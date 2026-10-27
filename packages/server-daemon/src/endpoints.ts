/**
 * How the daemon reaches an app (docs/architecture-v2/app-endpoints.md).
 *
 * Callers name a service and never supply an address. The table holds, per service, the one endpoint
 * the daemon itself verified for the container it created, tagged with the deploy it belongs to
 * (`generation`) and the container start it belongs to (`incarnation`). Anything not in the table, or
 * invalidated, is unavailable: there is no fallback to another path.
 *
 * An address belongs to a SERVICE for as long as the service exists (AddressPool), so a stale dial can
 * only reach nothing or a later incarnation of the same service, never another app. An address goes
 * back to the pool only after the service's endpoint is invalidated, its connections are closed and a
 * quarantine has passed.
 */

export type EndpointEnv = "live" | "staging" | "build";
export type EndpointRole = "http" | "data" | "ai";

export interface EndpointKey {
  serviceId: string;
  env: EndpointEnv;
  /** `main` for a single-process app, the component's name inside an app group. */
  component: string;
  role: EndpointRole;
}

export interface Endpoint {
  host: string;
  port: number;
  /** One per deploy (install, update, rollback). */
  generation: number;
  /** One per container start: the engine's container id plus its StartedAt. */
  incarnation: string;
}

export function keyString(k: EndpointKey): string {
  return `${k.env}/${k.serviceId}/${k.component}/${k.role}`;
}

/** What may be torn down on invalidation: a request, a socket, a pending dial. */
export interface Destroyable {
  destroy(error?: Error): unknown;
}

/** One caller's hold on an endpoint, registered BEFORE it dials so an invalidation cannot miss it. */
export class EndpointLease {
  private readonly bound = new Set<Destroyable>();
  private done = false;

  constructor(
    readonly endpoint: Endpoint,
    private readonly isCurrent: () => boolean,
    private readonly onRelease: (l: EndpointLease) => void,
  ) {}

  /** Tie a request or socket to this lease; it is destroyed if the endpoint is invalidated. */
  bind(d: Destroyable): void {
    if (this.done) {
      d.destroy(new Error("endpoint invalidated"));
      return;
    }
    this.bound.add(d);
  }

  /** True while the incarnation this lease was issued for is still the current one. */
  current(): boolean {
    return !this.done && this.isCurrent();
  }

  release(): void {
    if (this.done) return;
    this.done = true;
    this.bound.clear();
    this.onRelease(this);
  }

  /** Called by the table. */
  cancel(): void {
    if (this.done) return;
    this.done = true;
    const all = [...this.bound];
    this.bound.clear();
    this.onRelease(this);
    for (const d of all) {
      try {
        d.destroy(new Error("endpoint invalidated"));
      } catch {
        // already gone
      }
    }
  }
}

interface Entry {
  endpoint: Endpoint;
}

export class EndpointTable {
  private readonly entries = new Map<string, Entry>();
  /** Services being stopped: nothing is admitted until the next publish. */
  private readonly draining = new Set<string>();
  private readonly leases = new Map<string, Set<EndpointLease>>();

  /** Make an endpoint available. The caller verified the container (see publishFromEngine). */
  publish(key: EndpointKey, endpoint: Endpoint): void {
    this.entries.set(keyString(key), { endpoint });
    this.draining.delete(drainKey(key));
  }

  lookup(key: EndpointKey): Endpoint | null {
    const k = keyString(key);
    if (this.draining.has(drainKey(key))) return null;
    return this.entries.get(k)?.endpoint ?? null;
  }

  /** Take a lease on the current endpoint, or null (the proxy answers 503). */
  acquire(key: EndpointKey): EndpointLease | null {
    const k = keyString(key);
    const ep = this.lookup(key);
    if (!ep) return null;
    const lease = new EndpointLease(
      ep,
      () => {
        const cur = this.entries.get(k)?.endpoint;
        return !!cur && !this.draining.has(drainKey(key)) && cur.incarnation === ep.incarnation && cur.generation === ep.generation;
      },
      (l) => this.leases.get(k)?.delete(l),
    );
    let set = this.leases.get(k);
    if (!set) this.leases.set(k, (set = new Set()));
    set.add(lease);
    return lease;
  }

  /** Stop admitting, drop the endpoint, and destroy every connection and pending dial for the service. */
  invalidate(serviceId: string, env?: EndpointEnv): void {
    for (const k of [...this.entries.keys()]) {
      const [kEnv, kService] = k.split("/");
      if (kService !== serviceId || (env && kEnv !== env)) continue;
      this.entries.delete(k);
      this.cancelLeases(k);
    }
    for (const k of [...this.leases.keys()]) {
      const [kEnv, kService] = k.split("/");
      if (kService === serviceId && (!env || kEnv === env)) this.cancelLeases(k);
    }
  }

  /** The first step of a stop, replace, update or rollback: refuse new connections, close the old ones. */
  beginStop(serviceId: string, env: EndpointEnv = "live"): void {
    this.draining.add(drainKey({ serviceId, env }));
    this.invalidate(serviceId, env);
  }

  /** Leases currently open for a service (tests, diagnostics). */
  openLeases(serviceId: string): number {
    let n = 0;
    for (const [k, set] of this.leases) if (k.split("/")[1] === serviceId) n += set.size;
    return n;
  }

  private cancelLeases(k: string): void {
    const set = this.leases.get(k);
    if (!set) return;
    for (const l of [...set]) l.cancel();
    this.leases.delete(k);
  }
}

function drainKey(k: { serviceId: string; env: EndpointEnv }): string {
  return `${k.env}/${k.serviceId}`;
}

/** The daemon's one table. */
export const endpoints = new EndpointTable();

// ---------------------------------------------------------------------------------------------
// Address ownership

function ipToInt(ip: string): number {
  const p = ip.split(".").map(Number);
  return ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0;
}
function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

export interface AddressPoolOptions {
  /** Addresses the daemon must never hand out (the bridge's gateway, the egress gateway). */
  reserved?: string[];
  /** How long a released address stays out of use. */
  quarantineMs?: number;
  now?: () => number;
}

/**
 * One pool per bridge. An owner (a service, or one component of a group) keeps its address until it is
 * released; a released address is quarantined before another owner can get it.
 */
export class AddressPool {
  private readonly first: number;
  private readonly last: number;
  private readonly byOwner = new Map<string, string>();
  private readonly byIp = new Map<string, string>();
  private readonly quarantine = new Map<string, number>();
  private readonly reserved = new Set<string>();
  private readonly quarantineMs: number;
  private readonly now: () => number;

  constructor(readonly subnet: string, opts: AddressPoolOptions = {}) {
    const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(subnet);
    if (!m) throw new Error(`bad subnet ${JSON.stringify(subnet)}`);
    const bits = Number(m[2]);
    if (bits < 16 || bits > 29) throw new Error(`subnet /${bits} is outside the supported range`);
    const base = (ipToInt(m[1]!) & ((0xffffffff << (32 - bits)) >>> 0)) >>> 0;
    const size = 2 ** (32 - bits);
    this.first = (base >>> 0) + 2; // network address and the conventional gateway .1 are never given out
    this.last = (base >>> 0) + size - 2; // the broadcast address is not either
    for (const r of opts.reserved ?? []) this.reserved.add(r);
    this.quarantineMs = opts.quarantineMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** The owner's address, assigned on first use. Throws when the pool is full. */
  assign(owner: string): string {
    const have = this.byOwner.get(owner);
    if (have) return have;
    const t = this.now();
    for (const [ip, until] of this.quarantine) if (until <= t) this.quarantine.delete(ip);
    for (let n = this.first; n <= this.last; n++) {
      const ip = intToIp(n);
      if (this.byIp.has(ip) || this.quarantine.has(ip) || this.reserved.has(ip)) continue;
      this.byOwner.set(owner, ip);
      this.byIp.set(ip, owner);
      return ip;
    }
    throw new Error("no free address on the app network");
  }

  ownerOf(ip: string): string | undefined {
    return this.byIp.get(ip);
  }

  addressOf(owner: string): string | undefined {
    return this.byOwner.get(owner);
  }

  /** Only for a service that is being deleted. The address stays out of use for the quarantine. */
  release(owner: string): void {
    const ip = this.byOwner.get(owner);
    if (!ip) return;
    this.byOwner.delete(owner);
    this.byIp.delete(ip);
    this.quarantine.set(ip, this.now() + this.quarantineMs);
  }
}

// ---------------------------------------------------------------------------------------------
// What the engine says about a container (typed; raw inspect output never leaves this function)

export const LABEL_SERVICE = "flagship.service";
export const LABEL_GENERATION = "flagship.generation";

export interface ContainerObservation {
  containerId: string;
  generation: number | null;
  serviceLabel: string | null;
  running: boolean;
  startedAt: string;
  /** Network name -> the container's IPv4 on it. */
  addresses: Record<string, string>;
}

/** The fields the resolver needs from `inspect --format {{json .}}`, in Docker's and Podman's shared shape. */
export function parseObservation(json: string): ContainerObservation | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const c = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
  if (!c || typeof c !== "object") return null;
  const state = (c.State ?? {}) as Record<string, unknown>;
  const labels = ((c.Config as Record<string, unknown> | undefined)?.Labels ?? {}) as Record<string, unknown>;
  const nets = ((c.NetworkSettings as Record<string, unknown> | undefined)?.Networks ?? {}) as Record<string, { IPAddress?: unknown }>;
  const addresses: Record<string, string> = {};
  for (const [name, n] of Object.entries(nets)) {
    if (typeof n?.IPAddress === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(n.IPAddress)) addresses[name] = n.IPAddress;
  }
  const gen = typeof labels[LABEL_GENERATION] === "string" ? Number(labels[LABEL_GENERATION]) : NaN;
  const id = typeof c.Id === "string" ? c.Id : "";
  if (!id) return null;
  return {
    containerId: id,
    generation: Number.isSafeInteger(gen) ? gen : null,
    serviceLabel: typeof labels[LABEL_SERVICE] === "string" ? (labels[LABEL_SERVICE] as string) : null,
    running: state.Running === true,
    startedAt: typeof state.StartedAt === "string" ? state.StartedAt : "",
    addresses,
  };
}

export type ObserveFn = (container: string) => Promise<ContainerObservation | null>;

export interface ExpectedContainer {
  serviceId: string;
  container: string;
  network: string;
  /** Podman: the address the pool assigned; the container must be there and nowhere else. Null: Docker's loopback publish. */
  address: string | null;
  port: number;
  generation: number;
}

export type PublishResult = { ok: true; endpoint: Endpoint } | { ok: false; reason: string };

/**
 * Publish an endpoint only for the container the daemon created: right service label, this deploy's
 * generation, running, and on the expected network at the address the pool assigned. Anything else is
 * not published (the proxy answers 503).
 */
export async function publishFromEngine(
  table: EndpointTable,
  key: EndpointKey,
  want: ExpectedContainer,
  observe: ObserveFn,
): Promise<PublishResult> {
  const o = await observe(want.container);
  if (!o) return { ok: false, reason: "the engine has no such container" };
  if (o.serviceLabel !== want.serviceId) return { ok: false, reason: "the container is not labelled for this service" };
  if (o.generation !== want.generation) return { ok: false, reason: "the container belongs to another deploy" };
  if (!o.running) return { ok: false, reason: "the container is not running" };
  const ip = o.addresses[want.network];
  if (!ip) return { ok: false, reason: `the container is not on ${want.network}` };
  if (want.address !== null && ip !== want.address) return { ok: false, reason: "the container is not at the address assigned to its service" };
  const host = want.address === null ? "127.0.0.1" : ip;
  const endpoint: Endpoint = { host, port: want.port, generation: want.generation, incarnation: `${o.containerId}:${o.startedAt}` };
  table.publish(key, endpoint);
  return { ok: true, endpoint };
}

let lastGeneration = 0;
/** A number no earlier deploy of this process (or, by the clock, an earlier process) has had. */
export function nextGeneration(): number {
  lastGeneration = Math.max(lastGeneration + 1, Date.now());
  return lastGeneration;
}

// ---------------------------------------------------------------------------------------------
// Following the engine: a container the engine stopped or restarted behind the daemon's back

/**
 * Keeps the table true to the engine. Each published endpoint is checked against its container: gone,
 * stopped, relabelled or moved means invalidated (connections closed); the same container started again
 * means a NEW incarnation, so the old one's connections close and the new one is published.
 */
export class EndpointReconciler {
  private readonly watched = new Map<string, { key: EndpointKey; want: ExpectedContainer }>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly table: EndpointTable,
    private readonly observe: ObserveFn,
  ) {}

  watch(key: EndpointKey, want: ExpectedContainer): void {
    this.watched.set(keyString(key), { key, want });
  }

  unwatch(serviceId: string, env?: EndpointEnv): void {
    for (const [k, w] of [...this.watched]) if (w.key.serviceId === serviceId && (!env || w.key.env === env)) this.watched.delete(k);
  }

  async tick(): Promise<void> {
    for (const { key, want } of [...this.watched.values()]) {
      const before = this.table.lookup(key);
      const o = await this.observe(want.container);
      const sound =
        !!o &&
        o.running &&
        o.serviceLabel === want.serviceId &&
        o.generation === want.generation &&
        (want.address === null || o.addresses[want.network] === want.address);
      if (!sound) {
        if (before) this.table.invalidate(key.serviceId, key.env);
        continue;
      }
      const incarnation = `${o.containerId}:${o.startedAt}`;
      if (!before || before.incarnation !== incarnation) {
        if (before) this.table.invalidate(key.serviceId, key.env);
        await publishFromEngine(this.table, key, want, async () => o);
      }
    }
  }

  start(everyMs = 3000, onError: (e: unknown) => void = () => {}): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(onError), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
