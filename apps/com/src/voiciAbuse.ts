/**
 * voi.ci abuse handling on `.com` (docs/voici-and-messages.md §9.2-§9.7):
 *
 *   POST /api/voici/reports                      a report: an owner's signed message report, or anyone's page report
 *   GET  /api/admin/voici/reports[?status=all]   (x-admin-secret) open reports, newest last
 *   GET  /api/admin/voici/reports/<id>           (x-admin-secret) one report in full (envelope, sealed text)
 *   POST /api/admin/voici/ban                    (x-admin-secret) {username, reportId, reason}
 *   POST /api/admin/voici/unban                  (x-admin-secret) {username}
 *   POST /api/admin/voici/dismiss                (x-admin-secret) {reportId}
 *   POST /api/admin/voici/takedown               (x-admin-secret) {username, reason}; repeat until done: true
 *   POST /api/admin/voici/restore                (x-admin-secret) {username}
 *   GET  /api/admin/voici/stats                  (x-admin-secret) counts for `npm run ops -- voici`
 *
 * The reporter's address is never stored (the rate limiter counts it in Durable Objects only). `.com` never opens
 * an abuse tag: the owner does, offline (scripts/voici-abuse.mjs). Pages and their pieces live in R2 (`VOICI`,
 * chunk B1); a takedown deletes them and purges `files.voi.ci` by URL.
 */
import { authorizeAdmin } from "@flagship/control-plane";
import {
  b64Decode,
  canonicalVoiciReport,
  checkWebDelegation,
  isLowerHex,
  p256VerifyP1363,
  parseMessagesKeyAttestation,
  parseVoiciBanRequest,
  parseVoiciTakedownRequest,
  parseWebEnvelope,
  verifyVoiciMessageReport,
  VOICI_WEB_ORIGIN,
  type VoiciMessageReport,
  type VoiciPageReport,
  voiciNameKey,
} from "@flagship/protocol";
import type { D1Database } from "@flagship/storage";
import type { DeviceIntegrity, IntegrityPlatform } from "./deviceIntegrity.js";

export type WaitUntil = (p: Promise<unknown>) => void;

export const VOICI_REPORTS_PATH = "/api/voici/reports";
export const VOICI_ADMIN_PREFIX = "/api/admin/voici/";

const REPORT_SKEW_MS = 10 * 60_000;
/** §9.3: reports are accepted for 90 days after the message was sent. */
export const REPORT_WINDOW_MS = 90 * 86_400_000;
/** §9.5: a device token is kept 30 days to set the device's ban bit. */
export const DEVICE_TOKEN_KEEP_MS = 30 * 86_400_000;
const MAX_REPORT_BYTES = 112 * 1024;
const MAX_ATTACHED_BYTES = 12 * 1024;
const TAKEDOWN_PIECES_PER_CALL = 300;
const PURGE_URLS_PER_CALL = 30;

export interface VoiciBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
}

export interface VoiciAbuseEnv {
  DB?: D1Database;
  VOICI?: VoiciBucket;
  VOICI_ENABLED?: string;
  /** Website origin a visitor's delegation names: https://voi.ci (gym https://gym.voi.ci). */
  VOICI_WEB_ORIGIN?: string;
  /** Default files.voi.ci (gym files.gym.voi.ci). */
  VOICI_FILES_HOST?: string;
  /** Zone of the files host, for purge-by-URL. */
  VOICI_FILES_ZONE_ID?: string;
  /** Cloudflare API token with Cache Purge on that zone. */
  CLOUDFLARE_PURGE_TOKEN?: string;
  FLAGSHIP_ADMIN_SECRET?: string;
}

/** The current page as the R2 index says (enough to check a report). */
export interface VoiciPageRef {
  username: string;
  pageId: string;
  seq: number;
  ownerSignPub: string;
}

export interface VoiciAbuseDeps {
  now: () => number;
  integrity: DeviceIntegrity;
  /** Default: chunk B1's `voici_pages` (the last accepted index per account). */
  pages?: VoiciPageLookup;
  fetchFn?: typeof fetch;
  waitUntil?: WaitUntil;
}

export function voiciEnabled(env: { VOICI_ENABLED?: string }): boolean {
  return env.VOICI_ENABLED === "on" || env.VOICI_ENABLED === "true" || env.VOICI_ENABLED === "1";
}

export function voiciWebOrigin(env: { VOICI_WEB_ORIGIN?: string }): string {
  return env.VOICI_WEB_ORIGIN ?? VOICI_WEB_ORIGIN;
}

export function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

// ── reads other chunks use ────────────────────────────────────────────────

/** A ban row's name as the names registry folds it (migration 0127): a ban holds every name that shares its safety key. */
const BAN_KEY = "replace(replace(replace(lower(username), '-', ''), '0', 'o'), '1', 'l')";

/** Banned from Messages and pages (§9.3): no attestations, no publishes. Matched on the name's safety key, and kept
 *  when the account is deleted, so the name (or one too close to it) claimed again later is still banned. */
export async function isAccountBanned(db: D1Database, username: string): Promise<boolean> {
  return !!(await db.prepare(`SELECT 1 AS x FROM voici_bans WHERE ${BAN_KEY} = ?1 LIMIT 1`).bind(voiciNameKey(username)).first());
}

/** A pseudonym Flagship banned from a confirmed report: its sends are dropped at once (§9.3). */
export async function isPseudonymBanned(db: D1Database, pseudonymPub: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 AS x FROM voici_banned_pseudonyms WHERE pseudonym_pub = ?1").bind(pseudonymPub).first());
}

/** A taken-down page (§9.6): voi.ci answers 410 and publishes are refused `taken-down`. */
export async function isTakenDown(db: D1Database, username: string): Promise<{ reason: string } | null> {
  return await db.prepare("SELECT reason FROM voici_takedowns WHERE username = ?1").bind(username.toLowerCase()).first<{ reason: string }>();
}

/** Account deletion (§10.3): this chunk's rows for the account. A ban stays: it follows the name, not the account,
 *  until an operator lifts it (`unban`), so deleting the account and claiming the name again does not clear it. */
export async function deleteVoiciAbuseAccount(db: D1Database, username: string): Promise<void> {
  const u = username.toLowerCase();
  await db.batch([
    db.prepare("DELETE FROM messages_enrollments WHERE username = ?1").bind(u),
    db.prepare("DELETE FROM messages_attest_counters WHERE username = ?1").bind(u),
    db.prepare("DELETE FROM voici_takedowns WHERE username = ?1").bind(u),
  ]);
}

/** Retention (§9.5, §9.2): old counters, device tokens past 30 days, resolved reports past a year. */
export async function pruneVoiciAbuse(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM messages_attest_counters WHERE day < ?1").bind(new Date(now - 2 * 86_400_000).toISOString().slice(0, 10)),
    db.prepare("UPDATE messages_enrollments SET device_token = NULL, device_token_at = NULL WHERE device_token_at < ?1").bind(now - DEVICE_TOKEN_KEEP_MS),
    db.prepare("DELETE FROM voici_reports WHERE status <> 'open' AND resolved_at < ?1").bind(now - 365 * 86_400_000),
  ]);
}

// ── pages ───────────────────────────────────────────────────────────────────

export interface VoiciPageLookup {
  byUsername(username: string): Promise<VoiciPageRef | null>;
  byPageId(pageId: string): Promise<VoiciPageRef | null>;
}

/** B1's `voici_pages` (migration 0123): the stored index's page id, seq and owner messages key. */
export function d1Pages(db: D1Database): VoiciPageLookup {
  type Row = { username: string; page_id: string; seq: number; owner_sign_pub: string };
  const ref = (r: Row | null): VoiciPageRef | null => (r ? { username: r.username, pageId: r.page_id, seq: r.seq, ownerSignPub: r.owner_sign_pub } : null);
  return {
    byUsername: async (u) => ref(await db.prepare("SELECT username, page_id, seq, owner_sign_pub FROM voici_pages WHERE username = ?1").bind(u).first<Row>()),
    byPageId: async (id) => ref(await db.prepare("SELECT username, page_id, seq, owner_sign_pub FROM voici_pages WHERE page_id = ?1").bind(id).first<Row>()),
  };
}

/** The current index object in R2 (`v1/u/<username>.json`), as a takedown finds it. */
export function r2PageOf(bucket: VoiciBucket | undefined): (username: string) => Promise<VoiciPageRef | null> {
  return async (username) => {
    if (!bucket) return null;
    const obj = await bucket.get(`v1/u/${username}.json`);
    if (!obj) return null;
    try {
      const idx = JSON.parse(await obj.text()) as Record<string, unknown>;
      if (idx.username !== username || !isLowerHex(idx.pageId, 16) || !isLowerHex(idx.ownerSignPub, 32) || typeof idx.seq !== "number") return null;
      return { username, pageId: idx.pageId as string, seq: idx.seq, ownerSignPub: idx.ownerSignPub as string };
    } catch {
      return null;
    }
  };
}

// ── reports ─────────────────────────────────────────────────────────────────

const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const exactKeys = (o: Record<string, unknown>, keys: string[]) => {
  const k = Object.keys(o).sort();
  const want = [...keys].sort();
  return k.length === want.length && k.every((x, i) => x === want[i]);
};

function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** CORS for voi.ci on the report route (B2: §4.4 lists the routes voi.ci calls; page reports are one of them). */
export function reportCors(request: Request, env: VoiciAbuseEnv): Record<string, string> {
  const origin = request.headers.get("origin");
  return origin === voiciWebOrigin(env) ? { "access-control-allow-origin": origin, vary: "Origin" } : {};
}

export async function handleVoiciReport(request: Request, env: VoiciAbuseEnv, deps: VoiciAbuseDeps): Promise<Response> {
  const cors = reportCors(request, env);
  if (request.method === "OPTIONS") {
    if (!cors["access-control-allow-origin"]) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: { ...cors, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600" },
    });
  }
  const reply = (body: unknown, status: number) => json(body, status, cors);
  if (request.method !== "POST") return reply({ error: "method not allowed", code: "malformed" }, 405);
  const db = env.DB;
  if (!db) return reply({ error: "unavailable", code: "unavailable" }, 503);
  const text = await request.text();
  if (text.length > MAX_REPORT_BYTES) return reply({ error: "too large", code: "too-large" }, 413);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return reply({ error: "malformed", code: "malformed" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return reply({ error: "malformed", code: "malformed" }, 400);
  const now = deps.now();
  const pages = deps.pages ?? d1Pages(db);
  if (typeof body.issuedAt !== "number" || Math.abs(now - body.issuedAt) > REPORT_SKEW_MS) return reply({ error: "stale", code: "stale" }, 403);

  if (body.kind === "message") {
    if (!exactKeys(body, ["kind", "pageId", "envelope", "reason", "attached", "issuedAt", "signature"])) return reply({ error: "malformed", code: "malformed" }, 400);
    const r = body as unknown as VoiciMessageReport & { signature: unknown };
    if (!isLowerHex(r.pageId, 16)) return reply({ error: "malformed", code: "malformed" }, 400);
    const page = await pages.byPageId(r.pageId);
    if (!page) return reply({ error: "not found", code: "not-found" }, 404);
    if (r.attached !== null && (b64Decode(r.attached)?.length ?? Infinity) > MAX_ATTACHED_BYTES) return reply({ error: "malformed", code: "malformed" }, 400);
    const env1 = parseWebEnvelope(r.envelope);
    if (!env1 || env1.kind !== "voici-message" || env1.audience !== page.pageId || !isLowerHex(env1.from, 32)) return reply({ error: "malformed", code: "malformed" }, 400);
    const att = parseMessagesKeyAttestation(env1.cred.attestation);
    if (!att || att.pseudonymPub !== env1.from) return reply({ error: "malformed", code: "malformed" }, 400);
    try {
      canonicalVoiciReport(r);
    } catch {
      return reply({ error: "malformed", code: "malformed" }, 400);
    }
    if (typeof r.signature !== "string" || !verifyVoiciMessageReport(r, r.signature, page.ownerSignPub)) return reply({ error: "bad signature", code: "bad-signature" }, 403);
    if (now - env1.sentAt > REPORT_WINDOW_MS) return reply({ error: "too old to report", code: "stale" }, 403);
    const id = randomId();
    await db
      .prepare(
        "INSERT OR IGNORE INTO voici_reports (id, kind, username, page_id, page_seq, msg_id, pseudonym_pub, reason, envelope_json, attached_b64, signed, created_at) " +
          "VALUES (?1, 'message', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10)",
      )
      .bind(id, page.username, page.pageId, page.seq, env1.msgId, env1.from, r.reason, JSON.stringify(r.envelope), r.attached, now)
      .run();
    const row = await db.prepare("SELECT id FROM voici_reports WHERE kind = 'message' AND page_id = ?1 AND msg_id = ?2").bind(page.pageId, env1.msgId).first<{ id: string }>();
    return reply({ reportId: row?.id ?? id }, 200);
  }

  if (body.kind === "page") {
    if (!exactKeys(body, ["kind", "username", "seq", "reason", "note", "issuedAt", "signer"])) return reply({ error: "malformed", code: "malformed" }, 400);
    if (typeof body.username !== "string" || !USERNAME.test(body.username)) return reply({ error: "malformed", code: "malformed" }, 400);
    const page = await pages.byUsername(body.username);
    if (!page) return reply({ error: "not found", code: "not-found" }, 404);
    const r = body as unknown as VoiciPageReport & { signer: unknown };
    let bytes: Uint8Array;
    try {
      bytes = canonicalVoiciReport(r);
    } catch {
      return reply({ error: "malformed", code: "malformed" }, 400);
    }
    if (r.seq > page.seq) return reply({ error: "malformed", code: "malformed" }, 400);
    let signed = 0;
    if (r.signer !== null) {
      const s = r.signer as Record<string, unknown>;
      if (!s || typeof s !== "object" || !exactKeys(s, ["delegation", "delegationSig", "sig"])) return reply({ error: "malformed", code: "malformed" }, 400);
      const principal = (s.delegation as { principalPub?: unknown } | null)?.principalPub;
      const del = checkWebDelegation(s.delegation, s.delegationSig, {
        scope: "voici-messages",
        origin: voiciWebOrigin(env),
        audience: page.pageId,
        principalPub: typeof principal === "string" ? principal : "",
        now,
      });
      if (!del.ok || typeof s.sig !== "string" || !p256VerifyP1363(s.sig, bytes, del.delegation.delegatePub)) return reply({ error: "bad signature", code: "bad-signature" }, 403);
      signed = 1;
    }
    const id = randomId();
    await db
      .prepare("INSERT INTO voici_reports (id, kind, username, page_id, page_seq, reason, note, signed, created_at) VALUES (?1, 'page', ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
      .bind(id, page.username, page.pageId, r.seq, r.reason, r.note, signed, now)
      .run();
    return reply({ reportId: id }, 200);
  }
  return reply({ error: "malformed", code: "malformed" }, 400);
}

// ── admin ───────────────────────────────────────────────────────────────────

interface ReportRow {
  id: string;
  kind: "message" | "page";
  username: string;
  page_id: string | null;
  page_seq: number | null;
  msg_id: string | null;
  pseudonym_pub: string | null;
  reason: string;
  note: string | null;
  envelope_json: string | null;
  attached_b64: string | null;
  signed: number;
  status: string;
  created_at: number;
  resolved_at: number | null;
}

function summary(r: ReportRow) {
  let abuseEpoch: number | null = null;
  if (r.envelope_json) {
    try {
      abuseEpoch = (JSON.parse(r.envelope_json) as { cred?: { attestation?: { abuseEpoch?: number } } }).cred?.attestation?.abuseEpoch ?? null;
    } catch {
      abuseEpoch = null;
    }
  }
  return {
    id: r.id,
    kind: r.kind,
    username: r.username,
    pageId: r.page_id,
    pageSeq: r.page_seq,
    msgId: r.msg_id,
    reason: r.reason,
    signed: r.signed === 1,
    hasText: r.attached_b64 !== null,
    abuseEpoch,
    status: r.status,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

async function readJsonBody(request: Request): Promise<unknown> {
  const t = await request.text();
  if (t.length > 4096) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** Sets or clears the ban bit on the account's newest device, when its token is younger than 30 days. */
async function markDevice(db: D1Database, integrity: DeviceIntegrity, username: string, banned: boolean, now: number): Promise<"marked" | "no-token" | "failed"> {
  const row = await db
    .prepare("SELECT platform, device_token, device_token_at FROM messages_enrollments WHERE username = ?1")
    .bind(username)
    .first<{ platform: string; device_token: string | null; device_token_at: number | null }>();
  if (!row?.device_token || row.platform === "none" || (row.device_token_at ?? 0) < now - DEVICE_TOKEN_KEEP_MS) return "no-token";
  const ok = await integrity.setBits(row.platform as IntegrityPlatform, row.device_token, { banned }, now);
  if (ok && banned) await db.prepare("UPDATE messages_enrollments SET ban_marked_at = ?2 WHERE username = ?1").bind(username, now).run();
  return ok ? "marked" : "failed";
}

async function purgeUrls(env: VoiciAbuseEnv, fetchFn: typeof fetch, urls: string[]): Promise<boolean> {
  if (urls.length === 0) return true;
  if (!env.CLOUDFLARE_PURGE_TOKEN || !env.VOICI_FILES_ZONE_ID) return false;
  let ok = true;
  for (let i = 0; i < urls.length; i += PURGE_URLS_PER_CALL) {
    const res = await fetchFn(`https://api.cloudflare.com/client/v4/zones/${env.VOICI_FILES_ZONE_ID}/purge_cache`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.CLOUDFLARE_PURGE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ files: urls.slice(i, i + PURGE_URLS_PER_CALL) }),
    });
    ok &&= res.ok;
  }
  return ok;
}

/**
 * Deletes a page's index and pieces from R2 and purges their URLs, at most TAKEDOWN_PIECES_PER_CALL pieces a call
 * (a page has no cap on pieces, and a Worker call has a subrequest budget). Pieces are deleted only after their
 * purge was asked for, so a call that stops early leaves nothing cached that R2 no longer lists.
 */
async function takedownStep(db: D1Database, env: VoiciAbuseEnv, fetchFn: typeof fetch, username: string): Promise<{ done: boolean; deleted: number; purged: boolean }> {
  const bucket = env.VOICI;
  const host = env.VOICI_FILES_HOST ?? "files.voi.ci";
  const row = await db
    .prepare("SELECT t.page_id AS taken, p.page_id AS published FROM voici_takedowns t LEFT JOIN voici_pages p ON p.username = t.username WHERE t.username = ?1")
    .bind(username)
    .first<{ taken: string | null; published: string | null }>();
  let pageId = row?.taken ?? row?.published ?? null;
  let deleted = 0;
  let purged = true;
  if (!bucket) return { done: false, deleted, purged: false };
  const indexKey = `v1/u/${username}.json`;
  const index = await bucket.get(indexKey);
  if (index) {
    try {
      const id = (JSON.parse(await index.text()) as { pageId?: unknown }).pageId;
      if (isLowerHex(id, 16)) pageId = id;
    } catch {
      /* an unreadable index is still deleted */
    }
    if (pageId) await db.prepare("UPDATE voici_takedowns SET page_id = ?2 WHERE username = ?1").bind(username, pageId).run();
    purged &&= await purgeUrls(env, fetchFn, [`https://${host}/${indexKey}`]);
    await bucket.delete(indexKey);
    deleted++;
  }
  if (pageId) {
    const listed = await bucket.list({ prefix: `v1/p/${pageId}/`, limit: TAKEDOWN_PIECES_PER_CALL });
    const keys = listed.objects.map((o) => o.key);
    if (keys.length) {
      purged &&= await purgeUrls(env, fetchFn, keys.map((k) => `https://${host}/${k}`));
      await bucket.delete(keys);
      deleted += keys.length;
    }
    if (listed.truncated) return { done: false, deleted, purged };
    // The page is gone, so are its visitors' reply alerts (migration 0125).
    await db.prepare("DELETE FROM voici_alerts WHERE page_id = ?1").bind(pageId).run();
  }
  await db.prepare("UPDATE voici_takedowns SET purge_pending = 0 WHERE username = ?1").bind(username).run();
  return { done: true, deleted, purged };
}

export async function handleVoiciAdmin(request: Request, env: VoiciAbuseEnv, deps: VoiciAbuseDeps & { abuseKeyStatus?: () => { epoch: number; notAfter: number } | null }): Promise<Response> {
  const auth = authorizeAdmin({ expected: env.FLAGSHIP_ADMIN_SECRET, provided: request.headers.get("x-admin-secret") });
  if (auth) return json(auth.body, auth.status);
  const db = env.DB;
  if (!db) return json({ error: "unavailable" }, 503);
  const url = new URL(request.url);
  const sub = url.pathname.slice(VOICI_ADMIN_PREFIX.length);
  const now = deps.now();
  const fetchFn = deps.fetchFn ?? ((i: RequestInfo | URL, init?: RequestInit) => fetch(i, init));
  const later = (p: Promise<unknown>) => (deps.waitUntil ? deps.waitUntil(p) : p);

  if (request.method === "GET" && sub === "reports") {
    const all = url.searchParams.get("status") === "all";
    const rows = await db
      .prepare(`SELECT * FROM voici_reports ${all ? "" : "WHERE status = 'open'"} ORDER BY created_at ASC LIMIT 500`)
      .all<ReportRow>();
    return json({ reports: (rows.results ?? []).map(summary) }, 200);
  }
  const one = /^reports\/([0-9a-f]{32})$/.exec(sub);
  if (request.method === "GET" && one) {
    const r = await db.prepare("SELECT * FROM voici_reports WHERE id = ?1").bind(one[1]).first<ReportRow>();
    if (!r) return json({ error: "not found", code: "not-found" }, 404);
    return json({ report: { ...summary(r), note: r.note, envelope: r.envelope_json ? JSON.parse(r.envelope_json) : null, attached: r.attached_b64 } }, 200);
  }
  if (request.method === "GET" && sub === "stats") {
    await pruneVoiciAbuse(db, now);
    const day = new Date(now).toISOString().slice(0, 10);
    const [open, recent, bans, pseudonyms, takedowns, enrollments, today] = await db.batch([
      db.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM voici_reports WHERE status = 'open'"),
      db.prepare("SELECT COUNT(*) AS n FROM voici_reports WHERE created_at >= ?1").bind(now - 7 * 86_400_000),
      db.prepare("SELECT COUNT(*) AS n FROM voici_bans"),
      db.prepare("SELECT COUNT(*) AS n FROM voici_banned_pseudonyms"),
      db.prepare("SELECT COUNT(*) AS n, SUM(purge_pending) AS pending FROM voici_takedowns"),
      db.prepare("SELECT platform, COUNT(*) AS n FROM messages_enrollments GROUP BY platform"),
      db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM messages_attest_counters WHERE day = ?1").bind(day),
    ]);
    const rows = (r: { results?: unknown[] } | undefined) => (r?.results ?? []) as Record<string, unknown>[];
    const first = (r: { results?: unknown[] } | undefined) => rows(r)[0] ?? {};
    const byPlatform: Record<string, number> = { ios: 0, android: 0, none: 0 };
    for (const row of rows(enrollments)) byPlatform[String(row.platform)] = Number(row.n);
    return json(
      {
        now,
        enabled: voiciEnabled(env),
        openReports: Number(first(open).n ?? 0),
        oldestOpenReportAt: first(open).oldest ?? null,
        reportsLast7Days: Number(first(recent).n ?? 0),
        bans: Number(first(bans).n ?? 0),
        bannedPseudonyms: Number(first(pseudonyms).n ?? 0),
        takedowns: Number(first(takedowns).n ?? 0),
        takedownsPurgePending: Number(first(takedowns).pending ?? 0),
        enrollments: byPlatform,
        newRecipientsToday: Number(first(today).n ?? 0),
        abuseKey: deps.abuseKeyStatus?.() ?? null,
        purgeConfigured: !!(env.CLOUDFLARE_PURGE_TOKEN && env.VOICI_FILES_ZONE_ID),
      },
      200,
    );
  }
  if (request.method !== "POST") return json({ error: "not found" }, 404);
  const body = await readJsonBody(request);

  if (sub === "ban") {
    const b = parseVoiciBanRequest(body);
    if (!b) return json({ error: "malformed", code: "malformed" }, 400);
    const report = await db.prepare("SELECT * FROM voici_reports WHERE id = ?1").bind(b.reportId).first<ReportRow>();
    if (!report) return json({ error: "no such report", code: "not-found" }, 404);
    const stmts = [
      db.prepare("INSERT OR REPLACE INTO voici_bans (username, reason, report_id, banned_at) VALUES (?1, ?2, ?3, ?4)").bind(b.username, b.reason, b.reportId, now),
      db.prepare("UPDATE voici_reports SET status = 'banned', resolved_at = ?2 WHERE id = ?1").bind(b.reportId, now),
    ];
    if (report.pseudonym_pub) {
      stmts.push(db.prepare("INSERT OR IGNORE INTO voici_banned_pseudonyms (pseudonym_pub, report_id, banned_at) VALUES (?1, ?2, ?3)").bind(report.pseudonym_pub, b.reportId, now));
    }
    await db.batch(stmts);
    const device = markDevice(db, deps.integrity, b.username, true, now);
    later(device);
    return json({ ok: true, pseudonymBanned: !!report.pseudonym_pub, device: deps.waitUntil ? "pending" : await device }, 200);
  }
  if (sub === "unban") {
    const o = body as { username?: unknown } | null;
    if (!o || typeof o.username !== "string" || !USERNAME.test(o.username) || !exactKeys(o as Record<string, unknown>, ["username"])) return json({ error: "malformed", code: "malformed" }, 400);
    const key = voiciNameKey(o.username);
    const bans = (await db.prepare(`SELECT report_id FROM voici_bans WHERE ${BAN_KEY} = ?1`).bind(key).all<{ report_id: string | null }>()).results ?? [];
    if (!bans.length) return json({ error: "not banned", code: "not-found" }, 404);
    await db.batch([
      db.prepare(`DELETE FROM voici_bans WHERE ${BAN_KEY} = ?1`).bind(key),
      ...bans.map((b) => db.prepare("DELETE FROM voici_banned_pseudonyms WHERE report_id = ?1").bind(b.report_id ?? "")),
    ]);
    const device = markDevice(db, deps.integrity, o.username, false, now);
    later(device);
    return json({ ok: true, device: deps.waitUntil ? "pending" : await device }, 200);
  }
  if (sub === "dismiss") {
    const o = body as { reportId?: unknown } | null;
    if (!o || typeof o.reportId !== "string" || !/^[0-9a-f]{32}$/.test(o.reportId)) return json({ error: "malformed", code: "malformed" }, 400);
    const res = await db.prepare("UPDATE voici_reports SET status = 'dismissed', resolved_at = ?2 WHERE id = ?1 AND status = 'open'").bind(o.reportId, now).run();
    return res.meta?.changes ? json({ ok: true }, 200) : json({ error: "no open report with that id", code: "not-found" }, 404);
  }
  if (sub === "takedown") {
    const t = parseVoiciTakedownRequest(body);
    if (!t) return json({ error: "malformed", code: "malformed" }, 400);
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO voici_takedowns (username, reason, taken_down_at) VALUES (?1, ?2, ?3)").bind(t.username, t.reason, now),
      db.prepare("UPDATE voici_pages SET taken_down_at = ?2, takedown_reason = ?3 WHERE username = ?1 AND taken_down_at IS NULL").bind(t.username, now, t.reason),
      db.prepare("UPDATE voici_reports SET status = 'taken-down', resolved_at = ?2 WHERE username = ?1 AND kind = 'page' AND status = 'open'").bind(t.username, now),
    ]);
    const step = await takedownStep(db, env, fetchFn, t.username);
    return json({ ok: true, ...step }, 200);
  }
  if (sub === "restore") {
    const o = body as { username?: unknown } | null;
    if (!o || typeof o.username !== "string" || !USERNAME.test(o.username) || !exactKeys(o as Record<string, unknown>, ["username"])) return json({ error: "malformed", code: "malformed" }, 400);
    const [res] = await db.batch([
      db.prepare("DELETE FROM voici_takedowns WHERE username = ?1").bind(o.username),
      db.prepare("UPDATE voici_pages SET taken_down_at = NULL, takedown_reason = NULL WHERE username = ?1").bind(o.username),
    ]);
    return res?.meta?.changes ? json({ ok: true }, 200) : json({ error: "not taken down", code: "not-found" }, 404);
  }
  return json({ error: "not found" }, 404);
}

