/**
 * `POST /api/server-registry/revoke` — IRK-signed user-initiated server
 * revocation. Distinct from {@link handleServerRevokeBySelf} (server's
 * identity-signed self-revoke) and {@link handleServerReleaseName}
 * (owner-signed "free the name"): this path is the user's "this box is
 * lost / stolen / being decommissioned" assertion, signed by the user's
 * IRK and verified against the username's currently-registered IRK.
 *
 * Effect on success:
 *   1. Marks the server record revoked (idempotent — a re-submit of the
 *      same revocation returns 200 noop with the original revokedAt).
 *   2. Tears down every active boot-unlock lease on the server (both
 *      the box-sealed-v2 path and the legacy plaintext lease path) so
 *      the box bricks on its next reboot — the "brick on next boot"
 *      effect the P13 client surfaces to the user.
 *   3. Appends a `server-revoked` audit row so the user's Activity feed
 *      reflects the action.
 *
 * Ported from apps/web/src/routes/serverRevocation.ts (Fly app) — same
 * validation rules + replay window; deps shape matches the .com handler
 * conventions (see {@link handleServerReleaseName}).
 */

import {
  verifyRevocation,
  type RevocationReason,
  type ServerRevocation,
} from "@flagship/protocol";
import type {
  AuditEventStorage,
  AutoUnlockLeaseStorage,
  BoxSealedLeaseStorage,
  ServerStorage,
  UsernameStorage,
} from "@flagship/storage";
import { recordAuditEvent } from "./auditEvents.js";
import { hexToBytes } from "./hex.js";
import {
  forbidden,
  malformed,
  notFound,
  ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

export interface ServerRevocationDeps {
  usernames: UsernameStorage;
  servers: ServerStorage;
  auditEvents: AuditEventStorage;
  /**
   * Optional. When wired, every active lease on the revoked server is
   * torn down so the box can't auto-unlock on its next reboot. Both
   * lease storages are independently optional — a deployment that has
   * only migrated to box-sealed-v2 can omit the legacy `autoUnlockLeases`
   * dep entirely. When neither is wired the revocation still succeeds
   * (server record + audit row); the cascade just doesn't run.
   */
  autoUnlockLeases?: AutoUnlockLeaseStorage;
  boxSealedLeases?: BoxSealedLeaseStorage;
  /** Replay-window in ms. Default 5 min, matching the Fly precedent. */
  maxAgeMs?: number;
  now?: () => number;
}

interface RevokeBody {
  request?: {
    userId?: string;
    revokedServerId?: string;
    reason?: string;
    issuedAt?: number;
  };
  signature?: string;
}

const VALID_REASONS: ReadonlySet<RevocationReason> = new Set([
  "lost",
  "stolen",
  "decommissioned",
]);

export async function handleRevokeServer(
  deps: ServerRevocationDeps,
  body: RevokeBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const maxAgeMs = deps.maxAgeMs ?? 5 * 60_000;

  const r = body?.request;
  if (
    !r ||
    typeof r.userId !== "string" ||
    typeof r.revokedServerId !== "string" ||
    typeof r.reason !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof body?.signature !== "string"
  ) {
    return malformed("malformed body");
  }
  if (!VALID_REASONS.has(r.reason as RevocationReason)) {
    return malformed("invalid reason");
  }

  // Freshness window mirrors `handleServerReleaseName` (±maxAgeMs).
  if (Math.abs(now - r.issuedAt) > maxAgeMs) {
    return forbidden("stale request");
  }

  // Resolve the signing IRK by username (the protocol's `userId` field
  // is the username string — same as the Fly precedent's
  // `resolveUserIrk(r.userId)`).
  const userRec = await deps.usernames.get(r.userId);
  if (!userRec) return notFound("unknown user");

  // The server must be registered AND owned by the signing user. We
  // check this BEFORE signature verification so a typo in
  // revokedServerId surfaces as a clean 404 / 403 rather than a generic
  // "invalid signature".
  const target = await deps.servers.get(r.revokedServerId);
  if (!target) return notFound("unknown server");
  if (target.username !== r.userId) {
    return forbidden("server is not owned by signer");
  }

  // Idempotency: a retry of the same revocation (e.g. client network
  // blip after the cascade ran) is a 200 noop with the original
  // revokedAt + reason. Avoids the audit row + cascade firing twice.
  if (target.revokedAt) {
    return ok({
      ok: true,
      alreadyRevoked: true,
      revokedAt: target.revokedAt,
      reason: target.revocationReason,
    });
  }

  let sig: Uint8Array;
  let irkPub: Uint8Array;
  try {
    sig = hexToBytes(body.signature);
    irkPub = hexToBytes(userRec.irkPubHex);
  } catch {
    return malformed("invalid hex");
  }

  const revocation: ServerRevocation = {
    userId: r.userId,
    revokedServerId: r.revokedServerId,
    reason: r.reason as RevocationReason,
    issuedAt: r.issuedAt,
  };
  if (!verifyRevocation(revocation, sig, irkPub)) {
    return forbidden("invalid signature");
  }

  // Mark the server record revoked. `revoke` returns false iff the row
  // vanished between our `get` and now (e.g. a concurrent delete) — a
  // 500 is the right response: the caller can retry.
  const marked = await deps.servers.revoke(r.revokedServerId, r.reason, now);
  if (!marked) {
    return { status: 500, body: { error: "revoke failed (server vanished?)" } };
  }

  // Cascade: tear down every active boot-unlock lease on the server so
  // the box bricks on its next reboot. Best-effort — a lease-storage
  // hiccup MUST NOT undo the revocation that already landed. We swallow
  // per-lease errors but track counts for the response.
  let autoLeasesRevoked = 0;
  let boxSealedLeasesRevoked = 0;
  if (deps.autoUnlockLeases) {
    try {
      const leases = await deps.autoUnlockLeases.list(r.revokedServerId, now);
      for (const l of leases) {
        try {
          const dropped = await deps.autoUnlockLeases.revoke(
            r.revokedServerId,
            l.leaseId,
          );
          if (dropped) autoLeasesRevoked++;
        } catch {
          // swallow — see comment above.
        }
      }
    } catch {
      // swallow — the server record IS revoked; the next-boot ACL check
      // on tunnel HELLO is the second line of defense even if a stale
      // lease somehow survives this cascade.
    }
  }
  if (deps.boxSealedLeases) {
    try {
      const leases = await deps.boxSealedLeases.list(r.revokedServerId, now);
      for (const l of leases) {
        try {
          const dropped = await deps.boxSealedLeases.revoke(
            r.revokedServerId,
            l.leaseId,
          );
          if (dropped) boxSealedLeasesRevoked++;
        } catch {
          // swallow.
        }
      }
    } catch {
      // swallow.
    }
  }

  // Append the audit row. Best-effort matches the rest of this package
  // (see wipeRestart / deviceDisconnect): a failure here MUST NOT
  // undo the revocation. `recordAuditEvent` already truncates oversized
  // details rather than throwing.
  try {
    await recordAuditEvent(
      { auditEvents: deps.auditEvents },
      {
        username: r.userId,
        eventKind: "server-revoked",
        detail: `Revoked ${r.revokedServerId} (${r.reason})`,
        devicePrefix: r.revokedServerId.slice(0, 8),
        postedAt: now,
      },
    );
  } catch {
    // swallow.
  }

  return ok({
    ok: true,
    revokedAt: now,
    reason: r.reason,
    autoLeasesRevoked,
    boxSealedLeasesRevoked,
  });
}
