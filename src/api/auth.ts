import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase client, configured from the server at runtime so the URL and anon
 * key live in one place (the server's environment) instead of being baked
 * into the bundle at build time.
 *
 * Resolves to null when the server runs with auth disabled (local only).
 */

interface AuthConfig {
  enabled: boolean;
  url?: string;
  anonKey?: string;
  misconfigured?: boolean;
}

let clientPromise: Promise<SupabaseClient | null> | null = null;

export class AuthConfigError extends Error {}

export function getSupabase(): Promise<SupabaseClient | null> {
  clientPromise ??= fetch("/api/auth/config")
    .then(async (response) => {
      if (!response.ok) throw new AuthConfigError(`Auth config failed with ${response.status}`);
      const config = (await response.json()) as AuthConfig;
      if (config.misconfigured) {
        throw new AuthConfigError("El servidor no tiene Supabase configurado.");
      }
      if (!config.enabled || !config.url || !config.anonKey) return null;
      return createClient(config.url, config.anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: "solar-auth" },
      });
    })
    .catch((error: unknown) => {
      // Let the next call retry instead of caching a failure forever.
      clientPromise = null;
      throw error;
    });
  return clientPromise;
}

/** Current access token, refreshed by supabase-js when it is about to expire. */
export async function accessToken(): Promise<string | null> {
  const supabase = await getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
