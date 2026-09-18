import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createServer } from "./create-server";
import { describeEnv, loadDotEnv, loadEnv } from "./env";

/**
 * Long-running entry point (local and Docker): the API plus the built client
 * on one port. On Vercel, `server/vercel.ts` is used instead and the platform
 * serves the static files.
 */

const dotEnvFound = loadDotEnv();
const env = loadEnv();
const app = createServer(env);

// Built client. In development Vite serves the app and proxies /api here.
app.use("/assets/*", serveStatic({ root: "./dist" }));
app.get("/favicon.ico", serveStatic({ path: "./dist/favicon.ico" }));
app.get("*", serveStatic({ path: "./dist/index.html" }));

console.log(`\n${dotEnvFound ? "loaded .env" : "no .env file; using the ambient environment"}`);
console.log(`${describeEnv(env)}\n`);
serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`listening on http://localhost:${info.port}`);
});
