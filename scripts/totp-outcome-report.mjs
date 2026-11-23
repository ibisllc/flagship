#!/usr/bin/env node
/**
 * totp-outcome-report — how code protection (TOTP) enrolment calls ended on
 * `.com`, so a failure like security report F2 can be told apart without
 * Worker logs. Reads GET /api/admin/totp-outcomes (apps/com/src/totpOutcomeLog.ts).
 *
 *   npm run totp-outcomes                 last 7 days
 *   npm run totp-outcomes -- --days 30    up to 90
 *   npm run totp-outcomes -- --daily      a line per day and outcome
 *   npm run totp-outcomes -- --json       the raw report
 *
 * Outcomes: ok, a refusal's code (totp-admin-only, stale-request, …) or
 * internal-error. Nothing in the report identifies a caller or an account.
 *
 * Env: FLAGSHIP_ADMIN_SECRET (required), FLAGSHIP_BASE_URL (default
 * https://flagshipserver.com).
 */

import { fileURLToPath } from "node:url";

export function parseArgs(argv) {
  const opts = { days: 7, daily: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") opts.days = Number(argv[++i]);
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

export function formatReport(report, { daily = false } = {}) {
  const lines = [`Code protection calls, last ${report.days} day${report.days === 1 ? "" : "s"} (since ${report.since} UTC)`, ""];
  let any = false;
  for (const [endpoint, outcomes] of Object.entries(report.totals ?? {})) {
    const entries = Object.entries(outcomes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const total = entries.reduce((n, [, c]) => n + c, 0);
    lines.push(`${endpoint}: ${total === 0 ? "no calls" : `${total} call${total === 1 ? "" : "s"}`}`);
    for (const [outcome, count] of entries) {
      any = true;
      lines.push(`  ${String(count).padStart(6)}  ${outcome}`);
    }
    if (daily) {
      for (const row of (report.daily ?? []).filter((r) => r.endpoint === endpoint)) {
        lines.push(`  ${row.day}  ${String(row.count).padStart(6)}  ${row.outcome}`);
      }
    }
  }
  const internal = Object.values(report.totals ?? {}).reduce((n, o) => n + (o["internal-error"] ?? 0), 0);
  if (internal > 0) {
    lines.push("", `Worth a look: ${internal} internal error(s). The Worker logs one line per error with its request id.`);
  } else if (!any) {
    lines.push("", "Nobody tried to turn code protection on or off.");
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
    console.log("usage: npm run totp-outcomes -- [--days N] [--daily] [--json]");
    return;
  }
  const secret = process.env.FLAGSHIP_ADMIN_SECRET;
  if (!secret) {
    console.error("FLAGSHIP_ADMIN_SECRET is not set.");
    process.exit(2);
  }
  const base = (process.env.FLAGSHIP_BASE_URL ?? "https://flagshipserver.com").replace(/\/$/, "");
  const res = await fetch(`${base}/api/admin/totp-outcomes?days=${opts.days}`, { headers: { "x-admin-secret": secret } });
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
