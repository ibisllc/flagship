/**
 * Local-network discovery (docs/data-sovereignty.md): the owner's phone finds
 * its box on the Wi-Fi with no DNS, no `.com` and no typing.
 *
 * The box answers multicast DNS (RFC 6762) queries for the service type
 * `_flagship._tcp.local` with one instance whose name is an opaque id
 * (`rescueDiscoveryId`: a keyed hash of the server's name that only the box's
 * owner devices can recompute) and whose address records are the box's LAN
 * addresses at the LAN-direct port. The server's name, the account and the
 * owner appear nowhere in what is announced. A phone recomputes the id for
 * each of its servers, matches, connects to the address with the server's
 * name as SNI and checks the box by its key (`rescue.ts`), never by what the
 * announcement said.
 *
 * Failure is a no-op: if the socket cannot be bound (another responder owns
 * 5353 without SO_REUSEADDR, no multicast), the box logs once and carries on.
 */
import dgram from "node:dgram";
import os from "node:os";
import { isLanAddress, type LanEndpoint } from "@flagship/protocol";

export const DISCOVERY_SERVICE_TYPE = "_flagship._tcp.local";
const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_AAAA = 28;
const TYPE_SRV = 33;
const TYPE_ANY = 255;
const CLASS_IN = 1;
const CACHE_FLUSH = 0x8000;
const TTL_SECONDS = 120;
const MDNS_GROUP = "224.0.0.251";
const MDNS_PORT = 5353;

export interface Question {
  name: string;
  type: number;
  /** The QU bit: the asker wants a unicast reply. */
  unicast: boolean;
}

/** The questions of a DNS message, or null for anything that is not a plain query. */
export function parseQuestions(msg: Buffer): Question[] | null {
  if (msg.length < 12) return null;
  const flags = msg.readUInt16BE(2);
  if ((flags & 0x8000) !== 0) return null; // a response
  if (((flags >> 11) & 0xf) !== 0) return null; // not a standard query
  const qd = msg.readUInt16BE(4);
  if (qd === 0 || qd > 16) return null;
  const out: Question[] = [];
  let off = 12;
  for (let i = 0; i < qd; i++) {
    const n = readName(msg, off);
    if (!n || n.next + 4 > msg.length) return null;
    const type = msg.readUInt16BE(n.next);
    const cls = msg.readUInt16BE(n.next + 2);
    if ((cls & 0x7fff) === CLASS_IN || (cls & 0x7fff) === 255) out.push({ name: n.name.toLowerCase(), type, unicast: (cls & 0x8000) !== 0 });
    off = n.next + 4;
  }
  return out;
}

function readName(msg: Buffer, start: number): { name: string; next: number } | null {
  const labels: string[] = [];
  let off = start;
  let next = -1;
  for (let hops = 0; hops < 32; hops++) {
    if (off >= msg.length) return null;
    const len = msg[off]!;
    if (len === 0) {
      return { name: labels.join("."), next: next === -1 ? off + 1 : next };
    }
    if ((len & 0xc0) === 0xc0) {
      if (off + 1 >= msg.length) return null;
      if (next === -1) next = off + 2;
      off = ((len & 0x3f) << 8) | msg[off + 1]!;
      continue;
    }
    if ((len & 0xc0) !== 0 || off + 1 + len > msg.length) return null;
    labels.push(msg.subarray(off + 1, off + 1 + len).toString("latin1"));
    off += 1 + len;
  }
  return null;
}

function encodeName(name: string): Buffer {
  const parts: Buffer[] = [];
  for (const label of name.split(".")) {
    const b = Buffer.from(label, "latin1");
    if (b.length === 0 || b.length > 63) throw new Error("bad dns label");
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function record(name: string, type: number, rdata: Buffer, flush: boolean): Buffer {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(CLASS_IN | (flush ? CACHE_FLUSH : 0), 2);
  head.writeUInt32BE(TTL_SECONDS, 4);
  head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([encodeName(name), head, rdata]);
}

function ipv4(addr: string): Buffer | null {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(addr);
  return m ? Buffer.from(m.slice(1).map(Number)) : null;
}
function ipv6(addr: string): Buffer | null {
  if (!/^[0-9a-f:]+$/i.test(addr)) return null;
  const [head, tail] = addr.split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  if (fill < 0 || (tail === undefined && h.length !== 8)) return null;
  const groups = [...h, ...Array(fill).fill("0"), ...t];
  const b = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) b.writeUInt16BE(parseInt(groups[i]!, 16), i * 2);
  return b;
}

export interface Announcement {
  /** The opaque instance id (`rescueDiscoveryId`). */
  id: string;
  endpoints: LanEndpoint[];
}

const instanceName = (id: string) => `${id}.${DISCOVERY_SERVICE_TYPE}`;
const hostName = (id: string) => `${id}.local`;

/** The response to `questions`, or null when none of them is about this box. */
export function answerFor(a: Announcement, questions: Question[]): Buffer | null {
  const inst = instanceName(a.id);
  const host = hostName(a.id);
  const port = a.endpoints[0]?.port ?? 443;
  let wantAll = false;
  let wantAddr = false;
  for (const q of questions) {
    const any = q.type === TYPE_ANY;
    if (q.name === DISCOVERY_SERVICE_TYPE && (q.type === TYPE_PTR || any)) wantAll = true;
    if (q.name === inst && (any || q.type === TYPE_SRV || q.type === TYPE_TXT)) wantAll = true;
    if (q.name === host && (any || q.type === TYPE_A || q.type === TYPE_AAAA)) wantAddr = true;
  }
  if (!wantAll && !wantAddr) return null;
  const answers: Buffer[] = [];
  const extra: Buffer[] = [];
  if (wantAll) {
    answers.push(record(DISCOVERY_SERVICE_TYPE, TYPE_PTR, encodeName(inst), false));
    const srv = Buffer.alloc(6);
    srv.writeUInt16BE(0, 0);
    srv.writeUInt16BE(0, 2);
    srv.writeUInt16BE(port, 4);
    extra.push(record(inst, TYPE_SRV, Buffer.concat([srv, encodeName(host)]), true));
    const txt = ["v=1", `id=${a.id}`].map((s) => Buffer.concat([Buffer.from([s.length]), Buffer.from(s)]));
    extra.push(record(inst, TYPE_TXT, Buffer.concat(txt), true));
  }
  for (const e of a.endpoints) {
    if (!isLanAddress(e.address)) continue;
    const v4 = ipv4(e.address);
    const rr = v4 ? record(host, TYPE_A, v4, true) : (() => {
      const v6 = ipv6(e.address);
      return v6 ? record(host, TYPE_AAAA, v6, true) : null;
    })();
    if (!rr) continue;
    (wantAddr && !wantAll ? answers : extra).push(rr);
  }
  if (answers.length === 0) return null;
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(extra.length, 10);
  return Buffer.concat([header, ...answers, ...extra]);
}

export interface LanDiscovery {
  /** Resolves with the bound port once the socket is listening (rejects if it could not bind). */
  listening: Promise<number>;
  close(): void;
}

export interface LanDiscoveryOptions {
  id: string;
  endpoints: () => LanEndpoint[];
  /** Interface addresses to join the multicast group on (default: the LAN addresses). */
  interfaces?: () => string[];
  /** 0 binds an ephemeral port and joins nothing (tests). Default 5353. */
  port?: number;
  /** Accept queries from any source (tests). Default: LAN sources only. */
  anySource?: boolean;
  log?: (m: string) => void;
}

export function startLanDiscovery(o: LanDiscoveryOptions): LanDiscovery | null {
  const log = o.log ?? ((m: string) => console.log(`[lan-discovery] ${m}`));
  const port = o.port ?? MDNS_PORT;
  let sock: dgram.Socket;
  try {
    sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  } catch (e) {
    log(`cannot open a socket (${(e as Error).message}); not announcing`);
    return null;
  }
  let failBind: (e: Error) => void = () => {};
  const listening = new Promise<number>((resolve, reject) => {
    failBind = reject;
    sock.once("listening", () => resolve((sock.address() as import("node:net").AddressInfo).port));
  });
  listening.catch(() => {});
  sock.on("error", (e) => {
    failBind(e);
    log(`socket error (${(e as NodeJS.ErrnoException).code ?? e.message}); not announcing`);
  });
  sock.on("message", (msg, rinfo) => {
    try {
      if (!o.anySource && !isLanAddress(rinfo.address)) return;
      const qs = parseQuestions(msg);
      if (!qs) return;
      const res = answerFor({ id: o.id, endpoints: o.endpoints() }, qs);
      if (!res) return;
      const unicast = qs.some((q) => q.unicast) || rinfo.port !== MDNS_PORT;
      if (unicast) sock.send(res, rinfo.port, rinfo.address);
      else sock.send(res, MDNS_PORT, MDNS_GROUP);
    } catch (e) {
      log(`dropped a query (${(e as Error).message})`);
    }
  });
  sock.bind(port, () => {
    if (port === 0) return;
    try {
      const ifaces = (o.interfaces ?? (() => lanInterfaceAddresses()))();
      for (const i of ifaces) {
        try {
          sock.addMembership(MDNS_GROUP, i);
        } catch (e) {
          log(`cannot join the group on ${i} (${(e as NodeJS.ErrnoException).code ?? e})`);
        }
      }
      sock.setMulticastTTL(255);
      sock.setMulticastLoopback(false);
      log(`announcing ${o.id}`);
    } catch (e) {
      log(`cannot set up multicast (${(e as Error).message})`);
    }
  });
  return {
    listening,
    close: () => {
      try {
        sock.close();
      } catch {
        /* already closed */
      }
    },
  };
}

function lanInterfaceAddresses(): string[] {
  const out: string[] = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    if (/^(docker|br-|fs-|veth|virbr|vnet|vmnet|cni|flannel|cali|lxc|lxd|podman|tailscale|wg|tun|tap|zt|utun)/i.test(name)) continue;
    for (const i of infos ?? []) if (!i.internal && i.family === "IPv4" && isLanAddress(i.address)) out.push(i.address);
  }
  return out;
}

/** The address of `a` in the bytes of a response, for tests and the phone's own parser. */
export function describeResponse(msg: Buffer): { answers: number; additional: number } {
  return { answers: msg.readUInt16BE(6), additional: msg.readUInt16BE(10) };
}
