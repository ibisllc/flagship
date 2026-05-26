// P14 Phase 2 — Companion write-relay client (companion-profile side).
//
// When the active profile is a companion and the user attempts a
// signed write that v1-Phase-2 supports (`release-server` /
// `revoke-server`), the helpers in releaseServer.js / revokeServer.js
// route the intent through here instead of throwing
// CompanionWriteError up front.
//
// Wire shapes (companion-gated; session token via x-flagship-session):
//
//   POST /api/companion/request-write
//     body: { kind, intent }            // intent shape is per-kind, defined in the helpers
//     → 200 { requestId, queuedAt, expiresAt }
//
//   GET  /api/companion/my-pending
//     → 200 { pending: [{ requestId, kind, status, queuedAt, resolvedAt? }] }
//        status ∈ "pending" | "approved" | "denied" | "expired"
//
// Polling: the spec sets ≤10-minute TTL with a 2-second poll cadence.
// pollUntilResolved resolves on the first non-pending status it sees,
// or on "expired" once the TTL window elapses (so a network-flaky
// companion still gets a deterministic terminal state).
//
// Both submit and poll inject `fetch` so tests don't need globals.

import { getPodBaseUrl, getSessionToken } from "./api.js";

/** Kinds the v1 relay accepts. Other kinds keep the original guard
 *  (throw CompanionWriteError + "open your owner app" toast). */
export const RELAYABLE_KINDS = Object.freeze(["release-server", "revoke-server"]);

/** v1 TTL — must match the daemon contract. */
export const REQUEST_TTL_MS = 10 * 60 * 1000;

/** Default poll cadence — must match the spec. */
export const POLL_INTERVAL_MS = 2000;

export class CompanionRelayError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "CompanionRelayError";
    this.code = code;
  }
}

function makeError(message, code) {
  return new CompanionRelayError(message, code);
}

/** True iff this kind is forwardable via the relay (vs. blocked). */
export function isRelayableKind(kind) {
  return RELAYABLE_KINDS.includes(kind);
}

/**
 * Resolve the URL the companion POSTs to. Defaults to the user's pod
 * base URL recorded by api.js; tests can override via deps.podBaseUrl.
 */
function resolveBase(deps) {
  const base = (typeof deps.podBaseUrl === "string" ? deps.podBaseUrl : getPodBaseUrl()) || "";
  if (!base) throw makeError("not paired to a server yet", "no-pod");
  return base.replace(/\/+$/, "");
}

/**
 * Resolve the companion's session token for the x-flagship-session header.
 */
function resolveToken(deps) {
  const tok = (typeof deps.sessionToken === "string" ? deps.sessionToken : getSessionToken()) || "";
  if (!tok) throw makeError("no session token; re-pair", "no-session");
  return tok;
}

/**
 * Submit a write-request to the owner. Returns the queued envelope.
 *
 * @param {object} args
 * @param {"release-server"|"revoke-server"} args.kind
 * @param {object} args.intent  Per-kind body — release-server passes
 *   `{ username, serverDomain, issuedAt }`; revoke-server passes
 *   `{ userId, revokedServerId, reason, issuedAt }`.
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetch]
 * @param {string} [deps.podBaseUrl] override the pod base URL
 * @param {string} [deps.sessionToken] override the session token
 * @returns {Promise<{ requestId: string, queuedAt: number, expiresAt: number }>}
 */
export async function submitWriteRequest({ kind, intent }, deps = {}) {
  if (!isRelayableKind(kind)) {
    throw makeError(`kind ${kind} not relayable`, "not-relayable");
  }
  if (!intent || typeof intent !== "object") {
    throw makeError("intent required", "400");
  }
  const f = deps.fetch || fetch;
  const base = resolveBase(deps);
  const tok = resolveToken(deps);
  let resp;
  try {
    resp = await f(`${base}/api/companion/request-write`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-flagship-session": tok,
      },
      body: JSON.stringify({ kind, intent }),
    });
  } catch (e) {
    throw makeError(`network: ${e?.message ?? e}`, "network");
  }
  const text = await resp.text().catch(() => "");
  let body = null;
  try { body = text.length ? JSON.parse(text) : null; } catch { body = text; }
  if (!resp.ok) {
    const msg = body && typeof body === "object" && "error" in body ? body.error : `HTTP ${resp.status}`;
    throw makeError(`request-write failed: ${msg}`, String(resp.status));
  }
  if (!body || typeof body.requestId !== "string"
      || typeof body.queuedAt !== "number"
      || typeof body.expiresAt !== "number") {
    throw makeError("malformed request-write response", "bad-response");
  }
  return {
    requestId: body.requestId,
    queuedAt: body.queuedAt,
    expiresAt: body.expiresAt,
  };
}

/**
 * Fetch the companion's own pending list. Owner-resolved rows are
 * filtered IN here too so the companion view can render a single
 * stream of recent activity (pending + finalized).
 *
 * @param {object} [deps]
 * @returns {Promise<{ pending: Array<{ requestId: string, kind: string,
 *   status: "pending"|"approved"|"denied"|"expired", queuedAt: number,
 *   resolvedAt?: number }> }>}
 */
export async function listMyPending(deps = {}) {
  const f = deps.fetch || fetch;
  const base = resolveBase(deps);
  const tok = resolveToken(deps);
  let resp;
  try {
    resp = await f(`${base}/api/companion/my-pending`, {
      method: "GET",
      headers: { "x-flagship-session": tok },
    });
  } catch (e) {
    throw makeError(`network: ${e?.message ?? e}`, "network");
  }
  const text = await resp.text().catch(() => "");
  let body = null;
  try { body = text.length ? JSON.parse(text) : null; } catch { body = text; }
  if (!resp.ok) {
    const msg = body && typeof body === "object" && "error" in body ? body.error : `HTTP ${resp.status}`;
    throw makeError(`my-pending failed: ${msg}`, String(resp.status));
  }
  const pending = Array.isArray(body?.pending) ? body.pending : [];
  return { pending };
}

/**
 * Poll `/api/companion/my-pending` every `intervalMs` (default 2000),
 * resolving on the first non-pending status for the given requestId,
 * or with `"expired"` once the TTL window elapses.
 *
 * Resolves to `{ status, resolvedAt? }`. Throws CompanionRelayError on
 * transport failure that exceeds the TTL window (so a transient blip
 * doesn't terminate the poll early).
 *
 * @param {string} requestId
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetch]
 * @param {string} [deps.podBaseUrl]
 * @param {string} [deps.sessionToken]
 * @param {(fn: () => void, ms: number) => any} [deps.setTimeout]
 * @param {(handle: any) => void} [deps.clearTimeout]
 * @param {() => number} [deps.now]
 * @param {number} [deps.intervalMs]
 * @param {number} [deps.ttlMs]
 * @param {(status: string) => void} [deps.onTick] called once per poll iteration
 * @returns {Promise<{ status: "approved"|"denied"|"expired", resolvedAt?: number }>}
 */
export async function pollUntilResolved(requestId, deps = {}) {
  if (!requestId || typeof requestId !== "string") {
    throw makeError("requestId required", "400");
  }
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;
  const now = deps.now || (() => Date.now());
  const interval = typeof deps.intervalMs === "number" ? deps.intervalMs : POLL_INTERVAL_MS;
  const ttl = typeof deps.ttlMs === "number" ? deps.ttlMs : REQUEST_TTL_MS;
  const start = now();
  const onTick = typeof deps.onTick === "function" ? deps.onTick : null;

  return new Promise((resolve, reject) => {
    let handle = null;
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (handle != null) {
        try { clearT(handle); } catch { /* ignore */ }
        handle = null;
      }
    };

    const tick = async () => {
      if (stopped) return;
      try {
        const { pending } = await listMyPending(deps);
        if (stopped) return;
        const row = Array.isArray(pending)
          ? pending.find((p) => p && p.requestId === requestId)
          : null;
        const status = row?.status ?? "pending";
        if (onTick) {
          try { onTick(status); } catch { /* swallow user callback errors */ }
        }
        if (status === "approved" || status === "denied" || status === "expired") {
          stop();
          resolve({ status, resolvedAt: row?.resolvedAt });
          return;
        }
        // Pending — schedule next poll, unless TTL elapsed.
        if (now() - start >= ttl) {
          stop();
          resolve({ status: "expired" });
          return;
        }
        handle = setT(tick, interval);
      } catch (e) {
        if (stopped) return;
        // Transport hiccup — keep polling if we have TTL left.
        if (now() - start >= ttl) {
          stop();
          reject(e instanceof CompanionRelayError ? e : makeError(String(e?.message ?? e), "network"));
          return;
        }
        handle = setT(tick, interval);
      }
    };
    // First call is synchronous via microtask so tests can advance fake timers immediately.
    Promise.resolve().then(tick);
  });
}
