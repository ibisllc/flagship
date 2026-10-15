/**
 * How this box reaches the internet: directly, or through the owner's proxy
 * (docs/outbound-proxy.md). One place decides, and the daemon's three kinds of
 * client ask it: global `fetch` through an undici dispatcher, the `ws` clients
 * and `acme-client` (axios) through an `http.Agent`, and child processes
 * (git, npm) through the loopback bridge's address in their environment.
 *
 * Nothing is hooked until a proxy is first set, so a box without one keeps
 * Node's defaults byte for byte. Once hooked, the hooks stay and follow the
 * current setting (turning the proxy off makes them connect directly).
 */
import { Agent as HttpAgent, type AgentOptions } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { connect, isIP, type Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from "node:tls";
import type { Duplex } from "node:stream";
import { Agent as UndiciAgent, buildConnector, setGlobalDispatcher, type Dispatcher } from "undici";
import { isPublicAddress } from "../egress/policy.js";
import { openProxiedSocket, ProxyError, type ProxyUpstream } from "./connect.js";

export interface OutboundProxySetting {
  upstream: ProxyUpstream;
  fallbackDirect: boolean;
}

export type OutboundState = "direct" | "ok" | "failing" | "fallback";

export interface OutboundStatus {
  state: OutboundState;
  /** Unix ms the state began. */
  since: number;
  /** A plain reason, never the credentials. */
  lastError?: string;
}

export interface OutboundNetOptions {
  now?: () => number;
  onLog?: (m: string) => void;
  /** Test seam. */
  openProxied?: typeof openProxiedSocket;
  connectTimeoutMs?: number;
}

/**
 * Hosts that never go to the proxy: loopback, private and link-local
 * addresses (the data stores, a LAN Ollama, LAN-direct copies between the
 * owner's boxes) and local-only names. A proxy can't reach them, and sending
 * them would tell its operator about the LAN.
 */
export function isDirectHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (isIP(h)) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped) h = mapped[1]!;
    return !isPublicAddress(h);
  }
  if (!h.includes(".")) return true;
  return /\.(localhost|local|internal|lan|home\.arpa)$/.test(h);
}

export class OutboundNet {
  private setting: OutboundProxySetting | null = null;
  private stat: OutboundStatus;
  private hooked = false;
  private undici: UndiciAgent | null = null;
  private https: HttpsAgent | null = null;
  private http: HttpAgent | null = null;
  private bridgeUrl: string | null = null;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly open: typeof openProxiedSocket;
  private readonly timeoutMs: number;
  private readonly directTls = buildConnector({});

  constructor(opts: OutboundNetOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.log = opts.onLog ?? (() => {});
    this.open = opts.openProxied ?? openProxiedSocket;
    this.timeoutMs = opts.connectTimeoutMs ?? 15_000;
    this.stat = { state: "direct", since: this.now() };
  }

  current(): OutboundProxySetting | null {
    return this.setting;
  }

  status(): OutboundStatus {
    return { ...this.stat };
  }

  /** Switch to `setting` (null = direct). Existing connections are left to their owners. */
  configure(setting: OutboundProxySetting | null): void {
    this.setting = setting;
    this.setState(setting ? "ok" : "direct");
    // Pooled connections were opened under the old setting; drop them so the
    // next request uses the new path.
    const old = this.undici;
    if (old) {
      this.undici = null;
      void old.close().catch(() => {});
      if (this.hooked) setGlobalDispatcher(this.dispatcher());
    }
    // The Agents stay (axios holds them); only their idle sockets go.
    for (const a of [this.https, this.http]) {
      for (const list of Object.values(a?.freeSockets ?? {})) for (const s of list ?? []) s.destroy();
    }
  }

  /** Set the loopback bridge's URL, which child processes get as their proxy. */
  setBridgeUrl(url: string | null): void {
    this.bridgeUrl = url;
  }

  /**
   * Environment for a child process that reaches the internet (git, npm):
   * the parent's, plus the bridge as its proxy while a proxy is set. The
   * daemon's own environment is never changed, so docker and other children
   * that must not see a proxy don't.
   */
  childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env = { ...base };
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[k];
    if (!this.setting || !this.bridgeUrl) return env;
    const noProxy = "localhost,127.0.0.1,::1,.local,.internal";
    Object.assign(env, {
      HTTP_PROXY: this.bridgeUrl,
      HTTPS_PROXY: this.bridgeUrl,
      http_proxy: this.bridgeUrl,
      https_proxy: this.bridgeUrl,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
    });
    return env;
  }

  /** A TCP stream to `host:port` the way the box reaches it now. */
  async connectTcp(host: string, port: number): Promise<Socket> {
    const s = this.setting;
    if (!s || isDirectHost(host)) return this.direct(host, port);
    try {
      const sock = await this.open(s.upstream, host, port, this.timeoutMs);
      if (this.setting === s && this.stat.state !== "ok") this.setState("ok");
      return sock;
    } catch (e) {
      const err = e instanceof ProxyError ? e : new ProxyError("unreachable", "Can't reach the proxy.");
      const proxyDown = err.code === "unreachable" || err.code === "auth";
      if (!proxyDown) throw err;
      if (this.setting === s) {
        if (s.fallbackDirect) {
          if (this.stat.state !== "fallback") {
            this.log(`[outbound-proxy] ${err.message} Connecting directly (the owner allowed it).`);
            this.setState("fallback", err.message);
          }
        } else if (this.stat.state !== "failing" || this.stat.lastError !== err.message) {
          this.log(`[outbound-proxy] ${err.message}`);
          this.setState("failing", err.message);
        }
      }
      if (s.fallbackDirect) return this.direct(host, port);
      throw err;
    }
  }

  /** TLS to `host:port`, through the proxy when one is set. */
  async connectTls(host: string, port: number, opts: ConnectionOptions = {}): Promise<TLSSocket> {
    const raw = await this.connectTcp(host, port);
    return wrapTls(raw, { servername: isIP(host) ? undefined : host, ...opts });
  }

  /**
   * Check that `setting` reaches `host:port` (TLS handshake included) without
   * switching to it. Resolves null when it works, else the reason.
   */
  async probe(setting: OutboundProxySetting, host: string, port: number): Promise<string | null> {
    let sock: Socket | null = null;
    try {
      sock = await this.open(setting.upstream, host, port, this.timeoutMs);
      const tls = await wrapTls(sock, { servername: host }, this.timeoutMs);
      tls.destroy();
      return null;
    } catch (e) {
      sock?.destroy();
      if (e instanceof ProxyError) {
        return e.code === "refused" && port !== 443
          ? `${e.message} Some proxies only allow port 443; Flagship's relay uses ${port}.`
          : e.message;
      }
      return "The connection through the proxy failed.";
    }
  }

  /** The undici dispatcher that global `fetch` uses once hooked. */
  dispatcher(): Dispatcher {
    if (!this.undici) {
      this.undici = new UndiciAgent({
        connect: (o, cb) => {
          const host = o.hostname;
          const port = Number(o.port) || (o.protocol === "https:" ? 443 : 80);
          if (!this.setting || isDirectHost(host)) return this.directTls(o, cb);
          this.connectTcp(host, port)
            .then((raw): Promise<Socket> =>
              o.protocol === "https:"
                ? wrapTls(raw, { servername: o.servername || (isIP(host) ? undefined : host), ALPNProtocols: ["http/1.1"] })
                : Promise.resolve(raw),
            )
            .then((s) => cb(null, s), (e: Error) => cb(e, null));
        },
      });
    }
    return this.undici;
  }

  /** An `http.Agent` for `ws` and axios, or undefined when no proxy was ever set. */
  agentFor(url: string): HttpAgent | undefined {
    if (!this.hooked) return undefined;
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "wss:" ? this.httpsAgent() : this.httpAgent();
  }

  httpsAgent(): HttpsAgent {
    if (!this.https) this.https = new ProxyHttpsAgent(this, { keepAlive: true });
    return this.https;
  }

  httpAgent(): HttpAgent {
    if (!this.http) this.http = new ProxyHttpAgent(this, { keepAlive: true });
    return this.http;
  }

  /** Point global fetch (and whatever `hook` adds) at this object. Idempotent. */
  hook(extra?: (net: OutboundNet) => void): void {
    if (this.hooked) return;
    this.hooked = true;
    setGlobalDispatcher(this.dispatcher());
    extra?.(this);
  }

  isHooked(): boolean {
    return this.hooked;
  }

  private direct(host: string, port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const s = connect({ host, port });
      const t = setTimeout(() => {
        s.destroy();
        reject(new Error(`connect to ${host}:${port} timed out`));
      }, this.timeoutMs);
      s.once("connect", () => {
        clearTimeout(t);
        s.removeAllListeners("error");
        resolve(s);
      });
      s.once("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
  }

  private setState(state: OutboundState, lastError?: string): void {
    this.stat = { state, since: this.now(), ...(lastError ? { lastError } : {}) };
  }
}

function wrapTls(raw: Socket, opts: ConnectionOptions, timeoutMs = 15_000): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({ ...opts, socket: raw as Duplex as Socket });
    const t = setTimeout(() => {
      tls.destroy();
      reject(new Error("TLS handshake through the proxy timed out"));
    }, timeoutMs);
    tls.once("secureConnect", () => {
      clearTimeout(t);
      tls.removeAllListeners("error");
      resolve(tls);
    });
    tls.once("error", (e) => {
      clearTimeout(t);
      raw.destroy();
      reject(e);
    });
  });
}

type CreateCb = (err: Error | null, socket?: Duplex) => void;
interface AgentConnectOpts { host?: string | null; hostname?: string | null; port?: number | string | null; servername?: string }

function targetOf(o: AgentConnectOpts, defPort: number): { host: string; port: number } {
  const host = (o.hostname ?? o.host ?? "localhost").replace(/^\[|\]$/g, "");
  return { host, port: Number(o.port) || defPort };
}

const TLS_KEYS = [
  "servername", "ALPNProtocols", "ca", "cert", "key", "pfx", "passphrase",
  "rejectUnauthorized", "checkServerIdentity", "minVersion", "maxVersion", "session",
] as const satisfies readonly (keyof ConnectionOptions)[];

class ProxyHttpsAgent extends HttpsAgent {
  constructor(private readonly net: OutboundNet, opts: AgentOptions) {
    super(opts);
  }
  override createConnection(o: AgentConnectOpts & ConnectionOptions, cb: CreateCb): Duplex | undefined {
    const { host, port } = targetOf(o, 443);
    const tls: ConnectionOptions = {};
    for (const k of TLS_KEYS) {
      if (o[k] !== undefined) (tls as Record<string, unknown>)[k] = o[k];
    }
    this.net.connectTls(host, port, tls).then((s) => cb(null, s), (e: Error) => cb(e));
    return undefined;
  }
}

class ProxyHttpAgent extends HttpAgent {
  constructor(private readonly net: OutboundNet, opts: AgentOptions) {
    super(opts);
  }
  override createConnection(o: AgentConnectOpts, cb: CreateCb): Duplex | undefined {
    const { host, port } = targetOf(o, 80);
    // The proxied socket comes back paused (so no byte is lost before its
    // reader attaches); the http client attaches in `cb`, then we let it flow.
    this.net.connectTcp(host, port).then(
      (s) => {
        cb(null, s);
        process.nextTick(() => s.resume());
      },
      (e: Error) => cb(e),
    );
    return undefined;
  }
}

/** The box's one instance (tests build their own). */
export const outboundNet = new OutboundNet({ onLog: (m) => console.log(m) });
