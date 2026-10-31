/**
 * Boot wiring for the architecture v2 path (docs/architecture-v2/engine-and-rust-path.md):
 * pick the container engine (migrating Docker to Podman once when the switch asks for it, or
 * back), put the Rust keyd/broker/core units on or off, and give core the TS controller's view.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFileDurable } from "./durableFile.js";
import { loadArchV2Config, setActiveEngine, type ArchV2Config, type EngineKind } from "./engine/engine.js";
import { migrateDockerToPodman, readMigrationMarker, rollbackToDocker, type MigrationOutcome } from "./engine/migrate.js";
import { runSetupStep, runsUnprivileged } from "./privileged.js";
import { installRustStack, rustStackRegressions, type RustStackOutcome } from "./rustStack/install.js";
import { CORE_CHECKPOINT, CORE_DIR } from "./rustStack/units.js";
import type { CommandRunner } from "./serviceRunner.js";
import type { InstalledServicesStore, PersistedService } from "./installedServicesStore.js";
import type { ArchV2Switcher } from "./archV2Switch.js";

export interface ArchV2BootResult {
  config: ArchV2Config;
  engine: EngineKind;
  engineNote?: string;
  rust: RustStackOutcome;
}

export async function bootArchV2(o: {
  repoPath: string;
  cmd: CommandRunner;
  run: (cmd: string, args: string[]) => Promise<unknown>;
  log?: (m: string) => void;
  installRust?: (d: Parameters<typeof installRustStack>[0]) => Promise<RustStackOutcome>;
  /** The owner's switch on trial (archV2Switch.ts): finished, counted or put back around the move. */
  switcher?: Pick<ArchV2Switcher, "beforeEngine" | "afterEngine">;
  loadConfig?: () => ArchV2Config;
}): Promise<ArchV2BootResult> {
  const log = o.log ?? (() => {});
  const load = o.loadConfig ?? (() => loadArchV2Config());
  if (o.switcher) await o.switcher.beforeEngine().catch((e: Error) => log(`[arch-v2-switch] ${e.message}`));
  let config = load();
  const deps = { cmd: o.cmd as Required<CommandRunner>, exists: existsSync, log };
  // Podman, Docker's data and the copy between them are root's: an unprivileged daemon asks its helper to do the move.
  const migrate = (): Promise<MigrationOutcome> => (runsUnprivileged() ? runSetupStep<MigrationOutcome>("engine-migrate").then((r) => r ?? { ok: false, engine: "docker", reason: "the engine step gave no result" }) : migrateDockerToPodman(deps));
  const rollback = (): Promise<{ ok: boolean; reason?: string }> => (runsUnprivileged() ? runSetupStep<{ ok: boolean; reason?: string }>("engine-rollback").then((r) => r ?? { ok: false, reason: "the engine step gave no result" }) : rollbackToDocker(deps));
  let engine: EngineKind = "docker";
  let engineNote: string | undefined;
  if (config.engine === "podman") {
    const m = await migrate().catch((e: Error) => ({ ok: false as const, engine: "docker" as const, reason: e.message }));
    if (m.ok) engine = "podman";
    else {
      engineNote = m.reason;
      log(`[engine] ${m.reason}`);
    }
  } else {
    const marker = await readMigrationMarker(deps);
    if (marker?.result === "migrated") {
      const r = await rollback();
      engineNote = r.ok ? "switched back to Docker; its data from before the move is used again" : r.reason;
      log(`[engine] ${engineNote}`);
    }
  }
  if (o.switcher && (await o.switcher.afterEngine(engine, engineNote).catch(() => false))) config = load();
  setActiveEngine(engine);
  log(`[engine] apps run on ${engine === "podman" ? "Podman" : "Docker"}`);
  const rust = await (o.installRust ?? (runsUnprivileged() ? rustStackAsRoot : installRustStack))({ repoPath: o.repoPath, config, run: o.run, onLog: log });
  return { config, engine, ...(engineNote ? { engineNote } : {}), rust };
}

/**
 * Without root the daemon cannot write units or restart them: the release's own `rust-stack` step
 * does it through the privileged helper, so an update still moves keyd, broker and core onto the
 * new release's binaries. A step that restarts the broker it runs under loses its answer; the next
 * start finds the units current.
 */
export async function rustStackAsRoot(d: { onLog?: (m: string) => void }): Promise<RustStackOutcome> {
  try {
    const r = await runSetupStep<RustStackOutcome>("rust-stack");
    return r ?? { action: "failed", reason: "the rust-stack step gave no result" };
  } catch (e) {
    d.onLog?.(`[rust-path] the privileged helper could not update the Rust units: ${(e as Error).message}`);
    return { action: "failed", reason: (e as Error).message };
  }
}

/** Which privileged helper the daemon hands host operations to once it gives up root. */
export function privilegedHelperFor(r: Pick<ArchV2BootResult, "config" | "rust">): "broker" | "privd" {
  if (r.config.rust !== "on") return "privd";
  return r.rust.action === "installed" || r.rust.action === "unchanged" || r.rust.action === "restarted" ? "broker" : "privd";
}

/** For the update gate: true when no Rust component regressed to its fallback on this release. */
export async function rustPathHealthy(config: ArchV2Config, log: (m: string) => void = () => {}): Promise<boolean> {
  const regressions = await rustStackRegressions({ config });
  for (const r of regressions) log(`[self-update] ${r}`);
  return regressions.length === 0;
}

/** core's TsCheckpoint (flagship-core handover.rs): installation, generation, image, running. */
export function tsCheckpoint(services: readonly PersistedService[], now: number = Date.now()): string {
  return `${JSON.stringify({
    takenAt: Math.floor(now / 1000),
    tsControllerPaused: false,
    workloads: services.map((s) => ({ installation: s.serviceId, generation: 0, image: "", running: true })),
  })}\n`;
}

/**
 * Writes core's checkpoint whenever the TS controller's desired set is loaded or saved. Only
 * while core is installed; a write failure never touches the store itself.
 */
export function checkpointingStore(inner: InstalledServicesStore, path: string = CORE_CHECKPOINT): InstalledServicesStore {
  const write = async (services: PersistedService[]): Promise<void> => {
    if (!existsSync(CORE_DIR) && path === CORE_CHECKPOINT) return;
    await mkdir(dirname(path), { recursive: true }).catch(() => {});
    await writeFileDurable(path, tsCheckpoint(services), 0o644).catch(() => {});
  };
  return {
    async load() {
      const s = await inner.load();
      await write(s);
      return s;
    },
    async save(services) {
      await inner.save(services);
      await write(services);
    },
  };
}
