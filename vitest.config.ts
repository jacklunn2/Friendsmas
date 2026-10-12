import { defineConfig } from "vitest/config";

// Game-logic tests run in plain Node; they don't need the Cloudflare plugin.
export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
