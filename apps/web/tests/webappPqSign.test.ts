// The webapp's ML-DSA-65 (mldsa-native in WebAssembly, lib/mldsaWasm.js) and hybrid signer
// (lib/pqSign.js) against the shared vectors: every deterministic signature and binding the
// TypeScript, Rust, Swift and Kotlin ports produce, byte for byte, plus the pin on the module.
import { describe, expect, it, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MLDSA_WASM_SHA256, mldsaPublicKey, mldsaSign, mldsaVerify, setMldsaWasmBytesForTests } from "../public/webapp/lib/mldsaWasm.js";
import { hybridEnvelope, hybridSign, signPqKeyBinding } from "../public/webapp/lib/pqSign.js";
import { verifyCriticalSignature, verifyPqKeyBinding } from "../public/webapp/lib/pqBinding.js";

const ROOT = join(__dirname, "../../..");
const WASM = readFileSync(join(ROOT, "apps/web/public/webapp/vendor/mldsa-wasm/mldsa65.wasm"));
const HYB = JSON.parse(readFileSync(join(ROOT, "packages/protocol/test-vectors/pq-hybrid/vectors.json"), "utf8"));
const BIND = JSON.parse(readFileSync(join(ROOT, "packages/protocol/test-vectors/pq-binding/vectors.json"), "utf8"));
const b = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const h = (x: Uint8Array) => Buffer.from(x).toString("hex");

describe("ML-DSA-65 in WebAssembly", () => {
  beforeAll(() => setMldsaWasmBytesForTests(new Uint8Array(WASM)));

  it("is the pinned module", () => {
    expect(createHash("sha256").update(WASM).digest("hex")).toBe(MLDSA_WASM_SHA256);
  });

  it("refuses a module that does not hash to the pin", async () => {
    const bad = new Uint8Array(WASM);
    bad[bad.length - 1] ^= 1;
    setMldsaWasmBytesForTests(bad);
    await expect(mldsaPublicKey(new Uint8Array(32))).rejects.toMatchObject({ code: "pq-wasm-pin" });
    setMldsaWasmBytesForTests(new Uint8Array(WASM));
  });

  for (const v of HYB.sig.valid) {
    it(`hybrid signature vector: ${v.name}`, async () => {
      const sig = await hybridSign(b(v.edSeed), b(v.mldsaSeed), v.purpose, b(v.payload), { deterministic: true });
      expect(h(sig)).toBe(v.signature);
    });
  }

  it("hedged signatures differ and verify", async () => {
    const seed = new Uint8Array(32).fill(7);
    const ctx = new TextEncoder().encode("ctx");
    const m = new TextEncoder().encode("flagship/test/v1|x");
    const s1 = await mldsaSign(seed, m, ctx);
    const s2 = await mldsaSign(seed, m, ctx);
    expect(h(s1)).not.toBe(h(s2));
    const pk = await mldsaPublicKey(seed);
    expect(await mldsaVerify(pk, m, ctx, s1)).toBe(true);
    expect(await mldsaVerify(pk, new TextEncoder().encode("flagship/test/v1|y"), ctx, s1)).toBe(false);
  });

  it("signs a large message (memory grows)", async () => {
    const m = new Uint8Array(600_000).fill(1);
    const seed = new Uint8Array(32).fill(9);
    const sig = await mldsaSign(seed, m, new Uint8Array(0));
    expect(await mldsaVerify(await mldsaPublicKey(seed), m, new Uint8Array(0), sig)).toBe(true);
  });

  for (const v of BIND.bindings.valid) {
    const signer = BIND.signers.find((s: { ed25519PubHex: string }) => s.ed25519PubHex === v.wire.ed25519PubHex);
    if (!signer) continue;
    it(`pq-key-binding vector: ${v.name}`, async () => {
      const w = await signPqKeyBinding(v.wire, b(signer.edSeedHex), b(signer.mldsaSeedHex), { deterministic: true });
      expect(w).toEqual(v.wire);
    });
  }

  it("an envelope passes the browser's critical-signature gate", async () => {
    const s = BIND.signers[0];
    const w = await signPqKeyBinding({ role: "admin-root", subjectId: "alice", issuedAt: BIND.now }, b(s.edSeedHex), b(s.mldsaSeedHex));
    const binding = verifyPqKeyBinding(w, { role: "admin-root", subjectId: "alice", ed25519PubHex: s.ed25519PubHex, now: BIND.now });
    const message = new TextEncoder().encode("flagship/box-release/v1|home.alice.flagship.services|" + "ab".repeat(32) + "|1|" + "00".repeat(16));
    const envelope = await hybridEnvelope(message, b(s.edSeedHex), b(s.mldsaSeedHex));
    expect(verifyCriticalSignature({ message, expectedPurpose: "flagship/box-release/v1", envelope, signerEd25519PubHex: s.ed25519PubHex, binding, policy: { profile: "strict", rollout: "enforced" } })).toMatchObject({ strict: true });
  });
});
