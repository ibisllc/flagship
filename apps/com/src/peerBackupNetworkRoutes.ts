/**
 * Peer backup between accounts on `.com` (docs/peer-backup.md): the Worker
 * side of packages/control-plane/src/peerBackupNetwork.ts.
 *
 *   GET  /api/peer-backup/network
 *   POST /api/peer-backup/holder/checkin | holder/proof | holder/redeem
 *   POST /api/peer-backup/filler | directory | tokens
 *   PUT|GET /api/peer-backup/root/<serverDomain>
 *
 * Secrets: PB_TOKEN_RSA_JWK (the blind-signing key, JWK JSON), PB_FILLER_SECRET
 * and PB_TAG_SECRET (64 hex chars each). Without them every route but the
 * root read answers 503 with a sentence. PB_NETWORK (JSON) overrides the
 * network constants (the gym runs k=1, n=1).
 */
import {
  InMemoryPbNetStore,
  routePbNet,
  type PbHolderRow,
  type PbNetDeps,
  type PbNetStore,
  type PbRootRow,
} from "@flagship/control-plane";
import { PB_NETWORK_DEFAULT, parsePbNetwork, rsaPrivateKeyFromJwk, type PbNetwork, type RsaPrivateKey } from "@flagship/protocol";
import { D1Storage, type D1Database } from "@flagship/storage";

export interface PeerBackupNetEnv {
  DB?: D1Database;
  PB_TOKEN_RSA_JWK?: string;
  PB_FILLER_SECRET?: string;
  PB_TAG_SECRET?: string;
  PB_NETWORK?: string;
  SERVICES_BASE_URL?: string;
}

const PATHS = /^\/api\/peer-backup\/(network|holder\/checkin|holder\/proof|holder\/redeem|filler|directory|tokens|root\/[^/]+)$/;

export function isPeerBackupNetPath(pathname: string): boolean {
  return PATHS.test(pathname);
}

export class D1PbNetStore implements PbNetStore {
  constructor(private readonly db: D1Database) {}

  private static row(r: { row_json: string } | null): PbHolderRow | null {
    if (!r) return null;
    try {
      return JSON.parse(r.row_json) as PbHolderRow;
    } catch {
      return null;
    }
  }

  async holderByServer(serverDomain: string) {
    return D1PbNetStore.row(await this.db.prepare("SELECT row_json FROM pb_holders WHERE server_domain = ?").bind(serverDomain).first<{ row_json: string }>());
  }
  async holderByPik(pik: string) {
    return D1PbNetStore.row(await this.db.prepare("SELECT row_json FROM pb_holders WHERE pik_pub_hex = ?").bind(pik).first<{ row_json: string }>());
  }
  async putHolder(row: PbHolderRow) {
    await this.db.batch([
      this.db.prepare("DELETE FROM pb_holders WHERE server_domain = ? AND pik_pub_hex <> ?").bind(row.serverDomain, row.pikPubHex),
      this.db
        .prepare(
          "INSERT INTO pb_holders (pik_pub_hex, server_domain, username, last_checkin_at, row_json) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(pik_pub_hex) DO UPDATE SET server_domain = excluded.server_domain, username = excluded.username, last_checkin_at = excluded.last_checkin_at, row_json = excluded.row_json",
        )
        .bind(row.pikPubHex, row.serverDomain, row.username, row.lastCheckinAt, JSON.stringify(row)),
    ]);
  }
  async listHolders() {
    const r = await this.db.prepare("SELECT row_json FROM pb_holders").all<{ row_json: string }>();
    return (r.results ?? []).map((x) => D1PbNetStore.row(x)).filter((x): x is PbHolderRow => x !== null);
  }
  async putLease(pik: string, leaseId: string, slots: number, expiresAt: number) {
    await this.db
      .prepare(
        "INSERT INTO pb_leases (pik_pub_hex, lease_id, slots, expires_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(pik_pub_hex, lease_id) DO UPDATE SET slots = excluded.slots, expires_at = excluded.expires_at",
      )
      .bind(pik, leaseId, slots, expiresAt)
      .run();
  }
  async liveLeaseSlots(pik: string, now: number) {
    const r = await this.db.prepare("SELECT COALESCE(SUM(slots), 0) AS n FROM pb_leases WHERE pik_pub_hex = ? AND expires_at > ?").bind(pik, now).first<{ n: number }>();
    return Number(r?.n ?? 0);
  }
  async spendSerial(h: string, pik: string, at: number) {
    const r = await this.db.prepare("INSERT OR IGNORE INTO pb_token_serials (serial_sha256, pik_pub_hex, spent_at) VALUES (?, ?, ?)").bind(h, pik, at).run();
    return Number((r as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0;
  }
  async tokensIssuedSince(serverDomain: string, since: number) {
    const r = await this.db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM pb_token_issue WHERE server_domain = ? AND issued_at >= ?").bind(serverDomain, since).first<{ n: number }>();
    return Number(r?.n ?? 0);
  }
  async recordIssue(serverDomain: string, at: number, count: number) {
    await this.db.batch([
      this.db.prepare("INSERT INTO pb_token_issue (server_domain, issued_at, count) VALUES (?, ?, ?)").bind(serverDomain, at, count),
      this.db.prepare("DELETE FROM pb_token_issue WHERE issued_at < ?").bind(at - 32 * 24 * 60 * 60_000),
    ]);
  }
  private static rootRow(r: {
    server_domain: string;
    username: string;
    generation: number;
    revision: number;
    stored_at: number;
    nonce_hex: string;
    ciphertext_hex: string;
  }): PbRootRow {
    return {
      serverDomain: r.server_domain,
      username: r.username,
      generation: r.generation,
      revision: r.revision,
      storedAt: r.stored_at,
      nonceHex: r.nonce_hex,
      ciphertextHex: r.ciphertext_hex,
    };
  }
  async latestRoot(serverDomain: string) {
    return (await this.listRoots(serverDomain))[0] ?? null;
  }
  async listRoots(serverDomain: string) {
    const r = await this.db
      .prepare("SELECT * FROM pb_roots WHERE server_domain = ? ORDER BY generation DESC, revision DESC")
      .bind(serverDomain)
      .all<Parameters<typeof D1PbNetStore.rootRow>[0]>();
    return (r.results ?? []).map(D1PbNetStore.rootRow);
  }
  async putRoot(row: PbRootRow, keep: number) {
    await this.db.batch([
      this.db
        .prepare("INSERT INTO pb_roots (server_domain, username, generation, revision, stored_at, nonce_hex, ciphertext_hex) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(row.serverDomain, row.username, row.generation, row.revision, row.storedAt, row.nonceHex, row.ciphertextHex),
      this.db
        .prepare(
          "DELETE FROM pb_roots WHERE server_domain = ? AND (generation, revision) NOT IN " +
            "(SELECT generation, revision FROM pb_roots WHERE server_domain = ? ORDER BY generation DESC, revision DESC LIMIT ?)",
        )
        .bind(row.serverDomain, row.serverDomain, keep),
    ]);
  }
}

function hexKey(s: string | undefined): Uint8Array | null {
  if (!s || !/^[0-9a-f]{64}$/i.test(s.trim())) return null;
  const t = s.trim();
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(t.slice(i * 2, i * 2 + 2), 16);
  return out;
}

let keyMemo: { src: string; key: RsaPrivateKey } | null = null;
function tokenKey(env: PeerBackupNetEnv): RsaPrivateKey | null {
  const src = env.PB_TOKEN_RSA_JWK;
  if (!src) return null;
  if (keyMemo?.src === src) return keyMemo.key;
  try {
    const key = rsaPrivateKeyFromJwk(JSON.parse(src) as Record<string, unknown>);
    keyMemo = { src, key };
    return key;
  } catch (e) {
    console.error("[peer-backup] PB_TOKEN_RSA_JWK doesn't parse", (e as Error).message);
    return null;
  }
}

function network(env: PeerBackupNetEnv): PbNetwork {
  if (!env.PB_NETWORK) return PB_NETWORK_DEFAULT;
  try {
    const n = parsePbNetwork({ ...PB_NETWORK_DEFAULT, ...(JSON.parse(env.PB_NETWORK) as object) });
    if (typeof n !== "string") return n;
    console.error("[peer-backup] PB_NETWORK ignored:", n);
  } catch {
    console.error("[peer-backup] PB_NETWORK isn't JSON; using the defaults");
  }
  return PB_NETWORK_DEFAULT;
}

/** Filler with WebCrypto AES-CTR: one 4 MiB brick is a few ms of Worker CPU. */
async function webCryptoFiller(key: Uint8Array, offset: number, len: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "AES-CTR" }, false, ["encrypt"]);
  const counter = new Uint8Array(16);
  let block = Math.floor(offset / 16);
  for (let i = 15; i >= 0 && block > 0; i--) {
    counter[i] = block & 0xff;
    block = Math.floor(block / 256);
  }
  return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter, length: 128 }, k, new Uint8Array(len)));
}

export function peerBackupNetDeps(env: PeerBackupNetEnv & { DB: D1Database }): PbNetDeps {
  return {
    servers: new D1Storage(env.DB).servers,
    store: new D1PbNetStore(env.DB),
    network: network(env),
    relayBase: env.SERVICES_BASE_URL ?? "https://flagship-services.fly.dev:8443",
    tokenKey: tokenKey(env),
    fillerSecret: hexKey(env.PB_FILLER_SECRET),
    tagSecret: hexKey(env.PB_TAG_SECRET),
    fillerBytes: webCryptoFiller,
  };
}

export async function handlePeerBackupNetRoute(request: Request, env: PeerBackupNetEnv, deps?: PbNetDeps): Promise<Response> {
  const url = new URL(request.url);
  if (!deps && !env.DB) return Response.json({ error: "peer backup needs the database" }, { status: 503 });
  const d = deps ?? peerBackupNetDeps(env as PeerBackupNetEnv & { DB: D1Database });
  let json: unknown;
  if (request.method === "POST" || request.method === "PUT") {
    const text = await request.text();
    if (text.length > 2_000_000) return Response.json({ error: "too large" }, { status: 413 });
    try {
      json = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      return Response.json({ error: "malformed JSON" }, { status: 400 });
    }
  }
  const r = await routePbNet(d, {
    method: request.method,
    path: url.pathname,
    json,
    clientIp: request.headers.get("cf-connecting-ip"),
    query: url.searchParams,
  });
  if (!r) return Response.json({ error: "not found" }, { status: 404 });
  if (r.body instanceof Uint8Array) {
    return new Response(r.body, { status: r.status, headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
  }
  return Response.json(r.body, { status: r.status, headers: { "cache-control": "no-store", ...(r.headers ?? {}) } });
}

export { InMemoryPbNetStore };
