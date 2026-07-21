/**
 * Phase 3b (cross-device QR pairing) — quarantine review-alert
 * scheduler. Mirrors `rePairAlerts.ts`.
 *
 * A collaborator's device joins a multi-device account by scanning the
 * admin's pairing QR; it receives the UMK out-of-band over the sealed
 * relay and registers as a NON-ADMIN peer that is quarantined for 14
 * days (`push_tokens.quarantine_until = admit + 14d`, stamped by
 * `handlePushRegister`'s `quarantine` flag). While the device is in
 * quarantine the server fires "review your trusted devices — a new
 * device joined N days ago" pushes to the owner's OTHER devices on a
 * ladder relative to the admit time, so an unauthorized scan-in gets
 * noticed and revoked before the window lifts.
 *
 *   bit 0 = T+0   — fired on the first cron tick after admit
 *   bit 1 = T+1d
 *   bit 2 = T+3d
 *   bit 3 = T+7d
 *   bit 4 = T+13d — last nudge before the 14-day quarantine lifts
 *
 * **Idempotency.** `orInQuarantineAlertBit` OR-s the bit at the
 * database; a second cron tick that catches the same row past the same
 * offset is a no-op (the bit is already set). This lets a 10-minute
 * cron run safely without missing a window. The bit is stamped only
 * AFTER the push succeeds, so a transient push outage doesn't strand
 * the alert (the next tick retries because the bit is still clear).
 *
 * **Targets the owner's OTHER devices.** The newly-admitted (suspect)
 * device is excluded from the fan-out — the whole point is to alert the
 * devices the owner already trusts, not the device under review.
 */

import type {
  AuditEventStorage,
  PushTokenRecord,
  PushTokenStorage,
} from "@flagship/storage";
import { recordAuditEvent } from "./auditEvents.js";
import type { V12PushFanout } from "./totp.js";

export const QUARANTINE_ALERT_BIT_T0 = 1;
export const QUARANTINE_ALERT_BIT_T1D = 2;
export const QUARANTINE_ALERT_BIT_T3D = 4;
export const QUARANTINE_ALERT_BIT_T7D = 8;
export const QUARANTINE_ALERT_BIT_T13D = 16;

interface QuarantineOffset {
  bit: number;
  /** Wall-clock ms since the admit (`registeredAt`) after which the bit becomes due. */
  msSinceAdmit: number;
  /** Friendly label that ends up in the push category / audit detail. */
  label: string;
}

const QUARANTINE_OFFSETS: readonly QuarantineOffset[] = [
  { bit: QUARANTINE_ALERT_BIT_T0, msSinceAdmit: 0, label: "quarantine-admit" },
  { bit: QUARANTINE_ALERT_BIT_T1D, msSinceAdmit: 1 * 86_400_000, label: "quarantine-1d-reminder" },
  { bit: QUARANTINE_ALERT_BIT_T3D, msSinceAdmit: 3 * 86_400_000, label: "quarantine-3d-reminder" },
  { bit: QUARANTINE_ALERT_BIT_T7D, msSinceAdmit: 7 * 86_400_000, label: "quarantine-7d-reminder" },
  { bit: QUARANTINE_ALERT_BIT_T13D, msSinceAdmit: 13 * 86_400_000, label: "quarantine-13d-reminder" },
];

export interface QuarantinePushFireRequest {
  username: string;
  category: string;
  /** The quarantined device's token id (so the fan-out can EXCLUDE it). */
  quarantinedTokenId: string;
  /** Opaque account-scoped device identity. */
  quarantinedDeviceId: string;
  quarantineUntil: number;
  admittedAt: number;
  bit: number;
}

export interface QuarantineAlertsDeps {
  pushTokens: PushTokenStorage;
  /**
   * Phase 3b contract — fire-and-forget push. Tests inject a recording
   * stub via `firePush`; the Worker leaves it unset and instead passes
   * the high-level `pushFanout` + `auditEvents`, from which a default
   * `firePush` is synthesised. When BOTH are passed, `firePush` wins
   * (the explicit override knob — same shape as rePairAlerts).
   *
   * The callback is awaited and failures are swallowed by the
   * scheduler so a failed push doesn't block the bitmap-OR (the next
   * tick retries automatically because the bit isn't set yet).
   */
  firePush?: (req: QuarantinePushFireRequest) => Promise<void>;
  /**
   * Phase 3b — real push fan-out (same shape as the v1.2 re-pair
   * alert path). When wired, the synthesised firePush:
   *   1. Resolves the owner's push tokens via `pushTokens.listByUser`.
   *   2. EXCLUDES the quarantined device's own token from the targets.
   *   3. Emits a "quarantine-alert" audit row capturing the bit fired.
   *   4. Calls pushFanout with the remaining targets + a typed payload.
   */
  pushFanout?: V12PushFanout;
  auditEvents?: AuditEventStorage;
  /** Cron tick wall-clock; tests inject a fixed value. */
  now: () => number;
  /** Defaults to 100; only matters for very large fan-outs. */
  scanLimit?: number;
}

export interface QuarantineSchedulerResult {
  scanned: number;
  fired: Array<{ username: string; tokenId: string; bit: number; category: string }>;
}

export async function scheduleQuarantineAlerts(
  deps: QuarantineAlertsDeps,
): Promise<QuarantineSchedulerResult> {
  const now = deps.now();
  const rows = await deps.pushTokens.listQuarantined(now, deps.scanLimit ?? 100);

  const firePush: (req: QuarantinePushFireRequest) => Promise<void> =
    deps.firePush ?? buildDefaultFirePush(deps);

  const fired: QuarantineSchedulerResult["fired"] = [];
  for (const row of rows) {
    const bits = row.quarantineAlertsFiredBitmap ?? 0;
    const admittedAt = row.registeredAt;
    for (const off of QUARANTINE_OFFSETS) {
      if (bits & off.bit) continue;
      if (now - admittedAt < off.msSinceAdmit) continue;
      await firePushAndStamp(deps, firePush, row, off.bit, off.label);
      fired.push({
        username: row.username,
        tokenId: row.tokenId,
        bit: off.bit,
        category: off.label,
      });
    }
  }

  return { scanned: rows.length, fired };
}

/**
 * Wrap the high-level (pushFanout, auditEvents) deps into a firePush
 * callback. Resolves the owner's tokens, drops the quarantined device's
 * own token, composes a typed payload keyed off the bit, fans out, and
 * emits an audit row. Throws on push failure exactly like the legacy
 * stub so the "transient outage → bit stays clear" guarantee holds.
 */
function buildDefaultFirePush(
  deps: QuarantineAlertsDeps,
): (req: QuarantinePushFireRequest) => Promise<void> {
  return async (req: QuarantinePushFireRequest) => {
    if (deps.pushFanout) {
      const rows = await deps.pushTokens.listByUser(req.username);
      // Alert the owner's OTHER devices — never the device under review.
      const targets = rows.filter((p) => p.tokenId !== req.quarantinedTokenId);
      if (targets.length > 0) {
        const day = labelDays(req.bit);
        const body =
          day === 0
            ? "A new device joined your account. Unlock Flagship to review it."
            : `A device joined ${day} day${day === 1 ? "" : "s"} ago and is still under review. Unlock Flagship to review it.`;
        await deps.pushFanout({
          username: req.username.toLowerCase(),
          targets: targets.map((p) => ({
            tokenId: p.tokenId,
            platform: p.platform,
            providerToken: p.providerToken,
          })),
          payload: {
            category: req.category,
            title: "Review your trusted devices",
            body,
            deepLink: `flagship://account/devices?u=${encodeURIComponent(
              req.username.toLowerCase(),
            )}`,
            meta: {
              eventKind: req.category,
              bit: req.bit,
              deviceIdPrefix: (req.quarantinedDeviceId ?? "").slice(0, 8),
              quarantineUntil: req.quarantineUntil,
              admittedAt: req.admittedAt,
            },
          },
        });
      }
    }
    if (deps.auditEvents) {
      await recordAuditEvent(
        { auditEvents: deps.auditEvents },
        {
          username: req.username.toLowerCase(),
          eventKind: "device-added",
          detail: `Quarantine review reminder (${req.category})`,
          devicePrefix: req.quarantinedTokenId.slice(0, 8),
          postedAt: Date.now(),
          quarantineUntil: req.quarantineUntil,
        },
      );
    }
  };
}

function labelDays(bit: number): number {
  switch (bit) {
    case QUARANTINE_ALERT_BIT_T0: return 0;
    case QUARANTINE_ALERT_BIT_T1D: return 1;
    case QUARANTINE_ALERT_BIT_T3D: return 3;
    case QUARANTINE_ALERT_BIT_T7D: return 7;
    case QUARANTINE_ALERT_BIT_T13D: return 13;
    default: return 0;
  }
}

async function firePushAndStamp(
  deps: QuarantineAlertsDeps,
  firePush: (req: QuarantinePushFireRequest) => Promise<void>,
  row: PushTokenRecord,
  bit: number,
  category: string,
): Promise<void> {
  try {
    await firePush({
      username: row.username,
      category,
      quarantinedTokenId: row.tokenId,
      quarantinedDeviceId: row.deviceId,
      quarantineUntil: row.quarantineUntil ?? 0,
      admittedAt: row.registeredAt,
      bit,
    });
  } catch {
    // Swallow — the bit stays clear; next tick retries.
    return;
  }
  // Stamp only after the push succeeded so a transient push outage
  // doesn't permanently strand the alert.
  await deps.pushTokens.orInQuarantineAlertBit(row.tokenId, bit);
}
