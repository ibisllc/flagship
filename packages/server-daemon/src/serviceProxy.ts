/**
 * Per-app reverse proxy. The daemon's TLS server already terminates
 * inbound HTTPS; this module is what fires after termination when the
 * SNI maps to an installed app:
 *
 *   1. Decide if the request can reach the container at all: an owner's
 *      `fsk_` API key or a member ⇒ any path; an anonymous visitor ⇒ any path
 *      on an "open to all" app, only `access.public_routes` on a members-only
 *      one (else the knock page). WebSocket upgrades are decided the same.
 *   2. Strip any `X-Flagship-*` headers the client supplied (they have
 *      no business arriving uninjected).
 *   3. Inject signed identity headers the app trusts (docs/app-apis.md §5):
 *        X-Flagship-Visitor    : "member" | "api" | "anonymous", always
 *        X-Flagship-User       : member id or apikey:<keyId>; absent when anonymous
 *        X-Flagship-Role       : rank or "api"; absent when anonymous
 *        X-Flagship-Signature  : Ed25519 over the canonical-bytes of
 *                                {serviceId, user, role, timestamp}, with
 *                                user = role = "anonymous" for an anonymous visitor
 *   4. Forward the request to `127.0.0.1:<containerPort>` and stream the
 *      response back (`appConnection.ts`; `handleAppRequest` buffers).
 *
 * The container has no network path that bypasses this proxy (the
 * daemon runs the TLS server, the container is on a docker network
 * with no external bridge, and AppRunner publishes only to the
 * daemon's localhost port). So whatever the proxy decides, the app
 * sees only the result. The app cannot weaken or bypass the gate.
 *
 * Who a browser visitor is comes from `resolveSession`: on a live box the
 * `Flagship-App-Session` cookie the owner's or an invited person's phone
 * approved for THIS app (`appMemberSession.ts`). No resolver ⇒ anonymous.
 */

import { request as httpRequest } from "node:http";
import type { Bytes } from "@flagship/protocol";
import type { BoxSigner } from "./keyCustodian.js";
import type { InstalledService } from "./servicePlatform.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";
import type { UpdateServer } from "./updateServer.js";
import type { ApiKeyAuthenticator } from "./appApiKeys.js";

export interface SessionInfo {
  /** The member's identity key: the stable account id (AID) their session is bound to. */
  memberPub: Bytes;
  /** The app-stable id derived for this member-app pair (`AppMembership.stableIdFor`). */
  stableId: string;
  /** The member's rank in this app: member, manager or master (there is no owner rank). */
  role: string;
}

/**
 * Resolve a request to a member of `app`, or null for anonymous. A resolver
 * returns a session only for someone who may use this app right now: the
 * proxy treats any session as a member.
 */
export type SessionResolver = (req: HttpRequest, app: InstalledService) => SessionInfo | null;

export interface AppProxyDeps {
  /**
   * Narrow box-identity signer (the KeyCustodian's `BoxSigner` slice). Apps
   * verify `X-Flagship-Signature` against the public half, fetched from
   * `GET /.flagship/runtime-pubkey`. This is deliberately NOT the raw
   * `Keypair`: the internet-facing proxy closure must never hold the box's
   * private seed — it holds only "sign this / here's the pubkey".
   */
  injector: BoxSigner;
  /** Resolves a request to a paired-session member, or null for anonymous. */
  resolveSession?: SessionResolver;
  /**
   * The app's access mode as the owner set it (`ServiceAccessStore`). Absent,
   * or null because it can't be determined, ⇒ members-only (fail closed).
   */
  accessMode?: (serviceId: string) => AppAccessMode | null;
  /** Override fetch implementation for tests. */
  forward?: (host: string, port: number, req: HttpRequest) => Promise<HttpResponse>;
  now?: () => number;
  /**
   * App update-pack distribution server. When set, requests for
   * `/.flagship/update` are routed here before the container is
   * consulted. Apps cannot ship their own /update.
   */
  updateServer?: UpdateServer;
  /** The owner's API keys for apps (`appApiKeys.ts`); absent ⇒ no `fsk_` key is accepted. */
  apiKeys?: ApiKeyAuthenticator | null;
  /**
   * What a denied browser navigation gets instead of the "is private" page:
   * the knock page, where the owner or an invited person signs in with their
   * phone. Null (an API call, an asset) ⇒ the "is private" page.
   */
  deniedPage?: (serviceRef: string, req: HttpRequest) => HttpResponse | null;
}

const STRIP_PREFIX = "x-flagship-";
const ANONYMOUS = "anonymous";

/**
 * Who a forwarded request is, in `X-Flagship-Visitor`: a signed-in `member`
 * (the owner included), an owner's API key (`api`), or `anonymous` (no id,
 * no rank: the app decides what such a visitor may do).
 */
export type VisitorKind = "member" | "api" | "anonymous";

/**
 * Who may reach an app without signing in (docs/service-access-gating.md):
 * `open` ("Open to all") forwards every anonymous request and the app decides;
 * `members-only` forwards anonymous visitors only on `access.public_routes`.
 */
export type AppAccessMode = "open" | "members-only";

const REQUEST_ACCESS_TEMPLATE = (appName: string, urlLabel: string): string =>
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Request access · Flagship</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0a0a0a; color: #eee; padding: 4rem 2rem; max-width: 560px; margin: 0 auto; line-height: 1.55; }
      h1 { color: #6ee7a8; margin-bottom: 0.5rem; }
      p { color: #aaa; }
      code { background: #1a1a1a; color: #fbcc4a; padding: 0.1rem 0.4rem; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(appName)} is private</h1>
    <p>This Flagship app is gated. Ask the host to invite you, then accept the invite in your Flagship app.</p>
    <p style="color:#666; font-size:0.85rem; margin-top: 2rem;">URL: <code>${escapeHtml(urlLabel)}</code></p>
  </body>
</html>
`;

/** What the proxy does with a request once it has looked at it. */
export type PreparedAppRequest =
  /** Answer it here (denied, a box endpoint, a bad API key…); the container never sees it. */
  | { kind: "respond"; response: HttpResponse }
  /** Forward it to the container with these headers (identity injected). */
  | { kind: "forward"; headers: Record<string, string> };

/**
 * Decide whether a request may reach the container and, when it may, the
 * headers it goes with. Used for plain requests and WebSocket upgrades alike
 * (docs/app-apis.md §1): the decision and the injected identity are the same.
 *
 *   1. An `Authorization: Bearer fsk_…` API key is checked first (§3): wrong,
 *      revoked or expired ⇒ 401, a read key on a write method ⇒ 403, over the
 *      key's rate ⇒ 429. A valid key reaches every path as `apikey:<keyId>`.
 *   2. Otherwise the member session, unless the request is an unsafe method
 *      or an upgrade from another origin (§4): that one is anonymous for
 *      Flagship identity (the app's own auth is untouched).
 *   3. An anonymous visitor reaches every path of an "open to all" app, and
 *      only the public routes (exact or `/*` prefix, §2) of a members-only one.
 */
export async function prepareAppRequest(
  app: InstalledService,
  req: HttpRequest,
  deps: AppProxyDeps,
  opts: { upgrade?: boolean } = {},
): Promise<PreparedAppRequest> {
  const apiAuth = deps.apiKeys ? deps.apiKeys.authenticate(app.serviceId, req.method, req.headers) : { kind: "none" as const };
  if (apiAuth.kind === "invalid") {
    return respond(401, { error: "invalid API key (wrong, revoked or expired)" }, { "www-authenticate": 'Bearer realm="flagship"' });
  }
  if (apiAuth.kind === "rate-limited") {
    return respond(429, { error: "too many requests for this API key" }, { "retry-after": String(apiAuth.retryAfterSec) });
  }
  if (apiAuth.kind === "scope") {
    return respond(403, { error: "this API key is read-only: it allows GET, HEAD and OPTIONS" });
  }
  const apiKey = apiAuth.kind === "ok" ? { keyId: apiAuth.keyId, scope: apiAuth.scope } : null;

  let session = !apiKey && deps.resolveSession ? deps.resolveSession(req, app) : null;
  if (session && isCrossOriginUnsafe(req, opts.upgrade === true)) session = null;

  const mode = deps.accessMode?.(app.serviceId) ?? null;
  if (decideAccess(app, req, session, apiKey, mode) === "deny") {
    const page = opts.upgrade ? null : deps.deniedPage?.(app.serviceId, req);
    if (page) return { kind: "respond", response: page };
    return {
      kind: "respond",
      response: {
        status: 403,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: REQUEST_ACCESS_TEMPLATE(app.manifest.name, app.urlLabel),
      },
    };
  }

  const pathOnly = stripQuery(req.path);
  // Internal endpoint apps can hit to verify the daemon's injector key.
  if (pathOnly === "/.flagship/runtime-pubkey") {
    return {
      kind: "respond",
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          injectorPubKeyHex: bytesToHex(deps.injector.boxPublicKey()),
        }),
      },
    };
  }

  // App-update distribution. The proxy intercepts /.flagship/update
  // before the container, so apps can't ship their own /update that
  // would lie about lineage. The server enforces signature, subscriber
  // list, and lineage-coherence cache keying.
  if (pathOnly === "/.flagship/update" && deps.updateServer && !opts.upgrade) {
    const r = await deps.updateServer.handle(app, req);
    if (r) return { kind: "respond", response: r };
  }

  // (No AI-specific proxy path: a deployed app that wants an LLM reads
  // its provider key from its own env like any other var — env values
  // are injected into the container at deploy time by ServicePlatform.)

  // Strip incoming X-Flagship-* (and the API key, which is the box's to
  // check, never the app's to see) and inject signed identity headers.
  const forwardHeaders = stripIdentityHeaders(req.headers);
  if (apiKey) delete forwardHeaders["authorization"];
  const ts = String((deps.now ?? Date.now)());
  const visitor: VisitorKind = apiKey ? "api" : session ? "member" : "anonymous";
  // An anonymous visitor has no id and no rank: the signature's user and role
  // slots carry the literal `anonymous` (no member id is ever that string),
  // and neither header is sent (docs/app-apis.md §5).
  const user = apiKey ? `apikey:${apiKey.keyId}` : session ? session.stableId : ANONYMOUS;
  const role = apiKey ? "api" : session ? session.role : ANONYMOUS;
  const fields = [`flagship/inject/v1`, app.serviceId, user, role, ts];
  // An API-key request's scope is signed too, as a sixth field.
  if (apiKey) fields.push(apiKey.scope);
  const sig = deps.injector.signAsBox(new TextEncoder().encode(fields.join("|")));
  forwardHeaders["x-flagship-app-id"] = app.serviceId;
  forwardHeaders["x-flagship-visitor"] = visitor;
  if (visitor !== "anonymous") {
    forwardHeaders["x-flagship-user"] = user;
    forwardHeaders["x-flagship-role"] = role;
  }
  if (apiKey) forwardHeaders["x-flagship-api-scope"] = apiKey.scope;
  forwardHeaders["x-flagship-timestamp"] = ts;
  forwardHeaders["x-flagship-signature"] = bytesToHex(sig);
  return { kind: "forward", headers: forwardHeaders };
}

/**
 * Decide, then (when allowed) forward with a buffered response. The live
 * daemon streams instead (`appConnection.ts`); this stays for callers that
 * want one `HttpResponse`.
 */
export async function handleAppRequest(
  app: InstalledService,
  req: HttpRequest,
  deps: AppProxyDeps,
): Promise<HttpResponse> {
  const p = await prepareAppRequest(app, req, deps);
  if (p.kind === "respond") return p.response;
  const forward = deps.forward ?? defaultForward;
  return forward("127.0.0.1", app.containerPort, { ...req, headers: p.headers });
}

function respond(status: number, body: unknown, headers: Record<string, string> = {}): PreparedAppRequest {
  return {
    kind: "respond",
    response: { status, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) },
  };
}

/**
 * Pure access-decision function. Returns `"allow"` if the request can
 * reach the container; `"deny"` otherwise. Tested independently of
 * the network plumbing. `mode` null (unknown) is members-only.
 */
export function decideAccess(
  app: InstalledService,
  req: HttpRequest,
  session: SessionInfo | null,
  apiKey: { keyId: string } | null = null,
  mode: AppAccessMode | null = null,
): "allow" | "deny" {
  // 1. A valid API key (checked by the caller) reaches every path: the owner
  //    issued it for this app.
  if (apiKey) return "allow";

  // 2. A member session reaches any path (the resolver returns one only for
  //    someone this app lets in).
  if (session) return "allow";

  // 3. Anonymous: every path of an open app (the app decides what such a
  //    visitor may do); on a members-only app, only its declared public routes.
  if (mode === "open") return "allow";
  return matchesPublicRoute(req.path, app.manifest.access.public_routes ?? []) ? "allow" : "deny";
}

/**
 * Whether a request path (query ignored) is public under `access.public_routes`
 * (docs/app-apis.md §2). Both sides are normalised first (`normalizePublicPath`):
 * percent-decoded once, `//` collapsed, a trailing `/` dropped. An entry is an
 * exact path (`/webhook` covers `/webhook` and `/webhook/`), or a prefix ending
 * in `/*`: `/api/public/*` covers `/api/public` and everything under it, never
 * `/api/publicity`; `/*` covers the whole app. Matching is case-sensitive. A
 * path that doesn't normalise (a dot segment, an encoded slash, backslash or
 * percent, a control character) matches nothing, `/*` included.
 */
export function matchesPublicRoute(rawPath: string, publicRoutes: readonly string[]): boolean {
  const path = normalizePublicPath(stripQuery(rawPath));
  if (path === null) return false;
  for (const r of publicRoutes) {
    if (r.endsWith("/*")) {
      const prefix = normalizePublicPath(r.slice(0, -2) || "/");
      if (prefix === null) continue;
      if (prefix === "/" || path === prefix || path.startsWith(`${prefix}/`)) return true;
    } else if (normalizePublicPath(r) === path) {
      return true;
    }
  }
  return false;
}

/**
 * The form a path is compared in for `public_routes`, or null when it can't
 * be compared safely. Decoded once; `//` collapsed; a trailing `/` dropped
 * (`/` stays). Refused, so never public: a dot segment (`.` or `..`, also
 * percent-encoded or as `..;x`), which the app might resolve outside the
 * route or not resolve at all (browsers never send one); an encoded `/`, `\`
 * or `%`, which the app might decode again into something else; a backslash,
 * a control character, or a malformed escape.
 */
export function normalizePublicPath(path: string): string | null {
  if (!path.startsWith("/")) return null;
  if (path.includes("\\")) return null;
  if (/%(2f|5c|25)/i.test(path)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (/[\u0000-\u001f\u007f\\]/.test(decoded)) return null;
  const out: string[] = [];
  for (const seg of decoded.split("/")) {
    const bare = seg.split(";")[0]!;
    if (bare === "." || bare === "..") return null;
    if (seg !== "") out.push(seg);
  }
  return `/${out.join("/")}`;
}

function stripQuery(path: string): string {
  const q = path.search(/[?#]/);
  return q === -1 ? path : path.slice(0, q);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The sibling-app guard (docs/app-apis.md §4). Apps on one server share a
 * *site*, so app B's page can make the browser send a form or a fetch to app
 * A with the owner's session attached. An unsafe method, or a WebSocket
 * upgrade, whose `Origin` (else `Sec-Fetch-Site`, else `Referer`) shows
 * another origin is treated as anonymous for Flagship identity. No header at
 * all (curl, scripts, old browsers) counts as same-origin.
 */
export function isCrossOriginUnsafe(req: HttpRequest, upgrade: boolean): boolean {
  if (!upgrade && SAFE_METHODS.has(req.method.toUpperCase())) return false;
  const own = ownOrigin(req.headers.host);
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    return own === null || normalizeOrigin(origin) !== own;
  }
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site.length > 0) {
    const v = site.trim().toLowerCase();
    return v !== "same-origin" && v !== "none";
  }
  const referer = req.headers.referer;
  if (typeof referer === "string" && referer.length > 0) {
    return own === null || normalizeOrigin(referer) !== own;
  }
  return false;
}

function ownOrigin(host: string | undefined): string | null {
  if (!host) return null;
  return normalizeOrigin(`https://${host.trim()}`);
}

function normalizeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Drop any inbound header whose name starts with `x-flagship-`, also when
 * spelled with underscores (`x_flagship_role`): CGI/WSGI-style servers fold
 * `_` and `-` into one name, so that spelling would reach a Python app as the
 * real header.
 */
export function stripIdentityHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!k.toLowerCase().replace(/_/g, "-").startsWith(STRIP_PREFIX)) out[k] = v;
  }
  return out;
}

export async function defaultForward(host: string, port: number, req: HttpRequest): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    const proxyReq = httpRequest(
      {
        host,
        port,
        method: req.method,
        path: req.path,
        headers: req.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") headers[k] = v;
            else if (Array.isArray(v)) headers[k] = v.join(", ");
          }
          // Strip hop-by-hop response headers (we'll write our own
          // content-length — the container's copy must go too, or every
          // proxied response carries a duplicate Content-Length and
          // spec-compliant fetch clients reject it, RFC 9112 §6.3).
          delete headers["transfer-encoding"];
          delete headers["connection"];
          delete headers["content-length"];
          resolve({ status: res.statusCode ?? 502, headers, body });
        });
        res.on("error", reject);
      },
    );
    proxyReq.on("error", (e) =>
      resolve({
        status: 502,
        headers: { "content-type": "text/plain" },
        body: `bad gateway: ${e.message}`,
      }),
    );
    if (req.body.length > 0) proxyReq.write(req.body);
    proxyReq.end();
  });
}

function bytesToHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
