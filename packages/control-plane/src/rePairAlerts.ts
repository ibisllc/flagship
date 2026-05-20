/**
 * v1.2 Phase 2 — pending-re-pair alert scheduler.
 *
 * Walks every non-objected pending_re_pairs row on each cron tick
 * and OR-s in the next-due bit + fires a push when the row crosses
 * one of the documented offsets relative to its `initiatedAt`.
 *
 *   bit 0 = T+0   — fired on initiate (the initiator handler stamps
 *                   this synchronously; the cron picks it up if a
 *                   row somehow lands without it).
 *   bit 1 = T+1d  — single-device 7-day grace reminder #1
 *   bit 2 = T+3d  — single-device 7-day grace reminder #2
 *   bit 3 = T+6d  — single-device 7-day grace reminder #3
 *   bit 4 = T+7d  — last-chance urgent ping (~1h before completesAt)
 *
 * Multi-device flows (24h grace) skip bits 1-3 by construction
 * because their `initiatedAt + 1d` is already past `completesAt`,
 * but the urgent T-1h ping (bit 4 here, repurposed as
 * "completesAt - 1h" for both flows) still fires.
 *
 * Phase 2 fires fire-and-forget pushes with a stub-friendly
 * forwarder: callers wire the real APNs/FCM/Web Push bridge via
 * the `firePush` callback. Tests inject a recording stub and assert
 * the bitmap progression.
 *
 * **Idempotency.** `orInAlertsFiredBit` is atomic at the database;
 * a second cron tick that catches the same row past the same
 * offset is a no-op (the bit is already set). This is what lets a
 * 10-minute cron tick run safely without missing a window.
 */

import type {
  AuditEventStorage,
  PendingRePairRecord,
  PendingRePairStorage,
  PushTokenStorage,
} from "@flagship/storage";
import { recordAuditEvent } from "./auditEvents.js";
import type { V12PushFanout } from "./totp.js";

export const ALERT_BIT_T0 = 1;
export const ALERT_BIT_T1D = 2;
export const ALERT_BIT_T3D = 4;
export const ALERT_BIT_T6D = 8;
export const ALERT_BIT_URGENT = 16; // ~1h before completesAt

interface AlertOffset {
  bit: number;
  /** Wall-clock ms since `initiatedAt` after which the bit becomes due. */
  msSinceInitiated: number;
  /** Friendly label that ends up in the push category / audit detail. */
  label: string;
}

/** Single-device 7-day grace alert ladder. Multi-device skips the
 *  intermediate 1d/3d/6d rungs (the 24h window is too short for
 *  intermediate reminders) but still uses T+0 and the urgent ping. */
const SINGLE_DEVICE_OFFSETS: readonly AlertOffset[] = [
  { bit: ALERT_BIT_T0, msSinceInitiated: 0, label: "re-pair-initiated" },
  { bit: ALERT_BIT_T1D, msSinceInitiated: 1 * 86_400_000, label: "re-pair-1d-reminder" },
  { bit: ALERT_BIT_T3D, msSinceInitiated: 3 * 86_400_000, label: "re-pair-3d-reminder" },
  { bit: ALERT_BIT_T6D, msSinceInitiated: 6 * 86_400_000, label: "re-pair-6d-reminder" },
];

export interface PushFireRequest {
  username: string;
  category: string;
  /** Pending-row metadata for the push body. The push bridge can echo
   *  these into the sealed payload so the receiving device renders
   *  the right deep-link. */
  newIrkPubHex: string;
  oldIrkPubHex: string;
  completesAt: number;
  graceSeconds: number;
  bit: number;
  initiatedAt: number;
}

export interface RePairAlertsDeps {
  pendingRePairs: PendingRePairStorage;
  /**
   * Phase 2 contract — fire-and-forget push. Phase 5 keeps this
   * stub-friendly callback intact so existing tests + dev paths
   * still pass a recording stub, BUT the Worker injects the real
   * fan-out via the high-level deps below
   * (`pushFanout` + `pushTokens` + `auditEvents`) and leaves
   * `firePush` unset; the scheduler then synthesises a default
   * `firePush` from those high-level deps.
   *
   * The callback is awaited so a real implementation can defer to
   * `ctx.waitUntil` upstream; failures are caught by the scheduler
   * and a failed push doesn't block the bitmap-OR (the next tick
   * retries automatically because the bit isn't set yet).
   *
   * Exactly one of `firePush` OR the trio
   * `pushFanout + pushTokens + auditEvents` must be provided; when
   * both are passed, `firePush` wins (the explicit override).
   */
  firePush?: (req: PushFireRequest) => Promise<void>;
  /**
   * v1.2 Phase 5 — real push fan-out. Same shape as the
   * pushBridge.buildPushForwarder output (the Worker wraps the
   * forwarder for this callback). When wired, the scheduler:
   *   1. Resolves the user's push tokens via `pushTokens.listByUser`.
   *   2. Emits a "re-pair-alert" audit row capturing the bit fired.
   *   3. Calls pushFanout with the targets + a typed payload.
   * The `firePush` legacy callback is left unwired by the Worker;
   * Phase 5 tests prove both paths.
   */
  pushFanout?: V12PushFanout;
  pushTokens?: PushTokenStorage;
  auditEvents?: AuditEventStorage;
  /** Cron tick wall-clock; tests inject a fixed value. */
  now: () => number;
  /** Defaults to 100; only matters for very large fan-outs. */
  scanLimit?: number;
  /**
   * Wall-clock ms before completesAt at which the URGENT push
   * fires. Defaults to 1h. Tests inject smaller windows.
   */
  urgentLeadMs?: number;
}

export interface SchedulerResult {
  scanned: number;
  fired: Array<{ username: string; bit: number; category: string }>;
}

export async function schedulePendingRePairAlerts(
  deps: RePairAlertsDeps,
): Promise<SchedulerResult> {
  const now = deps.now();
  const urgentLeadMs = deps.urgentLeadMs ?? 60 * 60_000;
  const rows = await deps.pendingRePairs.listActive(deps.scanLimit ?? 100);

  // v1.2 Phase 5 — synthesise a default firePush from the high-
  // level real-fan-out deps when the caller didn't pass an explicit
  // stub. Worker injects (pushFanout, pushTokens, auditEvents) and
  // leaves firePush unset; tests inject a recording firePush and
  // leave the trio unset. When BOTH are passed, the explicit
  // firePush wins (the override knob).
  const firePush: (req: PushFireRequest) => Promise<void> =
    deps.firePush ?? buildDefaultFirePush(deps);

  const fired: Array<{ username: string; bit: number; category: string }> = [];
  for (const row of rows) {
    const bits = row.alertsFiredBitmap ?? 0;
    const grace = (row.graceSeconds ?? 86_400) * 1000;
    // Single-device gets the 1d/3d/6d ladder; multi only T+0.
    // The urgent ping fires for BOTH (single + multi) when the row
    // is within `urgentLeadMs` of completesAt.
    const isSingle = grace >= 7 * 86_400_000;
    const ladder = isSingle ? SINGLE_DEVICE_OFFSETS : [SINGLE_DEVICE_OFFSETS[0]!];

    for (const off of ladder) {
      if (bits & off.bit) continue;
      if (now - row.initiatedAt < off.msSinceInitiated) continue;
      await firePushAndStamp(deps, firePush, row, off.bit, off.label);
      fired.push({ username: row.username, bit: off.bit, category: off.label });
    }

    // Urgent ping = completesAt - urgentLeadMs ≤ now < completesAt.
    if (!(bits & ALERT_BIT_URGENT) && now + urgentLeadMs >= row.completesAt && now < row.completesAt) {
      await firePushAndStamp(deps, firePush, row, ALERT_BIT_URGENT, "re-pair-urgent");
      fired.push({ username: row.username, bit: ALERT_BIT_URGENT, category: "re-pair-urgent" });
    }
  }

  return { scanned: rows.length, fired };
}

/**
 * v1.2 Phase 5 — wrap the high-level (pushFanout, pushTokens,
 * auditEvents) deps into a firePush callback. The wrapped function:
 *   - resolves the user's push tokens (no-op fan-out if zero),
 *   - composes a typed payload (title/body/deepLink/meta) keyed off
 *     the bit + grace window so the device renders the right copy,
 *   - invokes pushFanout with the resolved targets,
 *   - emits an audit row tagging the bit that fired.
 *
 * The synthesised callback throws on push failure exactly the same
 * way the legacy stub does, so the existing
 * "transient outage → bit stays clear" guarantee is preserved.
 */
function buildDefaultFirePush(
  deps: RePairAlertsDeps,
): (req: PushFireRequest) => Promise<void> {
  return async (req: PushFireRequest) => {
    if (deps.pushFanout && deps.pushTokens) {
      const rows = await deps.pushTokens.listByUser(req.username);
      // Don't error out on a user with zero registered devices —
      // that's a "lost everything" recovery scenario; the audit row
      // still captures the timeline.
      if (rows.length > 0) {
        const isUrgent = req.bit === ALERT_BIT_URGENT;
        const dayLabel = labelForBit(req.bit);
        let body: string;
        if (isUrgent) {
          body = "Your account is about to be taken over in 1 hour. Object now if this isn't you.";
        } else if (dayLabel === "T+0") {
          body = "A new device is trying to take over your account. Tap to review or object.";
        } else {
          body = `Account recovery still pending (${dayLabel}). Tap to review or object.`;
        }
        await deps.pushFanout({
          username: req.username.toLowerCase(),
          targets: rows.map((p) => ({
            tokenId: p.tokenId,
            platform: p.platform,
            providerToken: p.providerToken,
          })),
          payload: {
            category: req.category,
            title: isUrgent
              ? "Account takeover in 1 hour"
              : "Account recovery attempt",
            body,
            deepLink: `flagship://account/re-pair?u=${encodeURIComponent(
              req.username.toLowerCase(),
            )}`,
            meta: {
              eventKind: req.category,
              bit: req.bit,
              completesAt: req.completesAt,
              graceSeconds: req.graceSeconds,
              initiatedAt: req.initiatedAt,
            },
          },
        });
      }
    }
    if (deps.auditEvents) {
      // Audit each bit fired so the Activity feed has a paper trail
      // of how many nudges the user received before the
      // grace window closed. accountTypeAtEvent we don't have on
      // the row directly; infer from grace duration as a pragmatic
      // approximation (multi grace = 24h ⇒ 'multi'; otherwise
      // 'single'). The completion-time audit captures the real
      // type read-through from the username row.
      const isSingle = (req.graceSeconds ?? 86_400) >= 7 * 86_400;
      await recordAuditEvent(
        { auditEvents: deps.auditEvents },
        {
          username: req.username.toLowerCase(),
          eventKind: "device-replaced",
          detail: `Re-pair alert (${req.category})`,
          devicePrefix: req.newIrkPubHex.slice(0, 8),
          postedAt: Date.now(),
          accountTypeAtEvent: isSingle ? "single" : "multi",
        },
      );
    }
  };
}

function labelForBit(bit: number): string {
  switch (bit) {
    case ALERT_BIT_T0: return "T+0";
    case ALERT_BIT_T1D: return "T+1d";
    case ALERT_BIT_T3D: return "T+3d";
    case ALERT_BIT_T6D: return "T+6d";
    case ALERT_BIT_URGENT: return "urgent";
    default: return `bit ${bit}`;
  }
}

async function firePushAndStamp(
  deps: RePairAlertsDeps,
  firePush: (req: PushFireRequest) => Promise<void>,
  row: PendingRePairRecord,
  bit: number,
  category: string,
): Promise<void> {
  try {
    await firePush({
      username: row.username,
      category,
      newIrkPubHex: row.newIrkPubHex,
      oldIrkPubHex: row.oldIrkPubHex,
      completesAt: row.completesAt,
      graceSeconds: row.graceSeconds ?? 86_400,
      bit,
      initiatedAt: row.initiatedAt,
    });
  } catch {
    // Swallow — the bit stays clear; next tick retries.
    return;
  }
  // Stamp only after the push succeeded so a transient push
  // outage doesn't permanently strand the alert.
  await deps.pendingRePairs.orInAlertsFiredBit(row.username, bit);
}
