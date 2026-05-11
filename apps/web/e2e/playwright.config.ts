import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the Flagship e2e suite.
 *
 * Chromium-only by design (per the user's choice on 2026-05-11).
 * Firefox + WebKit can be added later, but each new project
 * triples flake-investigation cost and we'd rather get the green
 * baseline locked in chromium first.
 *
 * Tests assume:
 *   - The pod-sim spins up per-worker via fixtures/pod-sim.ts.
 *   - The apex Worker is reachable at APEX_BASE_URL (default
 *     http://localhost:8787 / wrangler dev). Set to
 *     https://flagshipserver.com to run against live.
 *   - The webapp is reachable at WEBAPP_BASE_URL (default the
 *     localhost wrangler dev URL above; live = https://web.flagshipserver.com).
 */
export default defineConfig({
  testDir: "./flows",
  fullyParallel: false, // pod-sim + d1 seeding share state across tests in a worker
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: process.env.WEBAPP_BASE_URL ?? "http://localhost:8787",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Virtual authenticator support is enabled by default in Chromium
        // via Playwright's CDP integration; the WebAuthn fixtures use it.
      },
    },
  ],
});
