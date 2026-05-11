/**
 * S13 — service-worker offline-replay queue.
 *
 * The SW queues idempotent POSTs (orders/send, url-controller/claim,
 * app-backup/start) when the browser is offline, then replays them
 * on `online`. Take the page offline; trigger one of those POSTs;
 * assert 202 queued. Go online; assert the SW source still carries
 * the REPLAY_PATH_PATTERNS (smoke for the queue's wiring).
 */

import { test, expect } from "../fixtures/pod-sim.js";

const PASSPHRASE = "correct-horse-battery-staple-test";

test("S13 — orders/send queued while offline + SW carries the replay patterns", async ({
  page,
  context,
  podSim,
}) => {
  // Bootstrap + pair.
  await page.goto("/");
  await page.fill("#bootstrap-passphrase", PASSPHRASE);
  await page.fill("#bootstrap-passphrase-2", PASSPHRASE);
  await page.click("#bootstrap-go");
  await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });

  await page.click("#open-pod-pair");
  await page.fill("#pod-pair-base", podSim.baseUrl);
  await page.fill("#pod-pair-label", "e2e-s13");
  await page.click("#pod-pair-go");
  await expect.poll(() => podSim.orders.filterByType("add-paired-session").length).toBe(1);
  await page.click("#pod-pair-back");

  // Wait for the SW to become active.
  await page.evaluate(() => {
    const nav = (globalThis as unknown) as { navigator: { serviceWorker: { ready: Promise<unknown> } } };
    return nav.navigator.serviceWorker.ready;
  });

  await context.setOffline(true);

  const offlineResponse = await page.evaluate(async () => {
    const f = (globalThis as unknown) as { fetch: typeof fetch };
    const r = await f.fetch("/api/screens/orders/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "noop", issuedAt: Date.now() }),
    });
    return { status: r.status, body: await r.text() };
  });

  expect(offlineResponse.status).toBe(202);
  expect(offlineResponse.body).toContain("queued");

  await context.setOffline(false);
  await page.waitForTimeout(500);

  // SW source carries the replay-queue wiring.
  const swSource = await page.evaluate(async () => {
    const f = (globalThis as unknown) as { fetch: typeof fetch };
    const r = await f.fetch("/service-worker.js");
    return r.text();
  });
  expect(swSource).toContain("REPLAY_PATH_PATTERNS");
});
