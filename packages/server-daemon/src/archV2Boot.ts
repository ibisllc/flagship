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
import { migrateDockerToPodman, readMigrationMarker, rollbackToDocker } from "./engine/migrate.js";
import { installRustStack, rustStackRegressions, type RustStackOutcome } from "./rustStack/install.js";
import { CORE_CHECKPOINT, CORE_DIR } from "./rustStack/units.js";
import type { CommandRunner } from "./serviceRunner.js";
import type { InstalledServicesStore, PersistedService } from "./installedServicesStore.js";

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
}): Promise<ArchV2BootResult> {
  const log = o.log ?? (() => {});
  const config = loadArchV2Config();
  const deps = { cmd: o.cmd as Required<CommandRunner>, exists: existsSync, log };
  let engine: EngineKind = "docker";
  let engineNote: string | undefined;
  if (config.engine === "podman") {
    const m = await migrateDockerToPodman(deps).catch((e: Error) => ({ ok: false as const, engine: "docker" as const, reason: e.message }));
    if (m.ok) engine = "podman";
    else {
      engineNote = m.reason;
      log(`[engine] ${m.reason}`);
    }
  } else {
    const marker = await readMigrationMarker(deps);
    if (marker?.result === "migrated") {
      const r = await rollbackToDocker(deps);
      engineNote = r.ok ? "switched back to Docker; its data from before the move is used again" : r.reason;
      log(`[engine] ${engineNote}`);
    }
  }
  setActiveEngine(engine);
  log(`[engine] apps run on ${engine === "podman" ? "Podman" : "Docker"}`);
  const rust = await installRustStack({ repoPath: o.repoPath, config, run: o.run, onLog: log });
  return { config, engine, ...(engineNote ? { engineNote } : {}), rust };
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
