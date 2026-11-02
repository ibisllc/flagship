#!/usr/bin/env tsx
/**
 * ops: one command to see whether the control plane and the relay are healthy, and where it
 * is slow or failing. A stand-in for a dashboard (docs/ops-command.md).
 *
 *   npm run ops                       health + relay counters + Worker timings (what it can reach)
 *   npm run ops -- health             .com and .services answer? how fast?
 *   npm run ops -- services           the relay's counters since it started: routed, waited, dropped
 *                                     (missed redirections) and the last names that missed
 *   npm run ops -- workers [--hours 24] [--script flagship-com]
 *                                     Cloudflare's own numbers: requests, errors, CPU time p50/p99
 *                                     and every outcome, including exceededCpu (the 10 ms Free limit)
 *   npm run ops -- slow [--seconds 60]
 *                                     live: tail the Worker and show CPU per route, worst first
 *   npm run ops -- dns                a random name under flagship.services must answer with the relay's
 *                                     addresses on public resolvers: no NODATA or NXDOMAIN (needs nothing)
 *   npm run ops -- limits             who is hitting a rate limit (npm run rate-limits)
 *   npm run ops -- outbound           where boxes' AI calls leave (npm run outbound-hosts)
 *   npm run ops -- voici              voi.ci reports, bans, takedowns, Messages enrollments, the abuse key; warns when
 *                                     a report is older than 24 h (Apple's expectation) or the abuse key is ending
 *   npm run ops -- mesh               every relay in the directory (docs/runbooks/relay-mesh.md): ready or why
 *                                     not, head age, directory version, bridges, attachments, account moves
 *
 * Env: FLAGSHIP_BASE_URL (default https://flagshipserver.com), FLAGSHIP_SERVICES_URL (default
 * https://flagship.services); USAGE_REPORT_SECRET for `services`; CLOUDFLARE_API_TOKEN (Account
 * Analytics: Read) and CLOUDFLARE_ACCOUNT_ID for `workers`; wrangler login for `slow`;
 * FLAGSHIP_ADMIN_SECRET for `limits`, `outbound` and `voici`; `mesh` reads the directory from
 * FLAGSHIP_RELAY_FEED_URL (default https://feed.<host of FLAGSHIP_BASE_URL>/v1) and each relay's stats
 * with USAGE_REPORT_SECRET (health alone without it).
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { fileURLToPath } from "node:url";
import { WorkerTail } from "../tools/live-e2e/lib/workerTail.js";

export const FREE_CPU_MS = 10;

export interface Options {
  command: string;
  hours: number;
  seconds: number;
  script: string;
}

export function parseArgs(argv: string[]): Options {
  const o: Options = { command: "all", hours: 24, seconds: 60, script: "flagship-com" };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("-")) o.command = rest.shift()!;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--hours") o.hours = Number(rest[++i]);
    else if (a === "--seconds") o.seconds = Number(rest[++i]);
    else if (a === "--script") o.script = String(rest[++i] ?? "");
    else if (a === "-h" || a === "--help") o.command = "help";
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!["all", "health", "services", "dns", "workers", "slow", "limits", "outbound", "mesh", "voici", "help"].includes(o.command)) {
    throw new Error(`unknown command: ${o.command}`);
  }
  if (!Number.isInteger(o.hours) || o.hours < 1 || o.hours > 72) throw new Error("--hours takes a whole number from 1 to 72");
  if (!Number.isInteger(o.seconds) || o.seconds < 5 || o.seconds > 900) throw new Error("--seconds takes a whole number from 5 to 900");
  if (!o.script) throw new Error("--script needs a name");
  return o;
}

/* ---------------------------------------------------------------- health */

export interface HealthResult {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

export async function checkHealth(name: string, url: string, fetchFn: typeof fetch = fetch): Promise<HealthResult> {
  const t0 = Date.now();
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
    const ms = Date.now() - t0;
    if (!res.ok) return { name, ok: false, ms, detail: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; uptimeMs?: number };
    return { name, ok: body.ok !== false, ms, detail: body.uptimeMs !== undefined ? `up ${Math.round(body.uptimeMs / 60_000)} min` : "answered" };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t0, detail: (e as Error).message.slice(0, 100) };
  }
}

export function formatHealth(rs: HealthResult[]): string[] {
  return ["Health", ...rs.map((r) => `  ${r.ok ? "ok  " : "DOWN"}  ${r.name.padEnd(22)} ${String(r.ms).padStart(5)} ms  ${r.detail}`)];
}

/* ------------------------------------------------------------------- dns */

export interface DnsProbe {
  server: string;
  name: string;
  v4: string[];
  v6: string[];
  error?: string;
}

export type DnsLookup = (server: string, name: string, type: "A" | "AAAA") => Promise<string[]>;

const defaultLookup: DnsLookup = async (server, name, type) => {
  const r = new Resolver({ timeout: 4000, tries: 2 });
  r.setServers([server]);
  return type === "A" ? r.resolve4(name) : r.resolve6(name);
};

/**
 * A name nobody registered, under the apex and one level below it, asked of public resolvers: the
 * zone's root wildcard must answer both (docs/wildcard-dns.md). A resolver that says "no such name"
 * or "no data" while an ACME challenge is in flight is the outage that turns into 30 minutes of
 * negative caching for a real user.
 */
export async function probeWildcard(
  apex: string,
  servers: string[],
  lookup: DnsLookup = defaultLookup,
  rand: () => string = () => randomBytes(5).toString("hex"),
): Promise<DnsProbe[]> {
  const label = `canary-${rand()}`;
  const names = [`${label}.${apex}`, `home.${label}.${apex}`];
  const out: DnsProbe[] = [];
  for (const server of servers) {
    for (const name of names) {
      const p: DnsProbe = { server, name, v4: [], v6: [] };
      try {
        p.v4 = await lookup(server, name, "A");
      } catch (e) {
        p.error = (e as { code?: string }).code ?? (e as Error).message;
      }
      try {
        p.v6 = await lookup(server, name, "AAAA");
      } catch (e) {
        p.error ??= `AAAA ${(e as { code?: string }).code ?? (e as Error).message}`;
      }
      out.push(p);
    }
  }
  return out;
}

export function formatDns(probes: DnsProbe[], expectV4: string | null, expectV6: string | null): { lines: string[]; hints: string[] } {
  const lines = ["Wildcard DNS (names nobody registered)"];
  const hints: string[] = [];
  for (const p of probes) {
    const wrong =
      p.error !== undefined ||
      (expectV4 !== null && !p.v4.includes(expectV4)) ||
      (expectV6 !== null && p.v6.length > 0 && !p.v6.includes(expectV6));
    lines.push(`  ${wrong ? "BAD" : "ok "}  ${p.server.padEnd(9)} ${p.name}  ${p.error ? p.error : [...p.v4, ...p.v6].join(", ")}`);
    if (wrong) hints.push(`${p.server} answered ${p.name} with ${p.error ?? ([...p.v4, ...p.v6].join(", ") || "nothing")}; the relay is ${expectV4 ?? "unknown"}. A real box name could fail the same way.`);
  }
  return { lines, hints };
}

async function dnsReport(com: string): Promise<{ lines: string[]; hints: string[] }> {
  let v4: string | null = null;
  let v6: string | null = null;
  try {
    const res = await fetch(`${com}/api/services/endpoints`, { signal: AbortSignal.timeout(10_000) });
    const j = (await res.json()) as { passthroughIPv4?: string | null; passthroughIPv6?: string | null };
    v4 = j.passthroughIPv4 ?? null;
    v6 = j.passthroughIPv6 ?? null;
  } catch {
    // Without the expected address the probe still catches NXDOMAIN and NODATA.
  }
  return formatDns(await probeWildcard("flagship.services", ["1.1.1.1", "8.8.8.8", "9.9.9.9"]), v4, v6);
}

/* -------------------------------------------------------------- services */

export interface ServicesStats {
  uptimeSec: number;
  tunnelsOnline: number;
  router: {
    routed: number;
    parked: number;
    released: number;
    holdTimeouts: number;
    noBoxRegistered: number;
    noUser: number;
    bad: number;
    recentMisses: Array<{ at: string; domain: string; kind: string }>;
  };
}

export function formatServices(s: ServicesStats): { lines: string[]; hints: string[] } {
  const r = s.router;
  const lines = [
    `Relay (.services), up ${Math.round(s.uptimeSec / 60)} min, ${s.tunnelsOnline} box tunnel(s) online`,
    `  connections routed straight to a box   ${r.routed}`,
    `  waited for a box to claim the name     ${r.parked}   (recovered ${r.released}, dropped ${r.holdTimeouts})`,
    `  name known, no box registered          ${r.noBoxRegistered}`,
    `  name of no known account               ${r.noUser}`,
    `  unreadable or no-SNI connections       ${r.bad}`,
  ];
  if (r.recentMisses.length > 0) {
    lines.push("  last missed names:");
    for (const m of r.recentMisses.slice(-8)) lines.push(`    ${m.at.slice(11, 19)}  ${m.kind.padEnd(18)} ${m.domain}`);
  }
  const hints: string[] = [];
  if (r.holdTimeouts > 0) hints.push(`${r.holdTimeouts} connection(s) waited for a box that never claimed the name (missed redirection). Is a box offline, or its claim late?`);
  if (r.parked > 0 && r.released / r.parked < 0.5) hints.push(`Only ${r.released} of ${r.parked} waiting connections were recovered.`);
  if (s.uptimeSec < 600) hints.push("The relay restarted in the last 10 minutes (counters begin again; boxes reconnect on their own).");
  return { lines, hints };
}

/* --------------------------------------------------------------- workers */

export interface WorkerRow {
  status: string;
  requests: number;
  errors: number;
  subrequests: number;
  cpuP50Us: number;
  cpuP99Us: number;
  wallP99Us: number;
}

export function formatWorkers(script: string, hours: number, rows: WorkerRow[]): { lines: string[]; hints: string[] } {
  const total = rows.reduce((n, r) => n + r.requests, 0);
  const lines = [`Worker ${script}, last ${hours} h: ${total} request(s)`];
  const hints: string[] = [];
  if (total === 0) return { lines: [...lines, "  nothing recorded"], hints };
  lines.push(`  ${"outcome".padEnd(24)} ${"requests".padStart(9)} ${"errors".padStart(7)}  ${"cpu p50".padStart(8)} ${"cpu p99".padStart(8)} ${"wall p99".padStart(9)}`);
  for (const r of [...rows].sort((a, b) => b.requests - a.requests)) {
    lines.push(
      `  ${r.status.padEnd(24)} ${String(r.requests).padStart(9)} ${String(r.errors).padStart(7)}  ${(r.cpuP50Us / 1000).toFixed(1).padStart(6)}ms ${(r.cpuP99Us / 1000).toFixed(1).padStart(6)}ms ${(r.wallP99Us / 1000).toFixed(0).padStart(7)}ms`,
    );
  }
  for (const r of rows) {
    if (/exceeded/i.test(r.status) && r.requests > 0) hints.push(`${r.requests} request(s) ended "${r.status}" (error 1102 for exceededCpu: the 10 ms Free limit). Users saw a temporary failure.`);
    if (r.status === "scriptThrewException" && r.requests > 0) hints.push(`${r.requests} request(s) threw an exception. Run: npm run ops -- slow, or wrangler tail ${script}.`);
    if (/^(ok|success)$/.test(r.status) && r.cpuP99Us / 1000 > FREE_CPU_MS) hints.push(`The slowest 1% of successful requests used ${(r.cpuP99Us / 1000).toFixed(1)} ms of CPU, over the Free plan's ${FREE_CPU_MS} ms. They pass here only if this account is on Paid.`);
  }
  const errorRate = rows.reduce((n, r) => n + r.errors, 0) / total;
  if (errorRate > 0.01) hints.push(`${(errorRate * 100).toFixed(1)}% of requests errored.`);
  return { lines, hints };
}

export const WORKERS_QUERY = `query($account: String!, $script: String!, $since: Time!, $until: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    workersInvocationsAdaptive(limit: 100, filter: { scriptName: $script, datetime_geq: $since, datetime_leq: $until }) {
      dimensions { status }
      sum { requests errors subrequests }
      quantiles { cpuTimeP50 cpuTimeP99 wallTimeP99 }
    }
  } }
}`;

export function rowsFromAnalytics(json: unknown): WorkerRow[] {
  const groups = (json as { data?: { viewer?: { accounts?: Array<{ workersInvocationsAdaptive?: unknown[] }> } } })?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  return (groups as Array<{ dimensions?: { status?: string }; sum?: Record<string, number>; quantiles?: Record<string, number> }>).map((g) => ({
    status: g.dimensions?.status ?? "unknown",
    requests: g.sum?.requests ?? 0,
    errors: g.sum?.errors ?? 0,
    subrequests: g.sum?.subrequests ?? 0,
    cpuP50Us: g.quantiles?.cpuTimeP50 ?? 0,
    cpuP99Us: g.quantiles?.cpuTimeP99 ?? 0,
    wallP99Us: g.quantiles?.wallTimeP99 ?? 0,
  }));
}

async function workersReport(o: Options, env: NodeJS.ProcessEnv, now = new Date()): Promise<{ lines: string[]; hints: string[] } | string> {
  const token = env.CLOUDFLARE_API_TOKEN;
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) return "Worker numbers need CLOUDFLARE_API_TOKEN (Account Analytics: Read) and CLOUDFLARE_ACCOUNT_ID.";
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: WORKERS_QUERY,
      variables: { account, script: o.script, since: new Date(now.getTime() - o.hours * 3_600_000).toISOString(), until: now.toISOString() },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => null)) as { errors?: Array<{ message?: string }> } | null;
  if (!res.ok || json?.errors?.length) return `Cloudflare said no: ${json?.errors?.[0]?.message ?? `HTTP ${res.status}`}`;
  return formatWorkers(o.script, o.hours, rowsFromAnalytics(json));
}

/* ------------------------------------------------------------------ slow */

export function formatSlow(summary: ReturnType<WorkerTail["summary"]>, seconds: number): { lines: string[]; hints: string[] } {
  if (!summary.available) return { lines: [`Live tail unavailable: ${summary.reason ?? "unknown"}. Is wrangler logged in?`], hints: [] };
  const lines = [`Live tail, ${seconds} s: ${summary.events} request(s), outcomes ${JSON.stringify(summary.outcomes)}`];
  const hints: string[] = [];
  const withCpu = summary.routes.filter((r) => r.cpuMsMax !== null).sort((a, b) => (b.cpuMsMax ?? 0) - (a.cpuMsMax ?? 0)).slice(0, 15);
  if (withCpu.length > 0) {
    lines.push(`  ${"route".padEnd(52)} ${"n".padStart(4)} ${"p50".padStart(7)} ${"p95".padStart(7)} ${"max".padStart(7)}`);
    for (const r of withCpu) {
      lines.push(`  ${`${r.method} ${r.route}`.slice(0, 52).padEnd(52)} ${String(r.n).padStart(4)} ${`${(r.cpuMsP50 ?? 0).toFixed(1)}ms`.padStart(7)} ${`${(r.cpuMsP95 ?? 0).toFixed(1)}ms`.padStart(7)} ${`${(r.cpuMsMax ?? 0).toFixed(1)}ms`.padStart(7)}`);
    }
  } else {
    lines.push("  no request reached the Worker in this window; use the app or webapp while it runs.");
  }
  for (const n of summary.nearBudget.filter((x) => x.cpuMsMax > FREE_CPU_MS)) hints.push(`${n.method} ${n.route} used ${n.cpuMsMax.toFixed(1)} ms of CPU: over the Free plan's ${FREE_CPU_MS} ms.`);
  if (summary.exceeded.length > 0) hints.push(`${summary.exceeded.length} request(s) exceeded a limit: ${summary.exceeded.slice(0, 3).map((e) => `${e.method} ${e.route} (${e.outcome})`).join(", ")}.`);
  return { lines, hints };
}

async function slowReport(o: Options): Promise<{ lines: string[]; hints: string[] }> {
  const tail = new WorkerTail({ cwd: fileURLToPath(new URL("../apps/com", import.meta.url)), script: o.script });
  console.error(`Tailing ${o.script} for ${o.seconds} s. Use the app or webapp now.`);
  await tail.start();
  await new Promise((r) => setTimeout(r, o.seconds * 1000));
  tail.stop();
  return formatSlow(tail.summary(), o.seconds);
}

/* ------------------------------------------------------------------ mesh */

export interface MeshDirectoryRelay {
  relayId: string;
  tunnelHost: string;
  relayKind?: string;
  region?: string;
}

/** The relays named by `directory.json` (`{directory:{relays}}`) or by `.com`'s endpoints (`{relays}`). */
export function relaysFromDirectory(json: unknown): MeshDirectoryRelay[] {
  const j = json as { directory?: { relays?: unknown }; relays?: unknown } | null;
  const list = Array.isArray(j?.directory?.relays) ? j!.directory!.relays : Array.isArray(j?.relays) ? j!.relays : [];
  return (list as Array<Record<string, unknown>>)
    .filter((r) => typeof r?.relayId === "string" && typeof r?.tunnelHost === "string")
    .map((r) => ({
      relayId: r.relayId as string,
      tunnelHost: r.tunnelHost as string,
      ...(typeof r.relayKind === "string" ? { relayKind: r.relayKind } : {}),
      ...(typeof r.region === "string" ? { region: r.region } : {}),
    }));
}

export interface MeshRelayReport {
  relay: MeshDirectoryRelay;
  health: { status: number; body: unknown } | { error: string };
  stats: { status: number; body: unknown } | { error: string } | null;
}

interface MeshView {
  ready: boolean | null;
  reasons: string[];
  headAgeMs: number | null;
  directoryVersion: number | null;
  sequence: number | null;
  boxItems: number | null;
  phoneItems: number | null;
  localBoxes: number | null;
  accountMoves: number | null;
  draining: boolean | null;
  peers: Array<{ relayId: string; rejected: number; refusals: number; opens: number; lastHeardMs: number | null }>;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const sumValues = (v: unknown): number => (typeof v === "number" ? v : v && typeof v === "object" ? Object.values(v).reduce<number>((n, x) => n + (typeof x === "number" ? x : 0), 0) : 0);

/** One view over both relays' shapes: TS (`mesh.reasons`, `feed`, `store`, `homes`) and Rust (`readiness`, `state`). */
export function meshView(healthBody: unknown, statsBody: unknown): MeshView {
  const h = (healthBody as { mesh?: Record<string, unknown> } | null)?.mesh ?? null;
  const m = ((statsBody as { mesh?: Record<string, unknown> } | null)?.mesh ?? null) as Record<string, any> | null;
  const reasons: string[] = [];
  const from = (x: unknown) => {
    if (Array.isArray(x)) reasons.push(...x.filter((r): r is string => typeof r === "string"));
    else if (typeof x === "string" && x !== "ready") reasons.push(x);
  };
  from(h?.reasons ?? h?.readiness ?? m?.reasons ?? m?.readiness);
  const ready = typeof h?.ready === "boolean" ? h.ready : typeof m?.ready === "boolean" ? m.ready : null;
  const st = m?.state ?? null;
  const peersRaw: any[] = Array.isArray(m?.peers) ? m!.peers : [];
  return {
    ready,
    reasons: [...new Set(reasons)],
    headAgeMs: num(m?.feed?.headAgeMs ?? st?.headAgeMs),
    directoryVersion: num(m?.directory?.version ?? st?.directoryVersion),
    sequence: num(m?.feed?.sequence ?? st?.sequence),
    boxItems: num(m?.store?.boxItems ?? st?.boxItems),
    phoneItems: num(m?.store?.phoneItems ?? st?.phoneItems),
    localBoxes: num(m?.localBoxes ?? st?.localBoxes),
    accountMoves: num(m?.homes?.moves ?? st?.accountMoves),
    draining: typeof m?.draining === "boolean" ? m.draining : typeof st?.draining === "boolean" ? st.draining : null,
    peers: peersRaw
      .filter((p) => typeof p?.relayId === "string")
      .map((p) => ({ relayId: p.relayId, rejected: sumValues(p.rejected), refusals: sumValues(p.refusals), opens: sumValues(p.opens) + sumValues(p.opensIn), lastHeardMs: num(p.lastHeardMs) })),
  };
}

export function formatMesh(reports: MeshRelayReport[], source: string): { lines: string[]; hints: string[] } {
  const lines = [`Relay mesh (${reports.length} relay(s) in the directory, from ${source})`];
  const hints: string[] = [];
  if (reports.length === 0) hints.push("The directory lists no relay: is RELAY_MESH on at .com and a relay admitted (npm run relays -- list)?");
  const ids = reports.map((r) => r.relay.relayId);
  const versions = new Set<number>();
  for (const r of reports) {
    const name = `${r.relay.relayId}${r.relay.region ? ` (${r.relay.region})` : ""}`;
    if ("error" in r.health) {
      lines.push(`  DOWN  ${name.padEnd(20)} ${r.relay.tunnelHost}: ${r.health.error.slice(0, 80)}`);
      hints.push(`${r.relay.relayId} does not answer /api/health on ${r.relay.tunnelHost}:8443.`);
      continue;
    }
    const sb = r.stats && !("error" in r.stats) && r.stats.status === 200 ? r.stats.body : null;
    const v = meshView(r.health.body, sb);
    const ok = r.health.status === 200 && v.ready !== false;
    lines.push(`  ${ok ? "ok  " : "503 "}  ${name.padEnd(20)} ${ok ? "mesh-ready" : `not ready: ${v.reasons.join(", ") || `HTTP ${r.health.status}`}`}`);
    if (!ok) hints.push(`${r.relay.relayId} is not mesh-ready (${v.reasons.join(", ") || `HTTP ${r.health.status}`}); the load balancer sends it nothing.`);
    if (!sb) {
      lines.push(`        stats: ${r.stats === null ? "no USAGE_REPORT_SECRET" : "error" in r.stats ? r.stats.error.slice(0, 80) : `HTTP ${r.stats.status}`}`);
      continue;
    }
    if (v.directoryVersion !== null) versions.add(v.directoryVersion);
    const age = v.headAgeMs === null ? "no head" : `${Math.round(v.headAgeMs / 1000)} s`;
    lines.push(`        head ${age}, log ${v.sequence ?? "?"}, directory v${v.directoryVersion ?? "?"}, attachments ${v.boxItems ?? "?"} box / ${v.phoneItems ?? "?"} phone, local boxes ${v.localBoxes ?? "?"}, account moves ${v.accountMoves ?? "?"}${v.draining ? ", DRAINING" : ""}`);
    if (v.headAgeMs !== null && v.headAgeMs > 30_000) hints.push(`${r.relay.relayId}'s newest head is ${age} old (stale at 60 s): is the feed reachable from it?`);
    const up = new Set(v.peers.map((p) => p.relayId));
    for (const p of v.peers) {
      lines.push(`        bridge ${p.relayId.padEnd(14)} opens ${p.opens}, refusals ${p.refusals}, rejected items ${p.rejected}, heard ${p.lastHeardMs === null ? "?" : `${Math.round(p.lastHeardMs / 1000)} s`} ago`);
      if (p.rejected > 0) hints.push(`${r.relay.relayId} rejected ${p.rejected} item(s) from ${p.relayId}: a bug or a rogue relay.`);
    }
    const missing = ids.filter((id) => id !== r.relay.relayId && !up.has(id));
    if (missing.length > 0) {
      lines.push(`        no bridge to: ${missing.join(", ")}`);
      hints.push(`${r.relay.relayId} has no bridge to ${missing.join(", ")}.`);
    }
  }
  if (versions.size > 1) hints.push(`Relays hold different directory versions (${[...versions].sort((a, b) => a - b).join(", ")}); they converge within a minute.`);
  return { lines, hints };
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown } | { error: string }> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

async function meshReport(com: string, env: NodeJS.ProcessEnv): Promise<{ lines: string[]; hints: string[] }> {
  const feed = (env.FLAGSHIP_RELAY_FEED_URL ?? `https://feed.${new URL(com).hostname}/v1`).replace(/\/+$/, "");
  let source = `${feed}/directory.json`;
  let dir = await getJson(source);
  if ("error" in dir || dir.status !== 200 || relaysFromDirectory(dir.body).length === 0) {
    source = `${com}/api/services/endpoints`;
    dir = await getJson(source);
  }
  const relays = "error" in dir ? [] : relaysFromDirectory(dir.body);
  const secret = env.USAGE_REPORT_SECRET;
  const reports = await Promise.all(
    relays.map(async (relay): Promise<MeshRelayReport> => {
      const base = `https://${relay.tunnelHost}:8443`;
      const [health, stats] = await Promise.all([getJson(`${base}/api/health`), secret ? getJson(`${base}/api/stats`, { "x-usage-secret": secret }) : Promise.resolve(null)]);
      return { relay, health, stats };
    }),
  );
  return formatMesh(reports, source);
}

/* ----------------------------------------------------------------- voici */

export interface VoiciStats {
  now: number;
  enabled: boolean;
  openReports: number;
  oldestOpenReportAt: number | null;
  reportsLast7Days: number;
  bans: number;
  bannedPseudonyms: number;
  takedowns: number;
  takedownsPurgePending: number;
  enrollments: Record<string, number>;
  newRecipientsToday: number;
  abuseKey: { epoch: number; notAfter: number } | null;
  purgeConfigured: boolean;
}

const REPORT_DUE_MS = 24 * 3600_000;

export function formatVoici(s: VoiciStats): { lines: string[]; hints: string[] } {
  const hours = (ms: number) => Math.floor(ms / 3600_000);
  const lines = [
    "voi.ci and Messages:",
    `  reports    ${s.openReports} open${s.oldestOpenReportAt ? `, oldest ${hours(s.now - s.oldestOpenReportAt)} h` : ""}; ${s.reportsLast7Days} in the last 7 days`,
    `  bans       ${s.bans} account(s), ${s.bannedPseudonyms} pseudonym(s); takedowns ${s.takedowns}${s.takedownsPurgePending ? ` (${s.takedownsPurgePending} not finished)` : ""}`,
    `  Messages   enrolled ios ${s.enrollments.ios ?? 0}, android ${s.enrollments.android ?? 0}, web/unattested ${s.enrollments.none ?? 0}; ${s.newRecipientsToday} new conversation(s) today`,
    `  abuse key  ${s.abuseKey ? `epoch ${s.abuseKey.epoch}, until ${new Date(s.abuseKey.notAfter).toISOString().slice(0, 10)}` : "none in its window"}`,
  ];
  const hints: string[] = [];
  if (s.oldestOpenReportAt && s.now - s.oldestOpenReportAt > REPORT_DUE_MS) {
    hints.push(`A voi.ci report is ${hours(s.now - s.oldestOpenReportAt)} h old (Apple expects action within 24 h): npm run voici-abuse -- list`);
  }
  if (s.enabled && !s.abuseKey) hints.push("Messages is on but no abuse key is in its window: every attestation answers 503 (npm run abuse-key -- status).");
  if (s.abuseKey && s.abuseKey.notAfter - s.now < 14 * 86_400_000) hints.push(`The abuse key (epoch ${s.abuseKey.epoch}) ends within 14 days: generate and sign the next one.`);
  if (s.takedownsPurgePending) hints.push("A takedown has not finished deleting its pieces: run npm run voici-abuse -- takedown again.");
  if (s.takedowns && !s.purgeConfigured) hints.push("files.voi.ci purge is not configured (CLOUDFLARE_PURGE_TOKEN, VOICI_FILES_ZONE_ID): taken-down pieces stay cached.");
  return { lines, hints };
}

async function voiciReport(com: string, env: NodeJS.ProcessEnv): Promise<{ lines: string[]; hints: string[] } | string> {
  if (!env.FLAGSHIP_ADMIN_SECRET) return "voi.ci needs FLAGSHIP_ADMIN_SECRET.";
  const r = await getJson(`${com}/api/admin/voici/stats`, { "x-admin-secret": env.FLAGSHIP_ADMIN_SECRET });
  if ("error" in r) return `voi.ci: ${r.error}`;
  if (r.status === 404) return "voi.ci: off on this .com (VOICI_ENABLED), or not deployed.";
  if (r.status !== 200) return `voi.ci: HTTP ${r.status}`;
  return formatVoici(r.body as VoiciStats);
}

/* ------------------------------------------------------------------ main */

function delegate(script: string, args: string[] = []): void {
  const r = spawnSync("node", [fileURLToPath(new URL(script, import.meta.url)), ...args], { stdio: "inherit" });
  if (r.status) process.exitCode = r.status;
}

async function main(): Promise<void> {
  let o: Options;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  const com = (process.env.FLAGSHIP_BASE_URL ?? "https://flagshipserver.com").replace(/\/$/, "");
  const svc = (process.env.FLAGSHIP_SERVICES_URL ?? "https://flagship.services").replace(/\/$/, "");
  const hints: string[] = [];
  const out = (r: { lines: string[]; hints: string[] } | string): void => {
    if (typeof r === "string") return void console.log(r + "\n");
    console.log(r.lines.join("\n") + "\n");
    hints.push(...r.hints);
  };
  const all = o.command === "all";

  if (o.command === "help") {
    console.log("usage: npm run ops -- [health | services | dns | workers [--hours N] [--script NAME] | slow [--seconds N] | limits | outbound | mesh | voici]");
    return;
  }
  if (all || o.command === "health") {
    const rs = await Promise.all([checkHealth(".com", `${com}/api/health`), checkHealth(".services", `${svc}/api/health`), checkHealth(".com relay addresses", `${com}/api/services/endpoints`)]);
    console.log(formatHealth(rs).join("\n") + "\n");
    for (const r of rs.filter((x) => !x.ok)) hints.push(`${r.name} is not answering (${r.detail}).`);
  }
  if (all || o.command === "services") {
    const secret = process.env.USAGE_REPORT_SECRET;
    if (!secret) out("Relay counters need USAGE_REPORT_SECRET (the relay's shared secret).");
    else {
      try {
        const res = await fetch(`${svc}/api/stats`, { headers: { "x-usage-secret": secret }, signal: AbortSignal.timeout(10_000) });
        out(res.ok ? formatServices((await res.json()) as ServicesStats) : `Relay counters: HTTP ${res.status} (is the relay on a build with /api/stats?)`);
      } catch (e) {
        out(`Relay counters: ${(e as Error).message}`);
      }
    }
  }
  if (all || o.command === "dns") out(await dnsReport(com).catch((e) => `Wildcard DNS: ${(e as Error).message}`));
  if (all || o.command === "workers") out(await workersReport(o, process.env).catch((e) => `Worker numbers: ${(e as Error).message}`));
  if (o.command === "slow") out(await slowReport(o));
  if (o.command === "mesh") out(await meshReport(com, process.env));
  if (o.command === "voici") out(await voiciReport(com, process.env));
  if (o.command === "limits") delegate("./rate-limit-report.mjs");
  if (o.command === "outbound") delegate("./outbound-hosts.mjs");

  if (hints.length > 0) {
    console.log("Worth a look:");
    for (const h of hints) console.log(`  - ${h}`);
    process.exitCode = process.exitCode || 3;
  } else if (all) {
    console.log("Nothing stands out.");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
