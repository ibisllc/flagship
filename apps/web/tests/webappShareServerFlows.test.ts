// Share this server on the webapp (docs/share-a-server.md §9): the owner's and
// the other account's flows against the real `.com` handlers (InMemory) and the
// real box share routes, over a mocked fetch. Then link parsing at boot and the
// shared server's page, which must carry none of the owner's sections.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveIRK,
  deriveShareMemberKey,
  ed,
  verifyAppAccessGrant,
  verifyServerShareAcceptAdmin,
  verifyServerShareGrant,
  verifyServerShareRevoke,
  verifyServerShareUpdate,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  deriveDemoAdminRoot,
  handleDemoShareAccept,
  handleAccountKeyAttestation,
  handleAcceptServerShare,
  handleCreateServerShare,
  handleGetServerShare,
  handleLeaveServerShare,
  handleListServerShares,
  handleRevokeServerShare,
  handleServerSharePush,
  handleServerShareUnlock,
  handleShareInbox,
} from "@flagship/control-plane";
import { ShareStore } from "../../../packages/server-daemon/src/shares/shareStore.js";
import { ActivityLog } from "../../../packages/server-daemon/src/shares/activityLog.js";
import { ShareSessionStore, buildShares } from "../../../packages/server-daemon/src/shares/sharesHttp.js";
import { TEST_CA, testVerifyAcceptAdmin } from "../../../packages/server-daemon/tests/shares/acceptAdminFixture.js";

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
// Bob's admin root: the key his admin device holds and `.com` pins.
const bobAdminSeed = new Uint8Array(32).fill(66);
const bobAdminPub = ed.getPublicKey(bobAdminSeed);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

type Init = { method?: string; headers?: Record<string, string>; body?: string };

async function world() {
  const storage = new InMemoryStorage();
  await storage.usernames.put({ username: "alice", irkPubHex: hex(owner.publicKey), claimedAt: 1 });
  await storage.usernames.put({ username: "bob", irkPubHex: hex(deriveIRK({ seed: umkB }).publicKey), adminRootPubHex: hex(bobAdminPub), claimedAt: 1 });
  await storage.servers.put({ serverDomain: S, username: "alice", identityPubKeyHex: hex(stk.publicKey), registeredAt: 1 });
  const com = { shares: storage.serverShares, usernames: storage.usernames, servers: storage.servers };
  const store = new ShareStore(null, {
    serverDomain: S,
    verifyOwnerGrant: (g, sig) => verifyServerShareGrant(g, sig, owner.publicKey),
    verifyAcceptAdmin: testVerifyAcceptAdmin(),
  });
  const updates: Array<{ level: string; memberPubHex: string; body: Record<string, any> }> = [];
  const box = buildShares({
    serverDomain: S,
    store,
    sessions: new ShareSessionStore(null),
    activity: new ActivityLog(null),
    verifyOwnerRevoke: (r, sig) => verifyServerShareRevoke(r, sig, owner.publicKey),
    serverUpdate: async (caller, body) => {
      updates.push({ level: caller.level, memberPubHex: caller.memberPubHex, body: body ?? {} });
      return { status: 202, body: { ok: true, accepted: true, targetCommit: (body?.update as { targetCommit?: string })?.targetCommit } };
    },
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
      if (method === "GET" && (m = p.match(/^\/api\/users\/([^/]+)\/account-key-attestation$/))) {
        r = await handleAccountKeyAttestation({ ca: { keypair: TEST_CA, issuer: "test-ca" }, usernames: storage.usernames }, m[1]!);
      } else if (method === "POST" && p === "/api/users/alice/server-shares") r = await handleCreateServerShare(com, "alice", body);
      else if (method === "POST" && p === "/api/users/alice/server-shares/list") r = await handleListServerShares(com, "alice", body);
      else if (method === "POST" && (m = p.match(/^\/api\/users\/alice\/server-shares\/([0-9a-f]{32})\/revoke$/))) r = await handleRevokeServerShare(com, "alice", m[1]!, body);
      else if (method === "POST" && (m = p.match(/^\/api\/users\/alice\/server-shares\/([0-9a-f]{32})\/unlock$/))) r = await handleServerShareUnlock(com, "alice", m[1]!, body);
      else if (method === "GET" && (m = p.match(/^\/api\/server-shares\/([0-9a-f]{32})$/))) r = await handleGetServerShare(com, m[1]!, token);
      else if (method === "POST" && (m = p.match(/^\/api\/server-shares\/([0-9a-f]{32})\/accept$/))) r = await handleAcceptServerShare(com, m[1]!, token, body);
      else if (method === "POST" && (m = p.match(/^\/api\/server-shares\/([0-9a-f]{32})\/leave$/))) r = await handleLeaveServerShare(com, m[1]!, token, body);
      else if (method === "POST" && (m = p.match(/^\/api\/server-shares\/([0-9a-f]{32})\/push$/))) r = await handleServerSharePush(com, m[1]!, token, body);
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
  const depsB = {
    fetch: fetchImpl,
    apex: APEX,
    boot: BOOT,
    umk: umkB,
    username: "bob",
    adminRootSeed: bobAdminSeed as Uint8Array | null,
    isDemo: false,
    freshUnlock: async () => ({ ok: true }) as { ok: boolean; cancelled?: boolean; error?: string },
  };
  return { storage, store, box, diskKey, log, boxPosts, accessPosts, boot, updates, fetchImpl, depsA, depsB };
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
    expect(Object.keys(post.body).sort()).toEqual(["accept", "acceptAdmin", "acceptSignature", "grant", "signature"]);
    // Bob's admin device signed #12 with his admin root; the box checked it.
    const proof = post.body.acceptAdmin as { admit: Record<string, unknown>; signature: string; attestation: Record<string, unknown> };
    expect(proof.admit).toMatchObject({ shareId: created.shareId, memberPubHex: memberPub, keyKind: "admin-root", keyPubHex: hex(bobAdminPub) });
    expect(verifyServerShareAcceptAdmin(proof.admit as never, fromHex(proof.signature), bobAdminPub)).toBe(true);
    expect(proof.attestation).toMatchObject({ kind: "AccountKeyAttestation", keyKind: "admin-root", keyPubHex: hex(bobAdminPub) });
    expect(JSON.stringify(proof)).not.toContain("bob");
    expect(w.store.get(created.shareId)?.acceptAdmin?.admit.keyPubHex).toBe(hex(bobAdminPub));
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

  it("a non-admin device of the account can't accept: nothing is sent", async () => {
    const w = await world();
    const created = await offerTo(w);
    const link = parseShareLink(created.link)!;
    const phone = { ...w.depsB, adminRootSeed: null };
    let unlocks = 0;
    phone.freshUnlock = async () => ((unlocks += 1), { ok: true });
    await expect(shares.acceptShare(await shares.openShareLink(link, phone), phone)).rejects.toMatchObject({
      code: "not-admin",
      message: "Only an admin device of your account can accept a co-manage invitation.",
    });
    expect(unlocks).toBe(0);
    expect(w.log.some((l) => l.endsWith("/accept"))).toBe(false);
    // A device whose admin root isn't the one the account pins now is no admin either.
    const stale = { ...w.depsB, adminRootSeed: new Uint8Array(32).fill(67) };
    await expect(shares.acceptShare(await shares.openShareLink(link, stale), stale)).rejects.toMatchObject({ code: "not-admin" });
    expect(w.log.some((l) => l.endsWith("/accept"))).toBe(false);
  });

  it("cancelling the fresh unlock accepts nothing", async () => {
    const w = await world();
    const link = parseShareLink((await offerTo(w)).link)!;
    const deps = { ...w.depsB, freshUnlock: async () => ({ ok: false, cancelled: true }) };
    await expect(shares.acceptShare(await shares.openShareLink(link, deps), deps)).rejects.toMatchObject({ code: "cancelled" });
    expect(w.log.some((l) => l.endsWith("/accept"))).toBe(false);
  });

  it("an acceptance from an app that sent no admin proof: the owner sees the box's sentence", async () => {
    const w = await world();
    const created = await offerTo(w);
    await shares.acceptShare(await shares.openShareLink(parseShareLink(created.link)!, w.depsB), w.depsB);
    const [a] = (await shares.loadOwnerShares(S, w.depsA)).awaiting;
    await expect(shares.confirmShare(S, { ...a, acceptAdmin: null }, w.depsA)).rejects.toMatchObject({
      code: "accept-not-admin",
      message:
        "Only an admin device of their account can accept a co-manage invitation. Cancel this link and send a new one for them to open on an admin device.",
    });
    expect(w.store.get(created.shareId)).toBeNull();
  });

  it("a demo account's device accepts through .com's signer, and the box takes it", async () => {
    const w = await world();
    const KEK = new Uint8Array(32).fill(9);
    const demoRoot = deriveDemoAdminRoot(KEK, "bob");
    await w.storage.usernames.put({ username: "bob", irkPubHex: hex(deriveIRK({ seed: umkB }).publicKey), adminRootPubHex: hex(demoRoot.publicKey), claimedAt: 1 });
    await w.storage.demoUsers.insert({
      username: "bob", idempotencyKey: "demo-bob", snapshotId: null, isoR2Key: null, ttlIdleMinutes: 30, region: "fsn1", size: "cpx11",
      activeServerId: null, activeServerIp: null, image: "debian-12", activeServerFqdn: null, lastActivityAt: 1, state: "ready",
      createdAt: 1, provisionPhase: null, provisionPhaseAt: null, provisionLastError: null,
    } as never);
    const demoFetch = async (input: string, init: Init = {}) => {
      if (input === `${APEX}/api/dev/sample-user/bob/share-accept`) {
        const r = await handleDemoShareAccept({ storage: w.storage.demoUsers, demoIrkKek: KEK }, "bob", JSON.parse(init.body ?? "{}"));
        return new Response(JSON.stringify(r.body), { status: r.status });
      }
      return w.fetchImpl(input, init);
    };
    let unlocks = 0;
    const demo = { ...w.depsB, fetch: demoFetch, adminRootSeed: null, isDemo: true, freshUnlock: async () => ((unlocks += 1), { ok: true }) };
    const created = await offerTo(w);
    await shares.acceptShare(await shares.openShareLink(parseShareLink(created.link)!, demo), demo);
    expect(unlocks).toBe(0);
    const [a] = (await shares.loadOwnerShares(S, w.depsA)).awaiting;
    await shares.confirmShare(S, a, w.depsA);
    expect(w.store.get(created.shareId)?.acceptAdmin?.admit.keyPubHex).toBe(hex(demoRoot.publicKey));
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

  it("the Database on a shared server reads over the share session and writes only at manage", async () => {
    const w = await world();
    const { entry } = await sharedWithB(w);
    const back = vi.fn(async () => {});
    const viewer = await shares.shareDbSource(entry, { level: "view", seeAppData: true }, { back, deps: w.depsB });
    expect(viewer.writeRefusal()).toBe("Only someone who can manage this server can change its apps' data. You can read it.");
    expect(await viewer.fetchJson("/api/screens/apps-list")).toMatchObject({ apps: [{ serviceId: "notes" }] });
    const csv = await viewer.csvAuth();
    expect(csv.base).toBe(`https://${S}`);
    expect(typeof csv.token).toBe("string");
    await viewer.back();
    expect(back).toHaveBeenCalledOnce();

    const manager = await shares.shareDbSource(entry, { level: "manage", seeAppData: true }, { deps: w.depsB });
    expect(manager.writeRefusal()).toBe("");
    const s = manager.signer();
    expect(s.serverDomain).toBe(S);
    const sig = await s.signWithIrk(null, new Uint8Array([1, 2, 3]));
    const { ed25519 } = await import("@noble/curves/ed25519.js");
    expect(ed25519.verify(sig, new Uint8Array([1, 2, 3]), deriveShareMemberKey({ seed: umkB }, entry.shareId).publicKey)).toBe(true);
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

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

describe("share this server — start-up notices", () => {
  const TOKEN = JSON.stringify({ endpoint: "https://push.example/b", keys: { p256dh: "04", auth: "aa" } });

  it("registers this browser for a share with unlock at boot, and drops it when turned off", async () => {
    const w = await world();
    const { entry } = await sharedWithB(w);
    const storage = memoryStorage();
    const deps = { ...w.depsB, storage, providerToken: async () => TOKEN };
    expect(await shares.setSharePush(entry, true, deps)).toEqual({ ok: true, on: true });
    const targets = await w.storage.serverShares.pushTargetsForServer(S);
    expect(targets).toEqual([expect.objectContaining({ platform: "webpush", providerToken: TOKEN })]);
    expect(shares.sharePushState(entry.shareId, storage)).toMatchObject({ platform: "webpush" });

    expect(await shares.setSharePush(entry, false, deps)).toEqual({ ok: true, on: false });
    expect(await w.storage.serverShares.pushTargetsForServer(S)).toEqual([]);
    expect(shares.sharePushState(entry.shareId, storage)).toBeNull();
  });

  it("says plainly when the owner hasn't handed over start-up approval", async () => {
    const w = await world();
    const { entry } = await sharedWithB(w, { unlockAtBoot: false });
    const storage = memoryStorage();
    await expect(shares.setSharePush(entry, true, { ...w.depsB, storage, providerToken: async () => TOKEN })).rejects.toMatchObject({
      code: "unlock-not-shared",
      message: shares.NOTIFY_NOT_ALLOWED,
    });
    expect(shares.sharePushState(entry.shareId, storage)).toBeNull();
  });

  it("leaving forgets this browser's registration", async () => {
    const w = await world();
    const { entry } = await sharedWithB(w);
    const storage = memoryStorage();
    await shares.setSharePush(entry, true, { ...w.depsB, storage, providerToken: async () => TOKEN });
    await shares.leaveShare(entry, { ...w.depsB, storage });
    expect(shares.sharePushState(entry.shareId, storage)).toBeNull();
    expect(await w.storage.serverShares.pushTargetsForServer(S)).toEqual([]);
  });
});

describe("share this server — updates at manage level", () => {
  it("signs the update with the member key and sends it over the share session", async () => {
    const w = await world();
    const { created, entry } = await sharedWithB(w);
    const r = await shares.orderShareUpdate(entry, { targetCommit: "2".repeat(40), fromCommit: "1".repeat(40) }, w.depsB);
    expect(r).toMatchObject({ accepted: true });
    const [u] = w.updates;
    const memberPub = deriveShareMemberKey({ seed: umkB }, created.shareId).publicKey;
    expect(u.level).toBe("manage");
    expect(u.body.update).toMatchObject({ serverDomain: S, shareId: created.shareId, memberPubHex: hex(memberPub), targetCommit: "2".repeat(40), fromCommit: "1".repeat(40) });
    expect(u.body.update.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyServerShareUpdate(u.body.update, fromHex(u.body.signature), memberPub)).toBe(true);
    expect(verifyServerShareUpdate(u.body.update, fromHex(u.body.signature), owner.publicKey)).toBe(false);
  });

  it("is refused at view level, in words", async () => {
    const w = await world();
    const { entry } = await sharedWithB(w, { level: "view" });
    await expect(shares.orderShareUpdate(entry, { targetCommit: "2".repeat(40), fromCommit: "1".repeat(40) }, w.depsB)).rejects.toMatchObject({
      code: "manage-only",
      message: "Only someone who can manage this server can update it.",
    });
    expect(w.updates).toEqual([]);
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
  "update-card",
  "backup-migrate-card",
  "lock-power-card",
  "deadman-card",
  "journal-card",
  "front-page-card",
  "auto-unlock-card",
  "leader-card",
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
    for (const want of ["home is starting. Unlock it?", "Approve start-up", "Live metrics", "notes", "Internet access", "Leave this server", S]) {
      expect(html).toContain(want);
    }
    for (const owned of OWNER_ONLY) expect(html).not.toContain(owned);
  });

  it("at manage on an updatable box: the update card, the notices switch and the members-only hint", () => {
    const withModes = [...apps, { serviceId: "photos", slug: "photos", url: "https://photos.example", status: "running", accessMode: "members-only" }];
    const html = sharedServerHtml({ entry, me: { level: "manage", unlockAtBoot: true, seeAppData: false, canUpdate: true }, detail, apps: withModes });
    expect(html).toContain("shared-release-card");
    expect(html).toContain(shares.NOTIFY_TITLE);
    expect(html).toContain("Flagship's service know this device helps with this server");
    expect(html.match(/data-members-only/g)).toHaveLength(1);
    expect(html).toContain("Members only. As a co-manager you can open it.");
    expect(html).not.toContain("You need an invite");
    for (const owned of OWNER_ONLY) expect(html).not.toContain(owned);
  });

  it("offers each app's Database only with Can see app data", () => {
    const withData = sharedServerHtml({ entry, me: { level: "view", unlockAtBoot: false, seeAppData: true }, detail, apps });
    expect(withData).toContain('data-db-open="notes"');
    expect(withData).toContain(">Database<");
    const without = sharedServerHtml({ entry, me: { level: "manage", unlockAtBoot: false, seeAppData: false }, detail, apps });
    expect(without).not.toContain("data-db-open");
  });

  it("at view: no access-list editor and no start-up card", () => {
    const html = sharedServerHtml({ entry, me: { level: "view", unlockAtBoot: false, seeAppData: false, canUpdate: false }, detail, apps });
    expect(html).not.toContain("shared-release-card");
    expect(html).not.toContain(shares.NOTIFY_TITLE);
    expect(html).not.toContain("Internet access");
    expect(html).not.toContain("Approve start-up");
    expect(html).toContain("Leave this server");
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
    expect(html).toContain("Leave this server");
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

  it("warns, where unlock at boot is handed over, that a copy can't be taken back", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../public/webapp/views/server-sharing.js"), "utf8");
    expect(shares.UNLOCK_WARNING).toBe(
      "Only give this to someone you'd give a house key. Ending the share deletes their copy, but they could have kept one.",
    );
    expect(src.match(/UNLOCK_WARNING/g)!.length).toBeGreaterThanOrEqual(3);
  });
});
