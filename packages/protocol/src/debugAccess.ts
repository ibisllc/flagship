/**
 * Owner debug access (docs/recipe-delivery-and-remote-install.md "Debug
 * access"): an SSH key the box lets in as its `debug` user until a set time.
 *
 *   flagship/debug-access/v2|<serverDomain>|<sshPublicKey>|<issuedAt>|<expiresAt>
 *   flagship/debug-access-revoke/v1|<serverDomain>|<issuedAt>
 *
 * Both are sensitive orders: an admin-pinned box takes them only under the
 * account's admin root (the IRK only where no admin root is pinned), so a
 * co-manager or a non-admin device can never produce one. `sshPublicKey` is
 * the key in its normalized `<type> <base64>` form (no comment); the box
 * installs exactly that key, key auth only, until `expiresAt` (at most 7 days
 * after `issuedAt`). A newer grant renews; a revoke turns it off at once.
 */
import { sha256 } from "@noble/hashes/sha256";
import { ed } from "./edSync.js";
import { legacyFieldGuard } from "./canonicalBase.js";
import { base64UrlDecode, base64UrlEncode } from "./builderPairing.js";
import type { Bytes, Keypair } from "./types.js";

export const TAG_DEBUG_ACCESS = "flagship/debug-access/v2";
export const TAG_DEBUG_ACCESS_REVOKE = "flagship/debug-access-revoke/v1";

export const DEBUG_ACCESS_HOUR_MS = 60 * 60 * 1000;
export const DEBUG_ACCESS_DEFAULT_MS = 24 * DEBUG_ACCESS_HOUR_MS;
export const DEBUG_ACCESS_MAX_MS = 7 * 24 * DEBUG_ACCESS_HOUR_MS;

export interface DebugAccessGrant {
  /** The box this grant opens (its FQDN). */
  serverDomain: string;
  /** Normalized OpenSSH public key, `<type> <base64>`. */
  sshPublicKey: string;
  /** Unix ms. */
  issuedAt: number;
  /** Unix ms; the key stops working then. */
  expiresAt: number;
}

export interface DebugAccessRevoke {
  serverDomain: string;
  /** Unix ms. */
  issuedAt: number;
}

/** Key types the box installs. */
export const SSH_KEY_TYPES: readonly string[] = [
  "ssh-ed25519",
  "sk-ssh-ed25519@openssh.com",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ecdsa-sha2-nistp256@openssh.com",
  "ssh-rsa",
];

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

function b64decode(s: string): Uint8Array | null {
  if (!B64.test(s) || s.length % 4 !== 0) return null;
  return base64UrlDecode(s.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"));
}

function b64encodeNoPad(b: Uint8Array): string {
  return base64UrlEncode(b).replace(/-/g, "+").replace(/_/g, "/");
}

/**
 * Normalize a pasted OpenSSH public key line to `<type> <base64>`, or null
 * when it isn't one (the blob must decode and name the same type inside).
 * Options before the type and the trailing comment are dropped.
 */
export function normalizeSshPublicKey(input: string): string | null {
  if (typeof input !== "string") return null;
  const parts = input.trim().split(/\s+/);
  const at = parts.findIndex((p) => SSH_KEY_TYPES.includes(p));
  if (at < 0 || at + 1 >= parts.length) return null;
  const type = parts[at]!;
  const body = parts[at + 1]!;
  const blob = b64decode(body);
  if (!blob || blob.length < 4 + type.length || blob.length > 4096) return null;
  const n = ((blob[0]! << 24) | (blob[1]! << 16) | (blob[2]! << 8) | blob[3]!) >>> 0;
  if (n !== type.length) return null;
  const inner = new TextDecoder().decode(blob.subarray(4, 4 + n));
  if (inner !== type) return null;
  return `${type} ${body}`;
}

/** OpenSSH's `SHA256:<base64 without padding>` fingerprint of a key, or null. */
export function sshKeyFingerprint(key: string): string | null {
  const norm = normalizeSshPublicKey(key);
  if (!norm) return null;
  const blob = b64decode(norm.split(" ")[1]!)!;
  return `SHA256:${b64encodeNoPad(sha256(blob))}`;
}

/**
 * The reason a grant can't be signed or taken, as a sentence for the owner,
 * or null when its shape is fine. Time against the box clock is checked by
 * the box, not here.
 */
export function debugAccessGrantProblem(g: DebugAccessGrant): string | null {
  if (!g || typeof g.serverDomain !== "string" || g.serverDomain.length === 0) {
    return "The debug access grant doesn't name a server.";
  }
  if (typeof g.sshPublicKey !== "string" || g.sshPublicKey.trim().length === 0) {
    return "Debug access needs an SSH public key.";
  }
  if (normalizeSshPublicKey(g.sshPublicKey) !== g.sshPublicKey) {
    return "That isn't an SSH public key this server can use.";
  }
  if (!Number.isSafeInteger(g.issuedAt) || !Number.isSafeInteger(g.expiresAt) || g.issuedAt <= 0) {
    return "The debug access grant has no valid time.";
  }
  if (g.expiresAt <= g.issuedAt) return "Debug access has to end after it starts.";
  if (g.expiresAt - g.issuedAt > DEBUG_ACCESS_MAX_MS) return "Debug access can be on for at most 7 days at a time.";
  return null;
}

export function canonicalDebugAccessGrant(g: DebugAccessGrant): Bytes {
  legacyFieldGuard("serverDomain", g.serverDomain);
  legacyFieldGuard("sshPublicKey", g.sshPublicKey);
  if (!Number.isSafeInteger(g.issuedAt) || !Number.isSafeInteger(g.expiresAt)) {
    throw new Error("debug access times must be integers");
  }
  return new TextEncoder().encode(
    [TAG_DEBUG_ACCESS, g.serverDomain, g.sshPublicKey, String(g.issuedAt), String(g.expiresAt)].join("|"),
  );
}

/** Sign with the sensitive-order key (admin root, or the IRK on an unpinned box). */
export function signDebugAccessGrant(g: DebugAccessGrant, key: Keypair): Bytes {
  const problem = debugAccessGrantProblem(g);
  if (problem) throw new Error(problem);
  return ed.sign(canonicalDebugAccessGrant(g), key.privateKey);
}

/** Never throws. A grant with a bad shape never verifies. */
export function verifyDebugAccessGrant(g: DebugAccessGrant, sig: Bytes, pub: Bytes): boolean {
  try {
    if (debugAccessGrantProblem(g)) return false;
    return ed.verify(sig, canonicalDebugAccessGrant(g), pub);
  } catch {
    return false;
  }
}

export function canonicalDebugAccessRevoke(r: DebugAccessRevoke): Bytes {
  legacyFieldGuard("serverDomain", r.serverDomain);
  if (!Number.isSafeInteger(r.issuedAt)) throw new Error("issuedAt must be an integer");
  return new TextEncoder().encode([TAG_DEBUG_ACCESS_REVOKE, r.serverDomain, String(r.issuedAt)].join("|"));
}

export function signDebugAccessRevoke(r: DebugAccessRevoke, key: Keypair): Bytes {
  return ed.sign(canonicalDebugAccessRevoke(r), key.privateKey);
}

export function verifyDebugAccessRevoke(r: DebugAccessRevoke, sig: Bytes, pub: Bytes): boolean {
  try {
    if (!r || typeof r.serverDomain !== "string" || r.serverDomain.length === 0) return false;
    return ed.verify(sig, canonicalDebugAccessRevoke(r), pub);
  } catch {
    return false;
  }
}

/** Read a `{serverDomain, sshPublicKey, issuedAt, expiresAt}` object; null on any other shape. */
export function parseDebugAccessGrant(raw: unknown): DebugAccessGrant | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;
  if (
    typeof g.serverDomain !== "string" ||
    typeof g.sshPublicKey !== "string" ||
    typeof g.issuedAt !== "number" ||
    typeof g.expiresAt !== "number"
  ) {
    return null;
  }
  return { serverDomain: g.serverDomain, sshPublicKey: g.sshPublicKey, issuedAt: g.issuedAt, expiresAt: g.expiresAt };
}

export function parseDebugAccessRevoke(raw: unknown): DebugAccessRevoke | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.serverDomain !== "string" || typeof r.issuedAt !== "number") return null;
  return { serverDomain: r.serverDomain, issuedAt: r.issuedAt };
}
