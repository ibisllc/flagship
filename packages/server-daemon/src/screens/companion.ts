/**
 * P14 — Companion-browser dock BFF.
 *
 * Wave 1 (this file) implements the four endpoints documented in the
 * cycle plan; wave 9 will add the write-relay (the owner-side app
 * approves a queued signed write on behalf of the companion). Today
 * companions are strictly read-only — they can render every
 * /api/screens/* read endpoint, but any signed-envelope mutation
 * returns 403 `companion-write-not-allowed`.
 *
 * Endpoints (the redeem is mounted on the public path, not under
 * /api/screens/, because the ticketId+secret IS the proof):
 *
 *   POST /api/screens/companion/mint-ticket   (paired-session gated)
 *   POST /api/companion/redeem                (public; ticket-proof only)
 *   GET  /api/screens/companion/list          (paired-session gated)
 *   POST /api/screens/companion/revoke        (paired-session gated)
 *
 * The redeem path consumes the ticket atomically and writes a NEW
 * paired-session row to `FilePairedSessionStore` flagged with
 * `companion: true` + `expiresAt = now + 4h`. The gate's `check()`
 * rejects companion rows past expiry; `isCompanionRequest()` lets the
 * BFF's write handlers short-circuit with 403.
 */

import { randomBytes } from "node:crypto";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import type { FilePairedSessionStore } from "../pairedSessionStore.js";
import type {
  CompanionTicketRow,
  CompanionTicketStore,
} from "../companion/companionTicketStore.js";
import { sha256HexOfHex } from "../companion/companionTicketStore.js";
import type { CompanionWriteRequestStore } from "../companion/companionWriteRequestStore.js";
import type {
  CompanionDockRequestRow,
  CompanionDockRequestStore,
} from "../companion/companionDockRequestStore.js";

const J = { "content-type": "application/json" } as const;

/** Default ticket TTL (60 seconds). */
const DEFAULT_TICKET_TTL_MS = 60_000;
/** Default companion-session TTL (4 hours). */
const DEFAULT_COMPANION_TTL_MS = 4 * 60 * 60_000;

export interface CompanionBffDeps {
  /** Required. The ticket ledger. */
  ticketStore: CompanionTicketStore;
  /** Desktop-initiated docking requests. Optional during rolling upgrades. */
  dockRequestStore?: CompanionDockRequestStore;
  /**
   * Required. The paired-session store the companion-session token
   * lands in. The same store the owner uses for normal sessions —
   * companions are flagged with `companion: true`.
   */
  pairedSessions: FilePairedSessionStore;
  /** Canonical FQDN of this pod. Returned to the client on redeem. */
  serverFqdn: string;
  /** Owner's username (e.g. "alice"). Returned to the client on redeem. */
  username: string;
  /** Test seam. */
  now?: () => number;
  /** Test seam. */
  randomBytes?: (n: number) => Uint8Array;
  /** Override ticket TTL. Default 60s. */
  ticketTtlMs?: number;
  /** Override companion-session TTL. Default 4h. */
  companionTtlMs?: number;
  /**
   * P14 Phase 2 — write-relay queue. Optional in v1: when unset, the
   * four relay endpoints respond 503. Production wires one
   * `InMemoryCompanionWriteRequestStore` shared across the four
   * routes; a SQLite adapter can slot in later via the same interface.
   */
  writeRequestStore?: CompanionWriteRequestStore;
  /** Override write-request TTL. Default 10 minutes. */
  writeRequestTtlMs?: number;
}

export interface MintTicketRequest {}

export interface MintTicketResponse {
  ticketId: string;
  ticketSecret: string;
  expiresAt: number;
}

export interface RedeemTicketRequest {
  ticketId: string;
  ticketSecret: string;
}

export interface RedeemTicketResponse {
  companionSessionToken: string;
  expiresAt: number;
  podBaseUrl: string;
  username: string;
}

export interface CompanionSummary {
  tokenPrefix: string;
  redeemedAt: number;
  lastSeenMs: number;
  expiresAt: number;
  userAgent?: string;
}

export interface CompanionListResponse {
  companions: CompanionSummary[];
}

export interface RevokeCompanionRequest {
  tokenPrefix: string;
}

export interface BeginCompanionDockRequest {
  pollSecret: string;
  userAgent?: string;
}

export interface ApproveCompanionDockRequest {
  requestId: string;
  approvalSecret: string;
}

export interface PollCompanionDockRequest {
  requestId: string;
  pollSecret: string;
}

/**
 * POST /api/companion/dock/begin — public desktop entry.
 *
 * The browser supplies a polling secret that never appears in the QR. The
 * daemon returns a separate approval secret for the phone to scan. Possessing
 * the QR therefore cannot retrieve the eventual companion bearer token.
 */
export async function handleBeginCompanionDock(
  deps: CompanionBffDeps,
  req: HttpRequest,
): Promise<HttpResponse> {
  if (!deps.dockRequestStore) return jerr(503, "companion dock requests not configured");
  const body = parseJson(req.body) as BeginCompanionDockRequest | null;
  if (!body || !isSecretHex(body.pollSecret)) {
    return jerr(400, "pollSecret must be 64 hex characters");
  }
  const now = deps.now ?? (() => Date.now());
  const rand = deps.randomBytes ?? ((n: number) => new Uint8Array(randomBytes(n)));
  const issuedAt = now();
  const expiresAt = issuedAt + (deps.ticketTtlMs ?? DEFAULT_TICKET_TTL_MS);
  const requestId = bytesToHex(rand(16));
  const approvalSecret = bytesToHex(rand(32));
  const claimedAgent = typeof body.userAgent === "string" ? body.userAgent : undefined;
  const headerAgent = req.headers["user-agent"] ?? req.headers["User-Agent"];
  const userAgent = (claimedAgent || headerAgent || "").slice(0, 256) || undefined;
  const row: CompanionDockRequestRow = {
    requestId,
    pollSecretHash: sha256HexOfHex(body.pollSecret),
    approvalSecretHash: sha256HexOfHex(approvalSecret),
    issuedAt,
    expiresAt,
    status: "pending",
  };
  if (userAgent) row.userAgent = userAgent;
  await deps.dockRequestStore.insert(row);
  return jok({
    requestId,
    approvalSecret,
    expiresAt,
    podBaseUrl: `https://${deps.serverFqdn}`,
    username: deps.username,
  });
}

/** Owner-session gated; the native client adds its local biometric gate. */
export async function handleApproveCompanionDock(
  deps: CompanionBffDeps,
  req: HttpRequest,
): Promise<HttpResponse> {
  if (!deps.dockRequestStore) return jerr(503, "companion dock requests not configured");
  const body = parseJson(req.body) as ApproveCompanionDockRequest | null;
  if (!body || !isRequestId(body.requestId) || !isSecretHex(body.approvalSecret)) {
    return jerr(400, "valid requestId and approvalSecret required");
  }
  const now = deps.now ?? (() => Date.now());
  const rand = deps.randomBytes ?? ((n: number) => new Uint8Array(randomBytes(n)));
  const approvedAt = now();
  const companionSessionToken = bytesToHex(rand(32));
  const companionExpiresAt = approvedAt + (deps.companionTtlMs ?? DEFAULT_COMPANION_TTL_MS);
  const result = await deps.dockRequestStore.approveAtomically({
    requestId: body.requestId,
    approvalSecretHashMatch: sha256HexOfHex(body.approvalSecret),
    approvedAt,
    companionSessionToken,
    companionExpiresAt,
  });
  if (!result.ok) {
    if (result.reason === "not-found" || result.reason === "wrong-secret") {
      return jerr(401, "invalid dock request");
    }
    if (result.reason === "already-approved") return jerr(409, "dock request already approved");
    return jerr(410, "dock request expired");
  }
  await deps.pairedSessions.addCompanion({
    token: companionSessionToken,
    addedAt: approvedAt,
    expiresAt: companionExpiresAt,
    userAgent: result.row.userAgent,
  });
  return jok({ ok: true, expiresAt: companionExpiresAt });
}

/** Public, but the browser-only polling secret is required. */
export async function handlePollCompanionDock(
  deps: CompanionBffDeps,
  req: HttpRequest,
): Promise<HttpResponse> {
  if (!deps.dockRequestStore) return jerr(503, "companion dock requests not configured");
  const body = parseJson(req.body) as PollCompanionDockRequest | null;
  if (!body || !isRequestId(body.requestId) || !isSecretHex(body.pollSecret)) {
    return jerr(400, "valid requestId and pollSecret required");
  }
  const now = deps.now ?? (() => Date.now());
  const result = await deps.dockRequestStore.poll({
    requestId: body.requestId,
    pollSecretHashMatch: sha256HexOfHex(body.pollSecret),
    nowMs: now(),
  });
  if (!result.ok) {
    if (result.reason === "expired") return jerr(410, "dock request expired");
    return jerr(401, "invalid dock request");
  }
  if (result.row.status === "pending") {
    return {
      status: 202,
      headers: J,
      body: JSON.stringify({ status: "pending", expiresAt: result.row.expiresAt }),
    };
  }
  if (!result.row.companionSessionToken || !result.row.companionExpiresAt) {
    return jerr(500, "approved dock request is incomplete");
  }
  return jok({
    status: "approved",
    companionSessionToken: result.row.companionSessionToken,
    expiresAt: result.row.companionExpiresAt,
    podBaseUrl: `https://${deps.serverFqdn}`,
    username: deps.username,
  });
}

/**
 * POST /api/screens/companion/mint-ticket  — owner-gated.
 *
 * Mints a fresh single-use ticket. The owner-side webapp QR-encodes
 * `{ticketId, ticketSecret, podBaseUrl, username}` and the companion
 * browser scans it. The ticket itself never leaves the owner's screen
 * AND the receiving browser's request body — never an URL.
 */
export async function handleMintTicket(
  deps: CompanionBffDeps,
  req: HttpRequest,
): Promise<HttpResponse> {
  const now = deps.now ?? (() => Date.now());
  const rand = deps.randomBytes ?? ((n: number) => new Uint8Array(randomBytes(n)));
  const ttl = deps.ticketTtlMs ?? DEFAULT_TICKET_TTL_MS;

  parseJson(req.body);

  const ticketId = bytesToHex(rand(16));
  const secret = bytesToHex(rand(32));
  const secretHash = sha256HexOfHex(secret);
  const issuedAt = now();
  const expiresAt = issuedAt + ttl;

  const row: CompanionTicketRow = {
    ticketId,
    secretHash,
    issuedAt,
    expiresAt,
    status: "pending",
  };
  await deps.ticketStore.insert(row);

  const out: MintTicketResponse = {
    ticketId,
    ticketSecret: secret,
    expiresAt,
  };
  return jok(out);
}

/**
 * POST /api/companion/redeem  — public.
 *
 * Consumes a ticket atomically and writes a NEW companion
 * paired-session row. The ticketId + ticketSecret pair is the proof —
 * there is no other auth on this endpoint. The token is returned in
 * the response body; companions MUST send it as `x-flagship-session`
 * on subsequent calls.
 */
export async function handleRedeemTicket(
  deps: CompanionBffDeps,
  req: HttpRequest,
): Promise<HttpResponse> {
  const now = deps.now ?? (() => Date.now());
  const rand = deps.randomBytes ?? ((n: number) => new Uint8Array(randomBytes(n)));
  const companionTtl = deps.companionTtlMs ?? DEFAULT_COMPANION_TTL_MS;

  const body = parseJson(req.body) as RedeemTicketRequest | null;
  if (!body) return jerr(400, "body required");
  if (typeof body.ticketId !== "string" || body.ticketId.length === 0) {
    return jerr(400, "ticketId required");
  }
  if (typeof body.ticketSecret !== "string" || body.ticketSecret.length === 0) {
    return jerr(400, "ticketSecret required");
  }

  const secretHash = sha256HexOfHex(body.ticketSecret);
  const result = await deps.ticketStore.consumeAtomically({
    ticketId: body.ticketId,
    secretHashMatch: secretHash,
    consumedAt: now(),
  });
  if (!result.ok) {
    if (result.reason === "not-found" || result.reason === "wrong-secret") {
      // Don't disambiguate to the client; both branches are auth
      // failures from the requester's perspective.
      return jerr(401, "invalid ticket");
    }
    if (result.reason === "replay") return jerr(409, "ticket already consumed");
    if (result.reason === "expired") return jerr(410, "ticket expired");
    return jerr(400, "redeem failed");
  }

  const sessionToken = bytesToHex(rand(32));
  const redeemedAt = now();
  const expiresAt = redeemedAt + companionTtl;
  const ua = req.headers["user-agent"] ?? req.headers["User-Agent"];
  const userAgent = typeof ua === "string" && ua.length > 0 ? ua.slice(0, 256) : null;

  await deps.pairedSessions.addCompanion({
    token: sessionToken,
    addedAt: redeemedAt,
    expiresAt,
    userAgent,
  });

  const out: RedeemTicketResponse = {
    companionSessionToken: sessionToken,
    expiresAt,
    podBaseUrl: `https://${deps.serverFqdn}`,
    username: deps.username,
  };
  return jok(out);
}

/**
 * GET /api/screens/companion/list  — owner-gated.
 *
 * Lists active (non-expired) companion sessions. The owner sees only
 * a token PREFIX (first 12 chars) so the list can be revoked without
 * surfacing the bearer.
 */
export async function handleListCompanions(
  deps: CompanionBffDeps,
): Promise<HttpResponse> {
  const now = deps.now ?? (() => Date.now());
  const rows = deps.pairedSessions.listCompanions(now());
  const companions: CompanionSummary[] = rows.map((r) => {
    const out: CompanionSummary = {
      tokenPrefix: r.token.slice(0, 12),
      redeemedAt: r.addedAt,
      // v1 — `lastSeenMs` is the redeem time; a future revision will
      // wire it into the gate so we can show "active 30s ago".
      lastSeenMs: r.addedAt,
      expiresAt: r.expiresAt,
    };
    if (r.userAgent) out.userAgent = r.userAgent;
    return out;
  });
  const body: CompanionListResponse = { companions };
  return jok(body);
}

/**
 * POST /api/screens/companion/revoke  — owner-gated.
 *
 * Removes a companion session by token prefix. Idempotent: revoking
 * an already-gone session still returns `{ ok: true }`.
 */
export async function handleRevokeCompanion(
  deps: CompanionBffDeps,
  req: HttpRequest,
): Promise<HttpResponse> {
  const body = parseJson(req.body) as RevokeCompanionRequest | null;
  if (!body || typeof body.tokenPrefix !== "string" || body.tokenPrefix.length < 8) {
    return jerr(400, "tokenPrefix (>= 8 chars) required");
  }
  const prefix = body.tokenPrefix;
  const matches = deps.pairedSessions
    .list()
    .filter((s) => s.token.startsWith(prefix));
  if (matches.length === 0) {
    // Idempotent — already gone is fine.
    return jok({ ok: true });
  }
  if (matches.length > 1) {
    return jerr(409, "ambiguous prefix; provide more chars");
  }
  await deps.pairedSessions.remove(matches[0]!.token);
  return jok({ ok: true });
}

/**
 * Companion write-gate. Handlers that mutate state under a
 * paired-session token call this BEFORE executing the work. Returns
 * a 403 HttpResponse when the caller is a companion; null otherwise.
 */
export function denyCompanionWrite(
  pairedSessions: FilePairedSessionStore | null | undefined,
  req: HttpRequest,
): HttpResponse | null {
  if (!pairedSessions) return null;
  // Defensive: test harnesses sometimes pass a minimal stub that
  // doesn't implement the companion surface. Treat "no companion
  // surface" as "no companions exist", which is honest for legacy
  // gates that pre-date this feature.
  if (typeof (pairedSessions as { isCompanionRequest?: unknown }).isCompanionRequest !== "function") {
    return null;
  }
  if (!pairedSessions.isCompanionRequest(req)) return null;
  return {
    status: 403,
    headers: J,
    body: JSON.stringify({
      code: "companion-write-not-allowed",
      message: "Open your owner app to approve this",
    }),
  };
}

function parseJson(buf: Buffer): unknown {
  if (buf.length === 0) return null;
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
}

function jok(body: unknown): HttpResponse {
  return { status: 200, headers: J, body: JSON.stringify(body) };
}

function jerr(status: number, message: string): HttpResponse {
  return { status, headers: J, body: JSON.stringify({ error: message }) };
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function isSecretHex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

// Re-export so tests + the BFF wiring can reach the helper without
// double-importing the deeper module.
export { sha256HexOfHex as _sha256HexOfHex };
