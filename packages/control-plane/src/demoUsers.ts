/**
 * Plan A — sample-user / on-connect Hetzner-VPS demo handlers.
 *
 * The demo system extends the existing `TEST_ACCOUNTS` + `DemoFixtures`
 * sandbox path (which mocks everything) into a *real* Flagship server
 * lifecycle backed by a Hetzner VPS that materialises on first
 * `/connect` and tears down on idle. Anyone who types a demo username
 * on iOS / Android / webapp short-circuits into demo mode and sees one
 * real device.
 *
 * The handlers below are pure: every side effect is injected via deps
 * (`storage`, `usernames`, `hetzner`, `audit`, `now`, `rateLimit`).
 *
 * See docs/sample-users.md §10 for endpoint shapes and §4 for the
 * server lifecycle state machine.
 */

import type {
  AuditEventKind,
  AuditEventStorage,
  DemoUserRecord,
  DemoUserState,
  DemoUsersStorage,
  UsernameStorage,
} from "@flagship/storage";

import type { HandlerResponseWithHeaders } from "./types.js";
import { ok, malformed, notFound, conflict } from "./types.js";
import type { DnsDeleteClient } from "./cloudflareDns.js";

// ──────────────────────────────────────────────────────────────────────
// Domain configuration
// ──────────────────────────────────────────────────────────────────────

/** Soft cap on concurrent demo VPSs across all demo users. The handler
 *  rejects /connect with 429 once `count(state IN provisioning|up|
 *  idle-pending-teardown) >= MAX_CONCURRENT_DEMO_VPS`. Raising this is
 *  a one-line PR. See docs/sample-users.md §12.2. */
export const MAX_CONCURRENT_DEMO_VPS = 5;

/** Default Hetzner location for /create when the caller omits region. */
export const DEFAULT_REGION = "fsn1";
/** Default Hetzner server_type for /create when the caller omits size. */
export const DEFAULT_SIZE = "cx22";
/** Default idle-timeout for /create when the caller omits ttlIdleMinutes. */
export const DEFAULT_TTL_IDLE_MINUTES = 30;

/** docs/sample-users.md §2.4 — username naming rules. Hyphen-free
 *  (aligned with real usernames) so a demo name can never break the
 *  `<creator>-<slug>` app-id split or be rejected by the hyphen-free
 *  username validators downstream; 3..32 keeps the demo length range. */
const USERNAME_RE = /^[a-z0-9]{3,32}$/;
const RESERVED_USERNAMES = new Set([
  "admin",
  "flagship",
  "support",
  "www",
  "api",
  "dev",
]);

/** docs/sample-users.md §3.3 — concurrent paired-session cap per
 *  demo username. (Enforced inside the daemon, not the .com Worker
 *  — this constant lives here so it's discoverable from the spec
 *  reference.) */
export const DEMO_PAIRED_SESSION_CAP = 3;

/** Mapping the internal storage state → the public `/connect` /
 *  `/users/check` response state. `idle-pending-teardown` is
 *  surfaced as `provisioning` so clients can treat the transient
 *  destroy-and-relaunch window as "wait, the system is busy". */
function publicStatus(state: DemoUserState): "none" | "provisioning" | "up" {
  if (state === "up") return "up";
  if (state === "none") return "none";
  return "provisioning"; // 'provisioning' OR 'idle-pending-teardown'
}

/** Build the FQDN we publish for a demo server. Single-server-per-demo;
 *  see docs/sample-users.md §4. */
export function demoServerFqdn(username: string): string {
  return `home.${username.toLowerCase()}.flagship.services`;
}

/**
 * Delete the DNS records a demo server published at registration. A demo
 * box always installs as serverName `home`, so its per-box records mirror
 * the real `serverRegister` path (A/AAAA at `<serverDomain>` +
 * `*.<serverDomain>`), and the per-user CAA + apex records mirror the
 * `caaPublish` path. Best-effort: every delete is wrapped so a DNS-side
 * failure can never block the box/row teardown (the row delete is the
 * source of truth; DNS is cleanup). Logged via the audit sink when present.
 */
async function cleanupDemoUserDns(
  deps: DemoUsersDeps,
  username: string,
): Promise<void> {
  if (!deps.dns) return;
  const apex = deps.apex ?? "flagship.services";
  const u = username.toLowerCase();
  const serverDomain = `home.${u}.${apex}`;
  const userZone = `${u}.${apex}`;
  // Each entry is [name, type]. Mirrors what registration published:
  //   per-box A/AAAA at the box apex + its wildcard, and the per-user
  //   CAA at the user zone + its wildcard. The user-zone wildcard also
  //   gets an A/AAAA sweep so a stray model-C per-user record (if one
  //   was ever published under this name) is reaped too.
  const targets: Array<[string, string]> = [
    [serverDomain, "A"],
    [serverDomain, "AAAA"],
    [`*.${serverDomain}`, "A"],
    [`*.${serverDomain}`, "AAAA"],
    [userZone, "CAA"],
    [`*.${userZone}`, "A"],
    [`*.${userZone}`, "AAAA"],
    [`*.${userZone}`, "CAA"],
  ];
  let deleted = 0;
  for (const [name, type] of targets) {
    try {
      deleted += await deps.dns.deleteByName(name, type);
    } catch {
      // best-effort — a DNS failure must not block teardown.
    }
  }
  await audit(deps, u, "demo-vps-destroyed", `dns-records-deleted=${deleted}`);
}

// ──────────────────────────────────────────────────────────────────────
// Hetzner client surface (structurally-typed)
// ──────────────────────────────────────────────────────────────────────

/** Structural subset of `apps/com/src/hetzner.ts` HetznerClient. Defined
 *  here so the control-plane package doesn't depend on apps/com. The
 *  concrete client in the Worker satisfies this interface by name +
 *  signature; tests inject a fake. */
export interface HetznerProvisioner {
  createServerFromSnapshot(args: {
    name: string;
    snapshotId: string;
    location: string;
    serverType: string;
    sshKeyId: number;
    username: string;
  }): Promise<{ serverId: string; ipv4: string | null }>;
  getServerStatus(
    serverId: string,
  ): Promise<{ status: string; ipv4: string | null }>;
  destroyServer(serverId: string): Promise<void>;
}

// ──────────────────────────────────────────────────────────────────────
// Shared deps + audit emission
// ──────────────────────────────────────────────────────────────────────

export interface DemoUsersDeps {
  /** Demo-user storage; D1 in prod, InMemory in tests. */
  storage: DemoUsersStorage;
  /** Username storage; needed for the create-time uniqueness check
   *  against real-account claims. */
  usernames: UsernameStorage;
  /** Worker-side Hetzner client. Tests inject a fake. */
  hetzner: HetznerProvisioner;
  /** Numeric SSH key id Hetzner attaches to provisioned servers. Set
   *  via `wrangler.toml [vars] DEMO_PUBLIC_SSH_KEY_ID` (not a secret;
   *  it's a numeric handle). */
  sshKeyId: number;
  /** Audit log sink. Failures swallowed. */
  audit?: AuditEventStorage;
  /** Clock override for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Soft override for tests. Defaults to `MAX_CONCURRENT_DEMO_VPS`. */
  maxConcurrent?: number;
  /**
   * Optional. When wired, the per-box (and per-user) DNS records published
   * for this demo server at registration are deleted on teardown so the
   * `flagship.services` zone doesn't accumulate orphan records (and exhaust
   * the zone's record quota — a leak that already broke cert issuance once).
   * Best-effort: a DNS failure never blocks the row/box teardown.
   */
  dns?: DnsDeleteClient;
  /**
   * Services apex the demo server's DNS records live under (e.g.
   * `flagship.services`). Used only to compute the names to delete on
   * teardown. Defaults to `flagship.services`.
   */
  apex?: string;
}

function nowMs(deps: DemoUsersDeps): number {
  return (deps.now ?? Date.now)();
}

async function audit(
  deps: DemoUsersDeps,
  username: string,
  eventKind: AuditEventKind,
  detail: string,
): Promise<void> {
  if (!deps.audit) return;
  try {
    await deps.audit.append({
      username: username.toLowerCase(),
      eventKind,
      detail: detail.slice(0, 160),
      devicePrefix: "",
      postedAt: nowMs(deps),
    });
  } catch {
    // Audit is best-effort.
  }
}

// ──────────────────────────────────────────────────────────────────────
// Username validation
// ──────────────────────────────────────────────────────────────────────

// Legacy hyphenated names (e.g. `demo-alice`) predate the hyphen-free
// rename. CREATE stays strict (USERNAME_RE), but destructive cleanup
// (delete) must still accept them so pre-rename orphans can be torn
// down. delete just identifies an existing row, so accepting hyphens
// is harmless.
const LEGACY_USERNAME_RE = /^[a-z0-9-]{3,32}$/;

function validateDemoUsername(
  raw: unknown,
  opts?: { allowLegacyHyphens?: boolean },
): {
  ok: true;
  username: string;
} | {
  ok: false;
  reason: string;
} {
  if (typeof raw !== "string") return { ok: false, reason: "username must be a string" };
  const u = raw.toLowerCase();
  const allowHyphens = opts?.allowLegacyHyphens ?? false;
  const re = allowHyphens ? LEGACY_USERNAME_RE : USERNAME_RE;
  if (!re.test(u)) {
    return {
      ok: false,
      reason: allowHyphens
        ? "username must match [a-z0-9-]{3,32}"
        : "username must match [a-z0-9]{3,32} (no hyphens)",
    };
  }
  if (RESERVED_USERNAMES.has(u)) {
    return { ok: false, reason: "username is reserved" };
  }
  return { ok: true, username: u };
}

// ──────────────────────────────────────────────────────────────────────
// 1. POST /api/dev/sample-user/create — admin
// ──────────────────────────────────────────────────────────────────────

export interface CreateDemoUserBody {
  username?: unknown;
  display?: unknown;
  region?: unknown;
  size?: unknown;
  ttlIdleMinutes?: unknown;
}

export async function handleCreateDemoUser(
  deps: DemoUsersDeps,
  body: CreateDemoUserBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  if (!body) return malformed("malformed body");
  const v = validateDemoUsername(body.username);
  if (!v.ok) return malformed(v.reason);
  const username = v.username;
  if (typeof body.display !== "string" || body.display.length < 1 || body.display.length > 64) {
    return malformed("display must be a 1-64 char string");
  }
  const display = body.display;
  const region = typeof body.region === "string" ? body.region : DEFAULT_REGION;
  const size = typeof body.size === "string" ? body.size : DEFAULT_SIZE;
  const ttlIdleMinutes =
    typeof body.ttlIdleMinutes === "number" && body.ttlIdleMinutes > 0
      ? Math.floor(body.ttlIdleMinutes)
      : DEFAULT_TTL_IDLE_MINUTES;

  // Idempotency: if the row already exists, return it.
  const existing = await deps.storage.get(username);
  if (existing) {
    return ok({
      username: existing.username,
      display: existing.display,
      state: existing.state,
      createdAt: existing.createdAt,
      reused: true,
    });
  }

  // Real-account-username collision. Demo claims are flagged is_demo
  // (handleAdminClaimAndIssue sets it), so a prior demo claim must NOT
  // block re-creating the same demo user — otherwise every demo name is
  // burned after one run (delete doesn't drop the claim, and shouldn't
  // need to). Only a genuine real-account claim (is_demo falsy) collides.
  const realClaim = await deps.usernames.get(username);
  if (realClaim && !realClaim.isDemo) {
    return conflict("username already claimed by a real account");
  }

  const createdAt = nowMs(deps);
  const row: DemoUserRecord = {
    username,
    display,
    snapshotId: null,
    isoR2Key: null,
    ttlIdleMinutes,
    region,
    size,
    activeServerId: null,
    activeServerIp: null,
    image: null,
    activeServerFqdn: null,
    lastActivityAt: 0,
    state: "none",
    createdAt,
    provisionPhase: null,
    provisionPhaseAt: null,
    provisionLastError: null,
  };
  const inserted = await deps.storage.insert(row);
  if (!inserted.ok) {
    return conflict(inserted.reason);
  }

  await audit(deps, username, "demo-user-created", `region=${region} size=${size}`);
  return ok({
    username,
    display,
    state: "none",
    createdAt,
  });
}

// ──────────────────────────────────────────────────────────────────────
// 2. POST /api/dev/sample-user/{u}/install-complete — admin
// ──────────────────────────────────────────────────────────────────────

export interface InstallCompleteBody {
  snapshot_id?: unknown;
  iso_r2_key?: unknown;
}

export async function handleDemoUserInstallComplete(
  deps: DemoUsersDeps,
  username: string,
  body: InstallCompleteBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  if (!body) return malformed("malformed body");
  if (typeof body.snapshot_id !== "string" || body.snapshot_id.length === 0) {
    return malformed("snapshot_id required");
  }
  const isoKey = typeof body.iso_r2_key === "string" ? body.iso_r2_key : null;
  const u = username.toLowerCase();
  const row = await deps.storage.get(u);
  if (!row) return notFound("no such demo user");
  await deps.storage.update(u, {
    snapshotId: body.snapshot_id,
    isoR2Key: isoKey,
  });
  return ok({ username: u, snapshotId: body.snapshot_id, ready: true });
}

// ──────────────────────────────────────────────────────────────────────
// 3. POST /api/dev/sample-user/delete — admin
// ──────────────────────────────────────────────────────────────────────

export interface DeleteDemoUserBody {
  username?: unknown;
}

export async function handleDeleteDemoUser(
  deps: DemoUsersDeps,
  body: DeleteDemoUserBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  if (!body) return malformed("malformed body");
  // Accept legacy hyphenated names here so pre-rename orphans (e.g.
  // demo-alice) can still be torn down; CREATE remains hyphen-free.
  const v = validateDemoUsername(body.username, { allowLegacyHyphens: true });
  if (!v.ok) return malformed(v.reason);
  const username = v.username;
  const row = await deps.storage.get(username);
  if (!row) {
    return ok({ username, deleted: false });
  }
  // Best-effort Hetzner destroy. Idempotent (404 = success in the
  // hetzner client). If it fails, leave the row so a subsequent
  // delete can retry; don't half-clean.
  if (row.activeServerId) {
    try {
      await deps.hetzner.destroyServer(row.activeServerId);
    } catch {
      // Drop a row update so cron retries on the next pass and emits
      // `demo-vps-stuck` if it lingers. Leave the DNS in place too — a
      // retry of delete (after the box is gone) reaps it.
      await deps.storage.update(username, { state: "idle-pending-teardown" });
      return ok({ username, deleted: false, reason: "hetzner-destroy-failed" });
    }
  }
  // The box is gone; reap its DNS so the zone doesn't accumulate orphan
  // records. Best-effort — never blocks the row delete (source of truth).
  await cleanupDemoUserDns(deps, username);
  await deps.storage.delete(username);
  await audit(deps, username, "demo-user-deleted", "");
  return ok({ username, deleted: true });
}

// ──────────────────────────────────────────────────────────────────────
// 4. POST /api/dev/sample-user/{u}/connect — public (rate-limited)
// ──────────────────────────────────────────────────────────────────────

export async function handleDemoUserConnect(
  deps: DemoUsersDeps,
  username: string,
): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  const row = await deps.storage.get(u);
  if (!row) return notFound("no such demo user");

  const now = nowMs(deps);
  const fqdn = row.activeServerFqdn ?? demoServerFqdn(u);

  if (row.state === "up") {
    await deps.storage.update(u, { lastActivityAt: now });
    return ok({ fqdn, status: "up" });
  }

  if (row.state === "provisioning" || row.state === "idle-pending-teardown") {
    // The provisioning poller (cron) will flip provisioning→up; for
    // idle-pending-teardown the reaper completes the destroy and a
    // subsequent /connect re-provisions. Either way the client retries.
    return ok({ fqdn, status: "provisioning" });
  }

  // state === 'none' — provision a new server.
  if (!row.snapshotId) {
    return conflict("demo user not yet provisioned; call create+install-complete");
  }

  // Global concurrency cap.
  const cap = deps.maxConcurrent ?? MAX_CONCURRENT_DEMO_VPS;
  const active = await deps.storage.countActive();
  if (active >= cap) {
    await audit(
      deps,
      u,
      "demo-connect-attempt-rate-limited",
      `axis=global active=${active} cap=${cap}`,
    );
    return {
      status: 429,
      body: { error: "demo capacity reached, try again later" },
      headers: { "retry-after": "60" },
    };
  }

  // Reserve the slot via CAS before calling Hetzner.
  const reserved = await deps.storage.transition(u, "none", "provisioning", {
    lastActivityAt: now,
  });
  if (!reserved) {
    // Concurrent /connect raced us. Return the current state.
    const fresh = await deps.storage.get(u);
    if (!fresh) return notFound("no such demo user");
    return ok({ fqdn: fresh.activeServerFqdn ?? fqdn, status: publicStatus(fresh.state) });
  }

  let provision: { serverId: string; ipv4: string | null };
  try {
    provision = await deps.hetzner.createServerFromSnapshot({
      name: `flagship-demo-${u}-${now.toString(36).slice(-6)}`,
      snapshotId: reserved.snapshotId!,
      location: reserved.region,
      serverType: reserved.size,
      sshKeyId: deps.sshKeyId,
      username: u,
    });
  } catch (e) {
    // Roll the reservation back so a retry can attempt again.
    await deps.storage.transition(u, "provisioning", "none", {
      activeServerId: null,
      activeServerFqdn: null,
    });
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: 502,
      body: { error: "hetzner upstream unavailable", detail: msg.slice(0, 200) },
    };
  }

  await deps.storage.update(u, {
    activeServerId: provision.serverId,
    activeServerIp: provision.ipv4,
    activeServerFqdn: fqdn,
  });

  return ok({ fqdn, status: "provisioning" });
}

// ──────────────────────────────────────────────────────────────────────
// 5. POST /api/dev/sample-user/{u}/heartbeat — public (rate-limited)
// ──────────────────────────────────────────────────────────────────────

export async function handleDemoUserHeartbeat(
  deps: DemoUsersDeps,
  username: string,
): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  const row = await deps.storage.get(u);
  if (!row) return notFound("no such demo user");
  if (row.state !== "up") {
    return conflict("demo server is not up");
  }
  await deps.storage.update(u, { lastActivityAt: nowMs(deps) });
  return ok({ ok: true });
}

// ──────────────────────────────────────────────────────────────────────
// 5b. POST /api/dev/sample-user/{u}/cancel — public (rate-limited)
//
// "Cancel this device" from the install-progress detail page. A demo
// account is a no-auth capability (knowing the name is the capability),
// so this is deliberately public — but it ONLY touches `demo_users`
// rows. There is no path here to a REAL user's server (those live in
// the `servers` table and are owner-IRK-gated; an owner-authorized
// cancel for real servers is a follow-up). The edge rate-limits this
// bucket so it can't be used to flap a demo's VPS.
//
// Teardown semantics: destroy the active Hetzner server (best-effort,
// idempotent) and return the row to `none` so the UI drops back to the
// empty/list state and a later /connect can re-provision. We keep the
// row (and its snapshot_id/config) rather than deleting it — that's the
// difference from admin /delete, which also drops the row.
// ──────────────────────────────────────────────────────────────────────

export async function handleDemoUserCancel(
  deps: DemoUsersDeps,
  username: string,
): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  const row = await deps.storage.get(u);
  if (!row) return notFound("no such demo user");

  // Already torn down — idempotent success so a double-tap is a no-op.
  if (row.state === "none") {
    return ok({ username: u, cancelled: true, state: "none" });
  }

  // Best-effort provider destroy. The hetzner client treats 404 as
  // success (already gone). On a hard failure we leave the row so a
  // retry (or the idle reaper) can finish, and surface a clear reason.
  if (row.activeServerId) {
    try {
      await deps.hetzner.destroyServer(row.activeServerId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await deps.storage.update(u, { state: "idle-pending-teardown" });
      return {
        status: 502,
        body: {
          username: u,
          cancelled: false,
          reason: "provider-destroy-failed",
          detail: msg.slice(0, 200),
        },
      };
    }
  }

  // Reset to a clean 'none' so the device disappears from the UI and a
  // future /connect re-provisions. Clear the per-server identity fields
  // (id/ip/fqdn) AND the provisioning observability fields so the next
  // run starts from a blank progress bar.
  await deps.storage.update(u, {
    state: "none",
    activeServerId: null,
    activeServerIp: null,
    activeServerFqdn: null,
    provisionPhase: null,
    provisionPhaseAt: null,
    provisionLastError: null,
  });
  await audit(deps, u, "demo-user-cancelled", `serverId=${row.activeServerId ?? ""}`);
  return ok({ username: u, cancelled: true, state: "none" });
}

// ──────────────────────────────────────────────────────────────────────
// 6. GET /api/dev/sample-user/{u} — admin
// ──────────────────────────────────────────────────────────────────────

export async function handleGetDemoUser(
  deps: DemoUsersDeps,
  username: string,
): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  const row = await deps.storage.get(u);
  if (!row) return notFound("no such demo user");
  // Live Hetzner poll only when there's an active server.
  let hetznerLive: { status: string; ipv4: string | null } | null = null;
  if (row.activeServerId) {
    try {
      hetznerLive = await deps.hetzner.getServerStatus(row.activeServerId);
    } catch {
      hetznerLive = null;
    }
  }
  return ok({
    username: row.username,
    display: row.display,
    state: row.state,
    snapshotId: row.snapshotId,
    isoR2Key: row.isoR2Key,
    activeServerId: row.activeServerId,
    activeServerFqdn: row.activeServerFqdn,
    lastActivityAt: row.lastActivityAt,
    ttlIdleMinutes: row.ttlIdleMinutes,
    region: row.region,
    size: row.size,
    createdAt: row.createdAt,
    hetznerLive,
  });
}

// ──────────────────────────────────────────────────────────────────────
// 7. GET /api/dev/sample-user — admin, list
// ──────────────────────────────────────────────────────────────────────

export async function handleListDemoUsers(
  deps: DemoUsersDeps,
): Promise<HandlerResponseWithHeaders> {
  const rows = await deps.storage.list();
  return ok({
    demoUsers: rows.map((r) => ({
      username: r.username,
      display: r.display,
      state: r.state,
      activeServerFqdn: r.activeServerFqdn,
      lastActivityAt: r.lastActivityAt,
      createdAt: r.createdAt,
    })),
  });
}

// ──────────────────────────────────────────────────────────────────────
// Cron helpers (exported for apps/com/src/index.ts to call)
// ──────────────────────────────────────────────────────────────────────

/** Idle reaper. Scans for rows whose `lastActivityAt < now -
 *  ttlIdleMinutes*60_000`, transitions them to `idle-pending-teardown`,
 *  calls Hetzner destroy, then back to `none` on success. Stays in
 *  `idle-pending-teardown` on failure so the next cron pass retries.
 *  See docs/sample-users.md §11.3. */
export async function runDemoIdleReaper(deps: DemoUsersDeps): Promise<{
  reaped: number;
  stuck: number;
}> {
  const now = nowMs(deps);
  const candidates = await deps.storage.findIdle(now);
  let reaped = 0;
  let stuck = 0;
  for (const row of candidates) {
    const cutoff = now - row.ttlIdleMinutes * 60_000;
    if (row.lastActivityAt >= cutoff) continue;
    // Don't idle-reap rows still in 'provisioning' — they have their
    // own dedicated fail timer (runDemoW11SnapshotPoller's failMs +
    // the provisioning poller's promote-on-register). A row that's
    // been provisioning for >30 min isn't "idle", it's "still being
    // set up" — destroying it mid-build wastes a cycle.
    if (row.state === "provisioning") continue;
    const claimed = await deps.storage.transition(
      row.username,
      row.state,
      "idle-pending-teardown",
    );
    if (!claimed || !claimed.activeServerId) continue;
    try {
      await deps.hetzner.destroyServer(claimed.activeServerId);
      await deps.storage.transition(
        row.username,
        "idle-pending-teardown",
        "none",
        { activeServerId: null, activeServerFqdn: null },
      );
      await audit(
        deps,
        row.username,
        "demo-vps-idle-reaped",
        `idleMinutes=${Math.round((now - row.lastActivityAt) / 60_000)}`,
      );
      reaped++;
    } catch {
      // Stay in idle-pending-teardown. If the row has been stuck for
      // > 1 hour, emit a single warning.
      const stuckMs = now - claimed.lastActivityAt;
      if (stuckMs > 60 * 60_000) {
        await audit(
          deps,
          row.username,
          "demo-vps-stuck",
          `serverId=${claimed.activeServerId} stuckMinutes=${Math.round(stuckMs / 60_000)}`,
        );
        stuck++;
      }
    }
  }
  return { reaped, stuck };
}

/** Provisioning poller. Promotes `provisioning → up` rows whose
 *  Hetzner status is `running` AND whose daemon has registered with
 *  `.com` (we use an injected `isRegistered(fqdn, createdAt)` check
 *  since the install-events table lives in apps/com's storage layer
 *  and is not shared via this package). See docs/sample-users.md
 *  §11.4.
 *
 *  W11 carve-out: rows whose `snapshotId` is null AND `isoR2Key` is
 *  set were created by `admin-snapshot-now` (the W11 Worker-side
 *  provisioning path). For those, the cron snapshots the temp VPS
 *  instead of promoting it — see `runDemoW11SnapshotPoller`. The
 *  promoter SKIPS them so the two paths don't race on the same row. */
export async function runDemoProvisioningPoller(
  deps: DemoUsersDeps,
  isRegistered: (fqdn: string, createdAt: number) => Promise<boolean>,
): Promise<{ promoted: number }> {
  const rows = await deps.storage.list();
  let promoted = 0;
  for (const row of rows) {
    if (row.state !== "provisioning") continue;
    if (!row.activeServerId) continue;
    // W11 rows have no snapshot id yet AND have isoR2Key set; those
    // go through runDemoW11SnapshotPoller. Skip them here.
    // W13 rows have BOTH snapshotId AND isoR2Key null — they're a
    // direct cloud-init provision (no ISO, no snapshot). Promote
    // them like ordinary rows once the daemon registers.
    if (!row.snapshotId && row.isoR2Key !== null) continue;
    let live: { status: string; ipv4: string | null };
    try {
      live = await deps.hetzner.getServerStatus(row.activeServerId);
    } catch {
      continue;
    }
    if (live.status !== "running") continue;
    const fqdn = row.activeServerFqdn ?? demoServerFqdn(row.username);
    if (!(await isRegistered(fqdn, row.createdAt))) continue;
    const promotedRow = await deps.storage.transition(
      row.username,
      "provisioning",
      "up",
      { activeServerFqdn: fqdn, lastActivityAt: nowMs(deps) },
    );
    if (promotedRow) {
      await audit(
        deps,
        row.username,
        "demo-vps-provisioned",
        `serverId=${row.activeServerId} fqdn=${fqdn}`,
      );
      promoted++;
    }
  }
  return { promoted };
}

// ──────────────────────────────────────────────────────────────────────
// W11 snapshot + destroy cron (replaces the operator's laptop flow)
// ──────────────────────────────────────────────────────────────────────

/** Structural subset of the Worker-side Hetzner client used ONLY by
 *  the W11 snapshot poller. Kept here so the control-plane package
 *  stays decoupled from apps/com. */
export interface HetznerSnapshotter {
  destroyServer(serverId: string): Promise<void>;
  createImageSnapshot(
    serverId: string,
    description: string,
  ): Promise<{ imageId: string }>;
  getImageStatus(
    imageId: string,
  ): Promise<{ status: "creating" | "available" | "unknown" }>;
}

export interface DemoW11SnapshotDeps {
  storage: DemoUsersStorage;
  hetzner: HetznerSnapshotter;
  audit?: AuditEventStorage;
  now?: () => number;
  /** Grace before the snapshot attempt — keeps a flapping daemon from
   *  being snapshotted mid-boot. Default: 3 minutes. */
  preSnapshotGraceMs?: number;
  /** Hard timeout — declare failure when a W11 row sits in
   *  provisioning longer than this. Default: 20 minutes. */
  failTimeoutMs?: number;
  /** Recency threshold for the "pod recently reported" check. The
   *  caller is expected to feed in a function that consults the
   *  install_events / daemon_status tables for the W11 row's fqdn.
   *  Default: 5 minutes. */
  podRecentMs?: number;
}

/**
 * W11 snapshot + teardown driver. Runs on the same 10-minute cron as
 * the legacy reaper / promoter. For each W11 row
 * (`state='provisioning' && isoR2Key !== null`):
 *
 *   1. Within `preSnapshotGraceMs` of last_state_change: skip (let
 *      the cloud-init dd-and-reboot finish + the daemon register).
 *   2. Caller-injected `isRegistered(fqdn, recencyMs)` says no: skip
 *      and try again next tick.
 *   3. snapshotId NULL → call `createImageSnapshot`; stamp snapshotId.
 *   4. snapshotId NOT NULL → poll `getImageStatus`; when 'available',
 *      `destroyServer(activeServerId)` + transition to 'none' with
 *      activeServerId cleared.
 *   5. Older than `failTimeoutMs` with no /pods registration: declare
 *      failure, destroy the temp VPS, set state='none' WITHOUT
 *      snapshot_id. Operator can re-run admin-snapshot-now.
 *      (Default 45 min — sized for Debian d-i mini.iso + apt pkgsel +
 *      late-command's `npm ci` + `tsc -b` on a small VPS. Alpine apkovl
 *      finished in ~5 min; Debian d-i legitimately needs 20-30 min.)
 */
export async function runDemoW11SnapshotPoller(
  deps: DemoW11SnapshotDeps,
  isRegistered: (fqdn: string, recencyMs: number) => Promise<boolean>,
): Promise<{ snapshotted: number; finalized: number; failed: number }> {
  const now = (deps.now ?? Date.now)();
  const graceMs = deps.preSnapshotGraceMs ?? 3 * 60_000;
  const failMs = deps.failTimeoutMs ?? 45 * 60_000;
  const podRecentMs = deps.podRecentMs ?? 5 * 60_000;
  const rows = await deps.storage.list();
  let snapshotted = 0;
  let finalized = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.state !== "provisioning") continue;
    if (!row.isoR2Key) continue; // not W11
    if (!row.activeServerId) continue;
    const ageMs = now - row.createdAt;
    if (ageMs < graceMs) continue;
    const fqdn = row.activeServerFqdn ?? demoServerFqdn(row.username);

    // Already snapshotting: poll image, finalize on 'available'.
    if (row.snapshotId) {
      let imgStatus: { status: "creating" | "available" | "unknown" };
      try {
        imgStatus = await deps.hetzner.getImageStatus(row.snapshotId);
      } catch {
        continue;
      }
      if (imgStatus.status !== "available") continue;
      try {
        await deps.hetzner.destroyServer(row.activeServerId);
      } catch {
        // Leave the row for the next tick; we don't want to lose the
        // snapshot id because of a transient destroy failure.
        continue;
      }
      const transitioned = await deps.storage.transition(
        row.username,
        "provisioning",
        "none",
        {
          activeServerId: null,
          activeServerFqdn: null,
          lastActivityAt: now,
        },
      );
      if (transitioned) {
        if (deps.audit) {
          try {
            await deps.audit.append({
              username: row.username,
              eventKind: "demo-vps-provisioned",
              detail: `w11-snapshot ready snapshot_id=${row.snapshotId}`,
              devicePrefix: "",
              postedAt: now,
            });
          } catch {
            // best-effort
          }
        }
        finalized++;
      }
      continue;
    }

    // No snapshot yet: check daemon registration first.
    if (!(await isRegistered(fqdn, podRecentMs))) {
      if (ageMs > failMs) {
        // Give up — destroy the VPS, clear active_server_id, surface
        // the failure via audit. Operator can re-run.
        try {
          await deps.hetzner.destroyServer(row.activeServerId);
        } catch {
          // Stay provisioning; next tick will retry the destroy.
          continue;
        }
        await deps.storage.transition(
          row.username,
          "provisioning",
          "none",
          {
            activeServerId: null,
            activeServerFqdn: null,
            isoR2Key: null,
            lastActivityAt: now,
          },
        );
        if (deps.audit) {
          try {
            await deps.audit.append({
              username: row.username,
              eventKind: "demo-vps-stuck",
              detail: `w11-provision-timeout ageMs=${ageMs}`,
              devicePrefix: "",
              postedAt: now,
            });
          } catch {}
        }
        failed++;
      }
      continue;
    }

    // Daemon registered. Kick off the snapshot.
    let snap: { imageId: string };
    try {
      snap = await deps.hetzner.createImageSnapshot(
        row.activeServerId,
        `flagship-demo-${row.username}`,
      );
    } catch {
      continue;
    }
    await deps.storage.update(row.username, {
      snapshotId: snap.imageId,
      activeServerFqdn: fqdn,
      lastActivityAt: now,
    });
    snapshotted++;
  }
  return { snapshotted, finalized, failed };
}

// ──────────────────────────────────────────────────────────────────────
// /api/users/check extension
// ──────────────────────────────────────────────────────────────────────

/** Embedded into the /users/check response when the username matches
 *  a demo_users row. See docs/sample-users.md §10.9. */
export interface DemoServerBlock {
  fqdn: string;
  status: "none" | "provisioning" | "up";
  ttlIdleMinutes: number;
  /**
   * Fine-grained provisioning observability (migration 0035). The latest
   * named PHASE checkpoint, now a canonical `ProvisionStatusPhase`
   * (booting → downloading → partitioning → installing → registering →
   * sealing → pairing → live, terminal `error`) — the SAME vocabulary the
   * real-box install timeline uses. Mirrored here from the single canonical
   * order-status channel; `null` when no checkpoint has arrived yet. The
   * coarse `status` above is the three-state lifecycle; `phase` is the step
   * WITHIN provisioning so the phone can render a real progress list. The
   * 3-state lifecycle is derivable from this single phase (live → up,
   * error → failed, else provisioning) — see usersCheck.js demoLifecycle.
   */
  phase: string | null;
  /** Wall-clock ms the latest phase landed; null when `phase` is null. */
  phaseAt: number | null;
  /** Failure detail, present only when `phase === "failed"`. */
  lastError?: string;
  /**
   * Device-identifying metadata (migration 0036) so the user can confirm
   * the box they're watching is theirs. These ride the same signaling
   * channel as `phase`. Each is omitted when unknown (provider hasn't
   * returned it / pre-0036 row) so the wire stays minimal.
   *   ip         — public IPv4 the provider handed back.
   *   region     — provider location (e.g. `fsn1`).
   *   serverType — provider size (e.g. `cx22`).
   *   image      — provider OS image (e.g. `debian-12`).
   */
  ip?: string;
  region?: string;
  serverType?: string;
  image?: string;
}

/** Pure mapper from a storage row to the public-facing block. Exposed
 *  so usersCheck.ts + accountResolve.ts fold it into their responses. */
export function demoServerBlockFromRow(row: DemoUserRecord): DemoServerBlock {
  return {
    fqdn: row.activeServerFqdn ?? demoServerFqdn(row.username),
    status: publicStatus(row.state),
    ttlIdleMinutes: row.ttlIdleMinutes,
    phase: row.provisionPhase ?? null,
    phaseAt: row.provisionPhaseAt ?? null,
    ...(row.provisionLastError ? { lastError: row.provisionLastError } : {}),
    ...(row.activeServerIp ? { ip: row.activeServerIp } : {}),
    ...(row.region ? { region: row.region } : {}),
    ...(row.size ? { serverType: row.size } : {}),
    ...(row.image ? { image: row.image } : {}),
  };
}
