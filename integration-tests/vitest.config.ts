import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Preprod integration tests can take minutes (deposit confirmation, then
    // withdraw confirmation). Default vitest 5s timeout is way too short.
    testTimeout: 10 * 60_000,
    hookTimeout: 5 * 60_000,
    include: ["test/**/*.test.ts"],
  },
});
