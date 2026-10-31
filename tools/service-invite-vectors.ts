// Regenerates packages/protocol/test-vectors/service-invite/vectors.json: npx tsx tools/service-invite-vectors.ts
// The signed messages behind an app's invite entries (create, redeem, accept, revoke), signed by the TypeScript
// implementation; rust/crates/flagship-crypto/tests/service_invite.rs must give the same bytes and verdicts.
import { writeFileSync } from "node:fs";
import { bytesToHex } from "@noble/hashes/utils";
import { ed } from "../packages/protocol/src/edSync.js";
import {
  signAcceptServiceInvite,
  signCreateServiceInvite,
  signRedeemServiceInvite,
  signRevokeServiceInvite,
  createServiceInviteCanonicalBytes,
  revokeServiceInviteCanonicalBytes,
  serviceInviteSecretHash,
  type AcceptServiceInvite,
  type CreateServiceInvite,
  type RedeemServiceInvite,
  type RevokeServiceInvite,
} from "../packages/protocol/src/serviceInvite.js";

const seed = (b: number) => new Uint8Array(32).fill(b);
const pair = (b: number) => ({ privateKey: seed(b), publicKey: ed.getPublicKey(seed(b)) });
const irk = pair(0x11);
const friend = pair(0x22);
const contact = pair(0x33);
const author = pair(0x44);
const txt = (b: Uint8Array) => new TextDecoder().decode(b);
const h = (b: Uint8Array) => bytesToHex(b);
const D = (c: string) => c.repeat(64);

const base = { inviteId: D("5"), authorAID: author.publicKey, serviceRef: "harry--chess-club", secretHash: D("6"), encryptedBundle: "ab".repeat(40), issuedAt: 1760000000000 };
const creates: Array<{ name: string; create: CreateServiceInvite }> = [
  { name: "a single-use personal invite", create: base },
  { name: "a group link with a cap", create: { ...base, maxRedemptions: 25 } },
  { name: "a link that expires", create: { ...base, expiresAt: 1760086400000 } },
  { name: "a group link with a cap that is unlimited and expires", create: { ...base, maxRedemptions: 0, expiresAt: 1760086400000 } },
];
const redeem: RedeemServiceInvite = { secretHash: D("6"), visitorAID: friend.publicKey, redeemedAt: 1760000100000 };
const accept: AcceptServiceInvite = { inviteId: D("5"), serviceRef: "harry--chess-club", contactAID: contact.publicKey, acceptedAt: 1760000200000 };
const revoke: RevokeServiceInvite = { inviteId: D("5"), issuedAt: 1760000300000 };

const out = {
  about: "Invite messages signed by packages/protocol/src/serviceInvite.ts (tools/service-invite-vectors.ts). Keys are raw Ed25519 seeds filled with one byte.",
  keys: { irk: { seedByte: 0x11, pub: h(irk.publicKey) }, friend: { seedByte: 0x22, pub: h(friend.publicKey) }, contact: { seedByte: 0x33, pub: h(contact.publicKey) }, author: { pub: h(author.publicKey) } },
  create: creates.map((c) => ({
    name: c.name,
    inviteId: c.create.inviteId,
    authorAID: h(c.create.authorAID),
    serviceRef: c.create.serviceRef,
    secretHash: c.create.secretHash,
    encryptedBundle: c.create.encryptedBundle,
    issuedAt: c.create.issuedAt,
    ...(c.create.maxRedemptions !== undefined ? { maxRedemptions: c.create.maxRedemptions } : {}),
    ...(c.create.expiresAt !== undefined ? { expiresAt: c.create.expiresAt } : {}),
    canonical: txt(createServiceInviteCanonicalBytes(c.create)),
    signature: h(signCreateServiceInvite(c.create, irk)),
  })),
  redeem: [{ secretHash: redeem.secretHash, visitorAID: h(redeem.visitorAID), redeemedAt: redeem.redeemedAt, canonical: `flagship/service-invite/redeem/v1|${redeem.secretHash}|${h(redeem.visitorAID)}|${redeem.redeemedAt}`, signature: h(signRedeemServiceInvite(redeem, friend)) }],
  accept: [{ inviteId: accept.inviteId, serviceRef: accept.serviceRef, contactAID: h(accept.contactAID), acceptedAt: accept.acceptedAt, canonical: `flagship/service-invite/accept/v1|${accept.inviteId}|${accept.serviceRef}|${h(accept.contactAID)}|${accept.acceptedAt}`, signature: h(signAcceptServiceInvite(accept, contact)) }],
  revoke: [{ inviteId: revoke.inviteId, issuedAt: revoke.issuedAt, canonical: txt(revokeServiceInviteCanonicalBytes(revoke)), signature: h(signRevokeServiceInvite(revoke, irk)) }],
  secretHash: [{ secretHex: "00".repeat(32), expect: serviceInviteSecretHash(new Uint8Array(32)) }, { secretHex: "ff".repeat(32), expect: serviceInviteSecretHash(new Uint8Array(32).fill(255)) }],
  invalid: [
    { name: "a separator in the invite id", op: "create", ...creates[0]!.create, authorAID: h(author.publicKey), inviteId: "a|b" },
    { name: "a control character in the service ref", op: "redeem-secret", secretHash: "x\u0007y", visitorAID: h(friend.publicKey), redeemedAt: 1 },
    { name: "a negative cap", op: "create", ...creates[0]!.create, authorAID: h(author.publicKey), maxRedemptions: -1 },
    { name: "a fractional expiry", op: "create", ...creates[0]!.create, authorAID: h(author.publicKey), expiresAt: 1.5 },
  ],
};
writeFileSync(new URL("../packages/protocol/test-vectors/service-invite/vectors.json", import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log("wrote service-invite vectors");
