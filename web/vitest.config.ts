import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: [{ find: /^@\//, replacement: fileURLToPath(new URL("./", import.meta.url)) }] },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    testTimeout: 30_000,
    env: { NODE_ENV: "test", KEY_PEPPER: "test-pepper", DATABASE_URL: "", TOKEN_MINT: "" },
  },
});
