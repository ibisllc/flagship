/**
 * Remaster a stock Ubuntu Server ISO into an unattended autoinstall ISO.
 *
 * Why not "append a CIDATA FAT image after the ISO" (the old approach)?
 * cloud-init's NoCloud datasource discovers its seed via `blkid`, which
 * only sees filesystems the kernel exposes as partitions. Trailing bytes
 * past the ISO with no GPT/MBR entry are invisible — so the seed is never
 * found and the installer drops to interactive mode.
 *
 * Instead we bake the seed *inside* the ISO9660 image at `/nocloud/` and
 * tell the kernel to read it from the install media (mounted at /cdrom):
 *
 *     autoinstall ds=nocloud;s=/cdrom/nocloud/
 *
 * `autoinstall` on the cmdline also suppresses subiquity's "are you sure?"
 * confirmation, so the install is fully unattended. This is the method
 * documented by Canonical for custom autoinstall media.
 *
 * xorriso's `-boot_image any replay` reproduces the source ISO's El Torito
 * catalog AND isohybrid MBR/GPT in the output, so the result is a true
 * hybrid image: `dd` it to USB and it boots on both BIOS and UEFI.
 */
import { mkdir, rm, writeFile, readFile, stat, chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface RemasterArgs {
  srcIsoPath: string;
  outIsoPath: string;
  userDataYaml: string;
  /** Override for tests / non-standard installs. Defaults to a PATH scan. */
  xorrisoPath?: string;
}

const XORRISO_CANDIDATES = [
  "/opt/homebrew/bin/xorriso",
  "/usr/local/bin/xorriso",
  "/usr/bin/xorriso",
];

export async function resolveXorriso(override?: string): Promise<string> {
  if (override) return override;
  for (const c of XORRISO_CANDIDATES) {
    try {
      await stat(c);
      return c;
    } catch {
      // keep looking
    }
  }
  // Fall back to bare name — spawn will surface ENOENT with a clear hint.
  return "xorriso";
}

/**
 * Insert the autoinstall kernel cmdline into every GRUB boot entry that
 * loads the casper kernel, and shorten the menu timeout so the install
 * entry boots without a 30s wait.
 *
 * Pure string transform — unit-tested without touching a real ISO.
 */
export function editGrubCfgForAutoinstall(cfg: string): string {
  const SEED = "autoinstall ds=nocloud\\;s=/cdrom/nocloud/";
  const lines = cfg.split("\n").map((line) => {
    // The kernel line looks like:  linux /casper/vmlinuz quiet ---
    // (leading whitespace varies). Only touch lines that load the
    // installer kernel, and never double-insert.
    if (/^\s*linux\b/.test(line) && /\/casper\/vmlinuz/.test(line)) {
      if (line.includes("autoinstall")) return line;
      return line.replace(/(\/casper\/vmlinuz\S*)/, `$1 ${SEED}`);
    }
    return line;
  });
  let out = lines.join("\n");
  // Boot the autoinstall entry promptly. Replace any timeout, else prepend.
  if (/set\s+timeout=\d+/.test(out)) {
    out = out.replace(/set\s+timeout=\d+/g, "set timeout=1");
  } else {
    out = `set timeout=1\n${out}`;
  }
  return out;
}

function sh(cmd: string, argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr?.on("data", (d) => (stderr += d.toString()));
    p.on("error", (e) => {
      const hint =
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? ` (is xorriso installed? 'brew install xorriso' / 'apt install xorriso')`
          : "";
      reject(new Error(`${cmd} failed: ${(e as Error).message}${hint}`));
    });
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}\n${stderr.trim()}`));
    });
  });
}

/**
 * Build a NoCloud seed dir (user-data + meta-data + empty vendor-data).
 * Returns the seed directory path.
 */
export async function buildNocloudSeed(
  workDir: string,
  userDataYaml: string,
): Promise<string> {
  const seed = join(workDir, "nocloud");
  await mkdir(seed, { recursive: true });
  await writeFile(join(seed, "user-data"), userDataYaml, "utf-8");
  await writeFile(
    join(seed, "meta-data"),
    "instance-id: flagship-pod\nlocal-hostname: flagship\n",
    "utf-8",
  );
  // vendor-data must exist (even if empty) or some cloud-init versions log
  // a noisy 404; an empty file is the documented inert default.
  await writeFile(join(seed, "vendor-data"), "", "utf-8");
  return seed;
}

export async function remasterIsoWithAutoinstall(args: RemasterArgs): Promise<void> {
  const st = await stat(args.srcIsoPath);
  if (st.size < 1024) {
    throw new Error(`source ISO too small (${st.size}B); not an ISO`);
  }
  const xorriso = await resolveXorriso(args.xorrisoPath);
  const work = join(
    tmpdir(),
    `flagship-remaster-${createHash("sha256")
      .update(args.srcIsoPath + args.userDataYaml)
      .digest("hex")
      .slice(0, 12)}`,
  );
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  try {
    // 1. Extract the GRUB config from the source ISO.
    const grubOut = join(work, "grub.cfg");
    await sh(xorriso, [
      "-osirrox",
      "on",
      "-indev",
      args.srcIsoPath,
      "-extract",
      "/boot/grub/grub.cfg",
      grubOut,
    ]);
    // osirrox preserves the file's ISO mode, and grub.cfg ships read-only
    // (0444) on the Ubuntu image — so make our copy writable before we
    // rewrite it, or the open-for-write below fails with EACCES.
    await chmod(grubOut, 0o644);

    // 2. Patch it for unattended autoinstall.
    const patched = editGrubCfgForAutoinstall(await readFile(grubOut, "utf-8"));
    await writeFile(grubOut, patched, "utf-8");

    // 3. Build the NoCloud seed directory.
    const seed = await buildNocloudSeed(work, args.userDataYaml);

    // 4. Repack: replay the boot equipment, then overlay our seed + grub.
    await sh(xorriso, [
      "-indev",
      args.srcIsoPath,
      "-outdev",
      args.outIsoPath,
      "-boot_image",
      "any",
      "replay",
      "-map",
      seed,
      "/nocloud",
      "-map",
      grubOut,
      "/boot/grub/grub.cfg",
    ]);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
