import { sha256 } from "@noble/hashes/sha256";
import {
  verifyDns01Delete,
  verifyDns01Publish,
  type Dns01DeleteRequest,
  type Dns01PublishRequest,
} from "@flagship/protocol";
import type { ServerStorage } from "@flagship/storage";
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
  dns: CloudflareDnsClient;
  /** The apex this control plane manages. Default `flagship.services`. */
  apex?: string;
  /** Replay window in ms. Default 5 minutes. */
  maxAgeMs?: number;
  /** Test seam. */
  now?: () => number;
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
}

interface DeleteBody {
  request?: {
    serverId?: unknown;
    recordId?: unknown;
    issuedAt?: unknown;
  };
  signature?: unknown;
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
  // validate a cert covering another box's names. (A later phase adds a
  // PHONE-authorized `_acme-challenge.<service>.<user>` path for tier-2
  // shared service certs — that authority belongs to the trust root, not a
  // box, so it will be a separate authorization, not a relaxation here.)
  if (!r.serverId.endsWith(`.${apex}`)) {
    return { status: 403, body: { error: "serverId outside managed apex" } };
  }
  const expectedName = `_acme-challenge.${r.serverId}`;
  if (r.recordName !== expectedName) {
    return {
      status: 403,
      body: { error: `recordName must be ${JSON.stringify(expectedName)}` },
    };
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
    return { status: 403, body: { error: "recordId not owned by this server" } };
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
