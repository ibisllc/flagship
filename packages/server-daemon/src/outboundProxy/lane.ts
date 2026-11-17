/**
 * When the owner's proxy fails (docs/outbound-proxy.md "Failure handling").
 *
 * Owner rule (2026-11-17): a setting the owner chose that fails is said
 * loudly, and the box must never end up where the owner can't fix it. So:
 *
 *   - every change into `failing` or `fallback` (and back to working) is an
 *     Activity entry and a report to `.com` (`POST /api/server/<d>/proxy-alert`),
 *     which shows it on /pods and wakes the owner's devices once;
 *   - while the proxy fails and the owner didn't allow a direct connection,
 *     the box polls `.com` for an owner-signed order that fixes or clears the
 *     proxy (`GET /api/server/<d>/proxy-order`, the "lane"), so a box offline
 *     because of its proxy can always be reached.
 *
 * While the proxy fails, lane calls go through the private relay over a direct
 * connection (the relay sees the box's address, `.com` doesn't); if every
 * relay fails too they go to `.com` directly, marked: our relay failing never
 * strands a box. While the proxy works (or the box fell back) they use the
 * normal path. Each call is signed with the box's STK.
 */
import { readFile } from "node:fs/promises";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import {
  BOX_PROXY_LANE_AUTH_SCHEME,
  boxProxyLaneBytes,
  DEFAULT_OHTTP_RELAY,
  ohttpKeyConfigFromHex,
  parseOhttpPublicConfig,
  sendThroughRelays,
  type OhttpPublicConfig,
} from "@flagship/protocol";
import { writeFileDurable } from "../durableFile.js";
import type { OutboundNet, OutboundStatus } from "./outboundNet.js";
import { settingOf, verifiedBoxProxy, type OutboundProxyAuthority, type OutboundProxyStore, type StoredOutboundProxy } from "./store.js";

export interface ProxyLaneDeps {
  net: OutboundNet;
  store: OutboundProxyStore;
  authority: OutboundProxyAuthority;
  /** `https://flagshipserver.com` */
  controlPlaneBaseUrl: string;
  /** Sign with the box's STK. */
  signAsBox: (msg: Uint8Array) => Uint8Array | Promise<Uint8Array>;
  /** Switch to a setting the lane delivered (connector, tunnel, bridge). */
  activate: (stored: StoredOutboundProxy) => void | Promise<void>;
  /** Activity entries. */
  note: (kind: string, detail: string, opts: { ok?: boolean }) => void;
  /** Where the last relay config from `.com` is kept. */
  ohttpConfigPath: string;
  probeTarget: () => { host: string; port: number };
  /** The Pro gate (http.ts): a lane order that sets a proxy is refused on a verified Free plan. */
  plan?: { state(): "pro" | "free" | "unknown"; refresh(): Promise<"pro" | "free" | "unknown"> };
  log?: (m: string) => void;
  now?: () => number;
  /** Test seams. */
  fetch?: (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array; signal?: AbortSignal }) => Promise<Response>;
  directFetch?: ProxyLaneDeps["fetch"];
  pollEveryMs?: number;
}

export interface ProxyLane {
  /** Read the cached relay config and start listening; idempotent. */
  start(): Promise<void>;
  stop(): void;
  /** One poll now (tests; also after start-up while failing). */
  pollOnce(): Promise<"applied" | "none" | "refused" | "error">;
  /** Refresh the relay config from `.com` over the normal path. */
  refreshConfig(): Promise<void>;
  relayConfig(): OhttpPublicConfig;
}

const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const te = new TextEncoder();

function seedConfig(): OhttpPublicConfig {
  const url = process.env.FLAGSHIP_OHTTP_RELAY_URL ?? DEFAULT_OHTTP_RELAY?.relayUrl;
  const key = process.env.FLAGSHIP_OHTTP_KEY_CONFIG ?? DEFAULT_OHTTP_RELAY?.keyConfigHex;
  if (!url || !key) return { v: 1, keyConfigHex: null, relays: [] };
  return parseOhttpPublicConfig({ v: 1, keyConfigHex: key, relays: [{ url, operator: "Flagship", interim: true }] });
}

const DETAIL: Record<string, string> = {
  failing:
    "The outbound proxy isn't working, so the server can't reach Flagship. It keeps trying the proxy; change or turn off the proxy on the server's page.",
  fallback: "The outbound proxy isn't working, so the server is connecting directly, as the owner allowed.",
  ok: "The outbound proxy works again.",
};

export function startProxyLane(deps: ProxyLaneDeps): ProxyLane {
  const log = deps.log ?? ((m: string) => console.log(m));
  const now = deps.now ?? Date.now;
  const base = deps.controlPlaneBaseUrl.replace(/\/+$/, "");
  const apex = new URL(base).hostname;
  const domain = deps.authority.serverDomain.toLowerCase();
  const directAgent = new UndiciAgent();
  const normalFetch = deps.fetch ?? ((url, init) => globalThis.fetch(url, init as RequestInit));
  const directFetch =
    deps.directFetch ??
    ((url, init) => undiciFetch(url, { ...init, dispatcher: directAgent } as never) as unknown as Promise<Response>);
  let cfg: OhttpPublicConfig = seedConfig();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let stopped = false;
  let lastReported: string | null = null;

  const auth = async (method: string, path: string, body: Uint8Array) => {
    const ts = now();
    const sig = await deps.signAsBox(boxProxyLaneBytes(domain, method, path, ts, body));
    return `${BOX_PROXY_LANE_AUTH_SCHEME} ${ts}.${hexOf(sig)}`;
  };

  /** One lane call by whichever path works now. */
  const call = async (method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; json: unknown } | null> => {
    const bytes = body === undefined ? new Uint8Array(0) : te.encode(JSON.stringify(body));
    const headers: Array<[string, string]> = [["authorization", await auth(method, path, bytes)]];
    if (body !== undefined) headers.push(["content-type", "application/json"]);
    const url = `${base}${path}`;
    try {
      if (deps.net.status().state !== "failing") {
        const r = await normalFetch(url, { method, headers: Object.fromEntries(headers), ...(body !== undefined ? { body: bytes } : {}) });
        return { status: r.status, json: await r.json().catch(() => null) };
      }
      const key = cfg.keyConfigHex ? ohttpKeyConfigFromHex(cfg.keyConfigHex) : null;
      const r = await sendThroughRelays(
        { url, method, headers, ...(body !== undefined ? { body: bytes } : {}) },
        {
          keyConfig: key,
          relays: cfg.relays.map((x) => x.url),
          // Our relay failing must never strand the box: the lane goes direct, marked.
          mayGoDirect: () => true,
          timeoutMs: 15_000,
          fetch: directFetch as never,
        },
      );
      if (r.path === "direct") log(`[outbound-proxy] lane call went directly (${r.fallbackReason})`);
      let json: unknown = null;
      try {
        json = JSON.parse(new TextDecoder().decode(r.body));
      } catch {
        /* no body */
      }
      return { status: r.status, json };
    } catch (e) {
      log(`[outbound-proxy] lane call failed: ${(e as Error).message}`);
      return null;
    }
  };

  const report = async (s: OutboundStatus) => {
    const state = s.state === "failing" || s.state === "fallback" ? s.state : "ok";
    const key = `${state}|${s.code ?? ""}`;
    if (key === lastReported) return;
    const r = await call("POST", `/api/server/${domain}/proxy-alert`, {
      state,
      ...(state !== "ok" ? { code: s.code ?? "unreachable" } : {}),
      since: s.since,
    });
    if (r && r.status === 200) lastReported = key;
  };

  const pollOnce = async (): Promise<"applied" | "none" | "refused" | "error"> => {
    const r = await call("GET", `/api/server/${domain}/proxy-order`);
    if (!r || r.status !== 200) return "error";
    const order = (r.json as { order?: unknown } | null)?.order;
    if (!order) return "none";
    const signed = verifiedBoxProxy(order, deps.authority);
    const held = deps.store.current();
    if (!signed) return "refused";
    if (held && signed.proxy.issuedAt <= held.signed.proxy.issuedAt) return "none";
    const p = signed.proxy;
    if (p.kind !== "none" && deps.plan?.state() === "free" && (await deps.plan.refresh().catch(() => "unknown")) === "free") {
      deps.note("server.proxy.lane-refused", "An outbound proxy is part of Pro; the server can still turn this one off.", { ok: false });
      return "refused";
    }
    let credentials = undefined as StoredOutboundProxy["credentials"];
    if (p.kind !== "none" && p.auth) {
      const hp = held?.signed.proxy;
      const same = hp && hp.auth && hp.kind === p.kind && hp.host === p.host && hp.port === p.port && held?.credentials;
      if (!same) {
        deps.note("server.proxy.lane-refused", "A proxy change from the app needs a password, which Flagship never carries. Change it from the same network as the server.", { ok: false });
        return "refused";
      }
      credentials = held!.credentials;
    }
    const next: StoredOutboundProxy = { signed, ...(credentials ? { credentials } : {}), source: "owner" };
    const setting = settingOf(next);
    if (setting) {
      const t = deps.probeTarget();
      const why = await deps.net.probe(setting, t.host, t.port);
      if (why) {
        deps.note("server.proxy.lane-refused", `The new proxy setting didn't work either (${why}); the server keeps the old one.`, { ok: false });
        return "refused";
      }
    }
    await deps.store.save(next);
    await deps.activate(next);
    deps.note("server.proxy.changed", p.kind === "none" ? "The outbound proxy was turned off from the app." : "The outbound proxy was changed from the app.", { ok: true });
    log(`[outbound-proxy] took the owner's proxy order from the lane (${p.kind})`);
    return "applied";
  };

  const schedule = () => {
    if (stopped || timer) return;
    if (deps.net.status().state !== "failing") return;
    const every = deps.pollEveryMs ?? 2 * 60_000;
    timer = setTimeout(async () => {
      timer = null;
      if (deps.net.status().state === "failing") {
        await pollOnce().catch(() => "error");
        const s = deps.net.status();
        if (s.state === "failing") await report(s).catch(() => {});
      }
      schedule();
    }, every + Math.floor(Math.random() * 15_000));
    timer.unref?.();
  };

  const loadCached = async () => {
    try {
      const c = parseOhttpPublicConfig(JSON.parse(await readFile(deps.ohttpConfigPath, "utf8")), apex);
      if (c.keyConfigHex && c.relays.length > 0) cfg = c;
    } catch {
      /* none cached: the release's seed */
    }
  };

  const refreshConfig = async () => {
    try {
      const r = await normalFetch(`${base}/api/ohttp/config`, { method: "GET", headers: {} });
      if (!r.ok) return;
      const c = parseOhttpPublicConfig(await r.json(), apex);
      if (!c.keyConfigHex || c.relays.length === 0) return;
      cfg = c;
      await writeFileDurable(deps.ohttpConfigPath, `${JSON.stringify(c)}\n`, 0o644);
    } catch {
      /* keep the last one */
    }
  };

  return {
    async start() {
      if (started) return;
      started = true;
      await loadCached();
      deps.net.onStateChange((s, prev, how) => {
        const wasBad = prev.state === "failing" || prev.state === "fallback";
        if (s.state === "failing" || s.state === "fallback") {
          deps.note(`server.proxy.${s.state}`, `${DETAIL[s.state]} (${s.lastError ?? "no answer"})`, { ok: false });
        } else if (wasBad && !how.configured) {
          deps.note("server.proxy.ok", DETAIL.ok!, { ok: true });
        } else if (!wasBad) {
          return;
        }
        // A new setting (or the proxy working again) clears the alert at .com.
        void report(s).catch(() => {});
        if (s.state === "failing") {
          void pollOnce().catch(() => "error");
          schedule();
        }
      });
      if (deps.net.status().state !== "failing") void refreshConfig();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    pollOnce,
    refreshConfig,
    relayConfig: () => cfg,
  };
}
