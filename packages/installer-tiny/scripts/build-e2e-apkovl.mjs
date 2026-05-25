// Build an apkovl that runs the REAL installer.sh (non-dry-run) inside the
// stock Alpine standard ISO against a blank target disk, end to end. This is
// the harness that proves the full install path — partition -> LUKS -> LVM ->
// apk --root base lay-down -> configure -> GRUB BIOS+UEFI -> success gate — and
// leaves a bootable disk behind, which qemu-install-e2e.sh then boots STANDALONE
// to prove the installed Alpine reaches a login.
//
// What it drops onto the live overlay:
//   /flagship/installer.sh        the real script (copied verbatim from src/)
//   /flagship/install-blob.json   a minimal recipe (only `serial` is read live)
//   /flagship/installer.env       knobs: target/USB pinned, control-plane off
//   /etc/local.d/99-flagship-e2e.start   the launcher (runs installer.sh, then
//                                         prints a sentinel + poweroff)
//
// Usage: node scripts/build-e2e-apkovl.mjs <out.apkovl.tar.gz>
import { buildApkovl } from "../../installer-apkovl/src/buildApkovl.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || "/tmp/flagship-e2e.apkovl.tar.gz";
const enc = new TextEncoder();

const installerSh = readFileSync(join(HERE, "..", "src", "installer.sh"), "utf8");

// Minimal recipe — only authCode.serial is consumed by the live installer
// (read_serial). Everything else the first-boot unit needs, and that runs on
// the installed OS (out of scope for this harness).
const recipe = JSON.stringify({
  serverDomain: "e2e.harness.flagship.services",
  username: "e2e",
  serverName: "e2e",
  authCode: { serial: "E2EHARNESS0001" },
});

// installer.env: pin the install target + USB so select_target/detect_usb_dev
// are deterministic in the VM, and route status reports to a black hole (they
// are best-effort and must never fail the install). We override TARGET/USB_DEV
// by exporting them; the script's select_target only runs if TARGET is empty,
// and detect_usb_dev only sets USB_DEV if empty — so pinning here wins.
const env = [
  "# e2e harness env (sourced by installer.sh)",
  'CONTROL_PLANE_BASE="http://127.0.0.1:1"', // unreachable: reports no-op
  'GENESIS_PUBKEY_HEX=""', // seam (a) stays a no-op in the harness
  'FW_PACKAGES=""', // skip the ~100MB firmware in the VM (no real NICs to drive)
  'HOSTNAME_DEFAULT="flagship-e2e"',
  "export TARGET=/dev/vdb", // the blank 12G target disk QEMU attaches
  'export USB_DEV=""', // no USB to wipe in the harness; wipe step self-skips
  "",
].join("\n");

// The launcher: run the REAL installer non-dry-run, capture the verdict, print
// a sentinel the harness greps for, then power off so QEMU exits cleanly. The
// installer reboots on full success; we intercept by overriding `reboot` to a
// sentinel-print + poweroff (so we don't actually loop), and we still assert
// the disk is bootable by letting the success gate run for real.
const launcher = [
  "#!/bin/sh",
  "exec > /dev/console 2>&1",
  'echo "================ FLAGSHIP INSTALLER E2E (apkovl, REAL install) ================"',
  'echo "uname: $(uname -srm)"',
  // The standard ISO mounts modloop -> storage drivers present. Confirm the
  // blank target disk is visible before we hand off to the installer.
  'echo "target /dev/vdb present: $( [ -b /dev/vdb ] && echo yes || echo NO )"',
  // Bring up the wired NIC for apk (user-mode NAT gives us 10.0.2.x + DNS).
  "setup-interfaces -a 2>/dev/null || true",
  "rc-service networking start 2>/dev/null || udhcpc -i eth0 2>/dev/null || true",
  // Shadow `reboot` with a sentinel shim earlier in PATH so a successful
  // install does not actually loop the VM. The installer runs in its own `sh`
  // subprocess, so a shell function would not carry over — a PATH shim does.
  // The harness asserts bootability by booting the disk standalone next.
  "mkdir -p /usr/local/sbin",
  'printf "#!/bin/sh\\necho FLAGSHIP_INSTALL_REBOOT_REACHED\\n" > /usr/local/sbin/reboot',
  "chmod +x /usr/local/sbin/reboot",
  "export PATH=/usr/local/sbin:$PATH",
  // Run the real installer. FLAGSHIP_DRY_RUN unset -> real disk work.
  'echo "--- running /flagship/installer.sh (REAL, FLAGSHIP_DRY_RUN unset) ---"',
  "FLAGSHIP_LOG=/dev/console FLAGSHIP_DIR=/flagship PATH=/usr/local/sbin:$PATH sh /flagship/installer.sh; RC=$?",
  'echo "--- installer exited rc=$RC ---"',
  "if [ \"$RC\" = \"0\" ]; then echo FLAGSHIP_E2E_INSTALL_OK; else echo FLAGSHIP_E2E_INSTALL_FAIL; fi",
  // Dump the GPT we wrote so the log shows the proven layout.
  "apk add --quiet sgdisk 2>/dev/null || true",
  "sgdisk -p /dev/vdb 2>/dev/null || true",
  "poweroff -f",
  "",
].join("\n");

const tar = buildApkovl({
  mtime: Number.parseInt(process.env.SOURCE_DATE_EPOCH || "0", 10) || 0,
  files: [
    { name: "flagship/installer.sh", content: enc.encode(installerSh), mode: 0o755 },
    { name: "flagship/install-blob.json", content: enc.encode(recipe), mode: 0o644 },
    { name: "flagship/installer.env", content: enc.encode(env), mode: 0o644 },
    { name: "etc/local.d/99-flagship-e2e.start", content: enc.encode(launcher), mode: 0o755 },
    { name: "etc/runlevels/default/local", content: new Uint8Array(0), mode: 0o644 },
  ],
});
writeFileSync(out, tar);
console.log("e2e apkovl written:", out, tar.length, "bytes");
