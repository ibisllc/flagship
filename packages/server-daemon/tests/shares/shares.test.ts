/**
 * Share this server on the box (docs/share-a-server.md): grants verify against
 * the owner's sensitive key, the other account signs in with its per-share
 * key, every screens route is gated by level (default deny), changes and
 * revokes apply at once, ended shares never come back, signed actions chain
 * back to the owner's grant, and the activity log names the share by label.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  accessListSha256,
  appDbSqlSha256,
  signAppDbWriteGrant,
  deriveIRK,
  deriveShareMemberKey,
  signAppAccessGrant,
  signServerShareAccept,
  signServerShareGrant,
  signServerShareLeave,
  signServerShareRevoke,
  signServerShareSession,
  verifyServerShareGrant,
  verifyServerShareRevoke,
  type Keypair,
  type ServerShareGrant,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "../../src/adminAuthorityLocal.js";
import { buildOwnerDbHttp } from "../../src/dataLayer/ownerDb.js";
import { AppAccessStore } from "../../src/egress/accessStore.js";
import { accessAuthorizer, accessSummary, buildAppAccessHttp, egressView } from "../../src/egress/approvals.js";
import type { HttpRequest, HttpResponse } from "../../src/runtime.js";
import { buildScreensHttp } from "../../src/screens/screensHttp.js";
import { ActivityLog } from "../../src/shares/activityLog.js";
import { shareRefusal, shareRouteNeed } from "../../src/shares/shareRoutes.js";
import { ShareStore, type ShareStoreOptions } from "../../src/shares/shareStore.js";
import { ShareSessionStore, buildShares, pollShareEndsOnce } from "../../src/shares/sharesHttp.js";
import type { ShareInvites } from "../../src/shares/shareInvites.js";
import { ACCEPT_ADMIN_SENTENCES, checkShareAcceptAdmin } from "../../src/shares/acceptAdmin.js";
import { deriveDemoAdminRoot } from "@flagship/control-plane";
import { JOIN_ADMIN, adminProof, testVerifyAcceptAdmin, type ProofOptions } from "./acceptAdminFixture.js";

const BOX = "home.harry.flagship.services";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const owner = deriveIRK({ seed: new Uint8Array(32).fill(42) });
const adminRoot = deriveIRK({ seed: new Uint8Array(32).fill(7) });
const stranger = deriveIRK({ seed: new Uint8Array(32).fill(9) });
const memberUmk = { seed: new Uint8Array(32).fill(22) };
const SHARE = "ab".repeat(16);
const member = deriveShareMemberKey(memberUmk, SHARE);
const OWNER_TOKEN = "owner-token";

let clock = 1_800_000_000_000;
const now = () => clock;

function authority(withAdminRoot: boolean) {
  return { ownerIrkPub: owner.publicKey, username: "harry", ...(withAdminRoot ? { adminRootPub: adminRoot.publicKey } : {}) };
}

function req(method: string, path: string, token: string | null, body?: unknown): HttpRequest {
  return {
    method,
    path,
    headers: token ? { "x-flagship-session": token } : {},
    body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)),
  };
}
const parse = (r: HttpResponse | null) => ({ status: r!.status, body: JSON.parse(String(r!.body)) as Record<string, any> });

const APP = {
  serviceId: "harry-weather",
  creator: "harry",
  slug: "weather",
  urlLabel: "weather",
  installedAt: 1,
  manifest: { name: "weather", version: "1.0.0", network: { egress: ["api.open-meteo.com"] } },
  membership: { members: { list: () => [] } },
};

function setup(
  opts: { withAdminRoot?: boolean; dir?: string; invites?: ShareInvites; verifyAcceptAdmin?: ShareStoreOptions["verifyAcceptAdmin"] } = {},
) {
  const auth = authority(opts.withAdminRoot ?? false);
  const dir = opts.dir ?? null;
  const store = new ShareStore(dir ? join(dir, "shares.json") : null, {
    serverDomain: BOX,
    verifyOwnerGrant: (g, sig) => authorizeSensitiveOrder({ ...auth, order: g, signature: sig, verify: verifyServerShareGrant }),
    verifyAcceptAdmin: opts.verifyAcceptAdmin ?? testVerifyAcceptAdmin(now),
    now,
  });
  const sessions = new ShareSessionStore(dir ? join(dir, "share-sessions.json") : null, now);
  const activity = new ActivityLog(dir ? join(dir, "activity.jsonl") : null, now);
  const verifyOwnerRevoke = (r: Parameters<typeof verifyServerShareRevoke>[0], sig: Uint8Array) =>
    authorizeSensitiveOrder({ ...auth, order: r, signature: sig, verify: verifyServerShareRevoke });
  const shares = buildShares({ serverDomain: BOX, store, sessions, activity, verifyOwnerRevoke, now, log: () => {}, invites: opts.invites ?? null });
  const paired = {
    check: (r: HttpRequest): HttpResponse | null =>
      r.headers["x-flagship-session"] === OWNER_TOKEN ? null : { status: 401, body: '{"error":"unauthorized"}' },
  };
  const accessStore = new AppAccessStore(null, null, { now });
  const accessHandle = buildAppAccessHttp({
    serverDomain: BOX,
    ...auth,
    store: accessStore,
    app: (id) => (id === APP.serviceId ? { name: "weather", declared: APP.manifest.network.egress } : null),
    now,
  });
  const screens = buildScreensHttp({
    gate: shares.gate(paired),
    shares,
    serverFqdn: BOX,
    username: "harry",
    daemonVersion: "t",
    startedAt: 0,
    servicePlatform: { list: () => [APP], byServiceId: (id: string) => (id === APP.serviceId ? APP : undefined) } as never,
    appEgress: {
      handle: accessHandle,
      view: (id, declared) => egressView(accessStore, id, declared),
      access: (id) => accessSummary(accessStore, id),
    },
  });
  const http = shares.withActivity(screens);
  const all = async (r: HttpRequest) => (await shares.handlePublic(r)) ?? (await http(r));
  return { store, sessions, activity, shares, http: all, accessStore, auth };
}

function grantOf(o: Partial<ServerShareGrant> = {}): ServerShareGrant {
  return {
    serverDomain: BOX,
    shareId: SHARE,
    memberPubHex: hex(member.publicKey),
    level: "view",
    unlockAtBoot: false,
    seeAppData: false,
    label: "Sam",
    issuedAt: clock,
    ...o,
  };
}

function acceptance(m: Keypair = member, shareId = SHARE, proof: ProofOptions | null = {}) {
  const accept = { serverDomain: BOX, shareId, memberPubHex: hex(m.publicKey), acceptedAt: clock };
  return {
    accept,
    acceptSignature: hex(signServerShareAccept(accept, m)),
    ...(proof ? { acceptAdmin: adminProof(accept, proof) } : {}),
  };
}

async function grant(x: ReturnType<typeof setup>, o: Partial<ServerShareGrant> = {}, signer: Keypair = owner, withAccept = true) {
  const g = grantOf(o);
  return parse(
    await x.http(
      req("POST", "/api/screens/shares", OWNER_TOKEN, {
        grant: g,
        signature: hex(signServerShareGrant(g, signer)),
        ...(withAccept ? acceptance() : {}),
      }),
    ),
  );
}

async function signIn(x: ReturnType<typeof setup>, k: Keypair = member, shareId = SHARE) {
  const n = parse(await x.http(req("GET", "/api/shares/nonce", null)));
  const session = { serverDomain: BOX, shareId, memberPubHex: hex(k.publicKey), nonceHex: n.body.nonce as string, issuedAt: clock };
  return parse(await x.http(req("POST", "/api/shares/session", null, { session, signature: hex(signServerShareSession(session, k)) })));
}

describe("granting", () => {
  it("takes the owner's grant with the member's acceptance", async () => {
    const x = setup();
    const r = await grant(x);
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(true);
    const list = parse(await x.http(req("GET", "/api/screens/shares", OWNER_TOKEN)));
    expect(list.body.shares).toEqual([expect.objectContaining({ shareId: SHARE, label: "Sam", level: "view" })]);
  });

  it("refuses a grant signed by anyone but the owner's sensitive key", async () => {
    expect((await grant(setup(), {}, stranger)).status).toBe(403);
    expect((await grant(setup(), {}, member)).status).toBe(403);
    // With an admin root pinned, the IRK alone no longer suffices.
    expect((await grant(setup({ withAdminRoot: true }), {}, owner)).status).toBe(403);
    expect((await grant(setup({ withAdminRoot: true }), {}, adminRoot)).status).toBe(200);
  });

  it("needs the acceptance the first time, signed by the named key", async () => {
    expect((await grant(setup(), {}, owner, false)).status).toBe(400);
    const x = setup();
    const g = grantOf();
    const other = deriveShareMemberKey({ seed: new Uint8Array(32).fill(23) }, SHARE);
    const r = await x.http(
      req("POST", "/api/screens/shares", OWNER_TOKEN, { grant: g, signature: hex(signServerShareGrant(g, owner)), ...acceptance(other) }),
    );
    expect(r!.status).toBe(403);
  });

  it("refuses a grant for another server, and a share session can't grant", async () => {
    const x = setup();
    expect((await grant(x, { serverDomain: "media.harry.flagship.services" })).status).toBe(403);
    await grant(x);
    const s = await signIn(x);
    const g = grantOf({ level: "manage", issuedAt: clock + 1 });
    const r = await x.http(req("POST", "/api/screens/shares", s.body.token, { grant: g, signature: hex(signServerShareGrant(g, member)) }));
    expect(parse(r).body.error).toBe("owner-only");
  });

  it("re-verifies grants when the store loads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shares-"));
    await grant(setup({ dir }));
    const again = setup({ dir });
    expect(await again.store.load()).toEqual({ dropped: 0 });
    expect(again.store.get(SHARE)?.grant.label).toBe("Sam");
    const withRoot = setup({ dir, withAdminRoot: true });
    expect(await withRoot.store.load()).toEqual({ dropped: 1 });
  });
});

describe("signing in", () => {
  it("issues a session for the shared key only, once per nonce", async () => {
    const x = setup();
    await grant(x);
    const ok = await signIn(x);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ level: "view", unlockAtBoot: false, seeAppData: false });
    expect(String(ok.body.token)).toMatch(/^fss_/);
    const other = deriveShareMemberKey({ seed: new Uint8Array(32).fill(23) }, SHARE);
    expect((await signIn(x, other)).body.code).toBe("not-shared");
    const n = parse(await x.http(req("GET", "/api/shares/nonce", null)));
    const session = { serverDomain: BOX, shareId: SHARE, memberPubHex: hex(member.publicKey), nonceHex: n.body.nonce as string, issuedAt: clock };
    const body = { session, signature: hex(signServerShareSession(session, member)) };
    expect((await x.http(req("POST", "/api/shares/session", null, body)))!.status).toBe(200);
    expect((await x.http(req("POST", "/api/shares/session", null, body)))!.status).toBe(403);
  });

  it("refuses a stale proof and an unknown nonce", async () => {
    const x = setup();
    await grant(x);
    const session = { serverDomain: BOX, shareId: SHARE, memberPubHex: hex(member.publicKey), nonceHex: "00".repeat(32), issuedAt: clock };
    expect((await x.http(req("POST", "/api/shares/session", null, { session, signature: hex(signServerShareSession(session, member)) })))!.status).toBe(403);
    const n = parse(await x.http(req("GET", "/api/shares/nonce", null)));
    const stale = { ...session, nonceHex: n.body.nonce as string, issuedAt: clock - 10 * 60_000 };
    expect((await x.http(req("POST", "/api/shares/session", null, { session: stale, signature: hex(signServerShareSession(stale, member)) })))!.status).toBe(403);
  });
});

describe("levels", () => {
  async function asShare(o: Partial<ServerShareGrant> = {}) {
    const x = setup();
    await grant(x, o);
    const token = (await signIn(x)).body.token as string;
    const call = async (method: string, path: string, body?: unknown) => parse(await x.http(req(method, path, token, body)));
    return { x, token, call };
  }

  it("lets view read status but nothing that changes the box", async () => {
    const { call } = await asShare();
    expect((await call("GET", "/api/screens/apps-list")).status).toBe(200);
    expect((await call("GET", "/api/shares/me")).body.level).toBe("view");
    expect((await call("POST", "/api/screens/vibe-code/start", {})).body.error).toBe("manage-only");
    expect((await call("GET", "/api/screens/services/harry-weather/access")).body.error).toBe("manage-only");
    expect((await call("GET", "/api/screens/services/harry-weather/db")).body.error).toBe("app-data-not-shared");
  });

  it("keeps owner-only routes owner-only even at manage", async () => {
    const { call } = await asShare({ level: "manage", seeAppData: true, unlockAtBoot: true });
    for (const [m, p] of [
      ["GET", "/api/screens/shares"],
      ["POST", "/api/screens/shares/revoke"],
      ["GET", "/api/screens/activity"],
      ["GET", "/api/screens/paired-sessions/list"],
      ["POST", "/api/screens/companion/mint-ticket"],
      ["POST", "/api/screens/services/harry-weather/env/set"],
      ["POST", "/api/screens/services/harry-weather/api-keys"],
      ["POST", "/api/screens/services/copy"],
      ["POST", "/api/screens/url-controller/claim"],
      ["POST", "/api/screens/peer-backup/toggle"],
      ["POST", "/api/screens/app-backup/start"],
      ["POST", "/api/screens/orders/send"],
      ["GET", "/api/screens/post-recovery/status"],
    ] as const) {
      expect((await call(m, p, {})).body.error, `${m} ${p}`).toBe("owner-only");
    }
    expect((await call("POST", "/api/screens/lineage-resolve", { serviceId: "harry-weather", decision: "revoke" })).body.error).toBe("owner-only");
  });

  it("applies a level change at once, and an end drops the session", async () => {
    const { x, call } = await asShare();
    expect((await call("GET", "/api/screens/services/harry-weather/access")).status).toBe(403);
    clock += 1000;
    expect((await grant(x, { level: "manage", issuedAt: clock })).body.created).toBe(false);
    expect((await call("GET", "/api/screens/services/harry-weather/access")).status).toBe(200);
    const revoke = { serverDomain: BOX, shareId: SHARE, issuedAt: clock };
    const r = await x.http(req("POST", "/api/screens/shares/revoke", OWNER_TOKEN, { revoke, signature: hex(signServerShareRevoke(revoke, owner)) }));
    expect(r!.status).toBe(200);
    expect((await call("GET", "/api/screens/apps-list")).status).toBe(401);
    expect((await grant(x, { issuedAt: clock + 1 })).status).toBe(410);
    expect((await signIn(x)).body.code).toBe("share-ended");
  });

  it("refuses a revoke the owner didn't sign, and an older grant", async () => {
    const { x } = await asShare();
    const revoke = { serverDomain: BOX, shareId: SHARE, issuedAt: clock };
    const r = await x.http(req("POST", "/api/screens/shares/revoke", OWNER_TOKEN, { revoke, signature: hex(signServerShareRevoke(revoke, member)) }));
    expect(r!.status).toBe(403);
    expect((await grant(x, { issuedAt: clock - 1 })).status).toBe(409);
  });

  it("lets the member leave with its own key only", async () => {
    const { x, call } = await asShare();
    const other = deriveShareMemberKey({ seed: new Uint8Array(32).fill(23) }, SHARE);
    const forged = { serverDomain: BOX, shareId: SHARE, memberPubHex: hex(other.publicKey), issuedAt: clock };
    expect((await x.http(req("POST", "/api/shares/leave", null, { leave: forged, signature: hex(signServerShareLeave(forged, other)) })))!.status).toBe(403);
    const leave = { ...forged, memberPubHex: hex(member.publicKey) };
    expect((await x.http(req("POST", "/api/shares/leave", null, { leave, signature: hex(signServerShareLeave(leave, member)) })))!.status).toBe(200);
    expect((await call("GET", "/api/screens/apps-list")).status).toBe(401);
    expect(x.store.listEnded()[0]).toMatchObject({ shareId: SHARE, reason: "left", label: "Sam" });
  });
});

describe("signed actions at manage level", () => {
  const list = "allow api.open-meteo.com\n";
  const accessGrant = () => ({ serverDomain: BOX, serviceId: "harry-weather", listSha256: accessListSha256(list), issuedAt: clock });

  it("takes an access list the member signed, chained to the owner's grant", async () => {
    const x = setup();
    await grant(x, { level: "manage" });
    const token = (await signIn(x)).body.token as string;
    const g = accessGrant();
    const bad = await x.http(req("POST", "/api/screens/services/harry-weather/access", token, { list, grant: g, signature: hex(signAppAccessGrant(g, stranger)) }));
    expect(bad!.status).toBe(403);
    const r = await x.http(req("POST", "/api/screens/services/harry-weather/access", token, { list, grant: g, signature: hex(signAppAccessGrant(g, member)) }));
    expect(r!.status).toBe(200);
    const held = x.accessStore.held("harry-weather");
    expect(held && "by" in held && held.by?.grant.shareId).toBe(SHARE);
    // The chain re-verifies on its own (what a reload does), and only for a manage grant.
    const auth = accessAuthorizer(x.auth);
    expect(auth.v2ByShare(g, Buffer.from(held!.signature, "hex"), (held as { by: never }).by)).toBe(true);
    const viewGrant = grantOf({ level: "view" });
    expect(auth.v2ByShare(g, Buffer.from(held!.signature, "hex"), { grant: viewGrant, signature: hex(signServerShareGrant(viewGrant, owner)) })).toBe(false);
    // The owner's own signature still works over an owner session.
    clock += 1;
    const g2 = accessGrant();
    expect((await x.http(req("POST", "/api/screens/services/harry-weather/access", OWNER_TOKEN, { list, grant: g2, signature: hex(signAppAccessGrant(g2, owner)) })))!.status).toBe(200);
  });
});

describe("activity log", () => {
  it("names the owner or the share's label, and skips reads", async () => {
    const x = setup();
    await grant(x, { level: "manage" });
    const token = (await signIn(x)).body.token as string;
    await x.http(req("GET", "/api/screens/apps-list", token));
    await x.http(req("POST", "/api/screens/services/harry-weather/access/dismiss", token, { host: "x.com" }));
    const entries = parse(await x.http(req("GET", "/api/screens/activity", OWNER_TOKEN))).body.entries as Array<Record<string, any>>;
    const actions = entries.map((e) => `${e.actor.kind === "share" ? e.actor.label : "owner"}:${e.action}`);
    expect(actions).toEqual(["Sam:app.access.dismiss", "Sam:share.signed-in", "owner:share.granted"]);
    expect(JSON.stringify(entries)).not.toContain(hex(member.publicKey));
  });
});

describe("only an admin device of the joining account accepts", () => {
  async function firstGrant(x: ReturnType<typeof setup>, body: Record<string, unknown>) {
    const g = grantOf();
    return parse(await x.http(req("POST", "/api/screens/shares", OWNER_TOKEN, { grant: g, signature: hex(signServerShareGrant(g, owner)), ...body })));
  }
  const nonAdmin = deriveIRK({ seed: memberUmk.seed });

  it("takes an acceptance its admin root signed, and keeps the proof", async () => {
    const x = setup();
    const r = await firstGrant(x, acceptance());
    expect(r.status).toBe(200);
    expect(x.store.get(SHARE)?.acceptAdmin?.admit.keyPubHex).toBe(hex(JOIN_ADMIN.publicKey));
  });

  it("refuses an acceptance with no admin proof (a non-admin device or an older app)", async () => {
    const r = await firstGrant(setup(), acceptance(member, SHARE, null));
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: ACCEPT_ADMIN_SENTENCES["accept-not-admin"], code: "accept-not-admin" });
    expect(r.body.error).toBe(
      "Only an admin device of their account can accept a co-manage invitation. Cancel this link and send a new one for them to open on an admin device.",
    );
  });

  it("refuses a non-admin device that signs with its IRK while the account pins an admin root", async () => {
    const r = await firstGrant(setup(), acceptance(member, SHARE, { signer: nonAdmin, keyKind: "irk", attested: JOIN_ADMIN, attestedKind: "admin-root" }));
    expect(r.body.code).toBe("accept-not-admin");
  });

  it("refuses a forged key: one the device made up, or one the CA never attested", async () => {
    const madeUp = deriveIRK({ seed: new Uint8Array(32).fill(99) });
    // Signed by a key of its own while the attestation names the real admin root.
    let r = await firstGrant(setup(), acceptance(member, SHARE, { signer: madeUp, attested: JOIN_ADMIN }));
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: ACCEPT_ADMIN_SENTENCES["accept-signature"], code: "accept-signature" });
    // An attestation for its own key, signed by something that isn't the CA.
    r = await firstGrant(setup(), acceptance(member, SHARE, { signer: madeUp, ca: madeUp }));
    expect(r.body.code).toBe("accept-signature");
    // A real attestation, but the #12 signature is over other bytes.
    const a = acceptance();
    const tampered = { ...a, acceptAdmin: { ...a.acceptAdmin!, signature: hex(signServerShareAccept(a.accept, JOIN_ADMIN)) } };
    r = await firstGrant(setup(), tampered);
    expect(r.body.code).toBe("accept-signature");
  });

  it("refuses a proof replayed from another share or server", async () => {
    const x = setup();
    const other = acceptance(member, "cd".repeat(16));
    const mine = acceptance();
    const r = await firstGrant(x, { ...mine, acceptAdmin: other.acceptAdmin });
    expect(r.body.code).toBe("accept-signature");
    const elsewhere = adminProof({ ...mine.accept, serverDomain: "media.harry.flagship.services" });
    expect((await firstGrant(x, { ...mine, acceptAdmin: elsewhere })).body.code).toBe("accept-signature");
    expect(x.store.get(SHARE)).toBeNull();
  });

  it("refuses the same acceptance once the share has ended", async () => {
    const x = setup();
    const a = acceptance();
    expect((await firstGrant(x, a)).status).toBe(200);
    await x.store.end(SHARE, "revoked");
    clock += 1;
    expect((await firstGrant(x, a)).status).toBe(410);
  });

  it("refuses an acceptance too old to check, and one from the future", async () => {
    const start = clock;
    const a = acceptance();
    clock = start + 15 * 24 * 3600_000;
    let r = await firstGrant(setup(), a);
    expect(r.body).toEqual({ error: ACCEPT_ADMIN_SENTENCES["accept-stale"], code: "accept-stale" });
    clock = start;
    const future = { ...acceptance() };
    future.accept = { ...future.accept, acceptedAt: start + 10 * 60_000 };
    future.acceptSignature = hex(signServerShareAccept(future.accept, member));
    future.acceptAdmin = adminProof(future.accept, { issuedAt: start - 1000 });
    r = await firstGrant(setup(), future);
    expect(r.body.code).toBe("accept-stale");
  });

  it("says so when it can't check (no live CA lease on this box)", async () => {
    const x = setup({
      verifyAcceptAdmin: (accept, proof) => checkShareAcceptAdmin({ accept, proof, chain: { authorizedCaKeys: () => [] }, now: now() }),
    });
    const r = await firstGrant(x, acceptance());
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("accept-unverifiable");
    expect(r.body.error).toBe(ACCEPT_ADMIN_SENTENCES["accept-unverifiable"]);
  });

  it("follows the no-admin-root fallback: the IRK of an account that pins none", async () => {
    const r = await firstGrant(setup(), acceptance(member, SHARE, { signer: nonAdmin, keyKind: "irk" }));
    expect(r.status).toBe(200);
  });

  it("works the same for a demo account (its admin root, derived on .com)", async () => {
    const demoRoot = deriveDemoAdminRoot(new Uint8Array(32).fill(5), "playstore-test-0725");
    const r = await firstGrant(setup(), acceptance(member, SHARE, { signer: demoRoot }));
    expect(r.status).toBe(200);
  });

  it("asks for the proof only on the first grant; a change keeps it", async () => {
    const x = setup();
    await firstGrant(x, acceptance());
    clock += 1;
    const g = grantOf({ level: "manage" });
    const r = parse(await x.http(req("POST", "/api/screens/shares", OWNER_TOKEN, { grant: g, signature: hex(signServerShareGrant(g, owner)) })));
    expect(r.status).toBe(200);
    expect(x.store.get(SHARE)?.acceptAdmin).toBeDefined();
  });

  it("keeps the proof across a restart without checking it again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shares-admin-"));
    const x = setup({ dir });
    await firstGrant(x, acceptance());
    const y = setup({ dir, verifyAcceptAdmin: () => ({ ok: false, status: 503, code: "accept-unverifiable", error: "x" }) });
    await y.store.load();
    expect(y.store.get(SHARE)?.acceptAdmin?.admit.keyKind).toBe("admin-root");
  });
});

describe("ended shares from .com", () => {
  it("ends shares whose revoke or leave verifies here, and ignores forgeries", async () => {
    const x = setup();
    await grant(x);
    const SHARE2 = "cd".repeat(16);
    const member2 = deriveShareMemberKey(memberUmk, SHARE2);
    const g2 = grantOf({ shareId: SHARE2, memberPubHex: hex(member2.publicKey), label: "Rose" });
    const a2 = { serverDomain: BOX, shareId: SHARE2, memberPubHex: hex(member2.publicKey), acceptedAt: clock };
    await x.store.put(g2, hex(signServerShareGrant(g2, owner)), a2, hex(signServerShareAccept(a2, member2)), adminProof(a2));
    const revoke = { serverDomain: BOX, shareId: SHARE, issuedAt: clock };
    const leave = { serverDomain: BOX, shareId: SHARE2, memberPubHex: hex(member2.publicKey), issuedAt: clock };
    const ends = [
      { shareId: SHARE, kind: "revoke", endedAt: clock + 5, revoke, signature: hex(signServerShareRevoke(revoke, stranger)) },
      { shareId: SHARE2, kind: "leave", endedAt: clock + 6, leave, signature: hex(signServerShareLeave(leave, member)) },
    ];
    const fetchImpl = (async () => new Response(JSON.stringify({ ends }))) as unknown as typeof fetch;
    const d = { serverDomain: BOX, controlPlaneBaseUrl: "https://c", store: x.store, shares: x.shares, verifyOwnerRevoke: (r: never, s: Uint8Array) => authorizeSensitiveOrder({ ...x.auth, order: r, signature: s, verify: verifyServerShareRevoke }), fetchImpl };
    expect(await pollShareEndsOnce(d)).toBe(0);
    expect(x.store.list()).toHaveLength(2);
    expect(x.store.cursor()).toBe(clock + 6);
    ends[0]!.signature = hex(signServerShareRevoke(revoke, owner));
    ends[1]!.signature = hex(signServerShareLeave(leave, member2));
    expect(await pollShareEndsOnce(d)).toBe(2);
    expect(x.store.list()).toHaveLength(0);
  });
});

describe("route map", () => {
  it("defaults to the owner and needs the opt-in for app data", () => {
    expect(shareRouteNeed("GET", "/api/screens/whatever")).toBeNull();
    expect(shareRouteNeed("DELETE", "/api/screens/paired-sessions/abcd")).toBeNull();
    expect(shareRouteNeed("POST", "/api/power")).toBeNull();
    expect(shareRouteNeed("GET", "/api/screens/server-detail?x=1")).toMatchObject({ level: "view" });
    const write = shareRouteNeed("POST", "/api/screens/services/a/db/default/query", Buffer.from('{"sql":"x","grant":{}}'));
    expect(write).toMatchObject({ level: "manage", data: true, action: "db.write" });
    expect(shareRefusal({ level: "manage", seeAppData: false }, write)).toBe("app-data-not-shared");
    expect(shareRefusal({ level: "view", seeAppData: true }, write)).toBe("manage-only");
    expect(shareRefusal({ level: "manage", seeAppData: true }, write)).toBeNull();
    const read = shareRouteNeed("POST", "/api/screens/services/a/db/default/query", Buffer.from('{"sql":"select 1"}'));
    expect(shareRefusal({ level: "view", seeAppData: true }, read)).toBeNull();
    expect(shareRouteNeed("POST", "/api/screens/lineage-resolve", Buffer.from('{"decision":"accept","serviceId":"a"}'))).toMatchObject({ level: "manage", target: "a" });
  });
});

describe("app data at manage level", () => {
  const sql = "DELETE FROM notes;";
  const dbGrant = () => ({ serverDomain: BOX, serviceId: "harry-notes", store: "default", sqlSha256: appDbSqlSha256(sql), issuedAt: clock });
  const Q = "/api/screens/services/harry-notes/db/default/query";

  async function dbAs(o: Partial<ServerShareGrant>) {
    const x = setup();
    await grant(x, o);
    const token = (await signIn(x)).body.token as string;
    const ran: boolean[] = [];
    const db = buildOwnerDbHttp({
      serverDomain: BOX,
      username: "harry",
      ownerIrkPub: owner.publicKey,
      app: () => ({ data: { creator: "harry", slug: "notes", postgresSingleton: true, postgres: { default: { url: "postgresql://x", database: "d", role: "r" } } } }),
      sql: {
        query: async (a: { readOnly: boolean }) => {
          ran.push(!a.readOnly);
          return { command: "DELETE", columns: [], rows: [], rowCount: 0, truncated: false };
        },
      } as never,
      now,
      log: () => {},
    });
    const gate = x.shares.gate({ check: () => ({ status: 401, body: "{}" }) });
    const send = async (signer: Keypair) => {
      const g = dbGrant();
      const r = req("POST", Q, token, { sql, grant: g, signature: hex(signAppDbWriteGrant(g, signer)) });
      const denied = gate.check(r);
      if (denied) return parse(denied);
      return parse(await db(Q, "POST", r));
    };
    return { send, ran };
  }

  it("runs a statement the member signed only with manage and the app-data opt-in", async () => {
    expect((await (await dbAs({ level: "manage", seeAppData: false })).send(member)).body.error).toBe("app-data-not-shared");
    expect((await (await dbAs({ level: "view", seeAppData: true })).send(member)).body.error).toBe("manage-only");
    const ok = await dbAs({ level: "manage", seeAppData: true });
    expect((await ok.send(stranger)).status).toBe(403);
    expect((await ok.send(owner)).status).toBe(403);
    expect((await ok.send(member)).status).toBe(200);
    expect(ok.ran).toEqual([true]);
  });
});

describe("co-manager invites (docs/service-access-gating.md \"Co-manager invites\")", () => {
  function withInvites() {
    const changes: { level: string; end: string | null }[] = [];
    const handled: string[] = [];
    const invites = {
      handle: async (c: { shareId: string }, r: HttpRequest) => {
        handled.push(`${c.shareId}:${r.method} ${r.path}`);
        return { status: 200, headers: {}, body: "{}" };
      },
      onShareChange: async (ch: { grant: ServerShareGrant; end?: { kind: string } }) => {
        changes.push({ level: ch.grant.level, end: ch.end?.kind ?? null });
      },
    } as unknown as ShareInvites;
    return { x: setup({ invites }), changes, handled };
  }

  it("hands /api/shares/invites to the invites handler only over a share session", async () => {
    const { x, handled } = withInvites();
    await grant(x, { level: "manage" });
    expect((await x.http(req("GET", "/api/shares/invites?service=harry-weather", null)))!.status).toBe(401);
    const s = await signIn(x);
    expect((await x.http(req("GET", "/api/shares/invites?service=harry-weather", s.body.token)))!.status).toBe(200);
    expect((await x.http(req("POST", "/api/shares/invites/withdraw", s.body.token, {})))!.status).toBe(200);
    expect(handled).toEqual([`${SHARE}:GET /api/shares/invites?service=harry-weather`, `${SHARE}:POST /api/shares/invites/withdraw`]);
  });

  it("tells the invites handler about a level change and about the end, with its signed proof", async () => {
    const { x, changes } = withInvites();
    await grant(x, { level: "manage" });
    clock += 1;
    await grant(x, { level: "view", issuedAt: clock }, owner, false);
    const revoke = { serverDomain: BOX, shareId: SHARE, issuedAt: clock };
    expect(parse(await x.http(req("POST", "/api/screens/shares/revoke", OWNER_TOKEN, { revoke, signature: hex(signServerShareRevoke(revoke, owner)) }))).status).toBe(200);
    expect(changes).toEqual([
      { level: "view", end: null },
      { level: "view", end: "revoke" },
    ]);
  });

  it("a leave reaches it with the co-manager's signed leave", async () => {
    const { x, changes } = withInvites();
    await grant(x, { level: "manage" });
    const leave = { serverDomain: BOX, shareId: SHARE, memberPubHex: hex(member.publicKey), issuedAt: clock };
    expect((await x.http(req("POST", "/api/shares/leave", null, { leave, signature: hex(signServerShareLeave(leave, member)) })))!.status).toBe(200);
    expect(changes).toEqual([{ level: "manage", end: "leave" }]);
  });
});
