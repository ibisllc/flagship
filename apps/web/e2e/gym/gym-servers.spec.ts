/**
 * Servers (docs/server-order.md, the update lane, reversible revoke): the
 * webapp's server surfaces with no backend. Home's server order (drag + the
 * keyboard steps, the Leader badge that stays gray until the leader holds the
 * order), Add/Restore server, the server page's Make leader and update card
 * (last-update verdict, the release list, ordering an update and the pending
 * state it leaves), and a revoked server's Un-revoke and Delete.
 *
 * Crypto is real. The session is an admin device unless a test says
 * otherwise, and the mock answers every sensitive order the way `.com` does
 * on an admin-pinned account (gymKit `sensitive`): only the admin root
 * verifies, the IRK is refused. A demo account (no admin root pinned) keeps
 * the IRK.
 */

import { test, expect, type Page } from "@playwright/test";
import {
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
  sensitive,
  seedSession,
  serverDetail,
  shot,
  signer,
  unlock,
  type Keys,
} from "./gymKit.js";

const COMMIT_RUNNING = "7ac1b50a".padEnd(40, "1");
const COMMIT_ROLLED = "1584bfe8".padEnd(40, "2");
const COMMIT_LATEST = "52d0b375".padEnd(40, "3");
const COMMIT_OTHER = "9873b83e".padEnd(40, "4");
const COMMIT_OLDER = "67cfd8da".padEnd(40, "5");

const ORDER_CANON = ["/lib/serverOrder.js", "canonicalServerOrderBytes"] as [string, string];
const UNREVOKE_CANON = ["/lib/revokeServer.js", "canonicalUnrevokeBytes"] as [string, string];
const UPDATE_CANON = ["/lib/serverUpdate.js", "canonicalUpdateOrderBytes"] as [string, string];
const DECOMMISSION_CANON = ["/lib/serverReplacement.js", "canonicalDecommissionBytes"] as [string, string];
const releaseCanon = (r: { username: string; serverDomain: string; issuedAt: number }) =>
  `flagship/release-server-name/v1|${r.username}|${r.serverDomain}|${r.issuedAt}`;

function wireOrder(stks: string[], issuedAt: number) {
  return { order: { user: USER, stks, issuedAt, nonce: "ab".repeat(32) }, signature: "00".repeat(64) };
}

/** Server cards top to bottom, as their fqdn. */
async function shownOrder(page: Page): Promise<string[]> {
  return page.locator("#servers-list [data-server-cards] [data-open-fqdn]").evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-open-fqdn") ?? ""),
  );
}

async function openServer(page: Page, fqdn: string): Promise<void> {
  await page.evaluate(async (fqdn) => {
    const { enterServerDetail } = await import("/views/server-detail.js");
    await enterServerDetail(fqdn);
  }, fqdn);
}

/** `.com`'s server-order endpoint for an admin-pinned account. */
function serverOrderRule(page: Page, keys: Keys) {
  return sensitive(page, keys, ORDER_CANON, (b) => ({ arg: b.order, sig: b.signature }), () => ({ json: { ok: true } }));
}

async function dragAbove(page: Page, moving: string, target: string, release = true): Promise<void> {
  const handle = card(page, moving).locator(".js-order-handle");
  const hb = (await handle.boundingBox())!;
  const top = (await card(page, target).boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, top.y + 4, { steps: 8 });
  if (release) await page.mouse.up();
}

test.describe("gym webapp servers", () => {
  test("gym servers home drag reorders and the leader badge stays gray until the leader confirms", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME, OFFICE] });
    const t0 = Date.now() - 3_600_000;
    let releaseAck: () => void = () => {};
    const ackGate = new Promise<void>((resolve) => {
      releaseAck = resolve;
    });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", {
      pods: [livePod(HOME, { orderIssuedAt: t0 }), livePod(OFFICE, { orderIssuedAt: t0 }), offlinePod(MEDIA)],
      serverOrder: wireOrder([STK[HOME]!, STK[OFFICE]!, STK[MEDIA]!], t0),
    });
    m.post("/api/accounts/smoketest/server-order", serverOrderRule(page, keys));
    // The office box answers the hand-delivered order only once the test lets
    // it, so the unconfirmed state is observable.
    let officeGot: { order: { issuedAt: number } } | null = null;
    m.post(`https://${OFFICE}/api/screens/server-order`, async (call) => {
      officeGot = call.body;
      await ackGate;
      return { json: { ok: true, heldIssuedAt: call.body.order.issuedAt } };
    });
    await renderHome(page);

    await expect.poll(() => shownOrder(page)).toEqual([HOME, OFFICE, MEDIA]);
    await expect(page.locator("#servers-list [data-server-cards]")).toHaveAttribute("data-reorderable", "");
    // Only the leader wears a badge; home holds the saved order → green.
    await expect(page.locator("#servers-list [data-order-leader]")).toHaveCount(1);
    const homeBadge = card(page, HOME).locator("[data-order-leader]");
    await expect(homeBadge).toHaveText("Leader");
    await expect(homeBadge).toHaveClass(/\bok\b/);
    await expect(homeBadge).not.toHaveAttribute("data-order-leader-pending", "");
    await shot(page, testInfo, "order-confirmed");

    // Drag office by its handle above home.
    await dragAbove(page, OFFICE, HOME, false);
    // Mid-drag: the list already shows the draft, and the badge is gray.
    await expect.poll(() => shownOrder(page)).toEqual([OFFICE, HOME, MEDIA]);
    await expect(page.locator("#servers-list .is-dragging")).toHaveAttribute("data-open-fqdn", OFFICE);
    await expect(page.locator("#servers-list [data-order-leader]")).toHaveAttribute("data-order-leader-pending", "");
    await shot(page, testInfo, "order-dragging");
    await page.mouse.up();

    // The drop signs the new order with the admin root and posts it to .com.
    const post = await m.waitFor("/api/accounts/smoketest/server-order");
    const wire = post.body as { order: { user: string; stks: string[]; issuedAt: number; nonce: string }; signature: string };
    expect(wire.order.user).toBe(USER);
    expect(wire.order.stks).toEqual([STK[OFFICE], STK[HOME], STK[MEDIA]]);
    expect(wire.order.issuedAt).toBeGreaterThan(t0);
    expect(wire.order.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(await signer(page, keys, ORDER_CANON, wire.order, wire.signature)).toBe("admin");

    // Office leads now, but hasn't said it holds the new order: gray, with
    // the waiting label (Android: pod-leader-badge-pending).
    await expect.poll(() => shownOrder(page)).toEqual([OFFICE, HOME, MEDIA]);
    const officeBadge = card(page, OFFICE).locator("[data-order-leader]");
    await expect(officeBadge).toHaveAttribute("data-order-leader-pending", "");
    await expect(officeBadge).toHaveAttribute("aria-label", "Leader, waiting for the server to confirm");
    await expect(officeBadge).not.toHaveClass(/\bok\b/);
    await expect(card(page, HOME).locator("[data-order-leader]")).toHaveCount(0);
    await shot(page, testInfo, "order-leader-pending");

    // The order was also handed straight to the online box; its answer
    // confirms the badge.
    await expect.poll(() => (officeGot as { order: { issuedAt: number } } | null)?.order.issuedAt ?? 0).toBe(wire.order.issuedAt);
    releaseAck();
    await expect(officeBadge).toHaveClass(/\bok\b/, { timeout: 10_000 });
    await expect(officeBadge).not.toHaveAttribute("data-order-leader-pending", "");
    await shot(page, testInfo, "order-leader-confirmed");
  });

  test("gym servers a non-admin device sees the server order but can't change it or Make leader", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "non-admin", servers: [HOME, OFFICE] });
    const t0 = Date.now() - 3_600_000;
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", {
      pods: [livePod(HOME, { orderIssuedAt: t0 }), livePod(OFFICE, { orderIssuedAt: t0 })],
      serverOrder: wireOrder([STK[HOME]!, STK[OFFICE]!], t0),
    });
    m.get(`${OFFICE}/api/screens/server-detail`, serverDetail(OFFICE));
    m.post("/api/accounts/smoketest/server-order", serverOrderRule(page, keys));
    await renderHome(page);
    await expect.poll(() => shownOrder(page)).toEqual([HOME, OFFICE]);
    // The admin-pinned account refuses an order this device could only sign
    // with the IRK, so Home offers no handles (and no Add/Import).
    await expect(card(page, HOME).locator("[data-order-leader]")).toHaveText("Leader");
    await expect(page.locator("#servers-list [data-server-cards]")).not.toHaveAttribute("data-reorderable", "");
    await expect(page.locator("#servers-list .js-order-handle")).toHaveCount(0);
    await expect(page.locator("#home-add-server")).toHaveCount(0);
    await shot(page, testInfo, "order-non-admin");

    // The server page's Make leader is off, with the reason.
    await card(page, OFFICE).click();
    await expect(page.locator("#leader-pill")).toHaveText("Takes over while home is down", { timeout: 10_000 });
    await expect(page.locator("#make-leader-btn")).toBeDisabled();
    await expect(page.locator("[data-leader-admin-only]")).toHaveText("Only an admin device can change the server order.");
    await page.locator("#leader-card").scrollIntoViewIfNeeded();
    await shot(page, testInfo, "leader-non-admin");
    expect(m.sent("/server-order")).toHaveLength(0);
  });

  test("gym servers a demo account shows its demo server and may add servers without an admin root", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "demo", servers: [HOME] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME), livePod(OFFICE)] });
    await renderHome(page);
    // The operator runs a demo account, so its device stands in for an admin.
    await expect(card(page, HOME)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#home-add-server")).toBeVisible();
    const isAdmin = await page.evaluate(async () => !!(await import("/lib/state.js")).getSession().adminRootSeed);
    expect(isAdmin).toBe(false);
    await shot(page, testInfo, "home-demo");
    await page.click("#home-add-server");
    await expect(page.locator("[data-choice-add]")).toBeVisible();
  });

  test("gym servers home shows Add or Restore server above the list on an admin device only", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME, OFFICE] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME), livePod(OFFICE)] });
    await renderHome(page);
    // "Add/Restore server" sits above the list (iOS/Android: home-add-server).
    await expect(page.locator("#home-add-server")).toHaveText("+ Add/Restore server");
    const addAbove = await page.evaluate(() => {
      const add = document.getElementById("home-add-server");
      const cards = document.querySelector("#servers-list [data-server-cards]");
      return !!add && !!cards && !!(add.compareDocumentPosition(cards) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(addAbove).toBe(true);
    await page.click("#home-add-server");
    await expect(page.locator("dialog[open] .modal-title")).toHaveText("Add/Restore server");
    await expect(page.locator("dialog[open] button:not([data-choice-cancel])")).toHaveText([
      "Create a server",
      "Co-manage a running server",
      "Restore from backup",
    ]);
    await shot(page, testInfo, "home-add-import-menu");
  });

  test("gym servers each Add or Restore choice opens its flow and Cancel closes the menu", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
    await renderHome(page);
    const menu = page.locator('dialog[aria-label="Add or restore a server"]');

    // Cancel: the menu closes and Home stays.
    await page.click("#home-add-server");
    await expect(menu).toBeVisible();
    await menu.locator("[data-choice-cancel]").click();
    await expect(menu).toHaveCount(0);
    await expect(page.locator("#view-home")).toBeVisible();

    // Co-manage: asks for the owner's share link and refuses anything else.
    await page.click("#home-add-server");
    await menu.locator("[data-choice-co-manage]").click();
    await expect(page.locator(".modal-title")).toHaveText("Open a share link");
    await page.fill(".modal-input", "https://example.com/not-a-share");
    await page.click("[data-modal-ok]");
    await expect(page.locator("[data-modal-error]")).toHaveText("That isn't a share link.");
    await shot(page, testInfo, "add-co-manage-prompt");
    await page.click("[data-modal-cancel]");
    await expect(page.locator(".modal-title")).toHaveCount(0);

    // Restore from backup: the chooser lists the sources (no "From this device" in a browser);
    // From a file opens the picker dialog.
    await page.click("#home-add-server");
    await menu.locator("[data-choice-restore]").click();
    const chooser = page.locator('dialog[aria-label="Restore from backup"]');
    await expect(chooser.locator("button.choice-source .choice-source-title")).toHaveText(["From a file", "From other servers"]);
    await expect(chooser.locator("[data-restore-file] .choice-source-desc")).toHaveText("Pick a .flagship backup file.");
    await expect(chooser.locator("[data-restore-peers] .choice-source-desc")).toHaveText("Rebuild a lost server from pieces other servers keep.");
    await shot(page, testInfo, "add-restore-chooser");
    await chooser.locator("[data-restore-cancel]").click();
    await expect(chooser).toHaveCount(0);
    await page.click("#home-add-server");
    await menu.locator("[data-choice-restore]").click();
    await chooser.locator("[data-restore-file]").click();
    const imp = page.locator('dialog[aria-label="Import a backup"]');
    await expect(imp).toBeVisible({ timeout: 10_000 });
    await expect(imp.locator("[data-imp-file]")).toBeAttached();
    await shot(page, testInfo, "add-import-dialog");
    await page.keyboard.press("Escape");

    // Create a new server: the create form.
    await renderHome(page);
    await page.click("#home-add-server");
    await page.locator('dialog[aria-label="Add or restore a server"] [data-choice-add]').click();
    await expect(page.locator("#view-create-server")).toBeVisible({ timeout: 10_000 });
    await shot(page, testInfo, "add-create-form");
  });

  test("gym servers locking the app with a menu or dialog open leaves none of it on screen", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
    await renderHome(page);
    const visibleOverlays = () =>
      page.evaluate(() => {
        const shown = (el: Element) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          const cs = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
        };
        const open = [...document.querySelectorAll("dialog[open], .modal-overlay")].filter(shown).length;
        const focusable = [...document.querySelectorAll("dialog button, .modal-overlay button")].filter(shown).length;
        return { open, focusable, active: document.activeElement?.closest("dialog, .modal-overlay") !== null };
      });

    // The Add/Restore menu open, then Lock.
    await page.click("#home-add-server");
    await expect(page.locator('dialog[aria-label="Add or restore a server"]')).toBeVisible();
    await page.evaluate(async () => {
      const { lockToPin } = await import("/views/pinLock.js");
      lockToPin();
    });
    await expect(page.locator("#view-pin-unlock")).toBeVisible();
    expect(await visibleOverlays()).toEqual({ open: 0, focusable: 0, active: false });
    await expect(page.locator("dialog")).toHaveCount(0);
    await shot(page, testInfo, "home-locked-no-menu");

    // The restore chooser (a second layer) and a prompt, then the other lock path.
    await unlock(page, "home");
    await seedSession(page, { kind: "admin", servers: [HOME] });
    await renderHome(page);
    await page.click("#home-add-server");
    await page.locator("[data-choice-restore]").click();
    await expect(page.locator('dialog[aria-label="Restore from backup"]')).toBeVisible();
    await page.evaluate(async () => {
      const { inlinePrompt } = await import("/lib/modal.js");
      void inlinePrompt({ title: "Open a share link", message: "x" });
    });
    await page.evaluate(async () => {
      const { lockToPin } = await import("/views/pinLock.js");
      lockToPin();
    });
    expect(await visibleOverlays()).toEqual({ open: 0, focusable: 0, active: false });
    await expect(page.locator(".modal-overlay")).toHaveCount(0);
  });

  test("gym servers a non-admin device with no servers is told only an admin device can add one", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "non-admin", servers: [HOME] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [] });
    await renderHome(page);
    const empty = page.locator("[data-home-empty-non-admin]");
    await expect(empty).toBeVisible({ timeout: 10_000 });
    await expect(empty).toContainText("Only an admin device of this account can add servers.");
    await expect(page.locator("#home-add-server")).toHaveCount(0);
    await shot(page, testInfo, "home-empty-non-admin");
  });

  test("gym servers an admin device with no servers gets Add or Restore and Take over", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [] });
    await renderHome(page);
    await expect(page.locator("#home-add-server")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("[data-home-empty-non-admin]")).toHaveCount(0);
    await shot(page, testInfo, "home-empty-admin");
    await page.click("#home-take-over");
    await expect(page.locator('dialog[aria-label="Take over a box"] [data-claim-input]')).toBeVisible({ timeout: 10_000 });
  });

  test("gym servers home keyboard reorder reverts when another device saved a newer order", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME, OFFICE] });
    const t0 = Date.now() - 3_600_000;
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", {
      pods: [offlinePod(MEDIA), livePod(HOME, { orderIssuedAt: t0 }), livePod(OFFICE, { orderIssuedAt: t0 })],
      serverOrder: wireOrder([STK[MEDIA]!, STK[HOME]!, STK[OFFICE]!], t0),
    });
    m.post(
      "/api/accounts/smoketest/server-order",
      sensitive(page, keys, ORDER_CANON, (b) => ({ arg: b.order, sig: b.signature }), () => ({ status: 409, json: { error: "stale order" } })),
    );
    await renderHome(page);

    // Media is first but down, so home leads and says who it stands in for.
    await expect.poll(() => shownOrder(page)).toEqual([MEDIA, HOME, OFFICE]);
    await expect(card(page, HOME).locator("[data-order-leader]")).toHaveText("Leader");
    await expect(card(page, HOME)).toContainText("standing in for media");
    await expect(card(page, MEDIA).locator(".js-order-up")).toBeDisabled();
    await expect(card(page, OFFICE).locator(".js-order-down")).toBeDisabled();
    await shot(page, testInfo, "order-standing-in");

    // "Move office up" (the keyboard path): shown at once, then .com refuses
    // because another device saved a newer order, and the old order is back.
    const up = page.getByRole("button", { name: "Move office up" });
    await up.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#toast")).toContainText("Another device changed the order. Showing the latest one.", { timeout: 10_000 });
    const post = m.last("/api/accounts/smoketest/server-order")!;
    expect((post.body as { order: { stks: string[] } }).order.stks).toEqual([STK[MEDIA], STK[OFFICE], STK[HOME]]);
    await expect.poll(() => shownOrder(page)).toEqual([MEDIA, HOME, OFFICE]);
    await expect(card(page, HOME).locator("[data-order-leader]")).toHaveText("Leader");
    await shot(page, testInfo, "order-reverted");
  });

  test("gym servers Move down on Home saves the new order", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME, OFFICE] });
    const t0 = Date.now() - 3_600_000;
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", {
      pods: [livePod(HOME, { orderIssuedAt: t0 }), livePod(OFFICE, { orderIssuedAt: t0 })],
      serverOrder: wireOrder([STK[HOME]!, STK[OFFICE]!], t0),
    });
    m.post("/api/accounts/smoketest/server-order", serverOrderRule(page, keys));
    await renderHome(page);
    await page.getByRole("button", { name: "Move home down" }).focus();
    await page.keyboard.press("Enter");
    const post = await m.waitFor("/api/accounts/smoketest/server-order");
    expect(post.body.order.stks).toEqual([STK[OFFICE], STK[HOME]]);
    expect(await signer(page, keys, ORDER_CANON, post.body.order, post.body.signature)).toBe("admin");
    await expect.poll(() => shownOrder(page)).toEqual([OFFICE, HOME]);
    await shot(page, testInfo, "order-moved-down");
  });

  test("gym servers a Home server card opens its server page", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME, OFFICE] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME), livePod(OFFICE)] });
    m.get(`${OFFICE}/api/screens/server-detail`, serverDetail(OFFICE));
    await renderHome(page);
    await card(page, OFFICE).click();
    await expect(page.locator("#view-server-detail")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#leader-card")).toHaveAttribute("data-server-fqdn", OFFICE, { timeout: 10_000 });
    await shot(page, testInfo, "home-card-opens-server");
  });

  test("gym servers Make leader puts this server first and waits for it to confirm", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME, OFFICE] });
    const t0 = Date.now() - 3_600_000;
    let releaseAck: () => void = () => {};
    const ackGate = new Promise<void>((resolve) => {
      releaseAck = resolve;
    });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", {
      pods: [livePod(HOME, { orderIssuedAt: t0 }), livePod(OFFICE, { orderIssuedAt: t0 })],
      serverOrder: wireOrder([STK[HOME]!, STK[OFFICE]!], t0),
    });
    m.get(`${OFFICE}/api/screens/server-detail`, serverDetail(OFFICE));
    m.post("/api/accounts/smoketest/server-order", serverOrderRule(page, keys));
    m.post(`https://${OFFICE}/api/screens/server-order`, async (call) => {
      await ackGate;
      return { json: { ok: true, heldIssuedAt: call.body.order.issuedAt } };
    });
    m.post(`https://${HOME}/api/screens/server-order`, (call) => ({ json: { ok: true, heldIssuedAt: call.body.order.issuedAt } }));
    await renderHome(page);
    await openServer(page, OFFICE);

    const pill = page.locator("#leader-pill");
    const btn = page.locator("#make-leader-btn");
    await expect(pill).toHaveText("Takes over while home is down", { timeout: 10_000 });
    await expect(btn).toBeEnabled();
    await page.locator("#leader-card").scrollIntoViewIfNeeded();
    await shot(page, testInfo, "leader-card-second");

    await btn.click();
    const post = await m.waitFor("/api/accounts/smoketest/server-order");
    expect(post.body.order.stks).toEqual([STK[OFFICE], STK[HOME]]);
    expect(await signer(page, keys, ORDER_CANON, post.body.order, post.body.signature)).toBe("admin");
    await expect(page.locator("#toast")).toContainText(`${OFFICE} is first in your server order`, { timeout: 10_000 });
    // Leader, but gray with the waiting note until office holds the order.
    await expect(pill).toHaveText("Leader");
    await expect(pill).not.toHaveClass(/\bok\b/);
    await expect(page.locator("#leader-confirm-note")).toHaveText("Waiting for it to confirm the new order.");
    await expect(btn).toBeDisabled();
    await shot(page, testInfo, "leader-waiting");
    releaseAck();
    await expect(pill).toHaveClass(/\bok\b/, { timeout: 10_000 });
    await expect(page.locator("#leader-confirm-note")).toBeHidden();
    await shot(page, testInfo, "leader-confirmed");
  });

  test("gym servers update card shows the last update and orders the latest release", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const now = Date.now();
    const m = await mock(page);
    m.get(
      `${HOME}/api/screens/server-detail`,
      serverDetail(HOME, {
        currentCommit: COMMIT_RUNNING,
        lastUpdate: { outcome: "rolled-back", targetCommit: COMMIT_ROLLED, previousCommit: COMMIT_RUNNING, at: now - 86_400_000 },
      }),
    );
    m.get(`${HOME}/api/screens/updates`, {
      latest: { commit: COMMIT_LATEST, tag: "v1.4.0" },
      releases: [
        { commit: COMMIT_LATEST, tag: "v1.4.0", relation: "newer" },
        { commit: COMMIT_RUNNING, tag: "v1.3.2", relation: "current" },
      ],
    });
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
    m.post(
      `/api/server/${HOME}/update`,
      sensitive(page, keys, UPDATE_CANON, (b) => ({ arg: b.order, sig: b.signature }), () => ({ json: { ok: true, expiresAt: now + 3_600_000 } })),
    );
    await openServer(page, HOME);

    // The box's own verdict on the last update (iOS: sd-update-last-outcome).
    const cardEl = page.locator("#update-card");
    await expect(cardEl).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#update-current-commit")).toHaveText(COMMIT_RUNNING.slice(0, 8));
    await expect(page.locator("#update-last-outcome")).toHaveText(
      "The last update to 1584bfe8 didn't start cleanly, so the server went back to 7ac1b50a on its own.",
    );
    // The box's release list names a newer release (iOS: sd-update-available).
    await expect(page.locator("#update-available")).toHaveText("New release available: v1.4.0", { timeout: 10_000 });
    await expect(page.locator("#update-server-btn")).toHaveText("Update to latest");
    await cardEl.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "update-card");

    // Order it: the dialog offers the latest release first.
    await page.click("#update-server-btn");
    const dlg = page.locator('dialog[aria-label="Update this server"]');
    await expect(dlg).toBeVisible();
    await expect(dlg.locator("[data-update-running]")).toHaveText("v1.3.2", { timeout: 10_000 });
    await expect(dlg.locator("#update-latest-btn")).toHaveText("Update to latest");
    await shot(page, testInfo, "update-dialog");
    await dlg.locator("#update-latest-btn").click();
    await expect(dlg.locator("[data-update-pending='sent']")).toContainText("Update to v1.4.0 sent", { timeout: 10_000 });

    const post = m.last(`/api/server/${HOME}/update`)!;
    const body = post.body as { order: Record<string, unknown>; signature: string; auth: { username: string } };
    expect(body.order.serverDomain).toBe(HOME);
    expect(body.order.targetCommit).toBe(COMMIT_LATEST);
    expect(body.order.fromCommit).toBe(COMMIT_RUNNING);
    expect(await signer(page, keys, UPDATE_CANON, body.order, body.signature)).toBe("admin");
    expect(body.auth.username).toBe(USER);

    // Done: the card shows the pending order instead of the button
    // (iOS: sd-update-pending), so it isn't sent twice.
    await dlg.locator("[data-update-cancel]").click();
    await expect(dlg).toBeHidden();
    await expect(page.locator("#update-pending [data-update-pending='sent']")).toContainText("Update to v1.4.0 sent");
    await expect(page.locator("#update-server-btn")).toBeHidden();
    await expect(page.locator("#update-available")).toBeHidden();
    await cardEl.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "update-pending");
  });

  test("gym servers update dialog offers other releases, Go back under Advanced, a typed commit and Check again", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    m.get(`${HOME}/api/screens/server-detail`, serverDetail(HOME, { currentCommit: COMMIT_RUNNING }));
    let refreshed = 0;
    m.get(`${HOME}/api/screens/updates`, (call) => {
      if (call.url.searchParams.has("refresh")) refreshed++;
      return {
        json: {
          latest: { commit: COMMIT_LATEST, tag: "v1.4.0" },
          releases: [
            { commit: COMMIT_LATEST, tag: "v1.4.0", relation: "newer" },
            { commit: COMMIT_OTHER, tag: "v1.3.9", relation: "newer" },
            { commit: COMMIT_RUNNING, tag: "v1.3.2", relation: "current" },
            { commit: COMMIT_OLDER, tag: "v1.2.0", relation: "older" },
          ],
        },
      };
    });
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
    m.post(
      `/api/server/${HOME}/update`,
      sensitive(page, keys, UPDATE_CANON, (b) => ({ arg: b.order, sig: b.signature }), () => ({ json: { ok: true, expiresAt: Date.now() + 3_600_000 } })),
    );
    await openServer(page, HOME);
    await expect(page.locator("#update-server-btn")).toBeVisible({ timeout: 10_000 });
    await page.click("#update-server-btn");
    const dlg = page.locator('dialog[aria-label="Update this server"]');
    await expect(dlg.locator("[data-update-others]")).toContainText("Other new releases", { timeout: 10_000 });
    await expect(dlg.locator(`[data-update-others] [data-update-commit="${COMMIT_OTHER}"]`)).toHaveText("Update");

    // Advanced: a release to go back to, and a typed commit that must be a full hash.
    await dlg.locator("[data-update-advanced] summary").click();
    await expect(dlg.locator(`[data-update-older] [data-update-commit="${COMMIT_OLDER}"]`)).toHaveText("Go back");
    const target = dlg.locator("[data-update-target]");
    const go = dlg.locator("[data-update-go]");
    await target.fill("abc123");
    await expect(dlg.locator("[data-update-target-hint]")).toHaveText("Enter the full 40-character commit hash of the blessed release.");
    await expect(go).toBeDisabled();
    await target.fill(COMMIT_RUNNING);
    await expect(dlg.locator("[data-update-target-hint]")).toHaveText("The server is already running this release.");
    await expect(go).toBeDisabled();
    await target.fill(COMMIT_OLDER.toUpperCase());
    await expect(dlg.locator("[data-update-target-hint]")).toBeHidden();
    await expect(go).toBeEnabled();
    await shot(page, testInfo, "update-advanced");

    // Go back to the older release: the order names it.
    await dlg.locator(`[data-update-older] [data-update-commit="${COMMIT_OLDER}"]`).click();
    await expect(dlg.locator("[data-update-pending='sent']")).toContainText("Update to v1.2.0 sent", { timeout: 10_000 });
    const post = m.last(`/api/server/${HOME}/update`)!;
    expect(post.body.order.targetCommit).toBe(COMMIT_OLDER);
    expect(await signer(page, keys, UPDATE_CANON, post.body.order, post.body.signature)).toBe("admin");
    await shot(page, testInfo, "update-went-back");

    // A server on the latest release offers Check again, which asks the box afresh.
    await dlg.locator("[data-update-cancel]").click();
    await page.evaluate(async () => (await import("/lib/serverUpdate.js")).clearPendingUpdate("home.smoketest.flagship.services"));
    m.first("GET", `${HOME}/api/screens/updates`, (call: { url: URL }) => {
      if (call.url.searchParams.has("refresh")) refreshed++;
      return { json: { latest: null, releases: [{ commit: COMMIT_RUNNING, tag: "v1.3.2", relation: "current" }] } };
    });
    await openServer(page, HOME);
    await expect(page.locator("#update-server-btn")).toBeVisible({ timeout: 10_000 });
    await page.click("#update-server-btn");
    const dlg2 = page.locator('dialog[aria-label="Update this server"]');
    await expect(dlg2.locator("[data-update-latest]")).toContainText("This server is on the latest release.", { timeout: 10_000 });
    const before = m.sent(`${HOME}/api/screens/updates`, "GET").length;
    await dlg2.locator("[data-update-recheck]").click();
    await expect.poll(() => m.sent(`${HOME}/api/screens/updates`, "GET").length).toBeGreaterThan(before);
    await shot(page, testInfo, "update-latest-check-again");
  });

  test("gym servers an update the server hasn't picked up offers Send again and Forget it", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    m.get(`${HOME}/api/screens/server-detail`, serverDetail(HOME, { currentCommit: COMMIT_RUNNING }));
    m.get(`${HOME}/api/screens/updates`, {
      latest: { commit: COMMIT_LATEST, tag: "v1.4.0" },
      releases: [
        { commit: COMMIT_LATEST, tag: "v1.4.0", relation: "newer" },
        { commit: COMMIT_RUNNING, tag: "v1.3.2", relation: "current" },
      ],
    });
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME)] });
    // An order sent two days ago that the server never applied.
    await page.evaluate(
      async ({ fqdn, target, from }) => {
        const u = await import("/lib/serverUpdate.js");
        u.savePendingUpdate(fqdn, { targetCommit: target, targetTag: "v1.4.0", fromCommit: from, orderedAt: Date.now() - 2 * 86_400_000 });
      },
      { fqdn: HOME, target: COMMIT_LATEST, from: COMMIT_RUNNING },
    );
    await openServer(page, HOME);
    const pending = page.locator("#update-pending [data-update-pending='stale']");
    await expect(pending).toContainText("The server hasn't applied this update yet. It may be offline.", { timeout: 10_000 });
    await page.locator("#update-card").scrollIntoViewIfNeeded();
    await shot(page, testInfo, "update-stale");

    // Send again reopens the release list.
    await pending.locator("[data-update-send-again]").click();
    const dlg = page.locator('dialog[aria-label="Update this server"]');
    await expect(dlg.locator("#update-latest-btn")).toBeVisible({ timeout: 10_000 });
    await dlg.locator("[data-update-cancel]").click();

    // Forget it drops the order and brings the button back.
    await page.locator("#update-pending [data-update-forget]").click();
    await expect(page.locator("#update-pending")).toBeHidden();
    await expect(page.locator("#update-server-btn")).toBeVisible();
    await shot(page, testInfo, "update-forgotten");
  });

  test("gym servers un-revoke restores a revoked server", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    let revoked = true;
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", () => ({
      json: { pods: [revoked ? offlinePod(MEDIA, { revokedAt: Date.now() - 86_400_000, revocationReason: "lost" }) : offlinePod(MEDIA)] },
    }));
    m.post(
      "/api/server-registry/unrevoke",
      sensitive(page, keys, UNREVOKE_CANON, (b) => ({ arg: b.request, sig: b.signature }), () => {
        revoked = false;
        return { json: { ok: true, unrevokedAt: Date.now(), dnsRepublished: true } };
      }),
    );
    await openServer(page, MEDIA);

    // The box can't be reached (revoked): the page says so and offers
    // Un-revoke in place of Revoke (iOS: sd-unrevoke-server).
    await expect(page.locator("[data-detail-unreachable]")).toHaveText(
      "This server is revoked. It can't connect or unlock until you un-revoke it.",
      { timeout: 10_000 },
    );
    await expect(page.locator("#unrevoke-server-btn")).toHaveText("Un-revoke server");
    await expect(page.locator("#revoke-server-btn")).toHaveCount(0);
    await expect(page.locator("#delete-server-btn")).toBeVisible();
    await shot(page, testInfo, "revoked-server");

    await page.click("#unrevoke-server-btn");
    await expect(page.locator("#toast")).toContainText(
      "Server restored. If it unlocks on its own, approve its unlock once from your phone.",
      { timeout: 10_000 },
    );
    const post = m.last("/api/server-registry/unrevoke")!;
    const body = post.body as { request: { username: string; serverDomain: string; issuedAt: number }; signature: string };
    expect(body.request.username).toBe(USER);
    expect(body.request.serverDomain).toBe(MEDIA);
    expect(await signer(page, keys, UNREVOKE_CANON, body.request, body.signature)).toBe("admin");

    // The page re-reads .com and flips back to the reversible Revoke.
    await expect(page.locator("#revoke-server-btn")).toHaveText("Revoke server (reversible)", { timeout: 10_000 });
    await expect(page.locator("#unrevoke-server-btn")).toHaveCount(0);
    await shot(page, testInfo, "unrevoked-server");
  });

  test("gym servers a demo account un-revokes with the IRK", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "demo", servers: [HOME] });
    let revoked = true;
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", () => ({
      json: { pods: [revoked ? offlinePod(MEDIA, { revokedAt: Date.now() - 86_400_000, revocationReason: "lost" }) : offlinePod(MEDIA)] },
    }));
    m.post(
      "/api/server-registry/unrevoke",
      sensitive(page, keys, UNREVOKE_CANON, (b) => ({ arg: b.request, sig: b.signature }), () => {
        revoked = false;
        return { json: { ok: true, unrevokedAt: Date.now(), dnsRepublished: true } };
      }),
    );
    await openServer(page, MEDIA);
    await expect(page.locator("#unrevoke-server-btn")).toBeVisible({ timeout: 10_000 });
    await page.click("#unrevoke-server-btn");
    await expect(page.locator("#revoke-server-btn")).toBeVisible({ timeout: 10_000 });
    const post = m.last("/api/server-registry/unrevoke")!;
    expect(await signer(page, keys, UNREVOKE_CANON, post.body.request, post.body.signature)).toBe("irk");
    await shot(page, testInfo, "demo-unrevoked");
  });

  test("gym servers delete a revoked server behind the typed-name gate", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", {
      pods: [livePod(HOME), offlinePod(MEDIA, { revokedAt: Date.now() - 86_400_000, revocationReason: "stolen" })],
    });
    m.post(
      `/api/server/${MEDIA}/decommission`,
      sensitive(page, keys, DECOMMISSION_CANON, (b) => ({ arg: b.order, sig: b.signature }), () => ({ json: { ok: true } })),
    );
    m.post("/api/server/release", sensitive(page, keys, releaseCanon, (b) => ({ arg: b.request, sig: b.signature }), () => ({ json: { ok: true, released: true } })));
    await openServer(page, MEDIA);
    await expect(page.locator("#delete-server-btn")).toHaveText("Delete and wipe this server", { timeout: 10_000 });
    await page.click("#delete-server-btn");

    // The confirm asks for the server's name (iOS/Android: delete-server-name-field).
    const dlg = page.locator('dialog[aria-label="Delete server"]');
    await expect(dlg).toBeVisible();
    await expect(dlg.locator(".modal-title")).toHaveText("Delete media?");
    const go = dlg.locator("[data-delete-go]");
    await expect(go).toBeDisabled();
    await dlg.locator("[data-delete-input]").fill("home");
    await expect(go).toBeDisabled();
    await dlg.locator("[data-delete-input]").fill("Media ");
    await expect(go).toBeEnabled();
    await shot(page, testInfo, "delete-confirm");
    expect(m.sent("/api/server/")).toEqual([]);
    await go.click();

    // The box is asked to wipe itself, then the name is released: both under the admin root.
    await expect(page.locator("#toast")).toContainText("Deleted media. If it's online it will erase itself and power off.", { timeout: 10_000 });
    const decommission = m.last(`/api/server/${MEDIA}/decommission`);
    const release = m.last("/api/server/release");
    expect(decommission).toBeTruthy();
    expect(release).toBeTruthy();
    expect(m.calls.indexOf(decommission!)).toBeLessThan(m.calls.indexOf(release!));
    const order = (decommission!.body as { order: { diskDisposition: string; retiredStkPubHex: string; podCanonical: string } }).order;
    expect(order.diskDisposition).toBe("wipe-now");
    expect(order.retiredStkPubHex).toBe(STK[MEDIA]);
    expect(order.podCanonical).toBe(MEDIA);
    expect(await signer(page, keys, DECOMMISSION_CANON, order, decommission!.body.signature)).toBe("admin");
    expect((release!.body as { request: { serverDomain: string } }).request.serverDomain).toBe(MEDIA);
    expect(await signer(page, keys, releaseCanon, release!.body.request, release!.body.signature)).toBe("admin");

    // Back on Home, the deleted server is gone even though the stale lists
    // still name it.
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
    await expect(card(page, HOME)).toBeVisible({ timeout: 10_000 });
    await expect(card(page, MEDIA)).toHaveCount(0);
    await shot(page, testInfo, "deleted-home");
  });

  test("gym servers delete dialog Cancel sends nothing", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [livePod(HOME), offlinePod(MEDIA, { revokedAt: Date.now() - 86_400_000, revocationReason: "lost" })] });
    await openServer(page, MEDIA);
    await page.click("#delete-server-btn");
    const dlg = page.locator('dialog[aria-label="Delete server"]');
    await dlg.locator("[data-delete-input]").fill("media");
    await shot(page, testInfo, "delete-cancel");
    await dlg.locator("[data-delete-cancel]").click();
    await expect(dlg).toHaveCount(0);
    expect(m.sent("/api/server/")).toEqual([]);
    await expect(page.locator("#view-server-detail")).toBeVisible();
  });
});
