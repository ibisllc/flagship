/**
 * GET /api/admin/rate-limits?days=7 (x-admin-secret): every budget in
 * rateLimit.ts with what the log (rateLimitLog.ts) saw over the last
 * `days` days (1–90), busiest first. scripts/rate-limit-report.mjs prints it.
 */

import { authorizeAdmin } from "@flagship/control-plane";
import type { D1Database } from "@flagship/storage";
import { LIMITS, limitScale, type RateLimitEndpoint } from "./rateLimit.js";
import { RATE_LIMIT_LOG_RETENTION_DAYS, readRateLimitLog, type RateLimitLogRow } from "./rateLimitLog.js";

export const RATE_LIMIT_REPORT_PATH = "/api/admin/rate-limits";

export interface RateLimitReportEnv {
  DB?: D1Database;
  FLAGSHIP_ADMIN_SECRET?: string;
  RATE_LIMIT_SCALE?: string;
}

interface Counts {
  refused: number;
  sources: number;
  near: number;
  unreachable: number;
}

export interface RateLimitReportEntry extends Counts {
  endpoint: string;
  rules: { axis: string; limit: number; windowSec: number }[];
  byAxis: Record<string, Counts>;
  daily: ({ day: string } & Counts)[];
}

export interface RateLimitReport {
  days: number;
  since: string;
  scale: number;
  endpoints: RateLimitReportEntry[];
}

const zero = (): Counts => ({ refused: 0, sources: 0, near: 0, unreachable: 0 });

function add(into: Counts, row: Counts): void {
  into.refused += row.refused;
  into.sources += row.sources;
  into.near += row.near;
  into.unreachable += row.unreachable;
}

export function buildRateLimitReport(
  rows: readonly RateLimitLogRow[],
  days: number,
  since: string,
  scale: number,
): RateLimitReport {
  const entries = new Map<string, RateLimitReportEntry>();
  for (const [endpoint, rules] of Object.entries(LIMITS) as [RateLimitEndpoint, (typeof LIMITS)[RateLimitEndpoint]][]) {
    entries.set(endpoint, {
      endpoint,
      rules: rules.map((r) => ({ axis: r.axis, limit: Math.ceil(r.limit * scale), windowSec: r.windowSec })),
      ...zero(),
      byAxis: {},
      daily: [],
    });
  }
  for (const row of rows) {
    let e = entries.get(row.endpoint);
    if (!e) {
      e = { endpoint: row.endpoint, rules: [], ...zero(), byAxis: {}, daily: [] };
      entries.set(row.endpoint, e);
    }
    add(e, row);
    add((e.byAxis[row.axis] ??= zero()), row);
    let day = e.daily.find((d) => d.day === row.day);
    if (!day) {
      day = { day: row.day, ...zero() };
      e.daily.push(day);
    }
    add(day, row);
  }
  const endpoints = [...entries.values()].sort(
    (a, b) => b.refused - a.refused || b.near - a.near || a.endpoint.localeCompare(b.endpoint),
  );
  return { days, since, scale, endpoints };
}

export async function handleRateLimitReport(request: Request, env: RateLimitReportEnv): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  const auth = authorizeAdmin({ expected: env.FLAGSHIP_ADMIN_SECRET, provided: request.headers.get("x-admin-secret") });
  if (auth) return json(auth.body, auth.status);
  if (!env.DB) return json({ error: "rate-limit log unavailable" }, 503);
  const asked = Number(new URL(request.url).searchParams.get("days") ?? "7");
  const days = Number.isInteger(asked) && asked >= 1 ? Math.min(asked, RATE_LIMIT_LOG_RETENTION_DAYS) : 7;
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = await readRateLimitLog(env.DB, since);
  return json(buildRateLimitReport(rows, days, since, limitScale(env)), 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
