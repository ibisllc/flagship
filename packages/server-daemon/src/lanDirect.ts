/**
 * LAN-direct listener (docs/lan-direct.md).
 *
 * The box's TLS server binds only to loopback; the relay tunnel delivers every
 * connection into it. This listener lets a device on the SAME local network
 * reach that server without the relay. It is a byte forwarder, not a second
 * server: whatever arrives is piped into the same loopback TLS listener the
 * tunnel feeds, so certificates, SNI routing, auth and service access behave
 * exactly as they do over the relay. Two framings are accepted on the LAN port:
 *
 *   - raw TLS (first byte 0x16) — a client that resolved the box hostname to
 *     the LAN address itself (Android's OkHttp `Dns`);
 *   - an HTTP `CONNECT <host>:443` for a host in the box's own zone, answered
 *     with 200 and then piped — a client that can only point its HTTP stack
 *     at a proxy (iOS URLSession `proxyConfigurations`).
 *
 * It binds ONLY to private interface addresses (`isLanAddress`) and skips
 * container/VM/VPN bridges, so a VPS with only a public address binds nothing
 * and a home box is never reachable from the internet through it.
 */
import net from "node:net";
import os from "node:os";
import { X509Certificate } from "node:crypto";
import {
  isLanAddress,
  signLanHint,
  LAN_HINT_MAX_TTL_MS,
  LAN_HINT_MAX_ENDPOINTS,
  type LanEndpoint,
  type LanHint,
} from "@flagship/protocol";

/** Interfaces that look private but aren't the user's LAN. */
const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|vnet|vmnet|cni|flannel|cali|lxc|lxd|podman|tailscale|wg|tun|tap|zt|utun)/i;

export function lanAddressesFromInterfaces(
  ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): string[] {
  const out: string[] = [];
  for (const [name, infos] of Object.entries(ifaces)) {
    if (!infos || VIRTUAL_IFACE.test(name)) continue;
    for (const i of infos) {
      if (i.internal) continue;
      if (isLanAddress(i.address) && !out.includes(i.address)) out.push(i.address);
    }
  }
  return out.slice(0, LAN_HINT_MAX_ENDPOINTS);
}

/** The CONNECT target, if `head` is a complete CONNECT request for a host in
 *  `zone` on port 443; otherwise why it was refused. */
export function parseConnectRequest(
  head: string,
  zone: string,
): { ok: true; host: string } | { ok: false; status: number } {
  const line = head.split("\r\n", 1)[0] ?? "";
  const m = /^CONNECT ([^\s:]+):(\d+) HTTP\/1\.[01]$/.exec(line);
  if (!m) return { ok: false, status: 400 };
  const host = m[1]!.toLowerCase();
  const z = zone.toLowerCase();
  if (m[2] !== "443") return { ok: false, status: 403 };
  if (host !== z && !host.endsWith(`.${z}`)) return { ok: false, status: 403 };
  return { ok: true, host };
}

export interface LanListenerOptions {
  /** Port to listen on at each LAN address (443 keeps client URLs unchanged). */
  port: number;
  /** The loopback TLS server the tunnel also feeds. */
  backendPort: number;
  /** The box's own FQDN; CONNECT is allowed only into `zone` and `*.zone`. */
  zone: string;
  listAddresses?: () => string[];
  rescanMs?: number;
  maxConnections?: number;
  headerTimeoutMs?: number;
  idleTimeoutMs?: number;
  log?: (msg: string) => void;
}

export interface LanListener {
  /** Endpoints currently bound — what the signed hint advertises. */
  endpoints(): LanEndpoint[];
  close(): Promise<void>;
}

export async function startLanListener(o: LanListenerOptions): Promise<LanListener> {
  const listAddresses = o.listAddresses ?? (() => lanAddressesFromInterfaces(os.networkInterfaces()));
  const maxConnections = o.maxConnections ?? 256;
  const headerTimeoutMs = o.headerTimeoutMs ?? 5_000;
  const idleTimeoutMs = o.idleTimeoutMs ?? 5 * 60_000;
  const log = o.log ?? ((m: string) => console.log(`[lan-direct] ${m}`));
  const servers = new Map<string, net.Server>();
  let open = 0;
  let closed = false;

  const handle = (client: net.Socket): void => {
    if (open >= maxConnections) {
      client.destroy();
      return;
    }
    open++;
    client.once("close", () => open--);
    client.on("error", () => client.destroy());
    client.setTimeout(headerTimeoutMs, () => client.destroy());

    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      if (head[0] === 0x16) return pipe(head);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > 4096) client.destroy();
        return;
      }
      const parsed = parseConnectRequest(head.subarray(0, end).toString("latin1"), o.zone);
      if (!parsed.ok) {
        client.removeListener("data", onData);
        client.end(`HTTP/1.1 ${parsed.status} ${parsed.status === 403 ? "Forbidden" : "Bad Request"}\r\n\r\n`);
        return;
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      pipe(head.subarray(end + 4));
    };
    const pipe = (initial: Buffer): void => {
      client.removeListener("data", onData);
      client.pause();
      const upstream = net.connect(o.backendPort, "127.0.0.1", () => {
        client.setTimeout(idleTimeoutMs, () => client.destroy());
        if (initial.length > 0) upstream.write(initial);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
      upstream.on("error", () => client.destroy());
      client.once("close", () => upstream.destroy());
      upstream.once("close", () => client.destroy());
    };
    client.on("data", onData);
  };

  const rescan = async (): Promise<void> => {
    if (closed) return;
    const want = new Set(listAddresses());
    for (const [addr, srv] of servers) {
      if (!want.has(addr)) {
        srv.close();
        servers.delete(addr);
        log(`stopped listening on ${addr}`);
      }
    }
    for (const addr of want) {
      if (servers.has(addr)) continue;
      const srv = net.createServer(handle);
      const bound = await new Promise<boolean>((resolve) => {
        srv.once("error", (e) => {
          log(`cannot listen on ${addr}:${o.port} (${(e as NodeJS.ErrnoException).code ?? e})`);
          resolve(false);
        });
        srv.listen(o.port, addr, () => resolve(true));
      });
      if (bound) {
        servers.set(addr, srv);
        log(`listening on ${addr.includes(":") ? `[${addr}]` : addr}:${o.port}`);
      }
    }
  };

  await rescan();
  const timer = setInterval(() => void rescan(), o.rescanMs ?? 60_000);
  timer.unref();

  return {
    endpoints: () =>
      [...servers.entries()].map(([address, srv]) => {
        const a = srv.address();
        return { address, port: a && typeof a === "object" ? a.port : o.port };
      }),
    close: async () => {
      closed = true;
      clearInterval(timer);
      await Promise.all([...servers.values()].map((s) => new Promise<void>((r) => s.close(() => r()))));
      servers.clear();
    },
  };
}

/** Leaf-cert fingerprint exactly as the daemon-status report computes it. */
export function leafCertSha256(certPem: string): string | null {
  try {
    const fp = new X509Certificate(certPem).fingerprint256.replace(/:/g, "").toLowerCase();
    return /^[0-9a-f]{64}$/.test(fp) ? fp : null;
  } catch {
    return null;
  }
}

/** The signed hint the paired-device API serves, or null when there is
 *  nothing honest to say (no LAN address bound, or no cert to pin). */
export function buildSignedLanHint(args: {
  serverDomain: string;
  certPem: string | null;
  endpoints: LanEndpoint[];
  sign: (msg: Uint8Array) => Uint8Array;
  now?: number;
  ttlMs?: number;
}): { hint: LanHint; signatureHex: string } | null {
  if (args.endpoints.length === 0 || !args.certPem) return null;
  const certSha256 = leafCertSha256(args.certPem);
  if (!certSha256) return null;
  const now = args.now ?? Date.now();
  const hint: LanHint = {
    serverDomain: args.serverDomain,
    certSha256,
    endpoints: args.endpoints.slice(0, LAN_HINT_MAX_ENDPOINTS),
    issuedAt: now,
    expiresAt: now + Math.min(args.ttlMs ?? 6 * 60 * 60_000, LAN_HINT_MAX_TTL_MS),
  };
  return { hint, signatureHex: Buffer.from(signLanHint(hint, args.sign)).toString("hex") };
}
