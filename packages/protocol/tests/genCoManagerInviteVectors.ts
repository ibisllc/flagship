// Builds test-vectors/co-manager-invite/vectors.json (co-managers invite at
// Member, owner decision 2026-10-16). Regenerate with:
//   npx tsx packages/protocol/tests/genCoManagerInviteVectors.ts
// Every input is fixed and Ed25519 here is deterministic, so the output is
// byte-stable; coManagerInviteVectors.test.ts fails when the file drifts.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { ed } from "../src/edSync.js";
import { deriveAccountId } from "../src/keys.js";
import { deriveShareInviteBundleKey, deriveShareMemberKey, INFO_SHARE_INVITE_BUNDLE } from "../src/serverShare.js";
import {
  createServiceInviteCanonicalBytes,
  revokeServiceInviteCanonicalBytes,
  sealInviteBundle,
  serviceInviteCoManagerRelayCanonicalBytes,
  type CreateServiceInvite,
  type ServiceInviteCoManagerRelay,
} from "../src/serviceInvite.js";

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const sign = (msg: Uint8Array, seed: Uint8Array) => bytesToHex(ed.sign(msg, seed));

export const VECTORS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../test-vectors/co-manager-invite/vectors.json",
);

// The same two accounts and share as test-vectors/server-share.
const OWNER_UMK = "2a".repeat(32);
const MEMBER_UMK = "5b".repeat(32);
const SHARE_ID = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const OTHER_SHARE_ID = "ffeeddccbbaa99887766554433221100";
const STK_SEED = new Uint8Array(32).fill(0x77);

export function buildCoManagerInviteVectors(): unknown {
  const ownerAid = deriveAccountId({ seed: hexToBytes(OWNER_UMK) }).publicKey;
  const member = deriveShareMemberKey({ seed: hexToBytes(MEMBER_UMK) }, SHARE_ID);
  const otherMember = deriveShareMemberKey({ seed: hexToBytes(MEMBER_UMK) }, OTHER_SHARE_ID);
  const bundleKey = deriveShareInviteBundleKey({ seed: hexToBytes(MEMBER_UMK) }, SHARE_ID);
  const stkPub = ed.getPublicKey(STK_SEED);

  const inviteId = "a1".repeat(32);
  const groupInviteId = "b2".repeat(32);
  const nonce = hexToBytes("000102030405060708090a0b");
  const sealedBundle = sealInviteBundle({ name: "Alex" }, bundleKey, inviteId, nonce);
  const sealedGroupBundle = sealInviteBundle({ name: "Chess club" }, bundleKey, groupInviteId, nonce);

  const personal: CreateServiceInvite = {
    inviteId,
    authorAID: ownerAid,
    serviceRef: "harry--chess",
    secretHash: "c3".repeat(32),
    encryptedBundle: sealedBundle,
    issuedAt: 1792000000000,
  };
  const group: CreateServiceInvite = {
    inviteId: groupInviteId,
    authorAID: ownerAid,
    serviceRef: "harry--chess",
    secretHash: "d4".repeat(32),
    encryptedBundle: sealedGroupBundle,
    issuedAt: 1792000000000,
    maxRedemptions: 10,
    expiresAt: 1794592000000,
  };
  const createFields = (c: CreateServiceInvite) => ({
    inviteId: c.inviteId,
    authorAID: bytesToHex(c.authorAID),
    serviceRef: c.serviceRef,
    secretHash: c.secretHash,
    encryptedBundle: c.encryptedBundle,
    issuedAt: c.issuedAt,
    ...(c.maxRedemptions !== undefined ? { maxRedemptions: c.maxRedemptions } : {}),
    ...(c.expiresAt !== undefined ? { expiresAt: c.expiresAt } : {}),
  });
  const personalBytes = createServiceInviteCanonicalBytes(personal);
  const groupBytes = createServiceInviteCanonicalBytes(group);
  const personalSig = sign(personalBytes, member.privateKey);
  const groupSig = sign(groupBytes, member.privateKey);

  const revoke = { inviteId, issuedAt: 1792000600000 };
  const revokeBytes = revokeServiceInviteCanonicalBytes(revoke);

  const relay: ServiceInviteCoManagerRelay = {
    username: "harry",
    serverDomain: "home.harry.flagship.services",
    inviteId,
    serviceRef: "harry--chess",
    creatorPubHex: bytesToHex(member.publicKey),
    createSigHex: personalSig,
    issuedAt: 1792000001000,
  };
  const relayBytes = serviceInviteCoManagerRelayCanonicalBytes(relay);

  const tampered = { ...personal, serviceRef: "harry--notes" };

  return {
    about:
      "Co-manager invites (owner decision 2026-10-16; docs/service-access-gating.md \"Co-manager invites\"). " +
      "A co-manager (account B, sharing server S at Can manage) invites people to an app on S at Member. " +
      "B's device signs the ordinary flagship/service-invite/create/v1 with its per-share member key " +
      "(deriveShareMemberKey(memberUmk, shareId), see test-vectors/server-share), with authorAID = the owner's AID " +
      "(GET /api/shares/invites gives it) and the invitee's name sealed with sealInviteBundle under " +
      "deriveShareInviteBundleKey(memberUmk, shareId) = HKDF-SHA256(UMK, salt empty, info \"flagship/share-invite-bundle/v1|<shareId>\", 32) " +
      "instead of a household key (AES-256-GCM, AAD flagship/service-invite/bundle/v1|<inviteId>, hex nonce12||ct+tag; plaintext JSON {\"name\":…}). " +
      "B withdraws with flagship/service-invite/revoke/v1 signed by the same member key. " +
      "The box relays B's create to .com with flagship/service-invite-co-manager/v1, signed by its STK (only boxes sign it; ports need only reproduce the string). " +
      "Every platform must: derive keys.memberPubHex and keys.bundleKeyHex; seal each bundle to the given hex with the given nonce and open it back; " +
      "rebuild each canonical string from its fields and verify the signature under keys.memberPubHex (relay: keys.stkPubHex); " +
      "and fail every reject case.",
    keys: {
      ownerUmkSeedHex: OWNER_UMK,
      ownerAidPubHex: bytesToHex(ownerAid),
      memberUmkSeedHex: MEMBER_UMK,
      shareId: SHARE_ID,
      memberPubHex: bytesToHex(member.publicKey),
      otherShareId: OTHER_SHARE_ID,
      otherMemberPubHex: bytesToHex(otherMember.publicKey),
      bundleKeyInfo: `${INFO_SHARE_INVITE_BUNDLE}|${SHARE_ID}`,
      bundleKeyHex: bytesToHex(bundleKey),
      stkSeedHex: bytesToHex(STK_SEED),
      stkPubHex: bytesToHex(stkPub),
    },
    bundles: [
      { inviteId, plaintext: JSON.stringify({ name: "Alex" }), nonceHex: bytesToHex(nonce), sealedHex: sealedBundle },
      { inviteId: groupInviteId, plaintext: JSON.stringify({ name: "Chess club" }), nonceHex: bytesToHex(nonce), sealedHex: sealedGroupBundle },
    ],
    creates: [
      { kind: "personal", fields: createFields(personal), canonical: text(personalBytes), signatureHex: personalSig },
      { kind: "group", fields: createFields(group), canonical: text(groupBytes), signatureHex: groupSig },
    ],
    revoke: { fields: revoke, canonical: text(revokeBytes), signatureHex: sign(revokeBytes, member.privateKey) },
    relay: { fields: relay, canonical: text(relayBytes), signatureHex: sign(relayBytes, STK_SEED) },
    reject: [
      {
        why: "the create signed by the same account's member key for ANOTHER share (another server) is not this co-manager",
        envelope: "create",
        fields: createFields(personal),
        signatureHex: sign(personalBytes, otherMember.privateKey),
        verifyUnder: "memberPubHex",
      },
      {
        why: "a signature over another app's create",
        envelope: "create",
        fields: createFields(personal),
        signatureHex: sign(createServiceInviteCanonicalBytes(tampered), member.privateKey),
        verifyUnder: "memberPubHex",
      },
      {
        why: "the relay signed by the member key instead of the box's STK",
        envelope: "relay",
        fields: relay,
        signatureHex: sign(relayBytes, member.privateKey),
        verifyUnder: "stkPubHex",
      },
    ],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(VECTORS_PATH, `${JSON.stringify(buildCoManagerInviteVectors(), null, 2)}\n`);
  console.log(`wrote ${VECTORS_PATH}`);
}
