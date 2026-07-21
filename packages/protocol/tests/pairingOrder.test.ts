import { describe, expect, it } from "vitest";
import {
  openPairingOrderEnvelope,
  pairingOrderToJson,
  parsePairingOrderEnvelope,
  verifyPairingOrderEnvelope,
} from "../src/pairingOrder.js";
import { signPhoneOrder, type PhoneOrder } from "../src/orders.js";
import { deriveIRK } from "../src/keys.js";
import { ed } from "../src/edSync.js";

// Pinned cross-platform vector: a fixed owner UMK → IRK, a fixed
// add-paired-session order, and the resulting plaintext envelope JSON. The Swift
// / Kotlin twins (next agent) reproduce these bytes exactly.
const UMK = { seed: new Uint8Array(32).fill(7) };
const irk = deriveIRK(UMK);
const SERVER_ID = "kitchen.alice.flagship.services";
const ISSUED_AT = 1_750_000_000_000;

const order: Extract<PhoneOrder, { type: "add-paired-session" }> = {
  type: "add-paired-session",
  serverId: SERVER_ID,
  token: "a".repeat(64),
  issuedAt: ISSUED_AT,
};
const signature = signPhoneOrder(order, irk);

describe("pairing-order envelope (secret-free pairing)", () => {
  it("round-trips: serialize → parse → verify → extract the order", () => {
    const json = pairingOrderToJson(order, signature);
    const env = parsePairingOrderEnvelope(json);
    expect(env).not.toBeNull();
    expect(verifyPairingOrderEnvelope(env!, irk.publicKey, SERVER_ID)).toBe(true);
    const opened = openPairingOrderEnvelope({
      json,
      ownerIrkPub: irk.publicKey,
      expectedServerId: SERVER_ID,
    });
    expect(opened).not.toBeNull();
    expect(opened!.token).toBe(order.token);
    expect(opened!.issuedAt).toBe(order.issuedAt);
  });

  it("PINNED VECTOR: the plaintext envelope JSON is byte-stable", () => {
    const json = pairingOrderToJson(order, signature);
    // The order body + the hex signature. Pinned so native twins match.
    expect(json).toBe(
      JSON.stringify({
        request: {
          type: "add-paired-session",
          serverId: SERVER_ID,
          token: "a".repeat(64),
          issuedAt: ISSUED_AT,
        },
        signature:
          [...signature].map((b) => b.toString(16).padStart(2, "0")).join(""),
      }),
    );
  });

  it("rejects a wrong-box envelope (relay can't re-target)", () => {
    const json = pairingOrderToJson(order, signature);
    const env = parsePairingOrderEnvelope(json)!;
    expect(verifyPairingOrderEnvelope(env, irk.publicKey, "other.bob.flagship.services")).toBe(false);
    expect(
      openPairingOrderEnvelope({
        json,
        ownerIrkPub: irk.publicKey,
        expectedServerId: "other.bob.flagship.services",
      }),
    ).toBeNull();
  });

  it("rejects a wrong-owner signature", () => {
    const stranger = deriveIRK({ seed: new Uint8Array(32).fill(99) });
    const json = pairingOrderToJson(order, signature);
    expect(
      openPairingOrderEnvelope({
        json,
        ownerIrkPub: stranger.publicKey,
        expectedServerId: SERVER_ID,
      }),
    ).toBeNull();
  });

  it("rejects a tampered order body (signature no longer covers it)", () => {
    const env = parsePairingOrderEnvelope(pairingOrderToJson(order, signature))!;
    const tampered = pairingOrderToJson(
      { ...env.request, token: "b".repeat(64) },
      env.signature,
    );
    expect(
      openPairingOrderEnvelope({
        json: tampered,
        ownerIrkPub: irk.publicKey,
        expectedServerId: SERVER_ID,
      }),
    ).toBeNull();
  });

  it("never throws on junk / non-JSON / wrong shape", () => {
    expect(parsePairingOrderEnvelope("not json")).toBeNull();
    expect(parsePairingOrderEnvelope("{}")).toBeNull();
    expect(parsePairingOrderEnvelope(JSON.stringify({ request: 1, signature: "zz" }))).toBeNull();
    expect(
      parsePairingOrderEnvelope(
        JSON.stringify({ request: { type: "noop" }, signature: "ab" }),
      ),
    ).toBeNull();
    // signature present but not even-length hex
    expect(
      parsePairingOrderEnvelope(
        JSON.stringify({ request: order, signature: "abc" }),
      ),
    ).toBeNull();
    expect(
      openPairingOrderEnvelope({
        json: "garbage",
        ownerIrkPub: irk.publicKey,
        expectedServerId: SERVER_ID,
      }),
    ).toBeNull();
  });

  it("verify is robust to a low-order owner key (never throws, returns false)", () => {
    const json = pairingOrderToJson(order, signature);
    const zeroKey = new Uint8Array(32);
    expect(
      openPairingOrderEnvelope({
        json,
        ownerIrkPub: zeroKey,
        expectedServerId: SERVER_ID,
      }),
    ).toBeNull();
  });
});
