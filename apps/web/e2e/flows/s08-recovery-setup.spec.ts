/**
 * S8 — cloud recovery setup (the webapp's half).
 *
 * Settings → Cloud recovery → "Set up cloud recovery". The passkey lives on a
 * dedicated sub-origin (recovery.<apex>, lib/recovery.js): the webapp opens it
 * in a popup, hands it the UMK seed over postMessage, and gets back the
 * PRF-wrapped UMK + the passphrase hashes. The webapp then IRK-signs the upload
 * record (N03: every value that changes what recovery does, chained onto the stored
 * record) and POSTs it to .com /api/recovery.
 *
 * The sub-origin is replaced by a stub page (its WebAuthn PRF + Argon2id
 * ceremony needs a real passkey and stays manual QA). What this asserts is the
 * webapp's contract: it opens the recovery origin's enroll page, uploads the
 * sub-origin's result verbatim, and the envelope's signature verifies under
 * the IRK.
 */

import { test, expect, bootstrapToHome, syncWebappPubkey } from "../fixtures/pod-sim.js";
import { verifyRecoveryRecord, type RecoveryRecordV2 } from "@flagship/protocol";
import { createHash } from "node:crypto";

const PASSPHRASE = "correct-horse-battery-staple-test";

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const CREDENTIAL_ID_HEX = "c0ffee".repeat(8);
const WRAPPED_UMK_B64 = Buffer.from("wrapped-umk-ciphertext-from-the-sub-origin").toString("base64");
const FETCH_TOKEN_HASH_HEX = "aa".repeat(32);
const PRF_SALT_HASH_HEX = "bb".repeat(32);

// Stand-in for recovery.<apex>/#enroll: answer the webapp's HELLO with ready,
// then answer its enroll payload with a fixed enroll result.
const STUB_SUB_ORIGIN = `<!doctype html><meta charset="utf-8"><title>recovery stub</title><script>
  window.addEventListener("message", (ev) => {
    const m = ev.data || {};
    if (m.type === "flagship-recovery-hello") {
      window.opener.postMessage({ type: "flagship-recovery-ready" }, ev.origin);
    }
    if (m.type === "flagship-recovery-enroll-payload") {
      window.opener.postMessage({
        type: "flagship-recovery-enroll-result",
        credentialIdHex: ${JSON.stringify(CREDENTIAL_ID_HEX)},
        wrappedUmkB64: ${JSON.stringify(WRAPPED_UMK_B64)},
        fetchTokenHashHex: ${JSON.stringify(FETCH_TOKEN_HASH_HEX)},
        prfSaltHashHex: ${JSON.stringify(PRF_SALT_HASH_HEX)},
      }, ev.origin);
    }
  });
</script>`;

test("S8 — set up cloud recovery + assert the IRK-signed /api/recovery upload", async ({
  page,
  context,
  identity,
  podSim,
}) => {
  await page.goto("/");
  await bootstrapToHome(page, PASSPHRASE);
  const irkPubHex = await syncWebappPubkey(page, podSim);
  // bootstrapToHome skips the account-claim wizard; give the session its handle.
  await page.evaluate(async (username) => {
    const state = (await import("/lib/state.js" as string)) as { getSession(): { username: string | null } };
    state.getSession().username = username;
  }, identity.username);

  const recoveryOrigin = await page.evaluate(async () => {
    const apex = (await import("/lib/apex.js" as string)) as { recoveryOrigin(): string };
    return apex.recoveryOrigin();
  });
  expect(new URL(recoveryOrigin).hostname.startsWith("recovery.")).toBe(true);
  const popupUrls: string[] = [];
  await context.route(`${recoveryOrigin}/**`, (route) => {
    popupUrls.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "text/html", body: STUB_SUB_ORIGIN });
  });

  let uploadBody: string | null = null;
  await page.route("**/api/recovery", async (route, request) => {
    if (request.method() === "POST") {
      uploadBody = request.postData();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, updated: false }),
      });
    }
    return route.continue();
  });
  // The record is written under the account's own key and the admin root `.com` pins for it.
  await page.route("**/api/username/*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ username: identity.username, adminRootPub: null }) }),
  );
  await page.route("**/api/recovery/by-username/**", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "no recovery record" }) }),
  );

  await page.click('[data-tab-target="settings"]');
  await page.click("#settings-tab-recovery");
  await expect(page.locator("#view-recovery")).toBeVisible();
  const popupPromise = page.waitForEvent("popup");
  await page.click("#recovery-cloud-setup");
  const popup = await popupPromise;

  await expect.poll(() => uploadBody, { timeout: 10_000 }).not.toBeNull();
  await expect(page.locator("#toast")).toContainText(`Cloud recovery on for ${identity.username}`);
  expect(popup.url()).toBe(`${recoveryOrigin}/#enroll`);
  expect(popupUrls.length).toBeGreaterThan(0);

  const parsed = JSON.parse(uploadBody!) as { claim: RecoveryRecordV2; signature: string; wrappedUmk: string };
  expect(parsed.claim.username).toBe(identity.username);
  expect(parsed.claim.credentialIdHex).toBe(CREDENTIAL_ID_HEX);
  expect(parsed.wrappedUmk).toBe(WRAPPED_UMK_B64);
  expect(parsed.claim.fetchTokenHashHex).toBe(FETCH_TOKEN_HASH_HEX);
  expect(parsed.claim.prfSaltHashHex).toBe(PRF_SALT_HASH_HEX);
  expect(parsed.claim.wrappedUmkDigestHex).toBe(createHash("sha256").update(Buffer.from(WRAPPED_UMK_B64, "base64")).digest("hex"));
  // A first record: generation 1, chained onto nothing, with no escrow it did not send.
  expect(parsed.claim).toMatchObject({ op: "put", generation: 1, priorDigestHex: "genesis", acmeKey: { change: "none" } });
  expect(verifyRecoveryRecord(parsed.claim, hexToBytes(parsed.signature), hexToBytes(irkPubHex))).toBe(true);
});
