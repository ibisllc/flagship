import { legacyFieldGuard } from "./auth.js";
import { ed } from "./edSync.js";
import type { Bytes, Keypair, ServerId } from "./types.js";

/**
 * Tier-2 shared service certs (cert model A′, Phase 5).
 *
 * A tier-2 name `<service>.<user>.flagship.services` is leader-routed and
 * hardware-agnostic, so no per-box wildcard covers it. The cert for it is
 * minted ONCE under PHONE (IRK) authority and shared with exactly the boxes
 * that serve the service. Four envelopes carry that authority:
 *
 *   - {@link ServiceCertAuthority} — the phone's short-TTL grant letting ONE
 *     named box publish the DNS-01 challenge for ONE service FQDN. The box
 *     forwards it with its DNS-01 publish; `.com`/the broker verify the IRK
 *     signature, that the requesting box IS `boxServerId`, and that the
 *     challenge name matches `serviceFqdn`.
 *   - {@link ServiceCertMintRequest} — phone → box over the box's canonical
 *     pinned pipe: "run your ACME machinery for this service FQDN".
 *   - {@link ServiceCertExportRequest} — phone → minting box: hand me the
 *     cert + key PEMs (the pinned pipe is the confidentiality envelope).
 *   - {@link ServiceCertInstall} — phone → another serving box: here are the
 *     PEMs; serve this FQDN. The signature commits to sha256 of each PEM so
 *     a relay can't swap material against a captured signature.
 *
 * `.com` is NEVER in the key path: the key is born on the minting box and
 * travels phone↔box over each box's own pinned `<server>.<user>` HTTPS.
 */

const TAG_SERVICE_CERT_AUTHORITY = "flagship/service-cert-authority/v1";
const TAG_SERVICE_CERT_MINT = "flagship/service-cert-mint/v1";
const TAG_SERVICE_CERT_EXPORT = "flagship/service-cert-export/v1";
const TAG_SERVICE_CERT_INSTALL = "flagship/service-cert-install/v1";

/**
 * Longest grant the verifiers accept (`expiresAt - issuedAt`). One ACME
 * order needs minutes; an hour absorbs propagation waits + retries while
 * keeping a captured grant useless by the time anyone replays it.
 */
export const SERVICE_CERT_AUTHORITY_MAX_TTL_MS = 60 * 60_000;

export interface ServiceCertAuthority {
  username: string;
  /** `<service>.<user>.flagship.services` — the ONE name this grant covers. */
  serviceFqdn: string;
  /** The ONE box allowed to publish the challenge under this grant. */
  boxServerId: ServerId;
  issuedAt: number;
  expiresAt: number;
}

export interface ServiceCertMintRequest {
  username: string;
  serviceFqdn: string;
  /** The box being asked to mint — must be the receiving daemon's own FQDN. */
  serverId: ServerId;
  issuedAt: number;
}

export interface ServiceCertExportRequest {
  username: string;
  serviceFqdn: string;
  serverId: ServerId;
  issuedAt: number;
}

export interface ServiceCertInstall {
  username: string;
  serviceFqdn: string;
  serverId: ServerId;
  /** sha256 of the certPem riding in the request body (32 bytes). */
  certPemSha256: Bytes;
  /** sha256 of the keyPem riding in the request body (32 bytes). */
  keyPemSha256: Bytes;
  /** Cert expiry (ms epoch) — signed so the daemon needn't parse the cert. */
  notAfter: number;
  issuedAt: number;
}

function hex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function canonicalServiceCertAuthority(a: ServiceCertAuthority): Bytes {
  legacyFieldGuard("username", a.username);
  legacyFieldGuard("serviceFqdn", a.serviceFqdn);
  legacyFieldGuard("boxServerId", a.boxServerId);
  return new TextEncoder().encode(
    [
      TAG_SERVICE_CERT_AUTHORITY,
      a.username,
      a.serviceFqdn,
      a.boxServerId,
      a.issuedAt,
      a.expiresAt,
    ].join("|"),
  );
}

function canonicalServiceCertMint(r: ServiceCertMintRequest): Bytes {
  legacyFieldGuard("username", r.username);
  legacyFieldGuard("serviceFqdn", r.serviceFqdn);
  legacyFieldGuard("serverId", r.serverId);
  return new TextEncoder().encode(
    [TAG_SERVICE_CERT_MINT, r.username, r.serviceFqdn, r.serverId, r.issuedAt].join("|"),
  );
}

function canonicalServiceCertExport(r: ServiceCertExportRequest): Bytes {
  legacyFieldGuard("username", r.username);
  legacyFieldGuard("serviceFqdn", r.serviceFqdn);
  legacyFieldGuard("serverId", r.serverId);
  return new TextEncoder().encode(
    [TAG_SERVICE_CERT_EXPORT, r.username, r.serviceFqdn, r.serverId, r.issuedAt].join("|"),
  );
}

function canonicalServiceCertInstall(r: ServiceCertInstall): Bytes {
  legacyFieldGuard("username", r.username);
  legacyFieldGuard("serviceFqdn", r.serviceFqdn);
  legacyFieldGuard("serverId", r.serverId);
  return new TextEncoder().encode(
    [
      TAG_SERVICE_CERT_INSTALL,
      r.username,
      r.serviceFqdn,
      r.serverId,
      hex(r.certPemSha256),
      hex(r.keyPemSha256),
      r.notAfter,
      r.issuedAt,
    ].join("|"),
  );
}

export function signServiceCertAuthority(a: ServiceCertAuthority, irk: Keypair): Bytes {
  return ed.sign(canonicalServiceCertAuthority(a), irk.privateKey);
}
export function verifyServiceCertAuthority(
  a: ServiceCertAuthority,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalServiceCertAuthority(a), irkPub);
  } catch {
    return false;
  }
}

export function signServiceCertMint(r: ServiceCertMintRequest, irk: Keypair): Bytes {
  return ed.sign(canonicalServiceCertMint(r), irk.privateKey);
}
export function verifyServiceCertMint(
  r: ServiceCertMintRequest,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalServiceCertMint(r), irkPub);
  } catch {
    return false;
  }
}

export function signServiceCertExport(r: ServiceCertExportRequest, irk: Keypair): Bytes {
  return ed.sign(canonicalServiceCertExport(r), irk.privateKey);
}
export function verifyServiceCertExport(
  r: ServiceCertExportRequest,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalServiceCertExport(r), irkPub);
  } catch {
    return false;
  }
}

export function signServiceCertInstall(r: ServiceCertInstall, irk: Keypair): Bytes {
  return ed.sign(canonicalServiceCertInstall(r), irk.privateKey);
}
export function verifyServiceCertInstall(
  r: ServiceCertInstall,
  sig: Bytes,
  irkPub: Bytes,
): boolean {
  try {
    return ed.verify(sig, canonicalServiceCertInstall(r), irkPub);
  } catch {
    return false;
  }
}

const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Parse a tier-2 service FQDN: exactly `<service>.<username>.<apex>` —
 * ONE service label, ONE user label. Returns null for the user-zone apex,
 * box names (`<server>.<user>`, which this shape can't distinguish — callers
 * MUST additionally reject their own/box FQDNs where it matters), deeper
 * hierarchies (`x.<server>.<user>`), and anything outside the apex.
 */
export function parseTier2ServiceFqdn(
  fqdn: string,
  apex = "flagship.services",
): { service: string; username: string } | null {
  const lower = fqdn.toLowerCase();
  const suffix = `.${apex.toLowerCase()}`;
  if (!lower.endsWith(suffix)) return null;
  const head = lower.slice(0, -suffix.length);
  const labels = head.split(".");
  if (labels.length !== 2) return null;
  const [service, username] = labels as [string, string];
  if (!LABEL_RE.test(service) || !LABEL_RE.test(username)) return null;
  return { service, username };
}

/**
 * Shared time-validity gate for a {@link ServiceCertAuthority} — used
 * identically by `.com`, the broker, and the daemon so a grant can never be
 * valid at one verifier and expired at another. `skewMs` tolerates clock
 * drift on `issuedAt` (a grant from a slightly-fast phone still verifies).
 */
export function serviceCertAuthorityValidAt(
  a: ServiceCertAuthority,
  now: number,
  skewMs = 5 * 60_000,
): boolean {
  if (!Number.isFinite(a.issuedAt) || !Number.isFinite(a.expiresAt)) return false;
  if (a.expiresAt <= a.issuedAt) return false;
  if (a.expiresAt - a.issuedAt > SERVICE_CERT_AUTHORITY_MAX_TTL_MS) return false;
  if (a.issuedAt > now + skewMs) return false;
  if (now > a.expiresAt) return false;
  return true;
}
