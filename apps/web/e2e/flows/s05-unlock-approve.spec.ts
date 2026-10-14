/**
 * S5 — approve a box's boot (most security-critical).
 *
 * Boot approval is the phone-as-unlock-endpoint relay
 * (docs/security-phone-as-unlock-endpoint.md, docs/box-request-inbox.md):
 * the booting box posts an STK-signed SecretRequest to `.com`, the webapp
 * (a trust-root device) fetches pending requests with an IRK-signed
 * mailbox-auth, RE-VERIFIES each against the box's STK as resolved from the
 * directory, and on approval:
 *   1. GETs the LUKS key `.com` holds sealed FOR the IRK,
 *   2. unseals it locally,
 *   3. re-seals it FOR the box's STK bound to (nonce, purpose),
 *   4. POSTs the sealed reply to the boot worker under a Flagship-Boot-v1
 *      owner header, then deposits the box's entitlement.
 *
 * `.com` is stubbed with page.route, but every byte is real crypto from
 * @flagship/protocol: the test plays the box (STK) and asserts the box can
 * open the reply to the exact LUKS key, and that requests `.com` could have
 * spliced (wrong STK echo, bad signature) never reach the screen.
 */

import { test, expect, bootstrapToHome, syncWebappPubkey } from "../fixtures/pod-sim.js";
import { bytesToHex, makeKey } from "../fixtures/identity.js";
import {
  signSecretRequest,
  sealForEd25519Recipient,
  openSealedSecretResponse,
  type SecretRequest,
} from "@flagship/protocol";
import { stubAccountReadToken } from "../fixtures/accountRead.js";

const PASSPHRASE = "correct-horse-battery-staple-test";

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function wireRequest(r: SecretRequest, sig: Uint8Array, stkPubHexEcho = bytesToHex(r.stkPub)) {
  return {
    serverDomain: r.serverDomain,
    stkPub: stkPubHexEcho,
    purpose: r.purpose,
    requestNonceHex: bytesToHex(r.nonce),
    issuedAt: r.issuedAt,
    requestSignature: bytesToHex(sig),
    deviceInfo: { ip: "192.0.2.1", os: "Debian 13", hostname: "home" },
  };
}

test("S5 — Approve a pending unlock request → webapp re-seals the disk key for the box", async ({
  page,
  identity,
  podSim,
}) => {
  await page.goto("/");
  await bootstrapToHome(page, PASSPHRASE);
  const irkPubHex = await syncWebappPubkey(page, podSim);
  // bootstrapToHome skips the account-claim wizard, so the session has no
  // handle yet; the inbox needs one for the mailbox-auth + directory lookup.
  await page.evaluate(async (username) => {
    const state = (await import("/lib/state.js" as string)) as { getSession(): { username: string | null } };
    state.getSession().username = username;
  }, identity.username);

  const stk = identity.stk;
  const stkPubHex = bytesToHex(stk.publicKey);
  const domain = identity.serverFqdn;

  // The genuine request, signed by the box's STK.
  const genuine: SecretRequest = {
    serverDomain: domain,
    stkPub: stk.publicKey,
    purpose: "unlock-key",
    nonce: randomBytes(32),
    issuedAt: Date.now() - 5_000,
  };
  // `.com` splices in an attacker STK (echo ≠ directory) …
  const attacker = makeKey();
  const spliced: SecretRequest = { ...genuine, stkPub: attacker.publicKey, nonce: randomBytes(32) };
  // … or echoes the directory STK over an attacker signature.
  const forged: SecretRequest = { ...genuine, nonce: randomBytes(32) };
  const pending = [
    wireRequest(genuine, signSecretRequest(genuine, stk)),
    wireRequest(spliced, signSecretRequest(spliced, attacker)),
    wireRequest(forged, signSecretRequest(forged, attacker), stkPubHex),
  ];

  // The LUKS key `.com` holds sealed FOR the account IRK at install time.
  const luksKey = randomBytes(64);
  const sealedForIrk = sealForEd25519Recipient(luksKey, hexToBytes(irkPubHex));

  let mailboxAuth: { auth?: { username?: string; phoneIrkPub?: string } } | null = null;
  await page.route("**/api/secret-requests", async (route, request) => {
    mailboxAuth = JSON.parse(request.postData() ?? "{}");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ requests: pending }) });
  });
  await stubAccountReadToken(page);
  await page.route(`**/api/users/${identity.username}/pods`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ pods: [{ serverDomain: domain, identityPubKey: stkPubHex, revokedAt: null }] }),
    }),
  );
  await page.route("**/api/server/*/sealed-luks-key", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ serverDomain: domain, sealedKey: bytesToHex(sealedForIrk), sealedAt: Date.now() }),
    }),
  );
  const bootResponses: Array<{ auth: string; body: string }> = [];
  await page.route("**/api/boot/response", async (route, request) => {
    bootResponses.push({ auth: request.headers()["authorization"] ?? "", body: request.postData() ?? "" });
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  const entitlementDeposits: string[] = [];
  await page.route("**/api/server/*/entitlement-deposit", async (route, request) => {
    entitlementDeposits.push(request.postData() ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await page.click('[data-tab-target="activity"]');
  await page.click("#activity-open-boot-approval");
  await expect(page.locator("#view-boot-approval")).toBeVisible();

  // Only the request that re-verifies against the directory STK renders.
  const cards = page.locator("#boot-approval-content [data-boot-request-id]");
  await expect(cards).toHaveCount(1, { timeout: 10_000 });
  await expect(cards.first()).toContainText(domain);
  expect(mailboxAuth!.auth?.username).toBe(identity.username);
  expect(mailboxAuth!.auth?.phoneIrkPub).toBe(irkPubHex);

  await cards.first().locator("[data-approve-id]").click();
  await expect.poll(() => bootResponses.length, { timeout: 10_000 }).toBe(1);
  await expect(page.locator("#toast")).toContainText("Approved");

  // Play the box: the reply opens under the STK to the exact disk key, and
  // only for this request's (nonce, purpose).
  const posted = JSON.parse(bootResponses[0]!.body) as {
    response: { serverDomain: string; requestNonceHex: string; purpose: string; sealed: string; issuedAt: number };
  };
  expect(bootResponses[0]!.auth).toMatch(/^Flagship-Boot-v1 /);
  expect(posted.response.serverDomain).toBe(domain);
  expect(posted.response.requestNonceHex).toBe(bytesToHex(genuine.nonce));
  const sealedReply = { ...posted.response, sealed: hexToBytes(posted.response.sealed) } as Parameters<
    typeof openSealedSecretResponse
  >[0];
  const opened = openSealedSecretResponse(sealedReply, genuine, stk.privateKey);
  expect(bytesToHex(opened)).toBe(bytesToHex(luksKey));
  expect(() => openSealedSecretResponse(sealedReply, forged, stk.privateKey)).toThrow();
  expect(bootResponses[0]!.body).not.toContain(bytesToHex(luksKey));

  // Consent to boot ⇒ consent to serve: the entitlement deposit follows.
  await expect.poll(() => entitlementDeposits.length).toBe(1);
  const deposit = JSON.parse(entitlementDeposits[0]!) as { deposit: { serverDomain: string; stkPub: string } };
  expect(deposit.deposit.serverDomain).toBe(domain);
  expect(deposit.deposit.stkPub).toBe(stkPubHex);
});
