import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { registerAuth, type TokenVerifier } from "../../server/auth";
import { loadEnv } from "../../server/env";

const BASE = {
  SOLAX_BASE_URL: "https://openapi-eu.solaxcloud.com",
  SOLAX_CLIENT_ID: "id",
  SOLAX_CLIENT_SECRET: "fixture",
  SOLAX_BUSINESS_TYPE: "1",
};

const SUPABASE = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
};

/** Stand-in for Supabase: one known token, everything else is invalid. */
const verifier: TokenVerifier = async (token) =>
  token === "valid-token" ? { id: "u1", email: "owner@example.com" } : null;

function appWith(vars: Record<string, string>, verify: TokenVerifier = verifier) {
  const app = new Hono();
  registerAuth(app, loadEnv({ ...BASE, ...vars } as NodeJS.ProcessEnv), verify);
  app.get("/api/data", (c) => c.text("datos"));
  return app;
}

const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

describe("auth", () => {
  it("blocks the API without a token", async () => {
    expect((await appWith(SUPABASE).request("/api/data")).status).toBe(401);
  });

  it("rejects a token Supabase does not recognise", async () => {
    expect((await appWith(SUPABASE).request("/api/data", bearer("forged"))).status).toBe(401);
  });

  it("lets a valid session through", async () => {
    const res = await appWith(SUPABASE).request("/api/data", bearer("valid-token"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("datos");
  });

  it("refuses users outside the allow list", async () => {
    const app = appWith({ ...SUPABASE, AUTH_ALLOWED_EMAILS: "someone@else.com" });
    expect((await app.request("/api/data", bearer("valid-token"))).status).toBe(403);
  });

  it("accepts allow-listed users regardless of case", async () => {
    const app = appWith({ ...SUPABASE, AUTH_ALLOWED_EMAILS: " Owner@Example.com , b@c.com" });
    expect((await app.request("/api/data", bearer("valid-token"))).status).toBe(200);
  });

  it("answers 503, not 401, when Supabase is down", async () => {
    const down: TokenVerifier = async () => {
      throw new Error("down");
    };
    const res = await appWith(SUPABASE, down).request("/api/data", bearer("valid-token"));
    expect(res.status).toBe(503);
  });

  it("exposes only the public config", async () => {
    const res = await appWith(SUPABASE).request("/api/auth/config");
    expect(await res.json()).toEqual({
      enabled: true,
      url: SUPABASE.SUPABASE_URL,
      publishableKey: SUPABASE.SUPABASE_PUBLISHABLE_KEY,
    });
  });

  it("fails CLOSED in production when Supabase is missing", async () => {
    const app = new Hono();
    registerAuth(app, loadEnv({ ...BASE, NODE_ENV: "production" } as NodeJS.ProcessEnv));
    app.get("/api/data", (c) => c.text("datos"));
    expect((await app.request("/api/data", bearer("valid-token"))).status).toBe(503);
  });

  it("stays open locally when nothing is configured", async () => {
    const app = new Hono();
    registerAuth(app, loadEnv({ ...BASE } as NodeJS.ProcessEnv));
    app.get("/api/data", (c) => c.text("datos"));
    expect((await app.request("/api/data")).status).toBe(200);
  });
});
