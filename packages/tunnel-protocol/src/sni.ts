/**
 * Parse the SNI hostname out of a TLS ClientHello buffer.
 *
 * Handles bounds checking everywhere; never reads past `buf.length`.
 *
 * Returns:
 *   { kind: "ok", sni: string | null }   — sni is null if the client sent no SNI extension
 *   { kind: "incomplete", needAtLeast }  — caller should buffer more bytes and retry
 *   { kind: "error", reason }            — buffer is not a TLS ClientHello
 */
export type SniParseResult =
  | { kind: "ok"; sni: string | null }
  | { kind: "incomplete"; needAtLeast: number }
  | { kind: "error"; reason: string };

const TLS_RECORD_HANDSHAKE = 0x16;
const TLS_HANDSHAKE_CLIENT_HELLO = 0x01;
const EXT_SERVER_NAME = 0x0000;
const NAME_TYPE_HOST = 0x00;

const TLS_RECORD_HEADER = 5; // type(1) + version(2) + length(2)
const HANDSHAKE_HEADER = 4;  // msg_type(1) + length(3)

export function parseClientHelloSni(buf: Uint8Array): SniParseResult {
  // TLS record layer
  if (buf.length < TLS_RECORD_HEADER) {
    return { kind: "incomplete", needAtLeast: TLS_RECORD_HEADER };
  }
  if (buf[0] !== TLS_RECORD_HANDSHAKE) {
    return { kind: "error", reason: "not a TLS handshake record" };
  }
  // skip version (buf[1..3])
  const recordLen = (buf[3]! << 8) | buf[4]!;
  if (recordLen < HANDSHAKE_HEADER) {
    return { kind: "error", reason: "record too small for handshake header" };
  }
  if (recordLen > 16_640) {
    // RFC 8446 caps record length at 2^14 + 256 for TLS 1.3.
    return { kind: "error", reason: "record length exceeds TLS maximum" };
  }
  const recordEnd = TLS_RECORD_HEADER + recordLen;
  if (buf.length < recordEnd) {
    return { kind: "incomplete", needAtLeast: recordEnd };
  }

  // Handshake message
  let p = TLS_RECORD_HEADER;
  if (buf[p] !== TLS_HANDSHAKE_CLIENT_HELLO) {
    return { kind: "error", reason: "handshake is not ClientHello" };
  }
  const handshakeLen = (buf[p + 1]! << 16) | (buf[p + 2]! << 8) | buf[p + 3]!;
  p += HANDSHAKE_HEADER;
  const handshakeEnd = p + handshakeLen;
  if (handshakeEnd > recordEnd) {
    return { kind: "error", reason: "handshake length exceeds record" };
  }

  // ClientHello body
  if (handshakeLen < 34) return { kind: "error", reason: "ClientHello too short" };
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
