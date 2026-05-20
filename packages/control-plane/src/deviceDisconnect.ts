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

export interface DeviceDisconnectDeps {
  pushTokens: PushTokenStorage;
  usernames: UsernameStorage;
  auditEvents: AuditEventStorage;
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
  await recordAuditEvent(deps, {
    username: r.username.toLowerCase(),
    eventKind: "device-disconnected",
    detail: `Device removed (${(targetRow.label || targetRow.platform).slice(0, 32)})`,
    devicePrefix: r.targetTokenId.slice(0, 8),
    postedAt: now(),
  });

  return { status: 200, body: { ok: true } };
}
