/**
 * Sealed CGK-delivery envelope (docs/multi-pod-liveness-session-leadership.md,
 * Phase 6) — the EXACT twin of the SWK delivery (swkDelivery.ts), only the
 * payload + tag differ.
 *
 * The secret-free recipe carries NO Cloud Gossip Key (CGK). A box boots, runs
 * gossip ONLY if it has a CGK (else gossip stays disabled — no brick), so per-
 * service leadership is dark on a real box until the CGK arrives. This module is
 * the cryptographic envelope for that post-boot hand-off: the owner's phone seals
 * the 32-byte CGK to the box identity (the registered STK, X25519 conversion) and
 * IRK-signs the wrapper, then deposits it into the `.com` content-blind `cgk-deposit`
 * lane. `.com` and any relay see ciphertext only (I1/I3) — the CGK is a SECRET (it
 * authenticates + transports the gossip frame between siblings), so it is SEALED
 * for the box identity X25519 key exactly like the SWK.
 *
 * Wire shape (the deposited carrier, UTF-8 JSON):
 *
 *   {
 *     "serverDomain": "<box FQDN>",
 *     "sealed":       "<hex of sealForEd25519Recipient(cgk, boxIdentityPub)>",
 *     "issuedAt":     <ms epoch>,
 *     "signature":    "<hex Ed25519 over the canonical bytes, by the owner IRK>"
 *   }
 *
 * Canonical bytes signed by the owner IRK (so a relay/`.com` cannot substitute a
 * different box's blob or re-target the delivery, and the box knows it's from the
 * owner):
 *
 *   flagship/cgk-delivery/v1|<serverDomain>|<hex(sealed)>|<issuedAt>
 *
 * `seal`/`build` is the phone side (signs with the IRK + seals to the box X25519
 * pub, derived from its Ed25519 identity pub via the standard birational map).
 * `openAndVerify` is the box side: verify the IRK signature under the
 * config-pinned owner IRK, THEN unseal with the box identity X25519 priv (its
 * Ed25519 seed) → the 32-byte CGK. Verify is NEVER-THROWING (returns null on any
 * bad input) — matching the repo's other verify helpers and swkDelivery exactly.
 */
import { ed } from "./edSync.js";
import { hex, legacyFieldGuard } from "./canonicalBase.js";
import { sealForEd25519Recipient, openSealedFromEd25519Recipient } from "./encryption.js";
import type { Bytes, Keypair } from "./types.js";

const TAG_CGK_DELIVERY = "flagship/cgk-delivery/v1";

/** The signed (but not yet hex-serialized) envelope. */
export interface CgkDelivery {
  /** Box FQDN the CGK is for (binds the delivery to one box). */
  serverDomain: string;
  /**
   * The CGK SEALED for the box identity (output of `sealForEd25519Recipient`):
   * `[eph_x25519_pub:32][nonce:12][ciphertext+tag:var]`. Hex on the wire.
   */
  sealed: Bytes;
  /** ms since epoch when the phone minted this delivery. */
  issuedAt: number;
}

function canonicalCgkDelivery(d: CgkDelivery): Bytes {
  legacyFieldGuard("serverDomain", d.serverDomain);
  return new TextEncoder().encode(
    [TAG_CGK_DELIVERY, d.serverDomain, hex(d.sealed), d.issuedAt].join("|"),
  );
}

/** Sign an already-sealed CGK delivery with the owner IRK. */
export function signCgkDelivery(d: CgkDelivery, irk: Keypair): Bytes {
  return ed.sign(canonicalCgkDelivery(d), irk.privateKey);
}

/** Never-throwing verify of the owner-IRK signature over the delivery. */
export function verifyCgkDelivery(d: CgkDelivery, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalCgkDelivery(d), irkPub);
  } catch {
    return false;
  }
}

/**
 * PHONE side. Seal the 32-byte CGK to the box's Ed25519 identity pubkey (sealed
 * to its X25519 conversion under the hood) and IRK-sign the wrapper binding
 * `(serverDomain, sealed, issuedAt)`. Returns the signed envelope + its
 * signature; the caller hex-serializes them into the deposit carrier
 * (`cgkDeliveryToCarrierHex`).
 */
export function buildCgkDelivery(args: {
  serverDomain: string;
  /** The raw 32-byte CGK (= deriveCGK(umk.seed)). */
  cgk: Bytes;
  /** The box's Ed25519 identity pubkey (serverIdentityPubKey), 32 bytes. */
  boxIdentityPub: Bytes;
  /** The owner's IRK keypair (signs the wrapper). */
  irk: Keypair;
  issuedAt: number;
}): { delivery: CgkDelivery; signature: Bytes } {
  if (args.cgk.length !== 32) {
    throw new Error("CGK must be 32 bytes");
  }
  if (args.boxIdentityPub.length !== 32) {
    throw new Error("box identity pubkey must be 32 bytes");
  }
  const sealed = sealForEd25519Recipient(args.cgk, args.boxIdentityPub);
  const delivery: CgkDelivery = {
    serverDomain: args.serverDomain,
    sealed,
    issuedAt: args.issuedAt,
  };
  const signature = signCgkDelivery(delivery, args.irk);
  return { delivery, signature };
}

/**
 * BOX side. Given a deposited carrier (the parsed `{serverDomain, sealed,
 * issuedAt, signature}`), verify the owner-IRK signature under the
 * config-pinned owner IRK and — only if it verifies — unseal the CGK with the
 * box's Ed25519 identity SEED (its private key). Returns the 32-byte CGK, or
 * `null` on ANY defect (bad signature, wrong owner, unseal failure, wrong size).
 * NEVER throws — a forged/mismatched/junk delivery is simply rejected so the
 * caller keeps polling (never bricks, never persists garbage).
 */
export function openAndVerifyCgkDelivery(args: {
  delivery: CgkDelivery;
  signature: Bytes;
  /** The config-pinned owner IRK pubkey — the only trust anchor. */
  ownerIrkPub: Bytes;
  /** The box's Ed25519 identity SEED (its 32-byte private key). Legacy form;
   *  prefer `unsealToBox`. */
  boxIdentityPriv?: Bytes;
  /** Custodian-backed unseal — used instead of `boxIdentityPriv` when present,
   *  so the raw seed never surfaces. Exactly one must be supplied. */
  unsealToBox?: (blob: Bytes) => Bytes;
  /** Expected box FQDN — the delivery must name THIS box. */
  serverDomain: string;
}): Bytes | null {
  try {
    if (args.delivery.serverDomain.toLowerCase() !== args.serverDomain.toLowerCase()) {
      return null;
    }
    if (!verifyCgkDelivery(args.delivery, args.signature, args.ownerIrkPub)) {
      return null;
    }
    const unseal =
      args.unsealToBox ??
      (args.boxIdentityPriv
        ? (blob: Bytes) => openSealedFromEd25519Recipient(blob, args.boxIdentityPriv!)
        : null);
    if (!unseal) return null;
    const cgk = unseal(args.delivery.sealed);
    if (cgk.length !== 32) return null;
    return cgk;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Carrier (de)serialization — the hex-JSON form deposited on `.com` (the
// `secret_mailbox` `purpose:"cgk"` lane's `sealedHex`). The carrier is itself
// hex-encoded UTF-8 JSON so the existing deposit lane (a single hex column)
// transports it unchanged, exactly like the SWK/self-delete/entitlement carriers.
// ──────────────────────────────────────────────────────────────────────

const HEX = /^[0-9a-f]*$/;

function bytesToHex(b: Bytes): string {
  return hex(b);
}

function hexToBytes(h: string): Bytes {
  if (h.length % 2 !== 0) throw new Error("hex must have even length");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Phone side: turn a built delivery + signature into the hex carrier the deposit
 * lane stores (the `sealedHex` of the `purpose:"cgk"` row).
 */
export function cgkDeliveryToCarrierHex(delivery: CgkDelivery, signature: Bytes): string {
  const json = JSON.stringify({
    serverDomain: delivery.serverDomain,
    sealed: bytesToHex(delivery.sealed),
    issuedAt: delivery.issuedAt,
    signature: bytesToHex(signature),
  });
  return bytesToHex(new TextEncoder().encode(json));
}

/**
 * Box side: parse the deposited carrier hex back into the delivery + signature.
 * Returns null on ANY defect (not hex / not UTF-8 / not JSON / missing or
 * mis-typed fields) — never throws. The caller then runs `openAndVerifyCgkDelivery`.
 */
export function carrierHexToCgkDelivery(
  carrierHex: string,
): { delivery: CgkDelivery; signature: Bytes } | null {
  try {
    const h = carrierHex.toLowerCase();
    if (!HEX.test(h) || h.length === 0 || h.length % 2 !== 0) return null;
    let json: string;
    try {
      json = new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(h));
    } catch {
      return null;
    }
    const p = JSON.parse(json) as {
      serverDomain?: unknown;
      sealed?: unknown;
      issuedAt?: unknown;
      signature?: unknown;
    };
    if (
      typeof p.serverDomain !== "string" ||
      typeof p.sealed !== "string" ||
      typeof p.issuedAt !== "number" ||
      typeof p.signature !== "string" ||
      !HEX.test(p.sealed.toLowerCase()) ||
      !HEX.test(p.signature.toLowerCase()) ||
      p.sealed.length % 2 !== 0 ||
      p.signature.length % 2 !== 0
    ) {
      return null;
    }
    return {
      delivery: {
        serverDomain: p.serverDomain,
        sealed: hexToBytes(p.sealed.toLowerCase()),
        issuedAt: p.issuedAt,
      },
      signature: hexToBytes(p.signature.toLowerCase()),
    };
  } catch {
    return null;
  }
}
