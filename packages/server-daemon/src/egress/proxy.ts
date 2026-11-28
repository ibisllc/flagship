/**
 * The egress gateway's transparent proxies. The firewall redirects a
 * container's outbound :443 to the TLS proxy and :80 to the HTTP proxy.
 * The TLS proxy reads the ClientHello's SNI, asks the policy once, and, if
 * allowed, splices the connection to THAT host; TLS stays end to end, so the
 * Host inside it is never seen or judged. The HTTP proxy terminates HTTP/1.x
 * and judges EVERY request by its own Host header, forwarding each allowed
 * request to its own upstream connection, so a keep-alive or pipelined
 * socket cannot reach a second host after a first allowed one. The original
 * destination IP is ignored on purpose: an allowed name can't be pointed at
 * another server, and the name must resolve to a public address that is not
 * one of the box's own (a name pointed at the box's public IP must not reach
 * its own listeners from inside a sandbox).
 */
import { lookup } from "node:dns/promises";
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, createServer, Socket, type Server } from "node:net";
import type { Duplex } from "node:stream";
import { networkInterfaces } from "node:os";
import { parseClientHelloSni } from "@flagship/tunnel-protocol";
import { isPublicAddress } from "./policy.js";

export type ProxyKind = "tls" | "http";

export interface ProxyDeps {
  allow: (srcIp: string, host: string) => boolean | Promise<boolean>;
  /** Resolve a host to the addresses to try. Default: the host's resolver. */
  resolve?: (host: string) => Promise<string[]>;
  /** Connect upstream. Default: net.connect. Tests point it at a local server. */
  dial?: (address: string, port: number) => Socket;
  /**
   * Connect to the allowed host BY NAME through the box's outbound proxy
   * (docs/outbound-proxy.md), after the public-address check. Returns null
   * when no proxy is set, and the gateway dials the address itself.
   */
  dialViaProxy?: (host: string, port: number) => Promise<Socket> | null;
  /** Refuse non-public upstream addresses and the host's own (default true). */
  publicOnly?: boolean;
  /** The host's own addresses. Default: every interface's, read per connection. */
  ownAddresses?: () => Iterable<string>;
  onDenied?: (srcIp: string, host: string | null, kind: ProxyKind) => void;
  /** Idle timeout per connection (default 10 min). */
  idleMs?: number;
  /** Told about each spliced connection, so a revoke can cut it. Returns an untrack. */
  track?: (conn: { src: string; host: string; close: () => void }) => () => void;
}

const MAX_HEAD = 16 * 1024;
const HEAD_TIMEOUT_MS = 10_000;

/** The Host header of an HTTP/1.x request head, without a port. */
export function parseHttpHost(head: string): string | null {
  const lines = head.split("\r\n");
  if (!/^[A-Z]+ \S+ HTTP\/1\.[01]$/.test(lines[0] ?? "")) return null;
  let host: string | null = null;
  for (const l of lines.slice(1)) {
    if (l === "") break;
    const m = /^host:[ \t]*(.*?)[ \t]*$/i.exec(l);
    if (!m) continue;
    if (host !== null) return null;
    host = m[1]!;
  }
  return host ? hostWithoutPort(host) : null;
}

function hostWithoutPort(host: string): string | null {
  const v = /^([^:\s]+)(?::(\d+))?$/.exec(host.trim());
  if (!v) return null;
  if (v[2] && v[2] !== "80") return null;
  return v[1]!;
}

/** The one Host of a parsed request, or null for none, a doubled one or another port. */
function requestHost(req: IncomingMessage): string | null {
  let host: string | null = null;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]!.toLowerCase() !== "host") continue;
    if (host !== null) return null;
    host = req.rawHeaders[i + 1]!;
  }
  return host ? hostWithoutPort(host) : null;
}

/** Every address on this host's interfaces, lower-cased, without a zone. */
export function hostOwnAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((infos) => (infos ?? []).map((i) => i.address.toLowerCase().replace(/%.*$/, "")));
}

export async function defaultResolve(host: string): Promise<string[]> {
  const all = await lookup(host, { all: true, verbatim: false });
  return all.map((a) => a.address);
}

function sourceOf(sock: { remoteAddress?: string | undefined }): string {
  return (sock.remoteAddress ?? "").replace(/^::ffff:/i, "");
}

export function handleProxyConnection(deps: ProxyDeps, client: Socket): void {
  const src = sourceOf(client);
  let buf = Buffer.alloc(0);
  let decided = false;
  client.on("error", () => {});
  const headTimer = setTimeout(() => client.destroy(), HEAD_TIMEOUT_MS);

  const deny = (host: string | null) => {
    decided = true;
    clearTimeout(headTimer);
    deps.onDenied?.(src, host, "tls");
    client.destroy();
  };

  const onData = (d: Buffer) => {
    if (decided) return;
    buf = Buffer.concat([buf, d]);
    const r = parseClientHelloSni(buf);
    if (r.kind === "incomplete") {
      if (r.needAtLeast > MAX_HEAD + 5) return deny(null);
      return;
    }
    const host = r.kind === "ok" ? r.sni : null;
    if (!host) return deny(null);
    decided = true;
    client.pause();
    client.off("data", onData);
    const head = buf;
    void Promise.resolve()
      .then(() => deps.allow(src, host))
      .catch(() => false)
      .then(async (ok) => {
        clearTimeout(headTimer);
        if (!ok) return deny(host);
        const upstream = await openUpstream(deps, "tls", src, host);
        if (!upstream) return void client.destroy();
        splice(deps, client, upstream, src, host, head);
      });
  };
  client.on("data", onData);
}

/** A socket to the allowed host on the kind's port, or null (onDenied already told) when there is none to use. */
async function openUpstream(deps: ProxyDeps, kind: ProxyKind, src: string, host: string): Promise<Socket | null> {
  const port = kind === "tls" ? 443 : 80;
  let addrs: string[];
  try {
    addrs = await (deps.resolve ?? defaultResolve)(host);
  } catch {
    return null;
  }
  if (deps.publicOnly !== false) {
    const own = new Set([...(deps.ownAddresses ?? hostOwnAddresses)()].map((a) => a.toLowerCase().replace(/^::ffff:/, "")));
    addrs = addrs.filter((a) => isPublicAddress(a) && !own.has(a.toLowerCase().replace(/^::ffff:/, "")));
  }
  const v4 = addrs.filter((a) => !a.includes(":"));
  const addr = v4[0] ?? addrs[0];
  if (!addr) {
    deps.onDenied?.(src, host, kind);
    return null;
  }
  const proxied = deps.dialViaProxy?.(host, port) ?? null;
  if (proxied) {
    try {
      return await proxied;
    } catch {
      return null;
    }
  }
  const upstream = (deps.dial ?? ((a, p) => connect({ host: a, port: p })))(addr, port);
  upstream.on("error", () => {});
  if (upstream.connecting) {
    const ok = await new Promise<boolean>((resolve) => {
      upstream.once("connect", () => resolve(true));
      upstream.once("error", () => resolve(false));
    });
    if (!ok) {
      upstream.destroy();
      return null;
    }
  }
  return upstream;
}

function splice(deps: ProxyDeps, client: Duplex, upstream: Socket, src: string, host: string, head: Buffer): void {
  const idle = deps.idleMs ?? 10 * 60_000;
  upstream.setTimeout(idle, () => upstream.destroy());
  if (client instanceof Socket) client.setTimeout(idle, () => client.destroy());
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  const untrack = deps.track?.({
    src,
    host,
    close: () => {
      client.destroy();
      upstream.destroy();
    },
  });
  if (untrack) client.once("close", untrack);
  if (head.length) upstream.write(head);
  client.pipe(upstream);
  upstream.pipe(client);
  client.resume();
  upstream.resume();
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authorization", "te", "trailer", "upgrade"]);

/** The request's headers for the upstream, hop-by-hop ones dropped (and those `Connection` names). */
function forwardHeaders(raw: string[], keepUpgrade: boolean): string[] {
  const named = new Set<string>();
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() === "connection") for (const t of raw[i + 1]!.split(",")) named.add(t.trim().toLowerCase());
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const k = raw[i]!.toLowerCase();
    const upgradeHeader = keepUpgrade && (k === "upgrade" || k === "connection");
    if (!upgradeHeader && (HOP_BY_HOP.has(k) || named.has(k))) continue;
    out.push(raw[i]!, raw[i + 1]!);
  }
  return out;
}

const DENIED_BODY = "This host is not allowed from this Flagship sandbox.";

function refuse(res: ServerResponse, status: number): void {
  res.shouldKeepAlive = false;
  res.writeHead(status, { "content-type": "text/plain", connection: "close", "content-length": Buffer.byteLength(DENIED_BODY) });
  res.end(DENIED_BODY);
}

async function judge(deps: ProxyDeps, src: string, req: IncomingMessage): Promise<string | null> {
  const host = requestHost(req);
  if (!host) {
    deps.onDenied?.(src, null, "http");
    return null;
  }
  const ok = await Promise.resolve()
    .then(() => deps.allow(src, host))
    .catch(() => false);
  if (!ok) {
    deps.onDenied?.(src, host, "http");
    return null;
  }
  return host;
}

async function forwardRequest(deps: ProxyDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const src = sourceOf(req.socket);
  req.pause();
  const host = await judge(deps, src, req);
  if (!host) return refuse(res, 403);
  const socket = await openUpstream(deps, "http", src, host);
  if (!socket) return refuse(res, 502);
  const headers = forwardHeaders(req.rawHeaders, false);
  headers.push("Connection", "close");
  const up = httpRequest({ method: req.method, path: req.url, headers, createConnection: () => socket, setHost: false }, (r) => {
    const back: string[] = [];
    for (let i = 0; i < r.rawHeaders.length; i += 2) {
      const k = r.rawHeaders[i]!.toLowerCase();
      if (k === "connection" || k === "keep-alive" || k === "proxy-connection") continue;
      back.push(r.rawHeaders[i]!, r.rawHeaders[i + 1]!);
    }
    res.writeHead(r.statusCode ?? 502, r.statusMessage, back);
    r.pipe(res);
  });
  const idle = deps.idleMs ?? 10 * 60_000;
  socket.setTimeout(idle, () => socket.destroy());
  const untrack = deps.track?.({
    src,
    host,
    close: () => {
      socket.destroy();
      req.socket.destroy();
    },
  });
  const done = () => {
    untrack?.();
    socket.destroy();
  };
  res.once("close", done);
  up.on("error", () => (res.headersSent ? res.destroy() : refuse(res, 502)));
  req.pipe(up);
  req.resume();
}

async function forwardUpgrade(deps: ProxyDeps, req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
  const src = sourceOf(req.socket);
  client.on("error", () => {});
  const fail = (status: number) => {
    client.end(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Bad Gateway"}\r\ncontent-type: text/plain\r\nconnection: close\r\ncontent-length: ${Buffer.byteLength(DENIED_BODY)}\r\n\r\n${DENIED_BODY}`);
  };
  const host = await judge(deps, src, req);
  if (!host) return fail(403);
  const upstream = await openUpstream(deps, "http", src, host);
  if (!upstream) return fail(502);
  const headers = forwardHeaders(req.rawHeaders, true);
  let lines = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
  for (let i = 0; i < headers.length; i += 2) lines += `${headers[i]}: ${headers[i + 1]}\r\n`;
  splice(deps, client, upstream, src, host, Buffer.concat([Buffer.from(lines + "\r\n", "latin1"), head]));
}

function startHttpProxy(deps: ProxyDeps): Server {
  const server = createHttpServer({ requireHostHeader: false, maxHeaderSize: MAX_HEAD });
  server.headersTimeout = HEAD_TIMEOUT_MS;
  server.requestTimeout = 0;
  server.timeout = deps.idleMs ?? 10 * 60_000;
  server.on("request", (req, res) => void forwardRequest(deps, req, res).catch(() => res.destroy()));
  server.on("upgrade", (req, sock, head) => void forwardUpgrade(deps, req, sock, head).catch(() => sock.destroy()));
  server.on("connect", (req: IncomingMessage, sock: Duplex) => {
    sock.on("error", () => {});
    deps.onDenied?.(sourceOf(req.socket), null, "http");
    sock.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
  });
  server.on("clientError", (err: NodeJS.ErrnoException, sock: Duplex) => {
    if (!sock.writable || err.code === "ECONNRESET" || err.code === "ERR_HTTP_REQUEST_TIMEOUT") return void sock.destroy();
    deps.onDenied?.(sourceOf(sock as Socket), null, "http");
    sock.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
  });
  return server;
}

export interface ProxyServerHandle {
  close(): Promise<void>;
}

export async function startProxyServer(
  deps: ProxyDeps,
  kind: ProxyKind,
  host: string,
  port: number,
): Promise<ProxyServerHandle> {
  const server: Server = kind === "http" ? startHttpProxy(deps) : createServer((sock) => handleProxyConnection(deps, sock));
  server.maxConnections = 1024;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/**
 * Plain TCP forward from a bridge gateway port to the same service on the
 * host's loopback (the data stores bind 127.0.0.1 only). Only sources the
 * caller accepts (the bridge's own containers) get through.
 */
export async function startTcpForwarder(
  host: string,
  port: number,
  target: { host: string; port: number } | (() => { host: string; port: number }),
  allowSrc: (srcIp: string) => boolean | Promise<boolean>,
): Promise<ProxyServerHandle & { port: number }> {
  const server: Server = createServer((client) => {
    client.on("error", () => {});
    const src = (client.remoteAddress ?? "").replace(/^::ffff:/i, "");
    const verdict = allowSrc(src);
    if (verdict === false) {
      client.destroy();
      return;
    }
    if (verdict !== true) {
      // A source the gateway has not seen yet (a container that just started): decided once it has looked again.
      client.pause();
      void verdict.then(
        (ok) => (ok ? open(client) : client.destroy()),
        () => client.destroy(),
      );
      return;
    }
    open(client);
  });
  function open(client: import("node:net").Socket): void {
    const up = connect(typeof target === "function" ? target() : target);
    up.on("error", () => client.destroy());
    client.on("close", () => up.destroy());
    up.on("close", () => client.destroy());
    client.pipe(up);
    up.pipe(client);
    client.resume();
  }
  server.maxConnections = 512;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const bound = server.address();
  return {
    port: typeof bound === "object" && bound ? bound.port : port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
