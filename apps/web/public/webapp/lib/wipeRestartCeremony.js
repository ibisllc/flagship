// P11 — Wipe & restart ceremony.
//
// Mirror of FlagshipUI/ViewModels/WipeRestartViewModel.swift. Rotates
// everything in one envelope:
//
//   1. Generate a fresh 32-byte UMK seed locally.
//   2. Run a WebAuthn passkey REGISTER on the recovery sub-origin →
//      new credentialId + AES-GCM wrap of the NEW UMK under the new
//      PRF secret.
//   3. Compute SHA-256(wrappedUmkBytes) — the protocol signs the HASH
//      of the ciphertext, NOT the ciphertext itself, to keep the
//      canonical bytes small.
//   4. Sign canonical `flagship/wipe-restart/v1` bytes with the OLD
//      IRK (the currently-registered key, proof of possession of the
//      displaced identity).
//   5. POST `/api/users/:u/wipe-restart` with `{ request, signature,
//      idempotencyKey }` plus the optional `If-Match` ETag for the
//      device-list-shifted fence.
//
// Server returns:
//   - 200 + { ok, auditSeq, newIrkPub, revokedGrantIds, etag? }
//   - 412 (device list shifted)
//   - 429 (rate-limited 1/hour)
//   - 409 (concurrent rotation won)
//   - 403 (stale / signature mismatch)
//   - 400 (malformed)
//
// Local install: on a 200, the caller replaces the wrapped UMK in
// IndexedDB with one derived from the NEW UMK + the user's existing
// browser passphrase. Until the install lands, Keystore retains the
// OLD UMK — a network blip on POST doesn't strand the user with
// mismatched local + server keys (this matches the iOS conservative
// install pattern: keystore swap happens AFTER server-success only).

import { bytesToHex, deriveIrkFromSeed, hkdf32 } from "../keystore.js";
import { requireOwnerProfile } from "./companionGuard.js";

/** Canonical-bytes tag — MUST match @flagship/protocol TAG_WIPE_RESTART. */
export const TAG_WIPE_RESTART = "flagship/wipe-restart/v1";

const APEX = "https://flagshipserver.com";

/**
 * Compose the canonical bytes the OLD IRK signs. Byte-for-byte mirror
 * of @flagship/protocol's `canonicalWipeRestart`:
 *
 *   "flagship/wipe-restart/v1|<username>|<hex(oldIrkPub)>|<hex(newIrkPub)>|<lower(newCredentialIdHex)>|<lower(newWrappedUmkHashHex)>|<issuedAt>"
 */
export function canonicalWipeRestartBytes({
  username,
  oldIrkPubHex,
  newIrkPubHex,
  newCredentialIdHex,
  newWrappedUmkHashHex,
  issuedAt,
}) {
  return new TextEncoder().encode(
    [
      TAG_WIPE_RESTART,
      username,
      oldIrkPubHex,
      newIrkPubHex,
      String(newCredentialIdHex).toLowerCase(),
      String(newWrappedUmkHashHex).toLowerCase(),
      issuedAt,
    ].join("|"),
  );
}

/** SHA-256 hex of a byte array via SubtleCrypto. */
export async function sha256Hex(bytes) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return bytesToHex(h);
}

/** Generate a 16-byte random idempotency key (32 hex chars, matching
 *  the Worker's strict `/^[0-9a-fA-F]{32}$/` shape check). */
export function newIdempotencyKey() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

/** Generate a fresh 32-byte UMK seed. */
export function newUmkSeed() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return b;
}

/**
 * Run the wipe-restart ceremony to the point of a successful server
 * commit. Does NOT install the new UMK locally — the caller is
 * responsible for the keystore swap (so failures on the local install
 * don't leave the user holding a half-rotated browser when the server
 * already moved). Returns:
 *
 *   { ok: true, newUmk, newIrkPubHex, newCredentialIdHex,
 *     newWrappedUmkB64, auditSeq, freshEtag?, revokedGrantIds }
 *
 * Throws with `.code` ∈ {"412","429","409","403","400","5xx","network"}
 * on the documented non-2xx statuses.
 *
 * @param {object} args
 * @param {string} args.username
 * @param {Uint8Array} args.umk             current session UMK (OLD)
 * @param {string|null} [args.ifMatch]      devices-list ETag (optional)
 * @param {object} [args.deps]              ceremony deps (mostly tests)
 * @param {(umk: Uint8Array, username: string) => Promise<{credentialIdHex:string, wrappedUmkB64:string, wrappedUmkBytes:Uint8Array}>} [args.enrollPasskey]
 *        Override the recovery-passkey enrollment. Defaults to the
 *        production sub-origin popup; tests pass a synchronous stub.
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetch]
 * @param {string} [deps.origin]
 * @param {() => number} [deps.now]
 * @param {() => Uint8Array} [deps.newUmk]  override the new-UMK source (tests)
 * @param {() => string} [deps.newIdempotencyKey] override the nonce (tests)
 */
export async function runWipeRestartCeremony(args, deps = {}) {
  const { username, umk } = args;
  const ifMatch = args.ifMatch ?? null;
  const enrollPasskey = args.enrollPasskey ?? defaultEnrollPasskey;
  if (!username) throw makeError("username required", "400");
  // P14 — companion sessions can't sign. Refuse with a tagged error
  // before generating the new UMK.
  (deps.requireOwnerProfile ?? requireOwnerProfile)();
  if (!(umk instanceof Uint8Array) || umk.length !== 32) {
    throw makeError("umk must be a 32-byte Uint8Array", "400");
  }
  const f = deps.fetch || fetch;
  const origin = deps.origin || APEX;
  const now = (deps.now || Date.now)();

  // 1 — fresh UMK + register a new recovery passkey + wrap the new UMK
  // under the new passkey's PRF secret.
  const newUmk = (deps.newUmk || newUmkSeed)();
  if (!(newUmk instanceof Uint8Array) || newUmk.length !== 32) {
    throw makeError("newUmk source produced non-32B output", "400");
  }
  const reg = await enrollPasskey(newUmk, username);
  if (
    !reg ||
    typeof reg.credentialIdHex !== "string" ||
    typeof reg.wrappedUmkB64 !== "string" ||
    !(reg.wrappedUmkBytes instanceof Uint8Array)
  ) {
    throw makeError("passkey enrollment returned a malformed result", "400");
  }
  const wrappedUmkHashHex = await sha256Hex(reg.wrappedUmkBytes);

  // 2 — derive OLD + NEW IRK pubkeys.
  const oldIrk = await deriveIrkFromSeed(umk);
  // The NEW IRK is the v1 derivation off the NEW UMK — same shape the
  // keystore would compute the first time a user opens a fresh account.
  // Pinned to the iOS mirror (WipeRestartViewModel: `flagship/irk/v1`
  // info string + HKDF<SHA-256>).
  const newIrkKp = await deriveIrkFromSeed(newUmk);
  const oldIrkPubHex = bytesToHex(oldIrk.publicKey);
  const newIrkPubHex = bytesToHex(newIrkKp.publicKey);

  // 3 — sign WipeRestart canonical bytes with the OLD IRK.
  const issuedAt = now;
  const canonical = canonicalWipeRestartBytes({
    username,
    oldIrkPubHex,
    newIrkPubHex,
    newCredentialIdHex: reg.credentialIdHex,
    newWrappedUmkHashHex: wrappedUmkHashHex,
    issuedAt,
  });
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, oldIrk.privateKey, canonical),
  );

  // 4 — POST.
  const idempotencyKey = (deps.newIdempotencyKey || newIdempotencyKey)();
  if (!/^[0-9a-fA-F]{32}$/.test(idempotencyKey)) {
    throw makeError("idempotencyKey must be 32 hex chars", "400");
  }
  const headers = { "content-type": "application/json" };
  if (ifMatch) headers["if-match"] = ifMatch;
  const body = {
    request: {
      username,
      oldIrkPub: oldIrkPubHex,
      newIrkPub: newIrkPubHex,
      newCredentialId: reg.credentialIdHex,
      newWrappedUmk: reg.wrappedUmkB64,
      issuedAt,
    },
    signature: bytesToHex(sigBytes),
    idempotencyKey,
  };
  let resp;
  try {
    resp = await f(`${origin}/api/users/${encodeURIComponent(username)}/wipe-restart`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw makeError(`network: ${e?.message ?? e}`, "network");
  }
  if (resp.status === 200) {
    const json = await resp.json().catch(() => ({}));
    const freshEtag =
      (resp.headers && typeof resp.headers.get === "function" && resp.headers.get("etag")) ||
      json.etag ||
      null;
    return {
      ok: true,
      newUmk,
      newIrkPubHex,
      newCredentialIdHex: reg.credentialIdHex,
      newWrappedUmkB64: reg.wrappedUmkB64,
      auditSeq: json.auditSeq,
      revokedGrantIds: Array.isArray(json.revokedGrantIds) ? json.revokedGrantIds : [],
      freshEtag,
    };
  }
  const text = await resp.text().catch(() => "");
  if (resp.status === 412) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    throw makeError(
      "Your device list changed in the background. Refresh and try again.",
      "412",
      { currentEtag: parsed?.currentEtag ?? null },
    );
  }
  if (resp.status === 429) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    throw makeError(
      "Wipe rate-limited (1 per hour). Try again later.",
      "429",
      { retryAfterMs: parsed?.retryAfterMs },
    );
  }
  if (resp.status === 409) {
    throw makeError(
      "Another rotation completed first. Refresh and check Activity for the audit trail.",
      "409",
    );
  }
  if (resp.status === 403) {
    throw makeError("The server rejected the request — refresh and try again.", "403");
  }
  if (resp.status === 400) {
    throw makeError(`Bad request: ${text || resp.status}`, "400");
  }
  throw makeError(`Server error (${resp.status}): ${text}`, "5xx");
}

/** Default passkey-enrollment delegate — dynamically imports
 *  `enrollNewRecoveryPasskey` from lib/recovery.js so the test suite
 *  can short-circuit it without touching the sub-origin popup. */
async function defaultEnrollPasskey(umk, username) {
  const { enrollNewRecoveryPasskey } = await import("./recovery.js");
  return enrollNewRecoveryPasskey(umk, username);
}

function makeError(message, code, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

// Re-export to keep test imports stable if internals get reshuffled.
export const _internal = { deriveIrkFromSeed, hkdf32 };
