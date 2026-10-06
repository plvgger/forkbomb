import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    pool: "forks",
    env: { HYDRA_HOME: join(process.cwd(), ".test-tmp", "home") },
  },
});
