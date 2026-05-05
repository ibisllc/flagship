/**
 * Worker-side routing for the .com control-plane endpoints.
 *
 * These used to live on the Fly app behind Fastify. After the
 * .com (identity, persistent state) / .services (transient, runtime)
 * split they're now served directly by the Worker, with D1 as the
 * persistence layer. The handlers themselves live in
 * @flagship/control-plane and are runtime-agnostic.
 */

import {
  caKeypairFromEnv,
  handleAuthCodeIssue,
  handleAuthCodeLookup,
  handleAuthCodeRevoke,
  handleAuthCodeUse,
  handleBuildTicketIssue,
  handleBuildTicketLookup,
  handleBuildTicketRedeem,
  handleBuildTicketRefresh,
  handleCaCert,
  handleServerLookup,
  handleServerRegister,
  handleUsernameClaim,
  handleUsernameLookup,
  handleUserPubKeyCert,
  type CaIssuer,
  type HandlerResponseWithHeaders,
} from "@flagship/control-plane";
import { D1Storage, type D1Database } from "@flagship/storage";

export interface ControlPlaneEnv {
  DB?: D1Database;
  FLAGSHIP_CA_PRIV_HEX?: string;
  FLAGSHIP_CA_ISSUER?: string;
}

const ROUTE_RE = {
  USERNAME_CLAIM: /^\/api\/username\/claim$/,
  USERNAME_LOOKUP: /^\/api\/username\/([^/]+)$/,
  AUTH_CODE_ISSUE: /^\/api\/auth-code\/issue$/,
  AUTH_CODE_USE: /^\/api\/auth-code\/([^/]+)\/use$/,
  AUTH_CODE_REVOKE: /^\/api\/auth-code\/([^/]+)\/revoke$/,
  AUTH_CODE_LOOKUP: /^\/api\/auth-code\/([^/]+)$/,
  BUILD_TICKET_ISSUE: /^\/api\/build-tickets\/issue$/,
  BUILD_TICKET_REDEEM: /^\/api\/build-tickets\/redeem$/,
  BUILD_TICKET_REFRESH: /^\/api\/build-tickets\/([^/]+)\/refresh$/,
  BUILD_TICKET_LOOKUP: /^\/api\/build-tickets\/([^/]+)$/,
  SERVER_REGISTER: /^\/api\/server\/register$/,
  SERVER_LOOKUP: /^\/api\/server\/by-domain\/([^/]+)$/,
  PUBKEY_CERT: /^\/api\/users\/([^/]+)\/pubkey-cert$/,
  CA_CERT: /^\/api\/ca\/cert$/,
};

export async function tryControlPlane(
  request: Request,
  env: ControlPlaneEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  if (!env.DB) return null;
  const storage = new D1Storage(env.DB);
  const ca: CaIssuer = caKeypairFromEnv({
    FLAGSHIP_CA_PRIV_HEX: env.FLAGSHIP_CA_PRIV_HEX,
    FLAGSHIP_CA_ISSUER: env.FLAGSHIP_CA_ISSUER,
  });

  let m: RegExpMatchArray | null;
  if (method === "POST" && ROUTE_RE.USERNAME_CLAIM.test(path)) {
    return finish(await handleUsernameClaim({ storage: storage.usernames }, await readJson(request)));
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.USERNAME_LOOKUP))) {
    if (m[1] === "claim") return null;
    return finish(await handleUsernameLookup(storage.usernames, decodeURIComponent(m[1]!)));
  }

  if (method === "POST" && ROUTE_RE.AUTH_CODE_ISSUE.test(path)) {
    return finish(
      await handleAuthCodeIssue(
        { storage: storage.authCodes, usernames: storage.usernames },
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.AUTH_CODE_USE))) {
    return finish(
      await handleAuthCodeUse(
        { storage: storage.authCodes, usernames: storage.usernames },
        decodeURIComponent(m[1]!),
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.AUTH_CODE_REVOKE))) {
    return finish(
      await handleAuthCodeRevoke(
        { storage: storage.authCodes, usernames: storage.usernames },
        decodeURIComponent(m[1]!),
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.AUTH_CODE_LOOKUP))) {
    if (m[1] === "issue") return null;
    return finish(
      await handleAuthCodeLookup(
        { storage: storage.authCodes, usernames: storage.usernames },
        decodeURIComponent(m[1]!),
      ),
    );
  }

  if (method === "POST" && ROUTE_RE.BUILD_TICKET_ISSUE.test(path)) {
    return finish(
      await handleBuildTicketIssue(
        { storage: storage.buildTickets, usernames: storage.usernames },
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && ROUTE_RE.BUILD_TICKET_REDEEM.test(path)) {
    return finish(
      await handleBuildTicketRedeem(
        { storage: storage.buildTickets, usernames: storage.usernames },
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.BUILD_TICKET_REFRESH))) {
    return finish(
      await handleBuildTicketRefresh(
        { storage: storage.buildTickets, usernames: storage.usernames },
        decodeURIComponent(m[1]!),
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.BUILD_TICKET_LOOKUP))) {
    if (m[1] === "issue" || m[1] === "redeem") return null;
    return finish(
      await handleBuildTicketLookup(
        { storage: storage.buildTickets, usernames: storage.usernames },
        decodeURIComponent(m[1]!),
      ),
    );
  }

  if (method === "POST" && ROUTE_RE.SERVER_REGISTER.test(path)) {
    return finish(
      await handleServerRegister(
        { authCodes: storage.authCodes, servers: storage.servers },
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.SERVER_LOOKUP))) {
    return finish(
      await handleServerLookup(
        { authCodes: storage.authCodes, servers: storage.servers },
        decodeURIComponent(m[1]!),
      ),
    );
  }

  if (method === "GET" && (m = path.match(ROUTE_RE.PUBKEY_CERT))) {
    return finish(
      await handleUserPubKeyCert(
        { ca, usernames: storage.usernames },
        decodeURIComponent(m[1]!),
      ),
    );
  }
  if (method === "GET" && ROUTE_RE.CA_CERT.test(path)) {
    return finish(handleCaCert({ ca, usernames: storage.usernames }));
  }

  return null;
}

async function readJson(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const text = await request.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function finish(r: HandlerResponseWithHeaders): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (r.headers) for (const [k, v] of Object.entries(r.headers)) headers.set(k, v);
  return new Response(JSON.stringify(r.body), { status: r.status, headers });
}
