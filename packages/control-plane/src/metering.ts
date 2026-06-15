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
//
// Reports carry a batch id (counted at most once) and every answer carries a
// budget lease per account (EGRESS_LEASE_POLICY), which the relay enforces
// locally until it reports again: billing/docs/spec/report-and-lease-v1.md,
// docs/metering.md.

import type { TierName } from "@flagship/storage";
import { METER_BATCH_ID_RE, meterLease, type MeterLease, type MeterLeasePolicy } from "@ibisllc/billing-metering";
import {
  METER_RESOURCES,
  meterCheck,
  meterPeriodKey,
  meterRecord,
  meterReportBatch,
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

const MiB = 1024 * 1024;

/** How big a budget lease the relay gets per account
 *  (billing/docs/spec/report-and-lease-v1.md). A quarter of what is left,
 *  between 1 MiB and 256 MiB: a free account far from 25 GB reports about
 *  every 128 MiB, one near it every few MiB, and one relay can never carry
 *  it past the allowance on a lease. 256 MiB also bounds what a relay crash
 *  loses per account. Throttled leases last a minute, so an upgrade or the
 *  new month lifts the throttle within about a minute of activity. */
export const EGRESS_LEASE_POLICY: MeterLeasePolicy = {
  fraction: 0.25,
  minGrant: 1 * MiB,
  maxGrant: 256 * MiB,
  ttlMs: 10 * 60_000,
  overTtlMs: 60_000,
};

/** Most accounts one report may carry: the relay's batch size. Each is one
 *  statement in the report's D1 batch, and a Worker invocation may run 1000
 *  queries, so this leaves headroom. */
export const MAX_USAGE_REPORT_ITEMS = 500;

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

/** The lease for one account on the wire (bytes, relative ttl). */
export interface EgressLeaseWire {
  action: MeterLease["action"];
  grantBytes: number;
  policy: MeterLease["policy"];
  ttlMs: number;
}

export interface UsageReportResult {
  username: string;
  /** The verdict on the counted total ("may it carry more at full speed?").
   *  What a relay that predates leases acts on. */
  admit: boolean;
  usedBytes: number;
  quotaBytes: number;
  lease: EgressLeaseWire;
}

/** `POST /api/usage/report` — body `{ batchId?, items: [{ username, bytes }] }`.
 *
 *  The relay batches per-account egress deltas. With a `batchId` (16–128
 *  chars of [A-Za-z0-9_-]) the batch is counted at most once, so the relay
 *  can retry a batch whose answer it lost; `duplicate: true` says it had
 *  already been counted. Without one (relays from before leases) it is
 *  counted as it arrives; that path stays until every relay sends ids.
 *
 *  Each result carries `admit` (the old wire) and a budget `lease`: what the
 *  relay may carry for the account at full speed before reporting again. */
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
  const b = body as { items?: unknown; batchId?: unknown } | null;
  const items = b?.items;
  if (!Array.isArray(items)) return malformed("items[] required");
  if (items.length > MAX_USAGE_REPORT_ITEMS) return malformed(`at most ${MAX_USAGE_REPORT_ITEMS} items per report`);
  const batchId = b?.batchId;
  if (batchId !== undefined && (typeof batchId !== "string" || !METER_BATCH_ID_RE.test(batchId))) {
    return malformed("batchId must be 16–128 characters of [A-Za-z0-9_-]");
  }
  const report: Array<{ account: string; resource: "egress"; amount: number }> = [];
  for (const raw of items) {
    const it = raw as { username?: unknown; bytes?: unknown };
    if (typeof it.username !== "string" || typeof it.bytes !== "number" || !Number.isFinite(it.bytes)) {
      return malformed("each item needs { username: string, bytes: number }");
    }
    report.push({ account: it.username, resource: "egress", amount: Math.max(0, it.bytes) });
  }
  const r = await meterReportBatch(deps, { ...(batchId !== undefined ? { batchId } : {}), items: report });
  const now = deps.now ? deps.now() : Date.now();
  const results: UsageReportResult[] = r.verdicts.map((v) => {
    const l = meterLease(v, EGRESS_LEASE_POLICY, now);
    return {
      username: v.account,
      admit: v.action === "allow",
      usedBytes: v.used,
      quotaBytes: v.allowance,
      lease: { action: l.action, grantBytes: l.grant, policy: l.policy, ttlMs: l.ttlMs },
    };
  });
  return { status: 200, body: { ok: true, duplicate: r.duplicate, results } };
}

/** Dashboard-shaped allowance view (the public `/allowance` body). Same numbers
 *  as `QuotaStatus` but framed for a user, not the relay: it drops the relay's
 *  `admit` flag and adds a `usedFraction` (0..1, clamped) + a coarse `state`
 *  the clients colour on without re-deriving thresholds. */
export interface AllowanceView {
  username: string;
  tier: TierName;
  period: string;
  usedBytes: number;
  quotaBytes: number;
  remainingBytes: number;
  usedFraction: number;
  overQuota: boolean;
  overageUsd: number;
  /** "ok" < 80% · "approaching" ≥ 80% & ≤ 100% · "over" > 100%. The #7 upgrade
   *  alert fires on "approaching"/"over"; free + "over" is the hard cap. */
  state: "ok" | "approaching" | "over";
  /** Free tier is a hard cap (blocked when over); paid bills overage instead. */
  hardCapped: boolean;
}

const APPROACHING_FRACTION = 0.8;

export function allowanceViewFrom(username: string, s: QuotaStatus): AllowanceView {
  const usedFraction = s.quotaBytes > 0 ? Math.min(1, s.usedBytes / s.quotaBytes) : 0;
  const state: AllowanceView["state"] = s.overQuota
    ? "over"
    : s.usedBytes / Math.max(1, s.quotaBytes) >= APPROACHING_FRACTION
      ? "approaching"
      : "ok";
  return {
    username: username.toLowerCase(),
    tier: s.tier,
    period: s.period,
    usedBytes: s.usedBytes,
    quotaBytes: s.quotaBytes,
    remainingBytes: s.remainingBytes,
    usedFraction,
    overQuota: s.overQuota,
    overageUsd: s.overageUsd,
    state,
    hardCapped: s.tier === "free" && s.overQuota,
  };
}

/** `GET /api/users/:u/allowance` — PUBLIC, unauthenticated read of a user's
 *  current public-bandwidth allowance (the #6 dashboard + #7 alert data
 *  source). This is account METADATA only (tier + a byte total for the month,
 *  no content, no keys), the same disclosure class as the unauthenticated
 *  `/pods` directory — so it carries no secret, but the route MUST rate-limit
 *  it. Returns 0-usage/free defaults for an unknown username (no oracle on
 *  existence beyond what `/pods` already gives). */
export async function handleUserAllowance(
  deps: MeteringDeps,
  username: string | null,
): Promise<UsageHttpResult> {
  const u = String(username ?? "").trim().toLowerCase();
  if (!/^[a-z0-9]{3,30}$/.test(u)) return { status: 400, body: { error: "valid username required" } };
  const s = await quotaStatus(deps, u);
  return { status: 200, body: { ok: true, ...allowanceViewFrom(u, s) } };
}

/** `GET /api/usage/status?username=<u>` — read-only quota status. Same shared
 *  secret (the relay's pre-flight admit check + an admin/dashboard read).
 *  NOTE: this is account METADATA (no content), but it's gated to internal
 *  callers; the user-facing dashboard reads it through `handleUserAllowance`. */
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
