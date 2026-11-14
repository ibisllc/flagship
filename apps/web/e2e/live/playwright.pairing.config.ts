import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * LIVE two-device pairing config — drives the REAL deployed gym webapp
 * (`webapp.gym.flagshipserver.com`) against a REAL gym box, with TWO browser
 * contexts (= two devices). Scoped to the single pairing spec so it doesn't
 * also pick up the feature-sweep specs in this dir.
 */
const origin = process.env.GYM_LIVE_WEB_ORIGIN ?? "https://webapp.gym.flagshipserver.com";
const here = fileURLToPath(new URL(".", import.meta.url));
const outputDir = process.env.GYM_PW_OUTPUT ?? join(here, ".pairing-out");

export default defineConfig({
  testDir: here,
  testMatch: ["two-device-pairing.spec.ts"],
  outputDir: join(outputDir, "artifacts"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 8 * 60 * 1000,
  reporter: [["list"]],
  use: {
    baseURL: origin,
    // Box certificates come from the gym's private test CA unless this is the real-Let's-Encrypt lane
    // (docs/gym-test-acme.md); Chromium can't be handed that run's root, so only then are TLS errors ignored. This
    // weakens the run, which tools/live-e2e/shared-run.ts reports. Unset means Let's Encrypt: checks stay strict.
    ignoreHTTPSErrors: process.env.GYM_ISSUANCE_CA === "test",
    trace: "off",
    screenshot: "only-on-failure",
    actionTimeout: 30_000,
    navigationTimeout: 45_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
