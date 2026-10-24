import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BootUnlockV2Error,
  boxAcceptsVersion,
  buildBootReplyV2,
  chooseLeaseVersion,
  chooseReplyVersion,
  isV2Sealed,
  openBootReplyV2,
  openLeaseV3,
  parseUnlockPolicy,
  sealLeaseV3,
  signSecretRequestV2,
  verifyBootPq,
  verifySecretRequestV2,
} from "../src/bootUnlockV2.js";
import { hybridSign } from "../src/pqHybrid.js";
import { verifyPqKeyBinding } from "../src/pqTrust.js";

const V = JSON.parse(readFileSync(resolve(import.meta.dirname, "../test-vectors/boot-unlock-v2/vectors.json"), "utf8"));
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sk = (k: { edSeed: string; mldsaSeed: string }) => unhex(k.edSeed + k.mldsaSeed);
const code = (f: () => unknown): string => {
  try {
    f();
    return "ok";
  } catch (e) {
    if (e instanceof BootUnlockV2Error) return e.code;
    throw e;
  }
};
const stkBinding = verifyPqKeyBinding(V.stkBinding, { role: "box-stk", subjectId: V.serverDomain, ed25519PubHex: V.keys.stk.publicKey.slice(0, 64), now: V.now });
const bootPubHex = V.keys.boot.pubHex;
const material = verifyBootPq(V.material.wire, { serverDomain: V.serverDomain, bootPubHex, stkBinding, now: V.now });
const ownerPk = unhex(V.keys.owner.publicKey);
const sign = (purpose: string, m: Uint8Array) => hybridSign(sk(V.keys.owner), purpose, m, { deterministic: true });

describe("boot unlock v2 vectors", () => {
  it("material", () => {
    expect(material.custody).toBe("tpm");
    expect(material.leaseKemKeyIdHex).toBe(V.keys.leaseKem.keyId);
    for (const c of V.material.cases) {
      expect(code(() => verifyBootPq(c.wire, { serverDomain: V.serverDomain, bootPubHex: c.bootPubHex, stkBinding, now: V.now })), c.name).toBe(c.expect);
    }
  });

  it("request: signature byte for byte, then every case", () => {
    expect(signSecretRequestV2(V.request.fields, sk(V.keys.boot), { deterministic: true })).toEqual(V.request.pq);
    for (const c of V.request.cases) expect(code(() => verifySecretRequestV2(c.v1, c.pq, material)), c.name).toBe(c.expect);
    expect(hex(verifySecretRequestV2(V.request.cases[0].v1, V.request.pq, material))).toBe(V.keys.replyKem.publicKey);
  });

  it("reply: sealed bytes reproduced and every case", () => {
    const sealed = buildBootReplyV2({ ctx: V.reply.ctx, diskKey: unhex(V.diskKey), ownerHybridPublicKey: ownerPk, sign, issuedAt: V.reply.issuedAt, randomness: unhex(V.reply.randomness) });
    expect(hex(sealed)).toBe(V.reply.sealed);
    for (const c of V.reply.cases) {
      const s = unhex(c.sealed);
      const got = code(() => {
        boxAcceptsVersion(c.policy, isV2Sealed(s) ? 2 : 1);
        if (!isV2Sealed(s)) throw Object.assign(new BootUnlockV2Error("v2-malformed"), { code: "accept-v1" });
        expect(hex(openBootReplyV2({ sealed: s, ctx: { serverDomain: V.serverDomain, bootPubHex, nonceHex: c.nonceHex }, replyKemSecretKey: unhex(V.keys.replyKem.seed), ownerHybridPublicKey: ownerPk }))).toBe(V.diskKey);
      });
      expect(got, c.name).toBe(c.expect);
    }
  });

  it("lease: sealed key reproduced and every case", () => {
    const sealed = sealLeaseV3({ lease: V.lease.fields, leaseKemPublicKey: unhex(V.keys.leaseKem.publicKey), diskKey: unhex(V.diskKey), ownerHybridPublicKey: ownerPk, sign, randomness: unhex(V.lease.randomness) });
    expect(hex(sealed)).toBe(V.lease.sealedKey);
    for (const c of V.lease.cases) {
      const s = unhex(c.sealed);
      const got = code(() => {
        boxAcceptsVersion(c.policy, isV2Sealed(s) ? 2 : 1);
        if (!isV2Sealed(s)) throw Object.assign(new BootUnlockV2Error("v2-malformed"), { code: "accept-v1" });
        openLeaseV3({ lease: c.lease, sealedKey: s, leaseKemSecretKey: unhex(V.keys.leaseKem.seed), ownerHybridPublicKey: ownerPk, nowMs: c.nowMs });
      });
      expect(got, c.name).toBe(c.expect);
    }
  });

  it("policy file and the phone's choice", () => {
    for (const c of V.policy) expect(parseUnlockPolicy(c.text, c.hasV2Material)).toBe(c.expect);
    for (const c of V.replyChoice) expect(code(() => { const v = chooseReplyVersion(c); if (String(v) !== c.expect) throw new Error(String(v)); })).toBe(/^\d$/.test(c.expect) ? "ok" : c.expect);
    for (const c of V.leaseChoice) expect(code(() => { const v = chooseLeaseVersion(c); if (String(v) !== c.expect) throw new Error(String(v)); })).toBe(/^\d$/.test(c.expect) ? "ok" : c.expect);
  });

  it("a reply opens once: the reply key is per boot", () => {
    const other = new Uint8Array(32).fill(0x62);
    expect(code(() => openBootReplyV2({ sealed: unhex(V.reply.sealed), ctx: { serverDomain: V.serverDomain, bootPubHex, nonceHex: V.reply.ctx.nonceHex }, replyKemSecretKey: other, ownerHybridPublicKey: ownerPk }))).toBe("recipient-mismatch");
  });
});
