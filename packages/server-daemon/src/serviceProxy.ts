/**
 * Per-app reverse proxy. The daemon's TLS server already terminates
 * inbound HTTPS; this module is what fires after termination when the
 * SNI maps to an installed app:
 *
 *   1. Decide if the request can reach the container at all
 *      (public route ⇒ anonymous OK; otherwise membership-gated).
 *   2. Strip any `X-Flagship-*` headers the client supplied (they have
 *      no business arriving uninjected).
 *   3. Inject signed identity headers the app trusts:
 *        X-Flagship-User       : "anonymous" or member id
 *        X-Flagship-Role       : "anonymous" / role
 *        X-Flagship-Signature  : Ed25519 over the canonical-bytes of
 *                                {serviceId, user, role, timestamp}
 *   4. Forward the request to `127.0.0.1:<containerPort>` and pipe the
 *      response back.
 *
 * The container has no network path that bypasses this proxy (the
 * daemon runs the TLS server, the container is on a docker network
 * with no external bridge, and AppRunner publishes only to the
 * daemon's localhost port). So whatever the proxy decides, the app
 * sees only the result. The app cannot weaken or bypass the gate.
 *
 * Membership-based identification (mapping a request to a member's
 * IRK pubkey) requires a paired-session cookie/token mechanism the
 * phone produces. v1 supplies a `resolveSession` deps hook; v0 leaves
 * it as the always-anonymous resolver.
 */

import { request as httpRequest } from "node:http";
import type { Bytes } from "@flagship/protocol";
import type { BoxSigner } from "./keyCustodian.js";
import type { InstalledService } from "./servicePlatform.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";
import type { UpdateServer } from "./updateServer.js";

export interface SessionInfo {
  /** The signed-in member's IRK pubkey. */
  irkPub: Bytes;
  /** The app-stable id derived for this member-app pair (`AppMembership.stableIdFor`). */
  stableId: string;
  /** Role from the membership store. */
  role: string;
}

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
  /** Override fetch implementation for tests. */
  forward?: (host: string, port: number, req: HttpRequest) => Promise<HttpResponse>;
  now?: () => number;
  /**
   * App update-pack distribution server. When set, requests for
   * `/.flagship/update` are routed here before the container is
   * consulted. Apps cannot ship their own /update.
   */
  updateServer?: UpdateServer;
}

const STRIP_PREFIX = "x-flagship-";

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

/**
 * Decide whether a request is allowed to reach the container, then
 * (when allowed) forward it. Returns the HttpResponse the daemon's
 * TLS handler will write back to the inbound socket.
 */
export async function handleAppRequest(
  app: InstalledService,
  req: HttpRequest,
  deps: AppProxyDeps,
): Promise<HttpResponse> {
  const session = deps.resolveSession ? deps.resolveSession(req, app) : null;
  const allowed = decideAccess(app, req, session);

  if (allowed === "deny") {
    return {
      status: 403,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: REQUEST_ACCESS_TEMPLATE(app.manifest.name, app.urlLabel),
    };
  }

  // Internal endpoint apps can hit to verify the daemon's injector key.
  if (req.path === "/.flagship/runtime-pubkey") {
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        injectorPubKeyHex: bytesToHex(deps.injector.boxPublicKey()),
      }),
    };
  }

  // App-update distribution. The proxy intercepts /.flagship/update
  // before the container, so apps can't ship their own /update that
  // would lie about lineage. The server enforces signature, subscriber
  // list, and lineage-coherence cache keying.
  if (req.path === "/.flagship/update" && deps.updateServer) {
    const r = await deps.updateServer.handle(app, req);
    if (r) return r;
  }

  // (No AI-specific proxy path: a deployed app that wants an LLM reads
  // its provider key from its own env like any other var — env values
  // are injected into the container at deploy time by ServicePlatform.)

  // Build the forwarded request: strip incoming X-Flagship-* and inject
  // signed identity headers.
  const forwardHeaders = stripIdentityHeaders(req.headers);
  const ts = String((deps.now ?? Date.now)());
  const user = session ? session.stableId : "anonymous";
  const role = session ? session.role : "anonymous";
  const canonical = [`flagship/inject/v1`, app.serviceId, user, role, ts].join("|");
  const sig = deps.injector.signAsBox(new TextEncoder().encode(canonical));
  forwardHeaders["x-flagship-app-id"] = app.serviceId;
  forwardHeaders["x-flagship-user"] = user;
  forwardHeaders["x-flagship-role"] = role;
  forwardHeaders["x-flagship-timestamp"] = ts;
  forwardHeaders["x-flagship-signature"] = bytesToHex(sig);

  const forward = deps.forward ?? defaultForward;
  return forward("127.0.0.1", app.containerPort, {
    ...req,
    headers: forwardHeaders,
  });
}

/**
 * Pure access-decision function. Returns `"allow"` if the request can
 * reach the container; `"deny"` otherwise. Tested independently of
 * the network plumbing.
 */
export function decideAccess(
  app: InstalledService,
  req: HttpRequest,
  session: SessionInfo | null,
): "allow" | "deny" {
  const access = app.manifest.access;

  // 1. If the path matches a public route, anyone can reach it.
  const publicRoutes = access.public_routes ?? [];
  if (matchesPublicRoute(req.path, publicRoutes)) return "allow";

  // 2. Members can reach any path. Anonymous can reach only public routes.
  if (!session) return "deny";

  // 3. Member exists in the store?
  if (!app.membership.members.isMember(session.irkPub)) return "deny";
  return "allow";
}

function matchesPublicRoute(path: string, publicRoutes: string[]): boolean {
  for (const r of publicRoutes) {
    if (r === path) return true;
    // Allow trailing-slash trick: route "/" matches "/" exactly. Apps
    // that want a deeper public-prefix should declare each path
    // explicitly. We deliberately don't support glob patterns — apps
    // can't accidentally open more than they meant to.
  }
  return false;
}

/** Drop any inbound header whose name starts with `x-flagship-`. */
export function stripIdentityHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!k.toLowerCase().startsWith(STRIP_PREFIX)) out[k] = v;
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
