/**
 * debian-installer (d-i) `preseed.cfg` generator for the Burner — the Debian
 * twin of userdata.ts `buildAutoinstallUserData`.
 *
 * WHY DEBIAN EXISTS. Ubuntu's subiquity treats a UEFI box whose firmware
 * REJECTS NVRAM boot-entry writes as a FATAL install error
 * (`grub-install: error: failed to register the EFI boot entry: Invalid
 * argument`), and the documented opt-out (`storage.grub.update_nvram:false` +
 * the `grub2/update_nvram` debconf preseed) is IGNORED by the shipped
 * subiquity. debian-installer handles exactly this: a single preseed key forces
 * GRUB to the EFI removable-media path (`/EFI/BOOT/BOOTX64.EFI`), which every
 * UEFI box boots with no NVRAM entry. That is the whole reason for the Debian
 * path. See https://wiki.debian.org/UEFI and the d-i grub-installer templates.
 *
 * REUSE. Everything downstream of the installer is shared verbatim with the
 * Ubuntu path:
 *   - the first-boot bootstrap (clone + build daemon + identity + register +
 *     LUKS re-key/seal/initramfs-hook) is buildBootstrapScript() from
 *     userdata.ts, run from d-i's preseed/late_command (target at /target,
 *     exactly like curtin's in-target). `family:"debian"` only adapts the
 *     LVM-on-LUKS unlock step inside that script.
 *   - the runtime Wi-Fi script (wifiSetupScript) is byte-identical to Ubuntu's
 *     (same cross-language sha256 pin) — networkd still rejects a wifi `match:`,
 *     so the installed-system Wi-Fi is keyed by the interface name detected at
 *     runtime.
 *
 * STORAGE. partman-crypto's only reliably-preseedable encrypted mode is
 * LVM-on-LUKS (`partman-auto/method string crypto`): an unencrypted ESP + an
 * unencrypted /boot + a LUKS container holding one LVM volume group with a
 * single root LV. (Plain LUKS-without-LVM is not reliably preseedable across
 * d-i.) curtin's Ubuntu layout is plain-LUKS; the labels (FLAGSHIP_BOOT /
 * FLAGSHIP_ROOT) and the burn-time passphrase (re-keyed away on first boot)
 * are mirrored, and the bootstrap's `blkid -t TYPE=crypto_LUKS` re-key step
 * works unchanged on both.
 */
import {
  buildBootstrapScript,
  resolveBootstrapInputs,
  wifiSetupScript,
  BURN_PASSPHRASE,
  type UserDataOptions,
} from "./userdata.js";

/**
 * Build the Debian d-i preseed.cfg. Same options as the Ubuntu generator
 * (UserDataOptions) so the two are drop-in interchangeable behind a
 * family switch — the InstallBlob is embedded base64 verbatim and read back
 * by the bootstrap; the recipe never carries Debian-vs-Ubuntu choices.
 */
export function buildDebianPreseed(opts: UserDataOptions): string {
  // Same validated/defaulted inputs as the Ubuntu generator (shared so the two
  // can't drift on validation or the encryptRoot/bootUnlockMode defaults).
  const { blobB64, ref, repo, bootHost, encryptRoot, bootUnlockMode } =
    resolveBootstrapInputs(opts);
  // The exact same first-boot bootstrap as Ubuntu — only the LUKS unlock step
  // adapts to Debian's LVM-on-LUKS (family:"debian").
  const bootstrap = buildBootstrapScript({
    ref,
    repoUrl: repo,
    encryptRoot,
    bootUnlockMode,
    bootHost,
    family: "debian",
    wifiSSID: opts.wifiSSID,
    wifiPassword: opts.wifiPassword,
    debugSshAuthorizedKey: opts.debugSshAuthorizedKey,
  });
  const bootstrapB64 = utf8ToBase64(bootstrap);

  // Storage: encrypted (LVM-on-LUKS) is the locked default; the unencrypted
  // escape hatch reproduces a plain regular install for bisecting a boot
  // failure (NOT exposed in CLI/GUI), mirroring userdata.ts encryptRoot:false.
  const storageBlock = encryptRoot
    ? debianCryptoStorageBlock()
    : debianPlainStorageBlock();

  // Wi-Fi (burn-time local input; never in the signed recipe). d-i's netcfg
  // takes WPA directly at install time (unlike networkd, netcfg keys wireless
  // by ESSID), AND the installed system gets the same runtime-detected netplan
  // the Ubuntu path uses (the body is byte-identical — same sha256 pin).
  const ssid = (opts.wifiSSID ?? "").trim();
  const hasWifi = ssid.length > 0;
  const wifiScript64 = hasWifi
    ? utf8ToBase64(wifiSetupScript(ssid, opts.wifiPassword ?? ""))
    : "";
  const wifiNetcfgBlock = hasWifi
    ? debianWifiNetcfgBlock(ssid, opts.wifiPassword ?? "")
    : "";
  // wpasupplicant in the installed system so the radio comes up on first boot
  // (the runtime-detected netplan needs it) — matches the Ubuntu path.
  const wifiPackagesBlock = hasWifi ? " wpasupplicant" : "";
  // The runtime Wi-Fi setup. Run via `in-target` (chroot into /target), so the
  // script's ROOT arg is EMPTY — its `/` already IS the target (passing /target
  // here would write to /target/target). Running chrooted is also what lets the
  // script's `systemctl enable`-style symlinks land in the installed system.
  // Byte-identical script to Ubuntu (same cross-language sha pin).
  const wifiLateCommand = hasWifi
    ? `echo '${wifiScript64}' | base64 -d > /target/tmp/flagship-wifi.sh && in-target bash /tmp/flagship-wifi.sh; `
    : "";

  // The preseed/late_command. d-i runs it with the target at /target; `in-target`
  // chroots into it (the d-i equivalent of curtin's `in-target`). We write the
  // install-blob + bootstrap into the target and run the bootstrap there — the
  // exact same two artifacts the Ubuntu late-commands write.
  const lateCommand =
    `mkdir -p /target/var/flagship; ` +
    `echo '${blobB64}' | base64 -d > /target/var/flagship/install-blob.json; ` +
    `chmod 600 /target/var/flagship/install-blob.json; ` +
    `echo '${bootstrapB64}' | base64 -d > /target/usr/local/sbin/flagship-bootstrap.sh; ` +
    `chmod +x /target/usr/local/sbin/flagship-bootstrap.sh; ` +
    wifiLateCommand +
    `in-target /usr/local/sbin/flagship-bootstrap.sh`;

  return `# Flagship Burner — debian-installer preseed
# Generated at burn time. Don't edit by hand.

### Localization — fixed, non-interactive.
d-i debian-installer/locale string en_US.UTF-8
d-i keyboard-configuration/xkb-keymap select us

### Network.
${wifiNetcfgBlock}d-i netcfg/choose_interface select auto
d-i netcfg/get_hostname string flagship-pod
d-i netcfg/get_domain string
d-i netcfg/hostname string flagship-pod
# Don't block the install for a slow/absent link.
d-i netcfg/dhcp_timeout string 60
d-i netcfg/link_wait_timeout string 30

### Mirror — pulled from the network (netinst has no full package set).
d-i mirror/country string manual
d-i mirror/http/hostname string deb.debian.org
d-i mirror/http/directory string /debian
d-i mirror/http/proxy string

### Account setup. Root login disabled; one admin user (matches Ubuntu's
### autoinstall identity). The crypt(3) hash is the SAME baked hash the Ubuntu
### path ships (the box is phone-gated; this account is a break-glass console).
d-i passwd/root-login boolean false
d-i passwd/make-user boolean true
d-i passwd/user-fullname string Flagship
d-i passwd/username string flagship
d-i passwd/user-password-crypted password $6$saltsaltsaltsaltsalt$Fz2j0/yjeyqQsRGfQ2DGRrXyMz9.6CljgPwQ3UlqOPLqo4kVZk.zhztOQS9rdshOMu7w5WL9.bjvKR7vCs71y0
d-i user-setup/allow-password-weak boolean true
d-i user-setup/encrypt-home boolean false

### Clock.
d-i clock-setup/utc boolean true
d-i time/zone string Etc/UTC
d-i clock-setup/ntp boolean true

${storageBlock}
### Base system.
d-i base-installer/install-recommends boolean false
d-i apt-setup/non-free-firmware boolean true
d-i apt-setup/non-free boolean false
d-i apt-setup/contrib boolean false

### Packages. Debian names for the bootstrap's deps (Node 20 itself comes from
### the bootstrap's NodeSource one-liner, reused verbatim from the Ubuntu path).
tasksel tasksel/first multiselect standard, ssh-server
d-i pkgsel/include string git curl jq ca-certificates xxd cryptsetup cryptsetup-initramfs lvm2 gnupg openssl${wifiPackagesBlock}
d-i pkgsel/upgrade select none
popularity-contest popularity-contest/participate boolean false

### Bootloader — THE WHOLE POINT OF THE DEBIAN PATH.
# Install GRUB to the disk, no other-OS probing.
d-i grub-installer/only_debian boolean true
d-i grub-installer/with_other_os boolean false
d-i grub-installer/bootdev string default
# Many boxes' UEFI firmware REJECT NVRAM boot-entry writes
# ("failed to register the EFI boot entry: Invalid argument"), which aborts a
# subiquity install. d-i instead installs an extra GRUB copy at the EFI
# removable-media path (/EFI/BOOT/BOOTX64.EFI), which boots with NO NVRAM entry.
# Two keys, two owners, set together (belt + suspenders — same intent as the
# Ubuntu path setting both storage.grub.update_nvram AND the debconf key):
#   - grub-installer/force-efi-extra-removable  → the d-i question
#   - grub-efi-amd64 grub2/force_efi_extra_removable → the grub-efi pkg question
# https://wiki.debian.org/UEFI
d-i grub-installer/force-efi-extra-removable boolean true
grub-efi-amd64 grub2/force_efi_extra_removable boolean true
# Belt + suspenders for the firmware that also rejects the os-prober/efibootmgr
# NVRAM write outright: tell grub-installer not to touch NVRAM at all.
d-i grub-installer/update-nvram boolean false

### Finish — no prompts, just reboot into the installed system.
d-i finish-install/keep-consoles boolean true
d-i finish-install/reboot_in_progress note
d-i debian-installer/exit/poweroff boolean false

### First-boot bootstrap — the same install-blob + bootstrap the Ubuntu path
### writes, run in the installed target (d-i in-target == curtin in-target).
d-i preseed/late_command string ${lateCommand}
`;
}

/**
 * partman-crypto LVM-on-LUKS recipe (the locked encrypted default).
 * EXPERIMENTAL — needs live validation (brick risk).
 *
 * Layout (GPT): 1M bios_grub (reserved for a future BIOS variant) + a FAT32 ESP
 * at /boot/efi + an unencrypted ext4 /boot + the rest as a LUKS container whose
 * single LVM volume group `flagship` holds one root LV (ext4, /). The LUKS
 * volume is formatted with the fixed BURN_PASSPHRASE; the first-boot bootstrap
 * re-keys it to a phone-sealed random key and removes the passphrase, so the
 * burn-time constant never survives to the box being exposed.
 *
 * CRITICAL: under `partman-auto/method crypto`, partman builds the encrypted
 * LVM ITSELF from a PLAIN recipe (partitions with mountpoints only). Hand-
 * declaring the LVM (`method{ lvm }` / `vg_name{ }` / `in_vg{ }` / `lv_name{ }`)
 * makes partman abort with "No physical volume defined in volume group" — the
 * VG partman auto-creates inside the crypto layer and the one we named never get
 * linked. So `/` is just an ext4 partition marked `$lvmok{ }`; partman wraps it
 * in LUKS + LVM, names the VG from `partman-auto-lvm/new_vg_name`, and labels the
 * fs FLAGSHIP_ROOT. The bootstrap re-keys via `blkid TYPE=crypto_LUKS` (name-
 * agnostic), so the auto-assigned VG/LV names don't matter. Validated end-to-end
 * in a local QEMU d-i run (2026-05-24): plain recipe clears partman, builds the
 * LUKS volume, and proceeds to base install.
 */
function debianCryptoStorageBlock(): string {
  return `### Partitioning — EXPERIMENTAL LVM-on-LUKS (the locked encrypted default).
# partman-crypto only reliably preseeds LVM-on-LUKS: unencrypted ESP + /boot,
# then a LUKS container holding one VG (flagship) with a single root LV.
d-i partman-auto/method string crypto
d-i partman-auto/disk string /dev/sda /dev/vda /dev/nvme0n1
d-i partman/early_command string \\
  DISK=$(list-devices disk | head -n1); debconf-set partman-auto/disk "$DISK"
d-i partman-lvm/device_remove_lvm boolean true
d-i partman-md/device_remove_md boolean true
d-i partman-auto-lvm/new_vg_name string flagship
# The fixed burn-time LUKS passphrase. The bootstrap re-keys it to a
# phone-sealed random key on first boot, then removes this slot.
d-i partman-crypto/passphrase password ${BURN_PASSPHRASE}
d-i partman-crypto/passphrase-again password ${BURN_PASSPHRASE}
d-i partman-crypto/weak_passphrase boolean true
d-i partman-auto/choose_recipe select flagship-crypto
d-i partman-auto/expert_recipe string \\
      flagship-crypto ::                                            \\
              1 1 1 free                                            \\
                      \$iflabel{ gpt }                              \\
                      \$reusemethod{ }                              \\
                      method{ biosgrub }                            \\
              .                                                     \\
              512 512 512 free                                      \\
                      \$iflabel{ gpt }                              \\
                      \$reusemethod{ }                              \\
                      method{ efi } format{ }                       \\
              .                                                     \\
              768 768 768 ext4                                      \\
                      \$primary{ } \$bootable{ }                    \\
                      method{ format } format{ }                    \\
                      use_filesystem{ } filesystem{ ext4 }          \\
                      label{ FLAGSHIP_BOOT }                        \\
                      mountpoint{ /boot }                           \\
              .                                                     \\
              2000 5000 -1 ext4                                     \\
                      \$lvmok{ }                                    \\
                      method{ format } format{ }                    \\
                      use_filesystem{ } filesystem{ ext4 }          \\
                      label{ FLAGSHIP_ROOT }                        \\
                      mountpoint{ / }                               \\
              .
# Make the destructive steps fully unattended.
d-i partman-partitioning/confirm_write_new_label boolean true
d-i partman/choose_partition select finish
d-i partman/confirm boolean true
d-i partman/confirm_nooverwrite boolean true
d-i partman-lvm/confirm boolean true
d-i partman-lvm/confirm_nooverwrite boolean true
d-i partman-md/confirm boolean true
d-i partman-crypto/confirm boolean true
d-i partman-crypto/confirm_nooverwrite boolean true
d-i partman-basicfilesystems/no_swap boolean false
d-i partman-auto-crypto/erase_disks boolean false`;
}

/**
 * Unencrypted debug-escape layout (encryptRoot:false). NOT exposed in CLI/GUI —
 * it reproduces a plain ESP + /boot + ext4 root (regular partman) so a boot
 * failure can be bisected against a known-good non-LUKS baseline, mirroring
 * userdata.ts's plain path. Still forces the removable-media GRUB so the NVRAM
 * fix is exercised independently of the LUKS work.
 */
function debianPlainStorageBlock(): string {
  return `### Partitioning — DEBUG ESCAPE: plain (unencrypted) ESP + /boot + ext4 root.
# Not exposed in the CLI/GUI; reproduces a known-good non-LUKS baseline.
d-i partman-auto/method string regular
d-i partman-auto/disk string /dev/sda /dev/vda /dev/nvme0n1
d-i partman/early_command string \\
  DISK=$(list-devices disk | head -n1); debconf-set partman-auto/disk "$DISK"
d-i partman-lvm/device_remove_lvm boolean true
d-i partman-md/device_remove_md boolean true
d-i partman-auto/choose_recipe select flagship-plain
d-i partman-auto/expert_recipe string \\
      flagship-plain ::                                             \\
              1 1 1 free                                            \\
                      \$iflabel{ gpt }                              \\
                      \$reusemethod{ }                              \\
                      method{ biosgrub }                            \\
              .                                                     \\
              512 512 512 free                                      \\
                      \$iflabel{ gpt }                              \\
                      \$reusemethod{ }                              \\
                      method{ efi } format{ }                       \\
              .                                                     \\
              768 768 768 ext4                                      \\
                      \$primary{ } \$bootable{ }                    \\
                      method{ format } format{ }                    \\
                      use_filesystem{ } filesystem{ ext4 }          \\
                      label{ FLAGSHIP_BOOT }                        \\
                      mountpoint{ /boot }                           \\
              .                                                     \\
              2000 5000 -1 ext4                                     \\
                      \$primary{ }                                  \\
                      method{ format } format{ }                    \\
                      use_filesystem{ } filesystem{ ext4 }          \\
                      label{ FLAGSHIP_ROOT }                        \\
                      mountpoint{ / }                               \\
              .
d-i partman-partitioning/confirm_write_new_label boolean true
d-i partman/choose_partition select finish
d-i partman/confirm boolean true
d-i partman/confirm_nooverwrite boolean true`;
}

/**
 * Install-time Wi-Fi for d-i's netcfg. Unlike networkd (which rejects a wifi
 * `match:` and so can't take a burn-time glob), netcfg keys the wireless config
 * by ESSID directly, so the install itself can join the AP to reach the mirror.
 * The SSID/password sit in preseed string values; escape them for the d-i
 * string scalar. Emitted ABOVE choose_interface so netcfg sees them first.
 */
function debianWifiNetcfgBlock(ssid: string, password: string): string {
  return `d-i netcfg/wireless_show_essids select manual
d-i netcfg/wireless_essid string ${preseedEscape(ssid)}
d-i netcfg/wireless_essid_again string ${preseedEscape(ssid)}
d-i netcfg/wireless_security_type select wpa
d-i netcfg/wireless_wpa string ${preseedEscape(password)}
`;
}

/**
 * Escape a value for a single-line d-i preseed `string` scalar: strip CR/LF
 * (a preseed value is one physical line) and collapse stray control bytes.
 * d-i string values are not quoted, so the only hard requirement is no newline.
 */
function preseedEscape(s: string): string {
  return s.replace(/[\r\n]+/g, " ");
}

function utf8ToBase64(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64");
}
