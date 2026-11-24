/**
 * SEC — low-order / zero public-key rejection at the `ed` chokepoint.
 *
 * Plain Ed25519 verification accepts low-order public keys; most dangerously
 * the all-zero key, for which a zero signature verifies against ANY message.
 * `edSync` hardens `ed.verify` to reject the libsodium small-order blocklist
 * and to never throw on malformed input, covering every protocol verifier at
 * once. This pins the exploited case (the all-zero IRK that could squat any
 * username) and confirms legitimate keys still verify.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ed, edVerifyFast, isAcceptableEd25519PublicKey } from "../src/edSync.js";
import {
  signClaimUsername,
  verifyClaimUsername,
  deriveIRK,
  generateUMK,
  type ClaimUsername,
} from "../src/index.js";

const ZERO_PUB = new Uint8Array(32); // 0x00…00 — the exploited low-order key
const ZERO_SIG = new Uint8Array(64);

describe("ed low-order public-key rejection", () => {
  it("rejects the all-zero pubkey + zero signature (was accepted by raw noble)", () => {
    const msg = new TextEncoder().encode("any message");
    expect(ed.verify(ZERO_SIG, msg, ZERO_PUB)).toBe(false);
  });

  it("rejects a malformed (wrong-length) pubkey without throwing", () => {
    const msg = new Uint8Array([1, 2, 3]);
    expect(ed.verify(ZERO_SIG, msg, new Uint8Array(16))).toBe(false);
  });

  it("verifyClaimUsername cannot be satisfied by the zero key", () => {
    const claim: ClaimUsername = {
      username: "victim",
      irkPub: ZERO_PUB,
      issuedAt: 1,
    };
    expect(verifyClaimUsername(claim, ZERO_SIG, ZERO_PUB)).toBe(false);
  });

  it("a legitimate keypair still verifies (no false negatives)", () => {
    const irk = deriveIRK(generateUMK());
    const claim: ClaimUsername = {
      username: "alice",
      irkPub: irk.publicKey,
      issuedAt: 123,
    };
    const sig = signClaimUsername(claim, irk);
    expect(verifyClaimUsername(claim, sig, irk.publicKey)).toBe(true);
  });
});

const V = JSON.parse(readFileSync(new URL("../test-vectors/ed25519-low-order/vectors.json", import.meta.url), "utf8")) as {
  forgedSignatureHex: string;
  messagesHex: string[];
  rejectPublicKeysHex: string[];
  honest: { publicKeyHex: string; signatures: { messageHex: string; signatureHex: string }[] };
};
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));

describe("shared vectors: ed25519-low-order", () => {
  it("every low-order or non-canonical key is refused, sync, async and native-first", async () => {
    for (const k of V.rejectPublicKeysHex) {
      expect(isAcceptableEd25519PublicKey(k), k).toBe(false);
      for (const m of V.messagesHex) {
        expect(ed.verify(V.forgedSignatureHex, m, k), `${k} ${m}`).toBe(false);
        expect(ed.verify(V.forgedSignatureHex, m, k, { zip215: true }), `${k} ${m} zip215`).toBe(false);
        expect(await ed.verifyAsync(V.forgedSignatureHex, m, k), `${k} ${m} async`).toBe(false);
        expect(await edVerifyFast(hex(V.forgedSignatureHex), hex(m), hex(k)), `${k} ${m} fast`).toBe(false);
      }
    }
  });

  it("raw noble would have accepted some of them (the vectors are live)", async () => {
    const raw = await import("@noble/ed25519");
    let forged = 0;
    for (const k of V.rejectPublicKeysHex) for (const m of V.messagesHex) if (raw.verify(V.forgedSignatureHex, m, k)) forged++;
    expect(forged).toBeGreaterThan(0);
  });

  it("the honest key verifies through every path", async () => {
    expect(isAcceptableEd25519PublicKey(V.honest.publicKeyHex)).toBe(true);
    for (const s of V.honest.signatures) {
      expect(ed.verify(s.signatureHex, s.messageHex, V.honest.publicKeyHex)).toBe(true);
      expect(await ed.verifyAsync(s.signatureHex, s.messageHex, V.honest.publicKeyHex)).toBe(true);
      expect(await edVerifyFast(hex(s.signatureHex), hex(s.messageHex), hex(V.honest.publicKeyHex))).toBe(true);
    }
  });

  it("random honest keys are always acceptable", () => {
    for (let i = 0; i < 64; i++) expect(isAcceptableEd25519PublicKey(ed.getPublicKey(ed.utils.randomPrivateKey()))).toBe(true);
  });

  it("garbage input is refused without throwing", () => {
    expect(isAcceptableEd25519PublicKey("zz")).toBe(false);
    expect(isAcceptableEd25519PublicKey(new Uint8Array(31))).toBe(false);
    expect(isAcceptableEd25519PublicKey("ff".repeat(32))).toBe(false);
  });
});
