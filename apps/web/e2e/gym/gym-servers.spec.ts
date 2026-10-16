/**
 * Servers (docs/server-order.md, the update lane, reversible revoke): the
 * webapp's server surfaces with no backend. Home's server order (drag + the
 * keyboard steps, the Leader badge that stays gray until the leader holds the
 * order), the server page's update card (last-update verdict, the release
 * note, ordering an update and the pending state it leaves), and a revoked
 * server's Un-revoke and Delete.
 *
 * Crypto is real: orders are signed with the session's IRK and the specs
 * verify those signatures. `.com` and the boxes are one page.route router;
 * anything it doesn't know answers 404, so nothing reaches a network.
 */

import { test, expect, type Page, type TestInfo, type Route } from "@playwright/test";

const PASSPHRASE = "correct-horse-battery-staple-gym";
const HOME = "home.smoketest.flagship.services";
const OFFICE = "office.smoketest.flagship.services";
const MEDIA = "media.smoketest.flagship.services";
const STK = { [HOME]: "11".repeat(32), [OFFICE]: "22".repeat(32), [MEDIA]: "33".repeat(32) } as Record<string, string>;
const COMMIT_RUNNING = "7ac1b50a".padEnd(40, "1");
const COMMIT_ROLLED = "1584bfe8".padEnd(40, "2");
const COMMIT_LATEST = "52d0b375".padEnd(40, "3");

async function shot(page: Page, testInfo: TestInfo, point: string): Promise<void> {
  const file = testInfo.outputPath(`gym-screenshot-${point}.png`);
  await page.screenshot({ path: file });
  await testInfo.attach(`gym-screenshot:${point}`, { path: file, contentType: "image/png" });
}

async function reachHome(page: Page): Promise<void> {
  await page.goto("/index.html");
  await expect(page.locator("#view-bootstrap")).toBeVisible();
  await page.click("#bootstrap-create");
  await page.fill(".modal-input", PASSPHRASE);
  await page.click("[data-modal-ok]");
  await page.fill(".modal-input", PASSPHRASE);
  await page.click("[data-modal-ok]");
  await expect(page.locator("#toast")).toBeVisible({ timeout: 10_000 });
  await page.goto("/index.html?view=home");
  await expect(page.locator("#view-unlock")).toBeVisible({ timeout: 10_000 });
  await page.fill("#unlock-passphrase", PASSPHRASE);
  await page.click("#unlock-go");
  await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(150);
  await page.evaluate(
    async (boxes) => {
      const store = await import("/lib/profilesStore.js");
      store.ensureProfile("smoketest");
      store.setActiveCloudName("smoketest");
      store.set("username", "smoketest");
      const { getSession } = await import("/lib/state.js");
      getSession().username = "smoketest";
      const api = await import("/lib/api.js");
      api.setPodBaseUrl(`https://${boxes[0]}`);
      api.setSessionToken("gym-fixture-session-token");
      for (const b of boxes) api.setSessionTokenForPod(b, "gym-fixture-session-token");
    },
    [HOME, OFFICE],
  );
}

type Answer = { status?: number; json: unknown } | null;
type Rule = [string, unknown | ((body: unknown, url: URL) => Answer)];
interface Sent {
  url: string;
  body: unknown;
}

/** One router for `.com` (same origin here) and every box: the first rule
 *  whose substring matches answers; anything else is a 404. The account
 *  read-token mint always succeeds. Returns the other POSTs it saw, in order. */
async function stub(page: Page, rules: Rule[]): Promise<Sent[]> {
  const sent: Sent[] = [];
  await page.route(
    (url) => url.pathname.startsWith("/api/") || url.hostname !== "127.0.0.1",
    async (route: Route) => {
      const req = route.request();
      const url = new URL(req.url());
      let body: unknown = null;
      try {
        body = req.postDataJSON();
      } catch {
        body = null;
      }
      if (req.method() === "POST" && !url.pathname.endsWith("/read-token")) sent.push({ url: url.href, body });
      if (url.pathname.endsWith("/read-token")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ token: "art1.gym.mac", expiresAt: Date.now() + 86_400_000 }) });
        return;
      }
      for (const [needle, answer] of rules) {
        if (!url.href.includes(needle)) continue;
        const r = typeof answer === "function" ? (answer as (b: unknown, u: URL) => Answer)(body, url) : { json: answer };
        if (!r) continue;
        await route.fulfill({ status: r.status ?? 200, contentType: "application/json", body: JSON.stringify(r.json) });
        return;
      }
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "gym: no stub" }) });
    },
  );
  return sent;
}

function livePod(fqdn: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    serverDomain: fqdn,
    identityPubKey: STK[fqdn],
    liveness: "live",
    lastReported: Date.now(),
    registeredAt: Date.now() - 30 * 86_400_000,
    ...extra,
  };
}

function offlinePod(fqdn: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    serverDomain: fqdn,
    identityPubKey: STK[fqdn],
    liveness: "unreachable",
    lastSeenMsAgo: 2 * 3_600_000,
    lastReported: Date.now() - 2 * 3_600_000,
    registeredAt: Date.now() - 20 * 86_400_000,
    ...extra,
  };
}

function wireOrder(stks: string[], issuedAt: number) {
  return { order: { user: "smoketest", stks, issuedAt, nonce: "ab".repeat(32) }, signature: "00".repeat(64) };
}

async function renderHome(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { renderHome } = await import("/views/home.js");
    await renderHome();
  });
}

/** Server cards top to bottom, as their fqdn. */
async function shownOrder(page: Page): Promise<string[]> {
  return page.locator("#servers-list [data-server-cards] [data-open-fqdn]").evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-open-fqdn") ?? ""),
  );
}

function card(page: Page, fqdn: string) {
  return page.locator(`#servers-list [data-open-fqdn="${fqdn}"]`);
}

/** Verify an Ed25519 signature made with the session's IRK. */
async function signedByIrk(page: Page, kind: "server-order" | "unrevoke", body: unknown): Promise<boolean> {
  return page.evaluate(
    async ({ kind, body }) => {
      const { getSession } = await import("/lib/state.js");
      const irk = getSession().irk as { publicKey: Uint8Array };
      let bytes: Uint8Array;
      const b = body as { order?: unknown; request?: unknown; signature: string };
      if (kind === "server-order") {
        const { canonicalServerOrderBytes } = await import("/lib/serverOrder.js");
        bytes = canonicalServerOrderBytes(b.order);
      } else {
        const { canonicalUnrevokeBytes } = await import("/lib/revokeServer.js");
        bytes = canonicalUnrevokeBytes(b.request as { username: string; serverDomain: string; issuedAt: number });
      }
      const sig = Uint8Array.from((b.signature.match(/../g) ?? []).map((h) => parseInt(h, 16)));
      const key = await crypto.subtle.importKey("raw", irk.publicKey, { name: "Ed25519" }, false, ["verify"]);
      return crypto.subtle.verify({ name: "Ed25519" }, key, sig, bytes);
    },
    { kind, body },
  );
}

test.describe("gym webapp servers", () => {
  test("gym servers home drag reorders and the leader badge stays gray until the leader confirms", async ({ page }, testInfo) => {
    await reachHome(page);
    const t0 = Date.now() - 3_600_000;
    let releaseAck: () => void = () => {};
    const ackGate = new Promise<void>((resolve) => {
      releaseAck = resolve;
    });
    const sent = await stub(page, [
      [
        "/api/users/smoketest/pods",
        {
          pods: [livePod(HOME, { orderIssuedAt: t0 }), livePod(OFFICE, { orderIssuedAt: t0 }), offlinePod(MEDIA)],
          serverOrder: wireOrder([STK[HOME]!, STK[OFFICE]!, STK[MEDIA]!], t0),
        },
      ],
      ["/api/accounts/smoketest/server-order", { ok: true }],
    ]);
    // The office box answers the hand-delivered order only once the test lets
    // it, so the unconfirmed state is observable.
    let officeGot: { order: { issuedAt: number } } | null = null;
    await page.route(`https://${OFFICE}/api/screens/server-order`, async (route) => {
      officeGot = route.request().postDataJSON();
      await ackGate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, heldIssuedAt: officeGot!.order.issuedAt }),
      });
    });
    await renderHome(page);

    await expect.poll(() => shownOrder(page)).toEqual([HOME, OFFICE, MEDIA]);
    // This session holds no admin root, so it is not an admin device: no
    // Add/Import a server (docs/service-access-gating.md "Account members").
    await expect(page.locator("#home-add-server")).toHaveCount(0);
    await expect(page.locator("#servers-list [data-server-cards]")).toHaveAttribute("data-reorderable", "");
    // Only the leader wears a badge; home holds the saved order → green.
    await expect(page.locator("#servers-list [data-order-leader]")).toHaveCount(1);
    const homeBadge = card(page, HOME).locator("[data-order-leader]");
    await expect(homeBadge).toHaveText("Leader");
    await expect(homeBadge).toHaveClass(/\bok\b/);
    await expect(homeBadge).not.toHaveAttribute("data-order-leader-pending", "");
    await shot(page, testInfo, "order-confirmed");

    // Drag office by its handle above home.
    const handle = card(page, OFFICE).locator(".js-order-handle");
    const hb = (await handle.boundingBox())!;
    const top = (await card(page, HOME).boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2, top.y + 4, { steps: 8 });
    // Mid-drag: the list already shows the draft, and the badge is gray.
    await expect.poll(() => shownOrder(page)).toEqual([OFFICE, HOME, MEDIA]);
    await expect(page.locator("#servers-list .is-dragging")).toHaveAttribute("data-open-fqdn", OFFICE);
    await expect(page.locator("#servers-list [data-order-leader]")).toHaveAttribute("data-order-leader-pending", "");
    await shot(page, testInfo, "order-dragging");
    await page.mouse.up();

    // The drop signs the new order and posts it to .com.
    await expect.poll(() => sent.filter((s) => s.url.includes("/server-order")).length).toBeGreaterThan(0);
    const post = sent.find((s) => s.url.includes("/api/accounts/smoketest/server-order"))!;
    const wire = post.body as { order: { user: string; stks: string[]; issuedAt: number; nonce: string }; signature: string };
    expect(wire.order.user).toBe("smoketest");
    expect(wire.order.stks).toEqual([STK[OFFICE], STK[HOME], STK[MEDIA]]);
    expect(wire.order.issuedAt).toBeGreaterThan(t0);
    expect(wire.order.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(await signedByIrk(page, "server-order", wire)).toBe(true);

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
    await expect.poll(() => officeGot?.order.issuedAt ?? 0).toBe(wire.order.issuedAt);
    releaseAck();
    await expect(officeBadge).toHaveClass(/\bok\b/, { timeout: 10_000 });
    await expect(officeBadge).not.toHaveAttribute("data-order-leader-pending", "");
    await shot(page, testInfo, "order-leader-confirmed");
  });

  test("gym servers home shows Add or Import a server above the list on an admin device only", async ({ page }, testInfo) => {
    await reachHome(page);
    await stub(page, [["/api/users/smoketest/pods", { pods: [livePod(HOME), livePod(OFFICE)] }]]);
    await page.evaluate(async () => {
      const { getSession } = await import("/lib/state.js");
      getSession().adminRootSeed = crypto.getRandomValues(new Uint8Array(32));
    });
    await renderHome(page);
    // "Add/Import a server" sits above the list (iOS/Android: home-add-server).
    await expect(page.locator("#home-add-server")).toHaveText("+ Add/Import a server");
    const addAbove = await page.evaluate(() => {
      const add = document.getElementById("home-add-server");
      const cards = document.querySelector("#servers-list [data-server-cards]");
      return !!add && !!cards && !!(add.compareDocumentPosition(cards) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(addAbove).toBe(true);
    await page.click("#home-add-server");
    await expect(page.locator("[data-choice-add]")).toHaveText("Create a new server");
    await expect(page.locator("[data-choice-co-manage]")).toHaveText("Co-manage a running server");
    await expect(page.locator("[data-choice-import]")).toHaveText("Import a backup");
    await shot(page, testInfo, "home-add-import-menu");
  });

  test("gym servers home keyboard reorder reverts when another device saved a newer order", async ({ page }, testInfo) => {
    await reachHome(page);
    const t0 = Date.now() - 3_600_000;
    const sent = await stub(page, [
      [
        "/api/users/smoketest/pods",
        {
          pods: [offlinePod(MEDIA), livePod(HOME, { orderIssuedAt: t0 }), livePod(OFFICE, { orderIssuedAt: t0 })],
          serverOrder: wireOrder([STK[MEDIA]!, STK[HOME]!, STK[OFFICE]!], t0),
        },
      ],
      ["/api/accounts/smoketest/server-order", () => ({ status: 409, json: { error: "stale order" } })],
    ]);
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
    await expect(page.locator("#toast")).toContainText(
      "Another device changed the order. Showing the latest one.",
      { timeout: 10_000 },
    );
    const post = sent.find((s) => s.url.includes("/api/accounts/smoketest/server-order"))!;
    expect((post.body as { order: { stks: string[] } }).order.stks).toEqual([STK[MEDIA], STK[OFFICE], STK[HOME]]);
    await expect.poll(() => shownOrder(page)).toEqual([MEDIA, HOME, OFFICE]);
    await expect(card(page, HOME).locator("[data-order-leader]")).toHaveText("Leader");
    await shot(page, testInfo, "order-reverted");
  });

  test("gym servers update card shows the last update and orders the latest release", async ({ page }, testInfo) => {
    await reachHome(page);
    const now = Date.now();
    const sent = await stub(page, [
      [
        `${HOME}/api/screens/server-detail`,
        {
          serverFqdn: HOME,
          username: "smoketest",
          daemonVersion: "1.0.0",
          currentCommit: COMMIT_RUNNING,
          lastUpdate: { outcome: "rolled-back", targetCommit: COMMIT_ROLLED, previousCommit: COMMIT_RUNNING, at: now - 86_400_000 },
          uptimeMs: 3_600_000,
          certNotAfter: now + 60 * 86_400_000,
          certSans: [HOME],
          serviceCount: 1,
          pairedSessionCount: 1,
          recentInstallEvents: [],
        },
      ],
      [
        `${HOME}/api/screens/updates`,
        {
          latest: { commit: COMMIT_LATEST, tag: "v1.4.0" },
          releases: [
            { commit: COMMIT_LATEST, tag: "v1.4.0", relation: "newer" },
            { commit: COMMIT_RUNNING, tag: "v1.3.2", relation: "current" },
          ],
        },
      ],
      ["/api/users/smoketest/pods", { pods: [livePod(HOME)] }],
      [`/api/server/${HOME}/update`, { ok: true, expiresAt: now + 3_600_000 }],
    ]);
    await page.evaluate(async (fqdn) => {
      const { enterServerDetail } = await import("/views/server-detail.js");
      await enterServerDetail(fqdn);
    }, HOME);

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

    const post = sent.find((s) => s.url.includes(`/api/server/${HOME}/update`))!;
    const body = post.body as { order: Record<string, unknown>; signature: string; auth: { username: string } };
    expect(body.order.serverDomain).toBe(HOME);
    expect(body.order.targetCommit).toBe(COMMIT_LATEST);
    expect(body.order.fromCommit).toBe(COMMIT_RUNNING);
    expect(body.signature).toMatch(/^[0-9a-f]{128}$/);
    expect(body.auth.username).toBe("smoketest");

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

  test("gym servers un-revoke restores a revoked server", async ({ page }, testInfo) => {
    await reachHome(page);
    let revoked = true;
    const sent = await stub(page, [
      [
        "/api/users/smoketest/pods",
        () => ({
          json: {
            pods: [
              revoked
                ? offlinePod(MEDIA, { revokedAt: Date.now() - 86_400_000, revocationReason: "lost" })
                : offlinePod(MEDIA),
            ],
          },
        }),
      ],
      [
        "/api/server-registry/unrevoke",
        () => {
          revoked = false;
          return { json: { ok: true, unrevokedAt: Date.now(), dnsRepublished: true } };
        },
      ],
    ]);
    await page.evaluate(async (fqdn) => {
      const { enterServerDetail } = await import("/views/server-detail.js");
      await enterServerDetail(fqdn);
    }, MEDIA);

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
    const post = sent.find((s) => s.url.includes("/api/server-registry/unrevoke"))!;
    const body = post.body as { request: { username: string; serverDomain: string; issuedAt: number }; signature: string };
    expect(body.request.username).toBe("smoketest");
    expect(body.request.serverDomain).toBe(MEDIA);
    expect(await signedByIrk(page, "unrevoke", body)).toBe(true);

    // The page re-reads .com and flips back to the reversible Revoke.
    await expect(page.locator("#revoke-server-btn")).toHaveText("Revoke server (reversible)", { timeout: 10_000 });
    await expect(page.locator("#unrevoke-server-btn")).toHaveCount(0);
    await shot(page, testInfo, "unrevoked-server");
  });

  test("gym servers delete a revoked server behind the typed-name gate", async ({ page }, testInfo) => {
    await reachHome(page);
    const sent = await stub(page, [
      [
        "/api/users/smoketest/pods",
        { pods: [livePod(HOME), offlinePod(MEDIA, { revokedAt: Date.now() - 86_400_000, revocationReason: "stolen" })] },
      ],
      [`/api/server/${MEDIA}/decommission`, { ok: true }],
      ["/api/server/release", { ok: true, released: true }],
    ]);
    await page.evaluate(async (fqdn) => {
      const { enterServerDetail } = await import("/views/server-detail.js");
      await enterServerDetail(fqdn);
    }, MEDIA);
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
    expect(sent).toEqual([]);
    await go.click();

    // The box is asked to wipe itself, then the name is released.
    await expect(page.locator("#toast")).toContainText(
      "Deleted media. If it's online it will erase itself and power off.",
      { timeout: 10_000 },
    );
    const decommission = sent.find((s) => s.url.includes(`/api/server/${MEDIA}/decommission`));
    const release = sent.find((s) => s.url.includes("/api/server/release"));
    expect(decommission).toBeTruthy();
    expect(release).toBeTruthy();
    expect(sent.indexOf(decommission!)).toBeLessThan(sent.indexOf(release!));
    const order = (decommission!.body as { order: { diskDisposition: string; retiredStkPubHex: string; podCanonical: string } }).order;
    expect(order.diskDisposition).toBe("wipe-now");
    expect(order.retiredStkPubHex).toBe(STK[MEDIA]);
    expect(order.podCanonical).toBe(MEDIA);
    expect((release!.body as { request: { serverDomain: string } }).request.serverDomain).toBe(MEDIA);

    // Back on Home, the deleted server is gone even though the stale lists
    // still name it.
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
    await expect(card(page, HOME)).toBeVisible({ timeout: 10_000 });
    await expect(card(page, MEDIA)).toHaveCount(0);
    await shot(page, testInfo, "deleted-home");
  });
});
