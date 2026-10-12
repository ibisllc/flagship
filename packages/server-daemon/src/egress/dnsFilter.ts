/**
 * The egress gateway's filtering DNS server. Every DNS packet from the build,
 * staging and app bridges is redirected here (the firewall rewrites port 53).
 * A query for an allowed name is forwarded unchanged to the host's own
 * resolver; anything else gets NXDOMAIN without leaving the box, so a name
 * can't carry data out (`<secret>.attacker.example` never reaches attacker's
 * nameserver). AAAA for an allowed name gets an empty answer: the bridges are
 * IPv4-only, and a v6 address would only make clients stall before falling back.
 */
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { connect, createServer, type Server, type Socket } from "node:net";

export interface DnsQuestion {
  id: number;
  flags: number;
  name: string;
  qtype: number;
  qclass: number;
  /** Byte offset just past the question section. */
  questionEnd: number;
}

export const QTYPE_A = 1;
export const QTYPE_AAAA = 28;
export const RCODE_FORMERR = 1;
export const RCODE_SERVFAIL = 2;
export const RCODE_NXDOMAIN = 3;
export const RCODE_REFUSED = 5;

/** Parse a standard one-question query. Null for anything else. */
export function parseDnsQuery(buf: Uint8Array): DnsQuestion | null {
  if (buf.length < 12 || buf.length > 4096) return null;
  const id = (buf[0]! << 8) | buf[1]!;
  const flags = (buf[2]! << 8) | buf[3]!;
  if (flags & 0x8000) return null;
  if (((flags >> 11) & 0xf) !== 0) return null;
  const qd = (buf[4]! << 8) | buf[5]!;
  const an = (buf[6]! << 8) | buf[7]!;
  const ns = (buf[8]! << 8) | buf[9]!;
  if (qd !== 1 || an !== 0 || ns !== 0) return null;
  let p = 12;
  const labels: string[] = [];
  let nameLen = 0;
  for (;;) {
    if (p >= buf.length) return null;
    const len = buf[p]!;
    if (len === 0) {
      p++;
      break;
    }
    if (len > 63) return null;
    if (p + 1 + len > buf.length) return null;
    nameLen += len + 1;
    if (nameLen > 254) return null;
    let label = "";
    for (let i = 0; i < len; i++) {
      const c = buf[p + 1 + i]!;
      if (c <= 0x20 || c >= 0x7f || c === 0x2e) return null;
      label += String.fromCharCode(c);
    }
    labels.push(label.toLowerCase());
    p += 1 + len;
  }
  if (p + 4 > buf.length) return null;
  const qtype = (buf[p]! << 8) | buf[p + 1]!;
  const qclass = (buf[p + 2]! << 8) | buf[p + 3]!;
  return { id, flags, name: labels.join("."), qtype, qclass, questionEnd: p + 4 };
}

/** A header-plus-question reply with `rcode` and no records. */
export function dnsReply(query: Uint8Array, q: DnsQuestion | null, rcode: number): Buffer {
  const id = query.length >= 2 ? (query[0]! << 8) | query[1]! : 0;
  const reqFlags = query.length >= 4 ? (query[2]! << 8) | query[3]! : 0;
  const flags = 0x8000 | (reqFlags & 0x7900) | 0x0080 | (rcode & 0xf);
  const question = q ? Buffer.from(query.subarray(12, q.questionEnd)) : Buffer.alloc(0);
  const head = Buffer.alloc(12);
  head.writeUInt16BE(id, 0);
  head.writeUInt16BE(flags, 2);
  head.writeUInt16BE(q ? 1 : 0, 4);
  return Buffer.concat([head, question]);
}

export type DnsUpstream = (query: Buffer, transport: "udp" | "tcp") => Promise<Buffer>;

export interface DnsFilterDeps {
  /** May `srcIp` resolve `name`? */
  allow: (srcIp: string, name: string) => boolean | Promise<boolean>;
  upstream: DnsUpstream;
  onDenied?: (srcIp: string, name: string) => void;
}

/** One query → one reply. Never throws. */
export async function answerDnsQuery(
  deps: DnsFilterDeps,
  srcIp: string,
  query: Buffer,
  transport: "udp" | "tcp",
): Promise<Buffer> {
  const q = parseDnsQuery(query);
  if (!q) return dnsReply(query, null, RCODE_FORMERR);
  if (q.qclass !== 1) return dnsReply(query, q, RCODE_REFUSED);
  let allowed = false;
  try {
    allowed = q.name.length > 0 && (await deps.allow(srcIp, q.name));
  } catch {
    allowed = false;
  }
  if (!allowed) {
    deps.onDenied?.(srcIp, q.name);
    return dnsReply(query, q, RCODE_NXDOMAIN);
  }
  if (q.qtype === QTYPE_AAAA) return dnsReply(query, q, 0);
  try {
    const res = await deps.upstream(query, transport);
    if (res.length < 12 || res[0] !== query[0] || res[1] !== query[1]) return dnsReply(query, q, RCODE_SERVFAIL);
    return res;
  } catch {
    return dnsReply(query, q, RCODE_SERVFAIL);
  }
}

function hostPort(server: string): { host: string; port: number } {
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(server);
  if (v6) return { host: v6[1]!, port: v6[2] ? Number(v6[2]) : 53 };
  const v4 = /^([^:]+):(\d+)$/.exec(server);
  if (v4) return { host: v4[1]!, port: Number(v4[2]) };
  return { host: server, port: 53 };
}

/** Forward to the host's resolvers (`dns.getServers()`), trying each in turn. */
export function systemDnsUpstream(servers: () => string[], timeoutMs = 3000): DnsUpstream {
  return async (query, transport) => {
    const list = servers();
    let last: unknown = new Error("no upstream DNS servers");
    for (const s of list) {
      try {
        const { host, port } = hostPort(s);
        return transport === "udp" ? await udpOnce(host, port, query, timeoutMs) : await tcpOnce(host, port, query, timeoutMs);
      } catch (e) {
        last = e;
      }
    }
    throw last;
  };
}

function udpOnce(host: string, port: number, query: Buffer, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock = createSocket(host.includes(":") ? "udp6" : "udp4");
    const done = (e: Error | null, b?: Buffer) => {
      clearTimeout(timer);
      sock.close();
      if (e) reject(e);
      else resolve(b!);
    };
    const timer = setTimeout(() => done(new Error("upstream DNS timeout")), timeoutMs);
    sock.on("error", (e) => done(e));
    sock.on("message", (msg) => {
      if (msg.length >= 2 && msg[0] === query[0] && msg[1] === query[1]) done(null, msg);
    });
    sock.send(query, port, host);
  });
}

function tcpOnce(host: string, port: number, query: Buffer, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port });
    let buf = Buffer.alloc(0);
    const done = (e: Error | null, b?: Buffer) => {
      clearTimeout(timer);
      sock.destroy();
      if (e) reject(e);
      else resolve(b!);
    };
    const timer = setTimeout(() => done(new Error("upstream DNS timeout")), timeoutMs);
    sock.on("error", (e) => done(e));
    sock.on("connect", () => {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(query.length);
      sock.write(Buffer.concat([len, query]));
    });
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) done(null, buf.subarray(2, 2 + buf.readUInt16BE(0)));
    });
  });
}

export interface DnsServerHandle {
  close(): Promise<void>;
}

const MAX_INFLIGHT = 512;

/** Serve UDP + TCP DNS on `host:port`. */
export async function startDnsServer(deps: DnsFilterDeps, host: string, port: number): Promise<DnsServerHandle> {
  let inflight = 0;
  const udp: UdpSocket = createSocket({ type: "udp4", reuseAddr: false });
  udp.on("message", (msg, rinfo) => {
    if (inflight >= MAX_INFLIGHT) return;
    inflight++;
    void answerDnsQuery(deps, rinfo.address, msg, "udp")
      .then((res) => udp.send(res, rinfo.port, rinfo.address))
      .finally(() => inflight--);
  });
  await new Promise<void>((resolve, reject) => {
    udp.once("error", reject);
    udp.bind(port, host, () => {
      udp.off("error", reject);
      udp.on("error", () => {});
      resolve();
    });
  });

  const tcp: Server = createServer((sock: Socket) => {
    sock.setTimeout(10_000, () => sock.destroy());
    sock.on("error", () => {});
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length > 4098) return sock.destroy();
      while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
        const len = buf.readUInt16BE(0);
        const q = buf.subarray(2, 2 + len);
        buf = buf.subarray(2 + len);
        void answerDnsQuery(deps, sock.remoteAddress ?? "", Buffer.from(q), "tcp").then((res) => {
          const l = Buffer.alloc(2);
          l.writeUInt16BE(res.length);
          if (!sock.destroyed) sock.write(Buffer.concat([l, res]));
        });
      }
    });
  });
  tcp.maxConnections = 256;
  try {
    await new Promise<void>((resolve, reject) => {
      tcp.once("error", reject);
      tcp.listen(port, host, () => {
        tcp.off("error", reject);
        resolve();
      });
    });
  } catch (e) {
    udp.close();
    throw e;
  }
  return {
    close: () =>
      new Promise<void>((resolve) => {
        udp.close();
        tcp.close(() => resolve());
      }),
  };
}
