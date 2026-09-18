import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { z } from "zod";
import type { Env } from "./env";

/**
 * Single-owner login.
 *
 * Credentials live only in the environment (the owner sets them). A successful
 * login issues an HMAC-signed, httpOnly cookie, which is stateless — it works
 * across serverless instances with nothing stored server-side.
 *
 * Fails CLOSED: in production with no credentials configured, every API call is
 * refused instead of the dashboard silently going public.
 */

const COOKIE = "solar_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

const loginSchema = z.object({
  user: z.string().min(1).max(200),
  password: z.string().min(1).max(500),
});

/** Constant-time comparison; hashing first equalises the lengths. */
function matches(candidate: string, expected: string): boolean {
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function parseSession(value: string): string | null {
  const split = value.lastIndexOf("|");
  if (split <= 0) return null;
  const expiresAt = Number(value.slice(split + 1));
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  return value.slice(0, split);
}

export function registerAuth(app: Hono, env: Env): void {
  const configured = Boolean(env.APP_USER && env.APP_PASSWORD && env.APP_SESSION_SECRET);
  const production = env.NODE_ENV === "production";
  // Locally with nothing configured, auth is off. Anywhere else it is on.
  const enforced = configured || production;

  // Per-instance throttle. Weak on serverless, but it still turns a quick
  // brute force into a slow one, and each failure also costs a delay.
  const attempts = new Map<string, { count: number; resetAt: number }>();

  async function currentUser(c: Context): Promise<string | null> {
    if (!configured || !env.APP_SESSION_SECRET) return null;
    const value = await getSignedCookie(c, env.APP_SESSION_SECRET, COOKIE);
    return typeof value === "string" ? parseSession(value) : null;
  }

  const notConfigured = (c: Context) =>
    c.json({ error: "El servidor no tiene credenciales configuradas." }, 503);

  app.use("/api/*", async (c, next) => {
    if (c.req.path.startsWith("/api/auth/") || !enforced) return next();
    if (!configured) return notConfigured(c);
    if (await currentUser(c)) return next();
    return c.json({ error: "Sesión requerida" }, 401);
  });

  app.get("/api/auth/me", async (c) => {
    if (!enforced) return c.json({ user: "local", authDisabled: true });
    if (!configured) return notConfigured(c);
    const user = await currentUser(c);
    return user ? c.json({ user }) : c.json({ error: "Sesión requerida" }, 401);
  });

  app.post("/api/auth/login", async (c) => {
    if (!enforced) return c.json({ user: "local", authDisabled: true });
    if (!configured || !env.APP_USER || !env.APP_PASSWORD || !env.APP_SESSION_SECRET) {
      return notConfigured(c);
    }

    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const now = Date.now();
    const record = attempts.get(ip);
    if (record && record.resetAt > now && record.count >= MAX_ATTEMPTS) {
      return c.json({ error: "Demasiados intentos. Espera unos minutos." }, 429);
    }

    const body = loginSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Escribe usuario y contraseña." }, 400);

    // Both compared unconditionally so timing does not reveal which one failed.
    const userOk = matches(body.data.user, env.APP_USER);
    const passwordOk = matches(body.data.password, env.APP_PASSWORD);
    if (!(userOk && passwordOk)) {
      const fresh = !record || record.resetAt <= now;
      attempts.set(ip, {
        count: fresh ? 1 : record.count + 1,
        resetAt: fresh ? now + WINDOW_MS : record.resetAt,
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      return c.json({ error: "Usuario o contraseña incorrectos." }, 401);
    }

    attempts.delete(ip);
    await setSignedCookie(c, COOKIE, `${env.APP_USER}|${now + SESSION_MS}`, env.APP_SESSION_SECRET, {
      httpOnly: true,
      secure: production,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_MS / 1000,
    });
    return c.json({ user: env.APP_USER });
  });

  app.post("/api/auth/logout", (c) => {
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });
}
