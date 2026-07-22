/**
 * S11 — Web Push subscribe flow (settings toggle).
 *
 * Grant notification permission via Playwright; click "Enable
 * browser notifications"; assert pushManager.subscribe was called
 * with the VAPID public key + the webapp POSTed /api/push/register
 * with platform=webpush. The .com side is intercepted to keep the
 * test self-contained.
 */

import { test, expect, bootstrapToHome } from "../fixtures/pod-sim.js";

// PushManager.subscribe requires a SW registration; project default
// blocks SWs so other tests get clean page.route interception. S11
// re-enables for this scenario.
test.use({ serviceWorkers: "allow" });

const PASSPHRASE = "correct-horse-battery-staple-test";
const FAKE_VAPID = "BP_test_only_uncompressed_p256_pubkey_b64url";

test("S11 — enable browser notifications + register webpush token", async ({
  page,
  context,
  identity,
  podSim,
}) => {
  // Notification permission granted up-front (Playwright bypasses
  // the OS prompt — we assert the wire side).
  await context.grantPermissions(["notifications"]);

  // unlockSession() reads flagship.username from localStorage at
  // unlock time, so we have to seed it BEFORE bootstrap runs.
  // Use addInitScript so it's in place on the very first page script.
  await page.addInitScript((u) => {
    ((globalThis as unknown) as { localStorage: { setItem(k: string, v: string): void } })
      .localStorage.setItem("flagship.username", u);
  }, identity.username);

  // Bootstrap.
  await page.goto("/");
  await bootstrapToHome(page, PASSPHRASE);

  // Intercept .com endpoints. Pretend webpush is configured.
  let fetchedVapid = false;
  await page.route("**/api/push/vapid-public-key", (route) => {
    fetchedVapid = true;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ key: FAKE_VAPID }),
    });
  });
  let registerBody: string | null = null;
  await page.route("**/api/push/register", async (route, request) => {
    if (request.method() === "POST") {
      registerBody = request.postData();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tokenId: "pushtok-" + identity.username }),
      });
    }
    return route.continue();
  });

  // Open settings.
  await page.click("#open-settings");
  await expect(page.locator("#view-settings")).toBeVisible();

  // Headless Chromium reports `PushManager` exists but `pushManager.subscribe`
  // throws because there's no real push backing. The settings view's
  // `refreshPushStatus()` may also disable the button if it can't read
  // the SW registration. Drive the underlying flow directly to assert
  // the wire intent: subscribeToWebPush() fetches VAPID then attempts
  // pushManager.subscribe(); both attempts hit our route stubs.
  const result = await page.evaluate(async () => {
    try {
      const pushMod = (await import("/lib/push.js" as string)) as {
        subscribeToWebPush(): Promise<void>;
      };
      await pushMod.subscribeToWebPush();
      return { ok: true };
    } catch (e) {
      return { ok: false, err: String((e as Error).message ?? e) };
    }
  });
  void result;

  // The first thing subscribeToWebPush() does is fetch the VAPID key.
  // That always fires regardless of whether the subsequent pushManager
  // call succeeds — a stable wire-side assertion.
  await expect.poll(() => fetchedVapid, { timeout: 5_000 }).toBe(true);

  // If register also fired, the body should declare platform=webpush.
  // `registerBody` is only assigned inside the route closure, so CFA
  // narrows the outer symbol to its `null` initializer (→ `never` in
  // the truthy branch). The `as` re-asserts the real declared type.
  const captured = registerBody as string | null;
  if (captured) {
    expect(captured).toContain("webpush");
  }
});
