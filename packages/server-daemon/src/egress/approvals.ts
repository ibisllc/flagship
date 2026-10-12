/**
 * The screens API for live apps' internet access (docs/ai-privacy-and-staging.md §3a).
 *
 *   GET  /api/screens/services/:id/access          → { list, listSha256, pending }
 *   POST /api/screens/services/:id/access            { list, grant, signature }
 *        grant = { serverDomain, serviceId, listSha256, issuedAt } (`flagship/app-access/v1`)
 *        → 200 { ok, access } | 400 { error, errors:[{line, message}] } | 403 | 404 | 409
 *   POST /api/screens/services/:id/access/dismiss    { host }  (no signature: changes nothing the app reaches)
 *   GET  /api/screens/access-requests              → { requests:[{serviceId, appName, host, ...}] }
 *
 * v1, for older apps (`flagship/app-egress/v1`; the hosts become `allow` lines):
 *   GET  /api/screens/services/:id/egress          → { declared, approved }
 *   POST /api/screens/services/:id/egress            { grant, signature }; hosts [] revokes
 *
 * Every change to what an app may reach is authorized by an owner signature
 * under the box's sensitive-order authority; the paired session only carries it.
 */
import {
  accessListFromEgressHosts,
  accessListSha256,
  normalizeAccessList,
  parseAccessList,
  parseAppAccessGrant,
  parseAppEgressGrant,
  sortEgressHosts,
  verifyAppAccessGrant,
  verifyAppEgressGrant,
  type AccessListError,
  type AdminGrantView,
  type AppAccessGrant,
  type AppEgressGrant,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "../adminAuthorityLocal.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import { coveringRule, hexToBytes, type AccessAuthorizer, type AccessRequest, type AppAccessStore } from "./accessStore.js";

export interface EgressView {
  declared: string[];
  approved: string[];
}

export interface AccessView {
  list: string;
  listSha256: string;
  pending: AccessRequest[];
}

export interface AccessSummary {
  rules: number;
  pending: number;
}

export interface AccessRequestEntry extends AccessRequest {
  serviceId: string;
  appName: string;
}

export interface SensitiveAuthority {
  username: string;
  ownerIrkPub: Uint8Array;
  adminRootPub?: Uint8Array;
  activeGrants?: readonly AdminGrantView[];
}

export interface AppAccessHttpOptions extends SensitiveAuthority {
  /** The box FQDN every grant must name. */
  serverDomain: string;
  store: AppAccessStore;
  /** An installed service's name and declared `network.egress` hosts; null when not installed. */
  app: (serviceId: string) => { name: string; declared: string[] } | null;
  /** Called after a list is applied, so the gateway closes what it no longer allows. */
  onChange?: (serviceId: string) => void;
  now?: () => number;
  /** How far `issuedAt` may be from the box clock. Default 10 min. */
  maxSkewMs?: number;
}

const J = { "content-type": "application/json" } as const;
const ACCESS_RE = /^\/api\/screens\/services\/([^/]+)\/access$/;
const DISMISS_RE = /^\/api\/screens\/services\/([^/]+)\/access\/dismiss$/;
const EGRESS_RE = /^\/api\/screens\/services\/([^/]+)\/egress$/;
export const ACCESS_REQUESTS_PATH = "/api/screens/access-requests";

export function isAppAccessPath(path: string): boolean {
  return path === ACCESS_REQUESTS_PATH || ACCESS_RE.test(path) || DISMISS_RE.test(path) || EGRESS_RE.test(path);
}

/** Both kinds of owner signature, checked under the box's sensitive-order authority. */
export function accessAuthorizer(a: SensitiveAuthority): AccessAuthorizer {
  const base = {
    ownerIrkPub: a.ownerIrkPub,
    ...(a.adminRootPub ? { adminRootPub: a.adminRootPub } : {}),
    username: a.username,
    ...(a.activeGrants ? { activeGrants: a.activeGrants } : {}),
  };
  return {
    v2: (grant: AppAccessGrant, signature: Uint8Array) =>
      authorizeSensitiveOrder({ ...base, order: grant, signature, verify: verifyAppAccessGrant }),
    v1: (grant: AppEgressGrant, signature: Uint8Array) =>
      authorizeSensitiveOrder({ ...base, order: grant, signature, verify: verifyAppEgressGrant }),
  };
}

export function accessView(store: AppAccessStore, serviceId: string): AccessView {
  const list = store.list(serviceId);
  return { list, listSha256: accessListSha256(list), pending: store.pending(serviceId) };
}

export function accessSummary(store: AppAccessStore, serviceId: string): AccessSummary {
  return { rules: store.rules(serviceId).length, pending: store.pending(serviceId).length };
}

/** The v1 view: the declared entries the list opens as a whole. */
export function egressView(store: AppAccessStore, serviceId: string, declared: readonly string[]): EgressView {
  const rules = store.rules(serviceId);
  return { declared: [...declared], approved: declared.filter((d) => coveringRule(rules, d)?.action === "allow") };
}

export function accessRequests(store: AppAccessStore, app: AppAccessHttpOptions["app"]): AccessRequestEntry[] {
  const out: AccessRequestEntry[] = [];
  for (const serviceId of store.pendingServiceIds()) {
    const a = app(serviceId);
    if (!a) continue;
    for (const r of store.pending(serviceId)) out.push({ serviceId, appName: a.name, ...r });
  }
  return out.sort((x, y) => y.lastSeen - x.lastSeen);
}

/**
 * The screens-API handler. Runs behind the paired-session gate and the
 * companion write guard (screensHttp).
 */
export function buildAppAccessHttp(opts: AppAccessHttpOptions) {
  const now = opts.now ?? (() => Date.now());
  const maxSkew = opts.maxSkewMs ?? 10 * 60_000;
  const auth = accessAuthorizer(opts);
  const json = (status: number, body: unknown): HttpResponse => ({ status, headers: J, body: JSON.stringify(body) });
  const err = (status: number, error: string): HttpResponse => json(status, { error });
  const bad = (error: string, errors: AccessListError[] = []): HttpResponse => json(400, { error, errors });

  async function postAccess(serviceId: string, req: HttpRequest): Promise<HttpResponse> {
    let body: { list?: unknown; grant?: unknown; signature?: unknown };
    try {
      body = JSON.parse(req.body.toString("utf8")) as typeof body;
    } catch {
      return bad("invalid json");
    }
    if (typeof body?.list !== "string") return bad("list required");
    const grant = parseAppAccessGrant(body.grant);
    if (!grant) return bad("malformed grant");
    if (typeof body.signature !== "string") return bad("signature required");
    const sig = hexToBytes(body.signature);
    if (!sig || sig.length !== 64) return bad("invalid signature hex");
    if (grant.serviceId !== serviceId) return bad("grant is for a different service");
    const list = body.list;
    if (normalizeAccessList(list) !== list) {
      return bad("send the list normalized (\\n line ends, no trailing spaces or blank lines, one final \\n)");
    }
    const parsed = parseAccessList(list);
    if (parsed.errors.length > 0) {
      return bad(`the access list has ${parsed.errors.length} error${parsed.errors.length === 1 ? "" : "s"}`, parsed.errors);
    }
    if (accessListSha256(list) !== grant.listSha256) return err(403, "the list is not the one that was signed");
    if (grant.serverDomain !== opts.serverDomain) return err(403, "grant is for a different server");
    if (Math.abs(now() - grant.issuedAt) > maxSkew) return err(403, "stale grant");
    if (!auth.v2(grant, sig)) return err(403, "invalid signature");
    const held = opts.store.heldIssuedAt(serviceId);
    if (held !== null && grant.issuedAt <= held) return err(409, "a newer access list is already applied");
    await opts.store.putSigned(serviceId, list, { v: 2, grant, signature: body.signature.toLowerCase() });
    opts.onChange?.(serviceId);
    return json(200, { ok: true, access: accessView(opts.store, serviceId) });
  }

  async function postEgress(serviceId: string, declared: readonly string[], req: HttpRequest): Promise<HttpResponse> {
    let body: { grant?: unknown; signature?: unknown };
    try {
      body = JSON.parse(req.body.toString("utf8")) as typeof body;
    } catch {
      return err(400, "invalid json");
    }
    const grant = parseAppEgressGrant(body?.grant);
    if (!grant) return err(400, "malformed grant");
    if (typeof body.signature !== "string") return err(400, "signature required");
    const sig = hexToBytes(body.signature);
    if (!sig || sig.length !== 64) return err(400, "invalid signature hex");
    if (grant.serviceId !== serviceId) return err(400, "grant is for a different service");
    if (grant.serverDomain !== opts.serverDomain) return err(403, "grant is for a different server");
    if (Math.abs(now() - grant.issuedAt) > maxSkew) return err(403, "stale grant");
    if (!auth.v1(grant, sig)) return err(403, "invalid signature");
    const held = opts.store.heldIssuedAt(serviceId);
    if (held !== null && grant.issuedAt <= held) return err(409, "a newer grant is already applied");
    const undeclared = grant.hosts.filter((h) => !declared.includes(h));
    if (undeclared.length > 0) {
      return err(422, `not declared in the app's network.egress: ${undeclared.join(", ")}`);
    }
    const g = { ...grant, hosts: sortEgressHosts(grant.hosts) };
    await opts.store.putSigned(serviceId, accessListFromEgressHosts(g.hosts), {
      v: 1,
      grant: g,
      signature: body.signature.toLowerCase(),
    });
    opts.onChange?.(serviceId);
    return json(200, { ok: true, egress: egressView(opts.store, serviceId, declared) });
  }

  return async function handle(path: string, method: string, req: HttpRequest): Promise<HttpResponse | null> {
    if (path === ACCESS_REQUESTS_PATH) {
      if (method !== "GET") return err(405, "method not allowed");
      return json(200, { requests: accessRequests(opts.store, opts.app) });
    }
    const m = ACCESS_RE.exec(path) ?? DISMISS_RE.exec(path) ?? EGRESS_RE.exec(path);
    if (!m) return null;
    let serviceId: string;
    try {
      serviceId = decodeURIComponent(m[1]!);
    } catch {
      return err(400, "bad service id");
    }
    const app = opts.app(serviceId);
    if (!app) return err(404, "no such service");

    if (ACCESS_RE.test(path)) {
      if (method === "GET") return json(200, accessView(opts.store, serviceId));
      if (method === "POST") return postAccess(serviceId, req);
      return err(405, "method not allowed");
    }
    if (DISMISS_RE.test(path)) {
      if (method !== "POST") return err(405, "method not allowed");
      let body: { host?: unknown };
      try {
        body = JSON.parse(req.body.toString("utf8")) as typeof body;
      } catch {
        return bad("invalid json");
      }
      if (typeof body?.host !== "string" || !(await opts.store.dismiss(serviceId, body.host))) return bad("host required");
      return json(200, { ok: true, access: accessView(opts.store, serviceId) });
    }
    if (method === "GET") return json(200, egressView(opts.store, serviceId, app.declared));
    if (method === "POST") return postEgress(serviceId, app.declared, req);
    return err(405, "method not allowed");
  };
}
