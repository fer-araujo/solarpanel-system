import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { registerAuth } from "../../server/auth";
import { loadEnv, type Env } from "../../server/env";

const BASE = {
  SOLAX_BASE_URL: "https://openapi-eu.solaxcloud.com",
  SOLAX_CLIENT_ID: "id",
  SOLAX_CLIENT_SECRET: "secret",
  SOLAX_BUSINESS_TYPE: "1",
};

const CREDS = {
  APP_USER: "fer",
  APP_PASSWORD: "una-contrasena-larga",
  APP_SESSION_SECRET: "x".repeat(40),
};

function appWith(env: Env) {
  const app = new Hono();
  registerAuth(app, env);
  app.get("/api/secret", (c) => c.text("datos"));
  return app;
}

async function login(app: Hono, user: string, password: string) {
  return app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": `ip-${user}-${password}` },
    body: JSON.stringify({ user, password }),
  });
}

describe("auth", () => {
  const env = loadEnv({ ...BASE, ...CREDS } as NodeJS.ProcessEnv);

  it("blocks the API without a session", async () => {
    const res = await appWith(env).request("/api/secret");
    expect(res.status).toBe(401);
  });

  it("rejects a wrong password", async () => {
    const res = await login(appWith(env), "fer", "incorrecta-123456");
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("issues an httpOnly session cookie that unlocks the API", async () => {
    const app = appWith(env);
    const res = await login(app, "fer", CREDS.APP_PASSWORD);
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/solar_session=/);
    expect(cookie).toMatch(/HttpOnly/i);

    const session = cookie.split(";")[0] ?? "";
    const secret = await app.request("/api/secret", { headers: { cookie: session } });
    expect(secret.status).toBe(200);
    expect(await secret.text()).toBe("datos");
  });

  it("rejects a tampered cookie", async () => {
    const res = await appWith(env).request("/api/secret", {
      headers: { cookie: "solar_session=fer|9999999999999.forged" },
    });
    expect(res.status).toBe(401);
  });

  it("throttles repeated failures from one address", async () => {
    const app = appWith(env);
    const attempt = () =>
      app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "1.2.3.4" },
        body: JSON.stringify({ user: "fer", password: "mala-mala-mala" }),
      });
    for (let i = 0; i < 5; i++) await attempt();
    expect((await attempt()).status).toBe(429);
  }, 15_000);

  it("fails CLOSED in production when credentials are missing", async () => {
    const prod = loadEnv({ ...BASE, NODE_ENV: "production" } as NodeJS.ProcessEnv);
    const res = await appWith(prod).request("/api/secret");
    expect(res.status).toBe(503);
  });

  it("stays open locally when nothing is configured", async () => {
    const local = loadEnv({ ...BASE } as NodeJS.ProcessEnv);
    const res = await appWith(local).request("/api/secret");
    expect(res.status).toBe(200);
  });
});

describe("credential validation", () => {
  it("rejects a password shorter than 12 characters", () => {
    expect(() =>
      loadEnv({ ...BASE, ...CREDS, APP_PASSWORD: "corta" } as NodeJS.ProcessEnv),
    ).toThrow(/12 characters/);
  });

  it("requires all three settings together", () => {
    expect(() =>
      loadEnv({ ...BASE, APP_USER: "fer" } as NodeJS.ProcessEnv),
    ).toThrow(/set together/);
  });
});
