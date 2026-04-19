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
        lines: 80.56,
        functions: 84.27,
        branches: 77.65,
        statements: 80.74,
      },
    },
  },
});
