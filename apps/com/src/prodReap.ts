/**
 * Prod reap: removes what the pre-GA scrub (docs/runbooks/pre-ga-scrub.md)
 * leaves behind, and every record an earlier DNS layout left at an account or
 * box name. The scrub deletes D1 rows only; the wiped accounts' DNS records in
 * the `flagship.services` zone (the zone is capped at 200) and their demo
 * UpCloud servers stay until reaped here.
 *
 * Admin routes (x-admin-secret, like /api/admin/rate-limits), driven by
 * scripts/reap-orphans.mjs and scripts/dns-zone-health.mjs. Nothing here
 * deletes by itself: only `delete-one` writes, one DNS record or one server per
 * call, and it re-checks the item against D1 and the zone right then.
 *
 *   GET  /api/admin/reap/list         the zone's records and the Flagship-labelled
 *                                     UpCloud servers, unclassified
 *   GET  /api/admin/reap/classify     the same, each marked KEEP or ORPHAN with a
 *                                     reason, plus per-account counts (the plan)
 *   GET  /api/admin/reap/zone-health  read-only check of the root-wildcard layout
 *   POST /api/admin/reap/delete-one   {kind:"dns",id,name,type} or
 *                                     {kind:"server",id,owner}
 *
 * The zone holds `*.<apex>` A/AAAA at the relay and the apex CAA pair and
 * nothing at an account or box name (docs/wildcard-dns.md). A record at such a
 * name stops that wildcard for every name below it, so a record at
 * `<user>`, `*.<user>`, `<box>.<user>` or `*.<box>.<user>` (A, AAAA, CAA, TXT;
 * not `_acme-challenge`) is TRIMMED when one of these holds:
 *
 *   1. no account of that name is known to D1 (usernames, aliases, servers,
 *      demo users, auth codes);
 *   2. the account has no live (unrevoked) server and no install in flight;
 *   3. the account is live and the zone's root wildcard is in place and points
 *      at the relay: the record is redundant and blocks the wildcard. Before the
 *      wildcard exists the account's own records are all that resolve its names,
 *      so they are KEPT.
 *
 * A `_acme-challenge` TXT is kept only while its account is live and the TXT is
 * young (the hourly sweep clears stale ones; this clears them too).
 *
 * Everything else (the apex and its CAA, the root wildcard, system records,
 * gym, a host record at a single label that is not an account, anything
 * unrecognised, the protected store-review account) is KEEP. A D1 that does not
 * hold every protected account is refused outright: that is the wrong database
 * or the wipe went too far.
 */

import {
  authorizeAdmin,
  validateServerLabel,
  validateUserLabel,
  type RelayAddress,
} from "@flagship/control-plane";
import {
  PROTECTED_DNS_ACCOUNTS,
  RELAY_FALLBACK_LABEL,
  evaluateZoneHealth,
  isProtectedDnsName,
  legacyDeletionOrder,
  rootWildcardStatus,
  type ZoneHealth,
} from "@flagship/services-zone";
import type { D1Database } from "@flagship/storage";

export const REAP_PATH_PREFIX = "/api/admin/reap/";
export const DEFAULT_PROTECTED_ACCOUNTS = [...PROTECTED_DNS_ACCOUNTS];
/** UpCloud label every Worker-created demo/sample-user server carries. */
export const REAP_DEMO_LABEL = "flagship-demo";
/** Label of the gym (and any other parallel environment); never reaped here. */
export const REAP_ENV_LABEL = "flagship-env";

export interface ReapDnsRecord {
  id: string;
  name: string;
  type: string;
  content?: string;
  proxied?: boolean;
  created_on?: string;
  modified_on?: string;
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
  /** Comma list of accounts protected IN ADDITION to PROTECTED_DNS_ACCOUNTS (which can never be un-protected). */
  REAP_PROTECTED_ACCOUNTS?: string;
  /** The relay's address: what the root wildcard must point at. */
  SERVICES_PASSTHROUGH_IPV4?: string;
  SERVICES_PASSTHROUGH_IPV6?: string;
}

export interface ReapDeps {
  db: D1Database;
  dns: ReapDnsClient | undefined;
  cloud: ReapCloudClient | undefined;
  apex: string;
  protectedAccounts: readonly string[];
  /** The relay's address. Without it the root wildcard can't be verified, so live accounts' records are kept. */
  relay?: RelayAddress;
  now?: () => number;
  log?: (line: string) => void;
}

export interface KnownAccounts {
  names: Set<string>;
  serverIds: Set<string>;
  /**
   * Accounts with an unrevoked server or an install in flight. Absent when D1
   * could not say (a table or column missing): rule 2 is then not applied.
   */
  liveAccounts?: Set<string>;
}

export type ReapAction = "keep" | "orphan";

export type TrimClass = "gone" | "block" | "stale-challenge";

export interface DnsVerdict {
  action: ReapAction;
  /** The account label the name belongs to, when it has a recognisable shape. */
  owner: string | null;
  reason: string;
  /** Why an ORPHAN goes: its account is gone, it blocks the root wildcard, or it is a stale challenge. */
  trim?: TrimClass;
  /** Deletion order within a plan: lower first, so no name goes dark between deletes. */
  order?: number;
}

export interface ClassifyContext {
  /** Is the zone's root wildcard in place and pointing at the relay? */
  rootReady?: boolean;
  now?: number;
}

const NAME_CHARS = /^[a-z0-9_*.-]+$/;
/** Record types Flagship ever wrote at account names; anything else is left for a human. */
const TRIM_TYPES = new Set(["A", "AAAA", "CAA", "TXT"]);
const STALE_CHALLENGE_MS = 60 * 60 * 1000;

export function classifyDnsRecord(
  rec: { name: string; type: string; content?: string; created_on?: string; modified_on?: string },
  apexIn: string,
  known: KnownAccounts,
  protectedAccounts: readonly string[],
  ctx: ClassifyContext = {},
): DnsVerdict {
  const apex = apexIn.toLowerCase().replace(/\.$/, "");
  const name = rec.name.toLowerCase().replace(/\.$/, "");
  const type = rec.type.toUpperCase();
  if (name === apex) return { action: "keep", owner: null, reason: "the zone apex" };
  if (!name.endsWith(`.${apex}`)) return { action: "keep", owner: null, reason: "outside the services zone apex" };
  const rel = name.slice(0, -(apex.length + 1));
  if (!NAME_CHARS.test(rel)) return { action: "keep", owner: null, reason: "unrecognised name" };
  if (rel === "*") return { action: "keep", owner: null, reason: "the zone's root wildcard" };
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
  if (ownerLabel === RELAY_FALLBACK_LABEL) {
    return {
      action: "keep",
      owner: null,
      reason: `${RELAY_FALLBACK_LABEL} is reserved for the Android relay fallback; a record here is wrong, but it is not an account's to reap: remove it by hand (zone-health lists it)`,
    };
  }
  const user = validateUserLabel(ownerLabel);
  if (!user.ok) return { action: "keep", owner: null, reason: "system or reserved label" };
  const owner = user.label;
  if (labels.length === 2 && !validateServerLabel(labels[0]!).ok) {
    return { action: "keep", owner: null, reason: "unrecognised name" };
  }
  const order = legacyDeletionOrder({ name, type }, apex);
  const orphan = (reason: string, trim: TrimClass): DnsVerdict => ({ action: "orphan", owner, reason, trim, order });
  const goneOrIdle = (): DnsVerdict | null => {
    if (!known.names.has(owner)) return orphan("no account of this name in D1", "gone");
    if (known.liveAccounts && !known.liveAccounts.has(owner)) {
      return orphan("the account has no live server or install in flight (nothing is left to serve)", "gone");
    }
    return null;
  };

  if (kind === "acme") {
    if (type !== "TXT") return { action: "keep", owner: null, reason: `not a record Flagship publishes (${type})` };
    if (protectedAccounts.includes(owner)) return { action: "keep", owner, reason: "protected account" };
    const idle = goneOrIdle();
    if (idle) return idle;
    const stamp = Date.parse(rec.modified_on ?? rec.created_on ?? "");
    if (ctx.now !== undefined && Number.isFinite(stamp) && stamp < ctx.now - STALE_CHALLENGE_MS) {
      return orphan("a challenge TXT older than an hour (the certificate was issued or abandoned)", "stale-challenge");
    }
    return { action: "keep", owner, reason: "a challenge in flight for a live account" };
  }

  if (!TRIM_TYPES.has(type)) return { action: "keep", owner: null, reason: `not a record Flagship publishes (${type})` };
  // `<label>.<apex>` holding an A, AAAA or TXT is a host record (hub, www, ...)
  // unless the label is an account: it only blocks names below it, and none exist.
  if (kind === "plain" && labels.length === 1 && type !== "CAA" && !known.names.has(owner)) {
    return { action: "keep", owner: null, reason: "a host record, not an account's" };
  }
  if (protectedAccounts.includes(owner)) {
    return { action: "keep", owner, reason: "protected account (its own records keep it working; trim by hand once its review ends)" };
  }
  const idle = goneOrIdle();
  if (idle) return idle;
  if (!ctx.rootReady) {
    return {
      action: "keep",
      owner,
      reason: "the zone's root wildcard is not in place yet, so this record still resolves the account: create it first (docs/runbooks/final-deploy.md)",
    };
  }
  return orphan(
    "blocks the root wildcard: a record at an account or box name stops it for every name below; the zone wildcard answers this name",
    "block",
  );
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

/** Accounts that still serve: an unrevoked server, or an unexpired install order. */
const LIVE_QUERIES: { sql: string; bindNow?: true }[] = [
  { sql: "SELECT username AS v FROM servers WHERE revoked_at IS NULL" },
  { sql: "SELECT username AS v FROM auth_codes WHERE status = 'active' AND expires_at > ?", bindNow: true },
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
export async function loadKnownAccounts(
  db: D1Database,
  protectedAccounts: readonly string[],
  now: number = Date.now(),
): Promise<KnownAccounts> {
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
  // Which accounts still serve. If D1 cannot say (a table or column is missing),
  // leave it unknown and the "no live server" rule is simply not applied.
  let liveAccounts: Set<string> | undefined = new Set<string>();
  for (const q of LIVE_QUERIES) {
    try {
      const stmt = db.prepare(q.sql);
      const rows = (await (q.bindNow ? stmt.bind(now) : stmt).all<{ v: unknown }>()).results;
      for (const r of rows) if (typeof r.v === "string" && r.v !== "") liveAccounts.add(r.v.toLowerCase());
    } catch (e) {
      if (/no such (table|column)/i.test(e instanceof Error ? e.message : String(e))) {
        liveAccounts = undefined;
        break;
      }
      throw new ReapRefusal(502, "d1-unavailable", "Could not read the account tables; nothing was classified.");
    }
  }
  return { names, serverIds, ...(liveAccounts ? { liveAccounts } : {}) };
}

export function protectedAccountsFrom(env: ReapEnv): string[] {
  const extra = (env.REAP_PROTECTED_ACCOUNTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [...new Set([...DEFAULT_PROTECTED_ACCOUNTS, ...extra])];
}

export interface PlanDnsEntry extends ReapDnsRecord, DnsVerdict {}

/** The root wildcard's state in a zone listing, against the relay the Worker is configured with. */
function rootReadyIn(records: readonly ReapDnsRecord[], apex: string, relay: RelayAddress | undefined): boolean {
  return relay !== undefined && rootWildcardStatus(records, apex, relay).ready;
}
export interface PlanServerEntry extends ReapServer, ServerVerdict {}

export interface ReapAccountSummary {
  owner: string;
  /** orphan: the account is gone; trim: it stays, some records go; kept: nothing to do. */
  status: "orphan" | "trim" | "kept";
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
  /** Is `*.<apex>` in the zone and pointing at the relay? Until it is, live accounts' records are kept. */
  rootWildcardReady: boolean;
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

const STATUS_ORDER = { orphan: 0, trim: 1, kept: 2 } as const;

export async function buildPlan(deps: ReapDeps): Promise<ReapPlan> {
  if (!deps.dns) {
    throw new ReapRefusal(503, "dns-not-configured", "CLOUDFLARE_DNS_API_TOKEN and CLOUDFLARE_SERVICES_ZONE_ID are required.");
  }
  const known = await loadKnownAccounts(deps.db, deps.protectedAccounts, (deps.now ?? Date.now)());
  const records = await deps.dns.listAll();
  const ctx: ClassifyContext = { rootReady: rootReadyIn(records, deps.apex, deps.relay), now: (deps.now ?? Date.now)() };
  const dns: PlanDnsEntry[] = records.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    ...(r.content !== undefined ? { content: r.content } : {}),
    ...classifyDnsRecord(r, deps.apex, known, deps.protectedAccounts, ctx),
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
      if (a.status === "kept") a.status = known.names.has(d.owner) ? "trim" : "orphan";
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
    rootWildcardReady: ctx.rootReady === true,
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
      (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.owner.localeCompare(b.owner),
    ),
    dns,
    servers,
  };
}

export interface ZoneHealthReport extends ZoneHealth {
  generatedAt: string;
  /** The relay the zone is checked against (from the Worker's configuration). */
  relay: RelayAddress;
}

/**
 * Read-only check that the zone is in the root-wildcard layout: `*.<apex>` A and
 * AAAA at exactly the relay (DNS only), the apex CAA pair, and no record at any
 * account or box name. `ok: false` lists each problem with its record id. The
 * owner runs it after the manual DNS step and weekly (npm run zone-health).
 */
export async function buildZoneHealth(deps: ReapDeps): Promise<ZoneHealthReport> {
  if (!deps.dns) {
    throw new ReapRefusal(503, "dns-not-configured", "CLOUDFLARE_DNS_API_TOKEN and CLOUDFLARE_SERVICES_ZONE_ID are required.");
  }
  if (!deps.relay) {
    throw new ReapRefusal(503, "relay-not-configured", "SERVICES_PASSTHROUGH_IPV4 is not set: the zone can't be checked against the relay.");
  }
  const known = await loadKnownAccounts(deps.db, deps.protectedAccounts, (deps.now ?? Date.now)());
  const records = await deps.dns.listAll();
  const now = (deps.now ?? Date.now)();
  const health = evaluateZoneHealth(records, {
    apex: deps.apex,
    relay: deps.relay,
    accounts: known.names,
    skipUsers: deps.protectedAccounts,
    now,
  });
  return { ...health, generatedAt: new Date(now).toISOString(), relay: deps.relay };
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
    known = await loadKnownAccounts(deps.db, deps.protectedAccounts, (deps.now ?? Date.now)());
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
    // The store-review account's records are never deleted, whatever the plan or the env say.
    if (isProtectedDnsName(live.name, deps.apex)) {
      log(`reap refused dns ${live.type} ${live.name}: protected account`);
      return { status: 409, body: { error: "not an orphan: protected account", code: "not-orphan", reason: "protected account" } };
    }
    // The root wildcard must be in the zone right now, not as the plan saw it.
    let ctx: ClassifyContext;
    try {
      ctx = { rootReady: rootReadyIn(await deps.dns.listAll(), deps.apex, deps.relay), now: (deps.now ?? Date.now)() };
    } catch (e) {
      return { status: 502, body: { error: errText(e), code: "dns-read-failed", retryable: true } };
    }
    const verdict = classifyDnsRecord(live, deps.apex, known, deps.protectedAccounts, ctx);
    if (verdict.action !== "orphan") {
      log(`reap refused dns ${live.type} ${live.name}: ${verdict.reason}`);
      return { status: 409, body: { error: `not an orphan: ${verdict.reason}`, code: "not-orphan", reason: verdict.reason } };
    }
    try {
      await deps.dns.deleteById(id);
    } catch (e) {
      return { status: 502, body: { error: errText(e), code: "dns-delete-failed", retryable: true } };
    }
    log(`reap deleted dns ${live.type} ${live.name} (${verdict.owner}: ${verdict.reason})`);
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
  if (path !== "list" && path !== "classify" && path !== "zone-health" && !wantsPost) return json({ error: "not found" }, 404);
  if (request.method !== (wantsPost ? "POST" : "GET")) return json({ error: "method not allowed" }, 405);
  if (!env.DB) return json({ error: "database unavailable" }, 503);
  const deps: ReapDeps = {
    db: env.DB,
    dns: opts.makeDns(env),
    cloud: opts.makeCloud(env),
    apex: (env.SERVICES_APEX ?? "flagship.services").toLowerCase(),
    protectedAccounts: protectedAccountsFrom(env),
    ...(env.SERVICES_PASSTHROUGH_IPV4
      ? {
          relay: {
            servicesIpv4: env.SERVICES_PASSTHROUGH_IPV4,
            ...(env.SERVICES_PASSTHROUGH_IPV6 ? { servicesIpv6: env.SERVICES_PASSTHROUGH_IPV6 } : {}),
          },
        }
      : {}),
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
    if (path === "zone-health") return json(await buildZoneHealth(deps), 200);
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
