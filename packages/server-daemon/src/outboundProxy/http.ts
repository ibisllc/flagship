/**
 * `GET`/`POST /api/screens/outbound-proxy` (docs/outbound-proxy.md): the
 * owner reads and changes the box's outbound proxy over the paired session.
 * A change is an owner-signed `flagship/box-proxy/v1` order; the box tests it
 * before switching, so an edit can never strand the box.
 */
import {
  BOX_PROXY_MAX_SKEW_MS,
  boxProxyCredentialsError,
  type BoxProxyCredentials,
  type BoxProxyKind,
} from "@flagship/protocol";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import type { OutboundNet, OutboundStatus } from "./outboundNet.js";
import { settingOf, verifiedBoxProxy, type OutboundProxyAuthority, type OutboundProxyStore, type StoredOutboundProxy } from "./store.js";

export const OUTBOUND_PROXY_PATH = "/api/screens/outbound-proxy";

export interface OutboundProxySummary {
  proxy: {
    kind: Exclude<BoxProxyKind, "none">;
    host: string;
    port: number;
    auth: boolean;
    fallbackDirect: boolean;
    issuedAt: number;
  } | null;
  hasCredentials: boolean;
  status: OutboundStatus;
  /** False once `.com` has said the account is on Free: the proxy is part of
   *  Pro, so the box takes no new proxy (turning one off always works). */
  available: boolean;
}

export interface OutboundProxyHttpDeps {
  store: OutboundProxyStore;
  net: OutboundNet;
  authority: OutboundProxyAuthority;
  /** Where a new proxy must reach before it's accepted (the tunnel hub). */
  probeTarget: () => { host: string; port: number };
  /** Switch the box to the saved setting (connector, tunnel, bridge). */
  activate: (stored: StoredOutboundProxy) => void | Promise<void>;
  /** The account's plan as `.com` last said in the heartbeat reply; null until it has. */
  accountTier?: () => string | null;
  now?: () => number;
  /** How long to wait after answering before switching, so the answer leaves on the old path. */
  switchDelayMs?: number;
}

const J = { "content-type": "application/json" };
const jres = (status: number, body: unknown): HttpResponse => ({ status, headers: J, body: JSON.stringify(body) });

/** A proxy is part of Pro. Until `.com` has answered, the box doesn't refuse:
 *  a new box must reach `.com` through its proxy before it can learn its plan. */
export function proxyAvailable(accountTier: (() => string | null) | undefined): boolean {
  return accountTier?.() !== "free";
}

export function outboundProxySummary(
  store: OutboundProxyStore,
  net: OutboundNet,
  accountTier?: () => string | null,
): OutboundProxySummary {
  const held = store.current();
  const p = held?.signed.proxy;
  return {
    proxy:
      p && p.kind !== "none"
        ? { kind: p.kind, host: p.host, port: p.port, auth: p.auth, fallbackDirect: p.fallbackDirect, issuedAt: p.issuedAt }
        : null,
    hasCredentials: Boolean(p?.auth && held?.credentials),
    status: net.status(),
    available: proxyAvailable(accountTier),
  };
}

export function buildOutboundProxyHttp(deps: OutboundProxyHttpDeps) {
  const now = deps.now ?? Date.now;
  return async (path: string, method: string, req: HttpRequest, ctx: { companion: boolean }): Promise<HttpResponse | null> => {
    if (path !== OUTBOUND_PROXY_PATH) return null;
    if (method === "GET") return jres(200, outboundProxySummary(deps.store, deps.net, deps.accountTier));
    if (method !== "POST") return jres(405, { error: "method not allowed" });
    if (ctx.companion) {
      return jres(403, { code: "companion-write-not-allowed", message: "Open your owner app to approve this" });
    }

    let body: { proxy?: unknown; signature?: unknown; credentials?: unknown };
    try {
      body = JSON.parse(req.body.toString("utf-8")) as typeof body;
    } catch {
      return jres(400, { error: "The request isn't valid JSON." });
    }
    const signed = verifiedBoxProxy({ proxy: body.proxy, signature: body.signature }, deps.authority);
    if (!signed) return jres(403, { error: "This change isn't signed by the server's owner." });
    const p = signed.proxy;
    if (Math.abs(now() - p.issuedAt) > BOX_PROXY_MAX_SKEW_MS) {
      return jres(403, { error: "This change is too old. Try again." });
    }
    if (p.kind !== "none" && !proxyAvailable(deps.accountTier)) {
      return jres(403, { code: "pro-required", error: "An outbound proxy is part of Pro. You can still turn this one off." });
    }
    const held = deps.store.current();
    if (held && p.issuedAt <= held.signed.proxy.issuedAt) {
      return jres(409, { error: "A newer proxy setting is already in place." });
    }

    let credentials: BoxProxyCredentials | undefined;
    if (p.auth) {
      if (body.credentials !== undefined && body.credentials !== null) {
        const c = body.credentials as BoxProxyCredentials;
        const why = boxProxyCredentialsError(c);
        if (why) return jres(400, { error: why });
        credentials = { username: c.username, password: c.password };
      } else {
        const hp = held?.signed.proxy;
        const same = hp && hp.auth && hp.kind === p.kind && hp.host === p.host && hp.port === p.port;
        if (!same || !held?.credentials) return jres(400, { error: "Enter the proxy's username and password." });
        credentials = held.credentials;
      }
    }

    const next: StoredOutboundProxy = { signed, ...(credentials ? { credentials } : {}), source: "owner" };
    const setting = settingOf(next);
    if (setting) {
      const target = deps.probeTarget();
      const why = await deps.net.probe(setting, target.host, target.port);
      if (why) return jres(422, { error: why });
    }
    try {
      await deps.store.save(next);
    } catch (e) {
      return jres(500, { error: `Couldn't save the setting (${(e as Error).message}).` });
    }
    setTimeout(() => {
      void Promise.resolve(deps.activate(next)).catch(() => {});
    }, deps.switchDelayMs ?? 500).unref?.();
    const summary = outboundProxySummary(deps.store, deps.net, deps.accountTier);
    return jres(200, { ok: true, outboundProxy: { ...summary, status: { state: setting ? "ok" : "direct", since: now() } } });
  };
}
