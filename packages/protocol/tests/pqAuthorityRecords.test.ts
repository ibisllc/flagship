import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PqTrustError,
  canonicalAdminRootRotationV2,
  canonicalDeviceCapabilityGrant,
  legacyPolicyState,
  pqBindingKeyIdHex,
  verifyAdminRootRotationPq,
  verifyDeviceGrantPq,
  verifyPqKeyBinding,
  type DeviceCapabilityGrant,
  type PolicyState,
  type VerifiedPqKeyBinding,
} from "../src/index.js";

const V = JSON.parse(readFileSync(resolve(__dirname, "../test-vectors/pq-authority/vectors.json"), "utf8"));
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const utf8 = (s: string) => new TextDecoder().decode(new TextEncoder().encode(s));

const verified = (name: string | null): VerifiedPqKeyBinding | null => {
  if (name === null) return null;
  const w = V.bindings[name];
  return verifyPqKeyBinding(w, { role: w.role, subjectId: w.subjectId, ed25519PubHex: w.ed25519PubHex, now: V.now });
};
const policy = (p: { profile: string; rollout: string }): PolicyState => ({
  ...legacyPolicyState({ kind: "installation", id: "home.alice.flagship.services" }),
  profile: p.profile as PolicyState["profile"],
  rollout: p.rollout as PolicyState["rollout"],
});
const rotationOf = (f: { username: string; oldAdminRootPubHex: string; newAdminRootPubHex: string; issuedAt: number }) => ({
  username: f.username,
  oldAdminRootPub: unhex(f.oldAdminRootPubHex),
  newAdminRootPub: unhex(f.newAdminRootPubHex),
  issuedAt: f.issuedAt,
});
const grantOf = (f: Record<string, unknown>): DeviceCapabilityGrant => ({
  grantId: f.grantId as string,
  username: f.username as string,
  deviceId: f.deviceId as string,
  devicePubKey: unhex(f.devicePubKeyHex as string),
  scopes: f.scopes as DeviceCapabilityGrant["scopes"],
  issuedAt: f.issuedAt as number,
  expiresAt: f.expiresAt as number,
});
const code = (f: () => unknown): string => {
  try {
    f();
    return "ok";
  } catch (e) {
    return e instanceof PqTrustError ? e.code : `other:${String(e)}`;
  }
};

describe("pq-authority vectors", () => {
  it("builds the rotation v2 and grant canonical bytes", () => {
    expect(pqBindingKeyIdHex(V.bindings.newRoot)).toBe(V.rotation.newRootKeyId);
    expect(utf8(new TextDecoder().decode(canonicalAdminRootRotationV2(rotationOf(V.rotation.fields), V.rotation.newRootKeyId)))).toBe(V.rotation.canonical);
    for (const k of ["admin", "member"]) {
      expect(new TextDecoder().decode(canonicalDeviceCapabilityGrant(grantOf(V.grants[k].fields)))).toBe(V.grants[k].canonical);
    }
  });

  it("refuses a malformed new-root key id", () => {
    expect(() => canonicalAdminRootRotationV2(rotationOf(V.rotation.fields), "AA".repeat(32))).toThrow();
  });

  for (const c of V.rotationCases) {
    it(`rotation: ${c.name}`, () => {
      let got = "";
      const out = code(() => {
        const b = verifyAdminRootRotationPq({ rotation: rotationOf(V.rotation.fields), pq: c.pq, oldRootBinding: verified(c.oldRootBinding), policy: policy(c.policy), now: V.now });
        got = b.mldsaPubHex;
      });
      if (c.expect.ok) {
        expect(out).toBe("ok");
        expect(got).toBe(V.bindings.newRoot.mldsaPubHex);
      } else expect(out).toBe(c.expect.code);
    });
  }

  for (const c of V.grantCases) {
    it(`grant: ${c.name}`, () => {
      const signerPubHex = V.bindings[c.signer].ed25519PubHex;
      const out = code(() =>
        verifyDeviceGrantPq({ grant: grantOf(c.grant), pq: c.pq, signerPubHex, signerBinding: verified(c.signerBinding), policy: policy(c.policy) }),
      );
      expect(out).toBe(c.expect.ok ? "ok" : c.expect.code);
    });
  }
});
