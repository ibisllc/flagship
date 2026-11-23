/**
 * How code protection (TOTP) enrolment calls end, hour by hour (security
 * report F2: with no Worker logs kept, nobody could tell why an enrolment
 * failed). D1 `totp_outcome_log` (migration 0160): per hour, endpoint
 * (`enroll-begin`, `enroll-confirm`, `disable`) and outcome (`ok`, the
 * refusal's `code`, or `internal-error`), a count. Nothing about the caller
 * or the account is stored. Read by GET /api/admin/totp-outcomes and
 * `npm run totp-outcomes`; the 6-hourly cron drops rows older than 90 days.
 *
 * Writing never fails or slows a request: callers hand the promise to
 * waitUntil, and errors are logged and dropped.
 */

import { authorizeAdmin } from "@flagship/control-plane";
import type { D1Database } from "@flagship/storage";
import { hourBucket } from "./rateLimitLog.js";

export const TOTP_OUTCOME_ENDPOINTS = ["enroll-begin", "enroll-confirm", "disable"] as const;
export type TotpOutcomeEndpoint = (typeof TOTP_OUTCOME_ENDPOINTS)[number];

export const TOTP_OUTCOME_LOG_RETENTION_DAYS = 90;
export const TOTP_OUTCOMES_PATH = "/api/admin/totp-outcomes";

/** `ok` for a 2xx, else the answer's `code` (a short slug), else `http-<status>`. */
export function outcomeOf(status: number, body: unknown): string {
  if (status >= 200 && status < 300) return "ok";
  const code = (body as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[a-z][a-z0-9-]{0,47}$/.test(code)) return code;
  return `http-${status}`;
}

export async function recordTotpOutcome(
  db: D1Database,
  endpoint: TotpOutcomeEndpoint,
  outcome: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    await db
      .prepare(
        "INSERT INTO totp_outcome_log (bucket_hour, endpoint, outcome, count) VALUES (?, ?, ?, 1) " +
          "ON CONFLICT(bucket_hour, endpoint, outcome) DO UPDATE SET count = count + 1",
      )
      .bind(hourBucket(now), endpoint, outcome)
      .run();
  } catch (err) {
    console.warn("totpOutcomeLog: record failed", (err as Error).name);
  }
}

export interface TotpOutcomeRow {
  day: string;
  endpoint: string;
  outcome: string;
  count: number;
}

/** Per day, endpoint and outcome since `sinceDay` (YYYY-MM-DD, inclusive). */
export async function readTotpOutcomes(db: D1Database, sinceDay: string): Promise<TotpOutcomeRow[]> {
  const r = await db
    .prepare(
      "SELECT substr(bucket_hour, 1, 10) AS day, endpoint, outcome, SUM(count) AS count " +
        "FROM totp_outcome_log WHERE bucket_hour >= ? GROUP BY day, endpoint, outcome ORDER BY day, endpoint, outcome",
    )
    .bind(sinceDay)
    .all<TotpOutcomeRow>();
  return r.results;
}

export async function pruneTotpOutcomeLog(db: D1Database, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - TOTP_OUTCOME_LOG_RETENTION_DAYS * 86_400_000);
  await db.prepare("DELETE FROM totp_outcome_log WHERE bucket_hour < ?").bind(hourBucket(cutoff)).run();
}

export interface TotpOutcomeReport {
  days: number;
  since: string;
  /** endpoint → outcome → count, over the window. */
  totals: Record<string, Record<string, number>>;
  daily: TotpOutcomeRow[];
}

export function buildTotpOutcomeReport(rows: readonly TotpOutcomeRow[], days: number, since: string): TotpOutcomeReport {
  const totals: Record<string, Record<string, number>> = {};
  for (const e of TOTP_OUTCOME_ENDPOINTS) totals[e] = {};
  for (const row of rows) {
    const t = (totals[row.endpoint] ??= {});
    t[row.outcome] = (t[row.outcome] ?? 0) + Number(row.count);
  }
  return { days, since, totals, daily: [...rows] };
}

export interface TotpOutcomeReportEnv {
  DB?: D1Database;
  FLAGSHIP_ADMIN_SECRET?: string;
}

/** GET /api/admin/totp-outcomes?days=7 (x-admin-secret, 1–90 days). */
export async function handleTotpOutcomeReport(request: Request, env: TotpOutcomeReportEnv): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  const auth = authorizeAdmin({ expected: env.FLAGSHIP_ADMIN_SECRET, provided: request.headers.get("x-admin-secret") });
  if (auth) return json(auth.body, auth.status);
  if (!env.DB) return json({ error: "totp outcome log unavailable" }, 503);
  const asked = Number(new URL(request.url).searchParams.get("days") ?? "7");
  const days = Number.isInteger(asked) && asked >= 1 ? Math.min(asked, TOTP_OUTCOME_LOG_RETENTION_DAYS) : 7;
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return json(buildTotpOutcomeReport(await readTotpOutcomes(env.DB, since), days, since), 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
