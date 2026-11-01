/**
 * `.com`'s half of the phone's bare-name route (plan H3, docs/architecture-v2/phone-route.md):
 *
 *   GET  /api/internal/phone-route/:u/eligibility   (services control secret) the admin root and active device
 *        grants of the account; the relay re-verifies them with `requireMasterAdmin`
 *   GET  /api/internal/phone-route/ledger?hostname=  (services control secret) the ledger entry
 *   POST /api/internal/phone-route/ledger            (services control secret) acquire | renew | release
 *
 * The ledger lives in the ServingFeed Durable Object (one instance, already connected to every relay), so a
 * committed acquisition is pushed to every relay at once as `{type:"phone-route", hostname, generation}`. Removing a
 * device or revoking a grant pushes `{type:"phone-eligibility", username}`.
 */
import {
  emptyPhoneRouteEntry,
  ledgerAcquire,
  ledgerRelease,
  ledgerRenew,
  liveEntry,
  type LedgerResult,
  type PhoneRouteEntry,
  type PhoneRouteHolder,
} from "@flagship/protocol";
import type { DeviceCapabilityGrantStorage, DeviceIdentityStorage, UsernameStorage } from "@flagship/storage";
import { SERVING_FEED_NAME, type ServingEnv } from "./servingAuthority.js";

export const PHONE_ROUTE_PREFIX = "/api/internal/phone-route/";
export const PHONE_ROUTE_LEDGER_PATH = "/api/internal/phone-route/ledger";
const ELIGIBILITY = /^\/api\/internal\/phone-route\/([^/]+)\/eligibility$/;
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MAX_BODY = 4096;

export interface PhoneRouteDeps {
  usernames: UsernameStorage;
  grants: DeviceCapabilityGrantStorage;
  identities?: DeviceIdentityStorage;
  now?: () => number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function refuse(status: number, code: string): Response {
  return json({ error: code, code }, status);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function internalRefusal(request: Request, env: ServingEnv): Response | null {
  if (!env.SERVICES_CONTROL_SECRET) return refuse(503, "phone-route-not-configured");
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization")?.trim() ?? "");
  if (!m || !constantTimeEqual(m[1]!.trim(), env.SERVICES_CONTROL_SECRET)) return refuse(401, "unauthorized");
  return null;
}

export function isPhoneRoutePath(path: string): boolean {
  return path === PHONE_ROUTE_LEDGER_PATH || ELIGIBILITY.test(path);
}

export async function tryPhoneRouteRoute(request: Request, env: ServingEnv, deps: PhoneRouteDeps): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!isPhoneRoutePath(path)) return null;
  const denied = internalRefusal(request, env);
  if (denied) return denied;
  const method = request.method.toUpperCase();

  const m = path.match(ELIGIBILITY);
  if (m && method === "GET") {
    let u: string;
    try {
      u = decodeURIComponent(m[1]!).toLowerCase();
    } catch {
      return refuse(400, "phone-route-malformed");
    }
    const user = await deps.usernames.get(u);
    if (!user) return refuse(404, "account-not-found");
    const now = (deps.now ?? Date.now)();
    const rows = (await deps.grants.listForUser(u)).filter((g) => g.revokedAt == null && g.expiresAt > now);
    const grants: Array<Record<string, unknown>> = [];
    for (const g of rows) {
      const identity = deps.identities ? await deps.identities.get(u, g.deviceId) : undefined;
      if (identity && (identity.revokedAt != null || identity.devicePubHex.toLowerCase() !== g.devicePubHex.toLowerCase())) continue;
      let scopes: unknown;
      try {
        scopes = JSON.parse(g.scopesJson);
      } catch {
        continue;
      }
      grants.push({
        grantId: g.grantId,
        username: g.username,
        deviceId: g.deviceId,
        devicePubHex: g.devicePubHex.toLowerCase(),
        scopes,
        issuedAt: g.issuedAt,
        expiresAt: g.expiresAt,
        signatureHex: g.signatureHex.toLowerCase(),
        signerRoot: g.signerRoot ?? "membership",
      });
    }
    return json({ adminRootPub: user.adminRootPubHex?.toLowerCase() ?? null, grants });
  }

  if (path === PHONE_ROUTE_LEDGER_PATH && (method === "GET" || method === "POST")) {
    const ns = env.SERVING_FEED;
    if (!ns) return refuse(503, "phone-route-not-configured");
    const stub = ns.get(ns.idFromName(SERVING_FEED_NAME));
    const target = `https://serving-feed/phone-route${url.search}`;
    if (method === "GET") return stub.fetch(new Request(target, { method: "GET" }));
    const body = await request.text();
    if (body.length > MAX_BODY) return refuse(413, "phone-route-malformed");
    return stub.fetch(new Request(target, { method: "POST", body }));
  }
  return null;
}

// ── the ledger, inside the ServingFeed Durable Object ──────────────────────

export interface LedgerStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

const keyOf = (hostname: string) => `phone-route:${hostname}`;

function parseHolder(v: unknown): PhoneRouteHolder | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  return typeof o.relayId === "string" && typeof o.sessionId === "string" && typeof o.phoneRoutePub === "string"
    ? { relayId: o.relayId, sessionId: o.sessionId, phoneRoutePub: o.phoneRoutePub }
    : null;
}

/**
 * The ledger's one entry point (the DO serialises calls: storage reads and writes hold its input gate, so a
 * compare-and-set here cannot interleave with another). Returns the answer and, for a committed acquisition, the frame
 * every relay must get.
 */
export async function handlePhoneRouteLedger(
  storage: LedgerStorage,
  request: Request,
  now: number,
): Promise<{ response: Response; push?: { type: "phone-route"; hostname: string; generation: number } }> {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const hostname = (url.searchParams.get("hostname") ?? "").toLowerCase();
    if (!HOSTNAME.test(hostname)) return { response: refuse(400, "phone-route-malformed") };
    const e = (await storage.get<PhoneRouteEntry>(keyOf(hostname))) ?? emptyPhoneRouteEntry();
    return { response: json({ entry: liveEntry(e, now) }) };
  }
  let body: Record<string, unknown>;
  try {
    const v = (await request.json()) as unknown;
    if (typeof v !== "object" || v === null) throw new Error("not an object");
    body = v as Record<string, unknown>;
  } catch {
    return { response: refuse(400, "phone-route-malformed") };
  }
  const hostname = typeof body.hostname === "string" ? body.hostname.toLowerCase() : "";
  const generation = body.generation;
  if (!HOSTNAME.test(hostname) || typeof generation !== "number") return { response: refuse(400, "phone-route-malformed") };
  const e = (await storage.get<PhoneRouteEntry>(keyOf(hostname))) ?? emptyPhoneRouteEntry();
  let r: LedgerResult;
  if (body.op === "acquire") {
    const holder = parseHolder(body.holder);
    if (!holder) return { response: refuse(400, "phone-route-malformed") };
    r = ledgerAcquire(e, generation, holder, now);
  } else if (body.op === "renew" && typeof body.sessionId === "string") {
    r = ledgerRenew(e, generation, body.sessionId, now);
  } else if (body.op === "release" && typeof body.sessionId === "string") {
    r = ledgerRelease(e, generation, body.sessionId);
  } else {
    return { response: refuse(400, "phone-route-malformed") };
  }
  if (r.ok) await storage.put(keyOf(hostname), r.entry);
  const response = r.ok ? json({ ok: true, entry: r.entry, superseded: r.superseded }) : json({ ok: false, code: r.code, entry: liveEntry(r.entry, now) });
  return r.ok && body.op === "acquire" ? { response, push: { type: "phone-route", hostname, generation } } : { response };
}

/** The account whose admin phones may have lost eligibility after this write (device removal, grant revocation). */
export function phoneEligibilityAccount(method: string, path: string): string | null {
  if (method === "GET" || method === "HEAD") return null;
  const m = /^\/api\/accounts\/([^/]+)\/devices\/[^/]+$/.exec(path) ?? /^\/api\/users\/([^/]+)\/device-grants\/revoke$/.exec(path);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!).toLowerCase();
  } catch {
    return null;
  }
}
