import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Gym webapp config (§12-G3) — a SELF-CONTAINED Tier-1 surface: it starts the
 * tiny static webapp server (no backend) and runs ONLY the gym smoke spec.
 * Separate from the behavioral playwright.config.ts (which needs wrangler-dev +
 * pod-sim) so the every-merge gym's webapp leg is deterministic and zero-infra.
 *
 * Screenshots are captured on success too (the gym needs the D7 capture, §7-B),
 * and the JSON reporter writes a result file the web adapter maps into the gym
 * artifact. The output dir is provided by the adapter via GYM_PW_OUTPUT.
 */

const port = Number(process.env.GYM_WEBAPP_PORT ?? "8799");
const here = fileURLToPath(new URL(".", import.meta.url));
const outputDir = process.env.GYM_PW_OUTPUT ?? join(here, ".gym-pw-output");
const jsonReport = process.env.GYM_PW_JSON ?? join(outputDir, "report.json");

export default defineConfig({
  testDir: ".",
  testMatch: /gym-smoke\.spec\.ts$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  outputDir,
  reporter: [
    ["list"],
    ["json", { outputFile: jsonReport }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // The gym spec captures explicitly at each screenshot point (success too,
    // for the advisory judge); the rig keeps a failure screenshot/trace as a
    // triage fallback the adapter folds in under the "failure" point.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    ignoreHTTPSErrors: true,
    // Static server has no SW concerns, but blocking keeps parity with the
    // behavioral rig and avoids the webapp's own SW caching the shell.
    serviceWorkers: "block",
  },
  webServer: {
    command: `npx tsx ${join(here, "static-server.ts")}`,
    url: `http://127.0.0.1:${port}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { GYM_WEBAPP_PORT: String(port) },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
