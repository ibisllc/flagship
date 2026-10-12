/**
 * S11 — Web Push subscribe flow (Settings → Notifications).
 *
 * With notification permission granted but this browser not yet subscribed,
 * the Notifications card offers "Allow browser notifications". Clicking it
 * fetches the VAPID key from .com, subscribes the service worker's
 * PushManager with it, and POSTs an IRK-signed /api/push/register
 * (platform=webpush) carrying the subscription.
 *
 * Headless Chromium has no push service, so PushManager.subscribe is
 * replaced with a fake subscription; `.com` is stubbed. The signature is
 * checked with @flagship/protocol's verifier.
 */

import { test, expect, bootstrapToHome, syncWebappPubkey, routeServiceWorkerToWebappHost } from "../fixtures/pod-sim.js";
import { verifyPushTokenRegister } from "@flagship/protocol";

// PushManager.subscribe requires a SW registration; the project default
// blocks SWs so other tests get clean page.route interception.
test.use({ serviceWorkers: "allow" });

const PASSPHRASE = "correct-horse-battery-staple-test";
// A syntactically valid uncompressed P-256 point (65 bytes, 0x04 prefix).
const FAKE_VAPID = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString("base64url");
const FAKE_ENDPOINT = "https://push.example.test/e2e/subscription-1";

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

test("S11 — enable browser notifications + register webpush token", async ({
  page,
  context,
  identity,
  podSim,
}) => {
  await context.grantPermissions(["notifications"]);
  await routeServiceWorkerToWebappHost(context);

  // No push service in headless Chromium: hand out a fake subscription and
  // record the application server key the webapp subscribed with. The
  // headless shell also reports Notification.permission "denied" even after
  // grantPermissions, so present the granted state the OS prompt would.
  await page.addInitScript((endpoint) => {
    type FakeSub = {
      endpoint: string;
      options: { applicationServerKey: ArrayBuffer; userVisibleOnly: boolean };
      getKey(name: string): ArrayBuffer;
      unsubscribe(): Promise<boolean>;
    };
    const g = globalThis as unknown as {
      __subscribedWith?: number[];
      Notification: { permission: string; requestPermission(): Promise<string> };
      PushManager: {
        prototype: {
          getSubscription(): Promise<FakeSub | null>;
          subscribe(opts?: { applicationServerKey?: ArrayBuffer | Uint8Array }): Promise<FakeSub>;
        };
      };
    };
    Object.defineProperty(g.Notification, "permission", { get: () => "granted" });
    g.Notification.requestPermission = async () => "granted";
    let sub: FakeSub | null = null;
    g.PushManager.prototype.getSubscription = async () => sub;
    g.PushManager.prototype.subscribe = async (opts) => {
      const key = opts?.applicationServerKey;
      const bytes = key instanceof Uint8Array ? key : new Uint8Array(key ?? new ArrayBuffer(0));
      g.__subscribedWith = Array.from(bytes);
      const created: FakeSub = {
        endpoint,
        options: { applicationServerKey: new Uint8Array(bytes).buffer, userVisibleOnly: true },
        getKey: (name) => new Uint8Array(name === "p256dh" ? 65 : 16).fill(9).buffer,
        unsubscribe: async () => { sub = null; return true; },
      };
      sub = created;
      return created;
    };
  }, FAKE_ENDPOINT);

  // Stub .com on both the page and the context: the page fixture's
  // catch-all page.route outranks context routes for page fetches, while a
  // fetch the SW forwards is only visible to the context.
  let fetchedVapid = false;
  let registerBody: string | null = null;
  const stub = async (pattern: string, handler: Parameters<typeof page.route>[1]) => {
    await page.route(pattern, handler);
    await context.route(pattern, handler);
  };
  await stub("**/api/push/vapid-public-key", (route) => {
    fetchedVapid = true;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ key: FAKE_VAPID }) });
  });
  await stub("**/api/push/register", async (route, request) => {
    if (request.method() !== "POST") return route.continue();
    registerBody = request.postData();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tokenId: "pushtok-" + identity.username }),
    });
  });

  await page.goto("/");
  await bootstrapToHome(page, PASSPHRASE);
  const irkPubHex = await syncWebappPubkey(page, podSim);
  // bootstrapToHome skips the account-claim wizard; give the session its handle.
  await page.evaluate(async (username) => {
    const state = (await import("/lib/state.js" as string)) as { getSession(): { username: string | null } };
    state.getSession().username = username;
  }, identity.username);

  await page.click('[data-tab-target="settings"]');
  await page.click("#settings-tab-push");
  await expect(page.locator("#view-settings")).toBeVisible();
  await expect(page.locator("#push-switch")).toBeChecked();
  await expect(page.locator("#push-status")).toHaveText("not allowed yet");
  await page.click("#push-enable");

  await expect.poll(() => registerBody, { timeout: 10_000 }).not.toBeNull();
  await expect(page.locator("#toast")).toContainText("Notifications enabled");
  await expect(page.locator("#push-status")).toHaveText("on");
  expect(fetchedVapid).toBe(true);
  const subscribedWith = await page.evaluate(() => (globalThis as unknown as { __subscribedWith?: number[] }).__subscribedWith);
  expect(Buffer.from(subscribedWith ?? []).toString("base64url")).toBe(FAKE_VAPID);

  const parsed = JSON.parse(registerBody!) as {
    request: {
      username: string;
      deviceId: string;
      platform: "webpush";
      providerToken: string;
      pushX25519Pub: string;
      issuedAt: number;
    };
    signature: string;
  };
  expect(parsed.request.platform).toBe("webpush");
  expect(parsed.request.username).toBe(identity.username);
  expect(parsed.request.deviceId).toMatch(/^[0-9a-f]{32}$/);
  const token = JSON.parse(parsed.request.providerToken) as { endpoint: string; keys: Record<string, string> };
  expect(token.endpoint).toBe(FAKE_ENDPOINT);
  expect(Object.keys(token.keys).sort()).toEqual(["auth", "p256dh"]);
  const ok = verifyPushTokenRegister(
    { ...parsed.request, pushX25519Pub: hexToBytes(parsed.request.pushX25519Pub) },
    hexToBytes(parsed.signature),
    hexToBytes(irkPubHex),
  );
  expect(ok).toBe(true);
});
