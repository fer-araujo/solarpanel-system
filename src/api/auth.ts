import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, signOut as firebaseSignOut, type Auth } from "firebase/auth";

/**
 * Firebase Auth client, configured from the server at runtime so the project's
 * ids live in one place (the server's environment) instead of being baked into
 * the bundle at build time.
 *
 * Resolves to null when the server runs with auth disabled (local only).
 */

interface AuthConfig {
  enabled: boolean;
  apiKey?: string;
  projectId?: string;
  authDomain?: string;
  misconfigured?: boolean;
}

let authPromise: Promise<Auth | null> | null = null;
let app: FirebaseApp | null = null;

export class AuthConfigError extends Error {}

export function getAuthClient(): Promise<Auth | null> {
  authPromise ??= fetch("/api/auth/config")
    .then(async (response) => {
      if (!response.ok) throw new AuthConfigError(`Auth config failed with ${response.status}`);
      const config = (await response.json()) as AuthConfig;
      if (config.misconfigured) {
        throw new AuthConfigError("El servidor no tiene Firebase configurado.");
      }
      if (!config.enabled || !config.apiKey || !config.projectId) return null;
      app ??= initializeApp({
        apiKey: config.apiKey,
        projectId: config.projectId,
        authDomain: config.authDomain ?? `${config.projectId}.firebaseapp.com`,
      });
      const auth = getAuth(app);
      // Resolve only once the persisted session has been restored, so the gate
      // never flashes the login screen at someone who is already signed in.
      await auth.authStateReady();
      return auth;
    })
    .catch((error: unknown) => {
      // Let the next call retry instead of caching a failure forever.
      authPromise = null;
      throw error;
    });
  return authPromise;
}

/** Current ID token, refreshed by the SDK when it is close to expiring. */
export async function accessToken(): Promise<string | null> {
  const auth = await getAuthClient();
  const user = auth?.currentUser;
  return user ? await user.getIdToken() : null;
}

export async function signOut(): Promise<void> {
  const auth = await getAuthClient();
  if (auth) await firebaseSignOut(auth);
}
