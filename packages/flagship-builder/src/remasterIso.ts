/**
 * Remaster a stock Debian netinst ISO into an unattended preseed ISO.
 *
 * The preseed.cfg is baked at the ISO root and every boot config (grub.cfg for
 * UEFI, isolinux for BIOS) gets the preseed cmdline. xorriso's
 * `-boot_image any replay` reproduces the source ISO's El Torito catalog AND
 * isohybrid MBR/GPT in the output, so the result is a true hybrid image: `dd`
 * it to USB and it boots on both BIOS and UEFI.
 *
 * This file also holds the NoCloud seed helpers the VM appliance factory uses
 * for Debian cloud images (buildNocloudSeed / buildNocloudSeedIso).
 */
import { mkdir, rm, writeFile, readFile, stat, chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** The installer family an ISO carries: Debian's d-i is the only one Flagship installs from. */
export type IsoFamily = "debian" | "other";

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
  /** The d-i preseed.cfg text (from preseed.ts buildDebianPreseed). */
  preseedCfg: string;
  /** Force a family instead of detecting from the ISO (tests / overrides). */
  family?: IsoFamily;
  xorrisoPath?: string;
}

const XORRISO_CANDIDATES = [
  "/opt/homebrew/bin/xorriso",
  "/usr/local/bin/xorriso",
  "/usr/bin/xorriso",
  // Windows: the MSYS2 pacman package (the practical way to get xorriso there).
  "C:\\msys64\\usr\\bin\\xorriso.exe",
];

export async function resolveXorriso(override?: string): Promise<string> {
  const env = process.env.FLAGSHIP_XORRISO;
  if (override) return override;
  if (env) return env;
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
 * Disk-side path form for xorriso argv. The Cygwin/MSYS Windows builds parse
 * a leading drive letter as a RELATIVE path (prepending the workdir), so
 * `C:\a\b` must become `/c/a/b`. POSIX hosts pass through untouched. Pure.
 */
export function toXorrisoDiskPath(p: string, platform: string = process.platform): string {
  if (platform !== "win32") return p;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p.replace(/\\/g, "/");
  return `/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, "/")}`;
}

/**
 * The d-i kernel cmdline that drives a fully-unattended preseed install from
 * a preseed.cfg placed at the ISO root (mounted at /cdrom during install):
 *   - `auto=true priority=critical` suppresses every prompt at priority<critical
 *   - `preseed/file=/cdrom/preseed.cfg` points d-i at our config
 * The CD is already mounted at /cdrom by the time the preseed is read, so the
 * file method is reliable for the standard (text) installer entry — no initrd
 * repack needed (which keeps this inside one `-map` + `replay` flow). https://wiki.debian.org/DebianInstaller/Preseed
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
  // The speech-synthesis configs (spkgtk.cfg, spk.cfg) are included last and
  // carry `timeout 300` + `ontimeout <speech installer kernel line>`: without
  // this the BIOS boot drops into the accessible installer after 30 s, with no
  // preseed (found booting a remastered ISO on a real BIOS server). Point the
  // timeout at the plain installer label, which carries the preseed.
  out = out.replace(/^\s*ontimeout\s+.*$/gm, "ontimeout install");
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
  networkConfigYaml?: string,
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
  if (networkConfigYaml !== undefined) {
    await writeFile(join(seed, "network-config"), networkConfigYaml, "utf-8");
  }
  return seed;
}

export async function buildNocloudSeedIso(args: {
  outIsoPath: string;
  userDataYaml: string;
  networkConfigYaml?: string;
  xorrisoPath?: string;
}): Promise<void> {
  const xorriso = await resolveXorriso(args.xorrisoPath);
  const work = join(
    tmpdir(),
    `flagship-nocloud-${createHash("sha256")
      .update(args.outIsoPath + args.userDataYaml)
      .digest("hex")
      .slice(0, 12)}`,
  );
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  try {
    const seed = await buildNocloudSeed(work, args.userDataYaml, args.networkConfigYaml);
    await rm(args.outIsoPath, { force: true }).catch(() => {});
    await sh(xorriso, [
      "-as",
      "mkisofs",
      "-output",
      toXorrisoDiskPath(args.outIsoPath),
      "-volid",
      "cidata",
      "-joliet",
      "-rock",
      toXorrisoDiskPath(seed),
    ]);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Classify the volume-descriptor / ISO contents text as Debian's installer or
 * something else. Pure (no I/O) so it's unit-testable: feed it the volume id or
 * a directory listing. Debian wins on an explicit "debian" marker OR the d-i
 * kernel tree (/install.amd, /d-i), unless the text also looks like a casper
 * (Ubuntu live) image without the d-i tree.
 */
export function classifyIsoText(text: string): IsoFamily {
  const t = text.toLowerCase();
  if (/\binstall\.amd\b|\/d-i\/|debian-installer|\bdebian\b/.test(t)) {
    if (/\bcasper\b|\bubuntu\b/.test(t) && !/\binstall\.amd\b|\/d-i\//.test(t)) {
      return "other";
    }
    return "debian";
  }
  return "other";
}

/**
 * Detect whether a source ISO is a Debian (d-i) image. Reads the ISO volume id;
 * if that's inconclusive, peeks at the boot config tree (Debian has
 * /install.amd).
 */
export async function detectIsoFamily(
  srcIsoPath: string,
  xorrisoPath?: string,
): Promise<IsoFamily> {
  const xorriso = await resolveXorriso(xorrisoPath);
  // 1. Volume id (cheap, usually decisive: "Debian 13.5.0 amd64 1").
  let volid = "";
  try {
    volid = await shCapture(xorriso, ["-indev", toXorrisoDiskPath(srcIsoPath), "-toc"]);
  } catch {
    // fall through to the directory probe
  }
  const m = volid.match(/Volume id\s*:\s*'([^']*)'/i) ?? volid.match(/Volume id\s*:\s*(.+)/i);
  const volName = (m?.[1] ?? "").trim();
  if (/\bdebian\b/i.test(volName)) return "debian";
  // 2. Directory probe — list the root + boot tree and classify the listing.
  try {
    const listing = await shCapture(xorriso, [
      "-indev",
      toXorrisoDiskPath(srcIsoPath),
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
 * MBR/GPT so the result is dd-able on BIOS and UEFI.
 *
 * Note on md5sum.txt: d-i only verifies it during an explicit "Check disc"
 * step, which the unattended boot never runs — so editing files on the ISO is
 * fine.
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
      { iso: "/isolinux/spkgtk.cfg", edit: editIsolinuxCfgForPreseed },
      { iso: "/isolinux/spk.cfg", edit: editIsolinuxCfgForPreseed },
    ];
    let patchedAny = false;
    for (let i = 0; i < patchTargets.length; i++) {
      const t = patchTargets[i]!;
      const local = join(work, `bootcfg-${i}`);
      const ok = await extractOptional(xorriso, args.srcIsoPath, t.iso, local);
      if (!ok) continue;
      await chmod(local, 0o644).catch(() => {});
      await writeFile(local, t.edit(await readFile(local, "utf-8")), "utf-8");
      mapArgs.push("-map", toXorrisoDiskPath(local), t.iso);
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
      toXorrisoDiskPath(args.srcIsoPath),
      "-outdev",
      toXorrisoDiskPath(args.outIsoPath),
      "-boot_image",
      "any",
      "replay",
      "-map",
      toXorrisoDiskPath(preseedOut),
      "/preseed.cfg",
      ...mapArgs,
    ]);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Remaster a Debian installer ISO. Detects (or takes) the ISO family and
 * refuses anything that is not a Debian d-i image, with a sentence the apps can
 * show as is.
 */
export const NOT_DEBIAN_ISO_MESSAGE =
  "This is not a Debian installer image. Flagship installs from a Debian netinst ISO.";

export async function remasterIsoWithInstaller(
  args: RemasterInstallerArgs,
): Promise<IsoFamily> {
  const family = args.family ?? (await detectIsoFamily(args.srcIsoPath, args.xorrisoPath));
  if (family !== "debian") throw new Error(NOT_DEBIAN_ISO_MESSAGE);
  await remasterIsoWithPreseed({
    srcIsoPath: args.srcIsoPath,
    outIsoPath: args.outIsoPath,
    preseedCfg: args.preseedCfg,
    xorrisoPath: args.xorrisoPath,
  });
  return "debian";
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
    await sh(xorriso, [
      "-osirrox", "on",
      "-indev", toXorrisoDiskPath(srcIso),
      "-extract", isoPath, toXorrisoDiskPath(outPath),
    ]);
    // -extract can "succeed" without creating the file for a missing path on
    // some xorriso builds; confirm the local file actually exists + is nonempty.
    const st = await stat(outPath);
    return st.size > 0;
  } catch {
    return false;
  }
}
