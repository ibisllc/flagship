/**
 * STK-signed push-relay request — canonical bytes + sign/verify, with a
 * PINNED cross-platform vector. The legitimate sender of a push relay is
 * one of the target's own boxes; it signs with the SAME STK it signs
 * daemon-status reports with (derived deriveSTK(deriveSWK(UMK, serverId))),
 * so this reuses the daemon-status pinned UMK/serverId to keep the box key
 * identical across both contracts.
 */

import { describe, expect, it } from "vitest";
import {
  PUSH_RELAY_CATEGORIES,
  canonicalPushRelayRequest,
  deriveSTK,
  deriveSWK,
  isPushRelayCategory,
  signPushRelayRequest,
  verifyPushRelayRequest,
  type PushRelayRequest,
  type UserMasterKey,
} from "../src/index.js";

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const UMK_SEED_HEX = "07".repeat(32);
const SERVER_ID = "abc5.harry1.flagship.services";
const STK_PUB_HEX =
  "0a1eaaad1e4f57435b95e2339654618e121b2b84d3ac595c64f73520fde90d47";

const REQUEST: PushRelayRequest = {
  targetUsername: "harry1",
  category: "unlock-request",
  sealedPayloadHex: "deadbeefdeadbeefdeadbeefdeadbeef",
  issuedAt: 1_700_000_000_000,
};

describe("push-relay envelope", () => {
  const umk: UserMasterKey = { seed: hexToBytes(UMK_SEED_HEX) };
  const stk = deriveSTK(deriveSWK(umk, SERVER_ID));

  it("derives the same STK the daemon-status contract pins", () => {
    expect(bytesToHex(stk.publicKey)).toBe(STK_PUB_HEX);
  });

  it("produces stable canonical bytes", () => {
    const canonical = new TextDecoder().decode(canonicalPushRelayRequest(REQUEST));
    const digest = canonical.split("|")[3];
    expect(canonical).toBe(
      `flagship/push-relay/v1|harry1|unlock-request|${digest}|1700000000000`,
    );
    // The 4th field is sha256(sealedPayloadHex), lowercase hex, 64 chars.
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies a signature from the box STK", () => {
    const sig = signPushRelayRequest(REQUEST, stk);
    expect(verifyPushRelayRequest(REQUEST, sig, stk.publicKey)).toBe(true);
  });

  it("rejects a signature under a different key", () => {
    const other = deriveSTK(deriveSWK(umk, "other.harry1.flagship.services"));
    const sig = signPushRelayRequest(REQUEST, other);
    expect(verifyPushRelayRequest(REQUEST, sig, stk.publicKey)).toBe(false);
  });

  it("rejects when any signed field is tampered", () => {
    const sig = signPushRelayRequest(REQUEST, stk);
    for (const mutated of [
      { ...REQUEST, targetUsername: "harry2" },
      { ...REQUEST, category: "boot-approval" as const },
      { ...REQUEST, sealedPayloadHex: "00000000" },
      { ...REQUEST, issuedAt: REQUEST.issuedAt + 1 },
    ]) {
      expect(verifyPushRelayRequest(mutated, sig, stk.publicKey)).toBe(false);
    }
  });

  it("constrains the category enum", () => {
    expect(isPushRelayCategory("unlock-request")).toBe(true);
    expect(isPushRelayCategory("rm -rf /")).toBe(false);
    expect(PUSH_RELAY_CATEGORIES).toContain("generic");
  });
});
