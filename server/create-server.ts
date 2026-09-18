import { Hono } from "hono";
import { apiErrorHandler, registerApiRoutes } from "./app";
import { registerAuth } from "./auth";
import {
  KvReadingsStore,
  ReadingsStore,
  type ReadingsRepository,
} from "./billing/readings-store";
import type { Env } from "./env";
import { TtlCache } from "./solax/cache";
import { SolaxEndpoints } from "./solax/endpoints";
import { SolaxHttpClient } from "./solax/http-client";
import { RateLimiter } from "./solax/rate-limiter";
import { TokenStore } from "./solax/token-store";
import { createUpstashStore } from "./storage/kv";

/**
 * Builds the API, shared by both entry points: the long-running Node server
 * (local, Docker) and the Vercel function.
 *
 * With Upstash configured, the token, the cache and the CFE readings persist
 * across serverless cold starts. Without it they live in memory and a JSON
 * file — fine for one long-lived process, not for serverless.
 */
export function createServer(env: Env): Hono {
  const kv = createUpstashStore(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
  if (!kv && env.NODE_ENV === "production") {
    console.warn("WARNING: Upstash not configured — readings will not persist on serverless.");
  }

  const tokenStore = new TokenStore({
    baseUrl: env.SOLAX_BASE_URL,
    clientId: env.SOLAX_CLIENT_ID,
    clientSecret: env.SOLAX_CLIENT_SECRET,
    ...(kv ? { persistence: kv } : {}),
  });
  const rateLimiter = new RateLimiter({
    maxPerMinute: env.SOLAX_MAX_CALLS_PER_MINUTE,
    maxPerDay: env.SOLAX_MAX_CALLS_PER_DAY,
  });
  const http = new SolaxHttpClient({ baseUrl: env.SOLAX_BASE_URL, tokenStore, rateLimiter });
  const readings: ReadingsRepository = kv ? new KvReadingsStore(kv) : new ReadingsStore("data");

  const app = new Hono();

  // Unauthenticated liveness probe; reveals nothing and calls nothing.
  app.get("/healthz", (c) => c.text("ok"));

  // Auth before the routes it protects.
  registerAuth(app, env);

  registerApiRoutes(app, {
    env,
    endpoints: new SolaxEndpoints(http, env.SOLAX_BUSINESS_TYPE as 1 | 4),
    http,
    tokenStore,
    cache: new TtlCache(kv ? { l2: kv } : {}),
    readings,
  });

  app.all("/api/*", (c) => c.json({ error: "No such endpoint" }, 404));
  app.onError(apiErrorHandler);
  return app;
}
