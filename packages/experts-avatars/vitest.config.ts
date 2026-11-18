import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    // The CLI specs start a child process: under the load of the other packages running in parallel
    // (turbo) the 5 s default is too tight.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
