import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["./test/setup-env.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "../../coverage/api",
      include: ["src/**/*.ts"],
      exclude: ["src/main.ts", "src/observability/**"],
      // Floors a few points under the measured values (2026-11-18: 81.2 / 78.1 / 71.2 / 81.4), so a
      // real drop fails `test:coverage` without making it flaky. Raise them when the numbers rise.
      thresholds: { statements: 78, branches: 75, functions: 68, lines: 78 },
    },
  },
});
