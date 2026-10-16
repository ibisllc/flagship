// Envelope #12 on the webapp (docs/share-a-server.md §4, §5.1): only an admin
// device of the joining account accepts a share. Every case in the shared
// vectors, reproduced by lib/serverShare.js, and the tag signs under the admin
// root (lib/adminRoot.js), else the IRK.

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
  const adminSeed = fromHex(V.keys.adminRootSeedHex);
  return {
    m,
    sign: { adminRoot: adminSeed, irk: { umk: memberUmk, signWithIrk }, member: member.seed } as Record<string, unknown>,
    pub: {
      adminRoot: fromHex(V.keys.adminRootPubHex),
      irk: new Uint8Array((await deriveIrkFromSeed(memberUmk)).publicKey),
      member: member.publicKey,
    } as Record<string, Uint8Array>,
  };
}

describe("webapp share accept-admin vectors (#12)", () => {
  it("derives the keys", async () => {
    const { m, pub } = await keys();
    expect(hex(await m.ed25519PublicKey(fromHex(V.keys.adminRootSeedHex)))).toBe(V.keys.adminRootPubHex);
    expect(hex(pub.irk!)).toBe(V.keys.irkPubHex);
    expect(hex(pub.member!)).toBe(V.keys.memberPubHex);
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

  it("is a sensitive tag: an admin device signs it with the admin root", async () => {
    const { SENSITIVE_TAGS } = await load("lib/adminRoot.js");
    expect(SENSITIVE_TAGS.has("flagship/server-share-accept-admin/v1")).toBe(true);
  });
});
