/**
 * Daemon start-up for accelerators: put the pinned flagship-gpud in place on a box with a GPU
 * (as root; an unprivileged daemon asks the privileged helper's `gpu-broker` step), hand the
 * AppRunner its claim/release hook, and build the owner's screen handler. A box without a GPU, or
 * without the service, answers every question honestly as "no GPU" and deploys GPU apps only when
 * they have a CPU path.
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { activeEngine } from "../engine/engine.js";
import { runSetupStep } from "../privileged.js";
import type { FilePairedSessionStore } from "../pairedSessionStore.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import { denyCompanionWrite } from "../screens/companion.js";
import { setAcceleratorHook } from "../serviceRunner.js";
import { GpuApprovalStore, gpuApprovals, setGpuApprovals, type GpuApprovalsDeps } from "./approvals.js";
import { AcceleratorBroker, AppAccelerators } from "./broker.js";
import { gpudClient } from "./client.js";
import { buildAcceleratorsHttp } from "./http.js";
import { installGpud, type GpudInstallDeps, type GpudInstallResult } from "./unit.js";

export function realGpudInstallDeps(repoPath: string, engine: string, log?: (s: string) => void): GpudInstallDeps {
  return {
    repoPath,
    engine,
    exists: async (p) => existsSync(p),
    read: async (p) => await readFile(p).catch(() => null),
    write: async (p, data, mode) => {
      await mkdir(dirname(p), { recursive: true, mode: 0o755 });
      const tmp = `${p}.partial`;
      await writeFile(tmp, data, { mode });
      await chmod(tmp, mode);
      await rename(tmp, p);
    },
    run: (cmd, args) =>
      new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout: 120_000, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" } }, (err, stdout) => {
          if (err && typeof (err as { code?: unknown }).code !== "number") return reject(err);
          resolve({ code: err ? Number((err as { code?: number }).code) : 0, stdout: String(stdout) });
        });
      }),
    ...(log ? { log } : {}),
  };
}

export interface Accelerators {
  broker: AcceleratorBroker;
  apps: AppAccelerators;
  http: (path: string, method: string, req: HttpRequest) => Promise<HttpResponse | null>;
}

let started: Accelerators | null = null;
let core: { broker: AcceleratorBroker; apps: AppAccelerators } | null = null;

/** The one broker and AppRunner hook, made before the first deploy (restored apps at boot included). */
function acceleratorCore(dataDir: string): { broker: AcceleratorBroker; apps: AppAccelerators } {
  if (core) return core;
  const broker = new AcceleratorBroker(gpudClient(), { engine: activeEngine() });
  const apps = new AppAccelerators(broker, join(dataDir, "gpu-allocations.json"));
  setAcceleratorHook(apps);
  core = { broker, apps };
  return core;
}

/**
 * Once per daemon, before any app is deployed: the owner's GPU approvals (gpu/approvals.ts) in
 * `<dataDir>/gpu-approvals.json`; a withdrawal stops the app's GPU work through gpud.
 */
export function startGpuApprovals(o: { dataDir: string } & Omit<GpuApprovalsDeps, "path">): GpuApprovalStore {
  const existing = gpuApprovals();
  if (existing) return existing;
  const { broker } = acceleratorCore(o.dataDir);
  const store = new GpuApprovalStore({ ...o, path: join(o.dataDir, "gpu-approvals.json") });
  store.setEffects({ revoke: (appId) => broker.revokeApp(appId) });
  setGpuApprovals(store);
  return store;
}

/** Once per daemon: the screen and local AI (localAi/) share the one broker. */
export function startAccelerators(o: { dataDir: string; pairedSessions: FilePairedSessionStore | null }): Accelerators {
  if (started) return started;
  const { broker, apps } = acceleratorCore(o.dataDir);
  started = { broker, apps, http: buildAcceleratorsHttp({ broker, denyCompanion: (r) => denyCompanionWrite(o.pairedSessions, r), approvals: () => gpuApprovals() }) };
  return started;
}

/**
 * Where an unprivileged daemon gets flagship-gpud installed: the release's own root setup step
 * (`gpu-broker`, allowed by privd and the Rust broker), never a file the daemon writes.
 */
export async function installGpudAsRoot(log: (s: string) => void): Promise<GpudInstallResult> {
  try {
    return (await runSetupStep<GpudInstallResult>("gpu-broker")) ?? { action: "skipped", reason: "the gpu-broker step gave no result" };
  } catch (e) {
    log(`[gpu] the privileged helper could not install flagship-gpud: ${(e as Error).message}`);
    return { action: "skipped", reason: (e as Error).message };
  }
}

/** Install or refresh flagship-gpud from the running release (root only). */
export async function installGpudFromRelease(repoPath: string, engine: "docker" | "podman", log: (s: string) => void): Promise<GpudInstallResult> {
  const enginePath = engine === "podman" ? "/usr/bin/podman" : "/usr/bin/docker";
  try {
    return await installGpud(realGpudInstallDeps(repoPath, enginePath, log));
  } catch (e) {
    log(`[gpu] flagship-gpud could not be installed: ${(e as Error).message}`);
    return { action: "skipped", reason: (e as Error).message };
  }
}
