#!/usr/bin/env -S npx tsx
/**
 * Shared vectors for the org invite link's keys (packages/protocol/src/orgAuthority.ts,
 * docs/enterprise-accounts.md §7): the offer key and invite key derived from the link key k, the
 * invite naming the invite key, the read proof that opens the offer and the invite-key signature on
 * the accept. TypeScript generates them; packages/protocol/tests/orgInviteKeyVectors.test.ts, the
 * webapp test, the Swift OrgInviteKeyVectorTests and the Kotlin OrgInviteKeyVectorsTest check them.
 *
 * Run:          npx tsx tools/org-invite-key-vectors.ts
 * CI freshness: npx tsx tools/org-invite-key-vectors.ts --check
 */
import { createCipheriv } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hybridSigKeygen, hybridSign } from "../packages/protocol/src/pqHybrid.js";
import {
  canonicalOrgInviteRead,
  canonicalOrgInviteWithdraw,
  canonicalOrgSeatAccept,
  canonicalOrgSeatInvite,
  deriveOrgInviteKeys,
  orgSha256Hex,
  orgInviteAcceptSignature,
  orgInviteReadSignature,
  verifyOrgInviteAccept,
  verifyOrgInviteRead,
  type OrgSeatAccept,
  type OrgSeatInvite,
} from "../packages/protocol/src/orgAuthority.js";

const OUT = resolve(import.meta.dirname, "..", "packages/protocol/test-vectors/org-invite-key/vectors.json");
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const utf8 = (b: Uint8Array): string => new TextDecoder().decode(b);
const fill = (n: number, v: number): Uint8Array => new Uint8Array(n).fill(v);

const ORG = "0a".repeat(16);
const SEAT = "61".repeat(16);
const OTHER_SEAT = "62".repeat(16);
const T0 = 1_795_000_000_000;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const det = { deterministic: true };

const linkKey = fill(32, 0x33);
const k = deriveOrgInviteKeys(linkKey);
const wrong = deriveOrgInviteKeys(fill(32, 0x34));

// AES-256-GCM under the offer key, nonce || ciphertext || tag (the inviter picks a random nonce).
const iv = fill(12, 0x07);
const offerPlain = JSON.stringify({ orgId: ORG, orgName: "acme", genesisHash: "11".repeat(32), seatId: SEAT, roles: [{ role: "member" }], pseudonym: "Robin" });
const cipher = createCipheriv("aes-256-gcm", k.offerKey, iv);
const sealedOffer = new Uint8Array([...iv, ...cipher.update(offerPlain, "utf8"), ...cipher.final(), ...cipher.getAuthTag()]);

const invite: OrgSeatInvite = {
  orgId: ORG,
  seatId: SEAT,
  labelSha256: orgSha256Hex(new TextEncoder().encode("sealed pseudonym bytes")),
  rolesHash: "22".repeat(32),
  oarVersion: 1,
  issuedAt: T0,
  expiresAt: T0 + 7 * DAY,
  inviteKeyPub: k.inviteKeyPub,
};
const otherInvite: OrgSeatInvite = { ...invite, seatId: OTHER_SEAT };
const inviteSha256 = orgSha256Hex(canonicalOrgSeatInvite(invite));
const otherInviteSha256 = orgSha256Hex(canonicalOrgSeatInvite(otherInvite));

// The member key that signs the accept as itself (any hybrid key: here fixed seeds).
const member = hybridSigKeygen(fill(32, 0x41), fill(32, 0x42));

const READ_AT = T0 + 10 * MIN;
const readSig = orgInviteReadSignature(k.hybridSecret, ORG, SEAT, READ_AT, det);
const reads = [
  { name: "a fresh proof by the invite key", invite: "invite", issuedAt: READ_AT, now: READ_AT + MIN, signature: readSig, expect: true },
  { name: "at the edge of the 5-minute window", invite: "invite", issuedAt: READ_AT, now: READ_AT + 5 * MIN, signature: readSig, expect: true },
  { name: "no proof", invite: "invite", issuedAt: READ_AT, now: READ_AT, signature: "", expect: false },
  { name: "signed by another link's key", invite: "invite", issuedAt: READ_AT, now: READ_AT, signature: orgInviteReadSignature(wrong.hybridSecret, ORG, SEAT, READ_AT, det), expect: false },
  { name: "a proof for this seat replayed on another seat", invite: "otherInvite", issuedAt: READ_AT, now: READ_AT, signature: readSig, expect: false },
  { name: "stale: more than 5 minutes old", invite: "invite", issuedAt: READ_AT, now: READ_AT + 5 * MIN + 1, signature: readSig, expect: false },
  { name: "from the future: more than 5 minutes ahead", invite: "invite", issuedAt: READ_AT, now: READ_AT - 5 * MIN - 1, signature: readSig, expect: false },
  { name: "issuedAt changed after signing", invite: "invite", issuedAt: READ_AT + 1, now: READ_AT, signature: readSig, expect: false },
  { name: "signed by the member key", invite: "invite", issuedAt: READ_AT, now: READ_AT, signature: hex(hybridSign(member.secretKey, "flagship/org-invite-read/v1", canonicalOrgInviteRead(ORG, SEAT, READ_AT), det)), expect: false },
];

const accept: OrgSeatAccept = { orgId: ORG, seatId: SEAT, inviteSha256, memberKeyId: "33".repeat(32), adminKeyId: "", issuedAt: T0 + 11 * MIN };
const otherAccept: OrgSeatAccept = { ...accept, seatId: OTHER_SEAT, inviteSha256: otherInviteSha256 };
const acceptSig = orgInviteAcceptSignature(k.hybridSecret, accept, det);
const accepts = [
  { name: "the accept signed by the invite key", invite: "invite", accept: "accept", signature: acceptSig, expect: true },
  { name: "no proof", invite: "invite", accept: "accept", signature: "", expect: false },
  { name: "signed by another link's key", invite: "invite", accept: "accept", signature: orgInviteAcceptSignature(wrong.hybridSecret, accept, det), expect: false },
  { name: "signed by the member key only", invite: "invite", accept: "accept", signature: hex(hybridSign(member.secretKey, "flagship/org-seat-accept/v1", canonicalOrgSeatAccept(accept), det)), expect: false },
  { name: "this seat's proof on another seat's accept", invite: "otherInvite", accept: "otherAccept", signature: acceptSig, expect: false },
  { name: "another seat's accept against this invite", invite: "invite", accept: "otherAccept", signature: orgInviteAcceptSignature(k.hybridSecret, otherAccept, det), expect: false },
  { name: "the accept changed after signing (another member key)", invite: "invite", accept: "acceptOtherMember", signature: acceptSig, expect: false },
];
const acceptOtherMember: OrgSeatAccept = { ...accept, memberKeyId: "44".repeat(32) };

for (const r of reads) {
  const inv = r.invite === "invite" ? invite : otherInvite;
  if (verifyOrgInviteRead(inv, r.issuedAt, r.signature, r.now) !== r.expect) throw new Error(`read vector disagrees: ${r.name}`);
}
const acceptOf = (n: string) => (n === "accept" ? accept : n === "otherAccept" ? otherAccept : acceptOtherMember);
for (const a of accepts) {
  const inv = a.invite === "invite" ? invite : otherInvite;
  if (verifyOrgInviteAccept(inv, acceptOf(a.accept), a.signature) !== a.expect) throw new Error(`accept vector disagrees: ${a.name}`);
}

const withdraw = { orgId: ORG, seatId: SEAT, oarVersion: 1, issuedAt: T0 + DAY };

const doc = {
  description:
    "Org invite link keys (docs/enterprise-accounts.md §7). offerKey = HKDF-SHA256(ikm=linkKey, salt=empty, info='flagship/org-invite-offer/v1', 32); the invite key's hybrid secret (Ed25519 seed || ML-DSA-65 seed) = HKDF-SHA256(ikm=linkKey, salt=empty, info='flagship/org-invite-key/v1', 64). reads: verifyOrgInviteRead(invites[invite], issuedAt, signature, now) == expect (±5 min). accepts: verifyOrgInviteAccept(invites[invite], acceptObjects[accept], signature) == expect. Signatures are hybrid Ed25519 + ML-DSA-65, deterministic.",
  linkKeyHex: hex(linkKey),
  offerKeyHex: hex(k.offerKey),
  inviteSecretHex: hex(k.hybridSecret),
  inviteKeyPub: k.inviteKeyPub,
  wrongLinkKeyHex: hex(fill(32, 0x34)),
  wrongInviteKeyPub: wrong.inviteKeyPub,
  offer: { plaintext: offerPlain, sealedHex: hex(sealedOffer) },
  invites: { invite, otherInvite },
  canonical: {
    invite: { bytes: utf8(canonicalOrgSeatInvite(invite)), sha256: inviteSha256 },
    read: { orgId: ORG, seatId: SEAT, issuedAt: READ_AT, bytes: utf8(canonicalOrgInviteRead(ORG, SEAT, READ_AT)) },
    accept: { bytes: utf8(canonicalOrgSeatAccept(accept)) },
    withdraw: { ...withdraw, bytes: utf8(canonicalOrgInviteWithdraw(withdraw)), sha256: orgSha256Hex(canonicalOrgInviteWithdraw(withdraw)) },
  },
  acceptObjects: { accept, otherAccept, acceptOtherMember },
  reads,
  accepts,
};

const json = JSON.stringify(doc, null, 1) + "\n";
if (process.argv.includes("--check")) {
  const disk = readFileSync(OUT, "utf8");
  if (disk !== json) {
    console.error(`${OUT} is stale; rerun without --check`);
    process.exit(1);
  }
  console.log("org-invite-key vectors are fresh");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
  console.log(`wrote ${OUT}`);
}
