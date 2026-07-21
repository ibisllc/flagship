/**
 * Streaming personalize for Cloudflare Workers (W11).
 *
 * The whole-buffer `personalizeBytes` and the half-buffer
 * `personalizeStream` (which gets the trailer as a pre-built buffer)
 * already exist next to this file. This module adds a thin convenience
 * that builds the trailer for an ALREADY-SIGNED install blob + signature
 * and emits a ReadableStream<Uint8Array> the Worker can pipe straight
 * into `R2Bucket.put(stream)` — never landing the 240 MB ISO in V8 heap.
 *
 * Why "already signed": this module deliberately does not own identity or
 * signing authority; it only glues signed bytes into the trailer envelope.
 *
 * Wire format (byte-for-byte identical to `buildTrailer`):
 *
 *   MAGIC_HEADER || FORMAT_VERSION || u32le(jsonLen) || json ||
 *   signature(64) || MAGIC_FOOTER || u32le(totalSize)
 *
 * Drift here breaks `parseTrailer` on the daemon, so this module re-uses
 * the exported magic constants + the `installBlobToJson` serializer that
 * `buildTrailer` itself uses. A roundtrip test in
 * `tests/streamPersonalize.test.ts` pins this against the whole-buffer
 * API to catch any divergence.
 */

import type { InstallBlob } from "@flagship/protocol";
import { personalizeStream } from "./personalize.js";
import {
  MAGIC_HEADER,
  MAGIC_FOOTER,
  FORMAT_VERSION,
  HEADER_LEN,
  FOOTER_LEN,
  VERSION_LEN,
  JSON_LEN_FIELD,
  SIG_LEN,
  TOTAL_SIZE_FIELD,
  MAX_TRAILER_BYTES,
  installBlobToJson,
} from "./trailer.js";

export interface StreamPersonalizeInput {
  /** The base-ISO byte stream, sourced from `R2Bucket.get(key).body`. */
  baseIsoStream: ReadableStream<Uint8Array>;
  /** Total bytes of the base ISO — used to compute `totalBytes`. */
  baseIsoSize: number;
  /** Already-validated install envelope (returned by
   *  `handleAdminClaimAndIssue`). */
  blob: InstallBlob;
  /** 64-byte Ed25519 signature over the canonical-bytes of `blob`. */
  blobSignature: Uint8Array;
}

export interface StreamPersonalizeOutput {
  /** The personalized stream — base bytes verbatim then the trailer. */
  stream: ReadableStream<Uint8Array>;
  /** `baseIsoSize + trailer.size`. R2.put needs to know the length when
   *  no `Content-Length` header is on the upstream response. */
  totalBytes: number;
  /** Size of the (small) trailer envelope appended to the ISO. */
  trailerSize: number;
  /** Returned for callers that want to log / cache the trailer's bytes
   *  for a reproducible R2 key. Small (~1 KB) so this is cheap. */
  trailerBytes: Uint8Array;
}

const u32le = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Build ONLY the trailer envelope from an already-signed blob + signature —
 * no base-ISO stream involved. The trailer is small (~1 KB). Pulled out of
 * `streamPersonalize` so callers that stream the base ISO themselves (e.g. the
 * Worker, which streams the R2 body runtime-natively rather than through a JS
 * `pull` loop) can get just the bytes to append. Byte-for-byte identical to
 * the trailer `buildTrailer` produces.
 */
export function buildTrailerFromSignature(
  blob: InstallBlob,
  blobSignature: Uint8Array,
): Uint8Array {
  if (blobSignature.length !== SIG_LEN) {
    throw new Error(
      `buildTrailerFromSignature: expected ${SIG_LEN}-byte signature, got ${blobSignature.length}`,
    );
  }
  const json = new TextEncoder().encode(JSON.stringify(installBlobToJson(blob)));
  const totalSize =
    HEADER_LEN +
    VERSION_LEN +
    JSON_LEN_FIELD +
    json.length +
    SIG_LEN +
    FOOTER_LEN +
    TOTAL_SIZE_FIELD;
  if (totalSize > MAX_TRAILER_BYTES) {
    throw new Error(`trailer too large: ${totalSize} > ${MAX_TRAILER_BYTES}`);
  }
  return concat([
    MAGIC_HEADER,
    Uint8Array.of(FORMAT_VERSION),
    u32le(json.length),
    json,
    new Uint8Array(blobSignature),
    MAGIC_FOOTER,
    u32le(totalSize),
  ]);
}

/**
 * Glue the already-built trailer onto the base ISO stream. The trailer
 * is small (~1 KB) so we build it eagerly in RAM; only the 240 MB base
 * stream is forwarded chunk-by-chunk by `personalizeStream`.
 */
export function streamPersonalize(
  args: StreamPersonalizeInput,
): StreamPersonalizeOutput {
  const { baseIsoStream, baseIsoSize, blob, blobSignature } = args;
  const trailerBytes = buildTrailerFromSignature(blob, blobSignature);

  const stream = personalizeStream(baseIsoStream, trailerBytes);
  return {
    stream,
    totalBytes: baseIsoSize + trailerBytes.length,
    trailerSize: trailerBytes.length,
    trailerBytes,
  };
}
