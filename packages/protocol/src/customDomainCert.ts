/**
 * Custom-domain cert domain (#79B) — the fleet-scoped TLS cert + private key
 * for a user's external domain (sibling-sync transport only), plus the
 * `authorStableId` helper used across the service-canonical naming.
 *
 * Extracted verbatim from the original monolithic `auth.ts`; tag, field
 * order (PEMs hashed, not inlined), and validators are unchanged, so
 * canonical bytes and signatures remain byte-identical.
 */
import { ed } from "./edSync.js";
import { hex } from "./canonicalBase.js";
import type { Bytes, Keypair } from "./types.js";

// ──────────────────────────────────────────────────────────────────────
// CustomDomainCert (#79B / Phase 4 C4.1c)
//
// The fleet-scoped TLS cert + private key for a user's custom (external)
// domain. The LEAD pod runs ACME (TLS-ALPN-01 over the SNI-passthrough
// chain) and replicates this bundle to the user's OTHER pods over the
// authenticated sibling-sync channel ONLY — NEVER peerBackup/peerLink
// (that is a stranger mesh; the private key leaving it would be
// catastrophic to the privacy model). The cert is born on the pod
// (no IRK there), so the bundle is signed by the ISSUING POD's
// identity (STK) key; the receiver verifies it under a pod identity
// the sibling-sync layer has already authenticated as a member of
// this user's fleet (the sync hello binds pod identities to the
// user's IRK via PodIdentityBinding). Sign/verify are key-agnostic
// Ed25519 — the policy of which key signs lives in the daemon's
// customDomainCert module. The canonical bytes hash the PEMs (they
// contain newlines, unsafe for the '|' separator scheme) — async,
// mirroring appGrantId.
// ──────────────────────────────────────────────────────────────────────

export interface CustomDomainCert {
  /** Username at issuance time. */
  username: string;
  /** The custom FQDN this cert is for (lower-case, e.g. shop.example.com). */
  fqdn: string;
  /** PEM certificate chain. */
  certPem: string;
  /** PEM private key — the crown jewel; sibling-sync transport only. */
  privateKeyPem: string;
  /** RFC 5280 NotAfter, ms epoch. */
  notAfter: number;
  /** ms epoch — the fresher-cert-wins key (strictly-greater replaces). */
  issuedAt: number;
}

const TAG_CUSTOM_DOMAIN_CERT = "flagship/custom-domain-cert/v1";

function validateCustomDomainCertFields(c: CustomDomainCert): void {
  for (const [name, value] of [
    ["username", c.username],
    ["fqdn", c.fqdn],
  ] as Array<[string, string]>) {
    for (let i = 0; i < value.length; i++) {
      const ch = value.charCodeAt(i);
      if (ch === 0x7c) throw new Error(`CustomDomainCert field "${name}" contains separator '|'`);
      if (ch <= 0x1f || ch === 0x7f) {
        throw new Error(`CustomDomainCert field "${name}" contains control char 0x${ch.toString(16)}`);
      }
    }
  }
  if (c.username.length === 0 || c.fqdn.length === 0) {
    throw new Error("CustomDomainCert: username and fqdn are required");
  }
  if (c.certPem.length === 0 || c.privateKeyPem.length === 0) {
    throw new Error("CustomDomainCert: certPem and privateKeyPem are required");
  }
  if (c.notAfter <= c.issuedAt) {
    throw new Error("CustomDomainCert: notAfter must be strictly after issuedAt");
  }
}

async function canonicalCustomDomainCert(c: CustomDomainCert): Promise<Bytes> {
  validateCustomDomainCertFields(c);
  const enc = new TextEncoder();
  const certHash = hex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(c.certPem))),
  );
  const keyHash = hex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(c.privateKeyPem))),
  );
  return enc.encode(
    [
      TAG_CUSTOM_DOMAIN_CERT,
      c.username,
      c.fqdn.toLowerCase(),
      c.notAfter,
      c.issuedAt,
      certHash,
      keyHash,
    ].join("|"),
  );
}

export async function signCustomDomainCert(c: CustomDomainCert, irk: Keypair): Promise<Bytes> {
  return ed.sign(await canonicalCustomDomainCert(c), irk.privateKey);
}

export async function verifyCustomDomainCert(
  c: CustomDomainCert,
  sig: Bytes,
  irkPub: Bytes,
): Promise<boolean> {
  try {
    return ed.verify(sig, await canonicalCustomDomainCert(c), irkPub);
  } catch {
    return false;
  }
}

export function customDomainCertActiveAt(c: CustomDomainCert, now: number): boolean {
  return now >= c.issuedAt && now < c.notAfter;
}

/**
 * Derive the author stable ID (12-char SHA-256 prefix) from an IRK
 * pubkey. The author identifier is what survives username renames.
 */
export async function authorStableId(authorIrkPub: Bytes): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", authorIrkPub);
  return hex(new Uint8Array(digest).slice(0, 6)); // 6 bytes = 12 hex chars
}
