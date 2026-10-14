// Share this server on the webapp (docs/share-a-server.md §9): the owner's and
// the other account's flows against the real `.com` handlers (InMemory) and the
// real box share routes, over a mocked fetch. Then link parsing at boot and the
// shared server's page, which must carry none of the owner's sections.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveIRK,
  deriveShareMemberKey,
  verifyAppAccessGrant,
  verifyServerShareGrant,
  verifyServerShareRevoke,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleAcceptServerShare,
  handleCreateServerShare,
  handleGetServerShare,
  handleLeaveServerShare,
  handleListServerShares,
  handleRevokeServerShare,
  handleServerShareUnlock,
  handleShareInbox,
} from "@flagship/control-plane";
import { ShareStore } from "../../../packages/server-daemon/src/shares/shareStore.js";
import { ActivityLog } from "../../../packages/server-daemon/src/shares/activityLog.js";
import { ShareSessionStore, buildShares } from "../../../packages/server-daemon/src/shares/sharesHttp.js";

const enterShareAccept = vi.fn(async () => {});
vi.mock("../public/webapp/views/share-accept.js", () => ({ enterShareAccept }));
vi.mock("../public/webapp/lib/toast.js", () => ({ toast: vi.fn() }));

import * as shares from "../public/webapp/lib/serverShares.js";
import { parseShareLink, formatShareSas } from "../public/webapp/lib/serverShare.js";
import { _internal as bootSeal } from "../public/webapp/lib/bootApproval.js";
import { ScreensError } from "../public/webapp/lib/api.js";
import { getSession } from "../public/webapp/lib/state.js";
import { dispatchInitialView } from "../public/webapp/lib/deepLink.js";
import { sharedServerHtml, enterSharedServer } from "../public/webapp/views/shared-server.js";
import { sharesListHtml } from "../public/webapp/views/server-sharing.js";

const S = "home.alice.flagship.services";
const APEX = "https://flagshipserver.com";
const BOOT = "https://boot.flagshipserver.com";
const umkA = new Uint8Array(32).fill(11);
const umkB = new Uint8Array(32).fill(22);
const umkC = new Uint8Array(32).fill(44);
const owner = deriveIRK({ seed: umkA });
const stk = deriveIRK({ seed: new Uint8Array(32).fill(33) });
const impostor = deriveIRK({ seed: new Uint8Array(32).fill(55) });
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

type Init = { method?: string; headers?: Record<string, string>; body?: string };

async function world() {
  const storage = new InMemoryStorage();
  await storage.usernames.put({ username: "alice", irkPubHex: hex(owner.publicKey), claimedAt: 1 });
  await storage.servers.put({ serverDomain: S, username: "alice", identityPubKeyHex: hex(stk.publicKey), registeredAt: 1 });
  const com = { shares: storage.serverShares, usernames: storage.usernames, servers: storage.servers };
  const store = new ShareStore(null, {
    serverDomain: S,
    verifyOwnerGrant: (g, sig) => verifyServerShareGrant(g, sig, owner.publicKey),
  });
  const box = buildShares({
    serverDomain: S,
    store,
    sessions: new ShareSessionStore(null),
    activity: new ActivityLog(null),
    verifyOwnerRevoke: (r, sig) => verifyServerShareRevoke(r, sig, owner.publicKey),
    log: () => {},
  });
  const gate = box.gate({ check: () => ({ status: 401, body: "owner session required" }) });
  const diskKey = crypto.getRandomValues(new Uint8Array(32));
  const sealedLuks = hex(await bootSeal.sealForBoxStk(diskKey, owner.publicKey));
  const log: string[] = [];
  const boxPosts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const accessPosts: Array<{ serviceId: string; body: Record<string, unknown>; memberPubHex: string }> = [];
  const boot = { requests: [] as unknown[], responses: [] as Array<Record<string, unknown>> };

  const reply = (status: number, body: unknown) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = async (input: string, init: Init = {}) => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body ? JSON.parse(init.body) : undefined;
    log.push(`${method} ${url.host}${url.pathname}`);
    const p = url.pathname;
    let m: RegExpMatchArray | null;
    if (url.origin === APEX) {
      const token = headers["x-flagship-share-token"] ?? null;
      let r: { status: number; body: unknown } | null = null;
      if (method === "POST" && p === "/api/users/alice/server-shares") r = await handleCreateServerShare(com, "alice", body);
      else if (method === "POST" && p === "/api/users/alice/server-shares/list") r = await handleListServerShares(com, "alice", body);
      else if (method === "POST" && (m = p.match(/^\/api\/users\/alice\/server-shares\/([0-9a-f]{32})\/revoke$/))) r = await handleRevokeServerShare(com, "alice", m[1]!, body);
      else if (method === "POST" && (m = p.match(/^\/api\/users\/alice\/server-shares\/([0-9a-f]{32})\/unlock$/))) r = await handleServerShareUnlock(com, "alice", m[1]!, body);
      else if (method === "GET" && (m = p.match(/^\/api\/server-shares\/([0-9a-f]{32})$/))) r = await handleGetServerShare(com, m[1]!, token);
      else if (method === "POST" && (m = p.match(/^\/api\/server-shares\/([0-9a-f]{32})\/accept$/))) r = await handleAcceptServerShare(com, m[1]!, token, body);
      else if (method === "POST" && (m = p.match(/^\/api\/server-shares\/([0-9a-f]{32})\/leave$/))) r = await handleLeaveServerShare(com, m[1]!, token, body);
      else if (method === "POST" && p === "/api/share-inbox") r = await handleShareInbox(com, body);
      else if (method === "GET" && p === `/api/server/${S}/sealed-luks-key`) r = { status: 200, body: { sealedKey: sealedLuks } };
      return r ? reply(r.status, r.body) : reply(404, { error: "no route" });
    }
    if (url.origin === BOOT) {
      const auth = JSON.parse(Buffer.from(String(headers.authorization).split(" ")[1]!, "base64url").toString("utf8"));
      const { signatureHex, ...env } = auth;
      const { ed25519 } = await import("@noble/curves/ed25519.js");
      expect(env).toMatchObject({ role: "share", serverDomain: S, method, path: p });
      expect(ed25519.verify(fromHex(signatureHex), bootSeal.canonicalBootAuth(env), fromHex(env.pubKeyHex))).toBe(true);
      const rows = await Promise.all((await storage.serverShares.listForOwner("alice")).map((r) => storage.serverShares.getUnlock(r.shareId)));
      const mine = rows.find((u) => u && u.memberPubHex === env.pubKeyHex);
      if (!mine) return reply(403, { error: "this share can't unlock this server" });
      if (p === `/api/boot/share/pending/${S}`) return reply(200, { requests: boot.requests });
      if (p === `/api/boot/share/key/${S}`) return reply(200, { sealedKey: mine.sealedKeyHex });
      if (p === "/api/boot/response" && method === "POST") {
        boot.responses.push(body.response);
        return reply(200, { ok: true });
      }
      return reply(404, { error: "no route" });
    }
    if (url.host === S) {
      const req = { method, path: `${p}${url.search}`, headers, body: Buffer.from(init.body ?? "") };
      if (p.startsWith("/api/shares/")) {
        const r = await box.handlePublic(req);
        return reply(r!.status, r!.body as string);
      }
      const refused = gate.check(req);
      if (refused) return reply(refused.status, refused.body as string);
      if (p === "/api/screens/server-detail") return reply(200, { serverFqdn: S, username: "alice", currentCommit: "c".repeat(40), uptimeMs: 7_200_000, serviceCount: 1 });
      if (p === "/api/screens/apps-list") return reply(200, { apps: [{ serviceId: "notes", slug: "notes", url: "https://notes.home.alice.flagship.services", status: "running" }] });
      if (p === "/api/screens/services/notes/access" && method === "GET") return reply(200, { access: { list: "", listSha256: "" } });
      if (p === "/api/screens/services/notes/access" && method === "POST") {
        const caller = (await import("../../../packages/server-daemon/src/shares/sharesHttp.js")).shareCallerOf(req);
        accessPosts.push({ serviceId: "notes", body, memberPubHex: caller!.memberPubHex });
        return reply(200, { access: { list: body.list, listSha256: body.grant.listSha256 } });
      }
      return reply(404, { error: "no route" });
    }
    return reply(404, { error: "unknown host" });
  };

  const boxFetch = async (fqdn: string, path: string, init: Init = {}) => {
    expect(fqdn).toBe(S);
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (body) boxPosts.push({ path, body });
    const r = await box.handleOwner(path.split("?")[0]!, method, { method, path, headers: {}, body: Buffer.from(init.body ?? "") });
    const parsed = r ? JSON.parse(String(r.body)) : { error: "no route" };
    const status = r?.status ?? 404;
    if (status >= 400) throw new ScreensError(parsed.error ?? `HTTP ${status}`, status, parsed);
    return parsed;
  };

  const depsA = { fetch: fetchImpl, apex: APEX, boot: BOOT, umk: umkA, username: "alice", boxFetch };
  const depsB = { fetch: fetchImpl, apex: APEX, boot: BOOT, umk: umkB, username: "bob" };
  return { storage, store, box, diskKey, log, boxPosts, accessPosts, boot, fetchImpl, depsA, depsB };
}

type World = Awaited<ReturnType<typeof world>>;

async function offerTo(w: World, over: Record<string, unknown> = {}) {
  return shares.createShareOffer(
    { serverDomain: S, serverName: "home", stkPubHex: hex(stk.publicKey), label: "Sam", level: "manage", unlockAtBoot: true, seeAppData: false, ...over },
    w.depsA,
  );
}

/** Offer → B accepts → A confirms. */
async function sharedWithB(w: World, over: Record<string, unknown> = {}) {
  const created = await offerTo(w, over);
  const link = parseShareLink(created.link)!;
  const opened = await shares.openShareLink(link, w.depsB);
  const accepted = await shares.acceptShare(opened, w.depsB);
  const state = await shares.loadOwnerShares(S, w.depsA);
  await shares.confirmShare(S, state.awaiting[0], w.depsA);
  return { created, link, accepted, entry: accepted.entry };
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("share this server — owner and member flows", () => {
  it("offer → accept → the same code on both sides → a grant the box takes", async () => {
    const w = await world();
    const created = await offerTo(w);
    expect(created.link).toMatch(new RegExp(`^${APEX}/share#s=[0-9a-f]{32}&k=[0-9a-f]{64}$`));
    const link = parseShareLink(created.link)!;
    expect(link.shareId).toBe(created.shareId);

    const opened = await shares.openShareLink(link, w.depsB);
    expect(opened.offer).toMatchObject({ serverDomain: S, serverName: "home", level: "manage", unlockAtBoot: true, seeAppData: false });
    expect(opened.offer.stkPubHex).toBe(hex(stk.publicKey));

    const before = await shares.loadOwnerShares(S, w.depsA);
    expect(before.offered.map((o) => o.label)).toEqual(["Sam"]);
    expect(before.awaiting).toEqual([]);

    const accepted = await shares.acceptShare(opened, w.depsB);
    expect(accepted.sas).toMatch(/^\d{3} \d{3}$/);
    expect(accepted.savedToInbox).toBe(true);

    await expect(shares.signInToShare(accepted.entry, w.depsB)).rejects.toMatchObject({ code: "not-shared" });

    const state = await shares.loadOwnerShares(S, w.depsA);
    expect(state.offered).toEqual([]);
    expect(state.awaiting).toHaveLength(1);
    const a = state.awaiting[0];
    expect(a.label).toBe("Sam");
    expect(formatShareSas(a.sas)).toBe(accepted.sas);

    const memberPub = hex(deriveShareMemberKey({ seed: umkB }, created.shareId).publicKey);
    expect(a.memberPubHex).toBe(memberPub);

    await shares.confirmShare(S, a, w.depsA);
    const post = w.boxPosts.find((p) => p.path === "/api/screens/shares")!;
    expect(Object.keys(post.body).sort()).toEqual(["accept", "acceptSignature", "grant", "signature"]);
    expect(post.body.grant).toMatchObject({
      serverDomain: S,
      shareId: created.shareId,
      memberPubHex: memberPub,
      level: "manage",
      unlockAtBoot: true,
      seeAppData: false,
      label: "Sam",
    });
    expect(verifyServerShareGrant(post.body.grant as never, fromHex(post.body.signature as string), owner.publicKey)).toBe(true);
    expect(post.body.accept).toMatchObject({ serverDomain: S, shareId: created.shareId, memberPubHex: memberPub });

    const deposit = await w.storage.serverShares.getUnlock(created.shareId);
    expect(deposit?.memberPubHex).toBe(memberPub);

    const session = await shares.signInToShare(accepted.entry, w.depsB, { force: true });
    expect(session).toMatchObject({ level: "manage", unlockAtBoot: true, seeAppData: false });
    expect(session.token).toMatch(/^fss_/);

    const after = await shares.loadOwnerShares(S, w.depsA);
    expect(after.awaiting).toEqual([]);
    expect(after.active).toMatchObject([{ label: "Sam", level: "manage", unlockAtBoot: true, unlockDeposited: true }]);

    const mine = await shares.loadSharedWithMe(w.depsB);
    expect(mine).toMatchObject([{ status: "ready", level: "manage", entry: { serverName: "home", serverDomain: S } }]);

    const activity = await shares.fetchActivity(S, w.depsA);
    const lines = activity.map(shares.activityLine);
    expect(lines).toContain("Sam · signed in");
    expect(lines).toContain("You · shared this server with Sam");
  });

  it("someone who got the link first shows a different code, and the link works once", async () => {
    const w = await world();
    const created = await offerTo(w);
    const link = parseShareLink(created.link)!;
    const thief = { ...w.depsB, umk: umkC };
    const stolen = await shares.acceptShare(await shares.openShareLink(link, thief), thief);
    await expect(shares.acceptShare(await shares.openShareLink(link, w.depsB), w.depsB)).rejects.toMatchObject({ code: "taken" });
    const state = await shares.loadOwnerShares(S, w.depsA);
    expect(formatShareSas(state.awaiting[0].sas)).toBe(stolen.sas);
    expect(state.awaiting[0].memberPubHex).toBe(hex(deriveShareMemberKey({ seed: umkC }, created.shareId).publicKey));
  });

  it("re-opening an accepted link on the same account resumes with the same code", async () => {
    const w = await world();
    const created = await offerTo(w);
    const link = parseShareLink(created.link)!;
    const first = await shares.acceptShare(await shares.openShareLink(link, w.depsB), w.depsB);
    const again = await shares.openShareLink(link, w.depsB);
    expect(again.acceptedByMe).toBe(true);
    const second = await shares.acceptShare(again, w.depsB);
    expect(second.sas).toBe(first.sas);
    expect(await shares.listSharedWithMe(w.depsB)).toHaveLength(1);
  });

  it("changing the level re-signs the grant; turning start-up approval off withdraws the copy", async () => {
    const w = await world();
    const { created } = await sharedWithB(w);
    const [active] = (await shares.loadOwnerShares(S, w.depsA)).active;
    await shares.changeShare(S, active, { level: "view", unlockAtBoot: false }, w.depsA);
    expect(w.store.get(created.shareId)?.grant).toMatchObject({ level: "view", unlockAtBoot: false });
    expect(await w.storage.serverShares.getUnlock(created.shareId)).toBeNull();
    const lastGrant = w.boxPosts.filter((p) => p.path === "/api/screens/shares").at(-1)!;
    expect(lastGrant.body.accept).toBeUndefined();
  });

  it("Remove ends the share on the box and on .com; the member sees it gone", async () => {
    const w = await world();
    const { created, entry } = await sharedWithB(w);
    await shares.signInToShare(entry, w.depsB);
    const r = await shares.revokeShare(S, created.shareId, w.depsA);
    expect(r).toEqual({ box: true, com: true });
    expect(w.boxPosts.some((p) => p.path === "/api/screens/shares/revoke")).toBe(true);
    expect(w.log).toContain(`POST flagshipserver.com/api/users/alice/server-shares/${created.shareId}/revoke`);
    expect(w.store.isEnded(created.shareId)).toBe(true);
    expect((await w.storage.serverShares.get(created.shareId))?.endedAt).not.toBeNull();
    expect(await w.storage.serverShares.getUnlock(created.shareId)).toBeNull();

    await expect(shares.signInToShare(entry, w.depsB, { force: true })).rejects.toMatchObject({ code: "share-ended" });
    expect(await shares.loadSharedWithMe(w.depsB)).toEqual([]);
    expect(await shares.listSharedWithMe(w.depsB)).toEqual([]);
  });

  it("an end that reached only the box is listed so the owner's page can finish it on .com", async () => {
    const w = await world();
    const { created } = await sharedWithB(w);
    await w.box.endShare(created.shareId, "revoked", { kind: "owner" });
    const state = await shares.loadOwnerShares(S, w.depsA);
    expect(state.unfinished).toEqual([created.shareId]);
    await shares.cancelShareOffer(S, created.shareId, w.depsA);
    expect(await w.storage.serverShares.getUnlock(created.shareId)).toBeNull();
    expect((await shares.loadOwnerShares(S, w.depsA)).unfinished).toEqual([]);
  });

  it("Cancel on a link nobody confirmed goes to .com only", async () => {
    const w = await world();
    const created = await offerTo(w);
    w.boxPosts.length = 0;
    await shares.cancelShareOffer(S, created.shareId, w.depsA);
    expect(w.boxPosts).toEqual([]);
    expect((await shares.loadOwnerShares(S, w.depsA)).offered).toEqual([]);
    await expect(shares.openShareLink(parseShareLink(created.link)!, w.depsB)).rejects.toMatchObject({ code: "ended" });
  });

  it("Leave ends the share on the box and on .com and empties the inbox", async () => {
    const w = await world();
    const { created } = await sharedWithB(w);
    const [listed] = await shares.listSharedWithMe(w.depsB);
    const r = await shares.leaveShare(listed, w.depsB);
    expect(r).toEqual({ box: true, com: true });
    expect(w.store.isEnded(created.shareId)).toBe(true);
    expect((await w.storage.serverShares.get(created.shareId))?.endKind).toBe("leave");
    expect(await shares.listSharedWithMe(w.depsB)).toEqual([]);
    const seen = await shares.loadOwnerShares(S, w.depsA);
    expect(seen.active).toEqual([]);
    expect(seen.ended).toMatchObject([{ label: "Sam", reason: "left" }]);
  });

  it("a manage share signs an access list with its member key", async () => {
    const w = await world();
    const { created, entry } = await sharedWithB(w);
    const { sendAccessList } = await import("../public/webapp/lib/appAccess.js");
    const client = shares.shareBoxClient(entry, w.depsB);
    await sendAccessList(
      { serverDomain: S, serviceId: "notes", list: "allow api.example.com\n", umk: umkB, signWithIrk: await shares.shareMemberSigner(entry, w.depsB), fetchJson: client.fetch },
      { requireOwnerProfile: () => {} },
    );
    const [post] = w.accessPosts;
    const memberPub = deriveShareMemberKey({ seed: umkB }, created.shareId).publicKey;
    expect(post.memberPubHex).toBe(hex(memberPub));
    expect(verifyAppAccessGrant(post.body.grant as never, fromHex(post.body.signature as string), memberPub)).toBe(true);
  });
});

describe("share this server — start-up approval", () => {
  async function request(w: World, signer: { privateKey: Uint8Array; publicKey: Uint8Array }) {
    const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
    const req = { serverDomain: S, stkPub: hex(signer.publicKey), purpose: "unlock-key", nonce, issuedAt: Date.now() };
    const bytes = bootSeal.canonicalSecretRequest({ serverDomain: S, stkPubHex: req.stkPub, purpose: req.purpose, nonceHex: nonce, issuedAt: req.issuedAt });
    const { ed25519 } = await import("@noble/curves/ed25519.js");
    w.boot.requests.push({ request: req, signature: hex(ed25519.sign(bytes, signer.privateKey)) });
    return req;
  }

  it("lists only the pinned STK's requests and approves with the member's copy of the disk key", async () => {
    const w = await world();
    const { entry } = await sharedWithB(w);
    const real = await request(w, stk);
    const fake = await request(w, impostor);

    const startups = await shares.fetchShareStartups(entry, w.depsB);
    expect(startups.map((s) => s.nonce)).toEqual([real.nonce]);

    await expect(shares.approveShareStartup(entry, fake, w.depsB)).rejects.toMatchObject({ code: "wrong-stk" });
    expect(w.boot.responses).toEqual([]);

    await shares.approveShareStartup(entry, startups[0], w.depsB);
    const [resp] = w.boot.responses;
    expect(resp).toMatchObject({ serverDomain: S, requestNonceHex: real.nonce, purpose: "unlock-key" });
    const opened = await bootSeal.openSealedWithEd25519Seed(fromHex(resp.sealed as string), stk.privateKey);
    const ctxLen = new DataView(opened.buffer, opened.byteOffset).getUint32(0, false);
    const ctx = new TextDecoder().decode(opened.slice(4, 4 + ctxLen));
    expect(ctx).toBe(`flagship/secret-response/v1|${real.nonce}|unlock-key`);
    expect(hex(opened.slice(4 + ctxLen))).toBe(hex(w.diskKey));
  });

  it("a request signed by another key under the pinned STK's name is dropped", async () => {
    const w = await world();
    const { entry } = await sharedWithB(w);
    await request(w, impostor);
    (w.boot.requests[0] as { request: { stkPub: string } }).request.stkPub = hex(stk.publicKey);
    expect(await shares.fetchShareStartups(entry, w.depsB)).toEqual([]);
  });
});

describe("share links at boot", () => {
  const S_ID = "ab".repeat(16);
  const K = "cd".repeat(32);

  it("reads /share#s=…&k=… and nothing else", () => {
    expect(shares.shareLinkFromLocation({ pathname: "/share", hash: `#s=${S_ID}&k=${K}` })).toEqual({ shareId: S_ID, secretHex: K });
    expect(shares.shareLinkFromLocation({ pathname: "/share/", hash: `#s=${S_ID}&k=${K}` })).toEqual({ shareId: S_ID, secretHex: K });
    expect(shares.shareLinkFromLocation({ pathname: "/", hash: `#s=${S_ID}&k=${K}` })).toBeNull();
    expect(shares.shareLinkFromLocation({ pathname: "/share", hash: "#s=nope" })).toBeNull();
  });

  it("keeps the link in memory, drops it from the address bar, and opens it once unlocked", async () => {
    const replaceState = vi.fn();
    const link = shares.stashShareLinkFromLocation({ pathname: "/share", hash: `#s=${S_ID}&k=${K}` }, { replaceState });
    expect(link).toEqual({ shareId: S_ID, secretHex: K });
    expect(replaceState).toHaveBeenCalledWith({}, "", "/");
    await dispatchInitialView();
    expect(enterShareAccept).toHaveBeenCalledWith({ shareId: S_ID, secretHex: K });
    expect(shares.takePendingShareLink()).toBeNull();
  });
});

const OWNER_ONLY = [
  "danger-zone-card",
  "transfer-card",
  "replace-card",
  "update-card",
  "migrate-card",
  "lock-power-card",
  "deadman-card",
  "journal-card",
  "front-page-card",
  "auto-unlock-card",
  "preferred-server-card",
  "shared-with-card",
  "server-activity-card",
  "Delete server",
  "Revoke server",
  "Paired sessions",
  "Share this server",
];

describe("the shared server's page", () => {
  const entry = { entryId: "ee".repeat(16), shareId: "ab".repeat(16), secretHex: "cd".repeat(32), serverDomain: S, serverName: "home", acceptedAt: 1 };
  const detail = { serverFqdn: S, username: "alice", currentCommit: "c".repeat(40), uptimeMs: 3_600_000, pairedSessionCount: 3 };
  const apps = [{ serviceId: "notes", slug: "notes", url: "https://notes.example", status: "running" }];
  const startup = { serverDomain: S, nonce: "11".repeat(32), stkPub: hex(stk.publicKey), purpose: "unlock-key", issuedAt: 1 };

  it("at manage with start-up approval: status, apps with access lists, the start-up card and Leave, nothing of the owner's", () => {
    const html = sharedServerHtml({ entry, me: { level: "manage", unlockAtBoot: true, seeAppData: false }, detail, apps, startups: [startup] });
    for (const want of ["home is starting. Unlock it?", "Approve start-up", "Live metrics", "notes", "Internet access", "Leave home", S]) {
      expect(html).toContain(want);
    }
    for (const owned of OWNER_ONLY) expect(html).not.toContain(owned);
  });

  it("at view: no access-list editor and no start-up card", () => {
    const html = sharedServerHtml({ entry, me: { level: "view", unlockAtBoot: false, seeAppData: false }, detail, apps });
    expect(html).not.toContain("Internet access");
    expect(html).not.toContain("Approve start-up");
    expect(html).toContain("Leave home");
    for (const owned of OWNER_ONLY) expect(html).not.toContain(owned);
  });

  it("opens over a share session and paints the restricted page", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const w = await world();
    const { entry: shared } = await sharedWithB(w);
    class El {
      innerHTML = "";
      textContent = "";
      classList = { toggle: () => {}, contains: () => false, add: () => {}, remove: () => {} };
      addEventListener() {}
      insertAdjacentHTML() {}
      querySelector() { return null; }
      querySelectorAll() { return []; }
    }
    const ids: Record<string, El> = {
      "view-shared-server": new El(),
      "shared-server-content": new El(),
      "shared-server-title": new El(),
      "shared-server-sub": new El(),
    };
    vi.stubGlobal("document", {
      getElementById: (id: string) => ids[id] ?? null,
      querySelectorAll: () => [],
      dispatchEvent: () => true,
      body: new El(),
    });
    vi.stubGlobal("fetch", w.fetchImpl);
    const session = getSession();
    session.umk = umkB;
    session.username = "bob";
    try {
      await enterSharedServer(shared);
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    } finally {
      ids["view-shared-server"]!.classList.contains = () => true;
      session.umk = null;
      session.username = null;
    }
    const html = ids["shared-server-content"]!.innerHTML;
    expect(ids["shared-server-title"]!.textContent).toBe("home");
    expect(ids["shared-server-sub"]!.textContent).toBe("Shared with you · Can manage");
    expect(html).toContain("notes");
    expect(html).toContain("Internet access");
    expect(html).toContain("Leave home");
    for (const owned of OWNER_ONLY) expect(html).not.toContain(owned);
  });
});

describe("the owner's Shared with card", () => {
  it("lists active shares with their controls, links awaiting a code, and open links", () => {
    const html = sharesListHtml({
      active: [{ shareId: "a".repeat(32), label: "Sam", level: "manage", unlockAtBoot: true, seeAppData: false, lastSeenAt: null, unlockDeposited: true }],
      awaiting: [{ shareId: "b".repeat(32), label: "Ana", sas: "123456" }],
      offered: [{ shareId: "c".repeat(32), label: "Kim", expired: false }],
      ended: [],
      unfinished: [],
      boxError: null,
      comError: null,
    });
    expect(html).toContain("123 456");
    expect(html).toContain("Yes, confirm");
    expect(html).toContain("Waiting for <strong>Kim</strong> to open the link");
    expect(html).toContain('data-share-remove="' + "a".repeat(32));
    expect(html).toContain("Can approve this server's start-up");
  });
});
