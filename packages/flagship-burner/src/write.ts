/**
 * `flagship-burn write` — raw-disk write of a personalized Flagship ISO
 * onto a USB target.
 *
 * Flow:
 *   1. Verify the recipe (same loadBlobFromFile + sig check the other
 *      subcommands run). Refuse expired / forged / malformed.
 *   2. Verify the ISO against the pinned-distros allowlist (sha256).
 *   3. Resolve the target device — either a `--device /dev/diskN` flag
 *      (with explicit safety-classification), or the interactive picker.
 *   4. Refuse anything classified `internal`, `too-small`, or `unknown`.
 *      Defense in depth: macOS `/dev/disk0` is hard-coded refused; size
 *      <500MB or >500GB is refused regardless of metadata.
 *   5. Prompt for a typed "yes" (unless `--yes` is passed). The prompt
 *      shows the device path, size, model, mount state.
 *   6. Remaster the source ISO into an unattended autoinstall ISO (seed
 *      baked in at /nocloud/ + `autoinstall` kernel cmdline). Stream the
 *      remastered ISO to the device in 1 MiB chunks; fsync at the end.
 *   7. Auto-shred the recipe file (same one-shot semantics as
 *      `prepare` + `user-data`), unless `--keep-recipe` is passed.
 *
 * Raw disk writes need root on every supported OS. If we're not root we
 * print a clear "re-run with sudo" error and exit before touching
 * anything.
 */
import { createReadStream } from "node:fs";
import { open, rm, unlink, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createHash } from "node:crypto";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { loadBlobFromFile } from "./loadBlob.js";
import { buildAutoinstallUserData } from "./userdata.js";
import { buildDebianPreseed } from "./preseed.js";
import {
  remasterIsoWithInstaller,
  detectIsoFamily,
  type IsoFamily,
} from "./remasterIso.js";
import {
  enumerateDevices,
  lookupDevice,
  fmtSize,
  type DeviceInfo,
  type EnumerateOpts,
} from "./devices.js";

export interface WriteCommandOpts {
  recipePath: string;
  isoPath: string;
  /** `/dev/diskN`, "auto" (single removable USB), or undefined (picker). */
  device?: string;
  /** Skip the typed-yes prompt. Required when `--device auto` is set. */
  yes?: boolean;
  /** Don't auto-shred the recipe after a successful write. */
  keepRecipe?: boolean;
  /** LUKS-encrypted root, the locked DEFAULT. false = internal debug escape only. See userdata.ts. */
  encryptRoot?: boolean;
  /** Optional Wi-Fi for a box with no Ethernet (burn-time local input). See userdata.ts. */
  wifiSSID?: string;
  wifiPassword?: string;
  /** Injected for tests. Defaults to real spawn. */
  enumerateOpts?: EnumerateOpts;
  /** Injected for tests. Defaults to real stdin/stdout readline. */
  promptForLine?: (message: string) => Promise<string>;
  /** Injected for tests. Defaults to real geteuid()===0 check. */
  isRoot?: () => boolean;
  /** Injected for tests. Defaults to real raw-disk write. */
  writeBytesToDevice?: WriteBytesToDevice;
  /** Force a family instead of detecting from the ISO (tests / overrides). */
  family?: IsoFamily;
  /** Injected for tests. Defaults to detectIsoFamily (reads the ISO). */
  detectFamily?: (srcIsoPath: string) => Promise<IsoFamily>;
  /**
   * Injected for tests. Defaults to the family-aware xorriso remaster. Receives
   * both configs + the resolved family; the real impl bakes the preseed (Debian)
   * or the NoCloud seed (Ubuntu) accordingly.
   */
  remaster?: (args: {
    srcIsoPath: string;
    outIsoPath: string;
    userDataYaml: string;
    preseedCfg: string;
    family: IsoFamily;
  }) => Promise<void>;
}

export type WriteBytesToDevice = (args: {
  devicePath: string;
  isoPath: string;
}) => Promise<{ bytesWritten: number }>;

export type WriteCommandResult =
  | { ok: true; devicePath: string; bytesWritten: number }
  | { ok: false; reason: string; exitCode: number };

export async function runWriteCommand(opts: WriteCommandOpts): Promise<WriteCommandResult> {
  const isRoot = opts.isRoot ?? defaultIsRoot;
  const os = opts.enumerateOpts?.os ?? platform();
  if (os !== "darwin" && os !== "linux") {
    return {
      ok: false,
      reason: `unsupported platform: ${os} (write is Phase-2 macOS/Linux only)`,
      exitCode: 2,
    };
  }
  if (!isRoot()) {
    return {
      ok: false,
      reason:
        "raw-disk write requires root. Re-run with: sudo node packages/flagship-burner/src/cli.js write ...",
      exitCode: 13,
    };
  }

  let loaded;
  try {
    loaded = await loadBlobFromFile(opts.recipePath);
  } catch (e) {
    return { ok: false, reason: `load recipe failed: ${(e as Error).message}`, exitCode: 1 };
  }

  const target = await resolveTarget(opts);
  if (!target.ok) {
    return target;
  }
  const device = target.device;

  const confirmed = await confirmTarget(opts, device);
  if (!confirmed.ok) {
    return confirmed;
  }

  // Detect Ubuntu (subiquity autoinstall) vs Debian (d-i preseed) so we bake
  // the right unattended mechanism. Both configs embed the SAME signed recipe +
  // run the SAME first-boot bootstrap; only the installer wrapper differs.
  const detectFamily = opts.detectFamily ?? ((p: string) => detectIsoFamily(p));
  const family = opts.family ?? (await detectFamily(opts.isoPath));
  const genOpts = {
    blob: loaded.blob,
    blobSignatureHex: loaded.blobSignatureHex,
    encryptRoot: opts.encryptRoot !== false,
    wifiSSID: opts.wifiSSID,
    wifiPassword: opts.wifiPassword,
    // Carry the UNSIGNED recipe siblings into install-blob.json — the direct
    // `write` path dropped these (the GUI's prepare path threads them). Absent
    // ⇒ byte-identical.
    pairingOrder: loaded.pairingOrder,
    swkHex: loaded.swkHex,
    debugGrant: loaded.debugGrant,
  };
  const yaml = buildAutoinstallUserData(genOpts);
  const preseedCfg = buildDebianPreseed(genOpts);
  const activeConfig = family === "debian" ? preseedCfg : yaml;
  const remaster =
    opts.remaster ??
    ((a: {
      srcIsoPath: string;
      outIsoPath: string;
      userDataYaml: string;
      preseedCfg: string;
      family: IsoFamily;
    }) =>
      remasterIsoWithInstaller({
        srcIsoPath: a.srcIsoPath,
        outIsoPath: a.outIsoPath,
        userDataYaml: a.userDataYaml,
        preseedCfg: a.preseedCfg,
        family: a.family,
      }).then(() => undefined));
  const remasteredIso = join(
    tmpdir(),
    `flagship-remastered-${createHash("sha256")
      .update(opts.isoPath + activeConfig)
      .digest("hex")
      .slice(0, 12)}.iso`,
  );

  try {
    // Progress is reported on stdout as machine-readable control lines the
    // GUI parses (and filters out of the visible log):
    //   FLAGSHIP_PHASE:remaster|write   — coarse phase, drives the label
    //   FLAGSHIP_PROGRESS:<0..1>        — fraction of the byte-write
    console.log("FLAGSHIP_PHASE:remaster");
    await remaster({
      srcIsoPath: opts.isoPath,
      outIsoPath: remasteredIso,
      userDataYaml: yaml,
      preseedCfg,
      family,
    });
    console.log("FLAGSHIP_PHASE:write");
    const write = opts.writeBytesToDevice ?? defaultWriteBytesToDevice;
    const written = await write({
      devicePath: device.devicePath,
      isoPath: remasteredIso,
    });
    console.log("FLAGSHIP_PROGRESS:1");
    if (!opts.keepRecipe) {
      try {
        await unlink(opts.recipePath);
      } catch {
        // best-effort shred; don't fail the write because we can't unlink
      }
    }
    return { ok: true, devicePath: device.devicePath, bytesWritten: written.bytesWritten };
  } finally {
    await rm(remasteredIso, { force: true }).catch(() => {});
  }
}

export interface WriteImageCommandOpts {
  /** A prepared (already-remastered) ISO, written to the device verbatim. */
  imagePath: string;
  device?: string;
  yes?: boolean;
  enumerateOpts?: EnumerateOpts;
  promptForLine?: (message: string) => Promise<string>;
  isRoot?: () => boolean;
  writeBytesToDevice?: WriteBytesToDevice;
}

/**
 * Write an already-prepared image to a USB device — the privileged half of
 * the GUI flow. The remaster (which reads the recipe + source ISO, often
 * from a TCC-protected folder like ~/Downloads) runs UNPRIVILEGED via
 * `prepare`; only this raw-device write needs root, and it reads the
 * prepared image from a non-protected temp path, so the root process never
 * touches a protected folder.
 */
export async function runWriteImageCommand(
  opts: WriteImageCommandOpts,
): Promise<WriteCommandResult> {
  const isRoot = opts.isRoot ?? defaultIsRoot;
  const os = opts.enumerateOpts?.os ?? platform();
  if (os !== "darwin" && os !== "linux") {
    return { ok: false, reason: `unsupported platform: ${os}`, exitCode: 2 };
  }
  if (!isRoot()) {
    return { ok: false, reason: "raw-disk write requires root. Re-run with sudo.", exitCode: 13 };
  }
  let st;
  try {
    st = await stat(opts.imagePath);
  } catch {
    return { ok: false, reason: `cannot read image: ${opts.imagePath}`, exitCode: 1 };
  }
  if (st.size < 1024) {
    return { ok: false, reason: `image too small (${st.size}B); refusing`, exitCode: 1 };
  }

  const target = await resolveTarget(opts);
  if (!target.ok) return target;
  const device = target.device;

  const confirmed = await confirmTarget(opts, device);
  if (!confirmed.ok) return confirmed;

  console.log("FLAGSHIP_PHASE:write");
  const write = opts.writeBytesToDevice ?? defaultWriteBytesToDevice;
  const written = await write({ devicePath: device.devicePath, isoPath: opts.imagePath });
  console.log("FLAGSHIP_PROGRESS:1");
  return { ok: true, devicePath: device.devicePath, bytesWritten: written.bytesWritten };
}

interface TargetResult {
  ok: true;
  device: DeviceInfo;
}
interface TargetFailure {
  ok: false;
  reason: string;
  exitCode: number;
}

/** Fields both `write` and `write-image` need to pick + confirm a target. */
interface TargetOpts {
  device?: string;
  yes?: boolean;
  enumerateOpts?: EnumerateOpts;
  promptForLine?: (message: string) => Promise<string>;
}

/** Typed-yes / interactive confirmation, shared by write + write-image. */
async function confirmTarget(
  opts: TargetOpts,
  device: DeviceInfo,
): Promise<TargetResult | TargetFailure> {
  const promptForLine = opts.promptForLine ?? defaultPromptForLine;
  if (!opts.yes) {
    console.log("");
    console.log("About to WRITE to this device — all data on it will be DESTROYED:");
    console.log(`  ${device.devicePath}  (${fmtSize(device.sizeBytes)})`);
    console.log(`  model:  ${device.model}`);
    console.log(`  bus:    ${device.bus}`);
    console.log(`  mounted: ${device.mounted ? "YES (will be unmounted)" : "no"}`);
    console.log(`  verdict: ${device.verdict} — ${device.verdictReason}`);
    console.log("");
    const answer = await promptForLine('Type "yes" to confirm: ');
    if (answer.trim().toLowerCase() !== "yes") {
      return { ok: false, reason: "user declined", exitCode: 130 };
    }
  } else if (device.verdict !== "removable-usb") {
    return {
      ok: false,
      reason:
        `--yes refused: device verdict is "${device.verdict}" (${device.verdictReason}). ` +
        `--yes only auto-confirms removable-usb targets.`,
      exitCode: 1,
    };
  }
  return { ok: true, device };
}

async function resolveTarget(
  opts: TargetOpts,
): Promise<TargetResult | TargetFailure> {
  const devSpec = opts.device;
  const enumerateOpts = opts.enumerateOpts ?? {};
  if (devSpec && devSpec !== "auto") {
    if (!/^\/dev\/[A-Za-z0-9_/-]+$/.test(devSpec)) {
      return { ok: false, reason: `--device must be an absolute /dev path, got: ${devSpec}`, exitCode: 2 };
    }
    const info = await lookupDevice(devSpec, enumerateOpts);
    if (!info) {
      return {
        ok: false,
        reason: `${devSpec} not present in removable-device enumeration. Refusing write.`,
        exitCode: 1,
      };
    }
    if (info.verdict !== "removable-usb") {
      return {
        ok: false,
        reason: `${devSpec} classified "${info.verdict}": ${info.verdictReason}. Refusing.`,
        exitCode: 1,
      };
    }
    return { ok: true, device: info };
  }
  const all = await enumerateDevices(enumerateOpts);
  const eligible = all.filter((d) => d.verdict === "removable-usb");
  if (devSpec === "auto") {
    if (eligible.length === 0) {
      return { ok: false, reason: "auto: no removable-usb device found", exitCode: 1 };
    }
    if (eligible.length > 1) {
      return {
        ok: false,
        reason: `auto: ${eligible.length} removable-usb devices found; pass --device /dev/diskN explicitly`,
        exitCode: 1,
      };
    }
    return { ok: true, device: eligible[0]! };
  }
  if (eligible.length === 0) {
    console.log("No removable-USB devices found. Plug one in and retry, or pass --device /dev/diskN.");
    if (all.length > 0) {
      console.log("");
      console.log("Refused candidates (not safe to write):");
      for (const d of all) {
        console.log(`  ${d.devicePath}  ${fmtSize(d.sizeBytes)}  ${d.verdict}  — ${d.verdictReason}`);
      }
    }
    return { ok: false, reason: "no eligible removable-usb devices", exitCode: 1 };
  }
  const promptForLine = opts.promptForLine ?? defaultPromptForLine;
  console.log("");
  console.log("Available removable USB devices:");
  for (let i = 0; i < eligible.length; i++) {
    const d = eligible[i]!;
    console.log(
      `  [${i + 1}]  ${d.devicePath}  ${fmtSize(d.sizeBytes)}  ${d.model}  (${d.bus})${d.mounted ? "  [mounted]" : ""}`,
    );
  }
  const answer = await promptForLine(`Pick a device [1-${eligible.length}]: `);
  const idx = Number.parseInt(answer.trim(), 10) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= eligible.length) {
    return { ok: false, reason: "invalid picker selection", exitCode: 130 };
  }
  return { ok: true, device: eligible[idx]! };
}

const defaultWriteBytesToDevice: WriteBytesToDevice = async (args) => {
  // Stream the (already-remastered) ISO in 1 MiB chunks to the raw device.
  // We open the device node O_WRONLY (no O_DIRECT — Node doesn't expose it
  // portably and on macOS the equivalent is F_NOCACHE which isn't reachable
  // from fs.promises; the per-write fsync at the end gets us the durability
  // we need). The autoinstall seed is baked inside the ISO, so this is a
  // plain image write — no trailing partition to append.
  const isoStat = await stat(args.isoPath);
  if (isoStat.size < 1024) {
    throw new Error(`source ISO too small (${isoStat.size}B); refusing to write`);
  }

  // Prepare the device. A mounted disk can't be opened for raw write
  // (EPERM/EBUSY), so unmount its volumes first. On macOS, also target the
  // raw character device /dev/rdiskN — far faster than the buffered
  // /dev/diskN, and the conventional `dd` target. The ISO is a multiple of
  // the 2048-byte ISO sector, so our 1 MiB chunks stay block-aligned.
  let target = args.devicePath;
  if (platform() === "darwin") {
    await runCmd("diskutil", ["unmountDisk", args.devicePath]);
    target = args.devicePath.replace(/^\/dev\/disk/, "/dev/rdisk");
  } else if (platform() === "linux") {
    // Best-effort: unmount any mounted partitions of the target device.
    await runCmd("sh", [
      "-c",
      `for p in ${args.devicePath}*; do umount "$p" 2>/dev/null || true; done`,
    ]).catch(() => {});
  }

  let fh;
  try {
    fh = await open(target, "w");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      throw new Error(
        `macOS blocked raw disk access to ${target} (${code}). The process needs Full Disk ` +
          `Access — grant it to the terminal/app you're running from (System Settings → Privacy ` +
          `& Security → Full Disk Access), then retry. Note: an app that escalates via ` +
          `osascript "administrator privileges" runs under the system auth trampoline, which ` +
          `cannot be granted Full Disk Access — run the burn from a Full-Disk-Access terminal.`,
      );
    }
    throw e;
  }
  try {
    let total = 0;
    let lastPct = -1;
    const size = isoStat.size;
    const isoStream = createReadStream(args.isoPath, { highWaterMark: 1024 * 1024 });
    for await (const chunk of isoStream) {
      const buf = chunk as Buffer;
      await fh.write(buf, 0, buf.length, total);
      total += buf.length;
      // Emit at most once per whole percent to keep the log readable.
      const pct = Math.floor((total / size) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        console.log(`FLAGSHIP_PROGRESS:${(total / size).toFixed(4)}`);
      }
    }
    await fh.sync();
    return { bytesWritten: total };
  } finally {
    await fh.close();
  }
};

function defaultIsRoot(): boolean {
  // process.geteuid is undefined on Windows; we already gate on platform
  // above so on darwin/linux this is always defined.
  const g = (process as unknown as { geteuid?: () => number }).geteuid;
  return typeof g === "function" && g() === 0;
}

async function defaultPromptForLine(message: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(message);
  } finally {
    rl.close();
  }
}

/** Run a command, rejecting (with captured stderr) on a non-zero exit. */
function runCmd(cmd: string, argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr?.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} ${argv.join(" ")} exited ${code}: ${err.trim()}`)),
    );
  });
}
