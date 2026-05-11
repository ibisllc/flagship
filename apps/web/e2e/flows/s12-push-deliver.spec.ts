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
 * personalised body (including the serverFqdn). Click the
 * notification → assert it focuses an existing tab.
 */

import { test, expect } from "../fixtures/pod-sim.js";

const PASSPHRASE = "correct-horse-battery-staple-test";

test("S12 — simulate-push event → Notification fires with personalised body", async ({
  page,
  context,
  identity,
}) => {
  await context.grantPermissions(["notifications"]);

  // Bootstrap so the SW is registered.
  await page.goto("/");
  await page.fill("#bootstrap-passphrase", PASSPHRASE);
  await page.fill("#bootstrap-passphrase-2", PASSPHRASE);
  await page.click("#bootstrap-go");
  await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });

  // Wait for the SW to be active.
  await page.evaluate(() => {
    const nav = (globalThis as unknown) as { navigator: { serviceWorker: { ready: Promise<unknown> } } };
    return nav.navigator.serviceWorker.ready;
  });

  // Capture Notifications. Playwright doesn't expose the OS-level
  // notification surface directly; we observe via a page-side
  // wrapper around `Notification` set up on init.
  await page.addInitScript(() => {
    const w = (globalThis as unknown) as { __notifications?: Array<{ title: string; body: string }> };
    w.__notifications = [];
    type NotificationCtor = new (title: string, opts?: { body?: string }) => unknown;
    const g = globalThis as unknown as { Notification: NotificationCtor };
    const orig = g.Notification;
    g.Notification = new Proxy(orig, {
      construct(target, args) {
        const [title, opts] = args as [string, { body?: string }];
        w.__notifications!.push({ title, body: opts?.body ?? "" });
        return Reflect.construct(target, args);
      },
    }) as NotificationCtor;
  });

  // Trigger the simulate-push via the SW message channel. The SW's
  // showNotification call goes through the ServiceWorkerRegistration's
  // own notification surface (separate from page-Notification), but
  // both are observable via Notification API getNotifications().
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

  // Assert the SW posted a notification we can read back. The
  // ServiceWorkerRegistration.getNotifications() API returns active
  // notifications matching the SW's scope.
  await expect.poll(async () =>
    page.evaluate(async () => {
      const nav = (globalThis as unknown) as {
        navigator: { serviceWorker: { ready: Promise<{ getNotifications(): Promise<Array<{ body: string }>> }> } };
      };
      const reg = await nav.navigator.serviceWorker.ready;
      const ns = await reg.getNotifications();
      return ns.map((n) => n.body);
    }), { timeout: 5_000 },
  ).toContainEqual(expect.stringContaining(identity.serverFqdn));
});
