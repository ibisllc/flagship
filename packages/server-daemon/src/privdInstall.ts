import { existsSync } from "node:fs";
import { chmod, chown, lchown, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PrivdClient } from "@flagship/privd";
import {
  DAEMON_HARDENING_DROPIN_PATH,
  DAEMON_USER,
  HARDENING_STATE_DIR,
  PRIVD_DAEMON_DROPIN_PATH,
  PRIVD_HELPER,
  PRIVD_UNIT_PATH,
  daemonHardeningDropIn,
  daemonPrivdDropIn,
  privdSetupScript,
  privdUnit,
  type PrivilegedHelper,
} from "@flagship/privd/unit";
import { writeFileDurable } from "./durableFile.js";
import { BROKER_V1_SOCKET, RUST_RUN_DIR } from "./rustStack/units.js";

/**
 * On an architecture v2 box the Rust broker is the daemon's privileged helper: its privd v1
 * socket speaks the same contract (packages/privd/tests/vectors), and when its binary fails three
 * times in a row the same unit runs the TS privd on that socket instead (rustStack/units.ts).
 */
export const BROKER_HELPER: PrivilegedHelper = { unit: "flagship-broker.service", socket: BROKER_V1_SOCKET };

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
  /** "broker" on an architecture v2 box whose Rust units are in (archV2Boot.ts privilegedHelperFor). */
  helper?: "privd" | "broker";
  run: (cmd: string, args: string[]) => Promise<unknown>;
  hasSystemd?: () => boolean;
  fileExists?: (path: string) => boolean;
  read?: (path: string) => Promise<string | null>;
  write?: (path: string, content: string, mode: number) => Promise<void>;
  /** Resolves true once the broker answers and can reach Docker. */
  brokerAnswers?: (socket: string, timeoutMs: number) => Promise<boolean>;
  /** Gives the daemon's state to its account (handOverState; tests stub it). */
  handOver?: () => Promise<void>;
  /** The Rust path's status folder (tests). */
  runDir?: string;
  onLog?: (m: string) => void;
}

export async function installPrivd(o: PrivdInstallOptions): Promise<PrivdInstallOutcome> {
  const log = o.onLog ?? (() => {});
  const exists = o.fileExists ?? existsSync;
  if (!(o.hasSystemd ?? (() => existsSync("/run/systemd/system")))()) return "skipped-no-systemd";
  const entry = join(o.repoPath, "packages/privd/dist/main.js");
  if (!exists(entry) || !exists(join(o.repoPath, "packages/server-daemon/dist/setup.js"))) return "skipped-no-build";
  const helper = o.helper === "broker" ? BROKER_HELPER : PRIVD_HELPER;
  const read = o.read ?? (async (p) => await readFile(p, "utf8").catch(() => null));
  const write =
    o.write ??
    (async (p, c, mode) => {
      await mkdir(dirname(p), { recursive: true });
      await writeFileDurable(p, c, mode);
    });
  try {
    for (const line of privdSetupScript().trim().split("\n")) await o.run("sh", ["-c", line]);
    if (helper === PRIVD_HELPER) {
      const unit = privdUnit(entry);
      if ((await read(PRIVD_UNIT_PATH)) !== unit) await write(PRIVD_UNIT_PATH, unit, 0o644);
      await o.run("systemctl", ["daemon-reload"]);
      await o.run("systemctl", ["enable", "flagship-privd.service"]);
    } else if ((await read(PRIVD_UNIT_PATH)) !== null) {
      // One helper per box: the broker's socket replaces flagship-privd's.
      await o.run("systemctl", ["disable", "--now", "flagship-privd.service"]).catch(() => {});
    }
    // A restart reads the daemon's account afresh: the Rust broker admits it by its uid and group.
    await o.run("systemctl", ["restart", helper.unit]);
    if (!(await (o.brokerAnswers ?? brokerAnswers)(helper.socket, 30_000))) {
      log(`[privd] ${helper.unit} installed but not answering; the daemon keeps running as root until it does`);
      return "failed";
    }
    await (o.handOver ?? (() => handOverState({ log })))();
    await write(PRIVD_DAEMON_DROPIN_PATH, daemonPrivdDropIn(helper), 0o644);
    await write(DAEMON_HARDENING_DROPIN_PATH, daemonHardeningDropIn(), 0o644);
    await o.run("systemctl", ["daemon-reload"]);
    // The Rust keyd admits callers by uid (SO_PEERCRED), and the daemon's new uid joins its list
    // only when keyd selects again; keyd's restart restarts this daemon too, which is what follows.
    if (helper !== PRIVD_HELPER && (await read(join(o.runDir ?? RUST_RUN_DIR, "keyd.choice")))?.trim() === "rust") {
      await o.run("systemctl", ["restart", "--no-block", "flagship-keyd.service"]);
    }
    log(`[privd] ${helper.unit} answering; the daemon restarts as ${DAEMON_USER}`);
    return "switched";
  } catch (e) {
    log(`[privd] could not install: ${(e as Error).message}; the daemon keeps running as root`);
    return "failed";
  }
}

/**
 * Keep the unprivileged daemon's sandbox drop-in current, as root (the "update-guard" setup step, every
 * boot): present exactly when the daemon runs as `flagship` (its privd drop-in is there), so a box that
 * gave up root before the sandbox existed gets it, and a root daemon never runs under it. True when it
 * changed; it applies from the daemon's next start.
 */
export async function refreshDaemonHardening(o: {
  run: (cmd: string, args: string[]) => Promise<unknown>;
  read?: (path: string) => Promise<string | null>;
  write?: (path: string, content: string, mode: number) => Promise<void>;
  remove?: (path: string) => Promise<void>;
  onLog?: (m: string) => void;
  dataDir?: string;
  hardeningStateDir?: string;
}): Promise<boolean> {
  const read = o.read ?? (async (p) => await readFile(p, "utf8").catch(() => null));
  const write = o.write ?? (async (p, c, mode) => { await mkdir(dirname(p), { recursive: true }); await writeFileDurable(p, c, mode); });
  const remove = o.remove ?? (async (p) => { await rm(p, { force: true }); });
  const disabledPath = join(o.hardeningStateDir ?? HARDENING_STATE_DIR, "disabled.json");
  const unprivileged = (await read(PRIVD_DAEMON_DROPIN_PATH))?.includes(`User=${DAEMON_USER}`) === true;
  // The update guard took the sandbox away after a crash loop under it: not again for the same release.
  const disabled = sandboxDisabledRecord(await read(disabledPath));
  const current = commitOf(await read(join(o.dataDir ?? "/var/flagship", "artifact-current.json")));
  const heldOff = disabled !== null && (disabled.commit === "" || disabled.commit === current);
  const have = await read(DAEMON_HARDENING_DROPIN_PATH);
  const want = unprivileged && !heldOff ? daemonHardeningDropIn() : null;
  if (have === want) return false;
  if (want === null) await remove(DAEMON_HARDENING_DROPIN_PATH);
  else {
    await write(DAEMON_HARDENING_DROPIN_PATH, want, 0o644);
    if (disabled) await remove(disabledPath);
  }
  await o.run("systemctl", ["daemon-reload"]);
  o.onLog?.(`[privd] the daemon's sandbox drop-in ${want === null ? "removed (the daemon runs as root)" : "updated"}; it applies from the next start`);
  return true;
}

export interface SandboxDisabled {
  at: number;
  commit: string;
  starts: number;
}

/** The guard's record of taking the sandbox away (world-readable, root-written), or null. */
export function sandboxDisabledRecord(text: string | null): SandboxDisabled | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text) as Partial<SandboxDisabled>;
    if (typeof j.at !== "number" || typeof j.starts !== "number") return null;
    return { at: j.at, commit: typeof j.commit === "string" && /^[0-9a-f]{40}$/.test(j.commit) ? j.commit : "", starts: j.starts };
  } catch {
    return null;
  }
}

function commitOf(text: string | null): string | null {
  try {
    const c = text ? (JSON.parse(text) as { commit?: unknown }).commit : null;
    return typeof c === "string" ? c : null;
  } catch {
    return null;
  }
}

/** Says once, in Activity, that the guard removed the sandbox (the daemon reads the record; it cannot write it). */
export async function noteSandboxDisabled(o: {
  note: (kind: string, detail: string, extra?: { ok?: boolean }) => void;
  dataDir: string;
  hardeningStateDir?: string;
  read?: (path: string) => Promise<string | null>;
  write?: (path: string, content: string) => Promise<void>;
}): Promise<boolean> {
  const read = o.read ?? (async (p) => await readFile(p, "utf8").catch(() => null));
  const write = o.write ?? (async (p, c) => await writeFileDurable(p, c, 0o600));
  const r = sandboxDisabledRecord(await read(join(o.hardeningStateDir ?? HARDENING_STATE_DIR, "disabled.json")));
  if (!r) return false;
  const marker = join(o.dataDir, "sandbox-disabled-noted");
  if ((await read(marker))?.trim() === String(r.at)) return false;
  o.note(
    "server.sandbox.removed",
    `The server's program kept failing to start under its extra sandbox (${r.starts} quick starts in a row), so the sandbox was turned off for this release. The server works as before with less isolation; the next release turns it back on.`,
    { ok: false },
  );
  await write(marker, String(r.at));
  return true;
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
