/**
 * The dedicated database profile (IMPLEMENTATION-PLAN.md §8.4 / P05,
 * docs/app-runtimes.md "Database profiles"): an app's Postgres in its own
 * instance, so a hostile database can exhaust only itself.
 *
 * Each instance is the box's pinned Postgres image in its own container
 * (gVisor when the box has it, no capabilities beyond what Postgres needs to
 * drop to its user, no new privileges), with:
 *   - memory, CPU and process limits of its own (a runaway sort or a
 *     connection storm is OOM-killed or refused inside its cgroup);
 *   - `max_connections`, `temp_file_limit`, WAL and timeout settings of its own;
 *   - its data in its own quota image (appQuota/loopVolumes.ts), fully
 *     allocated up front, so filling it ends in ENOSPC inside that image and
 *     never takes the host's free space, a sibling's or the management reserve;
 *   - a loopback port the box uses and the apps gateway forwards only to that
 *     app's own containers (egress/gateway.ts forwardOwnedPort).
 *
 * The app sees the same `FLAGSHIP_PG_*` variables as with the shared
 * instance (`postgresql://<role>:…@host.flagship.internal:<port>/<db>`), with
 * the same opaque names and role limits. The shared instance stays the
 * compatibility profile: existing apps keep it, and a box whose egress
 * gateway can't forward (so no app could reach a dedicated port) uses it too.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { composeServiceId } from "@flagship/protocol";
import { writeFileDurable } from "../durableFile.js";
import { assignAddress, dialsContainersDirectly, publishAndWatch, releaseAddressFor, stopEndpoint, type CommandRunner } from "../serviceRunner.js";
import { endpoints, nextGeneration, type EndpointKey } from "../endpoints.js";
import type { PostgresAdmin } from "./admin.js";
import { registerDedicatedPort } from "./appSql.js";

export type DatabaseProfile = "shared" | "dedicated";

export const DEDICATED_PG_IMAGE =
  "pgvector/pgvector:0.8.7-pg18-trixie@sha256:9d9c930220cb9bf2f956d10a8f909cf9973d9672ca0278aef2c1e6facccad2e0";
export const DEDICATED_ADMIN_USER = "flagship_admin";
const MiB = 1024 * 1024;

export interface DedicatedLimits {
  memoryMiB: number;
  cpus: string;
  pids: number;
  maxConnections: number;
  diskBytes: number;
}

export const DEFAULT_DEDICATED_LIMITS: DedicatedLimits = {
  memoryMiB: 256,
  cpus: "0.50",
  pids: 128,
  maxConnections: 20,
  diskBytes: 512 * MiB,
};
export const MIN_DEDICATED_DISK = 64 * MiB;
export const MAX_DEDICATED_DISK = 64 * 1024 * MiB;

/** 24 hex naming an app's instance (opaque: names neither the account nor the app). */
export function dedicatedKey(creator: string, slug: string): string {
  return createHash("sha256").update(`flagship/dedicated-pg/v1|${creator}|${slug}`).digest("hex").slice(0, 24);
}
export const dedicatedContainer = (key: string) => `flagship-pgd-${key}`;
/** The endpoint table's service id for an app's own database. */
export const dedicatedServiceId = (key: string) => `pgd-${key}`;
const dedicatedEndpointKey = (key: string): EndpointKey => ({ serviceId: dedicatedServiceId(key), env: "live", component: "db", role: "data" });
export const dedicatedVolume = (key: string) => `flagship-pgdata-${key}`;
/** The instance's Unix-socket folder: its migration sandbox's only way in (migrationSandbox.ts). */
export const dedicatedSocketVolume = (key: string) => `flagship-pgsock-${key}`;
export function isDedicatedVolume(name: string): boolean {
  return /^flagship-pgdata-[0-9a-f]{24}$/.test(name);
}

/** Postgres settings every dedicated instance runs with. */
export function dedicatedServerSettings(l: DedicatedLimits): string[] {
  const settings: Array<[string, string]> = [
    ["listen_addresses", "*"],
    ["max_connections", String(l.maxConnections)],
    ["superuser_reserved_connections", "3"],
    ["shared_buffers", `${Math.max(16, Math.floor(l.memoryMiB / 8))}MB`],
    ["work_mem", "4MB"],
    ["maintenance_work_mem", "32MB"],
    ["temp_file_limit", `${Math.max(16, Math.floor(l.diskBytes / MiB / 4))}MB`],
    ["max_wal_size", `${Math.max(64, Math.floor(l.diskBytes / MiB / 8))}MB`],
    ["min_wal_size", "32MB"],
    ["statement_timeout", "30s"],
    ["idle_in_transaction_session_timeout", "60s"],
    ["max_parallel_workers_per_gather", "0"],
    ["log_min_messages", "warning"],
  ];
  return settings.flatMap(([k, v]) => ["-c", `${k}=${v}`]);
}

/** The `docker run` of one instance (pure, for tests and serviceRunner's mount guard). */
export function dedicatedRunArgs(a: {
  key: string;
  port: number;
  adminPassword: string;
  limits: DedicatedLimits;
  sandbox: string[];
  network: string;
  image?: string;
  /** Podman: the address this instance owns on `network` (no published port). Absent: Docker's loopback publish. */
  address?: string;
  generation?: number;
}): string[] {
  if (!/^[0-9a-f]{24}$/.test(a.key)) throw new Error("bad instance key");
  if (!Number.isInteger(a.port) || a.port < 1024 || a.port > 65535) throw new Error("bad port");
  return [
    "run",
    "-d",
    "--name",
    dedicatedContainer(a.key),
    "--label",
    "flagship.role=dedicated-postgres",
    "--label",
    `flagship.service=${dedicatedServiceId(a.key)}`,
    "--label",
    `flagship.generation=${a.generation ?? 0}`,
    "--restart",
    "unless-stopped",
    ...a.sandbox,
    "--cap-drop=ALL",
    // initdb and the image's entrypoint chown the data folder and drop to the postgres user.
    ...["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID"].flatMap((c) => ["--cap-add", c]),
    "--security-opt=no-new-privileges",
    "--network",
    a.network,
    "--memory",
    `${a.limits.memoryMiB}m`,
    "--memory-swap",
    `${a.limits.memoryMiB}m`,
    "--cpus",
    a.limits.cpus,
    "--pids-limit",
    String(a.limits.pids),
    "--shm-size",
    "64m",
    "-e",
    `POSTGRES_USER=${DEDICATED_ADMIN_USER}`,
    "-e",
    `POSTGRES_PASSWORD=${a.adminPassword}`,
    "-e",
    "POSTGRES_DB=postgres",
    // Passwords on the socket too: the image's default trusts local connections.
    "-e",
    "POSTGRES_INITDB_ARGS=--auth-local=scram-sha-256 --auth-host=scram-sha-256",
    ...(a.address ? ["--ip", a.address] : ["-p", `127.0.0.1:${a.port}:5432`]),
    "--mount",
    `type=volume,src=${dedicatedVolume(a.key)},dst=/var/lib/postgresql`,
    "--mount",
    `type=volume,src=${dedicatedSocketVolume(a.key)},dst=/var/run/postgresql`,
    a.image ?? DEDICATED_PG_IMAGE,
    "postgres",
    ...dedicatedServerSettings(a.limits),
  ];
}

export interface DedicatedEntry {
  key: string;
  creator: string;
  slug: string;
  port: number;
  adminPassword: string;
  limits: DedicatedLimits;
  createdAt: number;
}

/** An instance's admin login, for the whole-box dumps and their reload (volumeDump.ts). */
export interface DedicatedLogin {
  key: string;
  container: string;
  user: string;
  password: string;
}

const loginOf = (e: DedicatedEntry): DedicatedLogin => ({
  key: e.key,
  container: dedicatedContainer(e.key),
  user: DEDICATED_ADMIN_USER,
  password: e.adminPassword,
});

/** A state entry is only taken for the instance its own app's key names. */
const entryIsSound = (key: string, e: DedicatedEntry | undefined): e is DedicatedEntry =>
  !!e && /^[0-9a-f]{24}$/.test(key) && e.key === key && dedicatedKey(e.creator, e.slug) === key;

export interface DedicatedStateStore {
  load(): Promise<Record<string, DedicatedEntry>>;
  save(s: Record<string, DedicatedEntry>): Promise<void>;
}

export function fileDedicatedStateStore(path: string): DedicatedStateStore {
  return {
    load: async () => {
      try {
        return JSON.parse(await readFile(path, "utf8")) as Record<string, DedicatedEntry>;
      } catch {
        return {};
      }
    },
    save: (s) => writeFileDurable(path, JSON.stringify(s, null, 2) + "\n", 0o600),
  };
}

export function memoryDedicatedStateStore(): DedicatedStateStore {
  let s: Record<string, DedicatedEntry> = {};
  return { load: async () => structuredClone(s), save: async (n) => void (s = structuredClone(n)) };
}

export interface DedicatedPostgresDeps {
  cmd: CommandRunner;
  /** The quota image behind the data volume (appQuota/loopVolumes.ts). */
  volumes: {
    create(volume: string, sizeBytes: number, labels?: Record<string, string>): Promise<void>;
    remove(volume: string): Promise<void>;
    prepare(volume: string, sizeBytes: number): Promise<unknown>;
    imagePath(volume: string): string;
  };
  /** Allocate every block of an image (no overcommit): `fallocate -l <size> <file>`. */
  preallocate?: (path: string, bytes: number) => Promise<void>;
  /** Free bytes on the disk holding the images, and its size. */
  disk?: () => Promise<{ freeBytes: number; totalBytes: number }>;
  ports: { portFor(key: string): Promise<number>; release(prefix: string): Promise<number[]> };
  /** The apps gateway's owned-port forwarding; null when it doesn't enforce. */
  links: () => { link(port: number, target: { host: string; port: number }, owner: string): Promise<boolean>; unlink(port: number): Promise<void> } | null;
  state: DedicatedStateStore;
  admin: (adminUrl: string) => PostgresAdmin;
  sandboxArgs?: () => Promise<string[]>;
  network?: string;
  image?: string;
  /** Resolves once the instance accepts connections (tests replace it). */
  waitReady?: (container: string) => Promise<void>;
  onLog?: (m: string) => void;
}

/** Room a dedicated image must leave on the disk: 2 GiB or a tenth of it, whichever is more. */
export function diskRoomLeft(totalBytes: number): number {
  return Math.max(2 * 1024 * MiB, Math.floor(totalBytes / 10));
}

export class DedicatedPostgres {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: DedicatedPostgresDeps) {}

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private log(m: string): void {
    this.deps.onLog?.(`[dedicated-db] ${m}`);
  }

  /** Whether an app's container could reach a dedicated instance now. */
  available(): boolean {
    return this.deps.links() !== null;
  }

  private adminUrl(e: DedicatedEntry): string {
    // The host comes from the endpoint table (the instance this daemon started), never from a stored address.
    const ep = endpoints.lookup(dedicatedEndpointKey(e.key));
    if (!ep) throw new Error("the app's database is not reachable right now");
    return `postgresql://${DEDICATED_ADMIN_USER}:${encodeURIComponent(e.adminPassword)}@${ep.host}:${ep.port}/postgres`;
  }

  private async waitReady(container: string): Promise<void> {
    if (this.deps.waitReady) return this.deps.waitReady(container);
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        await this.deps.cmd.run("docker", ["exec", container, "pg_isready", "-q", "-h", "127.0.0.1", "-U", DEDICATED_ADMIN_USER]);
        return;
      } catch {
        if (Date.now() > deadline) throw new Error("the app's database didn't start");
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  /** The daemon's own dial, through the table, answers (the engine's check ran inside the container). */
  private async waitDialable(key: EndpointKey): Promise<void> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const lease = endpoints.acquire(key);
      if (lease) {
        try {
          const ok = await new Promise<boolean>((resolve) => {
            const sock = connect({ host: lease.endpoint.host, port: lease.endpoint.port, timeout: 1500 });
            sock.once("connect", () => (sock.destroy(), resolve(true)));
            sock.once("timeout", () => (sock.destroy(), resolve(false)));
            sock.once("error", () => resolve(false));
          });
          if (ok && lease.current()) return;
        } finally {
          lease.release();
        }
      }
      if (Date.now() > deadline) throw new Error("the app's database didn't answer on its address");
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private async running(container: string): Promise<boolean> {
    if (!this.deps.cmd.capture) return false;
    try {
      return (await this.deps.cmd.capture("docker", ["inspect", "-f", "{{.State.Running}}", container])).stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  /** The deploy number a container carries as a label (a container created by an earlier daemon run). */
  private async generationOf(container: string): Promise<number | null> {
    if (!this.deps.cmd.capture) return null;
    try {
      const out = (await this.deps.cmd.capture("docker", ["inspect", "-f", '{{index .Config.Labels "flagship.generation"}}', container])).stdout.trim();
      return /^\d{1,16}$/.test(out) ? Number(out) : null;
    } catch {
      return null;
    }
  }

  private async exists(container: string): Promise<boolean> {
    if (!this.deps.cmd.capture) return false;
    try {
      await this.deps.cmd.capture("docker", ["inspect", "-f", "{{.Id}}", container]);
      return true;
    } catch {
      return false;
    }
  }

  private async startEntry(e: DedicatedEntry): Promise<void> {
    const container = dedicatedContainer(e.key);
    await this.deps.volumes.prepare(dedicatedVolume(e.key), e.limits.diskBytes);
    const network = this.deps.network ?? "flagship-apps";
    const direct = dialsContainersDirectly();
    const address = direct ? await assignAddress(this.deps.cmd, network, `db:${e.key}`) : undefined;
    // A start or restart is a new incarnation: nothing keeps talking to the old one.
    stopEndpoint(dedicatedServiceId(e.key), "live");
    let generation = nextGeneration();
    let unlabelled = false;
    if (!(await this.running(container))) {
      if (await this.exists(container)) {
        // A container the engine kept keeps its labels: its generation is the one it was created with.
        const had = await this.generationOf(container);
        if (had !== null) generation = had;
        else unlabelled = !direct;
        await this.deps.cmd.run("docker", ["start", container]);
      } else {
        const sandbox = (await this.deps.sandboxArgs?.().catch(() => [])) ?? [];
        await this.deps.cmd.run(
          "docker",
          dedicatedRunArgs({
            key: e.key,
            port: e.port,
            adminPassword: e.adminPassword,
            limits: e.limits,
            sandbox,
            network,
            generation,
            ...(address ? { address } : {}),
            ...(this.deps.image ? { image: this.deps.image } : {}),
          }),
        );
      }
    } else {
      const had = await this.generationOf(container);
      if (had !== null) generation = had;
      else unlabelled = !direct;
    }
    registerDedicatedPort(e.port, dedicatedEndpointKey(e.key));
    await publishAndWatch(this.deps.cmd, dedicatedEndpointKey(e.key), { serviceId: dedicatedServiceId(e.key), container, network, address: address ?? null, port: direct ? 5432 : e.port, generation, ...(unlabelled ? { unlabelled } : {}) });
    await this.waitReady(container);
    if (!this.deps.waitReady) await this.waitDialable(dedicatedEndpointKey(e.key));
    const links = this.deps.links();
    const ep = endpoints.lookup(dedicatedEndpointKey(e.key));
    if (!ep) throw new Error("the app's database is not reachable right now");
    if (links && !(await links.link(e.port, { host: ep.host, port: ep.port }, composeServiceId(e.creator, e.slug)))) {
      throw new Error("the box could not route the app's database");
    }
  }

  /** The instance for an app, made on first use. */
  forApp(creator: string, slug: string, opts: { diskBytes?: number } = {}): Promise<{ admin: PostgresAdmin; port: number; container: string }> {
    return this.locked(async () => {
      if (!this.available()) throw new Error("this server can't give apps their own database yet (its egress gateway isn't running)");
      const key = dedicatedKey(creator, slug);
      const state = await this.deps.state.load();
      let e = state[key];
      if (!e) {
        const diskBytes = Math.min(MAX_DEDICATED_DISK, Math.max(MIN_DEDICATED_DISK, opts.diskBytes ?? DEFAULT_DEDICATED_LIMITS.diskBytes));
        if (this.deps.disk) {
          const d = await this.deps.disk();
          if (d.freeBytes - diskBytes < diskRoomLeft(d.totalBytes)) {
            throw new Error(`this server doesn't have room for the app's own database (${Math.round(diskBytes / MiB)} MiB)`);
          }
        }
        const volume = dedicatedVolume(key);
        await this.deps.volumes.create(volume, diskBytes, { "flagship.role": "dedicated-postgres" });
        await this.deps.preallocate?.(this.deps.volumes.imagePath(volume), diskBytes);
        e = {
          key,
          creator,
          slug,
          port: await this.deps.ports.portFor(`db:${key}`),
          adminPassword: randomBytes(24).toString("base64url"),
          limits: { ...DEFAULT_DEDICATED_LIMITS, diskBytes },
          createdAt: Date.now(),
        };
        state[key] = e;
        await this.deps.state.save(state);
        this.log(`${composeServiceId(creator, slug)}: own database instance on port ${e.port} (${Math.round(diskBytes / MiB)} MiB)`);
      }
      await this.startEntry(e);
      return { admin: this.deps.admin(this.adminUrl(e)), port: e.port, container: dedicatedContainer(key) };
    });
  }

  /** Drop an app's instance and every byte of it (uninstall, a failed install). */
  dropApp(creator: string, slug: string): Promise<void> {
    return this.locked(async () => {
      const key = dedicatedKey(creator, slug);
      const state = await this.deps.state.load();
      const e = state[key];
      const container = dedicatedContainer(key);
      stopEndpoint(dedicatedServiceId(key), "live");
      await this.deps.cmd.run("docker", ["rm", "-f", container]).catch(() => {});
      await releaseAddressFor(this.deps.network ?? "flagship-apps", `db:${key}`).catch(() => {});
      await this.deps.cmd.run("docker", ["volume", "rm", dedicatedSocketVolume(key)]).catch(() => {});
      if (e) await this.deps.links()?.unlink(e.port).catch(() => {});
      await this.deps.volumes.remove(dedicatedVolume(key)).catch((err: Error) => this.log(`${key}: volume not removed: ${err.message}`));
      await this.deps.ports.release(`db:${key}`);
      if (e) {
        delete state[key];
        await this.deps.state.save(state);
      }
    });
  }

  /** At boot: every instance up and routed again. */
  async startAll(): Promise<{ started: string[]; failed: string[] }> {
    const state = await this.deps.state.load();
    const started: string[] = [];
    const failed: string[] = [];
    for (const e of Object.values(state)) {
      try {
        await this.locked(() => this.startEntry(e));
        started.push(e.key);
      } catch (err) {
        failed.push(e.key);
        this.log(`${composeServiceId(e.creator, e.slug)}: database instance not started: ${(err as Error).message}`);
      }
    }
    return { started, failed };
  }

  /** Every instance this box keeps, with its admin login (the whole-box dumps). */
  async backupLogins(): Promise<DedicatedLogin[]> {
    const state = await this.deps.state.load();
    return Object.keys(state)
      .sort()
      .filter((k) => entryIsSound(k, state[k]))
      .map((k) => loginOf(state[k]!));
  }

  /**
   * A restored instance up again so its dump can be loaded into it. When the
   * restore brought back only its state, its quota image is made first: Docker
   * must never make an unlimited volume of that name. Null: no such instance here.
   */
  restoreLogin(key: string): Promise<DedicatedLogin | null> {
    return this.locked(async () => {
      const e = (await this.deps.state.load())[key];
      if (!entryIsSound(key, e)) return null;
      const volume = dedicatedVolume(key);
      if ((await this.deps.volumes.prepare(volume, e.limits.diskBytes)) === "absent") {
        if (this.deps.disk) {
          const d = await this.deps.disk();
          if (d.freeBytes - e.limits.diskBytes < diskRoomLeft(d.totalBytes)) {
            throw new Error(`this server doesn't have room for the app's own database (${Math.round(e.limits.diskBytes / MiB)} MiB)`);
          }
        }
        await this.deps.volumes.create(volume, e.limits.diskBytes, { "flagship.role": "dedicated-postgres" });
        await this.deps.preallocate?.(this.deps.volumes.imagePath(volume), e.limits.diskBytes);
      }
      await this.startEntry(e);
      return loginOf(e);
    });
  }

  /** The socket volume of the instance on `port` (a migration's target), or null. */
  async socketForPort(port: number): Promise<string | null> {
    const e = Object.values(await this.deps.state.load()).find((x) => x.port === port);
    return e ? dedicatedSocketVolume(e.key) : null;
  }

  /** On a box that dials containers directly, the app whose instance is on `port`: its migrations go through the gateway like the app does. */
  async memberForPort(port: number): Promise<string | null> {
    if (!dialsContainersDirectly()) return null;
    const e = Object.values(await this.deps.state.load()).find((x) => x.port === port);
    return e ? composeServiceId(e.creator, e.slug) : null;
  }

  async volumes(): Promise<string[]> {
    return Object.keys(await this.deps.state.load()).map(dedicatedVolume);
  }

  /** What the owner's app page shows: the profile and its limits. */
  async describe(creator: string, slug: string): Promise<{ profile: "dedicated"; port: number; limits: DedicatedLimits } | null> {
    const e = (await this.deps.state.load())[dedicatedKey(creator, slug)];
    return e ? { profile: "dedicated", port: e.port, limits: e.limits } : null;
  }
}
