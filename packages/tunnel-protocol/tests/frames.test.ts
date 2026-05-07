import { describe, expect, it } from "vitest";
import {
  closeFrame,
  dataFrame,
  decodeFrame,
  encodeFrame,
  FRAME_DATA,
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
