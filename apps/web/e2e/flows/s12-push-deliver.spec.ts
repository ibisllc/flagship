/**
 * S12 — Web Push delivery (synthetic push event via the SW shim).
 *
 * Real push delivery needs a real push service; the headless
 * Chromium under Playwright doesn't have one. The SW carries an
 * `e2e simulate-push` message handler (gated on the
 * `flagship-e2e:simulate-push` message type) that synthesises a
 * push event identical to what RFC 8291 decryption would produce.
 *
 * We send the message → assert Notification fired with the
 * personalised body (including the serverFqdn).
 */

import { test, expect, bootstrapToHome, routeServiceWorkerToWebappHost } from "../fixtures/pod-sim.js";

// S12 needs the SW (it pings the SW with a simulate-push message).
// Project default blocks SWs; re-enable for this scenario.
test.use({ serviceWorkers: "allow" });

const PASSPHRASE = "correct-horse-battery-staple-test";

test("S12 — simulate-push event → Notification fires with personalised body", async ({
  page,
  context,
  identity,
}) => {
  await context.grantPermissions(["notifications"]);

  // Bootstrap so the SW is registered.
  await routeServiceWorkerToWebappHost(context);
  await page.goto("/");
  await bootstrapToHome(page, PASSPHRASE);

  // Wait for the SW to be active.
  await page.evaluate(() => {
    const nav = (globalThis as unknown) as { navigator: { serviceWorker: { ready: Promise<unknown> } } };
    return nav.navigator.serviceWorker.ready;
  });

  // Headless Chromium has no notification service, so a real
  // showNotification resolves without surfacing anything (getNotifications()
  // stays empty). Record the SW's showNotification calls from inside the
  // worker instead, so the assertion is on exactly what the SW asked the
  // platform to display.
  const sw = context.serviceWorkers().find((w) => w.url().endsWith("/service-worker.js"))
    ?? (await context.waitForEvent("serviceworker"));
  await sw.evaluate(() => {
    const g = globalThis as unknown as {
      __shown?: Array<{ title: string; body: string; tag?: string }>;
      registration: { showNotification(title: string, opts?: { body?: string; tag?: string }): Promise<void> };
    };
    g.__shown = [];
    const orig = g.registration.showNotification.bind(g.registration);
    g.registration.showNotification = (title, opts) => {
      g.__shown!.push({ title, body: opts?.body ?? "", tag: opts?.tag });
      return orig(title, opts);
    };
  });

  // Trigger the simulate-push via the SW message channel.
  await page.evaluate(async (fqdn) => {
    const nav = (globalThis as unknown) as {
      navigator: { serviceWorker: { ready: Promise<{ active: { postMessage(m: unknown): void } | null }> } };
    };
    const reg = await nav.navigator.serviceWorker.ready;
    if (!reg.active) throw new Error("no active SW");
    reg.active.postMessage({
      type: "flagship-e2e:simulate-push",
      payload: { kind: "unlock-request", serverFqdn: fqdn, requestId: "req-e2e-001" },
    });
  }, identity.serverFqdn);

  await expect
    .poll(() => sw.evaluate(() => (globalThis as unknown as { __shown?: unknown[] }).__shown ?? []), { timeout: 10_000 })
    .toContainEqual({
      title: "Flagship",
      body: `${identity.serverFqdn} is asking to boot — tap to review.`,
      tag: "flagship-unlock-request",
    });
});
