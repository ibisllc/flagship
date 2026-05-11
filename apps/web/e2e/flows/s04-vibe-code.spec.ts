/**
 * S4 — vibe-code dialog.
 *
 * Open the Vibe-code view, type a prompt, click Start. The webapp
 * POSTs /api/screens/vibe-code/start; the pod-sim returns a session
 * id and the webapp opens a WebSocket to the stream URL. The full
 * real-LLM streaming path needs the daemon's LlmHarness; the rig
 * scope is "the click reaches the start endpoint."
 */

import { test, expect, syncWebappPubkey } from "../fixtures/pod-sim.js";

const PASSPHRASE = "correct-horse-battery-staple-test";

test("S4 — vibe-code start hits /api/screens/vibe-code/start with a prompt", async ({
  page,
  podSim,
}) => {
  // Setup.
  await page.goto("/");
  await page.fill("#bootstrap-passphrase", PASSPHRASE);
  await page.fill("#bootstrap-passphrase-2", PASSPHRASE);
  await page.click("#bootstrap-go");
  await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
  await syncWebappPubkey(page, podSim);

  await page.click("#open-pod-pair");
  await page.fill("#pod-pair-base", podSim.baseUrl);
  await page.fill("#pod-pair-label", "e2e-s4");
  await page.click("#pod-pair-go");
  await expect.poll(() => podSim.orders.filterByType("add-paired-session").length).toBe(1);
  await page.click("#pod-pair-back");

  // The pod-sim doesn't currently implement /api/screens/vibe-code/start
  // — intercept on the webapp side to fake a session id, then assert
  // the wire intent.
  let startBody: string | null = null;
  await page.route(`${podSim.baseUrl}/api/screens/vibe-code/start*`, async (route, request) => {
    if (request.method() === "POST") {
      startBody = request.postData();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessionId: "vc-e2e-001" }),
      });
    }
    return route.continue();
  });

  await page.click("#open-vibe-code");
  await expect(page.locator("#view-vibe-code")).toBeVisible();
  await page.fill("#vc-prompt", "A simple habit tracker — checkboxes per day.");
  await page.click("#vc-start");

  await expect.poll(() => startBody, { timeout: 5_000 }).not.toBeNull();
  expect(startBody!).toContain("habit tracker");
});
