/**
 * Co-manager invites on the box (owner decision 2026-10-16,
 * docs/service-access-gating.md "Co-manager invites").
 *
 * Someone another account shares this server with at "Can manage" is Manager
 * in every app; like a non-admin device they invite at Member with their
 * per-share member key and withdraw only their own invites. Their links let
 * new people in only while they still may invite there: an admin demoting
 * them to Member, refusing them, a share downgraded to "Can view" or ended
 * stops them (whoever joined stays). The app's other servers check the same
 * through the `share` journal entry.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveAccountId,
  deriveIRK,
  deriveShareInviteBundleKey,
  deriveShareMemberKey,
  ed,
  randomServiceInviteId,
  sealInviteBundle,
  serviceInviteSecretHash,
  signAppRank,
  signCreateServiceInvite,
  signRedeemServiceInvite,
  signRevokeServiceInvite,
  signServerShareGrant,
  signServerShareLeave,
  signServerShareRevoke,
  verifyServiceInviteCoManagerRelay,
  type AppRankOrder,
  type CreateServiceInvite,
  type Keypair,
  type ServerShareGrant,
} from "@flagship/protocol";
import { AccessPrincipals, type ShareView } from "../src/accessPrincipals.js";
import { AccessJournal, type AccessEntry } from "../src/accessJournal.js";
import { buildMemberRolesHttp, buildRankEntryApplier } from "../src/memberRoles.js";
import { buildServiceAccessHttp, ServiceAccessStore } from "../src/serviceAccess.js";
import { ShareInviteStore, buildShareInvites, type InviteCaller } from "../src/shares/shareInvites.js";
import type { HttpRequest } from "../src/runtime.js";

const FQDN = "home.alice.flagship.services";
const FQDN2 = "home2.alice.flagship.services";
const SERVICE = "alice--club";
const NOW = 1_700_000_000_000;
const ownerUmk = { seed: new Uint8Array(32).fill(11) };
const ownerIrk = deriveIRK(ownerUmk);
const ownerAid = deriveAccountId(ownerUmk);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
function key(fill: number): Keypair {
  const priv = new Uint8Array(32).fill(fill);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
const adminRoot = key(0x5a);
const stk = key(0x77);
const coUmk = { seed: new Uint8Array(32).fill(0x33) };
const SHARE_ID = "ab".repeat(16);
const OTHER_SHARE_ID = "cd".repeat(16);
const member = deriveShareMemberKey(coUmk, SHARE_ID);
const otherMember = deriveShareMemberKey({ seed: new Uint8Array(32).fill(0x44) }, OTHER_SHARE_ID);
const MEMBER = hex(member.publicKey);
const friend = deriveAccountId({ seed: new Uint8Array(32).fill(22) });
const friend2 = deriveAccountId({ seed: new Uint8Array(32).fill(23) });

function grantOf(level: "view" | "manage", issuedAt = NOW - 1000): { grant: ServerShareGrant; signature: string } {
  const grant: ServerShareGrant = {
    serverDomain: FQDN,
    shareId: SHARE_ID,
    memberPubHex: MEMBER,
    level,
    unlockAtBoot: false,
    seeAppData: false,
    label: "Sam",
    issuedAt,
  };
  return { grant, signature: hex(signServerShareGrant(grant, adminRoot)) };
}

function signedCreate(signer: Keypair, secret: Uint8Array, extra: Partial<CreateServiceInvite> = {}) {
  const inviteId = randomServiceInviteId();
  const create: CreateServiceInvite = {
    inviteId,
    authorAID: ownerAid.publicKey,
    serviceRef: SERVICE,
    secretHash: serviceInviteSecretHash(secret),
    encryptedBundle: sealInviteBundle({ name: "Alex" }, deriveShareInviteBundleKey(coUmk, SHARE_ID), inviteId),
    issuedAt: NOW,
    ...extra,
  };
  return {
    inviteId,
    createObj: create,
    create: { ...create, authorAID: hex(create.authorAID) },
    createSig: hex(signCreateServiceInvite(create, signer)),
    creatorPubHex: hex(signer.publicKey),
  };
}

/** One box. `fqdn` FQDN holds the share (shares() lists it); FQDN2 doesn't. */
function box(fqdn = FQDN, opts: { defaultRole?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "coinv-"));
  const shares: ShareView[] = fqdn === FQDN ? [{ shareId: SHARE_ID, memberPubHex: MEMBER, label: "Sam", level: "manage" }] : [];
  const principals = new AccessPrincipals(hex(ownerAid.publicKey));
  principals.shares = () => shares;
  const store = new ServiceAccessStore(join(dir, "service-access.json"), {
    ownerAidHex: hex(ownerAid.publicKey),
    principals,
    serverDomain: fqdn,
  });
  let carrier: ReturnType<typeof signedCreate> | null = null;
  let boundAID = hex(friend.publicKey);
  const fetchImpl = (async () =>
    Response.json({ redeemed: true, approvalMode: "auto", firstBind: true, serviceRef: SERVICE, boundAID, ...carrier })) as unknown as typeof fetch;
  const recorded: { ref: string; entry: AccessEntry }[] = [];
  const access = buildServiceAccessHttp({
    serverId: fqdn,
    ownerIrkPub: ownerIrk.publicKey,
    ownerAidPub: ownerAid.publicKey,
    adminRootPub: adminRoot.publicKey,
    store,
    serviceInstalled: (ref) => ref === SERVICE,
    controlPlaneBaseUrl: "https://flagshipserver.com",
    fetchImpl,
    onEntry: (ref, entry) => recorded.push({ ref, entry }),
    now: () => NOW,
  });
  const manifest = { access: { enabled: true as const, default_role: opts.defaultRole ?? "member" } };
  const memberOpts = {
    ownerIrkPub: ownerIrk.publicKey,
    adminRootPub: adminRoot.publicKey,
    username: "alice",
    store,
    app: (id: string) => (id === SERVICE ? { manifest: manifest as never } : null),
    now: () => NOW,
  };
  const roles = buildMemberRolesHttp({ ...memberOpts, serverDomain: fqdn });
  const applyRank = buildRankEntryApplier(memberOpts);
  const apply = (e: AccessEntry) => (e.kind === "rank" ? applyRank(SERVICE, e) : access.applyEntry(SERVICE, e));
  const post = async (path: string, body: unknown) =>
    (await access.handle({ method: "POST", path, headers: { host: fqdn }, body: Buffer.from(JSON.stringify(body)) }))!;

  async function redeem(c: ReturnType<typeof signedCreate>, secret: Uint8Array, who: Keypair = friend) {
    carrier = c;
    boundAID = hex(who.publicKey);
    const secretHash = serviceInviteSecretHash(secret);
    const aidSig = hex(signRedeemServiceInvite({ secretHash, visitorAID: who.publicKey, redeemedAt: NOW }, who));
    const res = await post("/api/service-invites/redeem", { secret: hex(secret), visitorAID: boundAID, aidSig, redeemedAt: NOW });
    return { res, body: JSON.parse(String(res.body)) as Record<string, unknown> };
  }
  async function inviteAndRedeem(who: Keypair = friend, signer: Keypair = member) {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const c = signedCreate(signer, secret);
    return { ...(await redeem(c, secret, who)), c, secret };
  }
  async function rank(r: string, issuedAt = NOW, target = `share:${SHARE_ID}`) {
    const o: AppRankOrder = { serviceRef: SERVICE, target, rank: r, issuedAt };
    const req: HttpRequest = {
      method: "POST",
      path: `/api/screens/services/${SERVICE}/members/rank`,
      headers: {},
      body: Buffer.from(JSON.stringify({ order: o, signature: hex(signAppRank(o, adminRoot)) })),
    };
    const res = (await roles(req.path, "POST", req))!;
    return { res, entry: { kind: "rank", order: o, signature: hex(signAppRank(o, adminRoot)) } as AccessEntry };
  }
  async function list() {
    const req: HttpRequest = { method: "GET", path: `/api/screens/services/${SERVICE}/members`, headers: {}, body: Buffer.alloc(0) };
    return JSON.parse(String((await roles(req.path, "GET", req))!.body));
  }
  async function withdraw(inviteId: string, signer: Keypair) {
    const revoke = { inviteId, issuedAt: NOW };
    return post("/api/service-access/invite-withdraw", { revoke, signature: hex(signRevokeServiceInvite(revoke, signer)) });
  }
  return { store, access, shares, recorded, apply, redeem, inviteAndRedeem, rank, list, withdraw };
}

describe("redeeming a co-manager's invite on the server they share", () => {
  it("lets the person in at Member, even where the app's default is higher, and records who invited", async () => {
    const b = box(FQDN, { defaultRole: "master" });
    const { res, body, c } = await b.inviteAndRedeem();
    expect(res.status).toBe(200);
    expect(body.tier).toBe("co-manager");
    expect(b.store.effectiveRank(SERVICE, hex(friend.publicKey), "master")).toBe("member");
    const l = await b.list();
    expect(l.invites).toEqual([
      expect.objectContaining({ inviteId: c.inviteId, tier: "co-manager", creatorPub: MEMBER, creatorShareId: SHARE_ID, creatorLabel: "Sam", role: "member" }),
    ]);
    expect(b.recorded.map((r) => r.entry.kind)).toEqual(["join"]);
  });

  for (const r of ["member", "refused"] as const) {
    it(`an admin's ${r} order on the co-manager stops their links; whoever joined stays`, async () => {
      const b = box();
      await b.inviteAndRedeem(friend);
      expect((await b.rank(r)).res.status).toBe(200);
      const late = await b.inviteAndRedeem(friend2);
      expect(late.res.status).toBe(403);
      expect(String(late.body.error)).toMatch(/can no longer invite people to this app/);
      expect(b.store.isAllowed(SERVICE, hex(friend.publicKey))).toBe(true);
      expect(b.store.isAllowed(SERVICE, hex(friend2.publicKey))).toBe(false);
    });
  }

  it("an admin raising them to Master keeps their links working (still capped at Member)", async () => {
    const b = box();
    await b.rank("master");
    const { res } = await b.inviteAndRedeem();
    expect(res.status).toBe(200);
    expect(b.store.effectiveRank(SERVICE, hex(friend.publicKey), "member")).toBe("member");
  });

  it("a share downgraded to Can view stops their links", async () => {
    const b = box();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const c = signedCreate(member, secret);
    b.shares[0]!.level = "view";
    const r = await b.redeem(c, secret);
    expect(r.res.status).toBe(403);
    expect(b.store.coManagerInviteStanding(SERVICE, MEMBER)).toEqual({ ok: false, why: "view-only" });
  });

  it("an ended share stops their links", async () => {
    const b = box();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const c = signedCreate(member, secret);
    b.shares.length = 0;
    expect((await b.redeem(c, secret)).res.status).toBe(403);
  });

  it("another server's co-manager key that this box never heard of signs nothing", async () => {
    const b = box();
    expect((await b.inviteAndRedeem(friend, otherMember)).res.status).toBe(403);
  });
});

describe("withdrawing a co-manager's invite", () => {
  it("the member key withdraws its own invite and removes who joined through it", async () => {
    const b = box();
    const { c } = await b.inviteAndRedeem();
    const res = await b.withdraw(c.inviteId, member);
    expect(res.status).toBe(200);
    expect(JSON.parse(String(res.body)).pruned).toBe(1);
    expect(b.store.isAllowed(SERVICE, hex(friend.publicKey))).toBe(false);
    expect(b.recorded.map((r) => r.entry.kind)).toEqual(["join", "withdraw"]);
  });

  it("another key can't, and a demoted co-manager withdraws nobody", async () => {
    const b = box();
    const { c } = await b.inviteAndRedeem();
    expect((await b.withdraw(c.inviteId, otherMember)).status).toBe(403);
    await b.rank("member");
    expect((await b.withdraw(c.inviteId, member)).status).toBe(403);
    expect(b.store.isAllowed(SERVICE, hex(friend.publicKey))).toBe(true);
  });

  it("an admin still withdraws it", async () => {
    const b = box();
    const { c } = await b.inviteAndRedeem();
    expect((await b.withdraw(c.inviteId, adminRoot)).status).toBe(200);
    expect(b.store.isAllowed(SERVICE, hex(friend.publicKey))).toBe(false);
  });
});

describe("the app's other servers (one list per app)", () => {
  function shareEntry(level: "view" | "manage", issuedAt = NOW - 1000, end?: "revoke" | "leave"): AccessEntry {
    const { grant, signature } = grantOf(level, issuedAt);
    const e: AccessEntry = { kind: "share", grant: { ...grant }, signature };
    if (end === "revoke") {
      const revoke = { serverDomain: FQDN, shareId: SHARE_ID, issuedAt: NOW };
      e.end = { kind: "revoke", revoke, signature: hex(signServerShareRevoke(revoke, adminRoot)) };
    } else if (end === "leave") {
      const leave = { serverDomain: FQDN, shareId: SHARE_ID, memberPubHex: MEMBER, issuedAt: NOW };
      e.end = { kind: "leave", leave, signature: hex(signServerShareLeave(leave, member)) };
    }
    return e;
  }

  it("a server without the share takes a join through the co-manager's invite once it has the share's grant", async () => {
    const one = box(FQDN);
    const two = box(FQDN2);
    await one.inviteAndRedeem();
    const join = one.recorded.find((r) => r.entry.kind === "join")!.entry;
    expect(await two.apply(join)).toBe("refused");
    expect(await two.apply(shareEntry("manage"))).toBe("applied");
    expect(await two.apply(join)).toBe("applied");
    expect(two.store.effectiveRank(SERVICE, hex(friend.publicKey), "master")).toBe("member");
    expect((await two.list()).invites[0]).toEqual(expect.objectContaining({ tier: "co-manager", creatorShareId: SHARE_ID, creatorLabel: "Sam" }));
  });

  it("refuses a share grant the owner didn't sign", async () => {
    const two = box(FQDN2);
    const e = shareEntry("manage");
    if (e.kind === "share") e.signature = hex(signServerShareGrant(grantOf("manage").grant, key(9)));
    expect(await two.apply(e)).toBe("refused");
  });

  for (const how of ["view", "revoke", "leave", "demoted"] as const) {
    it(`stops new joins there too once the share is ${how === "view" ? "downgraded to view" : how === "demoted" ? "demoted in the app" : `ended (${how})`}`, async () => {
      const one = box(FQDN);
      const two = box(FQDN2);
      expect(await two.apply(shareEntry("manage"))).toBe("applied");
      if (how === "view") expect(await two.apply(shareEntry("view", NOW - 500))).toBe("applied");
      else if (how === "demoted") expect(await two.apply((await one.rank("member")).entry)).toBe("applied");
      else expect(await two.apply(shareEntry("manage", NOW - 1000, how))).toBe("applied");
      const secret = crypto.getRandomValues(new Uint8Array(32));
      const c = signedCreate(member, secret);
      expect((await two.redeem(c, secret)).res.status).toBe(403);
    });
  }

  it("an older grant never overrides a newer one, and an end is final", async () => {
    const two = box(FQDN2);
    expect(await two.apply(shareEntry("view", NOW - 100))).toBe("applied");
    expect(await two.apply(shareEntry("manage", NOW - 1000))).toBe("stale");
    expect(await two.apply(shareEntry("manage", NOW - 50, "revoke"))).toBe("applied");
    expect(await two.apply(shareEntry("manage", NOW))).toBe("stale");
    expect(two.store.coManagerInviteStanding(SERVICE, MEMBER)).toEqual({ ok: false, why: "not-shared" });
  });

  it("the server holding the share never takes the journal's word over its own share store", async () => {
    const one = box(FQDN);
    expect(await one.apply(shareEntry("manage"))).toBe("applied");
    one.shares.length = 0;
    expect(one.store.coManagerInviteStanding(SERVICE, MEMBER)).toEqual({ ok: false, why: "not-shared" });
  });

  it("the journal keeps the newest grant per share and an end over everything", async () => {
    const j = new AccessJournal(join(mkdtempSync(join(tmpdir(), "coj-")), "j.json"));
    expect(await j.add(SERVICE, shareEntry("manage", NOW - 100))).toBe(true);
    expect(await j.add(SERVICE, shareEntry("view", NOW - 200))).toBe(false);
    expect(await j.add(SERVICE, shareEntry("view", NOW - 50))).toBe(true);
    expect(await j.add(SERVICE, shareEntry("view", NOW - 50, "leave"))).toBe(true);
    expect(await j.add(SERVICE, shareEntry("manage", NOW + 50))).toBe(false);
    expect(j.entries(SERVICE)).toHaveLength(1);
  });
});

describe("the co-manager's own routes (/api/shares/invites)", () => {
  function routes(level: "view" | "manage" = "manage", comStatus = 200) {
    const b = box();
    b.shares[0]!.level = level;
    const inviteStore = new ShareInviteStore(null);
    const posted: { url: string; body: Record<string, unknown> }[] = [];
    const journal: { ref: string; entry: AccessEntry }[] = [];
    const inv = buildShareInvites({
      serverDomain: FQDN,
      username: "alice",
      ownerAidHex: hex(ownerAid.publicKey),
      controlPlaneBaseUrl: "https://flagshipserver.com",
      stk,
      store: inviteStore,
      access: () => b.store,
      installed: (ref) => ref === SERVICE,
      record: (ref, entry) => journal.push({ ref, entry }),
      fetchImpl: (async (url: string, init: RequestInit) => {
        posted.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return new Response("{}", { status: comStatus });
      }) as unknown as typeof fetch,
      now: () => NOW,
    });
    const { grant, signature } = grantOf(level);
    const caller: InviteCaller = { shareId: SHARE_ID, label: "Sam", level, memberPubHex: MEMBER, grant, grantSignature: signature };
    const call = async (method: string, path: string, body?: unknown) => {
      const res = (await inv.handle(caller, { method, path, headers: {}, body: Buffer.from(body ? JSON.stringify(body) : "") }))!;
      return { status: res.status, body: JSON.parse(String(res.body)) as Record<string, unknown> };
    };
    const create = (signer: Keypair = member, extra: Partial<CreateServiceInvite> = {}) => {
      const c = signedCreate(signer, crypto.getRandomValues(new Uint8Array(32)), extra);
      return call("POST", "/api/shares/invites", { request: c.create, signature: c.createSig }).then((r) => ({ ...r, c }));
    };
    return { b, inv, inviteStore, posted, journal, call, create };
  }

  it("lists whether they may invite, the owner AID and their own invites", async () => {
    const r = routes();
    const before = await r.call("GET", `/api/shares/invites?service=${SERVICE}`);
    expect(before.body).toEqual(expect.objectContaining({ canInvite: true, why: null, rank: "manager", ownerAid: hex(ownerAid.publicKey), invites: [] }));
    const made = await r.create();
    expect(made.status).toBe(200);
    const after = await r.call("GET", `/api/shares/invites?service=${SERVICE}`);
    expect((after.body.invites as unknown[]).length).toBe(1);
    expect((after.body.invites as Record<string, unknown>[])[0]).toEqual(
      expect.objectContaining({ inviteId: made.c.inviteId, encryptedBundle: made.c.create.encryptedBundle, joined: 0 }),
    );
    expect((await r.call("GET", "/api/shares/invites?service=nope")).status).toBe(404);
  });

  it("relays the create to .com with the box's signature over it, and journals the share", async () => {
    const r = routes();
    const made = await r.create();
    expect(made.body).toEqual({ created: true, inviteId: made.c.inviteId, tier: "co-manager" });
    expect(r.posted).toHaveLength(1);
    const sent = r.posted[0]!;
    expect(sent.url).toBe("https://flagshipserver.com/api/users/alice/service-invites");
    const req = sent.body.request as Record<string, unknown>;
    const relay = sent.body.relay as { serverDomain: string; issuedAt: number; signature: string };
    expect(req.creatorPubHex).toBe(MEMBER);
    expect(
      verifyServiceInviteCoManagerRelay(
        {
          username: "alice",
          serverDomain: FQDN,
          inviteId: made.c.inviteId,
          serviceRef: SERVICE,
          creatorPubHex: MEMBER,
          createSigHex: made.c.createSig,
          issuedAt: relay.issuedAt,
        },
        Buffer.from(relay.signature, "hex"),
        stk.publicKey,
      ),
    ).toBe(true);
    // Who made it is recorded before anyone can join through it.
    expect(r.b.store.inviteTier(SERVICE, made.c.inviteId)).toBe("co-manager");
    expect(r.b.store.inviteCreator(SERVICE, made.c.inviteId)).toBe(MEMBER);
    expect(r.journal.map((j) => j.entry.kind)).toEqual(["share"]);
    expect(JSON.stringify(sent.body)).not.toContain(SHARE_ID);
  });

  it("refuses a view-only share, a demoted co-manager, a wrong author and a bad signature, and says why", async () => {
    const view = routes("view");
    expect((await view.create()).body.code).toBe("view-only");
    expect((await view.call("GET", `/api/shares/invites?service=${SERVICE}`)).body).toEqual(
      expect.objectContaining({ canInvite: false, why: "view-only" }),
    );
    const r = routes();
    expect((await r.create(member, { authorAID: key(3).publicKey })).body.code).toBe("wrong-author");
    expect((await r.create(otherMember)).body.code).toBe("invalid-signature");
    await r.b.rank("member");
    const demoted = await r.create();
    expect([demoted.status, demoted.body.code, demoted.body.error]).toEqual([
      403,
      "demoted",
      "An admin made you a Member of this app, so you can't invite people to it.",
    ]);
    expect(r.posted).toHaveLength(0);
  });

  it("keeps nothing when .com refuses", async () => {
    const r = routes("manage", 403);
    const made = await r.create();
    expect([made.status, made.body.code]).toEqual([502, "com-refused"]);
    expect(r.inviteStore.list(SHARE_ID)).toHaveLength(0);
    expect(r.b.store.inviteTier(SERVICE, made.c.inviteId)).toBeNull();
  });

  it("withdraws their own invite: prunes who joined, journals it, tells .com", async () => {
    const r = routes();
    const made = await r.create();
    // Bind someone through it as a redeem on the box would.
    await r.b.store.addAllowed(SERVICE, hex(friend.publicKey), made.c.inviteId);
    const revoke = { inviteId: made.c.inviteId, issuedAt: NOW };
    const w = await r.call("POST", "/api/shares/invites/withdraw", { revoke, signature: hex(signRevokeServiceInvite(revoke, member)) });
    expect(w.body).toEqual({ ok: true, pruned: 1, comNotified: true });
    expect(r.b.store.isAllowed(SERVICE, hex(friend.publicKey))).toBe(false);
    expect(r.posted.at(-1)!.url).toBe("https://flagshipserver.com/api/users/alice/service-invites/revoke");
    expect(r.journal.map((j) => j.entry.kind)).toEqual(["share", "withdraw"]);
    expect(r.inviteStore.list(SHARE_ID)).toHaveLength(0);
  });

  it("can't withdraw someone else's invite, nor after being demoted", async () => {
    const r = routes();
    const revokeOf = (inviteId: string, signer: Keypair) => {
      const revoke = { inviteId, issuedAt: NOW };
      return { revoke, signature: hex(signRevokeServiceInvite(revoke, signer)) };
    };
    expect((await r.call("POST", "/api/shares/invites/withdraw", revokeOf("ee".repeat(32), member))).body.code).toBe("not-yours");
    const made = await r.create();
    await r.b.rank("refused");
    expect((await r.call("POST", "/api/shares/invites/withdraw", revokeOf(made.c.inviteId, member))).body.code).toBe("refused");
  });

  it("a share change or end goes into the journal of every app the share invited people to", async () => {
    const r = routes();
    await r.create();
    const { grant, signature } = grantOf("view", NOW);
    await r.inv.onShareChange({ grant, signature });
    const revoke = { serverDomain: FQDN, shareId: SHARE_ID, issuedAt: NOW };
    await r.inv.onShareChange({ grant, signature, end: { kind: "revoke", revoke, signature: hex(signServerShareRevoke(revoke, adminRoot)) } });
    expect(r.journal.map((j) => [j.entry.kind, j.entry.kind === "share" && !!j.entry.end])).toEqual([
      ["share", false],
      ["share", false],
      ["share", true],
    ]);
    expect(r.inviteStore.list(SHARE_ID)).toHaveLength(0);
  });
});
