import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/tests/**/*.test.ts",
      "apps/web/tests/**/*.test.ts",
      "apps/com/test/**/*.test.ts",
      "apps/boot/test/**/*.test.ts",
      "apps/dns-broker/test/**/*.test.ts",
      "apps/services-site/test/**/*.test.ts",
      "services/*/tests/**/*.test.ts",
      "tools/*/tests/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    testTimeout: 30_000,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
