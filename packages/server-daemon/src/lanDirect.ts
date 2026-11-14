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
 * Either way the TLS ClientHello must name the box or a name under it, or the
 * connection is dropped before the box presents a certificate.
 *
 * It binds ONLY to private interface addresses (`isLanAddress`) and skips
 * container/VM/VPN bridges, so a VPS with only a public address binds nothing
 * and a home box is never reachable from the internet through it.
 */
import net from "node:net";
import os from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { DEFAULT_SNI_LIMITS, parseClientHelloSni } from "@flagship/tunnel-protocol";
import {
  isLanAddress,
  isPublicAddress,
  signLanHint,
  LAN_HINT_MAX_TTL_MS,
  LAN_HINT_MAX_ENDPOINTS,
  type LanEndpoint,
  type LanHint,
} from "@flagship/protocol";
import type { LanIngressPorts } from "./lanIngress.js";

/** Interfaces that look private but aren't the user's LAN (`fs-` = the box's own sandbox bridges, egress/policy.ts). */
const VIRTUAL_IFACE = /^(docker|br-|fs-|veth|virbr|vnet|vmnet|cni|flannel|cali|lxc|lxd|podman|tailscale|wg|tun|tap|zt|utun)/i;

/** Every address of this host, bridges included (a source offering one of them is this box). */
export function hostAddresses(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  return Object.values(ifaces).flatMap((infos) => (infos ?? []).map((i) => i.address));
}

/**
 * A Linux bridge that carries only containers: it has no ports, or every port is a veth. A user's own LAN bridge
 * (`br0` over `eth0`) has a real NIC as a port and is kept. Catches a container bridge whatever its name (Podman
 * numbers its own `podmanN`, a netavark/CNI plugin may pick anything), so the listener never binds an address an
 * app container can reach as its gateway.
 */
export function isContainerBridge(name: string, sysNet = "/sys/class/net"): boolean {
  if (!/^[a-zA-Z0-9_.-]{1,15}$/.test(name)) return false;
  try {
    if (!existsSync(`${sysNet}/${name}/bridge`)) return false;
    const ports = readdirSync(`${sysNet}/${name}/brif`);
    return ports.every((p) => /^veth/i.test(p));
  } catch {
    return false;
  }
}

export function lanAddressesFromInterfaces(
  ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
  containerBridge: (name: string) => boolean = isContainerBridge,
): string[] {
  const out: string[] = [];
  for (const [name, infos] of Object.entries(ifaces)) {
    if (!infos || VIRTUAL_IFACE.test(name) || containerBridge(name)) continue;
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

/** Whether a TLS client asked for the box's own name or one under it: anything else (no SNI, an IP, a guess) is
 *  refused before the box presents a certificate, so a stranger on the LAN never reads the box's names from it. */
export function lanSniAllowed(sni: string | null, zone: string): boolean {
  if (!sni) return false;
  const h = sni.toLowerCase();
  const z = zone.toLowerCase();
  return h === z || h.endsWith(`.${z}`);
}

/** `FLAGSHIP_LAN_PORT`, or 443 when unset or not a usable port. */
export function lanPortFromEnv(v: string | undefined, log: (m: string) => void = (m) => console.warn(`[lan-direct] ${m}`)): number {
  if (v === undefined || v === "") return 443;
  const n = Number(v);
  if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  log(`FLAGSHIP_LAN_PORT=${JSON.stringify(v)} isn't a port; using 443`);
  return 443;
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
  /** Connections one source address may hold at once. */
  maxPerSource?: number;
  /** A tunnelled connection must show handshake progress (the box answered and the client replied) within this long. */
  handshakeTimeoutMs?: number;
  headerTimeoutMs?: number;
  idleTimeoutMs?: number;
  log?: (msg: string) => void;
  /** Where each connection to the TLS server is recorded while it lives, so the box can tell LAN from relay. */
  lanPorts?: LanIngressPorts;
  /**
   * `public`: the direct-access listener (directAccess.ts) on the box's public addresses; its connections are
   * never recorded as LAN. Default `lan`.
   */
  ingress?: "lan" | "public";
}

/**
 * Whether a connection the LAN listener accepted may count as LAN (rescue routes, docs/data-sovereignty.md). A public
 * IPv4 source reached a private address only through the owner's port forward (direct access over IPv4,
 * docs/direct-access-and-domains.md), so it is a visitor from the internet. IPv6 sources are kept: a ULA is not
 * routable from outside the site, and a phone on the LAN may well use its global address as the source.
 */
export function lanSourceCountsAsLan(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const v4 = remoteAddress.startsWith("::ffff:") ? remoteAddress.slice(7) : remoteAddress;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return true;
  return !isPublicAddress(v4);
}

export interface LanListener {
  /** Endpoints currently bound — what the signed hint advertises. */
  endpoints(): LanEndpoint[];
  close(): Promise<void>;
}

export async function startLanListener(o: LanListenerOptions): Promise<LanListener> {
  const listAddresses = o.listAddresses ?? (() => lanAddressesFromInterfaces(os.networkInterfaces()));
  const maxConnections = o.maxConnections ?? 256;
  const maxPerSource = o.maxPerSource ?? 32;
  const handshakeTimeoutMs = o.handshakeTimeoutMs ?? 20_000;
  const perSource = new Map<string, number>();
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
    // Everything on the LAN is one network, so a single host must not be able to fill the box's slots
    // (the phone's way to the box when the internet is down is exactly this listener).
    const source = client.remoteAddress ?? "?";
    const held = perSource.get(source) ?? 0;
    if (held >= maxPerSource) {
      client.destroy();
      return;
    }
    perSource.set(source, held + 1);
    open++;
    client.once("close", () => {
      open--;
      const left = (perSource.get(source) ?? 1) - 1;
      if (left <= 0) perSource.delete(source);
      else perSource.set(source, left);
    });
    client.on("error", () => client.destroy());
    client.setTimeout(headerTimeoutMs, () => client.destroy());

    let head = Buffer.alloc(0);
    let hello: Buffer | null = null;
    const gate = (): void => {
      if (hello === null || hello.length === 0) return;
      const r = parseClientHelloSni(hello);
      if (r.kind === "incomplete") {
        if (hello.length > DEFAULT_SNI_LIMITS.maxRawBytes) client.destroy();
        return;
      }
      if (r.kind === "error" || !lanSniAllowed(r.sni, o.zone)) {
        client.destroy();
        return;
      }
      pipe(hello);
    };
    const onData = (chunk: Buffer): void => {
      if (hello !== null) {
        hello = Buffer.concat([hello, chunk]);
        return gate();
      }
      head = Buffer.concat([head, chunk]);
      if (head[0] === 0x16) {
        hello = head;
        return gate();
      }
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
      hello = head.subarray(end + 4);
      gate();
    };
    const pipe = (initial: Buffer): void => {
      client.removeListener("data", onData);
      client.pause();
      // Slow-loris guard: a real handshake has the box answer and the client reply to that answer.
      let boxAnswered = false;
      let progressed = false;
      const handshake = setTimeout(() => {
        if (!progressed) client.destroy();
      }, handshakeTimeoutMs);
      handshake.unref();
      client.once("close", () => clearTimeout(handshake));
      client.on("data", () => {
        if (boxAnswered) progressed = true;
      });
      let forget: (() => void) | null = null;
      const upstream = net.connect(o.backendPort, "127.0.0.1", () => {
        // Recorded before the first byte reaches the TLS server, so the server never sees this connection unmarked.
        if (o.lanPorts && o.ingress !== "public" && lanSourceCountsAsLan(source) && typeof upstream.localPort === "number") {
          forget = o.lanPorts.add(upstream.localPort);
        }
        upstream.on("data", () => {
          boxAnswered = true;
        });
        client.setTimeout(idleTimeoutMs, () => client.destroy());
        if (initial.length > 0) upstream.write(initial);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
      upstream.on("error", () => client.destroy());
      client.once("close", () => upstream.destroy());
      upstream.once("close", () => {
        forget?.();
        client.destroy();
      });
    };
    client.on("data", onData);
  };

  // A failed bind is retried on every rescan; say so once per address and
  // reason, not every minute.
  const lastBindError = new Map<string, string>();
  const rescan = async (): Promise<void> => {
    if (closed) return;
    let want: Set<string>;
    try {
      want = new Set(listAddresses());
    } catch (e) {
      log(`cannot list network interfaces (${(e as Error).message}); staying on the relay`);
      return;
    }
    for (const [addr, srv] of servers) {
      if (!want.has(addr)) {
        srv.close();
        servers.delete(addr);
        lastBindError.delete(addr);
        log(`stopped listening on ${addr}`);
      }
    }
    for (const addr of want) {
      if (servers.has(addr)) continue;
      const srv = net.createServer(handle);
      const bound = await new Promise<boolean>((resolve) => {
        const fail = (e: unknown): void => {
          const why = String((e as NodeJS.ErrnoException).code ?? (e as Error).message ?? e);
          if (lastBindError.get(addr) !== why) log(`cannot listen on ${addr}:${o.port} (${why}); that address stays relay-only`);
          lastBindError.set(addr, why);
          srv.close();
          resolve(false);
        };
        srv.once("error", fail);
        try {
          srv.listen(o.port, addr, () => {
            srv.removeListener("error", fail);
            // Accept errors (EMFILE…) must never become an uncaught 'error'.
            srv.on("error", (e) => log(`listener on ${addr} failed (${(e as NodeJS.ErrnoException).code ?? e})`));
            resolve(true);
          });
        } catch (e) {
          fail(e);
        }
      });
      if (bound && !closed) {
        servers.set(addr, srv);
        lastBindError.delete(addr);
        log(`listening on ${addr.includes(":") ? `[${addr}]` : addr}:${o.port}`);
      } else if (bound) {
        srv.close();
      }
    }
  };

  await rescan();
  const timer = setInterval(() => void rescan().catch((e: Error) => log(`rescan failed (${e.message})`)), o.rescanMs ?? 60_000);
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
