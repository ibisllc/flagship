/**
 * HTTP surface for the daemon-side AlertInbox.
 *
 * Mounts at `/api/phone/alerts` (drain) and `/api/phone/alerts/ack`
 * (acknowledge). The phone-paired session polls these every few
 * seconds while the screen is on; the daemon never pushes to the
 * phone (Flagship's "phone always initiates" invariant).
 *
 * Auth is via a paired-session gate the caller supplies. v1 implements
 * `PairedSessionGate` as a Set<token>; future revisions may move to a
 * D1-backed store. The gate runs BEFORE the route handler so a missing
 * or stale token returns 401 without touching the inbox.
 */

import type { AlertInbox } from "./alertInbox.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";

export interface PairedSessionGate {
  /**
   * Verify the request carries a valid paired-session token.
   * Returns null on success (the request may proceed) or an
   * HttpResponse to short-circuit on (401/403 etc).
   */
  check(req: HttpRequest): HttpResponse | null;
}

export interface AlertInboxHttpDeps {
  inbox: AlertInbox;
  gate: PairedSessionGate;
}

const J: Record<string, string> = { "content-type": "application/json" };

export function buildAlertInboxHandlers(deps: AlertInboxHttpDeps) {
  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    const qIdx = req.path.indexOf("?");
    const path = qIdx >= 0 ? req.path.slice(0, qIdx) : req.path;

    if (path === "/api/phone/alerts" && req.method === "GET") {
      const denied = deps.gate.check(req);
      if (denied) return denied;
      const sinceParam = extractQuery(req.path, "since");
      const since = sinceParam ? Number(sinceParam) : 0;
      const events = deps.inbox.list(Number.isFinite(since) ? since : 0);
      return {
        status: 200,
        headers: J,
        body: JSON.stringify({ events, size: deps.inbox.size() }),
      };
    }

    if (path === "/api/phone/alerts/ack" && req.method === "POST") {
      const denied = deps.gate.check(req);
      if (denied) return denied;
      let body: { throughId?: unknown };
      try {
        body = JSON.parse(req.body.toString("utf8")) as { throughId?: unknown };
      } catch {
        return {
          status: 400,
          headers: J,
          body: JSON.stringify({ error: "invalid json" }),
        };
      }
      const throughId = Number(body.throughId);
      if (!Number.isFinite(throughId) || throughId < 0) {
        return {
          status: 400,
          headers: J,
          body: JSON.stringify({ error: "throughId must be a non-negative number" }),
        };
      }
      deps.inbox.ack(throughId);
      return {
        status: 200,
        headers: J,
        body: JSON.stringify({ ok: true, size: deps.inbox.size() }),
      };
    }

    return null;
  };
}

/**
 * Trivial Bearer-token gate — looks for `Authorization: Flagship-Session
 * <token>` and accepts any token in the configured set. Pure in-memory;
 * production callers can swap in a D1- or file-backed gate.
 */
export class TokenSetSessionGate implements PairedSessionGate {
  constructor(private readonly tokens: Set<string>) {}

  check(req: HttpRequest): HttpResponse | null {
    const auth = req.headers["authorization"] ?? req.headers["Authorization"];
    if (typeof auth !== "string" || !auth.startsWith("Flagship-Session ")) {
      return jerr(401, "missing or malformed paired-session token");
    }
    const token = auth.slice("Flagship-Session ".length).trim();
    if (!token || !this.tokens.has(token)) {
      return jerr(401, "invalid paired-session token");
    }
    return null;
  }

  add(token: string): void {
    this.tokens.add(token);
  }
  remove(token: string): void {
    this.tokens.delete(token);
  }
  has(token: string): boolean {
    return this.tokens.has(token);
  }
}

function extractQuery(input: string, key: string): string | null {
  const i = input.indexOf("?");
  if (i < 0) return null;
  const search = new URLSearchParams(input.slice(i + 1));
  return search.get(key);
}

function jerr(status: number, message: string): HttpResponse {
  return { status, headers: J, body: JSON.stringify({ error: message }) };
}
