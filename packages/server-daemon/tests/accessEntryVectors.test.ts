/**
 * Verdicts on handed-over access entries, from the real applier (`applyEntry` on a fresh box per case): "refused"
 * when the entry fails verification, "ok" otherwise (applied, unchanged, stale or skipped). The file
 * `test-vectors/access-entries.json` holds the entries, the trust the box had and the TypeScript verdicts
 * (UPDATE_ACCESS_VECTORS=1 rewrites it); rust/crates/flagship-core/tests/access_entry_vectors.rs must agree.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveAccountId,
  deriveIRK,
  ed,
  signAcceptServiceInvite,
  signCreateServiceInvite,
  signDeviceCapabilityGrant,
  signRedeemServiceInvite,
  signRevokeServiceInvite,
  signServiceAccessModeV2,
  signServiceAllowRemoveV2,
  signServerShareGrant,
  signServerShareLeave,
  signServerShareRevoke,
  type DeviceCapabilityGrant,
  type Keypair,
} from "@flagship/protocol";
import { AccessPrincipals, AccountDeviceBook } from "../src/accessPrincipals.js";
import type { AccessEntry } from "../src/accessJournal.js";
import { buildServiceAccessHttp, ServiceAccessStore } from "../src/serviceAccess.js";

const FILE = new URL("../test-vectors/access-entries.json", import.meta.url);
const NOW = 1_700_000_000_000;
const SERVICE = "alice--club";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const key = (fill: number): Keypair => {
  const priv = new Uint8Array(32).fill(fill);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
};
const ownerUmk = { seed: new Uint8Array(32).fill(11) };
const ownerIrk = deriveIRK(ownerUmk);
const ownerAid = deriveAccountId(ownerUmk);
const adminRoot = key(0x5a);
const laptop = key(0x62);
const stranger = key(0x71);
const friend = deriveAccountId({ seed: new Uint8Array(32).fill(22) });
const contact = deriveAccountId({ seed: new Uint8Array(32).fill(24) });
const shareMember = key(0x81);
const LAPTOP_ID = "b2".repeat(16);

function laptopGrant() {
  const g: DeviceCapabilityGrant = { grantId: "g-lap", username: "alice", deviceId: LAPTOP_ID, devicePubKey: laptop.publicKey, scopes: ["browse", "view-directory"], issuedAt: NOW - 10, expiresAt: NOW + 1e9 };
  return { grantId: g.grantId, username: "alice", deviceId: LAPTOP_ID, devicePubHex: hex(laptop.publicKey), scopes: g.scopes, issuedAt: g.issuedAt, expiresAt: g.expiresAt, signatureHex: hex(signDeviceCapabilityGrant(g, ownerIrk)), signerRoot: "membership" };
}

async function freshBox() {
  const dir = mkdtempSync(join(tmpdir(), "entryjv-"));
  const book = new AccountDeviceBook({ path: join(dir, "account-devices.json"), username: "alice", ownerIrkPub: () => ownerIrk.publicKey, adminRootPub: () => adminRoot.publicKey, fetchGrants: async () => ({ grants: [laptopGrant()] }) });
  await book.refresh();
  const principals = new AccessPrincipals(hex(ownerAid.publicKey));
  principals.book = book;
  const store = new ServiceAccessStore(join(dir, "data/flagship-access/service-access.json"), { principals });
  await store.load();
  return buildServiceAccessHttp({
    serverId: "home.alice.flagship.services",
    ownerIrkPub: ownerIrk.publicKey,
    ownerAidPub: ownerAid.publicKey,
    adminRootPub: adminRoot.publicKey,
    store,
    serviceInstalled: (r) => r === SERVICE,
    controlPlaneBaseUrl: "https://flagshipserver.com",
    username: "alice",
    now: () => NOW,
  });
}

const S = (b: Uint8Array) => hex(b);
const secretHash = "6".repeat(64);
const inviteId = "5".repeat(64);
function create(signer: Keypair, over: Record<string, unknown> = {}) {
  const c = { inviteId, authorAID: ownerAid.publicKey, serviceRef: SERVICE, secretHash, encryptedBundle: "ab".repeat(40), issuedAt: NOW - 1000, ...over } as never;
  return { create: { ...(c as object), authorAID: hex(ownerAid.publicKey) } as Record<string, unknown>, createSig: S(signCreateServiceInvite(c, signer)) };
}
const modeOrder = (m: string, over: Record<string, unknown> = {}) => ({ serviceRef: SERVICE, mode: m, issuedAt: NOW - 500, ...over });
const modeEntry = (m: string, signer: Keypair, over: Record<string, unknown> = {}): AccessEntry => ({ kind: "mode", order: modeOrder(m, over) as never, signature: S(signServiceAccessModeV2(modeOrder(m) as never, signer)) });
const joinEntry = (cr: ReturnType<typeof create>, redeemSigner: Keypair = friend, hashOverride?: string): AccessEntry => {
  const sh = hashOverride ?? secretHash;
  const r = { secretHash: sh, visitorAID: friend.publicKey, redeemedAt: NOW - 400 };
  return { kind: "join", create: cr.create, createSig: cr.createSig, redeem: { secretHash: sh, visitorAID: hex(friend.publicKey), redeemedAt: r.redeemedAt, aidSig: S(signRedeemServiceInvite(r, redeemSigner)) } };
};

const CASES: Array<{ name: string; entry: () => AccessEntry; ref?: string }> = [
  { name: "a mode order signed by the admin root", entry: () => modeEntry("restricted", adminRoot) },
  { name: "a mode order signed by the owner IRK on an admin-pinned box is refused", entry: () => modeEntry("restricted", ownerIrk) },
  { name: "a mode order signed by a member device is refused", entry: () => modeEntry("restricted", laptop) },
  { name: "a mode order signed by a stranger is refused", entry: () => modeEntry("restricted", stranger) },
  { name: "a mode order for another app is refused", entry: () => modeEntry("restricted", adminRoot, { serviceRef: "alice--other" }) },
  { name: "a mode order whose time changed after signing is refused", entry: () => ({ ...modeEntry("restricted", adminRoot), order: modeOrder("restricted", { issuedAt: NOW - 499 }) as never }) },
  { name: "a mode order handed over for an app that is not installed here is refused", entry: () => modeEntry("restricted", adminRoot, { serviceRef: "alice--other" }), ref: "alice--other" },
  { name: "a removal signed by the admin root", entry: () => ({ kind: "remove", order: { serviceRef: SERVICE, aid: hex(friend.publicKey), issuedAt: NOW - 300 } as never, signature: S(signServiceAllowRemoveV2({ serviceRef: SERVICE, aid: hex(friend.publicKey), issuedAt: NOW - 300 }, adminRoot)) }) },
  { name: "a removal signed by a stranger is refused", entry: () => ({ kind: "remove", order: { serviceRef: SERVICE, aid: hex(friend.publicKey), issuedAt: NOW - 300 } as never, signature: S(signServiceAllowRemoveV2({ serviceRef: SERVICE, aid: hex(friend.publicKey), issuedAt: NOW - 300 }, stranger)) }) },
  { name: "a join through an admin-signed create", entry: () => joinEntry(create(adminRoot)) },
  { name: "a join through a create signed by a stranger is refused", entry: () => joinEntry(create(stranger)) },
  { name: "a join whose redeem was signed by another key is refused", entry: () => joinEntry(create(adminRoot), stranger) },
  { name: "a join whose redeem names another secret than the create is refused", entry: () => joinEntry(create(adminRoot), friend, "7".repeat(64)) },
  { name: "a join through a create for another app is refused", entry: () => joinEntry(create(adminRoot, { serviceRef: "alice--other" })) },
  { name: "a join through a create signed by a member device", entry: () => joinEntry(create(laptop)) },
  { name: "an accept through an admin-signed create", entry: () => acceptEntry(create(adminRoot), contact) },
  { name: "an accept signed by another key than the contact is refused", entry: () => acceptEntry(create(adminRoot), stranger) },
  { name: "an accept for another invite than the create's is refused", entry: () => acceptEntry(create(adminRoot), contact, "9".repeat(64)) },
  { name: "a withdraw signed by the admin root", entry: () => ({ kind: "withdraw", revoke: { inviteId, issuedAt: NOW - 100 }, signature: S(signRevokeServiceInvite({ inviteId, issuedAt: NOW - 100 }, adminRoot)) }) },
  { name: "a share grant signed by the admin root", entry: () => shareEntry(adminRoot) },
  { name: "a share grant signed by a stranger is refused", entry: () => shareEntry(stranger) },
  { name: "a share grant ended by the member's own leave", entry: () => shareEntry(adminRoot, { leave: shareMember }) },
  { name: "a share grant ended by a leave signed by someone else is refused", entry: () => shareEntry(adminRoot, { leave: stranger }) },
  { name: "a share grant ended by the admin's revoke", entry: () => shareEntry(adminRoot, { revoke: adminRoot }) },
  { name: "a share grant ended by a stranger's revoke is refused", entry: () => shareEntry(adminRoot, { revoke: stranger }) },
  { name: "a rank entry is left to the rank applier", entry: () => ({ kind: "rank", order: { serviceRef: SERVICE, target: `device:${hex(laptop.publicKey)}`, rank: "manager", issuedAt: NOW - 50 } as never, signature: "a".repeat(128) }) },
];

function acceptEntry(cr: ReturnType<typeof create>, signer: Keypair, inviteOverride?: string): AccessEntry {
  const a = { inviteId: inviteOverride ?? inviteId, serviceRef: SERVICE, contactAID: contact.publicKey, acceptedAt: NOW - 200 };
  return { kind: "accept", create: cr.create, createSig: cr.createSig, accept: { inviteId: a.inviteId, serviceRef: a.serviceRef, contactAID: hex(contact.publicKey), acceptedAt: a.acceptedAt }, acceptSig: S(signAcceptServiceInvite(a, signer)) };
}

function shareEntry(owner: Keypair, end?: { leave?: Keypair; revoke?: Keypair }): AccessEntry {
  const g = { serverDomain: "home.alice.flagship.services", shareId: "0f1e2d3c4b5a69788796a5b4c3d2e1f0", memberPubHex: hex(shareMember.publicKey), level: "manage" as const, unlockAtBoot: false, seeAppData: false, label: "Sam", issuedAt: NOW - 900 };
  const entry: Record<string, unknown> = { kind: "share", grant: g, signature: S(signServerShareGrant(g, owner)) };
  if (end?.leave) {
    const l = { serverDomain: g.serverDomain, shareId: g.shareId, memberPubHex: g.memberPubHex, issuedAt: NOW - 800 };
    entry.end = { kind: "leave", leave: l, signature: S(signServerShareLeave(l, end.leave)) };
  }
  if (end?.revoke) {
    const r = { serverDomain: g.serverDomain, shareId: g.shareId, issuedAt: NOW - 800 };
    entry.end = { kind: "revoke", revoke: r, signature: S(signServerShareRevoke(r, end.revoke)) };
  }
  return entry as unknown as AccessEntry;
}

async function verdicts() {
  const out = [];
  for (const c of CASES) {
    const box = await freshBox();
    const entry = c.entry();
    const ref = c.ref ?? SERVICE;
    const result = await box.applyEntry(ref, entry);
    out.push({ name: c.name, serviceRef: ref, entry, expect: result === "refused" ? "refused" : "ok" });
  }
  return out;
}

describe("access entry vectors (shared with flagship-core)", () => {
  it("the file holds the verdicts of the real applier", async () => {
    const doc = {
      about: "Verdicts of serviceAccess.applyEntry on a fresh box (tests/accessEntryVectors.test.ts, UPDATE_ACCESS_VECTORS=1); read by rust/crates/flagship-core/tests/access_entry_vectors.rs. 'refused' = failed verification; 'ok' = applied, unchanged, stale or skipped.",
      trust: {
        installed: [SERVICE],
        adminSigners: [hex(adminRoot.publicKey)],
        createSigners: [
          { pub: hex(adminRoot.publicKey), tier: "admin" },
          { pub: hex(laptop.publicKey), tier: "member" },
        ],
      },
      cases: await verdicts(),
    };
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    if (process.env.UPDATE_ACCESS_VECTORS === "1") writeFileSync(FILE, text);
    expect(JSON.parse(readFileSync(FILE, "utf8"))).toEqual(JSON.parse(text));
  });
});
