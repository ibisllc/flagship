#!/usr/bin/env tsx
/**
 * canary: how each release is doing in the boxes that took it, and whether its rollout may widen
 * (docs/runbooks/canary.md). Reads the content-free update receipts `.com` counts
 * (GET /api/admin/canary, apps/com/src/updateReceipts.ts) and the published catalog
 * (<base>/build/iso/catalog-targets.json, for each release's current rollout percent).
 *
 *   npm run canary                                every release with receipts in the last 30 days
 *   npm run canary -- --release <commit>          one release, with its cohorts, profiles and days
 *   npm run canary -- --release <c> --opened-at 2026-10-24T09:00:00Z
 *                                                 ... and the verdict: stop, hold, wait, widen or complete
 *   npm run canary -- --days 90 | --json | --min-receipts 3 --min-hours 48 --stop-rollbacks 2
 *
 * Columns: passed = the health gate passed and the box kept the release; rolled back = the gate failed
 * and the box went back on its own; stuck = the gate failed and the box could NOT go back (the release
 * before is below the security floor; it waits in restricted recovery). Receipts come only from boxes
 * whose owners agreed to share update results, and they are anonymous: read the denominators.
 *
 * The verdict never acts. To stop, an operator signs a catalog with the release lowered or removed:
 *   npx tsx tools/release-catalog/catalog.ts rollout --commit <c> --percent 0 ... (the runbook has the line)
 *
 * Env: FLAGSHIP_ADMIN_SECRET (required), FLAGSHIP_BASE_URL (default https://flagshipserver.com).
 */
import { fileURLToPath } from "node:url";
import {
  canaryVerdict,
  DEFAULT_CANARY_POLICY,
  totalReceipts,
  type CanaryPolicy,
  type CanaryVerdict,
  type OutcomeCounts,
} from "../packages/protocol/src/index.js";

export interface Options {
  days: number;
  release?: string;
  openedAt?: number;
  json: boolean;
  policy: CanaryPolicy;
  help?: boolean;
}

export function parseArgs(argv: string[]): Options {
  const o: Options = { days: 30, json: false, policy: { ...DEFAULT_CANARY_POLICY } };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--days") o.days = Number(val());
    else if (a === "--release") o.release = val().toLowerCase();
    else if (a === "--opened-at") o.openedAt = Date.parse(val());
    else if (a === "--json") o.json = true;
    else if (a === "--min-receipts") o.policy.minReceipts = Number(val());
    else if (a === "--min-hours") o.policy.minHours = Number(val());
    else if (a === "--stop-rollbacks") o.policy.stopRollbacks = Number(val());
    else if (a === "-h" || a === "--help") o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(o.days) || o.days < 1 || o.days > 400) throw new Error("--days takes a whole number from 1 to 400");
  if (o.release !== undefined && !/^[0-9a-f]{40}$/.test(o.release)) throw new Error("--release takes a 40-hex commit");
  if (o.openedAt !== undefined && !Number.isFinite(o.openedAt)) throw new Error("--opened-at takes an ISO time");
  for (const [k, v] of Object.entries(o.policy)) if (!Number.isFinite(v) || v < 0) throw new Error(`bad --${k}`);
  return o;
}

export interface ReleaseCounts {
  release: string;
  totals: OutcomeCounts;
  byCohort: Record<string, OutcomeCounts>;
  byProfile: Record<string, OutcomeCounts>;
  daily: ({ day: string } & OutcomeCounts)[];
  firstDay: string;
  lastDay: string;
}

export interface CatalogRelease {
  commit: string;
  label: string;
  securityVersion: number;
  rolloutPercent: number;
}

export interface Row {
  release: string;
  label: string | null;
  percent: number | null;
  counts: ReleaseCounts | null;
  verdict: CanaryVerdict;
}

/** One row per release in the catalog or with receipts. */
export function buildRows(counts: ReleaseCounts[], catalog: CatalogRelease[] | null, o: Pick<Options, "release" | "openedAt" | "policy">, now: number): Row[] {
  const commits = new Set<string>([...counts.map((c) => c.release), ...(catalog ?? []).map((r) => r.commit)]);
  const rows: Row[] = [];
  for (const commit of commits) {
    if (o.release && commit !== o.release) continue;
    const c = counts.find((x) => x.release === commit) ?? null;
    const cat = catalog?.find((r) => r.commit === commit) ?? null;
    const percent = cat ? cat.rolloutPercent : null;
    const totals = c?.totals ?? { passed: 0, rolledBack: 0, stuck: 0 };
    const verdict =
      percent === null
        ? { action: "wait" as const, reason: "not in the published catalog (removed, or the catalog was not reachable)" }
        : canaryVerdict({ percent, openedAt: o.release === commit ? (o.openedAt ?? null) : null, now, totals, byProfile: c?.byProfile ?? {}, policy: o.policy });
    rows.push({ release: commit, label: cat?.label ?? null, percent, counts: c, verdict });
  }
  return rows.sort((a, b) => (b.counts?.lastDay ?? "").localeCompare(a.counts?.lastDay ?? "") || a.release.localeCompare(b.release));
}

const pct = (n: number, d: number) => (d === 0 ? "-" : `${((100 * n) / d).toFixed(1)}%`);
const line = (name: string, c: OutcomeCounts) => {
  const n = totalReceipts(c);
  return `${name.padEnd(18)} ${String(n).padStart(6)} ${String(c.passed).padStart(7)} ${String(c.rolledBack).padStart(12)} ${String(c.stuck).padStart(6)}  ${pct(c.rolledBack + c.stuck, n)} failed`;
};

export function formatRows(rows: Row[], days: number, detail: boolean): string {
  const out: string[] = [`Update receipts, last ${days} days (only boxes whose owners share them)`, ""];
  if (rows.length === 0) return [...out, "No release has receipts or a catalog entry."].join("\n");
  for (const r of rows) {
    out.push(`${r.release.slice(0, 12)}${r.label ? ` (${r.label})` : ""}  rollout ${r.percent === null ? "?" : `${r.percent}%`}`);
    out.push(`${"".padEnd(18)} ${"boxes".padStart(6)} ${"passed".padStart(7)} ${"rolled back".padStart(12)} ${"stuck".padStart(6)}`);
    out.push(line("  all", r.counts?.totals ?? { passed: 0, rolledBack: 0, stuck: 0 }));
    if (detail && r.counts) {
      for (const [k, c] of Object.entries(r.counts.byCohort).sort((a, b) => Number(a[0]) - Number(b[0]))) out.push(line(`  cohort ${k}%`, c));
      for (const [k, c] of Object.entries(r.counts.byProfile).sort()) out.push(line(`  ${k}`, c));
      for (const d of r.counts.daily) out.push(line(`  ${d.day}`, d));
    }
    out.push(`  verdict: ${r.verdict.action}${r.verdict.next ? ` to ${r.verdict.next}%` : ""}: ${r.verdict.reason}`);
    if (r.verdict.action === "stop") {
      out.push(`  stop it: npx tsx tools/release-catalog/catalog.ts rollout --root release/catalog-root.json --list release/catalog-releases.json --commit ${r.release} --percent 0 --key <offline>/catalog-root-1.key.json --timestamp-key <offline>/catalog-timestamp-1.key.json --previous-targets <served targets> --previous-timestamp <served timestamp> --out-dir <out>`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd();
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T | null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch (e) {
    if (headers["x-admin-secret"]) throw e;
    return null;
  }
}

async function main(): Promise<void> {
  let o: Options;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  if (o.help) {
    console.log("usage: npm run canary -- [--release <commit>] [--opened-at <iso>] [--days N] [--json] [--min-receipts N] [--min-hours N] [--stop-rollbacks N]");
    return;
  }
  const secret = process.env.FLAGSHIP_ADMIN_SECRET;
  if (!secret) {
    console.error("FLAGSHIP_ADMIN_SECRET is required");
    process.exit(1);
  }
  const base = (process.env.FLAGSHIP_BASE_URL ?? "https://flagshipserver.com").replace(/\/+$/, "");
  const q = new URLSearchParams({ days: String(o.days), ...(o.release ? { release: o.release } : {}) });
  const report = await getJson<{ releases: ReleaseCounts[] }>(`${base}/api/admin/canary?${q}`, { "x-admin-secret": secret });
  const targets = await getJson<{ signed: { releases: CatalogRelease[] } }>(`${base}/build/iso/catalog-targets.json`);
  const rows = buildRows(report?.releases ?? [], targets?.signed.releases ?? null, o, Date.now());
  if (o.json) console.log(JSON.stringify({ days: o.days, catalog: targets !== null, rows }, null, 2));
  else {
    if (!targets) console.log("(the published catalog was not reachable: rollout percents unknown)\n");
    console.log(formatRows(rows, o.days, o.release !== undefined));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
