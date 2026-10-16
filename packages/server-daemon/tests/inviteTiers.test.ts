/**
 * Account members, ranks and who may change them, on the box (owner decision
 * 2026-10-15, docs/service-access-gating.md).
 *
 * The box classifies every signing key itself: a device of the account (its
 * grant in the device book, verified under the pinned admin root / IRK), a
 * co-manager (an active share's member key), or an invited person. Defaults:
 * admin device master, other devices and co-managers manager, people a
 * non-admin invited member. Only admin-signed orders change ranks (demotion
 * included), modes or the allow-list; a non-admin device that is
 * manager-class invites at Member and withdraws only its own invites; a
 * demoted creator's links stop letting new people in and it withdraws nobody.
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveAccountId,
  deriveHouseholdKey,
  deriveIRK,
  ed,
  randomServiceInviteId,
  sealInviteBundle,
  serviceInviteSecretHash,
  signAcceptServiceInvite,
  signAppRank,
  signCreateServiceInvite,
  signDeviceCapabilityGrant,
  signKnockAuthorization,
  signRedeemServiceInvite,
  signRemoveServiceAllow,
  signRevokeServiceInvite,
  signServiceAccessModeV2,
  signServiceAllowRemoveV2,
  signSetServiceAccessMode,
  type AcceptServiceInvite,
  type AppRankOrder,
  type CreateServiceInvite,
  type DeviceCapabilityGrant,
  type Keypair,
  type KnockAuthorization,
} from "@flagship/protocol";
import { AccessPrincipals, AccountDeviceBook } from "../src/accessPrincipals.js";
import { buildAppSessionResolver } from "../src/appMemberSession.js";
import { buildMemberRolesHttp } from "../src/memberRoles.js";
import {
  buildRevocationPoller,
  buildServiceAccessHttp,
  ServiceAccessStore,
  ServiceSessionStore,
} from "../src/serviceAccess.js";
import { buildServiceAccessWeb } from "../src/serviceAccessWeb.js";
import type { HttpRequest } from "../src/runtime.js";

const FQDN = "home.alice.flagship.services";
const SERVICE = "alice--club";
const NOW = 1_700_000_000_000;
const ownerUmk = { seed: new Uint8Array(32).fill(11) };
const ownerIrk = deriveIRK(ownerUmk);
const ownerAid = deriveAccountId(ownerUmk);
const household = deriveHouseholdKey(ownerUmk);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
function key(fill: number): Keypair {
  const priv = new Uint8Array(32).fill(fill);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
const adminRoot = key(0x5a);
const adminPhone = key(0x61); // admin-root-signed `admin` grant
const laptop = key(0x62); // IRK-signed grant: a non-admin device
const tablet = key(0x63); // another non-admin device
const coManager = key(0x64); // a share's member key
const SHARE_ID = "ab".repeat(16);
const friend = deriveAccountId({ seed: new Uint8Array(32).fill(22) });
const friend2 = deriveAccountId({ seed: new Uint8Array(32).fill(23) });
const FRIEND = hex(friend.publicKey);

function grantFor(device: Keypair, deviceId: string, admin: boolean): Record<string, unknown> {
  const g: DeviceCapabilityGrant = {
    grantId: `g-${deviceId.slice(0, 4)}`,
    username: "alice",
    deviceId,
    devicePubKey: device.publicKey,
    scopes: admin ? ["browse", "admin", "view-directory"] : ["browse", "view-directory"],
    issuedAt: NOW - 10,
    // A non-admin grant expired long ago: for the book (who is a device, and
    // its rank) expiry is a refresh horizon, not authority. An admin device's
    // key signing an admin-only order is `requireMasterAdmin`'s call, which
    // honours expiry.
    expiresAt: admin ? NOW + 1_000_000_000 : NOW - 5,
  };
  return {
    grantId: g.grantId,
    username: "alice",
    deviceId,
    devicePubHex: hex(device.publicKey),
    scopes: g.scopes,
    issuedAt: g.issuedAt,
    expiresAt: g.expiresAt,
    signatureHex: hex(signDeviceCapabilityGrant(g, admin ? adminRoot : ownerIrk)),
    signerRoot: admin ? "admin-root" : "membership",
  };
}
const PHONE_ID = "a1".repeat(16);
const LAPTOP_ID = "b2".repeat(16);
const TABLET_ID = "c3".repeat(16);

function signedCreate(signer: Keypair, secret: Uint8Array, inviteId = randomServiceInviteId()) {
  const create: CreateServiceInvite = {
    inviteId,
    authorAID: ownerAid.publicKey,
    serviceRef: SERVICE,
    secretHash: serviceInviteSecretHash(secret),
    encryptedBundle: sealInviteBundle({ name: "Sam" }, household, inviteId),
    issuedAt: NOW,
  };
  return {
    inviteId,
    create: { ...create, authorAID: hex(create.authorAID) },
    createSig: hex(signCreateServiceInvite(create, signer)),
    creatorPubHex: hex(signer.publicKey),
  };
}

async function box(opts: { pinned?: boolean; defaultRole?: string; grants?: Record<string, unknown>[] } = {}) {
  const pinned = opts.pinned !== false;
  const dir = mkdtempSync(join(tmpdir(), "acct-"));
  let listed = opts.grants ?? [grantFor(adminPhone, PHONE_ID, true), grantFor(laptop, LAPTOP_ID, false), grantFor(tablet, TABLET_ID, false)];
  let fetches = 0;
  const book = new AccountDeviceBook({
    path: join(dir, "account-devices.json"),
    username: "alice",
    ownerIrkPub: () => ownerIrk.publicKey,
    adminRootPub: () => (pinned ? adminRoot.publicKey : undefined),
    ownerAidHex: hex(ownerAid.publicKey),
    fetchGrants: async () => {
      fetches++;
      return { grants: listed };
    },
    now: () => NOW + fetches * 60_000,
  });
  await book.refresh();
  const principals = new AccessPrincipals(hex(ownerAid.publicKey));
  principals.book = book;
  principals.shares = () => [{ shareId: SHARE_ID, memberPubHex: hex(coManager.publicKey), label: "Sam" }];
  const store = new ServiceAccessStore(join(dir, "data/flagship-access/service-access.json"), {
    ownerAidHex: hex(ownerAid.publicKey),
    principals,
  });
  const sessions = new ServiceSessionStore(join(dir, "sessions.json"));
  let carrier: ReturnType<typeof signedCreate> | null = null;
  let boundAID = FRIEND;
  const fetchImpl = (async (url: string | URL) => {
    if (String(url).includes("/create")) return Response.json({ create: carrier!.create, createSig: carrier!.createSig, creatorPubHex: carrier!.creatorPubHex });
    return Response.json({ redeemed: true, approvalMode: "auto", firstBind: true, serviceRef: SERVICE, boundAID, ...carrier });
  }) as unknown as typeof fetch;
  const access = buildServiceAccessHttp({
    serverId: FQDN,
    ownerIrkPub: ownerIrk.publicKey,
    ownerAidPub: ownerAid.publicKey,
    ...(pinned ? { adminRootPub: adminRoot.publicKey } : {}),
    adminGrants: () => book.adminGrants(),
    store,
    sessions,
    serviceInstalled: (ref) => ref === SERVICE,
    controlPlaneBaseUrl: "https://flagshipserver.com",
    fetchImpl,
    username: "alice",
    serverDomain: FQDN,
    stk: deriveIRK({ seed: new Uint8Array(32).fill(99) }),
    now: () => NOW,
  });
  const web = buildServiceAccessWeb({ serverId: FQDN, store, sessions, now: () => NOW });
  const manifest = { access: { enabled: true as const, default_role: opts.defaultRole ?? "member" } };
  const roles = buildMemberRolesHttp({
    serverDomain: FQDN,
    ownerIrkPub: ownerIrk.publicKey,
    ...(pinned ? { adminRootPub: adminRoot.publicKey } : {}),
    username: "alice",
    adminGrants: () => book.adminGrants(),
    store,
    app: (id) => (id === SERVICE ? { manifest: manifest as never } : null),
    now: () => NOW,
  });
  let sessionAid = FRIEND;
  const resolve = buildAppSessionResolver({
    sessions: { lookup: () => ({ serviceRef: SERVICE, aid: sessionAid }) as never },
    access: store,
  });
  const app = {
    serviceId: SERVICE,
    manifest,
    membership: { stableIdFor: (pub: Uint8Array) => `stable-${hex(pub).slice(0, 8)}`, members: { getRole: () => null } },
  } as never;
  /** What the app sees for a session signed by `pubHex`. */
  const seen = (pubHex: string) => {
    sessionAid = pubHex;
    return resolve({ headers: { cookie: "Flagship-App-Session=t" } } as never, app);
  };

  const post = async (path: string, body: unknown) =>
    (await access.handle({ method: "POST", path, headers: { host: FQDN }, body: Buffer.from(JSON.stringify(body)) }))!;

  async function redeem(signer: Keypair, who: Keypair = friend) {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    carrier = signedCreate(signer, secret);
    boundAID = hex(who.publicKey);
    const secretHash = serviceInviteSecretHash(secret);
    const aidSig = hex(signRedeemServiceInvite({ secretHash, visitorAID: who.publicKey, redeemedAt: NOW }, who));
    const res = await post("/api/service-invites/redeem", { secret: hex(secret), visitorAID: boundAID, aidSig, redeemedAt: NOW });
    return { res, inviteId: carrier.inviteId, body: JSON.parse(String(res.body)) };
  }

  async function accept(signer: Keypair) {
    carrier = signedCreate(signer, crypto.getRandomValues(new Uint8Array(32)));
    const a: AcceptServiceInvite = { inviteId: carrier.inviteId, serviceRef: SERVICE, contactAID: friend.publicKey, acceptedAt: NOW };
    const res = await post("/api/service-access/accept", { accept: { ...a, contactAID: FRIEND }, acceptSig: hex(signAcceptServiceInvite(a, friend)) });
    return { res, inviteId: carrier.inviteId };
  }

  async function rank(target: string, r: string, signer: Keypair, issuedAt = NOW) {
    const o: AppRankOrder = { serviceRef: SERVICE, target, rank: r, issuedAt };
    const req: HttpRequest = {
      method: "POST",
      path: `/api/screens/services/${SERVICE}/members/rank`,
      headers: {},
      body: Buffer.from(JSON.stringify({ order: o, signature: hex(signAppRank(o, signer)) })),
    };
    return (await roles(req.path, "POST", req))!;
  }

  async function list() {
    const req: HttpRequest = { method: "GET", path: `/api/screens/services/${SERVICE}/members`, headers: {}, body: Buffer.alloc(0) };
    return JSON.parse(String((await roles(req.path, "GET", req))!.body));
  }

  async function withdraw(inviteId: string, signer: Keypair) {
    const revoke = { inviteId, issuedAt: NOW };
    return post("/api/service-access/invite-withdraw", { revoke, signature: hex(signRevokeServiceInvite(revoke, signer)) });
  }

  async function knock(signer: Keypair) {
    const page = await web.maybeServeKnock(SERVICE, { method: "GET", path: "/", headers: { host: `club.${FQDN}`, accept: "text/html" }, body: Buffer.alloc(0) });
    const pageId = /page=([0-9a-f]+)/.exec(String(page!.body))![1]!;
    const ka: KnockAuthorization = { serverId: FQDN, serviceRef: SERVICE, pageId, visitorAID: signer.publicKey, issuedAt: NOW };
    return (await web.handle({
      method: "POST",
      path: "/api/service-access/knock/authorize",
      headers: {},
      body: Buffer.from(JSON.stringify({ authorization: { ...ka, visitorAID: hex(signer.publicKey) }, sig: hex(signKnockAuthorization(ka, signer)) })),
    }))!;
  }

  return {
    store, book, access, redeem, accept, rank, list, withdraw, knock, seen, post, dir,
    setListed: (g: Record<string, unknown>[]) => { listed = g; },
    fetches: () => fetches,
  };
}

describe("default ranks, by who is signing in", () => {
  it("an admin device is master, the other devices and a co-manager manager, an unknown key nobody", async () => {
    const b = await box();
    expect(b.store.effectiveRank(SERVICE, hex(adminPhone.publicKey), "member")).toBe("master");
    expect(b.store.effectiveRank(SERVICE, hex(laptop.publicKey), "member")).toBe("manager");
    expect(b.store.effectiveRank(SERVICE, hex(coManager.publicKey), "member")).toBe("manager");
    expect(b.store.effectiveRank(SERVICE, hex(key(0x70).publicKey), "member")).toBeNull();
    expect(b.seen(hex(adminPhone.publicKey))?.role).toBe("master");
    expect(b.seen(hex(laptop.publicKey))?.role).toBe("manager");
    expect(b.seen(hex(coManager.publicKey))?.role).toBe("manager");
  });

  it("every device of the account is one person to the app (the owner AID's id); a co-manager is someone else", async () => {
    const b = await box();
    const phone = b.seen(hex(adminPhone.publicKey))!;
    const lap = b.seen(hex(laptop.publicKey))!;
    expect(phone.stableId).toBe(lap.stableId);
    expect(hex(phone.memberPub)).toBe(hex(ownerAid.publicKey));
    expect(b.seen(hex(coManager.publicKey))!.stableId).not.toBe(phone.stableId);
  });

  it("the legacy AID is a non-admin device on a pinned box, the owner on an unpinned one; there is no owner rank", async () => {
    const pinned = await box();
    expect(pinned.seen(hex(ownerAid.publicKey))?.role).toBe("manager");
    const unpinned = await box({ pinned: false });
    expect(unpinned.seen(hex(ownerAid.publicKey))?.role).toBe("master");
    expect(unpinned.seen(hex(laptop.publicKey))?.role).toBe("master");
  });

  it("a members-only app lets the account's devices and co-managers in through the knock", async () => {
    const b = await box();
    await b.store.setMode(SERVICE, "restricted");
    expect((await b.knock(laptop)).status).toBe(200);
    expect((await b.knock(coManager)).status).toBe(200);
    expect((await b.knock(key(0x70))).status).toBe(401);
  });

  it("a device the box hasn't heard of is learnt from .com at sign-in", async () => {
    const b = await box({ grants: [] });
    const before = b.fetches();
    b.setListed([grantFor(laptop, LAPTOP_ID, false)]);
    await b.store.setMode(SERVICE, "restricted");
    expect((await b.knock(laptop)).status).toBe(200);
    expect(b.fetches()).toBe(before + 1);
  });

  it("the book trusts only grants that verify under the pinned keys", async () => {
    const forged = grantFor(laptop, LAPTOP_ID, false);
    forged.scopes = ["browse", "admin", "view-directory"];
    const b = await box({ grants: [forged, { ...grantFor(tablet, TABLET_ID, true), signatureHex: "00".repeat(64) }] });
    expect(b.book.devices()).toEqual([]);
    expect(b.book.adminGrants()).toEqual([]);
  });

  it("the book is kept on disk (a restart works offline) and keeps the old list when .com fails", async () => {
    const b = await box();
    const again = new AccountDeviceBook({
      path: join(b.dir, "account-devices.json"),
      username: "alice",
      ownerIrkPub: () => ownerIrk.publicKey,
      adminRootPub: () => adminRoot.publicKey,
      fetchGrants: async () => {
        throw new Error("offline");
      },
    });
    await again.load();
    expect(again.classify(hex(adminPhone.publicKey))?.tier).toBe("admin");
    await again.refresh();
    expect(again.devices()).toHaveLength(3);
  });

  it("an IRK-signed grant naming the admin scope is still a non-admin device", async () => {
    const g = grantFor(laptop, LAPTOP_ID, false);
    const raw: DeviceCapabilityGrant = {
      grantId: String(g.grantId), username: "alice", deviceId: LAPTOP_ID, devicePubKey: laptop.publicKey,
      scopes: ["browse", "admin"], issuedAt: NOW - 10, expiresAt: NOW - 5,
    };
    const b = await box({ grants: [{ ...g, scopes: raw.scopes, signatureHex: hex(signDeviceCapabilityGrant(raw, ownerIrk)) }] });
    expect(b.book.classify(hex(laptop.publicKey))?.tier).toBe("member");
  });
});

describe("admin orders override the defaults (demotion works)", () => {
  it("an admin demotes the admin device, refuses a laptop, raises a co-manager", async () => {
    const b = await box();
    expect((await b.rank(`device:${hex(adminPhone.publicKey)}`, "member", adminRoot)).status).toBe(200);
    expect(b.seen(hex(adminPhone.publicKey))?.role).toBe("member");
    expect((await b.rank(`device:${hex(laptop.publicKey)}`, "refused", adminRoot)).status).toBe(200);
    expect(b.store.isAllowed(SERVICE, hex(laptop.publicKey))).toBe(false);
    expect(b.seen(hex(laptop.publicKey))).toBeNull();
    await b.store.setMode(SERVICE, "restricted");
    expect((await b.knock(laptop)).status).toBe(401);
    expect((await b.rank(`share:${SHARE_ID}`, "master", adminRoot)).status).toBe(200);
    expect(b.seen(hex(coManager.publicKey))?.role).toBe("master");
  });

  it("an admin device's own key signs orders too; the IRK and AID never do on a pinned box", async () => {
    const b = await box();
    expect((await b.rank(`device:${hex(laptop.publicKey)}`, "master", ownerIrk)).status).toBe(403);
    expect((await b.rank(`device:${hex(laptop.publicKey)}`, "master", ownerAid)).status).toBe(403);
    expect((await b.rank(`device:${hex(laptop.publicKey)}`, "master", laptop)).status).toBe(403);
    expect((await b.rank(`device:${hex(laptop.publicKey)}`, "master", adminPhone)).status).toBe(200);
    expect(b.seen(hex(laptop.publicKey))?.role).toBe("master");
  });

  it("latest order wins; an older one is refused", async () => {
    const b = await box();
    const t = `device:${hex(laptop.publicKey)}`;
    expect((await b.rank(t, "member", adminRoot, NOW + 5)).status).toBe(200);
    expect((await b.rank(t, "master", adminRoot, NOW + 4)).status).toBe(409);
    expect(b.seen(hex(laptop.publicKey))?.role).toBe("member");
  });

  it("refuses a target that isn't the account's, and a stale order", async () => {
    const b = await box();
    expect((await b.rank(`device:${hex(key(0x70).publicKey)}`, "member", adminRoot)).status).toBe(422);
    expect((await b.rank(`share:${"cd".repeat(16)}`, "member", adminRoot)).status).toBe(422);
    expect((await b.rank(`device:${hex(laptop.publicKey)}`, "member", adminRoot, NOW - 11 * 60_000)).status).toBe(403);
  });

  it("an aid: order replaces an invited person's grants (demotion, not highest-of)", async () => {
    const b = await box({ defaultRole: "member" });
    const { inviteId } = await b.redeem(adminRoot);
    expect((await b.rank(`invite:${inviteId}`, "master", adminRoot)).status).toBe(200);
    expect(b.seen(FRIEND)?.role).toBe("master");
    expect((await b.rank(`aid:${FRIEND}`, "member", adminRoot, NOW + 1)).status).toBe(200);
    expect(b.seen(FRIEND)?.role).toBe("member");
    expect((await b.rank(`aid:${FRIEND}`, "manager", ownerIrk, NOW + 2)).status).toBe(403);
    expect((await b.rank(`aid:${FRIEND}`, "manager", adminRoot, NOW + 2)).status).toBe(200);
    expect(b.seen(FRIEND)?.role).toBe("manager");
  });

  it("the members list shows the account members, each invite's creator, and no owner", async () => {
    const b = await box();
    await b.rank(`device:${hex(laptop.publicKey)}`, "refused", adminRoot);
    const { inviteId } = await b.redeem(tablet);
    const l = await b.list();
    expect(l.roles).toEqual(["member", "manager", "master"]);
    expect(l.accountMembers).toEqual(
      expect.arrayContaining([
        { kind: "device", deviceId: PHONE_ID, devicePub: hex(adminPhone.publicKey), tier: "admin", rank: "master", set: false, refused: false },
        { kind: "device", deviceId: LAPTOP_ID, devicePub: hex(laptop.publicKey), tier: "member", rank: null, set: true, refused: true },
        { kind: "co-manager", shareId: SHARE_ID, label: "Sam", rank: "manager", set: false, refused: false },
      ]),
    );
    expect(l.invites).toEqual([
      { inviteId, role: "member", set: false, tier: "member", creatorPub: hex(tablet.publicKey), creatorDeviceId: TABLET_ID },
    ]);
    expect(JSON.stringify(l)).not.toContain('"owner"');
  });
});

describe("invites: admins at any rank, manager-class devices at Member", () => {
  for (const defaultRole of ["master", "admin", "owner", "manager"]) {
    it(`a non-admin device's invite joins at Member (manifest default_role ${defaultRole})`, async () => {
      const b = await box({ defaultRole });
      const { res, inviteId, body } = await b.redeem(laptop);
      expect(res.status).toBe(200);
      expect(body.tier).toBe("member");
      expect(b.store.inviteTier(SERVICE, inviteId)).toBe("member");
      expect(b.store.inviteCreator(SERVICE, inviteId)).toBe(hex(laptop.publicKey));
      expect(b.seen(FRIEND)?.role).toBe("member");
    });
  }

  it("an admin root or an admin device's key makes an admin invite (both sides agree with .com)", async () => {
    const b = await box({ defaultRole: "master" });
    expect((await b.redeem(adminRoot)).body.tier).toBe("admin");
    const viaDevice = await b.redeem(adminPhone, friend2);
    expect(viaDevice.body.tier).toBe("admin");
    expect(b.store.effectiveRank(SERVICE, hex(friend2.publicKey), "master")).toBe("master");
  });

  it("the AID and IRK create nothing on a pinned box", async () => {
    const b = await box();
    expect((await b.redeem(ownerIrk)).res.status).toBe(403);
    expect((await b.redeem(ownerAid)).res.status).toBe(403);
    expect((await b.redeem(key(0x70))).res.status).toBe(403);
  });

  it("a demoted or refused device's open links stop letting new people in", async () => {
    const b = await box();
    expect((await b.rank(`device:${hex(laptop.publicKey)}`, "member", adminRoot)).status).toBe(200);
    expect((await b.redeem(laptop)).res.status).toBe(403);
    expect((await b.accept(laptop)).res.status).toBe(403);
    expect((await b.rank(`device:${hex(tablet.publicKey)}`, "refused", adminRoot)).status).toBe(200);
    expect((await b.redeem(tablet)).res.status).toBe(403);
    expect(b.store.isAllowed(SERVICE, FRIEND)).toBe(false);
  });

  it("people already in stay when the device that invited them is demoted", async () => {
    const b = await box();
    await b.redeem(laptop);
    await b.rank(`device:${hex(laptop.publicKey)}`, "member", adminRoot);
    expect(b.store.isAllowed(SERVICE, FRIEND)).toBe(true);
  });

  it("a manual-approve acceptance of a non-admin's invite is capped too", async () => {
    const b = await box({ defaultRole: "master" });
    const { res, inviteId } = await b.accept(laptop);
    expect(res.status).toBe(200);
    expect(b.store.inviteTier(SERVICE, inviteId)).toBe("member");
    expect(b.seen(FRIEND)?.role).toBe("member");
  });

  it("a box with no admin root: any account key is the owner's authority", async () => {
    const b = await box({ pinned: false, defaultRole: "master" });
    expect((await b.redeem(ownerIrk)).body.tier).toBe("admin");
    expect((await b.redeem(laptop, friend2)).body.tier).toBe("admin");
  });
});

describe("withdraw: the creating device (while manager-class) or an admin", () => {
  it("a device withdraws its own invite, and the people who joined (and used the app) are out", async () => {
    const b = await box();
    const { inviteId } = await b.redeem(laptop);
    expect(b.seen(FRIEND)?.role).toBe("member");
    const r = await b.withdraw(inviteId, laptop);
    expect(r.status).toBe(200);
    expect(JSON.parse(String(r.body)).pruned).toBe(1);
    expect(b.store.isAllowed(SERVICE, FRIEND)).toBe(false);
    expect(b.seen(FRIEND)).toBeNull();
  });

  it("another device, the IRK or the AID can't withdraw it; an admin can", async () => {
    const b = await box();
    const { inviteId } = await b.redeem(laptop);
    for (const k of [tablet, ownerIrk, ownerAid, coManager]) expect((await b.withdraw(inviteId, k)).status).toBe(403);
    expect(b.store.isAllowed(SERVICE, FRIEND)).toBe(true);
    expect((await b.withdraw(inviteId, adminRoot)).status).toBe(200);
    expect(b.store.isAllowed(SERVICE, FRIEND)).toBe(false);
  });

  it("a non-admin device can't withdraw an admin's invite", async () => {
    const b = await box();
    const { inviteId } = await b.redeem(adminRoot);
    expect((await b.withdraw(inviteId, laptop)).status).toBe(403);
  });

  it("a device demoted below manager can no longer withdraw anyone", async () => {
    const b = await box();
    const { inviteId } = await b.redeem(laptop);
    await b.rank(`device:${hex(laptop.publicKey)}`, "member", adminRoot);
    expect((await b.withdraw(inviteId, laptop)).status).toBe(403);
    expect(b.store.isAllowed(SERVICE, FRIEND)).toBe(true);
  });

  it("the revocation poller prunes only for a revoke the box verifies", async () => {
    const b = await box();
    const own = await b.redeem(laptop);
    const admins = await b.redeem(adminRoot, friend2);
    const rows = [
      // laptop's own revoke: prunes
      { inviteId: own.inviteId, serviceRef: SERVICE, boundAIDs: [FRIEND], revoke: { inviteId: own.inviteId, issuedAt: NOW }, revokeSig: hex(signRevokeServiceInvite({ inviteId: own.inviteId, issuedAt: NOW }, laptop)) },
      // .com claims the admin's invite is revoked but has no signature: ignored
      { inviteId: admins.inviteId, serviceRef: SERVICE, boundAIDs: [hex(friend2.publicKey)], revoke: null, revokeSig: null },
    ];
    const poller = buildRevocationPoller({
      controlPlaneBaseUrl: "https://flagshipserver.com",
      username: "alice",
      authorAidHex: hex(ownerAid.publicKey),
      serverDomain: FQDN,
      stk: deriveIRK({ seed: new Uint8Array(32).fill(99) }),
      store: b.store,
      verifyRevoke: b.access.verifyWithdraw,
      fetchImpl: (async () => Response.json({ revoked: rows, cursor: NOW })) as unknown as typeof fetch,
      now: () => NOW,
    });
    expect(await poller.pollOnce()).toBe(1);
    expect(b.store.isAllowed(SERVICE, FRIEND)).toBe(false);
    expect(b.store.isAllowed(SERVICE, hex(friend2.publicKey))).toBe(true);
  });
});

describe("mode and removals are admin-only on a pinned box", () => {
  const modeV1 = (signer: Keypair, mode: "open" | "restricted", issuedAt = NOW) => {
    const request = { serverId: FQDN, serviceRef: SERVICE, mode, issuedAt };
    return { request, signature: hex(signSetServiceAccessMode(request, signer)) };
  };
  const modeV2 = (signer: Keypair, mode: "open" | "restricted", issuedAt = NOW) => {
    const request = { serviceRef: SERVICE, mode, issuedAt };
    return { request, signature: hex(signServiceAccessModeV2(request, signer)) };
  };

  it("the IRK can't change the mode (v1 or v2); the admin root can, latest order wins", async () => {
    const b = await box();
    expect((await b.post("/api/service-access", modeV1(ownerIrk, "restricted"))).status).toBe(403);
    expect((await b.post("/api/service-access", modeV2(ownerIrk, "restricted"))).status).toBe(403);
    expect((await b.post("/api/service-access", modeV2(laptop, "restricted"))).status).toBe(403);
    expect(b.store.mode(SERVICE)).toBe("open");
    expect((await b.post("/api/service-access", modeV2(adminRoot, "restricted", NOW + 2))).status).toBe(200);
    expect(b.store.mode(SERVICE)).toBe("restricted");
    expect((await b.post("/api/service-access", modeV1(adminRoot, "open", NOW + 1))).status).toBe(409);
    expect((await b.post("/api/service-access", modeV2(adminPhone, "open", NOW + 3))).status).toBe(200);
    expect(b.store.mode(SERVICE)).toBe("open");
  });

  it("the IRK can't remove anyone; the admin root can (v1 and v2)", async () => {
    const b = await box();
    await b.redeem(adminRoot);
    const v1 = { serverId: FQDN, serviceRef: SERVICE, aid: FRIEND, issuedAt: NOW };
    expect((await b.post("/api/service-access/allow-remove", { request: v1, signature: hex(signRemoveServiceAllow(v1, ownerIrk)) })).status).toBe(403);
    const v2 = { serviceRef: SERVICE, aid: FRIEND, issuedAt: NOW };
    expect((await b.post("/api/service-access/allow-remove", { request: v2, signature: hex(signServiceAllowRemoveV2(v2, laptop)) })).status).toBe(403);
    expect(b.store.isAllowed(SERVICE, FRIEND)).toBe(true);
    const r = await b.post("/api/service-access/allow-remove", { request: v2, signature: hex(signServiceAllowRemoveV2(v2, adminRoot)) });
    expect(r.status).toBe(200);
    expect(b.store.isAllowed(SERVICE, FRIEND)).toBe(false);
  });

  it("a box with no admin root keeps the owner IRK as the authority", async () => {
    const b = await box({ pinned: false });
    expect((await b.post("/api/service-access", modeV2(ownerIrk, "restricted"))).status).toBe(200);
  });
});

describe("the state travels and is dropped on uninstall", () => {
  it("lives in the data folder Migrate carries, and an old /var/flagship file is moved there once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acct-mv-"));
    const legacy = join(dir, "service-access.json");
    const old = new ServiceAccessStore(legacy);
    await old.setMode(SERVICE, "restricted");
    await old.addAllowed(SERVICE, FRIEND, "inv-1");
    const path = join(dir, "data/flagship-access/service-access.json");
    const moved = new ServiceAccessStore(path, { legacyPath: legacy });
    await moved.load();
    expect(moved.mode(SERVICE)).toBe("restricted");
    expect(moved.isAllowed(SERVICE, FRIEND)).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(legacy)).toBe(false);
    // A restored copy of that file (Migrate's restore writes the data folder) reloads whole.
    const restored = join(mkdtempSync(join(tmpdir(), "acct-rs-")), "data/flagship-access");
    mkdirSync(restored, { recursive: true });
    writeFileSync(join(restored, "service-access.json"), readFileSync(path));
    const onNewBox = new ServiceAccessStore(join(restored, "service-access.json"));
    await onNewBox.load();
    expect(onNewBox.mode(SERVICE)).toBe("restricted");
    expect(onNewBox.grants(SERVICE, FRIEND)).toEqual(["inv-1"]);
  });

  it("app copy and archive carry the ranks and the invite creators", async () => {
    const b = await box();
    const { inviteId } = await b.redeem(laptop);
    await b.rank(`device:${hex(tablet.publicKey)}`, "refused", adminRoot);
    const copy = await box();
    await copy.store.importEntry(SERVICE, b.store.exportEntry(SERVICE)!);
    expect(copy.store.inviteCreator(SERVICE, inviteId)).toBe(hex(laptop.publicKey));
    expect(copy.store.isAllowed(SERVICE, hex(tablet.publicKey))).toBe(false);
    expect(copy.seen(FRIEND)?.role).toBe("member");
  });

  it("uninstall forgets the app's entry: a reinstall under the same id starts clean", async () => {
    const b = await box();
    await b.redeem(adminRoot);
    await b.store.setMode(SERVICE, "restricted");
    await b.rank(`device:${hex(laptop.publicKey)}`, "refused", adminRoot);
    expect(await b.store.forget(SERVICE)).toBe(true);
    expect(b.store.mode(SERVICE)).toBe("open");
    expect(b.store.allowList(SERVICE)).toEqual([]);
    expect(b.store.isAllowed(SERVICE, hex(laptop.publicKey))).toBe(true);
  });

  it("member tier is sticky, and so is the first recorded creator", async () => {
    const b = await box();
    await b.store.setInviteTier(SERVICE, "inv-1", "member");
    await b.store.setInviteTier(SERVICE, "inv-1", "admin");
    expect(b.store.inviteTier(SERVICE, "inv-1")).toBe("member");
    await b.store.setInviteCreator(SERVICE, "inv-1", hex(laptop.publicKey));
    await b.store.setInviteCreator(SERVICE, "inv-1", hex(adminRoot.publicKey));
    expect(b.store.inviteCreator(SERVICE, "inv-1")).toBe(hex(laptop.publicKey));
  });
});
