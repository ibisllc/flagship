import {
  verifyUploadRecoveryRecord,
  type UploadRecoveryRecord,
} from "@flagship/protocol";
import type {
  UsernameStorage,
  WebauthnRecoveryStorage,
} from "@flagship/storage";
import { hexToBytes } from "./hex.js";
import type { HandlerResponse } from "./types.js";

/**
 * Webapp cloud-shard recovery (WebAuthn PRF).
 *
 * `POST   /api/recovery`                            IRK-signed; upserts the record
 * `GET    /api/recovery/by-username/:username`       public metadata only — returns
 *                                                  credentialId + the SHA-256 of the
 *                                                  stored ciphertext, NOT the ciphertext
 *                                                  itself (Task #74).
 * `POST   /api/recovery/by-username/:username/fetch` Argon2id-gated; releases the
 *                                                  ciphertext only when the caller
 *                                                  presents a fetchToken whose
 *                                                  SHA-256 matches the stored hash.
 * `DELETE /api/recovery/by-username/:username`       IRK-signed; kill switch.
 *
 * `.com` only ever stores ciphertext + the credentialId pointer + the
 * passphrase-derived hashes. The unwrap key is the user's WebAuthn
 * passkey PRF output, which never leaves the browser.
 */

export interface WebauthnRecoveryDeps {
  usernames: UsernameStorage;
  webauthnRecovery: WebauthnRecoveryStorage;
  maxAgeMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_AGE = 5 * 60_000;

async function sha256Hex(b: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  let s = "";
  for (const x of h) s += x.toString(16).padStart(2, "0");
  return s;
}

function base64DecodeBytes(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Upload a wrapped-UMK ciphertext.
 *
 * Validation:
 *   - body shape is { request: { username, credentialId, wrappedUmk, issuedAt }, signature }
 *   - username row exists in the usernames table — IRK pubkey is fetched from there
 *   - signature verifies against that IRK pubkey
 *   - issuedAt is within maxAgeMs of now (replay defense)
 *   - wrappedUmk is well-formed base64 (we sign over its SHA-256 to keep
 *     canonical-bytes small; the upload-time hash is recomputed from the
 *     ciphertext on the wire and checked against the signed hash before
 *     the row is written, so .com cannot be tricked into storing
 *     attacker-substituted ciphertext under a victim's passkey)
 */
export async function handleUploadWebauthnRecovery(
  deps: WebauthnRecoveryDeps,
  body: unknown,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;

  const b = body as { request?: Record<string, unknown>; signature?: unknown };
  const r = b?.request ?? {};
  if (
    typeof r.username !== "string" ||
    typeof r.credentialId !== "string" ||
    typeof r.wrappedUmk !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(r.username)) {
    return { status: 400, body: { error: "invalid username" } };
  }
  if (!/^[0-9a-fA-F]{16,512}$/.test(r.credentialId)) {
    return { status: 400, body: { error: "credentialId must be 8-256 hex bytes" } };
  }
  // Task #74: passphrase-derived hashes — optional on the wire to keep
  // the canonical-bytes type stable (the protocol hashes only the
  // wrappedUmk bytes, not these new fields), but the recovery sub-origin
  // page always sends them. We accept-if-present + validate shape; rows
  // without them remain readable via the legacy presence GET but cannot
  // serve out the ciphertext through the new gated POST.
  if (r.fetchTokenHash !== undefined && r.fetchTokenHash !== null) {
    if (typeof r.fetchTokenHash !== "string" || !/^[0-9a-f]{64}$/.test(r.fetchTokenHash)) {
      return { status: 400, body: { error: "fetchTokenHash must be 64 hex chars (SHA-256)" } };
    }
  }
  if (r.prfSaltHash !== undefined && r.prfSaltHash !== null) {
    if (typeof r.prfSaltHash !== "string" || !/^[0-9a-f]{64}$/.test(r.prfSaltHash)) {
      return { status: 400, body: { error: "prfSaltHash must be 64 hex chars (SHA-256)" } };
    }
  }
  // Wrapped UMK is base64; decode to recompute the signed hash, then
  // store as base64. Cap at 16 KiB ciphertext to keep D1 row size sane.
  const wrappedBytes = base64DecodeBytes(r.wrappedUmk);
  if (!wrappedBytes) {
    return { status: 400, body: { error: "wrappedUmk must be valid base64" } };
  }
  if (wrappedBytes.length === 0 || wrappedBytes.length > 16 * 1024) {
    return { status: 400, body: { error: "wrappedUmk must be 1..16384 bytes" } };
  }

  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return { status: 403, body: { error: "stale request" } };
  }

  const userRec = await deps.usernames.get(r.username);
  if (!userRec) return { status: 404, body: { error: "unknown username" } };

  let sig: Uint8Array;
  try {
    sig = hexToBytes(b.signature);
  } catch {
    return { status: 400, body: { error: "invalid signature hex" } };
  }
  const wrappedUmkHashHex = await sha256Hex(wrappedBytes);
  const claim: UploadRecoveryRecord = {
    username: r.username,
    credentialIdHex: r.credentialId,
    wrappedUmkHashHex,
    issuedAt: r.issuedAt,
  };
  if (!verifyUploadRecoveryRecord(claim, sig, hexToBytes(userRec.irkPubHex))) {
    return { status: 403, body: { error: "invalid signature" } };
  }

  const t = now();
  const existing = await deps.webauthnRecovery.get(r.username);
  await deps.webauthnRecovery.upsert({
    username: r.username,
    credentialIdHex: r.credentialId,
    wrappedUmkB64: r.wrappedUmk,
    irkPubHex: userRec.irkPubHex,
    ...(typeof r.fetchTokenHash === "string" ? { fetchTokenHashHex: r.fetchTokenHash.toLowerCase() } : {}),
    ...(typeof r.prfSaltHash === "string" ? { prfSaltHashHex: r.prfSaltHash.toLowerCase() } : {}),
    createdAt: existing?.createdAt ?? t,
    updatedAt: t,
  });
  return { status: 200, body: { ok: true, updated: !!existing } };
}

/**
 * Public metadata fetch — returns presence + credentialId + the
 * SHA-256 of the stored ciphertext. Used by:
 *
 *   - `hasCloudRecovery` (webapp UI hint)
 *   - the delete pre-flight (the webapp needs the bytes-hash to pin
 *     the kill-switch signature; it gets the hash here without ever
 *     pulling the ciphertext).
 *
 * Task #74: the ciphertext itself is NO LONGER returned here — fetching
 * it requires `POST /api/recovery/by-username/<u>/fetch` with the
 * passphrase-derived fetchToken. Legacy records (uploaded before the
 * migration) have no fetchTokenHash; those rows still surface presence
 * + credentialId here but cannot be unwrapped through the gated POST
 * until the user re-enrols.
 */
export async function handleFetchWebauthnRecovery(
  deps: WebauthnRecoveryDeps,
  username: string,
): Promise<HandlerResponse> {
  const rec = await deps.webauthnRecovery.get(username);
  if (!rec) return { status: 404, body: { error: "no recovery record" } };
  const wrappedBytes = base64DecodeBytes(rec.wrappedUmkB64) ?? new Uint8Array();
  const wrappedUmkHash = await sha256Hex(wrappedBytes);
  return {
    status: 200,
    body: {
      username: rec.username,
      credentialId: rec.credentialIdHex,
      wrappedUmkHash,
      // Surfaces whether the gated-fetch path is available for this row.
      // Pre-migration rows return `false` — the webapp shows a "re-enrol
      // to unlock cloud recovery" hint instead of attempting the fetch.
      hasFetchTokenGate: !!rec.fetchTokenHashHex,
      updatedAt: rec.updatedAt,
    },
  };
}

/**
 * Argon2id-gated fetch (Task #74). The webapp posts
 *
 *   { fetchToken: <hex>, issuedAt: <ms> }
 *
 * after deriving fetchToken locally from the user's passphrase via
 * Argon2id + HKDF. We hash it and compare to the stored
 * `fetchTokenHashHex`. Only on match do we hand out the wrappedUmk.
 *
 * Rate-limiting happens upstream in apps/com/src/rateLimit.ts
 * (3-per-15min per usernameHash). The endpoint is also called per-IP
 * so a single passphrase-guessing attacker burns out their budget
 * almost immediately; combined with Argon2id's per-attempt cost on
 * the client side, this brings the brute-force cost to "infeasible
 * for any but a state-level attacker, even with a leaked rows dump"
 * — see project's threat-model.md for the math.
 */
export async function handleFetchWrappedUmkWithToken(
  deps: WebauthnRecoveryDeps,
  username: string,
  body: unknown,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") {
    return { status: 400, body: { error: "malformed body" } };
  }
  if (typeof b.fetchToken !== "string" || !/^[0-9a-fA-F]{32,512}$/.test(b.fetchToken)) {
    return { status: 400, body: { error: "fetchToken must be hex" } };
  }
  if (typeof b.issuedAt !== "number" || Math.abs(now() - b.issuedAt) > maxAgeMs) {
    return { status: 403, body: { error: "stale request" } };
  }
  const rec = await deps.webauthnRecovery.get(username);
  if (!rec) return { status: 404, body: { error: "no recovery record" } };
  if (!rec.fetchTokenHashHex) {
    // Legacy row uploaded before the migration. Refuse the gated fetch
    // — the user must re-enrol via the recovery sub-origin to acquire
    // a fetchToken hash on the stored row.
    return {
      status: 409,
      body: { error: "record predates passphrase gate — re-enrol cloud recovery" },
    };
  }
  const fetchTokenBytes = hexToBytes(b.fetchToken.toLowerCase());
  const presentedHashHex = await sha256Hex(fetchTokenBytes);
  if (presentedHashHex !== rec.fetchTokenHashHex.toLowerCase()) {
    return { status: 403, body: { error: "invalid fetch token" } };
  }
  return {
    status: 200,
    body: {
      username: rec.username,
      credentialId: rec.credentialIdHex,
      wrappedUmk: rec.wrappedUmkB64,
      // The PRF salt hash is returned so the client can verify it
      // re-derives the same value from the passphrase locally — a
      // defense against a malicious .com swapping the salt to coerce
      // a different PRF output.
      ...(rec.prfSaltHashHex ? { prfSaltHash: rec.prfSaltHashHex } : {}),
      updatedAt: rec.updatedAt,
    },
  };
}

/**
 * Kill switch — remove the cloud copy. Reuses the upload envelope shape
 * (signed by the user's IRK) so revocation doesn't need a new canonical
 * type. We require the credentialIdHex + wrappedUmkHash to match the
 * stored record's, so a leaked old signature can't be replayed to delete
 * a freshly-uploaded record.
 */
export async function handleDeleteWebauthnRecovery(
  deps: WebauthnRecoveryDeps,
  username: string,
  body: unknown,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;

  const b = body as { request?: Record<string, unknown>; signature?: unknown };
  const r = b?.request ?? {};
  if (
    typeof r.username !== "string" ||
    typeof r.credentialId !== "string" ||
    typeof r.wrappedUmkHash !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }
  if (r.username.toLowerCase() !== username.toLowerCase()) {
    return { status: 403, body: { error: "username / url mismatch" } };
  }
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return { status: 403, body: { error: "stale request" } };
  }

  const userRec = await deps.usernames.get(r.username);
  if (!userRec) return { status: 404, body: { error: "unknown username" } };
  const existing = await deps.webauthnRecovery.get(r.username);
  if (!existing) return { status: 404, body: { error: "no recovery record" } };

  // Pin the delete to the *current* record's bytes — old leaked sigs
  // can't replay against a freshly-uploaded record (wrappedUmkHash will
  // differ).
  const expectedHash = await sha256Hex(base64DecodeBytes(existing.wrappedUmkB64) ?? new Uint8Array());
  if (r.wrappedUmkHash !== expectedHash) {
    return { status: 409, body: { error: "stored record changed since signature" } };
  }

  let sig: Uint8Array;
  try {
    sig = hexToBytes(b.signature);
  } catch {
    return { status: 400, body: { error: "invalid signature hex" } };
  }
  const claim: UploadRecoveryRecord = {
    username: r.username,
    credentialIdHex: r.credentialId,
    wrappedUmkHashHex: r.wrappedUmkHash,
    issuedAt: r.issuedAt,
  };
  if (!verifyUploadRecoveryRecord(claim, sig, hexToBytes(userRec.irkPubHex))) {
    return { status: 403, body: { error: "invalid signature" } };
  }

  await deps.webauthnRecovery.delete(r.username);
  return { status: 200, body: { ok: true } };
}
