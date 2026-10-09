// Async custom-domain verifier (#79B) + #82 re-verify sweep.
//
// The .com POST only RECORDS an order (Phase 2). This runs out-of-band
// (Worker cron) and is the authoritative CNAME check:
//
//   PENDING  → resolve the fqdn's CNAME (server-side DoH). If it
//              targets the user's stub `<username>.flagship.services`
//              AND the user has a live pod: status→active, store the
//              serving podCanonical, pushRedirection("add"); reset
//              failCount. If not yet, retry next pass; give up
//              (→failed + pushRedirection("delete")) after 24h.
//   ACTIVE   → #82 sweep: re-verify every ~12h. A success resets
//              failCount (transient blips self-heal). 3 consecutive
//              due-fails (which, at the 12h cadence, inherently span
//              ≥24h) → invalidate: status→failed +
//              pushRedirection("delete"). A fixed-enum reason only —
//              never free-form from attacker-controlled DNS.
//
// The CNAME-targets-stub proof works because setting
// `shop.example.com` CNAME → `<user>.flagship.services` already
// requires controlling example.com's DNS, and the target encodes
// which user — an attacker can't CNAME a victim's domain to a
// victim's stub on the victim's behalf.

import type {
  CustomDomainOrderStorage,
  CustomDomainOrderRecord,
  ServerStorage,
  TierStorage,
} from "@flagship/storage";
import {
  customDomainAllowance,
  isSuspended,
  type CustomDomainAllowance,
} from "./customDomainEntitlement.js";

/** plan §2 defaults — all cheap to change. */
export const GIVEUP_MS = 24 * 60 * 60_000;
export const REVERIFY_INTERVAL_MS = 12 * 60 * 60_000;
/** 3 consecutive due re-verify fails. At REVERIFY_INTERVAL_MS=12h a
 *  3rd fail is inherently ≥24h after the first, so the plan's
 *  "spanning ≥24h" is enforced by the cadence, not a separate clock. */
export const INVALIDATE_FAILS = 3;

interface DohAnswer {
  name?: string;
  type?: number;
  data?: string;
}

/**
 * Resolve `fqdn`'s CNAME via the Cloudflare public DoH JSON resolver.
 * Returns the CNAME target(s), lowercased + trailing-dot stripped, or
 * [] (no CNAME / NXDOMAIN / network error — verification simply
 * doesn't pass; it never throws into the pass loop).
 */
export async function resolveCnameChain(
  fqdn: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  try {
    const res = await fetchImpl(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(fqdn)}&type=CNAME`,
      { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return [];
    const j = (await res.json()) as { Answer?: DohAnswer[] };
    return (j.Answer ?? [])
      .filter((a) => a.type === 5 && typeof a.data === "string") // 5 = CNAME
      .map((a) => a.data!.replace(/\.$/, "").toLowerCase());
  } catch {
    return [];
  }
}

/** username → the stub a custom domain must CNAME to. */
export function userStub(username: string): string {
  return `${username.toLowerCase()}.flagship.services`;
}

/** Does the resolved CNAME chain target the user's stub? */
export function cnameTargetsStub(chain: string[], username: string): boolean {
  const stub = userStub(username);
  return chain.some((t) => t === stub);
}

export interface VerifierDeps {
  customDomainOrders: CustomDomainOrderStorage;
  servers: ServerStorage;
  /** Paid-tier source — routing a custom domain needs Pro (1) or Pro Max. */
  tiers: TierStorage;
  /** Injected DoH resolver (real one is `resolveCnameChain`). */
  resolveCname: (fqdn: string) => Promise<string[]>;
  /** Best-effort push to `.services` (the real one never throws). */
  pushRedirection: (
    op: "add" | "delete",
    fqdn: string,
    podCanonical?: string,
  ) => Promise<void>;
  now?: () => number;
}

export interface VerificationPassResult {
  activated: number;
  stillPending: number;
  failed: number;
  reverified: number;
  invalidated: number;
  /** Active orders parked because the tier lapsed or dropped below the count. */
  suspended: number;
  /** Suspended orders routed again after the tier allowed them. */
  reactivated: number;
}

/** The user's serving pod = first non-revoked registered server. */
async function leadPod(
  servers: ServerStorage,
  userId: string,
): Promise<string | undefined> {
  const list = await servers.listForUser(userId);
  return list.find((s) => !s.revokedAt)?.serverDomain;
}

/** One verification pass. Idempotent; safe to run every cron tick.
 *
 *  1. Tier enforcement on ACTIVE orders, every pass (not only when a re-verify
 *     is due), so a lapsed subscription stops routing within one cron tick:
 *     no paid tier ⇒ every active order is suspended; over the plan's count ⇒
 *     the oldest `limit` stay, the rest are suspended.
 *  2. PENDING (and suspended) orders activate only when the CNAME proof holds
 *     AND the plan has room.
 *  3. The #82 CNAME re-verify sweep on the still-active orders. */
export async function runCustomDomainVerificationPass(
  deps: VerifierDeps,
): Promise<VerificationPassResult> {
  const now = (deps.now ?? (() => Date.now()))();
  const out: VerificationPassResult = {
    activated: 0,
    stillPending: 0,
    failed: 0,
    reverified: 0,
    invalidated: 0,
    suspended: 0,
    reactivated: 0,
  };
  const allowances = new Map<string, CustomDomainAllowance>();
  const allowanceFor = async (userId: string): Promise<CustomDomainAllowance> => {
    let a = allowances.get(userId);
    if (!a) {
      a = await customDomainAllowance(deps.tiers, userId, now);
      allowances.set(userId, a);
    }
    return a;
  };
  const suspend = async (o: CustomDomainOrderRecord): Promise<void> => {
    // Keep podCanonical — it is what marks the order as suspended rather than
    // never-verified (isSuspended), and what renewal re-activates.
    await deps.customDomainOrders.upsert({ ...o, status: "pending", updatedAt: now });
    await deps.pushRedirection("delete", o.fqdn);
    out.suspended++;
  };

  // --- 1. Tier enforcement on ACTIVE ---
  const activeByUser = new Map<string, CustomDomainOrderRecord[]>();
  for (const o of await deps.customDomainOrders.listByStatus("active")) {
    const list = activeByUser.get(o.userId) ?? [];
    list.push(o);
    activeByUser.set(o.userId, list);
  }
  const activeCount = new Map<string, number>();
  for (const [userId, orders] of activeByUser) {
    const { limit } = await allowanceFor(userId);
    const keep = [...orders].sort((a, b) => a.createdAt - b.createdAt);
    const over = keep.splice(Number.isFinite(limit) ? limit : keep.length);
    for (const o of over) await suspend(o);
    activeCount.set(userId, keep.length);
  }

  // --- 2. PENDING + suspended: (re)activation ---
  for (const o of await deps.customDomainOrders.listByStatus("pending")) {
    const suspended = isSuspended(o);
    const { limit } = await allowanceFor(o.userId);
    const room = (activeCount.get(o.userId) ?? 0) < limit;
    const chain = await deps.resolveCname(o.fqdn);
    if (room && cnameTargetsStub(chain, o.userId)) {
      const pod = await leadPod(deps.servers, o.userId);
      if (!pod) {
        // CNAME is right but there's no pod to serve it yet — keep
        // pending, retry when a pod registers.
        out.stillPending++;
        continue;
      }
      await deps.customDomainOrders.upsert({
        ...o,
        status: "active",
        podCanonical: pod,
        failCount: 0,
        updatedAt: now,
      });
      await deps.pushRedirection("add", o.fqdn, pod);
      activeCount.set(o.userId, (activeCount.get(o.userId) ?? 0) + 1);
      if (suspended) out.reactivated++;
      else out.activated++;
    } else if (suspended) {
      // Parked by a lapsed/smaller plan: never give up on it — renewing
      // the subscription must bring the domain back without re-ordering.
      out.stillPending++;
    } else if (now - o.createdAt >= GIVEUP_MS) {
      await deps.customDomainOrders.upsert({
        ...o,
        status: "failed",
        failCount: o.failCount + 1,
        updatedAt: now,
      });
      // Idempotent cleanup in case anything ever pointed here.
      await deps.pushRedirection("delete", o.fqdn);
      out.failed++;
    } else {
      await deps.customDomainOrders.upsert({
        ...o,
        failCount: o.failCount + 1,
        updatedAt: now,
      });
      out.stillPending++;
    }
  }

  // --- 3. ACTIVE: #82 re-verify sweep ---
  for (const o of await deps.customDomainOrders.listByStatus("active")) {
    if (now - o.updatedAt < REVERIFY_INTERVAL_MS) continue; // not due
    const chain = await deps.resolveCname(o.fqdn);
    if (cnameTargetsStub(chain, o.userId)) {
      if (o.failCount > 0) {
        await deps.customDomainOrders.upsert({ ...o, failCount: 0, updatedAt: now });
      } else {
        await deps.customDomainOrders.upsert({ ...o, updatedAt: now });
      }
      out.reverified++;
    } else {
      const failCount = o.failCount + 1;
      if (failCount >= INVALIDATE_FAILS) {
        await deps.customDomainOrders.upsert({
          ...o,
          status: "failed",
          failCount,
          updatedAt: now,
        });
        await deps.pushRedirection("delete", o.fqdn);
        out.invalidated++;
      } else {
        await deps.customDomainOrders.upsert({ ...o, failCount, updatedAt: now });
      }
    }
  }

  return out;
}
