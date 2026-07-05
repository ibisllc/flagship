/**
 * Burner: ISO remaster for unattended autoinstall.
 *
 * The pure grub-edit transform is unit-tested directly. A full xorriso
 * round-trip (build a synthetic ISO -> remaster -> extract -> assert) runs
 * when xorriso is present, so the real command plumbing is exercised
 * without needing the 2GB Ubuntu ISO.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  editGrubCfgForAutoinstall,
  editGrubCfgForPreseed,
  editIsolinuxCfgForPreseed,
  remasterIsoWithAutoinstall,
  remasterIsoWithPreseed,
  remasterIsoWithInstaller,
  classifyIsoText,
  detectIsoFamily,
  resolveXorriso,
  toXorrisoDiskPath,
  DEBIAN_PRESEED_CMDLINE,
} from "../src/remasterIso.js";

describe("toXorrisoDiskPath (Cygwin/MSYS Windows builds)", () => {
  it("converts win32 drive paths to the /c/ form xorriso parses as absolute", () => {
    // A bare `C:\a\b` is parsed by Cygwin xorriso as RELATIVE (workdir-prefixed).
    expect(toXorrisoDiskPath("C:\\Users\\x\\out.iso", "win32")).toBe("/c/Users/x/out.iso");
    expect(toXorrisoDiskPath("D:/tmp/seed", "win32")).toBe("/d/tmp/seed");
    expect(toXorrisoDiskPath("relative\\dir\\f.cfg", "win32")).toBe("relative/dir/f.cfg");
  });
  it("passes POSIX paths through untouched", () => {
    expect(toXorrisoDiskPath("/tmp/x/out.iso", "darwin")).toBe("/tmp/x/out.iso");
    expect(toXorrisoDiskPath("/tmp/x/out.iso", "linux")).toBe("/tmp/x/out.iso");
  });
});

const GRUB = `set timeout=30
menuentry "Try or Install Ubuntu Server" {
\tset gfxpayload=keep
\tlinux\t/casper/vmlinuz quiet ---
\tinitrd\t/casper/initrd
}
menuentry "Test memory" {
\tlinux16 /boot/memtest86+.bin
}
`;

describe("editGrubCfgForAutoinstall", () => {
  it("inserts the autoinstall + nocloud cmdline after the casper kernel", () => {
    const out = editGrubCfgForAutoinstall(GRUB);
    expect(out).toMatch(
      /linux\t\/casper\/vmlinuz autoinstall ds=nocloud\\;s=\/cdrom\/nocloud\/ quiet ---/,
    );
  });

  it("shortens the menu timeout so it boots without waiting", () => {
    expect(editGrubCfgForAutoinstall(GRUB)).toContain("set timeout=1");
    expect(editGrubCfgForAutoinstall(GRUB)).not.toContain("set timeout=30");
  });

  it("never touches non-casper boot entries (e.g. memtest)", () => {
    expect(editGrubCfgForAutoinstall(GRUB)).toContain("linux16 /boot/memtest86+.bin");
  });

  it("is idempotent — does not double-insert autoinstall", () => {
    const once = editGrubCfgForAutoinstall(GRUB);
    const twice = editGrubCfgForAutoinstall(once);
    expect((twice.match(/autoinstall/g) ?? []).length).toBe(1);
  });

  it("adds a timeout line when the source has none", () => {
    const noTimeout = `menuentry "x" {\n\tlinux /casper/vmlinuz ---\n}\n`;
    expect(editGrubCfgForAutoinstall(noTimeout).startsWith("set timeout=1\n")).toBe(true);
  });
});

function sh(cmd: string, argv: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: "ignore" });
    p.on("error", reject);
    p.on("close", (code) => resolve(code ?? 1));
  });
}

// The round-trip helpers spawn xorriso THEMSELVES (outside the production
// code), so their disk paths need the same Cygwin-form conversion on Windows.
const dp = (p: string) => toXorrisoDiskPath(p);

async function xorrisoPresent(): Promise<boolean> {
  const x = await resolveXorriso();
  try {
    await stat(x);
    return true;
  } catch {
    return x !== "xorriso" ? false : (await sh(x, ["-version"]).then(() => true).catch(() => false));
  }
}

describe("remasterIsoWithAutoinstall (real xorriso round-trip)", () => {
  it("bakes the seed at /nocloud and patches grub inside the ISO", async () => {
    if (!(await xorrisoPresent())) {
      // xorriso not installed in this environment — the pure transform
      // tests above still cover the patch logic.
      return;
    }
    const work = await mkdtemp(join(tmpdir(), "remaster-rt-"));
    try {
      const src = join(work, "src");
      await mkdir(join(src, "boot", "grub"), { recursive: true });
      await mkdir(join(src, "casper"), { recursive: true });
      const grubSrc = join(src, "boot", "grub", "grub.cfg");
      await writeFile(grubSrc, GRUB);
      await writeFile(join(src, "casper", "vmlinuz"), "fake");
      // Mirror the real Ubuntu ISO: grub.cfg is read-only (0444). With
      // Rock Ridge (-R) the mode is preserved into the ISO and restored on
      // extract, so the remaster must chmod it writable before patching.
      await chmod(grubSrc, 0o444);
      const srcIso = join(work, "src.iso");
      const x = await resolveXorriso();
      const mk = await sh(x, ["-as", "mkisofs", "-R", "-o", dp(srcIso), "-V", "SYNTH", dp(src)]);
      expect(mk).toBe(0);

      const outIso = join(work, "out.iso");
      await remasterIsoWithAutoinstall({
        srcIsoPath: srcIso,
        outIsoPath: outIso,
        userDataYaml: "#cloud-config\nautoinstall:\n  version: 1\n",
      });

      const check = join(work, "check");
      await mkdir(check, { recursive: true });
      await sh(x, [
        "-osirrox",
        "on",
        "-indev",
        dp(outIso),
        "-extract",
        "/boot/grub/grub.cfg",
        dp(join(check, "grub.cfg")),
        "-extract",
        "/nocloud/user-data",
        dp(join(check, "user-data")),
      ]);
      const patched = await readFile(join(check, "grub.cfg"), "utf-8");
      expect(patched).toContain("autoinstall ds=nocloud\\;s=/cdrom/nocloud/");
      const seeded = await readFile(join(check, "user-data"), "utf-8");
      expect(seeded).toContain("autoinstall:");
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// ── Debian (debian-installer / d-i) preseed remaster ────────────────────────

// A trimmed-down Debian netinst UEFI grub.cfg (the real one has more entries,
// but these are the kernel lines that matter).
const DEB_GRUB = `set default="0"
set timeout=10
set timeout_style=hidden
menuentry "Install" {
\tset background_color=black
\tlinux\t/install.amd/vmlinuz vga=788 --- quiet
\tinitrd\t/install.amd/initrd.gz
}
menuentry "Graphical install" {
\tlinux\t/install.amd/gtk/vmlinuz vga=788 --- quiet
\tinitrd\t/install.amd/gtk/initrd.gz
}
`;

// A trimmed-down Debian netinst BIOS isolinux txt.cfg.
const DEB_TXT = `default install
label install
\tmenu label ^Install
\tkernel /install.amd/vmlinuz
\tappend vga=788 initrd=/install.amd/initrd.gz --- quiet
label installgui
\tmenu label ^Graphical install
\tkernel /install.amd/gtk/vmlinuz
\tappend vga=788 initrd=/install.amd/gtk/initrd.gz --- quiet
`;

describe("editGrubCfgForPreseed (Debian UEFI)", () => {
  it("inserts the preseed cmdline after EVERY d-i kernel line (text + gtk)", () => {
    const out = editGrubCfgForPreseed(DEB_GRUB);
    expect(out).toContain(`/install.amd/vmlinuz ${DEBIAN_PRESEED_CMDLINE} vga=788`);
    expect(out).toContain(`/install.amd/gtk/vmlinuz ${DEBIAN_PRESEED_CMDLINE} vga=788`);
    // the canonical, file-based preseed delivery (CD mounted at /cdrom)
    expect(out).toContain("preseed/file=/cdrom/preseed.cfg");
    expect(out).toContain("auto=true priority=critical");
  });

  it("drops the menu timeout so it boots unattended", () => {
    const out = editGrubCfgForPreseed(DEB_GRUB);
    expect(out).toContain("set timeout=1");
    expect(out).not.toContain("set timeout=10");
  });

  it("is idempotent", () => {
    const once = editGrubCfgForPreseed(DEB_GRUB);
    const twice = editGrubCfgForPreseed(once);
    expect((twice.match(/preseed\/file=\/cdrom\/preseed\.cfg/g) ?? []).length).toBe(2);
    expect(once).toBe(twice);
  });
});

describe("editIsolinuxCfgForPreseed (Debian BIOS)", () => {
  it("inserts the preseed cmdline after initrd= on every append line", () => {
    const out = editIsolinuxCfgForPreseed(DEB_TXT);
    expect(out).toContain(`initrd=/install.amd/initrd.gz ${DEBIAN_PRESEED_CMDLINE}`);
    expect(out).toContain(`initrd=/install.amd/gtk/initrd.gz ${DEBIAN_PRESEED_CMDLINE}`);
  });

  it("forces a near-zero syslinux timeout + prompt 0", () => {
    const withPrompt = `prompt 1\ntimeout 600\n${DEB_TXT}`;
    const out = editIsolinuxCfgForPreseed(withPrompt);
    expect(out).toMatch(/^\s*timeout\s+1/m);
    expect(out).not.toContain("timeout 600");
    expect(out).toMatch(/^\s*prompt\s+0/m);
  });

  it("is idempotent", () => {
    const once = editIsolinuxCfgForPreseed(DEB_TXT);
    expect(editIsolinuxCfgForPreseed(once)).toBe(once);
  });
});

describe("classifyIsoText (Ubuntu vs Debian discriminator)", () => {
  it("classifies a Debian volume id / tree as debian", () => {
    expect(classifyIsoText("Debian 13.5.0 amd64 1")).toBe("debian");
    expect(classifyIsoText("/install.amd\n/boot\n/EFI")).toBe("debian");
  });
  it("classifies an Ubuntu volume id / tree as ubuntu", () => {
    expect(classifyIsoText("Ubuntu-Server 22.04.5 LTS amd64")).toBe("ubuntu");
    expect(classifyIsoText("/casper\n/boot\n/EFI")).toBe("ubuntu");
  });
  it("an Ubuntu image that mentions 'debian' but ships casper stays ubuntu", () => {
    // Ubuntu derives from Debian; casper (subiquity) is the real decider.
    expect(classifyIsoText("ubuntu based on debian\n/casper")).toBe("ubuntu");
  });
  it("defaults to the proven Ubuntu path when ambiguous", () => {
    expect(classifyIsoText("Some Custom Linux 1.0")).toBe("ubuntu");
    expect(classifyIsoText("")).toBe("ubuntu");
  });
});

describe("remasterIsoWithPreseed + detection (real xorriso round-trip)", () => {
  it("bakes /preseed.cfg + patches grub.cfg AND isolinux on a Debian-shaped ISO", async () => {
    if (!(await xorrisoPresent())) return;
    const work = await mkdtemp(join(tmpdir(), "remaster-deb-"));
    try {
      const src = join(work, "src");
      await mkdir(join(src, "boot", "grub"), { recursive: true });
      await mkdir(join(src, "isolinux"), { recursive: true });
      await mkdir(join(src, "install.amd", "gtk"), { recursive: true });
      const grubSrc = join(src, "boot", "grub", "grub.cfg");
      const txtSrc = join(src, "isolinux", "txt.cfg");
      await writeFile(grubSrc, DEB_GRUB);
      await writeFile(txtSrc, DEB_TXT);
      await writeFile(join(src, "install.amd", "vmlinuz"), "fake");
      await writeFile(join(src, "install.amd", "initrd.gz"), "fake");
      await chmod(grubSrc, 0o444);
      const srcIso = join(work, "src.iso");
      const x = await resolveXorriso();
      // Volume id contains "Debian" so detection picks the d-i path.
      const mk = await sh(x, ["-as", "mkisofs", "-R", "-o", dp(srcIso), "-V", "Debian 13.5.0 amd64 1", dp(src)]);
      expect(mk).toBe(0);

      // Detection should classify this as debian.
      expect(await detectIsoFamily(srcIso)).toBe("debian");

      const outIso = join(work, "out.iso");
      const used = await remasterIsoWithInstaller({
        srcIsoPath: srcIso,
        outIsoPath: outIso,
        preseedCfg: "# Flagship Burner — debian-installer preseed\nd-i debian-installer/locale string en_US.UTF-8\n",
        userDataYaml: "#cloud-config\n",
      });
      expect(used).toBe("debian");

      const check = join(work, "check");
      await mkdir(check, { recursive: true });
      await sh(x, [
        "-osirrox",
        "on",
        "-indev",
        dp(outIso),
        "-extract",
        "/preseed.cfg",
        dp(join(check, "preseed.cfg")),
        "-extract",
        "/boot/grub/grub.cfg",
        dp(join(check, "grub.cfg")),
        "-extract",
        "/isolinux/txt.cfg",
        dp(join(check, "txt.cfg")),
      ]);
      const preseed = await readFile(join(check, "preseed.cfg"), "utf-8");
      expect(preseed).toContain("d-i debian-installer/locale");
      const grub = await readFile(join(check, "grub.cfg"), "utf-8");
      expect(grub).toContain("preseed/file=/cdrom/preseed.cfg");
      const txt = await readFile(join(check, "txt.cfg"), "utf-8");
      expect(txt).toContain("preseed/file=/cdrom/preseed.cfg");
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  });
});
