import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// Deliberately separate from vite.config.ts: the domain tests need no React or
// Tailwind plugin, and keeping them out means a broken UI build cannot take the
// domain suite down with it.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@core": fileURLToPath(new URL("./core", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
