import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * LIVE web e2e config — drives the REAL deployed gym webapp against the REAL gym
 * backend (the opposite of playwright.gym.config.ts, which serves a local static
 * tree with every /api/* stubbed). No webServer: the baseURL is the live host
 * (`web.gym.flagshipserver.com`), and the webapp derives its backend apex from
 * window.location.origin (lib/apex.js), so loading that host auto-points the app
 * at gym.flagshipserver.com + gym.flagship.services. Override with
 * GYM_LIVE_WEB_ORIGIN.
 */
const origin = process.env.GYM_LIVE_WEB_ORIGIN ?? "https://web.gym.flagshipserver.com";
const here = fileURLToPath(new URL(".", import.meta.url));
const outputDir = process.env.GYM_PW_OUTPUT ?? join(here, ".live-out");
const jsonReport = process.env.GYM_PW_JSON ?? join(outputDir, "report.json");

export default defineConfig({
  testDir: here,
  outputDir: join(outputDir, "artifacts"),
  fullyParallel: false,
  workers: 1,
  retries: 1,
  timeout: 90_000,
  reporter: [["list"], ["json", { outputFile: jsonReport }]],
  use: {
    baseURL: origin,
    trace: "off",
    screenshot: "only-on-failure",
    // The live backend can be slower than a local stub.
    actionTimeout: 30_000,
    navigationTimeout: 45_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
