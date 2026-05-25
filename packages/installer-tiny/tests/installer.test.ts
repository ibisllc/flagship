/**
 * Validates the tiny live installer: shell syntax, phase coverage (must match
 * the control-plane status channel), and the proven encrypted-LVM layout
 * invariants. The installer is a POSIX shell script that runs as root inside
 * the live OS, so a syntax slip or a wrong partition label is a USB-reflash
 * (or worse, a wrong-disk wipe) — these are cheap guards against that.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  INSTALLER_PHASES,
  PROVEN_LAYOUT,
  LIVE_INSTALLER_TOOLS,
  INSTALLED_OS_PACKAGES,
  SUCCESS_FINALIZE_ORDER,
} from "../src/index.js";
import { PROVISION_STATUS_PHASES } from "@flagship/control-plane";
import { generateUMK, deriveIRK, signAuthCode, signInstallBlob } from "@flagship/protocol";
import { installBlobToJson } from "@flagship/iso-personalizer";

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALLER = join(HERE, "..", "src", "installer.sh");
const installerSrc = readFileSync(INSTALLER, "utf8");

describe("installer.sh shell validity", () => {
  it("passes POSIX sh -n syntax check", () => {
    const r = spawnSync("sh", ["-n", INSTALLER], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("the QEMU e2e runner passes POSIX sh -n syntax check", () => {
    const runner = join(HERE, "..", "scripts", "qemu-install-e2e.sh");
    const r = spawnSync("sh", ["-n", runner], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("is set -eu (fail-fast, no unbound vars)", () => {
    expect(installerSrc).toMatch(/^set -eu/m);
  });

  it("reports every status phase to /api/order/<serial>/status", () => {
    // The error phase is reported via fail(); the rest via report_phase.
    for (const phase of INSTALLER_PHASES) {
      if (phase === "error") {
        expect(installerSrc).toMatch(/report_phase error/);
      } else {
        expect(installerSrc).toMatch(new RegExp(`report_phase ${phase}`));
      }
    }
  });
});

describe("phase vocabulary stays in lock-step with the control plane", () => {
  it("matches PROVISION_STATUS_PHASES exactly", () => {
    expect([...INSTALLER_PHASES]).toEqual([...PROVISION_STATUS_PHASES]);
  });
});

describe("proven encrypted-LVM layout", () => {
  it("lays down bios_grub + ESP + /boot + LUKS in order with the right type codes", () => {
    expect(installerSrc).toMatch(/-t1:ef02/); // bios_grub
    expect(installerSrc).toMatch(/-t2:ef00/); // ESP
    expect(installerSrc).toMatch(/-t3:8300/); // /boot
    expect(installerSrc).toMatch(/-t4:8309/); // LUKS
  });

  it("uses LUKS2 and the proven vg/lv names + labels", () => {
    expect(installerSrc).toMatch(/luksFormat --type luks2/);
    expect(installerSrc).toMatch(new RegExp(`vgcreate ${PROVEN_LAYOUT.luks.vgName}`));
    expect(installerSrc).toMatch(new RegExp(`-n ${PROVEN_LAYOUT.luks.lvName} ${PROVEN_LAYOUT.luks.vgName}`));
    expect(installerSrc).toMatch(new RegExp(`-L ${PROVEN_LAYOUT.boot.label}`));
    expect(installerSrc).toMatch(new RegExp(`-L ${PROVEN_LAYOUT.luks.rootLabel}`));
  });

  it("forces a kernel partition-table re-read before using the new nodes (QEMU-found bug)", () => {
    // sgdisk alone does not create /dev/vdaN; partx -u + a device-wait do.
    expect(installerSrc).toMatch(/partx -u/);
    expect(installerSrc).toMatch(/while \[ ! -b/);
  });
});

describe("tiny-by-design: no heavy work in the live installer", () => {
  it("never EXECUTES node / npm install / tsc in the live installer body", () => {
    // The heavy proven sequence runs first-boot on the INSTALLED OS. Installing
    // npm INTO the target (apk add npm) is fine; RUNNING `npm install`/`tsc -b`
    // against the live system is not — those must only appear inside the dropped
    // first-boot unit heredoc.
    const beforeFirstBoot = installerSrc.split("drop_first_boot_unit()")[0] ?? installerSrc;
    expect(beforeFirstBoot).not.toMatch(/^[^#\n]*\bnpm install\b/m);
    expect(beforeFirstBoot).not.toMatch(/^[^#\n]*\bnpx tsc -b\b/m);
    expect(beforeFirstBoot).not.toMatch(/^[^#\n]*\bnpx tsx\b/m);
  });

  it("installs exactly the curated live-installer tool set via apk", () => {
    for (const t of LIVE_INSTALLER_TOOLS) {
      expect(installerSrc).toContain(t);
    }
  });

  it("defers the proven heavy sequence to the first-boot unit", () => {
    expect(installerSrc).toMatch(/git clone/);
    expect(installerSrc).toMatch(/npm install/);
    expect(installerSrc).toMatch(/gen-identity/);
    expect(installerSrc).toMatch(/mint-entitlements/);
    expect(installerSrc).toMatch(/sign-server-register/);
    expect(installerSrc).toMatch(/seal-for-bak/);
    expect(installerSrc).toMatch(/sealed-luks-key/);
  });
});

describe("dry-run safety for the QEMU PoC", () => {
  it("guards every disk-mutating phase behind FLAGSHIP_DRY_RUN", () => {
    expect(installerSrc).toMatch(/FLAGSHIP_DRY_RUN/);
    // The destructive sgdisk -Z must not run when dry-run is set.
    const partFn = installerSrc.split("phase_partition()")[1]?.split("phase_install()")[0] ?? "";
    expect(partFn).toMatch(/FLAGSHIP_DRY_RUN.*=.*1/s);
  });
});

describe("earliest 'box online' ping (agreed UX)", () => {
  it("reports `booting` from phase_network, the moment the link is up", () => {
    const netFn = installerSrc.split("phase_network()")[1]?.split("\nbake_wifi()")[0] ?? "";
    expect(netFn).toMatch(/report_phase booting/);
  });

  it("brings network up BEFORE the download/partition/install phases run", () => {
    // main() ordering: phase_network must precede phase_download.
    const main = installerSrc.split("\nmain() {")[1] ?? "";
    const net = main.indexOf("phase_network");
    const dl = main.indexOf("phase_download");
    const part = main.indexOf("phase_partition");
    expect(net).toBeGreaterThanOrEqual(0);
    expect(net).toBeLessThan(dl);
    expect(dl).toBeLessThan(part);
  });
});

describe("base OS comes up headless on the encrypted disk", () => {
  it("lays down the headless package set (incl. mkinitfs + grub + daemon runtime)", () => {
    for (const pkg of INSTALLED_OS_PACKAGES) {
      expect(installerSrc).toContain(pkg);
    }
  });

  it("writes fstab, hostname, crypttab, network config, and an inittab serial getty", () => {
    expect(installerSrc).toMatch(/\/mnt\/etc\/fstab/);
    expect(installerSrc).toMatch(/\/mnt\/etc\/hostname/);
    expect(installerSrc).toMatch(/\/mnt\/etc\/crypttab/);
    expect(installerSrc).toMatch(/\/mnt\/etc\/network\/interfaces/);
    expect(installerSrc).toMatch(/ttyS0/); // serial console so a headless box reaches login
  });

  it("builds a LUKS+LVM-aware initramfs in the target (cryptsetup+lvm mkinitfs features)", () => {
    expect(installerSrc).toMatch(/mkinitfs/);
    expect(installerSrc).toMatch(/cryptsetup cryptkey lvm/);
    // mkinitfs must run inside the target chroot, not against the live shell.
    expect(installerSrc).toMatch(/chroot \/mnt mkinitfs/);
  });

  it("enables the headless OpenRC services (networking, sshd, chronyd, local)", () => {
    // Added via a `for svc in ...; do rc-update add "$svc" default` loop.
    expect(installerSrc).toMatch(/for svc in networking sshd chronyd local crond/);
    expect(installerSrc).toMatch(/rc-update add "\$svc" default/);
    // The first-boot `local` hook is also explicitly enabled.
    expect(installerSrc).toMatch(/rc-update add local default/);
  });
});

describe("bootloader installs GRUB for BOTH BIOS and UEFI", () => {
  it("installs i386-pc (BIOS) into the bios_grub partition", () => {
    expect(installerSrc).toMatch(/grub-install --target=i386-pc/);
  });

  it("installs x86_64-efi (UEFI) with a --removable fallback loader", () => {
    expect(installerSrc).toMatch(/grub-install --target=x86_64-efi/);
    expect(installerSrc).toMatch(/--removable/);
  });

  it("generates a grub.cfg wired to the flagship root chain", () => {
    expect(installerSrc).toMatch(/grub-mkconfig/);
    expect(installerSrc).toMatch(/root=\/dev\/flagship\/root/);
  });
});

describe("self-wipe + efibootmgr are gated on a verified-bootable install", () => {
  it("has an explicit success gate that checks the boot chain exists", () => {
    const gate = installerSrc.split("verify_installed_bootable()")[1]?.split("\nefibootmgr_internal_first()")[0] ?? "";
    // It must check the real artifacts, not just trust exit codes.
    expect(gate).toMatch(/grub\.cfg/);
    expect(gate).toMatch(/vmlinuz-\*/);
    expect(gate).toMatch(/initramfs-\*/);
    expect(gate).toMatch(/BOOTX64\.EFI/);
  });

  it("finish() runs the gate BEFORE any wipe or efibootmgr (success-only)", () => {
    const fin = installerSrc.split("\nfinish() {")[1]?.split("\nmain() {")[0] ?? "";
    const realPath = fin.split("REAL path")[1] ?? fin; // the non-dry-run branch
    const gateAt = realPath.indexOf("verify_installed_bootable");
    const efiAt = realPath.indexOf("efibootmgr_internal_first");
    const wipeAt = realPath.indexOf("wipe_usb_boot_signature");
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(gateAt).toBeLessThan(efiAt);
    expect(gateAt).toBeLessThan(wipeAt);
  });

  it("on a FAILED gate: reports error, leaves USB intact, does NOT wipe", () => {
    const fin = installerSrc.split("\nfinish() {")[1]?.split("\nmain() {")[0] ?? "";
    const realPath = fin.split("REAL path")[1] ?? fin;
    // The failure branch must call fail()/report error and must not reach wipe.
    const failBranch = realPath.split("if ! verify_installed_bootable")[1]?.split("success gate PASSED")[0] ?? "";
    expect(failBranch).toMatch(/fail /);
    expect(failBranch).toMatch(/left intact for retry/);
    expect(failBranch).not.toMatch(/wipe_usb_boot_signature/);
  });

  it("efibootmgr runs while /sys is live (before /mnt is unmounted)", () => {
    const fin = installerSrc.split("success gate PASSED")[1]?.split("\nmain() {")[0] ?? "";
    const efiAt = fin.indexOf("efibootmgr_internal_first");
    const umountAt = fin.indexOf("umount -R /mnt");
    expect(efiAt).toBeGreaterThanOrEqual(0);
    expect(efiAt).toBeLessThan(umountAt);
  });

  it("wipes the USB only after unmounting it (clean because Alpine runs from RAM)", () => {
    const wipeFn = installerSrc.split("wipe_usb_boot_signature()")[1]?.split("\nfinish()")[0] ?? "";
    const umountAt = wipeFn.indexOf("umount");
    const ddAt = wipeFn.indexOf("dd if=/dev/zero");
    expect(umountAt).toBeGreaterThanOrEqual(0);
    expect(umountAt).toBeLessThan(ddAt);
  });

  it("SUCCESS_FINALIZE_ORDER constant matches the gate-first sequencing", () => {
    expect(SUCCESS_FINALIZE_ORDER[0]).toBe("verify_installed_bootable");
    expect(SUCCESS_FINALIZE_ORDER.indexOf("efibootmgr_internal_first")).toBeGreaterThan(0);
    expect(SUCCESS_FINALIZE_ORDER.indexOf("wipe_usb_boot_signature")).toBeGreaterThan(
      SUCCESS_FINALIZE_ORDER.indexOf("efibootmgr_internal_first") - 1,
    );
    expect(SUCCESS_FINALIZE_ORDER[SUCCESS_FINALIZE_ORDER.length - 1]).toBe("reboot");
  });
});

describe("recipe-signature verify (seam a — ARMED, fail-closed)", () => {
  it("is armed: verifies against the embedded authCode.userPubKey, not a genesis key", () => {
    expect(installerSrc).toMatch(/verify_recipe_signature\(\)/);
    // The IRK-signed-blob trust model: verify under authCode.userPubKey.
    expect(installerSrc).toMatch(/authCode\.userPubKey/);
    expect(installerSrc).toMatch(/openssl pkeyutl -verify -rawin/);
    // The wrong "genesis pubkey" framing must be gone.
    expect(installerSrc).not.toMatch(/GENESIS_PUBKEY_HEX/);
    // Current v2 canonical string (not the stale v1 issuedAt/expiresAt one).
    expect(installerSrc).toMatch(/flagship\/install-blob\/v1\|2\|/);
  });

  it("runs AFTER phase_download (tools present) and BEFORE phase_partition (no disk written)", () => {
    const main = installerSrc.split("\nmain() {")[1]?.split("\n}")[0] ?? "";
    const dl = main.indexOf("phase_download");
    const verify = main.indexOf("verify_recipe_signature");
    const part = main.indexOf("phase_partition");
    expect(dl).toBeGreaterThanOrEqual(0);
    expect(dl).toBeLessThan(verify);
    expect(verify).toBeLessThan(part);
    // The deps it needs are apk-added in phase_download.
    const dlFn = installerSrc.split("phase_download()")[1]?.split("\n# ===")[0] ?? "";
    expect(dlFn).toMatch(/openssl jq xxd/);
  });

  it("fails closed on a tampered/missing signature (live openssl verify)", () => {
    // Build a real signed v2 recipe with @flagship/protocol, then drive the
    // standalone `installer.sh verify-recipe` subcommand. Needs jq/xxd and a
    // real OpenSSL (LibreSSL's pkeyutl lacks the Ed25519 -rawin path); skip the
    // live portion otherwise — the shell logic is asserted statically above.
    const have = (t: string) => spawnSync("sh", ["-c", `command -v ${t}`]).status === 0;
    const opensslReal =
      (spawnSync("openssl", ["version"], { encoding: "utf8" }).stdout || "").startsWith("OpenSSL");
    if (!have("jq") || !have("xxd") || !opensslReal) {
      return;
    }
    const umk = generateUMK();
    const irk = deriveIRK(umk);
    const now = Date.now();
    const authCode = {
      version: 1 as const,
      serial: "TESTSERIAL0001",
      username: "testuser",
      serverName: "home",
      serverDomain: "home.testuser.flagship.services",
      delegatedPubKey: irk.publicKey,
      userPubKey: irk.publicKey,
      issuedAt: now,
      expiresAt: now + 3_600_000,
    };
    const blob = {
      version: 2 as const,
      serverDomain: authCode.serverDomain,
      username: authCode.username,
      serverName: authCode.serverName,
      phoneDelegatedPubKey: irk.publicKey,
      registrationUrl: "https://flagshipserver.com",
      authCode,
      authCodeUserSignature: signAuthCode(authCode, irk),
      installerGitRef: "main",
      rckPubKey: irk.publicKey,
    };
    const sig = signInstallBlob(blob, irk);
    const json = installBlobToJson(blob);

    const dir = mkdtempSync(join(tmpdir(), "flagship-recipe-"));
    const jsonPath = join(dir, "install-blob.json");
    const sigPath = join(dir, "install-blob.sig");
    writeFileSync(jsonPath, JSON.stringify(json));
    writeFileSync(sigPath, Buffer.from(sig));

    const run = (jp: string, sp?: string) =>
      spawnSync("sh", sp ? [INSTALLER, "verify-recipe", jp, sp] : [INSTALLER, "verify-recipe", jp], {
        encoding: "utf8",
      });

    // Valid signature (raw .sig file) -> exit 0.
    expect(run(jsonPath, sigPath).status).toBe(0);

    // Valid signature carried as blobSignatureHex inside the JSON, no .sig file.
    const jsonWithHex = join(dir, "with-hex.json");
    writeFileSync(
      jsonWithHex,
      JSON.stringify({ ...json, blobSignatureHex: Buffer.from(sig).toString("hex") }),
    );
    expect(run(jsonWithHex, join(dir, "does-not-exist.sig")).status).toBe(0);

    // Tampered field (installerGitRef) -> signature no longer matches -> non-zero.
    const tamperedJson = join(dir, "tampered.json");
    writeFileSync(tamperedJson, JSON.stringify({ ...json, installerGitRef: "evil-branch" }));
    expect(run(tamperedJson, sigPath).status).not.toBe(0);

    // Tampered signature bytes -> non-zero.
    const badSig = Buffer.from(sig);
    badSig[0] ^= 0xff;
    const badSigPath = join(dir, "bad.sig");
    writeFileSync(badSigPath, badSig);
    expect(run(jsonPath, badSigPath).status).not.toBe(0);

    // No signature at all (no .sig file, no blobSignatureHex) -> fail closed.
    expect(run(jsonPath, join(dir, "missing.sig")).status).not.toBe(0);
  });
});

describe("clean seams (deliberately NOT wired to live .com)", () => {
  it("(b) first-boot provision unit is dropped but TODO'd, not wired live", () => {
    const unit = installerSrc.split("drop_first_boot_unit()")[1] ?? "";
    expect(unit).toMatch(/10-flagship-provision\.start/);
    expect(unit).toMatch(/TODO\(seam-b\)/);
    // The heavy sequence lives ONLY inside the dropped unit heredoc.
    expect(unit).toMatch(/npm install/);
    expect(unit).toMatch(/gen-identity/);
  });
});
