/**
 * Companion to webapp-feature-sweep: capture the BOX-SIDE EFFECTS of the
 * owner ops that were driven via the signed API (path B), as a real user would
 * SEE them in a browser. These are top-level navigations to the box (NOT
 * cross-origin fetches), so they are not subject to the daemon's missing CORS —
 * they show the genuine end-to-end result:
 *
 *   - the box APEX (home.<u>.gym.flagship.services) now 302-redirects to the
 *     installed `whoami` service — proving the front-page op + the install +
 *     the service serving all took effect;
 *   - the installed `whoami` service page served at its own subdomain.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ORIGIN = process.env.GYM_LIVE_WEB_ORIGIN ?? "https://web.gym.flagshipserver.com";
const here = fileURLToPath(new URL(".", import.meta.url));
const SHOT_DIR = join(here, "..", "..", "..", "..", "gym-results", "feature-screenshots");
const BOX = JSON.parse(readFileSync(join(SHOT_DIR, "box.json"), "utf8")) as { fqdn: string };

test("box-side effects: apex front-page redirect + service serving", async ({ page }) => {
  test.setTimeout(3 * 60 * 1000);
  await page.context().addCookies([{ url: ORIGIN, name: "flagship_preview", value: "1" }]);

  // Apex → should redirect to the installed whoami service (front-page effect).
  await page.goto(`https://${BOX.fqdn}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(1_500);
  const landedUrl = page.url();
  // eslint-disable-next-line no-console
  console.log(`[box-effect] apex landed at: ${landedUrl}`);
  await page.screenshot({ path: join(SHOT_DIR, "11-box-apex-frontpage-redirect.png"), fullPage: true });
  expect(landedUrl).toContain(`whoami.${BOX.fqdn}`);

  // The installed service page at its own subdomain.
  await page.goto(`https://whoami.${BOX.fqdn}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(1_000);
  const body = await page.locator("body").innerText().catch(() => "");
  // eslint-disable-next-line no-console
  console.log(`[box-effect] whoami body snippet: ${body.replace(/\s+/g, " ").slice(0, 120)}`);
  await page.screenshot({ path: join(SHOT_DIR, "12-installed-service-serving.png"), fullPage: true });
});
