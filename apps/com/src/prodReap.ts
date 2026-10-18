/**
 * Prod reap: removes what the pre-GA scrub (docs/runbooks/pre-ga-scrub.md)
 * leaves behind. The scrub deletes D1 rows only; the wiped accounts' DNS
 * records in the `flagship.services` zone (the zone is capped at 200) and
 * their demo UpCloud servers stay until reaped here.
 *
 * Three admin routes (x-admin-secret, like /api/admin/rate-limits), driven by
 * scripts/reap-orphans.mjs. Nothing here deletes by itself: only `delete-one`
 * writes, one DNS record or one server per call, and it re-checks the item
 * against D1 right then.
 *
 *   GET  /api/admin/reap/list       the zone's records and the Flagship-labelled
 *                                   UpCloud servers, unclassified
 *   GET  /api/admin/reap/classify   the same, each marked KEEP or ORPHAN with a
 *                                   reason, plus per-account counts (the plan)
 *   POST /api/admin/reap/delete-one {kind:"dns",id,name,type} or
 *                                   {kind:"server",id,owner}
 *
 * An item is ORPHAN only when ALL hold: its name has exactly a shape that
 * Flagship publishes, the account label is a valid, non-reserved username, and
 * no account of that name is known to D1 (usernames, aliases, servers, demo
 * users, auth codes). Everything else (apex, system records, gym, anything
 * unrecognised, any account still in D1, the protected store-review account)
 * is KEEP. A D1 that does not hold every protected account is refused
 * outright: that is the wrong database or the wipe went too far.
 */

import { authorizeAdmin, validateServerLabel, validateUserLabel } from "@flagship/control-plane";
import type { D1Database } from "@flagship/storage";

export const REAP_PATH_PREFIX = "/api/admin/reap/";
export const DEFAULT_PROTECTED_ACCOUNTS = ["playstore-test-0725"];
/** UpCloud label every Worker-created demo/sample-user server carries. */
export const REAP_DEMO_LABEL = "flagship-demo";
/** Label of the gym (and any other parallel environment); never reaped here. */
export const REAP_ENV_LABEL = "flagship-env";

export interface ReapDnsRecord {
  id: string;
  name: string;
  type: string;
  content?: string;
}

export interface ReapDnsClient {
  listAll(): Promise<ReapDnsRecord[]>;
  getById(id: string): Promise<ReapDnsRecord | null>;
  deleteById(id: string): Promise<boolean>;
}

export interface ReapServer {
  serverId: string;
  title: string;
  state: string;
  labels: Record<string, string>;
}

export interface ReapCloudClient {
  listServersByLabelKey(key: string): Promise<ReapServer[]>;
  getServerLabels(serverId: string): Promise<Record<string, string> | null>;
  destroyServer(serverId: string): Promise<void>;
}

export interface ReapEnv {
  DB?: D1Database;
  FLAGSHIP_ADMIN_SECRET?: string;
  SERVICES_APEX?: string;
  CLOUDFLARE_DNS_API_TOKEN?: string;
  CLOUDFLARE_SERVICES_ZONE_ID?: string;
  UPCLOUD_TOKEN?: string;
  /** Comma list overriding DEFAULT_PROTECTED_ACCOUNTS (empty = none). */
  REAP_PROTECTED_ACCOUNTS?: string;
}

export interface ReapDeps {
  db: D1Database;
  dns: ReapDnsClient | undefined;
  cloud: ReapCloudClient | undefined;
  apex: string;
  protectedAccounts: readonly string[];
  now?: () => number;
  log?: (line: string) => void;
}

export interface KnownAccounts {
  names: Set<string>;
  serverIds: Set<string>;
}

export type ReapAction = "keep" | "orphan";

export interface DnsVerdict {
  action: ReapAction;
  /** The account label the name belongs to, when it has a recognisable shape. */
  owner: string | null;
  reason: string;
}

const NAME_CHARS = /^[a-z0-9_*.-]+$/;

/** Record shapes Flagship publishes under `<user>.<apex>`, by (labels, kind). */
const ALLOWED: Record<string, readonly string[]> = {
  "1:plain": ["CAA"],
  "1:wild": ["CAA", "A", "AAAA"],
  "1:acme": ["TXT"],
  "2:plain": ["A", "AAAA"],
  "2:wild": ["A", "AAAA"],
  "2:acme": ["TXT"],
};

export function classifyDnsRecord(
  rec: { name: string; type: string },
  apexIn: string,
  known: KnownAccounts,
  protectedAccounts: readonly string[],
): DnsVerdict {
  const apex = apexIn.toLowerCase().replace(/\.$/, "");
  const name = rec.name.toLowerCase().replace(/\.$/, "");
  const type = rec.type.toUpperCase();
  if (name === apex) return { action: "keep", owner: null, reason: "the zone apex" };
  if (!name.endsWith(`.${apex}`)) return { action: "keep", owner: null, reason: "outside the services zone apex" };
  const rel = name.slice(0, -(apex.length + 1));
  if (!NAME_CHARS.test(rel)) return { action: "keep", owner: null, reason: "unrecognised name" };
  let labels = rel.split(".");
  if (labels.some((l) => l === "")) return { action: "keep", owner: null, reason: "unrecognised name" };
  let kind: "plain" | "wild" | "acme" = "plain";
  if (labels[0] === "*") {
    kind = "wild";
    labels = labels.slice(1);
  } else if (labels[0] === "_acme-challenge") {
    kind = "acme";
    labels = labels.slice(1);
  }
  if (labels.length < 1 || labels.length > 2 || labels.some((l) => l.includes("*") || l.startsWith("_"))) {
    return { action: "keep", owner: null, reason: "unrecognised name" };
  }
  const ownerLabel = labels[labels.length - 1]!;
  const user = validateUserLabel(ownerLabel);
  if (!user.ok) return { action: "keep", owner: null, reason: "system or reserved label" };
  const owner = user.label;
  if (labels.length === 2 && !validateServerLabel(labels[0]!).ok) {
    return { action: "keep", owner: null, reason: "unrecognised name" };
  }
  const allowed = ALLOWED[`${labels.length}:${kind}`];
  if (!allowed || !allowed.includes(type)) {
    return { action: "keep", owner: null, reason: `not a record Flagship publishes (${type})` };
  }
  if (protectedAccounts.includes(owner)) return { action: "keep", owner, reason: "protected account" };
  if (known.names.has(owner)) return { action: "keep", owner, reason: "account still exists in D1" };
  return { action: "orphan", owner, reason: "no account of this name in D1" };
}

export interface ServerVerdict {
  action: ReapAction;
  owner: string | null;
  reason: string;
}

export function classifyServer(
  s: { serverId: string; labels: Record<string, string> },
  known: KnownAccounts,
  protectedAccounts: readonly string[],
): ServerVerdict {
  if (s.labels[REAP_ENV_LABEL] !== undefined) {
    return { action: "keep", owner: null, reason: "belongs to another environment (gym sweep handles it)" };
  }
  const raw = s.labels[REAP_DEMO_LABEL];
  if (raw === undefined) return { action: "keep", owner: null, reason: "not a Flagship demo server" };
  const user = validateUserLabel(raw.toLowerCase());
  if (!user.ok) return { action: "keep", owner: null, reason: "unrecognised account label" };
  const owner = user.label;
  if (protectedAccounts.includes(owner)) return { action: "keep", owner, reason: "protected account" };
  if (known.names.has(owner)) return { action: "keep", owner, reason: "account still exists in D1" };
  if (known.serverIds.has(s.serverId.toLowerCase())) {
    return { action: "keep", owner, reason: "a demo user in D1 still points at this server" };
  }
  return { action: "orphan", owner, reason: "no account of this name in D1" };
}

const KNOWN_QUERIES: { sql: string; kind: "name" | "serverId"; primary?: true }[] = [
  { sql: "SELECT username AS v FROM usernames", kind: "name", primary: true },
  { sql: "SELECT old_username AS v FROM usernames_aliases", kind: "name" },
  { sql: "SELECT new_username AS v FROM usernames_aliases", kind: "name" },
  { sql: "SELECT username AS v FROM servers", kind: "name" },
  { sql: "SELECT username AS v FROM demo_users", kind: "name" },
  { sql: "SELECT username AS v FROM auth_codes", kind: "name" },
  { sql: "SELECT active_server_id AS v FROM demo_users WHERE active_server_id IS NOT NULL", kind: "serverId" },
];

export class ReapRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Every account name D1 still knows. A query error other than a missing table fails closed. */
export async function loadKnownAccounts(db: D1Database, protectedAccounts: readonly string[]): Promise<KnownAccounts> {
  const names = new Set<string>();
  const serverIds = new Set<string>();
  let usernameRows = 0;
  for (const q of KNOWN_QUERIES) {
    let rows: { v: unknown }[];
    try {
      rows = (await db.prepare(q.sql).all<{ v: unknown }>()).results;
    } catch (e) {
      if (/no such (table|column)/i.test(e instanceof Error ? e.message : String(e))) continue;
      throw new ReapRefusal(502, "d1-unavailable", "Could not read the account tables; nothing was classified.");
    }
    for (const r of rows) {
      if (typeof r.v !== "string" || r.v === "") continue;
      if (q.kind === "name") names.add(r.v.toLowerCase());
      else serverIds.add(r.v.toLowerCase());
    }
    if (q.primary) usernameRows = rows.length;
  }
  if (usernameRows === 0) {
    throw new ReapRefusal(409, "d1-has-no-accounts", "D1 holds no accounts at all: wrong database? Nothing was classified.");
  }
  const missing = protectedAccounts.filter((p) => !names.has(p));
  if (missing.length > 0) {
    throw new ReapRefusal(
      409,
      "protected-account-missing",
      `D1 does not hold the protected account ${missing.join(", ")}: wrong database, or the review login is gone. Nothing was classified.`,
    );
  }
  return { names, serverIds };
}

export function protectedAccountsFrom(env: ReapEnv): string[] {
  if (env.REAP_PROTECTED_ACCOUNTS === undefined) return [...DEFAULT_PROTECTED_ACCOUNTS];
  return env.REAP_PROTECTED_ACCOUNTS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export interface PlanDnsEntry extends ReapDnsRecord, DnsVerdict {}
export interface PlanServerEntry extends ReapServer, ServerVerdict {}

export interface ReapAccountSummary {
  owner: string;
  status: "orphan" | "kept";
  dnsOrphans: number;
  serverOrphans: number;
  dnsKept: number;
}

export interface ReapPlan {
  version: 1;
  generatedAt: string;
  apex: string;
  zoneRecords: number;
  knownAccounts: number;
  protectedAccounts: string[];
  /** False when the UpCloud token is not configured: servers were not looked at. */
  serversChecked: boolean;
  summary: {
    dnsTotal: number;
    dnsKeep: number;
    dnsOrphan: number;
    serversTotal: number;
    serversKeep: number;
    serversOrphan: number;
    zoneRecordsAfter: number;
  };
  accounts: ReapAccountSummary[];
  dns: PlanDnsEntry[];
  servers: PlanServerEntry[];
}

export async function buildPlan(deps: ReapDeps): Promise<ReapPlan> {
  if (!deps.dns) {
    throw new ReapRefusal(503, "dns-not-configured", "CLOUDFLARE_DNS_API_TOKEN and CLOUDFLARE_SERVICES_ZONE_ID are required.");
  }
  const known = await loadKnownAccounts(deps.db, deps.protectedAccounts);
  const records = await deps.dns.listAll();
  const dns: PlanDnsEntry[] = records.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    ...(r.content !== undefined ? { content: r.content } : {}),
    ...classifyDnsRecord(r, deps.apex, known, deps.protectedAccounts),
  }));
  const servers: PlanServerEntry[] = deps.cloud
    ? (await deps.cloud.listServersByLabelKey(REAP_DEMO_LABEL)).map((s) => ({
        ...s,
        ...classifyServer(s, known, deps.protectedAccounts),
      }))
    : [];
  const accounts = new Map<string, ReapAccountSummary>();
  const row = (owner: string): ReapAccountSummary => {
    let a = accounts.get(owner);
    if (!a) {
      a = { owner, status: "kept", dnsOrphans: 0, serverOrphans: 0, dnsKept: 0 };
      accounts.set(owner, a);
    }
    return a;
  };
  for (const d of dns) {
    if (!d.owner) continue;
    const a = row(d.owner);
    if (d.action === "orphan") {
      a.status = "orphan";
      a.dnsOrphans += 1;
    } else a.dnsKept += 1;
  }
  for (const s of servers) {
    if (!s.owner) continue;
    const a = row(s.owner);
    if (s.action === "orphan") {
      a.status = "orphan";
      a.serverOrphans += 1;
    }
  }
  const dnsOrphan = dns.filter((d) => d.action === "orphan").length;
  const serversOrphan = servers.filter((s) => s.action === "orphan").length;
  return {
    version: 1,
    generatedAt: new Date((deps.now ?? Date.now)()).toISOString(),
    apex: deps.apex,
    zoneRecords: dns.length,
    knownAccounts: known.names.size,
    protectedAccounts: [...deps.protectedAccounts],
    serversChecked: deps.cloud !== undefined,
    summary: {
      dnsTotal: dns.length,
      dnsKeep: dns.length - dnsOrphan,
      dnsOrphan,
      serversTotal: servers.length,
      serversKeep: servers.length - serversOrphan,
      serversOrphan,
      zoneRecordsAfter: dns.length - dnsOrphan,
    },
    accounts: [...accounts.values()].sort(
      (a, b) => Number(b.status === "orphan") - Number(a.status === "orphan") || a.owner.localeCompare(b.owner),
    ),
    dns,
    servers,
  };
}

export interface DeleteOneBody {
  kind?: unknown;
  id?: unknown;
  name?: unknown;
  type?: unknown;
  owner?: unknown;
}

export interface DeleteOneResult {
  status: number;
  body: Record<string, unknown>;
}

const DNS_ID_RE = /^[0-9a-f]{32}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 240);
}

/**
 * Deletes exactly one item after re-reading it and re-deciding from D1 as of
 * now. A plan is never trusted: an account that came back since, a record that
 * changed, or a shape the rules do not know all answer 409 and delete nothing.
 */
export async function deleteOne(deps: ReapDeps, body: DeleteOneBody | undefined): Promise<DeleteOneResult> {
  const log = deps.log ?? (() => undefined);
  const kind = body?.kind;
  if (kind !== "dns" && kind !== "server") {
    return { status: 400, body: { error: "kind must be dns or server" } };
  }
  const id = body?.id;
  if (typeof id !== "string" || !(kind === "dns" ? DNS_ID_RE.test(id) : UUID_RE.test(id))) {
    return { status: 400, body: { error: kind === "dns" ? "id must be a Cloudflare record id" : "id must be an UpCloud server UUID" } };
  }
  let known: KnownAccounts;
  try {
    known = await loadKnownAccounts(deps.db, deps.protectedAccounts);
  } catch (e) {
    if (e instanceof ReapRefusal) return { status: e.status, body: { error: e.message, code: e.code } };
    throw e;
  }

  if (kind === "dns") {
    if (!deps.dns) return { status: 503, body: { error: "DNS is not configured", code: "dns-not-configured" } };
    const name = body?.name;
    const type = body?.type;
    if (typeof name !== "string" || typeof type !== "string") {
      return { status: 400, body: { error: "name and type are required" } };
    }
    let live: ReapDnsRecord | null;
    try {
      live = await deps.dns.getById(id);
    } catch (e) {
      return { status: 502, body: { error: errText(e), code: "dns-read-failed", retryable: true } };
    }
    if (live === null) return { status: 200, body: { result: "gone", kind, id, name } };
    if (live.name.toLowerCase() !== name.toLowerCase() || live.type.toUpperCase() !== type.toUpperCase()) {
      return { status: 409, body: { error: "the record is not the one in the plan", code: "mismatch" } };
    }
    const verdict = classifyDnsRecord(live, deps.apex, known, deps.protectedAccounts);
    if (verdict.action !== "orphan") {
      log(`reap refused dns ${live.type} ${live.name}: ${verdict.reason}`);
      return { status: 409, body: { error: `not an orphan: ${verdict.reason}`, code: "not-orphan", reason: verdict.reason } };
    }
    try {
      await deps.dns.deleteById(id);
    } catch (e) {
      return { status: 502, body: { error: errText(e), code: "dns-delete-failed", retryable: true } };
    }
    log(`reap deleted dns ${live.type} ${live.name} (${verdict.owner})`);
    return { status: 200, body: { result: "deleted", kind, id, name: live.name, type: live.type, owner: verdict.owner } };
  }

  if (!deps.cloud) return { status: 503, body: { error: "UpCloud is not configured", code: "cloud-not-configured" } };
  let labels: Record<string, string> | null;
  try {
    labels = await deps.cloud.getServerLabels(id);
  } catch (e) {
    return { status: 502, body: { error: errText(e), code: "server-read-failed", retryable: true } };
  }
  if (labels === null) return { status: 200, body: { result: "gone", kind, id } };
  const verdict = classifyServer({ serverId: id, labels }, known, deps.protectedAccounts);
  if (verdict.action !== "orphan") {
    log(`reap refused server ${id}: ${verdict.reason}`);
    return { status: 409, body: { error: `not an orphan: ${verdict.reason}`, code: "not-orphan", reason: verdict.reason } };
  }
  if (typeof body?.owner === "string" && body.owner.toLowerCase() !== verdict.owner) {
    return { status: 409, body: { error: "the server is not the one in the plan", code: "mismatch" } };
  }
  try {
    await deps.cloud.destroyServer(id);
  } catch (e) {
    return { status: 502, body: { error: errText(e), code: "server-delete-failed", retryable: true } };
  }
  log(`reap destroyed server ${id} (${verdict.owner})`);
  return { status: 200, body: { result: "deleted", kind, id, owner: verdict.owner } };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export interface ReapRouteOptions {
  makeDns?: (env: ReapEnv) => ReapDnsClient | undefined;
  makeCloud?: (env: ReapEnv) => ReapCloudClient | undefined;
}

export async function handleReapRoute(
  request: Request,
  env: ReapEnv,
  opts: Required<ReapRouteOptions>,
): Promise<Response> {
  const auth = authorizeAdmin({ expected: env.FLAGSHIP_ADMIN_SECRET, provided: request.headers.get("x-admin-secret") });
  if (auth) return json(auth.body, auth.status);
  const path = new URL(request.url).pathname.slice(REAP_PATH_PREFIX.length);
  const wantsPost = path === "delete-one";
  if (path !== "list" && path !== "classify" && !wantsPost) return json({ error: "not found" }, 404);
  if (request.method !== (wantsPost ? "POST" : "GET")) return json({ error: "method not allowed" }, 405);
  if (!env.DB) return json({ error: "database unavailable" }, 503);
  const deps: ReapDeps = {
    db: env.DB,
    dns: opts.makeDns(env),
    cloud: opts.makeCloud(env),
    apex: (env.SERVICES_APEX ?? "flagship.services").toLowerCase(),
    protectedAccounts: protectedAccountsFrom(env),
    log: (line) => console.log(line),
  };
  try {
    if (path === "list") {
      if (!deps.dns) return json({ error: "DNS is not configured", code: "dns-not-configured" }, 503);
      const dns = await deps.dns.listAll();
      const servers = deps.cloud ? await deps.cloud.listServersByLabelKey(REAP_DEMO_LABEL) : [];
      return json({ apex: deps.apex, zoneRecords: dns.length, serversChecked: deps.cloud !== undefined, dns, servers }, 200);
    }
    if (path === "classify") return json(await buildPlan(deps), 200);
    let body: DeleteOneBody | undefined;
    try {
      body = (await request.json()) as DeleteOneBody;
    } catch {
      return json({ error: "body must be JSON" }, 400);
    }
    const r = await deleteOne(deps, body);
    return json(r.body, r.status);
  } catch (e) {
    if (e instanceof ReapRefusal) return json({ error: e.message, code: e.code }, e.status);
    return json({ error: errText(e), code: "upstream-failed", retryable: true }, 502);
  }
}
