/**
 * Puts the WASI worker on the box at every daemon start (docs/wasi-apps.md).
 * The worker is a Rust binary inside the signed box artifact; it is used only
 * when its SHA-256 equals the one the release's PINS.json names
 * (rustStack/units.ts), copied to a root-owned path, with the
 * `flagship-wasi@.service` template beside it. A box whose release carries no
 * pinned worker (or no systemd) says it cannot run WebAssembly apps, and the
 * install of one is refused with that sentence. Independent of the arch-v2
 * switch and of the container engine: Docker and Podman boxes alike.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parsePins } from "../rustStack/install.js";
import { RUST_BIN_DIR_REL, RUST_PINS_REL } from "../rustStack/units.js";
import { WASI_APPS_DIR, WASI_MODULES_DIR, WASI_UNIT_PATH, WASI_WORKER_BIN, WASI_WORKER_NAME, wasiTemplateUnit } from "./unit.js";

export interface WasiInstallDeps {
  repoPath: string;
  run: (cmd: string, args: string[]) => Promise<unknown>;
  hasSystemd?: () => boolean;
  readText?: (path: string) => Promise<string | null>;
  readBytes?: (path: string) => Promise<Buffer | null>;
  /** Write a file atomically with a mode. */
  write?: (path: string, data: string | Buffer, mode: number) => Promise<void>;
  mkdirp?: (path: string, mode: number) => Promise<void>;
  binPath?: string;
  unitPath?: string;
  onLog?: (m: string) => void;
}

export type WasiInstallOutcome = { available: true; sha256: string; changed: boolean } | { available: false; reason: string };

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export async function ensureWasiRuntime(d: WasiInstallDeps): Promise<WasiInstallOutcome> {
  const readText = d.readText ?? (async (p: string) => await readFile(p, "utf8").catch(() => null));
  const readBytes = d.readBytes ?? (async (p: string) => await readFile(p).catch(() => null));
  const write =
    d.write ??
    (async (p: string, data: string | Buffer, mode: number) => {
      await mkdir(dirname(p), { recursive: true, mode: 0o755 });
      const tmp = `${p}.partial`;
      await writeFile(tmp, data, { mode });
      await chmod(tmp, mode);
      await rename(tmp, p);
    });
  const mkdirp = d.mkdirp ?? (async (p: string, mode: number) => void (await mkdir(p, { recursive: true, mode })));
  const bin = d.binPath ?? WASI_WORKER_BIN;
  const unitPath = d.unitPath ?? WASI_UNIT_PATH;
  const say = (m: string) => d.onLog?.(`[wasi] ${m}`);
  try {
    if (!(d.hasSystemd ?? (() => existsSync("/run/systemd/system")))()) return { available: false, reason: "this server has no systemd" };
    const pins = parsePins(await readText(join(d.repoPath, RUST_PINS_REL)));
    const want = (pins?.binaries as Record<string, string> | undefined)?.[WASI_WORKER_NAME];
    if (!want) return { available: false, reason: "this release carries no WebAssembly worker" };
    const shipped = await readBytes(join(d.repoPath, RUST_BIN_DIR_REL, WASI_WORKER_NAME));
    if (!shipped) return { available: false, reason: "the release's WebAssembly worker is missing" };
    if (sha256(shipped) !== want) return { available: false, reason: "the release's WebAssembly worker does not match its pin" };
    let changed = false;
    const current = await readBytes(bin);
    if (!current || sha256(current) !== want) {
      await write(bin, shipped, 0o755);
      changed = true;
    }
    const unit = wasiTemplateUnit(bin);
    if ((await readText(unitPath)) !== unit) {
      await write(unitPath, unit, 0o644);
      changed = true;
    }
    await mkdirp(WASI_APPS_DIR, 0o711);
    await mkdirp(WASI_MODULES_DIR, 0o700);
    if (changed) {
      await d.run("systemctl", ["daemon-reload"]);
      say(`worker ${want.slice(0, 12)} installed`);
    }
    return { available: true, sha256: want, changed };
  } catch (e) {
    return { available: false, reason: `the WebAssembly worker could not be installed: ${(e as Error).message}` };
  }
}
