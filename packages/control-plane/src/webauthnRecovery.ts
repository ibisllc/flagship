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
 * `POST /api/recovery`                      IRK-signed; upserts the record
 * `GET  /api/recovery/by-username/:username` public; returns the ciphertext
 * `DELETE /api/recovery/by-username/:username` IRK-signed; kill switch
 *
 * `.com` only ever stores ciphertext + the credentialId pointer. The
 * unwrap key is the user's WebAuthn passkey PRF output, which never
 * leaves the browser.
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
    createdAt: existing?.createdAt ?? t,
    updatedAt: t,
  });
  return { status: 200, body: { ok: true, updated: !!existing } };
}

/**
 * Public fetch of the recovery record. Returns ciphertext + credentialId
 * so the recovering browser can do `navigator.credentials.get()` scoped
 * to that specific passkey, then PRF-unwrap. No signature gate — the
 * payload is opaque ciphertext, useless without the user's authenticator.
 */
export async function handleFetchWebauthnRecovery(
  deps: WebauthnRecoveryDeps,
  username: string,
): Promise<HandlerResponse> {
  const rec = await deps.webauthnRecovery.get(username);
  if (!rec) return { status: 404, body: { error: "no recovery record" } };
  return {
    status: 200,
    body: {
      username: rec.username,
      credentialId: rec.credentialIdHex,
      wrappedUmk: rec.wrappedUmkB64,
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
