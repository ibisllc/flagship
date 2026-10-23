import { existsSync } from "node:fs";
import { chmod, chown, lchown, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PrivdClient } from "@flagship/privd";
import {
  DAEMON_USER,
  PRIVD_DAEMON_DROPIN_PATH,
  PRIVD_SOCKET,
  PRIVD_UNIT_PATH,
  daemonPrivdDropIn,
  privdSetupScript,
  privdUnit,
} from "@flagship/privd/unit";
import { writeFileDurable } from "./durableFile.js";

/**
 * Take this daemon off root (SECURITY-HARDENING-PLAN.md SEC-DAEMON-001), the way keyd went in
 * (keydInstall.ts): on a box whose keys keyd already holds, write flagship-privd's unit, start it,
 * and only once it answers hand the daemon's state to the `flagship` account and add the drop-in
 * that runs the daemon as it. The daemon then restarts unprivileged. Until privd answers nothing
 * changes and the daemon keeps running as root, and says so. Never throws.
 */
export type PrivdInstallOutcome = "switched" | "skipped-no-systemd" | "skipped-no-build" | "failed";

export interface PrivdInstallOptions {
  repoPath: string;
  run: (cmd: string, args: string[]) => Promise<unknown>;
  hasSystemd?: () => boolean;
  fileExists?: (path: string) => boolean;
  read?: (path: string) => Promise<string | null>;
  write?: (path: string, content: string, mode: number) => Promise<void>;
  /** Resolves true once the broker answers and can reach Docker. */
  brokerAnswers?: (socket: string, timeoutMs: number) => Promise<boolean>;
  /** Gives the daemon's state to its account (handOverState; tests stub it). */
  handOver?: () => Promise<void>;
  onLog?: (m: string) => void;
}

export async function installPrivd(o: PrivdInstallOptions): Promise<PrivdInstallOutcome> {
  const log = o.onLog ?? (() => {});
  const exists = o.fileExists ?? existsSync;
  if (!(o.hasSystemd ?? (() => existsSync("/run/systemd/system")))()) return "skipped-no-systemd";
  const entry = join(o.repoPath, "packages/privd/dist/main.js");
  if (!exists(entry) || !exists(join(o.repoPath, "packages/server-daemon/dist/setup.js"))) return "skipped-no-build";
  const read = o.read ?? (async (p) => await readFile(p, "utf8").catch(() => null));
  const write =
    o.write ??
    (async (p, c, mode) => {
      await mkdir(dirname(p), { recursive: true });
      await writeFileDurable(p, c, mode);
    });
  try {
    for (const line of privdSetupScript().trim().split("\n")) await o.run("sh", ["-c", line]);
    const unit = privdUnit(entry);
    if ((await read(PRIVD_UNIT_PATH)) !== unit) await write(PRIVD_UNIT_PATH, unit, 0o644);
    await o.run("systemctl", ["daemon-reload"]);
    await o.run("systemctl", ["enable", "flagship-privd.service"]);
    await o.run("systemctl", ["restart", "flagship-privd.service"]);
    if (!(await (o.brokerAnswers ?? brokerAnswers)(PRIVD_SOCKET, 30_000))) {
      log("[privd] installed but not answering; the daemon keeps running as root until it does");
      return "failed";
    }
    await (o.handOver ?? (() => handOverState({ log })))();
    await write(PRIVD_DAEMON_DROPIN_PATH, daemonPrivdDropIn(), 0o644);
    await o.run("systemctl", ["daemon-reload"]);
    log(`[privd] installed and answering; the daemon restarts as ${DAEMON_USER}`);
    return "switched";
  } catch (e) {
    log(`[privd] could not install: ${(e as Error).message}; the daemon keeps running as root`);
    return "failed";
  }
}

async function brokerAnswers(socket: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(socket)) {
      const c = new PrivdClient(socket);
      try {
        await c.docker(["version", "--format", "{{.Server.Version}}"]);
        return true;
      } catch {
        /* not yet */
      } finally {
        c.close();
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Entries of the state folder root keeps: what root processes read and trust (installer, init.sh, keyd). */
export const ROOT_KEEPS = new Set([
  "data",
  "identity",
  "keyd",
  "data-services.env",
  "data-services.ready",
  "artifact-sequence",
  "artifact-previous",
  "artifact-current.json",
  "update-guard-starts",
]);
/** Inside `data`: the data services' own folders, owned by their containers. */
export const DATA_KEEPS = new Set(["postgres", "forgejo"]);

interface Account {
  uid: number;
  gid: number;
}

async function account(name: string): Promise<Account> {
  const passwd = await readFile("/etc/passwd", "utf8");
  for (const line of passwd.split("\n")) {
    const f = line.split(":");
    if (f[0] === name) return { uid: Number(f[2]), gid: Number(f[3]) };
  }
  throw new Error(`no ${name} account`);
}

/** Give root-owned files under `path` to the daemon, never following a link and never crossing a mount. */
async function giveTree(path: string, to: Account, dev?: number): Promise<number> {
  const st = await lstat(path).catch(() => null);
  if (!st || (dev !== undefined && st.dev !== dev)) return 0;
  let n = 0;
  if (st.uid === 0) {
    await lchown(path, to.uid, to.gid);
    n++;
  }
  if (st.isDirectory()) for (const e of await readdir(path)) n += await giveTree(join(path, e), to, st.dev);
  return n;
}

/**
 * The one-time hand-over, as root. The state folder and `data` become root's and sticky with the
 * daemon's group, so the daemon adds and changes its own files but can never rename or replace what
 * root reads there (the data services' folders, the release records, the admin credentials).
 * Everything else root owned there becomes the daemon's. The box config stays root's, readable by
 * the daemon: the root steps (setup.ts) check grants against it.
 */
export async function handOverState(o: { dataDir?: string; configPath?: string; filesRoot?: string; log?: (m: string) => void } = {}): Promise<void> {
  const dataDir = o.dataDir ?? "/var/flagship";
  const to = await account(DAEMON_USER);
  await chown(dataDir, 0, to.gid);
  await chmod(dataDir, 0o1770);
  let given = 0;
  for (const e of await readdir(dataDir)) if (!ROOT_KEEPS.has(e)) given += await giveTree(join(dataDir, e), to);
  const data = join(dataDir, "data");
  if (existsSync(data)) {
    await chown(data, 0, to.gid);
    await chmod(data, 0o1770);
    for (const e of await readdir(data)) if (!DATA_KEEPS.has(e)) given += await giveTree(join(data, e), to);
  }
  const creds = join(dataDir, "data-services.env");
  if (existsSync(creds)) {
    await chown(creds, 0, to.gid);
    await chmod(creds, 0o640);
  }
  const config = o.configPath ?? process.env.FLAGSHIP_CONFIG;
  if (config && existsSync(config)) {
    await chown(config, 0, to.gid);
    await chmod(config, 0o640);
  }
  const files = o.filesRoot ?? "/var/lib/flagship-files";
  for (const d of [files, join(files, "orphaned")]) if (existsSync(d)) await chmod(d, 0o755);
  for (const e of await readdir("/var/tmp").catch(() => [] as string[])) if (e.startsWith(".flagship-")) given += await giveTree(join("/var/tmp", e), to);
  o.log?.(`[privd] gave ${given} files to ${DAEMON_USER}`);
}
