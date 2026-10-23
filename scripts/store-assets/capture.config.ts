import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Webapp captures for the store art (docs/store-assets/README.md): the real webapp, served by the mock gym's static
 * server with no backend, driven through the made-up world in store/demo-world.json in every shipped language.
 * Writes store/captures/webapp/<lang>/<phone|tablet>/<id>.png, which render.mjs uses as marked stand-ins until the
 * native captures exist (docs/store-assets/capture-plan.md).
 *
 *   npx playwright test --config scripts/store-assets/capture.config.ts     (or: npm run store-assets:capture)
 *   STORE_LANGS=ja,de ... to capture some languages only
 */
const here = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.STORE_WEBAPP_PORT ?? "8797");

export default defineConfig({
  testDir: here,
  testMatch: /capture-webapp\.spec\.ts$/,
  timeout: 120_000,
  fullyParallel: true,
  workers: Number(process.env.STORE_WORKERS ?? "3"),
  retries: 0,
  reporter: [["list"]],
  outputDir: join(here, "../../store/.capture-output"),
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    serviceWorkers: "block",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: {
    command: `npx tsx ${join(here, "../../apps/web/e2e/gym/static-server.ts")}`,
    url: `http://127.0.0.1:${port}/index.html`,
    reuseExistingServer: true,
    timeout: 30_000,
    env: { GYM_WEBAPP_PORT: String(port) },
  },
});
