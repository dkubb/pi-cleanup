import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        autoUpdate: true,
        lines: 65.02,
        functions: 72.22,
        branches: 53.21,
        statements: 64.88,
      },
    },
  },
});
