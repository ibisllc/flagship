/**
 * Share this server (docs/share-a-server.md §8) — the webapp surfaces with no
 * backend: the owner's "Shared with" card and the Share sheet, the other
 * account's accept view, its "Shared with me" section and the shared server's
 * page. Crypto is real (the page seals and signs with the session's UMK);
 * `.com`, the box and the boot worker are stubbed with page.route.
 *
 * Screenshots go to SHARE_SHOT_DIR when set (share-web-*.png), else to the
 * test's output dir.
 */

import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { stubAccountReadToken } from "../fixtures/accountRead.js";

const PASSPHRASE = "correct-horse-battery-staple-gym";
const OWNER_BOX = "home.smoketest.flagship.services";
const SHARED_BOX = "home.alice.flagship.services";
const OTHER_BOX = "media.kim.flagship.services";

test.use({ viewport: { width: 430, height: 932 } });

async function shot(page: Page, testInfo: TestInfo, name: string, opts: Parameters<Page["screenshot"]>[0] = {}): Promise<void> {
  const dir = process.env.SHARE_SHOT_DIR ?? testInfo.outputDir;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `share-web-${name}.png`);
  await page.addStyleTag({ content: `#toast { display: none !important; }${opts.fullPage ? " #tab-bar { display: none !important; }" : ""}` });
  await page.screenshot({ ...opts, path: file });
  await testInfo.attach(`gym-screenshot:${name}`, { path: file, contentType: "image/png" });
}

async function reachHome(page: Page): Promise<void> {
  await stubAccountReadToken(page);
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
  await page.evaluate(async () => {
    const store = await import("/lib/profilesStore.js");
    store.ensureProfile("smoketest");
    store.setActiveCloudName("smoketest");
    store.set("username", "smoketest");
    store.set("sessionId", "gym-fixture-session-id");
    const { getSession } = await import("/lib/state.js");
    getSession().username = "smoketest";
    const api = await import("/lib/api.js");
    api.setPodBaseUrl("https://home.smoketest.flagship.services");
    api.setSessionToken("gym-fixture-session-token");
    api.setSessionTokenForPod("home.smoketest.flagship.services", "gym-fixture-session-token");
    (await import("/lib/apex.js")).setApexOverride({ control: "https://flagshipserver.com" });
  });
}

type Responder = (body: unknown, url: URL) => { status?: number; json: unknown } | null;

/** One router for every foreign request: the first rule whose substring
 *  matches answers; anything else is a 404 so nothing reaches the network. */
async function stub(page: Page, rules: Array<[string, Responder | unknown]>): Promise<void> {
  await page.route(
    (url) => !url.href.startsWith("http://127.0.0.1"),
    async (route) => {
      const url = new URL(route.request().url());
      let body: unknown = null;
      try {
        body = route.request().postDataJSON();
      } catch {
        body = null;
      }
      for (const [needle, answer] of rules) {
        if (!url.href.includes(needle)) continue;
        const r = typeof answer === "function" ? (answer as Responder)(body, url) : { json: answer };
        if (!r) continue;
        await route.fulfill({ status: r.status ?? 200, contentType: "application/json", body: JSON.stringify(r.json) });
        return;
      }
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "gym: no stub" }) });
    },
  );
}

/** Seal real share fixtures with this browser's UMK (owner records, inbox
 *  entries) and with fresh link secrets (offers, acceptances). */
async function fixtures(page: Page) {
  return page.evaluate(
    async ({ OWNER_BOX, SHARED_BOX, OTHER_BOX }) => {
      const ss = await import("/lib/serverShare.js");
      const ks = await import("/keystore.js");
      const { getSession } = await import("/lib/state.js");
      const boot = (await import("/lib/bootApproval.js"))._internal;
      const umk = getSession().umk;
      const hex = ks.bytesToHex;
      const now = Date.now();
      const household = await ks.deriveHouseholdKeyFromSeed(umk);
      const inboxKey = await ss.deriveShareInboxSealKey(umk);

      async function signSeed(seed: Uint8Array, bytes: Uint8Array) {
        const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed]);
        const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
        return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, bytes));
      }

      async function ownerRow(label: string, level: string, accepted: boolean) {
        const shareId = ss.randomShareId();
        const secret = ss.randomShareSecret();
        const owner = await ss.sealShareJson(household, ss.shareAad(ss.AAD_SHARE_OWNER, shareId), {
          v: 1, secretHex: hex(secret), label, level, unlockAtBoot: false, seeAppData: false,
        });
        let acceptance = null;
        if (accepted) {
          const member = await ss.deriveShareMemberKey(crypto.getRandomValues(new Uint8Array(32)), shareId);
          const accept = { serverDomain: OWNER_BOX, shareId, memberPubHex: hex(member.publicKey), acceptedAt: now };
          const signature = hex(await ss.signServerShareAccept(accept, member.seed));
          acceptance = await ss.sealShareJson(await ss.shareLinkKey(secret), ss.shareAad(ss.AAD_SHARE_ACCEPTANCE, shareId), { v: 1, accept, signature });
        }
        return { shareId, serverDomain: OWNER_BOX, state: accepted ? "accepted" : "offered", owner, acceptance, expiresAt: now + 6 * 86_400_000, unlock: false };
      }

      async function memberShare(serverDomain: string, serverName: string, level: string, unlockAtBoot: boolean) {
        const shareId = ss.randomShareId();
        const secret = ss.randomShareSecret();
        const stkSeed = crypto.getRandomValues(new Uint8Array(32));
        const stkPubHex = hex(await ss.ed25519PublicKey(stkSeed));
        const offer = await ss.sealShareJson(await ss.shareLinkKey(secret), ss.shareAad(ss.AAD_SHARE_OFFER, shareId), {
          v: 1, serverDomain, serverName, stkPubHex, level, unlockAtBoot, seeAppData: false, expiresAt: now + 6 * 86_400_000,
        });
        const entryId = ss.randomShareId();
        const entry = { v: 1, shareId, secretHex: hex(secret), serverDomain, serverName, acceptedAt: now - 86_400_000 };
        const ct = await ss.sealShareJson(inboxKey, ss.shareAad(ss.AAD_SHARE_INBOX_ENTRY, entryId), entry);
        const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
        const request = { serverDomain, stkPub: stkPubHex, purpose: "unlock-key", nonce, issuedAt: now };
        const reqSig = hex(await signSeed(stkSeed, boot.canonicalSecretRequest({ serverDomain, stkPubHex, purpose: "unlock-key", nonceHex: nonce, issuedAt: now })));
        return { shareId, secretHex: hex(secret), offer, entryId, ct, entry: { entryId, ...entry }, startup: { request, signature: reqSig } };
      }

      const memberPub = hex(crypto.getRandomValues(new Uint8Array(32)));
      return {
        ownerRows: [await ownerRow("Ana", "view", true)],
        active: { shareId: ss.randomShareId(), label: "Sam", level: "manage", unlockAtBoot: true, seeAppData: false, memberPubHex: memberPub, issuedAt: now - 3 * 86_400_000, lastSeenAt: now - 2 * 3_600_000 },
        alice: await memberShare(SHARED_BOX, "home", "manage", true),
        kim: await memberShare(OTHER_BOX, "media", "view", false),
      };
    },
    { OWNER_BOX, SHARED_BOX, OTHER_BOX },
  );
}

function serverDetail(fqdn: string, username: string) {
  return {
    serverFqdn: fqdn,
    username,
    daemonVersion: "1.0.0",
    currentCommit: "37ba277d".padEnd(40, "0"),
    uptimeMs: 3 * 86_400_000 + 4 * 3_600_000,
    certNotAfter: Date.now() + 60 * 86_400_000,
    certSans: [fqdn],
    serviceCount: 2,
    pairedSessionCount: 1,
    recentInstallEvents: [],
  };
}

const APPS = {
  apps: [
    { serviceId: "notes", slug: "notes", url: `https://notes.${SHARED_BOX}`, status: "running", access: { rules: 2, pending: 0 } },
    { serviceId: "photos", slug: "photos", url: `https://photos.${SHARED_BOX}`, status: "running", access: { rules: 0, pending: 1 } },
  ],
};

const METRICS = { cpuPercent: 7.4, memUsedBytes: 1.6e9, memTotalBytes: 4.1e9, diskUsedBytes: 21e9, diskTotalBytes: 120e9, netRxBytesPerSec: 18_000, netTxBytesPerSec: 6_000, collectedAt: Date.now() };

test.describe("gym webapp share", () => {
  test("gym share owner card and share sheet", async ({ page }, testInfo) => {
    await reachHome(page);
    const fx = await fixtures(page);
    const stkPub = "ab".repeat(32);
    await stub(page, [
      ["/api/screens/server-detail", serverDetail(OWNER_BOX, "smoketest")],
      ["/api/screens/shares", { shares: [fx.active], ended: [{ shareId: "ef".repeat(16), label: "Lee", endedAt: Date.now() - 5 * 86_400_000, reason: "left" }] }],
      ["/server-shares/list", { shares: fx.ownerRows }],
      ["/api/users/smoketest/server-shares", { ok: true }],
      ["/api/users/smoketest/pods", { pods: [{ serverDomain: OWNER_BOX, identityPubKey: stkPub, liveness: "live", lastReported: Date.now() }] }],
      [
        "/api/screens/activity",
        {
          entries: [
            { ts: Date.now() - 20 * 60_000, actor: { kind: "share", shareId: fx.active.shareId, label: "Sam" }, action: "app.access.edit", target: "notes", ok: true },
            { ts: Date.now() - 2 * 3_600_000, actor: { kind: "share", shareId: fx.active.shareId, label: "Sam" }, action: "share.signed-in", ok: true },
            { ts: Date.now() - 3 * 86_400_000, actor: { kind: "owner" }, action: "share.granted", target: "Sam", ok: true },
          ],
        },
      ],
      ["/api/screens/apps-list", { apps: [] }],
      ["/api/screens/server-metrics", METRICS],
    ]);
    await page.evaluate(async (fqdn) => {
      const { enterServerDetail } = await import("/views/server-detail.js");
      await enterServerDetail(fqdn);
    }, OWNER_BOX);
    const card = page.locator("#shared-with-card");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator("[data-share-sas]")).toHaveText(/^\d{3} \d{3}$/, { timeout: 10_000 });
    await expect(card).toContainText("Sam");
    await expect(page.locator("#server-activity-card")).toContainText("Sam · changed notes's internet access");
    // Shared with sits after Leader and before Transfer.
    const order = await page.evaluate(() =>
      ["leader-card", "shared-with-card", "server-activity-card", "danger-zone-card"].map((id) => {
        const el = document.getElementById(id)!;
        return el.getBoundingClientRect().top + window.scrollY;
      }),
    );
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    await page.locator("#view-server-detail h2", { hasText: /^Shared with$/ }).evaluate((el) =>
      window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 72),
    );
    await shot(page, testInfo, "owner-shared-with");

    await page.click("#share-server-btn");
    const dlg = page.locator('dialog[aria-label="Share this server"]');
    await expect(dlg).toBeVisible();
    await expect(dlg.locator("[data-share-create]")).toBeDisabled();
    await dlg.locator("[data-share-label]").fill("Jo");
    await dlg.locator('input[name="share-level"][value="manage"]').check();
    await expect(dlg.locator("[data-share-unlock]")).not.toBeChecked();
    await expect(dlg.locator("[data-share-data]")).not.toBeChecked();
    await shot(page, testInfo, "share-sheet-form");
    await dlg.locator("[data-share-create]").click();
    await expect(dlg.locator("[data-share-link]")).toHaveValue(/^https:\/\/flagshipserver\.com\/share#s=[0-9a-f]{32}&k=[0-9a-f]{64}$/, { timeout: 10_000 });
    await expect(dlg.locator("[data-share-qr] svg")).toBeVisible();
    await shot(page, testInfo, "share-sheet-link");
  });

  test("gym share member accepts a link and reads the code", async ({ page }, testInfo) => {
    await reachHome(page);
    const fx = await fixtures(page);
    let accepted = false;
    await stub(page, [
      [`/api/server-shares/${fx.alice.shareId}/accept`, () => ((accepted = true), { json: { ok: true } })],
      [`/api/server-shares/${fx.alice.shareId}`, () => ({ json: { shareId: fx.alice.shareId, serverDomain: SHARED_BOX, state: accepted ? "accepted" : "offered", offer: fx.alice.offer, acceptance: null, unlock: false } })],
      ["/api/share-inbox", (b) => ({ json: (b as { request: { op: string } }).request.op === "list" ? { entries: [] } : { ok: true } })],
    ]);
    await page.evaluate(async (link) => {
      const { enterShareAccept } = await import("/views/share-accept.js");
      await enterShareAccept(link);
    }, { shareId: fx.alice.shareId, secretHex: fx.alice.secretHex });
    await expect(page.locator("#share-accept-content")).toContainText("home is shared with you", { timeout: 10_000 });
    await shot(page, testInfo, "member-offer");
    await page.click("[data-share-accept]");
    await expect(page.locator("[data-share-sas]")).toHaveText(/^\d{3} \d{3}$/, { timeout: 10_000 });
    await expect(page.locator("[data-share-waiting]")).toContainText("Waiting for the owner to confirm");
    await shot(page, testInfo, "member-code");
  });

  test("gym share member home and shared server page", async ({ page }, testInfo) => {
    await reachHome(page);
    const fx = await fixtures(page);
    const session = { token: "fss_gym", expiresAt: Date.now() + 12 * 3_600_000, level: "manage", unlockAtBoot: true, seeAppData: false };
    await stub(page, [
      ["/api/share-inbox", (b) => ({ json: (b as { request: { op: string } }).request.op === "list" ? { entries: [fx.alice, fx.kim].map((s) => ({ entryId: s.entryId, ct: s.ct, createdAt: 1 })) } : { ok: true } })],
      [`${SHARED_BOX}/api/shares/nonce`, { nonce: "11".repeat(32) }],
      [`${SHARED_BOX}/api/shares/session`, session],
      [`${SHARED_BOX}/api/shares/me`, { shareId: fx.alice.shareId, level: "manage", unlockAtBoot: true, seeAppData: false, serverDomain: SHARED_BOX }],
      [`${OTHER_BOX}/api/shares/nonce`, { nonce: "22".repeat(32) }],
      [`${OTHER_BOX}/api/shares/session`, () => ({ status: 403, json: { error: "not-shared", code: "not-shared" } })],
      [`/api/server-shares/${fx.alice.shareId}`, { shareId: fx.alice.shareId, serverDomain: SHARED_BOX, state: "accepted", offer: fx.alice.offer, unlock: true }],
      [`/api/server-shares/${fx.kim.shareId}`, { shareId: fx.kim.shareId, serverDomain: OTHER_BOX, state: "accepted", offer: fx.kim.offer, unlock: false }],
      [`/api/boot/share/pending/${SHARED_BOX}`, { requests: [fx.alice.startup] }],
      [`${SHARED_BOX}/api/screens/server-detail`, serverDetail(SHARED_BOX, "alice")],
      [`${SHARED_BOX}/api/screens/apps-list`, APPS],
      [`${SHARED_BOX}/api/screens/services/notes/access`, { access: { list: "allow api.github.com\n", listSha256: "", pending: [] } }],
      [`${SHARED_BOX}/api/screens/server-metrics`, METRICS],
      ["/api/me/servers", { servers: [{ serverId: OWNER_BOX }] }],
      ["/api/users/smoketest/pods", { pods: [{ serverDomain: OWNER_BOX, liveness: "live", lastReported: Date.now(), registeredAt: Date.now() - 86_400_000, currentCert: { validUntil: Date.now() + 60 * 86_400_000 } }] }],
    ]);
    await page.route("**/api/me/servers*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ servers: [{ serverId: OWNER_BOX }] }) }),
    );
    await page.evaluate(async () => {
      const { renderHome } = await import("/views/home.js");
      await renderHome();
    });
    const section = page.locator("#shared-with-me");
    await expect(section).toContainText("Shared with me", { timeout: 10_000 });
    await expect(section.locator('[data-open-share]', { hasText: "home" })).toContainText("Online");
    await expect(section.locator('[data-open-share]', { hasText: "media" })).toContainText("Waiting for the owner");
    await section.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 240));
    await shot(page, testInfo, "member-home");

    await section.locator('[data-open-share]', { hasText: "home" }).click({ position: { x: 20, y: 20 } });
    await expect(page.locator("#view-shared-server")).toBeVisible();
    await expect(page.locator("#shared-startup-card")).toContainText("home is starting. Unlock it?", { timeout: 10_000 });
    await expect(page.locator("#shared-server-sub")).toHaveText("Shared with you · Can manage");
    for (const owned of ["#danger-zone-card", "#lock-power-card", "#shared-with-card", "#update-card"]) {
      await expect(page.locator(`#view-shared-server ${owned}`)).toHaveCount(0);
    }
    await page.locator('[data-access-open="notes"]').click();
    await expect(page.locator('[data-access-editor="notes"] textarea')).toBeVisible();
    await page.locator('[data-access-editor="notes"] textarea').fill("allow api.github.com\nallow *.example.com\n");
    await expect(page.locator('[data-access-editor="notes"] [data-access-save]')).toBeEnabled();
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, testInfo, "member-server-page", { fullPage: true });
  });
});
