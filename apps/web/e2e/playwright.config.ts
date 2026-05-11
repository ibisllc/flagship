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
        // Two cross-network gotchas the rig has to defuse:
        //  1. The webapp loads from https://web.flagshipserver.com (PUBLIC,
        //     SECURE). It then tries to fetch https://127.0.0.1:NN/api/...
        //     (PRIVATE). Chrome's Private Network Access blocks this unless
        //     the target server replies to the preflight with
        //     Access-Control-Allow-Private-Network: true. Pod-sim's CORS
        //     hook covers that.
        //  2. The pod-sim's TLS cert is a committed self-signed dev cert.
        //     `ignoreHTTPSErrors` covers Playwright's own request layer;
        //     for the BROWSER's network stack we need
        //     --ignore-certificate-errors at launch.
        launchOptions: {
          args: [
            "--ignore-certificate-errors",
            // Modern Chromium blocks loopback access from public-secure
            // origins under several overlapping policies that have
            // evolved across versions. Disable every one we've seen
            // surface so the rig isn't fragile to Chrome upgrades:
            //   - BlockInsecurePrivateNetworkRequests: the original
            //     Private Network Access enforcement.
            //   - PrivateNetworkAccessSendPreflights: optional CORS
            //     preflight on PNA requests; we'd rather skip it.
            //   - LocalNetworkAccessChecks: the 2024+ replacement that
            //     ALSO blocks loopback (127.0.0.1) and emits "Permission
            //     was denied for this request to access the `loopback`
            //     address space."
            "--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,LocalNetworkAccessChecks,PrivateNetworkAccessForWorkers,PrivateNetworkAccessForNavigations",
          ],
        },
      },
    },
  ],
});
