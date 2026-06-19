/**
 * Web-experience gating — QR-login for a restricted service's WEBSITE
 * (docs/service-access-gating.md, "Web-experience gating").
 *
 * A plain browser can't AID-sign the `x-flagship-visit` header, so a restricted
 * service's website is unreachable from one. This module closes that with a
 * WhatsApp-Web-style QR-login:
 *
 *   1. The enforcement layer, on a top-level browser navigation it would deny,
 *      serves a non-threatening **knock page** (minimal disclosure — NO owner /
 *      content) carrying a high-entropy single-use **pageId**, a same-device
 *      deeplink button, a cross-device QR (scanned by the Flagship app), and an
 *      inline poller. The page-serve also sets a host-scoped **holder cookie**
 *      (`Flagship-Knock`) bound to that pageId.
 *   2. The visitor's PHONE (deeplink / in-app scan) verifies its AID is in the
 *      service allow-list and **AID-signs** `{serverId, serviceRef, pageId, ...}`
 *      (a `KnockAuthorization` — the pageId is IN the signature, so a visit proof
 *      can never be replayed to authorize a different page). It POSTs that to the
 *      box, which verifies signature + allow-list, mints a browser session (a
 *      `Flagship-App-Session` cookie token) + a phone-held **secretId**, and
 *      records both on the pending knock. The box returns the secretId to the
 *      PHONE (never the browser).
 *   3. The browser's next poll — carrying the holder cookie — gets the session
 *      `Set-Cookie` and reloads into the content. ONLY the holder receives the
 *      cookie (closes the pageId-theft race); the pageId is consumed on delivery.
 *
 * Session management (the phone holds the secretId): the phone can query a
 * session's `online|offline` (rate-limited, default-offline for unknown — no
 * enumeration oracle) and close it (kills the browser cookie). The secretId
 * rides the request BODY, never the URL path, so it can't land in access logs.
 *
 * This LAYERS on `serviceAccess.ts` (the AID allow-list + the
 * `Flagship-App-Session` cookie + `ServiceSessionStore`): the knock store is the
 * only new persistent-ish state, and it's ephemeral (in-memory, ~minutes) — a
 * daemon restart just makes a waiting browser re-knock.
 */

import { randomBytes } from "node:crypto";
import {
  verifyKnockAuthorization,
  type KnockAuthorization,
} from "@flagship/protocol";
import { renderQrSvg } from "./qrSvg.js";
import { SESSION_COOKIE, type ServiceAccessStore, type ServiceSessionStore } from "./serviceAccess.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";

const JSON_H = { "content-type": "application/json" };
const HTML_H = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };

/** Holder cookie binding the browser that requested the knock page to its pageId. */
export const KNOCK_HOLDER_COOKIE = "Flagship-Knock";

/** Pending-knock lifetime — short; the knock page re-rolls a fresh pageId on reload. */
const DEFAULT_KNOCK_TTL_MS = 5 * 60_000;
/** Phone session-status rate limit — ~1/min/secretId per the spec. */
const DEFAULT_STATUS_RATE_MS = 60_000;
/** Browser session lifetime issued by an authorize. */
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60_000;

interface KnockEntry {
  serviceRef: string;
  /** Bound to the browser that requested the page (race-fix): only it gets the cookie. */
  holderToken: string;
  /** Browser UA recorded at page-serve — surfaced to the phone in "Open secured sessions". */
  browserAgent: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "authorized";
  /** Set at authorize: the session cookie token the holder's poll will receive. */
  cookieToken?: string;
  /** Set at authorize: the phone's session handle (also stored on the session). */
  secretId?: string;
}

/**
 * In-memory pending-knock store. Knocks live ~minutes; persistence buys nothing
 * (a restart just makes the waiting browser re-knock), and keeping it in memory
 * avoids writing pageIds/holder tokens to disk.
 */
export class PendingKnockStore {
  private byPage = new Map<string, KnockEntry>();

  /** Mint a fresh pageId + holder token for a browser knocking on `serviceRef`. */
  mint(serviceRef: string, browserAgent: string, now: number, ttlMs: number): { pageId: string; holderToken: string } {
    this.prune(now);
    const pageId = randHex(16); // 128-bit, unguessable
    const holderToken = randHex(16);
    this.byPage.set(pageId, {
      serviceRef,
      holderToken,
      browserAgent,
      createdAt: now,
      expiresAt: now + ttlMs,
      status: "pending",
    });
    return { pageId, holderToken };
  }

  /** The live knock for a pageId, or null if unknown/expired. */
  get(pageId: string, now: number): KnockEntry | null {
    const e = this.byPage.get(pageId);
    if (!e) return null;
    if (e.expiresAt <= now) {
      this.byPage.delete(pageId);
      return null;
    }
    return e;
  }

  /** Mark a pending knock authorized + attach the session cookie token + secretId. */
  authorize(pageId: string, cookieToken: string, secretId: string, now: number): boolean {
    const e = this.get(pageId, now);
    if (!e || e.status !== "pending") return false;
    e.status = "authorized";
    e.cookieToken = cookieToken;
    e.secretId = secretId;
    return true;
  }

  /** Single-use: drop a knock once its holder has picked up the cookie. */
  consume(pageId: string): void {
    this.byPage.delete(pageId);
  }

  private prune(now: number): void {
    for (const [id, e] of this.byPage) if (e.expiresAt <= now) this.byPage.delete(id);
  }
}

export interface ServiceAccessWebOptions {
  /** The box fqdn — the `serverId` the knock authorization is bound to. */
  serverId: string;
  store: ServiceAccessStore;
  sessions: ServiceSessionStore;
  knocks?: PendingKnockStore;
  now?: () => number;
  /** Replay window for the AID-signed authorize. Default 5 min. */
  maxAgeMs?: number;
  /** Pending-knock lifetime. Default 5 min. */
  knockTtlMs?: number;
  /** Browser session lifetime an authorize issues. Default 12h. */
  sessionTtlMs?: number;
  /** Phone status-query rate limit per secretId. Default 60s. */
  statusRateMs?: number;
}

export interface ServiceAccessWeb {
  /** Routes the web-experience endpoints (poll / authorize / session status+close). Null = not ours. */
  handle: (req: HttpRequest) => Promise<HttpResponse | null>;
  /**
   * Called by the enforcement layer when it would DENY a request to a restricted
   * `serviceRef`: returns the knock page (200 HTML + holder cookie) for a
   * top-level browser navigation, or null for an API/asset request (→ 403 JSON).
   */
  maybeServeKnock: (serviceRef: string, req: HttpRequest) => HttpResponse | null;
  knocks: PendingKnockStore;
}

export function buildServiceAccessWeb(opts: ServiceAccessWebOptions): ServiceAccessWeb {
  const now = opts.now ?? (() => Date.now());
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;
  const knockTtlMs = opts.knockTtlMs ?? DEFAULT_KNOCK_TTL_MS;
  const sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const statusRateMs = opts.statusRateMs ?? DEFAULT_STATUS_RATE_MS;
  const knocks = opts.knocks ?? new PendingKnockStore();
  // Per-secretId last-query timestamp for the status rate limit (bounded; pruned opportunistically).
  const statusLastQuery = new Map<string, number>();

  function maybeServeKnock(serviceRef: string, req: HttpRequest): HttpResponse | null {
    // Only a top-level browser navigation gets HTML; everything else (XHR,
    // assets) gets the 403 JSON the caller falls back to.
    const method = req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") return null;
    const accept = (req.headers.accept ?? "").toLowerCase();
    if (!accept.includes("text/html")) return null;

    const host = (req.headers.host ?? "").split(":")[0]!.toLowerCase();
    const suffix = `.${opts.serverId.toLowerCase()}`;
    const label = host.endsWith(suffix) ? host.slice(0, host.length - suffix.length) : "";
    const ua = req.headers["user-agent"] ?? "";
    const { pageId, holderToken } = knocks.mint(serviceRef, ua, now(), knockTtlMs);
    const deeplink = `flagship://access?server=${encodeURIComponent(opts.serverId)}&svc=${encodeURIComponent(
      label,
    )}&ref=${encodeURIComponent(serviceRef)}&page=${encodeURIComponent(pageId)}`;
    return {
      status: 200,
      headers: {
        ...HTML_H,
        "set-cookie": `${KNOCK_HOLDER_COOKIE}=${holderToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(
          knockTtlMs / 1000,
        )}`,
      },
      body: renderKnockPage({ pageId, deeplink }),
    };
  }

  async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    // Browser poll: GET /__flagship/knock/<pageId>/status — ungated (registered
    // before enforcement), same-origin from the knock page (carries the holder).
    if (req.method === "GET" && req.path.startsWith("/__flagship/knock/") && req.path.endsWith("/status")) {
      const pageId = req.path.slice("/__flagship/knock/".length, -"/status".length);
      return handlePoll(pageId, req);
    }
    if (req.path === "/api/service-access/knock/authorize" && req.method === "POST") {
      return handleAuthorize(req);
    }
    if (req.path === "/api/service-access/session/status" && req.method === "POST") {
      return handleSessionStatus(req);
    }
    if (req.path === "/api/service-access/session/close" && req.method === "POST") {
      return handleSessionClose(req);
    }
    return null;
  }

  /** Browser poll. Delivers the session cookie ONLY to the holder, single-use. */
  function handlePoll(pageId: string, req: HttpRequest): HttpResponse {
    const knock = knocks.get(pageId, now());
    if (!knock) return jsonResponse(200, { status: "unknown" });
    if (knock.status !== "authorized" || !knock.cookieToken) {
      return jsonResponse(200, { status: "pending" });
    }
    // Race-fix: only the browser that requested THIS page (holding the matching
    // Flagship-Knock cookie) may pick up the session cookie. A non-holder poller
    // who learned the pageId (e.g. from a shoulder-surfed QR) gets "pending" and
    // never the cookie.
    const holder = readCookie(req.headers.cookie, KNOCK_HOLDER_COOKIE);
    if (holder !== knock.holderToken) return jsonResponse(200, { status: "pending" });
    const token = knock.cookieToken;
    knocks.consume(pageId);
    return {
      status: 200,
      headers: {
        ...JSON_H,
        "set-cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(
          sessionTtlMs / 1000,
        )}`,
      },
      body: JSON.stringify({ status: "authorized" }),
    };
  }

  /** Phone AID-signed authorize of a browser's pageId. */
  async function handleAuthorize(req: HttpRequest): Promise<HttpResponse> {
    let body: { authorization?: unknown; sig?: unknown };
    try {
      body = JSON.parse(req.body.toString("utf8"));
    } catch {
      return bad(400, "invalid json");
    }
    const parsed = parseKnockAuthorization(body.authorization);
    if (!parsed || typeof body.sig !== "string" || !/^[0-9a-f]{128}$/i.test(body.sig)) {
      return bad(400, "malformed authorization");
    }
    if (parsed.serverId !== opts.serverId) return bad(403, "serverId mismatch");
    if (Math.abs(now() - parsed.issuedAt) > maxAgeMs) return bad(403, "stale request");
    let sig: Uint8Array;
    try {
      sig = hexToBytes(body.sig);
    } catch {
      return bad(400, "invalid signature hex");
    }
    if (!verifyKnockAuthorization(parsed, sig, parsed.visitorAID)) return bad(403, "invalid signature");

    const knock = knocks.get(parsed.pageId, now());
    if (!knock) return bad(404, "unknown or expired page");
    if (knock.serviceRef !== parsed.serviceRef) return bad(403, "service mismatch");
    if (knock.status !== "pending") return bad(409, "already authorized");

    const aidHex = bytesToHex(parsed.visitorAID);
    // A session is only meaningful for a RESTRICTED service whose allow-list
    // holds this AID — anything else would be a bearer token to nothing.
    if (opts.store.mode(parsed.serviceRef) !== "restricted" || !opts.store.isAllowed(parsed.serviceRef, aidHex)) {
      return bad(401, "not allow-listed for this service");
    }
    const secretId = randHex(32);
    const startedAt = now();
    const token = await opts.sessions.issue(parsed.serviceRef, aidHex, startedAt, sessionTtlMs, {
      secretId,
      browserAgent: knock.browserAgent,
      startedAt,
    });
    if (!knocks.authorize(parsed.pageId, token, secretId, now())) {
      // Lost the race (expired between get + authorize) — clean up the orphan session.
      await opts.sessions.closeBySecretId(secretId);
      return bad(404, "page expired");
    }
    return jsonResponse(200, {
      authorized: true,
      secretId,
      serviceRef: parsed.serviceRef,
      browserAgent: knock.browserAgent,
      startedAt,
      expiresAt: startedAt + sessionTtlMs,
    });
  }

  /**
   * Phone session status. secretId in the BODY (never the URL — so it can't land
   * in access logs). Rate-limited ~1/min/secretId; UNKNOWN ⇒ `offline` (200, no
   * enumeration oracle); the response shape is IDENTICAL for known + unknown
   * (the phone already holds serviceRef/UA/start locally), so it leaks nothing.
   */
  async function handleSessionStatus(req: HttpRequest): Promise<HttpResponse> {
    const secretId = readSecretId(req);
    if (!secretId) return bad(400, "secretId required");
    const t = now();
    pruneRate(t);
    const last = statusLastQuery.get(secretId);
    if (last !== undefined && t - last < statusRateMs) {
      return { status: 429, headers: { ...JSON_H, "retry-after": String(Math.ceil(statusRateMs / 1000)) }, body: JSON.stringify({ error: "rate limited" }) };
    }
    statusLastQuery.set(secretId, t);
    const sess = opts.sessions.lookupBySecretId(secretId);
    const online =
      !!sess &&
      !sess.closed &&
      sess.expiresAt > t &&
      opts.store.mode(sess.serviceRef) === "restricted" &&
      opts.store.isAllowed(sess.serviceRef, sess.aid);
    return jsonResponse(200, { status: online ? "online" : "offline" });
  }

  /** Phone-initiated close. secretId in the BODY; idempotent + oracle-free (always 200 {closed:true}). */
  async function handleSessionClose(req: HttpRequest): Promise<HttpResponse> {
    const secretId = readSecretId(req);
    if (!secretId) return bad(400, "secretId required");
    await opts.sessions.closeBySecretId(secretId);
    statusLastQuery.delete(secretId);
    return jsonResponse(200, { closed: true });
  }

  function pruneRate(t: number): void {
    if (statusLastQuery.size < 1024) return;
    for (const [id, ts] of statusLastQuery) if (t - ts > statusRateMs * 2) statusLastQuery.delete(id);
  }

  return { handle, maybeServeKnock, knocks };
}

// ── helpers ───────────────────────────────────────────────────────────

/**
 * The self-contained knock page. NO remote assets (the box must never leak a
 * visitor to another origin — same rule as `defaultApexPage`), `noindex`, and
 * minimal disclosure (no owner / service name). The QR is baked server-side.
 */
function renderKnockPage(args: { pageId: string; deeplink: string }): string {
  const qr = renderQrSvg(args.deeplink, { size: 200, foreground: "#0f172a" });
  const pageJson = JSON.stringify(args.pageId);
  const deeplinkJson = JSON.stringify(args.deeplink);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Restricted — Flagship</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:#f8fafc; color:#0f172a; }
  @media (prefers-color-scheme: dark){ body{ background:#0b1220; color:#e2e8f0 } .card{ background:#111a2e !important } .muted{color:#94a3b8 !important} }
  .card { background:#fff; max-width:380px; width:calc(100% - 32px); border-radius:16px;
    padding:28px 24px; box-shadow:0 10px 40px rgba(2,6,23,.12); text-align:center; }
  h1 { font-size:18px; margin:0 0 6px; }
  .muted { color:#475569; font-size:14px; margin:0 0 18px; }
  .qr { width:200px; height:200px; margin:6px auto 16px; }
  .btn { display:inline-block; width:100%; box-sizing:border-box; padding:12px 16px; border:0; border-radius:12px;
    background:#14b8a6; color:#fff; font-weight:600; font-size:15px; cursor:pointer; text-decoration:none; }
  .btn:active { background:#0d9488; }
  .alt { margin-top:14px; font-size:13px; }
  .alt a { color:#0d9488; cursor:pointer; }
  .code { display:none; margin-top:10px; font-size:12px; word-break:break-all; color:#64748b;
    background:#f1f5f9; border-radius:8px; padding:8px; }
  @media (prefers-color-scheme: dark){ .code{ background:#1e293b } }
</style>
</head>
<body>
  <main class="card">
    <h1>Access is restricted</h1>
    <p class="muted">This page is on a Flagship cloud. Authenticate with your Flagship app to view it.</p>
    <div class="qr">${qr}</div>
    <a class="btn" id="access">Access site</a>
    <p class="alt"><a id="getlink">Get link to paste in the app</a></p>
    <div class="code" id="codebox"></div>
  </main>
<script>
(function(){
  var PAGE = ${pageJson};
  var LINK = ${deeplinkJson};
  document.getElementById('access').setAttribute('href', LINK);
  document.getElementById('getlink').addEventListener('click', function(){
    var box = document.getElementById('codebox');
    box.textContent = LINK;
    box.style.display = 'block';
    try { navigator.clipboard && navigator.clipboard.writeText(LINK); } catch(e){}
  });
  function poll(){
    fetch('/__flagship/knock/' + PAGE + '/status', { headers:{accept:'application/json'}, cache:'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(j){
        if (j && j.status === 'authorized'){ location.reload(); return; }
        setTimeout(poll, 2000);
      })
      .catch(function(){ setTimeout(poll, 2500); });
  }
  setTimeout(poll, 1500);
})();
</script>
</body>
</html>`;
}

function parseKnockAuthorization(raw: unknown): KnockAuthorization | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.serverId !== "string" ||
    typeof r.serviceRef !== "string" ||
    typeof r.pageId !== "string" ||
    typeof r.visitorAID !== "string" ||
    !/^[0-9a-f]{64}$/i.test(r.visitorAID) ||
    typeof r.issuedAt !== "number"
  ) {
    return null;
  }
  return {
    serverId: r.serverId,
    serviceRef: r.serviceRef,
    pageId: r.pageId,
    visitorAID: hexToBytes(r.visitorAID),
    issuedAt: r.issuedAt,
  };
}

/** secretId from the request body `{ secretId }` (validated 64-hex). */
function readSecretId(req: HttpRequest): string | null {
  let body: { secretId?: unknown };
  try {
    body = JSON.parse(req.body.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof body.secretId !== "string" || !/^[0-9a-f]{64}$/i.test(body.secretId)) return null;
  return body.secretId.toLowerCase();
}

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const t = part.trim();
    if (t.startsWith(`${name}=`)) {
      const v = t.slice(name.length + 1);
      return v.length > 0 ? v : null;
    }
  }
  return null;
}

function randHex(nBytes: number): string {
  return bytesToHex(randomBytes(nBytes));
}

function bad(status: number, error: string): HttpResponse {
  return { status, headers: JSON_H, body: JSON.stringify({ error }) };
}

function jsonResponse(status: number, body: unknown): HttpResponse {
  return { status, headers: JSON_H, body: JSON.stringify(body) };
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
