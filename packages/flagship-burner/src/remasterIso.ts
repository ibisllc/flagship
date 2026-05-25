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

/** The installer family an ISO carries. */
export type IsoFamily = "ubuntu" | "debian";

export interface RemasterPreseedArgs {
  srcIsoPath: string;
  outIsoPath: string;
  /** The d-i preseed.cfg text (from preseed.ts buildDebianPreseed). */
  preseedCfg: string;
  /** Override for tests / non-standard installs. Defaults to a PATH scan. */
  xorrisoPath?: string;
}

export interface RemasterInstallerArgs {
  srcIsoPath: string;
  outIsoPath: string;
  /**
   * The unattended-install config. For an Ubuntu ISO this is the cloud-init
   * user-data; for a Debian ISO it is the d-i preseed.cfg. The caller usually
   * generates the right one for the detected family (or passes both and lets
   * the dispatcher pick — see remasterIsoForRecipe in the CLI).
   */
  userDataYaml?: string;
  preseedCfg?: string;
  /** Force a family instead of detecting from the ISO (tests / overrides). */
  family?: IsoFamily;
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

/**
 * The d-i kernel cmdline that drives a fully-unattended preseed install from
 * a preseed.cfg placed at the ISO root (mounted at /cdrom during install):
 *   - `auto=true priority=critical` suppresses every prompt at priority<critical
 *   - `preseed/file=/cdrom/preseed.cfg` points d-i at our config
 * The CD is already mounted at /cdrom by the time the preseed is read, so the
 * file method is reliable for the standard (text) installer entry — no initrd
 * repack needed (which keeps this inside the same `-map` + `replay` flow the
 * Ubuntu path uses). https://wiki.debian.org/DebianInstaller/Preseed
 */
export const DEBIAN_PRESEED_CMDLINE =
  "auto=true priority=critical preseed/file=/cdrom/preseed.cfg";

/** Does a kernel cmdline already carry our preseed file param? */
function hasPreseedFile(line: string): boolean {
  return line.includes("preseed/file=/cdrom/preseed.cfg");
}

/**
 * Patch a Debian netinst UEFI grub.cfg for unattended preseed. d-i grub.cfg
 * `linux` lines load `/install.amd/...vmlinuz` (text + gtk variants); append the
 * preseed cmdline to every installer kernel line (whichever entry the firmware
 * picks then auto-installs) and drop the menu timeout. Pure transform.
 */
export function editGrubCfgForPreseed(cfg: string): string {
  const lines = cfg.split("\n").map((line) => {
    if (
      /^\s*linux\b/.test(line) &&
      /\/install(\.amd)?\/(gtk\/)?(vmlinuz|linux)/.test(line)
    ) {
      if (hasPreseedFile(line)) return line;
      // Insert the params right after the kernel path token. Debian's `---`
      // separates installer args from kernel args; keep ours before any `---`.
      return line.replace(
        /(linux\s+\/install(?:\.amd)?\/(?:gtk\/)?(?:vmlinuz|linux)\S*)/,
        `$1 ${DEBIAN_PRESEED_CMDLINE}`,
      );
    }
    return line;
  });
  let out = lines.join("\n");
  if (/set\s+timeout=\d+/.test(out)) {
    out = out.replace(/set\s+timeout=\d+/g, "set timeout=1");
  } else {
    out = `set timeout=1\n${out}`;
  }
  // If grub has a hidden-menu style, make sure it doesn't wait either.
  out = out.replace(/set\s+timeout_style=\w+/g, "set timeout_style=menu");
  return out;
}

/**
 * Patch a Debian netinst BIOS isolinux/syslinux config (isolinux.cfg / txt.cfg /
 * gtk.cfg) for unattended preseed. These use `append ... initrd=.../initrd.gz`
 * lines; insert the preseed cmdline after the `initrd=` token on every installer
 * entry, and force the menu timeout to ~0. Pure transform.
 */
export function editIsolinuxCfgForPreseed(cfg: string): string {
  const lines = cfg.split("\n").map((line) => {
    if (/^\s*append\b/.test(line) && /initrd=\S*initrd\.gz/.test(line)) {
      if (hasPreseedFile(line)) return line;
      return line.replace(
        /(initrd=\S*initrd\.gz)/,
        `$1 ${DEBIAN_PRESEED_CMDLINE}`,
      );
    }
    return line;
  });
  let out = lines.join("\n");
  // syslinux timeout is in 1/10s units; 1 == 0.1s. 0 would wait forever.
  if (/^\s*timeout\s+\d+/m.test(out)) {
    out = out.replace(/^(\s*timeout\s+)\d+/gm, "$11");
  } else {
    out = `timeout 1\n${out}`;
  }
  // Default to the auto-install label if a prompt would otherwise show.
  out = out.replace(/^\s*prompt\s+\d+/gm, "prompt 0");
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
    //    Clear a stale output first — xorriso refuses to write when -indev
    //    differs from -outdev and the outdev already holds data.
    await rm(args.outIsoPath, { force: true }).catch(() => {});
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

/**
 * Classify the volume-descriptor / ISO contents text as ubuntu vs debian.
 * Pure (no I/O) so it's unit-testable: feed it the volume id or a directory
 * listing. Debian wins on an explicit "debian" marker OR the d-i kernel tree
 * (/install.amd, /d-i); Ubuntu on "ubuntu"/casper. Defaults to ubuntu (the
 * original, proven path) when ambiguous — the burn never refuses an ISO, it
 * just picks the most-likely-correct unattended mechanism.
 */
export function classifyIsoText(text: string): IsoFamily {
  const t = text.toLowerCase();
  // Strong, specific markers first.
  if (/\binstall\.amd\b|\/d-i\/|debian-installer|\bdebian\b/.test(t)) {
    // …unless it ALSO looks like Ubuntu (Ubuntu derives from Debian, but its
    // live-server ISO is subiquity/casper — treat casper as the decider).
    if (/\bcasper\b|\bubuntu\b/.test(t) && !/\binstall\.amd\b|\/d-i\//.test(t)) {
      return "ubuntu";
    }
    return "debian";
  }
  if (/\bubuntu\b|\bcasper\b|subiquity/.test(t)) return "ubuntu";
  return "ubuntu";
}

/**
 * Detect whether a source ISO is an Ubuntu (subiquity) or Debian (d-i) image.
 * Reads the ISO volume id; if that's inconclusive, peeks at the boot config
 * tree (Debian has /install.amd, Ubuntu has /casper). Defaults to "ubuntu".
 */
export async function detectIsoFamily(
  srcIsoPath: string,
  xorrisoPath?: string,
): Promise<IsoFamily> {
  const xorriso = await resolveXorriso(xorrisoPath);
  // 1. Volume id (cheap, usually decisive: "Debian 13.5.0 amd64 1" vs
  //    "Ubuntu-Server 22.04.5 LTS amd64").
  let volid = "";
  try {
    volid = await shCapture(xorriso, ["-indev", srcIsoPath, "-toc"]);
  } catch {
    // fall through to the directory probe
  }
  const m = volid.match(/Volume id\s*:\s*'([^']*)'/i) ?? volid.match(/Volume id\s*:\s*(.+)/i);
  const volName = (m?.[1] ?? "").trim();
  if (/\bdebian\b/i.test(volName)) return "debian";
  if (/\bubuntu\b/i.test(volName)) return "ubuntu";
  // 2. Directory probe — list the root + boot tree and classify the listing.
  try {
    const listing = await shCapture(xorriso, [
      "-indev",
      srcIsoPath,
      "-find",
      "/",
      "-maxdepth",
      "2",
      "-type",
      "d",
    ]);
    return classifyIsoText(`${volName}\n${listing}`);
  } catch {
    return classifyIsoText(volName);
  }
}

/**
 * Remaster a stock Debian netinst ISO into an unattended preseed ISO. Bakes the
 * preseed.cfg at the ISO root and patches BOTH boot paths — grub.cfg (UEFI) and
 * the isolinux/syslinux configs (BIOS) — to add the preseed cmdline + drop the
 * menu timeout. `-boot_image any replay` preserves the El Torito + isohybrid
 * MBR/GPT so the result is dd-able on BIOS and UEFI, same as the Ubuntu path.
 *
 * Note on md5sum.txt: d-i only verifies it during an explicit "Check disc"
 * step, which the unattended boot never runs — so editing files on the ISO is
 * fine (the Ubuntu path likewise doesn't regenerate any checksums).
 */
export async function remasterIsoWithPreseed(args: RemasterPreseedArgs): Promise<void> {
  const st = await stat(args.srcIsoPath);
  if (st.size < 1024) {
    throw new Error(`source ISO too small (${st.size}B); not an ISO`);
  }
  const xorriso = await resolveXorriso(args.xorrisoPath);
  const work = join(
    tmpdir(),
    `flagship-remaster-deb-${createHash("sha256")
      .update(args.srcIsoPath + args.preseedCfg)
      .digest("hex")
      .slice(0, 12)}`,
  );
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  try {
    // 1. Write the preseed.cfg we'll map to the ISO root.
    const preseedOut = join(work, "preseed.cfg");
    await writeFile(preseedOut, args.preseedCfg, "utf-8");

    // 2. Patch every boot config present. Debian netinst ships grub.cfg for
    //    UEFI and isolinux configs for BIOS; the exact set varies by release,
    //    so patch whichever exist (best-effort extract; skip missing ones).
    const mapArgs: string[] = [];
    const patchTargets: Array<{ iso: string; edit: (s: string) => string }> = [
      { iso: "/boot/grub/grub.cfg", edit: editGrubCfgForPreseed },
      { iso: "/EFI/boot/grub.cfg", edit: editGrubCfgForPreseed },
      { iso: "/isolinux/isolinux.cfg", edit: editIsolinuxCfgForPreseed },
      { iso: "/isolinux/txt.cfg", edit: editIsolinuxCfgForPreseed },
      { iso: "/isolinux/gtk.cfg", edit: editIsolinuxCfgForPreseed },
    ];
    let patchedAny = false;
    for (let i = 0; i < patchTargets.length; i++) {
      const t = patchTargets[i]!;
      const local = join(work, `bootcfg-${i}`);
      const ok = await extractOptional(xorriso, args.srcIsoPath, t.iso, local);
      if (!ok) continue;
      await chmod(local, 0o644).catch(() => {});
      await writeFile(local, t.edit(await readFile(local, "utf-8")), "utf-8");
      mapArgs.push("-map", local, t.iso);
      patchedAny = true;
    }
    if (!patchedAny) {
      throw new Error(
        "no Debian boot config found on ISO (looked for grub.cfg + isolinux/*.cfg); " +
          "is this a Debian netinst/DVD image?",
      );
    }

    // 3. Repack: replay boot equipment, overlay preseed + the patched configs.
    await rm(args.outIsoPath, { force: true }).catch(() => {});
    await sh(xorriso, [
      "-indev",
      args.srcIsoPath,
      "-outdev",
      args.outIsoPath,
      "-boot_image",
      "any",
      "replay",
      "-map",
      preseedOut,
      "/preseed.cfg",
      ...mapArgs,
    ]);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Family-aware remaster. Detects (or takes) the ISO family and routes to the
 * Ubuntu autoinstall path or the Debian preseed path, using whichever config
 * the caller supplied for that family.
 */
export async function remasterIsoWithInstaller(
  args: RemasterInstallerArgs,
): Promise<IsoFamily> {
  const family = args.family ?? (await detectIsoFamily(args.srcIsoPath, args.xorrisoPath));
  if (family === "debian") {
    if (!args.preseedCfg) {
      throw new Error("Debian ISO detected but no preseedCfg was provided");
    }
    await remasterIsoWithPreseed({
      srcIsoPath: args.srcIsoPath,
      outIsoPath: args.outIsoPath,
      preseedCfg: args.preseedCfg,
      xorrisoPath: args.xorrisoPath,
    });
    return "debian";
  }
  if (!args.userDataYaml) {
    throw new Error("Ubuntu ISO detected but no userDataYaml was provided");
  }
  await remasterIsoWithAutoinstall({
    srcIsoPath: args.srcIsoPath,
    outIsoPath: args.outIsoPath,
    userDataYaml: args.userDataYaml,
    xorrisoPath: args.xorrisoPath,
  });
  return "ubuntu";
}

/** Run a command and capture stdout (for ISO introspection). */
function shCapture(cmd: string, argv: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout?.on("data", (d) => (stdout += d.toString()));
    p.stderr?.on("data", (d) => (stderr += d.toString()));
    p.on("error", (e) => reject(new Error(`${cmd} failed: ${(e as Error).message}`)));
    p.on("close", (code) => {
      // xorriso writes its report to stderr; some builds exit non-zero on -toc
      // even when the volid is printed. Return whatever we captured.
      resolve(`${stdout}\n${stderr}`);
      void code;
    });
  });
}

/**
 * Extract a file from the ISO if present. Returns true on success, false if the
 * path doesn't exist (so callers can patch only the boot configs that ship).
 */
async function extractOptional(
  xorriso: string,
  srcIso: string,
  isoPath: string,
  outPath: string,
): Promise<boolean> {
  try {
    await sh(xorriso, ["-osirrox", "on", "-indev", srcIso, "-extract", isoPath, outPath]);
    // -extract can "succeed" without creating the file for a missing path on
    // some xorriso builds; confirm the local file actually exists + is nonempty.
    const st = await stat(outPath);
    return st.size > 0;
  } catch {
    return false;
  }
}
