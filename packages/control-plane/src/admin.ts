import type { ServerStorage } from "@flagship/storage";
import { accountZoneOfServerDomain, ensureAccountDns } from "./accountDns.js";
import type { CloudflareDnsClient } from "./cloudflareDns.js";
import { forbidden, type HandlerResponse } from "./types.js";

/**
 * Operational admin handlers — gated by a shared secret carried in the
 * `x-admin-secret` request header. The secret is a Worker secret on
 * the production instance (`wrangler secret put FLAGSHIP_ADMIN_SECRET`)
 * and never appears in code, logs, or D1.
 *
 * These endpoints exist for the founder/operator. None of them mutate
 * user identity or money; the failure mode of a leaked admin secret is
 * "DNS records get re-republished" which is benign as long as the
 * passthrough IPs in `wrangler.toml` are correct. Still, treat it as
 * a sensitive credential and rotate after any suspected leak.
 */

export interface AdminAuth {
  expected: string | undefined;
  provided: string | null;
}

export function authorizeAdmin(auth: AdminAuth): HandlerResponse | null {
  if (!auth.expected) {
    return { status: 503, body: { error: "admin endpoints not configured (FLAGSHIP_ADMIN_SECRET missing)" } };
  }
  if (!auth.provided) {
    return { status: 401, body: { error: "x-admin-secret header required" } };
  }
  if (!constantTimeEqual(auth.provided, auth.expected)) {
    return forbidden("x-admin-secret rejected");
  }
  return null;
}

/**
 * DNS re-publisher. Walks every non-revoked server in storage and makes sure
 * each ACCOUNT's records exist at the currently-configured passthrough IPs:
 * `*.<user>` A/AAAA and the CAA at `<user>` (docs/wildcard-dns.md; no per-box
 * records). Used after editing the IPs in wrangler.toml — one curl
 * re-establishes correct DNS for every user — and to give an account that
 * predates the wildcard its records.
 *
 * Idempotent: existing-content matches are no-ops at the CF API.
 * Caller can re-invoke safely. Reports per-server outcomes (servers of one
 * account share its outcome) so a partial failure is visible.
 */
export interface RepublishDeps {
  servers: ServerStorage;
  dns: CloudflareDnsClient;
  servicesIpv4: string;
  servicesIpv6?: string;
}

export interface RepublishOutcome {
  serverDomain: string;
  ok: boolean;
  error?: string;
}

export async function handleRepublishServerDns(
  deps: RepublishDeps,
): Promise<HandlerResponse<{ total: number; ok: number; failed: number; outcomes: RepublishOutcome[] }>> {
  const all = await deps.servers.listAll();
  const active = all.filter((s) => !s.revokedAt);
  const outcomes: RepublishOutcome[] = [];
  const byZone = new Map<string, { ok: boolean; error?: string }>();
  for (const rec of active) {
    const zone = accountZoneOfServerDomain(rec.serverDomain);
    if (!zone) {
      outcomes.push({ serverDomain: rec.serverDomain, ok: false, error: "not a <server>.<user>.<apex> name" });
      continue;
    }
    let result = byZone.get(zone);
    if (!result) {
      const r = await ensureAccountDns(
        {
          client: deps.dns,
          servicesIpv4: deps.servicesIpv4,
          servicesIpv6: deps.servicesIpv6,
          caa: { client: deps.dns },
        },
        zone,
      );
      const error = r.dnsError ?? r.caaError;
      result = error ? { ok: false, error } : { ok: true };
      byZone.set(zone, result);
    }
    outcomes.push({ serverDomain: rec.serverDomain, ok: result.ok, ...(result.error ? { error: result.error } : {}) });
  }
  return {
    status: 200,
    body: {
      total: active.length,
      ok: outcomes.filter((o) => o.ok).length,
      failed: outcomes.filter((o) => !o.ok).length,
      outcomes,
    },
  };
}

/**
 * One-shot apex DNS cleanup. Deletes the now-stale `flagship.services`
 * A and AAAA records that point at Fly's old TLS-term IP. The apex
 * doesn't serve user content (subdomains do) and shouldn't resolve.
 *
 * Returns counts so the caller can confirm something happened. Calls
 * `deleteByName(apex, type)` which is idempotent (returns 0 if the
 * record is already gone).
 */
export interface ApexCleanupDeps {
  dns: CloudflareDnsClient;
  apex: string;
}

export async function handleCleanupApex(deps: ApexCleanupDeps): Promise<HandlerResponse> {
  let deletedA = 0;
  let deletedAaaa = 0;
  let error: string | undefined;
  try {
    deletedA = await deps.dns.deleteByName(deps.apex, "A");
    deletedAaaa = await deps.dns.deleteByName(deps.apex, "AAAA");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  if (error) {
    return { status: 502, body: { error: "cleanup failed", message: error, deletedA, deletedAaaa } };
  }
  return { status: 200, body: { ok: true, apex: deps.apex, deletedA, deletedAaaa } };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
