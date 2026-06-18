import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * LIVE account-recovery config — drives the REAL deployed gym webapp
 * (`web.gym.flagshipserver.com`) against a REAL gym box, with TWO browser
 * contexts (= the lost device + the fresh recovering device). Scoped to the
 * single recovery spec so it doesn't also pick up the pairing / feature-sweep
 * specs in this dir.
 */
const origin = process.env.GYM_LIVE_WEB_ORIGIN ?? "https://web.gym.flagshipserver.com";
const here = fileURLToPath(new URL(".", import.meta.url));
const outputDir = process.env.GYM_PW_OUTPUT ?? join(here, ".recovery-out");

export default defineConfig({
  testDir: here,
  testMatch: ["account-recovery.spec.ts"],
  outputDir: join(outputDir, "artifacts"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 8 * 60 * 1000,
  reporter: [["list"]],
  use: {
    baseURL: origin,
    trace: "off",
    screenshot: "only-on-failure",
    actionTimeout: 30_000,
    navigationTimeout: 45_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
