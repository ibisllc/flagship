/**
 * Which hosts a box's AI calls may leave through the hub (docs/outbound-hosts.md).
 *
 *   POST /api/outbound/check            (x-usage-secret, the hub) {host}
 *        → {allowed}. A host not seen before is recorded as allowed: a new AI
 *        provider just works. A host the owner blocked is refused.
 *   POST /api/outbound/report           (x-usage-secret, the hub) {rows:[{host,streams,up,down,refused}]}
 *        → adds to today's per-host totals.
 *   GET  /api/admin/outbound-hosts?days=1   (x-admin-secret) every host, busiest first.
 *   POST /api/admin/outbound-hosts          (x-admin-secret) {host, status, note?} → block or allow one.
 *
 * Nothing stored names an account, a box or a device: the hub calls with its own secret
 * and sends only a host, and the tables have no such column. scripts/outbound-hosts.mjs
 * prints and flips it.
 */

import { authorizeAdmin, constantTimeEqual } from "@flagship/control-plane";
import type { D1Database } from "@flagship/storage";

export const OUTBOUND_CHECK_PATH = "/api/outbound/check";
export const OUTBOUND_REPORT_PATH = "/api/outbound/report";
export const OUTBOUND_ADMIN_PATH = "/api/admin/outbound-hosts";

/** New hosts recorded per UTC day; past it an unseen host is refused until tomorrow or the owner adds it. */
export const NEW_HOSTS_PER_DAY = 100;
const MAX_REPORT_ROWS = 500;
const MAX_NOTE = 200;

export interface OutboundHostsEnv {
  DB?: D1Database;
  FLAGSHIP_ADMIN_SECRET?: string;
  USAGE_REPORT_SECRET?: string;
  /** "flagship.services" in production; the gym Worker sets "gym.flagship.services". */
  SERVICES_APEX?: string;
}

/** A lower-case public DNS name the hub could dial on 443, or null. Never an IP literal or one of our own names. */
export function normalizeOutboundHost(raw: unknown, servicesApex?: string): string | null {
  if (typeof raw !== "string") return null;
  const h = raw.trim().toLowerCase().replace(/\.$/, "");
  if (h.length < 4 || h.length > 253) return null;
  const labels = h.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null;
  if (/^\d+$/.test(labels[labels.length - 1]!)) return null;
  if (/\.(local|internal|localhost|invalid|test|example|lan|home|corp)$/.test(h)) return null;
  // The gym's scripted AI provider sits under the gym apex; production never allows it, and no
  // other name under either apex is let through.
  const gymStub = !!servicesApex && servicesApex !== "flagship.services" && h.startsWith("aistub.") && h.endsWith(`.${servicesApex}`);
  if (!gymStub && (h === "flagship.services" || h.endsWith(".flagship.services"))) return null;
  if (h === "flagshipserver.com" || h.endsWith(".flagshipserver.com")) return null;
  return h;
}

const today = (now: Date) => now.toISOString().slice(0, 10);

export async function checkOutboundHost(
  db: D1Database,
  host: string,
  now: Date = new Date(),
): Promise<{ allowed: boolean; reason?: string }> {
  const row = await db.prepare("SELECT status FROM outbound_hosts WHERE host = ?").bind(host).first<{ status: string }>();
  if (row) return row.status === "blocked" ? { allowed: false, reason: "blocked" } : { allowed: true };
  const day = today(now);
  const fresh = await db
    .prepare("SELECT COUNT(*) AS n FROM outbound_hosts WHERE first_seen_day = ?")
    .bind(day)
    .first<{ n: number }>();
  if ((fresh?.n ?? 0) >= NEW_HOSTS_PER_DAY) return { allowed: false, reason: "new-host-cap" };
  await db.prepare("INSERT OR IGNORE INTO outbound_hosts (host, status, first_seen_day) VALUES (?, 'allowed', ?)").bind(host, day).run();
  return { allowed: true };
}

export interface OutboundReportRow {
  host: string;
  streams: number;
  up: number;
  down: number;
  refused: number;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 2 ** 50) : 0);

export function parseReportRows(body: unknown, servicesApex?: string): OutboundReportRow[] | null {
  const rows = (body as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows) || rows.length > MAX_REPORT_ROWS) return null;
  const out: OutboundReportRow[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const host = normalizeOutboundHost(r?.host, servicesApex);
    if (!host) continue;
    out.push({ host, streams: count(r.streams), up: count(r.up), down: count(r.down), refused: count(r.refused) });
  }
  return out;
}

export async function recordOutboundReport(db: D1Database, rows: readonly OutboundReportRow[], now: Date = new Date()): Promise<void> {
  if (rows.length === 0) return;
  const day = today(now);
  const stmts = rows.flatMap((r) => [
    db.prepare("INSERT OR IGNORE INTO outbound_hosts (host, status, first_seen_day) VALUES (?, 'allowed', ?)").bind(r.host, day),
    db
      .prepare(
        "INSERT INTO outbound_host_daily (day, host, streams, bytes_up, bytes_down, refused) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(day, host) DO UPDATE SET streams = streams + excluded.streams, bytes_up = bytes_up + excluded.bytes_up, " +
          "bytes_down = bytes_down + excluded.bytes_down, refused = refused + excluded.refused",
      )
      .bind(day, r.host, r.streams, r.up, r.down, r.refused),
  ]);
  await db.batch(stmts);
}

export interface OutboundHostLine {
  host: string;
  status: "allowed" | "blocked";
  firstSeenDay: string;
  note: string;
  streams: number;
  bytesUp: number;
  bytesDown: number;
  refused: number;
}

export async function readOutboundHosts(db: D1Database, days: number, now: Date = new Date()): Promise<OutboundHostLine[]> {
  const since = today(new Date(now.getTime() - (days - 1) * 86_400_000));
  const r = await db
    .prepare(
      "SELECT h.host AS host, h.status AS status, h.first_seen_day AS firstSeenDay, h.note AS note, " +
        "COALESCE(SUM(d.streams), 0) AS streams, COALESCE(SUM(d.bytes_up), 0) AS bytesUp, " +
        "COALESCE(SUM(d.bytes_down), 0) AS bytesDown, COALESCE(SUM(d.refused), 0) AS refused " +
        "FROM outbound_hosts h LEFT JOIN outbound_host_daily d ON d.host = h.host AND d.day >= ? " +
        "GROUP BY h.host ORDER BY (COALESCE(SUM(d.bytes_up), 0) + COALESCE(SUM(d.bytes_down), 0)) DESC, h.host",
    )
    .bind(since)
    .all<OutboundHostLine>();
  return r.results;
}

export async function setOutboundHostStatus(
  db: D1Database,
  host: string,
  status: "allowed" | "blocked",
  note: string,
  now: Date = new Date(),
): Promise<void> {
  const day = today(now);
  await db
    .prepare(
      "INSERT INTO outbound_hosts (host, status, first_seen_day, note, changed_day) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(host) DO UPDATE SET status = excluded.status, note = excluded.note, changed_day = excluded.changed_day",
    )
    .bind(host, status, day, note.slice(0, MAX_NOTE), day)
    .run();
}

/** Daily rows older than this are dropped by the cron (a month is plenty for a complaint). */
export const OUTBOUND_DAILY_RETENTION_DAYS = 60;

export async function pruneOutboundDaily(db: D1Database, now: Date): Promise<void> {
  const cutoff = today(new Date(now.getTime() - OUTBOUND_DAILY_RETENTION_DAYS * 86_400_000));
  await db.prepare("DELETE FROM outbound_host_daily WHERE day < ?").bind(cutoff).run();
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function handleOutboundHosts(request: Request, env: OutboundHostsEnv): Promise<Response> {
  const path = new URL(request.url).pathname;
  const isHub = path === OUTBOUND_CHECK_PATH || path === OUTBOUND_REPORT_PATH;
  if (isHub) {
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    const secret = env.USAGE_REPORT_SECRET;
    if (!secret) return json({ error: "outbound hosts are off (USAGE_REPORT_SECRET missing)" }, 503);
    const given = request.headers.get("x-usage-secret") ?? "";
    if (!given || !constantTimeEqual(given, secret)) return json({ error: "forbidden" }, 403);
  } else {
    const auth = authorizeAdmin({ expected: env.FLAGSHIP_ADMIN_SECRET, provided: request.headers.get("x-admin-secret") });
    if (auth) return json(auth.body, auth.status);
  }
  if (!env.DB) return json({ error: "database unavailable" }, 503);

  if (path === OUTBOUND_CHECK_PATH) {
    const body = (await request.json().catch(() => null)) as { host?: unknown } | null;
    const host = normalizeOutboundHost(body?.host, env.SERVICES_APEX);
    if (!host) return json({ allowed: false, reason: "bad-host" }, 200);
    return json(await checkOutboundHost(env.DB, host), 200);
  }
  if (path === OUTBOUND_REPORT_PATH) {
    const rows = parseReportRows(await request.json().catch(() => null), env.SERVICES_APEX);
    if (!rows) return json({ error: "bad report" }, 400);
    await recordOutboundReport(env.DB, rows);
    return json({ ok: true, rows: rows.length }, 200);
  }
  if (request.method === "GET") {
    const asked = Number(new URL(request.url).searchParams.get("days") ?? "1");
    const days = Number.isInteger(asked) && asked >= 1 ? Math.min(asked, OUTBOUND_DAILY_RETENTION_DAYS) : 1;
    return json({ days, hosts: await readOutboundHosts(env.DB, days) }, 200);
  }
  if (request.method === "POST") {
    const body = (await request.json().catch(() => null)) as { host?: unknown; status?: unknown; note?: unknown } | null;
    const host = normalizeOutboundHost(body?.host, env.SERVICES_APEX);
    if (!host) return json({ error: "host must be a public DNS name" }, 400);
    if (body?.status !== "allowed" && body?.status !== "blocked") return json({ error: "status must be allowed or blocked" }, 400);
    await setOutboundHostStatus(env.DB, host, body.status, typeof body.note === "string" ? body.note : "");
    return json({ ok: true, host, status: body.status }, 200);
  }
  return json({ error: "method not allowed" }, 405);
}

export const isOutboundHostsPath = (p: string): boolean => p === OUTBOUND_CHECK_PATH || p === OUTBOUND_REPORT_PATH || p === OUTBOUND_ADMIN_PATH;
