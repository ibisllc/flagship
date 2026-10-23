/**
 * A forward proxy the app browser connects through (SECURITY-HARDENING-PLAN.md 10.4). The judge resolves a
 * name and approves its addresses; CDP cannot make the browser connect to exactly those addresses, so a
 * name that answers differently a moment later (DNS rebinding) would slip through. This proxy closes it:
 * the browser never resolves anything, it asks the proxy for `host:port`, and the proxy connects ONLY to the
 * addresses the judge approved for that host a moment ago. A host nobody approved gets 403, and so does a
 * connection to loopback, link-local, metadata or any other address the caller marks never reachable.
 *
 * Each app's browser context gets its own proxy (`egress.ts`), so one app's approvals never open a host to
 * another; Chromium's own default proxy is one with no approvals at all, and its DNS is switched off.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import type { Duplex } from "node:stream";

export interface PinningProxyOptions {
  /** True for an address that may never be connected to, whatever was approved. */
  forbidden: (address: string) => boolean;
  now?: () => number;
  /** How long an approval lasts. */
  ttlMs?: number;
  /** Who may use the proxy, by the connecting address. Default: loopback only. */
  acceptFrom?: (remoteAddress: string) => boolean;
  /** Where to really connect for an approved address (tests map addresses to a local server). */
  dial?: (address: string, port: number) => { host: string; port: number };
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export class PinningProxy {
  private readonly approved = new Map<string, { addresses: string[]; until: number }>();
  private server: Server | null = null;
  private readonly now: () => number;
  private readonly ttl: number;

  constructor(private readonly o: PinningProxyOptions) {
    this.now = o.now ?? (() => Date.now());
    this.ttl = o.ttlMs ?? 60_000;
  }

  /** The judge allowed `host` with these addresses. */
  allow(host: string, addresses: string[]): void {
    if (this.approved.size > 4096) this.approved.delete(this.approved.keys().next().value!);
    this.approved.set(host.toLowerCase(), { addresses: [...addresses], until: this.now() + this.ttl });
  }

  /** Forget every approval (the app's grants ended). */
  clear(): void {
    this.approved.clear();
  }

  private accepts(remote: string | undefined): boolean {
    const r = remote ?? "";
    return this.o.acceptFrom ? this.o.acceptFrom(r) : LOOPBACK.has(r);
  }

  private target(address: string, port: number): { host: string; port: number } {
    return this.o.dial ? this.o.dial(address, port) : { host: address, port };
  }

  private pinned(host: string): string[] | null {
    const h = host.toLowerCase().replace(/^\[|\]$/g, "");
    const e = this.approved.get(h);
    if (!e || e.until < this.now()) return null;
    return e.addresses.filter((a) => !this.o.forbidden(a));
  }

  async listen(port = 0, host = "127.0.0.1"): Promise<number> {
    const server = createServer((req, res) => this.forward(req, res));
    server.on("connect", (req, socket, head) => this.tunnel(req, socket, head));
    await new Promise<void>((resolve) => server.listen(port, host, resolve));
    this.server = server;
    const a = server.address();
    return typeof a === "object" && a ? a.port : port;
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  private tunnel(req: IncomingMessage, client: Duplex, head: Buffer): void {
    const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(req.url ?? "");
    const refuse = () => {
      client.write("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
      client.destroy();
    };
    if (!m || !this.accepts(req.socket.remoteAddress)) return refuse();
    const host = m[1]!;
    const port = Number(m[2]);
    const addrs = this.pinned(host) ?? [];
    if (!addrs.length || port < 1 || port > 65535) return refuse();
    const upstream: Socket = netConnect(this.target(addrs[0]!, port));
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    upstream.on("error", () => (client.writable ? refuse() : end()));
    client.on("error", end);
    client.on("close", end);
    upstream.on("close", end);
  }

  private forward(req: IncomingMessage, res: ServerResponse): void {
    let u: URL;
    try {
      u = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const addrs = this.accepts(req.socket.remoteAddress) ? this.pinned(u.hostname) : null;
    if (u.protocol !== "http:" || !addrs?.length) {
      res.writeHead(403).end();
      return;
    }
    const port = u.port ? Number(u.port) : 80;
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    const to = this.target(addrs[0]!, port);
    const up = httpRequest({ host: to.host, port: to.port, method: req.method, path: u.pathname + u.search, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
    req.pipe(up);
  }
}
