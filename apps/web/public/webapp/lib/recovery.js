// Cloud-shard recovery using a WebAuthn passkey's PRF output.
//
// Flow:
//   setupCloudRecovery(username)
//     → navigator.credentials.create() → get() with prf eval
//     → wrap UMK with PRF-derived key (AES-GCM)
//     → POST /api/recovery (IRK-signed envelope)
//
//   recoverFromCloud(username)
//     → GET /api/recovery/by-username/<username>
//     → navigator.credentials.get() scoped to credentialId, with prf eval
//     → unwrap with PRF-derived key
//     → return UMK seed bytes (caller persists via passphrase wrap as today)
//
//   deleteCloudRecovery(username)
//     → fetch current record (for the bytes hash)
//     → IRK-signed DELETE
//
// The webapp is a peer device — signs locally with IRK, never asks
// the phone (see feedback_webapp_is_peer_not_remote.md).

import { bytesToHex, hexToBytes, signWithIrk } from "../keystore.js";
import { getSession } from "./state.js";

const APEX = "https://flagshipserver.com";

// Same rpId for apex + web.; lets a passkey created here also work on
// flagshipserver.com if we ever need it. WebAuthn requires rpId to be
// the current origin OR a registrable domain ancestor; both
// flagshipserver.com and web.flagshipserver.com satisfy "flagshipserver.com".
const RP_ID = "flagshipserver.com";
const RP_NAME = "Flagship";

// Stable salt for the PRF-derived wrap key. Using a fixed string means
// the same passkey reliably regenerates the same key — required for
// recovery across browsers. Per WebAuthn spec, PRF input is hashed
// with SHA-256 before evaluation, so this can be arbitrary bytes.
const PRF_SALT = new TextEncoder().encode("flagship.recovery.v1");

/**
 * Register a new passkey, wrap the user's UMK seed with its PRF
 * output, and upload to .com. Returns { credentialId, updated }.
 */
export async function setupCloudRecovery(username) {
  const session = getSession();
  if (!session.umk) throw new Error("unlock first");
  if (!username) throw new Error("username required");
  await assertWebauthnAvailable();

  // Create the passkey. We declare PRF support up-front. Some
  // browsers honour eval-during-create (returning the PRF result in
  // the create response); others require a separate get() after.
  // Either path lands in `wrapKeyMaterial`.
  const userIdBytes = new TextEncoder().encode(username);
  const challenge = randBytes(32);
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { id: RP_ID, name: RP_NAME },
      user: {
        id: userIdBytes,
        name: username,
        displayName: username,
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -8 },   // Ed25519
        { type: "public-key", alg: -7 },   // ES256
        { type: "public-key", alg: -257 }, // RS256
      ],
      authenticatorSelection: {
        residentKey: "required",      // discoverable so login-without-username works later
        userVerification: "preferred",
      },
      timeout: 90_000,
      extensions: {
        prf: { eval: { first: PRF_SALT } },
      },
    },
  });
  if (!cred) throw new Error("passkey creation cancelled");

  const credentialId = new Uint8Array(cred.rawId);
  let prfBytes = readPrfFirst(cred);
  if (!prfBytes) {
    // Browser didn't return PRF during create — do a get() to obtain it.
    prfBytes = await getPrfWithGet(credentialId);
  }
  if (!prfBytes) {
    throw new Error("WebAuthn PRF not supported by this authenticator");
  }

  const wrappedB64 = await wrapUmkWithPrf(session.umk, prfBytes);
  await uploadRecord({
    session,
    username,
    credentialIdHex: bytesToHex(credentialId),
    wrappedUmkB64: wrappedB64,
  });
  return { credentialId: bytesToHex(credentialId) };
}

/**
 * Recover the UMK seed from a previously-uploaded record. Returns the
 * 32-byte UMK seed; caller is responsible for re-wrapping it under a
 * passphrase (or storing as-is) per the local-storage flow.
 */
export async function recoverFromCloud(username) {
  if (!username) throw new Error("username required");
  await assertWebauthnAvailable();

  const r = await fetch(`${APEX}/api/recovery/by-username/${encodeURIComponent(username)}`);
  if (r.status === 404) throw new Error("no cloud recovery for that username");
  if (!r.ok) throw new Error(`fetch recovery failed: ${r.status}`);
  const body = await r.json();
  const credentialId = hexToBytes(body.credentialId);
  const wrapped = base64ToBytes(body.wrappedUmk);

  const prfBytes = await getPrfWithGet(credentialId);
  if (!prfBytes) throw new Error("WebAuthn PRF not supported by this authenticator");

  return await unwrapUmkWithPrf(wrapped, prfBytes);
}

/**
 * Delete the cloud recovery record. Requires the user to be unlocked
 * (we sign with IRK + pin to the current stored bytes via SHA-256).
 */
export async function deleteCloudRecovery(username) {
  const session = getSession();
  if (!session.umk) throw new Error("unlock first");
  // Fetch current bytes so we can hash + sign over them.
  const r = await fetch(`${APEX}/api/recovery/by-username/${encodeURIComponent(username)}`);
  if (r.status === 404) return { deleted: false };
  if (!r.ok) throw new Error(`fetch recovery failed: ${r.status}`);
  const body = await r.json();
  const wrapped = base64ToBytes(body.wrappedUmk);
  const wrappedHash = await sha256Hex(wrapped);
  const issuedAt = Date.now();
  const canonical = canonicalUpload({
    username,
    credentialIdHex: body.credentialId,
    wrappedUmkHashHex: wrappedHash,
    issuedAt,
  });
  const sig = await signWithIrk(session.umk, canonical);
  const del = await fetch(
    `${APEX}/api/recovery/by-username/${encodeURIComponent(username)}`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: {
          username,
          credentialId: body.credentialId,
          wrappedUmkHash: wrappedHash,
          issuedAt,
        },
        signature: bytesToHex(sig),
      }),
    },
  );
  if (!del.ok) {
    const txt = await del.text().catch(() => "");
    throw new Error(`delete failed: ${del.status} ${txt}`.trim());
  }
  return { deleted: true };
}

/** Best-effort presence check used by views to decide UI state. */
export async function hasCloudRecovery(username) {
  if (!username) return false;
  try {
    const r = await fetch(`${APEX}/api/recovery/by-username/${encodeURIComponent(username)}`);
    return r.ok;
  } catch {
    return false;
  }
}

// ---- internals ----

async function assertWebauthnAvailable() {
  if (!("credentials" in navigator) || !window.PublicKeyCredential) {
    throw new Error("WebAuthn not supported in this browser");
  }
}

async function uploadRecord({ session, username, credentialIdHex, wrappedUmkB64 }) {
  const wrappedBytes = base64ToBytes(wrappedUmkB64);
  const wrappedUmkHashHex = await sha256Hex(wrappedBytes);
  const issuedAt = Date.now();
  const canonical = canonicalUpload({
    username,
    credentialIdHex,
    wrappedUmkHashHex,
    issuedAt,
  });
  const sig = await signWithIrk(session.umk, canonical);
  const r = await fetch(`${APEX}/api/recovery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request: {
        username,
        credentialId: credentialIdHex,
        wrappedUmk: wrappedUmkB64,
        issuedAt,
      },
      signature: bytesToHex(sig),
    }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`upload recovery failed: ${r.status} ${txt}`.trim());
  }
  return r.json();
}

// Pinned to packages/protocol/src/auth.ts canonicalUploadRecoveryRecord.
function canonicalUpload({ username, credentialIdHex, wrappedUmkHashHex, issuedAt }) {
  return new TextEncoder().encode(
    [
      "flagship/upload-recovery-record/v1",
      username,
      credentialIdHex,
      wrappedUmkHashHex,
      issuedAt,
    ].join("|"),
  );
}

async function getPrfWithGet(credentialId) {
  const challenge = randBytes(32);
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: RP_ID,
      allowCredentials: [{ type: "public-key", id: credentialId }],
      userVerification: "preferred",
      timeout: 90_000,
      extensions: {
        prf: { eval: { first: PRF_SALT } },
      },
    },
  });
  return readPrfFirst(cred);
}

function readPrfFirst(cred) {
  if (!cred) return null;
  const r = cred.getClientExtensionResults?.();
  const first = r?.prf?.results?.first;
  if (!first) return null;
  return new Uint8Array(first);
}

/** AES-GCM(prfKey, nonce, umkSeed) → base64(nonce || ct || tag). */
async function wrapUmkWithPrf(umkSeed, prfBytes) {
  const aesKey = await crypto.subtle.importKey(
    "raw",
    prfBytes.slice(0, 32),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const nonce = randBytes(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, umkSeed),
  );
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return bytesToB64(out);
}

async function unwrapUmkWithPrf(wrapped, prfBytes) {
  if (wrapped.length < 12 + 16) throw new Error("wrapped UMK too short");
  const nonce = wrapped.slice(0, 12);
  const ct = wrapped.slice(12);
  const aesKey = await crypto.subtle.importKey(
    "raw",
    prfBytes.slice(0, 32),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aesKey, ct);
  return new Uint8Array(pt);
}

function randBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function bytesToB64(b) {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

function base64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(b) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  return bytesToHex(h);
}
