/**
 * v1.2 Phase 2 — POST /api/users/:u/devices/:id/disconnect
 *
 * The legitimate-owner path for kicking a sibling device off the
 * account. Defined as a NEW endpoint (the existing
 * `DELETE /api/push/<token-id>` is the "this user revokes their
 * own token" path; this one is "this device, signed by the user's
 * IRK, kicks OTHER device with id `id` off the account").
 *
 * Body shape:
 *
 *   {
 *     "request": {
 *       "username":      "alice",
 *       "targetTokenId": "abcdef…",
 *       "callerTokenId": "ghijkl…",
 *       "issuedAt":      1700000000000
 *     },
 *     "signature": "<hex IRK signature over canonicalbytes>"
 *   }
 *
 * Phase 2 keeps the signature gate "structurally present" — same
 * pragmatism as `RePairInitiate.totpProof`. Phase 5 (audit) will
 * wire the actual ed25519 verify against the current IRK + a
 * canonical-bytes envelope (TAG_DEVICE_DISCONNECT). The QUARANTINE
 * gate, however, is real:
 *
 *   - look up `callerTokenId` in push_tokens
 *   - if that row's `quarantineUntil > now`, reject with 403
 *     { reason: "quarantine", until: <iso>, hint: "use a device
 *       you've had for longer" }
 *   - otherwise, remove the target row
 *
 * On a successful kick, an audit event is appended so the
 * Activity-feed UI shows the disconnect.
 */

import type {
  AuditEventStorage,
  PushTokenStorage,
  UsernameStorage,
} from "@flagship/storage";
import { recordAuditEvent } from "./auditEvents.js";
import type { HandlerResponse } from "./types.js";
import type { V12PushFanout } from "./totp.js";

export interface DeviceDisconnectDeps {
  pushTokens: PushTokenStorage;
  usernames: UsernameStorage;
  auditEvents: AuditEventStorage;
  /**
   * v1.2 Plan B Phase 5 — optional push fan-out. When a quarantined
   * device attempts to revoke a sibling, we surface that as a push
   * to all the user's currently-trusted devices so they know one of
   * their newly-admitted devices just tried something fishy. Older
   * callers that don't pass this dep degrade to "audit only".
   */
  pushFanout?: V12PushFanout;
  maxAgeMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_AGE = 5 * 60_000;

export async function handleDeviceDisconnect(
  deps: DeviceDisconnectDeps,
  username: string,
  targetTokenId: string,
  body: unknown,
): Promise<HandlerResponse> {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE;

  const b = body as {
    request?: Record<string, unknown>;
    signature?: unknown;
  };
  const r = b?.request ?? {};
  if (
    typeof r.username !== "string" ||
    typeof r.targetTokenId !== "string" ||
    typeof r.callerTokenId !== "string" ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string"
  ) {
    return { status: 400, body: { error: "malformed body" } };
  }
  if (r.username.toLowerCase() !== username.toLowerCase()) {
    return { status: 403, body: { error: "username / url mismatch" } };
  }
  if (r.targetTokenId !== targetTokenId) {
    return { status: 400, body: { error: "targetTokenId / url mismatch" } };
  }
  if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
    return { status: 403, body: { error: "stale request" } };
  }
  // Phase 2 — structural-only signature gate, matching the
  // totpProof structural check on RePairInitiate. Phase 5 swaps
  // this for a canonical-bytes verifyDeviceDisconnect against the
  // user's current IRK.
  if (b.signature.length === 0) {
    return { status: 403, body: { error: "invalid signature" } };
  }

  // Quarantine gate on the caller.
  const callerRow = await deps.pushTokens.get(r.callerTokenId);
  if (callerRow && (callerRow.quarantineUntil ?? 0) > now()) {
    // v1.2 Phase 5 — record the blocked attempt + fire push to ALL
    // the user's currently-trusted devices so the legitimate owner
    // sees that a quarantined device just tried to remove others.
    // accountTypeAtEvent reads through from the username row; we
    // default to 'single' (the safe assumption) if the row is gone.
    const userRec = await deps.usernames.get(r.username);
    const accountType = userRec?.accountType ?? "single";
    await recordAuditEvent(deps, {
      username: r.username.toLowerCase(),
      eventKind: "quarantine-blocked-revoke",
      detail: `Quarantined device blocked from removing ${(
        callerRow.label || callerRow.platform
      ).slice(0, 32)}`,
      devicePrefix: r.callerTokenId.slice(0, 8),
      postedAt: now(),
      accountTypeAtEvent: accountType,
      quarantineUntil: callerRow.quarantineUntil ?? 0,
    });
    if (deps.pushFanout) {
      try {
        const allTargets = await deps.pushTokens.listByUser(r.username);
        // Push to everyone EXCEPT the quarantined device itself —
        // they already saw a 403 in their UI; no point notifying
        // them about their own block. The legitimate older
        // devices are the audience.
        const targets = allTargets
          .filter((p) => p.tokenId !== r.callerTokenId)
          .map((p) => ({
            tokenId: p.tokenId,
            platform: p.platform,
            providerToken: p.providerToken,
          }));
        if (targets.length > 0) {
          await deps.pushFanout({
            username: r.username.toLowerCase(),
            targets,
            payload: {
              category: "quarantine-blocked-revoke",
              title: "Suspicious activity on your account",
              body:
                "A newly-admitted device just tried to remove others. It's quarantined for 14 days — you can revoke it from any of your older devices.",
              deepLink: `flagship://settings/devices?u=${encodeURIComponent(
                r.username.toLowerCase(),
              )}`,
              meta: {
                eventKind: "quarantine-blocked-revoke",
                callerPrefix: r.callerTokenId.slice(0, 8),
                quarantineUntil: callerRow.quarantineUntil ?? 0,
              },
            },
          });
        }
      } catch {
        // Push errors must not surface to the caller — the 403 is
        // the authoritative answer for the client. Audit is the
        // durable record either way.
      }
    }
    return {
      status: 403,
      body: {
        reason: "quarantine",
        until: new Date(callerRow.quarantineUntil ?? 0).toISOString(),
        hint: "use a device you've had for longer",
      },
    };
  }

  // Look up the target row before deleting so we can audit its
  // prefix. Missing-target is a 404 so a repeat-click on a stale
  // UI is unambiguous.
  const targetRow = await deps.pushTokens.get(r.targetTokenId);
  if (!targetRow) {
    return { status: 404, body: { error: "unknown targetTokenId" } };
  }
  if (targetRow.username.toLowerCase() !== r.username.toLowerCase()) {
    return { status: 403, body: { error: "targetTokenId does not belong to this user" } };
  }

  await deps.pushTokens.remove(r.targetTokenId);
  // v1.2 Phase 5 — capture the account-type snapshot on the audit
  // row so the Activity feed can render account-mode context next
  // to a disconnect event.
  const userRec = await deps.usernames.get(r.username);
  await recordAuditEvent(deps, {
    username: r.username.toLowerCase(),
    eventKind: "device-disconnected",
    detail: `Device removed (${(targetRow.label || targetRow.platform).slice(0, 32)})`,
    devicePrefix: r.targetTokenId.slice(0, 8),
    postedAt: now(),
    accountTypeAtEvent: userRec?.accountType ?? "single",
  });

  return { status: 200, body: { ok: true } };
}
