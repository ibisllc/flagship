/**
 * Puts the P04/P05 runtimes on a running box (called once from runtime.ts):
 * the WASI worker and its broker, the app groups' gateway links, the
 * dedicated database profile, and the quiesce hook backups use. Each part
 * that can't run here says so, and the matching install is refused with a
 * sentence instead of half-working.
 */
import { existsSync, readFileSync } from "node:fs";
import type { BoxRuntimeCapabilities } from "@flagship/protocol";
import type { RuntimeRouter } from "./appRuntimes.js";
import { OwnedPortBook, filePortBookStore, memoryPortBookStore } from "./appGroups/portBook.js";
import { setAppQuiesceHook } from "./appCopy/ops.js";
import { hostDiskUse, type LoopVolumes } from "./appQuota/index.js";
import { DedicatedPostgres, fileDedicatedStateStore, type DatabaseProfile } from "./dataLayer/dedicated.js";
import type { DataProvisioner } from "./dataLayer/provisioner.js";
import { RealPostgresAdmin } from "./dataLayer/realAdmins.js";
import type { EgressRuntime } from "./egress/boot.js";
import { activeEngine } from "./engine/engine.js";
import { prepareFilesVolume, realCommandRunner, type CommandRunner } from "./serviceRunner.js";
import type { ServicePlatform } from "./servicePlatform.js";
import { WasiCapabilityBroker } from "./wasi/broker.js";
import { wasiHostCalls } from "./wasi/hostCalls.js";
import { ensureWasiRuntime, type WasiInstallOutcome } from "./wasi/install.js";
import { WasiModuleStore } from "./wasi/moduleStore.js";
import { WasiRunner } from "./wasi/runner.js";
import { wasiDropInLimits, wasiInstance } from "./wasi/unit.js";
import { appSandboxRunArgs } from "./appSandbox/state.js";
import { privd, runSetupStep, runsUnprivileged } from "./privileged.js";

export interface AppRuntimes {
  capabilities(): BoxRuntimeCapabilities;
  ports: OwnedPortBook;
  dedicated: DedicatedPostgres | null;
  wasiModules: WasiModuleStore;
  wasiStatus(): { available: boolean; reason?: string };
  /** Which database profile a new app gets (docs/app-runtimes.md "Database profiles"). */
  databaseProfile(creator: string, slug: string): DatabaseProfile;
}

export interface WireAppRuntimesOptions {
  router: RuntimeRouter;
  egress: Pick<EgressRuntime, "ownedPorts" | "accessRules" | "onUnmatched">;
  loopVolumes: LoopVolumes | null;
  dataProvisioner: DataProvisioner | null;
  dataDir?: string;
  platform: () => ServicePlatform | null;
  repoPath?: string;
  cmd?: CommandRunner;
  log?: (m: string) => void;
}

interface ProfileFile {
  default?: DatabaseProfile;
  apps?: Record<string, DatabaseProfile>;
}

function readProfileFile(path: string | null): ProfileFile {
  if (!path || !existsSync(path)) return {};
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as ProfileFile;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export async function wireAppRuntimes(o: WireAppRuntimesOptions): Promise<AppRuntimes> {
  const cmd = o.cmd ?? realCommandRunner;
  const log = o.log ?? ((m: string) => console.warn(m));
  o.router.setGroupLinks(o.egress.ownedPorts);
  const ports = new OwnedPortBook(o.dataDir ? filePortBookStore(`${o.dataDir}/data/owned-ports.json`) : memoryPortBookStore());

  // WASI (P04): the pinned worker, its broker and runner.
  let wasi: WasiInstallOutcome = { available: false, reason: "this server has no systemd" };
  if (process.platform === "linux" && process.env.FLAGSHIP_WASI !== "0") {
    // Unprivileged, the release's own root step installs the worker and its template (the daemon hands nothing in).
    wasi = runsUnprivileged()
      ? ((await runSetupStep<WasiInstallOutcome>("wasi-runtime").catch((e: Error) => ({ available: false as const, reason: `the WebAssembly worker could not be installed: ${e.message}` }))) ??
        { available: false, reason: "the WebAssembly worker could not be installed" })
      : await ensureWasiRuntime({ repoPath: o.repoPath ?? process.env.FLAGSHIP_SELF_REPO ?? "/opt/flagship", run: (c, a) => cmd.run(c, a), onLog: log });
  }
  if (!wasi.available) log(`[wasi] WebAssembly apps unavailable: ${wasi.reason}`);
  const wasiModules = new WasiModuleStore();
  let runner: WasiRunner | null = null;
  const broker = new WasiCapabilityBroker(
    wasiHostCalls({
      context: (id) => runner?.context(id),
      accessRules: (id) => o.egress.accessRules(id),
      onUnmatched: (id, host) => o.egress.onUnmatched(id, host),
    }),
    log,
  );
  runner = new WasiRunner({
    cmd,
    modules: wasiModules,
    broker,
    available: () => wasi.available,
    filesHostPath: async (volume) => {
      await prepareFilesVolume(volume);
      if (o.loopVolumes) return o.loopVolumes.dataPath(volume);
      if (!cmd.capture) throw new Error("the app's files folder is not available");
      const mp = (await cmd.capture("docker", ["volume", "inspect", "-f", "{{.Mountpoint}}", volume])).stdout.trim();
      if (!mp.startsWith("/")) throw new Error("the app's files folder is not available");
      return mp;
    },
    ...(runsUnprivileged()
      ? {
          dropIns: {
            write: async (serviceId, d) => {
              await privd().wasiUnit({
                action: "write",
                instance: wasiInstance(serviceId),
                world: d.world,
                restart: d.restart,
                ...wasiDropInLimits(d),
                ...(d.filesHostPath ? { filesPath: d.filesHostPath } : {}),
              });
            },
            remove: async (serviceId) => void (await privd().wasiUnit({ action: "remove", instance: wasiInstance(serviceId) })),
          },
        }
      : {}),
    onLog: log,
  });
  o.router.setWasiRunner(runner);
  setAppQuiesceHook((id) => o.router.quiesce(id));

  // The dedicated database profile (P05): only with quota images and a data dir.
  const profilePath = o.dataDir ? `${o.dataDir}/data/database-profile.json` : null;
  let dedicated: DedicatedPostgres | null = null;
  if (o.loopVolumes && o.dataDir && o.dataProvisioner) {
    const volumes = o.loopVolumes;
    dedicated = new DedicatedPostgres({
      cmd,
      volumes,
      preallocate: (path, bytes) => cmd.run("fallocate", ["-l", String(bytes), path]),
      disk: async () => {
        const d = await hostDiskUse();
        if (!d) throw new Error("the disk's free space can't be read");
        return { freeBytes: d.availBytes, totalBytes: d.totalBytes };
      },
      ports,
      links: () => (o.egress.ownedPorts.gateway() ? o.egress.ownedPorts : null),
      state: fileDedicatedStateStore(`${o.dataDir}/data/dedicated-postgres.json`),
      admin: (adminUrl) => new RealPostgresAdmin({ adminUrl }),
      // gVisor like every other container (the broker refuses a dedicated database without it).
      sandboxArgs: appSandboxRunArgs,
      onLog: log,
    });
  }
  const databaseProfile = (creator: string, slug: string): DatabaseProfile => {
    if (!dedicated?.available()) return "shared";
    const f = readProfileFile(profilePath);
    const own = f.apps?.[`${creator}--${slug}`];
    if (own === "shared" || own === "dedicated") return own;
    if (f.default === "shared" || f.default === "dedicated") return f.default;
    // New (arch-v2, Podman) boxes give each new app its own database; older boxes keep the shared one.
    return activeEngine() === "podman" ? "dedicated" : "shared";
  };
  if (dedicated && o.dataProvisioner) {
    const d = dedicated;
    o.dataProvisioner.setDedicated({
      profileFor: databaseProfile,
      forApp: (c, s, opts) => d.forApp(c, s, opts),
      dropApp: (c, s) => d.dropApp(c, s),
    });
    // Every instance up and routed again; the gateway may come up after us, so retry the ones that failed.
    let tries = 0;
    const start = async () => {
      const r = await d.startAll();
      if (r.failed.length > 0 && tries++ < 20) setTimeout(() => void start(), 30_000).unref?.();
    };
    void start();
  }

  return {
    capabilities: () => o.router.capabilities(wasi.available),
    ports,
    dedicated,
    wasiModules,
    wasiStatus: () => (wasi.available ? { available: true } : { available: false, reason: wasi.reason }),
    databaseProfile,
  };
}
