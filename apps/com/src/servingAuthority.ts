/**
 * The serving authority on `.com` (docs/architecture-v2/serving-wiring.md §1; records and rules in
 * docs/architecture-v2/issuance-and-lease-records.md; every rule is a call into
 * packages/protocol/src/servingAuthority.ts).
 *
 *   POST /api/accounts/:u/serving-policy        {policy, signature}         the admin key's serving-policy/v1
 *   POST /api/accounts/:u/renewal-delegations   {delegation, signature}     the admin key's renewal-key-delegation/v1
 *   POST /api/accounts/:u/serving-leases        {leases:[{lease, signature, delegationPub?}]}
 *   GET  /api/accounts/:u/serving               (account read token) per server: policy, best lease, until
 *   GET  /api/internal/serving/:u/:boxPub       (services control secret) what a relay decides a box with
 *   GET  /api/internal/serving-revocations?since=N   (services control secret) the signed log after N
 *   GET  /api/internal/serving-feed?relay=<id>  (services control secret) WebSocket to the ServingFeed DO
 *   GET  /api/serving/revocation-key            the log's Ed25519 public key
 *
 * Signatures are checked when a record is written. Reads hand stored records out as they are: the box and
 * the relay verify them themselves, and the account read runs `servingDecision` on the best lease only.
 * The revocation log is filled by D1 triggers (migration 0120) and signed here, in sequence order.
 */
import { constantTimeEqual } from "@flagship/control-plane";
import {
  canonicalRenewalKeyDelegation,
  canonicalServingLease,
  canonicalServingPolicy,
  ed,
  emptyRevocationState,
  SERVING_CLOCK_SKEW_MS,
  servingDecision,
  signServingRecord,
  verifyServingRecord,
  type RenewalKeyDelegation,
  type RevocationEntry,
  type ServingLease,
  type ServingPolicy,
  type SignedServingRecord,
} from "@flagship/protocol";
import type { D1Database, UsernameRecord, UsernameStorage } from "@flagship/storage";

export interface ServingFeedNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export interface ServingEnv {
  DB?: D1Database;
  /** The relay's bearer secret for every `/api/internal/*` route. */
  SERVICES_CONTROL_SECRET?: string;
  /** Worker secret: the revocation log's Ed25519 seed, 64 hex. */
  SERVING_REVOCATION_SEED?: string;
  SERVING_FEED?: ServingFeedNamespace;
}

export interface ServingRouteDeps {
  usernames: UsernameStorage;
  /** Null when the account read may go ahead (the account read token gate). */
  gateRead(username: string): Promise<Response | null>;
  waitUntil?(p: Promise<unknown>): void;
  now?: () => number;
}

const RE = {
  POLICY: /^\/api\/accounts\/([^/]+)\/serving-policy$/,
  DELEGATIONS: /^\/api\/accounts\/([^/]+)\/renewal-delegations$/,
  LEASES: /^\/api\/accounts\/([^/]+)\/serving-leases$/,
  READ: /^\/api\/accounts\/([^/]+)\/serving$/,
  INTERNAL_BOX: /^\/api\/internal\/serving\/([^/]+)\/([0-9a-fA-F]{64})$/,
};
export const SERVING_ACCOUNT_ROUTES: readonly RegExp[] = [RE.POLICY, RE.DELEGATIONS, RE.LEASES, RE.READ];
export const SERVING_REVOCATIONS_PATH = "/api/internal/serving-revocations";
export const SERVING_FEED_PATH = "/api/internal/serving-feed";
export const SERVING_REVOCATION_KEY_PATH = "/api/serving/revocation-key";
export const SERVING_FEED_NAME = "serving-feed";

const MAX_LEASES_PER_CALL = 64;
const MAX_ENTRIES_PER_READ = 1000;
/** A relay that acknowledged within this window counts toward "confirmed by every relay". */
export const RELAY_FRESH_MS = 10 * 60_000;
const HEX64 = /^[0-9a-f]{64}$/;
const RELAY_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export function isServingPath(path: string): boolean {
  return (
    path === SERVING_REVOCATIONS_PATH ||
    path === SERVING_FEED_PATH ||
    path === SERVING_REVOCATION_KEY_PATH ||
    RE.INTERNAL_BOX.test(path) ||
    SERVING_ACCOUNT_ROUTES.some((re) => re.test(path))
  );
}

/**
 * Writes that can commit a revocation entry (server revoke, delete, transfer and migration hand-overs,
 * account deletion and reclaim, device removal). After one succeeds the Worker asks the feed to sign
 * and push at once; the feed's beat catches anything else within a beat.
 */
const REVOKING_WRITES: readonly RegExp[] = [
  /^\/api\/server-registry\/revoke$/,
  /^\/api\/server\/by-domain\/[^/]+\/revoke$/,
  /^\/api\/account\/self-delete$/,
  /^\/api\/admin\/username\/[^/]+\/reclaim$/,
  /^\/api\/accounts\/[^/]+\/devices\/[^/]+$/,
  /^\/api\/users\/[^/]+\/device-grants\/revoke$/,
  /^\/api\/server\/[^/]+\/transfer\//,
  /^\/api\/server\/[^/]+\/migration\/take-over$/,
  /^\/api\/server\/[^/]+\/decommission/,
];

export function mayCommitRevocation(method: string, path: string): boolean {
  return method !== "GET" && method !== "HEAD" && REVOKING_WRITES.some((re) => re.test(path));
}

// ── responses ─────────────────────────────────────────────────────────────

const NO_STORE = { "content-type": "application/json", "cache-control": "private, no-store" };

function json(body: unknown, status = 200, headers: Record<string, string> = NO_STORE): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

const SENTENCES = {
  "serving-malformed": "This request could not be read.",
  "serving-clock": "This device's clock is ahead. Check its date and time, then try again.",
  "serving-account": "This record is for another account.",
  "serving-unknown-box": "This server isn't one of this account's servers.",
  "serving-reg-gen": "This server was set up again since. Reload it and try again.",
  "serving-policy-signature": "Only an admin device of this account can change this setting.",
  "serving-policy-stale": "A newer setting for this server is already saved. Reload it and try again.",
  "renewal-delegation-signature": "Only an admin device of this account can add a renewal key.",
  "renewal-delegation-device": "This device is no longer part of the account.",
  "renewal-key-revoked": "This renewal key was removed. Sign in again on this device to make a new one.",
  "renewal-key-taken": "This renewal key belongs to another account.",
  "serving-not-configured": "Serving records aren't available right now.",
  "unauthorized": "Not authorized.",
} as const;
type ServingCode = keyof typeof SENTENCES;

function refuse(status: number, code: ServingCode): Response {
  return json({ error: SENTENCES[code], code }, status);
}

/** Per-lease refusal codes in a `/serving-leases` answer. */
export type LeaseRefusal =
  | "serving-lease-malformed"
  | "serving-lease-account"
  | "serving-lease-unknown-box"
  | "serving-lease-reg-gen"
  | "serving-lease-no-limit"
  | "serving-lease-policy-gen"
  | "serving-lease-delegation"
  | "serving-lease-key-revoked"
  | "serving-lease-invalid"
  | "serving-lease-expired"
  | "serving-policy-signature";

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function adminKeyOf(user: UsernameRecord): string {
  return (user.adminRootPubHex ?? user.irkPubHex).toLowerCase();
}

function bearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  const m = h ? /^Bearer\s+(.+)$/i.exec(h.trim()) : null;
  return m ? m[1]!.trim() : null;
}

function internalRefusal(request: Request, env: ServingEnv): Response | null {
  if (!env.SERVICES_CONTROL_SECRET) return refuse(503, "serving-not-configured");
  const presented = bearer(request);
  if (!presented || !constantTimeEqual(presented, env.SERVICES_CONTROL_SECRET)) return refuse(401, "unauthorized");
  return null;
}

// ── record shapes (only the protocol's fields are kept) ───────────────────

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parsePolicy(v: unknown): ServingPolicy | null {
  const o = asObject(v);
  if (!o) return null;
  const p = {
    account: o.account, box: o.box, regGen: o.regGen, policyGen: o.policyGen, grace: o.grace,
    onLapse: o.onLapse, scopeSha256: o.scopeSha256, issuedAt: o.issuedAt,
  } as ServingPolicy;
  try {
    canonicalServingPolicy(p);
    return p;
  } catch {
    return null;
  }
}

function parseLease(v: unknown): ServingLease | null {
  const o = asObject(v);
  if (!o) return null;
  const l = {
    account: o.account, box: o.box, regGen: o.regGen, policyGen: o.policyGen, leaseId: o.leaseId,
    issuedAt: o.issuedAt, notAfter: o.notAfter,
  } as ServingLease;
  try {
    canonicalServingLease(l);
    return l;
  } catch {
    return null;
  }
}

function parseDelegation(v: unknown): RenewalKeyDelegation | null {
  const o = asObject(v);
  if (!o) return null;
  const d = { account: o.account, alg: o.alg, renewalPub: o.renewalPub, deviceId: o.deviceId, issuedAt: o.issuedAt } as RenewalKeyDelegation;
  try {
    canonicalRenewalKeyDelegation(d);
    return d;
  } catch {
    return null;
  }
}

const isSig = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{128}$/.test(s);

// ── D1 rows ───────────────────────────────────────────────────────────────

interface ServerRow {
  server_domain: string;
  box_pub: string;
  reg_gen: number;
  revoked_at: number | null;
}
interface PolicyRow {
  box_pub: string;
  reg_gen: number;
  policy_gen: number;
  record_json: string;
  signature: string;
}
interface LeaseRow {
  box_pub: string;
  signer_pub: string;
  reg_gen: number;
  policy_gen: number;
  record_json: string;
  signature: string;
  delegation_pub: string | null;
  not_after: number;
}
interface DelegationRow {
  renewal_pub: string;
  username: string;
  device_id: string;
  record_json: string;
  signature: string;
  revoked_at: number | null;
}
interface LogRow {
  sequence: number;
  kind: string;
  account: string;
  subject: string;
  generation: number;
  revoked_at: number;
  signature: string | null;
}

const SQL = {
  servers: "SELECT server_domain, lower(identity_pubkey_hex) AS box_pub, reg_gen, revoked_at FROM servers WHERE username = ?",
  policies: "SELECT box_pub, reg_gen, policy_gen, record_json, signature FROM serving_policies WHERE username = ?",
  leases: "SELECT box_pub, signer_pub, reg_gen, policy_gen, record_json, signature, delegation_pub, not_after FROM serving_leases WHERE username = ?",
  delegations: "SELECT renewal_pub, username, device_id, record_json, signature, revoked_at FROM renewal_delegations WHERE username = ?",
};

/** Reads started together: through `.com`'s RequestD1 they leave as one D1 batch with any other reads of the tick. */
async function readAll<T>(db: D1Database, stmts: Array<[string, unknown[]]>): Promise<T[][]> {
  const results = await Promise.all(stmts.map(([sql, args]) => db.prepare(sql).bind(...args).all<T>()));
  return results.map((r) => r.results ?? []);
}

/** The account's live row for a box key (the highest generation if a key was registered twice). */
function liveServer(rows: readonly ServerRow[], box: string): ServerRow | null {
  let best: ServerRow | null = null;
  for (const r of rows) {
    if (r.box_pub !== box || r.revoked_at != null) continue;
    if (!best || r.reg_gen > best.reg_gen) best = r;
  }
  return best;
}

function currentServer(rows: readonly ServerRow[], box: string): ServerRow | null {
  return liveServer(rows, box) ?? rows.filter((r) => r.box_pub === box).sort((a, b) => b.reg_gen - a.reg_gen)[0] ?? null;
}

function signed<T>(recordJson: string, signature: string): SignedServingRecord<T> | null {
  try {
    return { record: JSON.parse(recordJson) as T, signature };
  } catch {
    return null;
  }
}

/** A stored lease as the relay and the box take it: `delegationPub` names the renewal key that signed it, and
 *  `delegation` carries that key's admin-signed record so `servingDecision` can take the lease as it is. */
type LeaseWithDelegation = SignedServingRecord<ServingLease> & {
  delegationPub?: string;
  delegation?: SignedServingRecord<RenewalKeyDelegation>;
};

function leasesFor(
  leases: readonly LeaseRow[],
  delegations: ReadonlyMap<string, DelegationRow>,
  box: string,
  regGen: number,
): Array<LeaseWithDelegation & { notAfter: number }> {
  const out: Array<LeaseWithDelegation & { notAfter: number }> = [];
  for (const l of leases) {
    if (l.box_pub !== box || l.reg_gen !== regGen) continue;
    const s = signed<ServingLease>(l.record_json, l.signature);
    if (!s) continue;
    if (l.delegation_pub) {
      const d = delegations.get(l.delegation_pub);
      if (!d || d.revoked_at != null) continue;
      const ds = signed<RenewalKeyDelegation>(d.record_json, d.signature);
      if (!ds) continue;
      out.push({ ...s, delegationPub: l.delegation_pub, delegation: ds, notAfter: l.not_after });
    } else {
      out.push({ ...s, notAfter: l.not_after });
    }
  }
  return out.sort((a, b) => b.notAfter - a.notAfter);
}

const stripNotAfter = ({ notAfter: _n, ...rest }: LeaseWithDelegation & { notAfter: number }): LeaseWithDelegation => rest;

export interface ServingBundle {
  regGen: number;
  revoked: boolean;
  policy: SignedServingRecord<ServingPolicy> | null;
  leases: LeaseWithDelegation[];
  delegations: Array<SignedServingRecord<RenewalKeyDelegation>>;
}

/** Everything stored for one box, unverified (the box and the relay verify it themselves). Null: no such box. */
export async function servingBundle(db: D1Database, username: string, box: string): Promise<ServingBundle | null> {
  const u = username.toLowerCase();
  const b = box.toLowerCase();
  const [servers, policies, leases, delegations] = await readAll<unknown>(db, [
    [SQL.servers, [u]],
    ["SELECT box_pub, reg_gen, policy_gen, record_json, signature FROM serving_policies WHERE username = ? AND box_pub = ?", [u, b]],
    ["SELECT box_pub, signer_pub, reg_gen, policy_gen, record_json, signature, delegation_pub, not_after FROM serving_leases WHERE username = ? AND box_pub = ?", [u, b]],
    [SQL.delegations, [u]],
  ]);
  const server = currentServer(servers as ServerRow[], b);
  if (!server) return null;
  const live = new Map<string, DelegationRow>();
  for (const d of delegations as DelegationRow[]) if (d.revoked_at == null) live.set(d.renewal_pub, d);
  const policyRow = (policies as PolicyRow[]).find((p) => p.reg_gen === server.reg_gen);
  return {
    regGen: server.reg_gen,
    revoked: server.revoked_at != null,
    policy: policyRow ? signed<ServingPolicy>(policyRow.record_json, policyRow.signature) : null,
    leases: leasesFor(leases as LeaseRow[], live, b, server.reg_gen).map(stripNotAfter),
    delegations: [...live.values()].flatMap((d) => {
      const s = signed<RenewalKeyDelegation>(d.record_json, d.signature);
      return s ? [s] : [];
    }),
  };
}

/** The heartbeat reply's `serving` block for a box (daemon-status). */
export async function servingForBox(
  db: D1Database,
  server: { username: string; identityPubKeyHex: string },
): Promise<{ regGen: number; policy: SignedServingRecord<ServingPolicy> | null; leases: LeaseWithDelegation[]; delegations: Array<SignedServingRecord<RenewalKeyDelegation>> } | undefined> {
  const b = await servingBundle(db, server.username, server.identityPubKeyHex);
  if (!b) return undefined;
  return { regGen: b.regGen, policy: b.policy, leases: b.leases, delegations: b.delegations };
}

// ── the revocation log ────────────────────────────────────────────────────

export function revocationKeyPair(seedHex: string | undefined): { seed: Uint8Array; publicKey: string } | null {
  if (!seedHex || !HEX64.test(seedHex.trim().toLowerCase())) return null;
  const seed = ed.etc.hexToBytes(seedHex.trim().toLowerCase());
  return { seed, publicKey: ed.etc.bytesToHex(ed.getPublicKey(seed)) };
}

function entryOf(r: LogRow): RevocationEntry {
  return {
    sequence: r.sequence,
    kind: r.kind as RevocationEntry["kind"],
    account: r.account,
    subject: r.subject,
    generation: r.generation,
    revokedAt: r.revoked_at,
  };
}

/**
 * Sign every entry the triggers left unsigned, in sequence order. Ed25519 is deterministic, so a
 * second signer racing this one writes the same bytes. Returns the newest signed sequence.
 */
export async function signPendingRevocations(db: D1Database, seedHex: string | undefined): Promise<number> {
  const key = revocationKeyPair(seedHex);
  if (!key) throw new Error("SERVING_REVOCATION_SEED is not set");
  for (;;) {
    const pending = await db
      .prepare("SELECT sequence, kind, account, subject, generation, revoked_at, signature FROM revocation_log WHERE signature IS NULL ORDER BY sequence LIMIT 200")
      .all<LogRow>();
    const rows = pending.results ?? [];
    if (rows.length === 0) break;
    const updates = [];
    for (const r of rows) {
      const entry = entryOf(r);
      let sig: string;
      try {
        sig = ed.etc.bytesToHex(signServingRecord("revocation-entry", entry, (m) => ed.sign(m, key.seed)));
      } catch (e) {
        console.error(JSON.stringify({ event: "serving-revocation-unsignable", sequence: r.sequence, error: String(e) }));
        break;
      }
      updates.push(
        db.prepare("UPDATE revocation_log SET entry_json = ?, signature = ? WHERE sequence = ? AND signature IS NULL").bind(JSON.stringify(entry), sig, r.sequence),
      );
    }
    if (updates.length === 0) break;
    await db.batch(updates);
    if (updates.length < rows.length || rows.length < 200) break;
  }
  const top = await db.prepare("SELECT MAX(sequence) AS seq FROM revocation_log WHERE signature IS NOT NULL").first<{ seq: number | null }>();
  return top?.seq ?? 0;
}

/** Signed entries after `since`, contiguous from it (stops before the first unsigned one). */
export async function revocationsSince(
  db: D1Database,
  since: number,
  limit = MAX_ENTRIES_PER_READ,
): Promise<Array<{ entry: RevocationEntry; signature: string }>> {
  const r = await db
    .prepare("SELECT sequence, kind, account, subject, generation, revoked_at, signature FROM revocation_log WHERE sequence > ? ORDER BY sequence LIMIT ?")
    .bind(since, limit)
    .all<LogRow>();
  const out: Array<{ entry: RevocationEntry; signature: string }> = [];
  for (const row of r.results ?? []) {
    if (!row.signature) break;
    out.push({ entry: entryOf(row), signature: row.signature });
  }
  return out;
}

// ── the feed ──────────────────────────────────────────────────────────────

function feedStub(env: ServingEnv): { fetch(request: Request): Promise<Response> } | null {
  if (!env.SERVING_FEED) return null;
  return env.SERVING_FEED.get(env.SERVING_FEED.idFromName(SERVING_FEED_NAME));
}

/** Tell the feed something changed. Never throws: the relays also re-read on their own. */
export async function pokeServingFeed(
  env: ServingEnv,
  message: { type: "flush" } | { type: "changed"; username: string; boxPub: string },
): Promise<void> {
  const stub = feedStub(env);
  if (!stub) return;
  try {
    await stub.fetch(new Request("https://serving-feed/notify", { method: "POST", body: JSON.stringify(message) }));
  } catch (e) {
    console.error(JSON.stringify({ event: "serving-feed-poke-failed", error: String(e) }));
  }
}

function afterResponse(deps: ServingRouteDeps, p: Promise<void>): Promise<void> {
  if (deps.waitUntil) {
    deps.waitUntil(p);
    return Promise.resolve();
  }
  return p;
}

// ── routes ────────────────────────────────────────────────────────────────

export async function tryServingRoute(request: Request, env: ServingEnv, deps: ServingRouteDeps): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const db = env.DB;
  if (!db) return null;
  const now = (deps.now ?? Date.now)();
  let m: RegExpMatchArray | null;

  if (path === SERVING_REVOCATION_KEY_PATH && method === "GET") {
    const key = revocationKeyPair(env.SERVING_REVOCATION_SEED);
    if (!key) return refuse(503, "serving-not-configured");
    return json({ alg: "ed25519", publicKey: key.publicKey }, 200, { "content-type": "application/json", "cache-control": "public, max-age=300" });
  }

  if (path === SERVING_REVOCATIONS_PATH && method === "GET") {
    const denied = internalRefusal(request, env);
    if (denied) return denied;
    if (!revocationKeyPair(env.SERVING_REVOCATION_SEED)) return refuse(503, "serving-not-configured");
    const since = Number(url.searchParams.get("since") ?? "0");
    if (!Number.isSafeInteger(since) || since < 0) return refuse(400, "serving-malformed");
    const sequence = await signPendingRevocations(db, env.SERVING_REVOCATION_SEED);
    const entries = await revocationsSince(db, since);
    return json({ entries, sequence });
  }

  if (path === SERVING_FEED_PATH && method === "GET") {
    const denied = internalRefusal(request, env);
    if (denied) return denied;
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "websocket only", code: "serving-malformed" }, 426);
    const relay = url.searchParams.get("relay");
    if (!relay || !RELAY_ID.test(relay)) return refuse(400, "serving-malformed");
    const stub = feedStub(env);
    if (!stub) return refuse(503, "serving-not-configured");
    return stub.fetch(request);
  }

  if (method === "GET" && (m = path.match(RE.INTERNAL_BOX))) {
    const denied = internalRefusal(request, env);
    if (denied) return denied;
    const u = safeDecode(m[1]!);
    if (!u) return refuse(400, "serving-malformed");
    const user = await deps.usernames.get(u);
    const bundle = user ? await servingBundle(db, u, m[2]!.toLowerCase()) : null;
    if (!user || !bundle) return refuse(404, "serving-unknown-box");
    return json({ adminKey: adminKeyOf(user), ...bundle });
  }

  const accountRoute = SERVING_ACCOUNT_ROUTES.find((re) => re.test(path));
  if (!accountRoute) return null;
  const u = safeDecode(path.match(accountRoute)![1]!);
  if (!u) return refuse(400, "serving-malformed");

  if (method === "GET" && accountRoute === RE.READ) {
    const gate = await deps.gateRead(u);
    if (gate) return gate;
    return json(await accountServing(db, u, now, deps));
  }
  if (method !== "POST") return null;
  const user = await deps.usernames.get(u);
  if (!user) return json({ error: "unknown account", code: "account-not-found" }, 404);
  const body = asObject(await readJson(request));
  if (accountRoute === RE.POLICY) return postPolicy(db, env, deps, u, user, body, now);
  if (accountRoute === RE.DELEGATIONS) return postDelegation(db, env, deps, u, user, body, now);
  return postLeases(db, env, deps, u, user, body, now);
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s).toLowerCase();
  } catch {
    return null;
  }
}

async function postPolicy(
  db: D1Database,
  env: ServingEnv,
  deps: ServingRouteDeps,
  u: string,
  user: UsernameRecord,
  body: Record<string, unknown> | null,
  now: number,
): Promise<Response> {
  const policy = parsePolicy(body?.policy);
  const signature = body?.signature;
  if (!policy || !isSig(signature)) return refuse(400, "serving-malformed");
  if (policy.account !== u) return refuse(403, "serving-account");
  if (policy.issuedAt > now + SERVING_CLOCK_SKEW_MS) return refuse(400, "serving-clock");
  const [servers, stored] = await readAll<unknown>(db, [
    [SQL.servers, [u]],
    ["SELECT box_pub, reg_gen, policy_gen, record_json, signature FROM serving_policies WHERE username = ? AND box_pub = ?", [u, policy.box]],
  ]);
  const server = liveServer(servers as ServerRow[], policy.box);
  if (!server) return refuse(403, "serving-unknown-box");
  if (policy.regGen !== server.reg_gen) return refuse(409, "serving-reg-gen");
  if (!verifyServingRecord("serving-policy", policy, signature, adminKeyOf(user))) return refuse(403, "serving-policy-signature");
  const prev = (stored as PolicyRow[])[0];
  if (prev && prev.reg_gen === policy.regGen && prev.policy_gen >= policy.policyGen) return refuse(409, "serving-policy-stale");
  const put = await db
    .prepare(
      "INSERT INTO serving_policies (username, box_pub, reg_gen, policy_gen, record_json, signature, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(username, box_pub) DO UPDATE SET reg_gen = excluded.reg_gen, policy_gen = excluded.policy_gen, record_json = excluded.record_json, " +
        "signature = excluded.signature, updated_at = excluded.updated_at " +
        "WHERE excluded.reg_gen > serving_policies.reg_gen OR (excluded.reg_gen = serving_policies.reg_gen AND excluded.policy_gen > serving_policies.policy_gen)",
    )
    .bind(u, policy.box, policy.regGen, policy.policyGen, JSON.stringify(policy), signature, now)
    .run();
  if (!put.meta?.changes) return refuse(409, "serving-policy-stale");
  await afterResponse(deps, pokeServingFeed(env, { type: "changed", username: u, boxPub: policy.box }));
  return json({ ok: true, policyGen: policy.policyGen });
}

async function postDelegation(
  db: D1Database,
  env: ServingEnv,
  deps: ServingRouteDeps,
  u: string,
  user: UsernameRecord,
  body: Record<string, unknown> | null,
  now: number,
): Promise<Response> {
  const delegation = parseDelegation(body?.delegation);
  const signature = body?.signature;
  if (!delegation || !isSig(signature)) return refuse(400, "serving-malformed");
  if (delegation.account !== u) return refuse(403, "serving-account");
  if (delegation.issuedAt > now + SERVING_CLOCK_SKEW_MS) return refuse(400, "serving-clock");
  if (!verifyServingRecord("renewal-key-delegation", delegation, signature, adminKeyOf(user))) {
    return refuse(403, "renewal-delegation-signature");
  }
  // The device check and the insert are one statement, so a device removed meanwhile can't leave a
  // delegation its removal never saw.
  const put = await db
    .prepare(
      "INSERT INTO renewal_delegations (renewal_pub, username, device_id, record_json, signature, created_at, revoked_at) " +
        "SELECT ?, ?, ?, ?, ?, ?, NULL WHERE EXISTS (" +
        "SELECT 1 FROM device_identities WHERE account_id = ? AND device_pub_hex = ? AND revoked_at IS NULL " +
        "UNION ALL SELECT 1 FROM device_capability_grants WHERE username = ? AND device_pub_hex = ? AND revoked_at IS NULL) " +
        "ON CONFLICT(renewal_pub) DO NOTHING",
    )
    .bind(delegation.renewalPub, u, delegation.deviceId, JSON.stringify(delegation), signature, now, u, delegation.deviceId, u, delegation.deviceId)
    .run();
  if (!put.meta?.changes) {
    const existing = await db
      .prepare("SELECT renewal_pub, username, device_id, record_json, signature, revoked_at FROM renewal_delegations WHERE renewal_pub = ?")
      .bind(delegation.renewalPub)
      .first<DelegationRow>();
    if (!existing) return refuse(403, "renewal-delegation-device");
    if (existing.username !== u) return refuse(409, "renewal-key-taken");
    if (existing.revoked_at != null) return refuse(409, "renewal-key-revoked");
    return json({ ok: true, renewalPub: delegation.renewalPub });
  }
  const servers = await db.prepare(SQL.servers).bind(u).all<ServerRow>();
  const boxes = new Set((servers.results ?? []).filter((s) => s.revoked_at == null).map((s) => s.box_pub));
  await afterResponse(deps, Promise.all([...boxes].map((boxPub) => pokeServingFeed(env, { type: "changed", username: u, boxPub }))).then(() => undefined));
  return json({ ok: true, renewalPub: delegation.renewalPub });
}

async function postLeases(
  db: D1Database,
  env: ServingEnv,
  deps: ServingRouteDeps,
  u: string,
  user: UsernameRecord,
  body: Record<string, unknown> | null,
  now: number,
): Promise<Response> {
  const list = body?.leases;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_LEASES_PER_CALL) return refuse(400, "serving-malformed");
  const admin = adminKeyOf(user);
  const [servers, policies, delegations] = await readAll<unknown>(db, [
    [SQL.servers, [u]],
    [SQL.policies, [u]],
    [SQL.delegations, [u]],
  ]);
  const delegationsByPub = new Map((delegations as DelegationRow[]).map((d) => [d.renewal_pub, d]));
  const refused: Array<{ leaseId: string | null; code: LeaseRefusal }> = [];
  const writes = [];
  const changedBoxes = new Set<string>();
  let accepted = 0;
  for (const item of list) {
    const o = asObject(item);
    const lease = parseLease(o?.lease);
    const leaseId = typeof asObject(o?.lease)?.leaseId === "string" ? (asObject(o?.lease)!.leaseId as string) : null;
    const no = (code: LeaseRefusal) => refused.push({ leaseId, code });
    const signature = o?.signature;
    const delegationPub = o?.delegationPub;
    if (!lease || !isSig(signature) || (delegationPub !== undefined && delegationPub !== null && typeof delegationPub !== "string")) {
      no("serving-lease-malformed");
      continue;
    }
    if (lease.account !== u) {
      no("serving-lease-account");
      continue;
    }
    const server = liveServer(servers as ServerRow[], lease.box);
    if (!server) {
      no("serving-lease-unknown-box");
      continue;
    }
    if (lease.regGen !== server.reg_gen) {
      no("serving-lease-reg-gen");
      continue;
    }
    const policyRow = (policies as PolicyRow[]).find((p) => p.box_pub === lease.box && p.reg_gen === server.reg_gen);
    const policy = policyRow ? signed<ServingPolicy>(policyRow.record_json, policyRow.signature) : null;
    if (!policy || policy.record.grace === "indefinite") {
      no("serving-lease-no-limit");
      continue;
    }
    if (lease.policyGen !== policy.record.policyGen) {
      no("serving-lease-policy-gen");
      continue;
    }
    let delegation: SignedServingRecord<RenewalKeyDelegation> | undefined;
    if (typeof delegationPub === "string") {
      const row = delegationsByPub.get(delegationPub);
      const s = row ? signed<RenewalKeyDelegation>(row.record_json, row.signature) : null;
      if (!row || !s) {
        no("serving-lease-delegation");
        continue;
      }
      if (row.revoked_at != null) {
        no("serving-lease-key-revoked");
        continue;
      }
      delegation = s;
    }
    const decision = servingDecision({
      account: u,
      box: lease.box,
      regGen: server.reg_gen,
      adminKeyFromCom: admin,
      adminKeyFromBox: admin,
      policies: [policy],
      leases: [{ record: lease, signature, ...(delegation ? { delegation } : {}) }],
      revocations: emptyRevocationState(),
      now,
    });
    if (!decision.apps) {
      no(decision.reason === "lease-expired" ? "serving-lease-expired" : decision.reason === "policy-signature" ? "serving-policy-signature" : "serving-lease-invalid");
      continue;
    }
    accepted++;
    changedBoxes.add(lease.box);
    writes.push(
      db
        .prepare(
          "INSERT INTO serving_leases (username, box_pub, signer_pub, reg_gen, policy_gen, record_json, signature, delegation_pub, not_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(username, box_pub, signer_pub) DO UPDATE SET reg_gen = excluded.reg_gen, policy_gen = excluded.policy_gen, record_json = excluded.record_json, " +
            "signature = excluded.signature, delegation_pub = excluded.delegation_pub, not_after = excluded.not_after " +
            "WHERE excluded.reg_gen > serving_leases.reg_gen OR (excluded.reg_gen = serving_leases.reg_gen AND (excluded.policy_gen > serving_leases.policy_gen " +
            "OR (excluded.policy_gen = serving_leases.policy_gen AND excluded.not_after > serving_leases.not_after)))",
        )
        .bind(u, lease.box, delegation ? delegation.record.renewalPub : admin, lease.regGen, lease.policyGen, JSON.stringify(lease), signature, delegation ? delegation.record.renewalPub : null, lease.notAfter),
    );
  }
  if (writes.length > 0) await db.batch(writes);
  if (changedBoxes.size > 0) {
    await afterResponse(deps, Promise.all([...changedBoxes].map((boxPub) => pokeServingFeed(env, { type: "changed", username: u, boxPub }))).then(() => undefined));
  }
  return json({ accepted, refused });
}

export interface AccountServingEntry {
  serverDomain: string;
  boxPub: string;
  regGen: number;
  revoked: boolean;
  policy: SignedServingRecord<ServingPolicy> | null;
  lease: (SignedServingRecord<ServingLease> & { delegationPub: string | null }) | null;
  /** App routes stop then without a newer lease; null: no time limit (or not serving). */
  until: number | null;
  onLapse: ServingPolicy["onLapse"];
  grace: ServingPolicy["grace"];
  /** Whether `servingDecision` lets the box serve apps now, and why not. */
  serving: boolean;
  reason: string | null;
  /** Every relay heard in the last 10 minutes acknowledged every revocation about this server. */
  confirmedByRelays: boolean;
}

async function accountServing(db: D1Database, u: string, now: number, deps: ServingRouteDeps): Promise<{ servers: AccountServingEntry[] }> {
  const user = await deps.usernames.get(u);
  const [servers, policies, leases, delegations, acks, logTops] = await readAll<unknown>(db, [
    [SQL.servers, [u]],
    [SQL.policies, [u]],
    [SQL.leases, [u]],
    [SQL.delegations, [u]],
    ["SELECT relay_id, sequence, seen_at FROM serving_relay_acks WHERE seen_at > ?", [now - RELAY_FRESH_MS]],
    ["SELECT kind, subject, MAX(sequence) AS seq FROM revocation_log WHERE account = ? GROUP BY kind, subject", [u]],
  ]);
  if (!user) return { servers: [] };
  const admin = adminKeyOf(user);
  const live = new Map<string, DelegationRow>();
  for (const d of delegations as DelegationRow[]) if (d.revoked_at == null) live.set(d.renewal_pub, d);
  const fresh = acks as Array<{ relay_id: string; sequence: number }>;
  const tops = logTops as Array<{ kind: string; subject: string; seq: number }>;
  const keySeq = tops.filter((t) => t.kind === "renewal-key").reduce((a, t) => Math.max(a, t.seq), 0);
  const out: AccountServingEntry[] = [];
  for (const s of servers as ServerRow[]) {
    const revoked = s.revoked_at != null;
    const policyRow = (policies as PolicyRow[]).find((p) => p.box_pub === s.box_pub && p.reg_gen === s.reg_gen);
    const policy = policyRow ? signed<ServingPolicy>(policyRow.record_json, policyRow.signature) : null;
    const best = leasesFor(leases as LeaseRow[], live, s.box_pub, s.reg_gen).filter((l) => l.record.policyGen === policy?.record.policyGen)[0];
    const relevant = Math.max(keySeq, tops.find((t) => t.kind === "box" && t.subject === s.box_pub)?.seq ?? 0);
    const confirmedByRelays = relevant === 0 || (fresh.length > 0 && fresh.every((r) => r.sequence >= relevant));
    const grace = policy?.record.grace ?? "indefinite";
    const onLapse = policy?.record.onLapse ?? "stop-apps";
    const lease = best ? { record: best.record, signature: best.signature, delegationPub: best.delegation?.record.renewalPub ?? null } : null;
    if (revoked) {
      out.push({ serverDomain: s.server_domain, boxPub: s.box_pub, regGen: s.reg_gen, revoked, policy, lease, until: null, onLapse, grace, serving: false, reason: "revoked", confirmedByRelays });
      continue;
    }
    const d = servingDecision({
      account: u,
      box: s.box_pub,
      regGen: s.reg_gen,
      adminKeyFromCom: admin,
      adminKeyFromBox: admin,
      policies: policy ? [policy] : [],
      leases: best ? [stripNotAfter(best)] : [],
      revocations: emptyRevocationState(),
      now,
    });
    out.push({
      serverDomain: s.server_domain,
      boxPub: s.box_pub,
      regGen: s.reg_gen,
      revoked,
      policy,
      lease,
      until: d.apps ? d.until : d.reason === "lease-expired" ? (best?.record.notAfter ?? null) : null,
      onLapse: d.apps ? d.onLapse : onLapse,
      grace,
      serving: d.apps,
      reason: d.apps ? null : d.reason,
      confirmedByRelays,
    });
  }
  return { servers: out };
}
