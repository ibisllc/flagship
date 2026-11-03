import { createServer, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import {
  closeFrame,
  dataFrame,
  DEFAULT_SNI_LIMITS,
  openFrame,
  parseClientHelloSni,
} from "@flagship/tunnel-protocol";
import type { RegisteredTunnel, TunnelRegistry } from "./registry.js";
import { fanOutNudge } from "./gossipFanout.js";
import { accountFromCanonical, type UsageMeter } from "./usageMeter.js";
import { PauseReasons, SourcePauser } from "./throttle.js";
import { routerStats } from "./routerStats.js";
import type { MeshDecision } from "./mesh/node.js";

/**
 * The relay mesh's routing hooks (docs/architecture-v2/relay-mesh.md §7.2), implemented by `MeshNode`. When set, every
 * parsed ClientHello is decided by the mesh first: route locally (today's path), forward over a bridge to the holder,
 * query the peers, or drop at the hold time. A stream that came over a bridge is only ever routed locally (one hop).
 */
export interface MeshRouting {
  readonly selfRelayId: string;
  decide(sni: string, bridged: boolean): MeshDecision;
  ask(name: string, exclude: string[]): Promise<string | null>;
  /** `client`: this relay's key for the visitor's address, sent in the OPEN for the holder's rebalancing (§6.4). */
  openTo(relayId: string, sni: string, client?: string): (Duplex & { refused: string | null }) | null;
  notHolder(name: string, relayId: string): void;
  /** This relay's opaque key for a visitor address (§6.4 `client`). */
  clientKey(address: string | undefined, port?: number): string;
  /** A visitor session to count for rebalancing once it completes (§10.1), or null (not counted). */
  traffic(podCanonical: string, sni: string, entry: string, client: string): SessionCounter | null;
}

/** One visitor session's traffic, counted for rebalancing only if both sides spoke after the ClientHello (§10.1). */
export interface SessionCounter {
  /** Visitor → box bytes after the ClientHello. */
  up(bytes: number): void;
  /** Box → visitor bytes. */
  down(bytes: number): void;
  /** The session ended (idempotent). */
  end(): void;
}

/** Where a stream came from: a visitor's own TCP connection (with its arrival time) or a peer relay's bridge. */
interface RouteCtx {
  arrivedAt?: number;
  bridged?: { entry: string; refuse: (code: string) => void; client?: string };
}

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

/**
 * How many unmatched first-party streams may sit out their delayed drop at
 * once. Past it they are destroyed at once: holding is a courtesy against an
 * oracle, never worth exhausting file descriptors for.
 */
export const MAX_DELAYED_DROPS = 2_048;

/** ClientHellos being read at once. Past it new connections are dropped at once. */
export const MAX_PENDING_HELLOS = 4_096;

/**
 * Bytes a parked visitor may send before the router stops reading it (TCP backpressure).
 * A TLS client sends nothing after its hello until the server answers, so this only has to
 * hold early data.
 */
export const MAX_PARKED_BYTES = 64 * 1024;

/**
 * Box → visitor: once this much sits unwritten in a visitor's socket, the router stops
 * reading the box's tunnel until the visitor has taken {@link VISITOR_RESUME_ROOM} back.
 * v1 tunnels have no per-stream credit, so the pause holds every stream on that tunnel;
 * a visitor that frees no room for {@link SLOW_VISITOR_GRACE_MS} is cut so it can't
 * hold the others for long.
 */
export const VISITOR_QUEUE_BYTES = 256 * 1024;
export const VISITOR_RESUME_ROOM = 64 * 1024;
export const SLOW_VISITOR_GRACE_MS = 5_000;
const SLOW_VISITOR_POLL_MS = 50;

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
  /** Override the delayed-drop cap (tests). Defaults to {@link MAX_DELAYED_DROPS}. */
  maxDelayedDrops?: number;
  /** Override the pending-hello cap (tests). Defaults to {@link MAX_PENDING_HELLOS}. */
  maxPendingHellos?: number;
  /** Override the slow-visitor cut (tests). Defaults to {@link SLOW_VISITOR_GRACE_MS}. */
  slowVisitorGraceMs?: number;
  /** The relay mesh (FLAGSHIP_MESH=on). Absent: today's single-relay routing, unchanged. */
  mesh?: MeshRouting;
}

/**
 * One parked client stream awaiting a route claim.
 */
interface Waiter {
  client: Duplex;
  initialBytes: Uint8Array;
  /** Post-ClientHello bytes that arrived while parked (replayed after pipe). */
  buffered: Uint8Array[];
  bufferedBytes: number;
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
  /**
   * Mesh holder duties (§7.4): route a stream a peer relay opened over a bridge, from local tunnels only. `refuse`
   * answers the entry relay (`not-holder`, `apps-off`, …) instead of the delayed drop the entry does itself.
   */
  routeBridged(stream: Duplex, sni: string, initialBytes: Uint8Array, ctx: { entry: string; refuse: (code: string) => void; client?: string }): void;
}

const DEFAULT_MAX_PEEK_BYTES = DEFAULT_SNI_LIMITS.maxRawBytes;
const DEFAULT_PEEK_TIMEOUT_MS = 10_000;

export function startSniRouter(
  registry: TunnelRegistry,
  opts: SniRouterOptions,
  /** Optional public-egress meter. When present, the router counts bytes per
   *  account and slows over-quota free accounts to their speed limit. Absent ⇒
   *  metering off (the default; nothing changes). */
  meter?: UsageMeter,
): Promise<RunningSniRouter> {
  const maxPeek = opts.maxPeekBytes ?? DEFAULT_MAX_PEEK_BYTES;
  const peekTimeoutMs = opts.peekTimeoutMs ?? DEFAULT_PEEK_TIMEOUT_MS;
  const holdTimeoutMs = opts.holdTimeoutMs ?? HOLD_TIMEOUT_MS;
  const holdPollIntervalMs = opts.holdPollIntervalMs ?? HOLD_POLL_INTERVAL_MS;
  // Single-flight park state, shared across every connection of THIS router.
  const parkLot: ParkLot = new Map();
  const hold: HoldConfig = {
    registry,
    meter,
    holdTimeoutMs,
    holdPollIntervalMs,
    parkLot,
    delayed: { count: 0 },
    maxDelayed: opts.maxDelayedDrops ?? MAX_DELAYED_DROPS,
    pendingHellos: { count: 0 },
    maxPendingHellos: opts.maxPendingHellos ?? MAX_PENDING_HELLOS,
    slowVisitorGraceMs: opts.slowVisitorGraceMs ?? SLOW_VISITOR_GRACE_MS,
    ...(opts.mesh ? { mesh: opts.mesh } : {}),
  };

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
        routeBridged(stream, sni, initialBytes, ctx) {
          routeToTunnel(stream, sni, initialBytes, hold, { bridged: ctx });
          if (!stream.destroyed) stream.resume();
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
  /** Streams currently waiting out a delayed drop (shared by this router's connections). */
  delayed: { count: number };
  maxDelayed: number;
  /** Connections still reading their ClientHello. */
  pendingHellos: { count: number };
  maxPendingHellos: number;
  slowVisitorGraceMs: number;
  mesh?: MeshRouting;
}

function handleConnection(
  client: Socket,
  registry: TunnelRegistry,
  maxPeek: number,
  peekTimeoutMs: number,
  meter: UsageMeter | undefined,
  hold: HoldConfig,
): void {
  if (hold.pendingHellos.count >= hold.maxPendingHellos) {
    client.destroy();
    return;
  }
  hold.pendingHellos.count += 1;
  const arrivedAt = Date.now();
  const limits = { ...DEFAULT_SNI_LIMITS, maxRawBytes: maxPeek };
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Re-parse only once the bytes the last parse asked for are here, so a sender that
  // dribbles single bytes costs one parse per record, not one per byte.
  let needAtLeast = 0;
  let resolved = false;

  const finishPeek = (): boolean => {
    if (resolved) return false;
    resolved = true;
    hold.pendingHellos.count -= 1;
    clearTimeout(peekTimer);
    client.off("data", onData);
    return true;
  };

  const peekTimer = setTimeout(() => {
    if (finishPeek()) client.destroy(new Error("ClientHello peek timeout"));
  }, peekTimeoutMs);

  const onData = (chunk: Buffer) => {
    if (resolved) return;
    chunks.push(bufferToBytes(chunk));
    total += chunk.byteLength;
    if (total < needAtLeast) return;
    const peeked = chunks.length === 1 ? chunks[0]! : concatAll(chunks);
    chunks.length = 0;
    chunks.push(peeked);
    const r = parseClientHelloSni(peeked, limits);
    if (r.kind === "incomplete") {
      needAtLeast = r.needAtLeast;
      return;
    }
    finishPeek();
    if (r.kind === "error") {
      routerStats.bad += 1;
      client.destroy(new Error(`ClientHello error: ${r.reason}`));
      return;
    }
    if (r.sni === null) {
      routerStats.bad += 1;
      client.destroy(new Error("no SNI — refusing to route"));
      return;
    }
    // The mesh measures every miss from the visitor's arrival (§7.2); without it the hold starts at the miss, as before.
    routeToTunnel(client, r.sni, peeked, hold, hold.mesh ? { arrivedAt } : {});
  };

  client.on("data", onData);
  client.once("error", () => {
    finishPeek();
  });
  client.once("close", () => {
    finishPeek();
  });
}

function routeToTunnel(
  client: Duplex,
  sni: string,
  initialBytes: Uint8Array,
  hold: HoldConfig,
  ctx: RouteCtx = {},
): void {
  const mesh = hold.mesh;
  if (mesh) {
    const d = mesh.decide(sni, ctx.bridged !== undefined);
    if (d.kind === "refuse") {
      ctx.bridged?.refuse(d.code);
      return;
    }
    if (d.kind === "drop") {
      routerStats.noBoxRegistered += 1;
      routerStats.missed("no-box-registered", sni.toLowerCase());
      delayedDrop(client, sni, hold, ctx.arrivedAt);
      return;
    }
    if (d.kind === "forward") {
      forwardOverMesh(mesh, client, sni, d.name, d.relayId, initialBytes, hold, ctx, false);
      return;
    }
    if (d.kind === "query") {
      queryThenForward(mesh, client, sni, d.name, d.exclude, initialBytes, hold, ctx, false);
      return;
    }
  }
  const tunnel = hold.registry.findBySni(sni);
  if (tunnel) {
    routerStats.routed += 1;
    const visitorKey = mesh ? (ctx.bridged ? (ctx.bridged.client ?? "?") : mesh.clientKey((client as { remoteAddress?: string }).remoteAddress, (client as { remotePort?: number }).remotePort)) : "?";
    const count = mesh?.traffic(tunnel.podCanonical, sni, ctx.bridged?.entry ?? mesh.selfRelayId, visitorKey) ?? undefined;
    pipeToTunnel(client, tunnel, sni, initialBytes, hold.meter, hold.slowVisitorGraceMs, count);
    return;
  }
  // MISS. Either park-on-miss (a leader-routed meta-URL whose user has online
  // boxes — nudge them and wait for one to claim it) or today's drop.
  if (hold.registry.isNudgeableSni(sni)) {
    parkAndNudge(client, sni, initialBytes, hold);
    return;
  }
  // A bridged stream is never dropped here: the entry relay keeps the hold timing; the holder only says why.
  if (ctx.bridged) {
    ctx.bridged.refuse(hold.registry.servingRefused(sni) ? "apps-off" : "not-holder");
    return;
  }
  // Under the wildcard DNS (docs/wildcard-dns.md) every name below an account
  // resolves here, registered or not. A first-party miss is dropped after the
  // same wait a nudged one gets, so the time to close tells a prober nothing
  // about whether the account exists, has a box online, or ever had this box.
  if (hold.registry.userOfSni(sni)) {
    routerStats.noBoxRegistered += 1;
    routerStats.missed("no-box-registered", sni.toLowerCase());
    delayedDrop(client, sni, hold, ctx.arrivedAt);
    return;
  }
  routerStats.noUser += 1;
  client.destroy(new Error(`no tunnel for ${sni}`));
}

/** Most bytes a visitor may send while the entry relay waits for the holder's first byte (a TLS client sends none). */
const MAX_EARLY_BYTES = 64 * 1024;

/**
 * Entry duties (§7.2 step 5): open a stream to the holder over its bridge, send the peeked ClientHello as the first
 * DATA, and splice. Until the holder answers, the visitor's bytes are kept so a `not-holder` refusal can be retried
 * once elsewhere (the attachment is dropped and the peers asked again, never through the refusing relay). Any other
 * end before an answer closes the visitor at the hold time, like every miss.
 */
function forwardOverMesh(
  mesh: MeshRouting,
  client: Duplex,
  sni: string,
  name: string,
  relayId: string,
  initialBytes: Uint8Array,
  hold: HoldConfig,
  ctx: RouteCtx,
  retried: boolean,
): void {
  if (client.destroyed) return;
  const s = mesh.openTo(relayId, sni, mesh.clientKey((client as { remoteAddress?: string }).remoteAddress, (client as { remotePort?: number }).remotePort));
  if (!s) {
    if (!retried) queryThenForward(mesh, client, sni, name, [relayId], initialBytes, hold, ctx, true);
    else delayedDrop(client, sni, hold, ctx.arrivedAt);
    return;
  }
  let answered = false;
  let early: Uint8Array[] = [];
  let earlyBytes = 0;
  const onEarly = (c: Buffer) => {
    early.push(bufferToBytes(c));
    earlyBytes += c.byteLength;
    if (earlyBytes >= MAX_EARLY_BYTES) client.pause();
  };
  const onClientGone = () => {
    if (!s.destroyed) s.destroy();
  };
  client.on("data", onEarly);
  client.once("close", onClientGone);
  client.once("error", onClientGone);
  client.resume();
  s.on("error", () => undefined);
  s.once("data", (first: Buffer) => {
    answered = true;
    client.off("data", onEarly);
    for (const b of early) s.write(Buffer.from(b));
    early = [];
    client.write(first);
    s.pipe(client);
    client.pipe(s);
    client.resume();
  });
  s.once("close", () => {
    if (answered) {
      if (!client.destroyed) client.end();
      return;
    }
    client.off("data", onEarly);
    client.off("close", onClientGone);
    client.off("error", onClientGone);
    if (client.destroyed) return;
    if (s.refused === "not-holder" && !retried) {
      mesh.notHolder(name, relayId);
      const replay = early.length ? concatAll([initialBytes, ...early]) : initialBytes;
      queryThenForward(mesh, client, sni, name, [relayId], replay, hold, ctx, true);
      return;
    }
    routerStats.noBoxRegistered += 1;
    routerStats.missed("no-box-registered", sni.toLowerCase());
    delayedDrop(client, sni, hold, ctx.arrivedAt);
  });
  s.write(Buffer.from(initialBytes));
}

/** §7.2 step 4: ask the peers (single-flight, 1.5 s), then forward to the answer or drop at the hold time. */
function queryThenForward(
  mesh: MeshRouting,
  client: Duplex,
  sni: string,
  name: string,
  exclude: string[],
  initialBytes: Uint8Array,
  hold: HoldConfig,
  ctx: RouteCtx,
  retried: boolean,
): void {
  client.pause();
  void mesh.ask(name, exclude).then(
    (relayId) => {
      if (client.destroyed) return;
      if (relayId && !exclude.includes(relayId)) forwardOverMesh(mesh, client, sni, name, relayId, initialBytes, hold, ctx, retried);
      else delayedDrop(client, sni, hold, ctx.arrivedAt);
    },
    () => delayedDrop(client, sni, hold, ctx.arrivedAt),
  );
}

/**
 * Close a first-party stream nobody registered after the hold timeout, saying
 * nothing in between: no TLS reply, no byte to any tunnel. Uses the same wait
 * as {@link parkAndNudge}'s drop so the two are indistinguishable by timing.
 */
function delayedDrop(client: Duplex, sni: string, hold: HoldConfig, arrivedAt?: number): void {
  if (hold.delayed.count >= hold.maxDelayed) {
    client.destroy(new Error(`no tunnel for ${sni}`));
    return;
  }
  hold.delayed.count += 1;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    hold.delayed.count -= 1;
    clearTimeout(timer);
    client.destroy();
  };
  // Mesh entries measure the hold from the visitor's arrival, so a local miss, a mesh miss and a holder's refusal all
  // close at the same time (§7.2). Without the mesh the hold starts here, as before.
  const wait = arrivedAt === undefined ? hold.holdTimeoutMs : Math.max(0, arrivedAt + hold.holdTimeoutMs - Date.now());
  const timer = setTimeout(finish, wait);
  // Swallow whatever the client sends meanwhile; a client that hangs up first frees the slot.
  client.on("data", () => undefined);
  client.resume();
  client.once("close", finish);
  client.once("error", finish);
}

/**
 * Park the client stream, single-flight-nudge the user's online boxes, and
 * poll for the claim. On a hit → pipe. On timeout → destroy (drop). N streams
 * for the SAME domain share ONE nudge + ONE poll and release together.
 */
function parkAndNudge(
  client: Duplex,
  sni: string,
  initialBytes: Uint8Array,
  hold: HoldConfig,
): void {
  const domain = sni.toLowerCase();
  const { registry, meter, parkLot } = hold;

  // Hold the raw TLS stream: we only peeked the ClientHello, never decrypt.
  // Pause reads (TCP backpressure) but still capture any early post-hello
  // bytes so we can replay them in-order once we pipe.
  routerStats.parked += 1;
  const waiter: Waiter = { client, initialBytes, buffered: [], bufferedBytes: 0 };
  const onParkData = (chunk: Buffer) => {
    waiter.buffered.push(bufferToBytes(chunk));
    waiter.bufferedBytes += chunk.byteLength;
    if (waiter.bufferedBytes >= MAX_PARKED_BYTES) client.pause();
  };
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
      releaseGroup(parkLot, domain, group, tunnel, meter, hold.slowVisitorGraceMs);
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
  slowVisitorGraceMs: number,
): void {
  if (parkLot.get(domain) !== group) return; // already released/dropped
  clearInterval(group.poll);
  clearTimeout(group.deadlineTimer);
  parkLot.delete(domain);
  routerStats.released += group.waiters.length;
  for (const w of group.waiters) {
    w.detach?.();
    // Replay: ClientHello + any bytes that arrived while parked, then live.
    const replay = w.buffered.length
      ? concatAll([w.initialBytes, ...w.buffered])
      : w.initialBytes;
    // Undo a parked-bytes pause; data events start on a later tick, after pipeToTunnel
    // has attached its listener.
    w.client.resume();
    pipeToTunnel(w.client, tunnel, domain, replay, meter, slowVisitorGraceMs);
  }
}

/** Timeout with no claim (or the resolved tunnel unreachable): drop them all. */
function dropGroup(parkLot: ParkLot, domain: string, group: ParkGroup): void {
  if (parkLot.get(domain) !== group) return;
  clearInterval(group.poll);
  clearTimeout(group.deadlineTimer);
  parkLot.delete(domain);
  routerStats.holdTimeouts += group.waiters.length;
  routerStats.missed("hold-timeout", domain);
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
  client: Duplex,
  tunnel: RegisteredTunnel,
  sni: string,
  initialBytes: Uint8Array,
  meter: UsageMeter | undefined,
  slowVisitorGraceMs: number = SLOW_VISITOR_GRACE_MS,
  /** Mesh rebalancing: this visitor session's traffic (§10.1). */
  count?: SessionCounter,
): void {
  // Per-account metering: attribute this stream to the box's owner. Custom
  // domains resolve to a tunnel whose podCanonical carries the username too.
  const account = meter ? accountFromCanonical(tunnel.podCanonical) : null;
  // The visitor's socket is paused for two independent reasons (the throttle and a
  // backed-up tunnel); it reads again only when neither holds it.
  const visitorGate = new PauseReasons(
    () => client.pause(),
    () => {
      if (!client.destroyed) client.resume();
    },
  );
  // An over-quota free account is slowed, never refused (throttle.ts): each
  // direction charges the account's shared bucket and, when it overdraws,
  // pauses its own source — the visitor's socket for uploads, the box's tunnel
  // for downloads — so nothing is buffered. A paused socket only notices the
  // visitor hanging up when it resumes, so a throttled stream can outlive its
  // visitor by the current hold (one chunk of debt, ~2 s at 256 kbit/s).
  const visitorSide = new SourcePauser(
    () => visitorGate.hold("throttle"),
    () => visitorGate.release("throttle"),
  );
  const streamId = tunnel.nextStreamId();
  const slowKey = `visitor:${streamId}`;
  let closed = false;
  let slowPoll: ReturnType<typeof setInterval> | null = null;

  const stopSlowWatch = () => {
    if (slowPoll) clearInterval(slowPoll);
    slowPoll = null;
    tunnel.resumeInbound?.(slowKey);
  };
  const closeStream = () => {
    count?.end();
    if (closed) return;
    closed = true;
    visitorSide.dispose();
    stopSlowWatch();
    tunnel.detachStream(streamId);
    try {
      tunnel.send(closeFrame(streamId, false));
    } catch {
      /* tunnel may be down */
    }
  };
  // The visitor's socket holds VISITOR_QUEUE_BYTES unwritten: stop reading the tunnel until
  // it frees VISITOR_RESUME_ROOM, or cut this visitor if it frees none in time.
  const watchSlowVisitor = () => {
    if (slowPoll || !tunnel.pauseInbound) return;
    tunnel.pauseInbound(slowKey);
    let lastLength = client.writableLength;
    let lastProgress = Date.now();
    slowPoll = setInterval(() => {
      const queued = client.writableLength;
      if (queued <= VISITOR_QUEUE_BYTES - VISITOR_RESUME_ROOM) {
        stopSlowWatch();
        return;
      }
      if (queued < lastLength) {
        lastLength = queued;
        lastProgress = Date.now();
        return;
      }
      if (Date.now() - lastProgress >= slowVisitorGraceMs) {
        closeStream();
        client.destroy(new Error("visitor too slow"));
      }
    }, SLOW_VISITOR_POLL_MS);
  };
  const resumeVisitor = () => visitorGate.release("tunnel");

  tunnel.attachStream(streamId, {
    onData(data) {
      // box → visitor (the dominant egress leg).
      if (closed) return;
      meter?.add(account, data.byteLength);
      count?.down(data.byteLength);
      client.write(Buffer.from(data));
      if (client.writableLength >= VISITOR_QUEUE_BYTES) watchSlowVisitor();
      const wait = meter?.throttleDelayMs(account, data.byteLength) ?? 0;
      if (wait > 0) tunnel.holdInbound?.(wait);
    },
    onRemoteClose() {
      count?.end();
      closed = true;
      visitorSide.dispose();
      stopSlowWatch();
      tunnel.detachStream(streamId);
      client.end();
    },
  }, sni);

  // visitor → box: stop reading the visitor while the tunnel's socket is backed up.
  const sendToBox = (bytes: Uint8Array) => {
    tunnel.send(dataFrame(streamId, bytes));
    if (tunnel.whenBoxWritable && !visitorGate.has("tunnel")) {
      const ready = tunnel.whenBoxWritable(resumeVisitor);
      if (!ready) visitorGate.hold("tunnel");
    }
  };

  // Hand off the ClientHello bytes we already buffered.
  tunnel.send(openFrame(streamId, sni));
  meter?.add(account, initialBytes.byteLength);
  sendToBox(initialBytes);
  visitorSide.hold(meter?.throttleDelayMs(account, initialBytes.byteLength) ?? 0);

  client.on("data", (chunk: Buffer) => {
    // visitor → box (request leg; small, but still relay egress).
    if (closed) return;
    meter?.add(account, chunk.byteLength);
    count?.up(chunk.byteLength);
    sendToBox(bufferToBytes(chunk));
    visitorSide.hold(meter?.throttleDelayMs(account, chunk.byteLength) ?? 0);
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
