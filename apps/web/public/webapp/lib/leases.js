// Auto-unlock leases — sign + post the IRK-signed envelope that lets
// `.com` release the LUKS unlock key on the next /unlock-key/consume.
//
// Two modes share the same envelope (see auto_unlock_lease_design.md):
//   approveOneShot(serverFqdn)   — multiUse=false, ~10 min expiry.
//                                   Used by the unlock-approvals view's
//                                   "Approve" button.
//   enableLongLived(serverFqdn)  — multiUse=true, ~7d expiry. Used by
//                                   the per-server toggle. Renew before
//                                   expiry by calling again.
//   revokeLease(serverFqdn, id)  — kill switch.
//   listLeases(serverFqdn)       — UI listing (no unlockKey returned).
//
// The webapp is a peer device (per feedback_webapp_is_peer_not_remote)
// — it signs locally with its IRK, never forwards to the phone.

import { bytesToHex, hexToBytes, hkdf32, signWithIrk } from "../keystore.js";
import { getSession } from "./state.js";

// Webapp lives on web.flagshipserver.com; .com endpoints live on the
// apex. Same Worker handles both via host-based routing.
const APEX = "https://flagshipserver.com";

const ONE_SHOT_TTL_MS = 10 * 60 * 1000;        // 10 min
const DEFAULT_LONG_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Sign + deposit a one-shot lease in response to an Approve click on
 * a pending unlock-key request. Returns { leaseId, expiresAt } on
 * success.
 */
export async function approveOneShot(serverFqdn) {
  return depositLease(serverFqdn, { multiUse: false, ttlMs: ONE_SHOT_TTL_MS });
}

/**
 * Sign + deposit a long-lived multi-use lease (the "auto-unlock"
 * toggle). The same call extends an existing lease — call it
 * periodically while the device is online to keep auto-unlock alive.
 */
export async function enableLongLived(serverFqdn, ttlMs = DEFAULT_LONG_TTL_MS) {
  return depositLease(serverFqdn, { multiUse: true, ttlMs });
}

/** Public list of active leases for a server (no unlockKey leaked). */
export async function listLeases(serverFqdn) {
  const r = await fetch(
    `${APEX}/api/server/${encodeURIComponent(serverFqdn)}/unlock-key/leases`,
  );
  if (!r.ok) throw new Error(`list leases failed: ${r.status}`);
  const body = await r.json();
  return Array.isArray(body.leases) ? body.leases : [];
}

// Renew when a long-lived lease has less than this much time left.
// 1 day default — at the 7d expiry, this means we re-sign on the
// 6th day. With a webapp opened at least once a week the lease
// stays alive; longer absences correctly let it decay (the design
// intent — see auto_unlock_lease_design.md).
const RENEW_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Re-sign every long-lived lease on `serverFqdn` whose `expiresAt`
 * is within `windowMs` of now. Silent — no UI prompt, the IRK is
 * already in the unlocked session. Returns the list of leases that
 * were actually renewed (empty when there was nothing to do).
 *
 * Failure to fetch the lease list (server unreachable, .com 5xx)
 * silently no-ops — we'll try again on the next tick.
 */
export async function renewIfExpiringSoon(serverFqdn, windowMs = RENEW_WINDOW_MS) {
  const session = getSession();
  if (!session.umk) return [];
  let active;
  try {
    active = await listLeases(serverFqdn);
  } catch {
    return [];
  }
  const now = Date.now();
  const renewed = [];
  for (const lease of active) {
    if (!lease.multiUse) continue;
    if (lease.expiresAt - now > windowMs) continue;
    // Re-issue with the default 7-day TTL. Multiple long-lived
    // leases (e.g., user has webapp + phone both signed) would
    // each get refreshed independently — that's fine, .com keeps
    // them as separate rows keyed by leaseId.
    try {
      const r = await enableLongLived(serverFqdn);
      renewed.push({ oldLeaseId: lease.leaseId, newLeaseId: r.leaseId, expiresAt: r.expiresAt });
    } catch {
      // Best-effort: a single failure doesn't abort the loop.
    }
  }
  return renewed;
}

/**
 * Run `renewIfExpiringSoon` against every server the user has paired
 * with locally. Called on app open + on a 30-min ticker while open.
 */
export async function tickRenewals(serverFqdns) {
  const out = [];
  for (const fqdn of serverFqdns) {
    const r = await renewIfExpiringSoon(fqdn);
    if (r.length) out.push({ serverFqdn: fqdn, renewed: r });
  }
  return out;
}

/** Sign + DELETE a lease. Per-device kill switch. */
export async function revokeLease(serverFqdn, leaseId) {
  const session = getSession();
  if (!session.umk) throw new Error("unlock first");
  const issuedAt = Date.now();
  const canonical = canonicalRevoke({ serverId: serverFqdn, leaseId, issuedAt });
  const sig = await signWithIrk(session.umk, canonical);
  const r = await fetch(
    `${APEX}/api/server/${encodeURIComponent(serverFqdn)}/unlock-key/lease/${encodeURIComponent(leaseId)}`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: { serverId: serverFqdn, leaseId, issuedAt },
        signature: bytesToHex(sig),
      }),
    },
  );
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`revoke lease failed: ${r.status} ${txt}`.trim());
  }
  return r.json();
}

// ---- internals ----

async function depositLease(serverFqdn, { multiUse, ttlMs }) {
  const session = getSession();
  if (!session.umk) throw new Error("unlock first");

  // 1. Fetch the sealed LUKS key the daemon stored at install time.
  const sealedRes = await fetch(
    `${APEX}/api/server/${encodeURIComponent(serverFqdn)}/sealed-luks-key`,
  );
  if (!sealedRes.ok) {
    throw new Error(`no sealed key on file for ${serverFqdn}: ${sealedRes.status}`);
  }
  const sealedJson = await sealedRes.json();
  const sealedBlob = hexToBytes(sealedJson.sealedKey);

  // 2. Open it with the IRK (Ed25519→X25519 conversion + ECDH + AES-GCM).
  const unlockKey = await openSealedWithIrk(session.umk, sealedBlob);

  // 3. Build + sign the lease envelope.
  const leaseId = randomHex(16);
  const issuedAt = Date.now();
  const expiresAt = issuedAt + ttlMs;
  const canonical = canonicalLease({
    serverId: serverFqdn,
    leaseId,
    expiresAt,
    unlockKey,
    multiUse,
    issuedAt,
  });
  const sig = await signWithIrk(session.umk, canonical);

  // 4. POST. .com verifies the signature against the user's IRK pub.
  const r = await fetch(
    `${APEX}/api/server/${encodeURIComponent(serverFqdn)}/unlock-key/lease`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: {
          serverId: serverFqdn,
          leaseId,
          unlockKey: bytesToHex(unlockKey),
          multiUse,
          expiresAt,
          issuedAt,
        },
        signature: bytesToHex(sig),
      }),
    },
  );
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`deposit lease failed: ${r.status} ${txt}`.trim());
  }
  return { leaseId, expiresAt, multiUse };
}

// Field order pinned to packages/protocol/src/auth.ts canonicalAutoUnlockLease.
function canonicalLease({ serverId, leaseId, expiresAt, unlockKey, multiUse, issuedAt }) {
  return new TextEncoder().encode(
    [
      "flagship/auto-unlock-lease/v1",
      serverId,
      leaseId,
      expiresAt,
      bytesToHex(unlockKey),
      multiUse ? "1" : "0",
      issuedAt,
    ].join("|"),
  );
}

function canonicalRevoke({ serverId, leaseId, issuedAt }) {
  return new TextEncoder().encode(
    ["flagship/revoke-auto-unlock-lease/v1", serverId, leaseId, issuedAt].join("|"),
  );
}

function randomHex(byteLen) {
  const buf = new Uint8Array(byteLen);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

/**
 * Open a sealed blob (sealed against IRK Ed25519 pubkey via the
 * libsodium birational trick — see protocol/src/encryption.ts
 * `sealForEd25519Recipient`) using the IRK seed.
 *
 * Blob layout (44 + ct):
 *   [0..32)   ephemeral X25519 pubkey
 *   [32..44)  AES-GCM nonce (12 bytes)
 *   [44..)    ciphertext + 16-byte tag
 */
async function openSealedWithIrk(umkSeed, blob) {
  if (blob.length < 44) throw new Error("sealed blob too short");
  const ephPub = blob.slice(0, 32);
  const nonce = blob.slice(32, 44);
  const ct = blob.slice(44);

  // 1. Re-derive the IRK seed (32 bytes) the same way keystore.js does.
  const irkSeed = await hkdf32(umkSeed, "flagship.irk.v1");

  // 2. Convert Ed25519 seed → X25519 priv (libsodium-style):
  //    clamp(SHA-512(seed)[0..32]).
  const h = new Uint8Array(await crypto.subtle.digest("SHA-512", irkSeed));
  const x25519Priv = h.slice(0, 32);
  x25519Priv[0] &= 248;
  x25519Priv[31] &= 127;
  x25519Priv[31] |= 64;

  // 3. ECDH(myX25519Priv, ephPub) via WebCrypto X25519. Requires
  //    Chrome 130+ / Safari 17+ / Firefox 130+; older browsers throw.
  const myKey = await crypto.subtle.importKey(
    "raw",
    x25519Priv,
    "X25519",
    false,
    ["deriveBits"],
  );
  const ephPubKey = await crypto.subtle.importKey(
    "raw",
    ephPub,
    "X25519",
    false,
    [],
  );
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "X25519", public: ephPubKey },
    myKey,
    256,
  );

  // 4. HKDF-SHA256(shared, salt=ephPub, info="flagship.seal.v1", L=32).
  const sharedKey = await crypto.subtle.importKey(
    "raw",
    sharedBits,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const symBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: ephPub,
      info: new TextEncoder().encode("flagship.seal.v1"),
    },
    sharedKey,
    256,
  );

  // 5. AES-GCM decrypt.
  const aesKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(symBits),
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce },
    aesKey,
    ct,
  );
  return new Uint8Array(pt);
}
