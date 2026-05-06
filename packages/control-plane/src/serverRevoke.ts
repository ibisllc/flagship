import {
  verifyServerRevokeBySelf,
  type ServerRevokeBySelf,
} from "@flagship/protocol";
import type { ServerStorage } from "@flagship/storage";
import { hexToBytes } from "./hex.js";
import type { HandlerResponse } from "./types.js";

/**
 * `POST /api/server/by-domain/:host/revoke` — server identity-signed
 * self-revocation. Marks the server record as revoked and short-circuits
 * any future tunnel HELLOs. The daemon typically calls this after
 * receiving a phone `revoke-self` order, then exits.
 *
 * This is the server's path; the IRK-signed `ServerRevocation` is the
 * user's separate path (lost/stolen device, etc.) and isn't wired
 * through this handler — it has its own flow.
 */
export interface RevokeBySelfDeps {
  servers: ServerStorage;
  maxAgeMs?: number;
  now?: () => number;
}

export async function handleServerRevokeBySelf(
  deps: RevokeBySelfDeps,
  host: string,
  body: unknown,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? 5 * 60_000;

  const b = body as { request?: Record<string, unknown>; signature?: unknown };
  const r = b?.request ?? {};
  if (
    typeof r.serverId !== "string" ||
    typeof r.reason !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }
  if (r.serverId !== host) {
    return { status: 403, body: { error: "serverId / host mismatch" } };
  }
  const reg = await deps.servers.get(host);
  if (!reg) return { status: 404, body: { error: "unknown server" } };
  // Idempotent: a daemon retrying after a network blip should not see 4xx.
  if (reg.revokedAt) {
    return {
      status: 200,
      body: { ok: true, alreadyRevoked: true, revokedAt: reg.revokedAt, reason: reg.revocationReason },
    };
  }
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return { status: 403, body: { error: "stale request" } };
  }

  let sig: Uint8Array;
  try {
    sig = hexToBytes(b.signature);
  } catch {
    return { status: 400, body: { error: "invalid hex" } };
  }
  const claim: ServerRevokeBySelf = {
    serverId: host,
    reason: r.reason,
    issuedAt: r.issuedAt,
  };
  if (!verifyServerRevokeBySelf(claim, sig, hexToBytes(reg.identityPubKeyHex))) {
    return { status: 403, body: { error: "invalid signature" } };
  }

  const revokedAt = now();
  const ok = await deps.servers.revoke(host, r.reason, revokedAt);
  if (!ok) {
    return { status: 500, body: { error: "revoke failed (server vanished?)" } };
  }
  return { status: 200, body: { ok: true, revokedAt, reason: r.reason } };
}
