/**
 * The Worker's cron handler. `.com` runs on the Workers Free plan, where one
 * cron invocation may spend 10 ms of CPU and make 50 subrequests (every D1 call
 * is one). So the work is split across invocations by `cronPlan.ts` (which job
 * runs at which tick) instead of one big invocation per cron, and every plan is
 * held to the limits by apps/com/test/cronBudget.test.ts
 * (scripts/cronHarness.ts measures it). docs/runbooks/workers-cpu-budget.md
 * "Crons" has the inventory.
 *
 * Two jobs are NOT here any more because they cannot fit in a Worker on Free:
 *   - the D1 backup (89 D1 calls, 45 ms): .github/workflows/d1-backup.yml
 *     exports the database with `wrangler d1 export` and keeps an encrypted copy
 *     in R2 (docs/runbooks/d1-restore.md);
 *   - the OpenRouter capability-table refresh (350 models parsed and upserted,
 *     33 ms): .github/workflows/model-capabilities.yml.
 */

import type { D1Database } from "@flagship/storage";
import { D1Storage } from "@flagship/storage";
import {
  buildPushForwarder,
  wrapForwarderAsV12Fanout,
  runCustomDomainVerificationPass,
  resolveCnameChain,
  pushRedirection,
  runDemoProvisioningPoller,
  schedulePendingRePairAlerts,
  scheduleQuarantineAlerts,
  runCtScan,
  createCrtShSource,
  runCaLeaseWarningCheck,
  replenishSuggestionQueue,
  comDomainExists,
  CloudflareDnsClient,
  THROTTLE_WINDOW_RESET_MS,
  OFFER_TTL_MS,
} from "@flagship/control-plane";
import { createDemoServerRouter, hasAnyDemoCloudToken } from "./demoCloud.js";
import { activeCaLeaseNotAfterMs } from "./caTrustChainLoader.js";
import { notifyCaLeaseViaGithubIssue } from "./caLeaseGithubNotifier.js";
import { runAdapterPublish } from "./adapterPublish.js";
import { runVoiciNamesCron } from "./voiciNamesCron.js";
import { runAdapterInsights } from "./adapterInsights.js";
import { cronPlan, SUGGESTION_ATTEMPTS_PER_TICK, type CronJobId, type CronPlan } from "./cronPlan.js";
import { pruneRateLimitLog } from "./rateLimitLog.js";
import { pruneOutboundDaily } from "./outboundHosts.js";
import { protectedAccountsFrom } from "./prodReap.js";
import { runRelayProbeCron, type OhttpEnv } from "./ohttpRoutes.js";
import type { AdapterBucketLike } from "./adapterIndex.js";
import { pruneLateLogs, type LateLogBucket } from "./legacyLateLogs.js";

export interface ScheduledEnv extends OhttpEnv {
  CONTROL_APEX?: string;
  DB?: D1Database;
  /** .services :8443 base (wrangler.toml) — custom-domain verifier
   *  pushes confirmed/invalidated redirections here (#79B/#87). */
  SERVICES_BASE_URL?: string;
  /** Shared bearer for the .com↔.services control channel (#87). */
  SERVICES_CONTROL_SECRET?: string;
  /** Plan A — Hetzner API token (demo provisioning poller). The demo cron
   *  branch no-ops only when neither cloud token is set. */
  HCLOUD_TOKEN?: string;
  /** UpCloud API token — polls demo servers whose id is an UpCloud UUID. */
  UPCLOUD_TOKEN?: string;
  /** Direct Cloudflare credentials used for stale ACME TXT cleanup. */
  CLOUDFLARE_DNS_API_TOKEN?: string;
  CLOUDFLARE_SERVICES_ZONE_ID?: string;
  SERVICES_APEX?: string;
  /** The relay's address: the root wildcard the legacy sweep waits for. */
  SERVICES_PASSTHROUGH_IPV4?: string;
  SERVICES_PASSTHROUGH_IPV6?: string;
  /** Accounts the legacy sweep leaves alone (the reap tool's protected list). */
  REAP_PROTECTED_ACCOUNTS?: string;
  /** "1" switches the hourly legacy-record sweep on. Off by default: the owner trims with the reap tool first. */
  DNS_LEGACY_SWEEP?: string;
  /** Plan A — numeric Hetzner SSH key id (set in [vars]). Unused by
   *  the cron itself but plumbed for symmetry with the request path. */
  DEMO_PUBLIC_SSH_KEY_ID?: string;
  // v1.2 Plan B Phase 5 — push provider secrets used by the
  // re-pair-alerts cron's real fan-out path. When any are missing,
  // the helper returns null and the scheduler falls back to
  // "audit-only" alerting.
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_PRIVATE_KEY_PEM?: string;
  APNS_BUNDLE_ID?: string;
  APNS_HOST?: string;
  FCM_SERVICE_ACCOUNT_JSON?: string;
  FCM_PROJECT_ID?: string;
  WEBPUSH_VAPID_PRIVATE_KEY_PEM?: string;
  WEBPUSH_VAPID_PUBLIC_KEY_B64URL?: string;
  WEBPUSH_CONTACT?: string;
  /** OPS-3 pager — fine-grained GitHub PAT (Issues: read+write) scoped to
   *  GITHUB_ISSUES_REPO. Unset ⇒ the ca-lease check still runs (audit
   *  event + console.error) but files no issue. */
  GITHUB_ISSUES_TOKEN?: string;
  /** "owner/name". Defaults to "ibisllc/flagship" when unset. */
  GITHUB_ISSUES_REPO?: string;
  /** Repo adapter queue (adapterIndex.ts) and its daily public publish
   *  (adapterPublish.ts). Publish no-ops unless the token AND repo are set. */
  ADAPTERS_BUCKET?: AdapterBucketLike;
  ADAPTERS_GITHUB_TOKEN?: string;
  ADAPTERS_REPO?: string;
  /** Optional: AI review of adapters, and the weekly private insight on retired ones. */
  ADAPTER_REVIEW_ANTHROPIC_KEY?: string;
  /** Holds leftover installer log tails (legacyLateLogs.ts), pruned to their TTL here. */
  ISO_TEMP_BUCKET?: LateLogBucket;
}

/**
 * Worker-facing scheduled handler. Cloudflare passes a controller + env + ctx;
 * `cronPlan` says which jobs this tick runs, each is guarded on its own so one
 * failure never stops another, and `waitUntil` keeps the Worker alive until
 * they finish.
 */
export async function scheduled(
  controller: { scheduledTime: number; cron: string },
  env: ScheduledEnv,
  ctx: { waitUntil(p: Promise<unknown>): void },
): Promise<void> {
  const now = new Date(controller.scheduledTime);
  const plan = cronPlan(controller.cron, controller.scheduledTime);
  for (const id of plan.jobs) {
    ctx.waitUntil(
      runJob(id, env, now, plan).catch((e) => {
        console.error(`[cron] ${id} failed`, (e as Error).message ?? e);
      }),
    );
  }
}

async function runJob(id: CronJobId, env: ScheduledEnv, now: Date, plan: CronPlan): Promise<unknown> {
  switch (id) {
    case "custom-domain-verify":
      return runCustomDomainVerify(env, now);
    case "ca-lease-warning":
      return runCaLeaseWarning(env, now);
    case "prune-rate-limit-log":
      return env.DB ? Promise.all([pruneRateLimitLog(env.DB, now), pruneOutboundDaily(env.DB, now)]) : null;
    case "prune-late-logs":
      return env.ISO_TEMP_BUCKET ? pruneLateLogs(env.ISO_TEMP_BUCKET, now) : null;
    case "demo":
      return runDemoCron(env, now);
    case "ct-scan":
      return runCtMonitor(env, now, plan.ctWindow);
    case "repair-alerts":
      return runRePairAlertsCron(env, now);
    case "quarantine-alerts":
      return runQuarantineAlertsCron(env, now);
    case "suggestions":
      return runSuggestionQueueCron(env, now);
    case "eviction-gc":
      return runEvictionGcCron(env, now);
    case "dns-gc":
      return runDnsChallengeGcCron(env, now);
    case "legacy-dns-sweep":
      return runLegacyDnsSweepCron(env, now);
    case "adapter-publish":
      return runAdapterPublish(env, now);
    case "adapter-insights":
      return runAdapterInsights(env, now);
    case "voici-names":
      return runVoiciNamesCron(env, now, plan.voiciWindow ?? { start: 0, count: 10 });
    case "relay-probe":
      return runRelayProbeCron(env, now, { apex: env.CONTROL_APEX ?? "flagshipserver.com" });
  }
}

/** Remove only ACME TXT records older than one hour. */
export async function runDnsChallengeGcCron(
  env: ScheduledEnv,
  now: Date,
): Promise<import("@flagship/control-plane").StaleAcmeTxtCleanupResult | null> {
  if (!env.CLOUDFLARE_DNS_API_TOKEN || !env.CLOUDFLARE_SERVICES_ZONE_ID) return null;
  const dns = new CloudflareDnsClient({
    apiToken: env.CLOUDFLARE_DNS_API_TOKEN,
    zoneId: env.CLOUDFLARE_SERVICES_ZONE_ID,
  });
  return dns.deleteStaleAcmeTxt({
    apex: env.SERVICES_APEX ?? "flagship.services",
    cutoffMs: now.getTime() - 60 * 60 * 1000,
  });
}

/**
 * Hourly: remove the A/AAAA/CAA records earlier DNS layouts left at account and
 * box names. Each one stops the zone's root wildcard for the names below it
 * (docs/wildcard-dns.md). It waits for the root wildcard to be in the zone and
 * deletes at most 20 a pass, so a zone with a backlog drains over a day. Off
 * unless `DNS_LEGACY_SWEEP` is "1": a bulk delete of live accounts' records is
 * the owner's call (the reap tool, then this to mop up); the per-event clean-up
 * (register, auth-code issue, revoke, delete, transfer) needs no switch.
 */
export async function runLegacyDnsSweepCron(
  env: ScheduledEnv,
  now: Date,
): Promise<import("@flagship/control-plane").LegacyDnsSweepResult | null> {
  if (env.DNS_LEGACY_SWEEP !== "1") return null;
  if (!env.CLOUDFLARE_DNS_API_TOKEN || !env.CLOUDFLARE_SERVICES_ZONE_ID || !env.SERVICES_PASSTHROUGH_IPV4) return null;
  const dns = new CloudflareDnsClient({
    apiToken: env.CLOUDFLARE_DNS_API_TOKEN,
    zoneId: env.CLOUDFLARE_SERVICES_ZONE_ID,
  });
  return dns.deleteLegacyAccountRecords({
    apex: env.SERVICES_APEX ?? "flagship.services",
    relay: {
      servicesIpv4: env.SERVICES_PASSTHROUGH_IPV4,
      ...(env.SERVICES_PASSTHROUGH_IPV6 ? { servicesIpv6: env.SERVICES_PASSTHROUGH_IPV6 } : {}),
    },
    cutoffMs: now.getTime() - 60 * 60 * 1000,
    maxDeletes: 20,
    skipUsers: protectedAccountsFrom(env),
  });
}

/** Top the username suggestion queue up to its warm target (the slow DoH `.com`
 *  exclusion happens here, not on the request path) and prune throttle rows that
 *  are well past their reset window. Best-effort; guarded by the caller. */
export async function runSuggestionQueueCron(env: ScheduledEnv, now: Date): Promise<void> {
  if (!env.DB) return;
  const storage = new D1Storage(env.DB);
  const nowMs = now.getTime();
  const f = globalThis.fetch as unknown as Parameters<typeof comDomainExists>[1];
  await replenishSuggestionQueue({
    queue: storage.suggestionQueue,
    usernames: storage.usernames,
    comExists: (name) => comDomainExists(name, f),
    now: nowMs,
    // Each attempt is a D1 read and a DoH lookup (two subrequests): a cold queue
    // fills over a few ticks instead of in one invocation's 50.
    attemptCap: SUGGESTION_ATTEMPTS_PER_TICK,
  });
  await storage.suggestThrottle.prune(nowMs - 2 * THROTTLE_WINDOW_RESET_MS);
  // Drop offers well past their claimable window (the gate uses OFFER_TTL_MS).
  await storage.usernameOffers.prune(nowMs - 2 * OFFER_TTL_MS);
}

/** GC the graceful-decommission eviction chain: drop successor-acked rows that
 *  are past a generous TTL. No-ops without a DB. Best-effort; guarded by caller. */
const EVICTION_GC_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export async function runEvictionGcCron(env: ScheduledEnv, now: Date): Promise<void> {
  if (!env.DB) return;
  const storage = new D1Storage(env.DB);
  await storage.serverEvictions.gcEvictions(now.getTime(), EVICTION_GC_TTL_MS);
}

/**
 * Plan A — demo-user cron pass: the provisioning poller. There is no idle
 * reaper by design — demo servers stay on until an operator cleans them up.
 * No-ops when no cloud token is configured.
 *
 * See docs/sample-users.md §11.
 */
export async function runDemoCron(
  env: ScheduledEnv,
  now: Date,
): Promise<{
  promoted: number;
} | null> {
  if (!env.DB || !hasAnyDemoCloudToken(env)) return null;
  const storage = new D1Storage(env.DB);
  const deps = {
    storage: storage.demoUsers,
    usernames: storage.usernames,
    hetzner: createDemoServerRouter(env),
    sshKeyId: 0, // unused by reaper / poller
    audit: storage.auditEvents,
    now: () => now.getTime(),
  };
  const pollerResult = await runDemoProvisioningPoller(
    deps,
    async (fqdn, createdAt) => {
      // The signal that "registration succeeded" is a row in the
      // `servers` table keyed by server_domain (created by
      // /api/server/register). The legacy install_events lookup
      // referenced columns that don't exist in the migration —
      // silently never promoting anything. We check `servers` directly
      // and additionally require the registration to be newer than
      // the row's createdAt so stale records can't promote a fresh
      // provision.
      const r = await env
        .DB!.prepare(
          "SELECT 1 FROM servers WHERE server_domain = ? AND registered_at > ? AND revoked_at IS NULL LIMIT 1",
        )
        .bind(fqdn, createdAt)
        .first();
      return !!r;
    },
  );
  return {
    promoted: pollerResult.promoted,
  };
}

/**
 * v1.2 Phase 2 — pending-re-pair alert scheduler. Fires
 * fire-and-forget push (stubbed for Phase 2; Phase 5 will wire the
 * real APNs/FCM/Web Push bridge with the encrypted deep-link
 * payload) whenever a pending re-pair row crosses one of the
 * documented offsets relative to its initiatedAt:
 *
 *   T+1d, T+3d, T+6d  (single-device 7-day grace only)
 *   completesAt - 1h  (both single + multi)
 *
 * No-op when DB binding isn't configured. Errors are swallowed —
 * a failed push won't block the next cron tick (idempotency lives
 * in the bitmap).
 */
export async function runRePairAlertsCron(
  env: ScheduledEnv,
  now: Date,
): Promise<{ scanned: number; fired: number } | null> {
  if (!env.DB) return null;
  const storage = new D1Storage(env.DB);
  // v1.2 Phase 5 — real fan-out via the high-level pushFanout +
  // pushTokens + auditEvents deps. When push provider secrets aren't
  // configured (dev / pre-launch), buildOptionalV12PushFanoutFromEnv
  // returns null and the scheduler falls back to "audit-only"
  // alerting (the bit still stamps, the activity feed captures the
  // alert, but the device doesn't get a push).
  const fanout = buildOptionalV12PushFanoutFromEnv(env);
  const result = await schedulePendingRePairAlerts({
    pendingRePairs: storage.pendingRePairs,
    pushTokens: storage.pushTokens,
    auditEvents: storage.auditEvents,
    ...(fanout ? { pushFanout: fanout } : {}),
    now: () => now.getTime(),
  });
  return { scanned: result.scanned, fired: result.fired.length };
}

/**
 * Phase 3b (cross-device QR pairing) — quarantine review-alert
 * scheduler. Fires "review your trusted devices — a new device joined"
 * pushes to the owner's OTHER devices whenever a freshly-admitted
 * (vouched) device crosses a T+0/+1d/+3d/+7d/+13d offset within its
 * 14-day quarantine window. Same idempotency + fan-out plumbing as the
 * re-pair alert cron: a per-row bitmask gates the rungs, and the real
 * push fan-out is wired from env (audit-only fallback when no push
 * provider secret is configured). No-op without the DB binding.
 */
export async function runQuarantineAlertsCron(
  env: ScheduledEnv,
  now: Date,
): Promise<{ scanned: number; fired: number } | null> {
  if (!env.DB) return null;
  const storage = new D1Storage(env.DB);
  const fanout = buildOptionalV12PushFanoutFromEnv(env);
  const result = await scheduleQuarantineAlerts({
    pushTokens: storage.pushTokens,
    auditEvents: storage.auditEvents,
    ...(fanout ? { pushFanout: fanout } : {}),
    now: () => now.getTime(),
  });
  return { scanned: result.scanned, fired: result.fired.length };
}

/**
 * #79B/#82 — one custom-domain verification pass per cron tick
 * (`0 *​/6 * * *`, so first-confirm is ≤6h after the record; DNS
 * propagation after the user sets the CNAME is minutes anyway, and
 * the UX already told them it's verified out-of-band). No-ops unless
 * the DB binding + the .services control channel are configured.
 * Never throws — the verifier swallows DoH/push failures and a row
 * just stays pending for the next tick.
 */
export async function runCustomDomainVerify(
  env: ScheduledEnv,
  now: Date,
): Promise<void> {
  if (!env.DB || !env.SERVICES_BASE_URL || !env.SERVICES_CONTROL_SECRET) return;
  const servicesBaseUrl = env.SERVICES_BASE_URL;
  const secret = env.SERVICES_CONTROL_SECRET;
  const storage = new D1Storage(env.DB);
  await runCustomDomainVerificationPass({
    customDomainOrders: storage.customDomainOrders,
    servers: storage.servers,
    tiers: storage.tiers,
    resolveCname: (fqdn) => resolveCnameChain(fqdn),
    pushRedirection: async (op, fqdn, podCanonical) => {
      await pushRedirection({ servicesBaseUrl, secret }, { op, fqdn, podCanonical });
    },
    now: () => now.getTime(),
  });
}

/**
 * CT-monitoring cron pass (server-side, defense-in-depth). Queries
 * crt.sh for each active user's `flagship.services` names and pushes the
 * owner when it sees a leaf cert the user's own boxes did NOT report
 * minting. No-ops without the DB binding. Best-effort + bounded — the
 * scan never throws and caps its per-run domain / CT-query budget.
 * When no push provider secrets are configured the alert is audit-only.
 */
export async function runCtMonitor(
  env: ScheduledEnv,
  now: Date,
  window?: { start: number; count: number },
): Promise<{
  usersScanned: number;
  alerted: number;
  audited: number;
} | null> {
  if (!env.DB) return null;
  const storage = new D1Storage(env.DB);
  const fanout = buildOptionalV12PushFanoutFromEnv(env);
  const result = await runCtScan({
    servers: storage.servers,
    daemonStatus: storage.daemonStatus,
    auditEvents: storage.auditEvents,
    ctAlerts: storage.ctAlerts,
    ctSource: createCrtShSource(),
    ...(window ? { userWindow: window } : {}),
    pushTokens: storage.pushTokens,
    ...(fanout ? { pushFanout: fanout } : {}),
    now: () => now.getTime(),
  });
  return {
    usersScanned: result.usersScanned,
    alerted: result.alerted,
    audited: result.audited,
  };
}

/**
 * OPS-3 — CA-endorsement lease lapse warning cron pass. Resolves the
 * active endorsement leases' notAfter from the SAME committed bundle the
 * #30 gate consults, and emits a high-severity audit event when the
 * soonest is within (or past) the 7-day warn threshold. No-ops without
 * the DB binding (the audit write needs it).
 *
 * NOTIFY GAP: `.com` has no operator-facing pager; the durable signal is
 * the audit event + the loud console.error + the queryable
 * /api/admin/ca-lease-status endpoint. See caLeaseWarning.ts.
 */
export async function runCaLeaseWarning(
  env: ScheduledEnv,
  now: Date,
): Promise<{ severity: string; alerted: boolean } | null> {
  if (!env.DB) return null;
  const storage = new D1Storage(env.DB);
  const token = env.GITHUB_ISSUES_TOKEN;
  const repo = env.GITHUB_ISSUES_REPO ?? "ibisllc/flagship";
  const result = await runCaLeaseWarningCheck({
    activeLeaseNotAfterMs: activeCaLeaseNotAfterMs,
    auditEvents: storage.auditEvents,
    now: () => now.getTime(),
    ...(token
      ? {
          notifyOperator: (status, message) =>
            notifyCaLeaseViaGithubIssue(status, message, { token, repo }),
        }
      : {}),
  });
  return { severity: result.status.severity, alerted: result.alerted };
}

/**
 * v1.2 Plan B Phase 5 — wrap the env-derived push forwarder into the
 * V12PushFanout shape. Returns null when no push provider's secrets
 * are configured (dev / pre-launch).
 */
function buildOptionalV12PushFanoutFromEnv(env: ScheduledEnv) {
  const apnsConfigured =
    !!env.APNS_KEY_ID &&
    !!env.APNS_TEAM_ID &&
    !!env.APNS_PRIVATE_KEY_PEM &&
    !!env.APNS_BUNDLE_ID;
  const fcmConfigured = !!env.FCM_SERVICE_ACCOUNT_JSON && !!env.FCM_PROJECT_ID;
  const webpushConfigured =
    !!env.WEBPUSH_VAPID_PRIVATE_KEY_PEM &&
    !!env.WEBPUSH_VAPID_PUBLIC_KEY_B64URL &&
    !!env.WEBPUSH_CONTACT;
  if (!apnsConfigured && !fcmConfigured && !webpushConfigured) return null;
  const forwarder = buildPushForwarder({
    ...(apnsConfigured
      ? {
          apns: {
            keyId: env.APNS_KEY_ID!,
            teamId: env.APNS_TEAM_ID!,
            privateKeyPem: env.APNS_PRIVATE_KEY_PEM!,
            bundleId: env.APNS_BUNDLE_ID!,
            ...(env.APNS_HOST ? { host: env.APNS_HOST } : {}),
          },
        }
      : {}),
    ...(fcmConfigured
      ? {
          fcm: {
            serviceAccountJson: env.FCM_SERVICE_ACCOUNT_JSON!,
            projectId: env.FCM_PROJECT_ID!,
          },
        }
      : {}),
    ...(webpushConfigured
      ? {
          webpush: {
            vapidPrivateKeyPem: env.WEBPUSH_VAPID_PRIVATE_KEY_PEM!,
            vapidPublicKeyB64Url: env.WEBPUSH_VAPID_PUBLIC_KEY_B64URL!,
            contact: env.WEBPUSH_CONTACT!,
          },
        }
      : {}),
  });
  return wrapForwarderAsV12Fanout(forwarder);
}

export const _internal = {
  buildOptionalV12PushFanoutFromEnv,
};
