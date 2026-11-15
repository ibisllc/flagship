import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The voi.ci call set-up between two browser contexts against a local stand-in `.com` (docs/voici-calls.md §10):
 * `npx playwright test -c apps/web/e2e/voici-calls/playwright.voici-calls.config.ts`. Chromium with a fake camera and
 * microphone; nothing leaves the machine.
 */
const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  testDir: here,
  testMatch: ["*.spec.ts"],
  outputDir: process.env.VOICI_CALLS_PW_OUTPUT ?? join(tmpdir(), "flagship-voici-calls-pw"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [["list"]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
        permissions: ["microphone", "camera"],
      },
    },
  ],
});
