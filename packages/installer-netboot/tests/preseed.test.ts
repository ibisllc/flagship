/**
 * W12 — assert the Debian preseed.cfg has the directives the install
 * path actually depends on. d-i is forgiving about missing answers
 * (it falls back to interactive prompts), but on an unattended cloud
 * install ANY prompt = a wedged provisioning attempt. So we
 * mechanically enforce that the preseed answers every load-bearing
 * directive.
 *
 * NOTE: this is a "config-shape" test, not a behavior test. d-i
 * actually parses preseed files in its own dialect; we just check
 * substrings here so a future edit can't silently delete e.g. the
 * `partman-auto/method` line and lose LUKS encryption.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const preseedPath = join(here, "..", "preseed.cfg");

function loadPreseed(): string {
  return readFileSync(preseedPath, "utf8");
}

describe("Debian preseed.cfg (W12)", () => {
  const src = loadPreseed();

  it("exists and is non-empty", () => {
    expect(src.length).toBeGreaterThan(500);
  });

  it("configures the locale + keyboard for unattended install", () => {
    expect(src).toContain("d-i debian-installer/locale string en_US.UTF-8");
    expect(src).toContain("d-i keyboard-configuration/xkb-keymap select us");
  });

  it("auto-selects a network interface and configures DHCP-friendly hostname", () => {
    expect(src).toContain("d-i netcfg/choose_interface select auto");
    expect(src).toContain("netcfg/get_hostname");
  });

  it("partitions with crypto + atomic recipe + LUKS placeholder", () => {
    // The single most security-relevant line in this file. A future
    // edit MUST NOT silently change this to e.g. lvm (= no encryption).
    expect(src).toContain("d-i partman-auto/method string crypto");
    expect(src).toContain("d-i partman-auto/choose_recipe select atomic");
    expect(src).toContain("d-i partman-crypto/passphrase string flagship-firstboot-placeholder");
    // The matching confirm line — d-i requires both passphrase + again.
    expect(src).toContain("d-i partman-crypto/passphrase-again string");
  });

  it("auto-confirms partitioning prompts (else the install wedges)", () => {
    expect(src).toContain("d-i partman/confirm boolean true");
    expect(src).toContain("d-i partman/confirm_nooverwrite boolean true");
    expect(src).toContain("d-i partman-lvm/confirm boolean true");
  });

  it("disables root login + creates the flagship user", () => {
    expect(src).toContain("d-i passwd/root-login boolean false");
    expect(src).toContain("d-i passwd/make-user boolean true");
    expect(src).toContain("d-i passwd/username string flagship");
  });

  it("pkgsel/include lists every dep the late-command + daemon need", () => {
    // Each of these is load-bearing somewhere downstream:
    //   openssh-server: only inbound access path (after key-only setup)
    //   git: clone the flagship repo
    //   curl: registration + sealed-luks-key POST
    //   jq: late-command parses install-blob.json
    //   nodejs + npm: build the daemon
    //   cryptsetup: rotate LUKS placeholder → real key
    //   lvm2: required by partman-auto/method=crypto
    //   ca-certificates: HTTPS to flagshipserver.com
    //   xxd: parse-trailer.sh decodes hex u32 LE fields
    const include = src.match(/^d-i pkgsel\/include string (.+)$/m);
    expect(include).toBeTruthy();
    const pkgs = include![1]!.split(/\s+/);
    for (const must of [
      "openssh-server",
      "git",
      "curl",
      "jq",
      "nodejs",
      "npm",
      "cryptsetup",
      "lvm2",
      "ca-certificates",
      "xxd",
    ]) {
      expect(pkgs).toContain(must);
    }
  });

  it("late_command copies our scripts in and exec's via in-target", () => {
    expect(src).toContain("d-i preseed/late_command string");
    // Paths are /flagship/ now (initrd root), not /cdrom/flagship/
    // (mini.iso doesn't auto-mount the boot medium at /cdrom).
    expect(src).toContain("/flagship/install.sh");
    expect(src).toContain("/flagship/parse-trailer.sh");
    expect(src).toContain("/flagship/late-command.sh");
    // in-target = run inside the chrooted /target where the LUKS root +
    // /dev/sda are both visible.
    expect(src).toContain("in-target /root/late-command.sh");
  });

  it("enables non-free-firmware for cloud-VM kernel drivers", () => {
    // Hetzner cx23's virtio + some realtek/intel NICs need firmware
    // blobs that only live in non-free-firmware. Without this, the
    // installed system boots but networking is half-broken.
    expect(src).toContain("d-i apt-setup/non-free-firmware boolean true");
  });

  it("installs GRUB to /dev/sda (the cloud-VPS root)", () => {
    expect(src).toContain("d-i grub-installer/only_debian boolean true");
    expect(src).toContain("d-i grub-installer/bootdev string /dev/sda");
  });

  it("tasksel is minimal — no desktop, no auto-ssh task", () => {
    // We install openssh-server via pkgsel/include so we control the
    // sshd_config; tasksel's "ssh-server" task brings its own config.
    expect(src).toContain("tasksel tasksel/first multiselect standard");
    expect(src).not.toMatch(/tasksel\/first[^\n]*ssh-server/);
    expect(src).not.toMatch(/tasksel\/first[^\n]*desktop/);
  });
});

describe("Debian preseed.cfg syntax sanity", () => {
  const src = loadPreseed();
  it("every non-comment, non-empty line starts with 'd-i', 'tasksel', or 'popularity-contest'", () => {
    const lines = src.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
    for (const line of lines) {
      // The late_command directive spans multiple lines with trailing
      // backslash-continuation; the continuation lines are anything
      // (start with whitespace + a sub-command). Skip continuation
      // lines.
      if (line.startsWith(" ") || line.startsWith("\t")) continue;
      expect(line).toMatch(/^(d-i|tasksel|popularity-contest)\b/);
    }
  });
});
