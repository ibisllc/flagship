// Auto-unlock leases, box-sealed (flagship/auto-unlock-lease/v2), as iOS and
// Android deposit them (packages/protocol/src/phoneEndpoint.ts §4).
//
// The browser opens the disk key `.com` holds sealed for this account's IRK,
// re-seals it FOR the box's STK (the directory-bound key), and signs a lease
// that pins that STK. `.com` stores only the sealed blob (it never sees the
// key) and releases it to the box on reboot; the box unseals it itself.
//
//   enableLongLived(serverFqdn)  — deposit a lease (7 days; renew by calling
//                                  again; tickRenewals does it silently).
//   revokeLease(serverFqdn, id)  — the kill switch (auto-unlock-lease-revoke/v1).
//   listLeases(serverFqdn)       — the active leases' metadata, never the key.
//
// Both orders are verified against the account IRK, so they're signed with
// it (not the admin root).

import { bytesToHex, hexToBytes, hkdf32, signWithIrk as defaultSignWithIrk } from "../keystore.js";
import { getSession } from "./state.js";
import { controlApex } from "./apex.js";
import { importX25519Private } from "./x25519.js";
import { ed25519PubToX25519 } from "./edToMont.js";
import { accountReadFetch } from "./accountRead.js";

export const TAG_AUTO_UNLOCK_LEASE_V2 = "flagship/auto-unlock-lease/v2";
export const TAG_AUTO_UNLOCK_LEASE_REVOKE = "flagship/auto-unlock-lease-revoke/v1";

const DEFAULT_LONG_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
// Renew a lease with less than this left: at the 7-day expiry, on the 6th day.
const RENEW_WINDOW_MS = 24 * 60 * 60 * 1000;

function fieldGuard(name, value) {
  const s = String(value);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x7c) throw new Error(`canonical-bytes field "${name}" contains separator '|' at index ${i}`);
    if (c <= 0x1f || c === 0x7f) throw new Error(`canonical-bytes field "${name}" contains control char 0x${c.toString(16)} at index ${i}`);
  }
}

/** `flagship/auto-unlock-lease/v2|<serverDomain>|<stkPub hex>|<leaseId>|
 *  <sealedKey hex>|<issuedAt>|<expiresAt>|<maxUses, -1 for none>`. */
export function canonicalLeaseV2Bytes({ serverDomain, stkPubHex, leaseId, sealedKeyHex, issuedAt, expiresAt, maxUses }) {
  fieldGuard("serverDomain", serverDomain);
  fieldGuard("leaseId", leaseId);
  return new TextEncoder().encode(
    [
      TAG_AUTO_UNLOCK_LEASE_V2,
      serverDomain,
      String(stkPubHex).toLowerCase(),
      leaseId,
      String(sealedKeyHex).toLowerCase(),
      issuedAt,
      expiresAt,
      maxUses ?? -1,
    ].join("|"),
  );
}

/** `flagship/auto-unlock-lease-revoke/v1|<serverDomain>|<leaseId>|<issuedAt>`. */
export function canonicalLeaseRevokeBytes({ serverDomain, leaseId, issuedAt }) {
  fieldGuard("serverDomain", serverDomain);
  fieldGuard("leaseId", leaseId);
  return new TextEncoder().encode([TAG_AUTO_UNLOCK_LEASE_REVOKE, serverDomain, leaseId, issuedAt].join("|"));
}

/** The active leases' metadata (`.com` never returns the sealed key here). */
export async function listLeases(serverFqdn, deps = {}) {
  const f = deps.fetch || fetch;
  const r = await f(`${deps.comBase || controlApex()}/api/server/${encodeURIComponent(serverFqdn)}/unlock-key/leases-v2`);
  if (!r.ok) throw new Error(`list leases failed: ${r.status}`);
  const body = await r.json();
  return Array.isArray(body.leases) ? body.leases : [];
}

/**
 * Deposit a box-sealed lease so the box can unlock itself on reboot until it
 * expires. Calling it again before then extends auto-unlock.
 */
export async function enableLongLived(serverFqdn, ttlMs = DEFAULT_LONG_TTL_MS, deps = {}) {
  const session = deps.session || getSession();
  if (!session?.umk) throw new Error("unlock first");
  const f = deps.fetch || fetch;
  const comBase = deps.comBase || controlApex();
  const sign = deps.signWithIrk || defaultSignWithIrk;
  const now = (deps.now || Date.now)();

  // 1. The box's STK, from the directory: the only key the lease may seal for.
  const stkPubHex = await (deps.boxStk || directoryStk)(serverFqdn, session, { fetch: f, comBase });
  if (!stkPubHex) throw new Error(`${serverFqdn} isn't in your account's server list`);

  // 2. The disk key `.com` holds sealed for this account's IRK.
  const sealedRes = await f(`${comBase}/api/server/${encodeURIComponent(serverFqdn)}/sealed-luks-key`);
  if (!sealedRes.ok) throw new Error(`no sealed key on file for ${serverFqdn}: ${sealedRes.status}`);
  const luksKey = await openSealedWithIrk(session.umk, hexToBytes((await sealedRes.json()).sealedKey));

  // 3. Re-seal it FOR the box, then sign the lease that pins the box.
  const sealedKeyHex = bytesToHex(await (deps.sealForStk || sealForEd25519Pub)(luksKey, hexToBytes(stkPubHex)));
  const lease = {
    serverDomain: serverFqdn,
    stkPub: stkPubHex,
    leaseId: bytesToHex(randomBytes(16)),
    sealedKey: sealedKeyHex,
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
  const sig = await sign(
    session.umk,
    canonicalLeaseV2Bytes({ ...lease, stkPubHex: lease.stkPub, sealedKeyHex: lease.sealedKey }),
  );
  const r = await f(`${comBase}/api/server/${encodeURIComponent(serverFqdn)}/unlock-key/lease-v2`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lease, signature: bytesToHex(sig) }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`deposit lease failed: ${r.status} ${txt}`.trim());
  }
  return { leaseId: lease.leaseId, expiresAt: lease.expiresAt };
}

/** Sign + DELETE a lease: the box needs an approval on its next boot. */
export async function revokeLease(serverFqdn, leaseId, deps = {}) {
  const session = deps.session || getSession();
  if (!session?.umk) throw new Error("unlock first");
  const f = deps.fetch || fetch;
  const sign = deps.signWithIrk || defaultSignWithIrk;
  const request = { serverDomain: serverFqdn, leaseId, issuedAt: (deps.now || Date.now)() };
  const sig = await sign(session.umk, canonicalLeaseRevokeBytes(request));
  const r = await f(
    `${deps.comBase || controlApex()}/api/server/${encodeURIComponent(serverFqdn)}/unlock-key/lease-v2/${encodeURIComponent(leaseId)}`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request, signature: bytesToHex(sig) }),
    },
  );
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`revoke lease failed: ${r.status} ${txt}`.trim());
  }
  return r.json();
}

/**
 * Re-deposit on `serverFqdn` when its newest lease has less than `windowMs`
 * left. Silent (the IRK is in the unlocked session); a server with no lease
 * (auto-unlock off) or one that can't be listed is left alone.
 */
export async function renewIfExpiringSoon(serverFqdn, windowMs = RENEW_WINDOW_MS, deps = {}) {
  const session = deps.session || getSession();
  if (!session?.umk) return [];
  let active;
  try {
    active = await (deps.listLeases || listLeases)(serverFqdn);
  } catch {
    return [];
  }
  if (active.length === 0) return [];
  const now = (deps.now || Date.now)();
  const newest = active.reduce((a, b) => (b.expiresAt > a.expiresAt ? b : a));
  if (newest.expiresAt - now > windowMs) return [];
  try {
    const r = await (deps.enableLongLived || enableLongLived)(serverFqdn);
    return [{ oldLeaseId: newest.leaseId, newLeaseId: r.leaseId, expiresAt: r.expiresAt }];
  } catch {
    return [];
  }
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

// ---- internals ----

/** The box's STK as the account's directory (`.com`'s /pods) lists it. */
async function directoryStk(serverFqdn, session, { fetch: f, comBase }) {
  const username = session.username;
  if (!username) return null;
  const r = await accountReadFetch(`${comBase}/api/users/${encodeURIComponent(username)}/pods`, { cache: "no-store" }, { fetch: f, baseUrl: comBase });
  if (!r.ok) throw new Error(`couldn't read your server list: ${r.status}`);
  const want = serverFqdn.toLowerCase();
  const pod = ((await r.json()).pods ?? []).find(
    (p) => String(p.serverDomain ?? "").toLowerCase() === want && p.revokedAt == null,
  );
  const stk = String(pod?.identityPubKey ?? "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(stk) ? stk : null;
}

function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/**
 * Seal `plaintext` FOR an Ed25519 public key (sealForEd25519Recipient):
 * the key's X25519 form, ECDH with a fresh ephemeral X25519 key,
 * HKDF-SHA256(salt = ephemeral pub, info = "flagship.seal.v1"), AES-GCM.
 * Returns [ephemeral X25519 pub:32][nonce:12][ct+tag].
 */
export async function sealForEd25519Pub(plaintext, edPub) {
  const recipKey = await crypto.subtle.importKey("raw", ed25519PubToX25519(edPub), "X25519", false, []);
  const eph = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const ephPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: recipKey }, eph.privateKey, 256);
  const hk = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const sym = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: ephPub, info: new TextEncoder().encode("flagship.seal.v1") },
    hk,
    256,
  );
  const aesKey = await crypto.subtle.importKey("raw", sym, { name: "AES-GCM" }, false, ["encrypt"]);
  const nonce = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext));
  const out = new Uint8Array(32 + 12 + ct.length);
  out.set(ephPub, 0);
  out.set(nonce, 32);
  out.set(ct, 44);
  return out;
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
export async function openSealedWithIrk(umkSeed, blob) {
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
  const myKey = await importX25519Private(x25519Priv);
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
