/**
 * The outbound proxy's fallback lane (docs/outbound-proxy.md "Failure
 * handling"; migration 0155).
 *
 *   POST /api/server/<domain>/proxy-order   an app leaves an owner-signed
 *        `flagship/box-proxy/v1` order for a server it can't reach (no
 *        credentials: they never pass `.com`). Checked here under the
 *        account's sensitive-order authority only so a stranger can't push a
 *        real order out of the lane; the box verifies it again.
 *   GET  /api/server/<domain>/proxy-order   the box (STK-signed lane call,
 *        usually through the private relay) picks it up.
 *   POST /api/server/<domain>/proxy-alert   the box reports that its proxy
 *        fails (or works again). Shown on /pods; a change into failing or
 *        fallback wakes the owner's devices with a content-free push.
 */
import {
  BOX_PROXY_LANE_ORDER_TTL_MS,
  BOX_PROXY_MAX_SKEW_MS,
  parseBoxProxyAlertReport,
  parseSignedBoxProxy,
  verifyBoxProxy,
  verifyBoxProxyLaneAuth,
} from "@flagship/protocol";
import type {
  BoxProxyAlert,
  BoxProxyLaneStorage,
  DeviceCapabilityGrantStorage,
  PushTokenStorage,
  ServerStorage,
  UsernameStorage,
} from "@flagship/storage";
import { authorizeSensitiveComOp } from "./adminAuthorityGate.js";
import { appRouteLink } from "./appLink.js";
import { hexToBytes } from "./hex.js";
import { apnsAlertFor } from "./pushBridge.js";
import type { V12PushFanout } from "./totp.js";
import { conflict, forbidden, malformed, notFound, ok, type HandlerResponseWithHeaders } from "./types.js";

export const PROXY_ALERT_PUSH_CATEGORY = "outbound-proxy";

export interface BoxProxyLaneDeps {
  lane: BoxProxyLaneStorage;
  servers: ServerStorage;
  usernames: UsernameStorage;
  grants?: DeviceCapabilityGrantStorage;
  pushTokens?: PushTokenStorage;
  pushFanout?: V12PushFanout;
  apex?: string;
  now?: () => number;
}

const DOMAIN_RE = /^[a-z0-9.-]{1,253}$/;

async function liveServer(deps: BoxProxyLaneDeps, domain: string) {
  const d = domain.toLowerCase();
  if (!DOMAIN_RE.test(d)) return null;
  const s = await deps.servers.get(d);
  return s && !s.revokedAt ? s : null;
}

export async function handlePostProxyOrder(deps: BoxProxyLaneDeps, domain: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  if (body && typeof body === "object" && "credentials" in body && (body as { credentials?: unknown }).credentials != null) {
    return { status: 400, body: { error: "credentials never go through Flagship", code: "lane-no-credentials" } };
  }
  const signed = parseSignedBoxProxy(body);
  if (!signed) return malformed("malformed proxy order");
  const p = signed.proxy;
  const server = await liveServer(deps, domain);
  if (!server || p.serverDomain !== server.serverDomain) return notFound("unknown server");
  if (Math.abs(now - p.issuedAt) > BOX_PROXY_MAX_SKEW_MS) return forbidden("stale request");
  const userRec = await deps.usernames.get(server.username);
  if (!userRec) return notFound("unknown server");
  const authz = await authorizeSensitiveComOp(
    { grants: deps.grants, now: () => now },
    { username: server.username, userRec, verifyWith: (pub) => verifyBoxProxy(p, signed.signature, hexToBytes(pub)) },
  );
  if (!authz.ok) return forbidden("invalid proxy order signature");
  const put = await deps.lane.putOrderIfNewer(server.serverDomain, server.username, {
    orderJson: JSON.stringify(p),
    signatureHex: signed.signature,
    issuedAt: p.issuedAt,
  });
  if (!put) return conflict("a newer proxy order is already waiting");
  return ok({ ok: true });
}

export async function handleGetProxyOrder(
  deps: BoxProxyLaneDeps,
  domain: string,
  path: string,
  auth: string | null,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  const server = await liveServer(deps, domain);
  if (!server) return notFound("unknown server");
  if (!verifyBoxProxyLaneAuth(auth, server.serverDomain, "GET", path, new Uint8Array(0), hexToBytes(server.identityPubKeyHex), now)) {
    return forbidden("not signed by this server");
  }
  const row = await deps.lane.getOrder(server.serverDomain);
  if (!row || now - row.issuedAt > BOX_PROXY_LANE_ORDER_TTL_MS) return ok({ order: null }, { "cache-control": "no-store" });
  let proxy: unknown;
  try {
    proxy = JSON.parse(row.orderJson);
  } catch {
    return ok({ order: null }, { "cache-control": "no-store" });
  }
  return ok({ order: { proxy, signature: row.signatureHex } }, { "cache-control": "no-store" });
}

export async function handlePostProxyAlert(
  deps: BoxProxyLaneDeps,
  domain: string,
  path: string,
  auth: string | null,
  rawBody: Uint8Array,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  const server = await liveServer(deps, domain);
  if (!server) return notFound("unknown server");
  if (!verifyBoxProxyLaneAuth(auth, server.serverDomain, "POST", path, rawBody, hexToBytes(server.identityPubKeyHex), now)) {
    return forbidden("not signed by this server");
  }
  let report;
  try {
    report = parseBoxProxyAlertReport(JSON.parse(new TextDecoder().decode(rawBody)));
  } catch {
    report = null;
  }
  if (!report) return malformed("malformed proxy report");
  const next = report.state === "ok" ? null : { state: report.state, code: report.code ?? "unreachable", since: Math.min(report.since, now), at: now };
  const prev = await deps.lane.setAlert(server.serverDomain, server.username, next);
  if (next && prev?.state !== next.state) await wakeOwner(deps, server.username);
  return ok({ ok: true });
}

/** `proxyAlert` per server for `/pods`. */
export async function proxyAlertsByServer(lane: BoxProxyLaneStorage | undefined, username: string): Promise<Map<string, BoxProxyAlert>> {
  const out = new Map<string, BoxProxyAlert>();
  if (!lane) return out;
  try {
    for (const a of await lane.alertsForUser(username.toLowerCase())) out.set(a.serverDomain, a);
  } catch {
    /* the lane is an extra; /pods works without it */
  }
  return out;
}

async function wakeOwner(deps: BoxProxyLaneDeps, username: string): Promise<void> {
  if (!deps.pushTokens || !deps.pushFanout) return;
  try {
    const tokens = await deps.pushTokens.listByUser(username);
    if (tokens.length === 0) return;
    const a = apnsAlertFor(PROXY_ALERT_PUSH_CATEGORY);
    await deps.pushFanout({
      username,
      targets: tokens.map((t) => ({ tokenId: t.tokenId, platform: t.platform, providerToken: t.providerToken })),
      payload: { category: PROXY_ALERT_PUSH_CATEGORY, title: a.title, body: a.body, deepLink: appRouteLink("account/activity", {}, deps.apex) },
    });
  } catch {
    /* a push failure never fails the report */
  }
}
