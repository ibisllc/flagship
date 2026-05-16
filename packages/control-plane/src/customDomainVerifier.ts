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
} from "@flagship/storage";

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
}

/** The user's serving pod = first non-revoked registered server. */
async function leadPod(
  servers: ServerStorage,
  userId: string,
): Promise<string | undefined> {
  const list = await servers.listForUser(userId);
  return list.find((s) => !s.revokedAt)?.serverDomain;
}

/** One verification pass. Idempotent; safe to run every cron tick. */
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
  };

  // --- PENDING: first-confirmation ---
  for (const o of await deps.customDomainOrders.listByStatus("pending")) {
    const chain = await deps.resolveCname(o.fqdn);
    if (cnameTargetsStub(chain, o.userId)) {
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
      out.activated++;
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

  // --- ACTIVE: #82 re-verify sweep ---
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
