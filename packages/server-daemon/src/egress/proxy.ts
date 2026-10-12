/**
 * The egress gateway's transparent TCP proxies. The firewall redirects a
 * container's outbound :443 to the TLS proxy and :80 to the HTTP proxy; each
 * reads just enough of the stream to learn the host (the ClientHello's SNI,
 * the request's Host header), asks the policy, and, if allowed, connects to
 * THAT host by name from the host network and splices the two sockets. TLS
 * stays end to end; the gateway never terminates it. The original destination
 * IP is ignored on purpose: an allowed name can't be pointed at another
 * server, and the name must resolve to a public address.
 */
import { lookup } from "node:dns/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { parseClientHelloSni } from "@flagship/tunnel-protocol";
import { isPublicAddress } from "./policy.js";

export type ProxyKind = "tls" | "http";

export interface ProxyDeps {
  allow: (srcIp: string, host: string) => boolean | Promise<boolean>;
  /** Resolve a host to the addresses to try. Default: the host's resolver. */
  resolve?: (host: string) => Promise<string[]>;
  /** Connect upstream. Default: net.connect. Tests point it at a local server. */
  dial?: (address: string, port: number) => Socket;
  /** Refuse non-public upstream addresses (default true). */
  publicOnly?: boolean;
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
  if (!host) return null;
  const v = /^([^:\s]+)(?::(\d+))?$/.exec(host);
  if (!v) return null;
  if (v[2] && v[2] !== "80") return null;
  return v[1]!;
}

export async function defaultResolve(host: string): Promise<string[]> {
  const all = await lookup(host, { all: true, verbatim: false });
  return all.map((a) => a.address);
}

export function handleProxyConnection(deps: ProxyDeps, kind: ProxyKind, client: Socket): void {
  const src = (client.remoteAddress ?? "").replace(/^::ffff:/i, "");
  let buf = Buffer.alloc(0);
  let decided = false;
  client.on("error", () => {});
  const headTimer = setTimeout(() => client.destroy(), HEAD_TIMEOUT_MS);

  const deny = (host: string | null) => {
    decided = true;
    clearTimeout(headTimer);
    deps.onDenied?.(src, host, kind);
    if (kind === "http") {
      client.end("HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\ncontent-length: 52\r\n\r\nThis host is not allowed from this Flagship sandbox.");
    } else {
      client.destroy();
    }
  };

  const onData = (d: Buffer) => {
    if (decided) return;
    buf = Buffer.concat([buf, d]);
    let host: string | null | undefined;
    if (kind === "tls") {
      const r = parseClientHelloSni(buf);
      if (r.kind === "incomplete") {
        if (r.needAtLeast > MAX_HEAD + 5) return deny(null);
        return;
      }
      host = r.kind === "ok" ? r.sni : null;
    } else {
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buf.length > MAX_HEAD) return deny(null);
        return;
      }
      host = parseHttpHost(buf.subarray(0, end).toString("latin1"));
    }
    if (!host) return deny(null);
    decided = true;
    client.pause();
    client.off("data", onData);
    const name = host;
    const head = buf;
    void Promise.resolve()
      .then(() => deps.allow(src, name))
      .catch(() => false)
      .then((ok) => {
        clearTimeout(headTimer);
        if (!ok) return deny(name);
        return splice(deps, kind, client, name, head);
      });
  };
  client.on("data", onData);
}

async function splice(deps: ProxyDeps, kind: ProxyKind, client: Socket, host: string, head: Buffer): Promise<void> {
  const port = kind === "tls" ? 443 : 80;
  let addrs: string[];
  try {
    addrs = await (deps.resolve ?? defaultResolve)(host);
  } catch {
    client.destroy();
    return;
  }
  if (deps.publicOnly !== false) addrs = addrs.filter(isPublicAddress);
  const v4 = addrs.filter((a) => !a.includes(":"));
  const addr = v4[0] ?? addrs[0];
  if (!addr) {
    deps.onDenied?.(client.remoteAddress ?? "", host, kind);
    client.destroy();
    return;
  }
  const upstream = (deps.dial ?? ((a, p) => connect({ host: a, port: p })))(addr, port);
  const idle = deps.idleMs ?? 10 * 60_000;
  upstream.setTimeout(idle, () => upstream.destroy());
  client.setTimeout(idle, () => client.destroy());
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  const untrack = deps.track?.({
    src: (client.remoteAddress ?? "").replace(/^::ffff:/i, ""),
    host,
    close: () => {
      client.destroy();
      upstream.destroy();
    },
  });
  if (untrack) client.once("close", untrack);
  upstream.once("connect", () => {
    upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  });
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
  const server: Server = createServer((sock) => handleProxyConnection(deps, kind, sock));
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
  target: { host: string; port: number },
  allowSrc: (srcIp: string) => boolean,
): Promise<ProxyServerHandle> {
  const server: Server = createServer((client) => {
    client.on("error", () => {});
    const src = (client.remoteAddress ?? "").replace(/^::ffff:/i, "");
    if (!allowSrc(src)) {
      client.destroy();
      return;
    }
    const up = connect(target);
    up.on("error", () => client.destroy());
    client.on("close", () => up.destroy());
    up.on("close", () => client.destroy());
    client.pipe(up);
    up.pipe(client);
  });
  server.maxConnections = 512;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
