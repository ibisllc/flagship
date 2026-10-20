#!/usr/bin/env node
/**
 * outbound-hosts — where boxes' AI calls leave through the hub, and a switch to stop one
 * (docs/outbound-hosts.md). Reads and writes /api/admin/outbound-hosts
 * (apps/com/src/outboundHosts.ts).
 *
 *   npm run outbound-hosts                       last day, every host, busiest first
 *   npm run outbound-hosts -- --days 7           up to 60
 *   npm run outbound-hosts -- --new              only hosts first seen in the window
 *   npm run outbound-hosts -- --blocked          only blocked hosts
 *   npm run outbound-hosts -- --json             the raw answer
 *   npm run outbound-hosts -- block <host> [note...]   refuse a host (a complaint, odd traffic)
 *   npm run outbound-hosts -- allow <host> [note...]   let it back
 *
 * Columns: streams = connections opened, up/down = bytes to and from the host, refused = opens
 * turned away. The hub reports totals across every box: nothing here, or in the database,
 * says which account or box a call came from.
 *
 * Env: FLAGSHIP_ADMIN_SECRET (required), FLAGSHIP_BASE_URL (default https://flagshipserver.com).
 */

import { fileURLToPath } from "node:url";

export function parseArgs(argv) {
  const opts = { days: 1, newOnly: false, blockedOnly: false, json: false, action: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") opts.days = Number(argv[++i]);
    else if (a === "--new") opts.newOnly = true;
    else if (a === "--blocked") opts.blockedOnly = true;
    else if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a.startsWith("--")) throw new Error(`unknown argument: ${a}`);
    else rest.push(a);
  }
  if (!Number.isInteger(opts.days) || opts.days < 1 || opts.days > 60) throw new Error("--days takes a whole number from 1 to 60");
  if (rest.length > 0) {
    const [verb, host, ...note] = rest;
    if ((verb !== "block" && verb !== "allow") || !host) throw new Error("expected: block <host> [note] | allow <host> [note]");
    opts.action = { status: verb === "block" ? "blocked" : "allowed", host, note: note.join(" ") };
  }
  return opts;
}

export function bytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`;
}

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

export function formatHosts(answer, { newOnly = false, blockedOnly = false } = {}, now = new Date()) {
  const since = new Date(now.getTime() - (answer.days - 1) * 86_400_000).toISOString().slice(0, 10);
  const isNew = (h) => h.firstSeenDay !== "seed" && h.firstSeenDay >= since;
  let hosts = answer.hosts;
  if (newOnly) hosts = hosts.filter(isNew);
  if (blockedOnly) hosts = hosts.filter((h) => h.status === "blocked");
  const lines = [`Outbound hosts, last ${answer.days} day${answer.days === 1 ? "" : "s"} (since ${since} UTC)`, ""];
  if (hosts.length === 0) {
    lines.push("No hosts to show.");
    return lines.join("\n");
  }
  const w = Math.max(...hosts.map((h) => h.host.length), 4);
  lines.push(`${pad("host", w)}  ${pad("status", 7)}  ${pad("first seen", 10)}  ${lpad("streams", 7)}  ${lpad("up", 9)}  ${lpad("down", 9)}  ${lpad("refused", 7)}  note`);
  for (const h of hosts) {
    lines.push(
      `${pad(h.host, w)}  ${pad(h.status, 7)}  ${pad(h.firstSeenDay, 10)}  ${lpad(h.streams, 7)}  ${lpad(bytes(h.bytesUp), 9)}  ${lpad(bytes(h.bytesDown), 9)}  ${lpad(h.refused, 7)}  ${h.note}`,
    );
  }
  const hints = [];
  const fresh = answer.hosts.filter((h) => isNew(h) && h.status === "allowed");
  if (fresh.length > 0) hints.push(`${fresh.length} host(s) are new in this window: ${fresh.slice(0, 5).map((h) => h.host).join(", ")}${fresh.length > 5 ? ", ..." : ""}. Anything that is not an AI provider?`);
  const heavy = answer.hosts.filter((h) => h.status === "allowed" && h.bytesUp > 1024 ** 3);
  for (const h of heavy) hints.push(`${h.host} took ${bytes(h.bytesUp)} UPLOADED in this window. AI calls are mostly download; this one sends a lot.`);
  const odd = answer.hosts.filter((h) => h.status === "allowed" && h.streams > 0 && !/^(api|router|generativelanguage|openrouter)\b/.test(h.host) && h.firstSeenDay !== "seed");
  if (odd.length > 0 && fresh.length === 0) hints.push(`${odd.length} allowed host(s) do not look like API hosts: ${odd.slice(0, 5).map((h) => h.host).join(", ")}.`);
  if (hints.length > 0) {
    lines.push("", "Worth a look (block one with: npm run outbound-hosts -- block <host> <why>):");
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
    console.log("usage: npm run outbound-hosts -- [--days N] [--new] [--blocked] [--json] | block <host> [note] | allow <host> [note]");
    return;
  }
  const secret = process.env.FLAGSHIP_ADMIN_SECRET;
  if (!secret) {
    console.error("FLAGSHIP_ADMIN_SECRET is not set.");
    process.exit(2);
  }
  const base = (process.env.FLAGSHIP_BASE_URL ?? "https://flagshipserver.com").replace(/\/$/, "");
  const url = `${base}/api/admin/outbound-hosts`;
  const res = opts.action
    ? await fetch(url, { method: "POST", headers: { "x-admin-secret": secret, "content-type": "application/json" }, body: JSON.stringify(opts.action) })
    : await fetch(`${url}?days=${opts.days}`, { headers: { "x-admin-secret": secret } });
  const text = await res.text();
  if (!res.ok) {
    console.error(`${res.status} from ${base}: ${text.slice(0, 200)}`);
    process.exit(res.status === 401 || res.status === 403 ? 2 : 1);
  }
  const answer = JSON.parse(text);
  if (opts.action) {
    console.log(`${answer.host} is now ${answer.status}. The hub notices within about 2 minutes.`);
    return;
  }
  console.log(opts.json ? JSON.stringify(answer, null, 2) : formatHosts(answer, opts));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
