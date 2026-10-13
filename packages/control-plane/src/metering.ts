// Public-egress metering + quota model — the "egress" resource of the
// metering core (meter.ts).
//
// The only cost that scales with usage is public-ingress traffic routed
// through the `.services` relay (Fly egress, ~$0.02/GB). This module is the
// `.com`-side accounting: the relay reports per-account egress deltas, and we
// answer the relay's gating question — "may this account carry MORE public
// traffic at full speed right now?" — plus the user-facing usage status.
//
// Quota model (see docs/monetization-free-tier-first.md for the locked
// pricing + cost basis): free is capped (over quota ⇒ `admit:false`, and the
// relay slows the account to a speed limit rather than refusing it, so an
// owner can still reach their own box); paid tiers bill overage per GB and are
// never throttled. Tier comes from the existing TierStorage; a lapsed paid sub
// (currentPeriodEnd in the past) falls back to free. The allowances and the
// over-quota policy live in meter.ts's METER_RESOURCES.egress.

import type { TierName } from "@flagship/storage";
import {
  METER_RESOURCES,
  meterCheck,
  meterPeriodKey,
  meterRecord,
  type MeterDeps,
  type MeterVerdict,
} from "./meter.js";
import { malformed } from "./types.js";

export { effectiveTierOf } from "./meter.js";

const GB = 1024 * 1024 * 1024;

/** Monthly public-egress quota by tier, in bytes (METER_RESOURCES.egress). */
export const MONTHLY_EGRESS_QUOTA_BYTES: Record<TierName, number> = {
  free: METER_RESOURCES.egress.plans.free.allowance,
  hobby: METER_RESOURCES.egress.plans.hobby.allowance,
  maker: METER_RESOURCES.egress.plans.maker.allowance,
};

/** Overage rate above quota, USD per GB (PAID tiers only — free is throttled
 *  rather than billed). ~2.5× our ~$0.02/GB Fly cost: covers egress + ops +
 *  margin at the point where a user is genuinely a public service. */
export const OVERAGE_USD_PER_GB = 0.05;

/** UTC "YYYY-MM" period key for a timestamp (the egress quota resets monthly). */
export function periodFor(nowMs: number): string {
  return meterPeriodKey("month", nowMs);
}

export function quotaBytesForTier(tier: TierName): number {
  return MONTHLY_EGRESS_QUOTA_BYTES[tier] ?? MONTHLY_EGRESS_QUOTA_BYTES.free;
}

export interface QuotaStatus {
  tier: TierName;
  period: string;
  usedBytes: number;
  quotaBytes: number;
  remainingBytes: number;
  overQuota: boolean;
  /** May the relay carry MORE public traffic at full speed for this account
   *  right now? Free over-quota ⇒ false (the relay throttles it). Paid ⇒
   *  always true (bills overage). */
  admit: boolean;
  /** Overage owed this period (paid tiers only); 0 for free. */
  overageUsd: number;
}

export type MeteringDeps = MeterDeps;

function statusFrom(v: MeterVerdict): QuotaStatus {
  const billed = v.policy === "allow";
  return {
    tier: v.tier,
    period: v.period,
    usedBytes: v.used,
    quotaBytes: v.allowance,
    remainingBytes: v.remaining,
    overQuota: v.over,
    admit: v.action === "allow",
    overageUsd: billed ? (Math.max(0, v.used - v.allowance) / GB) * OVERAGE_USD_PER_GB : 0,
  };
}

/** Record `bytes` of public egress for an account; return the post-add status
 *  (the relay uses `.admit` to decide whether to keep full speed). A negative
 *  delta records nothing. */
export async function recordEgress(
  deps: MeteringDeps,
  username: string,
  bytes: number,
): Promise<QuotaStatus> {
  return statusFrom(await meterRecord(deps, username, "egress", Math.max(0, bytes)));
}

/** Read current quota status WITHOUT recording usage (dashboard + pre-flight
 *  admit check). */
export async function quotaStatus(deps: MeteringDeps, username: string): Promise<QuotaStatus> {
  return statusFrom(await meterCheck(deps, username, "egress"));
}

// ──────────────────────────────────────────────────────────────────────
// HTTP handlers — the relay (.services) ↔ .com surface.
//
// The relay is trusted INTERNAL infrastructure (not the phone/box), so these
// authenticate with a shared secret (the same pattern as the boot notify
// bridge), NOT a user signature. Constant-time compare on the secret.
// ──────────────────────────────────────────────────────────────────────

function secretsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface UsageHttpResult {
  status: number;
  body: unknown;
}

/** `POST /api/usage/report` — body `{ items: [{ username, bytes }, ...] }`.
 *  The relay batches per-account egress deltas and posts them. Returns each
 *  account's post-update admit/quota status so the relay can immediately slow
 *  a free account that just crossed its cap. */
export async function handleUsageReport(
  deps: MeteringDeps,
  presentedSecret: string | null,
  expectedSecret: string | undefined,
  body: unknown,
): Promise<UsageHttpResult> {
  if (!expectedSecret) return { status: 503, body: { error: "metering not configured" } };
  if (!presentedSecret || !secretsEqual(presentedSecret, expectedSecret)) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items)) return malformed("items[] required");
  const results: Array<{ username: string; admit: boolean; usedBytes: number; quotaBytes: number }> = [];
  for (const raw of items) {
    const it = raw as { username?: unknown; bytes?: unknown };
    if (typeof it.username !== "string" || typeof it.bytes !== "number" || !Number.isFinite(it.bytes)) {
      return malformed("each item needs { username: string, bytes: number }");
    }
    const s = await recordEgress(deps, it.username, it.bytes);
    results.push({ username: it.username.toLowerCase(), admit: s.admit, usedBytes: s.usedBytes, quotaBytes: s.quotaBytes });
  }
  return { status: 200, body: { ok: true, results } };
}

/** `GET /api/usage/status?username=<u>` — read-only quota status. Same shared
 *  secret (the relay's pre-flight admit check + an admin/dashboard read).
 *  NOTE: this is account METADATA (no content), but it's gated to internal
 *  callers; the user-facing dashboard reads it through the existing
 *  TierStatus surface, not here. */
export async function handleUsageStatus(
  deps: MeteringDeps,
  presentedSecret: string | null,
  expectedSecret: string | undefined,
  username: string | null,
): Promise<UsageHttpResult> {
  if (!expectedSecret) return { status: 503, body: { error: "metering not configured" } };
  if (!presentedSecret || !secretsEqual(presentedSecret, expectedSecret)) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  if (!username) return malformed("username required");
  const s = await quotaStatus(deps, username);
  return { status: 200, body: { ok: true, ...s } };
}
