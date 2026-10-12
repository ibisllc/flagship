import { describe, expect, it } from "vitest";
import {
  CAPABILITY_OUTBOUND_V1,
  decodeFrame,
  encodeFrame,
  FRAME_HEADER_BYTES,
  FRAME_OUTBOUND_CREDIT,
  FRAME_OUTBOUND_OPEN,
  FRAME_OUTBOUND_RESULT,
  helloAckFrame,
  isOutboundStreamId,
  OUTBOUND_INITIAL_WINDOW,
  OUTBOUND_STREAM_ID_BASE,
  outboundCreditFrame,
  outboundOpenFrame,
  outboundResultFrame,
  parseHelloAck,
  parseOutboundCredit,
  parseOutboundOpen,
  parseOutboundResult,
} from "../src/index.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("outbound frames: golden bytes", () => {
  it("OUTBOUND_OPEN", () => {
    expect(hex(encodeFrame(outboundOpenFrame(0x8000_0001, { host: "api.anthropic.com", port: 443 })))).toBe(
      "80000001" + "40" + "00000027" +
        Buffer.from('{"host":"api.anthropic.com","port":443}').toString("hex"),
    );
  });

  it("OUTBOUND_RESULT ok and refused", () => {
    expect(hex(encodeFrame(outboundResultFrame(0x8000_0001, { ok: true })))).toBe(
      "80000001410000000b7b226f6b223a747275657d",
    );
    expect(
      hex(encodeFrame(outboundResultFrame(0x8000_0002, { ok: false, reason: "forbidden-address" }))),
    ).toBe(
      "8000000241000000297b226f6b223a66616c73652c22726561736f6e223a22666f7262696464656e2d61646472657373227d",
    );
  });

  it("OUTBOUND_CREDIT is a 4-byte big-endian count", () => {
    expect(hex(encodeFrame(outboundCreditFrame(0x8000_0001, OUTBOUND_INITIAL_WINDOW)))).toBe(
      "80000001420000000400040000",
    );
  });

  it("HELLO_ACK advertising outbound-v1", () => {
    expect(hex(encodeFrame(helloAckFrame(true, undefined, undefined, [CAPABILITY_OUTBOUND_V1])))).toBe(
      "00000000110000002a" +
        Buffer.from('{"ok":true,"capabilities":["outbound-v1"]}').toString("hex"),
    );
  });
});

describe("outbound frames: decode + parse", () => {
  it("round-trips every new type through decodeFrame", () => {
    for (const f of [
      outboundOpenFrame(OUTBOUND_STREAM_ID_BASE + 5, { host: "api.openai.com", port: 443 }),
      outboundResultFrame(OUTBOUND_STREAM_ID_BASE + 5, { ok: true }),
      outboundCreditFrame(OUTBOUND_STREAM_ID_BASE + 5, 1),
    ]) {
      const r = decodeFrame(encodeFrame(f));
      expect(r.kind).toBe("ok");
      if (r.kind !== "ok") continue;
      expect([FRAME_OUTBOUND_OPEN, FRAME_OUTBOUND_RESULT, FRAME_OUTBOUND_CREDIT]).toContain(r.frame.type);
      expect(r.frame.streamId).toBe(OUTBOUND_STREAM_ID_BASE + 5);
    }
  });

  it("open payload validation", () => {
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
    expect(parseOutboundOpen(enc({ host: "a.example", port: 443 }))).toEqual({ host: "a.example", port: 443 });
    expect(parseOutboundOpen(enc({ host: "", port: 443 }))).toBeNull();
    expect(parseOutboundOpen(enc({ host: "a.example", port: 0 }))).toBeNull();
    expect(parseOutboundOpen(enc({ host: "a.example", port: 1.5 }))).toBeNull();
    expect(parseOutboundOpen(enc({ host: "x".repeat(254), port: 443 }))).toBeNull();
    expect(parseOutboundOpen(enc([1]))).toBeNull();
    expect(parseOutboundOpen(new TextEncoder().encode("nope"))).toBeNull();
  });

  it("result parsing maps an unknown reason to connect-failed", () => {
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
    expect(parseOutboundResult(enc({ ok: true }))).toEqual({ ok: true });
    expect(parseOutboundResult(enc({ ok: false, reason: "dns-failed" }))).toEqual({ ok: false, reason: "dns-failed" });
    expect(parseOutboundResult(enc({ ok: false, reason: "<script>" }))).toEqual({ ok: false, reason: "connect-failed" });
    expect(parseOutboundResult(enc({}))).toBeNull();
  });

  it("credit parsing rejects zero and wrong lengths", () => {
    expect(parseOutboundCredit(new Uint8Array([0, 0, 0, 0]))).toBeNull();
    expect(parseOutboundCredit(new Uint8Array([0, 1]))).toBeNull();
    expect(parseOutboundCredit(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toBe(0xffff_ffff);
    expect(() => outboundCreditFrame(OUTBOUND_STREAM_ID_BASE + 1, 0)).toThrow();
  });

  it("stream-id spaces never overlap", () => {
    expect(isOutboundStreamId(1)).toBe(false);
    expect(isOutboundStreamId(OUTBOUND_STREAM_ID_BASE - 1)).toBe(false);
    expect(isOutboundStreamId(OUTBOUND_STREAM_ID_BASE)).toBe(true);
    expect(isOutboundStreamId(0xffff_ffff)).toBe(true);
    expect(() => outboundOpenFrame(7, { host: "a.example", port: 443 })).toThrow();
    expect(FRAME_HEADER_BYTES).toBe(9);
  });
});

describe("HELLO_ACK capabilities stay backward compatible", () => {
  it("an old hub's ack has no capabilities", () => {
    const r = decodeFrame(encodeFrame(helloAckFrame(true)));
    if (r.kind !== "ok") throw new Error("decode");
    expect(parseHelloAck(r.frame.payload)).toEqual({ ok: true });
  });

  it("a new hub's ack lists them, and non-strings are dropped", () => {
    const parsed = parseHelloAck(
      new TextEncoder().encode(JSON.stringify({ ok: true, capabilities: ["outbound-v1", 7, null] })),
    );
    expect(parsed?.capabilities).toEqual(["outbound-v1"]);
  });
});
