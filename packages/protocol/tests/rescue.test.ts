import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RESCUE_HELLO_TTL_MS,
  checkRescueHello,
  parseRescueExchange,
  rescueDiscoveryId,
  rescueHelloCanonicalBytes,
  rescueSessionCanonicalBytes,
  signRescueHello,
  signRescueSession,
  verifyRescueHello,
  verifyRescueSession,
  TAG_OFFLINE_CONTROL,
  isOfflineServiceId,
  offlineControlCanonicalBytes,
  parseOfflineControl,
  signOfflineControl,
  verifyOfflineControl,
  type OfflineControlOrder,
  type RescueExchange,
} from "../src/rescue.js";
import { PqTrustError, verifyCriticalSignature, verifyPqKeyBinding, type PqBindingExpectation, type SignatureEnvelope } from "../src/pqTrust.js";
import type { PolicyState } from "../src/assurancePolicy.js";
import { hex } from "../src/canonicalBase.js";
import { deriveIRK, deriveSTK, deriveSWK } from "../src/keys.js";

const V = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/rescue/vectors.json"), "utf8")) as {
  umkSeedHex: string;
  irkPub: string;
  cases: Array<RescueExchange & { stkPub: string; helloCanonical: string; helloSignature: string; sessionCanonical: string; sessionSignature: string; discoveryId: string }>;
  invalid: RescueExchange[];
};
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const umk = { seed: fromHex(V.umkSeedHex) };
const irk = deriveIRK(umk);

describe("rescue vectors (test-vectors/rescue/vectors.json)", () => {
  it("signs the session order with the IRK derived from the fixture seed", () => {
    expect(hex(irk.publicKey)).toBe(V.irkPub);
  });
  it.each(V.cases.map((c, i) => [i, c] as const))("case #%i", (_i, c) => {
    const x: RescueExchange = { serverDomain: c.serverDomain, clientNonce: c.clientNonce, boxNonce: c.boxNonce, certSha256: c.certSha256, issuedAt: c.issuedAt };
    const stk = deriveSTK(deriveSWK(umk, c.serverDomain));
    expect(hex(stk.publicKey)).toBe(c.stkPub);
    expect(new TextDecoder().decode(rescueHelloCanonicalBytes(x))).toBe(c.helloCanonical);
    expect(new TextDecoder().decode(rescueSessionCanonicalBytes(x))).toBe(c.sessionCanonical);
    expect(hex(signRescueHello(x, stk))).toBe(c.helloSignature);
    expect(hex(signRescueSession(x, irk))).toBe(c.sessionSignature);
    expect(verifyRescueHello(x, fromHex(c.helloSignature), stk.publicKey)).toBe(true);
    expect(verifyRescueSession(x, fromHex(c.sessionSignature), irk.publicKey)).toBe(true);
    expect(rescueDiscoveryId(stk.publicKey, c.serverDomain)).toBe(c.discoveryId);
    expect(rescueDiscoveryId(stk.publicKey, c.serverDomain.toUpperCase())).toBe(c.discoveryId);
    expect(parseRescueExchange(x)).toEqual(x);
  });
  it("a hello is not a session order and a session order is not a hello (distinct tags)", () => {
    const c = V.cases[0]!;
    const x: RescueExchange = { serverDomain: c.serverDomain, clientNonce: c.clientNonce, boxNonce: c.boxNonce, certSha256: c.certSha256, issuedAt: c.issuedAt };
    const stk = deriveSTK(deriveSWK(umk, c.serverDomain));
    expect(verifyRescueSession(x, signRescueHello(x, stk), stk.publicKey)).toBe(false);
    expect(verifyRescueHello(x, signRescueSession(x, stk), stk.publicKey)).toBe(false);
  });
  it("every field is covered by the signature", () => {
    const c = V.cases[0]!;
    const x: RescueExchange = { serverDomain: c.serverDomain, clientNonce: c.clientNonce, boxNonce: c.boxNonce, certSha256: c.certSha256, issuedAt: c.issuedAt };
    const sig = fromHex(c.sessionSignature);
    for (const t of [
      { ...x, serverDomain: "other.harry.flagship.services" },
      { ...x, clientNonce: "11".repeat(16) },
      { ...x, boxNonce: "22".repeat(16) },
      { ...x, certSha256: "33".repeat(32) },
      { ...x, issuedAt: x.issuedAt + 1 },
    ]) {
      expect(verifyRescueSession(t, sig, irk.publicKey)).toBe(false);
    }
  });
  it.each(V.invalid.map((c, i) => [i, c] as const))("refuses invalid #%i", (_i, c) => {
    expect(parseRescueExchange(c)).toBeNull();
    expect(() => rescueHelloCanonicalBytes(c)).toThrow();
  });
});

describe("checkRescueHello (what the phone checks before it signs)", () => {
  const c = V.cases[0]!;
  const hello: RescueExchange = { serverDomain: c.serverDomain, clientNonce: c.clientNonce, boxNonce: c.boxNonce, certSha256: c.certSha256, issuedAt: c.issuedAt };
  const stk = deriveSTK(deriveSWK(umk, c.serverDomain));
  const sig = fromHex(c.helloSignature);
  const expectOk = { serverDomain: c.serverDomain, clientNonce: c.clientNonce, seenCertSha256: c.certSha256, now: c.issuedAt + 1000 };

  it("accepts the box's hello for the connection it came on", () => {
    expect(checkRescueHello(hello, sig, stk.publicKey, expectOk)).toEqual({ ok: true });
  });
  it("refuses a hello signed by another key (a machine that is not the box)", () => {
    const other = deriveSTK(deriveSWK(umk, "other.harry.flagship.services"));
    expect(checkRescueHello(hello, sig, other.publicKey, expectOk)).toEqual({ ok: false, reason: "bad-signature" });
  });
  it("refuses a certificate other than the one the connection presented (a man in the middle)", () => {
    expect(checkRescueHello(hello, sig, stk.publicKey, { ...expectOk, seenCertSha256: "cd".repeat(32) })).toEqual({ ok: false, reason: "cert-mismatch" });
  });
  it("refuses another server, an old nonce, a stale hello and one from the future", () => {
    expect(checkRescueHello(hello, sig, stk.publicKey, { ...expectOk, serverDomain: "x.harry.flagship.services" })).toEqual({ ok: false, reason: "wrong-server" });
    expect(checkRescueHello(hello, sig, stk.publicKey, { ...expectOk, clientNonce: "99".repeat(16) })).toEqual({ ok: false, reason: "wrong-nonce" });
    expect(checkRescueHello(hello, sig, stk.publicKey, { ...expectOk, now: c.issuedAt + RESCUE_HELLO_TTL_MS + 1 })).toEqual({ ok: false, reason: "expired" });
    expect(checkRescueHello(hello, sig, stk.publicKey, { ...expectOk, now: c.issuedAt - 10 * 60_000 })).toEqual({ ok: false, reason: "not-yet-valid" });
  });
  it("does not care whether the certificate has expired: only that it is the one on the wire", () => {
    // The check takes a hash, never a certificate: an expired Let's Encrypt cert works as long as it matches.
    expect(checkRescueHello(hello, sig, stk.publicKey, expectOk).ok).toBe(true);
  });
});

// ── offline control + the PQ half (tools/rescue-vectors.ts) ─────────────────────

const OC = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/rescue/offline-control.json"), "utf8")) as {
  umkSeedHex: string;
  irkPub: string;
  cases: Array<{ name: string; order: OfflineControlOrder; canonical: string; signature: string }>;
  refused: Array<{ name: string; order: Record<string, unknown> }>;
};
const PQ = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/rescue/pq-vectors.json"), "utf8")) as {
  bindings: { valid: Array<{ name: string; wire: unknown; expect: PqBindingExpectation }> };
  exchange: RescueExchange;
  controlOrder: OfflineControlOrder;
  gate: Array<{
    name: string;
    messageHex: string;
    expectedPurpose: string;
    envelope: SignatureEnvelope;
    signerEd25519PubHex: string;
    binding: string | null;
    policy: PolicyState;
    expect: { ok: true; suite: string; strict: boolean } | { ok: false; code: string };
  }>;
};

describe("offline-control vectors (test-vectors/rescue/offline-control.json)", () => {
  const ocIrk = deriveIRK({ seed: fromHex(OC.umkSeedHex) });
  it("uses the IRK of the fixture seed", () => {
    expect(hex(ocIrk.publicKey)).toBe(OC.irkPub);
  });
  it.each(OC.cases.map((c) => [c.name, c] as const))("%s", (_n, c) => {
    expect(new TextDecoder().decode(offlineControlCanonicalBytes(c.order))).toBe(c.canonical);
    expect(hex(signOfflineControl(c.order, ocIrk))).toBe(c.signature);
    expect(verifyOfflineControl(c.order, fromHex(c.signature), ocIrk.publicKey)).toBe(true);
    expect(parseOfflineControl(c.order)).toEqual(c.order);
  });
  it.each(OC.refused.map((c) => [c.name, c] as const))("refuses %s", (_n, c) => {
    expect(parseOfflineControl(c.order)).toBeNull();
    expect(() => offlineControlCanonicalBytes(c.order as unknown as OfflineControlOrder)).toThrow();
  });
  it("every field is covered by the signature", () => {
    const c = OC.cases[0]!;
    const sig = fromHex(c.signature);
    for (const t of [
      { serverDomain: "home2.alice.flagship.services" },
      { sessionNonce: "00".repeat(16) },
      { action: "app-stop" as const },
      { target: "alice--other" },
      { nonce: "11".repeat(16) },
      { issuedAt: c.order.issuedAt + 1 },
    ]) {
      expect(verifyOfflineControl({ ...c.order, ...t }, sig, ocIrk.publicKey)).toBe(false);
    }
  });
  it("an offline order is not a rescue session order (distinct tags)", () => {
    expect(TAG_OFFLINE_CONTROL).not.toBe("flagship/rescue-session/v1");
    expect(isOfflineServiceId("alice--notes")).toBe(true);
    expect(isOfflineServiceId("alice--notes--x")).toBe(false);
  });
});

describe("rescue PQ gate vectors (test-vectors/rescue/pq-vectors.json)", () => {
  const bound = new Map(PQ.bindings.valid.map((b) => [b.name, verifyPqKeyBinding(b.wire, b.expect)]));
  it("names the exchange and order the messages are built from", () => {
    const session = PQ.gate.find((g) => g.name === "session-strict-hybrid")!;
    expect(session.messageHex).toBe(hex(rescueSessionCanonicalBytes(PQ.exchange)));
    const control = PQ.gate.find((g) => g.name === "control-strict-hybrid")!;
    expect(control.messageHex).toBe(hex(offlineControlCanonicalBytes(PQ.controlOrder)));
    const hello = PQ.gate.find((g) => g.name === "hello-strict-hybrid")!;
    expect(hello.messageHex).toBe(hex(rescueHelloCanonicalBytes(PQ.exchange)));
  });
  it.each(PQ.gate.map((g) => [g.name, g] as const))("%s", (_n, g) => {
    let got: { ok: true; suite: string; strict: boolean } | { ok: false; code: string };
    try {
      const v = verifyCriticalSignature({
        message: fromHex(g.messageHex),
        expectedPurpose: g.expectedPurpose,
        envelope: g.envelope,
        signerEd25519PubHex: g.signerEd25519PubHex,
        binding: g.binding ? bound.get(g.binding)! : null,
        policy: g.policy,
      });
      got = { ok: true, suite: v.suite, strict: v.strict };
    } catch (e) {
      got = { ok: false, code: (e as PqTrustError).code };
    }
    expect(got).toEqual(g.expect);
  });
  it("a classical-only order never passes under strict", () => {
    for (const g of PQ.gate.filter((x) => x.envelope.suite === "ed25519/v1" && x.policy.profile === "strict")) expect(g.expect.ok).toBe(false);
  });
});
