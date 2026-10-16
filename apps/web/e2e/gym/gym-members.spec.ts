/**
 * The Services list and an app's pages, the controls gym-apps doesn't press:
 * the list's search, filters, refresh, copy and card; Access control's switch
 * back to Open, invites at Manager and Master with their link, QR, Copy and
 * Share, group and approve-first invites, Finalize, Remove and the Cancel
 * paths; the invitee's redeem screen; internet access Ignore / Dismiss / View
 * list, the three global access-alert sheets and an older box's egress card;
 * API keys' scope, Enter, Copy and Cancel; the Database's paging, CSV export
 * and second store; Remove app; Edit this service; Configure environment;
 * the adapter report; and the web domains' copy and Replace.
 *
 * Crypto is real. The mock answers each admin order the way an admin-pinned
 * box or `.com` does (gymKit `sensitive`): the admin root only, the IRK gets a
 * 403; a demo account keeps the IRK.
 */

import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import {
  ACCOUNT_ID,
  DEVICE_ID,
  HOME,
  REFUSED_NOT_ADMIN,
  createAccount,
  mock,
  reachHome,
  sawToast,
  sensitive,
  shot,
  signer,
  type Canon,
  type Keys,
  type Mock,
} from "./gymKit.js";

const SERVICE_ID = "smoketest--notes";
const svc = (sub = "") => `/api/screens/services/${SERVICE_ID}${sub}`;
const onHome = (path: string) => (u: URL) => u.host === HOME && u.pathname === path;
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const CANON = {
  access: ["/lib/appAccess.js", "canonicalAppAccessBytes"] as Canon,
  egress: ["/lib/appEgress.js", "canonicalAppEgressBytes"] as Canon,
  apiKey: ["/lib/appApiKeys.js", "canonicalAppApiKeyBytes"] as Canon,
  dbWrite: ["/lib/appDb.js", "canonicalAppDbWriteBytes"] as Canon,
  rank: ["/lib/memberRoles.js", "canonicalAppRankBytes"] as Canon,
  mode: ["/lib/serviceInvite.js", "canonicalSetAccessModeV2Bytes"] as Canon,
  allowRemove: ["/lib/serviceInvite.js", "canonicalRemoveServiceAllowV2Bytes"] as Canon,
  revoke: ["/lib/serviceInvite.js", "canonicalRevokeBytes"] as Canon,
  uninstall: ["/lib/appPlacement.js", "canonicalUninstallServiceBytes"] as Canon,
  rename: (r: { username: string; serviceId: string; newDisplayLabel: string; issuedAt: number }) =>
    ["flagship/service-rename/v1", r.username, r.serviceId, r.newDisplayLabel.toLowerCase(), String(r.issuedAt)].join("|"),
  env: (r: { serverId: string; creator: string; slug: string; env: Record<string, string>; issuedAt: number }) => {
    const pairs = Object.keys(r.env).sort().map((k) => `${k}=${r.env[k]}`);
    return ["flagship/set-service-env/v1", r.serverId, r.creator, r.slug, String(pairs.length), ...pairs, String(r.issuedAt)].join("|");
  },
};

test.use({ viewport: { width: 430, height: 932 } });

/** Record clipboard writes and Web Share calls instead of touching the OS. */
async function recordClipboardAndShare(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __clip: string[]; __shared: unknown[] };
    w.__clip = [];
    w.__shared = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (t: string) => void w.__clip.push(t),
        readText: async () => w.__clip[w.__clip.length - 1] ?? "",
      },
    });
    Object.defineProperty(navigator, "share", { configurable: true, value: async (d: unknown) => void w.__shared.push(d) });
  });
}
const clipboard = (page: Page) => page.evaluate(() => (window as unknown as { __clip: string[] }).__clip);
const shared = (page: Page) => page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared);

function appDetail(extra: Record<string, unknown> = {}, app: Record<string, unknown> = {}) {
  return {
    app: {
      serviceId: SERVICE_ID,
      slug: "notes",
      creator: "smoketest",
      summary: "Shared notes for the house",
      status: "running",
      version: "1.2.0",
      url: `https://notes.${HOME}`,
      ...app,
    },
    manifest: { name: "notes", runtime: { base: "node-24" } },
    dataLayerInstances: [],
    members: [],
    editable: false,
    ...extra,
  };
}

/** What every app-page test needs: /pods, the apps list and the detail read. */
function base(m: Mock, detail: unknown = appDetail()): Mock {
  m.get("/api/users/smoketest/pods", { pods: [{ serverDomain: HOME, liveness: "live" }] });
  m.get(onHome("/api/screens/apps-list"), { apps: [{ serviceId: SERVICE_ID, slug: "notes", creator: "smoketest", status: "running", url: `https://notes.${HOME}` }] });
  m.get(onHome(`/api/screens/app-detail/${SERVICE_ID}`), () => ({ json: typeof detail === "function" ? (detail as () => unknown)() : detail }));
  return m;
}

async function openApp(page: Page): Promise<void> {
  await page.evaluate(async (id) => {
    const { enterServiceDetail } = await import("/views/service-detail.js");
    await enterServiceDetail(id);
  }, SERVICE_ID);
  await expect(page.locator("#service-detail-content .card-title").first()).toContainText("notes", { timeout: 10_000 });
}

/** This browser's account device key (hex), as the box's Account members names it. */
async function thisDevicePub(page: Page): Promise<string> {
  return page.evaluate(
    async ({ accountId, deviceId }) => {
      const ks = await import("/keystore.js");
      const { getSession } = await import("/lib/state.js");
      return ks.bytesToHex((await ks.deriveAccountDeviceKeyFromSeed(getSession().umk, accountId, deviceId)).publicKey);
    },
    { accountId: ACCOUNT_ID, deviceId: DEVICE_ID },
  );
}

/** Which key signed an invite create: the admin root, this device's key, or the AID. */
async function inviteSigner(page: Page, keys: Keys, req: Record<string, unknown>, sig: string): Promise<"admin" | "device" | "aid" | null> {
  return page.evaluate(
    async ({ req, sig, adminPub, accountId, deviceId }) => {
      const ks = await import("/keystore.js");
      const si = await import("/lib/serviceInvite.js");
      const { getSession } = await import("/lib/state.js");
      const umk = getSession().umk;
      const bytes = si.canonicalCreateBytes({ ...req, authorAID: ks.hexToBytes(req.authorAID as string) });
      const ok = (pub: Uint8Array) => ks.verifyWithEd25519Pub(pub, ks.hexToBytes(sig), bytes);
      if (adminPub && (await ok(ks.hexToBytes(adminPub)))) return "admin";
      if (await ok((await ks.deriveAccountDeviceKeyFromSeed(umk, accountId, deviceId)).publicKey)) return "device";
      if (await ok((await ks.deriveAccountIdFromSeed(umk)).publicKey)) return "aid";
      return null;
    },
    { req, sig, adminPub: keys.adminPubHex, accountId: ACCOUNT_ID, deviceId: DEVICE_ID },
  );
}

/** Open a sealed invite bundle with this account's household key. */
async function openBundle(page: Page, sealed: string, inviteId: string): Promise<Record<string, unknown>> {
  return page.evaluate(
    async ({ sealed, inviteId }) => {
      const ks = await import("/keystore.js");
      const si = await import("/lib/serviceInvite.js");
      const { getSession } = await import("/lib/state.js");
      return si.openInviteBundle(sealed, await ks.deriveHouseholdKeyFromSeed(getSession().umk), inviteId);
    },
    { sealed, inviteId },
  );
}

/**
 * Access control's box and `.com`: the members list, the invite list (fed by
 * what was created, sealed bundles and all), creates, ranks, the mode and
 * removals, each sensitive one answered as an admin-pinned box would.
 */
function accessControl(page: Page, m: Mock, keys: Keys, opts: { myPub: string; members?: Array<Record<string, unknown>>; invites?: Array<Record<string, unknown>> }) {
  const st = {
    mode: "open",
    ranks: {} as Record<string, string>,
    invites: [...(opts.invites ?? [])] as Array<Record<string, unknown>>,
    members: [...(opts.members ?? [])],
  };
  m.get((u) => u.pathname === "/api/users/smoketest/service-invites", () => ({ json: { invites: st.invites } }));
  m.get(onHome(svc("/members")), () => ({
    json: {
      mode: st.mode,
      roles: ["member", "manager", "master"],
      defaultRole: "member",
      descriptions: { member: "Reads notes", manager: "Edits notes", master: "Manages who's in" },
      accountMembers: [{ kind: "device", deviceId: DEVICE_ID, devicePub: opts.myPub, tier: "admin", rank: "master", set: false, refused: false }],
      members: st.members,
      invites: st.invites.map((i) => ({ inviteId: i.inviteId, role: st.ranks[`invite:${i.inviteId}`] ?? "member", set: !!st.ranks[`invite:${i.inviteId}`] })),
    },
  }));
  m.post((u) => u.pathname === "/api/users/smoketest/service-invites", (c) => {
    const r = c.body.request;
    st.invites.push({
      inviteId: r.inviteId,
      serviceRef: r.serviceRef,
      encryptedBundle: r.encryptedBundle,
      createdAt: r.issuedAt,
      approvalMode: r.approvalMode ?? "auto",
      ...(r.maxRedemptions !== undefined ? { maxRedemptions: r.maxRedemptions, redemptions: 0, boundAIDs: [] } : {}),
      ...(r.expiresAt !== undefined ? { expiresAt: r.expiresAt } : {}),
      creatorTier: "admin",
      creatorDeviceId: DEVICE_ID,
    });
    return { json: { created: true, inviteId: r.inviteId, tier: "admin" } };
  });
  m.post(
    onHome(svc("/members/rank")),
    sensitive(page, keys, CANON.rank, (b) => ({ arg: b.order, sig: b.signature }), (c) => {
      st.ranks[c.body.order.target] = c.body.order.rank;
      return { json: { ok: true, target: c.body.order.target, rank: c.body.order.rank } };
    }),
  );
  m.post(
    onHome("/api/service-access"),
    sensitive(page, keys, CANON.mode, (b) => ({ arg: b.request, sig: b.signature }), (c) => {
      st.mode = c.body.request.mode;
      return { json: { ok: true, mode: st.mode } };
    }),
  );
  m.post(
    (u) => u.pathname === "/api/users/smoketest/service-invites/revoke",
    sensitive(page, keys, CANON.revoke, (b) => ({ arg: b.request, sig: b.signature }), (c) => {
      st.invites = st.invites.filter((i) => i.inviteId !== c.body.request.inviteId);
      return { json: { revoked: true } };
    }),
  );
  m.post(onHome("/api/service-access/invite-withdraw"), { ok: true, pruned: 0 });
  m.post(
    onHome("/api/service-access/allow-remove"),
    sensitive(page, keys, CANON.allowRemove, (b) => ({ arg: b.request, sig: b.signature }), (c) => {
      st.members = st.members.filter((x) => x.aid !== c.body.request.aid);
      return { json: { ok: true, removed: true } };
    }),
  );
  return st;
}

async function openAccessControl(page: Page): Promise<void> {
  await openApp(page);
  await page.click("#sd-access");
  await expect(page.locator("#view-service-access")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#sa-account-people .card").first()).toBeVisible({ timeout: 10_000 });
}

const fresh = (issuedAt: unknown) => typeof issuedAt === "number" && Math.abs(Date.now() - issuedAt) < 5 * 60_000;
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360f8cf000000030101005c1b0fd20000000049454e44ae426082",
  "hex",
);

test.describe("gym webapp members and app pages", () => {
  test("gym members the Services tab searches, filters, copies a link and opens an app card", async ({ page }, testInfo) => {
    await recordClipboardAndShare(page);
    await reachHome(page, { kind: "admin" });
    const m = await mock(page);
    m.get("/api/users/smoketest/pods", { pods: [{ serverDomain: HOME, liveness: "live" }] });
    m.get(onHome("/api/screens/apps-list"), {
      apps: [
        { serviceId: SERVICE_ID, slug: "notes", creator: "smoketest", summary: "Shared notes", status: "running", version: "1.2.0", url: `https://notes.${HOME}` },
        { serviceId: "kim--chess", slug: "chess", creator: "kim", summary: "Club ladder", status: "running", version: "0.9.0", url: `https://chess.${HOME}` },
      ],
    });
    m.get(`/api/users/smoketest/apps/${SERVICE_ID}/links`, { shortUrl: "https://voi.ci/n0tes", canonicalUrl: `https://notes.${HOME}` });
    m.get(onHome(`/api/screens/app-detail/${SERVICE_ID}`), appDetail());
    await page.click('[data-tab-target="apps"]');
    await expect(page.locator("#view-services-list")).toBeVisible();
    const cards = page.locator("#services-list-content .fs-app-card");
    await expect(cards).toHaveCount(2, { timeout: 10_000 });

    // Search narrows, the clear button brings both back.
    await page.fill("#apps-search", "ladder");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toHaveAttribute("data-service-id", "kim--chess");
    await page.click("[data-search-clear]");
    await expect(cards).toHaveCount(2);
    await expect(page.locator("#apps-search")).toHaveValue("");

    // Yours / Shared by creator.
    await page.click('[data-chip][data-chip-value="shared"]');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toHaveAttribute("data-service-id", "kim--chess");
    await page.click('[data-chip][data-chip-value="yours"]');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toHaveAttribute("data-service-id", SERVICE_ID);
    await page.click('[data-chip][data-chip-value="all"]');
    await expect(cards).toHaveCount(2);

    // The short link from .com, copied.
    const notes = page.locator(`.fs-app-card[data-service-id="${SERVICE_ID}"]`);
    await expect(notes.locator('[data-copy][aria-label="Copy short link"]')).toBeVisible({ timeout: 10_000 });
    await notes.locator('[data-copy][aria-label="Copy short link"]').click();
    await sawToast(page, "Copied.");
    expect(await clipboard(page)).toEqual(["https://voi.ci/n0tes"]);
    await shot(page, testInfo, "services-list");

    // Refresh asks the box again.
    const lists = () => m.sent("/api/screens/apps-list", "GET").length;
    const before = lists();
    await page.click("#services-list-refresh");
    await expect.poll(lists).toBeGreaterThan(before);

    // The card opens the app; its Refresh re-reads it and Back returns to the list.
    await page.locator(`.fs-app-card[data-service-id="${SERVICE_ID}"] [data-action="open"]`).click();
    await expect(page.locator("#view-service-detail")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#service-detail-content .card-title").first()).toContainText("notes", { timeout: 10_000 });
    const reads = () => m.sent(`/api/screens/app-detail/${SERVICE_ID}`, "GET").length;
    const r0 = reads();
    await page.click("#service-detail-refresh");
    await expect.poll(reads).toBeGreaterThan(r0);
    await page.click("#service-detail-back");
    await expect(page.locator("#view-services-list")).toBeVisible({ timeout: 10_000 });
    await expect(cards).toHaveCount(2, { timeout: 10_000 });
    await page.click("#services-list-back");
    await expect(page.locator("#view-home")).toBeVisible();
  });

  test("gym members access control goes back to Open to all, and Members only can be cancelled", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin" });
    const myPub = await thisDevicePub(page);
    const m = base(await mock(page));
    const st = accessControl(page, m, keys, { myPub });
    await openAccessControl(page);
    const open = page.locator('#sa-mode [data-mode="open"]');
    const restricted = page.locator('#sa-mode [data-mode="restricted"]');
    await expect(open).toHaveAttribute("aria-checked", "true");

    // Cancel leaves it open and sends nothing.
    await restricted.click();
    await expect(page.locator(".modal-title")).toHaveText("Members only?");
    await page.click("[data-modal-cancel]");
    await expect(open).toHaveAttribute("aria-checked", "true");
    expect(m.sent("/api/service-access")).toHaveLength(0);

    await restricted.click();
    await page.click("[data-modal-ok]");
    await expect(page.locator("#sa-mode-status")).toHaveText("Only members and you can open it. Anyone else is asked to sign in.", { timeout: 10_000 });
    expect(st.mode).toBe("restricted");

    // Open to all needs no confirmation, and is signed with the admin root.
    await open.click();
    await sawToast(page, "Now open to all.");
    await expect(page.locator("#sa-mode-status")).toHaveText("Anyone can open it. Members who sign in get their rank.");
    await expect(page.locator(".modal-title")).toHaveCount(0);
    const back = m.last(onHome("/api/service-access"))!;
    expect(back.body.request).toMatchObject({ serviceRef: SERVICE_ID, mode: "open" });
    expect(await signer(page, keys, CANON.mode, back.body.request, back.body.signature)).toBe("admin");
    expect(st.mode).toBe("open");
    await shot(page, testInfo, "access-open-again");

    // Refresh re-reads the box; Back returns to the app page.
    const reads = () => m.sent(svc("/members"), "GET").length;
    const r0 = reads();
    await page.click("#service-access-refresh");
    await expect.poll(reads).toBeGreaterThan(r0);
    await page.click("#service-access-back");
    await expect(page.locator("#view-service-detail")).toBeVisible({ timeout: 10_000 });
  });

  test("gym members an admin invites a person at Manager with a photo and gets the link, QR, Copy and Share", async ({ page }, testInfo) => {
    await recordClipboardAndShare(page);
    const keys = await reachHome(page, { kind: "admin" });
    const myPub = await thisDevicePub(page);
    const m = base(await mock(page));
    const st = accessControl(page, m, keys, { myPub });
    await openAccessControl(page);

    await page.click("#sa-add-person");
    await expect(page.locator("#sa-add-title")).toHaveText("Add a person");
    await expect(page.locator("#sa-new-role")).toBeEnabled();
    await expect(page.locator("#sa-rank-locked")).toBeHidden();
    await page.selectOption("#sa-new-role", "manager");
    await page.fill("#sa-name", "Robin");
    await page.setInputFiles("#sa-photo", { name: "robin.png", mimeType: "image/png", buffer: PNG });
    await expect(page.locator("#sa-photo-preview img")).toBeVisible();
    await page.click("#sa-add-go");
    await expect(page.locator("#sa-add-status")).toHaveText("Invite for Robin created.", { timeout: 10_000 });

    // The create goes to .com under the admin root; the name and photo only sealed.
    const create = m.last((u) => u.pathname === "/api/users/smoketest/service-invites")!;
    const req = create.body.request;
    expect(req.serviceRef).toBe(SERVICE_ID);
    expect(req.approvalMode).toBe("auto");
    expect(req.deviceId).toBe(DEVICE_ID);
    expect(fresh(req.issuedAt)).toBe(true);
    expect(JSON.stringify(create.body)).not.toContain("Robin");
    expect(await inviteSigner(page, keys, req, create.body.signature)).toBe("admin");
    const bundle = await openBundle(page, req.encryptedBundle, req.inviteId);
    expect(bundle.name).toBe("Robin");
    expect(String(bundle.photo)).toMatch(/^data:image\/png;base64,/);
    // Manager isn't the app's default rank: an admin-root rank order for the invite.
    const rank = m.last(svc("/members/rank"))!;
    expect(rank.body.order).toMatchObject({ serviceRef: SERVICE_ID, target: `invite:${req.inviteId}`, rank: "manager" });
    expect(await signer(page, keys, CANON.rank, rank.body.order, rank.body.signature)).toBe("admin");
    expect(st.ranks[`invite:${req.inviteId}`]).toBe("manager");

    // The link names the box, the author, the invite and the app; a QR beside it.
    const link = await page.locator("#sa-link").inputValue();
    expect(link).toMatch(new RegExp(`^https://${HOME.replace(/\./g, "\\.")}/invite#[0-9a-f]{64}&a=[0-9a-f]{64}&i=${req.inviteId}&s=${SERVICE_ID}$`));
    await expect(page.locator("#sa-qr svg")).toBeVisible();
    await expect(page.locator("#sa-manual-hint")).toBeHidden();
    await page.click("#sa-copy");
    await sawToast(page, "Link copied.");
    expect(await clipboard(page)).toEqual([link]);
    await page.click("#sa-share");
    await expect.poll(() => shared(page)).toEqual([{ title: "Flagship invite", url: link }]);
    // The new row carries its rank and can be revoked.
    const robin = page.locator("#sa-people .card", { hasText: "Robin" });
    await expect(robin.locator('select[data-action="sa-role"]')).toHaveValue("manager", { timeout: 10_000 });
    await expect(robin).toContainText("invite sent — not opened yet");
    await shot(page, testInfo, "invite-manager-link");
  });

  // Each invite used to add another listener to #sa-copy / #sa-share, so
  // after a second invite Copy wrote the first link too and Share shared both.
  test("gym members a second invite's Copy and Share hand over only the newest link", async ({ page }, testInfo) => {
    await recordClipboardAndShare(page);
    const keys = await reachHome(page, { kind: "admin" });
    const myPub = await thisDevicePub(page);
    const m = base(await mock(page));
    accessControl(page, m, keys, { myPub });
    await openAccessControl(page);
    await page.click("#sa-add-person");
    await page.fill("#sa-name", "Ana");
    await page.click("#sa-add-go");
    await expect(page.locator("#sa-add-status")).toHaveText("Invite for Ana created.", { timeout: 10_000 });
    await page.click("#sa-add-person");
    await page.fill("#sa-name", "Ben");
    await page.click("#sa-add-go");
    await expect(page.locator("#sa-add-status")).toHaveText("Invite for Ben created.", { timeout: 10_000 });
    const second = await page.locator("#sa-link").inputValue();
    await page.click("#sa-copy");
    await sawToast(page, "Link copied.");
    await page.click("#sa-share");
    await expect.poll(async () => (await shared(page)).length).toBeGreaterThan(0);
    await shot(page, testInfo, "invite-second-link");
    // One click, one link: the one on screen.
    expect(await clipboard(page)).toEqual([second]);
    expect(await shared(page)).toEqual([{ title: "Flagship invite", url: second }]);
  });

  test("gym members a group invite at Master carries its limit and expiry, and Revoke can be cancelled", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin" });
    const myPub = await thisDevicePub(page);
    const m = base(await mock(page));
    const st = accessControl(page, m, keys, { myPub });
    await openAccessControl(page);

    await page.click("#sa-add-group");
    await expect(page.locator("#sa-add-title")).toHaveText("Add a group");
    await expect(page.locator("#sa-group-opts")).toBeVisible();
    await expect(page.locator("#sa-person-opts")).toBeHidden();
    await page.fill("#sa-name", "Chess club");
    await page.fill("#sa-maxn", "5");
    await page.fill("#sa-expiry-days", "7");
    await page.selectOption("#sa-new-role", "master");
    await page.click("#sa-add-go");
    await expect(page.locator("#sa-add-status")).toHaveText("Group Chess club created.", { timeout: 10_000 });
    const create = m.last((u) => u.pathname === "/api/users/smoketest/service-invites")!;
    const req = create.body.request;
    expect(req.maxRedemptions).toBe(5);
    expect(req.expiresAt - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(req.expiresAt - Date.now()).toBeLessThan(7.1 * 86_400_000);
    expect(req.approvalMode).toBe("auto");
    expect(await inviteSigner(page, keys, req, create.body.signature)).toBe("admin");
    const rank = m.last(svc("/members/rank"))!;
    expect(rank.body.order).toMatchObject({ target: `invite:${req.inviteId}`, rank: "master" });
    expect(await signer(page, keys, CANON.rank, rank.body.order, rank.body.signature)).toBe("admin");

    const group = page.locator("#sa-people .card", { hasText: "Chess club" });
    await expect(group).toContainText("0 of 5 joined · expires", { timeout: 10_000 });
    await expect(group.locator(".sa-crown")).toBeVisible();
    await shot(page, testInfo, "group-invite");

    // Revoke asks first; Cancel keeps the group.
    await group.locator('[data-action="sa-remove"]').click();
    await expect(page.locator(".modal-title")).toHaveText('Revoke the "Chess club" group?');
    await page.click("[data-modal-cancel]");
    expect(m.sent("/service-invites/revoke")).toHaveLength(0);
    await expect(page.locator("#sa-members-title")).toHaveText("Members (1)");
    expect(st.invites).toHaveLength(1);
  });

  test("gym members an approve-first invite shows its hint and Finalize grants a pasted acceptance", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin" });
    const myPub = await thisDevicePub(page);
    const m = base(await mock(page));
    accessControl(page, m, keys, { myPub });
    m.post(onHome("/api/service-access/accept"), (c) => ({ json: { bound: true, serviceRef: c.body.accept.serviceRef, boundAID: c.body.accept.contactAID } }));
    await openAccessControl(page);

    await page.click("#sa-add-person");
    await page.fill("#sa-name", "Kim");
    await page.check("#sa-approve");
    await page.click("#sa-add-go");
    await expect(page.locator("#sa-add-status")).toHaveText("Invite for Kim created.", { timeout: 10_000 });
    await expect(page.locator("#sa-manual-hint")).toBeVisible();
    const req = m.last((u) => u.pathname === "/api/users/smoketest/service-invites")!.body.request;
    expect(req.approvalMode).toBe("manual");
    await expect(page.locator("#sa-people .card", { hasText: "Kim" })).toContainText("you approve — waiting for their acceptance", { timeout: 10_000 });
    await shot(page, testInfo, "approve-first-invite");

    // Nothing pasted, then junk: the box is never asked.
    await page.click("#sa-accept-go");
    await expect(page.locator("#sa-accept-status")).toHaveText("Paste the acceptance code first.");
    await page.fill("#sa-accept-input", "hello there");
    await page.click("#sa-accept-go");
    await expect(page.locator("#sa-accept-status")).toHaveText("That doesn't look like an acceptance code. Paste the whole thing.");
    await expect(page.locator("#sa-accept-status")).toHaveClass(/err-text/);
    await expect(page.locator("#sa-accept-go")).toBeEnabled();
    expect(m.sent("/api/service-access/accept")).toHaveLength(0);

    // Kim's real reply, signed with Kim's id for this app.
    const reply = await page.evaluate(
      async ({ inviteId, serviceRef, host }) => {
        const ks = await import("/keystore.js");
        const si = await import("/lib/serviceInvite.js");
        const kimUmk = crypto.getRandomValues(new Uint8Array(32));
        const app = await ks.deriveAppAccountIdFromSeed(kimUmk, serviceRef);
        const acceptedAt = Date.now();
        const sig = await si.signAcceptServiceInvite({ inviteId, serviceRef, contactAID: app.publicKey, acceptedAt, umk: kimUmk }, ks.signWithAppAccountId);
        return si.buildAcceptReply(host, { inviteId, serviceRef, contactAID: ks.bytesToHex(app.publicKey), acceptedAt }, ks.bytesToHex(sig));
      },
      { inviteId: req.inviteId, serviceRef: SERVICE_ID, host: HOME },
    );
    await page.fill("#sa-accept-input", `  ${reply}  `);
    await page.click("#sa-accept-go");
    await expect(page.locator("#sa-accept-status")).toHaveText("Granted — they can open it now.", { timeout: 10_000 });
    await expect(page.locator("#sa-accept-input")).toHaveValue("");
    const sent = m.last(onHome("/api/service-access/accept"))!;
    expect(Object.keys(sent.body).sort()).toEqual(["accept", "acceptSig"]);
    expect(sent.body.accept).toMatchObject({ inviteId: req.inviteId, serviceRef: SERVICE_ID });
    await shot(page, testInfo, "finalize-granted");
  });

  test("gym members an admin removes a member, and the box prunes them under the admin root", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin" });
    const myPub = await thisDevicePub(page);
    const SAM_AID = "5a".repeat(32);
    const sealed = await page.evaluate(async () => {
      const ks = await import("/keystore.js");
      const si = await import("/lib/serviceInvite.js");
      const { getSession } = await import("/lib/state.js");
      return si.sealInviteBundle({ name: "Sam" }, await ks.deriveHouseholdKeyFromSeed(getSession().umk), "inv-sam");
    });
    const m = base(await mock(page));
    const st = accessControl(page, m, keys, {
      myPub,
      members: [{ aid: SAM_AID, role: "member", grants: [{ inviteId: "inv-sam", role: "member" }], direct: false }],
      invites: [{ inviteId: "inv-sam", serviceRef: SERVICE_ID, encryptedBundle: sealed, boundAID: SAM_AID, boundAt: Date.now() - 86_400_000, createdAt: Date.now() - 2 * 86_400_000, approvalMode: "auto" }],
    });
    await openAccessControl(page);
    const sam = page.locator("#sa-people .card", { hasText: "Sam" });
    await expect(sam).toContainText("active", { timeout: 10_000 });

    await sam.locator('[data-action="sa-remove"]').click();
    await expect(page.locator(".modal-title")).toHaveText("Remove Sam?");
    await page.click("[data-modal-cancel]");
    expect(m.sent("/service-invites/revoke")).toHaveLength(0);

    await sam.locator('[data-action="sa-remove"]').click();
    await page.click("[data-modal-ok]");
    await sawToast(page, "Removed.");
    await expect(page.locator("#sa-members-title")).toHaveText("Members (0)");
    const revoke = m.last("/service-invites/revoke")!;
    expect(await signer(page, keys, CANON.revoke, revoke.body.request, revoke.body.signature)).toBe("admin");
    const prune = m.last(onHome("/api/service-access/allow-remove"))!;
    expect(prune.body.request).toMatchObject({ serviceRef: SERVICE_ID, aid: SAM_AID });
    expect(await signer(page, keys, CANON.allowRemove, prune.body.request, prune.body.signature)).toBe("admin");
    expect(st.members).toHaveLength(0);
    await shot(page, testInfo, "member-removed");
  });

  test("gym members the invitee opens the invite link, unlocks and accepts", async ({ page }, testInfo) => {
    const SECRET = "ab".repeat(32);
    const AUTHOR = "cd".repeat(32);
    const IID = "ef".repeat(32);
    await createAccount(page);
    const m = await mock(page);
    m.post(onHome("/api/service-invites/redeem"), { serviceRef: SERVICE_ID, boundAID: "00".repeat(32), firstBind: true });
    await page.goto(`/invite#server=${HOME}&k=${SECRET}&a=${AUTHOR}&i=${IID}&s=${SERVICE_ID}`);
    await expect(page.locator("#view-invite-redeem")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#invite-redeem-content")).toContainText("Unlock this device to accept the invite.");
    await page.click("#ir-unlock");
    await expect(page.locator("#view-unlock")).toBeVisible();
    await page.fill("#unlock-passphrase", "correct-horse-battery-staple-gym");
    await page.click("#unlock-go");
    await expect(page.locator("#ir-accept")).toBeVisible({ timeout: 30_000 });
    await shot(page, testInfo, "invite-accept");
    await page.click("#ir-accept");
    await expect(page.locator("#invite-redeem-content")).toContainText("You're in", { timeout: 10_000 });
    await expect(page.locator("#invite-redeem-content")).toContainText(SERVICE_ID);

    // The raw secret goes to the box, signed with this person's id for that app only.
    const redeem = m.last(onHome("/api/service-invites/redeem"))!;
    expect(redeem.body.secret).toBe(SECRET);
    const check = await page.evaluate(
      async ({ body, ref }) => {
        const ks = await import("/keystore.js");
        const si = await import("/lib/serviceInvite.js");
        const { getSession } = await import("/lib/state.js");
        const umk = getSession().umk;
        const app = await ks.deriveAppAccountIdFromSeed(umk, ref);
        const global = await ks.deriveAccountIdFromSeed(umk);
        const secretHash = await si.serviceInviteSecretHash(ks.hexToBytes(body.secret));
        const bytes = si.canonicalRedeemBytes({ secretHash, visitorAID: ks.hexToBytes(body.visitorAID), redeemedAt: body.redeemedAt });
        return {
          appId: body.visitorAID === ks.bytesToHex(app.publicKey),
          notGlobal: body.visitorAID !== ks.bytesToHex(global.publicKey),
          signed: await ks.verifyWithEd25519Pub(app.publicKey, ks.hexToBytes(body.aidSig), bytes),
        };
      },
      { body: redeem.body, ref: SERVICE_ID },
    );
    expect(check).toEqual({ appId: true, notGlobal: true, signed: true });
    await shot(page, testInfo, "invite-in");
    await page.click("#ir-home");
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
  });

  test("gym members an approve-first invitee gets an acceptance code to copy and send back", async ({ page }, testInfo) => {
    await recordClipboardAndShare(page);
    const SECRET = "12".repeat(32);
    const AUTHOR = "34".repeat(32);
    const IID = "56".repeat(32);
    await createAccount(page);
    const m = await mock(page);
    m.post(onHome("/api/service-invites/redeem"), { pending: true, serviceRef: SERVICE_ID });
    await page.goto(`/invite#server=${HOME}&k=${SECRET}&a=${AUTHOR}&i=${IID}&s=${SERVICE_ID}`);
    await page.click("#ir-unlock", { timeout: 15_000 });
    await page.fill("#unlock-passphrase", "correct-horse-battery-staple-gym");
    await page.click("#unlock-go");
    await page.click("#ir-accept", { timeout: 30_000 });
    await expect(page.locator("#invite-redeem-content")).toContainText("Send this back to the owner", { timeout: 10_000 });
    const reply = await page.locator("#ir-accept-reply").inputValue();
    // An app link to the control apex, its details in the fragment.
    const u = new URL(reply);
    expect(u.pathname).toBe("/invite-accept");
    const p = new URLSearchParams(u.hash.slice(1));
    expect(p.get("server")).toBe(HOME);
    expect(p.get("iid")).toBe(IID);
    expect(p.get("ref")).toBe(SERVICE_ID);
    expect(p.get("sig")).toMatch(/^[0-9a-f]{128}$/);
    await expect(page.locator("#ir-accept-qr svg")).toBeVisible();
    await page.click("#ir-accept-copy");
    await sawToast(page, "Copied — send it to the owner.");
    expect(await clipboard(page)).toEqual([reply]);
    await page.click("#ir-accept-share");
    await expect.poll(() => shared(page)).toEqual([{ title: "Flagship acceptance", text: reply }]);
    await shot(page, testInfo, "invite-acceptance-code");
    await page.click("#ir-home");
    await expect(page.locator("#view-home")).toBeVisible({ timeout: 10_000 });
  });

  test("gym members internet access Ignore, Dismiss a suggestion and View access list", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin" });
    const list = "allow api.github.com\n";
    const draftList = "allow api.stripe.com\n";
    let draft: unknown = { list: draftList, listSha256: sha256(draftList), hosts: [{ host: "api.stripe.com", why: "Payments" }], createdAt: Date.now() };
    let pending = [{ host: "tracker.example.com", source: "attempt", attempts: 2 }];
    const state = () => ({ access: { list, listSha256: sha256(list), pending, draft } });
    const m = base(await mock(page), appDetail({}, { access: { rules: 1, pending: 1, draft: true } }));
    m.get(onHome(svc("/access")), () => ({ json: state() }));
    m.post(onHome(svc("/access/dismiss")), (c) => {
      pending = pending.filter((p) => p.host !== c.body.host);
      return { json: { ok: true } };
    });
    m.post(onHome(svc("/access/draft/dismiss")), () => {
      draft = null;
      return { json: state() };
    });
    await openApp(page);
    const section = page.locator("#sd-egress");
    await expect(section.locator('[data-access-host="tracker.example.com"]')).toBeVisible({ timeout: 10_000 });

    // Ignore drops the request; nothing is signed and the list doesn't change.
    await section.locator('[data-access-act="ignore"]').click();
    await expect(section.locator('[data-access-host="tracker.example.com"]')).toHaveCount(0);
    expect(m.last(svc("/access/dismiss"))!.body).toEqual({ host: "tracker.example.com" });
    expect(m.sent(onHome(svc("/access")))).toHaveLength(0);
    await expect(section.locator("#sd-access-count")).toHaveText("1 rule");

    // Dismiss drops the suggested list.
    await expect(section.locator("[data-access-draft]")).toContainText("api.stripe.com");
    await section.locator('[data-access-draft-act="dismiss"]').click();
    await expect(section.locator("[data-access-draft]")).toHaveCount(0);
    expect(m.sent(svc("/access/draft/dismiss"))).toHaveLength(1);
    await shot(page, testInfo, "access-ignored-dismissed");

    // View access list: the live list, not the draft; Refresh re-reads; Back returns.
    await section.locator("#sd-access-view").click();
    await expect(page.locator("#view-app-access")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#app-access-text")).toHaveValue(list);
    await expect(page.locator("[data-access-draft-note]")).toHaveCount(0);
    await expect(page.locator("#app-access-save")).toBeDisabled();
    const reads = () => m.sent(svc("/access"), "GET").length;
    const r0 = reads();
    await page.click("#app-access-refresh");
    await expect.poll(reads).toBeGreaterThan(r0);
    await page.click("#app-access-back");
    await expect(page.locator("#view-service-detail")).toBeVisible({ timeout: 10_000 });
  });

  test("gym members an older box's internet access is allowed and stopped with admin-root approvals", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin" });
    let approved: string[] = [];
    const m = base(await mock(page), () => appDetail({}, { egress: { declared: ["api.openai.com", "api.github.com"], approved } }));
    m.post(
      onHome(svc("/egress")),
      sensitive(page, keys, CANON.egress, (b) => ({ arg: b.grant, sig: b.signature }), (c) => {
        approved = c.body.grant.hosts;
        return { json: { egress: { declared: ["api.openai.com", "api.github.com"], approved } } };
      }),
    );
    await openApp(page);
    await expect(page.locator(".sd-egress-pending")).toContainText("api.openai.com", { timeout: 10_000 });
    await shot(page, testInfo, "egress-pending");
    await page.click("#sd-egress-allow");
    await sawToast(page, "Internet access allowed");
    const allow = m.last(svc("/egress"))!;
    expect(allow.body.grant).toMatchObject({ serverDomain: HOME, serviceId: SERVICE_ID, hosts: ["api.github.com", "api.openai.com"] });
    expect(await signer(page, keys, CANON.egress, allow.body.grant, allow.body.signature)).toBe("admin");
    await expect(page.locator(".sd-egress-approved")).toContainText("api.github.com");

    await page.click("#sd-egress-stop");
    await sawToast(page, "Internet access stopped");
    const stop = m.last(svc("/egress"))!;
    expect(stop.body.grant.hosts).toEqual([]);
    expect(await signer(page, keys, CANON.egress, stop.body.grant, stop.body.signature)).toBe("admin");
    await expect(page.locator("#sd-egress-allow")).toBeVisible();
    await shot(page, testInfo, "egress-stopped");
  });

  test("gym members a non-admin device sees an older box's egress read-only and gets no access alerts", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "non-admin" });
    const m = base(await mock(page), appDetail({}, { egress: { declared: ["api.openai.com"], approved: [] } }));
    m.get(onHome("/api/screens/access-requests"), {
      requests: [{ serviceId: SERVICE_ID, appName: "notes", host: "api.openai.com", source: "attempt", attempts: 1 }],
    });
    await openApp(page);
    await expect(page.locator(".sd-egress-pending")).toContainText("Only an admin device can change this app's internet access.", { timeout: 10_000 });
    await expect(page.locator("#sd-egress-allow")).toHaveCount(0);
    // The global alert can't be answered from here, so it never shows.
    await page.evaluate(() => navigator.serviceWorker?.dispatchEvent(new MessageEvent("message", { data: { type: "ACCESS_REQUESTS" } })));
    await page.evaluate(() => document.dispatchEvent(new CustomEvent("flagship:view-shown")));
    await expect(page.locator("[data-access-sheet]")).toHaveCount(0);
    expect(m.sent("/api/screens/access-requests", "GET")).toHaveLength(0);
    await shot(page, testInfo, "egress-non-admin");
  });

  test("gym members the access-request alert allows a host and opens the access list", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin" });
    let list = "allow api.github.com\n";
    let requests: Array<Record<string, unknown>> = [{ serviceId: SERVICE_ID, appName: "notes", host: "api.openai.com", source: "attempt", attempts: 3 }];
    const m = base(await mock(page));
    m.get(onHome("/api/screens/access-requests"), () => ({ json: { requests } }));
    m.get(onHome(svc("/access")), () => ({ json: { access: { list, listSha256: sha256(list), pending: [], draft: null } } }));
    m.post(
      onHome(svc("/access")),
      sensitive(page, keys, CANON.access, (b) => ({ arg: b.grant, sig: b.signature }), (c) => {
        list = c.body.list;
        requests = [];
        return { json: { access: { list, listSha256: sha256(list), pending: [], draft: null } } };
      }),
    );
    await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "ACCESS_REQUESTS" } })));
    const sheet = page.locator(".modal-overlay", { has: page.locator("[data-access-sheet]") });
    await expect(sheet.locator("[data-access-sheet]")).toHaveText("notes wants to reach api.openai.com", { timeout: 10_000 });
    await expect(sheet).toContainText("It tried to connect 3 times.");
    await shot(page, testInfo, "access-alert");
    await sheet.locator('[data-choice="allow"]').click();
    const answered = page.locator("[data-access-answered]");
    await expect(answered).toHaveText("notes can now reach api.openai.com", { timeout: 10_000 });
    const post = m.last(onHome(svc("/access")))!;
    expect(post.body.list).toBe("allow api.openai.com\nallow api.github.com\n");
    expect(await signer(page, keys, CANON.access, post.body.grant, post.body.signature)).toBe("admin");
    await shot(page, testInfo, "access-alert-answered");
    await page.locator('.modal-overlay [data-choice="view"]').click();
    await expect(page.locator("#view-app-access")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#app-access-text")).toHaveValue("allow api.openai.com\nallow api.github.com\n");
  });

  test("gym members the access alerts' Not now, Escape, Deny and Close, and a suggestion's Review", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin" });
    let list = "";
    const draftList = "allow api.stripe.com\n";
    const requests = [
      { kind: "draft", serviceId: SERVICE_ID, appName: "notes", hosts: [{ host: "api.stripe.com", why: "Payments" }], createdAt: Date.now() },
      { serviceId: SERVICE_ID, appName: "notes", host: "a.example.com", source: "app", attempts: 0 },
      { serviceId: SERVICE_ID, appName: "notes", host: "b.example.com", source: "attempt", attempts: 1 },
      { serviceId: SERVICE_ID, appName: "notes", host: "c.example.com", source: "attempt", attempts: 1 },
    ];
    const m = base(await mock(page));
    m.get(onHome("/api/screens/access-requests"), () => ({ json: { requests } }));
    m.get(onHome(svc("/access")), () => ({
      json: { access: { list, listSha256: sha256(list), pending: [], draft: { list: draftList, listSha256: sha256(draftList), hosts: [{ host: "api.stripe.com", why: "Payments" }], createdAt: Date.now() } } },
    }));
    m.post(
      onHome(svc("/access")),
      sensitive(page, keys, CANON.access, (b) => ({ arg: b.grant, sig: b.signature }), (c) => {
        list = c.body.list;
        return { json: { access: { list, listSha256: sha256(list), pending: [], draft: null } } };
      }),
    );
    const force = () => page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "ACCESS_REQUESTS" } })));
    await force();

    // The suggestion comes first: Not now.
    await expect(page.locator("[data-access-draft-sheet]")).toHaveText("notes suggests an access list", { timeout: 10_000 });
    await expect(page.locator(".modal-overlay")).toContainText("Payments");
    await shot(page, testInfo, "access-draft-alert");
    await page.locator('.modal-overlay [data-choice="later"]').click();
    // a: Not now. b: Escape.
    await expect(page.locator("[data-access-sheet]")).toHaveText("notes wants to reach a.example.com", { timeout: 10_000 });
    await expect(page.locator(".modal-overlay")).toContainText("It asked for this when it was installed.");
    await page.locator('.modal-overlay [data-choice="later"]').click();
    await expect(page.locator("[data-access-sheet]")).toHaveText("notes wants to reach b.example.com", { timeout: 10_000 });
    await page.keyboard.press("Escape");
    // c: Deny, then Close.
    await expect(page.locator("[data-access-sheet]")).toHaveText("notes wants to reach c.example.com", { timeout: 10_000 });
    expect(m.sent(onHome(svc("/access")))).toHaveLength(0);
    await page.locator('.modal-overlay [data-choice="deny"]').click();
    await expect(page.locator("[data-access-answered]")).toHaveText("notes won't reach c.example.com", { timeout: 10_000 });
    const deny = m.last(onHome(svc("/access")))!;
    expect(deny.body.list).toBe("deny c.example.com\n");
    expect(await signer(page, keys, CANON.access, deny.body.grant, deny.body.signature)).toBe("admin");
    await page.locator('.modal-overlay [data-choice="close"]').click();
    await expect(page.locator(".modal-overlay")).toHaveCount(0);

    // Put off or answered, none comes back on the next check.
    const fetches = m.sent("/api/screens/access-requests", "GET").length;
    await force();
    await expect.poll(() => m.sent("/api/screens/access-requests", "GET").length).toBeGreaterThan(fetches);
    await expect(page.locator(".modal-overlay")).toHaveCount(0);
    expect(m.sent(onHome(svc("/access")))).toHaveLength(1);

    // A fresh suggestion's Review opens the editor on it.
    requests.splice(0, requests.length, { kind: "draft", serviceId: SERVICE_ID, appName: "notes", hosts: [{ host: "api.stripe.com", why: "Payments" }], createdAt: Date.now() + 1000 });
    await force();
    await page.locator('.modal-overlay [data-choice="review"]').click({ timeout: 10_000 });
    await expect(page.locator("#view-app-access")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("[data-access-draft-note]")).toBeVisible();
    await expect(page.locator("#app-access-text")).toHaveValue(draftList);
    await shot(page, testInfo, "access-draft-review");
  });

  test("gym members a demo account allows an access request with the IRK", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "demo" });
    let list = "";
    let pending = [{ host: "api.openai.com", source: "attempt", attempts: 1 }];
    const m = base(await mock(page), appDetail({}, { access: { rules: 0, pending: 1, draft: false } }));
    m.get(onHome(svc("/access")), () => ({ json: { access: { list, listSha256: sha256(list), pending, draft: null } } }));
    m.post(
      onHome(svc("/access")),
      sensitive(page, keys, CANON.access, (b) => ({ arg: b.grant, sig: b.signature }), (c) => {
        list = c.body.list;
        pending = [];
        return { json: { access: { list, listSha256: sha256(list), pending, draft: null } } };
      }),
    );
    await openApp(page);
    await page.locator('#sd-egress [data-access-act="allow"]').click({ timeout: 10_000 });
    await sawToast(page, "notes can now reach api.openai.com");
    const post = m.last(onHome(svc("/access")))!;
    expect(await signer(page, keys, CANON.access, post.body.grant, post.body.signature)).toBe("irk");
    await shot(page, testInfo, "demo-access-allowed");
  });

  test("gym members API keys: Read & write by Enter, Copy the secret, Cancel and a cancelled revoke", async ({ page }, testInfo) => {
    await recordClipboardAndShare(page);
    const keys = await reachHome(page, { kind: "admin" });
    const OLD = { keyId: "0123456789abcdef", label: "Old script", scope: "read", createdAt: Date.now() - 86_400_000, lastUsedAt: 0, expiresAt: 0 };
    let list: Array<Record<string, unknown>> = [OLD];
    let secret = "";
    const m = base(await mock(page));
    m.get(onHome(svc("/api-keys")), () => ({ json: { keys: list } }));
    m.post(
      onHome(svc("/api-keys")),
      sensitive(page, keys, CANON.apiKey, (b) => ({ arg: b.grant, sig: b.signature }), (c) => {
        const g = c.body.grant;
        secret = `fsk_${g.keyId}_gymSecret0123456789`;
        list = [{ keyId: g.keyId, label: c.body.label, scope: g.scope, createdAt: g.issuedAt, lastUsedAt: 0, expiresAt: 0 }, ...list];
        return { json: { key: secret, keyId: g.keyId } };
      }),
    );
    await openApp(page);
    const section = page.locator("#sd-api-keys");
    await expect(section.locator(`[data-api-key="${OLD.keyId}"]`)).toBeVisible({ timeout: 10_000 });

    // Cancel closes the form and sends nothing.
    await page.click("#sd-api-key-new");
    await page.click("#sd-api-key-cancel");
    await expect(page.locator("#sd-api-key-label")).toHaveCount(0);
    await expect(page.locator("#sd-api-key-new")).toBeVisible();
    expect(m.sent(svc("/api-keys"))).toHaveLength(0);

    // Read & write, created with Enter.
    await page.click("#sd-api-key-new");
    await page.selectOption("#sd-api-key-scope", "write");
    await page.fill("#sd-api-key-label", "Sync job");
    await page.press("#sd-api-key-label", "Enter");
    await expect(page.locator("#sd-api-key-secret")).toHaveText(/^fsk_[0-9a-f]{16}_gymSecret/, { timeout: 10_000 });
    const post = m.last(svc("/api-keys"))!;
    expect(post.body.label).toBe("Sync job");
    expect(post.body.grant.scope).toBe("write");
    expect(await signer(page, keys, CANON.apiKey, post.body.grant, post.body.signature)).toBe("admin");
    await expect(section.locator(`[data-api-key="${post.body.grant.keyId}"] .pill`)).toHaveText("Read & write");

    await page.click("#sd-api-key-copy");
    await sawToast(page, "Copied.");
    expect(await clipboard(page)).toEqual([secret]);
    await shot(page, testInfo, "api-key-write-copied");
    await page.click("#sd-api-key-done");

    // Revoke asks; Cancel keeps the key.
    await section.locator(`[data-api-key="${OLD.keyId}"] [data-api-key-revoke]`).click();
    await expect(page.locator(".modal-title")).toHaveText('Revoke "Old script"?');
    await page.click("[data-modal-cancel]");
    await expect(section.locator(`[data-api-key="${OLD.keyId}"]`)).toBeVisible();
    expect(m.sent(svc("/api-keys/"), "DELETE")).toHaveLength(0);
  });

  test("gym members the database pages a table, exports CSV and runs SQL on a second store", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin" });
    const m = base(await mock(page));
    m.get(onHome(svc("/db")), {
      stores: [
        { store: "default", tables: [{ name: "items", kind: "table", rows: 250, bytes: 65_536 }] },
        { store: "analytics", tables: [{ name: "events", kind: "table", rows: 3, bytes: 8_192 }] },
      ],
    });
    m.get((u) => u.host === HOME && u.pathname === svc("/db/default/tables/items"), (c) => {
      const offset = Number(c.url.searchParams.get("offset"));
      const n = Math.min(100, 250 - offset);
      return { json: { columns: [{ name: "id", type: "int4" }], rows: Array.from({ length: n }, (_, i) => [offset + i + 1]), total: 250 } };
    });
    m.get(onHome(svc("/db/default/tables/items/export.csv")), (c) =>
      c.headers["x-flagship-session"]
        ? { raw: "id\n1\n2\n", contentType: "text/csv", headers: { "content-disposition": 'attachment; filename="items.csv"' } }
        : { status: 401, json: { error: "missing session" } },
    );
    m.post(
      onHome(svc("/db/analytics/query")),
      async (c) => {
        if (!c.body.signature) {
          return /^select/i.test(c.body.sql)
            ? { json: { command: "SELECT", rowCount: 1, columns: [{ name: "n", type: "int8" }], rows: [[3]] } }
            : { status: 400, json: { error: "this statement changes data", needsGrant: true } };
        }
        return sensitive(page, keys, CANON.dbWrite, (b) => ({ arg: b.grant, sig: b.signature }), () => ({ json: { command: "DELETE", rowCount: 3, columns: [], rows: [] } }))(c);
      },
    );
    await openApp(page);
    await page.click("#sd-db-open", { timeout: 10_000 });
    await expect(page.locator('[data-db-store-card="analytics"]')).toContainText("analytics", { timeout: 10_000 });

    await page.click('[data-db-table="items"]');
    await expect(page.locator("#app-db-range")).toHaveText("Rows 1–100 of 250", { timeout: 10_000 });
    await expect(page.locator("#app-db-prev")).toBeDisabled();
    await page.click("#app-db-next");
    await expect(page.locator("#app-db-range")).toHaveText("Rows 101–200 of 250", { timeout: 10_000 });
    expect(m.last(svc("/db/default/tables/items"), "GET")!.url.searchParams.get("offset")).toBe("100");
    await page.click("#app-db-prev");
    await expect(page.locator("#app-db-range")).toHaveText("Rows 1–100 of 250", { timeout: 10_000 });
    const tableReads = () => m.sent(svc("/db/default/tables/items"), "GET").filter((c) => !c.url.pathname.endsWith(".csv")).length;
    const t0 = tableReads();
    await page.click("#app-db-refresh");
    await expect.poll(tableReads).toBeGreaterThan(t0);
    await shot(page, testInfo, "db-paged");

    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#app-db-export")]);
    expect(download.suggestedFilename()).toBe("items.csv");
    const saved = testInfo.outputPath("items.csv");
    await download.saveAs(saved);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(saved, "utf8")).toBe("id\n1\n2\n");

    // Back to the tables, then SQL on the analytics store.
    await page.click("#app-db-back");
    await page.click("#app-db-sql");
    await page.selectOption("#app-db-store", "analytics");
    await page.fill("#app-db-sql-text", "SELECT count(*) AS n FROM events");
    await page.click("#app-db-run");
    await expect(page.locator("[data-db-result]")).toContainText("SELECT · 1 row", { timeout: 10_000 });
    // A write asks first; editing the statement withdraws the question.
    await page.fill("#app-db-sql-text", "DELETE FROM events");
    await page.click("#app-db-run");
    await expect(page.locator("#app-db-confirm")).toBeVisible({ timeout: 10_000 });
    await page.fill("#app-db-sql-text", "DELETE FROM events WHERE true");
    await expect(page.locator("#app-db-confirm")).toHaveCount(0);
    await page.click("#app-db-run");
    await page.click("#app-db-confirm", { timeout: 10_000 });
    await expect(page.locator("[data-db-result]")).toContainText("DELETE · 3 rows", { timeout: 10_000 });
    const writes = m.sent(svc("/db/analytics/query")).filter((c) => c.body.signature);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body.grant).toMatchObject({ store: "analytics", sqlSha256: sha256("DELETE FROM events WHERE true") });
    expect(await signer(page, keys, CANON.dbWrite, writes[0]!.body.grant, writes[0]!.body.signature)).toBe("admin");
    expect(m.sent(svc("/db/default/query"))).toHaveLength(0);
    await shot(page, testInfo, "db-second-store");

    // Back twice: tables, then the app page.
    await page.click("#app-db-back");
    await expect(page.locator('[data-db-table="items"]')).toBeVisible({ timeout: 10_000 });
    await page.click("#app-db-back");
    await expect(page.locator("#view-service-detail")).toBeVisible({ timeout: 10_000 });
  });

  test("gym members Remove app: Cancel keeps it, Remove signs the uninstall and returns to the list", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin" });
    const m = base(await mock(page));
    m.on(
      "DELETE",
      onHome(`/api/services/${SERVICE_ID}`),
      sensitive(page, keys, CANON.uninstall, (b) => ({ arg: b.request, sig: b.signature }), () => ({ json: { ok: true } })),
    );
    await openApp(page);
    const btn = page.locator("#service-detail-remove-btn");
    await expect(btn).toHaveText("Remove app");
    await btn.click();
    await expect(page.locator(".modal-title")).toHaveText("Remove this app?");
    await expect(page.locator(".modal-message")).toContainText(`This uninstalls notes from ${HOME} and deletes its data there.`);
    await page.click("[data-modal-cancel]");
    expect(m.sent(`/api/services/${SERVICE_ID}`, "DELETE")).toHaveLength(0);

    await btn.click();
    await page.click("[data-modal-ok]");
    await sawToast(page, "Removed notes.");
    await expect(page.locator("#view-services-list")).toBeVisible({ timeout: 10_000 });
    const del = m.last(`/api/services/${SERVICE_ID}`, "DELETE")!;
    expect(del.body.request).toMatchObject({ serverId: HOME, creator: "smoketest", slug: "notes" });
    expect(await signer(page, keys, CANON.uninstall, del.body.request, del.body.signature)).toBe("admin");
    await shot(page, testInfo, "app-removed");
  });

  test("gym members Edit this service: describe a change with AI, the refusals, and your IDE", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin" });
    await page.evaluate(async () => {
      const { addProvider } = await import("/providers.js");
      const { getSession } = await import("/lib/state.js");
      await addProvider(getSession().umk, { provider: "openai", label: "Work key", apiKey: "sk-gymfixture-0123456789abcdef", relay: true });
    });
    const m = base(await mock(page), appDetail({ editable: true }));
    const answers = [
      { status: 413, json: { error: "This service has 4 MB of code; the AI chat takes up to 1 MB." } },
      { status: 409, json: { ok: false, kind: "session", error: "busy" } },
      { json: { sessionId: "sess-edit-1", status: "running" } },
    ];
    m.post(onHome("/api/screens/vibe-code/start"), () => answers.shift() ?? { json: { sessionId: "sess-edit-1" } });
    m.post(onHome("/api/build/mcp"), { buildId: "b-ide-1", connection: { url: `https://${HOME}/mcp`, key: "mcp_key", ideConfig: { mcpServers: {} } } });
    await openApp(page);
    await page.click("#sd-edit");
    await expect(page.locator("#view-edit-service")).toBeVisible();
    await expect(page.locator("#edit-service-title")).toHaveText("Edit notes");
    await shot(page, testInfo, "edit-chooser");

    // Describe the change: the AI-key step, then "What should change?".
    await page.click("#edit-service-ai");
    await expect(page.locator("#view-build-key")).toBeVisible({ timeout: 10_000 });
    await page.locator("#build-key-saved [data-use-id]").first().click({ timeout: 10_000 });
    await expect(page.locator("#view-edit-describe")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#edit-describe-start")).toBeDisabled();
    await page.fill("#edit-describe-prompt", "Add a due date to each note");
    await expect(page.locator("#edit-describe-start")).toBeEnabled();

    // Too big for the chat: offered the IDE.
    await page.click("#edit-describe-start");
    await expect(page.locator(".modal-title")).toHaveText("Too big for the AI chat", { timeout: 10_000 });
    await expect(page.locator(".modal-message")).toHaveText("This service has 4 MB of code; the AI chat takes up to 1 MB.");
    await page.click("[data-modal-cancel]");
    // Already being changed: OK leaves it.
    await page.click("#edit-describe-start");
    await expect(page.locator(".modal-title")).toHaveText("Already being changed", { timeout: 10_000 });
    await page.click("[data-modal-cancel]");
    await expect(page.locator("#view-edit-describe")).toBeVisible();
    // Started: the chat opens on the box's session for this service.
    await page.click("#edit-describe-start");
    await expect(page.locator("#view-vibe-code")).toBeVisible({ timeout: 10_000 });
    const starts = m.sent("/api/screens/vibe-code/start");
    expect(starts).toHaveLength(3);
    expect(starts[2]!.body).toMatchObject({ prompt: "Add a due date to each note", editServiceId: SERVICE_ID });
    expect(starts[2]!.body.credential.apiKey).toBe("sk-gymfixture-0123456789abcdef");

    // Your IDE: the connect screen for this service; its Back returns to the chooser.
    await openApp(page);
    await page.click("#sd-edit");
    await page.click("#edit-service-ide");
    await expect(page.locator("#view-build-mcp")).toBeVisible();
    await expect(page.locator("#build-mcp-intro")).toContainText("Your editor's agent changes notes on your server");
    await page.click("#build-mcp-create");
    await expect(page.locator("#mcp-key")).toHaveText("mcp_key", { timeout: 10_000 });
    expect(m.last(onHome("/api/build/mcp"))!.body).toEqual({ label: "webapp", editServiceId: SERVICE_ID });
    await shot(page, testInfo, "edit-ide");
    await page.click("#build-mcp-back");
    await expect(page.locator("#view-edit-service")).toBeVisible();
    // The describe screen's Back, then the chooser's Back.
    await page.click("#edit-service-ai");
    await page.locator("#build-key-saved [data-use-id]").first().click({ timeout: 10_000 });
    await page.click("#edit-describe-back");
    await expect(page.locator("#view-edit-service")).toBeVisible();
    await page.click("#edit-service-back");
    await expect(page.locator("#view-service-detail")).toBeVisible({ timeout: 10_000 });
  });

  test("gym members Configure environment saves and removes a variable", async ({ page }, testInfo) => {
    const keys = await reachHome(page, { kind: "admin" });
    let names = ["OPENAI_API_KEY"];
    const m = base(await mock(page));
    m.get(onHome(svc("/env")), () => ({ json: { names } }));
    m.post(onHome(svc("/env/set")), (c) => {
      names = [...new Set([...names, c.body.name])].sort();
      return { json: { ok: true } };
    });
    m.post(onHome(svc("/env/unset")), (c) => {
      names = names.filter((n) => n !== c.body.name);
      return { json: { ok: true } };
    });
    await openApp(page);
    await page.click("#sd-configure-env");
    await expect(page.locator("#view-service-env")).toBeVisible();
    await expect(page.locator('.service-env-row[data-name="OPENAI_API_KEY"]')).toBeVisible({ timeout: 10_000 });

    await page.click("#service-env-save");
    await sawToast(page, "Name required");
    await page.fill("#service-env-name", "STRIPE_KEY");
    await page.fill("#service-env-value", "sk_live_gym_value");
    await page.click("#service-env-save");
    await sawToast(page, "Saved");
    await expect(page.locator("#service-env-value")).toHaveValue("");
    await expect(page.locator('.service-env-row[data-name="STRIPE_KEY"]')).toBeVisible();
    const set = m.last(svc("/env/set"))!;
    expect(set.body.name).toBe("STRIPE_KEY");
    expect(set.body.request).toMatchObject({ serverId: HOME, creator: "smoketest", slug: "notes", env: { STRIPE_KEY: "sk_live_gym_value" } });
    // The box takes the env order under the IRK (servicePlatform verifyHostAuthority).
    expect(await signer(page, keys, CANON.env, set.body.request, set.body.signature)).toBe("irk");
    // The value never shows on the page.
    await expect(page.locator("#view-service-env")).not.toContainText("sk_live_gym_value");
    await shot(page, testInfo, "env-saved");

    page.once("dialog", (d) => void d.accept());
    await page.locator('.service-env-row[data-name="OPENAI_API_KEY"] .service-env-remove').click();
    await expect(page.locator('.service-env-row[data-name="OPENAI_API_KEY"]')).toHaveCount(0, { timeout: 10_000 });
    const unset = m.last(svc("/env/unset"))!;
    expect(unset.body.name).toBe("OPENAI_API_KEY");
    expect(Object.keys(unset.body.request.env)).not.toContain("OPENAI_API_KEY");
    expect(await signer(page, keys, CANON.env, unset.body.request, unset.body.signature)).toBe("irk");

    page.once("dialog", (d) => void d.dismiss());
    await page.locator('.service-env-row[data-name="STRIPE_KEY"] .service-env-remove').click();
    await expect(page.locator('.service-env-row[data-name="STRIPE_KEY"]')).toBeVisible();
    expect(m.sent(svc("/env/unset"))).toHaveLength(1);

    await page.fill("#service-env-value", "typed but not saved");
    await page.click("#service-env-back");
    await expect(page.locator("#view-service-detail")).toBeVisible();
    await expect(page.locator("#service-env-value")).toHaveValue("");
  });

  test("gym members Report a problem with the adapter: Cancel, then send the note", async ({ page }, testInfo) => {
    await reachHome(page, { kind: "admin" });
    const m = base(await mock(page), appDetail({ adaptedFrom: { repo: "github.com/acme/notes" } }));
    m.post(onHome(`/api/screens/adapter-report/${SERVICE_ID}`), { ok: true });
    await openApp(page);
    await expect(page.locator("#sd-report-adapter")).toContainText("It was set up from a shared adaptation of github.com/acme/notes");
    await page.click("#sd-report-adapter");
    await expect(page.locator(".modal-title")).toHaveText("Report a problem");
    await page.click("[data-report-cancel]");
    await expect(page.locator(".modal-overlay")).toHaveCount(0);

    await page.click("#sd-report-adapter");
    await expect(page.locator("#adapter-report-send")).toBeDisabled();
    await page.fill("#adapter-report-text", "  The upload page 500s.  ");
    await expect(page.locator("[data-report-count]")).toHaveText("25 / 2000");
    await page.click("#adapter-report-send");
    await expect(page.locator("[data-report-sent]")).toContainText("Sent. Thank you.", { timeout: 10_000 });
    expect(m.last(`/api/screens/adapter-report/${SERVICE_ID}`)!.body).toEqual({ detail: "The upload page 500s." });
    await shot(page, testInfo, "adapter-report-sent");
    await page.click("[data-report-done]");
    await expect(page.locator(".modal-overlay")).toHaveCount(0);
  });

  test("gym members web domains copy their links and Replace renames the stem", async ({ page }, testInfo) => {
    await recordClipboardAndShare(page);
    const keys = await reachHome(page, { kind: "admin" });
    let links = { serviceId: SERVICE_ID, displayLabel: "notes", shortUrl: "https://voi.ci/n0tes", canonicalUrl: "https://notes.smoketest.flagship.services", instances: [] as unknown[] };
    const m = base(await mock(page));
    m.get(`/api/users/smoketest/apps/${SERVICE_ID}/links`, () => ({ json: links }));
    m.post(`/api/users/smoketest/apps/${SERVICE_ID}/rename`, async (c) => {
      if ((await signer(page, keys, CANON.rename, c.body.request, c.body.signature)) !== "irk") return { status: 403, json: { error: "invalid signature" } };
      links = { ...links, displayLabel: c.body.request.newDisplayLabel, shortUrl: "https://voi.ci/j0ts", canonicalUrl: "https://jots.smoketest.flagship.services" };
      return { json: { displayLabel: links.displayLabel, shortUrl: links.shortUrl, canonicalUrl: links.canonicalUrl } };
    });
    await openApp(page);
    await page.locator('[data-section="short"] [data-copy]').click({ timeout: 10_000 });
    await page.locator('[data-section="canonical"] [data-copy]').click();
    await expect.poll(() => clipboard(page)).toEqual(["https://voi.ci/n0tes", "https://notes.smoketest.flagship.services"]);

    // The stem is asked in a prompt: each click answers the next one queued.
    const answers: Array<string | null> = [];
    page.on("dialog", (d) => {
      const a = answers.shift();
      void (a === null || a === undefined ? d.dismiss() : d.accept(a));
    });
    // Cancelling the prompt, a bad stem, then cancelling the confirm: nothing sent.
    answers.push(null);
    await page.click("#sd-replace-stem");
    await expect.poll(() => answers.length).toBe(0);
    answers.push("Bad Stem!");
    await page.click("#sd-replace-stem");
    await sawToast(page, "Stem must be a DNS label");
    answers.push("jots");
    await page.click("#sd-replace-stem");
    await expect(page.locator(".modal-title")).toHaveText("Replace stem with 'jots'?");
    await page.click("[data-modal-cancel]");
    expect(m.sent("/rename")).toHaveLength(0);

    answers.push("jots");
    await page.click("#sd-replace-stem");
    await page.click("[data-modal-ok]");
    await sawToast(page, "Renamed to jots. New short link minted.");
    await expect(page.locator('[data-section="short"] a')).toContainText("voi.ci/j0ts", { timeout: 10_000 });
    expect(m.last("/rename")!.body.request).toMatchObject({ username: "smoketest", serviceId: SERVICE_ID, newDisplayLabel: "jots" });
    await shot(page, testInfo, "domains-renamed");
  });

  test("gym members an IRK-signed app order is refused the way an admin-pinned box refuses it", async ({ page }, testInfo) => {
    // The mock's rule itself: a non-admin device's IRK signature over an
    // access list gets the box's 403, an admin root one passes.
    const keys = await reachHome(page, { kind: "admin" });
    const grant = { serverDomain: HOME, serviceId: SERVICE_ID, listSha256: sha256("allow a.example.com\n"), issuedAt: Date.now() };
    const sigs = await page.evaluate(async (grant) => {
      const ks = await import("/keystore.js");
      const a = await import("/lib/appAccess.js");
      const { getSession } = await import("/lib/state.js");
      const bytes = a.canonicalAppAccessBytes(grant);
      return {
        irk: ks.bytesToHex(await ks.signWithIrk(getSession().umk, bytes)),
        admin: ks.bytesToHex(await ks.signWithAdminRoot(getSession().adminRootSeed, bytes)),
      };
    }, grant);
    const rule = sensitive(page, keys, CANON.access, (b) => ({ arg: b.grant, sig: b.signature }), () => ({ json: { ok: true } }));
    const call = (signature: string) => rule({ method: "POST", url: new URL(`https://${HOME}${svc("/access")}`), body: { grant, signature }, headers: {} });
    expect(await call(sigs.irk)).toEqual({ status: 403, json: { error: REFUSED_NOT_ADMIN } });
    expect(await call(sigs.admin)).toEqual({ json: { ok: true } });
    await shot(page, testInfo, "mock-refuses-irk");
  });
});
