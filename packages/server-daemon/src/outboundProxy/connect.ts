/**
 * Open a TCP stream to `host:port` through an HTTP CONNECT or SOCKS5 proxy
 * (docs/outbound-proxy.md). Names are always sent to the proxy, never resolved
 * here, so the box's resolver learns nothing (SOCKS5 with ATYP domain, i.e.
 * socks5h). Node built-ins only, so the loopback bridge and the daemon share
 * one implementation.
 */
import { connect, isIP, type Socket } from "node:net";

export interface ProxyUpstream {
  kind: "socks5" | "http";
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/**
 * - `unreachable`: no TCP connection to the proxy (refused, timed out, DNS).
 * - `auth`: the proxy refused the credentials (or wants some).
 * - `refused`: the proxy answered but won't make this connection.
 * - `protocol`: the proxy spoke something else.
 * Only `unreachable` and `auth` mean the proxy itself is down or misconfigured.
 */
export type ProxyErrorCode = "unreachable" | "auth" | "refused" | "protocol";

export class ProxyError extends Error {
  constructor(
    readonly code: ProxyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProxyError";
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REPLY = 16 * 1024;

export function openProxiedSocket(
  up: ProxyUpstream,
  host: string,
  port: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: up.host, port: up.port });
    let connected = false;
    let settled = false;
    let buf = Buffer.alloc(0);
    let step: (() => void) | null = null;

    const fail = (e: ProxyError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      reject(e);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.pause();
      sock.removeAllListeners("data");
      sock.removeAllListeners("error");
      sock.removeAllListeners("close");
      sock.setTimeout(0);
      if (buf.length > 0) sock.unshift(buf);
      resolve(sock);
    };
    const timer = setTimeout(
      () => fail(new ProxyError(connected ? "protocol" : "unreachable", connected ? "The proxy didn't answer." : "Can't reach the proxy.")),
      timeoutMs,
    );

    sock.on("error", () =>
      fail(connected ? new ProxyError("protocol", "The proxy closed the connection.") : new ProxyError("unreachable", "Can't reach the proxy.")),
    );
    sock.on("close", () => fail(new ProxyError(connected ? "protocol" : "unreachable", connected ? "The proxy closed the connection." : "Can't reach the proxy.")));
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length > MAX_REPLY) return fail(new ProxyError("protocol", "The proxy sent an unexpected reply."));
      step?.();
    });
    sock.once("connect", () => {
      connected = true;
      if (up.kind === "http") httpConnect();
      else socksGreet();
    });

    // ---- HTTP CONNECT ----
    const httpConnect = () => {
      const target = isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
      const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
      if (up.username !== undefined && up.password !== undefined) {
        const token = Buffer.from(`${up.username}:${up.password}`, "utf8").toString("base64");
        lines.push(`Proxy-Authorization: Basic ${token}`);
      }
      sock.write(`${lines.join("\r\n")}\r\n\r\n`);
      step = () => {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const status = /^HTTP\/1\.[01] (\d{3})/.exec(buf.subarray(0, end).toString("latin1"));
        buf = buf.subarray(end + 4);
        step = null;
        if (!status) return fail(new ProxyError("protocol", "The proxy sent an unexpected reply."));
        const code = Number(status[1]);
        if (code >= 200 && code < 300) return done();
        if (code === 407) return fail(new ProxyError("auth", "The proxy refused the username or password."));
        fail(new ProxyError("refused", `The proxy couldn't reach ${host}:${port} (HTTP ${code}).`));
      };
      step();
    };

    // ---- SOCKS5 (RFC 1928, username/password RFC 1929) ----
    const withAuth = up.username !== undefined && up.password !== undefined;
    const socksGreet = () => {
      sock.write(withAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]));
      step = () => {
        if (buf.length < 2) return;
        const [ver, method] = [buf[0], buf[1]];
        buf = buf.subarray(2);
        if (ver !== 0x05) return fail(new ProxyError("protocol", "That isn't a SOCKS5 proxy."));
        if (method === 0x00) return socksRequest();
        if (method === 0x02 && withAuth) return socksAuth();
        if (method === 0x02 || (method === 0xff && !withAuth)) {
          return fail(new ProxyError("auth", "The proxy needs a username and password."));
        }
        fail(new ProxyError("auth", "The proxy refused the username or password."));
      };
      step();
    };
    const socksAuth = () => {
      const u = Buffer.from(up.username ?? "", "utf8");
      const p = Buffer.from(up.password ?? "", "utf8");
      sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
      step = () => {
        if (buf.length < 2) return;
        const status = buf[1];
        buf = buf.subarray(2);
        if (status !== 0x00) return fail(new ProxyError("auth", "The proxy refused the username or password."));
        socksRequest();
      };
      step();
    };
    const socksRequest = () => {
      let addr: Buffer;
      if (isIP(host) === 4) {
        addr = Buffer.concat([Buffer.from([0x01]), Buffer.from(host.split(".").map(Number))]);
      } else if (isIP(host) === 6) {
        addr = Buffer.concat([Buffer.from([0x04]), ipv6Bytes(host)]);
      } else {
        const name = Buffer.from(host, "utf8");
        if (name.length > 255) return fail(new ProxyError("refused", "That host name is too long for SOCKS5."));
        addr = Buffer.concat([Buffer.from([0x03, name.length]), name]);
      }
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);
      sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addr, portBuf]));
      step = () => {
        if (buf.length < 5) return;
        if (buf[0] !== 0x05) return fail(new ProxyError("protocol", "The proxy sent an unexpected reply."));
        const atyp = buf[3];
        const len = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? 1 + buf[4]! : -1;
        if (len < 0) return fail(new ProxyError("protocol", "The proxy sent an unexpected reply."));
        if (buf.length < 4 + len + 2) return;
        const rep = buf[1]!;
        buf = buf.subarray(4 + len + 2);
        step = null;
        if (rep === 0x00) return done();
        fail(new ProxyError("refused", `The proxy couldn't reach ${host}:${port} (${SOCKS_REPLIES[rep] ?? `SOCKS error ${rep}`}).`));
      };
      step();
    };
  });
}

const SOCKS_REPLIES: Record<number, string> = {
  1: "general failure",
  2: "not allowed by the proxy's rules",
  3: "network unreachable",
  4: "host unreachable",
  5: "connection refused",
  6: "timed out",
  7: "command not supported",
  8: "address type not supported",
};

function ipv6Bytes(addr: string): Buffer {
  const [head, tail] = addr.includes("::") ? addr.split("::") : [addr, undefined];
  const parse = (s: string | undefined): number[] => {
    if (!s) return [];
    const out: number[] = [];
    for (const part of s.split(":")) {
      if (part.includes(".")) {
        const v4 = part.split(".").map(Number);
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else {
        out.push(parseInt(part, 16));
      }
    }
    return out;
  };
  const h = parse(head);
  const t = parse(tail);
  const groups = tail === undefined ? h : [...h, ...new Array(8 - h.length - t.length).fill(0), ...t];
  const b = Buffer.alloc(16);
  groups.forEach((g, i) => b.writeUInt16BE(g & 0xffff, i * 2));
  return b;
}
