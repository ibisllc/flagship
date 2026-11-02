import { describe, expect, it } from "vitest";
import {
  closeFrame,
  dataFrame,
  decodeFrame,
  domainGrantedFrame,
  encodeFrame,
  FRAME_DATA,
  FRAME_DOMAIN_GRANTED,
  FRAME_HELLO,
  FRAME_HELLO_ACK,
  FRAME_HEADER_BYTES,
  FRAME_OPEN,
  helloAckFrame,
  helloFrame,
  MAX_FRAME_PAYLOAD,
  openFrame,
  type Frame,
} from "../src/frames.js";

describe("encode/decode round-trip", () => {
  it("HELLO frame", () => {
    const f = helloFrame({
      serverId: "srv-1",
      controlledDomains: ["*.harry.flagship.services"],
    });
    const buf = encodeFrame(f);
    const r = decodeFrame(buf);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.frame.streamId).toBe(0);
    expect(r.frame.type).toBe(FRAME_HELLO);
    const body = JSON.parse(new TextDecoder().decode(r.frame.payload));
    expect(body.serverId).toBe("srv-1");
    expect(r.consumed).toBe(buf.length);
  });

  it("HELLO_ACK frame", () => {
    const buf = encodeFrame(helloAckFrame(true));
    const r = decodeFrame(buf);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.frame.type).toBe(FRAME_HELLO_ACK);
    expect(JSON.parse(new TextDecoder().decode(r.frame.payload)).ok).toBe(true);
  });

  it("DOMAIN_GRANTED frame carries fqdn + ownerServerId", () => {
    const buf = encodeFrame(
      domainGrantedFrame({
        fqdn: "notes.alice.flagship.services",
        ownerServerId: "office.alice.flagship.services",
      }),
    );
    const r = decodeFrame(buf);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.frame.streamId).toBe(0);
    expect(r.frame.type).toBe(FRAME_DOMAIN_GRANTED);
    const body = JSON.parse(new TextDecoder().decode(r.frame.payload));
    expect(body).toEqual({
      fqdn: "notes.alice.flagship.services",
      ownerServerId: "office.alice.flagship.services",
    });
  });

  it("OPEN frame carries the SNI hostname", () => {
    const buf = encodeFrame(openFrame(7, "photos.harry.flagship.services"));
    const r = decodeFrame(buf);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.frame.streamId).toBe(7);
    expect(r.frame.type).toBe(FRAME_OPEN);
    expect(new TextDecoder().decode(r.frame.payload)).toBe("photos.harry.flagship.services");
  });

  it("DATA frame carries arbitrary bytes", () => {
    const data = new Uint8Array([0x01, 0xff, 0x00, 0x42, 0xab]);
    const buf = encodeFrame(dataFrame(13, data));
    const r = decodeFrame(buf);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.frame.streamId).toBe(13);
    expect(r.frame.type).toBe(FRAME_DATA);
    expect(r.frame.payload).toEqual(data);
  });

  it("CLOSE and CLOSE_REMOTE frames have empty payloads", () => {
    const close = encodeFrame(closeFrame(99, false));
    const closeRemote = encodeFrame(closeFrame(99, true));
    expect(close.length).toBe(FRAME_HEADER_BYTES);
    expect(closeRemote.length).toBe(FRAME_HEADER_BYTES);
  });
});

describe("decode error paths", () => {
  it("incomplete on header-too-short", () => {
    const r = decodeFrame(new Uint8Array(4));
    expect(r.kind).toBe("incomplete");
  });

  it("incomplete on header-but-not-enough-payload", () => {
    const partial = encodeFrame(dataFrame(1, new Uint8Array([1, 2, 3])));
    const r = decodeFrame(partial.subarray(0, partial.length - 1));
    expect(r.kind).toBe("incomplete");
  });

  it("error on unknown frame type", () => {
    const buf = new Uint8Array(FRAME_HEADER_BYTES);
    buf[4] = 0xfe; // unknown type
    expect(decodeFrame(buf).kind).toBe("error");
  });

  it("error on payload length exceeding the cap", () => {
    const buf = new Uint8Array(FRAME_HEADER_BYTES);
    // Set type to a valid one
    buf[4] = FRAME_DATA;
    // Set payloadLen huge
    buf[5] = 0xff;
    buf[6] = 0xff;
    buf[7] = 0xff;
    buf[8] = 0xff;
    expect(decodeFrame(buf).kind).toBe("error");
  });

  it("encodeFrame rejects oversized payloads", () => {
    const f: Frame = {
      streamId: 1,
      type: FRAME_DATA,
      payload: new Uint8Array(MAX_FRAME_PAYLOAD + 1),
    };
    expect(() => encodeFrame(f)).toThrow();
  });
});

describe("decode multiple frames concatenated", () => {
  it("returns the first frame and reports how many bytes were consumed", () => {
    const a = encodeFrame(dataFrame(1, new Uint8Array([1])));
    const b = encodeFrame(dataFrame(2, new Uint8Array([2, 2])));
    const concat = new Uint8Array(a.length + b.length);
    concat.set(a, 0);
    concat.set(b, a.length);

    const first = decodeFrame(concat);
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;
    expect(first.consumed).toBe(a.length);
    expect(first.frame.streamId).toBe(1);

    const second = decodeFrame(concat.subarray(first.consumed));
    expect(second.kind).toBe("ok");
    if (second.kind !== "ok") return;
    expect(second.frame.streamId).toBe(2);
  });
});

describe("drain-v1", () => {
  it("decodes DRAIN_NOTICE only when the capability was negotiated", async () => {
    const { decodeFrame, drainNoticeFrame, encodeFrame, FRAME_DRAIN_NOTICE } = await import("../src/frames.js");
    const bytes = encodeFrame(drainNoticeFrame(15_000));
    expect(decodeFrame(bytes)).toEqual({ kind: "error", reason: "unknown frame type 0x5" });
    const r = decodeFrame(bytes, { drainNotice: true });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.frame.type).toBe(FRAME_DRAIN_NOTICE);
  });

  it("parses the grace, clamps it and refuses non-objects", async () => {
    const { parseDrainNotice, MAX_DRAIN_GRACE_MS } = await import("../src/frames.js");
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(parseDrainNotice(enc('{"graceMs":2500}'))).toBe(2500);
    expect(parseDrainNotice(enc('{"graceMs":-4}'))).toBe(0);
    expect(parseDrainNotice(enc('{"graceMs":1e12}'))).toBe(MAX_DRAIN_GRACE_MS);
    for (const bad of ["null", "[]", "7", '"x"', '{"graceMs":"9"}', "{", ""]) {
      expect(parseDrainNotice(enc(bad))).toBeNull();
    }
  });
});

describe("mesh-v1", () => {
  it("decodes ATTACHMENT and MOVE_HINT only when mesh-v1 was negotiated", async () => {
    const f = await import("../src/frames.js");
    const att = f.encodeFrame(f.attachmentFrame({ attachment: { relayId: "iad1" }, signature: "ab".repeat(64) }));
    const hint = f.encodeFrame(f.moveHintFrame({ hint: { toRelayId: "ams1" }, signature: "ab".repeat(64), target: {} }));
    expect(decodeFrame(att)).toEqual({ kind: "error", reason: "unknown frame type 0x7" });
    expect(decodeFrame(hint)).toEqual({ kind: "error", reason: "unknown frame type 0x8" });
    expect(decodeFrame(att, { drainNotice: true }).kind).toBe("error");
    for (const [bytes, type] of [[att, f.FRAME_ATTACHMENT], [hint, f.FRAME_MOVE_HINT]] as const) {
      const r = decodeFrame(bytes, { mesh: true });
      expect(r.kind).toBe("ok");
      if (r.kind === "ok") expect([r.frame.type, r.frame.streamId]).toEqual([type, 0]);
    }
    expect(decodeFrame(f.encodeFrame(f.drainNoticeFrame(1)), { mesh: true }).kind).toBe("error");
    expect(f.CAPABILITY_MESH_V1).toBe("mesh-v1");
  });

  it("round-trips the payloads and refuses malformed ones", async () => {
    const f = await import("../src/frames.js");
    const sig = "cd".repeat(64);
    const payloadOf = (fr: { payload: Uint8Array }) => fr.payload;
    expect(f.parseAttachmentFrame(payloadOf(f.attachmentFrame({ attachment: { a: 1 }, signature: sig })))).toEqual({ attachment: { a: 1 }, signature: sig });
    for (const p of [{ ok: true } as const, { ok: false, code: "clock" } as const, { ok: false, code: "mismatch" } as const]) {
      expect(f.parseAttachmentResult(payloadOf(f.attachmentResultFrame(p)))).toEqual(p);
    }
    expect(f.parseMoveHintFrame(payloadOf(f.moveHintFrame({ hint: { h: 1 }, signature: sig, target: { t: 1 } })))).toEqual({ hint: { h: 1 }, signature: sig, target: { t: 1 } });
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(f.parseAttachmentFrame(enc(JSON.stringify({ attachment: [], signature: sig })))).toBeNull();
    expect(f.parseAttachmentResult(enc('{"ok":false,"code":"nope"}'))).toBeNull();
    expect(f.parseMoveHintFrame(enc(JSON.stringify({ hint: {}, signature: "x", target: {} })))).toBeNull();
    const ack = f.parseHelloAck(f.helloAckFrame(true, undefined, { relayId: "iad1", relayBlessing: { kind: "RelayBlessing" } }, [f.CAPABILITY_MESH_V1]).payload);
    expect(ack).toEqual({ ok: true, capabilities: ["mesh-v1"], relayId: "iad1", relayBlessing: { kind: "RelayBlessing" } });
  });

  it("agrees with the shared frame vectors' mesh section", async () => {
    const f = await import("../src/frames.js");
    const { readFileSync } = await import("node:fs");
    const v = JSON.parse(readFileSync(new URL("../test-vectors/frames.json", import.meta.url), "utf8")).mesh;
    const unhex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
    const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
    expect(v.capability).toBe(f.CAPABILITY_MESH_V1);
    expect(v.types).toEqual({ FRAME_ATTACHMENT: f.FRAME_ATTACHMENT, FRAME_MOVE_HINT: f.FRAME_MOVE_HINT });
    for (const e of v.encoded) expect(hex(f.encodeFrame({ streamId: e.streamId, type: e.type, payload: unhex(e.payloadHex) }))).toBe(e.hex);
    const shape = (r: ReturnType<typeof decodeFrame>) =>
      r.kind === "ok" ? { kind: "ok", streamId: r.frame.streamId, type: r.frame.type, payloadHex: hex(r.frame.payload), consumed: r.consumed } : r;
    for (const c of v.decodeV1) expect(shape(decodeFrame(unhex(c.hex))), c.name).toEqual(c.result);
    for (const c of v.decodeMesh) expect(shape(decodeFrame(unhex(c.hex), { mesh: true })), c.name).toEqual(c.result);
    const parsers: Record<string, (p: Uint8Array) => unknown> = { attachment: f.parseAttachmentFrame, attachmentResult: f.parseAttachmentResult, moveHint: f.parseMoveHintFrame, helloAck: f.parseHelloAck };
    for (const [k, cases] of Object.entries(v.parsers as Record<string, Array<{ name: string; payloadHex: string; result: unknown }>>)) {
      for (const c of cases) expect(parsers[k]!(unhex(c.payloadHex)) ?? null, `${k}/${c.name}`).toEqual(c.result);
    }
  });
});
