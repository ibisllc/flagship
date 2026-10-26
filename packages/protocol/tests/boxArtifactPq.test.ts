import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyBoxArtifact, type BoxArtifactManifest, type BoxArtifactSignature } from "../src/boxArtifact.js";
import {
  BOX_ARTIFACT_PQ_BINDING_SUBJECT,
  BOX_ARTIFACT_PQ_PIN,
  boxArtifactPqPinConfigured,
  signBoxArtifactPq,
  verifyBoxArtifactPq,
  type BoxArtifactPqPin,
} from "../src/boxArtifactPq.js";
import { hybridSigKeygen, hybridSign } from "../src/pqHybrid.js";
import { canonicalPqKeyBinding, messagePurpose, verifyPqKeyBinding, type PqBindingRole } from "../src/pqTrust.js";

const V = JSON.parse(readFileSync(join(__dirname, "../test-vectors/box-artifact/pq-vectors.json"), "utf8")) as {
  now: number;
  manifest: BoxArtifactManifest;
  trust: { keys: string[]; threshold: number };
  cases: { name: string; signatures: BoxArtifactSignature[]; pin: BoxArtifactPqPin; bindings: unknown[]; expect: { ok: boolean; code?: string } }[];
};

describe("the box artifact's PQ companion", () => {
  it.each(V.cases)("$name", (c) => {
    const r = verifyBoxArtifact(V.manifest, c.signatures, { trust: V.trust, verifierVersion: 1, pqPin: c.pin, pqBindings: c.bindings, now: V.now });
    expect(r.ok ? { ok: true } : { ok: false, code: r.code }).toEqual(c.expect);
  });

  it("ships with the release key pinned (the 2026-10-26 ceremony)", () => {
    expect(boxArtifactPqPinConfigured(BOX_ARTIFACT_PQ_PIN)).toBe(true);
    expect([...BOX_ARTIFACT_PQ_PIN.keyIds]).toEqual(["1c07f1ffe8e6e8b89d8b8c8c14544d6f065decfa67ea76ec50c30fadaadb9434"]);
  });
});

describe("verifyBoxArtifactPq checks the binding's role itself", () => {
  const NOW = 1_760_000_100_000;
  const seed = (n: number) => new Uint8Array(32).fill(n);
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  const sk = Uint8Array.from([...seed(41), ...seed(42)]);
  const kp = hybridSigKeygen(seed(41), seed(42));
  const ed25519PubHex = hex(kp.publicKey.subarray(0, 32));
  const mldsaPubHex = hex(kp.publicKey.subarray(32));
  const bind = (role: PqBindingRole, subjectId: string) => {
    const st = { role, subjectId, ed25519PubHex, mldsaPubHex, issuedAt: NOW };
    const msg = canonicalPqKeyBinding(st);
    const wire = { v: 1 as const, ...st, signature: hex(hybridSign(sk, messagePurpose(msg), msg)) };
    return verifyPqKeyBinding(wire, { role, subjectId, ed25519PubHex, now: NOW });
  };
  const v1 = new TextEncoder().encode("flagship/box-artifact/v1|0123|amd64");
  const comp = signBoxArtifactPq(v1, sk, kp.publicKey);

  it("accepts the release-key binding for the box-artifact subject", () => {
    const b = bind("release-key", BOX_ARTIFACT_PQ_BINDING_SUBJECT);
    expect(verifyBoxArtifactPq(v1, ed25519PubHex, comp, new Map([[ed25519PubHex, b]]))).toBe(true);
  });

  it("refuses the same key bound under another role or subject, a binding filed under another signer, and a look-alike object", () => {
    for (const b of [bind("device", "dev_1"), bind("admin-root", "alice"), bind("release-key", "flagship-release")]) {
      expect(verifyBoxArtifactPq(v1, ed25519PubHex, comp, new Map([[ed25519PubHex, b]]))).toBe(false);
    }
    const good = bind("release-key", BOX_ARTIFACT_PQ_BINDING_SUBJECT);
    const other = "ab".repeat(32);
    expect(verifyBoxArtifactPq(v1, other, comp, new Map([[other, good]]))).toBe(false);
    expect(verifyBoxArtifactPq(v1, ed25519PubHex, comp, new Map([[ed25519PubHex, { ...good }]]))).toBe(false);
  });
});
