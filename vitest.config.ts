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
    server: {
      deps: {
        // Third-party code vendored into the static pages (no bundler there)
        // runs as it ships, like node_modules. Vite's transform made the
        // pure-JS argon2 in it 2.4x slower: ~5 s of CPU instead of ~2 s for
        // the production-cost KDF in keyfile.test.ts's interop gate.
        external: [/\/apps\/web\/public\/[^/]+\/vendor\//],
      },
    },
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
