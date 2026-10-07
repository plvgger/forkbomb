import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: [{ find: /^@\//, replacement: fileURLToPath(new URL("./", import.meta.url)) }] },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    testTimeout: 30_000,
    // Each test opens a fresh in-memory PGlite and migrates it in beforeEach. Under heavy machine load that
    // took over vitest's 10 s hook default and failed unrelated tests at random.
    hookTimeout: 30_000,
    env: { NODE_ENV: "test", KEY_PEPPER: "test-pepper", DATABASE_URL: "", TOKEN_MINT: "" },
  },
});
