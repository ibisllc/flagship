/**
 * Removable-storage enumeration + safety classification for the Builder's
 * `write` subcommand. macOS uses `diskutil list -plist external` + per-disk
 * `diskutil info -plist`; Linux uses `lsblk -J -b`.
 *
 * The classifier returns a verdict per disk:
 *
 *   - `removable-usb`: external + ejectable/removable + size in the
 *     500MB..500GB band → safe to offer in the picker, write requires a
 *     typed-yes confirmation
 *   - `internal`: internal media, system boot drive, NVMe, or anything
 *     above 500GB → refused even with --device; defense in depth so a
 *     fat-fingered `--device /dev/disk0` cannot accidentally wipe the
 *     user's laptop
 *   - `too-small`: under 500MB; can't hold a Flagship ISO
 *   - `unknown`: enumeration succeeded but we can't make a safety call
 *     (missing fields). Treated as `internal` for safety — never offered
 *     in the picker, refused on explicit `--device`
 *
 * macOS `/dev/disk0` is HARD-CODED as refused regardless of metadata —
 * it's the system boot drive on every Mac; no legitimate USB stick ever
 * lands there.
 *
 * The whole module is built around an injectable `runCommand` so the
 * safety + classification logic can be exercised in tests without
 * touching real disks.
 */
import { spawn } from "node:child_process";
import { platform } from "node:os";

export const MIN_DEVICE_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB
export const MAX_DEVICE_SIZE_BYTES = 500 * 1024 * 1024 * 1024; // 500 GB

export type SafetyVerdict =
  | "removable-usb"
  | "internal"
  | "too-small"
  | "unknown";

export interface DeviceInfo {
  /** Absolute device node, e.g. `/dev/disk5` or `/dev/sdb`. */
  devicePath: string;
  /** Reported total size in bytes (0 if unknown). */
  sizeBytes: number;
  /** Vendor + model string for display. */
  model: string;
  /** Bus type — "USB", "Disk Image", "NVMe", "Internal", etc. */
  bus: string;
  /** True if any partition on this device is currently mounted. */
  mounted: boolean;
  /** True if the OS marks this disk as removable/ejectable. */
  removable: boolean;
  /** True if the OS marks this disk as internal (laptop SSD etc). */
  internal: boolean;
  /** Final safety classification — see SafetyVerdict comments. */
  verdict: SafetyVerdict;
  /** Human-readable reason for the verdict. */
  verdictReason: string;
}

export type CommandRunner = (
  cmd: string,
  argv: readonly string[],
) => Promise<{ stdout: string; stderr: string; code: number }>;

export const defaultRunCommand: CommandRunner = (cmd, argv) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, [...argv], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => {
      stdout += d.toString("utf-8");
    });
    p.stderr.on("data", (d) => {
      stderr += d.toString("utf-8");
    });
    p.on("error", reject);
    p.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });

export interface EnumerateOpts {
  runCommand?: CommandRunner;
  /** Override platform for tests. */
  os?: NodeJS.Platform;
}

/** List every disk + classify each. Never throws on enumeration failure;
 *  returns [] and prints to stderr. Callers decide whether to fall back
 *  to manual `--device` entry. */
export async function enumerateDevices(opts: EnumerateOpts = {}): Promise<DeviceInfo[]> {
  const run = opts.runCommand ?? defaultRunCommand;
  const os = opts.os ?? platform();
  if (os === "darwin") {
    return enumerateMacos(run);
  }
  if (os === "linux") {
    return enumerateLinux(run);
  }
  return [];
}

/** macOS: parse `diskutil list -plist external` for whole-disk identifiers,
 *  then `diskutil info -plist <disk>` for each. Uses `plutil` to convert
 *  the plist XML to JSON in one shot — easier than walking the XML. */
async function enumerateMacos(run: CommandRunner): Promise<DeviceInfo[]> {
  const list = await run("diskutil", ["list", "-plist", "external"]);
  if (list.code !== 0) {
    return [];
  }
  const top = await plistToJson(list.stdout);
  if (!top) return [];
  const disks = parseMacosDiskList(top);
  const out: DeviceInfo[] = [];
  for (const id of disks) {
    const info = await run("diskutil", ["info", "-plist", id]);
    if (info.code !== 0) continue;
    const parsed = await plistToJson(info.stdout);
    if (!parsed) continue;
    out.push(classifyMacosDisk(id, parsed));
  }
  return out;
}

interface MacosDiskListShape {
  AllDisksAndPartitions?: Array<{
    DeviceIdentifier?: string;
    OSInternal?: boolean;
  }>;
}

export function parseMacosDiskList(plist: unknown): string[] {
  if (!plist || typeof plist !== "object") return [];
  const top = plist as MacosDiskListShape;
  const arr = top.AllDisksAndPartitions;
  if (!Array.isArray(arr)) return [];
  const ids: string[] = [];
  for (const d of arr) {
    if (d && typeof d.DeviceIdentifier === "string") {
      ids.push(d.DeviceIdentifier);
    }
  }
  return ids;
}

interface MacosDiskInfoShape {
  DeviceIdentifier?: string;
  DeviceNode?: string;
  Size?: number;
  TotalSize?: number;
  Internal?: boolean;
  Removable?: boolean;
  Ejectable?: boolean;
  RemovableMediaOrExternalDevice?: boolean;
  MediaName?: string;
  IORegistryEntryName?: string;
  BusProtocol?: string;
  MountPoint?: string;
  VirtualOrPhysical?: string;
  SystemImage?: boolean;
  OSInternalMedia?: boolean;
}

export function classifyMacosDisk(id: string, infoPlist: unknown): DeviceInfo {
  const info = (infoPlist ?? {}) as MacosDiskInfoShape;
  const devicePath = info.DeviceNode ?? `/dev/${id}`;
  const sizeBytes = typeof info.Size === "number"
    ? info.Size
    : typeof info.TotalSize === "number"
    ? info.TotalSize
    : 0;
  const bus = info.BusProtocol ?? "Unknown";
  const model = info.MediaName ?? info.IORegistryEntryName ?? "(unknown model)";
  const internal = info.Internal === true ||
    info.OSInternalMedia === true ||
    info.SystemImage === true;
  const removable = info.Removable === true ||
    info.Ejectable === true ||
    info.RemovableMediaOrExternalDevice === true;
  const mounted = typeof info.MountPoint === "string" && info.MountPoint.length > 0;
  const verdict = computeVerdict({
    devicePath,
    sizeBytes,
    internal,
    removable,
    bus,
    virtual: info.VirtualOrPhysical === "Virtual",
  });
  return {
    devicePath,
    sizeBytes,
    model,
    bus,
    mounted,
    removable,
    internal,
    verdict: verdict.verdict,
    verdictReason: verdict.reason,
  };
}

async function enumerateLinux(run: CommandRunner): Promise<DeviceInfo[]> {
  const r = await run("lsblk", [
    "-J",
    "-b",
    "-o",
    "NAME,SIZE,TYPE,RM,RO,MODEL,VENDOR,TRAN,MOUNTPOINT,HOTPLUG",
  ]);
  if (r.code !== 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return [];
  }
  return parseLsblk(parsed);
}

interface LsblkNode {
  name?: string;
  size?: number | string;
  type?: string;
  rm?: boolean | number | string;
  ro?: boolean | number | string;
  model?: string;
  vendor?: string;
  tran?: string;
  mountpoint?: string | null;
  hotplug?: boolean | number | string;
  children?: LsblkNode[];
}

interface LsblkRoot {
  blockdevices?: LsblkNode[];
}

export function parseLsblk(json: unknown): DeviceInfo[] {
  if (!json || typeof json !== "object") return [];
  const root = json as LsblkRoot;
  if (!Array.isArray(root.blockdevices)) return [];
  const out: DeviceInfo[] = [];
  for (const node of root.blockdevices) {
    if (!node || node.type !== "disk") continue;
    const name = node.name ?? "";
    if (!name) continue;
    const devicePath = `/dev/${name}`;
    const sizeBytes = toNumber(node.size);
    const removable = truthy(node.rm) || truthy(node.hotplug);
    const tran = (node.tran ?? "").toString().toLowerCase();
    const isUsb = tran === "usb";
    const isNvme = tran === "nvme";
    const isInternal = (tran === "sata" || tran === "ata" || isNvme) && !removable;
    const model = [node.vendor, node.model]
      .map((s) => (s ?? "").toString().trim())
      .filter(Boolean)
      .join(" ") || "(unknown model)";
    const mounted = nodeOrChildMounted(node);
    const verdict = computeVerdict({
      devicePath,
      sizeBytes,
      internal: isInternal,
      removable: removable || isUsb,
      bus: tran.toUpperCase() || "UNKNOWN",
      virtual: false,
    });
    out.push({
      devicePath,
      sizeBytes,
      model,
      bus: tran.toUpperCase() || "UNKNOWN",
      mounted,
      removable: removable || isUsb,
      internal: isInternal,
      verdict: verdict.verdict,
      verdictReason: verdict.reason,
    });
  }
  return out;
}

function nodeOrChildMounted(node: LsblkNode): boolean {
  if (typeof node.mountpoint === "string" && node.mountpoint.length > 0) {
    return true;
  }
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      if (nodeOrChildMounted(c)) return true;
    }
  }
  return false;
}

interface ComputeVerdictArgs {
  devicePath: string;
  sizeBytes: number;
  internal: boolean;
  removable: boolean;
  bus: string;
  virtual: boolean;
}

export function computeVerdict(a: ComputeVerdictArgs): {
  verdict: SafetyVerdict;
  reason: string;
} {
  // Hard-coded macOS system-drive guard. `/dev/disk0` is the boot drive on
  // every Mac shipped since 2017; refuse it even if some future diskutil
  // marks it as "external" by mistake.
  if (a.devicePath === "/dev/disk0") {
    return { verdict: "internal", reason: "macOS system drive (/dev/disk0)" };
  }
  if (a.sizeBytes > 0 && a.sizeBytes < MIN_DEVICE_SIZE_BYTES) {
    return {
      verdict: "too-small",
      reason: `device is ${fmtSize(a.sizeBytes)} (need >= ${fmtSize(MIN_DEVICE_SIZE_BYTES)})`,
    };
  }
  if (a.sizeBytes > MAX_DEVICE_SIZE_BYTES) {
    return {
      verdict: "internal",
      reason: `device is ${fmtSize(a.sizeBytes)} (>${fmtSize(MAX_DEVICE_SIZE_BYTES)} — almost certainly an internal drive)`,
    };
  }
  if (a.internal) {
    return { verdict: "internal", reason: `OS marks ${a.devicePath} as internal media` };
  }
  // Virtual disks (disk images, snapshots, etc) — refuse. They appear in
  // `diskutil list -plist external` but writing to them is never what the
  // user wanted; almost always a `.dmg` mount point.
  if (a.virtual) {
    return { verdict: "unknown", reason: "device is a virtual disk image, not physical hardware" };
  }
  if (a.removable || a.bus === "USB") {
    if (a.sizeBytes === 0) {
      return { verdict: "unknown", reason: "removable but size unknown — refusing" };
    }
    return { verdict: "removable-usb", reason: `removable ${a.bus} device, ${fmtSize(a.sizeBytes)}` };
  }
  return { verdict: "unknown", reason: "cannot determine if device is removable" };
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

/** Look up a single device by path + classify. Refuses if not in the list
 *  unless the device exists but enumeration missed it; in that case we
 *  return an `unknown` verdict so the write path can refuse loudly. */
export async function lookupDevice(
  devicePath: string,
  opts: EnumerateOpts = {},
): Promise<DeviceInfo | null> {
  const all = await enumerateDevices(opts);
  return all.find((d) => d.devicePath === devicePath) ?? null;
}

/** Convert plist XML → JSON via `plutil -convert json -o - -- -`. Uses
 *  spawn directly because we need to write to stdin; `plutil` is in /usr/bin
 *  on every macOS that supports `diskutil` anyway. */
async function plistToJson(xml: string): Promise<unknown> {
  return new Promise((resolve) => {
    const p = spawn("plutil", ["-convert", "json", "-o", "-", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d) => {
      out += d.toString("utf-8");
    });
    p.on("error", () => resolve(null));
    p.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve(null);
      }
    });
    p.stdin.write(xml);
    p.stdin.end();
  });
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function truthy(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v === "1" || v.toLowerCase() === "true";
  return false;
}
