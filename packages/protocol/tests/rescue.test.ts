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
  type RescueExchange,
} from "../src/rescue.js";
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
