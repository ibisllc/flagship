/**
 * The boot chain refresh (docs/boot-chain-refresh.md): brings the initramfs unlock a box was
 * installed with up to its release, through an endorsed update, without risking a box that can no
 * longer unlock its disk.
 *
 * Runs as root (setup step `boot-chain`), after the daemon reports healthy and no update is waiting
 * for its verdict. What it writes comes from the release only: the scripts from the release's
 * generator (@flagship/boot-chain, the same functions the installer uses) and the unseal helper from
 * the release tree, whose every path component must be root's and writable by root alone. From the
 * box it reads only root's files: the scripts it has installed (for the boot hosts and Wi-Fi it was
 * installed with), /proc and /boot.
 *
 * One run does at most one of:
 *   - nothing, when the installed pieces are the release's (and it keeps a copy of the initrd that
 *     booted this box, the known-good copy, under /var/lib/flagship-bootchain);
 *   - stage: build a trial initrd from a copy of /etc/initramfs-tools with the release's pieces
 *     (`mkinitramfs -d`), check it holds them (`lsinitramfs`), put it on /boot beside the default
 *     one, add a one-time GRUB entry for it (/boot/grub/custom.cfg) and ask GRUB to boot it once
 *     (`grub-reboot`). /etc and the default initrd do not change, so any restart that is not the
 *     trial (and the restart after a trial that fails, `panic=30`) boots the box as before;
 *   - promote, on the trial's own boot once the daemon is healthy (the disk unlocked and the box
 *     is up): write the pieces to /etc and /boot, `update-initramfs -u`, and accept the rebuilt
 *     default only when it holds exactly the files of the trial that booted. Anything else puts the
 *     old pieces and the known-good initrd back;
 *   - roll back, when the box came up without booting a staged trial: the trial is dropped and
 *     not tried again for that release.
 * A journal makes an interrupted stage or promotion put the old files back on the next run.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  RELEASE_UNSEAL_HELPER,
  UNLOCK_PREMOUNT_PATH,
  UNSEAL_HELPER_MODE,
  UNSEAL_HELPER_PATH,
  WIFI_PREMOUNT_PATH,
  bootChainScripts,
  initrdExpectations,
  installedBootChainInputs,
  type BootChainInputs,
  type InitrdEntry,
} from "@flagship/boot-chain";
import { removeDurable, writeFileDurable } from "./durableFile.js";

export const BOOT_CHAIN_STATE_DIR = "/var/lib/flagship-bootchain";
export const INITRAMFS_CONF_DIR = "/etc/initramfs-tools";
export const TRIAL_INITRD_NAME = "flagship-initrd-trial.img";
export const TRIAL_ENTRY_ID = "flagship-bootchain-trial";
/** A trial whose initramfs fails reboots after this many seconds, into the default entry. */
export const TRIAL_PANIC_SECS = 30;
const CUSTOM_CFG_MARK = "# Flagship boot chain trial (bootChainRefresh.ts): removed once the trial is decided.";
const HOOK_FAILED = "flagship-unlock hook:";

export interface Piece {
  path: string;
  data: Uint8Array;
  mode: number;
}

export interface FileInfo {
  uid: number;
  mode: number;
  size: number;
  mtimeMs: number;
  kind: "file" | "dir" | "symlink" | "other";
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface InitrdListingEntry {
  path: string;
  size: number;
  kind: "file" | "dir" | "symlink" | "other";
}

/** Everything the refresh does to the box, so tests can run it against fakes. */
export interface BootChainSystem {
  read(path: string): Promise<Uint8Array | null>;
  /** Replace a file durably, owned by the caller (root), with exactly `mode` whatever the umask. */
  write(path: string, data: Uint8Array, mode: number): Promise<void>;
  remove(path: string): Promise<void>;
  info(path: string): Promise<FileInfo | null>;
  realpath(path: string): Promise<string>;
  list(dir: string): Promise<string[]>;
  freeBytes(dir: string): Promise<number>;
  /** A fresh copy of `from` (a directory) at `to`, modes and owners kept. */
  copyTree(from: string, to: string): Promise<void>;
  removeTree(path: string): Promise<void>;
  /** `mkinitramfs -d confDir -o out kernel`. */
  buildInitrd(confDir: string, out: string, kernel: string): Promise<ToolResult>;
  /** `update-initramfs -u -k kernel`. */
  updateInitrd(kernel: string): Promise<ToolResult>;
  /** `lsinitramfs -l image`, parsed; null when it can't be listed. */
  listInitrd(image: string): Promise<InitrdListingEntry[] | null>;
  /** One digest of every file in the image (path, type, mode, link target, bytes); null on failure. */
  initrdContentDigest(image: string): Promise<string | null>;
  /** The filesystem UUID of the filesystem holding `dir`. */
  fsUuid(dir: string): Promise<string | null>;
  /** `grub-reboot <entry>`, then true only when grubenv names it as the next entry. */
  grubBootOnce(bootDir: string, entry: string): Promise<boolean>;
  grubClearOnce(bootDir: string): Promise<void>;
  /** True when every tool the refresh runs is installed. */
  toolsPresent(): Promise<boolean>;
  sync(): Promise<void>;
  kernelRelease(): string;
  cmdline(): Promise<string>;
  bootId(): Promise<string>;
  bootTimeMs(): Promise<number>;
  randomToken(): string;
  now(): number;
  log(m: string): void;
}

export interface BootChainOptions {
  /** The running release (root-owned): /opt/flagship. */
  releaseRoot: string;
  stateDir?: string;
  bootDir?: string;
  confDir?: string;
  /** Other release files the run relies on (the generator module); each is checked like the helper. */
  trustedFiles?: string[];
  /** The pieces for these inputs; the release's generator unless a drill swaps it. */
  scripts?: (inputs: BootChainInputs) => Array<{ path: string; content: string; mode: number }>;
  /** What a built initrd must hold; the generator's list unless a drill swaps it. */
  expectations?: (pieces: Piece[]) => InitrdEntry[];
}

export type BootChainOutcome =
  | { action: "none"; reason: "no-boot-chain" | "current" | "trial-pending" | "failed-before" | "deferred" | "busy"; detail?: string; established?: boolean }
  | { action: "staged"; digest: string; kernel: string }
  | { action: "refreshed"; digest: string; kernel: string }
  | { action: "rolled-back"; reason: string; detail: string; digest: string };

interface Backup {
  path: string;
  /** Where the old bytes were kept; null when the file did not exist. */
  saved: string | null;
  mode: number;
}

export interface BootChainState {
  v: 1;
  confirmed?: { digest: string; at: number };
  knownGood?: { kernel: string; size: number; mtimeMs: number; sha256: string; at: number };
  trial?: { digest: string; token: string; kernel: string; bootId: string; contentDigest: string; at: number };
  failed?: { digest: string; reason: string; at: number };
  journal?: { phase: "staging" | "promoting"; backups: Backup[] };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function sameBytes(a: Uint8Array | null, b: Uint8Array): boolean {
  return a !== null && a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

/** The digest that names one release's boot chain on this box. */
export function piecesDigest(pieces: readonly Piece[]): string {
  return sha256(JSON.stringify(pieces.map((p) => [p.path, p.mode, sha256(p.data)])));
}

export class UntrustedSourceError extends Error {}

/**
 * Refuse a source the daemon (or anyone but root) could have changed: every component of its real
 * path must be root's and not writable by group or others, and the file itself a regular file.
 */
export async function assertRootOnly(sys: BootChainSystem, path: string): Promise<string> {
  const real = await sys.realpath(path).catch(() => null);
  if (!real) throw new UntrustedSourceError(`${path} is missing`);
  const parts = real.split("/").filter(Boolean);
  let at = "";
  for (let i = 0; i <= parts.length; i++) {
    const p = i === 0 ? "/" : (at = `${at}/${parts[i - 1]}`);
    const st = await sys.info(p);
    if (!st) throw new UntrustedSourceError(`${p} is missing`);
    if (st.uid !== 0) throw new UntrustedSourceError(`${p} is not owned by root`);
    if ((st.mode & 0o022) !== 0) throw new UntrustedSourceError(`${p} is writable by others than root`);
    if (i === parts.length && st.kind !== "file") throw new UntrustedSourceError(`${p} is not a regular file`);
    if (i < parts.length && st.kind !== "dir") throw new UntrustedSourceError(`${p} is not a directory`);
  }
  return real;
}

/**
 * The pieces this release wants on this box. The helper is read from the release tree only after
 * the tree proves root-only; the scripts come from the release's generator, fed what the box's own
 * root-owned scripts say about it.
 */
export async function wantedPieces(sys: BootChainSystem, o: BootChainOptions, inputs: BootChainInputs): Promise<Piece[]> {
  for (const f of o.trustedFiles ?? []) await assertRootOnly(sys, f);
  const helperPath = await assertRootOnly(sys, join(o.releaseRoot, RELEASE_UNSEAL_HELPER));
  const helper = await sys.read(helperPath);
  if (!helper || helper.length === 0) throw new UntrustedSourceError("the release has no unseal helper");
  const scripts = (o.scripts ?? bootChainScripts)(inputs);
  return [
    ...scripts.map((s) => ({ path: s.path, data: enc.encode(s.content), mode: s.mode })),
    { path: UNSEAL_HELPER_PATH, data: helper, mode: UNSEAL_HELPER_MODE },
  ];
}

export function releaseInitrdExpectations(pieces: Piece[]): InitrdEntry[] {
  const helper = pieces.find((p) => p.path === UNSEAL_HELPER_PATH);
  const scripts = pieces.filter((p) => p.path !== UNSEAL_HELPER_PATH).map((p) => ({ path: p.path, content: dec.decode(p.data), mode: p.mode }));
  return initrdExpectations(scripts, helper?.data.length ?? 0);
}

/** Merged-/usr initrds keep bin and sbin under usr/; either place satisfies the unlock. */
function initrdPathVariants(path: string): string[] {
  return /^(bin|sbin|lib|lib64)\//.test(path) ? [path, `usr/${path}`] : [path];
}

/** What is missing from a listing, as one line per problem; empty when it holds everything. */
export function missingFromInitrd(listing: readonly InitrdListingEntry[], expected: readonly InitrdEntry[]): string[] {
  const byPath = new Map<string, InitrdListingEntry>();
  for (const e of listing) byPath.set(e.path.replace(/^\.\//, "").replace(/^(early|main)\//, ""), e);
  const problems: string[] = [];
  for (const want of expected) {
    const got = initrdPathVariants(want.path).map((p) => byPath.get(p)).find((e) => e !== undefined);
    if (!got) problems.push(`no ${want.path}`);
    else if (want.size !== undefined && (got.kind !== "file" || got.size !== want.size)) problems.push(`${want.path} is ${got.size} bytes, not ${want.size}`);
  }
  return problems;
}

/**
 * Parse `lsinitramfs -l` (cpio -tv lines: mode, links, owner, group, size, date, name). Lines that
 * are not entries (a segment header) are skipped.
 */
export function parseInitrdListing(text: string): InitrdListingEntry[] {
  const out: InitrdListingEntry[] = [];
  const re = /^([-dlcbps])[rwxsStT-]{9}\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+[\d:]+\s+(.+)$/;
  for (const line of text.split("\n")) {
    const m = re.exec(line.trimEnd());
    if (!m) continue;
    let name = m[3]!;
    const kind = m[1] === "-" ? "file" : m[1] === "d" ? "dir" : m[1] === "l" ? "symlink" : "other";
    if (kind === "symlink") name = name.replace(/ -> .*$/, "");
    if (name === "." || name === "") continue;
    out.push({ path: name.replace(/^\.\//, ""), size: Number(m[2]), kind });
  }
  return out;
}

const SAFE_GRUB_WORD = /^[A-Za-z0-9._/:=,+@%-]+$/;

/**
 * The kernel and arguments the running boot used (GRUB adds BOOT_IMAGE), for the trial entry:
 * the same kernel and command line, plus a reboot on initramfs failure and the trial's token.
 * Null when the command line can't be carried safely into a GRUB entry.
 */
export function trialKernelLine(cmdline: string, token: string): { kernelPath: string; args: string[] } | null {
  const words = cmdline.trim().split(/\s+/).filter(Boolean);
  const bootImage = words.find((w) => w.startsWith("BOOT_IMAGE="));
  if (!bootImage) return null;
  const kernelPath = bootImage.slice("BOOT_IMAGE=".length).replace(/^\([^)]*\)/, "");
  if (!/^\/[A-Za-z0-9._/+-]+$/.test(kernelPath)) return null;
  const args: string[] = [];
  for (const w of words) {
    if (w.startsWith("BOOT_IMAGE=") || w.startsWith("panic=") || w.startsWith("flagship.bootchain=")) continue;
    if (/[\u0000-\u001f\u007f']/.test(w)) return null;
    args.push(SAFE_GRUB_WORD.test(w) ? w : `'${w}'`);
  }
  args.push(`panic=${TRIAL_PANIC_SECS}`, `flagship.bootchain=${token}`);
  return { kernelPath, args };
}

export function buildTrialGrubConfig(o: { uuid: string; kernelPath: string; args: string[]; initrdPath: string }): string {
  if (!/^[A-Za-z0-9-]+$/.test(o.uuid)) throw new Error("bad filesystem UUID");
  if (!/^\/[A-Za-z0-9._/+-]+$/.test(o.initrdPath)) throw new Error("bad initrd path");
  return `${CUSTOM_CFG_MARK}
menuentry 'Flagship start-up check' --id ${TRIAL_ENTRY_ID} {
\tinsmod part_gpt
\tinsmod part_msdos
\tinsmod ext2
\tinsmod gzio
\tsearch --no-floppy --fs-uuid --set=root ${o.uuid}
\tlinux ${o.kernelPath} ${o.args.join(" ")}
\tinitrd ${o.initrdPath}
}
`;
}

/** Compare kernel release strings by their runs of digits, so 6.12.10 sorts after 6.12.9. */
export function compareKernels(a: string, b: string): number {
  const pa = a.match(/\d+|\D+/g) ?? [];
  const pb = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function emptyState(): BootChainState {
  return { v: 1 };
}

let running = false;

export async function runBootChainRefresh(sys: BootChainSystem, o: BootChainOptions): Promise<BootChainOutcome> {
  if (running) return { action: "none", reason: "busy" };
  running = true;
  try {
    return await runLocked(sys, o);
  } finally {
    running = false;
  }
}

async function runLocked(sys: BootChainSystem, o: BootChainOptions): Promise<BootChainOutcome> {
  const stateDir = o.stateDir ?? BOOT_CHAIN_STATE_DIR;
  const lockPath = join(stateDir, "lock");
  const pid = await sys.read(lockPath);
  const holder = pid ? Number(dec.decode(pid).trim()) : NaN;
  if (Number.isInteger(holder) && holder > 0 && holder !== process.pid) {
    try {
      process.kill(holder, 0);
      return { action: "none", reason: "busy" };
    } catch {
      /* a lock left by a run that died */
    }
  }
  await sys.write(lockPath, enc.encode(String(process.pid)), 0o600);
  try {
    return await new BootChainRun(sys, o, stateDir).run();
  } finally {
    await sys.remove(lockPath).catch(() => {});
  }
}

class BootChainRun {
  private readonly bootDir: string;
  private readonly confDir: string;
  private state: BootChainState = emptyState();

  constructor(
    private readonly sys: BootChainSystem,
    private readonly o: BootChainOptions,
    private readonly stateDir: string,
  ) {
    this.bootDir = o.bootDir ?? "/boot";
    this.confDir = o.confDir ?? INITRAMFS_CONF_DIR;
  }

  private get statePath(): string {
    return join(this.stateDir, "state.json");
  }
  private get trialInitrd(): string {
    return join(this.bootDir, TRIAL_INITRD_NAME);
  }
  private get customCfg(): string {
    return join(this.bootDir, "grub", "custom.cfg");
  }
  private defaultInitrd(kernel: string): string {
    return join(this.bootDir, `initrd.img-${kernel}`);
  }
  private knownGoodPath(kernel: string): string {
    return join(this.stateDir, "known-good", `initrd.img-${kernel}`);
  }
  /** initramfs-tools' own record of the image it built (absent on newer releases). */
  private initramfsRecord(kernel: string): string {
    return `/var/lib/initramfs-tools/${kernel}`;
  }

  private async load(): Promise<void> {
    const raw = await this.sys.read(this.statePath);
    try {
      const s = raw ? (JSON.parse(dec.decode(raw)) as BootChainState) : null;
      this.state = s && s.v === 1 ? s : emptyState();
    } catch {
      this.sys.log("[boot-chain] state unreadable; starting over");
      this.state = emptyState();
    }
  }

  private async save(): Promise<void> {
    await this.sys.write(this.statePath, enc.encode(JSON.stringify(this.state)), 0o600);
  }

  async run(): Promise<BootChainOutcome> {
    await this.load();
    if (this.state.journal) await this.recover();

    let inputs: BootChainInputs | null;
    let pieces: Piece[];
    try {
      inputs = installedBootChainInputs(await this.readRootOwned(UNLOCK_PREMOUNT_PATH), await this.readRootOwned(WIFI_PREMOUNT_PATH));
      if (!inputs) return { action: "none", reason: "no-boot-chain" };
      pieces = await wantedPieces(this.sys, this.o, inputs);
    } catch (e) {
      if (!(e instanceof UntrustedSourceError)) throw e;
      this.sys.log(`[boot-chain] refused: ${e.message}`);
      if (this.state.failed?.reason === "untrusted-source") return { action: "none", reason: "failed-before" };
      return this.rollBack("untrusted-source", `A start-up file wasn't root's own (${e.message}), so nothing was changed.`, "untrusted");
    }
    const digest = piecesDigest(pieces);
    const kernel = this.sys.kernelRelease();
    const cmdline = await this.sys.cmdline();
    const bootId = await this.sys.bootId();

    const t = this.state.trial;
    if (t) {
      const onTrial = cmdline.split(/\s+/).includes(`flagship.bootchain=${t.token}`);
      if (onTrial) {
        if (t.digest === digest && t.kernel === kernel && (await this.newestKernel()) === kernel) return this.promote(pieces, digest, kernel);
        this.sys.log("[boot-chain] booted a trial the release has moved past; dropping it");
        await this.dropTrial();
      } else if (t.bootId !== bootId) {
        await this.dropTrial();
        if (t.kernel === kernel) {
          this.state.failed = { digest: t.digest, reason: "trial-boot-failed", at: this.sys.now() };
          await this.save();
          return { action: "rolled-back", reason: "trial-boot-failed", detail: "The new start-up unlock didn't bring this server up, so it started with the previous one.", digest: t.digest };
        }
        this.sys.log("[boot-chain] the box restarted on another kernel; the trial will be built again");
      } else if (t.digest === digest) {
        return { action: "none", reason: "trial-pending" };
      } else {
        this.sys.log("[boot-chain] a newer release replaced the waiting trial");
        await this.dropTrial();
      }
    }

    if (await this.installedMatches(pieces)) {
      const established = await this.keepKnownGood(kernel, cmdline);
      if (this.state.confirmed?.digest !== digest || this.state.failed) {
        this.state.confirmed = { digest, at: this.sys.now() };
        delete this.state.failed;
        await this.save();
      }
      return { action: "none", reason: "current", ...(established ? { established: true } : {}) };
    }
    if (this.state.failed?.digest === digest) return { action: "none", reason: "failed-before" };
    return this.stage(pieces, digest, kernel, cmdline, bootId);
  }

  private async readRootOwned(path: string): Promise<string | null> {
    const st = await this.sys.info(path);
    if (!st) return null;
    if (st.kind !== "file" || st.uid !== 0 || (st.mode & 0o022) !== 0) throw new UntrustedSourceError(`${path} is not root's own`);
    const data = await this.sys.read(path);
    return data ? dec.decode(data) : null;
  }

  private async installedMatches(pieces: Piece[]): Promise<boolean> {
    for (const p of pieces) {
      const st = await this.sys.info(p.path);
      if (!st || st.kind !== "file" || (st.mode & 0o7777) !== p.mode || st.uid !== 0) return false;
      if (!sameBytes(await this.sys.read(p.path), p.data)) return false;
    }
    return true;
  }

  private async newestKernel(): Promise<string | null> {
    const names = await this.sys.list(this.bootDir).catch(() => [] as string[]);
    const kernels = names.filter((n) => n.startsWith("vmlinuz-")).map((n) => n.slice("vmlinuz-".length));
    return kernels.sort(compareKernels).at(-1) ?? null;
  }

  /** A copy of the initrd this healthy boot came up on, unless it changed after the boot began. */
  private async keepKnownGood(kernel: string, cmdline: string): Promise<boolean> {
    if (/(^|\s)flagship\.bootchain=/.test(cmdline)) return false;
    const live = this.defaultInitrd(kernel);
    const st = await this.sys.info(live);
    if (!st || st.kind !== "file") return false;
    const kg = this.state.knownGood;
    if (kg && kg.kernel === kernel && kg.size === st.size && kg.mtimeMs === st.mtimeMs && (await this.sys.info(this.knownGoodPath(kernel)))) return false;
    if (st.mtimeMs > (await this.sys.bootTimeMs())) return false;
    const data = await this.sys.read(live);
    if (!data) return false;
    await this.sys.write(this.knownGoodPath(kernel), data, 0o600);
    if (kg && kg.kernel !== kernel) await this.sys.remove(this.knownGoodPath(kg.kernel)).catch(() => {});
    this.state.knownGood = { kernel, size: st.size, mtimeMs: st.mtimeMs, sha256: sha256(data), at: this.sys.now() };
    await this.save();
    this.sys.log(`[boot-chain] kept a known-good copy of the initrd for ${kernel}`);
    return true;
  }

  private async rollBack(reason: string, detail: string, digest: string, record = true): Promise<BootChainOutcome> {
    if (record) {
      this.state.failed = { digest, reason, at: this.sys.now() };
      await this.save();
    }
    this.sys.log(`[boot-chain] kept the previous boot chain: ${reason}`);
    return { action: "rolled-back", reason, detail, digest };
  }

  // ── journal ──────────────────────────────────────────────────────────

  private async backUp(paths: string[]): Promise<Backup[]> {
    const backups: Backup[] = [];
    let n = 0;
    for (const path of paths) {
      const st = await this.sys.info(path);
      const data = st?.kind === "file" ? await this.sys.read(path) : null;
      if (data) {
        const saved = join(this.stateDir, "backup", `${n++}`);
        await this.sys.write(saved, data, 0o600);
        backups.push({ path, saved, mode: st!.mode & 0o7777 });
      } else {
        backups.push({ path, saved: null, mode: 0 });
      }
    }
    return backups;
  }

  private async restore(backups: Backup[]): Promise<void> {
    for (const b of backups) {
      if (b.saved === null) {
        await this.sys.remove(b.path).catch(() => {});
        continue;
      }
      const data = await this.sys.read(b.saved);
      if (data) await this.sys.write(b.path, data, b.mode);
    }
    await this.sys.sync();
  }

  private async clearJournal(): Promise<void> {
    delete this.state.journal;
    await this.save();
    await this.sys.removeTree(join(this.stateDir, "backup")).catch(() => {});
  }

  /** A run that stopped half way: put back every file it had replaced. */
  private async recover(): Promise<void> {
    const j = this.state.journal!;
    this.sys.log(`[boot-chain] an interrupted ${j.phase} is being undone`);
    await this.restore(j.backups);
    if (j.phase === "promoting") await this.dropTrial();
    await this.clearJournal();
    await this.sys.removeTree(join(this.stateDir, "stage")).catch(() => {});
  }

  // ── stage ────────────────────────────────────────────────────────────

  private async stage(pieces: Piece[], digest: string, kernel: string, cmdline: string, bootId: string): Promise<BootChainOutcome> {
    if ((await this.newestKernel()) !== kernel) {
      this.sys.log(`[boot-chain] a newer kernel than ${kernel} is installed; staging after the next restart`);
      return { action: "none", reason: "deferred", detail: "newer-kernel" };
    }
    if (!(await this.sys.toolsPresent())) return this.rollBack("no-tools", "This server lacks the tools to test a new start-up unlock, so it kept the previous one.", digest);
    const live = await this.sys.info(this.defaultInitrd(kernel));
    if (!live || !(await this.sys.info(join(this.bootDir, `vmlinuz-${kernel}`)))) {
      return this.rollBack("no-initrd", `There is no initrd for the running kernel ${kernel}, so the previous start-up unlock stays.`, digest);
    }
    const custom = await this.sys.read(this.customCfg);
    if (custom && !dec.decode(custom).startsWith(CUSTOM_CFG_MARK)) {
      return this.rollBack("grub-custom-in-use", "GRUB's custom.cfg holds someone else's entries, so a one-time test boot can't be added.", digest);
    }
    const grubCfg = await this.sys.read(join(this.bootDir, "grub", "grub.cfg"));
    if (!grubCfg || !dec.decode(grubCfg).includes("custom.cfg") || !dec.decode(grubCfg).includes("next_entry")) {
      return this.rollBack("grub-unsupported", "This server's GRUB can't boot a test entry once, so the previous start-up unlock stays.", digest);
    }
    const token = this.sys.randomToken();
    const line = trialKernelLine(cmdline, token);
    const uuid = await this.sys.fsUuid(this.bootDir);
    if (!line || !uuid || !line.kernelPath.endsWith(`/vmlinuz-${kernel}`)) {
      return this.rollBack("grub-unsupported", "The running kernel's command line can't be repeated for a test boot, so the previous start-up unlock stays.", digest);
    }
    if ((await this.sys.freeBytes(this.bootDir)) < live.size * 2) {
      return this.rollBack("no-space", "There isn't room on /boot for a test copy of the start-up files, so the previous ones stay.", digest);
    }

    const stage = join(this.stateDir, "stage");
    const conf = join(stage, "initramfs-tools");
    const built = join(stage, "initrd.img");
    const helper = pieces.find((p) => p.path === UNSEAL_HELPER_PATH)!;
    await this.sys.removeTree(stage).catch(() => {});
    const journal: NonNullable<BootChainState["journal"]> = { phase: "staging", backups: await this.backUp([UNSEAL_HELPER_PATH]) };
    this.state.journal = journal;
    await this.save();
    let result: ToolResult;
    try {
      await this.sys.copyTree(this.confDir, conf);
      for (const p of pieces) {
        if (p.path === UNSEAL_HELPER_PATH) continue;
        if (!p.path.startsWith(`${this.confDir}/`)) throw new Error(`${p.path} is outside ${this.confDir}`);
        await this.sys.write(join(conf, p.path.slice(this.confDir.length + 1)), p.data, p.mode);
      }
      // The hook copies the helper from /boot: the release's for this build, then the old one back.
      await this.sys.write(UNSEAL_HELPER_PATH, helper.data, helper.mode);
      result = await this.sys.buildInitrd(conf, built, kernel);
    } catch (e) {
      result = { ok: false, output: (e as Error).message };
    } finally {
      await this.restore(journal.backups);
      await this.clearJournal();
    }
    const hookFailure = result.output.split("\n").find((l) => l.includes(HOOK_FAILED));
    if (!result.ok || hookFailure) {
      await this.sys.removeTree(stage).catch(() => {});
      const why = (hookFailure ?? result.output.trim().split("\n").at(-1) ?? "").slice(0, 200);
      return this.rollBack("build-failed", `The new start-up files didn't build${why ? ` (${why})` : ""}; the previous ones stay.`, digest);
    }
    const listing = await this.sys.listInitrd(built);
    const missing = listing ? missingFromInitrd(listing, (this.o.expectations ?? releaseInitrdExpectations)(pieces)) : ["it can't be listed"];
    const contentDigest = missing.length === 0 ? await this.sys.initrdContentDigest(built) : null;
    if (missing.length > 0 || !contentDigest) {
      await this.sys.removeTree(stage).catch(() => {});
      const why = missing.length ? missing.slice(0, 3).join(", ") : "it can't be read";
      return this.rollBack("verify-failed", `The new initrd failed its check (${why}); the previous start-up unlock stays.`, digest);
    }

    const image = await this.sys.read(built);
    await this.sys.removeTree(stage).catch(() => {});
    if (!image) return this.rollBack("verify-failed", "The new initrd vanished before it could be tested; the previous start-up unlock stays.", digest);
    const kernelDir = dirname(line.kernelPath);
    const initrdPath = `${kernelDir === "/" ? "" : kernelDir}/${TRIAL_INITRD_NAME}`;
    try {
      await this.sys.write(this.trialInitrd, image, 0o600);
      await this.sys.write(this.customCfg, enc.encode(buildTrialGrubConfig({ uuid, kernelPath: line.kernelPath, args: line.args, initrdPath })), 0o600);
      await this.sys.sync();
      if (!(await this.sys.grubBootOnce(this.bootDir, TRIAL_ENTRY_ID))) throw new Error("grub-reboot did not take");
    } catch (e) {
      await this.dropTrial();
      return this.rollBack("grub-failed", `GRUB couldn't be set to test the new start-up unlock (${(e as Error).message}); the previous one stays.`, digest);
    }
    this.state.trial = { digest, token, kernel, bootId, contentDigest, at: this.sys.now() };
    delete this.state.failed;
    await this.save();
    this.sys.log(`[boot-chain] a trial of the release's boot chain will run at the next restart (${kernel})`);
    return { action: "staged", digest, kernel };
  }

  private async dropTrial(): Promise<void> {
    await this.sys.grubClearOnce(this.bootDir).catch(() => {});
    const custom = await this.sys.read(this.customCfg);
    if (custom && dec.decode(custom).startsWith(CUSTOM_CFG_MARK)) await this.sys.remove(this.customCfg);
    await this.sys.remove(this.trialInitrd).catch(() => {});
    await this.sys.sync();
    if (this.state.trial) {
      delete this.state.trial;
      await this.save();
    }
  }

  // ── promote ──────────────────────────────────────────────────────────

  private async promote(pieces: Piece[], digest: string, kernel: string): Promise<BootChainOutcome> {
    const trial = this.state.trial!;
    const live = this.defaultInitrd(kernel);
    const journal: NonNullable<BootChainState["journal"]> = {
      phase: "promoting",
      backups: await this.backUp([...pieces.map((p) => p.path), live, this.initramfsRecord(kernel)]),
    };
    this.state.journal = journal;
    await this.save();
    const fail = async (reason: string, detail: string): Promise<BootChainOutcome> => {
      await this.restore(journal.backups);
      await this.clearJournal();
      await this.dropTrial();
      return this.rollBack(reason, detail, digest);
    };
    try {
      for (const p of pieces) await this.sys.write(p.path, p.data, p.mode);
      const r = await this.sys.updateInitrd(kernel);
      await this.sys.sync();
      const hookFailure = r.output.split("\n").find((l) => l.includes(HOOK_FAILED));
      if (!r.ok || hookFailure) {
        return await fail("promote-build-failed", `The start-up files booted in their test but didn't rebuild as the default${hookFailure ? ` (${hookFailure.slice(0, 160)})` : ""}; the previous ones are back.`);
      }
      const listing = await this.sys.listInitrd(live);
      const missing = listing ? missingFromInitrd(listing, (this.o.expectations ?? releaseInitrdExpectations)(pieces)) : ["it can't be listed"];
      if (missing.length > 0) return await fail("promote-verify-failed", `The rebuilt initrd failed its check (${missing.slice(0, 3).join(", ")}); the previous start-up unlock is back.`);
      if ((await this.sys.initrdContentDigest(live)) !== trial.contentDigest) {
        return await fail("promote-differs", "The rebuilt initrd isn't the one that passed the test boot, so the previous start-up unlock is back.");
      }
    } catch (e) {
      return await fail("promote-failed", `Making the new start-up unlock the default failed (${(e as Error).message}); the previous one is back.`);
    }
    // Until the new default has booted, the restore point stays the image it replaced.
    const kept = journal.backups.find((b) => b.path === live);
    const old = kept?.saved ? await this.sys.read(kept.saved) : null;
    if (old) {
      await this.sys.write(this.knownGoodPath(kernel), old, 0o600);
      this.state.knownGood = { kernel, size: old.length, mtimeMs: 0, sha256: sha256(old), at: this.sys.now() };
    }
    await this.clearJournal();
    await this.dropTrial();
    this.state.confirmed = { digest, at: this.sys.now() };
    delete this.state.failed;
    await this.save();
    this.sys.log(`[boot-chain] the release's boot chain passed its test boot and is now the default (${kernel})`);
    return { action: "refreshed", digest, kernel };
  }
}

// ── the real box ───────────────────────────────────────────────────────

const TOOL_ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" };
const TOOLS = ["/usr/sbin/mkinitramfs", "/usr/sbin/update-initramfs", "/usr/bin/lsinitramfs", "/usr/bin/unmkinitramfs", "/usr/sbin/grub-reboot", "/usr/bin/grub-editenv", "/usr/bin/findmnt"];

function tool(file: string, args: string[], timeoutMs: number): Promise<ToolResult & { stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env: TOOL_ENV, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout}\n${stderr}`, stdout });
    });
  });
}

async function treeDigest(root: string): Promise<string> {
  const h = createHash("sha256");
  const walk = async (rel: string): Promise<void> => {
    const abs = rel ? join(root, rel) : root;
    const names = (await readdir(abs)).sort();
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      const st = await lstat(join(root, r));
      const mode = (st.mode & 0o7777).toString(8);
      if (st.isSymbolicLink()) h.update(`l ${r} ${mode} ${await readlink(join(root, r))}\n`);
      else if (st.isDirectory()) {
        h.update(`d ${r} ${mode}\n`);
        await walk(r);
      } else if (st.isFile()) h.update(`f ${r} ${mode} ${sha256(await readFile(join(root, r)))}\n`);
      else h.update(`o ${r} ${mode} ${st.rdev}\n`);
    }
  };
  await walk("");
  return h.digest("hex");
}

/** The box itself, for `setup.js boot-chain` (root) and a daemon that still runs as root. */
export function realBootChainSystem(log: (m: string) => void = (m) => console.error(m)): BootChainSystem {
  return {
    read: async (p) => {
      try {
        return new Uint8Array(await readFile(p));
      } catch {
        return null;
      }
    },
    write: async (p, data, mode) => {
      await mkdir(dirname(p), { recursive: true, mode: 0o700 });
      await writeFileDurable(p, data, mode);
    },
    remove: (p) => removeDurable(p),
    info: async (p) => {
      try {
        const st = await lstat(p);
        const kind = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
        return { uid: st.uid, mode: st.mode & 0o7777, size: st.size, mtimeMs: st.mtimeMs, kind };
      } catch {
        return null;
      }
    },
    realpath: (p) => realpath(p),
    list: (d) => readdir(d),
    freeBytes: async (d) => {
      const s = await statfs(d);
      return Number(s.bavail) * Number(s.bsize);
    },
    copyTree: async (from, to) => {
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      const r = await tool("/usr/bin/cp", ["-a", "--", from, to], 120_000);
      if (!r.ok) throw new Error(`copying ${from} failed`);
    },
    removeTree: (p) => rm(p, { recursive: true, force: true }),
    buildInitrd: (confDir, out, kernel) => tool("/usr/sbin/mkinitramfs", ["-d", confDir, "-o", out, kernel], 15 * 60_000),
    updateInitrd: (kernel) => tool("/usr/sbin/update-initramfs", ["-u", "-k", kernel], 15 * 60_000),
    listInitrd: async (image) => {
      const r = await tool("/usr/bin/lsinitramfs", ["-l", image], 5 * 60_000);
      return r.ok ? parseInitrdListing(r.stdout) : null;
    },
    initrdContentDigest: async (image) => {
      await mkdir(BOOT_CHAIN_STATE_DIR, { recursive: true, mode: 0o700 });
      const dir = await mkdtemp(join(BOOT_CHAIN_STATE_DIR, "unpack-"));
      try {
        const r = await tool("/usr/bin/unmkinitramfs", [image, dir], 10 * 60_000);
        return r.ok ? await treeDigest(dir) : null;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    fsUuid: async (d) => {
      const r = await tool("/usr/bin/findmnt", ["-n", "-o", "UUID", "--target", d], 30_000);
      const uuid = r.stdout.trim();
      return r.ok && /^[A-Za-z0-9-]+$/.test(uuid) ? uuid : null;
    },
    grubBootOnce: async (bootDir, entry) => {
      const r = await tool("/usr/sbin/grub-reboot", [`--boot-directory=${bootDir}`, entry], 60_000);
      if (!r.ok) return false;
      const env = await tool("/usr/bin/grub-editenv", [join(bootDir, "grub", "grubenv"), "list"], 30_000);
      return env.ok && env.stdout.split("\n").includes(`next_entry=${entry}`);
    },
    grubClearOnce: async (bootDir) => {
      const env = join(bootDir, "grub", "grubenv");
      if (existsSync(env)) await tool("/usr/bin/grub-editenv", [env, "unset", "next_entry"], 30_000);
    },
    toolsPresent: async () => {
      for (const t of TOOLS) {
        try {
          const st = await lstat(t);
          if (!st.isFile() && !st.isSymbolicLink()) return false;
        } catch {
          return false;
        }
      }
      return true;
    },
    sync: async () => {
      await tool("/usr/bin/sync", [], 120_000);
    },
    kernelRelease: () => readFileSync("/proc/sys/kernel/osrelease", "utf8").trim(),
    cmdline: async () => (await readFile("/proc/cmdline", "utf8")).trim(),
    bootId: async () => (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
    bootTimeMs: async () => {
      const btime = /^btime (\d+)$/m.exec(await readFile("/proc/stat", "utf8"))?.[1];
      return btime ? Number(btime) * 1000 : 0;
    },
    randomToken: () => randomBytes(12).toString("hex"),
    now: () => Date.now(),
    log,
  };
}

/** Root's run of the step: the real box, the release at /opt/flagship. */
export function refreshBootChainAsRoot(o: { releaseRoot: string; trustedFiles?: string[]; log?: (m: string) => void }): Promise<BootChainOutcome> {
  return runBootChainRefresh(realBootChainSystem(o.log), { releaseRoot: o.releaseRoot, ...(o.trustedFiles ? { trustedFiles: o.trustedFiles } : {}) });
}
