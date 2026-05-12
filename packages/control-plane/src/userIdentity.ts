/**
 * User-identity mandate store (#71).
 *
 *   POST /api/user-identity
 *     Body: {
 *       usernameHash,             // SHA-256(saltedUsernameBytes), hex
 *       encryptedBlob_b64,        // opaque ciphertext from the user's
 *                                  // EncryptedBlobAdapter (maintainers/protocol)
 *       authorizedSigners[],       // user-published Ed25519 pubkey hex list
 *       blobVersion,              // monotonic counter
 *       signature_hex             // Ed25519 sig by ONE of the authorizedSigners
 *     }
 *     Verifies the signature against every entry in `authorizedSigners`
 *     until one matches. Stores via `putIfNewer` so a captured older
 *     payload cannot replay the blob backwards.
 *
 *   GET /api/user-identity/<usernameHash>
 *     Returns { encryptedBlob_b64, authorizedSigners, blobVersion,
 *               signature_hex, updatedAt }.
 *     No signature gate — the blob is opaque AES-GCM ciphertext; without
 *     the user's UMK-derived key it's noise. Disclosing it doesn't leak
 *     names, devices, friends, or app state.
 *
 * Why `.com` is allowed to see authorizedSigners but nothing else:
 * the Worker has to verify the PUT signature against the user's own
 * published key list, so that list must be plaintext. Everything inside
 * `encryptedBlob` — labels, device names, friend names, app entries —
 * stays sealed (see docs/policy/no-kyc.md).
 *
 * Username-hash derivation (consumers compute this client-side and post
 * the hex result):
 *
 *     usernameHashBytes = SHA-256(
 *       UTF-8("flagship/userIdHash/v1|" + username + "|" + salt)
 *     )
 *
 * The salt is the fixed string `"flagship.v1"` for now. We deliberately
 * picked a fixed salt over a per-user one: a per-user salt would have
 * to live alongside the row (so `.com` could find the row), which would
 * trivially expose either the salt or the username at lookup time. The
 * fixed salt costs us no anti-enumeration property `.com` doesn't
 * already concede via the usernames table — and it keeps the protocol
 * one-step for clients.
 */

import { ed } from "@flagship/protocol";
import type {
  UserIdentityRecord,
  UserIdentityRecordStorage,
} from "@flagship/storage";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "./hex.js";
import {
  conflict,
  forbidden,
  malformed,
  notFound,
  ok,
  type HandlerResponse,
} from "./types.js";

export interface UserIdentityDeps {
  storage: UserIdentityRecordStorage;
  now?: () => number;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const MAX_BLOB_BYTES = 256 * 1024;
const MAX_SIGNERS = 16;

interface PostBody {
  usernameHash?: unknown;
  encryptedBlob_b64?: unknown;
  authorizedSigners?: unknown;
  blobVersion?: unknown;
  signature_hex?: unknown;
}

const TAG = "flagship/user-identity-record/v1";

/**
 * Canonical bytes the user signs.
 *
 * Includes every field the Worker is going to persist — both the
 * encrypted blob bytes (so a captured sig can't be paired with a
 * different ciphertext) AND the authorizedSigners list (so a captured
 * sig can't be paired with a freshly-rotated list to mint a row with a
 * compromised key in it).
 */
function canonicalBytes(
  usernameHash: string,
  encryptedBlob: Uint8Array,
  authorizedSigners: string[],
  blobVersion: number,
): Uint8Array {
  const blobHash = bytesToHex(sha256(encryptedBlob));
  const signerList = [...authorizedSigners].sort().join(",");
  const s = [
    TAG,
    usernameHash,
    blobHash,
    signerList,
    blobVersion.toString(10),
  ].join("|");
  return new TextEncoder().encode(s);
}

export function userIdentityCanonicalBytes(
  usernameHash: string,
  encryptedBlob: Uint8Array,
  authorizedSigners: string[],
  blobVersion: number,
): Uint8Array {
  return canonicalBytes(usernameHash, encryptedBlob, authorizedSigners, blobVersion);
}

/**
 * Compute the username-hash exactly as documented in the module
 * header. Clients are free to recompute this themselves; we export it
 * so the in-repo tests (and the webapp's typed BFF surface) agree on
 * one canonical string.
 */
export function deriveUsernameHash(username: string, salt = "flagship.v1"): string {
  const bytes = new TextEncoder().encode(
    `flagship/userIdHash/v1|${username}|${salt}`,
  );
  return bytesToHex(sha256(bytes));
}

function base64ToBytes(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function bytesToBase64(b: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]!);
  return btoa(bin);
}

export async function handlePutUserIdentity(
  deps: UserIdentityDeps,
  body: PostBody | undefined,
): Promise<HandlerResponse> {
  const r = body ?? {};
  if (typeof r.usernameHash !== "string" || !HEX64.test(r.usernameHash)) {
    return malformed("usernameHash must be 32-byte hex");
  }
  if (typeof r.encryptedBlob_b64 !== "string" || r.encryptedBlob_b64.length === 0) {
    return malformed("encryptedBlob_b64 missing");
  }
  if (!Array.isArray(r.authorizedSigners) || r.authorizedSigners.length === 0) {
    return malformed("authorizedSigners must be a non-empty list");
  }
  if (r.authorizedSigners.length > MAX_SIGNERS) {
    return malformed(`authorizedSigners exceeds limit of ${MAX_SIGNERS}`);
  }
  for (const s of r.authorizedSigners) {
    if (typeof s !== "string" || !HEX64.test(s)) {
      return malformed("authorizedSigners entries must be 32-byte hex");
    }
  }
  if (typeof r.blobVersion !== "number" || !Number.isInteger(r.blobVersion) || r.blobVersion < 1) {
    return malformed("blobVersion must be a positive integer");
  }
  if (typeof r.signature_hex !== "string" || !HEX128.test(r.signature_hex)) {
    return malformed("signature_hex must be 64-byte hex");
  }

  const blob = base64ToBytes(r.encryptedBlob_b64);
  if (!blob) return malformed("encryptedBlob_b64 is not valid base64");
  if (blob.length === 0 || blob.length > MAX_BLOB_BYTES) {
    return malformed(`encryptedBlob must be 1..${MAX_BLOB_BYTES} bytes`);
  }

  const signers = r.authorizedSigners as string[];
  const canon = canonicalBytes(r.usernameHash, blob, signers, r.blobVersion);
  let sig: Uint8Array;
  try {
    sig = hexToBytes(r.signature_hex);
  } catch {
    return malformed("signature_hex hex decode failed");
  }

  let matched = false;
  for (const pubHex of signers) {
    let pub: Uint8Array;
    try {
      pub = hexToBytes(pubHex);
    } catch {
      continue;
    }
    try {
      if (ed.verify(sig, canon, pub)) {
        matched = true;
        break;
      }
    } catch {
      // a malformed pubkey shouldn't kill the whole verify; just skip
    }
  }
  if (!matched) return forbidden("signature did not verify against any authorizedSigner");

  const now = (deps.now ?? (() => Date.now()))();
  const result = await deps.storage.putIfNewer({
    usernameHash: r.usernameHash,
    encryptedBlob: blob,
    authorizedSigners: signers,
    blobVersion: r.blobVersion,
    signatureHex: r.signature_hex,
    updatedAt: now,
  });
  if (!result.accepted) {
    return conflict("a newer blobVersion is already on record");
  }
  return ok({ ok: true, blobVersion: r.blobVersion, updatedAt: now });
}

export async function handleGetUserIdentity(
  deps: UserIdentityDeps,
  usernameHash: string,
): Promise<HandlerResponse> {
  if (!HEX64.test(usernameHash)) {
    return malformed("usernameHash must be 32-byte hex");
  }
  const rec: UserIdentityRecord | undefined = await deps.storage.get(usernameHash);
  if (!rec) return notFound("no user-identity record");
  return ok({
    usernameHash: rec.usernameHash,
    encryptedBlob_b64: bytesToBase64(rec.encryptedBlob),
    authorizedSigners: rec.authorizedSigners,
    blobVersion: rec.blobVersion,
    signature_hex: rec.signatureHex,
    updatedAt: rec.updatedAt,
  });
}
