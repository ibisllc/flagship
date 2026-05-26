/**
 * P14 Phase 2 — Companion write-relay HTTP handlers.
 *
 * Four endpoints (all under the screens dispatcher; the
 * `/api/companion/request-write` + `/api/companion/my-pending` pair
 * lives OUTSIDE `/api/screens/` because Phase 1 already grandfathered
 * the public `/api/companion/redeem` carve-out — but they STILL run
 * through the paired-session gate; the redeem endpoint is the only
 * truly public companion path because its proof-of-auth IS the
 * ticket).
 *
 * Endpoint                                          Gate           Body
 * ─────────────────────────────────────────────────────────────────────
 * POST /api/companion/request-write                 COMPANION      { kind, intent }
 * GET  /api/screens/companion/pending-writes        OWNER          —
 * POST /api/screens/companion/resolve-pending       OWNER          { requestId, outcome }
 * GET  /api/companion/my-pending                    COMPANION      —
 *
 * The four routes share a single `CompanionWriteRequestStore`
 * instance, wired through `ScreensHttpDeps.companion.writeRequestStore`.
 *
 * Push integration: deferred to Phase 2.5. Three hook points are
 * marked inline in this file. v1 is pure polling.
 */

import { randomBytes } from "node:crypto";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import type { FilePairedSessionStore } from "../pairedSessionStore.js";
import { extractPairedSessionToken } from "../pairedSessionStore.js";
import {
  type CompanionWriteRequestKind,
  type CompanionWriteRequestRow,
  type CompanionWriteRequestStatus,
  type CompanionWriteRequestStore,
  isSupportedWriteRequestKind,
} from "../companion/companionWriteRequestStore.js";

const J = { "content-type": "application/json" } as const;

/** Default write-request TTL (10 minutes). */
export const COMPANION_WRITE_REQUEST_TTL_MS = 10 * 60_000;

export interface CompanionWriteRelayDeps {
  writeRequestStore: CompanionWriteRequestStore;
  pairedSessions: FilePairedSessionStore;
  /** Test seam. */
  now?: () => number;
  /** Test seam. */
  randomBytes?: (n: number) => Uint8Array;
  /** Override TTL. Default 10 minutes. */
  ttlMs?: number;
}

// ---- Request/response shapes (exported so callers can mirror types) ----

export interface RequestWriteBody {
  kind: CompanionWriteRequestKind;
  intent: Record<string, unknown>;
}

export interface RequestWriteResponse {
  requestId: string;
  queuedAt: number;
  expiresAt: number;
}

export interface PendingWriteSummary {
  requestId: string;
  companionTokenPrefix: string;
  companionLabel: string | null;
  kind: CompanionWriteRequestKind;
  intent: Record<string, unknown>;
  queuedAt: number;
  expiresAt: number;
}

export interface PendingWritesResponse {
  pending: PendingWriteSummary[];
}

export interface ResolvePendingBody {
  requestId: string;
  outcome: "approved" | "denied";
}

export interface ResolvePendingResponse {
  ok: true;
  alreadyResolved: boolean;
}

export type CompanionPendingStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired";

export interface CompanionPendingRow {
  requestId: string;
  kind: CompanionWriteRequestKind;
  status: CompanionPendingStatus;
  queuedAt: number;
  resolvedAt?: number;
}

export interface MyPendingResponse {
  pending: CompanionPendingRow[];
}

/**
 * POST /api/companion/request-write — COMPANION-gated.
 *
 * Caller MUST be a companion paired-session (the existing 403 gate on
 * destination endpoints stays; this is the explicit opt-in path). If
 * the caller is the OWNER (non-companion paired-session), we respond
 * 401 to make the asymmetry explicit — the owner has no use for this
 * endpoint and the surface area shouldn't widen silently.
 */
export async function handleRequestWrite(
  deps: CompanionWriteRelayDeps,
  req: HttpRequest,
): Promise<HttpResponse> {
  const now = deps.now ?? (() => Date.now());
  const rand =
    deps.randomBytes ?? ((n: number) => new Uint8Array(randomBytes(n)));
  const ttl = deps.ttlMs ?? COMPANION_WRITE_REQUEST_TTL_MS;

  // Resolve the caller's token → companion row. The gate already
  // ran; we know it's authenticated, but we need to confirm it's a
  // companion + pull the label.
  const token = extractPairedSessionToken(req);
  if (!token) return jerr(401, "missing paired-session token");
  const row = deps.pairedSessions.get(token);
  if (!row) return jerr(401, "invalid paired-session token");
  if (row.companion !== true) {
    return jerr(401, "request-write is companion-only");
  }
  // Defensive: the gate already rejected expired companions, but in
  // case this handler is ever called outside the dispatcher we re-check.
  if (typeof row.expiresAt === "number" && row.expiresAt <= now()) {
    return jerr(401, "companion session expired");
  }

  const body = parseJson(req.body) as RequestWriteBody | null;
  if (!body || typeof body !== "object") return jerr(400, "body required");
  if (typeof body.kind !== "string") return jerr(400, "kind required");
  if (!isSupportedWriteRequestKind(body.kind)) {
    return { status: 400, headers: J, body: JSON.stringify({ error: "kind-not-supported-in-v1" }) };
  }
  if (
    !body.intent ||
    typeof body.intent !== "object" ||
    Array.isArray(body.intent)
  ) {
    return jerr(400, "intent (object) required");
  }

  const requestId = bytesToHex(rand(16));
  const queuedAt = now();
  const expiresAt = queuedAt + ttl;
  const tokenPrefix = token.slice(0, 12);
  const companionLabel = row.companionLabel ?? null;

  const persisted: CompanionWriteRequestRow = {
    requestId,
    companionTokenPrefix: tokenPrefix,
    companionLabel,
    kind: body.kind,
    intent: body.intent,
    queuedAt,
    expiresAt,
    status: "pending",
  };
  await deps.writeRequestStore.insert(persisted);

  // PHASE 2.5 HOOK: notify the OWNER device (push) that a companion
  // queued a write. v1 is polling-only; the owner's app/webapp
  // refreshes /api/screens/companion/pending-writes on a timer. When
  // push lands, fire a `notifyOwner({ kind: "companion-write-queued",
  // requestId, companionLabel, kind: body.kind })` here.

  const out: RequestWriteResponse = { requestId, queuedAt, expiresAt };
  return jok(out);
}

/**
 * GET /api/screens/companion/pending-writes — OWNER-gated.
 *
 * Lists every pending (unresolved + non-expired) write request,
 * oldest-first. The owner reads the intent, signs it, POSTs to the
 * destination, then resolves the row.
 */
export async function handlePendingWrites(
  deps: CompanionWriteRelayDeps,
): Promise<HttpResponse> {
  const now = deps.now ?? (() => Date.now());
  const rows = await deps.writeRequestStore.listPendingForOwner(now());
  rows.sort((a, b) => a.queuedAt - b.queuedAt);
  const pending: PendingWriteSummary[] = rows.map((r) => ({
    requestId: r.requestId,
    companionTokenPrefix: r.companionTokenPrefix,
    companionLabel: r.companionLabel,
    kind: r.kind,
    intent: r.intent,
    queuedAt: r.queuedAt,
    expiresAt: r.expiresAt,
  }));
  const body: PendingWritesResponse = { pending };
  return jok(body);
}

/**
 * POST /api/screens/companion/resolve-pending — OWNER-gated.
 *
 * Marks a queued row resolved (approved | denied). Idempotent: a
 * second call returns `{ ok: true, alreadyResolved: true }`.
 *
 * NOTE: we DON'T cross-check that the owner actually dispatched the
 * signed write — that's their responsibility. This endpoint just
 * records the audit outcome + lets the companion's poller observe
 * the state transition.
 */
export async function handleResolvePending(
  deps: CompanionWriteRelayDeps,
  req: HttpRequest,
): Promise<HttpResponse> {
  const now = deps.now ?? (() => Date.now());
  const body = parseJson(req.body) as ResolvePendingBody | null;
  if (!body || typeof body !== "object") return jerr(400, "body required");
  if (typeof body.requestId !== "string" || body.requestId.length === 0) {
    return jerr(400, "requestId required");
  }
  if (body.outcome !== "approved" && body.outcome !== "denied") {
    return jerr(400, "outcome must be 'approved' or 'denied'");
  }
  const result = await deps.writeRequestStore.resolve({
    requestId: body.requestId,
    outcome: body.outcome,
    resolvedAt: now(),
  });
  if (!result.ok) {
    return jerr(404, "requestId not found");
  }

  // PHASE 2.5 HOOK: notify the COMPANION (via the companion's docked
  // session — could be a Server-Sent Events stream or a WebSocket
  // push on the companion side) that its request resolved. v1: the
  // companion polls /api/companion/my-pending.

  const out: ResolvePendingResponse = {
    ok: true,
    alreadyResolved: result.alreadyResolved,
  };
  return jok(out);
}

/**
 * GET /api/companion/my-pending — COMPANION-gated.
 *
 * Returns every row the calling companion queued, with status
 * surfaced (pending / approved / denied / expired). The webapp polls
 * this to drive its "waiting for owner approval..." UI.
 */
export async function handleMyPending(
  deps: CompanionWriteRelayDeps,
  req: HttpRequest,
): Promise<HttpResponse> {
  const now = deps.now ?? (() => Date.now());
  const token = extractPairedSessionToken(req);
  if (!token) return jerr(401, "missing paired-session token");
  const row = deps.pairedSessions.get(token);
  if (!row) return jerr(401, "invalid paired-session token");
  if (row.companion !== true) {
    return jerr(401, "my-pending is companion-only");
  }
  const tokenPrefix = token.slice(0, 12);
  const rows = await deps.writeRequestStore.listForCompanion(tokenPrefix);
  rows.sort((a, b) => a.queuedAt - b.queuedAt);
  const t = now();
  const pending: CompanionPendingRow[] = rows.map((r) => {
    const status = projectStatus(r, t);
    const out: CompanionPendingRow = {
      requestId: r.requestId,
      kind: r.kind,
      status,
      queuedAt: r.queuedAt,
    };
    if (typeof r.resolvedAt === "number") out.resolvedAt = r.resolvedAt;
    return out;
  });
  const body: MyPendingResponse = { pending };
  return jok(body);
}

function projectStatus(
  r: CompanionWriteRequestRow,
  nowMs: number,
): CompanionPendingStatus {
  // Resolved rows surface their final outcome regardless of TTL —
  // expiry only governs the pending → expired transition. (A row
  // approved at t=2min then read at t=15min is still "approved".)
  const baseStatus: CompanionWriteRequestStatus = r.status;
  if (baseStatus === "approved") return "approved";
  if (baseStatus === "denied") return "denied";
  if (r.expiresAt <= nowMs) return "expired";
  return "pending";
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
