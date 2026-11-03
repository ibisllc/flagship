/**
 * The public relay log on `.com` (docs/architecture-v2/relay-mesh.md §4; records and state rules in
 * packages/protocol/src/relayMesh.ts, the encryption layer in packages/control-plane/src/relayFeedSeal.ts).
 *
 *   Appending   D1 triggers (migration 0122) write a row in the same transaction as the change that causes it, for
 *               every writer (server register / revoke / un-revoke / delete / re-key, account claim and admin root /
 *               IRK change, serving policy, renewal-key and device-grant revocation, cert revocation, relay retire).
 *               `relayLogAppend` is the same append for code that writes the log itself (the backfill).
 *   Signing     `signPendingRelayLog` fills the hashed fields (nameHash, accountHash, the policy's sha256) and signs
 *               pending rows in sequence order with the log key (SERVING_REVOCATION_SEED). Ed25519 is deterministic,
 *               so two signers racing write the same bytes.
 *   Publishing  `publishRelayFeed`, run by the ServingFeed Durable Object (servingFeed.ts) after a write and on its
 *               5 s alarm: the changed log pages and a fresh head go to the R2 bucket RELAY_FEED, each encrypted to
 *               the current mesh-key epoch (§4.5.1), served on https://feed.<controlApex>/v1/ behind Cloudflare's cache.
 *   Backfill    `backfillRelayLog`: one append per existing account, live server and stored policy, then every
 *               revocation already made; idempotent (it appends only what the log does not already say).
 *
 * Mesh mode is off unless RELAY_MESH is "on": the triggers still append and the feed still signs (cheap), but nothing
 * is published and no alarm runs, so today's relays keep using the internal routes (§13.3).
 */
import {
  accountHash,
  canonicalRelayLogHead,
  canonicalServingPolicy,
  ed,
  FEED_HEAD_MINT_MS,
  FEED_PAGE_ENTRIES,
  nameHash,
  RELAY_LOG_ZERO_TIP,
  relayLogEntryHash,
  signRelayLogEntry,
  type RelayLogEntry,
  type RelayLogHead,
  type RelayLogKind,
  type ServingPolicy,
  type SignedRelayLogEntry,
  type SignedRelayLogHead,
} from "@flagship/protocol";
import { deriveMeshEpochKey, sealRelayFeedObject, sealRelayMeshKeys, type RelayMeshKeys } from "@flagship/control-plane";
import type { D1Database, D1PreparedStatement } from "@flagship/storage";

// ── configuration ─────────────────────────────────────────────────────────

/** The R2 surface the feed writes (an R2Bucket in the Worker; a map in tests). */
export interface RelayFeedBucket {
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string; cacheControl?: string } }): Promise<unknown>;
}

export interface RelayFeedEnv {
  DB?: D1Database;
  /** The log key's Ed25519 seed (64 hex): today's revocation key, now signing the relay log. */
  SERVING_REVOCATION_SEED?: string;
  /** Worker secret, 64 hex: every mesh-key epoch is derived from it (relayFeedSeal.ts). */
  RELAY_MESH_KEY_SEED?: string;
  /** "on" publishes the feed and runs the 5 s head alarm; anything else leaves the mesh off. */
  RELAY_MESH?: string;
  /** R2 bucket served on feed.<controlApex>. */
  RELAY_FEED?: RelayFeedBucket;
  SERVICES_APEX?: string;
}

export function relayMeshOn(env: RelayFeedEnv): boolean {
  return env.RELAY_MESH === "on";
}

export function servicesApexOf(env: { SERVICES_APEX?: string }): string {
  return (env.SERVICES_APEX ?? "flagship.services").toLowerCase();
}

/** The published objects (§4.5) and their Cache-Control. */
export const FEED_OBJECTS = {
  head: "v1/head.json",
  page: (p: number) => `v1/log/${p}.json`,
  directory: "v1/directory.json",
  logKey: "v1/log-key.json",
  keys: (relayId: string) => `v1/keys/${relayId}.json`,
} as const;
export const FEED_CACHE = {
  head: "public, max-age=2",
  tailPage: "public, max-age=2",
  fullPage: "public, max-age=31536000, immutable",
  directory: "public, max-age=60",
  logKey: "public, max-age=3600",
  keys: "public, max-age=60",
} as const;

export function feedPut(bucket: RelayFeedBucket, key: string, body: unknown, cacheControl: string): Promise<unknown> {
  return bucket.put(key, JSON.stringify(body), { httpMetadata: { contentType: "application/json", cacheControl } });
}

// ── the log key ───────────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/;

export function relayLogKey(seedHex: string | undefined): { seed: Uint8Array; publicKey: string } | null {
  const s = seedHex?.trim().toLowerCase();
  if (!s || !HEX64.test(s)) return null;
  const seed = ed.etc.hexToBytes(s);
  return { seed, publicKey: ed.etc.bytesToHex(ed.getPublicKey(seed)) };
}

// ── appending and signing ─────────────────────────────────────────────────

interface LogRow {
  sequence: number;
  kind: RelayLogKind;
  at: number;
  account: string | null;
  src: string | null;
  f1: string | null;
  f2: string;
  f3: string;
  f4: string | null;
  signature: string | null;
}

const LOG_COLUMNS = "sequence, kind, at, account, src, f1, f2, f3, f4, signature";
const SIGN_BATCH = 200;

/**
 * Append one entry from code (the backfill): the same row a trigger writes. `account` and `src` are .com-only inputs
 * the signer hashes (`src` = the pod name for box-register, the policy JSON for policy-head); a NULL `f1` / `f4` is
 * filled in at signing. Returns the statement so the caller can put it in its own batch (one D1 transaction).
 */
export function relayLogAppend(
  db: D1Database,
  row: { kind: RelayLogKind; at: number; account?: string | null; src?: string | null; f1?: string | null; f2?: string; f3?: string; f4?: string | null },
  now: number,
): D1PreparedStatement {
  return db
    .prepare("INSERT INTO relay_log (kind, at, account, src, f1, f2, f3, f4, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(row.kind, row.at, row.account ?? null, row.src ?? null, row.f1 ?? null, row.f2 ?? "", row.f3 ?? "", row.f4 === undefined ? "" : row.f4, now);
}

async function sha256hex(bytes: Uint8Array): Promise<string> {
  return ed.etc.bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** The published fields of a pending row: the hashes a trigger could not compute. Throws if the row can't be carried. */
async function completeRow(r: LogRow): Promise<RelayLogEntry> {
  let f1 = r.f1;
  let f4 = r.f4;
  if (f1 === null) {
    if (r.kind === "box-register") f1 = nameHash(r.src ?? "");
    else if (r.kind === "account-authority" || r.kind === "cert-revoke") f1 = accountHash(r.account ?? "");
    else throw new Error(`${r.kind} needs f1`);
  }
  if (f4 === null) {
    if (r.kind !== "policy-head") throw new Error(`${r.kind} needs f4`);
    f4 = await sha256hex(canonicalServingPolicy(JSON.parse(r.src ?? "null") as ServingPolicy));
  }
  return { sequence: r.sequence, kind: r.kind, at: r.at, f1, f2: r.f2, f3: r.f3, f4 };
}

/**
 * Fill in and sign every pending row, in sequence order. A row that can't be signed stops the run (and is logged):
 * the signed rows are always a prefix of the log. Returns the newest signed sequence (0 when none).
 */
export async function signPendingRelayLog(db: D1Database, seedHex: string | undefined, servicesApex: string): Promise<number> {
  const key = relayLogKey(seedHex);
  if (!key) throw new Error("SERVING_REVOCATION_SEED is not set");
  for (;;) {
    const pending = await db
      .prepare(`SELECT ${LOG_COLUMNS} FROM relay_log WHERE signature IS NULL ORDER BY sequence LIMIT ${SIGN_BATCH}`)
      .all<LogRow>();
    const rows = pending.results ?? [];
    if (rows.length === 0) break;
    const updates: D1PreparedStatement[] = [];
    for (const r of rows) {
      let entry: RelayLogEntry;
      let sig: string;
      try {
        entry = await completeRow(r);
        sig = signRelayLogEntry(servicesApex, entry, (m) => ed.sign(m, key.seed));
      } catch (e) {
        console.error(JSON.stringify({ event: "relay-log-unsignable", sequence: r.sequence, kind: r.kind, error: String(e) }));
        break;
      }
      updates.push(
        db
          .prepare("UPDATE relay_log SET f1 = ?, f4 = ?, signature = ? WHERE sequence = ? AND signature IS NULL")
          .bind(entry.f1, entry.f4, sig, r.sequence),
      );
    }
    if (updates.length > 0) await db.batch(updates);
    if (updates.length < rows.length || rows.length < SIGN_BATCH) break;
  }
  return signedTop(db);
}

export async function signedTop(db: D1Database): Promise<number> {
  const r = await db.prepare("SELECT MAX(sequence) AS seq FROM relay_log WHERE signature IS NOT NULL").first<{ seq: number | null }>();
  return r?.seq ?? 0;
}

/** Signed entries with `from ≤ sequence ≤ to`, in order, stopping before the first unsigned one. */
export async function relayLogRange(db: D1Database, from: number, to: number): Promise<SignedRelayLogEntry[]> {
  const r = await db
    .prepare(`SELECT ${LOG_COLUMNS} FROM relay_log WHERE sequence >= ? AND sequence <= ? ORDER BY sequence`)
    .bind(from, to)
    .all<LogRow>();
  const out: SignedRelayLogEntry[] = [];
  for (const row of r.results ?? []) {
    if (!row.signature || row.f1 === null || row.f4 === null) break;
    out.push({
      entry: { sequence: row.sequence, kind: row.kind, at: row.at, f1: row.f1, f2: row.f2, f3: row.f3, f4: row.f4 },
      signature: row.signature,
    });
  }
  return out;
}

// ── mesh-key epochs (§4.5.1) ──────────────────────────────────────────────

export async function currentMeshEpoch(db: D1Database): Promise<number> {
  const r = await db.prepare("SELECT MAX(epoch) AS epoch FROM relay_mesh_epochs").first<{ epoch: number | null }>();
  return r?.epoch ?? 1;
}

/** Start a new epoch: files written from now on use it; relays not sealed to it can no longer read new files. */
export async function rotateMeshEpoch(db: D1Database, reason: string, now: number): Promise<number> {
  await db
    .prepare("INSERT INTO relay_mesh_epochs (epoch, created_at, reason) SELECT COALESCE(MAX(epoch), 0) + 1, ?, ? FROM relay_mesh_epochs")
    .bind(now, reason.slice(0, 200))
    .run();
  return currentMeshEpoch(db);
}

/** Every epoch key up to `current`, sealed to one relay key. */
export function meshKeysFor(seedHex: string, servicesApex: string, relayId: string, relayKey: string, current: number): RelayMeshKeys {
  const epochs = [];
  for (let e = 1; e <= current; e++) epochs.push({ epoch: e, key: deriveMeshEpochKey(seedHex, servicesApex, e) });
  return sealRelayMeshKeys({ servicesApex, relayId, relayKey, current, epochs });
}

/**
 * Seal the current epochs to every active relay: store each document (the blessing answer carries it) and publish it
 * as v1/keys/<relayId>.json. A retired relay gets nothing new.
 */
export async function resealMeshKeys(env: RelayFeedEnv, db: D1Database, now: number): Promise<{ epoch: number; relays: string[] }> {
  const seed = env.RELAY_MESH_KEY_SEED;
  if (!seed) throw new Error("RELAY_MESH_KEY_SEED is not set");
  const apex = servicesApexOf(env);
  const epoch = await currentMeshEpoch(db);
  const rows = await db.prepare("SELECT relay_id, relay_key FROM relays WHERE retired_at IS NULL ORDER BY relay_id").all<{ relay_id: string; relay_key: string }>();
  const done: string[] = [];
  const writes: D1PreparedStatement[] = [];
  const puts: Array<Promise<unknown>> = [];
  for (const r of rows.results ?? []) {
    const doc = meshKeysFor(seed, apex, r.relay_id, r.relay_key, epoch);
    writes.push(db.prepare("UPDATE relays SET mesh_keys_json = ? WHERE relay_id = ? AND relay_key = ?").bind(JSON.stringify(doc), r.relay_id, r.relay_key));
    if (env.RELAY_FEED) puts.push(feedPut(env.RELAY_FEED, FEED_OBJECTS.keys(r.relay_id), doc, FEED_CACHE.keys));
    done.push(r.relay_id);
  }
  if (writes.length > 0) await db.batch(writes);
  await Promise.all(puts);
  void now;
  return { epoch, relays: done };
}

// ── publishing (§4.5) ─────────────────────────────────────────────────────

/** What the publisher last wrote (kept in the Durable Object's storage). */
export interface RelayFeedPublishState {
  /** The head's sequence. */
  sequence: number;
  tipSha256: string;
  /** The epoch the tail page and head were last written under. */
  epoch: number;
}

export const pageOf = (sequence: number): number => Math.floor(sequence / FEED_PAGE_ENTRIES);

/**
 * Publish what changed since `state` and a fresh head. Pages from the one holding `state.sequence + 1` to the one
 * holding the top are rewritten (all of them when `state` is null or `force` is "all"; at least the tail page after an
 * epoch change or with `force` "tail"). A page whose last slot is filled is final and cached as immutable.
 */
export async function publishRelayFeed(o: {
  env: RelayFeedEnv;
  db: D1Database;
  bucket: RelayFeedBucket;
  now: number;
  state: RelayFeedPublishState | null;
  force?: "tail" | "all";
}): Promise<RelayFeedPublishState> {
  const { env, db, bucket, now } = o;
  const apex = servicesApexOf(env);
  const key = relayLogKey(env.SERVING_REVOCATION_SEED);
  const seed = env.RELAY_MESH_KEY_SEED;
  if (!key || !seed) throw new Error("the relay feed needs SERVING_REVOCATION_SEED and RELAY_MESH_KEY_SEED");
  const meta = await db
    .prepare(
      "SELECT (SELECT MAX(epoch) FROM relay_mesh_epochs) AS epoch, (SELECT MAX(version) FROM relay_directories) AS dv, " +
        "(SELECT MAX(sequence) FROM relay_log WHERE signature IS NOT NULL) AS top",
    )
    .first<{ epoch: number | null; dv: number | null; top: number | null }>();
  const epoch = meta?.epoch ?? 1;
  const top = meta?.top ?? 0;
  const meshKey = deriveMeshEpochKey(seed, apex, epoch);
  const prev = o.state;

  let firstPage: number | null = null;
  if (top > 0) {
    if (!prev || o.force === "all" || prev.sequence > top) firstPage = 0;
    else if (o.force === "tail" || prev.epoch !== epoch) firstPage = pageOf(Math.min(prev.sequence, top));
    else if (top > prev.sequence) firstPage = pageOf(prev.sequence + 1);
  }
  let tip = prev && prev.sequence === top && o.force !== "all" ? prev.tipSha256 : top === 0 ? RELAY_LOG_ZERO_TIP : null;
  if (firstPage !== null) {
    for (let p = firstPage; p <= pageOf(top); p++) {
      const lo = Math.max(1, p * FEED_PAGE_ENTRIES);
      const hi = p * FEED_PAGE_ENTRIES + FEED_PAGE_ENTRIES - 1;
      const entries = await relayLogRange(db, lo, Math.min(hi, top));
      const full = hi <= top;
      const sealed = await sealRelayFeedObject({ servicesApex: apex, object: "log", page: p, epoch, key: meshKey, plaintext: JSON.stringify({ page: p, entries }) });
      await feedPut(bucket, FEED_OBJECTS.page(p), sealed, full ? FEED_CACHE.fullPage : FEED_CACHE.tailPage);
      const last = entries[entries.length - 1];
      if (p === pageOf(top) && last && last.entry.sequence === top) tip = relayLogEntryHash(apex, last.entry);
    }
  }
  if (tip === null) {
    const last = (await relayLogRange(db, top, top))[0];
    if (!last) throw new Error(`relay log entry ${top} is missing`);
    tip = relayLogEntryHash(apex, last.entry);
  }
  const head: RelayLogHead = { servicesApex: apex, sequence: top, tipSha256: tip, directoryVersion: meta?.dv ?? 0, issuedAt: now };
  const signed: SignedRelayLogHead = { head, signature: ed.etc.bytesToHex(ed.sign(canonicalRelayLogHead(head), key.seed)) };
  const sealedHead = await sealRelayFeedObject({ servicesApex: apex, object: "head", page: null, epoch, key: meshKey, plaintext: JSON.stringify(signed) });
  await feedPut(bucket, FEED_OBJECTS.head, sealedHead, FEED_CACHE.head);
  if (!prev || prev.epoch !== epoch || o.force === "all") {
    await feedPut(bucket, FEED_OBJECTS.logKey, { logKey: key.publicKey }, FEED_CACHE.logKey);
  }
  return { sequence: top, tipSha256: tip, epoch };
}

export const RELAY_FEED_HEAD_MS = FEED_HEAD_MINT_MS;

// ── backfill (§13.2 step 1) ───────────────────────────────────────────────

const NOW_SQL = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const GUARD_KEY = (c: string) => `length(${c}) = 64 AND lower(${c}) NOT GLOB '*[^0-9a-f]*'`;
/** A device grant id the log can carry (`RELAY_LOG_GRANT_ID`): the apps choose UUIDs, so hex digits and dashes. */
const GUARD_GRANT = (c: string) => `length(${c}) BETWEEN 1 AND 64 AND lower(${c}) NOT GLOB '*[^0-9a-f-]*' AND ${c} NOT GLOB '-*'`;
const GUARD_USER = (c: string) =>
  `length(${c}) BETWEEN 1 AND 63 AND lower(${c}) NOT GLOB '*[^a-z0-9-]*' AND ${c} NOT GLOB '-*' AND ${c} NOT GLOB '*-'`;
const GUARD_NAME = (c: string) => `length(${c}) BETWEEN 3 AND 253 AND lower(${c}) NOT GLOB '*[^a-z0-9.-]*'`;
const INSERT = "INSERT INTO relay_log (kind, at, account, src, f1, f2, f3, f4, created_at)";

/**
 * The backfill statements, in the order their entries must land: account authorities, live servers, stored policies,
 * then every revocation already made (servers, renewal keys, device grants, certs, relays, and whatever only the old
 * revocation log still records). Each appends only what the log does not already say, so running it again appends
 * nothing.
 */
export function backfillStatements(db: D1Database): D1PreparedStatement[] {
  const sql = [
    // account-authority: the account's current keys, unless its newest authority entry already names them.
    `${INSERT} SELECT 'account-authority', ${NOW_SQL}, lower(u.username), NULL, NULL, COALESCE(lower(u.admin_root_pub_hex), ''), lower(u.irk_pub_hex), ` +
      `CAST(1 + (SELECT COUNT(*) FROM relay_log r WHERE r.kind = 'account-authority' AND r.account = lower(u.username)) AS TEXT), ${NOW_SQL} ` +
      `FROM usernames u WHERE ${GUARD_USER("u.username")} AND ${GUARD_KEY("u.irk_pub_hex")} AND (u.admin_root_pub_hex IS NULL OR (${GUARD_KEY("u.admin_root_pub_hex")})) ` +
      `AND NOT EXISTS (SELECT 1 FROM relay_log r WHERE r.sequence = (SELECT MAX(r2.sequence) FROM relay_log r2 WHERE r2.kind = 'account-authority' AND r2.account = lower(u.username)) ` +
      `AND r.f2 = COALESCE(lower(u.admin_root_pub_hex), '') AND r.f3 = lower(u.irk_pub_hex)) ORDER BY lower(u.username)`,
    // box-register: every live server at its generation.
    `${INSERT} SELECT 'box-register', ${NOW_SQL}, lower(s.username), lower(s.server_domain), NULL, lower(s.identity_pubkey_hex), CAST(s.reg_gen AS TEXT), '', ${NOW_SQL} ` +
      `FROM servers s WHERE s.revoked_at IS NULL AND s.reg_gen >= 1 AND ${GUARD_KEY("s.identity_pubkey_hex")} AND ${GUARD_NAME("s.server_domain")} ` +
      `AND NOT EXISTS (SELECT 1 FROM relay_log r WHERE r.kind = 'box-register' AND r.src = lower(s.server_domain) AND r.f2 = lower(s.identity_pubkey_hex) AND r.f3 = CAST(s.reg_gen AS TEXT)) ` +
      `ORDER BY s.registered_at, s.server_domain`,
    // policy-head: every stored policy.
    `${INSERT} SELECT 'policy-head', ${NOW_SQL}, p.username, p.record_json, p.box_pub, CAST(p.reg_gen AS TEXT), CAST(p.policy_gen AS TEXT), NULL, ${NOW_SQL} ` +
      `FROM serving_policies p WHERE p.reg_gen >= 1 AND p.policy_gen >= 1 AND length(p.box_pub) = 64 AND p.box_pub NOT GLOB '*[^0-9a-f]*' ` +
      `AND NOT EXISTS (SELECT 1 FROM relay_log r WHERE r.kind = 'policy-head' AND r.f1 = p.box_pub AND r.f2 = CAST(p.reg_gen AS TEXT) AND r.f3 = CAST(p.policy_gen AS TEXT)) ` +
      `ORDER BY p.username, p.box_pub`,
    // box-revoke: revoked servers.
    `${INSERT} SELECT 'box-revoke', COALESCE(CAST(s.revoked_at AS INTEGER), ${NOW_SQL}), lower(s.username), NULL, lower(s.identity_pubkey_hex), CAST(s.reg_gen AS TEXT), '', '', ${NOW_SQL} ` +
      `FROM servers s WHERE s.revoked_at IS NOT NULL AND s.reg_gen >= 1 AND ${GUARD_KEY("s.identity_pubkey_hex")} ` +
      `AND NOT EXISTS (SELECT 1 FROM relay_log r WHERE r.kind = 'box-revoke' AND r.f1 = lower(s.identity_pubkey_hex) AND CAST(r.f2 AS INTEGER) >= s.reg_gen) ` +
      `ORDER BY s.revoked_at, s.server_domain`,
    // box-revoke: what only the old revocation log records.
    `${INSERT} SELECT 'box-revoke', l.revoked_at, l.account, NULL, l.subject, CAST(l.generation AS TEXT), '', '', ${NOW_SQL} ` +
      `FROM revocation_log l WHERE l.kind = 'box' AND l.generation >= 1 AND ${GUARD_KEY("l.subject")} ` +
      `AND NOT EXISTS (SELECT 1 FROM relay_log r WHERE r.kind = 'box-revoke' AND r.f1 = l.subject AND CAST(r.f2 AS INTEGER) >= l.generation) ` +
      `AND l.sequence = (SELECT MAX(l2.sequence) FROM revocation_log l2 WHERE l2.kind = 'box' AND l2.subject = l.subject) ORDER BY l.sequence`,
    // renewal-key-revoke: revoked delegations, and the old log's renewal-key entries.
    `${INSERT} SELECT 'renewal-key-revoke', COALESCE(CAST(d.revoked_at AS INTEGER), ${NOW_SQL}), d.username, NULL, d.renewal_pub, '', '', '', ${NOW_SQL} ` +
      `FROM renewal_delegations d WHERE d.revoked_at IS NOT NULL AND length(d.renewal_pub) = 66 AND substr(d.renewal_pub, 1, 2) IN ('02', '03') AND d.renewal_pub NOT GLOB '*[^0-9a-f]*' ` +
      `AND NOT EXISTS (SELECT 1 FROM relay_log r WHERE r.kind = 'renewal-key-revoke' AND r.f1 = d.renewal_pub) ORDER BY d.revoked_at, d.renewal_pub`,
    `${INSERT} SELECT 'renewal-key-revoke', MIN(l.revoked_at), MIN(l.account), NULL, l.subject, '', '', '', ${NOW_SQL} ` +
      `FROM revocation_log l WHERE l.kind = 'renewal-key' AND length(l.subject) = 66 AND substr(l.subject, 1, 2) IN ('02', '03') AND l.subject NOT GLOB '*[^0-9a-f]*' ` +
      `AND NOT EXISTS (SELECT 1 FROM relay_log r WHERE r.kind = 'renewal-key-revoke' AND r.f1 = l.subject) GROUP BY l.subject ORDER BY MIN(l.sequence)`,
    // device-grant-revoke: revoked grants.
    `${INSERT} SELECT 'device-grant-revoke', COALESCE(CAST(g.revoked_at AS INTEGER), ${NOW_SQL}), lower(g.username), NULL, lower(g.grant_id), lower(g.device_pub_hex), '', '', ${NOW_SQL} ` +
      `FROM device_capability_grants g WHERE g.revoked_at IS NOT NULL AND ${GUARD_GRANT("g.grant_id")} AND ${GUARD_KEY("g.device_pub_hex")} ` +
      `AND NOT EXISTS (SELECT 1 FROM relay_log r WHERE r.kind = 'device-grant-revoke' AND r.f1 = lower(g.grant_id)) ORDER BY g.revoked_at, g.grant_id`,
    // cert-revoke: every cert id on an account's revocation list.
    `${INSERT} SELECT 'cert-revoke', ${NOW_SQL}, lower(e.username), NULL, NULL, lower(j.value), '', '', ${NOW_SQL} ` +
      `FROM entitlement_revocation_lists e, json_each(CASE WHEN json_valid(e.cert_ids_json) THEN e.cert_ids_json ELSE '[]' END) j ` +
      `WHERE j.type = 'text' AND ${GUARD_USER("e.username")} AND ${GUARD_KEY("j.value")} ` +
      `AND NOT EXISTS (SELECT 1 FROM relay_log r WHERE r.kind = 'cert-revoke' AND r.account = lower(e.username) AND r.f2 = lower(j.value)) ` +
      `GROUP BY lower(e.username), lower(j.value) ORDER BY lower(e.username), lower(j.value)`,
    // relay-revoke: retired relays.
    `${INSERT} SELECT 'relay-revoke', CAST(x.retired_at AS INTEGER), NULL, NULL, x.relay_id, x.relay_key, '', '', ${NOW_SQL} ` +
      `FROM relays x WHERE x.retired_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM relay_log r WHERE r.kind = 'relay-revoke' AND r.f1 = x.relay_id) ORDER BY x.retired_at, x.relay_id`,
  ];
  return sql.map((s) => db.prepare(s));
}

/** Run the backfill as one D1 batch (one transaction), then sign. Returns the entries it appended and the new top. */
export async function backfillRelayLog(env: RelayFeedEnv, db: D1Database): Promise<{ appended: number; sequence: number }> {
  const results = await db.batch(backfillStatements(db));
  const appended = results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
  const sequence = await signPendingRelayLog(db, env.SERVING_REVOCATION_SEED, servicesApexOf(env));
  return { appended, sequence };
}
