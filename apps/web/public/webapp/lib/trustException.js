// TrustException — the owner-signed, per-cert override that un-sticks a box /
// app from a broken maintainer-trust situation
// (docs/maintainer-trust-enforcement.md "Recovery = owner-signed, per-cert
// exception"). It is:
//   - device-key-signed (the webapp signs with its IRK — the same device key
//     the rest of the webapp signs with);
//   - scoped to EXACTLY one cert-hash + cert-class;
//   - safe to route through a possibly-rogue `.com` (it can drop or replay it
//     but cannot forge it, and replaying "accept cert X" is harmless).
//
// Shared contract (identical across all surfaces):
//   TrustException = {
//     kind:"TrustException", version:1,
//     certClass:"control"|"relay", certHash,
//     grantedAt, grantedByDevicePub,
//     signatures:[{pubkey, sig}]
//   }
//   canonical tag flagship/trust-exception/v1
//   fields certClass|certHash|grantedAt|grantedByDevicePub  (sep "|")
//
// Override flow: tap a red sliver line → biometric/PIN gate (lib/pinLock.js on
// the webapp) → on success record + persist a signed TrustException + mark the
// cert overridden (calls resume; the sliver line stays). One acceptance per
// cert works fleet-wide via the sync below.

import {
  bytesToHex,
  hexToBytes,
  signWithIrk as ksSignWithIrk,
  deriveIrkFromSeed,
  verifyWithEd25519Pub,
} from "../keystore.js";

const APEX = "https://flagshipserver.com";
const TAG = "flagship/trust-exception/v1";

/** Reject "|" + control chars in a canonical field (defense-in-depth, mirrors
 *  the protocol's legacyFieldGuard). */
function safeField(name, value) {
  const s = String(value);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x7c) throw new Error(`${name} contains '|'`);
    if (c <= 0x1f || c === 0x7f) throw new Error(`${name} contains a control char`);
  }
  return s;
}

/** Canonical bytes: TAG|certClass|certHash|grantedAt|grantedByDevicePub. */
export function canonicalTrustException({ certClass, certHash, grantedAt, grantedByDevicePub }) {
  return new TextEncoder().encode(
    [
      TAG,
      safeField("certClass", certClass),
      safeField("certHash", certHash),
      safeField("grantedAt", grantedAt),
      safeField("grantedByDevicePub", grantedByDevicePub),
    ].join("|"),
  );
}

/**
 * Build + sign a TrustException with the device IRK. Returns the full envelope
 * (canonical + one signature by grantedByDevicePub).
 * @param {object} args
 *   args.umk         the unlocked UMK seed (Uint8Array)
 *   args.certClass   "control" | "relay"
 *   args.certHash    the failing cert-hash (control = sha256hex(utf8(caPubkey)))
 *   args.grantedAt   epoch ms (defaults to Date.now())
 * @param {object} [deps]  injection seam (tests)
 */
export async function buildSignedTrustException(args, deps = {}) {
  const signWithIrk = deps.signWithIrk ?? ksSignWithIrk;
  const irkOf = deps.deriveIrk ?? deriveIrkFromSeed;
  const certClass = args.certClass === "relay" ? "relay" : "control";
  const certHash = String(args.certHash || "");
  if (!/^[0-9a-f]{64}$/.test(certHash)) throw new Error("certHash must be 64-hex");
  const grantedAt = args.grantedAt ?? Date.now();

  const irk = await irkOf(args.umk);
  const grantedByDevicePub = bytesToHex(irk.publicKey);

  const canonical = canonicalTrustException({
    certClass,
    certHash,
    grantedAt,
    grantedByDevicePub,
  });
  const sig = await signWithIrk(args.umk, canonical);

  return {
    kind: "TrustException",
    version: 1,
    certClass,
    certHash,
    grantedAt,
    grantedByDevicePub,
    signatures: [{ pubkey: grantedByDevicePub, sig: bytesToHex(sig) }],
  };
}

/**
 * Verify a TrustException's self-signature (does the signature match the
 * declared grantedByDevicePub?). Authorization against the IRK-anchored device
 * set is a separate, caller-side check — this only proves the envelope is
 * well-formed + internally signed. Never throws → false.
 *
 * @param {object} ex  the TrustException envelope
 * @param {object} [deps]  { verifyEd25519 }
 */
export async function verifyTrustExceptionSelfSig(ex, deps = {}) {
  const verifyEd = deps.verifyEd25519 ?? verifyWithEd25519Pub;
  try {
    if (!ex || ex.kind !== "TrustException" || ex.version !== 1) return false;
    if (!/^[0-9a-f]{64}$/.test(ex.certHash || "")) return false;
    if (!/^[0-9a-f]{64}$/.test(ex.grantedByDevicePub || "")) return false;
    if (!Array.isArray(ex.signatures) || ex.signatures.length === 0) return false;
    const canonical = canonicalTrustException(ex);
    // The grantedByDevicePub MUST be among the signers and verify.
    const s = ex.signatures.find((x) => x?.pubkey === ex.grantedByDevicePub);
    if (!s || typeof s.sig !== "string") return false;
    return await verifyEd(hexToBytes(ex.grantedByDevicePub), hexToBytes(s.sig), canonical);
  } catch {
    return false;
  }
}

/* ---------- sync via the .com directory ---------- */
//
// One acceptance per cert works across the user's devices: a device that
// overrides POSTs the signed exception; every device GETs the set on boot and
// applies the ones whose self-sig verifies. `.com` is an untrusted carrier —
// it can drop/replay but not forge (the exception is device-key-signed +
// cert-hash-scoped). The contract endpoint is built by Worker A; this codes to
// it. These calls go through the .com chokepoint (the blessing endpoint having
// already established/refreshed trust) — but the exception SYNC must work even
// while untrusted (it's how recovery propagates), so it uses fetch directly
// against a path the global guard does NOT gate by host-equality alone:
// callers invoke it AFTER a local override (which flips isServerTrusted true
// for that cert), so the guard lets it through.

/**
 * POST a signed TrustException to the user's directory. Best-effort — a
 * failure does NOT undo the local override (the override is what un-sticks
 * THIS device; propagation is a convenience). Returns {ok, status}.
 */
export async function postTrustException(username, ex, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch?.bind(globalThis);
  const base = deps.base ?? APEX;
  if (!username || !fetchImpl) return { ok: false, status: 0 };
  try {
    const r = await fetchImpl(
      `${base}/api/users/${encodeURIComponent(username)}/trust-exceptions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ex),
      },
    );
    return { ok: r.ok, status: r.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/**
 * GET the user's existing TrustExceptions and return only those whose
 * self-signature verifies. Best-effort — a network failure returns []. The
 * caller applies the verified set to the trust store on boot.
 */
export async function fetchTrustExceptions(username, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch?.bind(globalThis);
  const base = deps.base ?? APEX;
  if (!username || !fetchImpl) return [];
  let body;
  try {
    const r = await fetchImpl(
      `${base}/api/users/${encodeURIComponent(username)}/trust-exceptions`,
      { headers: { accept: "application/json" } },
    );
    if (!r.ok) return [];
    body = await r.json();
  } catch {
    return [];
  }
  const list = Array.isArray(body) ? body : Array.isArray(body?.exceptions) ? body.exceptions : [];
  const verified = [];
  for (const ex of list) {
    if (await verifyTrustExceptionSelfSig(ex, deps)) verified.push(ex);
  }
  return verified;
}
