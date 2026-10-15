/**
 * S6 — long-lived auto-unlock lease toggle (server-detail view).
 *
 * Home → tap the server card → server detail → "Enable for 7 days". The
 * webapp fetches the LUKS key `.com` holds sealed FOR the account IRK,
 * unseals it locally, signs an AutoUnlockLease (multiUse, ~7 d) with the IRK
 * and POSTs it to .com. `.com` is stubbed, but the seal and the signature are
 * real @flagship/protocol crypto: the test asserts the POST carries the exact
 * unsealed key under a signature that verifies against the IRK. The full
 * deposit → consume roundtrip is asserted live by smoke-lease-unlock.ts.
 */

import { test, expect, bootstrapToHome, routeFqdnToPodSim, syncWebappPubkey } from "../fixtures/pod-sim.js";
import { bytesToHex } from "../fixtures/identity.js";
import { sealForEd25519Recipient, verifyAutoUnlockLease } from "@flagship/protocol";

const PASSPHRASE = "correct-horse-battery-staple-test";

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

test("S6 — enable long-lived auto-unlock + assert wire-side POST shape", async ({
  page,
  identity,
  podSim,
}) => {
  await page.goto("/");
  await bootstrapToHome(page, PASSPHRASE);
  const irkPubHex = await syncWebappPubkey(page, podSim);
  await page.locator("#view-home .advanced-disclosure").evaluate((d) => { (d as unknown as { open: boolean }).open = true; });
  await page.click("#open-pod-pair");
  // Pair at the server's own name: server detail reaches it as https://<fqdn>.
  await page.fill("#pod-pair-base", await routeFqdnToPodSim(page, podSim, identity.serverFqdn));
  await page.click("#pod-pair-go");
  await expect.poll(() => podSim.orders.filterByType("add-paired-session").length).toBe(1);
  await page.click("#pod-pair-back");

  const luksKey = new Uint8Array(64);
  crypto.getRandomValues(luksKey);
  const sealedForIrk = sealForEd25519Recipient(luksKey, hexToBytes(irkPubHex));

  // Home lists the account's servers from /api/me/servers (needs an apex
  // session id); the card opens server detail.
  await page.route("**/api/me/servers**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ servers: [{ serverId: identity.serverFqdn, revoked: null }] }),
    }),
  );
  await page.route("**/api/server/*/sealed-luks-key", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ serverDomain: identity.serverFqdn, sealedKey: bytesToHex(sealedForIrk), sealedAt: Date.now() }),
    }),
  );
  await page.route("**/api/server/*/unlock-key/leases", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ leases: [] }) }),
  );
  let leasePost: string | null = null;
  await page.route("**/api/server/*/unlock-key/lease", async (route, request) => {
    if (request.method() === "POST") {
      leasePost = request.postData() ?? "";
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, leaseId: "feedface00112233" }),
      });
    }
    return route.continue();
  });
  await page.evaluate(() => {
    ((globalThis as unknown) as { localStorage: { setItem(k: string, v: string): void } })
      .localStorage.setItem("flagship.sessionId", "e2e-session-id");
  });
  await page.reload();
  await page.fill("#unlock-passphrase", PASSPHRASE);
  await page.click("#unlock-go");
  await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });

  await page.locator(`[data-open-fqdn="${identity.serverFqdn}"]`).click();
  await expect(page.locator("#view-server-detail")).toBeVisible();
  await expect(page.locator("#auto-unlock-pill")).toHaveText("off");
  const before = Date.now();
  await page.click("#auto-unlock-enable");

  await expect.poll(() => leasePost, { timeout: 10_000 }).not.toBeNull();
  await expect(page.locator("#toast")).toContainText("Auto-unlock on");
  const posted = JSON.parse(leasePost!) as {
    request: { serverId: string; leaseId: string; unlockKey: string; multiUse: boolean; expiresAt: number; issuedAt: number };
    signature: string;
  };
  expect(posted.request.serverId).toBe(identity.serverFqdn);
  expect(posted.request.multiUse).toBe(true);
  expect(posted.request.unlockKey).toBe(bytesToHex(luksKey));
  const ttl = posted.request.expiresAt - posted.request.issuedAt;
  expect(ttl).toBe(7 * 24 * 60 * 60 * 1000);
  expect(posted.request.issuedAt).toBeGreaterThanOrEqual(before - 1000);
  const verified = verifyAutoUnlockLease(
    { ...posted.request, unlockKey: hexToBytes(posted.request.unlockKey) },
    hexToBytes(posted.signature),
    hexToBytes(irkPubHex),
  );
  expect(verified).toBe(true);
});

test("S7 — auto-renewer fires on home enter when a lease is close to expiry", async ({
  page,
  identity,
  podSim,
}) => {
  // Bootstrap + pair (renewer lives on home view).
  await page.goto("/");
  await bootstrapToHome(page, PASSPHRASE);
  await syncWebappPubkey(page, podSim);
  await page.locator("#view-home .advanced-disclosure").evaluate((d) => { d.open = true; });
  await page.click("#open-pod-pair");
  await page.fill("#pod-pair-base", podSim.baseUrl);
  await page.click("#pod-pair-go");
  await expect.poll(() => podSim.orders.filterByType("add-paired-session").length).toBe(1);
  await page.click("#pod-pair-back");

  // The renewer queries /api/me/servers (apex), then for each server
  // queries /api/server/<fqdn>/unlock-key/leases. We intercept both.
  // Return ONE lease that's 12h from expiry (within the 24h renewal
  // window) so the renewer should re-issue.
  const leasesResponses: Array<unknown> = [];
  await page.route("**/api/me/servers**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        servers: [{ serverId: identity.serverFqdn, revoked: null }],
      }),
    }),
  );
  await page.route("**/api/server/*/unlock-key/leases", (route) => {
    const body = JSON.stringify({
      leases: [
        {
          leaseId: "11".repeat(8),
          multiUse: true,
          depositedAt: Date.now() - 6 * 24 * 60 * 60_000,
          expiresAt: Date.now() + 12 * 60 * 60_000, // within renewal window
        },
      ],
    });
    leasesResponses.push(body);
    route.fulfill({ status: 200, contentType: "application/json", body });
  });

  // Sealed key fetch for the renewal POST attempt.
  await page.route("**/api/server/*/sealed-luks-key", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ serverDomain: identity.serverFqdn, sealedKey: "00".repeat(48), sealedAt: Date.now() }),
    }),
  );

  // The home view's renderServers() early-returns when no
  // flagship.sessionId is in localStorage (the webapp's apex-device-
  // pair flow is what normally sets it, separate from pod-pair).
  // Seed it so scheduleRenewals → /api/me/servers → /unlock-key/leases
  // actually fires under the rig.
  await page.evaluate(() => {
    ((globalThis as unknown) as { localStorage: { setItem(k: string, v: string): void } })
      .localStorage.setItem("flagship.sessionId", "e2e-session-id");
  });

  // Reload home to trigger renderHome → scheduleRenewals → tickRenewals.
  await page.reload();
  await page.fill("#unlock-passphrase", PASSPHRASE);
  await page.click("#unlock-go");
  await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });

  // The renewer should have fetched the leases list at least once
  // (it does on home enter). Assert the wire interaction.
  await expect.poll(() => leasesResponses.length, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
});
