import {
  signInstallBlob,
  verifyInstallBlob,
  type InstallBlob,
} from "@flagship/protocol";
import type { Bytes, Keypair } from "@flagship/protocol";

export const MAGIC_HEADER = new TextEncoder().encode("FLAGSHIP-BOOT\0\0\0");
export const MAGIC_FOOTER = new TextEncoder().encode("\0\0\0FLAGSHIP-END\0");
export const FORMAT_VERSION = 0x01;

export const HEADER_LEN = MAGIC_HEADER.length;
export const FOOTER_LEN = MAGIC_FOOTER.length;
export const VERSION_LEN = 1;
export const JSON_LEN_FIELD = 4;
export const SIG_LEN = 64;
export const TOTAL_SIZE_FIELD = 4;

export const FIXED_OVERHEAD =
  HEADER_LEN + VERSION_LEN + JSON_LEN_FIELD + SIG_LEN + FOOTER_LEN + TOTAL_SIZE_FIELD;

export const MAX_TRAILER_BYTES = 65_536;

export interface BuiltTrailer {
  bytes: Uint8Array;
  size: number;
}

export interface ParsedTrailer {
  blob: InstallBlob;
  signature: Uint8Array;
  signerPubKey: Uint8Array;
  signatureValid: boolean;
}

const u32le = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  const v = new DataView(b.buffer);
  v.setUint32(0, n, true);
  return b;
};

const readU32le = (b: Uint8Array, off: number): number =>
  new DataView(b.buffer, b.byteOffset + off, 4).getUint32(0, true);

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

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

export function buildTrailer(blob: InstallBlob, signer: Keypair): BuiltTrailer {
  const json = new TextEncoder().encode(JSON.stringify(installBlobToJson(blob)));
  const signature = signInstallBlob(blob, signer);
  if (signature.length !== SIG_LEN) {
    throw new Error(`bug: expected ${SIG_LEN}-byte Ed25519 signature, got ${signature.length}`);
  }
  const totalSize =
    HEADER_LEN + VERSION_LEN + JSON_LEN_FIELD + json.length + SIG_LEN + FOOTER_LEN + TOTAL_SIZE_FIELD;
  if (totalSize > MAX_TRAILER_BYTES) {
    throw new Error(`trailer too large: ${totalSize} > ${MAX_TRAILER_BYTES}`);
  }
  const bytes = concat([
    MAGIC_HEADER,
    Uint8Array.of(FORMAT_VERSION),
    u32le(json.length),
    json,
    signature,
    MAGIC_FOOTER,
    u32le(totalSize),
  ]);
  return { bytes, size: totalSize };
}

export function parseTrailer(image: Uint8Array): ParsedTrailer | null {
  if (image.length < FIXED_OVERHEAD + 1) return null;
  const totalSize = readU32le(image, image.length - TOTAL_SIZE_FIELD);
  if (
    totalSize < FIXED_OVERHEAD ||
    totalSize > MAX_TRAILER_BYTES ||
    totalSize > image.length
  ) {
    return null;
  }
  const start = image.length - totalSize;
  const header = image.subarray(start, start + HEADER_LEN);
  if (!eq(header, MAGIC_HEADER)) return null;
  let off = start + HEADER_LEN;
  const version = image[off];
  if (version !== FORMAT_VERSION) return null;
  off += VERSION_LEN;
  const jsonLen = readU32le(image, off);
  off += JSON_LEN_FIELD;
  if (jsonLen > totalSize - FIXED_OVERHEAD) return null;
  const jsonBytes = image.subarray(off, off + jsonLen);
  off += jsonLen;
  const signature = image.subarray(off, off + SIG_LEN);
  off += SIG_LEN;
  const footer = image.subarray(off, off + FOOTER_LEN);
  if (!eq(footer, MAGIC_FOOTER)) return null;

  let blob: InstallBlob;
  try {
    blob = installBlobFromJson(JSON.parse(new TextDecoder().decode(jsonBytes)));
  } catch {
    return null;
  }
  const sigBytes = new Uint8Array(signature);
  const signerPubKey = blob.authCode.userPubKey;
  const signatureValid = verifyInstallBlob(blob, sigBytes, signerPubKey);
  return { blob, signature: sigBytes, signerPubKey, signatureValid };
}

interface InstallBlobJson {
  /** v2: blob.issuedAt + blob.expiresAt dropped. authCode.expiresAt is the sole TTL. */
  version: 2;
  serverDomain: string;
  username: string;
  serverName: string;
  phoneDelegatedPubKey: string;
  registrationUrl: string;
  authCode: {
    version: 1;
    serial: string;
    username: string;
    serverName: string;
    serverDomain: string;
    delegatedPubKey: string;
    userPubKey: string;
    issuedAt: number;
    expiresAt: number;
  };
  authCodeUserSignature: string;
  installerGitRef: string;
  rckPubKey: string;
  /** Optional signed fields — MUST be carried through the round-trip or the
   *  reconstructed blob's canonical bytes won't match the signature. */
  bootUnlockMode?: "auto" | "approve";
}

function bytesToHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
function hexToBytes(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error(`odd-length hex: ${s.length}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function installBlobToJson(b: InstallBlob): InstallBlobJson {
  return {
    version: b.version,
    serverDomain: b.serverDomain,
    username: b.username,
    serverName: b.serverName,
    phoneDelegatedPubKey: bytesToHex(b.phoneDelegatedPubKey),
    registrationUrl: b.registrationUrl,
    authCode: {
      version: b.authCode.version,
      serial: b.authCode.serial,
      username: b.authCode.username,
      serverName: b.authCode.serverName,
      serverDomain: b.authCode.serverDomain,
      delegatedPubKey: bytesToHex(b.authCode.delegatedPubKey),
      userPubKey: bytesToHex(b.authCode.userPubKey),
      issuedAt: b.authCode.issuedAt,
      expiresAt: b.authCode.expiresAt,
    },
    authCodeUserSignature: bytesToHex(b.authCodeUserSignature),
    installerGitRef: b.installerGitRef,
    rckPubKey: bytesToHex(b.rckPubKey),
    ...(b.bootUnlockMode !== undefined ? { bootUnlockMode: b.bootUnlockMode } : {}),
  };
}

export function installBlobFromJson(j: InstallBlobJson): InstallBlob {
  if (j.version !== 2) throw new Error("unsupported InstallBlob version");
  if (j.authCode.version !== 1) throw new Error("unsupported AuthCode version");
  return {
    version: 2,
    serverDomain: j.serverDomain,
    username: j.username,
    serverName: j.serverName,
    phoneDelegatedPubKey: hexToBytes(j.phoneDelegatedPubKey),
    registrationUrl: j.registrationUrl,
    authCode: {
      version: 1,
      serial: j.authCode.serial,
      username: j.authCode.username,
      serverName: j.authCode.serverName,
      serverDomain: j.authCode.serverDomain,
      delegatedPubKey: hexToBytes(j.authCode.delegatedPubKey),
      userPubKey: hexToBytes(j.authCode.userPubKey),
      issuedAt: j.authCode.issuedAt,
      expiresAt: j.authCode.expiresAt,
    },
    authCodeUserSignature: hexToBytes(j.authCodeUserSignature),
    installerGitRef: j.installerGitRef ?? "",
    rckPubKey: hexToBytes(j.rckPubKey),
    ...(j.bootUnlockMode !== undefined ? { bootUnlockMode: j.bootUnlockMode } : {}),
  };
}
