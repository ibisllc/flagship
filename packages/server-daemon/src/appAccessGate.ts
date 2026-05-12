/**
 * Per-app "protect content" toggle + access gate (#84).
 *
 * Each installed app has one bit of policy: `protectContent`. Default
 * `false` — the app is fully public on its FQDN; the daemon's reverse
 * proxy forwards every request unchecked. When the owner flips the
 * toggle to `true`:
 *
 *   - Anonymous traffic gets 403'd at the gate, before it ever hits
 *     the app container. The HTML 403 page links to /invite so the
 *     visitor can ask the owner for an invite.
 *
 *   - Authenticated traffic — anyone who has a non-revoked `app_access`
 *     row from the invite flow (#80) — passes through. The access is
 *     identified by a bearer session token carried either as a cookie
 *     (`Flagship-App-Session`) or as `Authorization: Flagship-App-Session <tok>`.
 *
 *   - The host's own IRK is implicitly an owner and is never gated;
 *     the daemon already verifies host identity on its admin surfaces.
 *
 * The toggle itself flips via a fifth signed endpoint on the per-app
 * surface:
 *
 *   POST /.flagship/app/:appId/access-mode    (PSK-signed)
 *     { protectContent: true|false, issuedAt: <ms>, serverId, appId }
 *
 * When flipping `false → true`, the response surfaces a migration
 * warning containing the count of currently-active access rows so the
 * owner knows how many "anonymous" sessions they're about to kick out.
 * In the false-default state there are no anonymous sessions in the
 * traditional sense — there is no session at all — but apps that have
 * been used by random visitors via direct URL access will lose those
 * tabs the moment the toggle flips. The phone surfaces this warning
 * before issuing the order; the daemon's response echoes the count so
 * the phone can also confirm the change took effect.
 */

import { createHash } from "node:crypto";
import {
  ed,
  type Bytes,
  type Keypair,
} from "@flagship/protocol";
import type { AppAccessRow, AppInviteStore } from "./inviteHandler.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";

const J: Record<string, string> = { "content-type": "application/json" };

/**
 * Per-app access-mode store. Read on every gated request, written on
 * the access-mode endpoint. Trivial in-memory default for tests;
 * production swaps in a Postgres-backed adapter later.
 */
export interface AccessModeStore {
  /** Returns the current `protectContent` flag for the app. Default false. */
  get(appId: string): Promise<boolean>;
  /** Sets the flag. Returns the prior value. */
  set(appId: string, protectContent: boolean): Promise<boolean>;
}

export class InMemoryAccessModeStore implements AccessModeStore {
  private readonly modes = new Map<string, boolean>();
  async get(appId: string): Promise<boolean> {
    return this.modes.get(appId) ?? false;
  }
  async set(appId: string, protectContent: boolean): Promise<boolean> {
    const prior = this.modes.get(appId) ?? false;
    this.modes.set(appId, protectContent);
    return prior;
  }
}

export interface AccessGateDeps {
  /** This daemon's FQDN; matched on the access-mode endpoint. */
  serverFqdn: string;
  /** Owner's PSK pubkey — required on /access-mode. */
  pskPub: Bytes;
  /** App-level toggle store. */
  modeStore: AccessModeStore;
  /** Invite/access store — source of truth for grant lookups. */
  inviteStore: AppInviteStore;
  /**
   * Owner's IRK pubkey. Requests bearing a header
   * `X-Flagship-Owner-IRK: <hex>` whose value matches this and a valid
   * signature on a fresh challenge would bypass the gate.
   *
   * For v1 we keep this simpler: the owner's webapp/phone calls these
   * apps through paired-session-gated surfaces, NOT through the
   * gated FQDN. So owner-bypass via IRK header is not wired here.
   * Production may add it.
   */
  ownerIrkPub?: Bytes | null;
  /** Reject signed access-mode flips older than this. Default 5 min. */
  maxAgeMs?: number;
  /** For tests. */
  now?: () => number;
}

export interface AccessGateDecision {
  pass: boolean;
  /** 403 reason; null on pass. */
  reason: string | null;
  /** Matched access row when authentication succeeded. */
  matched: AppAccessRow | null;
}

/**
 * Inspect an inbound request bound for an app's URL. Returns an
 * `AccessGateDecision` describing whether the reverse proxy should
 * forward it. The decision is pure (modulo store reads) — the caller
 * builds the actual 403 response from `denialResponse(decision)`.
 *
 * Cookie + Authorization header parsing are RFC-loose: any
 * `Flagship-App-Session` cookie token wins; otherwise we accept
 * `Authorization: Flagship-App-Session <token>`.
 */
export async function evaluateAccess(args: {
  appId: string;
  modeStore: AccessModeStore;
  inviteStore: AppInviteStore;
  headers: Record<string, string>;
}): Promise<AccessGateDecision> {
  const protectContent = await args.modeStore.get(args.appId);
  if (!protectContent) {
    return { pass: true, reason: null, matched: null };
  }
  const token = extractSessionToken(args.headers);
  if (!token) {
    return { pass: false, reason: "session token required", matched: null };
  }
  const row = await args.inviteStore.findAccessByToken(token);
  if (!row) {
    return { pass: false, reason: "unknown session token", matched: null };
  }
  if (row.appId !== args.appId) {
    return { pass: false, reason: "token bound to a different app", matched: null };
  }
  if (row.revokedAt !== null) {
    return { pass: false, reason: "access revoked", matched: null };
  }
  return { pass: true, reason: null, matched: row };
}

/**
 * Render the 403 response for a denied request. HTML for browsers (so
 * the user sees a hint about /invite) + JSON for everything else.
 */
export function denialResponse(decision: AccessGateDecision, headers: Record<string, string>): HttpResponse {
  const wantsHtml = (headers["accept"] ?? "").toLowerCase().includes("text/html");
  if (!wantsHtml) {
    return {
      status: 403,
      headers: J,
      body: JSON.stringify({ error: decision.reason ?? "forbidden" }),
    };
  }
  return {
    status: 403,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: DENIAL_HTML,
  };
}

const DENIAL_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Access restricted · Flagship</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0a0a0a; color: #eee; padding: 4rem 1.5rem; max-width: 560px; margin: 0 auto; line-height: 1.55; }
  h1 { color: #fbcc4a; }
  a { color: #7ad; }
</style></head>
<body>
<h1>This app is private.</h1>
<p>The owner has enabled "protect content" on this app. You need a valid
invite link to enter.</p>
<p>If you were expecting access, ask the owner to share an invite. They
can do that from their phone or webapp — the link will end in
<code>/invite#k=…</code>.</p>
<p><a href="/invite">If you already have a link, open it here.</a></p>
</body></html>`;

function extractSessionToken(headers: Record<string, string>): string | null {
  const auth = headers["authorization"] ?? "";
  const m = /^Flagship-App-Session\s+([^\s,;]+)$/i.exec(auth);
  if (m) return m[1]!;
  const cookie = headers["cookie"] ?? "";
  for (const part of cookie.split(";")) {
    const t = part.trim();
    if (t.startsWith("Flagship-App-Session=")) {
      return t.slice("Flagship-App-Session=".length);
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// POST /.flagship/app/:appId/access-mode handler
// ──────────────────────────────────────────────────────────────────────

const TAG_ACCESS_MODE = "flagship/app-access-mode/v1";

interface AccessModeFields {
  serverId: string;
  appId: string;
  protectContent: boolean;
  issuedAt: number;
}

export function canonicalAccessMode(f: AccessModeFields): Uint8Array {
  return new TextEncoder().encode(
    [TAG_ACCESS_MODE, f.serverId, f.appId, f.protectContent ? "1" : "0", f.issuedAt].join("|"),
  );
}

export function signAccessMode(f: AccessModeFields, psk: Keypair): Uint8Array {
  return ed.sign(canonicalAccessMode(f), psk.privateKey);
}

/**
 * Build the /access-mode handler. Path shape and verification follow the
 * same pattern as the rest of the invite surface (#80): PSK-signed,
 * fresh `issuedAt`, exact serverId + appId match.
 */
export function buildAccessModeHandler(deps: AccessGateDeps) {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? 5 * 60_000;

  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (!req.path.startsWith("/.flagship/app/")) return null;
    const qIdx = req.path.indexOf("?");
    const pathOnly = qIdx === -1 ? req.path : req.path.slice(0, qIdx);
    const tail = pathOnly.slice("/.flagship/app/".length);
    const parts = tail.split("/");
    if (parts.length !== 2 || parts[1] !== "access-mode" || req.method !== "POST") return null;
    const appId = parts[0]!;

    const body = safeJsonParse(req.body.toString("utf8")) as
      | { request?: unknown; signature?: unknown }
      | null;
    if (!body || typeof body.signature !== "string" || !body.request) {
      return jerr(400, "malformed body");
    }
    const r = body.request as Record<string, unknown>;
    if (typeof r.serverId !== "string" || r.serverId !== deps.serverFqdn) {
      return jerr(403, "serverId mismatch");
    }
    if (typeof r.appId !== "string" || r.appId !== appId) return jerr(400, "appId mismatch");
    if (typeof r.protectContent !== "boolean") return jerr(400, "protectContent must be a boolean");
    if (typeof r.issuedAt !== "number") return jerr(400, "issuedAt must be a number");
    if (Math.abs(now() - r.issuedAt) > maxAgeMs) return jerr(403, "stale request");

    let sig: Uint8Array;
    try {
      sig = hexToBytes(body.signature);
    } catch {
      return jerr(400, "invalid signature hex");
    }
    const canonical = canonicalAccessMode({
      serverId: deps.serverFqdn,
      appId,
      protectContent: r.protectContent,
      issuedAt: r.issuedAt,
    });
    try {
      if (!ed.verify(sig, canonical, deps.pskPub)) {
        return jerr(403, "invalid signature");
      }
    } catch {
      return jerr(403, "invalid signature");
    }

    const prior = await deps.modeStore.set(appId, r.protectContent);
    let warning: { activeSessions: number } | null = null;
    if (!prior && r.protectContent) {
      const active = await deps.inviteStore.listActiveAccess(appId);
      warning = { activeSessions: active.length };
    }
    return {
      status: 200,
      headers: J,
      body: JSON.stringify({
        ok: true,
        appId,
        protectContent: r.protectContent,
        prior,
        ...(warning ? { warning } : {}),
      }),
    };
  };
}

function jerr(status: number, error: string): HttpResponse {
  return { status, headers: J, body: JSON.stringify({ error }) };
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function hexToBytes(s: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Reference unused imports so type-only paths don't get stripped.
void createHash;
