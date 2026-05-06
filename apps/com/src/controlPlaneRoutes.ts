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
  authorizeAdmin,
  caKeypairFromEnv,
  CloudflareDnsClient,
  handleAuthCodeIssue,
  handleAuthCodeLookup,
  handleAuthCodeRevoke,
  handleAuthCodeUse,
  handleBuildTicketIssue,
  handleBuildTicketLookup,
  handleBuildTicketRedeem,
  handleBuildTicketRefresh,
  handleCaCert,
  handleCleanupApex,
  handleConsumeUnlockKey,
  handleDepositUnlockKey,
  handleDns01Delete,
  handleDns01Publish,
  handleGetInstallEvents,
  handleGetSealedLuksKey,
  handlePutSealedLuksKey,
  handlePostInstallEvent,
  handleRegisterRck,
  handleRepublishServerDns,
  handleRoutingLookup,
  handleServerLookup,
  handleServerRegister,
  handleServerRevokeBySelf,
  handleSetRoutingTarget,
  handleUsernameClaim,
  handleUsernameLookup,
  handleUserPubKeyCert,
  type CaIssuer,
  type HandlerResponse,
  type HandlerResponseWithHeaders,
} from "@flagship/control-plane";
import { D1Storage, type D1Database } from "@flagship/storage";

export interface ControlPlaneEnv {
  DB?: D1Database;
  FLAGSHIP_CA_PRIV_HEX?: string;
  FLAGSHIP_CA_ISSUER?: string;
  /** API token with Zone:DNS:Edit on flagship.services. */
  CLOUDFLARE_DNS_API_TOKEN?: string;
  /** Zone ID for flagship.services. */
  CLOUDFLARE_SERVICES_ZONE_ID?: string;
  /** IPv4 of the .services SNI passthrough listener (Fly anycast). */
  SERVICES_PASSTHROUGH_IPV4?: string;
  SERVICES_PASSTHROUGH_IPV6?: string;
  /** Shared secret gating /api/admin/* operational endpoints. */
  FLAGSHIP_ADMIN_SECRET?: string;
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
  SERVER_REVOKE_BY_SELF: /^\/api\/server\/by-domain\/([^/]+)\/revoke$/,
  PUBKEY_CERT: /^\/api\/users\/([^/]+)\/pubkey-cert$/,
  CA_CERT: /^\/api\/ca\/cert$/,
  RCK_REGISTER: /^\/api\/routing\/register-rck$/,
  RCK_SET_TARGET: /^\/api\/routing\/set-target$/,
  ROUTING_LOOKUP: /^\/api\/routing\/lookup$/,
  INSTALL_EVENTS: /^\/api\/install-events\/([^/]+)$/,
  DNS01_PUBLISH: /^\/api\/dns-01\/publish$/,
  DNS01_DELETE: /^\/api\/dns-01\/delete$/,
  LUKS_SEALED: /^\/api\/server\/([^/]+)\/sealed-luks-key$/,
  LUKS_UNLOCK_DEPOSIT: /^\/api\/server\/([^/]+)\/unlock-key$/,
  LUKS_UNLOCK_CONSUME: /^\/api\/server\/([^/]+)\/unlock-key\/consume$/,
  ADMIN_REPUBLISH: /^\/api\/admin\/republish-server-dns$/,
  ADMIN_CLEANUP_APEX: /^\/api\/admin\/cleanup-apex$/,
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
    const dns =
      env.CLOUDFLARE_DNS_API_TOKEN &&
      env.CLOUDFLARE_SERVICES_ZONE_ID &&
      env.SERVICES_PASSTHROUGH_IPV4
        ? {
            client: new CloudflareDnsClient({
              apiToken: env.CLOUDFLARE_DNS_API_TOKEN,
              zoneId: env.CLOUDFLARE_SERVICES_ZONE_ID,
            }),
            servicesIpv4: env.SERVICES_PASSTHROUGH_IPV4,
            servicesIpv6: env.SERVICES_PASSTHROUGH_IPV6,
          }
        : undefined;
    return finish(
      await handleServerRegister(
        {
          authCodes: storage.authCodes,
          servers: storage.servers,
          routing: storage.routing,
          dns,
        },
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
  if (method === "POST" && (m = path.match(ROUTE_RE.SERVER_REVOKE_BY_SELF))) {
    return finishPlain(
      await handleServerRevokeBySelf(
        { servers: storage.servers },
        decodeURIComponent(m[1]!),
        await readJson(request),
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

  if (method === "POST" && ROUTE_RE.RCK_REGISTER.test(path)) {
    return finish(
      await handleRegisterRck(
        { routing: storage.routing, usernames: storage.usernames },
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && ROUTE_RE.RCK_SET_TARGET.test(path)) {
    return finish(
      await handleSetRoutingTarget(
        { routing: storage.routing, usernames: storage.usernames },
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && ROUTE_RE.ROUTING_LOOKUP.test(path)) {
    const host = url.searchParams.get("host");
    if (!host) return jsonResponse({ error: "host query param required" }, 400);
    return finish(
      await handleRoutingLookup(
        { routing: storage.routing, usernames: storage.usernames },
        host,
      ),
    );
  }

  if (method === "POST" && (ROUTE_RE.DNS01_PUBLISH.test(path) || ROUTE_RE.DNS01_DELETE.test(path))) {
    if (
      !env.CLOUDFLARE_DNS_API_TOKEN ||
      !env.CLOUDFLARE_SERVICES_ZONE_ID
    ) {
      return jsonResponse({ error: "DNS-01 not configured on this control plane" }, 503);
    }
    const dns = new CloudflareDnsClient({
      apiToken: env.CLOUDFLARE_DNS_API_TOKEN,
      zoneId: env.CLOUDFLARE_SERVICES_ZONE_ID,
    });
    const handler = ROUTE_RE.DNS01_PUBLISH.test(path) ? handleDns01Publish : handleDns01Delete;
    const res = await handler({ servers: storage.servers, dns }, await readJson(request));
    return finishPlain(res);
  }

  if (method === "POST" && (m = path.match(ROUTE_RE.LUKS_SEALED))) {
    return finishPlain(
      await handlePutSealedLuksKey(
        {
          servers: storage.servers,
          usernames: storage.usernames,
          luksKeys: storage.luksKeys,
        },
        decodeURIComponent(m[1]!),
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.LUKS_SEALED))) {
    return finishPlain(
      await handleGetSealedLuksKey(
        {
          servers: storage.servers,
          usernames: storage.usernames,
          luksKeys: storage.luksKeys,
        },
        decodeURIComponent(m[1]!),
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.LUKS_UNLOCK_CONSUME))) {
    const host = decodeURIComponent(m[1]!);
    return finishPlain(
      await handleConsumeUnlockKey(
        {
          servers: storage.servers,
          usernames: storage.usernames,
          luksKeys: storage.luksKeys,
        },
        host,
        await readJson(request),
      ),
    );
  }
  if (method === "POST" && (m = path.match(ROUTE_RE.LUKS_UNLOCK_DEPOSIT))) {
    const host = decodeURIComponent(m[1]!);
    return finishPlain(
      await handleDepositUnlockKey(
        {
          servers: storage.servers,
          usernames: storage.usernames,
          luksKeys: storage.luksKeys,
        },
        host,
        await readJson(request),
      ),
    );
  }

  if (method === "POST" && (ROUTE_RE.ADMIN_REPUBLISH.test(path) || ROUTE_RE.ADMIN_CLEANUP_APEX.test(path))) {
    const auth = authorizeAdmin({
      expected: env.FLAGSHIP_ADMIN_SECRET,
      provided: request.headers.get("x-admin-secret"),
    });
    if (auth) return finishPlain(auth);
    if (
      !env.CLOUDFLARE_DNS_API_TOKEN ||
      !env.CLOUDFLARE_SERVICES_ZONE_ID
    ) {
      return jsonResponse({ error: "DNS API not configured" }, 503);
    }
    const dns = new CloudflareDnsClient({
      apiToken: env.CLOUDFLARE_DNS_API_TOKEN,
      zoneId: env.CLOUDFLARE_SERVICES_ZONE_ID,
    });
    if (ROUTE_RE.ADMIN_REPUBLISH.test(path)) {
      if (!env.SERVICES_PASSTHROUGH_IPV4) {
        return jsonResponse({ error: "SERVICES_PASSTHROUGH_IPV4 not set" }, 503);
      }
      return finishPlain(
        await handleRepublishServerDns({
          servers: storage.servers,
          dns,
          servicesIpv4: env.SERVICES_PASSTHROUGH_IPV4,
          servicesIpv6: env.SERVICES_PASSTHROUGH_IPV6,
        }),
      );
    }
    return finishPlain(
      await handleCleanupApex({ dns, apex: "flagship.services" }),
    );
  }

  if (method === "POST" && (m = path.match(ROUTE_RE.INSTALL_EVENTS))) {
    return finish(
      await handlePostInstallEvent(
        { storage: storage.installEvents },
        decodeURIComponent(m[1]!),
        await readJson(request),
      ),
    );
  }
  if (method === "GET" && (m = path.match(ROUTE_RE.INSTALL_EVENTS))) {
    const sinceSeq = parseInt(url.searchParams.get("since") ?? "0", 10) || 0;
    return finish(
      await handleGetInstallEvents(
        { storage: storage.installEvents },
        decodeURIComponent(m[1]!),
        sinceSeq,
      ),
    );
  }

  return null;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Returns `any` because the handlers in @flagship/control-plane all
// re-validate input shape internally. Casting to specific body types here
// would be busy-work without adding safety.
async function readJson(request: Request): Promise<any> {
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

function finishPlain(r: HandlerResponse): Response {
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers: { "content-type": "application/json" },
  });
}
