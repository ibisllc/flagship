/**
 * The issuance service's rules that need no storage (docs/architecture-v2/issuance-service.md): which names a class
 * gets, whether a CSR asks for exactly those, whether a returned chain is the certificate that was ordered, when a
 * certificate is due for renewal, and the limits kept below Let's Encrypt's.
 */
import type { CertificateClass } from "@flagship/protocol";
import {
  DerError,
  sameBytes,
  parseCertificate,
  parseCsr,
  pemBlocks,
  verifyX509Signature,
  type KeyKind,
  type ParsedCsr,
} from "./x509.js";

export type IssuanceRefusal =
  | "issuance-malformed"
  | "issuance-clock"
  | "issuance-signature"
  | "issuance-unknown-device"
  | "issuance-revoked"
  | "issuance-reg-gen"
  | "issuance-not-admin"
  | "issuance-no-serving"
  | "issuance-wildcard-grant"
  | "issuance-csr-signature"
  | "issuance-csr-key"
  | "issuance-csr-names"
  | "issuance-request-reused"
  | "issuance-not-due"
  | "issuance-rate-limited"
  | "issuance-not-configured"
  | "issuance-acme-failed"
  | "issuance-timeout"
  | "issuance-revoked-during-order"
  | "issuance-chain-mismatch"
  | "issuance-superseded"
  | "issuance-direct-name";

/** The names of a class, sorted. `server` is the box's leftmost label; `accountWildcard` adds `*.<user>`. */
export function issuanceNames(o: { class: CertificateClass; account: string; apex: string; server?: string; accountWildcard?: boolean }): string[] {
  const zone = `${o.account}.${o.apex}`.toLowerCase();
  if (o.class === "phone") return [zone];
  if (!o.server) throw new Error("a box class needs the server label");
  const control = `${o.server}.${zone}`.toLowerCase();
  if (o.class === "control") return [control];
  return (o.accountWildcard ? [`*.${control}`, `*.${zone}`] : [`*.${control}`]).sort();
}

/** The leftmost label of a box name under `<user>.<apex>`, or null when the name is not exactly one label deeper. */
export function serverLabelOf(serverDomain: string, account: string, apex: string): string | null {
  const suffix = `.${account}.${apex}`.toLowerCase();
  const d = serverDomain.toLowerCase();
  if (!d.endsWith(suffix)) return null;
  const label = d.slice(0, -suffix.length);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) ? label : null;
}

export const namesKey = (names: readonly string[]): string => [...names].map((n) => n.toLowerCase()).sort().join("\n");

function keyAllowed(k: KeyKind): boolean {
  return k.kind === "ec" || (k.bits >= 2048 && k.bits <= 4096 && k.bits % 8 === 0);
}

export type CsrCheck = { ok: true; csr: ParsedCsr; spkiSha256: string } | { ok: false; code: IssuanceRefusal };

/**
 * The CSR's own signature verifies, its key is one we allow, and it names exactly `names` (no IP or other names, no
 * name twice, a subject CN only if it is one of them). The digest the order signed is the CSR's.
 */
export async function checkCsr(der: Uint8Array, csrSha256Hex: string, names: readonly string[]): Promise<CsrCheck> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", der));
  if (toHex(digest) !== csrSha256Hex) return { ok: false, code: "issuance-csr-signature" };
  let csr: ParsedCsr;
  try {
    csr = parseCsr(der);
  } catch (e) {
    return { ok: false, code: e instanceof DerError && /curve|key algorithm/.test(e.message) ? "issuance-csr-key" : "issuance-malformed" };
  }
  if (!keyAllowed(csr.publicKey.key)) return { ok: false, code: "issuance-csr-key" };
  if (!(await verifyX509Signature(csr.publicKey, csr.signatureAlgorithm, csr.info, csr.signature))) return { ok: false, code: "issuance-csr-signature" };
  if (!sameNames(csr.sans, names)) return { ok: false, code: "issuance-csr-names" };
  const want = new Set(names.map((n) => n.toLowerCase()));
  if (csr.commonNames.length > 1 || csr.commonNames.some((cn) => !want.has(cn.toLowerCase()))) return { ok: false, code: "issuance-csr-names" };
  const spki = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", csr.publicKey.spki));
  return { ok: true, csr, spkiSha256: toHex(spki) };
}

function sameNames(sans: ParsedCsr["sans"], names: readonly string[]): boolean {
  if (sans.some((s) => s.type !== "dns")) return false;
  const got = sans.map((s) => (s as { value: string }).value.toLowerCase());
  if (new Set(got).size !== got.length) return false;
  return namesKey(got) === namesKey(names);
}

export type ChainCheck = { ok: true; notBefore: number; notAfter: number; leafDer: Uint8Array } | { ok: false; leafDer: Uint8Array | null; why: string };

/**
 * The chain the CA returned is the certificate ordered: the leaf names exactly `names`, carries the CSR's key, is in
 * date, and each certificate is signed by the next one with matching issuer and subject.
 */
export async function checkChain(pem: string, names: readonly string[], csrSpki: Uint8Array, now: number): Promise<ChainCheck> {
  const ders = pemBlocks(pem);
  const leafDer = ders[0] ?? null;
  if (!leafDer || ders.length < 2) return { ok: false, leafDer, why: "the chain has no issuer" };
  try {
    const certs = ders.map(parseCertificate);
    const leaf = certs[0]!;
    if (!sameBytes(leaf.publicKey.spki, csrSpki)) return { ok: false, leafDer, why: "the leaf is not for the requested key" };
    if (!sameNames(leaf.sans, names)) return { ok: false, leafDer, why: "the leaf does not name exactly the ordered names" };
    if (leaf.notBefore > now + 5 * 60_000 || leaf.notAfter <= now) return { ok: false, leafDer, why: "the leaf is not in date" };
    for (let i = 0; i + 1 < certs.length; i++) {
      const c = certs[i]!;
      const issuer = certs[i + 1]!;
      if (!sameBytes(c.issuer, issuer.subject)) return { ok: false, leafDer, why: `certificate ${i} does not name the next as issuer` };
      if (!(await verifyX509Signature(issuer.publicKey, c.signatureAlgorithm, c.tbs, c.signature))) return { ok: false, leafDer, why: `certificate ${i} is not signed by the next` };
    }
    return { ok: true, notBefore: leaf.notBefore, notAfter: leaf.notAfter, leafDer };
  } catch (e) {
    return { ok: false, leafDer, why: `unreadable chain: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** A certificate is due from the start of its last third. */
export function renewalDueAt(cert: { notBefore: number; notAfter: number }): number {
  return cert.notAfter - Math.floor((cert.notAfter - cert.notBefore) / 3);
}

/** Limits kept below Let's Encrypt's (https://letsencrypt.org/docs/rate-limits/). */
export const ISSUANCE_LIMITS = {
  /** Certificates for one exact name set per 7 days (LE: 5). */
  perNameSetPerWeek: 4,
  /** Certificates per account zone `<user>.<apex>` per 7 days (LE: 50 per registered domain; the apex is a public suffix). */
  perZonePerWeek: 40,
  /** New ACME orders by the service per 3 hours (LE: 300 per account). */
  serviceOrdersPer3h: 250,
  /** Of those, what orders that are not a due renewal may use: the rest is kept for renewals, so a burst of new or
   *  abandoned orders can never stop certificates already in use from renewing. */
  serviceNewOrdersPer3h: 150,
  /** Orders per Flagship account per day (our own budget, so one account cannot drain the service's). */
  perAccountPerDay: 20,
  /** Orders the CA saw that ended without a certificate (superseded, timed out, failed) per account per day: a
   *  device that keeps replacing or abandoning orders stops here instead of spending the service's budget. */
  perAccountAbandonedOrdersPerDay: 5,
  /** Failed validations per name set per hour (LE: 5 per identifier per account). */
  failuresPerNameSetPerHour: 3,
  /** How long a `rateLimited` answer from the CA stops every order, at least. */
  caBackoffMinMs: 60 * 60_000,
  /** One new key per class per this window may renew early. */
  rekeyWindowMs: 30 * 86_400_000,
} as const;

export const WEEK_MS = 7 * 86_400_000;
export const ORDER_TIMEOUT_MS = 15 * 60_000;
export const ISSUED_KEPT_MS = 7 * 86_400_000;
export const CLOCK_SKEW_MS = 5 * 60_000;

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
