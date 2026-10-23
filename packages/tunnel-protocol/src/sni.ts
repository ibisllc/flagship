/**
 * Parse the SNI hostname out of a TLS ClientHello buffer.
 *
 * Handles bounds checking everywhere; never reads past `buf.length`. A ClientHello may be
 * split across several handshake records (RFC 8446 §5.1); this reassembles it within
 * `limits`. On a hello that fits one record the result is what the single-record parser
 * always returned.
 *
 * Returns:
 *   { kind: "ok", sni: string | null }   — sni is null if the client sent no SNI extension
 *   { kind: "incomplete", needAtLeast }  — buffer at least this many bytes, then retry
 *   { kind: "error", reason }            — not a ClientHello, or one past the limits
 */
export type SniParseResult =
  | { kind: "ok"; sni: string | null }
  | { kind: "incomplete"; needAtLeast: number }
  | { kind: "error"; reason: string };

export interface SniLimits {
  /** Raw bytes, record headers included, the whole hello must arrive within. */
  maxRawBytes: number;
  /** Largest ClientHello body (the handshake message's own length field). */
  maxHelloBytes: number;
  /** Most TLS records the hello may span. */
  maxRecords: number;
}

/**
 * A post-quantum hello is about 1.5 KB; padded or extension-heavy ones stay well under 20 KB.
 * 32 KiB raw leaves room for two full 16 KiB records, and 512 records lets a hello arrive in
 * 32-byte records without letting a one-byte-record sender cost much.
 */
export const DEFAULT_SNI_LIMITS: SniLimits = {
  maxRawBytes: 32 * 1024,
  maxHelloBytes: 24 * 1024,
  maxRecords: 512,
};

const TLS_RECORD_HANDSHAKE = 0x16;
const TLS_HANDSHAKE_CLIENT_HELLO = 0x01;
const EXT_SERVER_NAME = 0x0000;
const NAME_TYPE_HOST = 0x00;

const TLS_RECORD_HEADER = 5; // type(1) + version(2) + length(2)
const HANDSHAKE_HEADER = 4;  // msg_type(1) + length(3)
/** RFC 8446 caps a record at 2^14 + 256 bytes. */
const MAX_RECORD_LEN = 16_640;

export function parseClientHelloSni(
  buf: Uint8Array,
  limits: SniLimits = DEFAULT_SNI_LIMITS,
): SniParseResult {
  const fragments: Uint8Array[] = [];
  let have = 0;
  let pos = 0;
  let records = 0;
  let helloLen = -1;
  for (;;) {
    const recordStart = pos + TLS_RECORD_HEADER;
    if (buf.length < recordStart) return need(recordStart, limits);
    if (buf[pos] !== TLS_RECORD_HANDSHAKE) {
      return { kind: "error", reason: "not a TLS handshake record" };
    }
    // skip version (buf[pos+1..pos+3])
    const recordLen = (buf[pos + 3]! << 8) | buf[pos + 4]!;
    if (recordLen === 0) {
      return {
        kind: "error",
        reason: records === 0 ? "record too small for handshake header" : "empty handshake record",
      };
    }
    if (recordLen > MAX_RECORD_LEN) {
      return { kind: "error", reason: "record length exceeds TLS maximum" };
    }
    const recordEnd = recordStart + recordLen;
    if (buf.length < recordEnd) return need(recordEnd, limits);
    if (records >= limits.maxRecords) {
      return { kind: "error", reason: "ClientHello spans too many records" };
    }
    records += 1;
    fragments.push(buf.subarray(recordStart, recordEnd));
    have += recordLen;
    pos = recordEnd;

    const first = fragments[0]!;
    if (first[0] !== TLS_HANDSHAKE_CLIENT_HELLO) {
      return { kind: "error", reason: "handshake is not ClientHello" };
    }
    if (helloLen < 0 && have >= HANDSHAKE_HEADER) {
      const head = joinPrefix(fragments, HANDSHAKE_HEADER);
      helloLen = (head[1]! << 16) | (head[2]! << 8) | head[3]!;
      if (helloLen > limits.maxHelloBytes) {
        return { kind: "error", reason: "ClientHello exceeds the size limit" };
      }
    }
    if (helloLen >= 0 && have >= HANDSHAKE_HEADER + helloLen) {
      const message = fragments.length === 1 ? first : joinPrefix(fragments, HANDSHAKE_HEADER + helloLen);
      return parseClientHelloBody(message.subarray(HANDSHAKE_HEADER, HANDSHAKE_HEADER + helloLen));
    }
    if (helloLen >= 0) {
      // The rest needs at least one more record header on top of its own bytes.
      const missing = HANDSHAKE_HEADER + helloLen - have;
      if (pos + TLS_RECORD_HEADER + missing > limits.maxRawBytes) {
        return { kind: "error", reason: "ClientHello exceeds the peek limit" };
      }
    }
  }
}

function need(n: number, limits: SniLimits): SniParseResult {
  if (n > limits.maxRawBytes) return { kind: "error", reason: "ClientHello exceeds the peek limit" };
  return { kind: "incomplete", needAtLeast: n };
}

function joinPrefix(parts: Uint8Array[], n: number): Uint8Array {
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    if (off >= n) break;
    const take = Math.min(p.length, n - off);
    out.set(p.subarray(0, take), off);
    off += take;
  }
  return out;
}

/** Walk a ClientHello body (after the 4-byte handshake header). */
function parseClientHelloBody(buf: Uint8Array): SniParseResult {
  const handshakeEnd = buf.length;
  if (handshakeEnd < 34) return { kind: "error", reason: "ClientHello too short" };
  let p = 0;
  p += 2; // client_version
  p += 32; // random

  // session_id (1-byte length)
  if (p >= handshakeEnd) return { kind: "error", reason: "truncated at session_id" };
  const sessionLen = buf[p]!;
  p += 1 + sessionLen;
  if (p > handshakeEnd) return { kind: "error", reason: "session_id overruns handshake" };

  // cipher_suites (2-byte length)
  if (p + 2 > handshakeEnd) return { kind: "error", reason: "truncated at cipher_suites" };
  const cipherLen = (buf[p]! << 8) | buf[p + 1]!;
  p += 2 + cipherLen;
  if (p > handshakeEnd) return { kind: "error", reason: "cipher_suites overruns handshake" };

  // compression_methods (1-byte length)
  if (p + 1 > handshakeEnd) return { kind: "error", reason: "truncated at compression_methods" };
  const compLen = buf[p]!;
  p += 1 + compLen;
  if (p > handshakeEnd) return { kind: "error", reason: "compression_methods overruns handshake" };

  // No extensions block at all is legal in pre-TLS-1.2 hellos and means "no SNI."
  if (p === handshakeEnd) return { kind: "ok", sni: null };

  // extensions (2-byte length)
  if (p + 2 > handshakeEnd) return { kind: "error", reason: "truncated at extensions length" };
  const extsLen = (buf[p]! << 8) | buf[p + 1]!;
  p += 2;
  const extsEnd = p + extsLen;
  if (extsEnd > handshakeEnd) return { kind: "error", reason: "extensions overrun handshake" };

  while (p + 4 <= extsEnd) {
    const extType = (buf[p]! << 8) | buf[p + 1]!;
    const extLen = (buf[p + 2]! << 8) | buf[p + 3]!;
    p += 4;
    if (p + extLen > extsEnd) {
      return { kind: "error", reason: "extension length overruns extensions block" };
    }
    if (extType === EXT_SERVER_NAME) {
      return parseServerNameExtension(buf, p, p + extLen);
    }
    p += extLen;
  }
  // No SNI extension found.
  return { kind: "ok", sni: null };
}

function parseServerNameExtension(buf: Uint8Array, start: number, end: number): SniParseResult {
  let p = start;
  if (p + 2 > end) return { kind: "error", reason: "SNI extension too short for list length" };
  const listLen = (buf[p]! << 8) | buf[p + 1]!;
  p += 2;
  if (p + listLen > end) {
    return { kind: "error", reason: "SNI list length exceeds extension" };
  }
  const listEnd = p + listLen;
  while (p + 3 <= listEnd) {
    const nameType = buf[p]!;
    const nameLen = (buf[p + 1]! << 8) | buf[p + 2]!;
    p += 3;
    if (p + nameLen > listEnd) {
      return { kind: "error", reason: "SNI name length exceeds list" };
    }
    if (nameType === NAME_TYPE_HOST) {
      const slice = buf.subarray(p, p + nameLen);
      // Hostname must be ASCII per RFC 6066. Reject non-ASCII to avoid spoofing.
      for (let i = 0; i < slice.length; i++) {
        const b = slice[i]!;
        if (b < 0x20 || b > 0x7e) {
          return { kind: "error", reason: "SNI hostname contains non-printable bytes" };
        }
      }
      const sni = new TextDecoder("ascii").decode(slice);
      // Lowercase per DNS conventions; reject empty.
      if (sni.length === 0) return { kind: "error", reason: "SNI hostname is empty" };
      return { kind: "ok", sni: sni.toLowerCase() };
    }
    p += nameLen;
  }
  return { kind: "error", reason: "SNI extension had no host_name entry" };
}
