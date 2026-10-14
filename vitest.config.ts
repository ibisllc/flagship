import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/tests/**/*.test.ts",
      // The SQLite and Postgres adapters need drivers Flagship doesn't install;
      // billing's own CI (.github/workflows/billing.yml) runs them.
      "billing/packages/{metering,store-d1}/tests/**/*.test.ts",
      "apps/web/tests/**/*.test.ts",
      "apps/com/test/**/*.test.ts",
      "apps/boot/test/**/*.test.ts",
      "apps/dns-broker/test/**/*.test.ts",
      "apps/services-site/test/**/*.test.ts",
      "services/*/tests/**/*.test.ts",
      "tools/*/tests/**/*.test.ts",
      "scripts/**/*.test.ts",
      "infra/**/tests/**/*.test.ts",
    ],
    testTimeout: 30_000,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
