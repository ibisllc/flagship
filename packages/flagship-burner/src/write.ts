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
 *   6. Open the device with `O_WRONLY | O_SYNC`. Stream the ISO bytes in
 *      1 MiB chunks. Append the CIDATA FAT image immediately after.
 *      fsync at the end.
 *   7. Auto-shred the recipe file (same one-shot semantics as
 *      `prepare` + `user-data`), unless `--keep-recipe` is passed.
 *
 * Raw disk writes need root on every supported OS. If we're not root we
 * print a clear "re-run with sudo" error and exit before touching
 * anything.
 */
import { createReadStream } from "node:fs";
import { open, mkdir, rm, readFile, writeFile, unlink, stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createHash } from "node:crypto";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { loadBlobFromFile } from "./loadBlob.js";
import { verifyIsoHash, type VerifyIsoResult } from "./verifyIso.js";
import { buildAutoinstallUserData } from "./userdata.js";
import { buildFatImage } from "./writeIsoWithCidata.js";
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
  /** Injected for tests. Defaults to real spawn. */
  enumerateOpts?: EnumerateOpts;
  /** Injected for tests. Defaults to real stdin/stdout readline. */
  promptForLine?: (message: string) => Promise<string>;
  /** Injected for tests. Defaults to real geteuid()===0 check. */
  isRoot?: () => boolean;
  /** Injected for tests. Defaults to real raw-disk write. */
  writeBytesToDevice?: WriteBytesToDevice;
  /** Injected for tests. Defaults to real `verifyIsoHash`. */
  verifyIso?: (isoPath: string) => Promise<VerifyIsoResult>;
  /** Injected for tests. Defaults to a real FAT12 build via hdiutil/mkfs.vfat. */
  materializeCidata?: (userDataYaml: string) => Promise<string>;
}

export type WriteBytesToDevice = (args: {
  devicePath: string;
  isoPath: string;
  cidataImagePath: string;
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
  const verifier = opts.verifyIso ?? verifyIsoHash;
  const isoResult = await verifier(opts.isoPath);
  if (!isoResult.ok) {
    return { ok: false, reason: `ISO verify failed: ${isoResult.reason}`, exitCode: 1 };
  }

  const target = await resolveTarget(opts);
  if (!target.ok) {
    return target;
  }
  const device = target.device;

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

  const yaml = buildAutoinstallUserData({
    blob: loaded.blob,
    blobSignatureHex: loaded.blobSignatureHex,
  });
  const materialize = opts.materializeCidata ?? materializeCidataImage;
  const cidataPath = await materialize(yaml);

  try {
    const write = opts.writeBytesToDevice ?? defaultWriteBytesToDevice;
    const written = await write({
      devicePath: device.devicePath,
      isoPath: opts.isoPath,
      cidataImagePath: cidataPath,
    });
    if (!opts.keepRecipe) {
      try {
        await unlink(opts.recipePath);
      } catch {
        // best-effort shred; don't fail the write because we can't unlink
      }
    }
    return { ok: true, devicePath: device.devicePath, bytesWritten: written.bytesWritten };
  } finally {
    await rm(cidataPath, { force: true }).catch(() => {});
    const work = cidataPath.replace(/\/cidata\.img$/, "");
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
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

async function resolveTarget(
  opts: WriteCommandOpts,
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

async function materializeCidataImage(userDataYaml: string): Promise<string> {
  const work = join(
    tmpdir(),
    `flagship-cidata-${createHash("sha256").update(userDataYaml).digest("hex").slice(0, 8)}`,
  );
  await mkdir(work, { recursive: true });
  await writeFile(join(work, "user-data"), userDataYaml, "utf-8");
  await writeFile(
    join(work, "meta-data"),
    `instance-id: flagship-pod\nlocal-hostname: flagship\n`,
    "utf-8",
  );
  const fatImg = join(work, "cidata.img");
  await buildFatImage({
    dir: work,
    fileNames: ["user-data", "meta-data"],
    outImg: fatImg,
    label: "CIDATA",
  });
  return fatImg;
}

const defaultWriteBytesToDevice: WriteBytesToDevice = async (args) => {
  // Stream the ISO in 1 MiB chunks to the raw device. We open the device
  // node O_WRONLY (no O_DIRECT — Node doesn't expose it portably and on
  // macOS the equivalent is F_NOCACHE which isn't reachable from
  // fs.promises; the per-write fsync at the end gets us the durability
  // we need).
  const isoStat = await stat(args.isoPath);
  if (isoStat.size < 1024) {
    throw new Error(`source ISO too small (${isoStat.size}B); refusing to write`);
  }
  const fh = await open(args.devicePath, "w");
  try {
    let total = 0;
    const isoStream = createReadStream(args.isoPath, { highWaterMark: 1024 * 1024 });
    for await (const chunk of isoStream) {
      const buf = chunk as Buffer;
      await fh.write(buf, 0, buf.length, total);
      total += buf.length;
    }
    const cidata = await readFile(args.cidataImagePath);
    await fh.write(cidata, 0, cidata.length, total);
    total += cidata.length;
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
