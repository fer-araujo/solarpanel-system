import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { apiErrorHandler, registerApiRoutes } from "./app";
import { ReadingsStore } from "./billing/readings-store";
import { describeEnv, loadDotEnv, loadEnv } from "./env";
import { TtlCache } from "./solax/cache";
import { SolaxEndpoints } from "./solax/endpoints";
import { SolaxHttpClient } from "./solax/http-client";
import { RateLimiter } from "./solax/rate-limiter";
import { TokenStore } from "./solax/token-store";

/**
 * One process, ONE Hono app: the API and the built client.
 *
 * A single app matters for more than tidiness — the error handler is per-app,
 * so routes registered on a mounted sub-app would lose their errors to the
 * outer app's default 500.
 *
 * Hono serves `dist/` so there is a single artifact to deploy and no CORS
 * between front and back. The client talks to `/api/*` on its own origin.
 */

const dotEnvFound = loadDotEnv();
const env = loadEnv();

const tokenStore = new TokenStore({
  baseUrl: env.SOLAX_BASE_URL,
  clientId: env.SOLAX_CLIENT_ID,
  clientSecret: env.SOLAX_CLIENT_SECRET,
});

const rateLimiter = new RateLimiter({
  maxPerMinute: env.SOLAX_MAX_CALLS_PER_MINUTE,
  maxPerDay: env.SOLAX_MAX_CALLS_PER_DAY,
});
const http = new SolaxHttpClient({
  baseUrl: env.SOLAX_BASE_URL,
  tokenStore,
  rateLimiter,
});

const app = new Hono();

// Registered before every route so it guards both the API and the client.
if (env.APP_USER && env.APP_PASSWORD) {
  app.use("*", basicAuth({ username: env.APP_USER, password: env.APP_PASSWORD }));
} else if (env.NODE_ENV === "production") {
  console.warn("WARNING: APP_USER / APP_PASSWORD not set — the dashboard is public.");
}

registerApiRoutes(app, {
  env,
  endpoints: new SolaxEndpoints(http, env.SOLAX_BUSINESS_TYPE as 1 | 4),
  http,
  tokenStore,
  cache: new TtlCache(),
  readings: new ReadingsStore("data"),
});

// Anything under /api that no route matched is a client bug, not a page.
// Without this the SPA fallback below would answer it with index.html and the
// fetch would fail on "Unexpected token '<'" instead of a clean 404.
app.all("/api/*", (context) => context.json({ error: "No such endpoint" }, 404));

// Built client. In development Vite serves the app and proxies /api here, so
// these only matter in production.
app.use("/assets/*", serveStatic({ root: "./dist" }));
app.get("/favicon.ico", serveStatic({ path: "./dist/favicon.ico" }));
app.get("*", serveStatic({ path: "./dist/index.html" }));

app.onError(apiErrorHandler);

console.log(
  `\n${dotEnvFound ? "loaded .env" : "no .env file; using the ambient environment"}`,
);
console.log(`${describeEnv(env)}\n`);
serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`listening on http://localhost:${info.port}`);
});
