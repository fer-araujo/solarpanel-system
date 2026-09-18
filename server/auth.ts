import { createHash } from "node:crypto";
import type { Hono } from "hono";
import type { Env } from "./env";

/**
 * Supabase Auth.
 *
 * The browser signs in with Supabase and sends its access token as a Bearer
 * header. The server asks Supabase who the token belongs to, which works with
 * both legacy (HS256) and asymmetric signing keys and honours revocations. The
 * answer is cached briefly so a dashboard refresh is not a dozen round trips.
 *
 * Fails CLOSED: in production without Supabase configured, every API call is
 * refused instead of the dashboard silently going public.
 */

export interface AuthUser {
  id: string;
  email: string | null;
}

export type TokenVerifier = (token: string) => Promise<AuthUser | null>;

const CACHE_MS = 60_000;
const CACHE_MAX = 500;

/** Verifies a token with Supabase's `/auth/v1/user`, caching the result. */
export function supabaseVerifier(url: string, publishableKey: string): TokenVerifier {
  const cache = new Map<string, { user: AuthUser | null; until: number }>();

  return async (token) => {
    const key = createHash("sha256").update(token).digest("hex");
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.until > now) return hit.user;

    const response = await fetch(`${url.replace(/\/$/, "")}/auth/v1/user`, {
      headers: { apikey: publishableKey, Authorization: `Bearer ${token}` },
    });
    let user: AuthUser | null = null;
    if (response.ok) {
      const body = (await response.json()) as { id?: string; email?: string | null };
      if (body.id) user = { id: body.id, email: body.email ?? null };
    } else if (response.status >= 500) {
      // Supabase itself failed: do not cache, and do not pretend the token is bad.
      throw new Error(`Supabase auth responded ${response.status}`);
    }

    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, { user, until: now + CACHE_MS });
    return user;
  };
}

export function registerAuth(app: Hono, env: Env, verifyOverride?: TokenVerifier): void {
  const configured = Boolean(env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY);
  const production = env.NODE_ENV === "production";
  // Locally with nothing configured, auth is off. Anywhere else it is on.
  const enforced = configured || production;
  const verify =
    verifyOverride ??
    (configured ? supabaseVerifier(env.SUPABASE_URL!, env.SUPABASE_PUBLISHABLE_KEY!) : null);
  const allowed = new Set(
    (env.AUTH_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );

  // Public on purpose: the publishable key is designed to ship to browsers.
  app.get("/api/auth/config", (c) =>
    c.json(
      configured
        ? { enabled: true, url: env.SUPABASE_URL, publishableKey: env.SUPABASE_PUBLISHABLE_KEY }
        : { enabled: false, misconfigured: production },
    ),
  );

  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/auth/config" || !enforced) return next();
    if (!verify) {
      return c.json({ error: "El servidor no tiene Supabase configurado." }, 503);
    }

    const header = c.req.header("authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!token) return c.json({ error: "Sesión requerida" }, 401);

    let user: AuthUser | null;
    try {
      user = await verify(token);
    } catch {
      return c.json({ error: "No se pudo validar la sesión.", retryable: true }, 503);
    }
    if (!user) return c.json({ error: "Sesión expirada" }, 401);
    if (allowed.size > 0 && !allowed.has((user.email ?? "").toLowerCase())) {
      return c.json({ error: "Esta cuenta no tiene acceso." }, 403);
    }
    return next();
  });
}
