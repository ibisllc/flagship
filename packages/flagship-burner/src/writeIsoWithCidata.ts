/**
 * Take a stock distro ISO + a cloud-init user-data string, produce a
 * single output ISO that:
 *   - boots the same kernel/initrd the stock ISO booted
 *   - is followed by a small FAT image labelled `CIDATA` containing
 *     `user-data` + `meta-data`, which subiquity (Ubuntu Server's
 *     autoinstall stage) reads on first boot
 *
 * The way this works in Phase 1:
 *   1. Copy the source ISO to the output path (raw bytes).
 *   2. Append a FAT12 image at the END of the output file. Most boot
 *      firmware tolerates trailing bytes past the ISO's last valid
 *      sector. Subiquity scans every block device for a partition
 *      labelled `CIDATA` regardless of whether it's part of the
 *      bootloaded ISO9660 image.
 *
 * macOS doesn't have mkfs.vfat in the base system; we shell out to
 * `hdiutil` to build the FAT image when on Darwin, and `mkfs.vfat`
 * elsewhere. The CIDATA image is small (a few KB), so copy cost is
 * dominated by the source-ISO byte-for-byte copy.
 *
 * Phase 2 will replace this with proper xorriso re-pack producing a
 * true hybrid-bootable ISO that boots from CDROM + USB + EFI. For now
 * the simpler "ISO bytes + appended FAT" suffices for `dd`-to-USB
 * which is the path the demo uses.
 */
import {
  copyFile,
  mkdir,
  rm,
  stat,
  appendFile,
  writeFile,
  readFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface WriteIsoArgs {
  srcIsoPath: string;
  outIsoPath: string;
  userDataYaml: string;
}

export async function writeIsoWithCidata(args: WriteIsoArgs): Promise<void> {
  // 1. Stat source for size sanity.
  const st = await stat(args.srcIsoPath);
  if (st.size < 1024) {
    throw new Error(`source ISO too small (${st.size}B); not an ISO`);
  }

  // 2. Copy source → output (fast cp; the OS uses copyfile/sendfile).
  await copyFile(args.srcIsoPath, args.outIsoPath);

  // 3. Build the CIDATA FAT image in a temp dir.
  const work = join(
    tmpdir(),
    `flagship-cidata-${createHash("sha256").update(args.userDataYaml).digest("hex").slice(0, 8)}`,
  );
  await mkdir(work, { recursive: true });
  const userData = join(work, "user-data");
  const metaData = join(work, "meta-data");
  await writeFile(userData, args.userDataYaml, "utf-8");
  await writeFile(metaData, `instance-id: flagship-pod\nlocal-hostname: flagship\n`, "utf-8");

  const fatImg = join(work, "cidata.img");
  await buildFatImage({ dir: work, fileNames: ["user-data", "meta-data"], outImg: fatImg, label: "CIDATA" });

  // 4. Append the FAT image to the end of the output ISO.
  const fatBytes = await readFile(fatImg);
  await appendFile(args.outIsoPath, fatBytes);

  // 5. Clean up temp.
  await rm(work, { recursive: true, force: true });
}

export interface BuildFatArgs {
  dir: string;
  fileNames: string[];
  outImg: string;
  label: string;
}

/** Build a tiny FAT12 image at `outImg` containing the given files from
 *  `dir`, with the volume label `label`. Used by both the prepare path
 *  (writes the image into an ISO file) and the write path (reads the
 *  image back as bytes and dd's them onto a raw disk after the ISO). */
export async function buildFatImage(args: BuildFatArgs): Promise<void> {
  if (platform() === "darwin") {
    // hdiutil — build a 64 KB FAT12 image, copy the files in.
    // `-fs MS-DOS` makes it FAT12/16 depending on size; small dirs end
    // up as FAT12.
    await sh(
      "hdiutil",
      [
        "create",
        "-fs",
        "MS-DOS",
        "-volname",
        args.label,
        "-size",
        "256k",
        "-layout",
        "NONE",
        "-format",
        "UDRO",
        "-srcfolder",
        args.dir,
        "-ov",
        args.outImg.replace(/\.img$/, ""),
      ],
    );
    // hdiutil may add `.dmg`; rename if needed.
    try {
      await copyFile(args.outImg.replace(/\.img$/, ".dmg"), args.outImg);
    } catch {
      // already at the expected path
    }
  } else {
    // Linux path: `mkfs.vfat` + `mcopy` from mtools. Both are usually
    // pre-installed; if not, error message tells the user what to
    // install.
    await sh("dd", ["if=/dev/zero", `of=${args.outImg}`, "bs=1k", "count=256"]);
    await sh("mkfs.vfat", ["-n", args.label, args.outImg]);
    for (const name of args.fileNames) {
      await sh("mcopy", ["-i", args.outImg, join(args.dir, name), `::${name}`]);
    }
  }
}

function sh(cmd: string, argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: "inherit" });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}`));
    });
  });
}
