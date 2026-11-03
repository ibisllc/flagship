/**
 * Abuse reports of links and apps, notices to an account, suspensions (docs/abuse-handling.md).
 *
 *   POST /api/abuse/reports                          anyone: {kind: link|app, subject, reason, note, contact}
 *   GET  /api/users/<u>/abuse-notices                the account's devices (read token): its notices + suspension
 *   POST /api/users/<u>/abuse-notices/<id>/done      an admin device: the signed "done" note
 *   /api/admin/abuse/*                               (x-admin-secret) the operator's queue, notices, suspensions
 *
 * The reporter's address is never stored (the rate limiter counts it in Durable Objects only); `.com` reads only what
 * the reporter typed and the public routing records, never sealed content. Nothing here is ever handed to a model.
 */
import {
  ACCOUNT_KEY_HOLDERS_ONLY,
  accountExists,
  adminDeviceIds,
  authorizeAdmin,
  authorizeSensitiveComOp,
  hexToBytes,
  requireAccountRead,
  type AccountReadTokenDeps,
} from "@flagship/control-plane";
import {
  ABUSE_NOTICE_ACTIONS,
  ABUSE_NOTICE_NOTE_MAX,
  ABUSE_SUBJECT_KINDS,
  ABUSE_URGENT_CATEGORIES,
  abuseNoteSha256Hex,
  isAbuseCategory,
  isAbuseReportReason,
  verifyAbuseNoticeDone,
  type AbuseCategory,
  type AbuseNoticeDone,
} from "@flagship/protocol";
import { D1Storage, type D1Database } from "@flagship/storage";
import { D1NonceStore } from "@flagship/boot-core";
import { restoreVoiciPageFor, takedownVoiciPageFor, voiciWebOrigin, type VoiciAbuseEnv } from "./voiciAbuse.js";

export const ABUSE_REPORTS_PATH = "/api/abuse/reports";
export const ABUSE_ADMIN_PREFIX = "/api/admin/abuse/";
const NOTICES_PATH = /^\/api\/users\/([^/]+)\/abuse-notices$/;
const DONE_PATH = /^\/api\/users\/([^/]+)\/abuse-notices\/([0-9a-f]{32})\/done$/;

export const ABUSE_NOTICE_CATEGORY = "abuse-notice";
export const ABUSE_NOTICE_TEXT = "There is a notice about your Flagship account. Open Flagship to read it.";
export const APPEAL_EMAIL = "abuse@flagship.services";
/** Notices older than this are left out of the account's read. */
export const NOTICE_SHOWN_MS = 180 * 86_400_000;
/** Resolved reports and closed notices are deleted after a year. */
export const ABUSE_RETENTION_MS = 365 * 86_400_000;
const DONE_SKEW_MS = 5 * 60_000;
const MAX_REPORT_BYTES = 8 * 1024;
const NOTE_MAX = 2000;
const DETAIL_MAX = 1000;
const REASON_MAX = 1000;
const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EMAIL = /^[^\s@<>"',;]{1,64}@[a-z0-9.-]+\.[a-z]{2,}$/i;
const ID32 = /^[0-9a-f]{32}$/;

export interface AbuseEnv extends VoiciAbuseEnv {
  ACCOUNT_READ_TOKEN_SECRET?: string;
  SERVICES_APEX?: string;
  CONTROL_APEX?: string;
}

/** What the push forwarder takes (controlPlaneRoutes.buildOptionalPushForwarder). */
export type AbusePushForward = (args: {
  targets: Array<{ tokenId: string; platform: "apns" | "fcm" | "webpush"; providerToken: string }>;
  category: string;
  sealedPayloadHex: string;
  webpushPayloadBytes?: Uint8Array;
  displayData?: Record<string, string>;
}) => Promise<unknown>;

export interface AbuseDeps {
  now?: () => number;
  fetchFn?: typeof fetch;
  forward?: AbusePushForward | null;
  waitUntil?: (p: Promise<unknown>) => void;
}

export function isAbusePath(pathname: string): boolean {
  return pathname === ABUSE_REPORTS_PATH || pathname.startsWith(ABUSE_ADMIN_PREFIX) || NOTICES_PATH.test(pathname) || DONE_PATH.test(pathname);
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, "0")).join("");
}

async function readBody(request: Request, max: number): Promise<Record<string, unknown> | null> {
  const t = await request.text();
  if (t.length > max) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const servicesApex = (env: AbuseEnv) => (env.SERVICES_APEX ?? "flagship.services").toLowerCase();
const voiciHost = (env: AbuseEnv) => new URL(voiciWebOrigin(env)).host.toLowerCase();

// ── resolution (§2) ─────────────────────────────────────────────────────────

export type TargetKind = "page" | "link" | "app" | "box" | "account";

export interface Resolved {
  subject: string;
  account: string;
  targetKind: TargetKind;
  target: string;
  serviceId: string | null;
  serverDomain: string | null;
}

/** The voi.ci name a link report names (`voi.ci/x`, `https://voi.ci/x`, `x`, `@x`), or null. */
export function voiciNameOf(raw: string, host: string): string | null {
  let s = raw.trim();
  if (/^https?:\/\//i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    if (u.host.toLowerCase() !== host) return null;
    s = u.pathname;
  } else if (s.toLowerCase().startsWith(`${host}/`)) {
    s = s.slice(host.length);
  }
  s = s.replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
  return /^@?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s) ? s : null;
}

/** The hostname an app report names (a URL or a bare host under the services apex), or null. */
export function hostOf(raw: string, apex: string): string | null {
  let s = raw.trim().toLowerCase();
  if (/^https?:\/\//.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      return null;
    }
  } else {
    s = s.split(/[/?#]/)[0]!.replace(/:\d+$/, "");
  }
  s = s.replace(/\.$/, "");
  if (!s.endsWith(`.${apex}`)) return null;
  const labels = s.slice(0, -(apex.length + 1)).split(".");
  if (labels.length < 1 || labels.length > 2 || !labels.every((l) => LABEL.test(l))) return null;
  return s;
}

async function resolveLink(db: D1Database, storage: D1Storage, env: AbuseEnv, subject: string): Promise<Resolved | null> {
  const host = voiciHost(env);
  const name = voiciNameOf(subject, host);
  if (!name) return null;
  const at = name.startsWith("@");
  const row = await storage.names.lookup(at ? name.slice(1) : name, at ? "username" : undefined);
  if (!row || row.kind === "reserved" || !row.owner) return null;
  const owner = row.owner.toLowerCase();
  if (!(await accountExists({ usernames: storage.usernames, demoUsers: storage.demoUsers }, owner))) return null;
  const shown = `${host}/${row.name}`;
  if (row.kind === "username") return { subject: shown, account: owner, targetKind: "page", target: `https://${host}/${row.name}`, serviceId: null, serverDomain: null };
  void db;
  return { subject: shown, account: owner, targetKind: "link", target: row.target ?? "", serviceId: row.serviceId, serverDomain: null };
}

async function resolveHost(db: D1Database, storage: D1Storage, env: AbuseEnv, subject: string): Promise<Resolved | null> {
  const apex = servicesApex(env);
  const host = hostOf(subject, apex);
  if (!host) return null;
  const labels = host.slice(0, -(apex.length + 1)).split(".");
  const account = labels[labels.length - 1]!;
  if (!USERNAME.test(account) || !(await accountExists({ usernames: storage.usernames, demoUsers: storage.demoUsers }, account))) return null;
  if (labels.length === 1) return { subject: host, account, targetKind: "account", target: host, serviceId: null, serverDomain: null };
  const server = await storage.servers.get(host);
  if (server && server.username.toLowerCase() === account) {
    return { subject: host, account, targetKind: "box", target: host, serviceId: null, serverDomain: host };
  }
  const label = labels[0]!;
  const alias = await db
    .prepare("SELECT service_id FROM user_service_aliases WHERE username = ?1 AND display_label = ?2 LIMIT 1")
    .bind(account, label)
    .first<{ service_id: string }>();
  let serviceId = alias?.service_id ?? null;
  if (!serviceId) {
    const parts = label.split("--");
    serviceId = parts.length === 2 ? `${parts[1]}--${parts[0]}` : parts.length === 1 ? `${account}--${label}` : null;
  }
  return { subject: host, account, targetKind: "app", target: host, serviceId, serverDomain: null };
}

// ── reads other code uses ───────────────────────────────────────────────────

export interface Suspension {
  account: string;
  category: string;
  reason: string;
  noticeId: string | null;
  urgent: boolean;
  suspendedAt: number;
  servers: string[];
  pageTakenDown: boolean;
}

export async function suspensionOf(db: D1Database, account: string): Promise<Suspension | null> {
  const r = await db
    .prepare("SELECT account, category, reason, notice_id, urgent, suspended_at, servers_json, page_taken_down FROM account_suspensions WHERE account = ?1")
    .bind(account.toLowerCase())
    .first<{ account: string; category: string; reason: string; notice_id: string | null; urgent: number; suspended_at: number; servers_json: string; page_taken_down: number }>();
  if (!r) return null;
  let servers: string[] = [];
  try {
    const v = JSON.parse(r.servers_json) as unknown;
    if (Array.isArray(v)) servers = v.filter((x): x is string => typeof x === "string");
  } catch {
    servers = [];
  }
  return {
    account: r.account,
    category: r.category,
    reason: r.reason,
    noticeId: r.notice_id,
    urgent: r.urgent === 1,
    suspendedAt: r.suspended_at,
    servers,
    pageTakenDown: r.page_taken_down === 1,
  };
}

/** Retention (§6): resolved reports, and done or withdrawn notices of accounts not suspended, after a year. */
export async function pruneAbuseCases(db: D1Database, now: number): Promise<void> {
  const cutoff = now - ABUSE_RETENTION_MS;
  await db.batch([
    db.prepare("DELETE FROM abuse_reports WHERE status <> 'open' AND resolved_at IS NOT NULL AND resolved_at < ?1").bind(cutoff),
    db
      .prepare(
        "DELETE FROM abuse_notices WHERE COALESCE(withdrawn_at, done_at) IS NOT NULL AND COALESCE(withdrawn_at, done_at) < ?1 " +
          "AND account NOT IN (SELECT account FROM account_suspensions)",
      )
      .bind(cutoff),
  ]);
}

/**
 * While an account is suspended its names stay held and its servers stay down (§5): the routes that would free a
 * name, add or hand over a server answer `403 account-suspended`. Null when the request may go on. Reads the body
 * of a clone, so the caller's request is untouched.
 */
export async function suspensionGuard(request: Request, db: D1Database | undefined): Promise<Response | null> {
  if (!db || request.method.toUpperCase() !== "POST") return null;
  const path = new URL(request.url).pathname;
  const guarded =
    path === "/api/auth-code/issue" ||
    path === "/api/server/register" ||
    path === "/api/account/self-delete" ||
    path === "/api/server/release" ||
    path === "/api/server-registry/unrevoke" ||
    /^\/api\/server\/[^/]+\/transfer\/offer$/.test(path);
  if (!guarded) return null;
  let account: string | null = null;
  const offer = /^\/api\/server\/([^/]+)\/transfer\/offer$/.exec(path);
  if (offer) {
    let domain = "";
    try {
      domain = decodeURIComponent(offer[1]!).toLowerCase();
    } catch {
      return null;
    }
    const row = await db.prepare("SELECT username FROM servers WHERE server_domain = ?1").bind(domain).first<{ username: string }>();
    account = row?.username ?? null;
  } else {
    let b: Record<string, any> | null = null;
    try {
      b = (await request.clone().json()) as Record<string, any>;
    } catch {
      return null;
    }
    const pick = (v: unknown) => (typeof v === "string" ? v : null);
    account =
      pick(b?.code?.username) ??
      pick(b?.request?.authCode?.username) ??
      pick(b?.accountSelfDelete?.request?.username) ??
      pick(b?.request?.username) ??
      null;
  }
  if (!account) return null;
  if (!(await suspensionOf(db, account))) return null;
  return json({ error: "This account is suspended.", code: "account-suspended" }, 403);
}

// ── intake (§1) ─────────────────────────────────────────────────────────────

function reportCors(request: Request, env: AbuseEnv): Record<string, string> {
  const origin = request.headers.get("origin");
  return origin && origin === voiciWebOrigin(env) ? { "access-control-allow-origin": origin, vary: "Origin" } : {};
}

async function handleReport(request: Request, env: AbuseEnv, db: D1Database, storage: D1Storage, now: number): Promise<Response> {
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
  const b = await readBody(request, MAX_REPORT_BYTES);
  const malformed = reply({ error: "Check the address, the reason and the note.", code: "malformed" }, 400);
  if (!b) return malformed;
  const keys = Object.keys(b).sort().join(",");
  if (keys !== "contact,kind,note,reason,subject") return malformed;
  if ((b.kind !== "link" && b.kind !== "app") || typeof b.subject !== "string" || b.subject.length > 300) return malformed;
  if (!isAbuseReportReason(b.reason) || typeof b.note !== "string" || b.note.length > NOTE_MAX) return malformed;
  let contact: string | null = null;
  if (b.contact !== null && b.contact !== "") {
    if (typeof b.contact !== "string" || b.contact.length > 254 || !EMAIL.test(b.contact.trim())) return malformed;
    contact = b.contact.trim();
  }
  const resolved = b.kind === "link" ? await resolveLink(db, storage, env, b.subject) : await resolveHost(db, storage, env, b.subject);
  if (!resolved) return reply({ error: "That isn't a voi.ci link or a Flagship address we know.", code: "not-flagship" }, 404);
  const id = randomId();
  await db
    .prepare(
      "INSERT INTO abuse_reports (id, kind, subject, reason, note, contact_email, account, target_kind, target, service_id, server_domain, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
    )
    .bind(id, b.kind, resolved.subject, b.reason, b.note, contact, resolved.account, resolved.targetKind, resolved.target, resolved.serviceId, resolved.serverDomain, now)
    .run();
  return reply({ reportId: id }, 200);
}

// ── the account's side (§4) ─────────────────────────────────────────────────

interface NoticeRow {
  id: string;
  account: string;
  report_id: string | null;
  subject_kind: string;
  subject: string;
  service_id: string | null;
  category: string;
  action: string;
  detail: string;
  deadline_at: number;
  issued_at: number;
  done_at: number | null;
  done_note: string | null;
  done_signer: string | null;
  done_signature: string | null;
  withdrawn_at: number | null;
}

const accountView = (n: NoticeRow) => ({
  id: n.id,
  subjectKind: n.subject_kind,
  subject: n.subject,
  serviceId: n.service_id,
  category: n.category,
  action: n.action,
  detail: n.detail,
  deadlineAt: n.deadline_at,
  issuedAt: n.issued_at,
  doneAt: n.done_at,
  doneNote: n.done_note,
});

function readTokenDeps(storage: D1Storage, env: AbuseEnv, db: D1Database, now: () => number): AccountReadTokenDeps {
  return {
    secret: env.ACCOUNT_READ_TOKEN_SECRET,
    usernames: storage.usernames,
    identities: storage.deviceIdentities,
    servers: storage.servers,
    demoUsers: storage.demoUsers,
    nonces: new D1NonceStore(db),
    now,
  };
}

const READ_HEADERS = { "cache-control": "private, no-store", vary: "authorization" };
const accountGone = () => json({ error: "account-not-found", code: "account-not-found" }, 404, READ_HEADERS);

function decodeName(raw: string): string | null {
  try {
    const u = decodeURIComponent(raw).toLowerCase();
    return USERNAME.test(u) ? u : null;
  } catch {
    return null;
  }
}

async function handleNoticesRead(request: Request, env: AbuseEnv, db: D1Database, storage: D1Storage, rawName: string, now: number): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  const u = decodeName(rawName);
  if (!u || !(await accountExists({ usernames: storage.usernames, demoUsers: storage.demoUsers }, u))) return accountGone();
  const check = await requireAccountRead(readTokenDeps(storage, env, db, () => now), u, request.headers.get("authorization"), ACCOUNT_KEY_HOLDERS_ONLY);
  if (!check.ok) return json(check.response.body, check.response.status, { ...READ_HEADERS, ...(check.response.headers ?? {}) });
  const [rows, suspension] = await Promise.all([
    db
      .prepare("SELECT * FROM abuse_notices WHERE account = ?1 AND withdrawn_at IS NULL AND issued_at >= ?2 ORDER BY issued_at DESC LIMIT 50")
      .bind(u, now - NOTICE_SHOWN_MS)
      .all<NoticeRow>(),
    suspensionOf(db, u),
  ]);
  const apex = env.CONTROL_APEX ?? "flagshipserver.com";
  return json(
    {
      notices: (rows.results ?? []).map(accountView),
      suspension: suspension
        ? { suspendedAt: suspension.suspendedAt, category: suspension.category, reason: suspension.reason, appealEmail: APPEAL_EMAIL, appealUrl: `https://${apex}/abuse#appeal` }
        : null,
    },
    200,
    READ_HEADERS,
  );
}

async function handleNoticeDone(request: Request, db: D1Database, storage: D1Storage, rawName: string, noticeId: string, now: number): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const u = decodeName(rawName);
  if (!u) return accountGone();
  const user = await storage.usernames.get(u);
  if (!user) return accountGone();
  const b = await readBody(request, 8 * 1024);
  const r = b?.request as Record<string, unknown> | undefined;
  if (
    !r ||
    typeof r.username !== "string" ||
    r.username.toLowerCase() !== u ||
    r.noticeId !== noticeId ||
    typeof r.note !== "string" ||
    r.note.length > ABUSE_NOTICE_NOTE_MAX ||
    typeof r.issuedAt !== "number" ||
    typeof b?.signature !== "string" ||
    !/^[0-9a-f]{128}$/i.test(b.signature)
  ) {
    return json({ error: "malformed", code: "malformed" }, 400);
  }
  if (Math.abs(now - r.issuedAt) > DONE_SKEW_MS) return json({ error: "stale request", code: "stale" }, 403);
  const done: AbuseNoticeDone = { username: u, noticeId, note: r.note, issuedAt: r.issuedAt };
  const sig = hexToBytes(b.signature.toLowerCase());
  const authz = await authorizeSensitiveComOp(
    { grants: storage.deviceCapabilityGrants, now: () => now },
    { username: u, userRec: user, verifyWith: (pub) => verifyAbuseNoticeDone(done, sig, hexToBytes(pub)) },
  );
  if (!authz.ok) return json({ error: "Only an admin device can do this.", code: "not-admin" }, 403);
  const notice = await db.prepare("SELECT * FROM abuse_notices WHERE id = ?1 AND account = ?2").bind(noticeId, u).first<NoticeRow>();
  if (!notice || notice.withdrawn_at !== null) return json({ error: "not found", code: "not-found" }, 404);
  if (notice.done_at !== null) return json({ ok: true, doneAt: notice.done_at }, 200);
  await db
    .prepare("UPDATE abuse_notices SET done_at = ?2, done_note = ?3, done_signer = ?4, done_signature = ?5 WHERE id = ?1 AND done_at IS NULL")
    .bind(noticeId, now, r.note, authz.signerPubHex, b.signature.toLowerCase())
    .run();
  return json({ ok: true, doneAt: now }, 200);
}

// ── push (§4) ───────────────────────────────────────────────────────────────

/** A content-free push to the account's admin devices (every device when the account pins no admin root). */
async function notifyAccount(storage: D1Storage, forward: AbusePushForward | null | undefined, account: string, now: number, everyDevice: boolean): Promise<number> {
  if (!forward) return 0;
  try {
    const user = await storage.usernames.get(account);
    if (!user) return 0;
    let tokens = await storage.pushTokens.listByUser(account);
    if (!everyDevice && user.adminRootPubHex) {
      const admins = await adminDeviceIds(storage.deviceCapabilityGrants, account, user.adminRootPubHex, now);
      tokens = tokens.filter((t) => admins.has(t.deviceId));
    }
    if (tokens.length === 0) return 0;
    const displayData = { kind: ABUSE_NOTICE_CATEGORY };
    await forward({
      targets: tokens.map((t) => ({ tokenId: t.tokenId, platform: t.platform, providerToken: t.providerToken })),
      category: "abuse-notice",
      sealedPayloadHex: "",
      webpushPayloadBytes: new TextEncoder().encode(JSON.stringify({ category: ABUSE_NOTICE_CATEGORY, body: ABUSE_NOTICE_TEXT, ...displayData })),
      displayData,
    });
    return tokens.length;
  } catch {
    return 0;
  }
}

// ── the operator (§3-§5) ────────────────────────────────────────────────────

interface ReportRow {
  id: string;
  kind: string;
  subject: string;
  reason: string;
  note: string;
  contact_email: string | null;
  account: string | null;
  target_kind: string | null;
  target: string | null;
  service_id: string | null;
  server_domain: string | null;
  status: string;
  created_at: number;
  resolved_at: number | null;
}

const reportSummary = (r: ReportRow) => ({
  id: r.id,
  kind: r.kind,
  subject: r.subject,
  reason: r.reason,
  account: r.account,
  targetKind: r.target_kind,
  target: r.target,
  serviceId: r.service_id,
  serverDomain: r.server_domain,
  hasContact: r.contact_email !== null,
  status: r.status,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
});

const operatorNotice = (n: NoticeRow) => ({
  ...accountView(n),
  account: n.account,
  reportId: n.report_id,
  doneSigner: n.done_signer,
  withdrawnAt: n.withdrawn_at,
});

/** Map a notice category onto the voi.ci takedown reasons the apps already show (§9.6). */
function voiciReasonFor(category: string): string {
  return ["spam", "harassment", "impersonation", "other"].includes(category) ? category : "illegal";
}

async function handleAdmin(request: Request, env: AbuseEnv, db: D1Database, storage: D1Storage, deps: AbuseDeps, now: number): Promise<Response> {
  const auth = authorizeAdmin({ expected: env.FLAGSHIP_ADMIN_SECRET, provided: request.headers.get("x-admin-secret") });
  if (auth) return json(auth.body, auth.status);
  const url = new URL(request.url);
  const sub = url.pathname.slice(ABUSE_ADMIN_PREFIX.length);
  const malformed = (why: string) => json({ error: why, code: "malformed" }, 400);

  if (request.method === "GET" && sub === "reports") {
    // Retention runs when the operator reads the queue (daily, §7) or the stats: no cron step to budget.
    await pruneAbuseCases(db, now);
    const all = url.searchParams.get("status") === "all";
    const rows = await db.prepare(`SELECT * FROM abuse_reports ${all ? "" : "WHERE status = 'open'"} ORDER BY created_at ASC LIMIT 500`).all<ReportRow>();
    return json({ reports: (rows.results ?? []).map(reportSummary) }, 200);
  }
  const one = /^reports\/([0-9a-f]{32})$/.exec(sub);
  if (request.method === "GET" && one) {
    const r = await db.prepare("SELECT * FROM abuse_reports WHERE id = ?1").bind(one[1]).first<ReportRow>();
    if (!r) return json({ error: "not found", code: "not-found" }, 404);
    return json({ report: { ...reportSummary(r), note: r.note, contact: r.contact_email } }, 200);
  }
  if (request.method === "GET" && sub === "notices") {
    const account = url.searchParams.get("account");
    const rows = account
      ? await db.prepare("SELECT * FROM abuse_notices WHERE account = ?1 ORDER BY issued_at DESC LIMIT 200").bind(account.toLowerCase()).all<NoticeRow>()
      : await db.prepare("SELECT * FROM abuse_notices WHERE withdrawn_at IS NULL ORDER BY deadline_at ASC LIMIT 500").all<NoticeRow>();
    return json({ notices: (rows.results ?? []).map(operatorNotice) }, 200);
  }
  if (request.method === "GET" && sub === "stats") {
    await pruneAbuseCases(db, now);
    const [open, oldest, noticesOpen, overdue, suspended] = await db.batch([
      db.prepare("SELECT COUNT(*) AS n FROM abuse_reports WHERE status = 'open'"),
      db.prepare("SELECT MIN(created_at) AS t FROM abuse_reports WHERE status = 'open'"),
      db.prepare("SELECT COUNT(*) AS n FROM abuse_notices WHERE withdrawn_at IS NULL AND done_at IS NULL"),
      db.prepare("SELECT COUNT(*) AS n FROM abuse_notices WHERE withdrawn_at IS NULL AND done_at IS NULL AND deadline_at < ?1").bind(now),
      db.prepare("SELECT COUNT(*) AS n FROM account_suspensions"),
    ]);
    const first = (r: { results?: unknown[] } | undefined) => ((r?.results ?? [])[0] ?? {}) as Record<string, unknown>;
    return json(
      {
        now,
        openReports: Number(first(open).n ?? 0),
        oldestOpenReportAt: first(oldest).t ?? null,
        openNotices: Number(first(noticesOpen).n ?? 0),
        overdueNotices: Number(first(overdue).n ?? 0),
        suspendedAccounts: Number(first(suspended).n ?? 0),
      },
      200,
    );
  }
  if (request.method !== "POST") return json({ error: "not found" }, 404);
  const b = await readBody(request, 8 * 1024);
  if (!b) return malformed("malformed body");

  if (sub === "dismiss") {
    if (typeof b.reportId !== "string" || !ID32.test(b.reportId)) return malformed("reportId");
    const res = await db.prepare("UPDATE abuse_reports SET status = 'dismissed', resolved_at = ?2 WHERE id = ?1 AND status = 'open'").bind(b.reportId, now).run();
    return res.meta?.changes ? json({ ok: true }, 200) : json({ error: "no open report with that id", code: "not-found" }, 404);
  }

  if (sub === "notice") {
    const account = typeof b.account === "string" ? b.account.toLowerCase() : "";
    if (!USERNAME.test(account)) return malformed("account");
    if (!(ABUSE_SUBJECT_KINDS as readonly unknown[]).includes(b.subjectKind)) return malformed("subjectKind");
    if (typeof b.subject !== "string" || b.subject.length < 1 || b.subject.length > 300) return malformed("subject");
    if (!isAbuseCategory(b.category)) return malformed("category");
    if (!(ABUSE_NOTICE_ACTIONS as readonly unknown[]).includes(b.action)) return malformed("action");
    const detail = b.detail === undefined ? "" : b.detail;
    if (typeof detail !== "string" || detail.length > DETAIL_MAX) return malformed("detail");
    const hours = b.deadlineHours;
    if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > 720) return malformed("deadlineHours (1..720)");
    const serviceId = b.serviceId === undefined || b.serviceId === null ? null : b.serviceId;
    if (serviceId !== null && (typeof serviceId !== "string" || serviceId.length > 200)) return malformed("serviceId");
    const reportId = b.reportId === undefined || b.reportId === null ? null : b.reportId;
    if (reportId !== null && (typeof reportId !== "string" || !ID32.test(reportId))) return malformed("reportId");
    if (!(await storage.usernames.get(account))) return json({ error: "no such account", code: "not-found" }, 404);
    if (reportId) {
      const r = await db.prepare("SELECT account FROM abuse_reports WHERE id = ?1").bind(reportId).first<{ account: string | null }>();
      if (!r) return json({ error: "no such report", code: "not-found" }, 404);
      if (r.account && r.account !== account) return json({ error: "the report names another account", code: "wrong-account" }, 409);
    }
    const id = randomId();
    const stmts = [
      db
        .prepare(
          "INSERT INTO abuse_notices (id, account, report_id, subject_kind, subject, service_id, category, action, detail, deadline_at, issued_at) " +
            "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )
        .bind(id, account, reportId, b.subjectKind, b.subject, serviceId, b.category, b.action, detail, now + hours * 3_600_000, now),
    ];
    if (reportId) stmts.push(db.prepare("UPDATE abuse_reports SET status = 'noticed', resolved_at = ?2 WHERE id = ?1 AND status = 'open'").bind(reportId, now));
    await db.batch(stmts);
    const push = notifyAccount(storage, deps.forward, account, now, false);
    if (deps.waitUntil) deps.waitUntil(push);
    return json({ ok: true, noticeId: id, deadlineAt: now + hours * 3_600_000, pushed: deps.waitUntil ? "pending" : await push }, 200);
  }

  if (sub === "notice-withdraw") {
    if (typeof b.noticeId !== "string" || !ID32.test(b.noticeId)) return malformed("noticeId");
    const res = await db.prepare("UPDATE abuse_notices SET withdrawn_at = ?2 WHERE id = ?1 AND withdrawn_at IS NULL").bind(b.noticeId, now).run();
    if (!res.meta?.changes) return json({ error: "no open notice with that id", code: "not-found" }, 404);
    await db
      .prepare("UPDATE abuse_reports SET status = 'closed', resolved_at = ?2 WHERE id = (SELECT report_id FROM abuse_notices WHERE id = ?1) AND status = 'noticed'")
      .bind(b.noticeId, now)
      .run();
    return json({ ok: true }, 200);
  }

  if (sub === "suspend") {
    const account = typeof b.account === "string" ? b.account.toLowerCase() : "";
    if (!USERNAME.test(account)) return malformed("account");
    if (!isAbuseCategory(b.category)) return malformed("category");
    if (typeof b.reason !== "string" || b.reason.trim().length < 1 || b.reason.length > REASON_MAX) return malformed("reason");
    const urgent = b.urgent === true;
    if (b.urgent !== undefined && typeof b.urgent !== "boolean") return malformed("urgent");
    const noticeId = b.noticeId === undefined || b.noticeId === null ? null : b.noticeId;
    if (noticeId !== null && (typeof noticeId !== "string" || !ID32.test(noticeId))) return malformed("noticeId");
    if (urgent && !ABUSE_URGENT_CATEGORIES.includes(b.category as AbuseCategory)) {
      return json({ error: `urgent suspension is only for ${ABUSE_URGENT_CATEGORIES.join(", ")}`, code: "not-urgent-category" }, 400);
    }
    if (!(await storage.usernames.get(account))) return json({ error: "no such account", code: "not-found" }, 404);
    if (await suspensionOf(db, account)) return json({ error: "already suspended", code: "already-suspended" }, 409);
    if (!urgent) {
      const due = noticeId
        ? await db.prepare("SELECT id FROM abuse_notices WHERE id = ?1 AND account = ?2 AND withdrawn_at IS NULL AND deadline_at <= ?3").bind(noticeId, account, now).first<{ id: string }>()
        : await db.prepare("SELECT id FROM abuse_notices WHERE account = ?1 AND withdrawn_at IS NULL AND deadline_at <= ?2 ORDER BY deadline_at LIMIT 1").bind(account, now).first<{ id: string }>();
      if (!due) {
        return json({ error: "no notice to this account whose deadline has passed; pass urgent for csam, active-phishing or malware", code: "before-deadline" }, 409);
      }
    }
    // Revoke every live server through the normal path: the revocation-log trigger tells the relays. Leases stay.
    const live = (await storage.servers.listForUser(account)).filter((s) => !s.revokedAt);
    const revoked: string[] = [];
    for (const s of live) if (await storage.servers.revoke(s.serverDomain, "suspended", now)) revoked.push(s.serverDomain);
    const fetchFn = deps.fetchFn ?? ((i: RequestInfo | URL, init?: RequestInit) => fetch(i, init));
    const page = await takedownVoiciPageFor(db, env, fetchFn, account, voiciReasonFor(b.category), now);
    await db
      .prepare(
        "INSERT INTO account_suspensions (account, category, reason, notice_id, urgent, suspended_at, servers_json, page_taken_down) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      )
      .bind(account, b.category, b.reason.trim(), noticeId, urgent ? 1 : 0, now, JSON.stringify(revoked), page.took ? 1 : 0)
      .run();
    const push = notifyAccount(storage, deps.forward, account, now, true);
    if (deps.waitUntil) deps.waitUntil(push);
    return json({ ok: true, serversRevoked: revoked, pageTakenDown: page.took, pagePurgeDone: page.done, pushed: deps.waitUntil ? "pending" : await push }, 200);
  }

  if (sub === "unsuspend") {
    const account = typeof b.account === "string" ? b.account.toLowerCase() : "";
    if (!USERNAME.test(account)) return malformed("account");
    const s = await suspensionOf(db, account);
    if (!s) return json({ error: "not suspended", code: "not-found" }, 404);
    const restored: string[] = [];
    for (const domain of s.servers) {
      const rec = await storage.servers.get(domain);
      if (rec && rec.username.toLowerCase() === account && rec.revocationReason === "suspended" && (await storage.servers.unrevoke(domain))) restored.push(domain);
    }
    if (s.pageTakenDown) await restoreVoiciPageFor(db, account);
    await db.prepare("DELETE FROM account_suspensions WHERE account = ?1").bind(account).run();
    return json({ ok: true, serversRestored: restored, pageRestored: s.pageTakenDown }, 200);
  }
  return json({ error: "not found" }, 404);
}

export async function handleAbuseRoute(request: Request, env: AbuseEnv, deps: AbuseDeps = {}): Promise<Response> {
  const db = env.DB;
  if (!db) return json({ error: "unavailable", code: "unavailable" }, 503);
  const storage = new D1Storage(db);
  const now = (deps.now ?? (() => Date.now()))();
  const path = new URL(request.url).pathname;
  if (path === ABUSE_REPORTS_PATH) return handleReport(request, env, db, storage, now);
  if (path.startsWith(ABUSE_ADMIN_PREFIX)) return handleAdmin(request, env, db, storage, deps, now);
  const done = DONE_PATH.exec(path);
  if (done) return handleNoticeDone(request, db, storage, done[1]!, done[2]!, now);
  const read = NOTICES_PATH.exec(path);
  if (read) return handleNoticesRead(request, env, db, storage, read[1]!, now);
  return json({ error: "not found" }, 404);
}

/** The note's hash, as the signed bytes carry it (for the operator script's display). */
export const noteHash = abuseNoteSha256Hex;
