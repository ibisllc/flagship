import { BlockList, connect as netConnect, isIP, type Socket } from "node:net";
import { promises as dns } from "node:dns";
import { KNOWN_AI_HOSTS as KNOWN_PROVIDER_HOSTS, KnownHostsPolicy, type HostPolicy } from "./outboundHostPolicy.js";
import {
  closeFrame,
  dataFrame,
  FRAME_CLOSE,
  FRAME_CLOSE_REMOTE,
  FRAME_DATA,
  FRAME_OUTBOUND_CREDIT,
  FRAME_OUTBOUND_OPEN,
  isOutboundStreamId,
  OUTBOUND_INITIAL_WINDOW,
  OUTBOUND_MAX_CHUNK,
  outboundCreditFrame,
  outboundResultFrame,
  parseOutboundCredit,
  parseOutboundOpen,
  type Frame,
  type OutboundRefusal,
} from "@flagship/tunnel-protocol";

/**
 * The hub side of box-initiated outbound streams (docs/ai-privacy-and-staging.md
 * §4). An authenticated box asks for `host:443`; the hub resolves the name,
 * refuses anything that isn't a public unicast address (no SSRF into Fly's
 * private network or the machine itself), connects, and splices bytes under
 * the credit window from `@flagship/tunnel-protocol`. The box runs TLS end to
 * end with the destination, so the hub only ever sees ciphertext.
 *
 * It logs only totals across every box, every 15 minutes: streams per
 * destination, bytes and refusals by reason. A per-call line (host, size, a
 * timestamp) could be matched to one box's activity, so there is none. Known
 * AI providers are counted by name; any other host only as "other", because
 * a rare host (someone's own model server) would identify them even in a
 * total. No box, content or key is ever logged.
 */

/** Provider API hosts counted by name; a suffix entry covers a whole zone. */
const KNOWN_AI_HOSTS: ReadonlyArray<[match: string, label: string]> = [
  ["api.openai.com", "api.openai.com"],
  ["api.anthropic.com", "api.anthropic.com"],
  ["generativelanguage.googleapis.com", "generativelanguage.googleapis.com"],
  ["aiplatform.googleapis.com", "vertex-ai"],
  ["openrouter.ai", "openrouter.ai"],
  ["api.mistral.ai", "api.mistral.ai"],
  ["api.groq.com", "api.groq.com"],
  ["api.together.xyz", "api.together.xyz"],
  ["api.deepseek.com", "api.deepseek.com"],
  ["api.x.ai", "api.x.ai"],
  ["api.fireworks.ai", "api.fireworks.ai"],
  ["api.perplexity.ai", "api.perplexity.ai"],
  ["api.cohere.com", "api.cohere.com"],
  ["api.cerebras.ai", "api.cerebras.ai"],
  ["router.huggingface.co", "huggingface"],
  [".openai.azure.com", "azure-openai"],
  [".amazonaws.com", "aws"],
];

/** The name a destination is counted under in the totals. */
export function destinationLabel(host: string): string {
  const h = host.toLowerCase();
  for (const [match, label] of KNOWN_AI_HOSTS) {
    if (match.startsWith(".") ? h.endsWith(match) : h === match) return label;
  }
  return "other";
}
export interface OutboundRelayOptions {
  /** Concurrent outbound streams per box on this machine. Default 8. */
  maxStreamsPerBox?: number;
  /** New outbound opens per box per minute. Default 120. */
  opensPerMinute?: number;
  /**
   * Hosts a box may ask about for the first time (not a known provider) per hour. A box that is
   * only a harness asks about a handful; more is a box spending `.com`'s requests on made-up
   * names, and is refused here without asking. Default 10.
   */
  newHostsPerHour?: number;
  /** Sustained bytes/second per box, both directions combined. Default 4 MiB/s. */
  bytesPerSecond?: number;
  /** Bucket size for `bytesPerSecond`. Default 16 MiB. */
  burstBytes?: number;
  /** Default 10 s. */
  connectTimeoutMs?: number;
  /** Close an upstream that moves no bytes for this long. Default 5 min. */
  idleTimeoutMs?: number;
  /** Default [443]. */
  allowedPorts?: readonly number[];
  /** Test seam: name → addresses (default: the system resolver, all records). */
  resolve?: (host: string) => Promise<string[]>;
  /** Test seam: open the TCP connection to an already-vetted address. */
  connect?: (address: string, port: number) => Socket;
  /** Which hosts may be reached (docs/outbound-hosts.md). Default: the known AI providers only. */
  hostPolicy?: HostPolicy;
  /** Default console.log. */
  log?: (line: string) => void;
  /** How often the totals are logged. Default 15 min; 0 = only via flushStats(). */
  statsIntervalMs?: number;
  now?: () => number;
}

interface HostTotals {
  streams: number;
  up: number;
  down: number;
  refused: number;
}

/** Hosts totalled per flush; more than this in 15 minutes are not counted by name. */
const MAX_HOSTS_PER_FLUSH = 500;

interface RelayStats {
  byHost: Map<string, HostTotals>;
  streams: number;
  byDestination: Map<string, number>;
  up: number;
  down: number;
  refused: Map<string, number>;
}

export interface OutboundSession {
  /** Handle an outbound-space frame. Returns false when it isn't one. */
  handleFrame(f: Frame): boolean;
  /** The tunnel closed: drop every upstream without telling the box. */
  close(): void;
  activeStreams(): number;
}

const DEFAULTS = {
  maxStreamsPerBox: 8,
  opensPerMinute: 120,
  newHostsPerHour: 10,
  bytesPerSecond: 4 * 1024 * 1024,
  burstBytes: 16 * 1024 * 1024,
  connectTimeoutMs: 10_000,
  idleTimeoutMs: 5 * 60_000,
  allowedPorts: [443] as readonly number[],
};

type ResolvedOptions = typeof DEFAULTS & {
  resolve: (host: string) => Promise<string[]>;
  connect: (address: string, port: number) => Socket;
  hostPolicy: HostPolicy;
  log: (line: string) => void;
  now: () => number;
  stats: RelayStats;
};

function emptyStats(): RelayStats {
  return { byHost: new Map(), streams: 0, byDestination: new Map(), up: 0, down: 0, refused: new Map() };
}

export class OutboundRelay {
  private readonly o: ResolvedOptions;
  private readonly budgets = new Map<string, BoxBudget>();

  constructor(opts: OutboundRelayOptions = {}) {
    this.o = {
      maxStreamsPerBox: opts.maxStreamsPerBox ?? DEFAULTS.maxStreamsPerBox,
      opensPerMinute: opts.opensPerMinute ?? DEFAULTS.opensPerMinute,
      newHostsPerHour: opts.newHostsPerHour ?? DEFAULTS.newHostsPerHour,
      bytesPerSecond: opts.bytesPerSecond ?? DEFAULTS.bytesPerSecond,
      burstBytes: opts.burstBytes ?? DEFAULTS.burstBytes,
      connectTimeoutMs: opts.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs,
      idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
      allowedPorts: opts.allowedPorts ?? DEFAULTS.allowedPorts,
      resolve: opts.resolve ?? systemResolve,
      connect: opts.connect ?? ((address, port) => netConnect({ host: address, port })),
      hostPolicy: opts.hostPolicy ?? new KnownHostsPolicy(),
      log: opts.log ?? ((line) => console.log(line)),
      now: opts.now ?? (() => Date.now()),
      stats: emptyStats(),
    };
    const every = opts.statsIntervalMs ?? 15 * 60_000;
    if (every > 0) setInterval(() => this.flushStats(), every).unref();
  }

  /** Log and reset the totals since the last flush; nothing when idle. */
  flushStats(): string | null {
    const t = this.o.stats;
    if (t.streams === 0 && t.refused.size === 0) return null;
    const list = (m: Map<string, number>) =>
      [...m].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k}:${n}`).join(",");
    const to = list(t.byDestination);
    const refused = list(t.refused);
    const line =
      `[outbound-relay] streams=${t.streams}${to ? ` to=${to}` : ""} up=${t.up} down=${t.down}` +
      (refused ? ` refused=${refused}` : "");
    this.o.log(line);
    // Per-host totals go to `.com` (docs/outbound-hosts.md): a host and counts across every
    // box, with nothing that names one.
    const rows = [...t.byHost].map(([host, v]) => ({ host, ...v }));
    if (rows.length > 0) void this.o.hostPolicy.report(rows).catch(() => {});
    this.o.stats = emptyStats();
    return line;
  }

  /**
   * One session per authenticated tunnel. Budgets are keyed by the box's
   * verified pod canonical, so a box can't widen its limits by opening more
   * WebSockets to the same machine.
   */
  session(podCanonical: string, send: (f: Frame) => void): OutboundSession {
    const key = podCanonical.toLowerCase();
    let budget = this.budgets.get(key);
    if (!budget) {
      budget = new BoxBudget(this.o.bytesPerSecond, this.o.burstBytes, this.o.opensPerMinute, this.o.newHostsPerHour, this.o.now);
      this.budgets.set(key, budget);
    }
    budget.sessions += 1;
    const b = budget;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      b.sessions -= 1;
      if (b.sessions === 0 && b.streams === 0) this.budgets.delete(key);
    };
    return new HubOutboundSession(send, this.o, b, release);
  }
}

/* ------------------------------------------------------------------ */
/*  Destination policy                                                 */
/* ------------------------------------------------------------------ */

const LABEL = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;
const FORBIDDEN_SUFFIXES = [".localhost", ".local", ".internal", ".flycast", ".lan", ".home.arpa", ".localdomain"];

/**
 * A destination must be a public DNS name: no IP literals (in any spelling
 * the resolver would accept), no single-label names, no names reserved for
 * local or Fly-private use. Returns the lowercased name or null.
 */
export function vetOutboundHost(raw: string): string | null {
  const host = raw.trim().toLowerCase().replace(/\.$/, "");
  if (host.length === 0 || host.length > 253) return null;
  if (isIP(host) !== 0 || host.includes(":") || host.includes("[")) return null;
  const labels = host.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((l) => LABEL.test(l))) return null;
  // An all-numeric last label is an IPv4 shorthand (127.1, 2130706433.x).
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return null;
  if (host === "localhost") return null;
  if (FORBIDDEN_SUFFIXES.some((s) => host.endsWith(s))) return null;
  return host;
}

const V4_FORBIDDEN = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  V4_FORBIDDEN.addSubnet(net, bits, "ipv4");
}

const V6_GLOBAL = new BlockList();
V6_GLOBAL.addSubnet("2000::", 3, "ipv6");
const V6_FORBIDDEN = new BlockList();
for (const [net, bits] of [
  ["2001::", 23], // IETF protocol assignments, incl. Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (embeds an arbitrary IPv4)
  ["3fff::", 20], // documentation
] as const) {
  V6_FORBIDDEN.addSubnet(net, bits, "ipv6");
}

/**
 * True when `address` is a public unicast address the hub may connect to.
 * IPv6 must be global unicast (2000::/3), which by construction excludes
 * loopback, link-local, unique-local (fc00::/7, so Fly's fdaa::/16 6PN),
 * multicast and every IPv4-mapped / NAT64 form.
 */
export function isPublicUnicast(address: string): boolean {
  const fam = isIP(address);
  if (fam === 4) return !V4_FORBIDDEN.check(address, "ipv4");
  if (fam === 6) {
    const a = address.split("%")[0]!;
    return V6_GLOBAL.check(a, "ipv6") && !V6_FORBIDDEN.check(a, "ipv6");
  }
  return false;
}

async function systemResolve(host: string): Promise<string[]> {
  const records = await dns.lookup(host, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

/* ------------------------------------------------------------------ */
/*  Budgets                                                            */
/* ------------------------------------------------------------------ */

class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly perSecond: number,
    private readonly capacity: number,
    private readonly now: () => number,
  ) {
    this.tokens = capacity;
    this.last = now();
  }
  private refill(): void {
    const t = this.now();
    const elapsed = Math.max(0, t - this.last);
    this.last = t;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.perSecond) / 1000);
  }
  /** Spend `n` (may go into debt); returns how long to wait before the next spend. */
  spend(n: number): number {
    this.refill();
    this.tokens -= n;
    return this.tokens >= 0 ? 0 : Math.ceil((-this.tokens * 1000) / this.perSecond);
  }
  /** Spend `n` only if available. */
  tryTake(n: number): boolean {
    this.refill();
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

class BoxBudget {
  sessions = 0;
  streams = 0;
  readonly bytes: TokenBucket;
  readonly opens: TokenBucket;
  /** Hosts this box asked about in the last hour (first-seen time), for the new-host limit. */
  private readonly seen = new Map<string, number>();
  constructor(
    bytesPerSecond: number,
    burst: number,
    opensPerMinute: number,
    private readonly newHostsPerHour: number,
    private readonly now: () => number,
  ) {
    this.bytes = new TokenBucket(bytesPerSecond, burst, now);
    this.opens = new TokenBucket(opensPerMinute / 60, opensPerMinute, now);
  }

  /** False when this would be one new host too many in the hour; a known provider or a repeat always passes. */
  admitHost(host: string): boolean {
    const h = host.toLowerCase();
    if (KNOWN_PROVIDER_HOSTS.has(h)) return true;
    const t = this.now();
    for (const [k, at] of this.seen) if (t - at >= 3_600_000) this.seen.delete(k);
    if (this.seen.has(h)) return true;
    if (this.seen.size >= this.newHostsPerHour) return false;
    this.seen.set(h, t);
    return true;
  }
}

/* ------------------------------------------------------------------ */
/*  Streams                                                            */
/* ------------------------------------------------------------------ */

interface HubStream {
  id: number;
  host: string;
  sock: Socket | null;
  open: boolean;
  done: boolean;
  /** Bytes we may still send the box before it grants more. */
  sendCredit: number;
  /** Bytes the box sent that we haven't credited back yet. */
  recvOutstanding: number;
  queue: Buffer[];
  upstreamEnded: boolean;
  boxClosed: boolean;
  waitingOnBudget: boolean;
  up: number;
  down: number;
  timers: Set<ReturnType<typeof setTimeout>>;
}

class HubOutboundSession implements OutboundSession {
  private readonly streams = new Map<number, HubStream>();
  private closed = false;

  constructor(
    private readonly send: (f: Frame) => void,
    private readonly o: ResolvedOptions,
    private readonly budget: BoxBudget,
    private readonly release: () => void,
  ) {}

  activeStreams(): number {
    return this.streams.size;
  }

  handleFrame(f: Frame): boolean {
    if (f.type === FRAME_OUTBOUND_OPEN) {
      this.onOpen(f);
      return true;
    }
    if (!isOutboundStreamId(f.streamId)) return false;
    if (f.type === FRAME_OUTBOUND_CREDIT) {
      this.onCredit(f);
      return true;
    }
    if (f.type === FRAME_DATA) {
      this.onData(f);
      return true;
    }
    if (f.type === FRAME_CLOSE || f.type === FRAME_CLOSE_REMOTE) {
      this.onBoxClose(f.streamId);
      return true;
    }
    return false;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const s of [...this.streams.values()]) this.finish(s, false);
    this.release();
  }

  private refuse(streamId: number, reason: OutboundRefusal): void {
    this.countRefusal(reason);
    this.send(outboundResultFrame(streamId, { ok: false, reason }));
  }

  private onOpen(f: Frame): void {
    if (this.closed) return;
    const req = parseOutboundOpen(f.payload);
    if (!req || !isOutboundStreamId(f.streamId)) return this.refuse(f.streamId, "bad-request");
    const host = vetOutboundHost(req.host);
    if (this.streams.has(f.streamId)) return this.refuse(f.streamId, "duplicate-stream");
    if (!this.o.allowedPorts.includes(req.port)) return this.refuse(f.streamId, "forbidden-port");
    if (!host) return this.refuse(f.streamId, "forbidden-host");
    if (this.budget.streams >= this.o.maxStreamsPerBox) {
      return this.refuse(f.streamId, "too-many-streams");
    }
    if (!this.budget.opens.tryTake(1)) return this.refuse(f.streamId, "rate-limited");

    const s: HubStream = {
      id: f.streamId,
      host,
      sock: null,
      open: false,
      done: false,
      sendCredit: OUTBOUND_INITIAL_WINDOW,
      recvOutstanding: 0,
      queue: [],
      upstreamEnded: false,
      boxClosed: false,
      waitingOnBudget: false,
      up: 0,
      down: 0,
      timers: new Set(),
    };
    this.streams.set(s.id, s);
    this.budget.streams += 1;
    void this.dial(s, req.port);
  }

  private async dial(s: HubStream, port: number): Promise<void> {
    if (!this.budget.admitHost(s.host)) return this.fail(s, "forbidden-host");
    if (!(await this.o.hostPolicy.allowed(s.host).catch(() => false))) return this.fail(s, "forbidden-host");
    if (s.done) return;
    let addrs: string[];
    try {
      addrs = await this.o.resolve(s.host);
    } catch {
      return this.fail(s, "dns-failed");
    }
    if (s.done) return;
    if (addrs.length === 0) return this.fail(s, "dns-failed");
    // Every record must be public: a name with one private record is refused
    // outright rather than "picking the safe one", so it can't be steered.
    if (!addrs.every(isPublicUnicast)) return this.fail(s, "forbidden-address");

    const sock = this.o.connect(addrs[0]!, port);
    s.sock = sock;
    const connectTimer = this.timer(s, this.o.connectTimeoutMs, () => {
      if (!s.open) {
        sock.destroy();
        this.fail(s, "connect-failed");
      }
    });
    sock.once("connect", () => {
      clearTimeout(connectTimer);
      s.timers.delete(connectTimer);
      if (s.done) {
        sock.destroy();
        return;
      }
      s.open = true;
      sock.setTimeout(this.o.idleTimeoutMs, () => sock.destroy());
      this.send(outboundResultFrame(s.id, { ok: true }));
    });
    sock.on("data", (chunk: Buffer) => {
      if (s.done || s.boxClosed) return;
      s.down += chunk.length;
      s.queue.push(chunk);
      this.pump(s);
    });
    sock.on("end", () => {
      s.upstreamEnded = true;
      this.pump(s);
    });
    sock.on("error", () => {
      if (!s.open) this.fail(s, "connect-failed");
    });
    sock.on("close", () => {
      if (!s.open) {
        this.fail(s, "connect-failed");
        return;
      }
      s.upstreamEnded = true;
      this.pump(s);
    });
  }

  /** Upstream → box, within the box's credit and this box's byte budget. */
  private pump(s: HubStream): void {
    if (s.done) return;
    while (s.queue.length > 0 && s.sendCredit > 0 && !s.waitingOnBudget) {
      const head = s.queue[0]!;
      const n = Math.min(head.length, s.sendCredit, OUTBOUND_MAX_CHUNK);
      const piece = head.subarray(0, n);
      if (n === head.length) s.queue.shift();
      else s.queue[0] = head.subarray(n);
      s.sendCredit -= n;
      this.send(dataFrame(s.id, new Uint8Array(piece.buffer, piece.byteOffset, piece.byteLength)));
      const wait = this.budget.bytes.spend(n);
      if (wait > 0) {
        s.waitingOnBudget = true;
        this.timer(s, wait, () => {
          s.waitingOnBudget = false;
          this.pump(s);
        });
      }
    }
    if (s.queue.length > 0 || s.waitingOnBudget) s.sock?.pause();
    else if (!s.upstreamEnded) s.sock?.resume();
    if (s.queue.length === 0 && s.upstreamEnded) this.finish(s, true);
  }

  private onCredit(f: Frame): void {
    const s = this.streams.get(f.streamId);
    const n = parseOutboundCredit(f.payload);
    if (!s || n === null) return;
    // A credit that would exceed a few windows is a confused or hostile peer.
    s.sendCredit = Math.min(s.sendCredit + n, OUTBOUND_INITIAL_WINDOW * 4);
    this.pump(s);
  }

  /** Box → upstream. Credit goes back once the bytes are on the wire and paid for. */
  private onData(f: Frame): void {
    const s = this.streams.get(f.streamId);
    if (!s) return;
    const n = f.payload.length;
    if (!s.open || !s.sock || s.boxClosed || s.recvOutstanding + n > OUTBOUND_INITIAL_WINDOW) {
      // Data before the open completed, or past the window: the box broke
      // the protocol. Drop the stream rather than buffer without bound.
      this.finish(s, true);
      return;
    }
    if (n === 0) return;
    s.recvOutstanding += n;
    s.up += n;
    s.sock.write(Buffer.from(f.payload), () => {
      const wait = this.budget.bytes.spend(n);
      const grant = () => {
        if (s.done) return;
        s.recvOutstanding -= n;
        this.send(outboundCreditFrame(s.id, n));
      };
      if (wait > 0) this.timer(s, wait, grant);
      else grant();
    });
  }

  private onBoxClose(streamId: number): void {
    const s = this.streams.get(streamId);
    if (!s) return;
    s.boxClosed = true;
    s.queue = [];
    if (s.sock && s.open) {
      // Let anything already written flush, then stop.
      s.sock.end();
      this.timer(s, 5_000, () => s.sock?.destroy());
    }
    this.finish(s, false);
  }

  private fail(s: HubStream, reason: OutboundRefusal): void {
    if (s.done) return;
    this.countRefusal(reason);
    const h = this.hostTotals(s.host);
    if (h) h.refused += 1;
    this.send(outboundResultFrame(s.id, { ok: false, reason }));
    this.cleanup(s);
    s.sock?.destroy();
  }

  /** End a stream; `notifyBox` sends CLOSE_REMOTE (the box hasn't closed). */
  private finish(s: HubStream, notifyBox: boolean): void {
    if (s.done) return;
    if (notifyBox && !s.boxClosed) this.send(closeFrame(s.id, true));
    const t = this.o.stats;
    t.streams += 1;
    const dest = destinationLabel(s.host);
    t.byDestination.set(dest, (t.byDestination.get(dest) ?? 0) + 1);
    t.up += s.up;
    t.down += s.down;
    const h = this.hostTotals(s.host);
    if (h) {
      h.streams += 1;
      h.up += s.up;
      h.down += s.down;
    }
    this.cleanup(s);
    if (!s.boxClosed) s.sock?.destroy();
  }

  private hostTotals(host: string): HostTotals | null {
    const m = this.o.stats.byHost;
    let h = m.get(host);
    if (!h) {
      if (m.size >= MAX_HOSTS_PER_FLUSH) return null;
      h = { streams: 0, up: 0, down: 0, refused: 0 };
      m.set(host, h);
    }
    return h;
  }

  private countRefusal(reason: OutboundRefusal): void {
    const r = this.o.stats.refused;
    r.set(reason, (r.get(reason) ?? 0) + 1);
  }

  private cleanup(s: HubStream): void {
    s.done = true;
    for (const t of s.timers) if (!s.boxClosed) clearTimeout(t);
    if (this.streams.get(s.id) === s) {
      this.streams.delete(s.id);
      this.budget.streams -= 1;
    }
  }

  private timer(s: HubStream, ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      s.timers.delete(t);
      fn();
    }, ms);
    (t as { unref?: () => void }).unref?.();
    s.timers.add(t);
    return t;
  }
}
