import { createServer, type Server, type Socket } from "node:net";
import {
  closeFrame,
  dataFrame,
  openFrame,
  parseClientHelloSni,
} from "@flagship/tunnel-protocol";
import type { RegisteredTunnel, TunnelRegistry } from "./registry.js";
import { fanOutNudge } from "./gossipFanout.js";
import { accountFromCanonical, type UsageMeter } from "./usageMeter.js";

/**
 * How long the hub holds a parked client stream — after nudging the user's
 * online boxes — waiting for one to elect itself and `register` the missed
 * leader-routed name. On expiry with still no claim, the socket is DESTROYED
 * (there is no literal 503 under SNI passthrough; a dropped connection is
 * "service unavailable").
 */
export const HOLD_TIMEOUT_MS = 4_000;
/** How often the hub re-checks `findBySni` for the awaited claim while parked. */
export const HOLD_POLL_INTERVAL_MS = 100;

export interface SniRouterOptions {
  port: number;
  host?: string;
  /** Max bytes to buffer waiting for the ClientHello before giving up. */
  maxPeekBytes?: number;
  /** Max wall-clock time (ms) to wait for a ClientHello before closing. */
  peekTimeoutMs?: number;
  /** Override the park hold-timeout (tests). Defaults to {@link HOLD_TIMEOUT_MS}. */
  holdTimeoutMs?: number;
  /** Override the park poll interval (tests). Defaults to {@link HOLD_POLL_INTERVAL_MS}. */
  holdPollIntervalMs?: number;
}

/**
 * One parked client stream awaiting a route claim.
 */
interface Waiter {
  client: Socket;
  initialBytes: Uint8Array;
  /** Post-ClientHello bytes that arrived while parked (replayed after pipe). */
  buffered: Uint8Array[];
  /** Detach the park-phase socket listeners (set once parked). */
  detach?: () => void;
}

/**
 * Single-flight park state for ONE unresolved domain. N concurrent parked
 * streams for the SAME domain share ONE nudge + ONE poll loop and release
 * together when the claim lands (or all drop together on timeout).
 */
interface ParkGroup {
  waiters: Waiter[];
  poll: ReturnType<typeof setInterval>;
  deadlineTimer: ReturnType<typeof setTimeout>;
}

/** Per-router single-flight registry: `domain → ParkGroup`. */
type ParkLot = Map<string, ParkGroup>;

export interface RunningSniRouter {
  port: number;
  close(): Promise<void>;
}

const DEFAULT_MAX_PEEK_BYTES = 16 * 1024; // covers any plausible ClientHello
const DEFAULT_PEEK_TIMEOUT_MS = 10_000;

export function startSniRouter(
  registry: TunnelRegistry,
  opts: SniRouterOptions,
  /** Optional public-egress meter. When present, the router counts bytes per
   *  account and refuses NEW streams for over-quota free accounts. Absent ⇒
   *  metering off (the default; nothing changes). */
  meter?: UsageMeter,
): Promise<RunningSniRouter> {
  const maxPeek = opts.maxPeekBytes ?? DEFAULT_MAX_PEEK_BYTES;
  const peekTimeoutMs = opts.peekTimeoutMs ?? DEFAULT_PEEK_TIMEOUT_MS;
  const holdTimeoutMs = opts.holdTimeoutMs ?? HOLD_TIMEOUT_MS;
  const holdPollIntervalMs = opts.holdPollIntervalMs ?? HOLD_POLL_INTERVAL_MS;
  // Single-flight park state, shared across every connection of THIS router.
  const parkLot: ParkLot = new Map();
  const hold: HoldConfig = { registry, meter, holdTimeoutMs, holdPollIntervalMs, parkLot };

  const server: Server = createServer((client) =>
    handleConnection(client, registry, maxPeek, peekTimeoutMs, meter, hold),
  );

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "0.0.0.0", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("router failed to obtain address"));
        return;
      }
      resolve({
        port: address.port,
        close() {
          return new Promise<void>((res) => server.close(() => res()));
        },
      });
    });
  });
}

/**
 * Everything the miss-path park logic needs, bundled so it threads cleanly
 * through `handleConnection` → `routeToTunnel`.
 */
interface HoldConfig {
  registry: TunnelRegistry;
  meter?: UsageMeter;
  holdTimeoutMs: number;
  holdPollIntervalMs: number;
  parkLot: ParkLot;
}

function handleConnection(
  client: Socket,
  registry: TunnelRegistry,
  maxPeek: number,
  peekTimeoutMs: number,
  meter: UsageMeter | undefined,
  hold: HoldConfig,
): void {
  let peeked: Uint8Array = new Uint8Array(0);
  let resolved = false;

  const peekTimer = setTimeout(() => {
    if (!resolved) {
      client.destroy(new Error("ClientHello peek timeout"));
    }
  }, peekTimeoutMs);

  const onData = (chunk: Buffer) => {
    if (resolved) return;
    peeked = concat(peeked, bufferToBytes(chunk));
    if (peeked.length > maxPeek) {
      bail("peek buffer exceeded");
      return;
    }
    const r = parseClientHelloSni(peeked);
    if (r.kind === "incomplete") return; // keep buffering
    resolved = true;
    clearTimeout(peekTimer);
    client.off("data", onData);
    if (r.kind === "error") {
      bail(`ClientHello error: ${r.reason}`);
      return;
    }
    if (r.sni === null) {
      bail("no SNI — refusing to route");
      return;
    }
    routeToTunnel(client, r.sni, peeked, hold);
  };

  function bail(reason: string): void {
    if (!resolved) {
      resolved = true;
      clearTimeout(peekTimer);
    }
    client.destroy(new Error(reason));
  }

  client.on("data", onData);
  client.once("error", () => {
    if (!resolved) {
      resolved = true;
      clearTimeout(peekTimer);
    }
  });
}

function routeToTunnel(
  client: Socket,
  sni: string,
  initialBytes: Uint8Array,
  hold: HoldConfig,
): void {
  const tunnel = hold.registry.findBySni(sni);
  if (tunnel) {
    pipeToTunnel(client, tunnel, sni, initialBytes, hold.meter);
    return;
  }
  // MISS. Either park-on-miss (a leader-routed meta-URL whose user has online
  // boxes — nudge them and wait for one to claim it) or today's drop.
  if (hold.registry.isNudgeableSni(sni)) {
    parkAndNudge(client, sni, initialBytes, hold);
    return;
  }
  client.destroy(new Error(`no tunnel for ${sni}`));
}

/**
 * Park the client stream, single-flight-nudge the user's online boxes, and
 * poll for the claim. On a hit → pipe. On timeout → destroy (drop). N streams
 * for the SAME domain share ONE nudge + ONE poll and release together.
 */
function parkAndNudge(
  client: Socket,
  sni: string,
  initialBytes: Uint8Array,
  hold: HoldConfig,
): void {
  const domain = sni.toLowerCase();
  const { registry, meter, parkLot } = hold;

  // Hold the raw TLS stream: we only peeked the ClientHello, never decrypt.
  // Pause reads (TCP backpressure) but still capture any early post-hello
  // bytes so we can replay them in-order once we pipe.
  const waiter: Waiter = { client, initialBytes, buffered: [] };
  const onParkData = (chunk: Buffer) => waiter.buffered.push(bufferToBytes(chunk));
  client.on("data", onParkData);

  // If the parked client itself goes away before a claim lands, drop it from
  // the group (and tear the group down if it was the last waiter).
  const onParkGone = () => removeWaiter(parkLot, domain, waiter);
  client.once("close", onParkGone);
  client.once("error", onParkGone);
  waiter.detach = () => {
    client.off("data", onParkData);
    client.off("close", onParkGone);
    client.off("error", onParkGone);
  };

  const existing = parkLot.get(domain);
  if (existing) {
    // Single-flight: join the in-flight wait. No second nudge, no second poll.
    existing.waiters.push(waiter);
    return;
  }

  // First waiter for this domain: fire ONE nudge to every online box of the
  // user, then start ONE poll loop + ONE deadline.
  const user = registry.userOfSni(domain);
  if (user) fanOutNudge(registry, user, domain);

  const group: ParkGroup = {
    waiters: [waiter],
    poll: setInterval(() => {
      const tunnel = registry.findBySni(domain);
      if (!tunnel) return; // still no claim — keep waiting
      releaseGroup(parkLot, domain, group, tunnel, meter);
    }, hold.holdPollIntervalMs),
    deadlineTimer: setTimeout(() => {
      dropGroup(parkLot, domain, group);
    }, hold.holdTimeoutMs),
  };
  parkLot.set(domain, group);
}

/** Remove one waiter (its socket died) from a domain's group. */
function removeWaiter(parkLot: ParkLot, domain: string, waiter: Waiter): void {
  const group = parkLot.get(domain);
  if (!group) return;
  const i = group.waiters.indexOf(waiter);
  if (i === -1) return;
  waiter.detach?.();
  group.waiters.splice(i, 1);
  if (group.waiters.length === 0) {
    clearInterval(group.poll);
    clearTimeout(group.deadlineTimer);
    parkLot.delete(domain);
  }
}

/** A claim landed: pipe every parked waiter to the now-registered tunnel. */
function releaseGroup(
  parkLot: ParkLot,
  domain: string,
  group: ParkGroup,
  tunnel: RegisteredTunnel,
  meter: UsageMeter | undefined,
): void {
  if (parkLot.get(domain) !== group) return; // already released/dropped
  clearInterval(group.poll);
  clearTimeout(group.deadlineTimer);
  parkLot.delete(domain);
  for (const w of group.waiters) {
    w.detach?.();
    // Replay: ClientHello + any bytes that arrived while parked, then live.
    const replay = w.buffered.length
      ? concatAll([w.initialBytes, ...w.buffered])
      : w.initialBytes;
    pipeToTunnel(w.client, tunnel, domain, replay, meter);
  }
}

/** Timeout with no claim (or the resolved tunnel unreachable): drop them all. */
function dropGroup(parkLot: ParkLot, domain: string, group: ParkGroup): void {
  if (parkLot.get(domain) !== group) return;
  clearInterval(group.poll);
  clearTimeout(group.deadlineTimer);
  parkLot.delete(domain);
  for (const w of group.waiters) {
    w.detach?.();
    // No literal 503 under SNI passthrough — a dropped connection IS
    // "service unavailable". Log it.
    console.warn(`[sni-router] hold timeout, dropping parked stream for ${domain}`);
    w.client.destroy(new Error(`no claim for ${domain} within hold timeout`));
  }
}

/**
 * Pipe a (possibly previously-parked) client stream to a registered tunnel.
 * This is the existing relay path — extracted so both the direct-hit and the
 * claim-landed paths share it. `initialBytes` is everything to hand the box
 * up front (the ClientHello, plus any bytes buffered while parked).
 */
function pipeToTunnel(
  client: Socket,
  tunnel: RegisteredTunnel,
  sni: string,
  initialBytes: Uint8Array,
  meter?: UsageMeter,
): void {
  // Per-account metering: attribute this stream to the box's owner. Custom
  // domains resolve to a tunnel whose podCanonical carries the username too.
  const account = meter ? accountFromCanonical(tunnel.podCanonical) : null;
  // Hard cap: an over-quota free account stops getting NEW public streams.
  // (Existing in-flight streams are left alone — we never kill live traffic.)
  if (meter && account && !meter.admits(account)) {
    client.destroy(new Error("over quota"));
    return;
  }
  const streamId = tunnel.nextStreamId();
  let closed = false;
  const closeStream = () => {
    if (closed) return;
    closed = true;
    tunnel.detachStream(streamId);
    try {
      tunnel.send(closeFrame(streamId, false));
    } catch {
      /* tunnel may be down */
    }
  };

  tunnel.attachStream(streamId, {
    onData(data) {
      // box → visitor (the dominant egress leg).
      meter?.add(account, data.byteLength);
      client.write(Buffer.from(data));
    },
    onRemoteClose() {
      closed = true;
      tunnel.detachStream(streamId);
      client.end();
    },
  });

  // Hand off the ClientHello bytes we already buffered.
  tunnel.send(openFrame(streamId, sni));
  meter?.add(account, initialBytes.byteLength);
  tunnel.send(dataFrame(streamId, initialBytes));

  client.on("data", (chunk: Buffer) => {
    // visitor → box (request leg; small, but still relay egress).
    meter?.add(account, chunk.byteLength);
    tunnel.send(dataFrame(streamId, bufferToBytes(chunk)));
  });
  client.on("end", closeStream);
  client.on("close", closeStream);
  client.on("error", () => closeStream());
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function concatAll(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function bufferToBytes(b: Buffer): Uint8Array {
  const out = new Uint8Array(b.byteLength);
  out.set(b);
  return out;
}
