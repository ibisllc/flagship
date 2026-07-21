/**
 * debian-installer (d-i) `preseed.cfg` generator for the Builder — the Debian
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
import { utf8ToBase64 } from "./base64.js";

/**
 * The single canonical provisioning vocabulary (mirror of the control-plane
 * `PROVISION_STATUS_PHASES` allowlist). The d-i beacons report the three
 * pre-bootstrap rungs (`booting`/`partitioning`/`downloading`); the first-boot
 * bootstrap + daemon report the rest. ONE channel, ONE vocabulary.
 */
export type ProvisionStatusPhase =
  | "booting"
  | "partitioning"
  | "installing"
  | "downloading"
  | "registering"
  | "sealing"
  | "installed"
  | "pairing"
  | "live"
  | "error";

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
  // Phone-home beacons. The serial is known at generation time; we inline it
  // (never parse the blob at runtime in early_command). It's sanitized to an
  // injection-proof set so it can sit unquoted in the URL. The beacon carries
  // only the serial (URL) + a canonical PHASE name — no secrets — and is
  // best-effort. ONE channel: POST /api/order/<serial>/status.
  const beaconSerial = beaconSafe(opts.blob.authCode.serial);
  // Beacon A — earliest hook (early_command, before partman): the box has
  // booted the installer. Canonical phase `booting`.
  const earlyBeacon = debianBeaconCommand("booting", beaconSerial);
  // Beacon B — late_command (network guaranteed up): the mirror + blob fetch
  // are happening. Canonical phase `downloading`. Stop the base-installer
  // telemetry first so a delayed heartbeat cannot overwrite this later phase.
  const lateBeacon = debianBeaconCommand("downloading", beaconSerial);
  const stopInstallerTelemetry =
    `touch /tmp/flagship-installer-telemetry.done; ` +
    `if [ -s /tmp/flagship-installer-telemetry.pid ]; then ` +
    `kill "$(cat /tmp/flagship-installer-telemetry.pid)" 2>/dev/null || true; fi; ` +
    `sleep 1`;
  // Beacon fired from partman/early_command (the network IS up by partman, so
  // this is the most reliable "the box exists" ping — emitted BEFORE the wipe so
  // the phone hears from the box even if partitioning later fails).
  const partitionBeacon = debianBeaconCommand("partitioning", beaconSerial);
  // Beacon E — `installing`, fired by base-installer right after partitioning.
  // d-i has no command-level preseed hook in the multi-minute debootstrap/apt
  // window (partman/early_command is before partitioning, late_command after the
  // base install), so partman/early_command drops a tiny executable into
  // /usr/lib/base-installer.d/ which base-installer runs as that window opens.
  const installingDrop = debianBaseInstallerBeaconDrop(beaconSerial);
  // Final SUCCESS beacon — emitted at the END of late_command, AFTER the
  // first-boot bootstrap succeeds, but BEFORE the box powers off (this preseed
  // sets debian-installer/exit/poweroff). It is NOT success: the install
  // completed but the box has not registered — it powered off awaiting the user
  // to unplug the USB + power back on (registration + cert happen on the first
  // real boot → `live`). Emitted on the success branch ONLY (the failure branch
  // posts the dev late-log + exits 1, never this).
  const installedBeacon = debianBeaconCommand("installed", beaconSerial);
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
    ? debianCryptoStorageBlock(partitionBeacon, installingDrop)
    : debianPlainStorageBlock(partitionBeacon, installingDrop);

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
  // (the runtime-detected netplan needs it) — matches the Ubuntu path. PLUS the
  // non-free Wi-Fi firmware: the Debian INSTALLER ships firmware (so Wi-Fi works
  // during install), but unless we explicitly install it into the target the
  // installed system + the initramfs boot with NO radio firmware — the box then
  // installs/registers/seals fine yet can't bring Wi-Fi up at the LUKS unlock OR
  // for the first-boot daemon. apt-setup/non-free-firmware is enabled below, so
  // these resolve from the non-free-firmware component; explicit in pkgsel/include
  // so install-recommends=false can't drop them. Broad consumer set (Intel /
  // Realtek / Atheros-Qualcomm / Broadcom / misc incl. Mediatek) — chip-agnostic.
  const wifiPackagesBlock = hasWifi
    ? " wpasupplicant firmware-iwlwifi firmware-realtek firmware-atheros firmware-brcm80211 firmware-misc-nonfree"
    : "";
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
    // Beacon B — network is guaranteed up by late_command; ping home that the
    // installer is running, before the blob-decode + bootstrap. Best-effort.
    `${stopInstallerTelemetry}; ${lateBeacon}; ` +
    `mkdir -p /target/var/flagship; ` +
    `echo '${blobB64}' | base64 -d > /target/var/flagship/install-blob.json; ` +
    `chmod 600 /target/var/flagship/install-blob.json; ` +
    `echo '${bootstrapB64}' | base64 -d > /target/usr/local/sbin/flagship-bootstrap.sh; ` +
    `chmod +x /target/usr/local/sbin/flagship-bootstrap.sh; ` +
    wifiLateCommand +
    // Run the first-boot bootstrap capturing its output to a log on the target.
    // On failure, POST the last 16 KB home to the dev late-log endpoint (so we
    // can read WHY it failed via R2 without a serial console / d-i shell), then
    // exit non-zero so d-i still flags the failure. Best-effort post (|| true
    // inside) never masks the real exit code.
    // On SUCCESS, fire the `installed` beacon (best-effort `|| true`, so it never
    // blocks the imminent poweroff and never trips the failure branch). On
    // FAILURE, POST the last 16 KB to the dev late-log and exit 1.
    `( in-target /usr/local/sbin/flagship-bootstrap.sh > /target/var/log/flagship-bootstrap.log 2>&1 ) && ` +
    `${installedBeacon} || ` +
    `( tail -c 16000 /target/var/log/flagship-bootstrap.log > /tmp/fb-bootstrap-tail.txt 2>/dev/null; ` +
    `wget -q -O- --post-file=/tmp/fb-bootstrap-tail.txt --timeout=20 https://flagshipserver.com/api/dev/late-log/${beaconSerial}-bootstrap 2>/dev/null; exit 1 )`;

  return `# Flagship Studio — debian-installer preseed
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

### Phone-home beacon A — the EARLIEST hook (runs before partman; the network
### may only just be coming up). Best-effort POST so the owner's phone sees the
### box the instant d-i starts. busybox wget (no curl in mini.iso d-i) needs
### --post-file=<path>, so we write the tiny JSON to /tmp first. Wrapped so a
### not-yet-up network never blocks the install.
d-i preseed/early_command string ${earlyBeacon}

### Mirror — pulled from the network (netinst has no full package set).
d-i mirror/country string manual
d-i mirror/http/hostname string deb.debian.org
d-i mirror/http/directory string /debian
d-i mirror/http/proxy string

### Account setup. Root login disabled; one admin user (matches Ubuntu's
### autoinstall identity). Its password is LOCKED — "*" is the conventional
### /etc/shadow "no valid password, login disabled" marker (d-i writes the crypt
### field verbatim and no hashed input can ever match it). There is NO committed
### crypt hash on the image, so the flagship account exists (for its sudo
### membership + the dev SSH stub) but CANNOT be logged into by password; with
### root login off and no authorized_keys installed in production, the box has no
### interactive console/SSH login by any path. The sanctioned debug path is
### 100% runtime + owner-grant-gated (the daemon's debugAccessGate provisions its
### OWN 'debug' user on a verified owner-IRK grant) and is unaffected by this lock.
d-i passwd/root-login boolean false
d-i passwd/make-user boolean true
d-i passwd/user-fullname string Flagship
d-i passwd/username string flagship
d-i passwd/user-password-crypted password *
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
# A USB netinst booted as a CD-ROM loses its /media/cdrom mount by
# finish-install; with the firmware netinst, apt-setup then re-scans for the
# disc and loops forever on "please insert the disc". Force the network mirror
# and never expect/scan the install CD again (it's already configured above).
d-i apt-setup/use_mirror boolean true
d-i apt-setup/cdrom/set-first boolean false
d-i apt-setup/cdrom/set-next boolean false
d-i apt-setup/cdrom/set-failed boolean false
d-i cdrom-detect/eject boolean false

### Packages. Debian names for the bootstrap's deps (Node 20 itself comes from
### the bootstrap's NodeSource one-liner, reused verbatim from the Ubuntu path).
tasksel tasksel/first multiselect standard, ssh-server
d-i pkgsel/include string git curl jq ca-certificates xxd cryptsetup cryptsetup-initramfs lvm2 gnupg openssl${wifiPackagesBlock}
d-i pkgsel/upgrade select none
popularity-contest popularity-contest/participate boolean false

### Bootloader — THE WHOLE POINT OF THE DEBIAN PATH.
# Install GRUB to the disk, no other-OS probing. The static default is only a
# fallback: partman/early_command replaces it with the same resolved fixed disk
# used for partitioning. This matters when the installer is USB /dev/sda and
# the real target is virtio /dev/vda (macOS VZ); Debian otherwise chooses the
# ISO and fails at grub-install /dev/sda after the whole base install.
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
# arm64 twin (VM-hosted guests on Apple-silicon / arm64 KVM hosts). Preseeding
# a question owned by a package the arch never installs is a no-op, so this is
# inert on amd64 and load-bearing on arm64 (there /EFI/BOOT/BOOTAA64.EFI).
grub-efi-arm64 grub2/force_efi_extra_removable boolean true
# Belt + suspenders for the firmware that also rejects the os-prober/efibootmgr
# NVRAM write outright: tell grub-installer not to touch NVRAM at all.
d-i grub-installer/update-nvram boolean false

### Finish — POWER OFF after install instead of rebooting. A reboot with the
### USB still plugged re-enters the installer (the firmware boots the USB's
### removable-media EFI first, and we don't write NVRAM). Powering off removes
### that race entirely: the box turns itself off = "done" — the user unplugs
### the USB and powers it on, which boots the installed disk → first real boot
### → auto-unlock → register → cert.
d-i finish-install/keep-consoles boolean true
d-i finish-install/reboot_in_progress note
d-i debian-installer/exit/poweroff boolean true

### First-boot bootstrap — the same install-blob + bootstrap the Ubuntu path
### writes, run in the installed target (d-i in-target == curtin in-target).
d-i preseed/late_command string ${lateCommand}
`;
}

/**
 * Unconditional wipe of the resolved target disk, run inside partman/early_command
 * right after DISK is chosen and BEFORE partman probes it. Zeroing the GPT (the
 * front 16 MB primary header/table + the 8192-sector backup header at the tail)
 * and rereadpt makes partman see a blank disk, so a prior install's stale
 * encrypted VG / LUKS / GPT can't be probed (the real "volume group with no
 * physical volume" partman failure on a repurposed disk). dmsetup remove_all
 * first clears any active device-mapper mappings carried over from a prior boot.
 * INTENTIONAL + UNCONDITIONAL: the builder is plug-and-play and the user already
 * consented to a destructive install. Every sub-command is guarded (`|| true`)
 * so it can never abort the install; dmsetup/dd/blockdev all exist in the d-i env.
 */
/**
 * Resolve the install TARGET disk to the LARGEST NON-REMOVABLE block device,
 * run inside partman/early_command BEFORE the wipe/partition. The naive
 * `list-devices disk | head -n1` picked the first-ENUMERATED device, which on
 * any box with a USB installer stick + an internal disk is the WRONG one: the
 * USB device commonly sorts first (e.g. the Mac VZHost attaches the virtio main
 * disk as vda and the USB ISO as sda — sda sorts before vda), so partman tried
 * to partition the ~755 MB installer stick and aborted ("failed to partition:
 * too small"). Bare-metal with a USB stick + an internal disk hits the identical
 * trap. Selecting the largest FIXED disk is robust for both: the installer
 * medium is tiny relative to a real disk, and removable media is excluded
 * outright. `/sys/block/<name>/removable` is 1 for removable media; `/size` is
 * in 512-byte sectors. Falls back to the old first-enumerated pick only if the
 * scan finds nothing (degenerate single-disk case). The Ubuntu/curtin path
 * already selects `match: {size: largest}`, so this brings d-i to parity.
 */
const resolveTargetDisk =
  `DISK=""; _best=0; ` +
  `for _d in $(list-devices disk); do ` +
  `_n=\${_d##*/}; ` +
  `[ "$(cat /sys/block/$_n/removable 2>/dev/null || echo 0)" = 1 ] && continue; ` +
  `_s=$(cat /sys/block/$_n/size 2>/dev/null || echo 0); ` +
  `[ "$_s" -gt "$_best" ] && { _best=$_s; DISK=$_d; }; ` +
  `done; ` +
  `[ -n "$DISK" ] || DISK=$(list-devices disk | head -n1)`;

const wipeTargetDisk =
  `dmsetup remove_all 2>/dev/null || true; ` +
  `dd if=/dev/zero of="$DISK" bs=1M count=16 2>/dev/null || true; ` +
  `SZ=$(blockdev --getsz "$DISK" 2>/dev/null || echo 0); ` +
  `[ "$SZ" -gt 8192 ] && dd if=/dev/zero of="$DISK" bs=512 seek=$((SZ-8192)) count=8192 2>/dev/null || true; ` +
  `blockdev --rereadpt "$DISK" 2>/dev/null || true`;

/**
 * The partman/early_command line shared by both storage variants: resolve the
 * target disk, set it for BOTH partman and GRUB, phone home (network is up by
 * partman), then wipe it, then drop the Beacon E base-installer.d script. GRUB
 * performs its own disk selection later and otherwise picks the USB ISO
 * (`/dev/sda`) instead of the already-partitioned virtio disk (`/dev/vda`).
 * The preseed `\`-continuation
 * style is kept (each logical step on its own line).
 */
function partmanEarlyCommand(partitionBeacon: string, installingDrop: string): string {
  return (
    `d-i partman/early_command string \\\n` +
    `  ${resolveTargetDisk}; debconf-set partman-auto/disk "$DISK"; debconf-set grub-installer/bootdev "$DISK"; \\\n` +
    `  ${partitionBeacon}; \\\n` +
    `  ${wipeTargetDisk}; \\\n` +
    `  ${installingDrop}`
  );
}

/**
 * Beacon E dropper, appended to partman/early_command. Writes a tiny executable
 * into /usr/lib/base-installer.d/ (the d-i hook dir base-installer runs right
 * after partitioning, e.g. hw-detect's 50install-firmware) that POSTs the
 * canonical `installing` phase with a privacy-safe, allowlisted d-i stage and
 * elapsed minutes. It reports on stage changes and every two minutes, so a
 * prompt or package deadlock is distinguishable from a dead VM without
 * uploading raw syslog (which can contain recipe material). The watcher is
 * backgrounded and always exits zero, so telemetry can never gate the install.
 */
function debianBaseInstallerBeaconDrop(serial: string): string {
  const scriptB64 = utf8ToBase64(debianInstallerTelemetryScript(serial));
  const launcherB64 = utf8ToBase64(`#!/bin/sh
if command -v setsid >/dev/null 2>&1; then
  setsid /bin/sh /tmp/flagship-installer-telemetry.sh </dev/null >/dev/null 2>&1 &
else
  ( trap '' HUP; /bin/sh /tmp/flagship-installer-telemetry.sh </dev/null >/dev/null 2>&1 ) &
fi
echo $! > /tmp/flagship-installer-telemetry.pid
exit 0
`);
  return (
    `( mkdir -p /usr/lib/base-installer.d; ` +
    `echo '${scriptB64}' | base64 -d > /tmp/flagship-installer-telemetry.sh; ` +
    `chmod +x /tmp/flagship-installer-telemetry.sh; ` +
    `echo '${launcherB64}' | base64 -d > /usr/lib/base-installer.d/05flagship-beacon; ` +
    `chmod +x /usr/lib/base-installer.d/05flagship-beacon ) || true`
  );
}

/**
 * A secret-free d-i progress watcher. It never sends log text: only one of the
 * fixed labels below plus an integer minute count. `main-menu` selections are
 * monotonic, so testing the later components first recovers the current stage
 * from the accumulated syslog without parsing package names or user inputs.
 */
function debianInstallerTelemetryScript(serial: string): string {
  return `#!/bin/sh
STATUS_URL='https://flagshipserver.com/api/order/${serial}/status'
_started=$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0)
_last_stage=''
_last_report=0
while [ ! -e /tmp/flagship-installer-telemetry.done ]; do
  _now=$(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0)
  _minutes=$(( (_now - _started) / 60 ))
  _stage='Installing Debian base system'
  if grep -q "Menu item 'finish-install' selected" /var/log/syslog 2>/dev/null; then
    _stage='Finishing the operating-system install'
  elif grep -q "Menu item 'grub-installer' selected" /var/log/syslog 2>/dev/null; then
    _stage='Installing the bootloader'
  elif grep -q "Menu item 'pkgsel' selected" /var/log/syslog 2>/dev/null; then
    _stage='Installing system packages'
  elif grep -q "Menu item 'apt-setup' selected" /var/log/syslog 2>/dev/null; then
    _stage='Configuring the Debian package source'
  elif grep -q 'debootstrap:.*Configuring' /var/log/syslog 2>/dev/null; then
    _stage='Configuring the Debian base system'
  elif grep -q 'debootstrap:.*Unpacking' /var/log/syslog 2>/dev/null; then
    _stage='Unpacking the Debian base system'
  elif grep -q 'debootstrap:.*Extracting' /var/log/syslog 2>/dev/null; then
    _stage='Extracting the Debian base system'
  elif grep -q 'debootstrap:.*Validating' /var/log/syslog 2>/dev/null; then
    _stage='Verifying Debian base packages'
  elif grep -q 'debootstrap:.*Retrieving' /var/log/syslog 2>/dev/null; then
    _stage='Downloading Debian base packages'
  fi
  if [ "$_stage" != "$_last_stage" ] || [ $(( _now - _last_report )) -ge 120 ]; then
    printf '{"phase":"installing","detail":"%s (%s min)"}\n' "$_stage" "$_minutes" > /tmp/flagship-beacon.json
    wget -q -O- --post-file=/tmp/flagship-beacon.json --timeout=15 "$STATUS_URL" >/dev/null 2>&1 || true
    _last_stage="$_stage"
    _last_report=$_now
  fi
  sleep 15
done
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
function debianCryptoStorageBlock(partitionBeacon: string, installingDrop: string): string {
  return `### Partitioning — EXPERIMENTAL LVM-on-LUKS (the locked encrypted default).
# partman-crypto only reliably preseeds LVM-on-LUKS: unencrypted ESP + /boot,
# then a LUKS container holding one VG (flagship) with a single root LV.
d-i partman-auto/method string crypto
d-i partman-auto/disk string /dev/sda /dev/vda /dev/nvme0n1
${partmanEarlyCommand(partitionBeacon, installingDrop)}
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
function debianPlainStorageBlock(partitionBeacon: string, installingDrop: string): string {
  return `### Partitioning — DEBUG ESCAPE: plain (unencrypted) ESP + /boot + ext4 root.
# Not exposed in the CLI/GUI; reproduces a known-good non-LUKS baseline.
d-i partman-auto/method string regular
d-i partman-auto/disk string /dev/sda /dev/vda /dev/nvme0n1
${partmanEarlyCommand(partitionBeacon, installingDrop)}
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
d-i partman/confirm_nooverwrite boolean true
# No swap partition in this recipe — auto-answer the "no swap space, return to
# the partitioning menu?" prompt with No (proceed). The crypto recipe carries
# the same line; the plain recipe was missing it (the no-LUKS box stopped here).
d-i partman-basicfilesystems/no_swap boolean false
# Authorize partman to steamroll a prior install's LVM/crypto instead of
# stalling (the proven cloud preseed carries these; the builder was missing them).
d-i partman-lvm/confirm boolean true
d-i partman-lvm/confirm_nooverwrite boolean true
d-i partman-crypto/confirm boolean true
d-i partman-crypto/confirm_nooverwrite boolean true`;
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

/**
 * Sanitize a value that gets inlined, unquoted, into a beacon URL or a
 * single-quoted JSON literal. Strips everything outside [A-Za-z0-9._:-] —
 * enough for an auth-code serial (`^[A-Za-z0-9_-]{8,64}$`) and an FQDN, and
 * injection-proof for the shell/JSON contexts the beacon command builds.
 */
function beaconSafe(s: string): string {
  return s.replace(/[^A-Za-z0-9._:-]/g, "");
}

/**
 * A best-effort phone-home beacon for the d-i environment, POSTing a canonical
 * provisioning PHASE to the single order-status channel
 * (POST /api/order/<serial>/status). Writes the tiny JSON body to /tmp (busybox
 * wget POST needs `--post-file=<path>`, not stdin — and mini.iso d-i has NO
 * curl, only busybox wget) then POSTs it. HTTPS works against d-i's bundled CA
 * bundle. Wrapped in `( … ) || true` so a down/just-coming-up network never
 * blocks the install. SECRET-FREE: only the serial (in the URL) + the phase
 * name. Host stays flagshipserver.com — it IS the control plane that owns the
 * order-status route.
 *
 * BYTE-IDENTICAL CONTRACT: this exact string is mirrored by the Swift twin
 * (apps/builder-mac UserData.debianBeaconCommand). Keep both in lockstep.
 */
function debianBeaconCommand(phase: ProvisionStatusPhase, serial: string): string {
  return (
    `( echo '{"phase":"${phase}"}' > /tmp/flagship-beacon.json; ` +
    `wget -q -O- --post-file=/tmp/flagship-beacon.json --timeout=15 ` +
    `https://flagshipserver.com/api/order/${serial}/status ) || true`
  );
}
