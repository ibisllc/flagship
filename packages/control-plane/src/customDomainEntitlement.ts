// Custom domains are a Pro feature (owner decision 2026-10-09,
// docs/monetization-free-tier-first.md §3): Free gets none, Pro ("hobby") one,
// Pro Max ("maker") unlimited. `.com` is the only authority over which external
// hostnames the relay routes — the hub routes a custom domain only after `.com`
// pushes (or serves via the lazy lookup) a redirection — so the tier rule is
// enforced here, at order time, in the verifier sweep, and on the two lookup
// endpoints the hub reads.
import type { CustomDomainOrderRecord, TierName, TierStorage } from "@flagship/storage";
import { effectiveTierOf } from "./metering.js";

export const CUSTOM_DOMAIN_LIMITS: Readonly<Record<TierName, number>> = {
  free: 0,
  hobby: 1,
  maker: Number.POSITIVE_INFINITY,
};

/** Hostnames that are ours and can never be someone's custom domain. */
const OWN_ZONES = ["flagship.services", "flagshipserver.com", "voi.ci"];

export function isOwnZone(fqdn: string): boolean {
  const f = fqdn.trim().toLowerCase().replace(/\.$/, "");
  return OWN_ZONES.some((z) => f === z || f.endsWith("." + z));
}

/**
 * A domain whose subscription lapsed is parked as `pending` with its serving
 * pod still recorded — only a once-active order has `podCanonical` — rather
 * than a new status (the table's CHECK allows pending/active/failed only, and
 * rebuilding it in production isn't worth one state). The verifier never gives
 * up on a suspended order and re-activates it when the tier allows again.
 */
export function isSuspended(r: CustomDomainOrderRecord): boolean {
  return r.status === "pending" && !!r.podCanonical;
}

export interface CustomDomainAllowance {
  tier: TierName;
  limit: number;
}

export async function customDomainAllowance(
  tiers: TierStorage,
  username: string,
  nowMs: number,
): Promise<CustomDomainAllowance> {
  const tier = await effectiveTierOf(tiers, username, nowMs);
  return { tier, limit: CUSTOM_DOMAIN_LIMITS[tier] };
}

export const TIER_REQUIRED_ERROR = "Custom domains are part of Pro — upgrade to add one.";
export function overLimitError(limit: number): string {
  return `Your plan includes ${limit} custom domain${limit === 1 ? "" : "s"} — remove one, or move to Pro Max for unlimited.`;
}
