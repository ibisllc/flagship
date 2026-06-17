/**
 * v1.2 Phase 2 — pending-re-pair alert scheduler.
 *
 * Walks every non-objected pending_re_pairs row on each cron tick
 * and OR-s in the next-due bit + fires a push when the row crosses
 * one of the documented offsets relative to its `initiatedAt`.
 *
 *   bit 0 = T+0      — fired on initiate (the initiator handler stamps
 *                      this synchronously; the cron picks it up if a
 *                      row somehow lands without it).
 *   bit 1 = ~⅓-grace — single-device objection reminder #1
 *   bit 2 = ~⅔-grace — single-device objection reminder #2
 *   bit 3 = (reserved) — historical T+6d rung, retired when the grace
 *                      shrank 7d→3d; the constant is kept so persisted
 *                      bitmaps stay stable but no rung fires it now.
 *   bit 4 = urgent   — last-chance ping (~1h before completesAt)
 *
 * **Grace-relative, not day-pinned.** The single-device grace shrank
 * from 7 days to 3 (`RE_PAIR_SINGLE_GRACE_MS`), and the takeover window
 * IS the objection window — a stranger who knows the username can
 * initiate with no second factor, so the owner's other devices must be
 * nudged to object DURING the grace. A 7-day-pinned ladder (T+1d/T+3d/
 * T+6d) fired zero intermediate reminders inside a 3-day window. The
 * rungs are now FRACTIONS of the row's own grace (⅓ + ⅔), so they land
 * meaningfully whatever the grace length: ~day-1 and ~day-2 for the
 * 3-day single-device window, and they'd still space correctly if the
 * grace were ever retuned.
 *
 * Multi-device flows (24h grace) skip the fractional rungs by
 * construction (the window is too short for intermediate nudges and a
 * TOTP proof is required before the grace even starts), but the urgent
 * "completesAt - 1h" ping (bit 4) still fires for both flows.
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

// NOTE: these numeric values are a PERSISTED bitfield
// (`pending_re_pairs.alerts_fired_bitmap` in D1 / InMemory). Never
// renumber them — a deploy that shifted a bit would re-fire (or skip)
// alerts on in-flight rows. The SEMANTICS of bits 1/2 changed from
// day-pinned offsets to grace fractions; the bit VALUES did not.
/**
 * Multi-device grace (24h). Mirrors `RE_PAIR_GRACE_MS` in rePair.ts but
 * declared locally to avoid a module cycle (rePair.ts already imports
 * ALERT_BIT_T0 from here). The single-device ladder fires only for rows
 * whose grace EXCEEDS this; the 24h multi window gets T+0 + urgent only.
 */
const MULTI_DEVICE_GRACE_MS = 24 * 60 * 60_000;

export const ALERT_BIT_T0 = 1;
export const ALERT_BIT_T1D = 2; // first intermediate reminder (~⅓ grace)
export const ALERT_BIT_T3D = 4; // second intermediate reminder (~⅔ grace)
export const ALERT_BIT_T6D = 8; // reserved — retired 7d-only rung (kept for bitmap stability)
export const ALERT_BIT_URGENT = 16; // ~1h before completesAt

interface AlertOffset {
  bit: number;
  /**
   * Fraction of the row's OWN grace window (initiatedAt → completesAt)
   * after which the bit becomes due. Grace-relative so the ladder
   * spaces correctly whatever the grace length (3d single-device today;
   * resilient if it's ever retuned). T+0 is fraction 0.
   */
  graceFraction: number;
  /** Friendly label that ends up in the push category / audit detail. */
  label: string;
}

/** Single-device grace alert ladder, grace-RELATIVE (see the file
 *  header). T+0 plus two intermediate objection reminders at ~⅓ and ~⅔
 *  of the window; the urgent ping (handled separately, below) covers
 *  the ~1h-before-completesAt slot. Multi-device skips the intermediate
 *  rungs (the 24h window is too short, and a second factor already
 *  gated the initiate) but still uses T+0 and the urgent ping. */
const SINGLE_DEVICE_OFFSETS: readonly AlertOffset[] = [
  { bit: ALERT_BIT_T0, graceFraction: 0, label: "re-pair-initiated" },
  { bit: ALERT_BIT_T1D, graceFraction: 1 / 3, label: "re-pair-reminder-1" },
  { bit: ALERT_BIT_T3D, graceFraction: 2 / 3, label: "re-pair-reminder-2" },
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
    // Single-device gets the full grace-relative ladder (T+0 + the ⅓/⅔
    // intermediate reminders); multi gets only T+0. The discriminator
    // is the grace LENGTH, not a 7-day assumption: anything longer than
    // the multi-device 24h grace (MULTI_DEVICE_GRACE_MS) is single-
    // device (single is 3 days; a `>` keeps the boundary off the exact
    // 24h multi value). The urgent
    // ping below fires for BOTH when the row is within `urgentLeadMs`
    // of completesAt.
    const isSingle = grace > MULTI_DEVICE_GRACE_MS;
    const ladder = isSingle ? SINGLE_DEVICE_OFFSETS : [SINGLE_DEVICE_OFFSETS[0]!];

    for (const off of ladder) {
      if (bits & off.bit) continue;
      // Grace-relative due-time: initiatedAt + fraction × grace. T+0
      // (fraction 0) is due immediately. Using `grace` rather than
      // (completesAt - initiatedAt) keeps the rungs stable even if the
      // two ever drift; they're equal by construction at initiate.
      const dueAt = row.initiatedAt + off.graceFraction * grace;
      if (now < dueAt) continue;
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
        const isInitial = req.bit === ALERT_BIT_T0;
        let body: string;
        if (isUrgent) {
          body = "Your account is about to be taken over in 1 hour. Object now if this isn't you.";
        } else if (isInitial) {
          body = "A new device is trying to take over your account. Tap to review or object.";
        } else {
          // Intermediate objection reminder. Deliberately grace-length-
          // agnostic copy (no day count) — the rungs are now fractions
          // of the grace window, not fixed days.
          body = "Account recovery still pending. Tap to review or object before the window closes.";
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
      // approximation (multi grace = 24h ⇒ 'multi'; anything longer ⇒
      // 'single', which is 3 days). The completion-time audit captures
      // the real type read-through from the username row.
      const isSingle = (req.graceSeconds ?? 86_400) * 1000 > MULTI_DEVICE_GRACE_MS;
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
