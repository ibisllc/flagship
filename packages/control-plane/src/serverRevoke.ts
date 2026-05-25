import {
  verifyReleaseServerName,
  verifyServerRevokeBySelf,
  type ReleaseServerName,
  type ServerRevokeBySelf,
} from "@flagship/protocol";
import type {
  AuthCodeStorage,
  RoutingStorage,
  ServerStorage,
  UsernameStorage,
} from "@flagship/storage";
import { HEX128, hexToBytes } from "./hex.js";
import { validateServerLabel, validateUserLabel } from "./labels.js";
import {
  forbidden,
  malformed,
  notFound,
  ok,
  type HandlerResponse,
  type HandlerResponseWithHeaders,
} from "./types.js";

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
  const revoked = await deps.servers.revoke(host, r.reason, revokedAt);
  if (!revoked) {
    return { status: 500, body: { error: "revoke failed (server vanished?)" } };
  }
  return { status: 200, body: { ok: true, revokedAt, reason: r.reason } };
}

/**
 * `POST /api/server/release` — owner-signed "cancel the server / free the
 * name". Releases a reserved-but-unactivated server name (the common case:
 * an install that failed before the box phoned home) so the leftmost
 * `<server>` label can be claimed again. Also handles releasing an
 * already-active server, since the IRK signature IS the owner gate —
 * nobody but the account owner can produce it, so an active box can't be
 * released out from under its owner by anyone else.
 *
 * Why a dedicated endpoint and not just the auth-code revoke: revoking
 * the auth-code marks ONE ticket dead, but the name stays pinned by the
 * RCK routing record (register() refuses to overwrite it with a fresh
 * key). Retrying the same name then fails with "subdomain already
 * controlled by a different RCK" — that's the "name is now lost" bug.
 * This releases every artifact that pins the name in one signed call:
 *   1. the RCK routing record (the actual blocker),
 *   2. any still-active auth-codes for the domain,
 *   3. the registered server record, if the box ever registered.
 *
 * Idempotent: releasing an already-free name returns 200 with zeroed
 * counts, so a double-tap / retry is safe.
 */
export interface ServerReleaseDeps {
  usernames: UsernameStorage;
  routing: RoutingStorage;
  authCodes: AuthCodeStorage;
  servers: ServerStorage;
  freshnessMs?: number;
  now?: () => number;
}

interface ReleaseBody {
  request?: { username?: string; serverDomain?: string; issuedAt?: number };
  signature?: string;
}

export async function handleServerReleaseName(
  deps: ServerReleaseDeps,
  body: ReleaseBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const freshnessMs = deps.freshnessMs ?? 5 * 60_000;

  const r = body?.request;
  if (
    !r ||
    typeof r.username !== "string" ||
    typeof r.serverDomain !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof body?.signature !== "string" ||
    !HEX128.test(body.signature)
  ) {
    return malformed("malformed body");
  }

  const userV = validateUserLabel(r.username);
  if (!userV.ok) return malformed(userV.reason);

  // serverDomain MUST be `<server>.<user>.flagship.services` with the
  // user segment equal to the signing username and a valid server label.
  // This binds the release to the owner's own namespace — even a valid
  // IRK can't release a name under a different user.
  const expectedSuffix = `.${userV.label}.flagship.services`;
  if (
    !r.serverDomain.endsWith(expectedSuffix) ||
    r.serverDomain.length === expectedSuffix.length
  ) {
    return malformed(`serverDomain must end with ${expectedSuffix}`);
  }
  const serverLabel = r.serverDomain.slice(
    0,
    r.serverDomain.length - expectedSuffix.length,
  );
  const labelV = validateServerLabel(serverLabel);
  if (!labelV.ok) return malformed(`invalid server label: ${labelV.reason}`);

  if (Math.abs(now - r.issuedAt) > freshnessMs) return forbidden("stale request");

  // Owner auth: the signature must verify against the username's
  // REGISTERED IRK. This is the only authority that can free the name.
  const userRec = await deps.usernames.get(userV.label);
  if (!userRec) return notFound("username not registered");

  let sig: Uint8Array;
  try {
    sig = hexToBytes(body.signature);
  } catch {
    return malformed("invalid hex");
  }
  const claim: ReleaseServerName = {
    username: userV.label,
    serverDomain: r.serverDomain,
    issuedAt: r.issuedAt,
  };
  if (!verifyReleaseServerName(claim, sig, hexToBytes(userRec.irkPubHex))) {
    return forbidden("invalid signature");
  }

  // 1. Release the RCK routing record — the artifact that actually
  //    blocks re-claiming the name. Idempotent in storage.
  await deps.routing.release(r.serverDomain);

  // 2. Revoke every still-active auth-code reserving this domain.
  const active = await deps.authCodes.listActiveByServerDomain(r.serverDomain);
  let authCodesRevoked = 0;
  for (const code of active) {
    const res = await deps.authCodes.markRevoked(code.serial, now);
    if (res.ok) authCodesRevoked++;
  }

  // 3. Revoke the registered server record if the box ever phoned home.
  //    `revoke` returns false when there's no (live) record — that's the
  //    common reserved-but-unactivated case, not an error.
  const serverRevoked = await deps.servers.revoke(
    r.serverDomain,
    "released-by-owner",
    now,
  );

  return ok({
    ok: true,
    serverDomain: r.serverDomain,
    routingReleased: true,
    authCodesRevoked,
    serverRevoked,
    releasedAt: now,
  });
}
