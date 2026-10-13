/**
 * The box's data-layer stack (installer/data-services/docker-compose.yml):
 * make sure its core store (Postgres) is up, and tell the provisioner whether
 * it is. Apps' files folders are Docker volumes and need no stack.
 *
 * The unit `flagship-data-services.service` runs init.sh on every boot. A box
 * installed before that fix carries an older unit that ran init.sh only until
 * it had written the secrets file, so one failed first run (home3: the `mc`
 * download it no longer does) left the stack down for good. At boot, in the
 * background, the daemon therefore:
 *
 *   1. installs the current unit from the checkout over an older one;
 *   2. checks the core containers; when one is missing or stopped, brings the
 *      core up itself (`docker compose … up -d postgres`), or
 *      starts the unit when the secrets file doesn't exist yet;
 *   3. waits, bounded, for their healthchecks, then runs the `onHealthy`
 *      hooks (the runtime attaches the provisioner's admins there) and starts
 *      the unit so the optional services (forgejo, chromium, …) come up too.
 *
 * Nothing here blocks the tunnel or HTTPS. Provisioning asks `ready()`, which
 * fails fast with a `DataLayerUnavailableError` while the stack is down (and
 * kicks another bring-up), so a caller can say why instead of timing out.
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CommandRunner } from "../serviceRunner.js";

export const DATA_COMPOSE_FILE = "/opt/flagship/installer/data-services/docker-compose.yml";
export const DATA_ENV_FILE = "/var/flagship/data-services.env";
export const DATA_UNIT_NAME = "flagship-data-services.service";
export const DATA_UNIT_FILE = `/etc/systemd/system/${DATA_UNIT_NAME}`;

/** The store apps' data needs; the compose file's other services are optional. */
export const CORE_SERVICES = ["postgres"] as const;
export const CORE_CONTAINERS: Record<(typeof CORE_SERVICES)[number], string> = {
  postgres: "flagship-postgres",
};

export type DataLayerState = "absent" | "starting" | "healthy" | "down";

export interface DataLayerStatus {
  state: DataLayerState;
  /** Why it's down or still starting (box-side detail for logs and the owner). */
  reason?: string;
}

/** Thrown by `ready()` when the core stores can't be used right now. */
export class DataLayerUnavailableError extends Error {
  readonly code = "data-layer-unavailable";
  constructor(
    readonly state: Exclude<DataLayerState, "healthy" | "absent">,
    detail?: string,
  ) {
    super(
      state === "starting"
        ? `the data layer (Postgres) is still starting${detail ? `: ${detail}` : ""}`
        : `the data layer (Postgres) isn't running${detail ? `: ${detail}` : ""}`,
    );
    this.name = "DataLayerUnavailableError";
  }
}

export function isDataLayerUnavailable(e: unknown): e is DataLayerUnavailableError {
  return e instanceof Error && (e as { code?: unknown }).code === "data-layer-unavailable";
}

export interface DataStackFs {
  exists(path: string): boolean;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
}

const realFs: DataStackFs = {
  exists: (p) => existsSync(p),
  read: (p) => readFile(p, "utf8"),
  write: (p, c) => writeFile(p, c, { mode: 0o644 }),
};

export interface DataStackOptions {
  cmd: CommandRunner;
  composeFile?: string;
  envFile?: string;
  /** The installed unit. */
  unitFile?: string;
  /** The checkout's unit, installed over an older one. Default: next to the compose file. */
  unitSource?: string;
  fs?: DataStackFs;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long to wait for the core healthchecks after a bring-up. Default 10 min. */
  healthTimeoutMs?: number;
  /** How long to wait for dockerd at boot. Default 2 min. */
  dockerWaitMs?: number;
  /** Delay before another background attempt after one ends `down`. Default 5 min. */
  retryMs?: number;
  /** Background attempts after the first. Default 6. */
  maxRetries?: number;
  log?: (m: string) => void;
}

type ContainerHealth = "healthy" | "starting" | "unhealthy" | "stopped" | "missing";

const POLL_MS = 3_000;
const RECHECK_MS = 30_000;
const MIN_KICK_MS = 60_000;

export class DataStack {
  private readonly cmd: CommandRunner;
  private readonly composeFile: string;
  private readonly envFile: string;
  private readonly unitFile: string;
  private readonly unitSource: string;
  private readonly fs: DataStackFs;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private current: DataLayerStatus = { state: "starting", reason: "not checked yet" };
  private lastCheck = 0;
  private lastKick = -Infinity;
  private inFlight: Promise<DataLayerState> | null = null;
  private readonly healthyHooks: Array<() => void | Promise<void>> = [];
  private readonly waiters = new Set<() => void>();
  private retriesLeft: number;
  private composeCmd: string[] | null = null;

  constructor(private readonly opts: DataStackOptions) {
    this.cmd = opts.cmd;
    this.composeFile = opts.composeFile ?? DATA_COMPOSE_FILE;
    this.envFile = opts.envFile ?? DATA_ENV_FILE;
    this.unitFile = opts.unitFile ?? DATA_UNIT_FILE;
    this.unitSource = opts.unitSource ?? join(dirname(this.composeFile), DATA_UNIT_NAME);
    this.fs = opts.fs ?? realFs;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((m) => console.log(m));
    this.retriesLeft = opts.maxRetries ?? 6;
  }

  /** Whether this host runs the compose stack at all (a box, not a dev machine). */
  applies(): boolean {
    return this.fs.exists(this.composeFile);
  }

  status(): DataLayerStatus {
    return { ...this.current };
  }

  /** Run once the core stores are healthy (immediately if they already are). */
  onHealthy(fn: () => void | Promise<void>): void {
    this.healthyHooks.push(fn);
    if (this.current.state === "healthy") void Promise.resolve().then(fn).catch(() => {});
    // (Hooks are for one-time setup; each runs on every not-healthy → healthy edge.)
  }

  /** Start the boot check in the background; never throws, never blocks. */
  start(): void {
    void this.ensure().catch(() => {});
  }

  /** Check the stack and bring it up when it's down. One at a time. */
  ensure(): Promise<DataLayerState> {
    if (this.inFlight) return this.inFlight;
    const p = this.ensureNow()
      .catch((e: unknown) => {
        this.set({ state: "down", reason: (e as Error).message });
        return "down" as const;
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = p;
    void p.then((state) => {
      if (state !== "down" || this.retriesLeft <= 0) return;
      this.retriesLeft--;
      // A pending retry never keeps the process alive.
      const wait = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
      void wait(this.opts.retryMs ?? 5 * 60_000).then(() => {
        if (this.current.state === "down") this.start();
      });
    });
    return p;
  }

  /**
   * Resolve when the core stores can be used; otherwise throw a
   * `DataLayerUnavailableError` at once (down) or after `waitMs` (starting).
   * A host without the compose stack is never gated.
   */
  async ready(opts: { waitMs?: number } = {}): Promise<void> {
    if (!this.applies()) return;
    if (this.current.state === "healthy" && this.now() - this.lastCheck > RECHECK_MS && !this.inFlight) {
      const h = await this.coreHealth().catch(() => null);
      this.lastCheck = this.now();
      if (h && !allHealthy(h)) {
        this.set({ state: "starting", reason: describe(h) });
        this.kick();
      }
    }
    if (this.current.state === "healthy") return;
    if (this.current.state === "down") {
      this.kick();
      throw new DataLayerUnavailableError("down", this.current.reason);
    }
    const waitMs = opts.waitMs ?? 15_000;
    if (waitMs > 0 && (await this.waitForHealthy(waitMs))) return;
    const st = this.status().state;
    if (st === "healthy") return;
    throw new DataLayerUnavailableError(st === "down" ? "down" : "starting", this.current.reason);
  }

  private kick(): void {
    if (this.inFlight || this.now() - this.lastKick < MIN_KICK_MS) return;
    this.lastKick = this.now();
    this.start();
  }

  private waitForHealthy(ms: number): Promise<boolean> {
    if (this.current.state === "healthy") return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: boolean) => {
        if (done) return;
        done = true;
        this.waiters.delete(wake);
        resolve(v);
      };
      const wake = () => {
        if (this.current.state === "healthy") finish(true);
        else if (this.current.state === "down") finish(false);
      };
      this.waiters.add(wake);
      void this.sleep(ms).then(() => finish(this.current.state === "healthy"));
    });
  }

  private set(s: DataLayerStatus): void {
    const was = this.current.state;
    this.current = s;
    this.lastCheck = this.now();
    if (s.state === "healthy" && was !== "healthy") {
      this.log("[data-layer] core store healthy (postgres)");
    } else if (s.state === "down" && was !== "down") {
      this.log(`[data-layer] DOWN: ${s.reason ?? "unknown"}`);
    }
    for (const w of [...this.waiters]) w();
  }

  private async ensureNow(): Promise<DataLayerState> {
    if (!this.applies()) {
      this.set({ state: "absent" });
      return "absent";
    }
    await this.syncUnit();
    if (!(await this.waitForDocker())) {
      this.set({ state: "down", reason: "docker isn't running" });
      return "down";
    }
    let health = await this.coreHealth();
    if (allHealthy(health)) {
      await this.becameHealthy(false);
      return "healthy";
    }
    this.set({ state: "starting", reason: describe(health) });
    let broughtUp = false;
    const needsStart = Object.values(health).some((h) => h === "missing" || h === "stopped");
    if (needsStart) {
      if ((await this.unitState()) === "activating") {
        this.log("[data-layer] the data-services unit is already bringing the stack up; waiting");
      } else if (!this.fs.exists(this.envFile)) {
        // No secrets yet: init.sh makes them, then brings the stack up.
        this.log("[data-layer] no data-services secrets yet; starting the data-services unit");
        if (!(await this.startUnit())) {
          this.set({ state: "down", reason: "the data-services secrets don't exist and the unit couldn't start" });
          return "down";
        }
      } else {
        this.log(`[data-layer] core stores not running (${describe(health)}); bringing them up`);
        const up = await this.composeUp();
        if (!up.ok) {
          this.set({ state: "down", reason: up.reason });
          return "down";
        }
        broughtUp = true;
      }
    }
    const deadline = this.now() + (this.opts.healthTimeoutMs ?? 10 * 60_000);
    while (this.now() < deadline) {
      await this.sleep(POLL_MS);
      health = await this.coreHealth();
      if (allHealthy(health)) {
        await this.becameHealthy(broughtUp);
        return "healthy";
      }
      this.current = { state: "starting", reason: describe(health) };
    }
    this.set({ state: "down", reason: `the core stores didn't become healthy (${describe(health)})` });
    return "down";
  }

  private async becameHealthy(startOptional: boolean): Promise<void> {
    // Hooks first (they attach the provisioner's admins), so nothing that
    // waits on `ready()` runs before they're in place.
    if (this.current.state !== "healthy") {
      for (const fn of this.healthyHooks) {
        try {
          await fn();
        } catch (e) {
          this.log(`[data-layer] a healthy hook failed: ${(e as Error).message}`);
        }
      }
    }
    this.set({ state: "healthy" });
    this.retriesLeft = this.opts.maxRetries ?? 6;
    // The core is up; let the (now current) unit bring up the optional
    // services and write its ready marker. Idempotent, and it no-ops on the
    // core containers that are already running.
    if (startOptional && (await this.unitState()) !== "activating") await this.startUnit();
  }

  /** Install the checkout's unit over an older one (a box that only ever ran the old one). */
  private async syncUnit(): Promise<void> {
    if (!this.fs.exists(this.unitFile) || !this.fs.exists(this.unitSource)) return;
    try {
      const [installed, wanted] = await Promise.all([this.fs.read(this.unitFile), this.fs.read(this.unitSource)]);
      if (installed === wanted) return;
      await this.fs.write(this.unitFile, wanted);
      await this.cmd.run("systemctl", ["daemon-reload"]).catch(() => {});
      this.log(`[data-layer] installed the current ${DATA_UNIT_NAME}`);
    } catch (e) {
      this.log(`[data-layer] couldn't update ${this.unitFile}: ${(e as Error).message}`);
    }
  }

  private async unitState(): Promise<string> {
    if (!this.cmd.capture) return "unknown";
    try {
      const { stdout } = await this.cmd.capture("systemctl", ["is-active", DATA_UNIT_NAME]);
      return stdout.trim();
    } catch (e) {
      const out = (e as { stdout?: string }).stdout;
      return typeof out === "string" && out.trim() ? out.trim() : "unknown";
    }
  }

  private async startUnit(): Promise<boolean> {
    try {
      await this.cmd.run("systemctl", ["reset-failed", DATA_UNIT_NAME]).catch(() => {});
      await this.cmd.run("systemctl", ["start", "--no-block", DATA_UNIT_NAME]);
      return true;
    } catch (e) {
      this.log(`[data-layer] couldn't start ${DATA_UNIT_NAME}: ${(e as Error).message}`);
      return false;
    }
  }

  private async waitForDocker(): Promise<boolean> {
    const deadline = this.now() + (this.opts.dockerWaitMs ?? 120_000);
    let woken = false;
    for (;;) {
      try {
        if (this.cmd.capture) {
          // With a custom format, `docker info` exits 0 when dockerd is down.
          const { stdout } = await this.cmd.capture("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 15_000 });
          if (stdout.trim() === "") throw new Error("docker didn't answer");
        } else await this.cmd.run("docker", ["info"], { timeoutMs: 15_000 });
        return true;
      } catch {
        if (this.now() >= deadline) return false;
        if (!woken) {
          woken = true;
          // A dockerd that failed too often is refused until its failure is
          // reset; nothing else on the box would ever start it again.
          await this.cmd.run("systemctl", ["reset-failed", "docker.service", "docker.socket"], { timeoutMs: 15_000 }).catch(() => {});
          await this.cmd.run("systemctl", ["start", "--no-block", "docker.socket", "docker.service"], { timeoutMs: 15_000 }).catch(() => {});
        }
        await this.sleep(5_000);
      }
    }
  }

  private async coreHealth(): Promise<Record<(typeof CORE_SERVICES)[number], ContainerHealth>> {
    const out = {} as Record<(typeof CORE_SERVICES)[number], ContainerHealth>;
    for (const svc of CORE_SERVICES) out[svc] = await this.containerHealth(CORE_CONTAINERS[svc]);
    return out;
  }

  private async containerHealth(name: string): Promise<ContainerHealth> {
    if (!this.cmd.capture) return "missing";
    let line: string;
    try {
      const { stdout } = await this.cmd.capture(
        "docker",
        ["inspect", "-f", "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}", name],
        { timeoutMs: 15_000 },
      );
      line = stdout.trim();
    } catch {
      return "missing";
    }
    const [status, health] = line.split("|");
    if (status !== "running" && status !== "restarting") return "stopped";
    if (health === "healthy") return "healthy";
    if (health === "unhealthy") return "unhealthy";
    return "starting";
  }

  private async compose(): Promise<string[]> {
    if (this.composeCmd) return this.composeCmd;
    try {
      if (this.cmd.capture) await this.cmd.capture("docker", ["compose", "version"], { timeoutMs: 15_000 });
      else await this.cmd.run("docker", ["compose", "version"], { timeoutMs: 15_000 });
      this.composeCmd = ["docker", "compose"];
    } catch {
      this.composeCmd = ["docker-compose"];
    }
    return this.composeCmd;
  }

  private async composeUp(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const [bin, ...pre] = await this.compose();
    const args = [...pre, "-f", this.composeFile, "--env-file", this.envFile, "up", "-d", ...CORE_SERVICES];
    try {
      // Pulling the images on a slow line can take minutes.
      if (this.cmd.capture) await this.cmd.capture(bin!, args, { timeoutMs: 15 * 60_000 });
      else await this.cmd.run(bin!, args, { timeoutMs: 15 * 60_000 });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `compose couldn't start the core stores: ${(e as Error).message}` };
    }
  }
}

function allHealthy(h: Record<string, ContainerHealth>): boolean {
  return Object.values(h).every((v) => v === "healthy");
}

function describe(h: Record<string, ContainerHealth>): string {
  return Object.entries(h)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
}
