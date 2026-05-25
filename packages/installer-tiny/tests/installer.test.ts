/**
 * Validates the tiny live installer: shell syntax, phase coverage (must match
 * the control-plane status channel), and the proven encrypted-LVM layout
 * invariants. The installer is a POSIX shell script that runs as root inside
 * the live OS, so a syntax slip or a wrong partition label is a USB-reflash
 * (or worse, a wrong-disk wipe) — these are cheap guards against that.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTALLER_PHASES, PROVEN_LAYOUT, LIVE_INSTALLER_TOOLS } from "../src/index.js";
import { PROVISION_STATUS_PHASES } from "@flagship/control-plane";

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALLER = join(HERE, "..", "src", "installer.sh");
const installerSrc = readFileSync(INSTALLER, "utf8");

describe("installer.sh shell validity", () => {
  it("passes POSIX sh -n syntax check", () => {
    const r = spawnSync("sh", ["-n", INSTALLER], { encoding: "utf8" });
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
