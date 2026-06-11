import { sha256 } from "@noble/hashes/sha256";
import {
  parseTier2ServiceFqdn,
  serviceCertAuthorityValidAt,
  verifyDns01Delete,
  verifyDns01Publish,
  verifyServiceCertAuthority,
  type Dns01DeleteRequest,
  type Dns01PublishRequest,
  type ServiceCertAuthority,
} from "@flagship/protocol";
import type { ServerStorage, UsernameStorage } from "@flagship/storage";
import type { CloudflareDnsClient, CloudflareDnsRecord } from "./cloudflareDns.js";
import { hexToBytes } from "./hex.js";
import type { HandlerResponse } from "./types.js";

/**
 * ACME DNS-01 publish/delete handlers. Each Flagship daemon runs ACME
 * locally; for wildcard SANs (the `*.<server>.<user>.flagship.services`
 * leg) Let's Encrypt will only accept DNS-01, but the daemon doesn't own
 * the zone. The daemon signs a publish request with its identity key and
 * `.com` writes the TXT record on its behalf using the
 * `CLOUDFLARE_DNS_API_TOKEN` Worker secret.
 *
 * Auth: every request is signed with the server's identity key (the same
 * key registered via `/api/server/register`). The handler:
 *   1. Looks up the server by `serverId` (== server FQDN) in storage.
 *   2. Verifies the Ed25519 signature against the stored identity pubkey.
 *   3. Confirms `recordName` lives inside the requesting server's
 *      namespace so a compromised server can't poison another server's
 *      zone or cross the line into `flagshipserver.com`.
 *   4. For publish, also verifies the included plaintext `recordValue`
 *      hashes to the signed `recordValueHash` — protects against MITM
 *      tampering with the value after the daemon signed.
 *
 * For delete the handler additionally verifies the record exists, is a
 * TXT record, and lives inside the requesting server's namespace before
 * issuing the CF DELETE.
 */
export interface Dns01Deps {
  servers: ServerStorage;
  /**
   * Needed only for the tier-2 service-cert path (resolving the user's
   * registered IRK to verify a phone-issued ServiceCertAuthority). When
   * absent, requests carrying a service-cert authority are refused.
   */
  usernames?: UsernameStorage;
  dns: CloudflareDnsClient;
  /** The apex this control plane manages. Default `flagship.services`. */
  apex?: string;
  /** Replay window in ms. Default 5 minutes. */
  maxAgeMs?: number;
  /** Test seam. */
  now?: () => number;
}

interface ServiceCertAuthorityBody {
  authority?: {
    username?: unknown;
    serviceFqdn?: unknown;
    boxServerId?: unknown;
    issuedAt?: unknown;
    expiresAt?: unknown;
  };
  signature?: unknown;
}

interface PublishBody {
  request?: {
    serverId?: unknown;
    recordName?: unknown;
    recordValueHash?: unknown;
    issuedAt?: unknown;
  };
  signature?: unknown;
  recordValue?: unknown;
  serviceCertAuthority?: ServiceCertAuthorityBody;
}

interface DeleteBody {
  request?: {
    serverId?: unknown;
    recordId?: unknown;
    issuedAt?: unknown;
  };
  signature?: unknown;
  serviceCertAuthority?: ServiceCertAuthorityBody;
}

/**
 * Validate a phone-issued ServiceCertAuthority forwarded by a box with its
 * DNS-01 request. The grant lets `boxServerId` (and ONLY that box) act on the
 * challenge for ONE tier-2 service FQDN, for at most an hour. Returns the
 * parsed authority on success, or an error string naming the failed fence.
 */
async function checkServiceCertAuthority(args: {
  body: ServiceCertAuthorityBody | undefined;
  requestingServerId: string;
  usernames: UsernameStorage | undefined;
  apex: string;
  now: number;
}): Promise<{ ok: true; authority: ServiceCertAuthority } | { ok: false; error: string }> {
  if (!args.usernames) return { ok: false, error: "service-cert authority not supported here" };
  const b = args.body;
  const a = b?.authority;
  if (
    !b ||
    !a ||
    typeof a.username !== "string" ||
    typeof a.serviceFqdn !== "string" ||
    typeof a.boxServerId !== "string" ||
    typeof a.issuedAt !== "number" ||
    typeof a.expiresAt !== "number" ||
    typeof b.signature !== "string"
  ) {
    return { ok: false, error: "malformed service-cert authority" };
  }
  const authority: ServiceCertAuthority = {
    username: a.username,
    serviceFqdn: a.serviceFqdn,
    boxServerId: a.boxServerId,
    issuedAt: a.issuedAt,
    expiresAt: a.expiresAt,
  };
  const parsed = parseTier2ServiceFqdn(authority.serviceFqdn, args.apex);
  if (!parsed || parsed.username !== authority.username) {
    return { ok: false, error: "serviceFqdn is not a tier-2 name under this user" };
  }
  if (authority.boxServerId !== args.requestingServerId) {
    return { ok: false, error: "authority not issued to this server" };
  }
  // The granted box must live in the SAME user's zone as the service —
  // a grant can never let user A's box validate a name under user B.
  if (!args.requestingServerId.endsWith(`.${authority.username}.${args.apex}`)) {
    return { ok: false, error: "server not in the authority's user zone" };
  }
  if (!serviceCertAuthorityValidAt(authority, args.now)) {
    return { ok: false, error: "authority expired or invalid window" };
  }
  let sig: Uint8Array;
  try {
    sig = hexToBytes(b.signature);
  } catch {
    return { ok: false, error: "invalid authority hex" };
  }
  const user = await args.usernames.get(authority.username);
  if (!user) return { ok: false, error: "unknown user" };
  let irkPub: Uint8Array;
  try {
    irkPub = hexToBytes(user.irkPubHex);
  } catch {
    return { ok: false, error: "unresolvable user IRK" };
  }
  if (!verifyServiceCertAuthority(authority, sig, irkPub)) {
    return { ok: false, error: "invalid authority signature" };
  }
  return { ok: true, authority };
}

export async function handleDns01Publish(
  deps: Dns01Deps,
  body: unknown,
): Promise<HandlerResponse> {
  const apex = deps.apex ?? "flagship.services";
  const maxAgeMs = deps.maxAgeMs ?? 5 * 60_000;
  const now = deps.now ?? (() => Date.now());

  const b = (body ?? {}) as PublishBody;
  const r = b.request ?? {};
  if (
    typeof r.serverId !== "string" ||
    typeof r.recordName !== "string" ||
    typeof r.recordValueHash !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b.signature !== "string" ||
    typeof b.recordValue !== "string"
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }

  const reg = await deps.servers.get(r.serverId);
  if (!reg) return { status: 404, body: { error: "unknown server" } };
  if (reg.revokedAt) return { status: 403, body: { error: "server is revoked" } };

  // recordName must be the DNS-01 challenge record for the requesting
  // box's OWN subdomain. Under cert model A′ a box mints exactly
  // `[<server>.<user>.flagship.services, *.<server>.<user>.flagship.services]`
  // and BOTH SANs validate at the same challenge name (RFC 8555 strips the
  // `*.` prefix before prepending `_acme-challenge.`):
  //   `_acme-challenge.<server>.<user>.flagship.services`
  // No user-zone names: a box must never write a challenge that could
  // validate a cert covering another box's names.
  //
  // ONE phone-authorized exception (cert model A′ Phase 5, tier-2 shared
  // service certs): the box may additionally write
  // `_acme-challenge.<service>.<user>.flagship.services` when it forwards a
  // valid IRK-signed ServiceCertAuthority naming THIS box and THAT service —
  // that authority belongs to the trust root, not the box, so it is verified
  // as a separate authorization, never a relaxation of the own-name rule.
  if (!r.serverId.endsWith(`.${apex}`)) {
    return { status: 403, body: { error: "serverId outside managed apex" } };
  }
  const expectedName = `_acme-challenge.${r.serverId}`;
  if (r.recordName !== expectedName) {
    const svc = await checkServiceCertAuthority({
      body: b.serviceCertAuthority,
      requestingServerId: r.serverId,
      usernames: deps.usernames,
      apex,
      now: now(),
    });
    if (!svc.ok) {
      return {
        status: 403,
        body: {
          error: b.serviceCertAuthority
            ? svc.error
            : `recordName must be ${JSON.stringify(expectedName)}`,
        },
      };
    }
    if (r.recordName !== `_acme-challenge.${svc.authority.serviceFqdn}`) {
      return {
        status: 403,
        body: { error: "recordName does not match the authorized serviceFqdn" },
      };
    }
  }

  let valueHash: Uint8Array;
  let sig: Uint8Array;
  try {
    valueHash = hexToBytes(r.recordValueHash);
    sig = hexToBytes(b.signature);
  } catch {
    return { status: 400, body: { error: "invalid hex" } };
  }
  const expectedValueHash = sha256(new TextEncoder().encode(b.recordValue));
  if (!equalBytes(expectedValueHash, valueHash)) {
    return { status: 400, body: { error: "recordValue does not match recordValueHash" } };
  }

  const claim: Dns01PublishRequest = {
    serverId: r.serverId,
    recordName: r.recordName,
    recordValueHash: valueHash,
    issuedAt: r.issuedAt,
  };
  const stkPub = hexToBytes(reg.identityPubKeyHex);
  if (!verifyDns01Publish(claim, sig, stkPub)) {
    return { status: 403, body: { error: "invalid signature" } };
  }
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return { status: 403, body: { error: "stale request" } };
  }

  let record: CloudflareDnsRecord;
  try {
    record = await deps.dns.createTxt({ name: r.recordName, value: b.recordValue, ttl: 60 });
  } catch (e) {
    return { status: 502, body: { error: "publish failed", message: errMsg(e) } };
  }
  return { status: 200, body: { recordId: record.id } };
}

export async function handleDns01Delete(
  deps: Dns01Deps,
  body: unknown,
): Promise<HandlerResponse> {
  const apex = deps.apex ?? "flagship.services";
  const maxAgeMs = deps.maxAgeMs ?? 5 * 60_000;
  const now = deps.now ?? (() => Date.now());

  const b = (body ?? {}) as DeleteBody;
  const r = b.request ?? {};
  if (
    typeof r.serverId !== "string" ||
    typeof r.recordId !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b.signature !== "string"
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }

  const reg = await deps.servers.get(r.serverId);
  if (!reg) return { status: 404, body: { error: "unknown server" } };
  if (reg.revokedAt) return { status: 403, body: { error: "server is revoked" } };
  if (!r.serverId.endsWith(`.${apex}`)) {
    return { status: 403, body: { error: "serverId outside managed apex" } };
  }

  let sig: Uint8Array;
  try {
    sig = hexToBytes(b.signature);
  } catch {
    return { status: 400, body: { error: "invalid hex" } };
  }
  const claim: Dns01DeleteRequest = {
    serverId: r.serverId,
    recordId: r.recordId,
    issuedAt: r.issuedAt,
  };
  const stkPub = hexToBytes(reg.identityPubKeyHex);
  if (!verifyDns01Delete(claim, sig, stkPub)) {
    return { status: 403, body: { error: "invalid signature" } };
  }
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return { status: 403, body: { error: "stale request" } };
  }

  // Defense-in-depth: confirm the record we're about to delete actually
  // belongs to this server's _acme-challenge name. CF record ids are
  // unguessable in practice, but a bug or compromise that leaks an id
  // shouldn't enable cross-server zone tampering.
  let rec: CloudflareDnsRecord | null;
  try {
    rec = await deps.dns.getById(r.recordId);
  } catch (e) {
    return { status: 502, body: { error: "lookup failed", message: errMsg(e) } };
  }
  if (!rec) return { status: 404, body: { error: "unknown recordId" } };
  if (rec.type !== "TXT") {
    return { status: 403, body: { error: "recordId is not a TXT record" } };
  }
  if (rec.name !== `_acme-challenge.${r.serverId}`) {
    // Tier-2 service-cert challenge cleanup: the publishing box may delete
    // the record it created under a phone-issued authority — same fences as
    // publish, including the record name matching the authorized service.
    const svc = await checkServiceCertAuthority({
      body: b.serviceCertAuthority,
      requestingServerId: r.serverId,
      usernames: deps.usernames,
      apex,
      now: now(),
    });
    if (!svc.ok || rec.name !== `_acme-challenge.${svc.authority.serviceFqdn}`) {
      return { status: 403, body: { error: "recordId not owned by this server" } };
    }
  }

  try {
    await deps.dns.deleteById(r.recordId);
  } catch (e) {
    return { status: 502, body: { error: "delete failed", message: errMsg(e) } };
  }
  return { status: 200, body: { ok: true } };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i]! ^ b[i]!);
  return diff === 0;
}
