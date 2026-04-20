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
        lines: 90.34,
        functions: 93.1,
        branches: 87.3,
        statements: 90.43,
      },
    },
  },
});
