/**
 * Share this server (docs/share-a-server.md §5.1–§5.7, §8–§10), both sides,
 * every control: the owner's "Shared with" card (confirm or cancel a code, a
 * broken answer, level, start-up and app-data switches, Remove, an offered
 * link's Copy and Cancel, an expired link's Remove) and the Share sheet
 * (Cancel, Create, Copy link, Share, Done); the co-manager's link (Not now,
 * a confirmed share's Open, a bad link's Back), Home's "Shared with me" rows,
 * and the shared server page (start-up notices, Update, Approve start-up,
 * Leave, an app's access list, members-only apps, Refresh, Back).
 *
 * Crypto is real. The owner is an admin device and the mock answers each
 * owner order as `.com` and an admin-pinned box do (gymKit `sensitive`): only
 * the admin root verifies. The co-manager's orders are checked under the
 * per-share member key the box pins (deriveShareMemberKey(UMK, shareId)).
 */

import { test, expect, type Page } from "@playwright/test";
import {
  HOME,
  USER,
  livePod,
  mock,
  reachHome,
  freshUnlock,
  PASSPHRASE,
  sensitive,
  serverDetail,
  shot,
  signer,
  type Call,
  type Canon,
  type Keys,
  type Mock,
} from "./gymKit.js";

const SHARED_BOX = "home.alice.flagship.services";
const OTHER_BOX = "media.kim.flagship.services";
const HOME_STK = "ab".repeat(32);
const COMMIT_RUNNING = "37ba277d".padEnd(40, "0");
const COMMIT_LATEST = "52d0b375".padEnd(40, "3");

const SS = "/lib/serverShare.js";
const GRANT: Canon = [SS, "serverShareGrantCanonicalBytes"];
const REVOKE: Canon = [SS, "serverShareRevokeCanonicalBytes"];
const OFFER: Canon = [SS, "serverShareOfferCanonicalBytes"];
const UNLOCK: Canon = [SS, "serverShareUnlockCanonicalBytes"];

test.use({ viewport: { width: 430, height: 932 } });

/** Capture clipboard writes and navigator.share calls (before any page script). */
async function captureClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __copied: string[]; __shared: unknown[] };
    w.__copied = [];
    w.__shared = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t: string) => void w.__copied.push(t), readText: async () => w.__copied[w.__copied.length - 1] ?? "" },
    });
    Object.defineProperty(navigator, "share", { configurable: true, value: async (d: unknown) => void w.__shared.push(d) });
  });
}

/** A browser that can subscribe to Web Push without a service worker. */
async function fakeWebPush(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const sub = {
      endpoint: "https://push.example/gym-sub",
      options: { applicationServerKey: null },
      getKey: (n: string) => new Uint8Array(n === "p256dh" ? 65 : 16).fill(7).buffer,
      unsubscribe: async () => true,
    };
    const reg = { pushManager: { getSubscription: async () => null, subscribe: async () => sub }, showNotification: async () => {} };
    try {
      Object.defineProperty(Notification, "permission", { configurable: true, get: () => "granted" });
      Notification.requestPermission = (async () => "granted") as typeof Notification.requestPermission;
      Object.defineProperty(navigator.serviceWorker, "ready", { configurable: true, get: () => Promise.resolve(reg) });
    } catch {
      /* no service worker container */
    }
  });
}

/** Real share fixtures sealed with this browser's UMK. */
async function fixtures(page: Page) {
  return page.evaluate(
    async ({ HOME, SHARED_BOX, OTHER_BOX }) => {
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

      /** One of the owner's `.com` rows: offered, accepted (awaiting the code), broken or expired. */
      async function ownerRow(label: string, level: string, kind: "offered" | "accepted" | "broken" | "expired", unlockAtBoot = false) {
        const shareId = ss.randomShareId();
        const secret = ss.randomShareSecret();
        const owner = await ss.sealShareJson(household, ss.shareAad(ss.AAD_SHARE_OWNER, shareId), {
          v: 1, secretHex: hex(secret), label, level, unlockAtBoot, seeAppData: false,
        });
        let acceptance: string | null = null;
        let memberPubHex = "";
        if (kind === "accepted") {
          const member = await ss.deriveShareMemberKey(crypto.getRandomValues(new Uint8Array(32)), shareId);
          memberPubHex = hex(member.publicKey);
          const accept = { serverDomain: HOME, shareId, memberPubHex, acceptedAt: now };
          const signature = hex(await ss.signServerShareAccept(accept, member.seed));
          acceptance = await ss.sealShareJson(await ss.shareLinkKey(secret), ss.shareAad(ss.AAD_SHARE_ACCEPTANCE, shareId), { v: 1, accept, signature });
        }
        if (kind === "broken") acceptance = "00".repeat(48);
        const state = kind === "accepted" || kind === "broken" ? "accepted" : "offered";
        const expiresAt = kind === "expired" ? now - 3_600_000 : now + 6 * 86_400_000;
        return {
          row: { shareId, serverDomain: HOME, state, owner, acceptance, expiresAt, unlock: false },
          secretHex: hex(secret),
          memberPubHex,
          sas: kind === "accepted" ? ss.formatShareSas(await ss.shareSas(shareId, memberPubHex, secret)) : "",
        };
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
        // This account's copy of the disk key, sealed to its member key (what
        // the owner's unlock deposit holds for it).
        const diskKey = crypto.getRandomValues(new Uint8Array(32));
        const member = await ss.deriveShareMemberKey(umk, shareId);
        const sealedKey = hex(await boot.sealForBoxStk(diskKey, member.publicKey));
        return {
          shareId,
          secretHex: hex(secret),
          token: await ss.shareTokenFromSecret(secret),
          offer,
          entryId,
          ct,
          stkSeedHex: hex(stkSeed),
          memberPubHex: hex(member.publicKey),
          diskKeyHex: hex(diskKey),
          sealedKey,
          startup: { request, signature: reqSig },
        };
      }

      // Sam, an active co-manager on the owner's box, with a real member key
      // (a start-up copy of the disk key is sealed to it).
      const samSeed = crypto.getRandomValues(new Uint8Array(32));
      const samShare = ss.randomShareId();
      const sam = await ss.deriveShareMemberKey(samSeed, samShare);
      // The owner's disk key, sealed to the account IRK as `.com` keeps it.
      const ownerDiskKey = crypto.getRandomValues(new Uint8Array(32));
      const irk = await ks.deriveIrkFromSeed(umk);
      return {
        ana: await ownerRow("Ana", "manage", "accepted"),
        bo: await ownerRow("Bo", "view", "accepted"),
        cy: await ownerRow("Cy", "view", "broken"),
        dee: await ownerRow("Dee", "view", "offered"),
        eli: await ownerRow("Eli", "manage", "expired"),
        active: {
          shareId: samShare,
          label: "Sam",
          level: "manage",
          unlockAtBoot: false,
          seeAppData: false,
          memberPubHex: hex(sam.publicKey),
          issuedAt: now - 3 * 86_400_000,
          lastSeenAt: now - 2 * 3_600_000,
        },
        samSeedHex: hex(sam.seed),
        ownerDiskKeyHex: hex(ownerDiskKey),
        ownerSealedKey: hex(await boot.sealForBoxStk(ownerDiskKey, irk.publicKey)),
        alice: await memberShare(SHARED_BOX, "home", "manage", true),
        kim: await memberShare(OTHER_BOX, "media", "view", false),
      };
    },
    { HOME, SHARED_BOX, OTHER_BOX },
  );
}
type Fx = Awaited<ReturnType<typeof fixtures>>;

/** Whether `sigHex` is this account's per-share member key over `canon(arg)`. */
async function memberSigned(page: Page, shareId: string, fn: string, arg: unknown, sigHex: string): Promise<boolean> {
  return page.evaluate(
    async ({ shareId, fn, arg, sigHex }) => {
      const ss = (await import("/lib/serverShare.js")) as unknown as Record<string, (a: unknown) => Uint8Array>;
      const ks = await import("/keystore.js");
      const { getSession } = await import("/lib/state.js");
      const member = await (await import("/lib/serverShare.js")).deriveShareMemberKey(getSession().umk, shareId);
      return ks.verifyWithEd25519Pub(member.publicKey, ks.hexToBytes(sigHex), ss[fn]!(arg));
    },
    { shareId, fn, arg, sigHex },
  );
}

/** Whether `sealedHex` opens with `seedHex` to `plainHex` (a disk key copy). */
async function opensTo(page: Page, sealedHex: string, seedHex: string): Promise<string> {
  return page.evaluate(
    async ({ sealedHex, seedHex }) => {
      const ks = await import("/keystore.js");
      const boot = (await import("/lib/bootApproval.js"))._internal;
      return ks.bytesToHex(await boot.openSealedWithEd25519Seed(ks.hexToBytes(sealedHex), ks.hexToBytes(seedHex)));
    },
    { sealedHex, seedHex },
  );
}

const METRICS = { cpuPercent: 7.4, memUsedBytes: 1.6e9, memTotalBytes: 4.1e9, diskUsedBytes: 21e9, diskTotalBytes: 120e9, netRxBytesPerSec: 18_000, netTxBytesPerSec: 6_000, collectedAt: Date.now() };

// ───────────────────────────── owner side ─────────────────────────────

/** The owner's server page with `.com` rows and the box's active shares. */
async function ownerPage(page: Page, keys: Keys, comRows: unknown[], boxShares: () => unknown[]): Promise<Mock> {
  const m = await mock(page);
  m.get("/api/users/smoketest/pods", { pods: [livePod(HOME, { identityPubKey: HOME_STK })] });
  m.get(`${HOME}/api/screens/server-detail`, serverDetail(HOME));
  m.get(`${HOME}/api/screens/shares`, () => ({ json: { shares: boxShares(), ended: [] } }));
  m.post(`${HOME}/api/screens/shares/revoke`, sensitive(page, keys, REVOKE, (b) => ({ arg: b.revoke, sig: b.signature }), () => ({ json: { ok: true } })));
  m.post(`${HOME}/api/screens/shares`, sensitive(page, keys, GRANT, (b) => ({ arg: b.grant, sig: b.signature }), () => ({ json: { ok: true } })));
  m.post("/api/users/smoketest/server-shares/list", { shares: comRows });
  m.post(/\/api\/users\/smoketest\/server-shares\/[0-9a-f]+\/revoke$/, sensitive(page, keys, REVOKE, (b) => ({ arg: b.revoke, sig: b.signature }), () => ({ json: { ok: true } })));
  m.post(/\/api\/users\/smoketest\/server-shares\/[0-9a-f]+\/unlock$/, sensitive(page, keys, UNLOCK, (b) => ({ arg: b.unlock, sig: b.signature }), () => ({ json: { ok: true } })));
  m.post(/\/api\/users\/smoketest\/server-shares$/, sensitive(page, keys, OFFER, (b) => ({ arg: b.offer, sig: b.signature }), () => ({ json: { ok: true } })));
  m.get(`${HOME}/api/screens/activity`, { entries: [] });
  m.get(`${HOME}/api/screens/apps-list`, { apps: [] });
  m.get(`${HOME}/api/screens/server-metrics`, METRICS);
  await page.evaluate(async (fqdn) => {
    const { enterServerDetail } = await import("/views/server-detail.js");
    await enterServerDetail(fqdn);
  }, HOME);
  await expect(page.locator("#shared-with-card")).toBeVisible({ timeout: 10_000 });
  return m;
}

const row = (page: Page, shareId: string) => page.locator(`#shared-with-list [data-share-row="${shareId}"]`);

async function scrollToShares(page: Page): Promise<void> {
  await page.locator("#view-server-detail h2", { hasText: /^Shared with$/ }).evaluate((el) =>
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 72),
  );
}

// ─────────────────────────── co-manager side ───────────────────────────

interface MemberOpts {
  me?: Record<string, unknown>;
  /** What the shared box answers to a sign-in. */
  session?: (call: Call) => { status?: number; json: unknown };
  /** `.com`'s `unlock` flag on the share row. */
  unlock?: boolean;
  startups?: boolean;
  apps?: unknown[];
}

/** The co-manager's routes for `alice` (manage, start-up approval) and `kim`. */
async function memberRoutes(page: Page, fx: Fx, o: MemberOpts = {}): Promise<Mock> {
  const a = fx.alice;
  const me = { shareId: a.shareId, level: "manage", unlockAtBoot: true, seeAppData: false, serverDomain: SHARED_BOX, ...(o.me ?? {}) };
  const m = await mock(page);
  m.post("/api/share-inbox", (call) =>
    ({ json: call.body.request.op === "list" ? { entries: [fx.alice, fx.kim].map((s) => ({ entryId: s.entryId, ct: s.ct, createdAt: 1 })) } : { ok: true } }));
  m.get(`${SHARED_BOX}/api/shares/nonce`, { nonce: "11".repeat(32) });
  m.post(`${SHARED_BOX}/api/shares/session`, o.session ?? (() => ({ json: { token: "fss_gym", expiresAt: Date.now() + 12 * 3_600_000, level: me.level, unlockAtBoot: me.unlockAtBoot, seeAppData: me.seeAppData } })));
  m.get(`${SHARED_BOX}/api/shares/me`, me);
  m.get(`${OTHER_BOX}/api/shares/nonce`, { nonce: "22".repeat(32) });
  m.first("POST", `${OTHER_BOX}/api/shares/session`, () => ({ status: 403, json: { error: "not-shared", code: "not-shared" } }));
  m.get(`/api/server-shares/${a.shareId}`, { shareId: a.shareId, serverDomain: SHARED_BOX, state: "accepted", offer: a.offer, unlock: o.unlock ?? true });
  m.get(`/api/server-shares/${fx.kim.shareId}`, { shareId: fx.kim.shareId, serverDomain: OTHER_BOX, state: "accepted", offer: fx.kim.offer, unlock: false });
  m.get(`/api/boot/share/pending/${SHARED_BOX}`, () => ({ json: { requests: o.startups ? [a.startup] : [] } }));
  m.get(`${SHARED_BOX}/api/screens/server-detail`, { ...serverDetail(SHARED_BOX), username: "alice", currentCommit: COMMIT_RUNNING });
  m.get(`${SHARED_BOX}/api/screens/apps-list`, {
    apps: o.apps ?? [
      { serviceId: "notes", slug: "notes", url: `https://notes.${SHARED_BOX}`, status: "running", access: { rules: 2, pending: 0 } },
      { serviceId: "photos", slug: "photos", url: `https://photos.${SHARED_BOX}`, status: "running", accessMode: "members-only", access: { rules: 0, pending: 0 } },
    ],
  });
  m.get(`${SHARED_BOX}/api/screens/server-metrics`, METRICS);
  m.get(`${SHARED_BOX}/api/screens/updates`, {
    latest: { commit: COMMIT_LATEST, tag: "v1.4.0" },
    releases: [
      { commit: COMMIT_LATEST, tag: "v1.4.0", relation: "newer" },
      { commit: COMMIT_RUNNING, tag: "v1.3.2", relation: "current" },
    ],
  });
  m.get("/api/users/smoketest/pods", { pods: [] });
  return m;
}

async function renderMemberHome(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { renderHome } = await import("/views/home.js");
    await renderHome();
  });
  await expect(page.locator("#shared-with-me")).toContainText("Shared with me", { timeout: 15_000 });
}

/** Open the shared `home` from its Home row (a click, as a person would). */
async function openSharedFromHome(page: Page): Promise<void> {
  await renderMemberHome(page);
  await page.locator("#shared-with-me [data-open-share]", { hasText: "home" }).click({ position: { x: 20, y: 20 } });
  await expect(page.locator("#view-shared-server")).toBeVisible({ timeout: 10_000 });
}

test.describe("gym webapp sharing", () => {
  // ─────────────────────────── owner ───────────────────────────

  test("gym sharing owner confirms a matching code and cancels a mismatched one", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const fx = await fixtures(page);
    const live: unknown[] = [];
    const m = await ownerPage(page, keys, [fx.ana.row, fx.bo.row, fx.cy.row], () => live);
    await expect(row(page, fx.ana.row.shareId).locator("[data-share-sas]")).toHaveText(fx.ana.sas, { timeout: 10_000 });
    await expect(row(page, fx.bo.row.shareId).locator("[data-share-sas]")).toHaveText(fx.bo.sas);
    await expect(row(page, fx.cy.row.shareId)).toContainText("their answer didn't check out");
    await scrollToShares(page);
    await shot(page, testInfo, "owner-awaiting-codes");

    // Bo's phone shows another code: No, cancel → "Keep it" sends nothing…
    await row(page, fx.bo.row.shareId).locator("[data-share-cancel]").click();
    await expect(page.locator(".modal-title")).toHaveText("Cancel this link?");
    await page.click("[data-modal-cancel]");
    await expect(page.locator(".modal-title")).toHaveCount(0);
    expect(m.sent("/revoke")).toHaveLength(0);
    // …"Cancel link" ends it on .com, signed with the admin root.
    await row(page, fx.bo.row.shareId).locator("[data-share-cancel]").click();
    await page.click("[data-modal-ok]");
    const boRevoke = await m.waitFor(`/server-shares/${fx.bo.row.shareId}/revoke`);
    expect(boRevoke.body.revoke).toMatchObject({ serverDomain: HOME, shareId: fx.bo.row.shareId });
    expect(await signer(page, keys, REVOKE, boRevoke.body.revoke, boRevoke.body.signature)).toBe("admin");

    // The broken answer's Cancel link does the same.
    await row(page, fx.cy.row.shareId).locator("[data-share-cancel]").click();
    await page.click("[data-modal-ok]");
    await m.waitFor(`/server-shares/${fx.cy.row.shareId}/revoke`);

    // Ana's code matches: Yes, confirm signs the grant with her acceptance.
    await row(page, fx.ana.row.shareId).locator("[data-share-confirm]").click();
    await freshUnlock(page, "Give Ana access?");
    const grant = await m.waitFor(`${HOME}/api/screens/shares`);
    expect(grant.body.grant).toMatchObject({ serverDomain: HOME, shareId: fx.ana.row.shareId, memberPubHex: fx.ana.memberPubHex, level: "manage", label: "Ana" });
    expect(grant.body.accept.memberPubHex).toBe(fx.ana.memberPubHex);
    expect(await signer(page, keys, GRANT, grant.body.grant, grant.body.signature)).toBe("admin");
    await expect(page.locator("#toast")).toContainText("Ana can now manage this server", { timeout: 10_000 });
    await shot(page, testInfo, "owner-confirmed");
  });

  test("gym sharing owner changes a co-manager's level, switches and removes them", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const fx = await fixtures(page);
    const m = await ownerPage(page, keys, [], () => [fx.active]);
    m.first("GET", `/api/server/${HOME}/sealed-luks-key`, { sealedKey: fx.ownerSealedKey });
    const sam = row(page, fx.active.shareId);
    await expect(sam.locator("[data-share-level]")).toHaveValue("manage", { timeout: 10_000 });
    await scrollToShares(page);
    await shot(page, testInfo, "owner-active-share");

    // Level: Can view.
    await sam.locator("[data-share-level]").selectOption("view");
    let g = await m.waitFor(`${HOME}/api/screens/shares`);
    expect(g.body.grant).toMatchObject({ shareId: fx.active.shareId, level: "view", unlockAtBoot: false, seeAppData: false });
    expect(await signer(page, keys, GRANT, g.body.grant, g.body.signature)).toBe("admin");

    // See app data on.
    await sam.locator('[data-share-opt="seeAppData"]').check();
    await freshUnlock(page, "Let Sam see app data?");
    g = await m.waitFor(`${HOME}/api/screens/shares`, "POST", 2);
    expect(g.body.grant).toMatchObject({ seeAppData: true, level: "manage" });

    // Start-up approval: Cancel puts the switch back and sends nothing.
    await sam.locator('[data-share-opt="unlockAtBoot"]').click();
    await expect(page.locator(".modal-title")).toHaveText("Let Sam approve start-up?");
    await page.click("[data-modal-cancel]");
    await expect(sam.locator('[data-share-opt="unlockAtBoot"]')).not.toBeChecked();
    expect(m.sent(`${HOME}/api/screens/shares`)).toHaveLength(2);
    // Allow: the grant, then Sam's copy of the disk key on .com.
    await sam.locator('[data-share-opt="unlockAtBoot"]').click();
    await freshUnlock(page, "Let Sam approve start-up?");
    g = await m.waitFor(`${HOME}/api/screens/shares`, "POST", 3);
    expect(g.body.grant.unlockAtBoot).toBe(true);
    const dep = await m.waitFor(`/server-shares/${fx.active.shareId}/unlock`);
    expect(dep.body.unlock).toMatchObject({ serverDomain: HOME, shareId: fx.active.shareId, memberPubHex: fx.active.memberPubHex });
    expect(await signer(page, keys, UNLOCK, dep.body.unlock, dep.body.signature)).toBe("admin");
    expect(await opensTo(page, dep.body.sealedKey, fx.samSeedHex)).toBe(fx.ownerDiskKeyHex);
    await shot(page, testInfo, "owner-switches");

    // Remove: confirm, then the box and .com both end it.
    await sam.locator("[data-share-remove]").click();
    await expect(page.locator(".modal-title")).toHaveText("Remove Sam?");
    await page.click("[data-modal-ok]");
    const boxRevoke = await m.waitFor(`${HOME}/api/screens/shares/revoke`);
    const comRevoke = await m.waitFor(`/server-shares/${fx.active.shareId}/revoke`);
    expect(boxRevoke.body.revoke.shareId).toBe(fx.active.shareId);
    expect(await signer(page, keys, REVOKE, boxRevoke.body.revoke, boxRevoke.body.signature)).toBe("admin");
    expect(comRevoke.body.signature).toBe(boxRevoke.body.signature);
    await expect(page.locator("#toast")).toContainText("Removed Sam", { timeout: 10_000 });
  });

  test("gym sharing owner copies or cancels an unopened link and removes an expired one", async ({ page }, testInfo) => {
    await captureClipboard(page);
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const fx = await fixtures(page);
    const m = await ownerPage(page, keys, [fx.dee.row, fx.eli.row], () => []);
    const dee = row(page, fx.dee.row.shareId);
    const eli = row(page, fx.eli.row.shareId);
    await expect(dee).toContainText("Waiting for Dee to open the link.", { timeout: 10_000 });
    await expect(eli).toContainText("The link for Eli expired.");
    await expect(eli.locator("[data-share-copy]")).toHaveCount(0);
    await scrollToShares(page);
    await shot(page, testInfo, "owner-offered-links");

    await dee.locator("[data-share-copy]").click();
    await expect(page.locator("#toast")).toContainText("Link copied");
    const copied = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
    expect(copied).toEqual([`https://flagshipserver.com/share#s=${fx.dee.row.shareId}&k=${fx.dee.secretHex}`]);

    await dee.locator("[data-share-cancel]").click();
    await expect(page.locator(".modal-title")).toHaveText("Cancel this link?");
    await page.click("[data-modal-ok]");
    const r1 = await m.waitFor(`/server-shares/${fx.dee.row.shareId}/revoke`);
    expect(await signer(page, keys, REVOKE, r1.body.revoke, r1.body.signature)).toBe("admin");

    await expect(eli.locator("[data-share-cancel]")).toHaveText("Remove");
    await eli.locator("[data-share-cancel]").click();
    await page.click("[data-modal-ok]");
    await m.waitFor(`/server-shares/${fx.eli.row.shareId}/revoke`);
  });

  test("gym sharing owner's share sheet: Cancel sends nothing, Create signs the offer, Copy link, Share and Done", async ({ page }, testInfo) => {
    await captureClipboard(page);
    const keys = await reachHome(page, { kind: "admin", servers: [HOME] });
    const m = await ownerPage(page, keys, [], () => []);
    const dlg = page.locator('dialog[aria-label="Share this server"]');

    await page.click("#share-server-btn");
    await dlg.locator("[data-share-label]").fill("Jo");
    await dlg.locator("[data-share-close]").click();
    await expect(dlg).toHaveCount(0);
    expect(m.sent(/server-shares$/)).toHaveLength(0);

    await page.click("#share-server-btn");
    await dlg.locator("[data-share-label]").fill("Jo");
    await dlg.locator('input[name="share-level"][value="manage"]').check();
    await dlg.locator("[data-share-unlock]").check();
    await dlg.locator("[data-share-data]").check();
    await shot(page, testInfo, "share-sheet-all-on");
    await dlg.locator("[data-share-create]").click();
    // One fresh unlock inside the sheet: a wrong passphrase is refused there and nothing is sent.
    await expect(dlg.locator("[data-share-unlock-title]")).toHaveText("Share home with Jo?");
    await dlg.locator("[data-share-passphrase]").fill("not-this-device-passphrase");
    await dlg.locator("[data-share-unlock-ok]").click();
    await expect(dlg.locator("[data-share-error]")).toHaveText("That passphrase doesn't unlock this device.");
    expect(m.sent(/server-shares$/)).toHaveLength(0);
    await dlg.locator("[data-share-create]").click();
    await dlg.locator("[data-share-passphrase]").fill(PASSPHRASE);
    await dlg.locator("[data-share-unlock-ok]").click();
    const link = dlg.locator("[data-share-link]");
    await expect(link).toHaveValue(/^https:\/\/flagshipserver\.com\/share#s=[0-9a-f]{32}&k=[0-9a-f]{64}$/, { timeout: 10_000 });
    const post = m.last(/server-shares$/)!;
    expect(post.body.offer).toMatchObject({ username: USER, serverDomain: HOME });
    expect(await signer(page, keys, OFFER, post.body.offer, post.body.signature)).toBe("admin");
    // What the link opens to carries the choices.
    const sealed = await page.evaluate(
      async ({ offerHex, shareId, link }) => {
        const ss = await import("/lib/serverShare.js");
        const ks = await import("/keystore.js");
        const k = new URL(link).hash.match(/k=([0-9a-f]+)/)![1]!;
        return ss.openShareJson(await ss.shareLinkKey(ks.hexToBytes(k)), ss.shareAad(ss.AAD_SHARE_OFFER, shareId), offerHex);
      },
      { offerHex: post.body.offerHex, shareId: post.body.offer.shareId, link: await link.inputValue() },
    );
    expect(sealed).toMatchObject({ serverDomain: HOME, stkPubHex: HOME_STK, level: "manage", unlockAtBoot: true, seeAppData: true });

    await dlg.locator("[data-share-copy-link]").click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([await link.inputValue()]);
    await dlg.locator("[data-share-send]").click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __shared: Array<{ url: string; title: string }> }).__shared))
      .toEqual([{ title: "A Flagship server for Jo", url: await link.inputValue() }]);
    await shot(page, testInfo, "share-sheet-link-ready");
    const listsBefore = m.sent("/server-shares/list").length;
    await dlg.locator("[data-share-done]").click();
    await expect(dlg).toHaveCount(0);
    // Done reloads the card so the new link shows.
    await expect.poll(() => m.sent("/server-shares/list").length).toBeGreaterThan(listsBefore);
  });

  test("gym sharing a non-admin device sees who the server is shared with but can't change it", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "non-admin", servers: [HOME] });
    const fx = await fixtures(page);
    const m = await ownerPage(page, keys, [], () => [fx.active]);
    // Every share order signs under the admin root, which this device lacks:
    // the list shows, read-only, and the page says only an admin device shares.
    const sam = row(page, fx.active.shareId);
    await expect(sam).toBeVisible({ timeout: 10_000 });
    await expect(sam.locator("[data-share-level]")).toHaveCount(0);
    await expect(sam.locator("[data-share-remove]")).toHaveCount(0);
    await expect(page.locator("#share-server-btn")).toHaveCount(0);
    await expect(page.locator("[data-share-admin-only]")).toHaveText("Only an admin device can share this server.");
    // The rest of the page's orders are off too, with one line why.
    await expect(page.locator("[data-server-admin-only]")).toHaveText("Only an admin device can change this server. This device can see it.");
    for (const id of ["#update-server-btn", "#backup-start-btn", "#migrate-start-btn", "#power-off-btn", "#delete-server-btn", "#revoke-server-btn", "#transfer-start-btn", "#deadman-enable-btn"]) {
      await expect(page.locator(id), id).toBeDisabled();
    }
    await scrollToShares(page);
    await shot(page, testInfo, "share-non-admin-read-only");
    expect(m.sent(/server-shares|\/api\/screens\/shares/).filter((c) => !c.url.pathname.endsWith("/list"))).toEqual([]);
  });

  // ─────────────────────────── co-manager ───────────────────────────

  test("gym sharing co-manager link: Not now, a bad link's Back to servers, and Open once the owner confirms", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const fx = await fixtures(page);
    let confirmed = false;
    let accepted = false;
    const m = await mock(page);
    m.post(`/api/server-shares/${fx.alice.shareId}/accept`, () => ((accepted = true), { json: { ok: true } }));
    m.get(`/api/server-shares/${fx.alice.shareId}`, () => ({ json: { shareId: fx.alice.shareId, serverDomain: SHARED_BOX, state: accepted ? "accepted" : "offered", offer: fx.alice.offer, acceptance: null, unlock: true } }));
    m.first("GET", `/api/server-shares/${fx.kim.shareId}`, () => ({ status: 404, json: { error: "not found" } }));
    m.post("/api/share-inbox", (c) => ({ json: c.body.request.op === "list" ? { entries: [] } : { ok: true } }));
    m.get(`${SHARED_BOX}/api/shares/nonce`, { nonce: "11".repeat(32) });
    m.post(`${SHARED_BOX}/api/shares/session`, () =>
      confirmed
        ? { json: { token: "fss_gym", expiresAt: Date.now() + 3_600_000, level: "manage", unlockAtBoot: true, seeAppData: false } }
        : { status: 403, json: { error: "not-shared", code: "not-shared" } });
    m.get(`${SHARED_BOX}/api/shares/me`, { shareId: fx.alice.shareId, level: "manage", unlockAtBoot: true, seeAppData: false, serverDomain: SHARED_BOX });
    m.get(`${SHARED_BOX}/api/screens/server-detail`, { ...serverDetail(SHARED_BOX), username: "alice" });
    m.get(`${SHARED_BOX}/api/screens/apps-list`, { apps: [] });
    m.get(`${SHARED_BOX}/api/screens/server-metrics`, METRICS);
    m.get("/api/users/smoketest/pods", { pods: [] });
    const open = (link: { shareId: string; secretHex: string }) =>
      page.evaluate(async (link) => {
        const { enterShareAccept } = await import("/views/share-accept.js");
        await enterShareAccept(link);
      }, link);

    // Not now: back to Home, nothing accepted.
    await open({ shareId: fx.alice.shareId, secretHex: fx.alice.secretHex });
    await expect(page.locator("#share-accept-content")).toContainText("home is shared with you", { timeout: 10_000 });
    await page.click("[data-share-decline]");
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
    expect(m.sent("/accept")).toHaveLength(0);

    // A link .com doesn't know: the error and Back to servers.
    await open({ shareId: fx.kim.shareId, secretHex: fx.kim.secretHex });
    await expect(page.locator("#share-accept-content")).toContainText("This link doesn't work. Ask the owner to send it again.", { timeout: 10_000 });
    await shot(page, testInfo, "member-bad-link");
    await page.click("[data-share-home]");
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });

    // Accept, read the code; once the owner confirms, Open lands on the server.
    await open({ shareId: fx.alice.shareId, secretHex: fx.alice.secretHex });
    await page.click("[data-share-accept]");
    await expect(page.locator("[data-share-waiting]")).toBeVisible({ timeout: 10_000 });
    const put = m.sent("/api/share-inbox").find((c) => c.body.request.op === "put");
    expect(put).toBeTruthy();
    confirmed = true;
    await expect(page.locator("[data-share-open]")).toHaveText("Open home", { timeout: 20_000 });
    await shot(page, testInfo, "member-confirmed");
    await page.click("[data-share-open]");
    await expect(page.locator("#shared-server-sub")).toHaveText("Shared with you · Can manage", { timeout: 10_000 });

    // The page's Back goes Home; so does the accept view's.
    await page.click("#shared-server-back");
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
    await open({ shareId: fx.alice.shareId, secretHex: fx.alice.secretHex });
    await page.click("#share-accept-back");
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
  });

  test("gym sharing co-manager turns start-up notices on and off", async ({ page }, testInfo) => {
    await fakeWebPush(page);
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const fx = await fixtures(page);
    const m = await memberRoutes(page, fx);
    m.get("/api/push/vapid-public-key", { key: "BA".padEnd(87, "A") });
    let refuse = true;
    m.post(`/api/server-shares/${fx.alice.shareId}/push`, () =>
      refuse ? { status: 403, json: { error: "unlock-not-shared", code: "unlock-not-shared" } } : { json: { ok: true } });
    await openSharedFromHome(page);
    const toggle = page.locator("#shared-notify-toggle");
    await expect(toggle).not.toBeChecked({ timeout: 10_000 });
    await shot(page, testInfo, "member-notify-off");

    // The owner hasn't deposited a copy for this device yet: refused, switch back off.
    await toggle.check();
    await expect(page.locator("#toast")).toContainText("The owner hasn't let you approve this server's start-up.", { timeout: 10_000 });
    await expect(toggle).not.toBeChecked();

    refuse = false;
    await toggle.check();
    await expect(page.locator("#toast")).toContainText("This device will be told when it needs to start", { timeout: 10_000 });
    const on = m.last(`/api/server-shares/${fx.alice.shareId}/push`)!;
    expect(on.headers["x-flagship-share-token"]).toBe(fx.alice.token);
    expect(on.body.push).toMatchObject({ serverDomain: SHARED_BOX, shareId: fx.alice.shareId, memberPubHex: fx.alice.memberPubHex, op: "put", platform: "webpush" });
    expect(JSON.parse(on.body.providerToken).endpoint).toBe("https://push.example/gym-sub");
    expect(await memberSigned(page, fx.alice.shareId, "serverSharePushCanonicalBytes", on.body.push, on.body.signature)).toBe(true);
    await expect(toggle).toBeChecked();
    await shot(page, testInfo, "member-notify-on");

    await toggle.uncheck();
    await expect(page.locator("#toast")).toContainText("Notices turned off", { timeout: 10_000 });
    const off = m.last(`/api/server-shares/${fx.alice.shareId}/push`)!;
    expect(off.body.push).toMatchObject({ op: "delete", tokenSha256: on.body.push.tokenSha256 });
    expect(off.body.providerToken).toBeUndefined();
    expect(await memberSigned(page, fx.alice.shareId, "serverSharePushCanonicalBytes", off.body.push, off.body.signature)).toBe(true);
  });

  test("gym sharing co-manager updates a shared server to the newest release", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const fx = await fixtures(page);
    const m = await memberRoutes(page, fx, { me: { canUpdate: true } });
    let answer: { status?: number; json: unknown } = { status: 409, json: { error: "busy", code: "busy" } };
    m.post(`${SHARED_BOX}/api/shares/update`, () => answer);
    await openSharedFromHome(page);
    const btn = page.locator("#shared-release-btn");
    await expect(btn).toHaveText("Update to v1.4.0", { timeout: 10_000 });
    await page.locator("#shared-release-card").scrollIntoViewIfNeeded();
    await shot(page, testInfo, "member-update-offer");

    // Cancel sends nothing.
    await btn.click();
    await expect(page.locator(".modal-title")).toHaveText("Update home?");
    await page.click("[data-modal-cancel]");
    expect(m.sent("/api/shares/update")).toHaveLength(0);

    // The box refuses while an update runs: its reason, in words.
    await btn.click();
    await page.click("[data-modal-ok]");
    await expect(page.locator("#toast")).toContainText("An update is already underway.", { timeout: 10_000 });
    await expect(btn).toBeEnabled();

    answer = { json: { ok: true } };
    await btn.click();
    await page.click("[data-modal-ok]");
    await expect(page.locator("#toast")).toContainText("Updating home. It restarts in a few minutes.", { timeout: 10_000 });
    await expect(page.locator("#shared-release-offer")).toContainText("Updating to v1.4.0…");
    const post = m.last(`${SHARED_BOX}/api/shares/update`)!;
    expect(post.headers["x-flagship-session"]).toBe("fss_gym");
    expect(post.body.update).toMatchObject({
      serverDomain: SHARED_BOX,
      shareId: fx.alice.shareId,
      memberPubHex: fx.alice.memberPubHex,
      targetCommit: COMMIT_LATEST,
      fromCommit: COMMIT_RUNNING,
    });
    expect(await memberSigned(page, fx.alice.shareId, "serverShareUpdateCanonicalBytes", post.body.update, post.body.signature)).toBe(true);
    await shot(page, testInfo, "member-update-sent");
  });

  test("gym sharing co-manager approves a waiting start-up from its Home row", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const fx = await fixtures(page);
    // The box is locked (starting): it can't take a sign-in; it asks the boot gate.
    const m = await memberRoutes(page, fx, { startups: true, session: () => ({ status: 503, json: { error: "starting" } }) });
    m.get(`/api/boot/share/key/${SHARED_BOX}`, { sealedKey: fx.alice.sealedKey });
    m.post("/api/boot/response", { ok: true });
    await renderMemberHome(page);
    const homeRow = page.locator("#shared-with-me [data-open-share]", { hasText: "home" });
    await expect(homeRow).toContainText("Waiting to start", { timeout: 10_000 });
    await homeRow.evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 200));
    await shot(page, testInfo, "member-row-waiting-to-start");

    await homeRow.locator("[data-shared-approve]").click();
    await expect(page.locator("#view-shared-server")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#shared-startup-card")).toContainText("home is starting. Unlock it?", { timeout: 10_000 });
    await page.click("#shared-startup-approve");
    await expect(page.locator("#toast")).toContainText("home is unlocking", { timeout: 10_000 });
    await expect(page.locator("#shared-startup-card")).toHaveCount(0);
    const res = m.last("/api/boot/response")!;
    expect(res.headers["authorization"]).toMatch(/^Flagship-Boot-v1 /);
    expect(res.body.response).toMatchObject({ serverDomain: SHARED_BOX, requestNonceHex: fx.alice.startup.request.nonce, purpose: "unlock-key" });
    // Sealed for the box's pinned key, carrying this account's copy of the disk key.
    const opened = await opensTo(page, res.body.response.sealed, fx.alice.stkSeedHex);
    expect(opened).toContain(fx.alice.diskKeyHex);
    await shot(page, testInfo, "member-startup-approved");
  });

  test("gym sharing co-manager saves an app's access list, opens members-only apps, refreshes and goes back", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const fx = await fixtures(page);
    const m = await memberRoutes(page, fx);
    m.get(`${SHARED_BOX}/api/screens/services/notes/access`, { access: { list: "allow api.github.com\n", listSha256: "", pending: [] } });
    m.post(`${SHARED_BOX}/api/screens/services/notes/access`, (c) => ({ json: { access: { list: c.body.list, listSha256: c.body.grant.listSha256, pending: [] } } }));
    await openSharedFromHome(page);

    // A members-only app: a co-manager is manager-class there, never told to get an invite.
    const photos = page.locator('[data-shared-app="photos"]');
    await expect(photos.locator("[data-members-only]")).toHaveText("Members only. As a co-manager you can open it.", { timeout: 10_000 });
    await expect(page.locator("#view-shared-server")).not.toContainText("You need an invite");
    await expect(photos.locator("a[href]")).toHaveAttribute("href", `https://photos.${SHARED_BOX}`);

    await page.locator('[data-access-open="notes"]').click();
    const editor = page.locator('[data-access-editor="notes"]');
    await editor.locator("textarea").fill("allow api.github.com\nallow *.example.com\n");
    await editor.locator("[data-access-save]").click();
    await expect(page.locator("#toast")).toContainText("Access list saved", { timeout: 10_000 });
    const post = m.last(`${SHARED_BOX}/api/screens/services/notes/access`)!;
    expect(post.headers["x-flagship-session"]).toBe("fss_gym");
    expect(post.body.list).toContain("allow *.example.com");
    const ok = await page.evaluate(
      async ({ shareId, grant, sig }) => {
        const ks = await import("/keystore.js");
        const { canonicalAppAccessBytes } = await import("/lib/appAccess.js");
        const { getSession } = await import("/lib/state.js");
        const member = await (await import("/lib/serverShare.js")).deriveShareMemberKey(getSession().umk, shareId);
        return ks.verifyWithEd25519Pub(member.publicKey, ks.hexToBytes(sig), canonicalAppAccessBytes(grant));
      },
      { shareId: fx.alice.shareId, grant: post.body.grant, sig: post.body.signature },
    );
    expect(ok).toBe(true);
    await expect(editor.locator("[data-access-save]")).toBeDisabled();
    await shot(page, testInfo, "member-access-saved");

    // Refresh reads the page again; Back returns Home.
    const before = m.sent(`${SHARED_BOX}/api/shares/me`, "GET").length;
    await page.click("#shared-server-refresh");
    await expect.poll(() => m.sent(`${SHARED_BOX}/api/shares/me`, "GET").length).toBeGreaterThan(before);
    await page.click("#shared-server-back");
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
  });

  test("gym sharing co-manager at view level gets no Update or access controls and leaves the server", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin", servers: [HOME] });
    const fx = await fixtures(page);
    const m = await memberRoutes(page, fx, { me: { level: "view", unlockAtBoot: false, canUpdate: true } });
    m.post(`${SHARED_BOX}/api/shares/leave`, { ok: true });
    m.post(`/api/server-shares/${fx.alice.shareId}/leave`, { ok: true });
    await openSharedFromHome(page);
    await expect(page.locator("#shared-server-sub")).toHaveText("Shared with you · Can view", { timeout: 10_000 });
    await expect(page.locator("#shared-release-card")).toHaveCount(0);
    await expect(page.locator("[data-access-open]")).toHaveCount(0);
    await expect(page.locator("#shared-notify-card")).toHaveCount(0);
    await shot(page, testInfo, "member-view-level");

    // Cancel sends nothing.
    await page.click("#shared-leave-btn");
    await expect(page.locator(".modal-title")).toHaveText("Leave this server?");
    await page.click("[data-modal-cancel]");
    expect(m.sent("/leave")).toHaveLength(0);

    await page.click("#shared-leave-btn");
    await page.click("[data-modal-ok]");
    await expect(page.locator("#toast")).toContainText("You left home", { timeout: 10_000 });
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
    const box = m.last(`${SHARED_BOX}/api/shares/leave`)!;
    const com = m.last(`/api/server-shares/${fx.alice.shareId}/leave`)!;
    expect(box.body.leave).toMatchObject({ serverDomain: SHARED_BOX, shareId: fx.alice.shareId, memberPubHex: fx.alice.memberPubHex });
    expect(await memberSigned(page, fx.alice.shareId, "serverShareLeaveCanonicalBytes", box.body.leave, box.body.signature)).toBe(true);
    expect(com.body.signature).toBe(box.body.signature);
    expect(com.headers["x-flagship-share-token"]).toBe(fx.alice.token);
    // The inbox entry goes too.
    await expect.poll(() => m.sent("/api/share-inbox").filter((c) => c.body.request.op === "delete").map((c) => c.body.request.entryId)).toContain(fx.alice.entryId);
  });
});
