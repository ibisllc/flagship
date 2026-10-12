/**
 * S4 — start a vibe-code build.
 *
 * Services tab → Vibe-code → "Start from scratch with AI" → the AI-key step
 * (add a BYOK key, then "Use this") → the build chat. Name the service, type a
 * prompt, click Build it. The webapp POSTs /api/screens/vibe-code/start to the
 * paired box carrying the prompt, the chosen name and the in-memory
 * credential. The real LLM loop needs the daemon's LlmHarness; the rig scope is
 * "the click reaches the start endpoint with the right body, and the key goes
 * to the box, never to flagshipserver.com".
 */

import { test, expect, bootstrapToHome, syncWebappPubkey } from "../fixtures/pod-sim.js";

const PASSPHRASE = "correct-horse-battery-staple-test";
const API_KEY = "sk-ant-e2e-test-0000000000000000";

test("S4 — vibe-code start hits /api/screens/vibe-code/start with a prompt", async ({
  page,
  podSim,
}) => {
  await page.goto("/");
  await bootstrapToHome(page, PASSPHRASE);
  await syncWebappPubkey(page, podSim);

  await page.locator("#view-home .advanced-disclosure").evaluate((d) => { (d as unknown as { open: boolean }).open = true; });
  await page.click("#open-pod-pair");
  await page.fill("#pod-pair-base", podSim.baseUrl);
  await page.click("#pod-pair-go");
  await expect.poll(() => podSim.orders.filterByType("add-paired-session").length).toBe(1);
  await page.click("#pod-pair-back");

  // The pod-sim doesn't implement /api/screens/vibe-code/start — intercept
  // on the webapp side to fake a session id, then assert the wire intent.
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
  // The raw key must never reach the control plane.
  const keyLeaks: string[] = [];
  page.on("request", (req) => {
    if (req.url().startsWith(podSim.baseUrl)) return;
    if ((req.postData() ?? "").includes(API_KEY) || req.url().includes(API_KEY)) keyLeaks.push(req.url());
  });

  await page.click('[data-tab-target="apps"]');
  await expect(page.locator("#view-services-list")).toBeVisible();
  await page.click("#services-list-open-vibe-code");
  await expect(page.locator("#view-build-source")).toBeVisible();
  await page.click("#build-src-scratch");

  // AI-key step: with no saved keys the add form opens on its own.
  await expect(page.locator("#view-build-key")).toBeVisible();
  await expect(page.locator("#build-key-form")).toBeVisible();
  await page.selectOption("#bk-provider", "anthropic");
  await page.fill("#bk-key", API_KEY);
  await page.click("#bk-add");
  await page.locator("#build-key-saved [data-use-id]").first().click();

  await expect(page.locator("#view-vibe-code")).toBeVisible();
  await page.fill("#vc-name", "habits");
  await page.fill("#vc-prompt", "A simple habit tracker — checkboxes per day.");
  await expect(page.locator("#vc-send")).toBeEnabled();
  await page.click("#vc-send");

  await expect.poll(() => startBody, { timeout: 5_000 }).not.toBeNull();
  const body = JSON.parse(startBody!) as {
    prompt: string;
    name: string;
    credential?: { provider: string; apiKey: string };
  };
  expect(body.prompt).toContain("habit tracker");
  expect(body.name).toBe("habits");
  expect(body.credential?.provider).toBe("anthropic");
  expect(body.credential?.apiKey).toBe(API_KEY);
  expect(keyLeaks).toEqual([]);
});
