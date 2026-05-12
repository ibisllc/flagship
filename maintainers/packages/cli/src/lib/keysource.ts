/**
 * Key-source resolution.
 *
 * Two forms supported on the CLI surface:
 *   file:<path>            local hex-encoded key (pubkey or privkey)
 *   yubikey:slot=<piv>     Yubikey via PIV — STAGED, not yet implemented
 *
 * The CLI's role is server-side / CI signing where an Ed25519 key on disk
 * is the normal carrier. Yubikey via PIV (and ES256) is a future addition
 * that requires the protocol library to accept ES256 signatures alongside
 * Ed25519. For now we raise a clear error and direct users to `file:` keys.
 *
 * File contents:
 *   - Whitespace and a leading "0x" are tolerated.
 *   - 32 raw bytes  -> 64 hex chars  -> private key.
 *   - Ed25519 pubkeys are 32 raw bytes / 64 hex chars too. Disambiguation
 *     happens at the call site: callers ask for either a privKey or a pubKey
 *     and we return that part. (When loading a privKey we derive the pubKey
 *     and return both.)
 */

import * as fs from "node:fs";
import { pubKeyFromPriv } from "@maintainers/protocol";
import { CliError } from "./args.js";

export interface LoadedPubKey {
  kind: "pub";
  pubKey: string;
  source: string;
}

export interface LoadedPrivKey {
  kind: "priv";
  privKey: string;
  pubKey: string;
  source: string;
}

export type LoadedKey = LoadedPubKey | LoadedPrivKey;

export interface KeySourceFs {
  readFileSync(path: string): string;
}

export const realFs: KeySourceFs = {
  readFileSync(path: string): string {
    return fs.readFileSync(path, "utf8");
  },
};

function normalizeHex(raw: string): string {
  const trimmed = raw.trim();
  const stripped = trimmed.startsWith("0x") || trimmed.startsWith("0X")
    ? trimmed.slice(2)
    : trimmed;
  return stripped.toLowerCase();
}

function isHex64(s: string): boolean {
  if (s.length !== 64) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ok = (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66);
    if (!ok) return false;
  }
  return true;
}

/**
 * Resolve a key source string into a public key. Accepts file: pointers
 * that contain either a privkey or a pubkey (we derive the pubkey when given
 * a privkey).
 */
export function loadPubKey(source: string, io: KeySourceFs = realFs): LoadedPubKey {
  if (source.startsWith("yubikey:")) {
    // TODO: implement PIV-backed signing. ES256 will need protocol-side support.
    throw new CliError(
      `yubikey: key sources are not yet implemented; use file: keys for now (got "${source}")`,
    );
  }
  if (!source.startsWith("file:")) {
    throw new CliError(
      `key source must start with "file:" or "yubikey:" (got "${source}")`,
    );
  }
  const path = source.slice("file:".length);
  if (path.length === 0) throw new CliError("file: key source has empty path");
  let raw: string;
  try {
    raw = io.readFileSync(path);
  } catch (err) {
    throw new CliError(
      `failed to read key file "${path}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const hex = normalizeHex(raw);
  if (!isHex64(hex)) {
    throw new CliError(
      `key file "${path}" does not contain 64 hex characters of key material`,
    );
  }
  // The 32-byte hex could be either a privkey or a pubkey — we can't tell from
  // hex alone. We treat it as a pubkey when the caller wants a pubkey; when
  // the caller wants to sign with it, they call loadPrivKey instead and we
  // re-validate by deriving the corresponding pubkey.
  return { kind: "pub", pubKey: hex, source };
}

/**
 * Resolve a key source string into a private key. Yubikey is stubbed.
 */
export function loadPrivKey(source: string, io: KeySourceFs = realFs): LoadedPrivKey {
  if (source.startsWith("yubikey:")) {
    throw new CliError(
      `yubikey: signing is not yet implemented; provide an Ed25519 key via file: (got "${source}")`,
    );
  }
  if (!source.startsWith("file:")) {
    throw new CliError(
      `signing key source must start with "file:" (got "${source}")`,
    );
  }
  const path = source.slice("file:".length);
  if (path.length === 0) throw new CliError("file: signing key source has empty path");
  let raw: string;
  try {
    raw = io.readFileSync(path);
  } catch (err) {
    throw new CliError(
      `failed to read signing key file "${path}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const hex = normalizeHex(raw);
  if (!isHex64(hex)) {
    throw new CliError(
      `signing key file "${path}" does not contain 64 hex characters`,
    );
  }
  const pub = pubKeyFromPriv(hex);
  return { kind: "priv", privKey: hex, pubKey: pub, source };
}

export function loadPubKeyList(csv: string, io: KeySourceFs = realFs): LoadedPubKey[] {
  if (csv.length === 0) return [];
  const parts = csv.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.map((p) => loadPubKey(p, io));
}
