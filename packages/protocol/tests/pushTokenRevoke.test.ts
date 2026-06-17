/**
 * IRK-signed push-token REVOKE — canonical bytes + sign/verify, with a
 * PINNED cross-platform vector. Revoke is proven by the account IRK so a
 * tokenId-knower can no longer silently delete a device's push tether.
 * The Swift (`PushTokenRevoke.swift`) + Kotlin (`PushTokenRevoke.kt`) +
 * webapp (`lib/push.js`) mirrors MUST reproduce the same bytes.
 */

import { describe, expect, it } from "vitest";
import {
  canonicalPushTokenRevoke,
  ed,
  signPushTokenRevoke,
  verifyPushTokenRevoke,
  type Keypair,
  type PushTokenRevoke,
} from "../src/index.js";

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

// Fixed IRK seed so the pinned signature vector is reproducible across
// every surface that re-implements the canonical bytes.
const IRK_SEED_HEX = "11".repeat(32);
const IRK_PUB_HEX =
  "d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737";
const SIG_HEX =
  "46dde40edd081692a6412539bbb5e1a27f978a0bfdd27bbbd7cd4911501f5c27" +
  "3948f78248c70199ccb27905720a5a22fe5dc9d7c4bbff2b936663a467f2980b";

const REQUEST: PushTokenRevoke = {
  tokenId: "0123456789abcdef0123456789abcdef",
  issuedAt: 1_700_000_000_000,
};

describe("push-token-revoke envelope", () => {
  const irk: Keypair = {
    privateKey: Uint8Array.from(
      IRK_SEED_HEX.match(/.{2}/g)!.map((h) => parseInt(h, 16)),
    ),
    publicKey: ed.getPublicKey(
      Uint8Array.from(IRK_SEED_HEX.match(/.{2}/g)!.map((h) => parseInt(h, 16))),
    ),
  };

  it("derives the pinned IRK pubkey from the fixed seed", () => {
    expect(bytesToHex(irk.publicKey)).toBe(IRK_PUB_HEX);
  });

  it("produces stable canonical bytes", () => {
    const canonical = new TextDecoder().decode(canonicalPushTokenRevoke(REQUEST));
    expect(canonical).toBe(
      "flagship/push-token-revoke/v1|0123456789abcdef0123456789abcdef|1700000000000",
    );
  });

  it("matches the pinned cross-platform signature vector", () => {
    const sig = signPushTokenRevoke(REQUEST, irk);
    expect(bytesToHex(sig)).toBe(SIG_HEX);
  });

  it("verifies a signature from the account IRK", () => {
    const sig = signPushTokenRevoke(REQUEST, irk);
    expect(verifyPushTokenRevoke(REQUEST, sig, irk.publicKey)).toBe(true);
  });

  it("rejects a signature under a different key", () => {
    const otherSeed = Uint8Array.from(
      "22".repeat(32).match(/.{2}/g)!.map((h) => parseInt(h, 16)),
    );
    const other: Keypair = { privateKey: otherSeed, publicKey: ed.getPublicKey(otherSeed) };
    const sig = signPushTokenRevoke(REQUEST, other);
    expect(verifyPushTokenRevoke(REQUEST, sig, irk.publicKey)).toBe(false);
  });

  it("rejects when any signed field is tampered", () => {
    const sig = signPushTokenRevoke(REQUEST, irk);
    for (const mutated of [
      { ...REQUEST, tokenId: "ffffffffffffffffffffffffffffffff" },
      { ...REQUEST, issuedAt: REQUEST.issuedAt + 1 },
    ]) {
      expect(verifyPushTokenRevoke(mutated, sig, irk.publicKey)).toBe(false);
    }
  });

  it("field-guards the tokenId against separator / control chars", () => {
    expect(() => canonicalPushTokenRevoke({ tokenId: "ab|cd", issuedAt: 1 })).toThrow();
    expect(() => canonicalPushTokenRevoke({ tokenId: "ab\ncd", issuedAt: 1 })).toThrow();
  });
});
