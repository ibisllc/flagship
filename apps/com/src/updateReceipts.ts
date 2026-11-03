/**
 * Canary update receipts (architecture v2 V02; docs/runbooks/canary.md).
 *
 *   POST /api/update-receipts            a box's content-free receipt (protocol updateReceipt.ts). No
 *                                        session, no signature, nothing about the caller is stored: the
 *                                        receipt only adds one to a count per release, cohort, profile
 *                                        (architecture x stack) and arrival day. Metered per network
 *                                        (`update-receipt` in rateLimit.ts).
 *   GET  /api/admin/canary?days=30[&release=<commit>]   (x-admin-secret) the counts, per release,
 *                                        cohort and profile, for `npm run canary`.
 *
 * Storage is bounded per day (MAX_RECEIPTS_PER_DAY, MAX_NEW_COUNT_ROWS_PER_DAY) and pruned by the cron, exactly by day.
 *
 * Receipts are anonymous, so they can be forged: a flood can make a release look better or worse than it
 * is. The canary therefore stops on bad news and widens only by an operator's decision, with the gym, the
 * maintainers' boxes and the observation time as the other gates (runbook "What receipts cannot prove").
 */

import { authorizeAdmin } from "@flagship/control-plane";
import { parseUpdateReceipt, receiptOutcome, UPDATE_RECEIPT_PATH, type OutcomeCounts } from "@flagship/protocol";
import type { D1Database } from "@flagship/storage";

export { UPDATE_RECEIPT_PATH };
export const CANARY_REPORT_PATH = "/api/admin/canary";

/** Arrival days of counts kept; resend nonces only need to outlive a box's retries. */
export const RECEIPT_COUNT_RETENTION_DAYS = 400;
export const RECEIPT_NONCE_RETENTION_DAYS = 14;
/** Receipts taken per arrival day (bounds the nonce table to this x RECEIPT_NONCE_RETENTION_DAYS rows). */
export const MAX_RECEIPTS_PER_DAY = 5000;
/** Count rows a day may add (a release x cohort x profile is one row; a real day has a few dozen). Bounds the counts
 *  table to this x RECEIPT_COUNT_RETENTION_DAYS rows. */
export const MAX_NEW_COUNT_ROWS_PER_DAY = 300;
const MAX_BODY = 1024;

export interface UpdateReceiptEnv {
  DB?: D1Database;
  FLAGSHIP_ADMIN_SECRET?: string;
}

const day = (now: Date) => now.toISOString().slice(0, 10);
const daysAgo = (now: Date, n: number) => day(new Date(now.getTime() - n * 86_400_000));

export async function handleUpdateReceipt(request: Request, env: UpdateReceiptEnv, now: Date = new Date()): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!env.DB) return json({ error: "receipts unavailable" }, 503);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: "too large" }, 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json({ error: "not a receipt" }, 400);
  }
  const r = parseUpdateReceipt(parsed);
  if (!r) return json({ error: "not a receipt" }, 400);
  const today = day(now);
  const db = env.DB;
  // Storage is bounded per day whatever callers send: a receipt cap (the nonce table), and a cap on the count rows a
  // day may add (each made-up release, cohort or profile would be a new row). A refused receipt is not spent, so a
  // box's retry on a later day still counts.
  const taken = await db.prepare("SELECT COUNT(*) AS n FROM update_receipt_nonces WHERE day = ?").bind(today).first<{ n: number }>();
  if ((taken?.n ?? 0) >= MAX_RECEIPTS_PER_DAY) return full();
  const fresh = await db.prepare("INSERT OR IGNORE INTO update_receipt_nonces (nonce, day) VALUES (?, ?)").bind(r.nonce, today).run();
  if (!fresh.meta?.changes) return json({ ok: true, duplicate: true }, 200);
  const o = receiptOutcome(r);
  const add = [o === "passed" ? 1 : 0, o === "rolled-back" ? 1 : 0, o === "stuck" ? 1 : 0] as const;
  const bumped = await db
    .prepare(
      "UPDATE update_receipt_counts SET passed = passed + ?, rolled_back = rolled_back + ?, stuck = stuck + ? " +
        "WHERE release_commit = ? AND cohort = ? AND arch = ? AND stack = ? AND day = ?",
    )
    .bind(...add, r.release, r.cohort, r.arch, r.stack, today)
    .run();
  if (!bumped.meta?.changes) {
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM update_receipt_counts WHERE day = ?").bind(today).first<{ n: number }>();
    if ((rows?.n ?? 0) >= MAX_NEW_COUNT_ROWS_PER_DAY) {
      await db.prepare("DELETE FROM update_receipt_nonces WHERE nonce = ?").bind(r.nonce).run();
      return full();
    }
    await db
      .prepare(
        "INSERT INTO update_receipt_counts (release_commit, cohort, arch, stack, day, passed, rolled_back, stuck) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(release_commit, cohort, arch, stack, day) DO UPDATE SET passed = passed + excluded.passed, " +
          "rolled_back = rolled_back + excluded.rolled_back, stuck = stuck + excluded.stuck",
      )
      .bind(r.release, r.cohort, r.arch, r.stack, today, ...add)
      .run();
  }
  // No pruning here: it used to run when the caller's own nonce started with "0", which put it in the caller's hands.
  // The cron prunes (cronPlan "prune-update-receipts"), by day only.
  return json({ ok: true }, 202);
}

function full(): Response {
  return json({ error: "Receipts are full for today. Try again tomorrow.", code: "receipts-full" }, 503);
}

export async function pruneUpdateReceipts(db: D1Database, now: Date = new Date()): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM update_receipt_nonces WHERE day < ?").bind(daysAgo(now, RECEIPT_NONCE_RETENTION_DAYS)),
    db.prepare("DELETE FROM update_receipt_counts WHERE day < ?").bind(daysAgo(now, RECEIPT_COUNT_RETENTION_DAYS)),
  ]);
}

interface CountRow {
  release_commit: string;
  cohort: string;
  arch: string;
  stack: string;
  day: string;
  passed: number;
  rolled_back: number;
  stuck: number;
}

export interface CanaryReleaseReport {
  release: string;
  totals: OutcomeCounts;
  byCohort: Record<string, OutcomeCounts>;
  /** `<arch>/<stack>` */
  byProfile: Record<string, OutcomeCounts>;
  daily: ({ day: string } & OutcomeCounts)[];
  firstDay: string;
  lastDay: string;
}

export interface CanaryReport {
  days: number;
  since: string;
  releases: CanaryReleaseReport[];
}

const zero = (): OutcomeCounts => ({ passed: 0, rolledBack: 0, stuck: 0 });
function add(into: OutcomeCounts, row: CountRow): void {
  into.passed += row.passed;
  into.rolledBack += row.rolled_back;
  into.stuck += row.stuck;
}

export function buildCanaryReport(rows: readonly CountRow[], days: number, since: string): CanaryReport {
  const by = new Map<string, CanaryReleaseReport>();
  for (const row of rows) {
    let r = by.get(row.release_commit);
    if (!r) {
      r = { release: row.release_commit, totals: zero(), byCohort: {}, byProfile: {}, daily: [], firstDay: row.day, lastDay: row.day };
      by.set(row.release_commit, r);
    }
    add(r.totals, row);
    add((r.byCohort[row.cohort] ??= zero()), row);
    add((r.byProfile[`${row.arch}/${row.stack}`] ??= zero()), row);
    let d = r.daily.find((x) => x.day === row.day);
    if (!d) {
      d = { day: row.day, ...zero() };
      r.daily.push(d);
    }
    add(d, row);
    if (row.day < r.firstDay) r.firstDay = row.day;
    if (row.day > r.lastDay) r.lastDay = row.day;
  }
  const releases = [...by.values()];
  for (const r of releases) r.daily.sort((a, b) => a.day.localeCompare(b.day));
  releases.sort((a, b) => b.lastDay.localeCompare(a.lastDay) || a.release.localeCompare(b.release));
  return { days, since, releases };
}

export async function handleCanaryReport(request: Request, env: UpdateReceiptEnv, now: Date = new Date()): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  const auth = authorizeAdmin({ expected: env.FLAGSHIP_ADMIN_SECRET, provided: request.headers.get("x-admin-secret") });
  if (auth) return json(auth.body, auth.status);
  if (!env.DB) return json({ error: "receipts unavailable" }, 503);
  const url = new URL(request.url);
  const asked = Number(url.searchParams.get("days") ?? "30");
  const days = Number.isInteger(asked) && asked >= 1 ? Math.min(asked, RECEIPT_COUNT_RETENTION_DAYS) : 30;
  const since = daysAgo(now, days - 1);
  const release = url.searchParams.get("release");
  if (release !== null && !/^[0-9a-f]{40}$/.test(release)) return json({ error: "release must be a 40-hex commit" }, 400);
  const sql = "SELECT release_commit, cohort, arch, stack, day, passed, rolled_back, stuck FROM update_receipt_counts WHERE day >= ?" + (release ? " AND release_commit = ?" : "");
  const stmt = release ? env.DB.prepare(sql).bind(since, release) : env.DB.prepare(sql).bind(since);
  const r = await stmt.all<CountRow>();
  return json(buildCanaryReport(r.results ?? [], days, since), 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
