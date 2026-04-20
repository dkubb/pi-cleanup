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
        lines: 90.89,
        functions: 93.2,
        branches: 88.32,
        statements: 90.98,
      },
    },
  },
});
