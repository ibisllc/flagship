/**
 * Relay admission and the CA-signed relay directory (docs/architecture-v2/relay-mesh.md §3.1, §3.3).
 *
 *   POST /api/admin/relays   (x-admin-secret)   {op, ...}; CLI: `npm run relays` (scripts/relays.mjs)
 *     add              {relayId, relayKey, kind, region, ipv4?, ipv6?}   admit a relay; new directory; seal mesh keys
 *     update           {relayId, kind?, region?, ipv4?, ipv6?}           new directory
 *     retire           {relayId}       relay-revoke log entry, new mesh-key epoch sealed to the others, new directory
 *     stage-key        {relayId, nextKey, deadline?}   the relay's next key; its first blessing request under it
 *                                      promotes it. `deadline` (ms) also sets key-deadline for the current key
 *     key-deadline     {relayId, deadline | null}   after it, no blessing is renewed for the current key
 *     rotate-mesh-key  {reason?}       a new epoch sealed to every active relay; the tail page is re-published
 *     mint-directory   {}              re-mint now (same version unless the relays changed)
 *     backfill         {}              relayFeed.backfillRelayLog, then publish
 *     republish        {}              rewrite every page and the head (after replacing RELAY_MESH_KEY_SEED)
 *     list             {}              relays (keys and state, never secrets), directory version, epoch, log top
 *
 * The directory and the relay blessings are signed by `.com`'s online hot CA key (FLAGSHIP_CA_PRIV_HEX), the same
 * key that signs ServiceBlessing and UserPubKeyBinding; verifiers check it against the maintainer chain's lease. No
 * offline signing step is involved.
 */
import { authorizeAdmin, caKeypairFromEnv, type CaIssuer } from "@flagship/control-plane";
import {
  DIRECTORY_REMINT_MS,
  DIRECTORY_TTL_MS,
  isRelayId,
  relayDirectoryEntriesSha256,
  relayDirectoryEntryLine,
  relayTunnelHost,
  signRelayDirectory,
  type RelayBlessing,
  type RelayDirectory,
  type RelayDirectoryEntry,
  type RelayKind,
} from "@flagship/protocol";
import type { D1Database } from "@flagship/storage";
import {
  backfillRelayLog,
  currentMeshEpoch,
  FEED_CACHE,
  FEED_OBJECTS,
  feedPut,
  relayMeshOn,
  resealMeshKeys,
  rotateMeshEpoch,
  servicesApexOf,
  signedTop,
  type RelayFeedEnv,
} from "./relayFeed.js";
import { pokeServingFeed, type ServingFeedNamespace } from "./servingAuthority.js";

export const RELAY_ADMIN_PATH = "/api/admin/relays";

export interface RelayDirectoryEnv extends RelayFeedEnv {
  FLAGSHIP_ADMIN_SECRET?: string;
  FLAGSHIP_CA_PRIV_HEX?: string;
  FLAGSHIP_CA_ISSUER?: string;
  SERVING_FEED?: ServingFeedNamespace;
}

export interface RelayRow {
  relay_id: string;
  relay_key: string;
  kind: RelayKind;
  tunnel_host: string;
  region: string;
  ipv4_json: string;
  ipv6_json: string;
  added_at: number;
  retired_at: number | null;
  next_relay_key: string | null;
  key_deadline: number | null;
  blessing_json: string | null;
  blessed_at: number | null;
  mesh_keys_json: string | null;
}

const RELAY_COLUMNS =
  "relay_id, relay_key, kind, tunnel_host, region, ipv4_json, ipv6_json, added_at, retired_at, next_relay_key, key_deadline, blessing_json, blessed_at, mesh_keys_json";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function parseList(s: string): string[] {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function directoryEntryOf(r: RelayRow): RelayDirectoryEntry {
  return { relayId: r.relay_id, relayKey: r.relay_key, tunnelHost: r.tunnel_host, relayKind: r.kind, region: r.region, ipv4: parseList(r.ipv4_json), ipv6: parseList(r.ipv6_json) };
}

export async function activeRelays(db: D1Database): Promise<RelayRow[]> {
  const r = await db.prepare(`SELECT ${RELAY_COLUMNS} FROM relays WHERE retired_at IS NULL ORDER BY relay_id`).all<RelayRow>();
  return r.results ?? [];
}

export async function relayRow(db: D1Database, relayId: string): Promise<RelayRow | null> {
  return db.prepare(`SELECT ${RELAY_COLUMNS} FROM relays WHERE relay_id = ?`).bind(relayId).first<RelayRow>();
}

export async function latestDirectory(db: D1Database): Promise<RelayDirectory | null> {
  const r = await db.prepare("SELECT directory_json FROM relay_directories ORDER BY version DESC LIMIT 1").first<{ directory_json: string }>();
  if (!r) return null;
  try {
    return JSON.parse(r.directory_json) as RelayDirectory;
  } catch {
    return null;
  }
}

/**
 * Mint the directory: a new version when the active relays differ from the newest directory's, else the same version
 * re-minted when `force` or the newest is a day old (DIRECTORY_REMINT_MS). Returns the directory in force and whether
 * it was (re)minted.
 */
export async function mintRelayDirectory(
  env: RelayDirectoryEnv,
  db: D1Database,
  ca: CaIssuer,
  now: number,
  force = false,
): Promise<{ directory: RelayDirectory | null; minted: boolean }> {
  const apex = servicesApexOf(env);
  const relays = (await activeRelays(db)).map(directoryEntryOf);
  const sum = relayDirectoryEntriesSha256(relays, apex);
  const last = await db
    .prepare("SELECT version, issued_at, entries_sha256, directory_json FROM relay_directories ORDER BY version DESC LIMIT 1")
    .first<{ version: number; issued_at: number; entries_sha256: string; directory_json: string }>();
  if (!last && relays.length === 0) return { directory: null, minted: false };
  const changed = !last || last.entries_sha256 !== sum;
  if (!changed && !force && now - last!.issued_at < DIRECTORY_REMINT_MS) {
    return { directory: JSON.parse(last!.directory_json) as RelayDirectory, minted: false };
  }
  const version = changed ? (last?.version ?? 0) + 1 : last!.version;
  const issuedAt = Math.max(now, (last?.issued_at ?? 0) + 1);
  const directory = signRelayDirectory({ servicesApex: apex, directoryVersion: version, issuedAt, expiresAt: issuedAt + DIRECTORY_TTL_MS, relays }, ca.keypair);
  await db
    .prepare(
      "INSERT INTO relay_directories (version, issued_at, expires_at, entries_sha256, directory_json) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(version) DO UPDATE SET issued_at = excluded.issued_at, expires_at = excluded.expires_at, directory_json = excluded.directory_json " +
        "WHERE excluded.issued_at > relay_directories.issued_at AND excluded.entries_sha256 = relay_directories.entries_sha256",
    )
    .bind(version, issuedAt, directory.expiresAt, sum, JSON.stringify(directory))
    .run();
  return { directory, minted: true };
}

/** Write v1/directory.json: the newest directory and the newest blessing of every relay it lists (§4.5). */
export async function publishDirectory(env: RelayDirectoryEnv, db: D1Database): Promise<boolean> {
  if (!env.RELAY_FEED || !relayMeshOn(env)) return false;
  const directory = await latestDirectory(db);
  if (!directory) return false;
  const rows = await activeRelays(db);
  const listed = new Map(directory.relays.map((r) => [r.relayId, r.relayKey]));
  const blessings: RelayBlessing[] = [];
  for (const r of rows) {
    if (!r.blessing_json || listed.get(r.relay_id) !== r.relay_key) continue;
    try {
      const b = JSON.parse(r.blessing_json) as RelayBlessing;
      if (b.relayKey === r.relay_key) blessings.push(b);
    } catch {
      /* skip */
    }
  }
  await feedPut(env.RELAY_FEED, FEED_OBJECTS.directory, { directory, blessings }, FEED_CACHE.directory);
  return true;
}

/** After a relay change: re-mint, publish the directory and the head (which carries the directory version). */
async function afterRelayChange(env: RelayDirectoryEnv, db: D1Database, ca: CaIssuer, now: number, feed?: "tail" | "all"): Promise<RelayDirectory | null> {
  const { directory } = await mintRelayDirectory(env, db, ca, now);
  await publishDirectory(env, db);
  await pokeServingFeed(env, feed ? { type: "relay-feed", force: feed } : { type: "relay-feed" });
  return directory;
}

// ── the `relays` field of GET /api/services/endpoints (§2) ────────────────

export interface EndpointRelay {
  relayId: string;
  tunnelHost: string;
  ipv4: string[];
  ipv6: string[];
}

let endpointCache: { at: number; relays: EndpointRelay[] } | null = null;
const ENDPOINT_CACHE_MS = 60_000;

/** The newest directory's relays, cached a minute per isolate (the answer itself is cached 60 s). */
export async function endpointRelays(db: D1Database | undefined, now: number): Promise<EndpointRelay[]> {
  if (!db) return [];
  if (endpointCache && now - endpointCache.at < ENDPOINT_CACHE_MS) return endpointCache.relays;
  let relays: EndpointRelay[] = [];
  try {
    const d = await latestDirectory(db);
    relays = (d?.relays ?? []).map((r) => ({ relayId: r.relayId, tunnelHost: r.tunnelHost, ipv4: [...r.ipv4], ipv6: [...r.ipv6] }));
  } catch {
    relays = endpointCache?.relays ?? [];
  }
  endpointCache = { at: now, relays };
  return relays;
}

export function resetEndpointRelayCache(): void {
  endpointCache = null;
}

// ── the cron tick (cronPlan.ts "relay-directory") ────────────────────────

/** Six-hourly: re-mint the directory once a day and make sure the feed's alarm is running. Nothing with the mesh off. */
export async function runRelayDirectoryCron(env: RelayDirectoryEnv, now: Date): Promise<{ minted: boolean } | null> {
  if (!relayMeshOn(env) || !env.DB) return null;
  const ca = caKeypairFromEnv({ FLAGSHIP_CA_PRIV_HEX: env.FLAGSHIP_CA_PRIV_HEX, FLAGSHIP_CA_ISSUER: env.FLAGSHIP_CA_ISSUER });
  const { minted } = await mintRelayDirectory(env, env.DB, ca, now.getTime());
  if (minted) await publishDirectory(env, env.DB);
  await pokeServingFeed(env, { type: "ensure" });
  return { minted };
}

// ── the admin route ───────────────────────────────────────────────────────

const HEX64 = /^[0-9a-f]{64}$/;
const REGION = /^[a-z0-9][a-z0-9-]{0,31}$/;

function addressesOf(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return null;
  return (v as string[]).map((x) => x.toLowerCase());
}

export async function handleRelayAdmin(request: Request, env: RelayDirectoryEnv, now: number = Date.now()): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const auth = authorizeAdmin({ expected: env.FLAGSHIP_ADMIN_SECRET, provided: request.headers.get("x-admin-secret") });
  if (auth) return json(auth.body, auth.status);
  const db = env.DB;
  if (!db) return json({ error: "relay admin unavailable" }, 503);
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }
  if (!body || typeof body !== "object") return json({ error: "body must be an object" }, 400);
  const ca = caKeypairFromEnv({ FLAGSHIP_CA_PRIV_HEX: env.FLAGSHIP_CA_PRIV_HEX, FLAGSHIP_CA_ISSUER: env.FLAGSHIP_CA_ISSUER });
  const apex = servicesApexOf(env);
  const op = body.op;
  const relayId = typeof body.relayId === "string" ? body.relayId : null;
  const meshSealing = !!env.RELAY_MESH_KEY_SEED;

  if (op === "list") {
    const rows = await db.prepare(`SELECT ${RELAY_COLUMNS} FROM relays ORDER BY relay_id`).all<RelayRow>();
    const directory = await latestDirectory(db);
    return json({
      relays: (rows.results ?? []).map((r) => ({
        ...directoryEntryOf(r),
        addedAt: r.added_at,
        retiredAt: r.retired_at,
        nextRelayKey: r.next_relay_key,
        keyDeadline: r.key_deadline,
        blessedAt: r.blessed_at,
        blessingExpiresAt: r.blessing_json ? ((JSON.parse(r.blessing_json) as RelayBlessing).expiresAt ?? null) : null,
      })),
      directoryVersion: directory?.directoryVersion ?? 0,
      directoryIssuedAt: directory?.issuedAt ?? null,
      meshEpoch: await currentMeshEpoch(db),
      logSequence: await signedTop(db),
      mesh: relayMeshOn(env),
    });
  }

  if (op === "add") {
    const relayKey = typeof body.relayKey === "string" ? body.relayKey.toLowerCase() : "";
    const kind = body.kind === "entry" ? "entry" : body.kind === "full" ? "full" : null;
    const region = typeof body.region === "string" ? body.region : "";
    const ipv4 = addressesOf(body.ipv4);
    const ipv6 = addressesOf(body.ipv6);
    if (!relayId || !isRelayId(relayId)) return json({ error: "relayId must match ^[a-z][a-z0-9-]{1,30}$" }, 400);
    if (!HEX64.test(relayKey)) return json({ error: "relayKey must be 64 hex (the relay's Ed25519 public key)" }, 400);
    if (!kind) return json({ error: "kind must be full or entry" }, 400);
    if (!REGION.test(region)) return json({ error: "region must be a short lowercase label" }, 400);
    if (!ipv4 || !ipv6) return json({ error: "ipv4 and ipv6 must be lists of addresses" }, 400);
    const entry: RelayDirectoryEntry = { relayId, relayKey, tunnelHost: relayTunnelHost(relayId, apex), relayKind: kind, region, ipv4, ipv6 };
    try {
      relayDirectoryEntryLine(entry, apex);
    } catch (e) {
      return json({ error: String((e as Error).message ?? e) }, 400);
    }
    const taken = await db.prepare("SELECT relay_id FROM relays WHERE relay_id = ? OR relay_key = ? OR next_relay_key = ?").bind(relayId, relayKey, relayKey).first();
    if (taken) return json({ error: "this relay id or key was used before (ids and keys are never reused)" }, 409);
    await db
      .prepare("INSERT INTO relays (relay_id, relay_key, kind, tunnel_host, region, ipv4_json, ipv6_json, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(relayId, relayKey, kind, entry.tunnelHost, region, JSON.stringify(ipv4), JSON.stringify(ipv6), now)
      .run();
    if (meshSealing) await resealMeshKeys(env, db, now);
    const directory = await afterRelayChange(env, db, ca, now);
    return json({ ok: true, relay: entry, directoryVersion: directory?.directoryVersion ?? 0 });
  }

  if (!relayId && ["update", "retire", "stage-key", "key-deadline"].includes(String(op))) return json({ error: "relayId required" }, 400);

  if (op === "update") {
    const row = await relayRow(db, relayId!);
    if (!row || row.retired_at != null) return json({ error: "no such active relay" }, 404);
    const next = directoryEntryOf(row);
    if (body.kind !== undefined) {
      if (body.kind !== "full" && body.kind !== "entry") return json({ error: "kind must be full or entry" }, 400);
      next.relayKind = body.kind;
    }
    if (body.region !== undefined) {
      if (typeof body.region !== "string" || !REGION.test(body.region)) return json({ error: "region must be a short lowercase label" }, 400);
      next.region = body.region;
    }
    if (body.ipv4 !== undefined) {
      const v = addressesOf(body.ipv4);
      if (!v) return json({ error: "ipv4 must be a list" }, 400);
      next.ipv4 = v;
    }
    if (body.ipv6 !== undefined) {
      const v = addressesOf(body.ipv6);
      if (!v) return json({ error: "ipv6 must be a list" }, 400);
      next.ipv6 = v;
    }
    try {
      relayDirectoryEntryLine(next, apex);
    } catch (e) {
      return json({ error: String((e as Error).message ?? e) }, 400);
    }
    await db
      .prepare("UPDATE relays SET kind = ?, region = ?, ipv4_json = ?, ipv6_json = ? WHERE relay_id = ? AND retired_at IS NULL")
      .bind(next.relayKind, next.region, JSON.stringify(next.ipv4), JSON.stringify(next.ipv6), relayId)
      .run();
    const directory = await afterRelayChange(env, db, ca, now);
    return json({ ok: true, relay: next, directoryVersion: directory?.directoryVersion ?? 0 });
  }

  if (op === "retire") {
    const r = await db.prepare("UPDATE relays SET retired_at = ? WHERE relay_id = ? AND retired_at IS NULL").bind(now, relayId).run();
    if (!r.meta?.changes) return json({ error: "no such active relay" }, 404);
    // A new epoch the retired relay is not sealed to: it cannot read anything written from now on.
    let epoch: number | null = null;
    if (meshSealing) {
      epoch = await rotateMeshEpoch(db, `retire ${relayId}`, now);
      await resealMeshKeys(env, db, now);
    }
    const directory = await afterRelayChange(env, db, ca, now, "tail");
    return json({ ok: true, retired: relayId, meshEpoch: epoch, directoryVersion: directory?.directoryVersion ?? 0 });
  }

  if (op === "stage-key") {
    const nextKey = typeof body.nextKey === "string" ? body.nextKey.toLowerCase() : "";
    if (!HEX64.test(nextKey)) return json({ error: "nextKey must be 64 hex" }, 400);
    const deadline = body.deadline;
    if (deadline !== undefined && deadline !== null && !(typeof deadline === "number" && Number.isSafeInteger(deadline) && deadline > now)) {
      return json({ error: "deadline must be a future time in ms" }, 400);
    }
    const taken = await db.prepare("SELECT relay_id FROM relays WHERE relay_key = ? OR (next_relay_key = ? AND relay_id <> ?)").bind(nextKey, nextKey, relayId).first();
    if (taken) return json({ error: "this key was used before" }, 409);
    const r = await db
      .prepare("UPDATE relays SET next_relay_key = ?, key_deadline = COALESCE(?, key_deadline) WHERE relay_id = ? AND retired_at IS NULL")
      .bind(nextKey, typeof deadline === "number" ? deadline : null, relayId)
      .run();
    if (!r.meta?.changes) return json({ error: "no such active relay" }, 404);
    return json({ ok: true, relayId, nextKey, keyDeadline: typeof deadline === "number" ? deadline : null });
  }

  if (op === "key-deadline") {
    const deadline = body.deadline;
    if (deadline !== null && !(typeof deadline === "number" && Number.isSafeInteger(deadline) && deadline > 0)) {
      return json({ error: "deadline must be a time in ms, or null to clear it" }, 400);
    }
    const r = await db.prepare("UPDATE relays SET key_deadline = ? WHERE relay_id = ? AND retired_at IS NULL").bind(deadline, relayId).run();
    if (!r.meta?.changes) return json({ error: "no such active relay" }, 404);
    return json({ ok: true, relayId, keyDeadline: deadline });
  }

  if (op === "rotate-mesh-key") {
    if (!meshSealing) return json({ error: "RELAY_MESH_KEY_SEED is not set" }, 503);
    const reason = typeof body.reason === "string" && body.reason.length > 0 ? body.reason : "rotate";
    const epoch = await rotateMeshEpoch(db, reason, now);
    const sealed = await resealMeshKeys(env, db, now);
    await pokeServingFeed(env, { type: "relay-feed", force: "tail" });
    return json({ ok: true, meshEpoch: epoch, sealedTo: sealed.relays });
  }

  if (op === "mint-directory") {
    const { directory, minted } = await mintRelayDirectory(env, db, ca, now, true);
    await publishDirectory(env, db);
    await pokeServingFeed(env, { type: "relay-feed" });
    return json({ ok: true, minted, directoryVersion: directory?.directoryVersion ?? 0 });
  }

  if (op === "backfill") {
    if (!env.SERVING_REVOCATION_SEED) return json({ error: "SERVING_REVOCATION_SEED is not set" }, 503);
    const r = await backfillRelayLog(env, db);
    await pokeServingFeed(env, { type: "relay-feed" });
    return json({ ok: true, ...r });
  }

  if (op === "republish") {
    await pokeServingFeed(env, { type: "relay-feed", force: "all" });
    if (meshSealing) await resealMeshKeys(env, db, now);
    await publishDirectory(env, db);
    return json({ ok: true });
  }

  return json({ error: "op must be one of add, update, retire, stage-key, key-deadline, rotate-mesh-key, mint-directory, backfill, republish, list" }, 400);
}
