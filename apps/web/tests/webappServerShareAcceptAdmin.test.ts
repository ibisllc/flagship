// Envelope #12 on the webapp (docs/share-a-server.md §4, §5.1): only an admin
// device of the joining account accepts a share. Every case in the shared
// vectors, reproduced by lib/serverShare.js: #12 signs with the per-share admin
// key, and the attestation request signs under the admin root (lib/adminRoot.js),
// else the IRK (AT-LNK-10).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const V = JSON.parse(
  readFileSync(resolve(__dirname, "../../../packages/protocol/test-vectors/server-share-accept-admin/vectors.json"), "utf8"),
);

async function load(rel: string) {
  return import(pathToFileURL(resolve(__dirname, "..", "public", "webapp", rel)).href);
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);
const memberUmk = fromHex(V.keys.memberUmkSeedHex);

async function keys() {
  const m = await load("lib/serverShare.js");
  const { signWithIrk, deriveIrkFromSeed } = await load("keystore.js");
  const member = await m.deriveShareMemberKey(memberUmk, V.keys.shareId);
  const shareAdmin = await m.deriveShareAdminKey(memberUmk, V.keys.shareId);
  const adminSeed = fromHex(V.keys.adminRootSeedHex);
  return {
    m,
    sign: { adminRoot: adminSeed, irk: { umk: memberUmk, signWithIrk }, member: member.seed, shareAdmin: shareAdmin.seed } as Record<string, unknown>,
    pub: {
      adminRoot: fromHex(V.keys.adminRootPubHex),
      irk: new Uint8Array((await deriveIrkFromSeed(memberUmk)).publicKey),
      member: member.publicKey,
      shareAdmin: shareAdmin.publicKey,
    } as Record<string, Uint8Array>,
  };
}

describe("webapp share accept-admin vectors (#12)", () => {
  it("derives the keys", async () => {
    const { m, pub } = await keys();
    expect(hex(await m.ed25519PublicKey(fromHex(V.keys.adminRootSeedHex)))).toBe(V.keys.adminRootPubHex);
    expect(hex(pub.irk!)).toBe(V.keys.irkPubHex);
    expect(hex(pub.member!)).toBe(V.keys.memberPubHex);
    expect(hex(pub.shareAdmin!)).toBe(V.keys.shareAdminPubHex);
    expect(hex((await m.deriveShareAdminKey(memberUmk, V.keys.otherShareId)).publicKey)).toBe(V.keys.otherShareAdminPubHex);
  });

  it("builds and signs every attestation request, and refuses every requestRefuse case", async () => {
    const { m, sign } = await keys();
    expect(V.requests.length).toBeGreaterThan(0);
    for (const c of V.requests) {
      expect(utf8(m.shareKeyAttestationRequestCanonicalBytes(c.fields))).toBe(c.canonical);
      expect(hex(await m.signShareKeyAttestationRequest(c.fields, sign[c.signer]))).toBe(c.signature);
    }
    for (const c of V.requestRefuse) expect(() => m.shareKeyAttestationRequestCanonicalBytes(c.fields), c.why).toThrow();
  });

  it("builds, signs, verifies and parses every envelope", async () => {
    const { m, sign, pub } = await keys();
    for (const c of V.envelopes) {
      expect(utf8(m.serverShareAcceptAdminCanonicalBytes(c.fields))).toBe(c.canonical);
      const sig = await m.signServerShareAcceptAdmin(c.fields, sign[c.signer]);
      expect(hex(sig)).toBe(c.signature);
      expect(await m.verifyServerShareAcceptAdmin(c.fields, sig, pub[c.signer])).toBe(true);
      expect(await m.verifyServerShareAcceptAdmin(c.fields, sig, pub.member)).toBe(false);
      expect(m.parseServerShareAcceptAdmin(c.fields)).toEqual(c.fields);
    }
  });

  it("refuses every refuse case and fails every reject case", async () => {
    const { m, pub } = await keys();
    for (const c of V.refuse) {
      expect(() => m.serverShareAcceptAdminCanonicalBytes(c.fields), c.why).toThrow();
      expect(m.parseServerShareAcceptAdmin(c.fields), c.why).toBeNull();
    }
    for (const c of V.reject) {
      expect(await m.verifyServerShareAcceptAdmin(c.fields, fromHex(c.signature), pub[c.pub]), c.why).toBe(false);
    }
  });

  it("parses the sealed acceptance with its admin proof, and without one", async () => {
    const { m } = await keys();
    const p = m.parseShareAcceptancePayload(V.payload);
    expect(p.admin).toEqual(V.payload.admin);
    const { admin: _a, ...bare } = V.payload;
    expect(m.parseShareAcceptancePayload(bare).admin).toBeUndefined();
    expect(m.parseShareAcceptancePayload({ ...V.payload, admin: { ...V.payload.admin, attestation: { kind: "x" } } })).toBeNull();
    expect(m.parseAccountKeyAttestation(V.attestation.attestation)).toEqual(V.attestation.attestation);
  });

  it("the attestation request is a sensitive tag (admin root); #12 itself never signs with it", async () => {
    const { SENSITIVE_TAGS } = await load("lib/adminRoot.js");
    expect(SENSITIVE_TAGS.has("flagship/share-key-attestation-request/v1")).toBe(true);
    expect(SENSITIVE_TAGS.has("flagship/server-share-accept-admin/v1")).toBe(false);
  });
});
