/**
 * Runs WASI apps (manifest v2 `runtime.kind: "wasi"`, docs/wasi-apps.md,
 * IMPLEMENTATION-PLAN.md §8.5 / P04) under the same contracts as a container
 * app: the install order names the module digest; the app proxy reaches it
 * on its loopback port with the same identity headers; its files folder is
 * the same quota-backed volume; its egress is the owner's access list; its
 * backups read the same folder and databases; uninstall drops the same
 * stores. Only the process differs: a `flagship-wasi@` unit (wasi/unit.ts)
 * instead of a gVisor container, so the same code serves Docker and Podman
 * boxes.
 */
import { endpoints, nextGeneration } from "../endpoints.js";
import { mkdir, rm, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { request } from "node:http";
import type { PostgresStore } from "../dataLayer/provisioner.js";
import type { AppSpec, CommandRunner, StartCheck } from "../serviceRunner.js";
import type { WasiCapabilityBroker } from "./broker.js";
import type { WasiAppContext } from "./hostCalls.js";
import type { WasiModuleStore } from "./moduleStore.js";
import {
  GUEST_CAP_SOCKET,
  GUEST_DATA,
  GUEST_PKG,
  WASI_APPS_DIR,
  WASI_DROPIN_ROOT,
  wasiAppDir,
  wasiDropIn,
  wasiDropInPath,
  wasiUnitName,
  type WasiDropIn,
} from "./unit.js";

/** Per-run limits the worker enforces (flagship-wasi `Limits`). */
export interface WasiRunLimits {
  memoryMiB: number;
  tableElements: number;
  fuel: number;
  wallTimeMs: number;
  stdoutBytes: number;
  stderrBytes: number;
}

export const DEFAULT_WASI_RUN_LIMITS: WasiRunLimits = {
  memoryMiB: 64,
  tableElements: 10_000,
  fuel: 1_000_000_000,
  wallTimeMs: 10_000,
  stdoutBytes: 4 * 1024 * 1024,
  stderrBytes: 64 * 1024,
};

export interface WasiAppSpec {
  world: "command" | "http-proxy";
  /** `sha256:<hex>` the owner's install order named. */
  moduleDigest: string;
  files: boolean;
  egressHosts: string[];
  /** The app's databases, for `db_query`; never handed to the guest. */
  postgres: Record<string, PostgresStore>;
  args?: string[];
  runLimits: WasiRunLimits;
  maxConcurrentRuns: number;
  unit: { memoryMiB: number; tasks: number; cpuPercent: number; restart: "always" | "on-failure" | "never" };
}

/** Platform values written into the worker's config (not secret). */
const PLATFORM_KEYS = ["FLAGSHIP_APP_ID", "FLAGSHIP_CREATOR", "FLAGSHIP_SLUG", "FLAGSHIP_HOST"] as const;
/** Never given to a WASI guest: it has no sockets to use them, and must not carry them out through an allowed host. */
const WITHHELD = /^(FLAGSHIP_PG_|FLAGSHIP_APP_TOKEN$|FLAGSHIP_FILES_DIR$|PORT$)/;

/** The worker's config file (flagship-wasi `WorkerFileConfig`). */
export function wasiWorkerConfig(spec: AppSpec): Record<string, unknown> {
  const w = spec.wasi;
  if (!w) throw new Error("not a WASI app");
  if (w.world === "http-proxy" && !spec.port) throw new Error("an http-proxy app needs a port");
  const stores = Object.keys(w.postgres);
  const env: Record<string, string> = {};
  for (const k of PLATFORM_KEYS) if (spec.env?.[k] !== undefined) env[k] = spec.env[k]!;
  return {
    schema: "flagship/wasi-worker/v1",
    manifest: {
      schema: "flagship/wasi-capabilities/v1",
      appId: spec.serviceId,
      world: w.world,
      module: { digest: w.moduleDigest },
      args: w.args ?? [],
      env: {},
      data: { stores: { files: w.files, ...(stores.length ? { postgres: stores } : {}) }, scratch: false },
      network: { egress: w.egressHosts },
      limits: w.runLimits,
    },
    approvedDigest: w.moduleDigest,
    modulePath: `${GUEST_PKG}/module.wasm`,
    ...(w.world === "http-proxy" ? { listen: `127.0.0.1:${spec.port}` } : {}),
    ...(w.files ? { filesDir: GUEST_DATA } : {}),
    capSocket: GUEST_CAP_SOCKET,
    env,
    maxConcurrentRuns: w.maxConcurrentRuns,
    maxConnections: 32,
  };
}

/** What the worker receives over its socket at start: owner env and manifest env, minus what a guest must never hold. */
export function wasiSecretEnv(spec: AppSpec): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    if ((PLATFORM_KEYS as readonly string[]).includes(k) || WITHHELD.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export interface WasiRunnerDeps {
  cmd: CommandRunner;
  modules: WasiModuleStore;
  broker: WasiCapabilityBroker;
  /** Whether this box can run WASI apps (the pinned worker and its unit are installed). */
  available: () => boolean;
  /** The host folder behind a files volume (appQuota/loopVolumes.ts dataPath), after mounting it. */
  filesHostPath?: (volume: string) => Promise<string>;
  appsDir?: string;
  dropInRoot?: string;
  /**
   * Where each app's unit drop-in goes. Default: written here (a root daemon). An unprivileged daemon
   * hands the broker the typed fields and the broker renders the unit text (privd `wasi.unit`).
   */
  dropIns?: { write(serviceId: string, d: WasiDropIn): Promise<void>; remove(serviceId: string): Promise<void> };
  onLog?: (m: string) => void;
  /** Tests: does something answer on the port. */
  answers?: (port: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  startTimeoutMs?: number;
}

function httpAnswers(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/", method: "GET", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

async function writeAtomic(path: string, data: string | Uint8Array, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const tmp = `${path}.partial`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, path);
}

export class WasiRunner {
  private readonly contexts = new Map<string, WasiAppContext>();

  constructor(private readonly deps: WasiRunnerDeps) {}

  private log(m: string): void {
    this.deps.onLog?.(`[wasi] ${m}`);
  }

  /** The broker's view of a running app (wasi/hostCalls.ts). */
  context(serviceId: string): WasiAppContext | undefined {
    return this.contexts.get(serviceId);
  }

  private async systemctl(...args: string[]): Promise<string> {
    if (this.deps.cmd.capture) return (await this.deps.cmd.capture("systemctl", args)).stdout;
    await this.deps.cmd.run("systemctl", args);
    return "";
  }

  async deploy(spec: AppSpec): Promise<void> {
    const w = spec.wasi;
    if (!w) throw new Error("not a WASI app");
    if (!this.deps.available()) throw new Error("this server cannot run WebAssembly apps yet: update the server first");
    const sid = spec.serviceId;
    const unit = wasiUnitName(sid);
    endpoints.beginStop(sid, "live", "main");
    await this.systemctl("stop", unit).catch(() => "");
    const dir = wasiAppDir(sid, this.deps.appsDir ?? WASI_APPS_DIR);
    await mkdir(dir, { recursive: true, mode: 0o755 });
    const bytes = await this.deps.modules.read(w.moduleDigest);
    await writeAtomic(join(dir, "module.wasm"), bytes, 0o644);
    await writeAtomic(join(dir, "worker.json"), JSON.stringify(wasiWorkerConfig(spec), null, 2) + "\n", 0o644);
    let filesHostPath: string | undefined;
    if (w.files) {
      if (!spec.filesVolume || !this.deps.filesHostPath) throw new Error("the app's files folder is not available");
      filesHostPath = await this.deps.filesHostPath(spec.filesVolume);
    }
    this.contexts.set(sid, { secretEnv: wasiSecretEnv(spec), egressHosts: w.egressHosts, postgres: w.postgres });
    await this.deps.broker.open(sid, join(dir, "cap.sock"));
    const dropIn: WasiDropIn = { world: w.world, ...w.unit, ...(filesHostPath ? { filesHostPath } : {}) };
    if (this.deps.dropIns) await this.deps.dropIns.write(sid, dropIn);
    else await writeAtomic(wasiDropInPath(sid, this.deps.dropInRoot ?? WASI_DROPIN_ROOT), wasiDropIn(dropIn), 0o644);
    await this.systemctl("daemon-reload");
    await this.systemctl("reset-failed", unit).catch(() => "");
    await this.systemctl("start", "--no-block", unit);
    // The worker listens on the host's loopback (not a container): the same table answers for it, so the proxy has one path.
    if (w.world === "http-proxy" && spec.port) {
      endpoints.publish({ serviceId: sid, env: "live", component: "main", role: "http" }, { host: "127.0.0.1", port: spec.port, generation: nextGeneration(), incarnation: `wasi:${unit}:${Date.now()}` });
    }
    this.log(`${sid}: started ${unit} (${w.world}, module ${w.moduleDigest.slice(0, 19)}…)`);
  }

  /** Confirm the worker came up (http-proxy: answers; command: finished cleanly). */
  check: StartCheck = async (spec) => {
    const w = spec.wasi;
    if (!w) return { ok: true };
    const unit = wasiUnitName(spec.serviceId);
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const answers = this.deps.answers ?? ((p: number) => httpAnswers(p));
    const deadline = Date.now() + (this.deps.startTimeoutMs ?? 30_000);
    for (;;) {
      const show = await this.systemctl("show", unit, "--property=ActiveState,Result").catch(() => "");
      const state = /ActiveState=(\w+)/.exec(show)?.[1] ?? "unknown";
      const result = /Result=([\w-]+)/.exec(show)?.[1] ?? "unknown";
      if (state === "failed" || (result !== "success" && result !== "unknown")) {
        return { ok: false, reason: `the WebAssembly app didn't start.${await this.tail(spec.serviceId)}` };
      }
      if (w.world === "command" && state === "inactive" && result === "success") return { ok: true };
      if (w.world === "http-proxy" && state === "active" && spec.port && (await answers(spec.port))) return { ok: true };
      if (Date.now() >= deadline) return { ok: false, reason: `the WebAssembly app didn't answer in time.${await this.tail(spec.serviceId)}` };
      await sleep(500);
    }
  };

  private async tail(serviceId: string): Promise<string> {
    const out = (await this.logs(serviceId, 15).catch(() => ({ stdout: "" }))).stdout.trim();
    return out ? ` Its last output:\n${out}` : "";
  }

  async stop(serviceId: string): Promise<void> {
    endpoints.beginStop(serviceId, "live", "main");
    await this.systemctl("stop", wasiUnitName(serviceId)).catch(() => "");
    await this.deps.broker.close(serviceId);
    this.contexts.delete(serviceId);
  }

  async restart(spec: AppSpec): Promise<void> {
    await this.stop(spec.serviceId);
    await this.deploy(spec);
  }

  /** Uninstall: the unit's per-app files go; the files volume and databases are the platform's to drop. */
  async remove(serviceId: string): Promise<void> {
    await this.stop(serviceId);
    if (this.deps.dropIns) await this.deps.dropIns.remove(serviceId).catch(() => {});
    else await rm(wasiDropInPath(serviceId, this.deps.dropInRoot ?? WASI_DROPIN_ROOT), { force: true }).catch(() => {});
    await rm(wasiAppDir(serviceId, this.deps.appsDir ?? WASI_APPS_DIR), { recursive: true, force: true }).catch(() => {});
    await this.systemctl("daemon-reload").catch(() => "");
  }

  async logs(serviceId: string, tail: number): Promise<{ stdout: string; stderr: string }> {
    if (!this.deps.cmd.capture) throw new Error("CommandRunner.capture is not configured");
    return this.deps.cmd.capture("journalctl", ["-u", wasiUnitName(serviceId), "-n", String(Math.max(1, Math.min(5000, tail))), "--no-pager", "-o", "cat"]);
  }

  /** Hold every run still while its data is read (a backup): the cgroup freezer. */
  async freeze(serviceId: string): Promise<(() => Promise<void>) | undefined> {
    if (!this.contexts.has(serviceId)) return undefined;
    const unit = wasiUnitName(serviceId);
    await this.systemctl("freeze", unit);
    return async () => {
      await this.systemctl("thaw", unit).catch(() => "");
    };
  }

  isWasi(serviceId: string): boolean {
    return this.contexts.has(serviceId);
  }
}
