/**
 * Home's banners and cards, and the rest of the server page, with no backend:
 * the recovery nudge, the "device was removed" banner, the locked server list,
 * Delete on never-seen / awaiting-backup / pending cards, the operations bar
 * from the keyboard, a cancelled drag, the AI keys chip; and on the server
 * page Pair this server, the Monitoring rows, Lock & restart, the dead-man
 * lock, the journal, the front page, auto-unlock, an update row, the app rows
 * and Create app here, plus a non-admin device's read-only page. Also the
 * Trusted devices "Finalize now" banner and an app's browser viewer.
 *
 * Sensitive orders go through gymKit `sensitive`: the admin root verifies,
 * the IRK gets `.com`'s / the box's 403.
 */

import { test, expect, type Page } from "@playwright/test";
import {
  ACCOUNT_ID,
  HOME,
  MEDIA,
  OFFICE,
  STK,
  USER,
  homeCard as card,
  livePod,
  mock,
  offlinePod,
  reachHome,
  renderHome,
  sawToast,
  sensitive,
  toastMark,
  toasts,
  serverDetail,
  shot,
  signer,
  verifies,
  type Keys,
  type Mock,
} from "./gymKit.js";

test.use({ viewport: { width: 430, height: 932 } });

const SERVICE_ID = "smoketest--notes";
const ATTIC = "attic.smoketest.flagship.services";
const COMMIT_RUNNING = "7ac1b50a".padEnd(40, "1");
const COMMIT_LATEST = "52d0b375".padEnd(40, "3");
const COMMIT_OTHER = "9873b83e".padEnd(40, "4");

const POWER = ["/lib/lockAndPower.js", "canonicalPowerOffBytes"] as [string, string];
const DEADMAN = ["/lib/lockAndPower.js", "canonicalDeadManPolicyBytes"] as [string, string];
const affirmCanon = (r: { serverId: string; nonce: string; issuedAt: number }) =>
  `flagship/deadman-affirm/v1|${r.serverId}|${r.nonce}|${r.issuedAt}`;
const FRONT = ["/lib/frontPage.js", "canonicalSetFrontPageBytes"] as [string, string];
const UPDATE = ["/lib/serverUpdate.js", "canonicalUpdateOrderBytes"] as [string, string];
const DECOMMISSION = ["/lib/serverReplacement.js", "canonicalDecommissionBytes"] as [string, string];
const releaseCanon = (r: { username: string; serverDomain: string; issuedAt: number }) =>
  `flagship/release-server-name/v1|${r.username}|${r.serverDomain}|${r.issuedAt}`;

const METRICS = {
  cpuPercent: 37,
  loadAvg1: 0.5,
  loadAvg5: 0.4,
  loadAvg15: 0.3,
  memUsedBytes: 2 * 1024 ** 3,
  memTotalBytes: 4 * 1024 ** 3,
  diskUsedBytes: 80 * 1024 ** 3,
  diskTotalBytes: 100 * 1024 ** 3,
  diskIOReadBytesPerSec: 4096,
  diskIOWriteBytesPerSec: 2048,
  netRxBytesPerSec: 2048,
  netTxBytesPerSec: 1024,
  cpuHistory: [{ value: 10 }, { value: 40 }, { value: 37 }],
  memHistory: [{ value: 1 }, { value: 2 }],
  netHistory: [{ read: 1, write: 2 }, { read: 3, write: 4 }],
};

/** Everything a server page reads, answered for `fqdn`. */
function serverPage(m: Mock, fqdn: string, pods: unknown[]): Mock {
  m.get("/api/users/smoketest/pods", { pods });
  m.get(`${fqdn}/api/screens/server-detail`, serverDetail(fqdn, { currentCommit: COMMIT_RUNNING }));
  m.get(`${fqdn}/api/screens/server-metrics`, METRICS);
  m.get(`${fqdn}/api/screens/updates`, { latest: null, releases: [] });
  m.get(`${fqdn}/api/screens/apps-list`, {
    apps: [{ serviceId: SERVICE_ID, slug: "notes", creator: USER, status: "running", url: `https://notes.${fqdn}`, urlLabel: "notes" }],
  });
  m.get(`${fqdn}/api/front-page`, { label: null, active: false });
  m.get(`${fqdn}/api/services`, { apps: [{ urlLabel: "notes", name: "Notes" }] });
  m.get(`/api/server/${fqdn}/unlock-key/leases-v2`, { leases: [] });
  return m;
}

/** Open `fqdn`'s page from its Home card. */
async function fromHomeCard(page: Page, fqdn: string): Promise<void> {
  await renderHome(page);
  await card(page, fqdn).click();
  await expect(page.locator("#view-server-detail")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#leader-card")).toHaveAttribute("data-server-fqdn", fqdn, { timeout: 10_000 });
}

async function openServer(page: Page, fqdn: string): Promise<void> {
  await page.evaluate(async (fqdn) => {
    const { enterServerDetail } = await import("/views/server-detail.js");
    await enterServerDetail(fqdn);
  }, fqdn);
}

async function scrollTo(page: Page, sel: string): Promise<void> {
  await page.locator(sel).evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 80));
}

test.describe("gym webapp server page and Home leftovers", () => {
  // ─────────────────────────────── Home ───────────────────────────────

  test("gym serverpage the recovery nudge opens recovery, and once dismissed stays away", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
    await page.evaluate(async () => {
      const store = await import("/lib/profilesStore.js");
      store.set("recoveryWarn", "true");
      store.remove("recoveryBannerDismissed");
    });
    await renderHome(page);
    const banner = page.locator("#home-recovery-banner");
    await expect(banner).toContainText("Your account isn't backed up yet", { timeout: 10_000 });
    await shot(page, testInfo, "home-recovery-nudge");

    // "Secure my account" goes to recovery.
    await banner.locator("[data-ann-cta]").click();
    await expect(page.locator("#view-recovery")).toBeVisible({ timeout: 10_000 });

    // Back on Home the nudge is still there until dismissed; then it's gone for good.
    await page.click('[data-tab-target="home"]');
    await expect(page.locator("#home-recovery-banner")).toBeVisible({ timeout: 10_000 });
    await page.locator("#home-recovery-banner [data-ann-dismiss]").click();
    await expect(page.locator("#home-recovery-banner")).toHaveCount(0);
    const dismissed = await page.evaluate(async () => (await import("/lib/profilesStore.js")).get("recoveryBannerDismissed"));
    expect(dismissed).toBe("true");
    await renderHome(page);
    await expect(card(page, HOME)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#home-recovery-banner")).toHaveCount(0);
  });

  test("gym serverpage a device removed from the account is told so and Sign in again reloads to unlock", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
    // The account's directory no longer lists this device.
    m.get(`/api/accounts/${ACCOUNT_ID}/directory`, {
      accountId: ACCOUNT_ID,
      devices: [{ deviceId: "ee".repeat(16), revokedAt: null }],
      selfProfiles: [],
      managedProfiles: [],
      grants: [],
    });
    await page.evaluate(async () => (await import("/lib/profilesStore.js")).set("sessionV1", JSON.stringify({ username: "smoketest" })));
    await renderHome(page);
    const banner = page.locator("#home-account-reset-banner");
    await expect(banner).toContainText("This device was removed from your account", { timeout: 15_000 });
    await expect(banner.locator("[data-ann-dismiss]")).toHaveCount(0);
    await shot(page, testInfo, "home-device-removed");
    await banner.locator("[data-ann-cta]").click();
    // The page reloads without the session: the signed-in Home is gone, the
    // device's session slots are cleared, and the key asks to be unlocked.
    await expect(page.locator("#view-unlock")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#view-home")).toBeHidden();
    const left = await page.evaluate(async () => (await import("/lib/profilesStore.js")).get("sessionV1"));
    expect(left ?? null).toBeNull();
  });

  test("gym serverpage a locked server list shows Show my servers, which reads it again", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    let refuse = true;
    const m = await mock(page);
    m.get("/api/users/smoketest/stream", () => ({ status: 404, json: { error: "no stream" } }));
    m.get("/api/users/smoketest/pods", () => (refuse ? { status: 401, json: { error: "read token required" } } : { json: { pods: [livePod(HOME)] } }));
    await renderHome(page);
    const locked = page.locator("#home-locked-state");
    await expect(locked).toContainText("Your server list is locked", { timeout: 10_000 });
    await expect(locked).toContainText("Flagship only shows your servers to your own devices.");
    await expect(page.locator("#session-status")).toHaveText("Locked");
    await shot(page, testInfo, "home-locked");
    refuse = false;
    const before = m.sent("/api/users/smoketest/pods", "GET").length;
    await page.click("#home-show-my-servers");
    await expect(card(page, HOME)).toBeVisible({ timeout: 10_000 });
    expect(m.sent("/api/users/smoketest/pods", "GET").length).toBeGreaterThan(before);
    await expect(page.locator("#home-locked-state")).toHaveCount(0);
  });

  test("gym serverpage Delete on a never-seen card wipes and frees its name under the admin root", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", {
      pods: [livePod(HOME), { serverDomain: MEDIA, identityPubKey: STK[MEDIA], liveness: "never", registeredAt: Date.now() - 3 * 86_400_000 }],
    });
    m.post(`/api/server/${MEDIA}/decommission`, sensitive(page, keys, DECOMMISSION, (b) => ({ arg: b.order, sig: b.signature }), () => ({ json: { ok: true } })));
    m.post("/api/server/release", sensitive(page, keys, releaseCanon, (b) => ({ arg: b.request, sig: b.signature }), () => ({ json: { ok: true, released: true } })));
    await renderHome(page);
    await expect(card(page, MEDIA)).toContainText("Never came online", { timeout: 10_000 });
    const del = page.locator(`#servers-list .js-delete-server[data-fqdn="${MEDIA}"]`);
    await expect(del).toHaveText("Delete server");
    await shot(page, testInfo, "home-never-seen");
    await del.click();
    // The card's button doesn't open the server page; it opens the typed-name delete.
    const dlg = page.locator('dialog[aria-label="Delete server"]');
    await expect(dlg.locator(".modal-title")).toHaveText("Delete media?");
    await expect(page.locator("#view-home")).toBeVisible();
    await dlg.locator("[data-delete-input]").fill("media");
    await dlg.locator("[data-delete-go]").click();
    await sawToast(page, "Deleted media.");
    const order = m.last(`/api/server/${MEDIA}/decommission`)!;
    expect(order.body.order.diskDisposition).toBe("wipe-now");
    expect(await signer(page, keys, DECOMMISSION, order.body.order, order.body.signature)).toBe("admin");
    const release = m.last("/api/server/release")!;
    expect(release.body.request.serverDomain).toBe(MEDIA);
    expect(await signer(page, keys, releaseCanon, release.body.request, release.body.signature)).toBe("admin");
    await expect(card(page, MEDIA)).toHaveCount(0, { timeout: 10_000 });
  });

  test("gym serverpage Delete on an awaiting-backup card opens the delete and Cancel keeps it", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME), livePod(OFFICE, { awaitingBackup: { archiveId: "ef".repeat(16) } })] });
    await renderHome(page);
    await expect(page.locator(`#servers-list .js-send-backup[data-fqdn="${OFFICE}"]`)).toHaveText("Send the backup", { timeout: 10_000 });
    // A waiting server isn't opened from its card; its own buttons act on it.
    await expect(page.locator("#servers-list")).toContainText("Waiting for its backup");
    await page.locator(`#servers-list .js-delete-server[data-fqdn="${OFFICE}"]`).click();
    const dlg = page.locator('dialog[aria-label="Delete server"]');
    await expect(dlg.locator(".modal-title")).toHaveText("Delete office?");
    await shot(page, testInfo, "home-awaiting-backup-delete");
    await dlg.locator("[data-delete-cancel]").click();
    await expect(dlg).toHaveCount(0);
    expect(m.sent(/\/decommission|\/api\/server\/release/)).toEqual([]);
    await expect(page.locator(`#servers-list .js-send-backup[data-fqdn="${OFFICE}"]`)).toBeVisible();
  });

  test("gym serverpage Delete on a pending order frees the name after the browser's confirm", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    let pending = true;
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", () => ({
      json: { pods: [livePod(HOME)], pending: pending ? [{ fqdn: ATTIC, serverName: "attic", createdAt: Date.now() - 60_000 }] : [] },
    }));
    m.post(
      "/api/server/release",
      sensitive(page, keys, releaseCanon, (b) => ({ arg: b.request, sig: b.signature }), () => {
        pending = false;
        return { json: { ok: true, released: true } };
      }),
    );
    await renderHome(page);
    const del = page.locator(`#servers-list .js-delete-dead-server[data-fqdn="${ATTIC}"]`);
    await expect(del).toHaveText("Delete server (free name)", { timeout: 10_000 });
    await shot(page, testInfo, "home-pending-card");

    // Declining the browser's confirm sends nothing.
    const asked: string[] = [];
    page.once("dialog", (d) => {
      asked.push(d.message());
      void d.dismiss();
    });
    await del.click();
    await expect.poll(() => asked.length).toBe(1);
    expect(asked[0]).toContain(`Delete "${ATTIC}"? This frees the name for reuse`);
    expect(m.sent("/api/server/release")).toHaveLength(0);

    page.once("dialog", (d) => void d.accept());
    await del.click();
    await sawToast(page, `Deleted — "${ATTIC}" is free again`);
    const release = m.last("/api/server/release")!;
    expect(release.body.request).toMatchObject({ username: USER, serverDomain: ATTIC });
    expect(await signer(page, keys, releaseCanon, release.body.request, release.body.signature)).toBe("admin");
    await expect(page.locator(`#servers-list .js-delete-dead-server[data-fqdn="${ATTIC}"]`)).toHaveCount(0, { timeout: 10_000 });
  });

  test("gym serverpage the empty Home links to Flagship Studio in a new tab", async ({ page }) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [] });
    await renderHome(page);
    const studio = page.locator('#servers-list a[href="https://flagshipserver.com/studio"]');
    await expect(studio).toContainText("Get Flagship Studio", { timeout: 10_000 });
    await expect(studio).toHaveAttribute("target", "_blank");
    await expect(studio).toHaveAttribute("rel", /noopener/);
  });

  test("gym serverpage the operations bar opens its operation from the keyboard", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
    const seed = (view: string) =>
      page.evaluate(async (view) => {
        const [{ activeOperations }, { refreshOperationsBar }] = await Promise.all([
          import("/lib/activeOperations.js"),
          import("/lib/operationsBar.js"),
        ]);
        activeOperations.upsertBuild("gym-serverpage-op", "blog", "Home", { view });
        refreshOperationsBar();
      }, view);
    await seed("view-install-progress");
    const bar = page.locator("#global-operations-bar");
    await expect(bar).toBeVisible({ timeout: 10_000 });
    await expect(bar).toHaveAttribute("role", "button");
    await shot(page, testInfo, "ops-bar");
    await bar.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#view-install-progress")).toBeVisible({ timeout: 10_000 });

    await page.click('[data-tab-target="settings"]');
    await seed("view-about");
    await bar.focus();
    await page.keyboard.press(" ");
    await expect(page.locator("#view-about")).toBeVisible({ timeout: 10_000 });
  });

  test("gym serverpage a drag that's cancelled or dropped in place changes nothing", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME, OFFICE] });
    const t0 = Date.now() - 3_600_000;
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", {
      pods: [livePod(HOME, { orderIssuedAt: t0 }), livePod(OFFICE, { orderIssuedAt: t0 })],
      serverOrder: { order: { user: USER, stks: [STK[HOME], STK[OFFICE]], issuedAt: t0, nonce: "ab".repeat(32) }, signature: "00".repeat(64) },
    });
    await renderHome(page);
    const order = () =>
      page.locator("#servers-list [data-server-cards] [data-open-fqdn]").evaluateAll((els) => els.map((e) => e.getAttribute("data-open-fqdn")));
    await expect.poll(order).toEqual([HOME, OFFICE]);

    // Drag office above home, then the pointer is cancelled (a system gesture).
    const handle = card(page, OFFICE).locator(".js-order-handle");
    const hb = (await handle.boundingBox())!;
    const top = (await card(page, HOME).boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2, top.y + 4, { steps: 6 });
    await expect.poll(order).toEqual([OFFICE, HOME]);
    await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, pointerType: "mouse" })));
    await expect.poll(order).toEqual([HOME, OFFICE]);
    await expect(page.locator("#servers-list .is-dragging")).toHaveCount(0);
    await page.mouse.up();
    await shot(page, testInfo, "drag-cancelled");

    // The window losing focus mid-drag ends it the same way.
    const hb2 = (await card(page, OFFICE).locator(".js-order-handle").boundingBox())!;
    await page.mouse.move(hb2.x + hb2.width / 2, hb2.y + hb2.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb2.x + hb2.width / 2, top.y + 4, { steps: 6 });
    await expect.poll(order).toEqual([OFFICE, HOME]);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect.poll(order).toEqual([HOME, OFFICE]);
    await page.mouse.up();

    // A press and release without moving: nothing to save.
    const hb3 = (await card(page, OFFICE).locator(".js-order-handle").boundingBox())!;
    await page.mouse.move(hb3.x + hb3.width / 2, hb3.y + hb3.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await expect.poll(order).toEqual([HOME, OFFICE]);
    expect(m.sent("/server-order")).toEqual([]);
  });

  test("gym serverpage Home's AI provider chip opens AI keys", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
    await page.evaluate(async () => {
      const { renderActiveProviderChip } = await import("/views/home.js");
      await renderActiveProviderChip();
    });
    const chip = page.locator("#home-active-provider");
    await expect(chip).toContainText("Flagship Inference", { timeout: 10_000 });
    await expect(page.locator("#chip-settings")).toHaveText("settings");
    await shot(page, testInfo, "home-provider-chip");
    await page.click("#chip-settings");
    await expect(page.locator("#view-settings")).toBeVisible({ timeout: 10_000 });
  });

  // ──────────────────────────── server page ────────────────────────────

  test("gym serverpage a server this browser has no session for offers Pair this server", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME), livePod(MEDIA)] });
    m.post(`${MEDIA}/api/orders-from-user`, { ok: true });
    await renderHome(page);
    await card(page, MEDIA).click();
    const box = page.locator('[data-unreachable-kind="not-paired"]');
    await expect(box).toContainText("This server isn't paired with this browser yet", { timeout: 10_000 });
    await expect(box).toContainText("Pair it to manage this server here.");
    await expect(page.locator("#delete-server-btn")).toBeVisible();
    await shot(page, testInfo, "server-not-paired");
    const pair = page.locator("#sd-pair-server");
    await expect(pair).toHaveText("Pair this server");
    // A refusal keeps the page and says so in its own words; the next test
    // covers a pairing the box accepts.
    m.first("POST", `${MEDIA}/api/orders-from-user`, () => ({ status: 503, json: { error: "busy" } }));
    const mark = await toastMark(page);
    await pair.click();
    await sawToast(page, "The server didn't accept the pairing. Try again in a moment.", 15_000, mark);
    await expect(pair).toBeEnabled();
    await expect(pair).toHaveText("Pair this server");
  });

  // Auto-pair used to read `pod.fqdn`, which /pods rows don't carry, so no
  // registered box was ever paired and Pair this server always failed.
  test("gym serverpage Pair this server pairs a server this browser has no session for", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    let allowPair = false;
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME), livePod(MEDIA)] });
    m.get(`${MEDIA}/api/screens/server-detail`, serverDetail(MEDIA));
    // Background auto-pair is held off until the button is pressed.
    m.post(`${MEDIA}/api/orders-from-user`, () => (allowPair ? { json: { ok: true } } : { status: 503, json: { error: "busy" } }));
    await openServer(page, MEDIA);
    await expect(page.locator('[data-unreachable-kind="not-paired"]')).toBeVisible({ timeout: 10_000 });
    const pair = page.locator("#sd-pair-server");
    await expect(pair).toHaveText("Pair this server");
    await shot(page, testInfo, "server-not-paired");
    allowPair = true;
    await pair.click();
    await sawToast(page, "Paired");
    const order = m.last(`${MEDIA}/api/orders-from-user`)!;
    expect(order.body.request).toMatchObject({ type: "add-paired-session", serverId: MEDIA });
    expect(order.body.request.token).toMatch(/^[0-9a-f]{64}$/);
    // The page reads the box with its new session.
    await expect(page.locator("#leader-card")).toHaveAttribute("data-server-fqdn", MEDIA, { timeout: 10_000 });
    const token = await page.evaluate(async (fqdn) => (await import("/lib/api.js")).sessionTokenForPod(fqdn), MEDIA);
    expect(token).toBe(order.body.request.token);
  });

  test("gym serverpage Monitoring rows open and close and show the box's numbers", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = serverPage(await mock(page), HOME, [
      livePod(HOME, {
        health: { receivedAt: Date.now(), memAvailMB: 2048, memTotalMB: 4096, diskUsedPct: 80, uptimeS: 7200, daemon: { state: "active", restarts: 0 }, tunnel: false, oomKills: 0 },
      }),
    ]);
    m.get("/api/users/smoketest/stream", () => ({ status: 404, json: { error: "no stream" } }));
    await fromHomeCard(page, HOME);
    await page.evaluate(async () => (await import("/lib/liveSync.js")).liveSync.refresh());

    const row = (key: string) => page.locator(`[data-monitor="${key}"]`);
    // Health needs attention, so it opens itself; its button folds it.
    await expect(row("health").locator(".monitor-value")).toHaveText("Needs attention", { timeout: 15_000 });
    await expect(row("health").locator(".monitor-detail")).toContainText("Can't reach the Flagship relay.");
    await expect(page.locator("#monitor-health-btn")).toHaveAttribute("aria-expanded", "true");
    await page.click("#monitor-health-btn");
    await expect(page.locator("#monitor-health-btn")).toHaveAttribute("aria-expanded", "false");
    await expect(row("health").locator(".monitor-detail")).toBeHidden();

    await expect(row("cpu").locator(".monitor-value")).toHaveText("37%", { timeout: 15_000 });
    await expect(row("memory").locator(".monitor-value")).toHaveText("2.0 GB of 4.0 GB");
    await expect(row("disk").locator(".monitor-value")).toHaveText("80% used");
    await expect(row("disk")).toHaveAttribute("data-tone", "warn");
    await expect(row("network").locator(".monitor-value")).toHaveText("↓ 2 KB/s  ↑ 1 KB/s");
    await expect(row("certificate").locator(".monitor-value")).toContainText("Valid until");
    const expect1 = async (key: string, text: string | RegExp) => {
      await page.click(`#monitor-${key}-btn`);
      await expect(page.locator(`#monitor-${key}-btn`)).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator(`#monitor-${key}-detail`)).toBeVisible();
      await expect(page.locator(`#monitor-${key}-detail`)).toContainText(text);
    };
    await expect1("cpu", "Load 0.50 · 0.40 · 0.30");
    await expect1("memory", "50% in use");
    await expect1("disk", "Total");
    await expect1("network", "In");
    await expect1("certificate", "Names covered");
    await expect(page.locator("#monitor-certificate-detail")).toContainText(HOME);
    await scrollTo(page, "#monitor-section");
    await shot(page, testInfo, "monitoring-open");
    await page.click("#monitor-cpu-btn");
    await expect(page.locator("#monitor-cpu-detail")).toBeHidden();
  });

  test("gym serverpage Lock and restart asks, counts down and sends a signed restart", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = serverPage(await mock(page), HOME, [livePod(HOME)]);
    m.post(`${HOME}/api/power`, sensitive(page, keys, POWER, (b) => ({ arg: b.request, sig: b.signature }), () => ({ json: { ok: true } })));
    await fromHomeCard(page, HOME);
    const btn = page.locator("#power-restart-btn");
    await expect(btn).toHaveText("Lock and restart");
    await btn.click();
    const dlg = page.locator('dialog[aria-label="Lock and restart"]');
    await expect(dlg.locator(".modal-title")).toHaveText("Lock and restart?");
    await expect(dlg).toContainText(`${HOME} will go offline.`);
    await dlg.locator("[data-power-cancel]").click();
    await expect(dlg).toHaveCount(0);
    expect(m.sent("/api/power")).toHaveLength(0);

    await btn.click();
    await shot(page, testInfo, "power-restart-confirm");
    await page.locator('dialog[aria-label="Lock and restart"] [data-power-go]').click();
    // A three-second countdown on the button, then the order.
    await expect(btn).toHaveText(/Lock and restart in \d…/);
    const post = await m.waitFor(`${HOME}/api/power`);
    expect(post.body.request).toMatchObject({ type: "power-off", serverId: HOME, mode: "restart" });
    expect(await signer(page, keys, POWER, post.body.request, post.body.signature)).toBe("admin");
    await expect(page.locator("#power-status")).toHaveText("Restarting — the server will go offline briefly.", { timeout: 10_000 });
    await sawToast(page, "Lock and restart sent");
    await expect(btn).toHaveText("Lock and restart");
  });

  test("gym serverpage the dead-man lock enables, affirms, tightens and disables under the admin root", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = serverPage(await mock(page), HOME, [livePod(HOME)]);
    const lease = Date.now() + 8 * 3_600_000;
    m.post(`${HOME}/api/deadman/policy`, sensitive(page, keys, DEADMAN, (b) => ({ arg: b.request, sig: b.signature }), () => ({ json: { ok: true } })));
    m.post(`${HOME}/api/deadman/affirm`, sensitive(page, keys, affirmCanon, (b) => ({ arg: b.request, sig: b.signature }), () => ({ json: { ok: true, leaseExpiry: lease } })));
    await fromHomeCard(page, HOME);
    await scrollTo(page, "#deadman-card");
    await expect(page.locator("#deadman-pill")).toHaveText("off");
    await expect(page.locator("#deadman-disable-btn")).toBeHidden();

    // 8 hours, restart on lockout, Enable.
    await page.selectOption("#deadman-window", "8h");
    await page.selectOption("#deadman-lockout", "restart");
    await page.click("#deadman-enable-btn");
    const on = await m.waitFor(`${HOME}/api/deadman/policy`);
    expect(on.body.request).toMatchObject({ serverId: HOME, enabled: true, windowMs: 8 * 3_600_000, graceMs: 2 * 3_600_000, lockoutMode: "restart" });
    expect(await signer(page, keys, DEADMAN, on.body.request, on.body.signature)).toBe("admin");
    await expect(page.locator("#deadman-pill")).toHaveText("on");
    await expect(page.locator("#deadman-enable-btn")).toHaveText("Update window");
    await expect(page.locator("#deadman-remaining")).toHaveText("affirm to start the lease");
    await shot(page, testInfo, "deadman-on");

    // Affirm: a fresh nonce, signed, and the countdown starts.
    await page.click("#deadman-affirm-btn");
    const affirm = await m.waitFor(`${HOME}/api/deadman/affirm`);
    expect(affirm.body.request.serverId).toBe(HOME);
    expect(affirm.body.request.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(await signer(page, keys, affirmCanon, affirm.body.request, affirm.body.signature)).toBe("admin");
    await expect(page.locator("#deadman-remaining")).toHaveText(/^7h 59m \d+s left$/, { timeout: 10_000 });
    await sawToast(page, "Affirmed — lease renewed");

    // Tighten now: the shortest window.
    await page.click("#deadman-tighten-btn");
    const tight = await m.waitFor(`${HOME}/api/deadman/policy`, "POST", 2);
    expect(tight.body.request).toMatchObject({ enabled: true, windowMs: 5 * 60_000, graceMs: 2 * 60_000, lockoutMode: "restart" });
    await expect(page.locator("#deadman-window")).toHaveValue("5m");
    await sawToast(page, "Tightened to 5 minutes (tighten)");

    // Disable.
    await page.click("#deadman-disable-btn");
    const off = await m.waitFor(`${HOME}/api/deadman/policy`, "POST", 3);
    expect(off.body.request.enabled).toBe(false);
    expect(await signer(page, keys, DEADMAN, off.body.request, off.body.signature)).toBe("admin");
    await expect(page.locator("#deadman-pill")).toHaveText("off");
    await expect(page.locator("#deadman-affirm-block")).toBeHidden();
    await sawToast(page, "Dead-man lock disabled");
  });

  test("gym serverpage the journal reads the chosen unit and line count", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = serverPage(await mock(page), HOME, [livePod(HOME)]);
    m.post(`${HOME}/api/journal`, (c) => ({ json: { unit: c.body.request.unit, lines: ["started", "listening on :443"] } }));
    await fromHomeCard(page, HOME);
    await scrollTo(page, "#journal-card");
    await page.selectOption("#journal-unit", "flagship-data-services");
    await page.fill("#journal-lines", "50");
    await page.click("#journal-fetch-btn");
    await expect(page.locator("#journal-output")).toHaveText("started\nlistening on :443", { timeout: 10_000 });
    await expect(page.locator("#journal-status")).toHaveText("2 lines from flagship-data-services.");
    const post = m.last(`${HOME}/api/journal`)!;
    expect(post.body.request).toMatchObject({ serverId: HOME, unit: "flagship-data-services", lines: 50 });
    // A read, not an order: the membership key signs it.
    const canon = (r: { serverId: string; unit: string; lines: number; issuedAt: number }) =>
      `flagship/journal-read/v1|${r.serverId}|${r.unit}|${r.lines}|${r.issuedAt}`;
    expect(await signer(page, keys, canon, post.body.request, post.body.signature)).toBe("irk");
    await shot(page, testInfo, "journal-read");
  });

  test("gym serverpage the front page points visitors at an app under the admin root", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = serverPage(await mock(page), HOME, [livePod(HOME)]);
    m.post(`${HOME}/api/front-page`, sensitive(page, keys, FRONT, (b) => ({ arg: b.request, sig: b.signature }), () => ({ json: { ok: true } })));
    await fromHomeCard(page, HOME);
    const select = page.locator("#front-page-select");
    await expect(select).toBeEnabled({ timeout: 10_000 });
    await expect(select.locator("option")).toHaveText(["Default Flagship page", `Notes — notes.${HOME}`]);
    await select.selectOption("notes");
    await page.click("#front-page-save");
    const post = await m.waitFor(`${HOME}/api/front-page`);
    expect(post.body.request).toMatchObject({ type: "set-front-page", serverId: HOME, label: "notes" });
    expect(await signer(page, keys, FRONT, post.body.request, post.body.signature)).toBe("admin");
    await expect(page.locator("#front-page-status")).toHaveText(`Visitors to ${HOME} now land on notes.${HOME}.`, { timeout: 10_000 });
    await sawToast(page, "Front page set to notes");
    await scrollTo(page, "#front-page-card");
    await shot(page, testInfo, "front-page-set");

    // Back to the default page.
    await select.selectOption("");
    await page.click("#front-page-save");
    const reset = await m.waitFor(`${HOME}/api/front-page`, "POST", 2);
    expect(reset.body.request.label).toBe("");
    await expect(page.locator("#front-page-status")).toHaveText(`Visitors to ${HOME} now see the default Flagship page.`, { timeout: 10_000 });
  });

  test("gym serverpage auto-unlock seals the disk key for this box and lists the lease", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    // A real box identity and a disk key `.com` holds sealed to this account's IRK.
    const fx = await page.evaluate(async () => {
      const ks = await import("/keystore.js");
      const { getSession } = await import("/lib/state.js");
      const boot = (await import("/lib/bootApproval.js"))._internal;
      const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
      const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
      const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
      const irk = await ks.deriveIrkFromSeed(getSession().umk);
      const disk = crypto.getRandomValues(new Uint8Array(32));
      return {
        stkHex: ks.bytesToHex(pub),
        seedHex: ks.bytesToHex(pkcs8.slice(-32)),
        diskHex: ks.bytesToHex(disk),
        sealedHex: ks.bytesToHex(await boot.sealForBoxStk(disk, irk.publicKey)),
      };
    });
    let leases: unknown[] = [];
    const m = serverPage(await mock(page), HOME, [livePod(HOME, { identityPubKey: fx.stkHex })]);
    m.first("GET", `/api/server/${HOME}/unlock-key/leases-v2`, () => ({ json: { leases } }));
    m.get(`/api/server/${HOME}/sealed-luks-key`, { sealedKey: fx.sealedHex });
    m.post(`/api/server/${HOME}/unlock-key/lease-v2`, (c) => {
      leases = [c.body.lease];
      return { json: { ok: true } };
    });
    await fromHomeCard(page, HOME);
    await scrollTo(page, "#auto-unlock-card");
    await expect(page.locator("#auto-unlock-pill")).toHaveText("off", { timeout: 10_000 });
    await page.click("#auto-unlock-enable");
    const post = await m.waitFor(`/api/server/${HOME}/unlock-key/lease-v2`);
    const lease = post.body.lease;
    expect(lease.serverDomain).toBe(HOME);
    expect(lease.stkPub).toBe(fx.stkHex);
    expect(lease.expiresAt - lease.issuedAt).toBe(7 * 86_400_000);
    // Only this box can open the lease, and it holds the same disk key.
    const opened = await page.evaluate(
      async ({ sealed, seed }) => {
        const ks = await import("/keystore.js");
        const boot = (await import("/lib/bootApproval.js"))._internal;
        return ks.bytesToHex(await boot.openSealedWithEd25519Seed(ks.hexToBytes(sealed), ks.hexToBytes(seed)));
      },
      { sealed: lease.sealedKey, seed: fx.seedHex },
    );
    expect(opened).toBe(fx.diskHex);
    expect(await verifies(page, ["/lib/leases.js", "canonicalLeaseV2Bytes"], { ...lease, stkPubHex: lease.stkPub, sealedKeyHex: lease.sealedKey }, post.body.signature, keys.irkPubHex)).toBe(true);
    await sawToast(page, "Auto-unlock on; lease expires");
    await expect(page.locator("#auto-unlock-pill")).toHaveText("on", { timeout: 10_000 });
    await expect(page.locator("#auto-unlock-leases-list")).toContainText(lease.leaseId.slice(0, 12));
    await expect(page.locator("#auto-unlock-enable")).toHaveText("Renew for 7 more days");
    await shot(page, testInfo, "auto-unlock-on");
  });

  test("gym serverpage an update row for another new release orders that release", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = serverPage(await mock(page), HOME, [livePod(HOME)]);
    m.first("GET", `${HOME}/api/screens/updates`, {
      latest: { commit: COMMIT_LATEST, tag: "v1.4.0" },
      releases: [
        { commit: COMMIT_LATEST, tag: "v1.4.0", relation: "newer" },
        { commit: COMMIT_OTHER, tag: "v1.3.9", relation: "newer" },
        { commit: COMMIT_RUNNING, tag: "v1.3.2", relation: "current" },
      ],
    });
    m.post(`/api/server/${HOME}/update`, sensitive(page, keys, UPDATE, (b) => ({ arg: b.order, sig: b.signature }), () => ({ json: { ok: true, expiresAt: Date.now() + 3_600_000 } })));
    await fromHomeCard(page, HOME);
    await page.click("#update-server-btn");
    const dlg = page.locator('dialog[aria-label="Update this server"]');
    const row = dlg.locator(`[data-update-others] [data-update-action="update"][data-update-commit="${COMMIT_OTHER}"]`);
    await expect(row).toHaveText("Update", { timeout: 10_000 });
    await shot(page, testInfo, "update-other-row");
    await row.click();
    await expect(dlg.locator("[data-update-pending='sent']")).toContainText("Update to v1.3.9 sent", { timeout: 10_000 });
    const post = m.last(`/api/server/${HOME}/update`)!;
    expect(post.body.order).toMatchObject({ serverDomain: HOME, targetCommit: COMMIT_OTHER, fromCommit: COMMIT_RUNNING });
    expect(await signer(page, keys, UPDATE, post.body.order, post.body.signature)).toBe("admin");
  });

  test("gym serverpage an app row opens the app and Back returns to the server, Create app here opens Build", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = serverPage(await mock(page), HOME, [livePod(HOME)]);
    m.get(`${HOME}/api/screens/app-detail/${SERVICE_ID}`, {
      app: { serviceId: SERVICE_ID, slug: "notes", creator: USER, summary: "Notes", status: "running", version: "1.0.0", url: `https://notes.${HOME}` },
      manifest: { name: "notes", runtime: { base: "node-24" } },
      dataLayerInstances: [],
      members: [],
      editable: false,
    });
    await fromHomeCard(page, HOME);
    const app = page.locator(`#server-apps [data-open-app="${SERVICE_ID}"]`);
    await expect(app).toContainText("notes", { timeout: 10_000 });
    await shot(page, testInfo, "server-apps");
    await app.click();
    await expect(page.locator("#view-service-detail")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#service-detail-content")).toContainText("notes", { timeout: 10_000 });
    expect(m.sent(`${HOME}/api/screens/app-detail/${SERVICE_ID}`, "GET").length).toBeGreaterThan(0);
    await page.click("#service-detail-back");
    await expect(page.locator("#leader-card")).toHaveAttribute("data-server-fqdn", HOME, { timeout: 10_000 });

    await page.locator("#server-create-app").click();
    await expect(page.locator("#view-build-source")).toBeVisible({ timeout: 10_000 });
  });

  test("gym serverpage a non-admin device sees power, dead-man and front page off", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "non-admin", servers: [HOME] });
    const m = serverPage(await mock(page), HOME, [livePod(HOME)]);
    await fromHomeCard(page, HOME);
    const sentence = "Only an admin device can change this server. This device can see it.";
    await expect(page.locator("[data-server-admin-only]")).toHaveText(sentence, { timeout: 10_000 });
    for (const id of ["#power-off-btn", "#power-restart-btn", "#deadman-window", "#deadman-lockout", "#deadman-enable-btn", "#deadman-tighten-btn", "#front-page-save"]) {
      await expect(page.locator(id), id).toBeDisabled();
      await expect(page.locator(id), id).toHaveAttribute("title", sentence);
    }
    // The front page stays off even after its options load.
    await expect(page.locator("#front-page-select option")).toHaveCount(2, { timeout: 10_000 });
    await expect(page.locator("#front-page-select")).toBeDisabled();
    // Reads still work: the journal and the monitoring rows.
    await expect(page.locator("#journal-fetch-btn")).toBeEnabled();
    await expect(page.locator("#monitor-cpu-btn")).toBeEnabled();
    await scrollTo(page, "#lock-power-card");
    await shot(page, testInfo, "server-non-admin-controls");
    expect(m.sent(/\/api\/(power|deadman|front-page)/)).toEqual([]);
  });

  test("gym serverpage Trusted devices finalizes a replacement once its grace is over", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    let completesAt = Date.now() + 2 * 86_400_000;
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
    m.get(`/api/accounts/${ACCOUNT_ID}/directory`, { accountId: ACCOUNT_ID, devices: [], selfProfiles: [], managedProfiles: [], grants: [] });
    m.get("/api/users/smoketest/re-pair", () => ({ json: { pending: { completesAt, initiatedAt: Date.now() - 86_400_000 } } }));
    m.post("/api/users/smoketest/re-pair/complete", { ok: true });
    const open = async () => {
      await page.click('[data-tab-target="settings"]');
      await page.click("#settings-tab-trusted-devices");
      await expect(page.locator("#view-trusted-devices")).toBeVisible({ timeout: 10_000 });
    };
    // Inside the grace window: shown, but Finalize waits.
    await open();
    const fin = page.locator("#finalize-replace-btn");
    await expect(fin).toBeDisabled({ timeout: 10_000 });
    await expect(page.locator("[data-pending-re-pair]")).toContainText("finalize when the 3-day grace elapses");
    await shot(page, testInfo, "finalize-waiting");

    // After it: Finalize signs with the next key and installs it.
    completesAt = Date.now() - 60_000;
    await page.click("#trusted-devices-back");
    await open();
    await expect(page.locator("[data-pending-re-pair]")).toContainText("The grace window has elapsed", { timeout: 10_000 });
    const before = await page.evaluate(async () => (await import("/keystore.js")).currentIrkVersion());
    await page.locator("#finalize-replace-btn").click();
    const post = await m.waitFor("/api/users/smoketest/re-pair/complete");
    expect(post.body.request.username).toBe(USER);
    expect(post.body.request.newIrkPub).toMatch(/^[0-9a-f]{64}$/);
    await sawToast(page, "Replace complete.");
    const after = await page.evaluate(async () => (await import("/keystore.js")).currentIrkVersion());
    expect(after).toBe(before + 1);
  });

  test("gym serverpage an app's browser viewer lists its tabs and refreshes them", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
    m.get(`${HOME}/api/screens/app-detail/${SERVICE_ID}`, {
      app: { serviceId: SERVICE_ID, slug: "notes", creator: USER, summary: "Notes", status: "running", version: "1.0.0", url: `https://notes.${HOME}` },
      manifest: { name: "notes", runtime: { base: "node-24" }, browser: { start: "https://example.com" } },
      dataLayerInstances: [],
      members: [],
      browserTabs: [{ tabId: "t1" }],
      editable: false,
    });
    let tabs = [{ tabId: "t1", title: "Sign in", currentUrl: "https://example.com/login" }];
    m.get(`${HOME}/api/screens/browser-tabs/list/${SERVICE_ID}`, () => ({ json: { tabs } }));
    await page.evaluate(async (id) => {
      const { enterServiceDetail } = await import("/views/service-detail.js");
      await enterServiceDetail(id);
    }, SERVICE_ID);
    await page.locator("#sd-open-browser").click();
    await expect(page.locator("#view-browser-viewer")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#bv-app-id")).toHaveText(SERVICE_ID);
    await expect(page.locator("#bv-tabs")).toContainText("Sign in", { timeout: 10_000 });
    await expect(page.locator("#bv-tabs")).toContainText("https://example.com/login");
    await shot(page, testInfo, "browser-viewer");
    tabs = [];
    await page.click("#bv-refresh");
    await expect(page.locator("#bv-tabs")).toContainText("no tabs open for this app", { timeout: 10_000 });
    await page.click("#browser-viewer-back");
    await expect(page.locator("#view-browser-viewer")).toBeHidden();
    // Back returns to the app it was opened from.
    await expect(page.locator("#view-service-detail")).toBeVisible({ timeout: 10_000 });
  });
});

// Keep the imported helpers referenced for the type checker.
void offlinePod;
void (null as unknown as Keys);
