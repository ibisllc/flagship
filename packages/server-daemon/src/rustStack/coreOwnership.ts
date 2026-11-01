/**
 * The daemon as the executor of core's app reconciler (flagship-core `apps.rs`, G3).
 *
 * Every app container effect on the live app network and the local-AI model server goes through
 * here. In `shadow` mode (the default) the daemon still performs its own deploys and stops and only
 * tells core what it wants and what the engine shows, so core can compare. In `rust` mode the
 * daemon asks: `ensure` records what it wants and returns once core has made it so; core hands out
 * each effect (deploy at this generation and address, remove that generation) after journalling
 * it, the daemon performs exactly that effect with its existing engine code (AppRunner on Podman)
 * and reports the outcome. The daemon never decides an effect itself while core owns them, so a
 * restart of either side, or both, converges without a second copy or a lost container.
 *
 * What stays with the daemon: app groups' extra components, WASI apps, staging and build
 * containers, and the data services (Postgres, Forgejo). Those are documented as remaining for
 * the next steps (docs/architecture-v2/broker-runtime-core.md §11).
 */
import { createHash, randomBytes } from "node:crypto";
import { Socket } from "node:net";
import { cpus, totalmem } from "node:os";
import { LABEL_SERVICE, parseObservation } from "../endpoints.js";
import type { CommandRunner } from "../serviceRunner.js";
import { inspectNetwork } from "../egress/networks.js";

import { CORE_SOCKET_PATH } from "./units.js";

export const CORE_SOCKET = CORE_SOCKET_PATH;

export type WorkloadKind = "app" | "local-ai";
export type ReconcilerMode = "shadow" | "rust";

export interface OwnedWorkload {
  installation: string;
  component: string;
  kind: WorkloadKind;
  network: string;
  specDigest: string;
  running: boolean;
  epoch: number;
  resources: { memoryBytes: number; cpuMillis: number };
  wantsAddress: boolean;
}

export interface WorkloadOps {
  /** Create and start the container labelled with `generation`, at `address` when given. */
  deploy(o: { generation: number; address: string | null }): Promise<void>;
}

export interface ObservedContainer {
  name: string;
  containerId: string;
  installation: string;
  component: string;
  generation: number | null;
  running: boolean;
  startedAt: string;
  addresses: Record<string, string>;
}

export interface CoreEffect {
  op: number;
  kind: "deploy" | "remove";
  installation: string;
  component: string;
  generation: number;
  specDigest: string | null;
  epoch: number;
  network: string;
  address: string | null;
}

export interface CoreWorkloadStatus {
  installation: string;
  component: string;
  state: string;
  generation: number | null;
  reason: string | null;
}

export interface CoreSyncResponse {
  mode: ReconcilerMode;
  live: boolean;
  effects: CoreEffect[];
  workloads: CoreWorkloadStatus[];
  divergent: string[];
  agreePasses: number;
  unmanaged: string[];
  term: number;
}

export const keyOf = (installation: string, component: string) => `${installation}/${component}`;

/** SHA-256 of a value's JSON with sorted keys: the same spec always gives the same digest. */
export function specDigest(v: unknown): string {
  const stable = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(stable);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, stable((x as Record<string, unknown>)[k])]));
    return x;
  };
  return createHash("sha256").update(JSON.stringify(stable(v))).digest("hex");
}

/** Docker's memory notation (`512m`, `2g`, bytes) in bytes; 0 when it can't be read. */
export function memoryBytes(s: string | undefined): number {
  const m = /^(\d+(?:\.\d+)?)([bkmg])?$/i.exec((s ?? "").trim());
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = (m[2] ?? "b").toLowerCase();
  const mult = unit === "g" ? 1024 ** 3 : unit === "m" ? 1024 ** 2 : unit === "k" ? 1024 : 1;
  return Math.floor(n * mult);
}

/** The workload a container stands for, from its name and service label; null for anything else. */
export function workloadOfContainer(name: string, serviceLabel: string | null): { installation: string; component: string } | null {
  const ai = /^flagship-localai-[0-9a-f]{16}$/.exec(name);
  if (ai) return serviceLabel === "local-ai" ? { installation: "local-ai", component: "model" } : null;
  const m = /^flagship-([a-z0-9][a-z0-9-]*--[a-z0-9][a-z0-9-]*)(?:\.([a-z0-9][a-z0-9-]{0,62}))?$/.exec(name);
  if (!m || m[1]!.startsWith("stg-") || serviceLabel !== m[1]) return null;
  return { installation: m[1]!, component: m[2] ?? "main" };
}

/** What the engine runs that core may own: every container with a Flagship service label. */
export async function observeContainers(cmd: CommandRunner): Promise<ObservedContainer[]> {
  return (await observeEngine(cmd)).observed;
}

/**
 * The workloads core may own, and the addresses every other Flagship container holds on the same
 * networks (staging copies and builds share the model server's network; core never gives those out).
 */
export async function observeEngine(cmd: CommandRunner): Promise<{ observed: ObservedContainer[]; occupied: Array<{ network: string; ip: string }> }> {
  const occupied: Array<{ network: string; ip: string }> = [];
  if (!cmd.capture) return { observed: [], occupied };
  const names = (await cmd.capture("docker", ["ps", "-a", "--filter", `label=${LABEL_SERVICE}`, "--format", "{{.Names}}"])).stdout
    .split("\n")
    .map((n) => n.trim())
    .filter(Boolean);
  const out: ObservedContainer[] = [];
  for (const name of names) {
    let o;
    try {
      o = parseObservation((await cmd.capture("docker", ["inspect", "--format", "{{json .}}", name])).stdout.trim());
    } catch {
      continue;
    }
    if (!o) continue;
    const w = workloadOfContainer(name, o.serviceLabel);
    if (!w) {
      for (const [network, ip] of Object.entries(o.addresses)) occupied.push({ network, ip });
      continue;
    }
    out.push({ name, containerId: o.containerId, ...w, generation: o.generation, running: o.running, startedAt: o.startedAt, addresses: o.addresses });
  }
  return { observed: out, occupied };
}

/** One framed request to core's socket (4-byte big-endian length, then JSON). */
export async function coreCall(req: unknown, socketPath = CORE_SOCKET, timeoutMs = 30_000): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const s = new Socket();
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => {
      s.destroy();
      reject(new Error("the Rust controller did not answer in time"));
    }, timeoutMs);
    t.unref?.();
    const done = (e: Error | null, v?: unknown) => {
      clearTimeout(t);
      s.destroy();
      if (e) reject(e);
      else resolve(v);
    };
    s.on("error", (e) => done(new Error(`the Rust controller is not answering: ${e.message}`)));
    s.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      const n = buf.readUInt32BE(0);
      if (n === 0 || n > 16 << 20) return done(new Error("bad frame from the Rust controller"));
      if (buf.length < 4 + n) return;
      let v: { ok?: boolean; result?: unknown; error?: string };
      try {
        v = JSON.parse(buf.subarray(4, 4 + n).toString("utf8")) as typeof v;
      } catch {
        return done(new Error("bad answer from the Rust controller"));
      }
      if (v.ok !== true) return done(new Error(`the Rust controller refused: ${v.error ?? "no reason"}`));
      done(null, v.result);
    });
    s.connect(socketPath, () => {
      const body = Buffer.from(JSON.stringify(req), "utf8");
      const head = Buffer.alloc(4);
      head.writeUInt32BE(body.length, 0);
      s.write(Buffer.concat([head, body]));
    });
  });
}

export interface CoreOwnershipDeps {
  mode: () => ReconcilerMode;
  call?: (req: unknown) => Promise<unknown>;
  observe: () => Promise<ObservedContainer[]>;
  /** Addresses containers core does not own hold (asked right after `observe`). */
  occupied?: () => Promise<Array<{ network: string; ip: string }>>;
  networks: () => Promise<Array<{ name: string; subnet: string; gateways: string[] }>>;
  /** Stop and delete the container of exactly this workload and generation (already gone = done). */
  removeContainer: (o: { installation: string; component: string; generation: number }) => Promise<void>;
  capacity?: () => { memoryBytes: number; cpuMillis: number };
  log?: (m: string) => void;
  executor?: string;
  /** How long `ensure` and `stop` wait for core to make it so. */
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class CoreOwnership {
  readonly executor: string;
  private readonly registry = new Map<string, { w: OwnedWorkload; ops?: WorkloadOps }>();
  private readonly forgets = new Map<string, { installation: string; component: string }>();
  private chain: Promise<unknown> = Promise.resolve();
  private last: CoreSyncResponse | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly errors = new Map<number, string>();

  constructor(private readonly d: CoreOwnershipDeps) {
    this.executor = d.executor ?? randomBytes(12).toString("hex");
  }

  /** True while core owns the effects: the daemon performs only what core hands it. */
  live(): boolean {
    return this.d.mode() === "rust";
  }

  lastResponse(): CoreSyncResponse | null {
    return this.last;
  }

  /** Shadow bookkeeping: what the daemon wants, for core to compare (the daemon acts itself). */
  note(w: OwnedWorkload, ops?: WorkloadOps): void {
    this.registry.set(keyOf(w.installation, w.component), { w, ...(ops ? { ops } : {}) });
    this.forgets.delete(keyOf(w.installation, w.component));
    if (!this.live()) void this.pump().catch(() => {});
  }

  /** Shadow bookkeeping: the daemon stopped this workload itself. */
  noteStopped(installation: string, component: string): void {
    const key = keyOf(installation, component);
    const have = this.registry.get(key);
    if (have) this.registry.set(key, { ...have, w: { ...have.w, running: false } });
    if (!this.live()) void this.pump().catch(() => {});
  }

  /** Want `w` running (or stopped) and wait until core has made it so. */
  async ensure(w: OwnedWorkload, ops: WorkloadOps): Promise<void> {
    const key = keyOf(w.installation, w.component);
    this.registry.set(key, { w, ops });
    this.forgets.delete(key);
    await this.waitFor(key, (s) => (w.running ? s?.state === "running" : s === undefined || s.state === "stopped"));
  }

  async stop(installation: string, component: string): Promise<void> {
    const key = keyOf(installation, component);
    const have = this.registry.get(key);
    if (!have) {
      // Nothing known in this process: still tell core (it may hold it from before a restart).
      this.forgets.set(key, { installation, component });
      await this.pump();
      return;
    }
    this.registry.set(key, { ...have, w: { ...have.w, running: false } });
    await this.waitFor(key, (s) => s === undefined || s.state === "stopped");
  }

  /** The workload is gone for good (an uninstall): its container is removed and its address freed. */
  async forget(installation: string, component: string): Promise<void> {
    const key = keyOf(installation, component);
    this.registry.delete(key);
    this.forgets.set(key, { installation, component });
    await this.pump().catch((e: Error) => this.d.log?.(`[core] forget ${key}: ${e.message}`));
  }

  start(intervalMs = 10_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pump().catch((e: Error) => this.d.log?.(`[core] ${e.message}`)), intervalMs);
    this.timer.unref?.();
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async waitFor(key: string, done: (s: CoreWorkloadStatus | undefined) => boolean): Promise<void> {
    const deadline = Date.now() + (this.d.waitMs ?? 5 * 60_000);
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (;;) {
      const r = await this.pump();
      const s = r.workloads.find((x) => keyOf(x.installation, x.component) === key);
      if (done(s)) return;
      if (s && (s.state === "failed" || s.state === "unschedulable")) throw new Error(s.reason ?? `the app is ${s.state}`);
      if (Date.now() > deadline) throw new Error(`the Rust controller did not finish with ${key}${s?.reason ? ` (${s.reason})` : ""}`);
      await sleep(r.effects.length > 0 ? 50 : 1000);
    }
  }

  /** One sync, the effects it hands out performed and settled, repeated while there are effects. */
  pump(): Promise<CoreSyncResponse> {
    const run = this.chain.then(() => this.pumpOnce());
    this.chain = run.catch(() => {});
    return run;
  }

  private async pumpOnce(): Promise<CoreSyncResponse> {
    const call = this.d.call ?? ((req: unknown) => coreCall(req));
    let r!: CoreSyncResponse;
    for (let round = 0; round < 8; round++) {
      const mode = this.d.mode();
      const forget = [...this.forgets.values()];
      const sync = {
        executor: this.executor,
        mode,
        desired: [...this.registry.values()].map((e) => e.w),
        forget,
        observed: await this.d.observe(),
        occupied: (await this.d.occupied?.().catch(() => [])) ?? [],
        networks: await this.d.networks().catch(() => []),
        capacity: (this.d.capacity ?? defaultCapacity)(),
      };
      r = (await call({ op: "Sync", sync })) as CoreSyncResponse;
      for (const f of forget) this.forgets.delete(keyOf(f.installation, f.component));
      this.last = r;
      if (!r.live || r.effects.length === 0) return r;
      let performed = 0;
      for (const e of r.effects) {
        const key = keyOf(e.installation, e.component);
        const ops = this.registry.get(key)?.ops;
        let outcome: "ok" | "definite" | "unknown" = "ok";
        let detail: string | undefined;
        let conflictIp: string | undefined;
        try {
          if (e.kind === "remove") {
            await this.d.removeContainer({ installation: e.installation, component: e.component, generation: e.generation });
          } else {
            // A deploy core wants for a spec this process doesn't hold yet (just after a restart):
            // it waits with core until the app's owner code asks for it again.
            if (!ops) continue;
            await ops.deploy({ generation: e.generation, address: e.address });
          }
        } catch (err) {
          const msg = (err as Error).message;
          detail = msg.slice(0, 2000);
          const taken = /requested ip address (\d{1,3}(?:\.\d{1,3}){3}) is already allocated/.exec(msg);
          if (taken) conflictIp = taken[1];
          outcome = /timed out|ETIMEDOUT|ECONNRESET|EPIPE/i.test(msg) ? "unknown" : "definite";
          this.errors.set(e.op, msg);
        }
        performed++;
        await call({ op: "Settle", settle: { executor: this.executor, op: e.op, outcome, ...(detail ? { detail } : {}), ...(conflictIp ? { conflictIp } : {}) } });
      }
      if (performed === 0) return r;
    }
    return r;
  }
}

function defaultCapacity(): { memoryBytes: number; cpuMillis: number } {
  // The box keeps 512 MiB for itself (the daemon, keyd, the broker, Postgres's base).
  return { memoryBytes: Math.max(0, totalmem() - 512 * 1024 ** 2), cpuMillis: cpus().length * 1000 };
}

/** The networks core's address pools come from. */
export async function networksFor(cmd: CommandRunner, names: readonly string[]): Promise<Array<{ name: string; subnet: string; gateways: string[] }>> {
  const out: Array<{ name: string; subnet: string; gateways: string[] }> = [];
  for (const name of names) {
    const info = await inspectNetwork(cmd, name).catch(() => null);
    const subnet = info?.subnets[0];
    if (subnet) out.push({ name, subnet, gateways: info.gateways });
  }
  return out;
}

/** The one instance on this daemon (index.ts sets it on an arch-v2 box with core serving). */
let current: CoreOwnership | null = null;
export function setCoreOwnership(o: CoreOwnership | null): void {
  current?.stopTimer();
  current = o;
}
export function coreOwnership(): CoreOwnership | null {
  return current;
}
