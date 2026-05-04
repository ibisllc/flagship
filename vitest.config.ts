import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/tests/**/*.test.ts",
      "apps/web/tests/**/*.test.ts",
      "apps/com/test/**/*.test.ts",
    ],
    environment: "node",
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
