/**
 * S9 — recover an account on a fresh browser with the cloud passkey.
 *
 * Recovery is a takeover, as on iOS (there is no "keep both"):
 *   1. Bootstrap → "Sign in" with a username → `.com`
 *      /api/account/resolve/:u says the account exists with cloud recovery.
 *   2. "Recover with your passkey" → the "Take over this account" explainer.
 *   3. The webapp opens recovery.<apex>/#recover in a popup. That sub-origin
 *      owns the passkey: it asks for the recovery passphrase, fetches the
 *      wrapped UMK from `.com`, runs WebAuthn get() + PRF and posts the UMK
 *      seed back with `.com`'s recovery proof.
 *   4. The webapp wraps the seed under a fresh local passphrase, unlocks with
 *      the ORIGINAL account IRK and initiates the re-pair (POST
 *      /api/users/:u/re-pair) signed by a rotated device key and the old IRK,
 *      carrying the proof; the grace clock starts and home opens with this
 *      browser as one of the account's devices.
 *
 * Step 3 is a stub page here: the real passkey + PRF + Argon2id ceremony
 * needs a synced passkey and stays manual QA (docs/e2e-test-plan.md). The
 * test asserts everything around it.
 */

import { test, expect } from "../fixtures/pod-sim.js";
import { bytesToHex } from "../fixtures/identity.js";
import { ed } from "@flagship/protocol";

const RECOVERY_PROOF = "e2e-recovery-proof";

interface InitiateBody {
  request: { username: string; newIrkPub: string; oldIrkPub: string; issuedAt: number };
  signature: string;
  recoveryProof?: { token: string };
  oldIrkSignature?: string;
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

test.skip("S9 — real passkey + PRF unwrap on the recovery sub-origin (manual QA only)", async () => {
  // Needs a passkey synced between two browsers (iCloud / Google backup);
  // CDP virtual authenticators can't be moved between contexts reliably.
});

test("S9 — sign in → recover with passkey takes the account over on this browser", async ({
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
            window.opener.postMessage({
              type: "flagship-recovery-recover-result",
              umk: ${seed},
              recoveryProof: { token: "${RECOVERY_PROOF}" },
            }, ev.origin);
          }
        });
      </script>`,
    }),
  );

  // .com starts the takeover's grace clock; capture what the browser sends.
  let initiate: InitiateBody | null = null;
  const completesAt = Date.now() + 3 * 86_400_000;
  await page.route(`**/api/users/${identity.username}/re-pair`, async (route, request) => {
    if (request.method() !== "POST") return route.continue();
    initiate = request.postDataJSON() as InitiateBody;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, accountType: "single", completesAt, graceMs: 3 * 86_400_000 }),
    });
  });

  await page.click("#bootstrap-connect");
  await page.fill("#bootstrap-username", identity.username);
  await page.click("#bootstrap-continue");
  const recover = page.locator('#bootstrap-access [data-access="recover"]');
  await expect(recover).toBeEnabled();
  await recover.click();

  // Recovery IS the takeover (as on iOS): one explainer, no "keep both".
  await expect(page.locator(".modal-title")).toHaveText("Take over this account");
  await expect(page.locator("#view-post-recovery-choice")).toHaveCount(0);
  const popupPromise = page.waitForEvent("popup");
  await page.click("[data-modal-ok]");
  const popup = await popupPromise;
  expect(popup.url()).toBe(`${recoveryOrigin}/#recover`);

  await expect.poll(() => initiate, { timeout: 10_000 }).not.toBeNull();
  const body = initiate as unknown as InitiateBody;
  const oldIrkPub = bytesToHex(identity.irk.publicKey);
  expect(body.request.username).toBe(identity.username);
  expect(body.request.oldIrkPub).toBe(oldIrkPub);
  expect(body.request.newIrkPub).toMatch(/^[0-9a-f]{64}$/);
  expect(body.request.newIrkPub).not.toBe(oldIrkPub);
  expect(body.recoveryProof).toEqual({ token: RECOVERY_PROOF });
  // The new device key and the account's registered key both sign the same
  // bytes: proof of the rotated key and of holding the account's own.
  const message = new TextEncoder().encode(
    ["flagship/re-pair-initiate/v1", identity.username, body.request.newIrkPub, oldIrkPub, body.request.issuedAt].join("|"),
  );
  expect(ed.verify(hexToBytes(body.signature), message, hexToBytes(body.request.newIrkPub))).toBe(true);
  expect(ed.verify(hexToBytes(body.oldIrkSignature ?? ""), message, identity.irk.publicKey)).toBe(true);

  await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#home-username")).toHaveText(identity.username);
  await expect(page.locator("#toast")).toContainText(`Taking over ${identity.username}`);
  // This browser is now one of the account's devices: its own opaque id
  // under the account, and the recovered seed unlocks the original IRK.
  const joined = await page.evaluate(async () => {
    const [{ getActiveProfile }, { getSession }] = await Promise.all([
      import("/lib/profiles.js" as string) as Promise<{ getActiveProfile(): { accountId: string; deviceId: string; cloudRootPubHex: string } | null }>,
      import("/lib/state.js" as string) as Promise<{ getSession(): { username: string | null; irk: { publicKey: Uint8Array } | null } }>,
    ]);
    const p = getActiveProfile();
    const s = getSession();
    return {
      accountId: p?.accountId ?? null,
      deviceId: p?.deviceId ?? null,
      cloudRootPubHex: p?.cloudRootPubHex ?? null,
      username: s.username,
      irkPubHex: s.irk ? Array.from(s.irk.publicKey, (b) => b.toString(16).padStart(2, "0")).join("") : null,
    };
  });
  expect(joined.accountId).toBe(identity.username);
  expect(joined.deviceId).toMatch(/^[0-9a-f]{32}$/);
  expect(joined.cloudRootPubHex).toBe(oldIrkPub);
  expect(joined.username).toBe(identity.username);
  expect(joined.irkPubHex).toBe(oldIrkPub);
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
  await page.click("#bootstrap-connect");
  await page.fill("#bootstrap-username", identity.username);
  await page.click("#bootstrap-continue");
  await expect(page.locator('#bootstrap-access [data-access="recover"]')).toBeDisabled();
  await expect(page.locator("#bootstrap-access")).toContainText("No cloud recovery is set up on this account.");
});
