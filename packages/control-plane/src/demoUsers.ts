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

/** docs/sample-users.md §2.4 — username naming rules. */
const USERNAME_RE = /^[a-z0-9-]{3,32}$/;
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

function validateDemoUsername(raw: unknown): {
  ok: true;
  username: string;
} | {
  ok: false;
  reason: string;
} {
  if (typeof raw !== "string") return { ok: false, reason: "username must be a string" };
  const u = raw.toLowerCase();
  if (!USERNAME_RE.test(u)) {
    return { ok: false, reason: "username must match [a-z0-9-]{3,32}" };
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

  // Real-account-username collision.
  const realClaim = await deps.usernames.get(username);
  if (realClaim) {
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
    activeServerFqdn: null,
    lastActivityAt: 0,
    state: "none",
    createdAt,
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
  const v = validateDemoUsername(body.username);
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
      // `demo-vps-stuck` if it lingers.
      await deps.storage.update(username, { state: "idle-pending-teardown" });
      return ok({ username, deleted: false, reason: "hetzner-destroy-failed" });
    }
  }
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
 *  §11.4. */
export async function runDemoProvisioningPoller(
  deps: DemoUsersDeps,
  isRegistered: (fqdn: string, createdAt: number) => Promise<boolean>,
): Promise<{ promoted: number }> {
  const rows = await deps.storage.list();
  let promoted = 0;
  for (const row of rows) {
    if (row.state !== "provisioning") continue;
    if (!row.activeServerId) continue;
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
// /api/users/check extension
// ──────────────────────────────────────────────────────────────────────

/** Embedded into the /users/check response when the username matches
 *  a demo_users row. See docs/sample-users.md §10.9. */
export interface DemoServerBlock {
  fqdn: string;
  status: "none" | "provisioning" | "up";
  ttlIdleMinutes: number;
}

/** Pure mapper from a storage row to the public-facing block. Exposed
 *  so usersCheck.ts can fold it into the existing response. */
export function demoServerBlockFromRow(row: DemoUserRecord): DemoServerBlock {
  return {
    fqdn: row.activeServerFqdn ?? demoServerFqdn(row.username),
    status: publicStatus(row.state),
    ttlIdleMinutes: row.ttlIdleMinutes,
  };
}
