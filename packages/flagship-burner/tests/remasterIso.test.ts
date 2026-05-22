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
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  editGrubCfgForAutoinstall,
  remasterIsoWithAutoinstall,
  resolveXorriso,
} from "../src/remasterIso.js";

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
      await writeFile(join(src, "boot", "grub", "grub.cfg"), GRUB);
      await writeFile(join(src, "casper", "vmlinuz"), "fake");
      const srcIso = join(work, "src.iso");
      const x = await resolveXorriso();
      const mk = await sh(x, ["-as", "mkisofs", "-o", srcIso, "-V", "SYNTH", src]);
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
        outIso,
        "-extract",
        "/boot/grub/grub.cfg",
        join(check, "grub.cfg"),
        "-extract",
        "/nocloud/user-data",
        join(check, "user-data"),
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
