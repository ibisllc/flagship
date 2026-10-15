#!/usr/bin/env node
/**
 * rate-limit-report — who is running into `.com`'s rate limits, so the
 * numbers in apps/com/src/rateLimit.ts can be tuned. Reads
 * GET /api/admin/rate-limits (apps/com/src/rateLimitReport.ts).
 *
 *   npm run rate-limits                 last 7 days, active budgets only
 *   npm run rate-limits -- --days 30    up to 90
 *   npm run rate-limits -- --all        every budget, quiet ones too
 *   npm run rate-limits -- --daily      a line per day under each budget
 *   npm run rate-limits -- --json       the raw report
 *
 * Columns: refused = requests turned away; sources = distinct callers
 * refused; near = passes that took a window to 80% of its budget (its last
 * slot under 5); down = checks that found the counter unreachable.
 * Nothing in the report identifies a caller.
 *
 * Env: FLAGSHIP_ADMIN_SECRET (required), FLAGSHIP_BASE_URL (default
 * https://flagshipserver.com).
 */

import { fileURLToPath } from "node:url";

export function parseArgs(argv) {
  const opts = { days: 7, all: false, daily: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") opts.days = Number(argv[++i]);
    else if (a === "--all") opts.all = true;
    else if (a === "--daily") opts.daily = true;
    else if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > 90) {
    throw new Error("--days takes a whole number from 1 to 90");
  }
  return opts;
}

export function formatWindow(sec) {
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}min`;
  return `${sec}s`;
}

const AXIS = { ip: "IP", irk: "account key", usernameHash: "username", counter: "counter" };

export function formatRules(rules) {
  return rules.map((r) => `${r.limit}/${formatWindow(r.windowSec)} per ${AXIS[r.axis] ?? r.axis}`).join(", ");
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function lpad(s, n) {
  s = String(s);
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

export function formatReport(report, { all = false, daily = false } = {}) {
  const active = report.endpoints.filter((e) => e.refused || e.near || e.unreachable);
  const shown = all ? report.endpoints : active;
  const lines = [];
  const scale = report.scale !== 1 ? ` (limits ×${report.scale})` : "";
  lines.push(`Rate limits, last ${report.days} day${report.days === 1 ? "" : "s"} (since ${report.since} UTC)${scale}`);
  lines.push("");
  if (shown.length === 0) {
    lines.push("Nobody was refused or came close to a limit.");
    return lines.join("\n");
  }
  const w = Math.max(...shown.map((e) => e.endpoint.length), 8);
  lines.push(`${pad("endpoint", w)}  ${lpad("refused", 7)}  ${lpad("sources", 7)}  ${lpad("near", 5)}  ${lpad("down", 4)}  limits`);
  for (const e of shown) {
    lines.push(
      `${pad(e.endpoint, w)}  ${lpad(e.refused, 7)}  ${lpad(e.sources, 7)}  ${lpad(e.near, 5)}  ${lpad(e.unreachable, 4)}  ${formatRules(e.rules)}`,
    );
    const axes = Object.entries(e.byAxis ?? {}).filter(([axis]) => axis !== "counter");
    if (axes.length > 1) {
      for (const [axis, c] of axes) {
        lines.push(`${pad(`  by ${AXIS[axis] ?? axis}`, w)}  ${lpad(c.refused, 7)}  ${lpad(c.sources, 7)}  ${lpad(c.near, 5)}`);
      }
    }
    if (daily) {
      for (const d of e.daily ?? []) {
        lines.push(`${pad(`  ${d.day}`, w)}  ${lpad(d.refused, 7)}  ${lpad(d.sources, 7)}  ${lpad(d.near, 5)}  ${lpad(d.unreachable, 4)}`);
      }
    }
  }
  if (!all && report.endpoints.length > active.length) {
    lines.push("");
    lines.push(`${report.endpoints.length - active.length} other budgets were quiet (--all lists them).`);
  }
  const hints = [];
  for (const e of active) {
    if (e.sources >= 3) hints.push(`${e.endpoint}: ${e.sources} different callers were refused. Real people, or one abuser on many addresses?`);
    else if (e.near >= 10 && e.refused === 0) hints.push(`${e.endpoint}: ${e.near} passes came close but none was refused. The limit has little headroom.`);
    if (e.unreachable > 0) hints.push(`${e.endpoint}: the counter was unreachable ${e.unreachable} time(s). Check Durable Object errors.`);
  }
  if (hints.length > 0) {
    lines.push("");
    lines.push("Worth a look:");
    for (const h of hints) lines.push(`  - ${h}`);
  }
  return lines.join("\n");
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (opts.help) {
    console.log("usage: npm run rate-limits -- [--days N] [--all] [--daily] [--json]");
    return;
  }
  const secret = process.env.FLAGSHIP_ADMIN_SECRET;
  if (!secret) {
    console.error("FLAGSHIP_ADMIN_SECRET is not set.");
    process.exit(2);
  }
  const base = (process.env.FLAGSHIP_BASE_URL ?? "https://flagshipserver.com").replace(/\/$/, "");
  const res = await fetch(`${base}/api/admin/rate-limits?days=${opts.days}`, {
    headers: { "x-admin-secret": secret },
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`${res.status} from ${base}: ${text.slice(0, 200)}`);
    process.exit(res.status === 401 || res.status === 403 ? 2 : 1);
  }
  const report = JSON.parse(text);
  console.log(opts.json ? JSON.stringify(report, null, 2) : formatReport(report, opts));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
