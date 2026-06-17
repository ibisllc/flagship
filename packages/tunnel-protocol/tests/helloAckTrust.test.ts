import { describe, expect, it } from "vitest";
import {
  decodeFrame,
  encodeFrame,
  FRAME_HELLO_ACK,
  helloAckFrame,
  parseHelloAck,
} from "../src/frames.js";

describe("HELLO_ACK maintainer-trust attachment", () => {
  it("round-trips ok with no trust fields (backward compatible)", () => {
    const f = helloAckFrame(true);
    const r = decodeFrame(encodeFrame(f));
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.frame.type).toBe(FRAME_HELLO_ACK);
    const parsed = parseHelloAck(r.frame.payload);
    expect(parsed).toEqual({ ok: true });
    expect(parsed?.serviceBlessing).toBeUndefined();
    expect(parsed?.hubSig).toBeUndefined();
  });

  it("round-trips a rejection with a reason", () => {
    const f = helloAckFrame(false, "bad HELLO");
    const r = decodeFrame(encodeFrame(f));
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    const parsed = parseHelloAck(r.frame.payload);
    expect(parsed).toEqual({ ok: false, reason: "bad HELLO" });
  });

  it("round-trips an attached blessing + hubSig", () => {
    const blessing = {
      kind: "ServiceBlessing",
      version: 1,
      hubKeyPub: "aa".repeat(32),
      hubHost: "flagship.services",
      nonce: "n-1",
      issuedAt: 1000,
      expiresAt: 2000,
      signedBy: "bb".repeat(32),
      signatures: [{ pubkey: "bb".repeat(32), sig: "cc".repeat(64) }],
    };
    const hubSig = "dd".repeat(64);
    const f = helloAckFrame(true, undefined, { serviceBlessing: blessing, hubSig });
    const r = decodeFrame(encodeFrame(f));
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    const parsed = parseHelloAck(r.frame.payload);
    expect(parsed?.ok).toBe(true);
    expect(parsed?.serviceBlessing).toEqual(blessing);
    expect(parsed?.hubSig).toBe(hubSig);
  });

  it("attaches only hubSig when blessing omitted", () => {
    const f = helloAckFrame(true, undefined, { hubSig: "ee".repeat(64) });
    const r = decodeFrame(encodeFrame(f));
    if (r.kind !== "ok") throw new Error("decode failed");
    const parsed = parseHelloAck(r.frame.payload);
    expect(parsed?.serviceBlessing).toBeUndefined();
    expect(parsed?.hubSig).toBe("ee".repeat(64));
  });

  it("parseHelloAck returns null on non-JSON payload", () => {
    expect(parseHelloAck(new TextEncoder().encode("not json"))).toBeNull();
  });

  it("an old box that ignores the trust fields still reads ok/reason", () => {
    // Simulate a new hub's ack with trust fields; an old parser reading
    // just ok/reason via JSON.parse must be unaffected. We assert the
    // JSON shape stays a superset.
    const f = helloAckFrame(true, undefined, {
      serviceBlessing: { kind: "ServiceBlessing" },
      hubSig: "ff".repeat(64),
    });
    const body = JSON.parse(new TextDecoder().decode(f.payload));
    expect(body.ok).toBe(true);
  });
});
