/**
 * S9 — recover an account on a fresh browser with the cloud passkey.
 *
 * The flow today:
 *   1. Bootstrap → "Sign in" with a username → `.com`
 *      /api/account/resolve/:u says the account exists with cloud recovery.
 *   2. "Recover with your passkey" → the post-recovery choice screen →
 *      "keep both" (no key rotation).
 *   3. The webapp opens recovery.<apex>/#recover in a popup. That sub-origin
 *      owns the passkey: it asks for the recovery passphrase, fetches the
 *      wrapped UMK from `.com`, runs WebAuthn get() + PRF and posts the UMK
 *      seed back.
 *   4. The webapp wraps the seed under a fresh local passphrase, unlocks and
 *      lands on home with the ORIGINAL account IRK.
 *
 * Step 3 is a stub page here: the real passkey + PRF + Argon2id ceremony
 * needs a synced passkey and stays manual QA (docs/e2e-test-plan.md). The
 * test asserts everything around it: the resolve → access options → choice →
 * popup wiring, and that the recovered seed yields the same IRK the account
 * was registered with.
 */

import { test, expect } from "../fixtures/pod-sim.js";
import { bytesToHex } from "../fixtures/identity.js";

test.skip("S9 — real passkey + PRF unwrap on the recovery sub-origin (manual QA only)", async () => {
  // Needs a passkey synced between two browsers (iCloud / Google backup);
  // CDP virtual authenticators can't be moved between contexts reliably.
});

test("S9 — sign in → recover with passkey → keep both restores the account IRK", async ({
  page,
  context,
  identity,
}) => {
  await page.goto("/");
  await expect(page.locator("#view-bootstrap")).toBeVisible();

  await page.route(`**/api/account/resolve/${identity.username}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        username: identity.username,
        exists: true,
        kind: "single",
        recovery: { present: true },
        totpEnrolled: false,
      }),
    }),
  );

  const recoveryOrigin = await page.evaluate(async () => {
    const apex = (await import("/lib/apex.js" as string)) as { recoveryOrigin(): string };
    return apex.recoveryOrigin();
  });
  const seed = JSON.stringify(Array.from(identity.umkSeed));
  await context.route(`${recoveryOrigin}/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8"><title>recovery stub</title><script>
        window.addEventListener("message", (ev) => {
          const m = ev.data || {};
          if (m.type === "flagship-recovery-hello" && m.mode === "recover") {
            window.opener.postMessage({ type: "flagship-recovery-recover-result", umk: ${seed} }, ev.origin);
          }
        });
      </script>`,
    }),
  );

  await page.fill("#bootstrap-username", identity.username);
  await page.click("#bootstrap-continue");
  const recover = page.locator('#bootstrap-access [data-access="recover"]');
  await expect(recover).toBeEnabled();

  await recover.click();
  await expect(page.locator("#view-post-recovery-choice")).toBeVisible();
  await page.click("#post-recovery-choice-keep-both");
  const popupPromise = page.waitForEvent("popup");
  await page.click("#post-recovery-choice-continue");
  const popup = await popupPromise;
  expect(popup.url()).toBe(`${recoveryOrigin}/#recover`);

  await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
  const irkHex = bytesToHex(identity.irk.publicKey);
  await expect(page.locator("#home-irkpub")).toHaveText(`${irkHex.slice(0, 16)}…${irkHex.slice(-4)}`);
  await expect(page.locator("#home-username")).toHaveText(identity.username);
});

test("S9 — an account without cloud recovery can't take the passkey path", async ({ page, identity }) => {
  await page.goto("/");
  await page.route(`**/api/account/resolve/${identity.username}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        username: identity.username,
        exists: true,
        kind: "single",
        recovery: { present: false },
        totpEnrolled: false,
      }),
    }),
  );
  await page.fill("#bootstrap-username", identity.username);
  await page.click("#bootstrap-continue");
  await expect(page.locator('#bootstrap-access [data-access="recover"]')).toBeDisabled();
  await expect(page.locator("#bootstrap-access")).toContainText("No cloud recovery is set up on this account.");
});
