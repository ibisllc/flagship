// Public-egress metering + quota model — feat/metering.
//
// The only cost that scales with usage is public-ingress traffic routed
// through the `.services` relay (Fly egress, ~$0.02/GB). This module is the
// `.com`-side accounting: the relay reports per-account egress deltas, and we
// answer the relay's gating question — "may this account carry MORE public
// traffic right now?" — plus the user-facing usage status.
//
// Quota model (see docs/monetization-free-tier-first.md for the locked
// pricing + cost basis): free is a HARD CAP (over quota ⇒ the relay stops
// admitting new public traffic); paid tiers bill overage per GB and are never
// throttled. Tier comes from the existing TierStorage; a lapsed paid sub
// (currentPeriodEnd in the past) falls back to free.

import type { TierName, TierStorage, UsageStorage } from "@flagship/storage";
import { malformed } from "./types.js";

const GB = 1024 * 1024 * 1024;

/** Monthly public-egress quota by tier, in bytes. Tune freely — the only hard
 *  constraint is that free-tier worst-case cost = quota × Fly egress
 *  (~$0.02/GB), so 50 GB ⇒ ~$1/mo max exposure per free account. */
export const MONTHLY_EGRESS_QUOTA_BYTES: Record<TierName, number> = {
  free: 50 * GB,
  hobby: 250 * GB,
  maker: 1024 * GB,
};

/** Overage rate above quota, USD per GB (PAID tiers only — free is hard-capped
 *  rather than billed). ~2.5× our ~$0.02/GB Fly cost: covers egress + ops +
 *  margin at the point where a user is genuinely a public service. */
export const OVERAGE_USD_PER_GB = 0.05;

/** UTC "YYYY-MM" period key for a timestamp (the egress quota resets monthly). */
export function periodFor(nowMs: number): string {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
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
  /** May the relay carry MORE public traffic for this account right now?
   *  Free over-quota ⇒ false (hard cap). Paid ⇒ always true (bills overage). */
  admit: boolean;
  /** Overage owed this period (paid tiers only); 0 for free. */
  overageUsd: number;
}

export interface MeteringDeps {
  usage: UsageStorage;
  tiers: TierStorage;
  now?: () => number;
}

function nowMs(deps: MeteringDeps): number {
  return deps.now ? deps.now() : Date.now();
}

/** Effective tier for an account: a lapsed paid sub falls back to free. */
async function effectiveTier(deps: MeteringDeps, username: string): Promise<TierName> {
  const rec = await deps.tiers.get(username);
  if (!rec || rec.tier === "free") return "free";
  if (rec.currentPeriodEnd !== undefined && rec.currentPeriodEnd < nowMs(deps)) {
    return "free"; // subscription lapsed
  }
  return rec.tier;
}

function statusFrom(tier: TierName, period: string, usedBytes: number): QuotaStatus {
  const quotaBytes = quotaBytesForTier(tier);
  const overQuota = usedBytes > quotaBytes;
  const overBytes = Math.max(0, usedBytes - quotaBytes);
  const isFree = tier === "free";
  return {
    tier,
    period,
    usedBytes,
    quotaBytes,
    remainingBytes: Math.max(0, quotaBytes - usedBytes),
    overQuota,
    // Free is a hard cap; paid is never throttled (it bills overage).
    admit: isFree ? !overQuota : true,
    overageUsd: isFree ? 0 : (overBytes / GB) * OVERAGE_USD_PER_GB,
  };
}

/** Record `bytes` of public egress for an account; return the post-add status
 *  (the relay uses `.admit` to decide whether to keep carrying traffic). */
export async function recordEgress(
  deps: MeteringDeps,
  username: string,
  bytes: number,
): Promise<QuotaStatus> {
  const now = nowMs(deps);
  const period = periodFor(now);
  const used = await deps.usage.addEgress(username.toLowerCase(), period, bytes, now);
  const tier = await effectiveTier(deps, username.toLowerCase());
  return statusFrom(tier, period, used);
}

/** Read current quota status WITHOUT recording usage (dashboard + pre-flight
 *  admit check). */
export async function quotaStatus(deps: MeteringDeps, username: string): Promise<QuotaStatus> {
  const now = nowMs(deps);
  const period = periodFor(now);
  const u = username.toLowerCase();
  const rec = await deps.usage.get(u, period);
  const tier = await effectiveTier(deps, u);
  return statusFrom(tier, period, rec?.bytesEgress ?? 0);
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
 *  account's post-update admit/quota status so the relay can immediately drop
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
