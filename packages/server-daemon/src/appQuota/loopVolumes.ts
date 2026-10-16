/**
 * Files folders with a size limit (docs/app-runtimes.md §5.3). Each app's
 * Docker volume is a bind of a folder inside its own ext4 filesystem: a
 * sparse image file, loop-mounted by the box, so a full folder is ENOSPC for
 * that app alone and never fills the box's disk.
 *
 *   /var/lib/flagship-files/<volume>.img    the sparse ext4 image
 *   /var/lib/flagship-files/<volume>/       its mount point (immutable while
 *                                           unmounted, so nothing lands there)
 *   /var/lib/flagship-files/<volume>/data   what the volume binds, at /data
 *
 * Why images and not ext4 project quotas: the box's root is ext4 on LUKS
 * (the appliance and the USB installer alike) made without the `quota` and
 * `project` features, which can't be turned on while it's mounted. Images
 * need nothing but e2fsprogs and util-linux, which every Debian has.
 *
 * Fail closed: the volume binds `<mount>/data`, which exists only inside
 * the mounted image, so a container whose image isn't mounted fails to
 * start instead of writing to the box's disk.
 *
 * Limits: an image only grows online (resize2fs); a lower limit is held by
 * a ballast file at the image's root, outside the `data/` the app sees,
 * preallocated to what's above the limit (limits.ts `ballastTarget`).
 * Images live outside /var/flagship (never under a docker arg tripwire).
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, open, readdir, readFile, rm, rmdir, stat, statfs, truncate } from "node:fs/promises";
import { join } from "node:path";
import type { CommandRunner } from "../serviceRunner.js";
import { isFilesVolume } from "../dataLayer/naming.js";
import { MIN_IMAGE_BYTES, ballastTarget, shouldGrow } from "./limits.js";

export const FILES_IMAGE_ROOT = "/var/lib/flagship-files";
/** The label a quota-backed volume carries. */
export const QUOTA_LABEL = "flagship.quota";
/** The ballast file, at the image's root (never inside the app's `data/`). */
export const BALLAST_FILE = ".flagship-ballast";
const MOUNT_OPTS = "loop,nodev,nosuid,discard,noinit_itable";

export interface FsUsage {
  /** Filesystem capacity (ext4's metadata already left out). */
  sizeBytes: number;
  /** What the app's files take (the ballast left out). */
  usedBytes: number;
  /** The ballast holding a lower limit, or the brake's freeze. */
  ballastBytes: number;
  /** What the app can still write. */
  availBytes: number;
  /** Bytes of the image file (its apparent size). */
  imageBytes: number;
  readOnly: boolean;
}

export interface LoopHost {
  statfs(path: string): Promise<{ blocks: number; bfree: number; bavail: number; bsize: number }>;
  mounts(): Promise<string>;
  exists(path: string): boolean;
  fileSize(path: string): Promise<number>;
  mkdir(path: string, mode: number): Promise<void>;
  /** Create an empty sparse file of `bytes` (fails if it exists). */
  createSparse(path: string, bytes: number): Promise<void>;
  growSparse(path: string, bytes: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rm(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
}

export const realLoopHost: LoopHost = {
  statfs: async (p) => {
    const s = await statfs(p);
    return { blocks: Number(s.blocks), bfree: Number(s.bfree), bavail: Number(s.bavail), bsize: Number(s.bsize) };
  },
  mounts: () => readFile("/proc/self/mounts", "utf8"),
  exists: (p) => existsSync(p),
  fileSize: async (p) => (await stat(p)).size,
  mkdir: async (p, mode) => {
    await mkdir(p, { recursive: true, mode });
  },
  createSparse: async (p, bytes) => {
    const fh = await open(p, "wx", 0o600);
    try {
      await fh.truncate(bytes);
    } finally {
      await fh.close();
    }
  },
  growSparse: (p, bytes) => truncate(p, bytes),
  chmod: (p, mode) => chmod(p, mode),
  rm: (p) => rm(p, { force: true }),
  rmdir: (p) => rmdir(p),
  readdir: (p) => readdir(p),
};

export type PrepareResult = "mounted" | "adopted" | "plain" | "absent";

export class LoopVolumes {
  private readonly root: string;
  private readonly host: LoopHost;
  private readonly log: (m: string) => void;

  constructor(
    private readonly cmd: CommandRunner,
    opts: { root?: string; host?: LoopHost; log?: (m: string) => void } = {},
  ) {
    this.root = opts.root ?? FILES_IMAGE_ROOT;
    this.host = opts.host ?? realLoopHost;
    this.log = opts.log ?? ((m) => console.warn(m));
  }

  imagePath(volume: string): string {
    return join(this.root, `${volume}.img`);
  }
  mountPath(volume: string): string {
    return join(this.root, volume);
  }
  dataPath(volume: string): string {
    return join(this.root, volume, "data");
  }

  private async sh(cmd: string, args: string[], timeoutMs = 120_000): Promise<string> {
    if (!this.cmd.capture) throw new Error("CommandRunner.capture is not configured");
    return (await this.cmd.capture(cmd, args, { timeoutMs })).stdout;
  }

  private async docker(args: string[]): Promise<string> {
    return this.sh("docker", args, 60_000);
  }

  /** The loop device and options of a mounted image, or null. */
  private async mountOf(volume: string): Promise<{ device: string; readOnly: boolean } | null> {
    const at = this.mountPath(volume);
    const lines = (await this.host.mounts()).split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const f = lines[i]!.split(" ");
      if (f[1] === at) return { device: f[0]!, readOnly: (f[3] ?? "").split(",").includes("ro") };
    }
    return null;
  }

  async isMounted(volume: string): Promise<boolean> {
    return (await this.mountOf(volume)) !== null;
  }

  /**
   * The `device` a Docker volume binds, or null when it doesn't exist; "" for
   * a plain volume. Throws when Docker can't say (not up yet), so a down
   * daemon is never taken for a missing volume.
   */
  private async volumeDevice(volume: string): Promise<string | null> {
    try {
      return (await this.docker(["volume", "inspect", "-f", '{{index .Options "device"}}', volume])).trim().replace(/^<no value>$/, "");
    } catch (e) {
      const err = e as Error & { stderr?: string };
      if (/no such volume/i.test(`${err.message}\n${err.stderr ?? ""}`)) return null;
      throw e;
    }
  }

  /** Whether a volume is backed by one of this box's images. */
  async isQuotaBacked(volume: string): Promise<boolean> {
    const device = await this.volumeDevice(volume);
    return device === this.dataPath(volume);
  }

  private async mount(volume: string): Promise<void> {
    if (await this.isMounted(volume)) return;
    const at = this.mountPath(volume);
    if (!this.host.exists(at)) {
      await this.host.mkdir(at, 0o700);
      await this.sh("chattr", ["+i", at]).catch(() => {});
    }
    await this.sh("mount", ["-o", MOUNT_OPTS, this.imagePath(volume), at]);
  }

  /** Make and mount a fresh image (no Docker volume yet). */
  private async makeImage(volume: string, sizeBytes: number): Promise<void> {
    await this.host.mkdir(this.root, 0o700);
    const img = this.imagePath(volume);
    if (this.host.exists(img)) await this.dropImage(volume);
    await this.host.createSparse(img, Math.max(MIN_IMAGE_BYTES, sizeBytes));
    try {
      // 4 KiB blocks and the default inode ratio even for a small image (mke2fs
      // would pick 1 KiB blocks), since it may grow a thousandfold later.
      await this.sh("mkfs.ext4", ["-q", "-F", "-b", "4096", "-T", "default", "-m", "0", "-E", "lazy_itable_init=1,lazy_journal_init=1,nodiscard", img]);
      await this.mount(volume);
      const data = this.dataPath(volume);
      await this.host.mkdir(data, 0o777);
      // The app's uid varies by runtime (10001, nginx's 101, a tier-3 image's
      // own): the folder is only ever mounted into this app's container.
      await this.host.chmod(data, 0o777);
    } catch (e) {
      await this.dropImage(volume).catch(() => {});
      throw e;
    }
  }

  private async createBindVolume(volume: string, labels: Record<string, string>): Promise<void> {
    const l = Object.entries({ ...labels, [QUOTA_LABEL]: "loop" }).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
    await this.docker([
      "volume",
      "create",
      "--driver",
      "local",
      "--opt",
      "type=none",
      "--opt",
      "o=bind",
      "--opt",
      `device=${this.dataPath(volume)}`,
      ...l,
      volume,
    ]);
  }

  /** A new files folder of at most `sizeBytes`. Throws when the volume already exists. */
  async create(volume: string, sizeBytes: number, labels: Record<string, string> = {}): Promise<void> {
    assertVolume(volume);
    if ((await this.volumeDevice(volume)) !== null) throw new Error(`files volume ${volume} already exists`);
    await this.makeImage(volume, sizeBytes);
    try {
      await this.createBindVolume(volume, labels);
    } catch (e) {
      await this.dropImage(volume).catch(() => {});
      throw e;
    }
  }

  /** Unmount and delete an image (its Docker volume is the caller's). */
  private async dropImage(volume: string): Promise<void> {
    const at = this.mountPath(volume);
    if (await this.isMounted(volume)) {
      await this.sh("umount", [at]).catch(async () => {
        await this.sh("umount", ["-l", at]);
      });
    }
    if (this.host.exists(at)) {
      await this.sh("chattr", ["-i", at]).catch(() => {});
      await this.host.rmdir(at).catch(() => {});
    }
    await this.host.rm(this.imagePath(volume));
  }

  /** Remove the volume and its image; a volume already gone is fine. */
  async remove(volume: string): Promise<void> {
    assertVolume(volume);
    if ((await this.volumeDevice(volume)) !== null) await this.docker(["volume", "rm", volume]);
    if (this.host.exists(this.imagePath(volume)) || this.host.exists(this.mountPath(volume))) await this.dropImage(volume);
  }

  /**
   * Before a container mounts the volume: mount its image (after a reboot),
   * or move an older plain volume into an image when nothing uses it.
   * "plain" means the folder still has no limit (a container holds it).
   */
  async prepare(volume: string, sizeBytes: number): Promise<PrepareResult> {
    assertVolume(volume);
    const device = await this.volumeDevice(volume);
    if (device === null) {
      if (!this.host.exists(this.imagePath(volume))) return "absent";
      // The image is here but its volume isn't (a move cut short between
      // removing the old volume and binding the new one): bind it again
      // rather than let Docker make an empty one of that name.
      await this.mount(volume);
      await this.createBindVolume(volume, {});
      return "mounted";
    }
    if (device === this.dataPath(volume)) {
      if (!this.host.exists(this.imagePath(volume))) {
        throw new Error("this app's files folder is missing its disk image");
      }
      await this.mount(volume);
      return "mounted";
    }
    if (device !== "") return "plain";
    const users = (await this.docker(["ps", "-aq", "--filter", `volume=${volume}`])).trim();
    if (users) return "plain";
    try {
      await this.adopt(volume, sizeBytes);
    } catch (e) {
      // The app keeps its folder as it was (no limit of its own) rather than not starting.
      this.log(`[app-quota] ${(e as Error).message}`);
      return "plain";
    }
    return "adopted";
  }

  /** Copy a plain volume's folder into a new image and swap the volume over. */
  private async adopt(volume: string, sizeBytes: number): Promise<void> {
    const old = (await this.docker(["volume", "inspect", "-f", "{{.Mountpoint}}", volume])).trim();
    if (!old.startsWith("/")) throw new Error(`files volume ${volume} has no folder to move`);
    const labels = parseLabels(await this.docker(["volume", "inspect", "-f", "{{json .Labels}}", volume]));
    const used = await this.duBytes(old);
    await this.makeImage(volume, Math.max(sizeBytes, Math.ceil(used * 1.1) + MIN_IMAGE_BYTES));
    try {
      await this.sh("cp", ["-a", "--", `${old}/.`, `${this.dataPath(volume)}/`], 30 * 60_000);
    } catch (e) {
      await this.dropImage(volume).catch(() => {});
      throw new Error(`couldn't move ${volume} into its own disk image: ${(e as Error).message}`);
    }
    await this.docker(["volume", "rm", volume]);
    await this.createBindVolume(volume, labels);
    this.log(`[app-quota] moved ${volume} into its own disk image`);
  }

  private async duBytes(path: string): Promise<number> {
    try {
      const kib = Number((await this.sh("du", ["-sk", path], 10 * 60_000)).trim().split(/\s+/)[0]);
      return Number.isFinite(kib) ? kib * 1024 : 0;
    } catch {
      return 0;
    }
  }

  /** The folder's filesystem numbers, or null when its image isn't mounted. */
  async usage(volume: string): Promise<FsUsage | null> {
    const m = await this.mountOf(volume);
    if (!m) return null;
    const s = await this.host.statfs(this.mountPath(volume));
    const ballast = this.host.exists(this.ballastPath(volume)) ? await this.host.fileSize(this.ballastPath(volume)).catch(() => 0) : 0;
    return {
      sizeBytes: s.blocks * s.bsize,
      usedBytes: Math.max(0, (s.blocks - s.bfree) * s.bsize - ballast),
      ballastBytes: ballast,
      availBytes: s.bavail * s.bsize,
      imageBytes: await this.host.fileSize(this.imagePath(volume)).catch(() => 0),
      readOnly: m.readOnly,
    };
  }

  /**
   * Hold the folder to `limitBytes` (null: only the image's own size): grow
   * the image to `imageBytes` when that's a real step, then size the
   * ballast to what's above the limit; `freeze` (the brake) takes all that's
   * free. An app already over a lower limit gets the room it frees taken,
   * tick by tick, until it's down to the limit.
   */
  async applyLimit(volume: string, a: { imageBytes: number; limitBytes: number | null; freeze: boolean }): Promise<FsUsage | null> {
    const m = await this.mountOf(volume);
    if (!m) return null;
    let u = await this.usage(volume);
    if (!u) return null;
    if (shouldGrow(u.imageBytes, a.imageBytes)) {
      await this.host.growSparse(this.imagePath(volume), a.imageBytes);
      await this.sh("losetup", ["-c", m.device]);
      await this.sh("resize2fs", [m.device], 10 * 60_000);
      u = (await this.usage(volume)) ?? u;
    }
    const want = ballastTarget({
      capacityBytes: u.sizeBytes,
      ballastBytes: u.ballastBytes,
      availBytes: u.availBytes,
      limitBytes: a.limitBytes,
      freeze: a.freeze,
    });
    if (want !== u.ballastBytes) {
      await this.setBallast(volume, u.ballastBytes, want, u.availBytes);
      u = (await this.usage(volume)) ?? u;
    }
    return u;
  }

  ballastPath(volume: string): string {
    return join(this.mountPath(volume), BALLAST_FILE);
  }

  /** Grow (fallocate: no writes, no host disk) or shrink (truncate) the ballast. */
  private async setBallast(volume: string, current: number, want: number, availBytes: number): Promise<void> {
    const path = this.ballastPath(volume);
    if (want <= 0) {
      await this.host.rm(path);
      return;
    }
    if (want < current) {
      await this.host.growSparse(path, want);
      return;
    }
    try {
      await this.sh("fallocate", ["-l", String(want), path]);
    } catch {
      // Less room than the limit wants (the app is over it): take what's free now.
      const most = Math.floor((current + availBytes - 64 * 1024) / 4096) * 4096;
      if (most > current) await this.sh("fallocate", ["-l", String(most), path]).catch(() => {});
    }
  }

  /** The hard brake: read-only (EROFS) until the box's disk has room again. */
  async setReadOnly(volume: string, readOnly: boolean): Promise<void> {
    const m = await this.mountOf(volume);
    if (!m || m.readOnly === readOnly) return;
    await this.sh("mount", ["-o", `remount,${readOnly ? "ro" : "rw"}`, this.mountPath(volume)]);
  }

  /** Volumes that have an image on this box. */
  async listImages(): Promise<string[]> {
    if (!this.host.exists(this.root)) return [];
    return (await this.host.readdir(this.root))
      .filter((f) => f.endsWith(".img"))
      .map((f) => f.slice(0, -4))
      .filter((v) => isFilesVolume(v));
  }

  /**
   * At boot, before any app starts: mount every image. Needs no Docker,
   * which may not be up yet.
   */
  async mountAll(): Promise<number> {
    let mounted = 0;
    for (const volume of await this.listImages()) {
      try {
        if (!(await this.isMounted(volume))) {
          await this.mount(volume);
          mounted++;
        }
      } catch (e) {
        this.log(`[app-quota] couldn't mount the files image of ${volume}: ${(e as Error).message}`);
      }
    }
    return mounted;
  }

  /** Unmount and delete every image (the box's self-delete). */
  async dropAll(): Promise<string[]> {
    const left: string[] = [];
    for (const volume of await this.listImages()) {
      try {
        await this.dropImage(volume);
      } catch (e) {
        left.push(volume);
        this.log(`[app-quota] couldn't delete the files image of ${volume}: ${(e as Error).message}`);
      }
    }
    return left;
  }
}

function assertVolume(volume: string): void {
  if (!isFilesVolume(volume)) throw new Error(`not a files volume name ${JSON.stringify(volume)}`);
}

function parseLabels(json: string): Record<string, string> {
  try {
    const o = JSON.parse(json.trim()) as Record<string, unknown> | null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o ?? {})) if (typeof v === "string" && k !== QUOTA_LABEL) out[k] = v;
    return out;
  } catch {
    return {};
  }
}
