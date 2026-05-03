import { describe, expect, it } from "vitest";
import {
  decodeFrame,
  encodeFrame,
  FRAME_PB_PUT,
  FRAME_PB_PUT_ACK,
  FRAME_PB_GET_DATA,
} from "../src/frames.js";
import {
  pbPutFrame,
  pbPutAckFrame,
  pbGetFrame,
  pbGetDataFrame,
  pbGetEndFrame,
  pbChallengeFrame,
  pbResponseFrame,
  decodePbPut,
  decodePbPutAck,
  decodePbGet,
  decodePbGetEnd,
  decodePbChallenge,
  decodePbResponse,
  canonicalPbPut,
  canonicalPbResponse,
} from "../src/peerBackupFrames.js";

const ENC = "11".repeat(32);
const SIG = "22".repeat(64);
const NONCE = "33".repeat(32);
const HASH = "44".repeat(32);

describe("PB_* frames — wire roundtrip", () => {
  it("PB_PUT: encode → decodeFrame → decodePbPut", () => {
    const f = pbPutFrame(7, { encChunkId: ENC, shardIndex: 3, sizeBytes: 1024, signature: SIG });
    const buf = encodeFrame(f);
    const r = decodeFrame(buf);
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.frame.type).toBe(FRAME_PB_PUT);
    expect(r.frame.streamId).toBe(7);
    const p = decodePbPut(r.frame.payload);
    expect(p.encChunkId).toBe(ENC);
    expect(p.shardIndex).toBe(3);
    expect(p.sizeBytes).toBe(1024);
  });

  it("PB_PUT_ACK with reason", () => {
    const f = pbPutAckFrame(7, { encChunkId: ENC, shardIndex: 0, ok: false, reason: "no space" });
    const r = decodeFrame(encodeFrame(f));
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.frame.type).toBe(FRAME_PB_PUT_ACK);
    const p = decodePbPutAck(r.frame.payload);
    expect(p.ok).toBe(false);
    expect(p.reason).toBe("no space");
  });

  it("PB_GET / PB_GET_DATA / PB_GET_END sequence", () => {
    const get = pbGetFrame(8, { encChunkId: ENC, shardIndex: 1 });
    expect(decodePbGet(get.payload).shardIndex).toBe(1);

    const data = pbGetDataFrame(8, new Uint8Array([1, 2, 3, 4]));
    expect(data.type).toBe(FRAME_PB_GET_DATA);
    expect(Array.from(data.payload)).toEqual([1, 2, 3, 4]);

    const end = pbGetEndFrame(8, { encChunkId: ENC, shardIndex: 1, sha256: HASH });
    expect(decodePbGetEnd(end.payload).sha256).toBe(HASH);
  });

  it("PB_CHALLENGE rejects zero-length challenges (no point hashing nothing)", () => {
    const ok = pbChallengeFrame(9, {
      encChunkId: ENC,
      shardIndex: 0,
      nonce: NONCE,
      offset: 0,
      length: 1024,
    });
    expect(decodePbChallenge(ok.payload).length).toBe(1024);

    const zero = pbChallengeFrame(9, {
      encChunkId: ENC,
      shardIndex: 0,
      nonce: NONCE,
      offset: 0,
      length: 0,
    });
    expect(() => decodePbChallenge(zero.payload)).toThrow();
  });

  it("PB_RESPONSE roundtrip with signature validation", () => {
    const f = pbResponseFrame(9, {
      encChunkId: ENC,
      shardIndex: 0,
      hash: HASH,
      signature: SIG,
    });
    expect(decodePbResponse(f.payload).hash).toBe(HASH);
  });
});

describe("PB_* frames — malformed payload rejection", () => {
  it("PbPut rejects short hex / non-hex / negative ints", () => {
    expect(() =>
      decodePbPut(new TextEncoder().encode(JSON.stringify({
        encChunkId: "short",
        shardIndex: 0,
        sizeBytes: 0,
        signature: SIG,
      }))),
    ).toThrow();
    expect(() =>
      decodePbPut(new TextEncoder().encode(JSON.stringify({
        encChunkId: ENC,
        shardIndex: -1,
        sizeBytes: 0,
        signature: SIG,
      }))),
    ).toThrow();
  });

  it("PbResponse requires 64-byte (128-hex) signature", () => {
    expect(() =>
      decodePbResponse(new TextEncoder().encode(JSON.stringify({
        encChunkId: ENC,
        shardIndex: 0,
        hash: HASH,
        signature: "00",
      }))),
    ).toThrow();
  });
});

describe("canonical bytes (used for STK signatures)", () => {
  it("canonicalPbPut is deterministic", () => {
    const a = canonicalPbPut({ encChunkId: ENC, shardIndex: 0, sizeBytes: 1, peerServerId: "p" });
    const b = canonicalPbPut({ encChunkId: ENC, shardIndex: 0, sizeBytes: 1, peerServerId: "p" });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("canonicalPbResponse is deterministic", () => {
    const a = canonicalPbResponse({ encChunkId: ENC, shardIndex: 0, nonce: NONCE, hash: HASH });
    const b = canonicalPbResponse({ encChunkId: ENC, shardIndex: 0, nonce: NONCE, hash: HASH });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("changes when any field changes (no aliasing)", () => {
    const base = canonicalPbPut({ encChunkId: ENC, shardIndex: 0, sizeBytes: 1, peerServerId: "p" });
    const changed = canonicalPbPut({ encChunkId: ENC, shardIndex: 0, sizeBytes: 2, peerServerId: "p" });
    expect(Array.from(base)).not.toEqual(Array.from(changed));
  });
});
