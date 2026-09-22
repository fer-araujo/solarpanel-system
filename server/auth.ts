import type { Hono } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env";

/**
 * Firebase Authentication.
 *
 * The browser signs in with Firebase and sends its ID token as a Bearer
 * header. The server verifies that token's signature against GOOGLE'S PUBLIC
 * KEYS, so it needs no secret and no service account — only the project id,
 * which the token's issuer and audience must match.
 *
 * Fails CLOSED: in production without Firebase configured, every API call is
 * refused instead of the dashboard silently going public.
 */

const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

export interface AuthUser {
  id: string;
  email: string | null;
}

export type TokenVerifier = (token: string) => Promise<AuthUser | null>;

/** Verifies a Firebase ID token. The key set is cached and refreshed by jose. */
export function firebaseVerifier(projectId: string): TokenVerifier {
  const keys = createRemoteJWKSet(new URL(JWKS_URL));

  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: `https://securetoken.google.com/${projectId}`,
        audience: projectId,
      });
      // `sub` is the Firebase uid; a token without one is not a user token.
      if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
      const email = typeof payload.email === "string" ? payload.email : null;
      return { id: payload.sub, email };
    } catch (error) {
      // A bad signature, a wrong project or an expired token are all "not
      // signed in". Anything else (network, key fetch) must surface as an
      // outage rather than as a rejected session.
      const code = (error as { code?: string }).code ?? "";
      if (code.startsWith("ERR_JWKS_") || code === "ERR_JOSE_GENERIC") throw error;
      return null;
    }
  };
}

export function registerAuth(app: Hono, env: Env, verifyOverride?: TokenVerifier): void {
  const configured = Boolean(env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY);
  const production = env.NODE_ENV === "production";
  // Locally with nothing configured, auth is off. Anywhere else it is on.
  const enforced = configured || production;
  const verify =
    verifyOverride ?? (configured ? firebaseVerifier(env.FIREBASE_PROJECT_ID!) : null);
  const allowed = new Set(
    (env.AUTH_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );

  // Public on purpose: a Firebase web API key identifies the project, it does
  // not authorise anything on its own.
  app.get("/api/auth/config", (c) =>
    c.json(
      configured
        ? {
            enabled: true,
            apiKey: env.FIREBASE_API_KEY,
            projectId: env.FIREBASE_PROJECT_ID,
            authDomain: env.FIREBASE_AUTH_DOMAIN ?? `${env.FIREBASE_PROJECT_ID}.firebaseapp.com`,
          }
        : { enabled: false, misconfigured: production },
    ),
  );

  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/auth/config" || !enforced) return next();
    if (!verify) {
      return c.json({ error: "El servidor no tiene Firebase configurado." }, 503);
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
