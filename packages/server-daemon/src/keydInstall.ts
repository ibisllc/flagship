import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  TLSD_DAEMON_DROPIN_PATH,
  TLSD_UNIT_PATH,
  daemonTlsdDropIn,
  tlsdServiceUnit,
  tlsdSetupScript,
  KEYD_DAEMON_DROPIN_PATH,
  KEYD_SOCKET,
  KEYD_UNIT_PATH,
  daemonKeydDropIn,
  keydServiceUnit,
  keydSetupScript,
} from "@flagship/keyd/unit";
import { writeFileDurable } from "./durableFile.js";

/**
 * Put flagship-keyd on a box that runs without it (SECURITY-HARDENING-PLAN.md 6.4): a box
 * installed before keyd, or a fresh one whose bootstrap generated its keys the old way.
 * Writes the hardened unit and the daemon's drop-in, creates the keyd user and group, and
 * starts keyd, whose first start moves the keys in and removes the readable copies. The
 * daemon then restarts so it comes back talking to keyd.
 *
 * Does nothing without systemd, without the keyd build in the running release, or when keyd
 * is already answering. Never throws: a box that cannot install keyd keeps running as before
 * and says so.
 */
export type TlsdInstallOutcome = "installed" | "already-installed" | "skipped-no-binary" | "failed";

/**
 * Put the TLS frontend on a box that has keyd (and a certificate in it, or will get one):
 * the user, the hardened unit, and the daemon's drop-in that points it at the frontend. The
 * daemon restarts afterwards and from then on holds no TLS key. Does nothing without the
 * frontend binary in this release.
 */
export async function installTlsd(opts: KeydInstallOptions & { binaryPath?: string }): Promise<TlsdInstallOutcome> {
  const log = opts.onLog ?? (() => {});
  const exists = opts.fileExists ?? existsSync;
  const binary = opts.binaryPath ?? join(opts.repoPath, "installer/flagship-tlsd");
  if (!exists(binary)) return "skipped-no-binary";
  const read = opts.read ?? (async (p) => await readFile(p, "utf8").catch(() => null));
  const write =
    opts.write ??
    (async (p, c, mode) => {
      await mkdir(dirname(p), { recursive: true });
      await writeFileDurable(p, c, mode);
    });
  try {
    const files: Array<[string, string, number]> = [
      [TLSD_UNIT_PATH, tlsdServiceUnit({ binary }), 0o644],
      [TLSD_DAEMON_DROPIN_PATH, daemonTlsdDropIn(), 0o644],
    ];
    let changed = false;
    for (const line of tlsdSetupScript().trim().split("\n")) await opts.run("sh", ["-c", line]);
    for (const [path, content, mode] of files) {
      if ((await read(path)) !== content) {
        await write(path, content, mode);
        changed = true;
      }
    }
    if (!changed) return "already-installed";
    await opts.run("systemctl", ["daemon-reload"]);
    await opts.run("systemctl", ["enable", "flagship-tlsd.service"]);
    log("[tlsd] installed; the daemon restarts to hand TLS to it");
    return "installed";
  } catch (e) {
    log(`[tlsd] could not install: ${(e as Error).message}`);
    return "failed";
  }
}

export type KeydInstallOutcome = "already-running" | "installed" | "skipped-no-systemd" | "skipped-no-keyd-build" | "failed";

export interface KeydInstallOptions {
  repoPath: string;
  socketPath?: string;
  run: (cmd: string, args: string[]) => Promise<unknown>;
  hasSystemd?: () => boolean;
  fileExists?: (path: string) => boolean;
  read?: (path: string) => Promise<string | null>;
  write?: (path: string, content: string, mode: number) => Promise<void>;
  /** Resolves true once the socket answers. */
  waitForSocket?: (path: string, timeoutMs: number) => Promise<boolean>;
  onLog?: (m: string) => void;
}

export async function installKeyd(opts: KeydInstallOptions): Promise<KeydInstallOutcome> {
  const log = opts.onLog ?? (() => {});
  const socket = opts.socketPath ?? KEYD_SOCKET;
  const exists = opts.fileExists ?? existsSync;
  if (exists(socket)) return "already-running";
  const hasSystemd = opts.hasSystemd ?? (() => existsSync("/run/systemd/system"));
  if (!hasSystemd()) return "skipped-no-systemd";
  const entry = join(opts.repoPath, "packages/keyd/dist/main.js");
  if (!exists(entry)) return "skipped-no-keyd-build";
  const read = opts.read ?? (async (p) => await readFile(p, "utf8").catch(() => null));
  const write =
    opts.write ??
    (async (p, c, mode) => {
      await mkdir(dirname(p), { recursive: true });
      await writeFileDurable(p, c, mode);
    });
  try {
    for (const line of keydSetupScript().trim().split("\n")) await opts.run("sh", ["-c", line]);
    const files: Array<[string, string, number]> = [
      [KEYD_UNIT_PATH, keydServiceUnit({ keydEntry: entry }), 0o644],
      [KEYD_DAEMON_DROPIN_PATH, daemonKeydDropIn(), 0o644],
    ];
    for (const [path, content, mode] of files) {
      if ((await read(path)) !== content) await write(path, content, mode);
    }
    await opts.run("systemctl", ["daemon-reload"]);
    await opts.run("systemctl", ["enable", "--now", "flagship-keyd.service"]);
    const up = await (opts.waitForSocket ?? defaultWait)(socket, 20_000);
    if (!up) {
      log("[keyd] installed but not answering yet; the daemon keeps its keys until it does");
      return "failed";
    }
    log("[keyd] installed and running; restarting the daemon to use it");
    return "installed";
  } catch (e) {
    log(`[keyd] could not install: ${(e as Error).message}`);
    return "failed";
  }
}

async function defaultWait(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
