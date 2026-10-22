import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

/**
 * The package version alone never changes between deploys, so the commit (on
 * Vercel) or the build time is appended: every deploy gets a fresh buster for
 * the persisted query cache, and a reshaped response never meets old data.
 */
const appBuild = `${pkg.version}+${process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? Date.now().toString(36)}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_BUILD__: JSON.stringify(appBuild),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@core": fileURLToPath(new URL("./core", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // In development the client stays on Vite and forwards /api to Hono, so the
    // browser only ever talks to one origin and the client_secret never leaves
    // the server process.
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
