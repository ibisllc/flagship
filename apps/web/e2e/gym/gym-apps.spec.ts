/**
 * The app page (docs/service-access-gating.md "Open mode + members",
 * docs/ai-privacy-and-staging.md §3a, docs/app-apis.md §3 + §6,
 * docs/app-placement.md §4-§5) with no backend: Access control and ranks, the
 * app's internet access list, API keys, the Database section and Runs on.
 *
 * Crypto is real: every signed order is signed with this browser's unlocked
 * keys, and each test re-verifies the signature the box would check over the
 * exact canonical bytes. `.com` and the boxes are a single page.route router
 * that records every request; anything it doesn't know is a 404.
 */

import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { freshUnlock, sawToast, watchToasts } from "./gymKit.js";
import { createHash } from "node:crypto";
import { stubAccountReadToken } from "../fixtures/accountRead.js";

const PASSPHRASE = "correct-horse-battery-staple-gym";
const HOME = "home.smoketest.flagship.services";
const MEDIA = "media.smoketest.flagship.services";
const ATTIC = "attic.smoketest.flagship.services";
const SERVICE_ID = "smoketest--notes";

test.use({ viewport: { width: 430, height: 932 } });

async function shot(page: Page, testInfo: TestInfo, point: string): Promise<void> {
  const file = testInfo.outputPath(`gym-screenshot-${point}.png`);
  await page.screenshot({ path: file });
  await testInfo.attach(`gym-screenshot:${point}`, { path: file, contentType: "image/png" });
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

async function reachHome(page: Page): Promise<void> {
  await stubAccountReadToken(page);
  await watchToasts(page);
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
  // The unlock toasts once it has dispatched its view: the sync point.
  await sawToast(page, "Unlocked", 30_000);
  await page.evaluate(
    async ({ HOME, MEDIA }) => {
      const store = await import("/lib/profilesStore.js");
      store.ensureProfile("smoketest");
      store.setActiveCloudName("smoketest");
      store.set("username", "smoketest");
      const { getSession } = await import("/lib/state.js");
      getSession().username = "smoketest";
      const api = await import("/lib/api.js");
      api.setPodBaseUrl(`https://${HOME}`);
      api.setSessionToken("gym-home-token");
      api.setSessionTokenForPod(HOME, "gym-home-token");
      api.setSessionTokenForPod(MEDIA, "gym-media-token");
      (await import("/lib/apex.js")).setApexOverride({ control: "https://flagshipserver.com" });
    },
    { HOME, MEDIA },
  );
}

interface Call {
  method: string;
  url: URL;
  body: any;
  headers: Record<string, string>;
}
type Answer = { status?: number; json: unknown } | { status?: number; raw: Buffer; contentType: string } | null;
type Rule = { method?: string; match: (url: URL) => boolean; answer: (call: Call) => Answer };

/** One router for every foreign request; returns the recorded calls. */
async function stub(page: Page, rules: Rule[]): Promise<Call[]> {
  const calls: Call[] = [];
  await page.route(
    (url) => !url.href.startsWith("http://127.0.0.1"),
    async (route) => {
      const req = route.request();
      let body: unknown = null;
      try {
        body = req.postDataJSON();
      } catch {
        body = null;
      }
      const call: Call = { method: req.method(), url: new URL(req.url()), body, headers: req.headers() };
      calls.push(call);
      for (const rule of rules) {
        if (rule.method && rule.method !== call.method) continue;
        if (!rule.match(call.url)) continue;
        const a = rule.answer(call);
        if (!a) continue;
        if ("raw" in a) {
          await route.fulfill({ status: a.status ?? 200, contentType: a.contentType, body: a.raw });
          return;
        }
        await route.fulfill({ status: a.status ?? 200, contentType: "application/json", body: JSON.stringify(a.json) });
        return;
      }
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "gym: no stub" }) });
    },
  );
  return calls;
}

const on = (host: string, path: string) => (u: URL) => u.host === host && u.pathname === path;
const svc = (sub = "") => `/api/screens/services/${SERVICE_ID}${sub}`;

/** The app-detail answer for notes; `access` is the box's §3a summary. */
function appDetail(access: Record<string, unknown> | null = { rules: 0, pending: 0, draft: false }) {
  return {
    app: {
      serviceId: SERVICE_ID,
      slug: "notes",
      creator: "smoketest",
      summary: "Shared notes for the house",
      status: "running",
      version: "1.2.0",
      url: `https://notes.${HOME}`,
      ...(access ? { access } : {}),
    },
    manifest: { name: "notes", runtime: { base: "node-24" } },
    dataLayerInstances: [],
    members: [],
    editable: false,
  };
}

/** Rules every app-page test needs: the detail read, and quiet 404-free
 *  answers for the sections a test doesn't look at. */
function baseRules(detail: unknown, extra: { apiKeys?: boolean; db?: boolean } = {}): Rule[] {
  const rules: Rule[] = [
    { method: "GET", match: on(HOME, `/api/screens/app-detail/${SERVICE_ID}`), answer: () => ({ json: detail }) },
    { method: "GET", match: (u) => u.pathname.endsWith("/api/users/smoketest/pods"), answer: () => ({ json: { pods: [{ serverDomain: HOME, liveness: "live" }] } }) },
    { method: "GET", match: on(HOME, "/api/screens/apps-list"), answer: () => ({ json: { apps: [{ serviceId: SERVICE_ID, slug: "notes", status: "running" }] } }) },
  ];
  if (!extra.apiKeys) rules.push({ method: "GET", match: on(HOME, svc("/api-keys")), answer: () => ({ status: 404, json: { error: "not found" } }) });
  if (!extra.db) rules.push({ method: "GET", match: on(HOME, svc("/db")), answer: () => ({ status: 404, json: { error: "not found" } }) });
  return rules;
}

async function openApp(page: Page): Promise<void> {
  await page.evaluate(async (id) => {
    const { enterServiceDetail } = await import("/views/service-detail.js");
    await enterServiceDetail(id);
  }, SERVICE_ID);
  await expect(page.locator("#view-service-detail")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#service-detail-content .card-title").first()).toContainText("notes", { timeout: 10_000 });
}

/** Whether `sigHex` is this browser's signature over `canonical`: the
 *  sensitive-order key (admin root when held, else the IRK) or the IRK. */
async function signedBy(page: Page, canonical: string, sigHex: string, key: "sensitive" | "irk" = "sensitive"): Promise<boolean> {
  return page.evaluate(
    async ({ canonical, sigHex, key }) => {
      const ks = await import("/keystore.js");
      const { getSession } = await import("/lib/state.js");
      const s = getSession();
      const pub =
        key === "sensitive" && s.adminRootSeed
          ? ks.hexToBytes(await ks.adminRootPubHex(s.adminRootSeed))
          : (await ks.deriveIrkFromSeed(s.umk)).publicKey;
      return ks.verifyWithEd25519Pub(pub, ks.hexToBytes(sigHex), new TextEncoder().encode(canonical));
    },
    { canonical, sigHex, key },
  );
}

const fresh = (issuedAt: unknown) => typeof issuedAt === "number" && Math.abs(Date.now() - issuedAt) < 5 * 60_000;

const ACCOUNT_ID = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const THIS_DEVICE = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const OTHER_DEVICE = "f0e1d2c3b4a5968778695a4b3c2d1e0f";
const GONE_DEVICE = "00112233445566778899aabbccddeeff";

/** Give this browser an account device id; `admin` decides whether it holds the admin root. */
async function asDevice(page: Page, { admin }: { admin: boolean }): Promise<void> {
  await page.evaluate(
    async ({ accountId, deviceId, admin, passphrase }) => {
      const profiles = await import("/lib/profiles.js");
      const store = await import("/lib/profilesStore.js");
      const { getSession } = await import("/lib/state.js");
      // The account's profile holds this device's key under its passphrase,
      // as opening an account leaves it, so a fresh unlock finds it.
      await (await import("/keystore.js")).persistSeedForProfile(getSession().umk, "smoketest", passphrase);
      profiles.addProfile({ cloudName: "smoketest", accountId, deviceId });
      store.ensureProfile("smoketest");
      store.setActiveCloudName("smoketest");
      store.set("username", "smoketest");
      const session = getSession();
      session.username = "smoketest";
      session.adminRootSeed = admin ? crypto.getRandomValues(new Uint8Array(32)) : null;
    },
    { accountId: ACCOUNT_ID, deviceId: THIS_DEVICE, admin, passphrase: PASSPHRASE },
  );
}

/** This browser's account device key (public, hex): how the box's Account members names it. */
async function thisDevicePub(page: Page): Promise<string> {
  return page.evaluate(
    async ({ accountId, deviceId }) => {
      const ks = await import("/keystore.js");
      const { getSession } = await import("/lib/state.js");
      return ks.bytesToHex((await ks.deriveAccountDeviceKeyFromSeed(getSession().umk, accountId, deviceId)).publicKey);
    },
    { accountId: ACCOUNT_ID, deviceId: THIS_DEVICE },
  );
}

/** Whether `sigHex` over `canonical` is this browser's account device key. */
async function signedByDevice(page: Page, canonical: string, sigHex: string): Promise<boolean> {
  return page.evaluate(
    async ({ canonical, sigHex, accountId, deviceId }) => {
      const ks = await import("/keystore.js");
      const { getSession } = await import("/lib/state.js");
      const key = await ks.deriveAccountDeviceKeyFromSeed(getSession().umk, accountId, deviceId);
      return ks.verifyWithEd25519Pub(key.publicKey, ks.hexToBytes(sigHex), new TextEncoder().encode(canonical));
    },
    { canonical, sigHex, accountId: ACCOUNT_ID, deviceId: THIS_DEVICE },
  );
}

const PHONE_PUB = "2b".repeat(32);
const MUM_SHARE = "0123456789abcdef0123456789abcdef";

/** The box's Account members: this browser (its tier and rank), the phone (admin, Master) and Mum (co-manager). */
function accountMembers(myPub: string, me: { tier: "admin" | "member"; rank: string | null; refused?: boolean }) {
  return [
    { kind: "device", deviceId: THIS_DEVICE, devicePub: myPub, tier: me.tier, rank: me.rank, set: false, refused: me.refused === true },
    { kind: "device", deviceId: OTHER_DEVICE, devicePub: PHONE_PUB, tier: "admin", rank: "master", set: false, refused: false },
    { kind: "co-manager", shareId: MUM_SHARE, label: "Mum", rank: "manager", set: false, refused: false },
  ];
}

/** Invite bundles sealed under this account's household key, by inviteId. */
async function sealBundles(page: Page, names: Record<string, string>): Promise<Record<string, string>> {
  return page.evaluate(async (names) => {
    const ks = await import("/keystore.js");
    const si = await import("/lib/serviceInvite.js");
    const { getSession } = await import("/lib/state.js");
    const hk = await ks.deriveHouseholdKeyFromSeed(getSession().umk);
    const out: Record<string, string> = {};
    for (const [id, name] of Object.entries(names)) out[id] = await si.sealInviteBundle({ name }, hk, id);
    return out;
  }, names);
}

test.describe("gym webapp apps", () => {
  test("gym apps access control goes members-only and sets a rank with signed orders", async ({ page }, testInfo) => {
    await reachHome(page);
    // Only an admin device changes ranks and the mode; each order is signed with its admin root.
    await asDevice(page, { admin: true });
    const myPub = await thisDevicePub(page);
    const SAM_AID = "5a".repeat(32);
    const invites = await page.evaluate(async () => {
      const ks = await import("/keystore.js");
      const si = await import("/lib/serviceInvite.js");
      const { getSession } = await import("/lib/state.js");
      const hk = await ks.deriveHouseholdKeyFromSeed(getSession().umk);
      return {
        sam: await si.sealInviteBundle({ name: "Sam" }, hk, "inv-sam"),
        chess: await si.sealInviteBundle({ name: "Chess club" }, hk, "inv-chess"),
      };
    });
    let samRole = "member";
    let mode = "open";
    const members = () => ({
      mode,
      roles: ["member", "manager", "master"],
      defaultRole: "member",
      descriptions: { member: "Reads notes", manager: "Edits notes", master: "Manages who's in" },
      accountMembers: accountMembers(myPub, { tier: "admin", rank: "master" }),
      members: [{ aid: SAM_AID, role: samRole, grants: [{ inviteId: "inv-sam", role: samRole }], direct: false }],
      invites: [
        { inviteId: "inv-sam", role: samRole, set: samRole !== "member" },
        { inviteId: "inv-chess", role: "manager", set: true },
      ],
    });
    const calls = await stub(page, [
      ...baseRules(appDetail()),
      {
        method: "GET",
        match: (u) => u.pathname === "/api/users/smoketest/service-invites",
        answer: () => ({
          json: {
            invites: [
              { inviteId: "inv-sam", serviceRef: SERVICE_ID, encryptedBundle: invites.sam, boundAID: SAM_AID, boundAt: Date.now() - 86_400_000, createdAt: Date.now() - 2 * 86_400_000, approvalMode: "auto" },
              { inviteId: "inv-chess", serviceRef: SERVICE_ID, encryptedBundle: invites.chess, createdAt: Date.now() - 86_400_000, maxRedemptions: 10, redemptions: 3, boundAIDs: [], approvalMode: "auto" },
            ],
          },
        }),
      },
      { method: "GET", match: on(HOME, svc("/members")), answer: () => ({ json: members() }) },
      {
        method: "POST",
        match: on(HOME, "/api/service-access"),
        answer: (c) => {
          mode = c.body.request.mode;
          return { json: { ok: true, mode } };
        },
      },
      {
        method: "POST",
        match: on(HOME, svc("/members/rank")),
        answer: (c) => {
          samRole = c.body.order.rank;
          return { json: { ok: true, target: c.body.order.target, rank: samRole } };
        },
      },
    ]);
    await openApp(page);
    await page.click("#sd-access");
    await expect(page.locator("#view-service-access")).toBeVisible({ timeout: 10_000 });

    // Both modes keep the same list: two invites, each with its rank.
    await expect(page.locator("#sa-members-title")).toHaveText("Members (2)", { timeout: 10_000 });
    const sam = page.locator("#sa-people .card", { hasText: "Sam" });
    const chess = page.locator("#sa-people .card", { hasText: "Chess club" });
    await expect(sam).toContainText("active");
    await expect(sam.locator('select[data-action="sa-role"]')).toHaveValue("member");
    await expect(chess).toContainText("3 of 10 joined");
    await expect(chess.locator('select[data-action="sa-role"]')).toHaveValue("manager");
    await expect(chess.locator('[data-action="sa-remove"]')).toHaveText("Revoke");
    await expect(page.locator('#sa-mode [data-mode="open"]')).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#sa-mode-status")).toHaveText("Anyone can open it. Members who sign in get their rank.");
    await shot(page, testInfo, "access-control-open");

    // Members only asks once, saying how many people that leaves in.
    await page.click('#sa-mode [data-mode="restricted"]');
    await expect(page.locator(".modal-title")).toHaveText("Members only?");
    await expect(page.locator(".modal-message")).toHaveText("Only this 1 person will be able to open it.");
    await page.click("[data-modal-ok]");
    await expect(page.locator("#sa-mode-status")).toHaveText("Only members and you can open it. Anyone else is asked to sign in.", { timeout: 10_000 });
    await expect(page.locator('#sa-mode [data-mode="restricted"]')).toHaveAttribute("aria-checked", "true");
    const modeCall = calls.find((c) => c.method === "POST" && c.url.pathname === "/api/service-access");
    expect(modeCall).toBeTruthy();
    const req = modeCall!.body.request;
    // v2 names the app only (no serverId), signed with the admin root.
    expect(req).toEqual({ serviceRef: SERVICE_ID, mode: "restricted", issuedAt: req.issuedAt });
    expect(fresh(req.issuedAt)).toBe(true);
    expect(
      await signedBy(page, ["flagship/service-access-mode/v2", req.serviceRef, req.mode, req.issuedAt].join("|"), modeCall!.body.signature),
    ).toBe(true);

    // Raising Sam to Master signs flagship/app-rank/v1 for their invite.
    await sam.locator('select[data-action="sa-role"]').selectOption("master");
    await freshUnlock(page, "Make Sam Master?");
    await expect(sam.locator(".sa-crown")).toBeVisible({ timeout: 10_000 });
    await expect(sam.locator('select[data-action="sa-role"]')).toHaveValue("master");
    const roleCall = calls.find((c) => c.method === "POST" && c.url.pathname === svc("/members/rank"));
    expect(roleCall).toBeTruthy();
    const order = roleCall!.body.order;
    expect(order).toEqual({ serviceRef: SERVICE_ID, target: "invite:inv-sam", rank: "master", issuedAt: order.issuedAt });
    expect(fresh(order.issuedAt)).toBe(true);
    expect(
      await signedBy(page, ["flagship/app-rank/v1", order.serviceRef, order.target, order.rank, order.issuedAt].join("|"), roleCall!.body.signature),
    ).toBe(true);
    expect(calls.some((c) => c.url.pathname === svc("/members/role"))).toBe(false);
    // The box session rides every box call; the members list itself was never changed by the mode switch.
    expect(roleCall!.headers["x-flagship-session"]).toBe("gym-home-token");
    await expect(page.locator("#sa-members-title")).toHaveText("Members (2)");
    await shot(page, testInfo, "access-control-ranks");
  });

  test("gym apps rank picker is locked to Member on a non-admin device", async ({ page }, testInfo) => {
    await reachHome(page);
    await asDevice(page, { admin: false });
    const myPub = await thisDevicePub(page);
    const sealed = await sealBundles(page, { "inv-sam": "Sam", "inv-lee": "Lee" });
    const members = {
      mode: "open",
      roles: ["member", "manager", "master"],
      defaultRole: "member",
      descriptions: {},
      // This device is a Manager in the app (the default for a non-admin device).
      accountMembers: accountMembers(myPub, { tier: "member", rank: "manager" }),
      members: [],
      invites: [
        { inviteId: "inv-sam", role: "master", set: true, tier: "admin", creatorPub: PHONE_PUB, creatorDeviceId: OTHER_DEVICE },
        { inviteId: "inv-lee", role: "member", set: false, tier: "member", creatorPub: myPub, creatorDeviceId: THIS_DEVICE },
      ],
    };
    const calls = await stub(page, [
      ...baseRules(appDetail()),
      {
        method: "GET",
        match: (u) => u.pathname === "/api/users/smoketest/service-invites",
        answer: () => ({
          json: {
            invites: [
              { inviteId: "inv-sam", serviceRef: SERVICE_ID, encryptedBundle: sealed["inv-sam"], createdAt: Date.now() - 86_400_000, approvalMode: "auto", creatorTier: "admin", creatorDeviceId: OTHER_DEVICE },
              { inviteId: "inv-lee", serviceRef: SERVICE_ID, encryptedBundle: sealed["inv-lee"], createdAt: Date.now() - 3_600_000, approvalMode: "auto", creatorTier: "member", creatorDeviceId: THIS_DEVICE },
            ],
          },
        }),
      },
      // A device without view-directory can't read the account directory.
      { method: "GET", match: (u) => u.pathname === `/api/accounts/${ACCOUNT_ID}/directory`, answer: () => ({ status: 403, json: { error: "forbidden" } }) },
      { method: "GET", match: on(HOME, svc("/members")), answer: () => ({ json: members }) },
      {
        method: "POST",
        match: (u) => u.pathname === "/api/users/smoketest/service-invites",
        answer: (c) => ({ json: { created: true, inviteId: c.body.request.inviteId, tier: "member" } }),
      },
      { method: "POST", match: (u) => u.pathname === "/api/users/smoketest/service-invites/revoke", answer: () => ({ json: { revoked: true } }) },
      { method: "POST", match: on(HOME, "/api/service-access/invite-withdraw"), answer: () => ({ json: { ok: true, pruned: 0 } }) },
    ]);
    await openApp(page);
    // No admin root: no Remove app, and Runs on is locked.
    await expect(page.locator("#service-detail-remove-btn")).toHaveCount(0);
    await expect(page.locator("#sd-runs-on-card")).toContainText("Only an admin device can change where this app runs.");
    await expect(page.locator("[data-remove-app-locked]")).toHaveText("Only an admin device can remove an app.");
    await page.click("#sd-access");
    await expect(page.locator("#sa-members-title")).toHaveText("Members (2)", { timeout: 10_000 });

    // Account members are read-only here; this device is a Manager.
    const mine = page.locator("#sa-account-people .card", { hasText: "This device" });
    await expect(mine.locator(".sa-rank")).toHaveText("Manager");
    await expect(page.locator('select[data-action="sa-acct-rank"]')).toHaveCount(0);
    await expect(page.locator('[data-action="sa-acct-refuse"]')).toHaveCount(0);
    // The mode is an admin's call.
    await expect(page.locator('#sa-mode [data-mode="restricted"]')).toBeDisabled();
    await expect(page.locator("#sa-mode-locked")).toHaveText("Only an admin device can change who can open it.");

    // Ranks are read-only here; only this device's own member invite can be withdrawn.
    const sam = page.locator("#sa-people .card", { hasText: "Sam" });
    const lee = page.locator("#sa-people .card", { hasText: "Lee" });
    await expect(page.locator('select[data-action="sa-role"]')).toHaveCount(0);
    await expect(sam.locator(".sa-rank")).toHaveText("Master");
    await expect(sam.locator('[data-action="sa-remove"]')).toHaveCount(0);
    await expect(sam.locator(".sa-invited-by")).toHaveText("Invited by another device");
    await expect(lee.locator('[data-action="sa-remove"]')).toHaveText("Remove");
    await expect(lee.locator(".sa-invited-by")).toHaveText("Invited by this device");

    // A new invite can only be Member, and says why.
    await page.click("#sa-add-person");
    await expect(page.locator("#sa-new-role")).toBeDisabled();
    await expect(page.locator("#sa-new-role")).toHaveValue("member");
    await expect(page.locator("#sa-new-role option")).toHaveCount(1);
    await expect(page.locator("#sa-rank-locked")).toHaveText("Only an admin device can give a higher rank");
    await shot(page, testInfo, "rank-locked");

    await page.fill("#sa-name", "Robin");
    await page.click("#sa-add-go");
    await expect(page.locator("#sa-add-status")).toHaveText("Invite for Robin created.", { timeout: 10_000 });
    const create = calls.find((c) => c.method === "POST" && c.url.pathname === "/api/users/smoketest/service-invites");
    expect(create).toBeTruthy();
    const req = create!.body.request;
    expect(req.deviceId).toBe(THIS_DEVICE);
    expect(fresh(req.issuedAt)).toBe(true);
    // Signed with this device's account device key (member tier), never the AID or an admin key.
    const verifyCreate = (key: "device" | "aid") =>
      page.evaluate(
        async ({ req, sig, key, accountId, deviceId }) => {
          const ks = await import("/keystore.js");
          const si = await import("/lib/serviceInvite.js");
          const { getSession } = await import("/lib/state.js");
          const umk = getSession().umk;
          const pub = key === "device"
            ? (await ks.deriveAccountDeviceKeyFromSeed(umk, accountId, deviceId)).publicKey
            : (await ks.deriveAccountIdFromSeed(umk)).publicKey;
          const bytes = si.canonicalCreateBytes({ ...req, authorAID: ks.hexToBytes(req.authorAID) });
          return ks.verifyWithEd25519Pub(pub, ks.hexToBytes(sig), bytes);
        },
        { req, sig: create!.body.signature, key, accountId: ACCOUNT_ID, deviceId: THIS_DEVICE },
      );
    expect(await verifyCreate("device")).toBe(true);
    expect(await verifyCreate("aid")).toBe(false);
    // Member needs no rank order.
    expect(calls.some((c) => c.method === "POST" && /\/members\/(role|rank)$/.test(c.url.pathname))).toBe(false);
    await shot(page, testInfo, "member-invite-created");

    // Withdrawing its own invite: the device-key-signed revoke goes to .com and to the box.
    await lee.locator('[data-action="sa-remove"]').click();
    await page.click("[data-modal-ok]");
    await expect(page.locator("#toast")).toContainText("Removed.", { timeout: 10_000 });
    const revoke = calls.find((c) => c.method === "POST" && c.url.pathname === "/api/users/smoketest/service-invites/revoke")!;
    const r = revoke.body.request;
    expect(r.inviteId).toBe("inv-lee");
    expect(await signedByDevice(page, ["flagship/service-invite/revoke/v1", r.inviteId, r.issuedAt].join("|"), revoke.body.signature)).toBe(true);
    const withdraw = calls.find((c) => c.method === "POST" && c.url.host === HOME && c.url.pathname === "/api/service-access/invite-withdraw")!;
    expect(withdraw.body).toEqual({ revoke: r, signature: revoke.body.signature });
    expect(calls.some((c) => c.url.pathname === "/api/service-access/allow-remove")).toBe(false);
  });

  test("gym apps account members list each device and co-manager, and an admin changes a rank and refuses", async ({ page }, testInfo) => {
    await reachHome(page);
    await asDevice(page, { admin: true });
    const myPub = await thisDevicePub(page);
    const phoneProfile = await page.evaluate(
      async ({ accountId, deviceId }) => {
        const meta = await import("/lib/accountMetadata.js");
        const { getSession } = await import("/lib/state.js");
        const fields = { accountId, recordType: "device-self-profile", deviceId, revision: 1, keyVersion: 1 };
        const sealed = await meta.encryptProfile("Kitchen iPad", await meta.deriveDeviceDirectoryKey(getSession().umk), fields);
        return { accountId, deviceId, revision: 1, keyVersion: 1, ...sealed };
      },
      { accountId: ACCOUNT_ID, deviceId: OTHER_DEVICE },
    );
    const ranks: Record<string, { rank: string | null; refused: boolean }> = {
      [`device:${PHONE_PUB}`]: { rank: "master", refused: false },
      [`share:${MUM_SHARE}`]: { rank: "manager", refused: false },
    };
    const members = () => ({
      mode: "open",
      roles: ["member", "manager", "master"],
      defaultRole: "member",
      descriptions: {},
      accountMembers: accountMembers(myPub, { tier: "admin", rank: "master" }).map((m) => {
        const key = m.kind === "co-manager" ? `share:${m.shareId}` : `device:${m.devicePub}`;
        return ranks[key] ? { ...m, ...ranks[key], set: true } : m;
      }),
      members: [],
      invites: [],
    });
    const calls = await stub(page, [
      ...baseRules(appDetail()),
      { method: "GET", match: (u) => u.pathname === "/api/users/smoketest/service-invites", answer: () => ({ json: { invites: [] } }) },
      {
        method: "GET",
        match: (u) => u.pathname === `/api/accounts/${ACCOUNT_ID}/directory`,
        answer: () => ({
          json: {
            accountId: ACCOUNT_ID,
            devices: [
              { deviceId: THIS_DEVICE, platformClass: "web", createdAt: Date.now() - 3_600_000 },
              { deviceId: OTHER_DEVICE, platformClass: "ios", createdAt: Date.now() - 86_400_000 },
            ],
            selfProfiles: [phoneProfile],
            managedProfiles: [],
            grants: [],
          },
        }),
      },
      { method: "GET", match: on(HOME, svc("/members")), answer: () => ({ json: members() }) },
      {
        method: "POST",
        match: on(HOME, svc("/members/rank")),
        answer: (c) => {
          const { target, rank } = c.body.order;
          ranks[target] = rank === "refused" ? { rank: null, refused: true } : { rank, refused: false };
          return { json: { ok: true, target, rank } };
        },
      },
    ]);
    await openApp(page);
    await expect(page.locator("#service-detail-remove-btn")).toBeVisible();
    await page.click("#sd-access");
    const row = (name: string) => page.locator("#sa-account-people .card", { hasText: name });
    await expect(row("Kitchen iPad")).toBeVisible({ timeout: 10_000 });
    await expect(row("Kitchen iPad")).toContainText("Admin device");
    await expect(row("Kitchen iPad").locator(".sa-crown")).toBeVisible();
    await expect(row("This device")).toContainText("Device a1b2c3d4");
    await expect(row("Mum")).toContainText("Co-manages this server");
    await expect(row("Mum").locator('select[data-action="sa-acct-rank"]')).toHaveValue("manager");
    // Only the three ranks, never an owner.
    await expect(row("Mum").locator("option")).toHaveText(["Member", "Manager", "Master"]);
    await expect(page.locator("#sa-add-person")).toBeVisible();
    await shot(page, testInfo, "account-members-admin");

    // Demote the phone to Member: one admin-root order naming the device key.
    await row("Kitchen iPad").locator('select[data-action="sa-acct-rank"]').selectOption("member");
    await freshUnlock(page, "Make Kitchen iPad Member?");
    await expect(row("Kitchen iPad").locator('select[data-action="sa-acct-rank"]')).toHaveValue("member", { timeout: 10_000 });
    await expect.poll(() => calls.filter((c) => c.method === "POST" && c.url.pathname === svc("/members/rank")).length).toBe(1);
    const demote = calls.find((c) => c.method === "POST" && c.url.pathname === svc("/members/rank"))!;
    const o1 = demote.body.order;
    expect(o1).toEqual({ serviceRef: SERVICE_ID, target: `device:${PHONE_PUB}`, rank: "member", issuedAt: o1.issuedAt });
    expect(fresh(o1.issuedAt)).toBe(true);
    expect(await signedBy(page, ["flagship/app-rank/v1", o1.serviceRef, o1.target, o1.rank, o1.issuedAt].join("|"), demote.body.signature)).toBe(true);

    // Refuse Mum (co-manager), then let her back in at Manager.
    await row("Mum").locator('[data-action="sa-acct-refuse"]').click();
    await expect(page.locator(".modal-title")).toHaveText("Refuse Mum?");
    await page.click("[data-modal-ok]");
    await expect(row("Mum").locator('select[data-action="sa-acct-rank"]')).toHaveValue("refused", { timeout: 10_000 });
    await expect(row("Mum").locator('[data-action="sa-acct-refuse"]')).toHaveCount(0);
    const refuse = calls.filter((c) => c.method === "POST" && c.url.pathname === svc("/members/rank"))[1]!;
    const o2 = refuse.body.order;
    expect(o2).toMatchObject({ serviceRef: SERVICE_ID, target: `share:${MUM_SHARE}`, rank: "refused" });
    expect(await signedBy(page, ["flagship/app-rank/v1", o2.serviceRef, o2.target, o2.rank, o2.issuedAt].join("|"), refuse.body.signature)).toBe(true);
    await shot(page, testInfo, "account-members-refused");

    await row("Mum").locator('select[data-action="sa-acct-rank"]').selectOption("manager");
    await freshUnlock(page, "Make Mum Manager?");
    await expect(row("Mum").locator('select[data-action="sa-acct-rank"]')).toHaveValue("manager", { timeout: 10_000 });
    await expect(row("Mum").locator('[data-action="sa-acct-refuse"]')).toHaveCount(1);
    const back = calls.filter((c) => c.method === "POST" && c.url.pathname === svc("/members/rank"))[2]!;
    expect(back.body.order).toMatchObject({ target: `share:${MUM_SHARE}`, rank: "manager" });
  });

  test("gym apps a member-rank device sees why it can't invite", async ({ page }, testInfo) => {
    await reachHome(page);
    await asDevice(page, { admin: false });
    const myPub = await thisDevicePub(page);
    await stub(page, [
      ...baseRules(appDetail()),
      { method: "GET", match: (u) => u.pathname === "/api/users/smoketest/service-invites", answer: () => ({ json: { invites: [] } }) },
      { method: "GET", match: (u) => u.pathname === `/api/accounts/${ACCOUNT_ID}/directory`, answer: () => ({ status: 403, json: { error: "forbidden" } }) },
      {
        method: "GET",
        match: on(HOME, svc("/members")),
        answer: () => ({
          json: {
            mode: "open",
            roles: ["member", "manager", "master"],
            defaultRole: "member",
            descriptions: {},
            accountMembers: accountMembers(myPub, { tier: "member", rank: "member" }),
            members: [],
            invites: [],
          },
        }),
      },
    ]);
    await openApp(page);
    await page.click("#sd-access");
    await expect(page.locator("#sa-add-why")).toHaveText("Only an admin can let you invite people to this app.", { timeout: 10_000 });
    await expect(page.locator("#sa-add-person")).toBeHidden();
    await expect(page.locator("#sa-add-group")).toBeHidden();
    await expect(page.locator("#sa-account-people .card", { hasText: "This device" }).locator(".sa-rank")).toHaveText("Member");
    await shot(page, testInfo, "member-cant-invite");
  });

  test("gym apps members list shows who invited each person", async ({ page }, testInfo) => {
    await reachHome(page);
    await asDevice(page, { admin: true });
    const sealed = await sealBundles(page, { "inv-sam": "Sam", "inv-lee": "Lee", "inv-kim": "Kim", "inv-old": "Old friend" });
    const phoneProfile = await page.evaluate(
      async ({ accountId, deviceId }) => {
        const meta = await import("/lib/accountMetadata.js");
        const { getSession } = await import("/lib/state.js");
        const fields = { accountId, recordType: "device-self-profile", deviceId, revision: 1, keyVersion: 1 };
        const sealed = await meta.encryptProfile("Kitchen iPad", await meta.deriveDeviceDirectoryKey(getSession().umk), fields);
        return { accountId, deviceId, revision: 1, keyVersion: 1, ...sealed };
      },
      { accountId: ACCOUNT_ID, deviceId: OTHER_DEVICE },
    );
    let invites = [
      { inviteId: "inv-sam", serviceRef: SERVICE_ID, encryptedBundle: sealed["inv-sam"], createdAt: Date.now() - 86_400_000, approvalMode: "auto", creatorTier: "member", creatorDeviceId: OTHER_DEVICE },
      { inviteId: "inv-lee", serviceRef: SERVICE_ID, encryptedBundle: sealed["inv-lee"], createdAt: Date.now() - 86_400_000, approvalMode: "auto", creatorTier: "admin", creatorDeviceId: THIS_DEVICE },
      { inviteId: "inv-kim", serviceRef: SERVICE_ID, encryptedBundle: sealed["inv-kim"], createdAt: Date.now() - 86_400_000, approvalMode: "auto", creatorTier: "admin", creatorDeviceId: GONE_DEVICE },
      { inviteId: "inv-old", serviceRef: SERVICE_ID, encryptedBundle: sealed["inv-old"], createdAt: Date.now() - 86_400_000, approvalMode: "auto" },
    ];
    let directoryReads = 0;
    const calls = await stub(page, [
      ...baseRules(appDetail()),
      { method: "GET", match: (u) => u.pathname === "/api/users/smoketest/service-invites", answer: () => ({ json: { invites } }) },
      {
        method: "GET",
        match: (u) => u.pathname === `/api/accounts/${ACCOUNT_ID}/directory`,
        answer: () => {
          directoryReads += 1;
          return {
            json: {
              accountId: ACCOUNT_ID,
              devices: [
                { deviceId: THIS_DEVICE, platformClass: "web", createdAt: Date.now() - 3_600_000 },
                { deviceId: OTHER_DEVICE, platformClass: "ios", createdAt: Date.now() - 86_400_000 },
              ],
              selfProfiles: [phoneProfile],
              managedProfiles: [],
              grants: [],
            },
          };
        },
      },
      {
        method: "GET",
        match: on(HOME, svc("/members")),
        answer: () => ({
          json: {
            mode: "open",
            roles: ["member", "manager", "master"],
            defaultRole: "member",
            descriptions: {},
            members: [],
            invites: invites.map((i) => ({ inviteId: i.inviteId, role: "member", set: false, tier: i.creatorTier ?? null })),
          },
        }),
      },
      {
        method: "POST",
        match: (u) => u.pathname === "/api/users/smoketest/service-invites/revoke",
        answer: (c) => {
          invites = invites.filter((i) => i.inviteId !== c.body.request.inviteId);
          return { json: { revoked: true } };
        },
      },
      { method: "POST", match: on(HOME, "/api/service-access/invite-withdraw"), answer: () => ({ json: { ok: true, pruned: 0 } }) },
    ]);
    await openApp(page);
    await page.click("#sd-access");
    await expect(page.locator("#sa-members-title")).toHaveText("Members (4)", { timeout: 10_000 });
    const row = (name: string) => page.locator("#sa-people .card", { hasText: name });
    await expect(row("Sam").locator(".sa-invited-by")).toHaveText("Invited by Kitchen iPad");
    await expect(row("Lee").locator(".sa-invited-by")).toHaveText("Invited by this device");
    await expect(row("Kim").locator(".sa-invited-by")).toHaveText("Invited by another device");
    await expect(row("Old friend").locator(".sa-invited-by")).toHaveCount(0);
    // An admin device changes ranks and can revoke every row.
    await expect(page.locator('select[data-action="sa-role"]')).toHaveCount(4);
    await expect(page.locator('[data-action="sa-remove"]')).toHaveCount(4);
    await shot(page, testInfo, "invited-by");

    await row("Sam").locator('[data-action="sa-remove"]').click();
    await page.click("[data-modal-ok]");
    await expect(page.locator("#sa-members-title")).toHaveText("Members (3)", { timeout: 10_000 });
    const revoke = calls.find((c) => c.method === "POST" && c.url.pathname === "/api/users/smoketest/service-invites/revoke");
    expect(revoke).toBeTruthy();
    const r = revoke!.body.request;
    expect(r.inviteId).toBe("inv-sam");
    expect(await signedBy(page, ["flagship/service-invite/revoke/v1", r.inviteId, r.issuedAt].join("|"), revoke!.body.signature)).toBe(true);
    // The same signed revoke goes to the box, which prunes who joined through it.
    const withdraw = calls.find((c) => c.method === "POST" && c.url.pathname === "/api/service-access/invite-withdraw");
    expect(withdraw?.body).toEqual({ revoke: r, signature: revoke!.body.signature });
    // The directory is read once, however often the list redraws.
    expect(directoryReads).toBe(1);
    await shot(page, testInfo, "invite-revoked");
  });

  test("gym apps internet access requests are allowed and denied with a signed access list", async ({ page }, testInfo) => {
    await reachHome(page);
    // An admin-pinned box takes this order only under the admin root (lib/addServerGate.js canSignAdminOrders).
    await asDevice(page, { admin: true });
    let list = "allow api.github.com\n";
    let pending = [
      { host: "api.openai.com", source: "attempt", attempts: 3, firstSeen: Date.now() - 60_000, lastSeen: Date.now() },
      { host: "tracker.example.com", source: "app", attempts: 0 },
    ];
    const state = () => ({ access: { list, listSha256: sha256(list), pending, draft: null } });
    const calls = await stub(page, [
      ...baseRules(appDetail({ rules: 1, pending: 2, draft: false })),
      { method: "GET", match: on(HOME, svc("/access")), answer: () => ({ json: state() }) },
      {
        method: "POST",
        match: on(HOME, svc("/access")),
        answer: (c) => {
          list = c.body.list;
          const decided = new Set(list.split("\n").map((l: string) => l.split(" ")[1]));
          pending = pending.filter((p) => !decided.has(p.host));
          return { json: state() };
        },
      },
    ]);
    await openApp(page);
    const section = page.locator("#sd-egress");
    await expect(section.locator("#sd-access-count")).toHaveText("1 rule", { timeout: 10_000 });
    const openai = section.locator('[data-access-host="api.openai.com"]');
    const tracker = section.locator('[data-access-host="tracker.example.com"]');
    await expect(openai).toContainText("It tried to connect 3 times.");
    await expect(tracker).toContainText("It asked for this when it was installed.");
    await shot(page, testInfo, "access-requests");

    await openai.locator('[data-access-act="allow"]').click();
    await expect(page.locator("#toast")).toContainText("notes can now reach api.openai.com", { timeout: 10_000 });
    await expect(section.locator('[data-access-host="api.openai.com"]')).toHaveCount(0);
    await expect(section.locator("#sd-access-count")).toHaveText("2 rules");
    const allow = calls.filter((c) => c.method === "POST" && c.url.pathname === svc("/access"))[0]!;
    expect(allow.body.list).toBe("allow api.openai.com\nallow api.github.com\n");
    const g1 = allow.body.grant;
    expect(g1).toMatchObject({ serverDomain: HOME, serviceId: SERVICE_ID, listSha256: sha256(allow.body.list) });
    expect(fresh(g1.issuedAt)).toBe(true);
    expect(await signedBy(page, ["flagship/app-access/v1", g1.serverDomain, g1.serviceId, g1.listSha256, g1.issuedAt].join("|"), allow.body.signature)).toBe(true);

    await section.locator('[data-access-host="tracker.example.com"] [data-access-act="deny"]').click();
    await expect(page.locator("#toast")).toContainText("notes won't reach tracker.example.com", { timeout: 10_000 });
    await expect(section.locator("[data-access-host]")).toHaveCount(0);
    await expect(section.locator("#sd-access-count")).toHaveText("3 rules");
    const deny = calls.filter((c) => c.method === "POST" && c.url.pathname === svc("/access"))[1]!;
    expect(deny.body.list).toBe("deny tracker.example.com\nallow api.openai.com\nallow api.github.com\n");
    const g2 = deny.body.grant;
    expect(g2.listSha256).toBe(sha256(deny.body.list));
    expect(await signedBy(page, ["flagship/app-access/v1", g2.serverDomain, g2.serviceId, g2.listSha256, g2.issuedAt].join("|"), deny.body.signature)).toBe(true);
    await shot(page, testInfo, "access-answered");
  });

  test("gym apps access list editor reviews a suggested list, flags bad lines and saves it signed", async ({ page }, testInfo) => {
    await reachHome(page);
    // An admin-pinned box takes this order only under the admin root (lib/addServerGate.js canSignAdminOrders).
    await asDevice(page, { admin: true });
    let list = "# Uncomment the following line to allow all hosts\n#allow all\n";
    const draftList = "allow api.stripe.com\nallow *.tiles.example.com\n";
    let draft: unknown = {
      list: draftList,
      listSha256: sha256(draftList),
      hosts: [
        { host: "api.stripe.com", why: "Takes payments for the bake sale" },
        { host: "*.tiles.example.com", why: "Map tiles" },
      ],
      createdAt: Date.now() - 60_000,
    };
    const state = () => ({ access: { list, listSha256: sha256(list), pending: [], draft } });
    const calls = await stub(page, [
      ...baseRules(appDetail({ rules: 0, pending: 0, draft: true })),
      { method: "GET", match: on(HOME, svc("/access")), answer: () => ({ json: state() }) },
      {
        method: "POST",
        match: on(HOME, svc("/access")),
        answer: (c) => {
          list = c.body.list;
          draft = null;
          return { json: state() };
        },
      },
    ]);
    await openApp(page);
    const card = page.locator("#sd-egress [data-access-draft]");
    await expect(card).toContainText("This app suggests letting it reach these hosts", { timeout: 10_000 });
    await expect(card).toContainText("Takes payments for the bake sale");
    await expect(page.locator("#sd-access-count")).toHaveText("No rules: this app can't reach the internet.");
    await shot(page, testInfo, "access-draft-card");

    await card.locator('[data-access-draft-act="review"]').click();
    await expect(page.locator("#view-app-access")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("[data-access-draft-note]")).toBeVisible();
    const editor = page.locator("#app-access-text");
    await expect(editor).toHaveValue(draftList);
    await expect(page.locator("#app-access-count")).toHaveText("2 rules");
    await expect(page.locator("#app-access-save")).toBeEnabled();

    // A bad line is flagged by its number and Save goes off.
    await editor.fill(`${draftList}allow https://evil.example.com/x\n`);
    await expect(page.locator("#app-access-errors")).toContainText("Line 3: write the host only, without http:// or https://");
    await expect(page.locator("#app-access-save")).toBeDisabled();
    await shot(page, testInfo, "access-editor-error");

    await editor.fill(`${draftList}deny ads.example.com   \n\n`);
    await expect(page.locator("#app-access-errors")).toBeEmpty();
    await expect(page.locator("#app-access-count")).toHaveText("3 rules");
    await page.click("#app-access-save");
    await expect(page.locator("#toast")).toContainText("Access list saved", { timeout: 10_000 });
    await expect(page.locator("[data-access-draft-note]")).toHaveCount(0);
    const save = calls.find((c) => c.method === "POST" && c.url.pathname === svc("/access"))!;
    // The normalized list is what's hashed and signed.
    expect(save.body.list).toBe(`${draftList}deny ads.example.com\n`);
    const g = save.body.grant;
    expect(g).toMatchObject({ serverDomain: HOME, serviceId: SERVICE_ID, listSha256: sha256(save.body.list) });
    expect(await signedBy(page, ["flagship/app-access/v1", g.serverDomain, g.serviceId, g.listSha256, g.issuedAt].join("|"), save.body.signature)).toBe(true);
    await expect(editor).toHaveValue(save.body.list);
    await expect(page.locator("#app-access-save")).toBeDisabled();
    await shot(page, testInfo, "access-editor-saved");
  });

  test("gym apps API key is created signed, its secret shown once, and a key revoked", async ({ page }, testInfo) => {
    await reachHome(page);
    // An admin-pinned box takes this order only under the admin root (lib/addServerGate.js canSignAdminOrders).
    await asDevice(page, { admin: true });
    const OLD = { keyId: "0123456789abcdef", label: "Old script", scope: "write", createdAt: Date.now() - 5 * 86_400_000, lastUsedAt: Date.now() - 3_600_000, expiresAt: 0 };
    let keys: Array<Record<string, unknown>> = [OLD];
    let secret = "";
    const calls = await stub(page, [
      ...baseRules(appDetail(), { apiKeys: true }),
      { method: "GET", match: on(HOME, svc("/api-keys")), answer: () => ({ json: { keys } }) },
      {
        method: "POST",
        match: on(HOME, svc("/api-keys")),
        answer: (c) => {
          const g = c.body.grant;
          secret = `fsk_${g.keyId}_gymSecretValueShownOnce0123456789`;
          keys = [{ keyId: g.keyId, label: c.body.label, scope: g.scope, createdAt: g.issuedAt, lastUsedAt: 0, expiresAt: 0 }, ...keys];
          return { json: { key: secret, keyId: g.keyId } };
        },
      },
      {
        method: "DELETE",
        match: (u) => u.host === HOME && u.pathname.startsWith(svc("/api-keys/")),
        answer: (c) => {
          const id = decodeURIComponent(c.url.pathname.split("/").pop()!);
          keys = keys.filter((k) => k.keyId !== id);
          return { json: { ok: true } };
        },
      },
    ]);
    await openApp(page);
    const section = page.locator("#sd-api-keys");
    await expect(section).toContainText("Let scripts, devices and other servers call this app. Each key works until you revoke it.", { timeout: 10_000 });
    const oldRow = section.locator(`[data-api-key="${OLD.keyId}"]`);
    await expect(oldRow).toContainText("Old script");
    await expect(oldRow.locator(".pill")).toHaveText("Read & write");

    await page.click("#sd-api-key-new");
    await expect(page.locator("#sd-api-key-scope")).toHaveValue("read");
    await page.click("#sd-api-key-go");
    await expect(page.locator("#sd-api-key-error")).toHaveText("Give the key a name, so you know what uses it.");
    expect(calls.some((c) => c.method === "POST" && c.url.pathname === svc("/api-keys"))).toBe(false);
    await page.fill("#sd-api-key-label", "  Kitchen display  ");
    await page.click("#sd-api-key-go");

    await expect(page.locator("#sd-api-key-secret")).toHaveText(/^fsk_[0-9a-f]{16}_gymSecretValueShownOnce/, { timeout: 10_000 });
    expect(await page.locator("#sd-api-key-secret").textContent()).toBe(secret);
    await expect(section).toContainText("Copy it now. Flagship can't show it again.");
    await expect(section.locator(".sd-api-key-usage")).toHaveText("Authorization: Bearer <key>");
    const post = calls.find((c) => c.method === "POST" && c.url.pathname === svc("/api-keys"))!;
    const g = post.body.grant;
    expect(post.body.label).toBe("Kitchen display");
    expect(g).toMatchObject({ serverDomain: HOME, serviceId: SERVICE_ID, scope: "read", expiresAt: 0 });
    expect(g.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(fresh(g.issuedAt)).toBe(true);
    expect(
      await signedBy(page, ["flagship/app-api-key/v1", g.serverDomain, g.serviceId, g.keyId, g.scope, g.expiresAt, g.issuedAt].join("|"), post.body.signature),
    ).toBe(true);
    // The check is real: the same signature over any other bytes fails.
    expect(
      await signedBy(page, ["flagship/app-api-key/v1", g.serverDomain, g.serviceId, g.keyId, "write", g.expiresAt, g.issuedAt].join("|"), post.body.signature),
    ).toBe(false);
    await expect(section.locator(`[data-api-key="${g.keyId}"]`)).toContainText("Never used");
    await shot(page, testInfo, "api-key-revealed");

    // Done: the secret is gone from the page for good.
    await page.click("#sd-api-key-done");
    await expect(page.locator("#sd-api-key-secret")).toHaveCount(0);
    await expect(page.locator("#view-service-detail")).not.toContainText(secret);

    await oldRow.locator("[data-api-key-revoke]").click();
    await expect(page.locator(".modal-title")).toHaveText('Revoke "Old script"?');
    await expect(page.locator(".modal-message")).toHaveText("Anything using this key stops working right away. This can't be undone.");
    await page.click("[data-modal-ok]");
    await expect(page.locator("#toast")).toContainText("Key revoked", { timeout: 10_000 });
    await expect(section.locator(`[data-api-key="${OLD.keyId}"]`)).toHaveCount(0);
    expect(calls.some((c) => c.method === "DELETE" && c.url.pathname === svc(`/api-keys/${OLD.keyId}`))).toBe(true);
    await shot(page, testInfo, "api-key-revoked");
  });

  test("gym apps database browses read-only and a write runs only after a signed confirm", async ({ page }, testInfo) => {
    await reachHome(page);
    // An admin-pinned box takes this order only under the admin root (lib/addServerGate.js canSignAdminOrders).
    await asDevice(page, { admin: true });
    const SQL = "UPDATE items SET done = true WHERE done IS NULL";
    const calls = await stub(page, [
      ...baseRules(appDetail(), { db: true }),
      {
        method: "GET",
        match: on(HOME, svc("/db")),
        answer: () => ({
          json: {
            stores: [
              {
                store: "default",
                tables: [
                  { name: "items", kind: "table", rows: 2, bytes: 16_384 },
                  { name: "recent", kind: "view", rows: null, bytes: null },
                ],
              },
            ],
          },
        }),
      },
      {
        method: "GET",
        match: on(HOME, svc("/db/default/tables/items")),
        answer: () => ({
          json: {
            columns: [
              { name: "id", type: "int4" },
              { name: "title", type: "text" },
              { name: "done", type: "bool" },
            ],
            rows: [
              [1, "Milk", null],
              [2, "Eggs", true],
            ],
            total: 2,
          },
        }),
      },
      {
        method: "POST",
        match: on(HOME, svc("/db/default/query")),
        answer: (c) =>
          c.body.signature
            ? { json: { command: "UPDATE", rowCount: 1, columns: [], rows: [] } }
            : { status: 400, json: { error: "this statement changes data", needsGrant: true } },
      },
    ]);
    await openApp(page);
    const entry = page.locator("#sd-database");
    await expect(entry).toContainText("Database", { timeout: 10_000 });
    await expect(entry).toContainText("2 tables");
    await page.click("#sd-db-open");
    await expect(page.locator("#view-app-db")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-db-table="items"]')).toContainText("~2 rows · 16 KB", { timeout: 10_000 });
    await expect(page.locator('[data-db-table="recent"]')).toContainText("view");

    await page.click('[data-db-table="items"]');
    await expect(page.locator("#app-db-range")).toHaveText("Rows 1–2 of 2", { timeout: 10_000 });
    await expect(page.locator(".db-grid td.db-null")).toHaveText("NULL");
    await expect(page.locator("#app-db-next")).toBeDisabled();
    await expect(page.locator("#app-db-prev")).toBeDisabled();
    await shot(page, testInfo, "db-table");

    await page.click("#app-db-back");
    await page.click("#app-db-sql");
    await page.fill("#app-db-sql-text", SQL);
    await page.click("#app-db-run");
    // The first run is read-only and unsigned; the box answers needsGrant.
    await expect(page.locator("[data-db-needs-grant]")).toContainText("This changes data. Confirm to run it.", { timeout: 10_000 });
    const queries = () => calls.filter((c) => c.method === "POST" && c.url.pathname === svc("/db/default/query"));
    expect(queries()).toHaveLength(1);
    expect(queries()[0]!.body).toEqual({ sql: SQL });
    await shot(page, testInfo, "db-needs-grant");

    await page.click("#app-db-confirm");
    await expect(page.locator("[data-db-result]")).toContainText("UPDATE · 1 row", { timeout: 10_000 });
    expect(queries()).toHaveLength(2);
    const signed = queries()[1]!.body;
    expect(signed.sql).toBe(SQL);
    expect(signed.grant).toMatchObject({ serverDomain: HOME, serviceId: SERVICE_ID, store: "default", sqlSha256: sha256(SQL) });
    expect(fresh(signed.grant.issuedAt)).toBe(true);
    const gr = signed.grant;
    expect(
      await signedBy(page, ["flagship/app-db-write/v1", gr.serverDomain, gr.serviceId, gr.store, gr.sqlSha256, gr.issuedAt].join("|"), signed.signature),
    ).toBe(true);
    await shot(page, testInfo, "db-write-ran");
  });

  test("gym apps a non-admin device sees the admin-only app orders read-only, with the reason", async ({ page }, testInfo) => {
    await reachHome(page);
    await asDevice(page, { admin: false });
    const list = "allow api.github.com\n";
    const pending = [{ host: "api.openai.com", source: "attempt", attempts: 3, firstSeen: Date.now() - 60_000, lastSeen: Date.now() }];
    const KEY = { keyId: "0123456789abcdef", label: "Old script", scope: "write", createdAt: Date.now() - 86_400_000, lastUsedAt: 0, expiresAt: 0 };
    const calls = await stub(page, [
      ...baseRules(appDetail({ rules: 1, pending: 1, draft: false }), { apiKeys: true, db: true }),
      { method: "GET", match: on(HOME, svc("/access")), answer: () => ({ json: { access: { list, listSha256: sha256(list), pending, draft: null } } }) },
      { method: "GET", match: on(HOME, svc("/api-keys")), answer: () => ({ json: { keys: [KEY] } }) },
      { method: "GET", match: on(HOME, svc("/db")), answer: () => ({ json: { stores: [{ store: "default", tables: [{ name: "items", kind: "table", rows: 2, bytes: 16_384 }] }] } }) },
      { method: "POST", match: on(HOME, svc("/db/default/query")), answer: () => ({ status: 400, json: { error: "this statement changes data", needsGrant: true } }) },
    ]);
    await openApp(page);
    const section = page.locator("#sd-egress");
    await expect(section.locator('[data-access-host="api.openai.com"]')).toBeVisible({ timeout: 10_000 });
    await expect(section.locator("[data-access-act]")).toHaveCount(0);
    await expect(section.locator("[data-access-locked]")).toHaveText("Only an admin device can change this app's internet access.");
    const keys = page.locator("#sd-api-keys");
    await expect(keys).toContainText("Old script", { timeout: 10_000 });
    await expect(keys.locator("[data-api-key-revoke]")).toHaveCount(0);
    await expect(page.locator("#sd-api-key-new")).toHaveCount(0);
    await expect(keys.locator("[data-api-keys-locked]")).toHaveText("Only an admin device can create or revoke API keys.");
    await expect(page.locator("[data-remove-app-locked]")).toHaveText("Only an admin device can remove an app.");
    await shot(page, testInfo, "admin-only-read-only");

    await page.click("#sd-db-open");
    await page.click("#app-db-sql", { timeout: 10_000 });
    await page.fill("#app-db-sql-text", "DELETE FROM items");
    await page.click("#app-db-run");
    await expect(page.locator("[data-db-write-refused]")).toContainText("Only an admin device can change this app's data.", { timeout: 10_000 });
    await expect(page.locator("#app-db-confirm")).toHaveCount(0);
    // Only the unsigned read-only run went out: nothing was signed or sent for the box to refuse.
    const posts = calls.filter((c) => c.method === "POST" && c.url.host === HOME);
    expect(posts.map((c) => c.url.pathname)).toEqual([svc("/db/default/query")]);
    expect(posts[0]!.body.signature).toBeUndefined();
    await shot(page, testInfo, "admin-only-db-write");
  });

  test("gym apps runs-on ticks a copy to another server and unticks it with a signed uninstall", async ({ page }, testInfo) => {
    await reachHome(page);
    // Copies and uninstalls are admin orders: only a device holding the admin root changes Runs on.
    await asDevice(page, { admin: true });
    let mediaApps: Array<Record<string, unknown>> = [];
    const calls = await stub(page, [
      { method: "GET", match: on(HOME, `/api/screens/app-detail/${SERVICE_ID}`), answer: () => ({ json: appDetail() }) },
      { method: "GET", match: on(HOME, svc("/api-keys")), answer: () => ({ status: 404, json: {} }) },
      { method: "GET", match: on(HOME, svc("/db")), answer: () => ({ status: 404, json: {} }) },
      {
        method: "GET",
        match: (u) => u.pathname.endsWith("/api/users/smoketest/pods"),
        answer: () => ({
          json: {
            pods: [
              { serverDomain: HOME, liveness: "live" },
              { serverDomain: MEDIA, liveness: "live" },
              { serverDomain: ATTIC, liveness: "live" },
            ],
          },
        }),
      },
      { method: "GET", match: on(HOME, "/api/screens/apps-list"), answer: () => ({ json: { apps: [{ serviceId: SERVICE_ID, slug: "notes", status: "running" }] } }) },
      { method: "GET", match: on(MEDIA, "/api/screens/apps-list"), answer: () => ({ json: { apps: mediaApps } }) },
      {
        method: "POST",
        match: on(MEDIA, "/api/screens/services/copy"),
        answer: () => {
          mediaApps = [{ serviceId: SERVICE_ID, slug: "notes", status: "running", copying: { state: "copying", progress: 0.4 } }];
          return { json: { copyId: "copy-1" } };
        },
      },
      {
        method: "DELETE",
        match: on(MEDIA, `/api/services/${SERVICE_ID}`),
        answer: () => {
          mediaApps = [];
          return { json: { ok: true } };
        },
      },
    ]);
    await openApp(page);
    const card = page.locator("#sd-runs-on-card");
    const row = (fqdn: string) => card.locator(`[data-runs-on-fqdn="${fqdn}"]`);
    const box = (fqdn: string) => page.locator(`[data-runs-on-toggle="${fqdn}"]`);
    await expect(row(HOME)).toBeVisible({ timeout: 10_000 });
    // home holds the only copy: ticked and locked.
    await expect(box(HOME)).toBeChecked();
    await expect(box(HOME)).toBeDisabled();
    await expect(row(HOME)).toContainText("This is the app's only copy, so it can't be unticked.");
    // media is reachable and doesn't have it; attic has no session here: unknown, never ticked.
    await expect(box(MEDIA)).not.toBeChecked();
    await expect(box(MEDIA)).toBeEnabled();
    await expect(box(ATTIC)).not.toBeChecked();
    await expect(box(ATTIC)).toBeDisabled();
    await expect(row(ATTIC)).toContainText("Can't reach this server, so it isn't known whether the app is there.");
    await shot(page, testInfo, "runs-on");

    await box(MEDIA).check();
    await expect(page.locator("#toast")).toContainText("Copying the app. It appears on that server when it's ready.", { timeout: 10_000 });
    await expect(row(MEDIA)).toContainText("Copying…");
    const copy = calls.find((c) => c.method === "POST" && c.url.host === MEDIA && c.url.pathname === "/api/screens/services/copy")!;
    expect(copy.headers["x-flagship-session"]).toBe("gym-media-token");
    const g = copy.body.grant;
    expect(g).toMatchObject({ sourceServer: HOME, targetServer: MEDIA, serviceId: SERVICE_ID });
    expect(fresh(g.issuedAt)).toBe(true);
    expect(await signedBy(page, ["flagship/app-copy/v1", g.sourceServer, g.targetServer, g.serviceId, g.issuedAt].join("|"), copy.body.signature)).toBe(true);
    await shot(page, testInfo, "runs-on-copying");

    // The page re-reads while the copy runs; once media has it, both copies can be unticked.
    mediaApps = [{ serviceId: SERVICE_ID, slug: "notes", status: "running" }];
    await expect(box(MEDIA)).toBeEnabled({ timeout: 15_000 });
    await expect(box(MEDIA)).toBeChecked();
    await expect(box(HOME)).toBeEnabled();

    await box(MEDIA).uncheck();
    await expect(page.locator(".modal-title")).toHaveText("Remove from this server?");
    await expect(page.locator(".modal-message")).toHaveText("notes and its data on media are deleted. Your other servers keep their copies.");
    await page.click("[data-modal-ok]");
    await expect(page.locator("#toast")).toContainText("Removed from media.", { timeout: 10_000 });
    await expect(box(MEDIA)).not.toBeChecked();
    await expect(box(HOME)).toBeDisabled();
    const del = calls.find((c) => c.method === "DELETE" && c.url.host === MEDIA)!;
    const r = del.body.request;
    expect(r).toMatchObject({ serverId: MEDIA, creator: "smoketest", slug: "notes" });
    expect(await signedBy(page, ["flagship/uninstall-service/v1", r.serverId, r.creator, r.slug, r.issuedAt].join("|"), del.body.signature)).toBe(true);
    // No app order went to home or to attic (auto-pair asking attic, a box
    // this browser has no session for, for one is expected).
    expect(
      calls
        .filter((c) => c.method !== "GET" && c.url.host !== MEDIA && c.url.host.endsWith("flagship.services") && !c.url.pathname.endsWith("/api/orders-from-user") && !c.url.pathname.endsWith("/api/screens/ws-ticket"))
        .map((c) => `${c.method} ${c.url.pathname}`),
    ).toEqual([]);
    await shot(page, testInfo, "runs-on-removed");
  });

  test("gym apps backup packs the app and saves the archive fetched once with the session", async ({ page }, testInfo) => {
    await reachHome(page);
    const ARCHIVE = Buffer.from(Array.from({ length: 2048 }, (_, i) => i % 251));
    const ids = ["0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210"];
    let started = 0;
    const served = new Set<string>();
    const calls = await stub(page, [
      ...baseRules(appDetail()),
      {
        method: "POST",
        match: on(HOME, "/api/screens/app-backup/start"),
        answer: (c) => {
          const id = ids[started++]!;
          return { json: { backupId: id, fetchPath: `/api/backups/${id}`, expiresAt: Date.now() + 600_000, bytes: ARCHIVE.length, encrypted: !!c.body.password } };
        },
      },
      {
        method: "GET",
        match: (u) => u.host === HOME && u.pathname.startsWith("/api/backups/"),
        answer: (c) => {
          // The box hands each archive out once; the second backup's is already gone.
          const id = c.url.pathname.split("/").pop()!;
          if (c.headers["x-flagship-session"] !== "gym-home-token") return { status: 401, json: { error: "missing paired-session token" } };
          if (served.has(id) || id === ids[1]) return { status: 404, json: { error: "backup not found or expired" } };
          served.add(id);
          return { raw: ARCHIVE, contentType: "application/octet-stream" };
        },
      },
    ]);
    await openApp(page);
    const card = page.locator("#sd-backup");
    await expect(card).toContainText("The app's code, and its data if you include it. It comes straight from your server to this device.");
    await page.check("#sd-include-data");
    await page.fill("#sd-password", "gym-backup-pw");
    await page.click("#sd-backup-go");

    await expect(card.locator("[data-backup-ready]")).toHaveText("Ready: 2 KB, encrypted", { timeout: 10_000 });
    await expect(page.locator("#sd-password")).toHaveValue("");
    await expect(page.locator("#sd-backup-go")).toHaveText("Back up now");
    const start = calls.find((c) => c.method === "POST" && c.url.pathname === "/api/screens/app-backup/start")!;
    expect(start.body).toEqual({ serviceId: SERVICE_ID, includeUserData: true, password: "gym-backup-pw" });
    const fetches = calls.filter((c) => c.method === "GET" && c.url.pathname.startsWith("/api/backups/"));
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.url.host).toBe(HOME);
    expect(fetches[0]!.headers["x-flagship-session"]).toBe("gym-home-token");
    await card.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "app-backup-ready");

    // Save hands over the bytes this page already holds; the box isn't asked again.
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#sd-backup-save")]);
    expect(download.suggestedFilename()).toMatch(/^notes-backup-\d{4}-\d{2}-\d{2}-\d{4}\.tar\.gz\.enc$/);
    const saved = testInfo.outputPath("app-backup.tar.gz.enc");
    await download.saveAs(saved);
    const { readFileSync } = await import("node:fs");
    expect(Buffer.compare(readFileSync(saved), ARCHIVE)).toBe(0);
    expect(calls.filter((c) => c.method === "GET" && c.url.pathname.startsWith("/api/backups/"))).toHaveLength(1);

    // A backup the box no longer holds says so, and leaves nothing to save.
    await page.click("#sd-backup-go");
    await expect(card.locator("[data-backup-error]")).toHaveText("The server no longer has that backup. Back up again.", { timeout: 10_000 });
    await expect(page.locator("#sd-backup-save")).toHaveCount(0);
    const second = calls.filter((c) => c.method === "POST" && c.url.pathname === "/api/screens/app-backup/start")[1]!;
    expect(second.body).toEqual({ serviceId: SERVICE_ID, includeUserData: true });
    await card.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "app-backup-gone");
  });
  test("gym apps storage shows an app's use against its limits and why a full app refuses data", async ({ page }, testInfo) => {
    await reachHome(page);
    const GB = 1024 ** 3;
    const detail = appDetail() as Record<string, unknown>;
    detail.storage = {
      files: { usedBytes: 5 * GB, limitBytes: 5 * GB, full: true },
      postgres: { usedBytes: 200 * 1024 ** 2, limitBytes: GB },
    };
    await stub(page, baseRules(detail));
    await openApp(page);
    const card = page.locator("#sd-storage");
    await expect(card).toContainText("Files");
    await expect(card).toContainText("5.0 GB of 5.0 GB");
    await expect(card.locator("[data-sd-storage-full]")).toHaveText("Full: new data is refused until you free space or raise the limit.");
    await expect(card).toContainText("200 MB of 1.0 GB");
    await card.scrollIntoViewIfNeeded();
    await shot(page, testInfo, "app-storage-full");
  });
});
