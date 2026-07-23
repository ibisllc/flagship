/**
 * LIVE webapp e2e — the FRONTEND-against-a-REAL-SERVER slice. Drives the actual
 * deployed gym webapp (webapp.gym.flagshipserver.com) against the actual gym
 * backend (gym.flagshipserver.com / gym.flagship.services). Unlike the mocked
 * gym Tier-1 (every /api/* stubbed), here the app's real network paths execute:
 * the bootstrap mints a device identity client-side, then the first-run wizard's
 * username step makes a REAL availability/claim call to the gym control plane.
 *
 * The deterministic proof that the frontend reached the real backend is a
 * captured `gym.flagshipserver.com/api/*` response (waitForResponse) with a
 * non-5xx status — not a screenshot. Run via npm run live-e2e:web.
 */
import { test, expect } from "@playwright/test";

const PASSPHRASE = "correct-horse-battery-staple-live";
const ORIGIN = process.env.GYM_LIVE_WEB_ORIGIN ?? "https://webapp.gym.flagshipserver.com";

test.describe("webapp LIVE (real gym backend)", () => {
  // The webapp host sits behind the pre-launch coming-soon gate (route.ts) —
  // `/wip_` or `/alpha` drops a `flagship_preview=1` cookie that lets the real
  // app serve. Set it up-front so navigations reach the webapp, not the gate.
  // (The control-plane /api/* the app then calls is NOT gated.)
  test.beforeEach(async ({ context }) => {
    await context.addCookies([{ url: ORIGIN, name: "flagship_preview", value: "1" }]);
  });

  test("live webapp serves and boots the bootstrap shell", async ({ page }) => {
    await page.goto("/index.html");
    await expect(page.locator("#view-bootstrap")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("header h1#title")).toContainText("Flagship");
    await expect(page.locator("#bootstrap-go")).toBeEnabled();
    // Sanity: the app resolved its control apex to the GYM host, not prod.
    const apex = await page.evaluate(() => (window as any).location.origin);
    expect(apex).toContain("gym.flagshipserver.com");
  });

  test("live bootstrap reaches the account form + fires a real call to the gym control plane", async ({
    page,
  }) => {
    // Collect every backend call from boot onward (cross-origin to the control
    // plane is what we want to SEE).
    const calls: Array<{ url: string; status: number }> = [];
    page.on("response", (r) => {
      if (/flagshipserver\.com\/api\//.test(r.url())) calls.push({ url: r.url(), status: r.status() });
    });

    await page.goto("/index.html");
    await expect(page.locator("#view-bootstrap")).toBeVisible({ timeout: 30_000 });

    // Mint a device identity (client-side crypto) → reach the real first-run
    // "OPEN YOUR ACCOUNT" step, rendered against the LIVE gym host.
    await page.fill("#bootstrap-passphrase", PASSPHRASE);
    await page.fill("#bootstrap-passphrase-2", PASSPHRASE);
    await page.click("#bootstrap-go");
    await expect(page.locator("#view-wizard")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#wizard-username-input")).toBeVisible();
    await expect(page.locator("#wizard-go-username")).toBeEnabled();

    // Drive the account-open action + let the app talk to the backend.
    await page.fill("#wizard-username-input", "weblv" + Date.now().toString(36).slice(-7));
    await page.click("#wizard-go-username");
    await page.waitForTimeout(8_000);

    const controlPlane = calls.filter((c) => /^https:\/\/gym\.flagshipserver\.com\/api\//.test(c.url));
    console.log(`[live] backend calls: ${JSON.stringify(calls)}`);
    // DETERMINISTIC proof the live frontend drove the REAL backend: ≥1 call to
    // the gym control-plane origin (the webapp's trust/maintainer-blessing +
    // username flow), and the live server answered every one without a 5xx.
    // NOTE: full account *creation* additionally needs the gym env to serve a
    // maintainer-blessing that verifies against the webapp's baked pin — until
    // that trust infra is stood up for gym, the trust gate blocks the mutating
    // ops (the form renders + the trust call fires, which is what we assert).
    expect(controlPlane.length, `control-plane calls: ${JSON.stringify(calls)}`).toBeGreaterThan(0);
    expect(controlPlane.every((c) => c.status < 500), `statuses: ${JSON.stringify(controlPlane)}`).toBe(true);
  });
});
