/**
 * Tier-2 shared service certs — the daemon side (cert model A′ Phase 5).
 *
 * Three phone→box endpoints on the box's canonical pinned HTTPS pipe
 * (mounted as `additionalHandlers`, like identityRotateHttp):
 *
 *   POST /api/service-certs/mint     — IRK-signed ServiceCertMintRequest +
 *       the phone's ServiceCertAuthority naming THIS box. Runs the box's
 *       ACME machinery for `[<service>.<user>.flagship.services]` with the
 *       authority forwarded on every DNS-01 publish/delete, persists the
 *       result, and serves it for that exact SNI.
 *   POST /api/service-certs/export   — IRK-signed ServiceCertExportRequest →
 *       `{ certPem, privateKeyPem }`. The pinned pipe is the confidentiality
 *       envelope; the IRK signature is the authorization.
 *   POST /api/service-certs/install  — IRK-signed ServiceCertInstall whose
 *       signature commits to sha256 of each PEM riding in the body. Persists
 *       + serves, so a second box can serve a cert minted on the first.
 *
 * The key never touches `.com`: it is born on the minting box and travels
 * phone↔box over each box's own `<server>.<user>` HTTPS.
 */

import { sha256 } from "@noble/hashes/sha256";
import {
  parseTier2ServiceFqdn,
  serviceCertAuthorityValidAt,
  verifyServiceCertAuthority,
  verifyServiceCertExport,
  verifyServiceCertInstall,
  verifyServiceCertMint,
  type Bytes,
  type ServiceCertAuthority,
  type ServiceCertExportRequest,
  type ServiceCertInstall,
  type ServiceCertMintRequest,
} from "@flagship/protocol";
import type { DnsChallengeWriter } from "./acme/letsEncryptIssuer.js";
import type { PersistedCert } from "./acme/persistentStore.js";
import type { CertManager } from "./certManager.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";

const J = { "content-type": "application/json" } as const;

/** The issuer surface this module needs — LetsEncryptIssuer satisfies it. */
export interface ServiceCertIssuer {
  issue(
    names: string[],
    perIssue?: { dns?: DnsChallengeWriter },
  ): Promise<{ certPem: string; privateKeyPem: string; notAfter: number }>;
}

/** The persistence surface this module needs — PersistentAcmeStore satisfies it. */
export interface ServiceCertPersistence {
  loadCert(fqdn: string): Promise<PersistedCert | null>;
  saveCert(
    fqdn: string,
    cert: { certPem: string; privateKeyPem: string; names: string[]; notAfter: number },
  ): Promise<void>;
}

export interface ServiceCertHttpDeps {
  /** This box's FQDN — must equal the authority's `boxServerId` and every request's `serverId`. */
  serverFqdn: string;
  /** The host user — must equal every envelope's `username`. */
  username: string;
  /** The host's IRK pubkey — the sole verification authority here. */
  irkPub: Bytes;
  issuer: ServiceCertIssuer;
  certManager: CertManager;
  /** Null when the daemon runs without a dataDir (in-memory only). */
  store: ServiceCertPersistence | null;
  /** Builds the per-issuance DNS-01 writer carrying the forwarded grant. */
  dnsWriterWithAuthority: (grant: {
    authority: ServiceCertAuthority;
    signature: Bytes;
  }) => DnsChallengeWriter;
  /** Default `flagship.services`. */
  apex?: string;
  /** Replay window for request `issuedAt`. Default 5 minutes. */
  maxAgeMs?: number;
  now?: () => number;
}

function jerr(status: number, error: string): HttpResponse {
  return { status, headers: J, body: JSON.stringify({ error }) };
}

function jok(body: unknown): HttpResponse {
  return { status: 200, headers: J, body: JSON.stringify(body) };
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) throw new Error("not hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function parseJson(body: Buffer): unknown | null {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
}

interface AuthorityWire {
  username?: unknown;
  serviceFqdn?: unknown;
  boxServerId?: unknown;
  issuedAt?: unknown;
  expiresAt?: unknown;
}

/**
 * Common fences for every envelope: it names THIS box (a capture for
 * box A can't be replayed at box B), THIS host user, a well-formed
 * tier-2 service FQDN under that user — and never the box's own apex
 * (`<server>.<user>` is also two labels, so parseTier2 alone can't
 * tell them apart; the protocol doc makes that rejection the caller's
 * job).
 */
function checkNames(
  deps: ServiceCertHttpDeps,
  r: { username: string; serviceFqdn: string; serverId: string },
): string | null {
  if (r.serverId !== deps.serverFqdn) return "serverId mismatch";
  if (r.username !== deps.username) return "username mismatch";
  const parsed = parseTier2ServiceFqdn(r.serviceFqdn, deps.apex ?? "flagship.services");
  if (!parsed || parsed.username !== r.username) {
    return "serviceFqdn is not a tier-2 name under this user";
  }
  if (r.serviceFqdn.toLowerCase() === deps.serverFqdn.toLowerCase()) {
    return "serviceFqdn is this box's own name";
  }
  return null;
}

export function buildServiceCertHandlers(deps: ServiceCertHttpDeps) {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? 5 * 60_000;
  // In-memory mirror of the persisted material so export works on a
  // storeless (no-dataDir) daemon within one process lifetime, and
  // without a disk round-trip otherwise.
  const memory = new Map<string, { certPem: string; privateKeyPem: string; notAfter: number }>();

  async function persistAndInstall(
    serviceFqdn: string,
    cert: { certPem: string; privateKeyPem: string; notAfter: number },
  ): Promise<void> {
    const key = serviceFqdn.toLowerCase();
    memory.set(key, cert);
    await deps.store?.saveCert(key, {
      certPem: cert.certPem,
      privateKeyPem: cert.privateKeyPem,
      names: [key],
      notAfter: cert.notAfter,
    });
    deps.certManager.installCustom(key, cert, cert.notAfter);
  }

  async function handleMint(body: unknown): Promise<HttpResponse> {
    const b = (body ?? {}) as {
      request?: { username?: unknown; serviceFqdn?: unknown; serverId?: unknown; issuedAt?: unknown };
      signature?: unknown;
      authority?: AuthorityWire;
      authoritySignature?: unknown;
    };
    const r = b.request ?? {};
    const a = b.authority ?? {};
    if (
      typeof r.username !== "string" ||
      typeof r.serviceFqdn !== "string" ||
      typeof r.serverId !== "string" ||
      typeof r.issuedAt !== "number" ||
      typeof b.signature !== "string" ||
      typeof a.username !== "string" ||
      typeof a.serviceFqdn !== "string" ||
      typeof a.boxServerId !== "string" ||
      typeof a.issuedAt !== "number" ||
      typeof a.expiresAt !== "number" ||
      typeof b.authoritySignature !== "string"
    ) {
      return jerr(400, "malformed body");
    }
    const request: ServiceCertMintRequest = {
      username: r.username,
      serviceFqdn: r.serviceFqdn,
      serverId: r.serverId,
      issuedAt: r.issuedAt,
    };
    const authority: ServiceCertAuthority = {
      username: a.username,
      serviceFqdn: a.serviceFqdn,
      boxServerId: a.boxServerId,
      issuedAt: a.issuedAt,
      expiresAt: a.expiresAt,
    };
    const nameErr = checkNames(deps, request);
    if (nameErr) return jerr(403, nameErr);
    // The authority must grant exactly what the mint asks for: same
    // service, same user, and THIS box as the one allowed to publish.
    if (authority.boxServerId !== deps.serverFqdn) {
      return jerr(403, "authority not issued to this server");
    }
    if (
      authority.serviceFqdn !== request.serviceFqdn ||
      authority.username !== request.username
    ) {
      return jerr(403, "authority does not match the mint request");
    }
    if (!serviceCertAuthorityValidAt(authority, now())) {
      return jerr(403, "authority expired or invalid window");
    }
    let sig: Uint8Array;
    let authoritySig: Uint8Array;
    try {
      sig = hexToBytes(b.signature);
      authoritySig = hexToBytes(b.authoritySignature);
    } catch {
      return jerr(400, "invalid hex signature");
    }
    if (!verifyServiceCertMint(request, sig, deps.irkPub)) {
      return jerr(403, "invalid mint signature");
    }
    if (!verifyServiceCertAuthority(authority, authoritySig, deps.irkPub)) {
      return jerr(403, "invalid authority signature");
    }
    if (Math.abs(now() - request.issuedAt) > maxAgeMs) {
      return jerr(403, "stale request");
    }

    // Issue with the authority riding on every DNS-01 publish/delete —
    // `.com`/the broker refuse the off-box challenge name without it.
    // Renewal is NOT automatic in v1: the authority is single-use-short
    // (≤1h) by design, so the box cannot re-validate `<service>.<user>`
    // on its own — the PHONE re-mints (or re-installs) before expiry.
    // That keeps the trust root in the loop for every shared-name
    // issuance instead of parking a standing DNS capability on a box.
    let issued: { certPem: string; privateKeyPem: string; notAfter: number };
    try {
      issued = await deps.issuer.issue([request.serviceFqdn.toLowerCase()], {
        dns: deps.dnsWriterWithAuthority({ authority, signature: authoritySig }),
      });
    } catch (e) {
      return jerr(502, `issuance failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await persistAndInstall(request.serviceFqdn, issued);
    return jok({ ok: true, serviceFqdn: request.serviceFqdn.toLowerCase(), notAfter: issued.notAfter });
  }

  async function handleExport(body: unknown): Promise<HttpResponse> {
    const b = (body ?? {}) as {
      request?: { username?: unknown; serviceFqdn?: unknown; serverId?: unknown; issuedAt?: unknown };
      signature?: unknown;
    };
    const r = b.request ?? {};
    if (
      typeof r.username !== "string" ||
      typeof r.serviceFqdn !== "string" ||
      typeof r.serverId !== "string" ||
      typeof r.issuedAt !== "number" ||
      typeof b.signature !== "string"
    ) {
      return jerr(400, "malformed body");
    }
    const request: ServiceCertExportRequest = {
      username: r.username,
      serviceFqdn: r.serviceFqdn,
      serverId: r.serverId,
      issuedAt: r.issuedAt,
    };
    const nameErr = checkNames(deps, request);
    if (nameErr) return jerr(403, nameErr);
    let sig: Uint8Array;
    try {
      sig = hexToBytes(b.signature);
    } catch {
      return jerr(400, "invalid hex signature");
    }
    if (!verifyServiceCertExport(request, sig, deps.irkPub)) {
      return jerr(403, "invalid signature");
    }
    if (Math.abs(now() - request.issuedAt) > maxAgeMs) {
      return jerr(403, "stale request");
    }
    const key = request.serviceFqdn.toLowerCase();
    let held = memory.get(key) ?? null;
    if (!held && deps.store) {
      const persisted = await deps.store.loadCert(key);
      if (persisted && isServiceCertNames(persisted.names, key)) {
        held = persisted;
      }
    }
    if (!held) return jerr(404, "no service cert held for this fqdn");
    return jok({
      certPem: held.certPem,
      privateKeyPem: held.privateKeyPem,
      notAfter: held.notAfter,
    });
  }

  async function handleInstall(body: unknown): Promise<HttpResponse> {
    const b = (body ?? {}) as {
      request?: {
        username?: unknown;
        serviceFqdn?: unknown;
        serverId?: unknown;
        certPemSha256?: unknown;
        keyPemSha256?: unknown;
        notAfter?: unknown;
        issuedAt?: unknown;
      };
      signature?: unknown;
      certPem?: unknown;
      keyPem?: unknown;
    };
    const r = b.request ?? {};
    if (
      typeof r.username !== "string" ||
      typeof r.serviceFqdn !== "string" ||
      typeof r.serverId !== "string" ||
      typeof r.certPemSha256 !== "string" ||
      typeof r.keyPemSha256 !== "string" ||
      typeof r.notAfter !== "number" ||
      typeof r.issuedAt !== "number" ||
      typeof b.signature !== "string" ||
      typeof b.certPem !== "string" ||
      typeof b.keyPem !== "string"
    ) {
      return jerr(400, "malformed body");
    }
    let certPemSha256: Uint8Array;
    let keyPemSha256: Uint8Array;
    let sig: Uint8Array;
    try {
      certPemSha256 = hexToBytes(r.certPemSha256);
      keyPemSha256 = hexToBytes(r.keyPemSha256);
      sig = hexToBytes(b.signature);
    } catch {
      return jerr(400, "invalid hex");
    }
    const request: ServiceCertInstall = {
      username: r.username,
      serviceFqdn: r.serviceFqdn,
      serverId: r.serverId,
      certPemSha256,
      keyPemSha256,
      notAfter: r.notAfter,
      issuedAt: r.issuedAt,
    };
    const nameErr = checkNames(deps, request);
    if (nameErr) return jerr(403, nameErr);
    // The signature commits to sha256 of each PEM — re-hash what actually
    // rode in the body so a relay can't swap material under a captured
    // signature.
    if (!equalBytes(sha256(new TextEncoder().encode(b.certPem)), certPemSha256)) {
      return jerr(403, "certPem does not match signed hash");
    }
    if (!equalBytes(sha256(new TextEncoder().encode(b.keyPem)), keyPemSha256)) {
      return jerr(403, "keyPem does not match signed hash");
    }
    if (!verifyServiceCertInstall(request, sig, deps.irkPub)) {
      return jerr(403, "invalid signature");
    }
    if (Math.abs(now() - request.issuedAt) > maxAgeMs) {
      return jerr(403, "stale request");
    }
    if (request.notAfter <= now()) {
      return jerr(403, "cert already expired");
    }
    await persistAndInstall(request.serviceFqdn, {
      certPem: b.certPem,
      privateKeyPem: b.keyPem,
      notAfter: request.notAfter,
    });
    return jok({ ok: true, serviceFqdn: request.serviceFqdn.toLowerCase() });
  }

  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (!req.path.startsWith("/api/service-certs/")) return null;
    if (req.method !== "POST") return jerr(405, "method not allowed");
    const body = parseJson(req.body);
    if (body === null) return jerr(400, "invalid JSON");
    switch (req.path) {
      case "/api/service-certs/mint":
        return handleMint(body);
      case "/api/service-certs/export":
        return handleExport(body);
      case "/api/service-certs/install":
        return handleInstall(body);
      default:
        return jerr(404, "not found");
    }
  };
}

/** A persisted entry is a tier-2 shared service cert iff its stored names
 *  are exactly the one non-wildcard service FQDN. */
function isServiceCertNames(names: string[], fqdn: string): boolean {
  return names.length === 1 && names[0]?.toLowerCase() === fqdn.toLowerCase();
}

/**
 * Startup rehydration (mirrors the box-cert reuse in startDaemonRuntime):
 * reload every persisted, unexpired tier-2 service cert into the
 * custom-SNI tier so `<service>.<user>` serves immediately after a
 * restart without waiting for the phone to re-mint. Pure-ish + exported
 * so tests drive it without spinning up TLS + tunnel + ACME.
 */
export async function rehydrateServiceCerts(args: {
  store: { listCerts(): Promise<PersistedCert[]> };
  certManager: CertManager;
  serverFqdn: string;
  apex?: string;
  now?: number;
}): Promise<string[]> {
  const apex = args.apex ?? "flagship.services";
  const now = args.now ?? Date.now();
  const installed: string[] = [];
  for (const cert of await args.store.listCerts()) {
    if (cert.names.length !== 1) continue;
    const fqdn = cert.names[0]!.toLowerCase();
    if (fqdn.startsWith("*.")) continue;
    if (fqdn === args.serverFqdn.toLowerCase()) continue;
    if (!parseTier2ServiceFqdn(fqdn, apex)) continue;
    if (cert.notAfter <= now) continue;
    args.certManager.installCustom(
      fqdn,
      { certPem: cert.certPem, privateKeyPem: cert.privateKeyPem },
      cert.notAfter,
    );
    installed.push(fqdn);
  }
  return installed;
}
