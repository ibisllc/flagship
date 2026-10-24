/**
 * The one-time move from Docker to Podman on an existing box
 * (docs/architecture-v2/engine-and-rust-path.md §4). It runs at boot, before any app container
 * is restored, only when the box's switch names Podman and the marker says it has not run.
 *
 * What moves: every tagged image (`docker save` → `podman load`, one image at a time so the
 * spool never holds more than one), and every named volume (the files volumes are bind volumes
 * of the per-app loop images, so only their definition moves; any other volume's contents are
 * copied). Containers and networks are not moved: the daemon recreates both at boot from its own
 * records. Postgres and Forgejo keep their data in host folders, which both engines mount.
 *
 * Docker's data is never deleted. dockerd is stopped and disabled, so switching the box back to
 * Docker (`rollbackToDocker`) is a restart away. A failure leaves Docker running and the box on
 * Docker; the next boot tries again.
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CommandRunner } from "../serviceRunner.js";
import { writeFileDurable } from "../durableFile.js";

export const ENGINE_MIGRATION_MARKER = "/var/lib/flagship/engine-migration.json";
/** The engine the box runs now, read by installer/data-services/init.sh. */
export const ENGINE_ACTIVE_FILE = "/var/lib/flagship/engine-active";
export const DOCKER_ROOT = "/var/lib/docker";

export interface MigrationMarker {
  version: 1;
  result: "migrated" | "nothing-to-migrate" | "rolled-back";
  at: string;
  images: string[];
  volumes: Array<{ name: string; how: "bind" | "copied" | "exists" }>;
  skipped: string[];
}

export type MigrationOutcome =
  | { ok: true; engine: "podman"; marker: MigrationMarker; ran: boolean }
  | { ok: false; engine: "docker"; reason: string };

export interface MigrationDeps {
  cmd: Required<CommandRunner>;
  exists: (path: string) => boolean;
  read?: (path: string) => Promise<string | null>;
  write?: (path: string, content: string) => Promise<void>;
  /** Where image archives are spooled, one at a time (on the data disk, never tmpfs). */
  spoolDir?: string;
  markerPath?: string;
  activePath?: string;
  dockerRoot?: string;
  now?: () => Date;
  log?: (m: string) => void;
}

interface VolumeInspect {
  Name?: string;
  Driver?: string;
  Mountpoint?: string;
  Options?: Record<string, string> | null;
}

const IMAGE_REF = /^[a-z0-9][a-z0-9._/:@-]{0,255}$/;
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

async function readText(deps: MigrationDeps, path: string): Promise<string | null> {
  if (deps.read) return deps.read(path);
  return readFile(path, "utf8").catch(() => null);
}

async function writeText(deps: MigrationDeps, path: string, content: string): Promise<void> {
  if (deps.write) return deps.write(path, content);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFileDurable(path, content, 0o644);
}

export async function readMigrationMarker(deps: MigrationDeps): Promise<MigrationMarker | null> {
  const text = await readText(deps, deps.markerPath ?? ENGINE_MIGRATION_MARKER);
  if (!text) return null;
  try {
    const m = JSON.parse(text) as MigrationMarker;
    return m.version === 1 && typeof m.result === "string" ? m : null;
  } catch {
    return null;
  }
}

async function out(deps: MigrationDeps, cmd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return (await deps.cmd.capture(cmd, args, { timeoutMs })).stdout;
}

async function dockerAnswers(deps: MigrationDeps): Promise<boolean> {
  try {
    return (await out(deps, "docker", ["info", "--format", "{{.ServerVersion}}"], 20_000)).trim() !== "";
  } catch {
    return false;
  }
}

/** Tagged images Docker holds, deduplicated. Untagged (dangling or digest-only) are listed as skipped. */
export function parseImageList(text: string): { refs: string[]; skipped: string[] } {
  const refs: string[] = [];
  const skipped: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const [repo, tag] = t.split(" ");
    if (!repo || !tag || repo === "<none>" || tag === "<none>") {
      skipped.push(t);
      continue;
    }
    const ref = `${repo}:${tag}`;
    if (!IMAGE_REF.test(ref)) {
      skipped.push(t);
      continue;
    }
    if (!refs.includes(ref)) refs.push(ref);
  }
  return { refs, skipped };
}

/** A volume whose definition is a bind of a host folder (our files volumes). */
export function bindOptions(v: VolumeInspect): { device: string } | null {
  const o = v.Options ?? {};
  if (v.Driver === "local" && o.type === "none" && o.o === "bind" && typeof o.device === "string" && o.device.startsWith("/")) {
    return { device: o.device };
  }
  return null;
}

/**
 * Move the box from Docker to Podman once. Safe to call on every boot: it returns at once when
 * the marker exists, and records "nothing-to-migrate" on a box that never had Docker data.
 */
export async function migrateDockerToPodman(deps: MigrationDeps): Promise<MigrationOutcome> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());
  const markerPath = deps.markerPath ?? ENGINE_MIGRATION_MARKER;
  const activePath = deps.activePath ?? ENGINE_ACTIVE_FILE;
  const existing = await readMigrationMarker(deps);
  if (existing && existing.result !== "rolled-back") {
    return { ok: true, engine: "podman", marker: existing, ran: false };
  }

  try {
    await out(deps, "podman", ["--version"], 20_000);
  } catch (e) {
    return { ok: false, engine: "docker", reason: `podman is not installed or does not run (${(e as Error).message})` };
  }

  const dockerRoot = deps.dockerRoot ?? DOCKER_ROOT;
  const marker: MigrationMarker = { version: 1, result: "migrated", at: now().toISOString(), images: [], volumes: [], skipped: [] };
  if (!deps.exists(dockerRoot)) {
    marker.result = "nothing-to-migrate";
    await writeText(deps, markerPath, `${JSON.stringify(marker, null, 2)}\n`);
    await writeText(deps, activePath, "podman\n");
    return { ok: true, engine: "podman", marker, ran: true };
  }

  if (!(await dockerAnswers(deps))) {
    await deps.cmd.run("systemctl", ["start", "docker.service"], { timeoutMs: 60_000 }).catch(() => {});
    if (!(await dockerAnswers(deps))) {
      return { ok: false, engine: "docker", reason: "Docker holds this server's apps but does not answer, so nothing could be moved to Podman yet" };
    }
  }

  try {
    // Nothing may write while it moves: the app containers and the data services stop first.
    const running = (await out(deps, "docker", ["ps", "-q", "--filter", "name=^flagship-"])).split("\n").map((s) => s.trim()).filter(Boolean);
    if (running.length > 0) await deps.cmd.run("docker", ["stop", ...running], { timeoutMs: 180_000 });
    await deps.cmd.run("systemctl", ["stop", "flagship-data-services.service"], { timeoutMs: 120_000 }).catch(() => {});

    const listed = parseImageList(await out(deps, "docker", ["images", "--format", "{{.Repository}} {{.Tag}}"]));
    marker.skipped.push(...listed.skipped.map((s) => `image ${s}`));
    const spool = deps.spoolDir ?? "/var/flagship/data/engine-migration";
    await mkdir(spool, { recursive: true, mode: 0o700 }).catch(() => {});
    for (const ref of listed.refs) {
      const file = join(spool, "image.tar");
      try {
        await deps.cmd.run("docker", ["save", "-o", file, ref], { timeoutMs: 30 * 60_000 });
        await deps.cmd.run("podman", ["load", "-q", "-i", file], { timeoutMs: 30 * 60_000 });
        marker.images.push(ref);
        log(`[engine] moved image ${ref} to Podman`);
      } finally {
        await rm(file, { force: true }).catch(() => {});
      }
    }

    const volumes = (await out(deps, "docker", ["volume", "ls", "-q"])).split("\n").map((s) => s.trim()).filter(Boolean);
    const podmanHas = new Set((await out(deps, "podman", ["volume", "ls", "-q"])).split("\n").map((s) => s.trim()).filter(Boolean));
    for (const name of volumes) {
      if (!VOLUME_NAME.test(name)) {
        marker.skipped.push(`volume ${name}`);
        continue;
      }
      if (podmanHas.has(name)) {
        marker.volumes.push({ name, how: "exists" });
        continue;
      }
      const raw = JSON.parse(await out(deps, "docker", ["volume", "inspect", "--format", "{{json .}}", name])) as VolumeInspect;
      const bind = bindOptions(raw);
      if (bind) {
        await deps.cmd.run("podman", ["volume", "create", "--opt", "type=none", "--opt", "o=bind", "--opt", `device=${bind.device}`, name]);
        marker.volumes.push({ name, how: "bind" });
        continue;
      }
      if (!raw.Mountpoint || !raw.Mountpoint.startsWith(`${dockerRoot}/volumes/`)) {
        marker.skipped.push(`volume ${name} (unexpected mount point)`);
        continue;
      }
      await deps.cmd.run("podman", ["volume", "create", name]);
      const target = (await out(deps, "podman", ["volume", "inspect", "--format", "{{.Mountpoint}}", name])).trim();
      if (!target.startsWith("/")) throw new Error(`podman gave volume ${name} no mount point`);
      await deps.cmd.run("cp", ["-a", "--", `${raw.Mountpoint}/.`, `${target}/`], { timeoutMs: 60 * 60_000 });
      marker.volumes.push({ name, how: "copied" });
      log(`[engine] copied volume ${name} to Podman`);
    }

    // Docker's data stays where it is; dockerd stops and stays off.
    await deps.cmd.run("systemctl", ["disable", "--now", "docker.socket", "docker.service"], { timeoutMs: 120_000 }).catch((e: Error) => {
      log(`[engine] could not stop Docker (${e.message}); it is left running beside Podman`);
    });
    await writeText(deps, markerPath, `${JSON.stringify(marker, null, 2)}\n`);
    await writeText(deps, activePath, "podman\n");
    log(`[engine] this server now runs its apps with Podman (${marker.images.length} image(s), ${marker.volumes.length} volume(s) moved)`);
    return { ok: true, engine: "podman", marker, ran: true };
  } catch (e) {
    // Back to where it started: Docker up, its containers recreated by the daemon's restore.
    await deps.cmd.run("systemctl", ["start", "docker.service"], { timeoutMs: 60_000 }).catch(() => {});
    return { ok: false, engine: "docker", reason: `moving to Podman failed, so this server stays on Docker for now: ${(e as Error).message}` };
  }
}

/** The way back: Docker's untouched data comes back up; the marker records the rollback. */
export async function rollbackToDocker(deps: MigrationDeps): Promise<{ ok: boolean; reason?: string }> {
  const marker = await readMigrationMarker(deps);
  try {
    await deps.cmd.run("systemctl", ["enable", "--now", "docker.socket", "docker.service"], { timeoutMs: 120_000 });
  } catch (e) {
    return { ok: false, reason: `Docker could not be started again: ${(e as Error).message}` };
  }
  const now = deps.now ?? (() => new Date());
  const next: MigrationMarker = {
    version: 1,
    result: "rolled-back",
    at: now().toISOString(),
    images: marker?.images ?? [],
    volumes: marker?.volumes ?? [],
    skipped: marker?.skipped ?? [],
  };
  await writeText(deps, deps.markerPath ?? ENGINE_MIGRATION_MARKER, `${JSON.stringify(next, null, 2)}\n`);
  await writeText(deps, deps.activePath ?? ENGINE_ACTIVE_FILE, "docker\n");
  return { ok: true };
}
