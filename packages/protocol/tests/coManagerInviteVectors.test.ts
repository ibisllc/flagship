import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { deriveAccountId } from "../src/keys.js";
import { deriveShareInviteBundleKey, deriveShareMemberKey } from "../src/serverShare.js";
import {
  createServiceInviteCanonicalBytes,
  openInviteBundle,
  revokeServiceInviteCanonicalBytes,
  sealInviteBundle,
  serviceInviteCoManagerRelayCanonicalBytes,
  verifyCreateServiceInvite,
  verifyRevokeServiceInvite,
  verifyServiceInviteCoManagerRelay,
  type CreateServiceInvite,
} from "../src/serviceInvite.js";
import { buildCoManagerInviteVectors, VECTORS_PATH } from "./genCoManagerInviteVectors.js";

// VECTORS_PATH is packages/protocol/test-vectors/co-manager-invite/vectors.json.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as any;
const text = (b: Uint8Array) => new TextDecoder().decode(b);

function create(f: Record<string, unknown>): CreateServiceInvite {
  return {
    inviteId: f.inviteId as string,
    authorAID: hexToBytes(f.authorAID as string),
    serviceRef: f.serviceRef as string,
    secretHash: f.secretHash as string,
    encryptedBundle: f.encryptedBundle as string,
    issuedAt: f.issuedAt as number,
    ...(typeof f.maxRedemptions === "number" ? { maxRedemptions: f.maxRedemptions } : {}),
    ...(typeof f.expiresAt === "number" ? { expiresAt: f.expiresAt } : {}),
  };
}

describe("co-manager invite vectors", () => {
  it("the file is what the generator writes", () => {
    expect(V).toEqual(JSON.parse(JSON.stringify(buildCoManagerInviteVectors())));
  });

  it("derives the member key, the bundle key and the owner AID", () => {
    const umk = { seed: hexToBytes(V.keys.memberUmkSeedHex) };
    expect(bytesToHex(deriveShareMemberKey(umk, V.keys.shareId).publicKey)).toBe(V.keys.memberPubHex);
    expect(bytesToHex(deriveShareMemberKey(umk, V.keys.otherShareId).publicKey)).toBe(V.keys.otherMemberPubHex);
    expect(bytesToHex(deriveShareInviteBundleKey(umk, V.keys.shareId))).toBe(V.keys.bundleKeyHex);
    expect(bytesToHex(deriveAccountId({ seed: hexToBytes(V.keys.ownerUmkSeedHex) }).publicKey)).toBe(V.keys.ownerAidPubHex);
  });

  it("seals and opens each bundle", () => {
    const key = hexToBytes(V.keys.bundleKeyHex);
    for (const b of V.bundles) {
      const plain = JSON.parse(b.plaintext) as { name: string };
      expect(sealInviteBundle(plain, key, b.inviteId, hexToBytes(b.nonceHex))).toBe(b.sealedHex);
      expect(openInviteBundle(b.sealedHex, key, b.inviteId)).toEqual(plain);
    }
  });

  it("reproduces every canonical string and verifies every signature", () => {
    const member = hexToBytes(V.keys.memberPubHex);
    for (const c of V.creates) {
      expect(text(createServiceInviteCanonicalBytes(create(c.fields)))).toBe(c.canonical);
      expect(verifyCreateServiceInvite(create(c.fields), hexToBytes(c.signatureHex), member)).toBe(true);
    }
    expect(text(revokeServiceInviteCanonicalBytes(V.revoke.fields))).toBe(V.revoke.canonical);
    expect(verifyRevokeServiceInvite(V.revoke.fields, hexToBytes(V.revoke.signatureHex), member)).toBe(true);
    expect(text(serviceInviteCoManagerRelayCanonicalBytes(V.relay.fields))).toBe(V.relay.canonical);
    expect(verifyServiceInviteCoManagerRelay(V.relay.fields, hexToBytes(V.relay.signatureHex), hexToBytes(V.keys.stkPubHex))).toBe(true);
  });

  it("fails every reject", () => {
    for (const r of V.reject) {
      const pub = hexToBytes(V.keys[r.verifyUnder]);
      const sig = hexToBytes(r.signatureHex);
      const ok =
        r.envelope === "create"
          ? verifyCreateServiceInvite(create(r.fields), sig, pub)
          : verifyServiceInviteCoManagerRelay(r.fields, sig, pub);
      expect(ok, r.why).toBe(false);
    }
  });

  it("refuses a relay with an uppercase or short creator key", () => {
    const base = V.relay.fields;
    expect(() => serviceInviteCoManagerRelayCanonicalBytes({ ...base, creatorPubHex: base.creatorPubHex.toUpperCase() })).toThrow();
    expect(() => serviceInviteCoManagerRelayCanonicalBytes({ ...base, createSigHex: "ab" })).toThrow();
    expect(() => serviceInviteCoManagerRelayCanonicalBytes({ ...base, serviceRef: "a|b" })).toThrow();
  });
});
