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
import { ed } from "../src/edSync.js";
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
