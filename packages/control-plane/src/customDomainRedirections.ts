// `.com` side of the custom-domain control channel (#87, Phase 3).
//
//   - handleActiveRedirections: GET /api/internal/active-redirections
//     — authed (shared SERVICES_CONTROL_SECRET, constant-time bearer);
//     returns every confirmed fqdn→podCanonical so `.services` can
//     rebuild its RAM redirection table on cold start.
//   - pushRedirection: helper the Phase-4 verifier calls to POST an
//     add/delete to `.services` POST /control/redirections.
//
// Auth rationale: a constant-time-compared shared bearer secret over
// TLS between two first-party services. The payloads are idempotent,
// non-sensitive routing facts (add/delete fqdn→pod); TLS gives
// confidentiality + integrity in transit; the secret authenticates the
// caller. HMAC-over-body would add replay protection, but add/delete
// are idempotent so replay is harmless — the bearer secret is the
// right weight here.

import type { CustomDomainOrderStorage } from "@flagship/storage";
import { ok, type HandlerResponseWithHeaders } from "./types.js";

/** Length-checked, then XOR-accumulated constant-time compare. The
 *  length of a high-entropy shared secret is not itself sensitive. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Pull `Authorization: Bearer <secret>` → the bare secret, or null. */
export function bearer(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  const m = /^bearer\s+(.+)$/i.exec(authorization.trim());
  return m ? m[1]! : null;
}

export interface ActiveRedirectionsDeps {
  customDomainOrders: CustomDomainOrderStorage;
}

export interface RedirectionEntry {
  fqdn: string;
  podCanonical: string;
}

/**
 * GET /api/internal/active-redirections. Fails CLOSED when the secret
 * is unconfigured (503) or the bearer mismatches (401). On success
 * returns only active orders that already have a serving pod
 * (`podCanonical` set by the Phase-4 verifier).
 */
export async function handleActiveRedirections(
  deps: ActiveRedirectionsDeps,
  presentedSecret: string | null,
  expectedSecret: string | undefined,
): Promise<HandlerResponseWithHeaders> {
  if (!expectedSecret) {
    return { status: 503, body: { error: "control channel not configured" } };
  }
  if (!presentedSecret || !constantTimeEqual(presentedSecret, expectedSecret)) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  const active = await deps.customDomainOrders.listActive();
  const redirections: RedirectionEntry[] = active
    .filter((r): r is typeof r & { podCanonical: string } => !!r.podCanonical)
    .map((r) => ({ fqdn: r.fqdn, podCanonical: r.podCanonical }));
  return ok({ redirections });
}

/**
 * GET /api/internal/redirection-lookup?fqdn=<fqdn> — the lazy
 * SNI-miss path's point lookup (#12, Phase 3 C3.3 lazy half). Same
 * fail-closed auth as the bulk endpoint, but resolves EXACTLY ONE
 * caller-supplied fqdn → its serving pod. Deliberately NOT a
 * list/enumeration endpoint: you must already know the precise fqdn
 * (it came in on the wire as the TLS SNI), so this leaks nothing a
 * `dig`/connection didn't already reveal. 404 on a fqdn with no
 * active+served order so `.services` can negative-cache the miss.
 */
export async function handleRedirectionLookup(
  deps: ActiveRedirectionsDeps,
  presentedSecret: string | null,
  expectedSecret: string | undefined,
  fqdn: string | null | undefined,
): Promise<HandlerResponseWithHeaders> {
  if (!expectedSecret) {
    return { status: 503, body: { error: "control channel not configured" } };
  }
  if (!presentedSecret || !constantTimeEqual(presentedSecret, expectedSecret)) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  const f = (fqdn ?? "").trim().toLowerCase();
  if (f.length === 0 || f.length > 253 || f.includes("/") || f.includes(":")) {
    return { status: 400, body: { error: "fqdn required" } };
  }
  const active = await deps.customDomainOrders.listActive();
  const hit = active.find((r) => r.fqdn.toLowerCase() === f && !!r.podCanonical);
  if (!hit || !hit.podCanonical) {
    return { status: 404, body: { found: false } };
  }
  return ok({ found: true, fqdn: hit.fqdn, podCanonical: hit.podCanonical });
}

export interface PushRedirectionOpts {
  servicesBaseUrl: string;
  secret: string;
  fetchImpl?: typeof fetch;
}

export interface RedirectionOp {
  op: "add" | "delete";
  fqdn: string;
  /** Required for "add"; ignored for "delete". */
  podCanonical?: string;
}

/**
 * POST one add/delete to `.services` POST /control/redirections. Used
 * by the Phase-4 verifier (confirm→add, invalidate/uninstall→delete,
 * replace→delete(old)+add(new) as two calls). Best-effort: returns
 * {ok,status}; never throws (a `.services` blip must not fail the
 * verifier — `.services` cold-start reconciles from the pull anyway).
 */
export async function pushRedirection(
  opts: PushRedirectionOpts,
  msg: RedirectionOp,
): Promise<{ ok: boolean; status: number }> {
  const f = opts.fetchImpl ?? fetch;
  const url = `${opts.servicesBaseUrl.replace(/\/+$/, "")}/control/redirections`;
  try {
    const res = await f(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.secret}`,
      },
      body: JSON.stringify(msg),
      // A .services blip must not hang the Phase-4 verifier; cold-start
      // pull reconciles anything missed.
      signal: AbortSignal.timeout(5000),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}
