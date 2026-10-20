import { createServer, type Server, type Socket } from "node:net";

/**
 * "Which address did you reach me at?" (docs/relay-addresses.md).
 *
 * A phone that is told a relay address by `.com` asks that address this question over TLS
 * (Fly terminates it on the echo port with the app's own certificate). The answer is the
 * destination address Fly's PROXY-protocol header says the connection arrived at. A forwarder
 * that tunnels to the real relay has to dial the relay's own address, so the answer names that
 * address, not the one the phone dialed, and the phone drops it. The TLS certificate is what
 * stops a forwarder from answering for itself.
 *
 * The header comes before any HTTP bytes (Fly `proxy_proto` handler), so this is a plain TCP
 * server that strips it and then speaks one tiny HTTP reply.
 */

export interface ProxyHeader {
  src: string;
  dst: string;
  srcPort: number;
  dstPort: number;
}

const V2_SIGNATURE = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
const MAX_HEADER = 536;

/** Result of reading a PROXY header from the start of `buf`; null means "need more bytes". */
export function parseProxyHeader(buf: Buffer): { header: ProxyHeader | null; length: number } | null {
  if (buf.length >= 12 && buf.subarray(0, 12).equals(V2_SIGNATURE)) return parseV2(buf);
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "PROXY") return parseV1(buf);
  if (buf.length < 12) return null;
  throw new Error("not a PROXY header");
}

function parseV1(buf: Buffer): { header: ProxyHeader | null; length: number } | null {
  const end = buf.indexOf("\r\n");
  if (end < 0) {
    if (buf.length > 107) throw new Error("PROXY v1 header too long");
    return null;
  }
  const parts = buf.subarray(0, end).toString("latin1").split(" ");
  const length = end + 2;
  if (parts[1] === "UNKNOWN") return { header: null, length };
  if (parts.length !== 6 || (parts[1] !== "TCP4" && parts[1] !== "TCP6")) throw new Error("bad PROXY v1 header");
  return { header: { src: parts[2]!, dst: parts[3]!, srcPort: Number(parts[4]), dstPort: Number(parts[5]) }, length };
}

function ipv6(b: Buffer): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(b.readUInt16BE(i).toString(16));
  return groups.join(":");
}

function parseV2(buf: Buffer): { header: ProxyHeader | null; length: number } | null {
  if (buf.length < 16) return null;
  const len = buf.readUInt16BE(14);
  const total = 16 + len;
  if (total > MAX_HEADER) throw new Error("PROXY v2 header too long");
  if (buf.length < total) return null;
  if ((buf[12]! >> 4) !== 2) throw new Error("bad PROXY v2 version");
  const command = buf[12]! & 0x0f;
  const family = buf[13]! >> 4;
  const body = buf.subarray(16, total);
  if (command === 0) return { header: null, length: total };
  if (family === 1 && body.length >= 12) {
    return {
      header: {
        src: [...body.subarray(0, 4)].join("."),
        dst: [...body.subarray(4, 8)].join("."),
        srcPort: body.readUInt16BE(8),
        dstPort: body.readUInt16BE(10),
      },
      length: total,
    };
  }
  if (family === 2 && body.length >= 36) {
    return {
      header: {
        src: ipv6(body.subarray(0, 16)),
        dst: ipv6(body.subarray(16, 32)),
        srcPort: body.readUInt16BE(32),
        dstPort: body.readUInt16BE(34),
      },
      length: total,
    };
  }
  return { header: null, length: total };
}

export function echoBody(header: ProxyHeader | null): string {
  return JSON.stringify({ relay: "flagship.services", reachedAt: header?.dst ?? null, reachedPort: header?.dstPort ?? null });
}

const HEADER_TIMEOUT_MS = 5_000;

export interface RunningRelayEcho {
  port: number;
  close(): Promise<void>;
}

export async function startRelayEcho(opts: { port: number; host?: string }): Promise<RunningRelayEcho> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => sock.destroy());
    sock.setTimeout(HEADER_TIMEOUT_MS, () => sock.destroy());
    let buf = Buffer.alloc(0);
    let header: ProxyHeader | null | undefined;
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_HEADER + 4096) return void sock.destroy();
      try {
        if (header === undefined) {
          const got = parseProxyHeader(buf);
          if (!got) return;
          header = got.header;
          buf = buf.subarray(got.length);
        }
      } catch {
        return void sock.destroy();
      }
      if (!buf.includes("\r\n\r\n") && !buf.includes("\n\n")) return;
      const body = echoBody(header);
      sock.end(
        `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncache-control: no-store\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "0.0.0.0", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
