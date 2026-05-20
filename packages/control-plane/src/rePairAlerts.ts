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
  PendingRePairRecord,
  PendingRePairStorage,
} from "@flagship/storage";

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
   * Fire-and-forget push. Phase 5 (Audit + push) will replace this
   * stub-friendly callback with a real bridge that fans out to APNs
   * / FCM / Web Push with the correct category + deep-link payload.
   * For Phase 2 we just need a hook so tests can confirm the
   * scheduler chose the right (row, bit) pair.
   *
   * The callback is awaited so a real implementation can defer to
   * `ctx.waitUntil` upstream; failures are caught by the scheduler
   * and a failed push doesn't block the bitmap-OR (the next tick
   * retries automatically because the bit isn't set yet).
   */
  firePush: (req: PushFireRequest) => Promise<void>;
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
      await firePushAndStamp(deps, row, off.bit, off.label);
      fired.push({ username: row.username, bit: off.bit, category: off.label });
    }

    // Urgent ping = completesAt - urgentLeadMs ≤ now < completesAt.
    if (!(bits & ALERT_BIT_URGENT) && now + urgentLeadMs >= row.completesAt && now < row.completesAt) {
      await firePushAndStamp(deps, row, ALERT_BIT_URGENT, "re-pair-urgent");
      fired.push({ username: row.username, bit: ALERT_BIT_URGENT, category: "re-pair-urgent" });
    }
  }

  return { scanned: rows.length, fired };
}

async function firePushAndStamp(
  deps: RePairAlertsDeps,
  row: PendingRePairRecord,
  bit: number,
  category: string,
): Promise<void> {
  try {
    await deps.firePush({
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
