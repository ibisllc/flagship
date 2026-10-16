/**
 * Separate lists per server, the owner's surface (docs/service-access-gating.md,
 * "Separate lists per server (Pro)"; feat/marketplace only), over the paired
 * session:
 *
 *   GET  /api/screens/services/:id/list-scope
 *        → { serviceRef, scope: "account"|"server", pending, plan: "pro"|"free"|"unknown",
 *            self, leader, servers: [fqdn, …] (the app's servers in server order) }
 *   POST /api/screens/services/:id/list-scope   { order, signature }  (flagship/app-list-scope/v1)
 *        → the same state; 402 { code: "pro-required" } for `server` without Pro
 *   GET  /api/screens/access-lists/summary
 *        → { plan, separateApps, leaders: [fqdn, …] } across the account (asked box to box)
 *
 * The order is admin-only (the AccessScopes verifier), at most 10 minutes old
 * when posted, and newer than the last one for the app.
 */
import { parseAppListScopeOrder } from "@flagship/protocol";
import type { AccessScopes, PlanCheck } from "./accessScope.js";
import type { AccessPeers, AccessSync } from "./accessSync.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";

export const LIST_SCOPE_MAX_SKEW_MS = 10 * 60_000;
export const PRO_REQUIRED_ERROR = "A separate list on each server comes with Pro.";

const J = { "content-type": "application/json" } as const;
const SCOPE_RE = /^\/api\/screens\/services\/([^/]+)\/list-scope$/;
const SUMMARY_PATH = "/api/screens/access-lists/summary";

export function isListScopePath(path: string): boolean {
  return SCOPE_RE.test(path) || path === SUMMARY_PATH;
}

export interface ListScopeHttpOptions {
  selfFqdn: string;
  scopes: AccessScopes;
  plan: Pick<PlanCheck, "state" | "refreshSoon">;
  sync: () => AccessSync | null;
  peers: () => (AccessPeers & { inOrder?(serviceRef: string): string[] }) | null;
  installed: (serviceRef: string) => boolean;
  now?: () => number;
}

export function buildListScopeHttp(opts: ListScopeHttpOptions) {
  const now = opts.now ?? (() => Date.now());
  const self = opts.selfFqdn.toLowerCase();

  function state(ref: string) {
    const p = opts.peers();
    const leader = p?.leaderFor(ref)?.toLowerCase() ?? self;
    const servers = p?.inOrder?.(ref) ?? [self, ...(p?.runners(ref) ?? []).map((x) => x.toLowerCase()).filter((x) => x !== self)];
    const rec = opts.scopes.record(ref);
    return {
      serviceRef: ref,
      scope: opts.scopes.scope(ref),
      pending: !!rec && rec.order.scope === "server" && !rec.honoured && rec.endedAt === undefined,
      plan: opts.plan.state(),
      self,
      leader,
      servers,
    };
  }

  return async function handle(path: string, method: string, req: HttpRequest): Promise<HttpResponse | null> {
    if (path === SUMMARY_PATH && method === "GET") {
      if (opts.plan.state() !== "pro") await opts.plan.refreshSoon(60_000).catch(() => null);
      const apps = (await opts.sync()?.separateAcross().catch(() => null)) ?? [];
      return json(200, {
        plan: opts.plan.state(),
        separateApps: apps.length,
        leaders: [...new Set(apps.map((a) => a.leader))],
      });
    }
    const m = SCOPE_RE.exec(path);
    if (!m) return null;
    const ref = decodeURIComponent(m[1]!);
    if (!opts.installed(ref)) return json(404, { error: "the app isn't on this server" });
    if (method === "GET") {
      if (opts.plan.state() !== "pro") await opts.plan.refreshSoon(60_000).catch(() => null);
      return json(200, state(ref));
    }
    if (method !== "POST") return null;
    let body: { order?: unknown; signature?: unknown };
    try {
      body = JSON.parse(req.body.toString("utf8"));
    } catch {
      return json(400, { error: "invalid json" });
    }
    const order = parseAppListScopeOrder(body.order);
    if (!order || typeof body.signature !== "string") return json(400, { error: "malformed list-scope order" });
    if (order.serviceRef !== ref) return json(400, { error: "the order names another app" });
    if (Math.abs(now() - order.issuedAt) > LIST_SCOPE_MAX_SKEW_MS) return json(403, { error: "stale request" });
    if (order.scope === "server" && opts.plan.state() !== "pro") await opts.plan.refreshSoon(0).catch(() => null);
    const r = await opts.scopes.adopt(order, body.signature, { direct: true });
    if (r === "refused") return json(403, { error: "only an admin device can change this" });
    if (r === "stale") return json(409, { error: "a newer change was already made: sign it again" });
    if (r === "needs-pro") return json(402, { error: PRO_REQUIRED_ERROR, code: "pro-required" });
    return json(200, { ok: true, ...state(ref) });
  };
}

function json(status: number, body: unknown): HttpResponse {
  return { status, headers: J, body: JSON.stringify(body) };
}
