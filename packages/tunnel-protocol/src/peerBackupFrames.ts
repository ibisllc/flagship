import {
  FRAME_PB_PUT,
  FRAME_PB_PUT_ACK,
  FRAME_PB_GET,
  FRAME_PB_GET_DATA,
  FRAME_PB_GET_END,
  FRAME_PB_CHALLENGE,
  FRAME_PB_RESPONSE,
  type Frame,
} from "./frames.js";

/**
 * Peer-backup payload shapes — JSON-encoded for everything except
 * GET_DATA, which is a raw shard-bytes blob (size-bounded by the frame
 * protocol's MAX_FRAME_PAYLOAD).
 *
 * All hex fields are lowercase, fixed-length (encChunkId = 64 hex chars
 * = 32 bytes; signature = 128 hex chars = 64 bytes; nonce = 64 hex chars).
 */

export interface PbPutPayload {
  encChunkId: string;
  shardIndex: number;
  sizeBytes: number;
  /** STK-signed by the requester over `pb-put|encChunkId|shardIndex|sizeBytes|peerServerId`. */
  signature: string;
}

export interface PbPutAckPayload {
  encChunkId: string;
  shardIndex: number;
  ok: boolean;
  reason?: string;
}

export interface PbGetPayload {
  encChunkId: string;
  shardIndex: number;
}

export interface PbGetEndPayload {
  encChunkId: string;
  shardIndex: number;
  /** SHA-256 of the full shard bytes the peer streamed (hex). */
  sha256: string;
}

export interface PbChallengePayload {
  encChunkId: string;
  shardIndex: number;
  /** 32-byte hex random nonce. */
  nonce: string;
  offset: number;
  length: number;
}

export interface PbResponsePayload {
  encChunkId: string;
  shardIndex: number;
  /** SHA-256 of (nonce || shard[offset..offset+length]) — hex. */
  hash: string;
  /** STK signature over the canonical bytes of the response. */
  signature: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

function encodeJson(payload: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

function decodeJson<T>(payload: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(payload)) as T;
}

function nonNeg(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

export function pbPutFrame(streamId: number, p: PbPutPayload): Frame {
  return { streamId, type: FRAME_PB_PUT, payload: encodeJson(p) };
}

export function decodePbPut(payload: Uint8Array): PbPutPayload {
  const o = decodeJson<Partial<PbPutPayload>>(payload);
  if (
    typeof o.encChunkId !== "string" ||
    !HEX64.test(o.encChunkId) ||
    typeof o.shardIndex !== "number" ||
    !nonNeg(o.shardIndex) ||
    typeof o.sizeBytes !== "number" ||
    !nonNeg(o.sizeBytes) ||
    typeof o.signature !== "string" ||
    !HEX128.test(o.signature)
  ) {
    throw new Error("PbPut payload malformed");
  }
  return o as PbPutPayload;
}

export function pbPutAckFrame(streamId: number, p: PbPutAckPayload): Frame {
  return { streamId, type: FRAME_PB_PUT_ACK, payload: encodeJson(p) };
}

export function decodePbPutAck(payload: Uint8Array): PbPutAckPayload {
  const o = decodeJson<Partial<PbPutAckPayload>>(payload);
  if (
    typeof o.encChunkId !== "string" ||
    !HEX64.test(o.encChunkId) ||
    typeof o.shardIndex !== "number" ||
    !nonNeg(o.shardIndex) ||
    typeof o.ok !== "boolean"
  ) {
    throw new Error("PbPutAck payload malformed");
  }
  return o as PbPutAckPayload;
}

export function pbGetFrame(streamId: number, p: PbGetPayload): Frame {
  return { streamId, type: FRAME_PB_GET, payload: encodeJson(p) };
}

export function decodePbGet(payload: Uint8Array): PbGetPayload {
  const o = decodeJson<Partial<PbGetPayload>>(payload);
  if (
    typeof o.encChunkId !== "string" ||
    !HEX64.test(o.encChunkId) ||
    typeof o.shardIndex !== "number" ||
    !nonNeg(o.shardIndex)
  ) {
    throw new Error("PbGet payload malformed");
  }
  return o as PbGetPayload;
}

export function pbGetDataFrame(streamId: number, data: Uint8Array): Frame {
  return { streamId, type: FRAME_PB_GET_DATA, payload: data };
}

export function pbGetEndFrame(streamId: number, p: PbGetEndPayload): Frame {
  return { streamId, type: FRAME_PB_GET_END, payload: encodeJson(p) };
}

export function decodePbGetEnd(payload: Uint8Array): PbGetEndPayload {
  const o = decodeJson<Partial<PbGetEndPayload>>(payload);
  if (
    typeof o.encChunkId !== "string" ||
    !HEX64.test(o.encChunkId) ||
    typeof o.shardIndex !== "number" ||
    !nonNeg(o.shardIndex) ||
    typeof o.sha256 !== "string" ||
    !HEX64.test(o.sha256)
  ) {
    throw new Error("PbGetEnd payload malformed");
  }
  return o as PbGetEndPayload;
}

export function pbChallengeFrame(streamId: number, p: PbChallengePayload): Frame {
  return { streamId, type: FRAME_PB_CHALLENGE, payload: encodeJson(p) };
}

export function decodePbChallenge(payload: Uint8Array): PbChallengePayload {
  const o = decodeJson<Partial<PbChallengePayload>>(payload);
  if (
    typeof o.encChunkId !== "string" ||
    !HEX64.test(o.encChunkId) ||
    typeof o.shardIndex !== "number" ||
    !nonNeg(o.shardIndex) ||
    typeof o.nonce !== "string" ||
    !HEX64.test(o.nonce) ||
    typeof o.offset !== "number" ||
    !nonNeg(o.offset) ||
    typeof o.length !== "number" ||
    !nonNeg(o.length) ||
    o.length === 0
  ) {
    throw new Error("PbChallenge payload malformed");
  }
  return o as PbChallengePayload;
}

export function pbResponseFrame(streamId: number, p: PbResponsePayload): Frame {
  return { streamId, type: FRAME_PB_RESPONSE, payload: encodeJson(p) };
}

export function decodePbResponse(payload: Uint8Array): PbResponsePayload {
  const o = decodeJson<Partial<PbResponsePayload>>(payload);
  if (
    typeof o.encChunkId !== "string" ||
    !HEX64.test(o.encChunkId) ||
    typeof o.shardIndex !== "number" ||
    !nonNeg(o.shardIndex) ||
    typeof o.hash !== "string" ||
    !HEX64.test(o.hash) ||
    typeof o.signature !== "string" ||
    !HEX128.test(o.signature)
  ) {
    throw new Error("PbResponse payload malformed");
  }
  return o as PbResponsePayload;
}

/**
 * Canonical bytes for the requester's STK signature over a PB_PUT request.
 * Both sides must compute these identically — bug here = silent data-loss.
 */
export function canonicalPbPut(args: {
  encChunkId: string;
  shardIndex: number;
  sizeBytes: number;
  peerServerId: string;
}): Uint8Array {
  return new TextEncoder().encode(
    `pb-put|${args.encChunkId}|${args.shardIndex}|${args.sizeBytes}|${args.peerServerId}`,
  );
}

/** Canonical bytes for a PB_RESPONSE signature (matches the design doc). */
export function canonicalPbResponse(args: {
  encChunkId: string;
  shardIndex: number;
  nonce: string;
  hash: string;
}): Uint8Array {
  return new TextEncoder().encode(
    `pb-resp|${args.encChunkId}|${args.shardIndex}|${args.nonce}|${args.hash}`,
  );
}
