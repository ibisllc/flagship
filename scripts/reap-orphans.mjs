#!/usr/bin/env node
/**
 * reap-orphans: removes the DNS records and demo servers that the pre-GA
 * scrub (docs/runbooks/pre-ga-scrub.md) leaves behind for accounts that no
 * longer exist. The tokens for Cloudflare DNS and UpCloud live only on the
 * `.com` Worker, so this talks to its admin routes
 * (apps/com/src/prodReap.ts). Run it AFTER the D1 scrub. It also trims
 * accounts that stay: records an account wildcard replaced (older per-box
 * A/AAAA, the CAA copy at *.<user>, iodef) and the records of an account with
 * no live server (docs/wildcard-dns.md).
 *
 *   node scripts/reap-orphans.mjs                      dry run: classify every
 *                                                      record and server, print
 *                                                      per-account counts, save a plan
 *   node scripts/reap-orphans.mjs --out plan.json      pick where the plan is saved
 *   node scripts/reap-orphans.mjs --show               also list each orphan
 *   node scripts/reap-orphans.mjs --apply --plan plan.json
 *                                                      delete ONLY the orphans in that
 *                                                      saved plan (typed confirmation,
 *                                                      terminal only)
 *
 * The dry run never writes. --apply refuses a plan older than 24 hours, asks
 * you to type the counts, then deletes one item at a time; the Worker
 * re-checks each against D1 right before deleting and refuses anything that
 * is no longer an orphan. A failed call (Cloudflare rate limit, network) is
 * retried after 30 seconds. Every outcome is appended to <plan>.log.jsonl.
 *
 * Env: FLAGSHIP_ADMIN_SECRET (required), FLAGSHIP_BASE_URL (default
 * https://flagshipserver.com).
 */

import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const PLAN_MAX_AGE_MS = 24 * 3600 * 1000;
export const RETRY_WAIT_MS = 30_000;
export const MAX_ATTEMPTS = 6;
const USERNAME_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const DNS_ID_RE = /^[0-9a-f]{32}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NEVER_ORPHAN = ["playstore-test-0725"];
const DNS_TYPES = new Set(["CAA", "A", "AAAA", "TXT"]);

export function parseArgs(argv) {
  const opts = { apply: false, show: false, json: false, plan: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") opts.apply = true;
    else if (a === "--show") opts.show = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--plan") opts.plan = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (opts.apply && !opts.plan) throw new Error("--apply needs --plan <file> (run the dry run first and review the plan)");
  if (!opts.apply && opts.plan) throw new Error("--plan is only used with --apply");
  if (opts.apply && opts.out) throw new Error("--out is only used for the dry run");
  return opts;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function lpad(s, n) {
  s = String(s);
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

export function formatPlan(plan, { show = false } = {}) {
  const s = plan.summary;
  const lines = [];
  lines.push(`Reap plan for ${plan.apex} (${plan.generatedAt})`);
  lines.push(`  accounts known to D1: ${plan.knownAccounts}; protected: ${plan.protectedAccounts.join(", ") || "none"}`);
  lines.push(`  DNS records: ${s.dnsTotal} in the zone, ${s.dnsKeep} kept, ${s.dnsOrphan} orphaned`);
  lines.push(
    plan.serversChecked
      ? `  UpCloud demo servers: ${s.serversTotal} found, ${s.serversKeep} kept, ${s.serversOrphan} orphaned`
      : "  UpCloud demo servers: NOT CHECKED (the Worker has no UPCLOUD_TOKEN)",
  );
  lines.push(`  zone after the reap: ${s.zoneRecordsAfter} of 200 records`);
  const orphans = plan.accounts.filter((a) => a.status === "orphan");
  lines.push("");
  if (orphans.length === 0) {
    lines.push(plan.accounts.some((a) => a.status === "trim") ? "No account to reap." : "Nothing to reap.");
  } else {
    lines.push(`${pad("account (gone from D1)", 28)}  ${lpad("records", 7)}  ${lpad("servers", 7)}`);
    for (const a of orphans) lines.push(`${pad(a.owner, 28)}  ${lpad(a.dnsOrphans, 7)}  ${lpad(a.serverOrphans, 7)}`);
  }
  const trims = plan.accounts.filter((a) => a.status === "trim");
  if (trims.length > 0) {
    lines.push("");
    lines.push(`${pad("account (stays; records to trim)", 32)}  ${lpad("records", 7)}  ${lpad("kept", 5)}`);
    for (const a of trims) lines.push(`${pad(a.owner, 32)}  ${lpad(a.dnsOrphans, 7)}  ${lpad(a.dnsKept, 5)}`);
  }
  const kept = plan.accounts.filter((a) => a.status === "kept");
  if (kept.length > 0) {
    lines.push("");
    lines.push(`Kept accounts with records: ${kept.map((a) => `${a.owner} (${a.dnsKept})`).join(", ")}`);
  }
  const unknown = plan.dns.filter((d) => !d.owner);
  lines.push("");
  lines.push(`Kept without an account (apex, system, gym, unrecognised): ${unknown.length} records`);
  if (show) {
    lines.push("");
    for (const d of plan.dns.filter((x) => x.action === "orphan")) lines.push(`  dns    ${pad(d.type, 5)} ${d.name}`);
    for (const v of plan.servers.filter((x) => x.action === "orphan")) lines.push(`  server ${v.serverId}  ${v.title} (${v.owner})`);
    lines.push("");
    lines.push("Unrecognised records (kept, worth a look):");
    for (const d of unknown.filter((x) => x.reason.startsWith("unrecognised") || x.reason.startsWith("not a record"))) {
      lines.push(`  ${pad(d.type, 5)} ${d.name}  (${d.reason})`);
    }
  }
  return lines.join("\n");
}

/** The orphans in a saved plan that pass the local rules; everything else is refused here before any call. */
export function selectOrphans(plan, now = Date.now()) {
  if (!plan || plan.version !== 1 || !Array.isArray(plan.dns) || !Array.isArray(plan.servers) || typeof plan.apex !== "string") {
    throw new Error("this is not a reap plan from this tool");
  }
  const age = now - Date.parse(plan.generatedAt);
  if (!Number.isFinite(age) || age < -60_000) throw new Error("the plan has no valid time");
  if (age > PLAN_MAX_AGE_MS) throw new Error("the plan is older than 24 hours: run the dry run again and review the new one");
  const apex = plan.apex.toLowerCase();
  const protectedNames = new Set([...NEVER_ORPHAN, ...(plan.protectedAccounts ?? [])]);
  const refused = [];
  const dns = [];
  const servers = [];
  for (const d of plan.dns) {
    if (d.action !== "orphan") continue;
    const name = String(d.name ?? "").toLowerCase();
    const labels = name.endsWith(`.${apex}`) ? name.slice(0, -(apex.length + 1)).split(".") : [];
    const ok =
      typeof d.id === "string" && DNS_ID_RE.test(d.id) &&
      labels.length >= 1 && labels.length <= 3 &&
      d.owner && USERNAME_RE.test(d.owner) && !protectedNames.has(d.owner) &&
      labels[labels.length - 1] === d.owner &&
      DNS_TYPES.has(String(d.type).toUpperCase());
    if (ok) dns.push({ kind: "dns", id: d.id, name: d.name, type: d.type, owner: d.owner });
    else refused.push(`dns ${d.type} ${d.name}`);
  }
  for (const v of plan.servers) {
    if (v.action !== "orphan") continue;
    const ok = typeof v.serverId === "string" && UUID_RE.test(v.serverId) && v.owner && USERNAME_RE.test(v.owner) && !protectedNames.has(v.owner);
    if (ok) servers.push({ kind: "server", id: v.serverId, owner: v.owner, name: v.title });
    else refused.push(`server ${v.serverId}`);
  }
  return { dns, servers, refused };
}

export function confirmationPhrase(sel) {
  return `delete ${sel.dns.length} records and ${sel.servers.length} servers`;
}

/**
 * Deletes the selection one item at a time through `post(body)`, which
 * returns {status, body} or throws on a network error. Returns the outcomes.
 */
export async function applyPlan(sel, { post, sleep, log, retryWaitMs = RETRY_WAIT_MS, maxAttempts = MAX_ATTEMPTS, pauseMs = 300 }) {
  const out = { deleted: 0, gone: 0, skipped: 0, failed: 0, aborted: null };
  const items = [...sel.servers, ...sel.dns];
  for (const item of items) {
    const body = item.kind === "dns"
      ? { kind: "dns", id: item.id, name: item.name, type: item.type }
      : { kind: "server", id: item.id, owner: item.owner };
    const label = item.kind === "dns" ? `dns ${item.type} ${item.name}` : `server ${item.id} (${item.owner})`;
    let done = false;
    for (let attempt = 1; attempt <= maxAttempts && !done; attempt++) {
      let res;
      try {
        res = await post(body);
      } catch (e) {
        res = { status: 0, body: { error: e instanceof Error ? e.message : String(e) } };
      }
      const { status } = res;
      if (status === 200) {
        const result = res.body?.result === "gone" ? "gone" : "deleted";
        out[result] += 1;
        log({ event: result, ...item });
        done = true;
      } else if (status === 409) {
        out.skipped += 1;
        log({ event: "refused", ...item, code: res.body?.code, reason: res.body?.reason ?? res.body?.error });
        done = true;
      } else if (status === 401 || status === 403 || status === 400 || status === 404 || status === 405 || status === 503) {
        out.aborted = `${label}: ${status} ${String(res.body?.error ?? "").slice(0, 160)}`;
        log({ event: "abort", ...item, status, error: res.body?.error });
        return out;
      } else if (attempt === maxAttempts) {
        out.failed += 1;
        log({ event: "failed", ...item, status, error: String(res.body?.error ?? "").slice(0, 160) });
        done = true;
      } else {
        log({ event: "retry", ...item, status, attempt, waitMs: retryWaitMs, error: String(res.body?.error ?? "").slice(0, 160) });
        await sleep(retryWaitMs);
      }
    }
    await sleep(pauseMs);
  }
  return out;
}

function stamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, "-");
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((res) => rl.question(question, res));
  } finally {
    rl.close();
  }
}

async function api(base, secret, method, path, body) {
  const res = await fetch(`${base}/api/admin/reap/${path}`, {
    method,
    headers: { "x-admin-secret": secret, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { error: text.slice(0, 200) };
  }
  return { status: res.status, body: parsed };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (opts.help) {
    console.log("usage: node scripts/reap-orphans.mjs [--out plan.json] [--show] [--json]\n       node scripts/reap-orphans.mjs --apply --plan plan.json");
    return;
  }
  const secret = process.env.FLAGSHIP_ADMIN_SECRET;
  if (!secret) {
    console.error("FLAGSHIP_ADMIN_SECRET is not set.");
    process.exit(2);
  }
  const base = (process.env.FLAGSHIP_BASE_URL ?? "https://flagshipserver.com").replace(/\/$/, "");

  if (!opts.apply) {
    const r = await api(base, secret, "GET", "classify");
    if (r.status !== 200) {
      console.error(`${r.status} from ${base}: ${r.body?.error ?? "unexpected answer"}`);
      process.exit(r.status === 401 || r.status === 403 ? 2 : 1);
    }
    const out = resolve(opts.out ?? join(homedir(), `flagship-reap-plan-${stamp()}.json`));
    writeFileSync(out, JSON.stringify(r.body, null, 2), { mode: 0o600 });
    try { chmodSync(out, 0o600); } catch { /* best effort */ }
    console.log(opts.json ? JSON.stringify(r.body, null, 2) : formatPlan(r.body, opts));
    console.log(`\nPlan saved to ${out}. Nothing was deleted.`);
    console.log(`To delete exactly what it lists: node scripts/reap-orphans.mjs --apply --plan ${out}`);
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("--apply needs a real terminal (stdin and stdout). Refusing.");
    process.exit(2);
  }
  const planPath = resolve(opts.plan);
  if (!existsSync(planPath)) {
    console.error(`no such plan: ${planPath}`);
    process.exit(2);
  }
  let sel;
  let plan;
  try {
    plan = JSON.parse(readFileSync(planPath, "utf8"));
    sel = selectOrphans(plan);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  console.log(formatPlan(plan));
  if (sel.refused.length > 0) {
    console.error(`\nRefusing ${sel.refused.length} plan entr${sel.refused.length === 1 ? "y" : "ies"} that fail the local rules:`);
    for (const r of sel.refused) console.error(`  ${r}`);
  }
  if (sel.dns.length + sel.servers.length === 0) {
    console.log("\nNothing to delete.");
    return;
  }
  const phrase = confirmationPhrase(sel);
  console.log(`\nThis deletes ${sel.dns.length} DNS records and ${sel.servers.length} servers on ${base}. It cannot be undone.`);
  const typed = (await ask(`Type "${phrase}" to go on: `)).trim();
  if (typed !== phrase) {
    console.error("Not confirmed. Nothing was deleted.");
    process.exit(2);
  }
  const logPath = `${planPath}.log.jsonl`;
  const log = (entry) => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    appendFileSync(logPath, `${line}\n`, { mode: 0o600 });
    if (entry.event === "retry") console.log(`  retry in ${entry.waitMs / 1000}s: ${entry.kind} ${entry.name ?? entry.id} (${entry.status} ${entry.error ?? ""})`);
    else console.log(`  ${pad(entry.event, 8)} ${entry.kind} ${entry.type ?? ""} ${entry.name ?? entry.id}${entry.reason ? `  (${entry.reason})` : ""}`);
  };
  const result = await applyPlan(sel, {
    post: (body) => api(base, secret, "POST", "delete-one", body),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
  });
  console.log(`\ndeleted ${result.deleted}, already gone ${result.gone}, refused by the re-check ${result.skipped}, failed ${result.failed}`);
  if (result.aborted) console.error(`stopped: ${result.aborted}`);
  const after = await api(base, secret, "GET", "classify");
  if (after.status === 200) {
    console.log(`left: ${after.body.summary.dnsOrphan} orphaned records, ${after.body.summary.serversOrphan} orphaned servers; zone is at ${after.body.zoneRecords} of 200 records`);
  }
  console.log(`log: ${logPath}`);
  process.exit(result.aborted || result.failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
