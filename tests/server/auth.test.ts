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

const FIREBASE = {
  FIREBASE_PROJECT_ID: "solar-fixture",
  FIREBASE_API_KEY: "AIzaFixture",
};

/** Stand-in for Firebase: one known token, everything else is invalid. */
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
    expect((await appWith(FIREBASE).request("/api/data")).status).toBe(401);
  });

  it("rejects a token Firebase does not recognise", async () => {
    expect((await appWith(FIREBASE).request("/api/data", bearer("forged"))).status).toBe(401);
  });

  it("lets a valid session through", async () => {
    const res = await appWith(FIREBASE).request("/api/data", bearer("valid-token"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("datos");
  });

  it("refuses users outside the allow list", async () => {
    const app = appWith({ ...FIREBASE, AUTH_ALLOWED_EMAILS: "someone@else.com" });
    expect((await app.request("/api/data", bearer("valid-token"))).status).toBe(403);
  });

  it("accepts allow-listed users regardless of case", async () => {
    const app = appWith({ ...FIREBASE, AUTH_ALLOWED_EMAILS: " Owner@Example.com , b@c.com" });
    expect((await app.request("/api/data", bearer("valid-token"))).status).toBe(200);
  });

  it("answers 503, not 401, when Firebase is down", async () => {
    const down: TokenVerifier = async () => {
      throw new Error("down");
    };
    const res = await appWith(FIREBASE, down).request("/api/data", bearer("valid-token"));
    expect(res.status).toBe(503);
  });

  it("exposes only the public config", async () => {
    const res = await appWith(FIREBASE).request("/api/auth/config");
    expect(await res.json()).toEqual({
      enabled: true,
      apiKey: FIREBASE.FIREBASE_API_KEY,
      projectId: FIREBASE.FIREBASE_PROJECT_ID,
      authDomain: "solar-fixture.firebaseapp.com",
    });
  });

  it("fails CLOSED in production when Firebase is missing", async () => {
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
