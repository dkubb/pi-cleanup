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
        lines: 80.23,
        functions: 82.69,
        branches: 77.24,
        statements: 80.38,
      },
    },
  },
});
