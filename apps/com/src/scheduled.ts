/**
 * D1 → R2 backup pipeline. Runs from the Worker's cron trigger every
 * 6 hours.
 *
 * Why a Worker-resident job (not a Fly cron / external runner):
 *   - D1 lives behind the binding; the Worker already has authenticated
 *     access without needing to plumb a long-lived API token elsewhere.
 *   - R2 is bound here too — zero-egress, zero-extra-cred backups.
 *   - Cloudflare's scheduler is the same trust root as the Worker, so
 *     this stays inside the .com control-plane boundary.
 *
 * Dump format: one JSON Lines file per run. Each row is either
 *   {"type":"table","name":"<table>"}
 * announcing the table, followed by N
 *   {"type":"row","table":"<table>","data":{...}}
 * lines for its contents.
 *
 * Why JSONL (not SQL): D1 has no native dump API, so we'd be hand-
 * constructing INSERTs either way. JSONL is easier to inspect, easier
 * to filter (`zcat foo.jsonl.gz | jq 'select(.table=="usernames")'`),
 * and trivially streamable. The restore runbook turns it back into SQL
 * via a tiny tsx script.
 *
 * Streaming: tables are walked LIMIT/OFFSET in chunks of CHUNK_ROWS so
 * we never buffer a whole table in memory. The JSONL bytes flow through
 * a CompressionStream into R2.put(stream), so the entire pipeline is
 * O(CHUNK_ROWS) RAM regardless of table size.
 *
 * Retention:
 *   - Hourly snapshots live under d1/hourly/YYYY-MM-DD-HH.jsonl.gz and
 *     are pruned to 30 days by code on each run.
 *   - On the first run of each calendar month (UTC) we ALSO write a
 *     monthly snapshot under d1/monthly/YYYY-MM.jsonl.gz. Monthly
 *     snapshots are never pruned by the Worker — operators reclaim
 *     them via R2 lifecycle rules or by hand.
 */

import type { D1Database } from "@flagship/storage";
import { D1Storage } from "@flagship/storage";
import {
  runCustomDomainVerificationPass,
  resolveCnameChain,
  pushRedirection,
  runDemoIdleReaper,
  runDemoProvisioningPoller,
} from "@flagship/control-plane";
import { createHetznerClient } from "./hetzner.js";

/** Scope of one row that the dump emits. */
export type DumpRow =
  | { type: "meta"; tookAt: string; cron: string }
  | { type: "table"; name: string }
  | { type: "row"; table: string; data: Record<string, unknown> };

export interface ScheduledEnv {
  DB?: D1Database;
  /** R2 bucket for D1 backup artifacts. Separate from ISO_BUCKET. */
  BACKUPS_BUCKET?: R2BucketLike;
  /** .services :8443 base (wrangler.toml) — custom-domain verifier
   *  pushes confirmed/invalidated redirections here (#79B/#87). */
  SERVICES_BASE_URL?: string;
  /** Shared bearer for the .com↔.services control channel (#87). */
  SERVICES_CONTROL_SECRET?: string;
  /** Plan A — Hetzner API token (idle reaper + provisioning poller).
   *  Unset ⇒ the demo cron branch no-ops. */
  HCLOUD_TOKEN?: string;
  /** Plan A — numeric Hetzner SSH key id (set in [vars]). Unused by
   *  the cron itself but plumbed for symmetry with the request path. */
  DEMO_PUBLIC_SSH_KEY_ID?: string;
}

/**
 * Minimal R2 binding shape the backup needs. The real Cloudflare
 * binding is a superset (put / list / delete are the only methods we
 * call). Defined locally so the tests can hand in a plain object stub
 * without dragging in @cloudflare/workers-types at runtime.
 */
export interface R2BucketLike {
  put(
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string,
    options?: { httpMetadata?: { contentType?: string; contentEncoding?: string } },
  ): Promise<unknown>;
  list(options?: { prefix?: string; cursor?: string }): Promise<R2ListResultLike>;
  delete(keys: string | string[]): Promise<void>;
}

export interface R2ListResultLike {
  objects: Array<{ key: string }>;
  truncated: boolean;
  cursor?: string;
}

/** Read this many rows per D1 round-trip. Keeps each request small enough that workerd's CPU budget doesn't trip on a single batch. */
export const CHUNK_ROWS = 500;

/** Hourly retention window (days). 30 = "you can roll back a month." */
export const HOURLY_RETENTION_DAYS = 30;

const HOURLY_PREFIX = "d1/hourly/";
const MONTHLY_PREFIX = "d1/monthly/";

/**
 * Run one full backup cycle. Called both from the cron handler and
 * directly from tests.
 */
export async function runBackup(
  env: ScheduledEnv,
  now: Date,
  cronSpec: string,
): Promise<BackupResult> {
  if (!env.DB) throw new Error("DB binding missing — cannot run D1 backup");
  if (!env.BACKUPS_BUCKET) {
    throw new Error("BACKUPS_BUCKET binding missing — cannot write D1 backup");
  }

  const tables = await listTables(env.DB);
  const hourlyKey = `${HOURLY_PREFIX}${formatHourlyKey(now)}.jsonl.gz`;

  const hourly = buildDumpStream(env.DB, tables, now, cronSpec);
  const gzip = hourly.stream.pipeThrough(new CompressionStream("gzip"));
  await env.BACKUPS_BUCKET.put(hourlyKey, gzip, {
    httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" },
  });

  let monthlyKey: string | null = null;
  // Monthly snapshot: first hourly run of each calendar month (UTC).
  // We can't reuse the hourly stream — it's already consumed — so we
  // dump again. Cost is one extra D1 walk every ~720 hourly runs;
  // negligible vs the value of an indefinite long-tail snapshot.
  if (now.getUTCDate() === 1 && now.getUTCHours() < 6) {
    monthlyKey = `${MONTHLY_PREFIX}${formatMonthlyKey(now)}.jsonl.gz`;
    const month = buildDumpStream(env.DB, tables, now, cronSpec);
    const monthGz = month.stream.pipeThrough(new CompressionStream("gzip"));
    await env.BACKUPS_BUCKET.put(monthlyKey, monthGz, {
      httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" },
    });
  }

  // Sweep stale hourly snapshots after the new one is durable, so a
  // failure between write + sweep just keeps a stragglier file around
  // — never erases the last good copy.
  const cutoff = new Date(now.getTime() - HOURLY_RETENTION_DAYS * 86_400 * 1000);
  const deleted = await pruneHourly(env.BACKUPS_BUCKET, cutoff);

  return {
    hourlyKey,
    monthlyKey,
    tables,
    tableStats: hourly.stats.perTable,
    totalRows: hourly.stats.totalRows,
    deletedHourlyKeys: deleted,
  };
}

export interface BackupResult {
  hourlyKey: string;
  monthlyKey: string | null;
  tables: string[];
  tableStats: Map<string, number>;
  totalRows: number;
  deletedHourlyKeys: string[];
}

interface DumpStats {
  totalRows: number;
  perTable: Map<string, number>;
}

/**
 * Discover user tables to dump. We deliberately skip
 *   - sqlite_*  internal bookkeeping
 *   - _cf_KV    Cloudflare's D1 migrations bookkeeping
 * because both are recreated by the platform/migrations on a fresh
 * database, so backing them up would just clutter the dump.
 */
async function listTables(db: D1Database): Promise<string[]> {
  const result = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    )
    .all<{ name: string }>();
  return (result.results ?? []).map((r) => r.name).filter((n) => typeof n === "string");
}

/**
 * Build a ReadableStream of UTF-8 JSONL bytes for a full dump. Rows
 * are pulled chunk-by-chunk so memory is bounded.
 */
function buildDumpStream(
  db: D1Database,
  tables: string[],
  now: Date,
  cronSpec: string,
): { stream: ReadableStream<Uint8Array>; stats: DumpStats } {
  const encoder = new TextEncoder();
  // Stats live on a shared object so callers see updates as the stream
  // is consumed downstream (R2.put). Otherwise the caller would close
  // over zero-valued primitives at construction time.
  const stats: DumpStats = { totalRows: 0, perTable: new Map() };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const meta: DumpRow = { type: "meta", tookAt: now.toISOString(), cron: cronSpec };
        controller.enqueue(encoder.encode(JSON.stringify(meta) + "\n"));
        for (const table of tables) {
          // SQL injection guard: tables came from sqlite_master and
          // pass the identifier shape check below. We still quote the
          // identifier with [ ] in case a legitimate table name shares
          // a SQL keyword.
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) continue;
          const header: DumpRow = { type: "table", name: table };
          controller.enqueue(encoder.encode(JSON.stringify(header) + "\n"));
          let offset = 0;
          let perTable = 0;
          while (true) {
            const chunk = await db
              .prepare(`SELECT * FROM [${table}] LIMIT ? OFFSET ?`)
              .bind(CHUNK_ROWS, offset)
              .all<Record<string, unknown>>();
            const rows = chunk.results ?? [];
            for (const data of rows) {
              const row: DumpRow = { type: "row", table, data };
              controller.enqueue(encoder.encode(JSON.stringify(row) + "\n"));
            }
            perTable += rows.length;
            if (rows.length < CHUNK_ROWS) break;
            offset += CHUNK_ROWS;
          }
          stats.perTable.set(table, perTable);
          stats.totalRows += perTable;
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });

  return { stream, stats };
}

/**
 * Walk d1/hourly/* and delete keys whose embedded timestamp is older
 * than `cutoff`. Pagination follows the R2 cursor so a backlog of many
 * thousands of files still terminates.
 */
async function pruneHourly(bucket: R2BucketLike, cutoff: Date): Promise<string[]> {
  const deleted: string[] = [];
  let cursor: string | undefined;
  do {
    const page: R2ListResultLike = await bucket.list({
      prefix: HOURLY_PREFIX,
      ...(cursor ? { cursor } : {}),
    });
    const stale = page.objects
      .map((o) => o.key)
      .filter((k) => isHourlyKeyOlderThan(k, cutoff));
    if (stale.length > 0) {
      await bucket.delete(stale);
      for (const k of stale) deleted.push(k);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}

const HOURLY_KEY_RE = /^d1\/hourly\/(\d{4})-(\d{2})-(\d{2})-(\d{2})\.jsonl\.gz$/;

function isHourlyKeyOlderThan(key: string, cutoff: Date): boolean {
  const m = key.match(HOURLY_KEY_RE);
  if (!m) return false;
  const [, y, mo, d, h] = m;
  const t = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    0,
    0,
    0,
  );
  return t < cutoff.getTime();
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function formatHourlyKey(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}-${pad2(d.getUTCHours())}`;
}
function formatMonthlyKey(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/**
 * Worker-facing scheduled handler. Cloudflare passes a controller +
 * env + ctx; we forward env to runBackup and use waitUntil so a slow
 * backup doesn't get the Worker terminated when the handler returns.
 */
export async function scheduled(
  controller: { scheduledTime: number; cron: string },
  env: ScheduledEnv,
  ctx: { waitUntil(p: Promise<unknown>): void },
): Promise<void> {
  const now = new Date(controller.scheduledTime);
  // The 6-hourly cron drives D1 backup + custom-domain verify (both
  // were here before Plan A). The new 10-minute cron drives the
  // demo-user reaper + provisioning poller.
  if (controller.cron === "0 */6 * * *") {
    ctx.waitUntil(runBackup(env, now, controller.cron));
    ctx.waitUntil(runCustomDomainVerify(env, now));
    return;
  }
  if (controller.cron === "*/10 * * * *") {
    ctx.waitUntil(runDemoCron(env, now));
    return;
  }
  // Unknown cron string — be defensive: do nothing rather than mis-
  // dispatch. Cloudflare can't add crons without a deploy.
}

/**
 * Plan A — demo-user cron pass. Idle reaper + provisioning poller.
 * No-ops when HCLOUD_TOKEN isn't configured (lets a deploy ship the
 * cron entry safely before the demo system is provisioned).
 *
 * See docs/sample-users.md §11.
 */
export async function runDemoCron(
  env: ScheduledEnv,
  now: Date,
): Promise<{ reaped: number; stuck: number; promoted: number } | null> {
  if (!env.DB || !env.HCLOUD_TOKEN) return null;
  const storage = new D1Storage(env.DB);
  const hetzner = createHetznerClient(env.HCLOUD_TOKEN);
  const deps = {
    storage: storage.demoUsers,
    usernames: storage.usernames,
    hetzner,
    sshKeyId: 0, // unused by reaper / poller
    audit: storage.auditEvents,
    now: () => now.getTime(),
  };
  const reaperResult = await runDemoIdleReaper(deps);
  const pollerResult = await runDemoProvisioningPoller(
    deps,
    async (fqdn, createdAt) => {
      const r = await env
        .DB!.prepare(
          "SELECT 1 FROM install_events WHERE server_fqdn = ? AND event = 'registered' AND created_at > ? LIMIT 1",
        )
        .bind(fqdn, createdAt)
        .first();
      return !!r;
    },
  );
  return {
    reaped: reaperResult.reaped,
    stuck: reaperResult.stuck,
    promoted: pollerResult.promoted,
  };
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
    resolveCname: (fqdn) => resolveCnameChain(fqdn),
    pushRedirection: async (op, fqdn, podCanonical) => {
      await pushRedirection({ servicesBaseUrl, secret }, { op, fqdn, podCanonical });
    },
    now: () => now.getTime(),
  });
}

export const _internal = {
  HOURLY_PREFIX,
  MONTHLY_PREFIX,
  CHUNK_ROWS,
  HOURLY_RETENTION_DAYS,
  isHourlyKeyOlderThan,
  formatHourlyKey,
  formatMonthlyKey,
  HOURLY_KEY_RE,
};
