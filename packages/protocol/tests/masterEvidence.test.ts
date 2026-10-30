import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { checkMasterEvidence, deriveServiceMemberStableId, deriveServiceSecret } from "../src/index.js";

const V = JSON.parse(readFileSync(resolve(import.meta.dirname, "../test-vectors/identity-assertion/master-evidence.json"), "utf8"));
const swk = Uint8Array.from(Buffer.from(V.swk, "hex"));

describe("master needs the owner's evidence", () => {
  it("every case", () => {
    for (const s of V.stableIds) expect(deriveServiceMemberStableId(deriveServiceSecret(swk, s.app), Buffer.from(s.identityPubHex, "hex"))).toBe(s.stableId);
    for (const c of V.cases) {
      const got = checkMasterEvidence(c.msg, c.ev, c.anchors, V.now, (a, p) => deriveServiceMemberStableId(deriveServiceSecret(swk, a), p), (sig, m, p) =>
        ed25519.verify(Buffer.from(sig, "hex"), m, Buffer.from(p, "hex")),
      );
      expect(got ?? "ok", c.name).toBe(c.expect);
    }
  });
});

describe("an account device signs in under the owner's AID", () => {
  const rand = (n: number) => Uint8Array.from(Array.from({ length: 32 }, (_, i) => (i * 7 + n) & 255));
  const root = rand(1);
  const rootPub = Buffer.from(ed25519.getPublicKey(root)).toString("hex");
  const ownerAid = Buffer.from(ed25519.getPublicKey(rand(2)));
  const device = Buffer.from(ed25519.getPublicKey(rand(3))).toString("hex");
  const stable = (a: string, p: Uint8Array) => deriveServiceMemberStableId(deriveServiceSecret(swk, a), p);
  const verify = (sig: string, m: Uint8Array, p: string) => ed25519.verify(Buffer.from(sig, "hex"), m, Buffer.from(p, "hex"));
  const grant = `flagship/device-capability-grant/v2|g1|alice|d1|${device}|admin,browse|1|${Date.now() + 3_600_000}`;
  const sig = Buffer.from(ed25519.sign(new TextEncoder().encode(grant), root)).toString("hex");
  const msg = `flagship/inject/v1|alice--shop|${stable("alice--shop", ownerAid)}|master|1`;
  const anchors = { irkPubHex: "00".repeat(32), adminRootPubHex: rootPub };

  it("is proven by the grant of the device that signed in, though the member id comes from the AID", () => {
    const ev = { appId: "alice--shop", identityPubHex: ownerAid.toString("hex"), signInPubHex: device, statement: grant, signatureHex: sig };
    expect(checkMasterEvidence(msg, ev, anchors, Date.now(), stable, verify)).toBeNull();
  });
  it("is refused when the grant names another key, or no sign-in key is given (the AID is not the device)", () => {
    const base = { appId: "alice--shop", identityPubHex: ownerAid.toString("hex"), statement: grant, signatureHex: sig };
    expect(checkMasterEvidence(msg, { ...base, signInPubHex: "ab".repeat(32) }, anchors, Date.now(), stable, verify)).toBe("wrong-key");
    expect(checkMasterEvidence(msg, base, anchors, Date.now(), stable, verify)).toBe("wrong-key");
  });
});
