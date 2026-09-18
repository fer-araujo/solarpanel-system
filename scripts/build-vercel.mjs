// Emits the Vercel Build Output API (v3) layout from the Vite build and a
// bundled server, so the deploy does not depend on Vercel resolving TypeScript
// path aliases (@core/*) at runtime.
//
//   .vercel/output/static            <- dist/ (the SPA)
//   .vercel/output/functions/api.func <- one bundled Node function
//   .vercel/output/config.json        <- routes: /api and /healthz to the
//                                        function, files, then SPA fallback
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const out = ".vercel/output";
const fn = `${out}/functions/api.func`;

rmSync(out, { recursive: true, force: true });
mkdirSync(fn, { recursive: true });

cpSync("dist", `${out}/static`, { recursive: true });

await build({
  entryPoints: ["server/vercel.ts"],
  outfile: `${fn}/index.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  tsconfig: "tsconfig.node.json",
  // Some transitive deps are CommonJS and call require().
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: "info",
});

writeFileSync(
  `${fn}/.vc-config.json`,
  JSON.stringify(
    {
      runtime: "nodejs22.x",
      handler: "index.mjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
      // Oregon, next to the Upstash database (us-west-2): each request makes
      // several Redis round trips, so co-location matters more than user distance.
      regions: ["pdx1"],
    },
    null,
    2,
  ),
);

writeFileSync(
  `${out}/config.json`,
  JSON.stringify(
    {
      version: 3,
      routes: [
        // Rewrites keep the original URL, so Hono still sees /api/... paths.
        { src: "/api/(.*)", dest: "/api" },
        { src: "/healthz", dest: "/api" },
        { handle: "filesystem" },
        { src: "/(.*)", dest: "/index.html" },
      ],
    },
    null,
    2,
  ),
);

console.log("Build Output ready in .vercel/output");
