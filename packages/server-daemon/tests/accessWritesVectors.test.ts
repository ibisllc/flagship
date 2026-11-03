/**
 * The access WRITES as the TypeScript implementation makes them (release plan R4), for the Rust authority to match:
 *
 * - "people": who each key is on a box, from the device book, the revocations and the share list on disk
 *   (`AccountDeviceBook` + `AccessPrincipals` + `ShareStore.load`);
 * - "scenarios": sequences of handed-over journal entries (`applyEntry` and the rank applier, as `accessSync`
 *   applies them) and of the store's own changes (`ServiceAccessStore`), with each step's result, the state file
 *   after it, and the app's journal digest (an entry is kept only when it was not refused, as `take()` does).
 *
 * `test-vectors/access-writes.json` is written here (UPDATE_ACCESS_VECTORS=1) and read by
 * rust/crates/flagship-access/tests/write_vectors.rs, which must reach the same results and the same states.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveAccountId,
  ed,
  signAcceptServiceInvite,
  signAppRank,
  signCreateServiceInvite,
  signDeviceCapabilityGrant,
  signRedeemServiceInvite,
  signRevokeServiceInvite,
  signServerShareAccept,
  signServerShareGrant,
  signServerShareRevoke,
  signServiceAccessModeV2,
  signServiceAllowRemoveV2,
  verifyServerShareGrant,
  type DeviceCapabilityGrant,
  type Keypair,
} from "@flagship/protocol";
import { AccessPrincipals, AccountDeviceBook } from "../src/accessPrincipals.js";
import { AccessJournal, type AccessEntry } from "../src/accessJournal.js";
import { authorizeSensitiveOrder } from "../src/adminAuthorityLocal.js";
import { buildRankEntryApplier } from "../src/memberRoles.js";
import { buildServiceAccessHttp, ServiceAccessStore } from "../src/serviceAccess.js";
import { ShareStore } from "../src/shares/shareStore.js";

const FILE = new URL("../test-vectors/access-writes.json", import.meta.url);
const NOW = 1_800_000_000_000;
const APP = "alice--club";
const DOMAIN = "home.alice.flagship.services";
const OTHER = "home2.alice.flagship.services";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const key = (fill: number): Keypair => {
  const priv = new Uint8Array(32).fill(fill);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
};
const irk = key(0x11);
const ownerAid = deriveAccountId({ seed: new Uint8Array(32).fill(12) });
const root = key(0x5a);
const adminDev = key(0x61);
const laptop = key(0x62);
const tablet = key(0x63);
const revokedDev = key(0x64);
const forged = key(0x65);
const twice = key(0x66);
const stranger = key(0x71);
const member = key(0x81);
const otherMember = key(0x82);
const endedMember = key(0x83);
const remoteMember = key(0x84);
const person = (n: number) => deriveAccountId({ seed: new Uint8Array(32).fill(n) });
const [friend, friend2, friend3, friend4, contact] = [person(21), person(22), person(23), person(24), person(25)];

function listed(k: Keypair, id: string, signer: Keypair, opts: { scopes?: string[]; username?: string } = {}) {
  const g: DeviceCapabilityGrant = {
    grantId: id,
    username: opts.username ?? "alice",
    deviceId: hex(k.publicKey).slice(0, 32),
    devicePubKey: k.publicKey,
    scopes: (opts.scopes ?? ["browse"]) as DeviceCapabilityGrant["scopes"],
    issuedAt: NOW - 1000,
    expiresAt: NOW + 1e9,
  };
  return {
    grantId: g.grantId,
    username: opts.username ?? "Alice",
    deviceId: g.deviceId,
    devicePubHex: hex(k.publicKey),
    scopes: [...g.scopes],
    issuedAt: g.issuedAt,
    expiresAt: g.expiresAt,
    signatureHex: hex(signDeviceCapabilityGrant({ ...g, username: g.username.toLowerCase() }, signer)),
  };
}

function bookFor(pinned: boolean) {
  if (!pinned) return [listed(laptop, "u-laptop-1", irk), listed(stranger, "u-strange", forged)];
  return [
    listed(adminDev, "g-admin-01", root, { scopes: ["browse", "admin"] }),
    listed(laptop, "g-laptop-1", irk),
    listed(tablet, "g-tablet-1", root),
    listed(revokedDev, "g-revoked1", root, { scopes: ["admin"] }),
    listed(forged, "g-forged-1", stranger, { scopes: ["admin"] }),
    listed(stranger, "g-otheruser", root, { username: "bob", scopes: ["admin"] }),
    listed(twice, "g-twice-01", irk),
    listed(twice, "g-twice-02", root, { scopes: ["admin"] }),
    { ...listed(laptop, "g-badscope", root), scopes: ["browse", "fly"] },
  ];
}

const SHARE = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
function held(m: Keypair, shareId: string, owner: Keypair, opts: { domain?: string; acceptBy?: Keypair; level?: "view" | "manage" } = {}) {
  const grant = { serverDomain: opts.domain ?? DOMAIN, shareId, memberPubHex: hex(m.publicKey), level: opts.level ?? "manage", unlockAtBoot: false, seeAppData: false, label: `S ${shareId.slice(0, 4)}`, issuedAt: NOW - 900 };
  const accept = { serverDomain: grant.serverDomain, shareId, memberPubHex: grant.memberPubHex, acceptedAt: NOW - 800 };
  return { grant, signature: hex(signServerShareGrant(grant, owner)), accept, acceptSignature: hex(signServerShareAccept(accept, opts.acceptBy ?? m)), sharedAt: NOW - 900, lastSeenAt: null };
}
function sharesFor(owner: Keypair) {
  return {
    active: [
      held(member, SHARE, owner),
      held(otherMember, "1".repeat(32), owner, { domain: OTHER }),
      held(endedMember, "2".repeat(32), owner),
      held(stranger, "3".repeat(32), owner, { acceptBy: forged }),
      held(stranger, "4".repeat(32), stranger),
    ],
    ended: [{ shareId: "2".repeat(32), label: "gone", endedAt: NOW - 10, reason: "left" }],
    endsCursor: 0,
  };
}

const anchorsFor = (pinned: boolean) => ({
  username: "alice",
  ownerIrkHex: hex(irk.publicKey),
  ...(pinned ? { adminRootHex: hex(root.publicKey) } : {}),
  ownerAidHex: hex(ownerAid.publicKey),
  serverDomain: DOMAIN,
});

async function boxFor(pinned: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "accesswv-"));
  const files = {
    book: { grants: bookFor(pinned) },
    revocations: { revoked: { "g-revoked1": { at: NOW - 5, reason: "lost" } } },
    shares: sharesFor(pinned ? root : irk),
  };
  writeFileSync(join(dir, "account-devices.json"), JSON.stringify(files.book));
  writeFileSync(join(dir, "shares.json"), JSON.stringify(files.shares));
  const revoked = new Set(Object.keys(files.revocations.revoked));
  const book = new AccountDeviceBook({
    path: join(dir, "account-devices.json"),
    username: "alice",
    ownerIrkPub: () => irk.publicKey,
    adminRootPub: () => (pinned ? root.publicKey : undefined),
    ownerAidHex: hex(ownerAid.publicKey),
    isRevoked: (id) => revoked.has(id),
    fetchGrants: async () => files.book,
    now: () => NOW,
  });
  await book.load();
  const authority = { ownerIrkPub: irk.publicKey, ...(pinned ? { adminRootPub: root.publicKey } : {}), username: "alice", activeGrants: book.adminGrants(), now: NOW };
  const shares = new ShareStore(join(dir, "shares.json"), {
    serverDomain: DOMAIN,
    verifyOwnerGrant: (g, sig) => authorizeSensitiveOrder({ ...authority, order: g, signature: sig, verify: verifyServerShareGrant }),
    verifyAcceptAdmin: () => ({ ok: true }) as never,
  });
  await shares.load();
  const principals = new AccessPrincipals(hex(ownerAid.publicKey));
  principals.book = book;
  principals.shares = () => shares.list().map((h) => ({ shareId: h.grant.shareId, memberPubHex: h.grant.memberPubHex, label: h.grant.label, level: h.grant.level }));
  return { dir, files, book, principals };
}

const KEYS: Record<string, Keypair | string> = { irk, ownerAid, root, adminDev, laptop, tablet, revokedDev, forged, twice, stranger, member, otherMember, endedMember, upper: hex(adminDev.publicKey).toUpperCase() };

async function peopleCase(pinned: boolean) {
  const box = await boxFor(pinned);
  const classify: Record<string, unknown> = {};
  for (const [n, k] of Object.entries(KEYS)) {
    const p = box.principals.classify(typeof k === "string" ? k : hex(k.publicKey));
    classify[n] = p ? (p.kind === "device" ? { kind: "device", tier: p.tier, legacy: p.legacy } : { kind: "co-manager", shareId: p.shareId, level: p.level }) : null;
  }
  return {
    name: pinned ? "a box that pins an admin root" : "a box that pins no admin root",
    anchors: anchorsFor(pinned),
    files: box.files,
    keys: Object.fromEntries(Object.entries(KEYS).map(([n, k]) => [n, typeof k === "string" ? k : hex(k.publicKey)])),
    expect: {
      devices: box.principals.devices().map((d) => ({ pub: d.pub, deviceId: d.deviceId, tier: d.tier })),
      coManagers: box.principals.coManagers().map((c) => ({ pub: c.pub, shareId: c.shareId, label: c.label, level: c.level })),
      classify,
    },
  };
}

// ── scenario entries ────────────────────────────────────────────────────────────────────────────────────────────
const S = (b: Uint8Array) => hex(b);
const inv = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
function create(signer: Keypair, invite: string, over: Record<string, unknown> = {}) {
  const c = { inviteId: invite, authorAID: ownerAid.publicKey, serviceRef: APP, secretHash: invite.replace(/./g, "6"), encryptedBundle: "ab".repeat(20), issuedAt: NOW - 3000, ...over } as never;
  return { create: { ...(c as object), authorAID: hex(ownerAid.publicKey) } as Record<string, unknown>, createSig: S(signCreateServiceInvite(c, signer)) };
}
function joinE(signer: Keypair, invite: string, who: Keypair, at: number, over: Record<string, unknown> = {}): AccessEntry {
  const cr = create(signer, invite, over);
  const sh = String(cr.create.secretHash);
  const r = { secretHash: sh, visitorAID: who.publicKey, redeemedAt: at };
  return { kind: "join", create: cr.create, createSig: cr.createSig, redeem: { secretHash: sh, visitorAID: hex(who.publicKey), redeemedAt: at, aidSig: S(signRedeemServiceInvite(r, who)) } };
}
function acceptE(signer: Keypair, invite: string, who: Keypair, at: number): AccessEntry {
  const cr = create(signer, invite);
  const a = { inviteId: invite, serviceRef: APP, contactAID: who.publicKey, acceptedAt: at };
  return { kind: "accept", create: cr.create, createSig: cr.createSig, accept: { inviteId: invite, serviceRef: APP, contactAID: hex(who.publicKey), acceptedAt: at }, acceptSig: S(signAcceptServiceInvite(a, who)) };
}
const modeE = (m: "open" | "restricted", signer: Keypair, at: number): AccessEntry => {
  const o = { serviceRef: APP, mode: m, issuedAt: at };
  return { kind: "mode", order: o as never, signature: S(signServiceAccessModeV2(o as never, signer)) };
};
const removeE = (aid: Keypair, signer: Keypair, at: number): AccessEntry => {
  const o = { serviceRef: APP, aid: hex(aid.publicKey), issuedAt: at };
  return { kind: "remove", order: o as never, signature: S(signServiceAllowRemoveV2(o, signer)) };
};
const rankE = (target: string, rank: string, signer: Keypair, at: number): AccessEntry => {
  const o = { serviceRef: APP, target, rank, issuedAt: at };
  return { kind: "rank", order: o as never, signature: S(signAppRank(o, signer)) };
};
const withdrawE = (invite: string, signer: Keypair, at: number): AccessEntry => ({ kind: "withdraw", revoke: { inviteId: invite, issuedAt: at }, signature: S(signRevokeServiceInvite({ inviteId: invite, issuedAt: at }, signer)) });
const REMOTE_SHARE = "5".repeat(32);
function shareE(m: Keypair, owner: Keypair, end?: Keypair): AccessEntry {
  const g = { serverDomain: OTHER, shareId: REMOTE_SHARE, memberPubHex: hex(m.publicKey), level: "manage" as const, unlockAtBoot: false, seeAppData: false, label: "Remote", issuedAt: NOW - 950 };
  const e: Record<string, unknown> = { kind: "share", grant: g, signature: S(signServerShareGrant(g, owner)) };
  if (end) {
    const r = { serverDomain: OTHER, shareId: REMOTE_SHARE, issuedAt: NOW - 100 };
    e.end = { kind: "revoke", revoke: r, signature: S(signServerShareRevoke(r, end)) };
  }
  return e as unknown as AccessEntry;
}

type Step =
  | { op: "apply"; entry: AccessEntry; installed?: boolean; catchingUp?: boolean; note: string }
  | { op: "mutate"; method: string; args: Record<string, unknown>; note: string };

const A = (entry: AccessEntry, note: string, o: { installed?: boolean; catchingUp?: boolean } = {}): Step => ({ op: "apply", entry, note, ...o });
const M = (method: string, args: Record<string, unknown>, note: string): Step => ({ op: "mutate", method, args, note });
const aidOf = (k: Keypair) => hex(k.publicKey);

const SCENARIOS: Array<{ name: string; pinned: boolean; steps: Step[] }> = [
  {
    name: "one list on an admin-pinned box",
    pinned: true,
    steps: [
      A(modeE("restricted", root, NOW - 900), "the admin root makes the app members-only"),
      A(modeE("restricted", root, NOW - 900), "the same order again is stale"),
      A(modeE("open", irk, NOW - 800), "the owner key is no admin on a pinned box"),
      A(modeE("open", adminDev, NOW - 850), "an admin device's newer order opens it again", { installed: true }),
      A(joinE(root, inv(1), friend, NOW - 700), "a join through the admin's invite"),
      A(joinE(root, inv(1), friend, NOW - 700), "the same join again changes nothing"),
      A(joinE(root, inv(1), friend2, NOW - 690), "a personal invite binds one person"),
      A(joinE(laptop, inv(2), friend2, NOW - 680, { maxRedemptions: 5 }), "a join through a member device's invite"),
      A(rankE(`device:${aidOf(laptop)}`, "member", root, NOW - 670), "the admin demotes the laptop to Member here"),
      A(joinE(laptop, inv(2), friend3, NOW - 660, { maxRedemptions: 5 }), "a demoted creator's link lets nobody new in"),
      A(rankE(`aid:${aidOf(friend)}`, "manager", adminDev, NOW - 650), "an admin device raises an invited person"),
      A(rankE(`aid:${aidOf(friend4)}`, "manager", root, NOW - 645), "a rank for someone not on the list is refused"),
      A(rankE(`grant:${inv(2)}/${aidOf(friend2)}`, "master", root, NOW - 640), "a grant's own rank, master with evidence"),
      A(rankE(`invite:${inv(2)}`, "manager", root, NOW - 635), "an invite's rank"),
      A(rankE(`device:${aidOf(stranger)}`, "manager", root, NOW - 630), "a device target that is no device of the account"),
      A(rankE(`aid:${aidOf(laptop)}`, "manager", root, NOW - 629), "an account device is ranked in Account members, not as an invitee"),
      A(rankE(`share:${SHARE}`, "refused", root, NOW - 628), "the admin refuses a co-manager here"),
      A(rankE(`aid:${aidOf(friend)}`, "master", stranger, NOW - 620), "a stranger's rank order"),
      A(rankE(`aid:${aidOf(friend)}`, "master", root, NOW - 619), "a rank for an app that is not installed", { installed: false }),
      A(withdrawE(inv(1), root, NOW - 600), "the admin withdraws the first invite"),
      A(joinE(root, inv(1), friend4, NOW - 590, { maxRedemptions: 9, inviteId: inv(1) }), "a withdrawn link lets nobody new in"),
      A(withdrawE(inv(2), stranger, NOW - 580), "a stranger's withdraw is kept but prunes nothing"),
      A(removeE(friend2, root, NOW - 500), "the admin removes a person"),
      A(joinE(root, inv(3), friend2, NOW - 510), "a join older than the removal is stale"),
      A(removeE(friend3, stranger, NOW - 495), "a stranger's removal"),
      A(shareE(remoteMember, root), "a co-manager of another server, from its share"),
      A(shareE(remoteMember, stranger), "a share grant a stranger signed"),
      A(joinE(remoteMember, inv(4), friend3, NOW - 400), "a join through that co-manager's invite"),
      A(joinE(remoteMember, inv(5), friend4, NOW - 390), "co-managers wait while the list catches up", { catchingUp: true }),
      A(rankE(`share:${REMOTE_SHARE}`, "member", root, NOW - 380), "the admin demotes the co-manager"),
      A(joinE(remoteMember, inv(6), friend4, NOW - 370), "a demoted co-manager's link lets nobody new in"),
      A(shareE(remoteMember, root, root), "the share ends"),
      A(shareE(remoteMember, root), "an ended share never comes back"),
      A(acceptE(adminDev, inv(7), contact, NOW - 300), "an accept through an admin device's invite"),
      A(acceptE(stranger, inv(8), contact, NOW - 290), "an accept through a stranger's invite"),
      A(joinE(member, inv(9), friend4, NOW - 280), "this server's own co-manager is refused here (the admin refused them)"),
      A(joinE(tablet, inv(10), friend4, NOW - 270, { expiresAt: NOW - 275 }), "a join after the invite expired"),
      A(joinE(tablet, inv(11), friend4, NOW - 260), "a join through a non-admin device's invite"),
      A(withdrawE(inv(11), tablet, NOW - 250), "the creating device withdraws its own invite"),
      M("setMode", { serviceRef: "alice--notes", mode: "restricted" }, "a store change: another app's mode"),
      M("addAllowed", { serviceRef: "alice--notes", aid: aidOf(friend).toUpperCase(), inviteId: "manual" }, "an add (lower-cased)"),
      M("addAllowed", { serviceRef: "alice--notes", aid: aidOf(friend2) }, "an add without an invite"),
      M("setInviteTier", { serviceRef: "alice--notes", inviteId: "manual", tier: "member" }, "a member tier"),
      M("setInviteTier", { serviceRef: "alice--notes", inviteId: "manual", tier: "admin" }, "a member tier is sticky"),
      M("setInviteCreator", { serviceRef: "alice--notes", inviteId: "manual", pub: aidOf(laptop).toUpperCase() }, "the creator"),
      M("setInviteCreator", { serviceRef: "alice--notes", inviteId: "manual", pub: aidOf(tablet) }, "the first creator stays"),
      M("noteWithdrawn", { serviceRef: "alice--notes", inviteId: "manual", issuedAt: NOW - 10, signature: "AB".repeat(64) }, "a withdraw kept"),
      M("setRole", { serviceRef: "alice--notes", target: { kind: "aid", aid: aidOf(friend2) }, targetKey: `aid:${aidOf(friend2)}`, role: "manager", issuedAt: NOW - 9 }, "a role"),
      M("setRole", { serviceRef: "alice--notes", target: { kind: "aid", aid: aidOf(friend2) }, targetKey: `aid:${aidOf(friend2)}`, role: "member", issuedAt: NOW - 9 }, "a role no newer is stale"),
      M("setAccountRank", { serviceRef: "alice--notes", targetKey: `device:${aidOf(laptop)}`, rank: "master", issuedAt: NOW - 8, evidence: `${"c".repeat(128)}:flagship/app-rank/v1|x` }, "an account rank with evidence"),
      M("noteCoManager", { serviceRef: "alice--notes", shareId: REMOTE_SHARE, rec: { pub: aidOf(remoteMember).toUpperCase(), level: "view", label: "R", serverDomain: OTHER.toUpperCase(), issuedAt: NOW - 7, ended: false } }, "a co-manager record"),
      M("removeIfUngranted", { serviceRef: "alice--notes", aid: aidOf(friend) }, "someone with a grant stays"),
      M("removeIfUngranted", { serviceRef: "alice--notes", aid: aidOf(friend2) }, "someone without one goes"),
      M("revokeGroup", { inviteId: "manual" }, "a group revoked on every app"),
      M("removeAllowed", { serviceRef: "alice--nothing", aid: aidOf(friend) }, "a removal from an app with no row"),
      M("importEntry", { serviceRef: "alice--copy", entry: { mode: "restricted", allow: [aidOf(friend), "nothex", aidOf(friend)], groups: { g1: [aidOf(friend), aidOf(friend3)] }, roles: { aids: { [aidOf(friend)]: "manager", [aidOf(friend3)]: "master" }, grants: { [`g1/${aidOf(friend)}`]: "master", [`g2/${aidOf(friend)}`]: "member" }, creators: { g1: "zz" } } } }, "a copied app's list"),
      M("forget", { serviceRef: "alice--notes" }, "an uninstalled app is forgotten"),
      M("forget", { serviceRef: "alice--notes" }, "forgetting twice changes nothing"),
    ],
  },
  {
    name: "a box that pins no admin root",
    pinned: false,
    steps: [
      A(modeE("restricted", irk, NOW - 900), "the owner key is the admin here"),
      A(modeE("open", root, NOW - 800), "a root this box does not pin"),
      A(joinE(irk, inv(1), friend, NOW - 700), "a join through the owner key's invite"),
      A(joinE(laptop, inv(2), friend2, NOW - 690), "a device the owner key granted is an admin device here"),
      A(joinE(ownerAid, inv(3), friend3, NOW - 680), "the owner AID signs invites too"),
      A(withdrawE(inv(3), ownerAid, NOW - 600), "the owner AID withdraws"),
      A(rankE(`aid:${aidOf(friend)}`, "master", irk, NOW - 500), "the owner key ranks"),
      A(rankE(`device:${aidOf(ownerAid)}`, "manager", irk, NOW - 490), "the legacy AID is a device"),
    ],
  },
];

async function runScenario(sc: (typeof SCENARIOS)[number]) {
  const box = await boxFor(sc.pinned);
  const store = new ServiceAccessStore(join(box.dir, "data/flagship-access/service-access.json"), { principals: box.principals, serverDomain: DOMAIN, ownerAidHex: hex(ownerAid.publicKey) });
  await store.load();
  box.principals.book = box.book;
  let installed = true;
  const authority = { ownerIrkPub: irk.publicKey, ...(sc.pinned ? { adminRootPub: root.publicKey } : {}), username: "alice" };
  const access = buildServiceAccessHttp({ serverId: DOMAIN, ...authority, ownerAidPub: ownerAid.publicKey, adminGrants: () => box.book.adminGrants(), store, serviceInstalled: (r) => installed && r === APP, controlPlaneBaseUrl: "https://flagshipserver.com", now: () => NOW });
  const rank = buildRankEntryApplier({ ...authority, adminGrants: () => box.book.adminGrants(), store, app: (id) => (installed && id === APP ? { manifest: {} as never } : null), now: () => NOW });
  const journal = new AccessJournal(join(box.dir, "data/flagship-access/access-journal.json"));
  const steps = [];
  for (const s of sc.steps) {
    let result: unknown;
    let kept: boolean | null = null;
    if (s.op === "apply") {
      installed = s.installed !== false;
      store.setCatchingUp(APP, s.catchingUp === true);
      const r = s.entry.kind === "rank" ? await rank(APP, s.entry) : await access.applyEntry(APP, s.entry);
      result = r;
      kept = r !== "refused" && r !== "skipped" ? await journal.add(APP, s.entry) : false;
      store.setCatchingUp(APP, false);
    } else {
      const a = s.args as Record<string, never>;
      const call: Record<string, () => Promise<unknown>> = {
        setMode: () => store.setMode(a.serviceRef, a.mode),
        addAllowed: () => store.addAllowed(a.serviceRef, a.aid, a.inviteId),
        setInviteTier: () => store.setInviteTier(a.serviceRef, a.inviteId, a.tier),
        setInviteCreator: () => store.setInviteCreator(a.serviceRef, a.inviteId, a.pub),
        noteWithdrawn: () => store.noteWithdrawn(a.serviceRef, a.inviteId, a.issuedAt, a.signature),
        setRole: () => store.setRole(a.serviceRef, a.target, a.targetKey, a.role, a.issuedAt, a.evidence),
        setAccountRank: () => store.setAccountRank(a.serviceRef, a.targetKey, a.rank, a.issuedAt, a.evidence),
        noteCoManager: () => store.noteCoManager(a.serviceRef, a.shareId, a.rec),
        removeIfUngranted: () => store.removeIfUngranted(a.serviceRef, a.aid),
        revokeGroup: () => store.revokeGroup(a.inviteId, a.serviceRef),
        removeAllowed: () => store.removeAllowed(a.serviceRef, a.aid),
        importEntry: () => store.importEntry(a.serviceRef, a.entry),
        forget: () => store.forget(a.serviceRef),
      };
      result = (await call[s.method]!()) ?? null;
    }
    const state = JSON.parse((store as unknown as { snapshot(): string }).snapshot());
    steps.push({ ...s, expect: { result, kept, state, digest: journal.digest(APP) } });
  }
  return { name: sc.name, anchors: anchorsFor(sc.pinned), files: box.files, installedApp: APP, now: NOW, steps };
}

async function build() {
  return {
    about:
      "The access writes as TypeScript makes them (tests/accessWritesVectors.test.ts, UPDATE_ACCESS_VECTORS=1): account people from the box's files, and per step of each scenario the result, the state file after it and the journal digest. Read by rust/crates/flagship-access/tests/write_vectors.rs.",
    people: [await peopleCase(true), await peopleCase(false)],
    scenarios: await Promise.all(SCENARIOS.map(runScenario)),
  };
}

describe("access write vectors", () => {
  it("TypeScript makes the writes the vector file records", async () => {
    const fresh = await build();
    if (process.env.UPDATE_ACCESS_VECTORS === "1") writeFileSync(FILE, `${JSON.stringify(fresh, null, 2)}\n`);
    const onDisk = JSON.parse(readFileSync(FILE, "utf8"));
    expect(fresh).toEqual(onDisk);
  });

  it("the vectors exercise every kind of step", async () => {
    const v = JSON.parse(readFileSync(FILE, "utf8")) as { scenarios: Array<{ steps: Array<{ op: string; entry?: { kind: string }; expect: { result: unknown } }> }> };
    const steps = v.scenarios.flatMap((s) => s.steps);
    for (const kind of ["mode", "remove", "join", "accept", "withdraw", "share", "rank"]) {
      const ofKind = steps.filter((s) => s.entry?.kind === kind).map((s) => s.expect.result);
      expect(ofKind, kind).toContain("applied");
      expect(ofKind.some((r) => r === "refused" || r === "stale" || r === "unchanged"), kind).toBe(true);
    }
    expect(steps.filter((s) => s.op === "mutate").length).toBeGreaterThan(10);
  });
});
