import { getRequestListener } from "@hono/node-server";
import { createServer } from "./create-server";
import { loadEnv } from "./env";

/**
 * Vercel function entry. Bundled by `scripts/build-vercel.mjs` into the Build
 * Output API layout; Vercel's routes send every /api request here and serve
 * the static client itself.
 *
 * Built once per instance and reused across warm invocations.
 *
 * Always production here, so auth fails closed without depending on an
 * environment variable. Setting NODE_ENV in the Vercel dashboard instead would
 * also make the install skip devDependencies and break the build.
 */
const app = createServer(loadEnv({ ...process.env, NODE_ENV: "production" }));

export default getRequestListener(app.fetch);
