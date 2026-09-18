import { getRequestListener } from "@hono/node-server";
import { createServer } from "./create-server";
import { loadEnv } from "./env";

/**
 * Vercel function entry. Bundled by `scripts/build-vercel.mjs` into the Build
 * Output API layout; Vercel's routes send every /api request here and serve
 * the static client itself.
 *
 * Built once per instance and reused across warm invocations.
 */
const app = createServer(loadEnv());

export default getRequestListener(app.fetch);
