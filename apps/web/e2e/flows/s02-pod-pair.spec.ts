/**
 * S2 — pod-pair scenario.
 *
 * Drives the webapp through the bootstrap + pod-pair flow:
 *   bootstrap passphrase → home → "Pair to a server" → paste pod URL
 *   → click Pair → toast "paired".
 *
 * Asserts at the pod-sim side that exactly one add-paired-session
 * order arrived and the IRK signature verified. This is the smallest
 * full-chain scenario; if it passes, the rig works.
 */

import { test, expect, syncWebappPubkey } from "../fixtures/pod-sim.js";

const PASSPHRASE = "correct-horse-battery-staple-test";

test("S2 — pair the webapp with the pod-sim", async ({ page, identity, podSim }) => {
  // 1. Bootstrap.
  await page.goto("/");
  await expect(page.locator("#view-bootstrap")).toBeVisible();
  await page.fill("#bootstrap-passphrase", PASSPHRASE);
  await page.fill("#bootstrap-passphrase-2", PASSPHRASE);
  await page.click("#bootstrap-go");
  await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });

  // The webapp's bootstrap minted a fresh random UMK in-browser, so
  // its derived IRK pubkey differs from the test fixture's. Sync it
  // to the pod-sim before any signed order goes out.
  await syncWebappPubkey(page, podSim);

  // 2. Pod pairing.
  await page.locator("#view-home .advanced-disclosure").evaluate((d) => { d.open = true; });
  await page.click("#open-pod-pair");
  await expect(page.locator("#view-pod-pair")).toBeVisible();
  await page.fill("#pod-pair-base", podSim.baseUrl);
  await page.click("#pod-pair-go");

  // 3. Wait for the pod-sim to receive the order. The webapp shows
  // a toast on success but we assert the wire side directly.
  await expect.poll(() => podSim.orders.filterByType("add-paired-session").length, {
    timeout: 5_000,
  }).toBe(1);

  const order = podSim.orders.filterByType("add-paired-session")[0]!;
  const raw = order.raw as { serverId: string; token: string; label: string };
  // pairWithPod sets serverId = new URL(baseUrl).host. In production that
  // resolves to the pod's FQDN (home.alice.flagship.services); in the
  // rig we run pod-sim on a loopback random port, so we compare against
  // the URL host directly.
  expect(raw.serverId).toBe(new URL(podSim.baseUrl).host);
  expect(raw.label).toBe(`e2e-${identity.username}`);
  expect(raw.token).toMatch(/^[0-9a-f]{64}$/);

  // 4. The session token should now be a valid paired-session on
  // the pod-sim — calling /api/screens/server-detail with it should 200.
  const detailRes = await page.request.get(`${podSim.baseUrl}/api/screens/server-detail`, {
    headers: { "x-flagship-session": raw.token },
  });
  expect(detailRes.status()).toBe(200);

  // 5. The webapp should have persisted podBaseUrl + sessionToken.
  // The eval runs in the browser; `any` cast sidesteps the DOM-lib
  // gap in this tsconfig (which excludes DOM so @flagship/protocol's
  // source-resolution doesn't drag in incompatible Uint8Array shapes).
  const podBaseUrl = await page.evaluate(
    () => ((globalThis as unknown) as { localStorage: { getItem(k: string): string | null } })
      .localStorage.getItem("flagship.podBaseUrl"),
  );
  const sessionToken = await page.evaluate(
    () => ((globalThis as unknown) as { localStorage: { getItem(k: string): string | null } })
      .localStorage.getItem("flagship.sessionToken"),
  );
  expect(podBaseUrl).toBe(podSim.baseUrl);
  expect(sessionToken).toBe(raw.token);
});
