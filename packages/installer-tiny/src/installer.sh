#!/bin/sh
# Flagship tiny live installer — the live-OS install script.
#
# WHAT THIS IS
# ------------
# This runs inside a tiny live Linux (Alpine LTS netboot kernel + initramfs,
# see docs/installer-tiny.md for the base evaluation). It is the modern
# replacement for the Debian-netinst (d-i) preseed: instead of an opaque
# chroot where every failure costs a USB reflash, we drive every step
# ourselves from a real shell and report granular progress to the order's
# status channel.
#
# It is a ONE-SHOT, RAM-based INITIATOR (owner-locked design decision):
# it installs Alpine -lts onto encrypted LVM, lights up the phone EARLY,
# verifies the installed disk is genuinely bootable, then SELF-WIPES the USB
# boot signature and points the firmware at the internal disk so there is no
# reboot-into-installer loop. Apps run as Docker containers after install
# (first-boot provisioning unit — out of scope here).
#
# DIVISION OF LABOUR (the key architectural insight)
# --------------------------------------------------
# The LIVE installer does ONLY the light, deterministic work that needs no
# package manager and no monorepo build:
#   1. network (baked Wi-Fi via wpa_supplicant, else DHCP) -> EARLIEST PING
#   2. partition: bios_grub + ESP + /boot + LUKS -> LVM (vg "flagship", lv "root")
#   3. lay down + CONFIGURE a base OS onto the encrypted root (apk --root):
#      fstab, hostname, crypttab, network/OpenRC, root setup, LUKS-aware initramfs
#   4. drop the first-boot provisioning unit + the recipe + status creds
#   5. install GRUB (BIOS + UEFI), VERIFY the disk is bootable, then SELF-WIPE
#      the USB + efibootmgr the internal disk first, reboot
#
# The HEAVY work (node, `npm install`, `tsc -b`, gen-identity, mint-entitlements,
# register, seal LUKS key) runs FIRST-BOOT on the INSTALLED OS, which has its
# own package manager. That is what makes the live installer tiny: NO node here.
# The proven first-boot sequence is lifted verbatim from
# packages/flagship-burner/src/userdata.ts (the d-i bootstrap), which we ran
# live over SSH on a real box.
#
# This file is QEMU-validated: the partition / luks / base-lay-down / GRUB /
# boot-into-installed-Alpine path is proven in a VM (see docs/installer-tiny.md
# §3). Disk-mutating phases are guarded by FLAGSHIP_DRY_RUN so the dry-run PoC
# can walk the whole flow without a target disk; the self-wipe + efibootmgr
# decision logic is success-gated and unit-tested.
set -eu

# ---------------------------------------------------------------------------
# Config — baked by the burner into /flagship/installer.env on the live media,
# or passed on the kernel cmdline. The recipe (signed InstallBlob) is at
# /flagship/install-blob.json; its signature at /flagship/install-blob.sig.
# ---------------------------------------------------------------------------
FLAGSHIP_DIR="${FLAGSHIP_DIR:-/flagship}"
ENV_FILE="$FLAGSHIP_DIR/installer.env"
[ -r "$ENV_FILE" ] && . "$ENV_FILE"

BLOB_JSON="${BLOB_JSON:-$FLAGSHIP_DIR/install-blob.json}"
# The 64-byte Ed25519 recipe signature. Either a raw 64-byte file here, or the
# `blobSignatureHex` field inside the recipe JSON (the burner may write either).
# The signature is verified against the IRK pubkey EMBEDDED in the recipe as
# authCode.userPubKey — install blobs are signed by the owner's phone-held IRK,
# NOT by any global key (so there is no "genesis pubkey" to bake). See
# verify_recipe_signature().
BLOB_SIG="${BLOB_SIG:-$FLAGSHIP_DIR/install-blob.sig}"
GIT_REF="${GIT_REF:-main}"
REPO_URL="${REPO_URL:-https://github.com/ibisllc/flagship.git}"
CONTROL_PLANE_BASE="${CONTROL_PLANE_BASE:-https://flagshipserver.com}"
HOSTNAME_DEFAULT="${HOSTNAME_DEFAULT:-flagship}"
# Curated firmware subset for commodity hardware (see docs eval). Each is an
# Alpine subpackage so the total stays ~50-150MB, not the ~1GB full set.
FW_PACKAGES="${FW_PACKAGES:-linux-firmware-intel linux-firmware-rtw88 linux-firmware-rtw89 linux-firmware-iwlwifi linux-firmware-rtl_nic linux-firmware-ath10k linux-firmware-ath11k linux-firmware-amdgpu linux-firmware-i915 linux-firmware-other}"
# Wi-Fi (burn-time only; never part of the signed blob). Empty => wired DHCP only.
WIFI_SSID="${WIFI_SSID:-}"
WIFI_PSK="${WIFI_PSK:-}"
# Dry-run lets the QEMU PoC walk the whole flow without a real install target.
FLAGSHIP_DRY_RUN="${FLAGSHIP_DRY_RUN:-0}"
# Reproducible mtimes for anything we generate on the installed FS.
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}"

LOG="${FLAGSHIP_LOG:-/var/log/flagship-install.log}"
# Skip the live-install logging plumbing when invoked as the standalone
# `verify-recipe` subcommand (unit test / pre-flight check) — that path must
# leave stdout untouched and not write to /var/log.
if [ "${1:-}" != "verify-recipe" ]; then
    mkdir -p "$(dirname "$LOG")" "$FLAGSHIP_DIR" 2>/dev/null || true
    # Tee everything to console + log so a hung install is debuggable live. POSIX
    # (busybox ash) has no process substitution, so we use a FIFO + a background
    # tee. The console fd is captured first so tee can still reach the screen after
    # we redirect our own stdout into the pipe.
    _logpipe=/run/flagship-install.pipe
    if command -v mkfifo >/dev/null 2>&1 && (mkfifo "$_logpipe" 2>/dev/null || [ -p "$_logpipe" ]); then
        tee -a "$LOG" < "$_logpipe" > /dev/console 2>&1 &
        exec > "$_logpipe" 2>&1
    else
        exec >>"$LOG" 2>&1
    fi
fi

log() { echo "[flagship-installer] $*"; }

# ---------------------------------------------------------------------------
# Status channel: POST {phase} to /api/order/<serial>/status. A failed report
# NEVER fails the install (the box may be offline mid-install). Mirrors the
# report_phase() in userdata.ts so the phone timeline is identical across the
# d-i path and this path.
# ---------------------------------------------------------------------------
SERIAL=""
read_serial() {
    # The serial is the auth-code serial inside the recipe; jq isn't in the
    # tiny base, so we grep it. The blob is small, trusted JSON.
    SERIAL="$(sed -n 's/.*"serial"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$BLOB_JSON" 2>/dev/null | head -1)"
}
report_phase() {
    [ -n "$SERIAL" ] || return 0
    curl -fsS -m 8 -X POST -H 'content-type: application/json' \
        --data '{"phase":"'"$1"'"'"${2:+,\"detail\":\"$2\"}"'}' \
        "$CONTROL_PLANE_BASE/api/order/$SERIAL/status" >/dev/null 2>&1 || true
}
fail() { log "FATAL: $*"; report_phase error "$*"; exit 1; }

# ===========================================================================
# Recipe-signature verification (ARMED, fail-closed).
#
# The InstallBlob is signed by the owner's phone-held IRK; the 64-byte Ed25519
# signature is over canonicalInstallBlob() (packages/protocol/src/auth.ts) and
# is verified here against the IRK pubkey EMBEDDED in the recipe as
# authCode.userPubKey — exactly what packages/iso-personalizer/src/trailer.ts
# (parseTrailer) does. There is NO global "genesis" key for install blobs.
#
# This reconstructs the CURRENT v2 canonical string. Note
# packages/installer-netboot/parse-trailer.sh is the lineage of the openssl
# trick below but carries a STALE v1 string (…|issuedAt|expiresAt) — do NOT copy
# it. v2 is: TAG|2|serverDomain|username|serverName|phoneDelegatedPubKey|
# registrationUrl|authCode.serial|userPubKey|authCodeUserSignature|
# installerGitRef|rckPubKey (bootUnlockMode is not serialized by
# installBlobToJson, so it is absent here too).
#
# The real trust gate is .com registration matching the user's recorded IRK;
# this check is defense-in-depth so a compromised network/control-plane cannot
# tamper recipe fields (gitRef, serverDomain, rckPubKey, …) between phone and
# box. Fail CLOSED: abort before any disk is touched if the signature is absent
# or does not verify.
#
# Tooling: openssl (Ed25519 via the SPKI-wrap trick), jq (field extraction),
# xxd (hex→DER). All are apk-added in phase_download, so this MUST run after
# download and before phase_partition (no signed field trusted / no disk written
# before it). Callable standalone for testing: `installer.sh verify-recipe
# <blob.json> [sig-file]`.
# ===========================================================================
verify_recipe_signature() {
    if [ "$FLAGSHIP_DRY_RUN" = "1" ]; then
        log "  recipe signature verify: SKIPPED (dry-run PoC — no real recipe)"
        return 0
    fi
    [ -r "$BLOB_JSON" ] || fail "recipe not found at $BLOB_JSON"
    for t in openssl jq xxd; do
        command -v "$t" >/dev/null 2>&1 || fail "recipe verify needs '$t' (apk add it in phase_download)"
    done

    _vdir="$(mktemp -d 2>/dev/null)" || fail "mktemp -d failed for recipe verify"

    _ver="$(jq -r '.version' "$BLOB_JSON" 2>/dev/null)"
    [ "$_ver" = "2" ] || { rm -rf "$_vdir"; fail "unsupported InstallBlob version: ${_ver:-<none>} (expected 2)"; }
    _sd="$(jq -r '.serverDomain' "$BLOB_JSON")"
    _un="$(jq -r '.username' "$BLOB_JSON")"
    _sn="$(jq -r '.serverName' "$BLOB_JSON")"
    _pd="$(jq -r '.phoneDelegatedPubKey' "$BLOB_JSON")"
    _ru="$(jq -r '.registrationUrl' "$BLOB_JSON")"
    _ser="$(jq -r '.authCode.serial' "$BLOB_JSON")"
    _upk="$(jq -r '.authCode.userPubKey' "$BLOB_JSON")"
    _acs="$(jq -r '.authCodeUserSignature' "$BLOB_JSON")"
    _gr="$(jq -r '.installerGitRef' "$BLOB_JSON")"
    _rck="$(jq -r '.rckPubKey' "$BLOB_JSON")"
    # The signer's pubkey must be 32-byte hex; the rest is integrity-checked by
    # the signature itself (a tampered/empty field simply fails verification).
    [ "${#_upk}" = "64" ] || { rm -rf "$_vdir"; fail "authCode.userPubKey is not 32-byte hex"; }

    # Reconstruct canonicalInstallBlob bytes — MUST byte-match auth.ts. No
    # trailing newline (printf %s); parts joined by '|'.
    _canon="flagship/install-blob/v1|2|$_sd|$_un|$_sn|$_pd|$_ru|$_ser|$_upk|$_acs|$_gr|$_rck"
    printf '%s' "$_canon" > "$_vdir/canonical.bin"

    # Signature bytes: prefer a raw 64-byte $BLOB_SIG file; else blobSignatureHex.
    if [ -r "$BLOB_SIG" ] && [ "$(wc -c < "$BLOB_SIG" | tr -d ' ')" = "64" ]; then
        cp "$BLOB_SIG" "$_vdir/sig.bin"
    else
        _sighex="$(jq -r '.blobSignatureHex // .blobSignature // empty' "$BLOB_JSON")"
        { [ -n "$_sighex" ] && [ "${#_sighex}" = "128" ]; } || { rm -rf "$_vdir"; fail "recipe has no 64-byte signature ($BLOB_SIG file or blobSignatureHex field)"; }
        printf '%s' "$_sighex" | xxd -r -p > "$_vdir/sig.bin"
    fi
    [ "$(wc -c < "$_vdir/sig.bin" | tr -d ' ')" = "64" ] || { rm -rf "$_vdir"; fail "recipe signature is not 64 bytes"; }

    # SPKI-wrap the raw Ed25519 pubkey (constant 12-byte prefix) → DER → PEM,
    # then openssl rawin verify (openssl wants an SPKI key, not the raw 32 bytes).
    printf '%s%s' "302a300506032b6570032100" "$_upk" | xxd -r -p > "$_vdir/pub.der"
    {
        echo "-----BEGIN PUBLIC KEY-----"
        base64 < "$_vdir/pub.der" | tr -d '\n'; echo
        echo "-----END PUBLIC KEY-----"
    } > "$_vdir/pub.pem"

    if openssl pkeyutl -verify -rawin -pubin -inkey "$_vdir/pub.pem" \
            -sigfile "$_vdir/sig.bin" -in "$_vdir/canonical.bin" >/dev/null 2>&1; then
        rm -rf "$_vdir"
        log "  recipe signature verify: OK (Ed25519 over canonical v2 blob, under authCode.userPubKey)"
        return 0
    fi
    rm -rf "$_vdir"
    fail "recipe Ed25519 signature does NOT verify under authCode.userPubKey — refusing to install"
}

# ===========================================================================
# PHASE: booting — the live OS is up; verify our tools + the recipe.
# ===========================================================================
# The install tools the LIVE installer needs. They are NOT in the stock Alpine
# base — phase_download apk-adds them — so phase_boot only REPORTS their absence;
# require_tools() is the fail-closed gate, called at the END of phase_download.
# node is deliberately absent (it runs first-boot on the installed OS).
REQUIRED_LIVE_TOOLS="cryptsetup pvcreate vgcreate lvcreate sgdisk mkfs.ext4 mkfs.vfat curl openssl jq xxd"
phase_boot() {
    log "phase: booting"
    read_serial
    log "recipe serial=${SERIAL:-<none>}"
    # Informational only — these arrive in phase_download (see require_tools()).
    for t in $REQUIRED_LIVE_TOOLS; do
        command -v "$t" >/dev/null 2>&1 && log "  tool present: $t" || log "  tool (added at download): $t"
    done
    [ -r "$BLOB_JSON" ] || { [ "$FLAGSHIP_DRY_RUN" = "1" ] || fail "no recipe at $BLOB_JSON"; }
    # NB: the cryptographic recipe-signature check runs AFTER phase_download
    # (which apk-adds openssl/jq/xxd) and BEFORE phase_partition — see main().
}

# Fail-closed tool gate, run after phase_download has installed the set.
require_tools() {
    [ "$FLAGSHIP_DRY_RUN" = "1" ] && return 0
    for t in $REQUIRED_LIVE_TOOLS; do
        command -v "$t" >/dev/null 2>&1 || fail "required tool missing after download: $t"
    done
    log "  all required live-installer tools present"
}

# ===========================================================================
# PHASE: network — bring the box online, then IMMEDIATELY light up the phone.
# This is the EARLIEST possible signal: the very first thing we do after the
# link is up is report the `booting` phase, so the owner's phone reacts the
# moment the box has connectivity — before the (slower) apk download, before
# any disk work. Per the agreed UX, nothing else happens before this ping.
# ===========================================================================
network_up=0
phase_network() {
    log "phase: network (bring link up, then earliest ping)"
    if [ "$FLAGSHIP_DRY_RUN" = "1" ]; then
        log "  DRY_RUN: would 'setup-interfaces -a; udhcpc -i eth0; [bake_wifi]'"
        log "  DRY_RUN: EARLIEST PING -> report_phase booting (the moment network is up)"
        report_phase booting
        return 0
    fi
    setup-interfaces -a 2>/dev/null || true   # bring NICs up (Alpine helper)
    udhcpc -i eth0 2>/dev/null || true
    bake_wifi
    # Wait briefly for a default route (DHCP can lag the link). Bounded so an
    # offline install still proceeds (the phone simply lights up later).
    i=0; while [ "$i" -lt 15 ]; do
        if ip route 2>/dev/null | grep -q '^default'; then network_up=1; break; fi
        sleep 1; i=$((i+1))
    done
    [ "$network_up" = "1" ] && log "  network up (default route present)" || log "  no default route yet; continuing offline"
    # EARLIEST PING: the first thing after the link — phone lights up now.
    report_phase booting
}

bake_wifi() {
    [ -n "$WIFI_SSID" ] || return 0
    log "  joining Wi-Fi SSID=$WIFI_SSID"
    apk add wpa_supplicant 2>/dev/null || true
    wpa_passphrase "$WIFI_SSID" "$WIFI_PSK" > /etc/wpa_supplicant/wpa_supplicant.conf 2>/dev/null || true
    wpa_supplicant -B -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf 2>/dev/null || true
    udhcpc -i wlan0 2>/dev/null || true
}

# ===========================================================================
# PHASE: downloading — pull the install tools + curated firmware via apk.
# The netboot initramfs ships only busybox + apk; cryptsetup/lvm/parted/curl
# and the firmware subset come from here. This is the ONLY network-heavy step
# in the live installer and it is bounded (~50-150MB, not node's hundreds).
# ===========================================================================
phase_download() {
    log "phase: downloading (apk add install tools + curated firmware)"
    report_phase downloading
    if [ "$FLAGSHIP_DRY_RUN" = "1" ]; then
        log "  DRY_RUN: would 'apk add cryptsetup lvm2 sgdisk dosfstools e2fsprogs curl ca-certificates efibootmgr openssl jq xxd $FW_PACKAGES'"
        return 0
    fi
    # Pick the fastest mirror (QEMU-validated: 'apk add' fails if the repo list
    # only has the cdrom; setup-apkrepos -1 writes a working network mirror) and
    # enable community (sgdisk lives there). Both confirmed live in the PoC.
    setup-apkrepos -1 2>/dev/null || true
    sed -i 's|^#\(.*/community\)|\1|' /etc/apk/repositories 2>/dev/null || true
    apk update
    # openssl/jq/xxd are needed by verify_recipe_signature, which runs right
    # after this phase (before any disk write).
    apk add cryptsetup lvm2 sgdisk partx dosfstools e2fsprogs curl ca-certificates efibootmgr \
        openssl jq xxd \
        $FW_PACKAGES || fail "apk add of install tools failed"
    # Fail-closed: every required tool must now resolve before we touch a disk.
    require_tools
}

# ===========================================================================
# PHASE: partitioning — the proven layout from installer/install.sh, extended
# to LVM (vg "flagship") so root can grow / add lvs later:
#   p1 bios_grub (1MiB, BIOS GRUB stage-1.5)   -> no fs
#   p2 ESP       (256MiB, FAT32, UEFI)         -> label not applicable
#   p3 /boot     (512MiB, ext4)                -> label FLAGSHIP_BOOT
#   p4 LUKS2     (rest) -> LVM PV -> vg flagship -> lv root (ext4)
#                                                 -> label FLAGSHIP_ROOT
# ===========================================================================
TARGET=""
USB_DEV=""
select_target() {
    # First fixed disk >= 8GiB that isn't the live USB. Mirrors install.sh.
    # Also note the USB we booted from so the success self-wipe can target it.
    detect_usb_dev
    for d in /dev/nvme0n1 /dev/sda /dev/vda /dev/mmcblk0; do
        [ -b "$d" ] || continue
        [ "$d" = "$USB_DEV" ] && continue
        sz=$(blockdev --getsize64 "$d" 2>/dev/null || echo 0)
        [ "$sz" -ge $((8 * 1024 * 1024 * 1024)) ] || continue
        TARGET="$d"; break
    done
}
detect_usb_dev() {
    # The live media is whatever block device backs the mounted boot media
    # (Alpine mounts it at /media/<dev> or /.modloop's parent). Best-effort:
    # resolve the source of the modloop/cdrom mount to its parent disk.
    # Guarded so a missing /proc/mounts (non-Linux dev box) can't trip set -e.
    src=""
    if [ -r /proc/mounts ]; then
        src="$(awk '$2 ~ /^\/media\// {print $1; exit}' /proc/mounts 2>/dev/null || true)"
    fi
    case "$src" in
        /dev/*) USB_DEV="$(echo "$src" | sed 's/[0-9]*$//; s/p$//')";;
    esac
    [ -n "$USB_DEV" ] && log "  live USB detected: $USB_DEV (will self-wipe on success)" || log "  live USB not auto-detected"
}
part_suffix() { case "$1" in *nvme*|*mmc*) echo "p";; *) echo "";; esac; }

phase_partition() {
    log "phase: partitioning"
    report_phase partitioning
    select_target
    if [ "$FLAGSHIP_DRY_RUN" = "1" ]; then
        log "  DRY_RUN: target=${TARGET:-<none, ok in PoC>}; would lay down bios_grub+ESP+/boot+LUKS->LVM"
        log "  DRY_RUN: sgdisk -Z; sgdisk -n1:0:+1M -t1:ef02; -n2:0:+256M -t2:ef00; -n3:0:+512M; -n4:0:0 -t4:8309 \$TARGET"
        return 0
    fi
    [ -n "$TARGET" ] || fail "no install-target disk >= 8GiB"
    log "  target=$TARGET"
    s="$(part_suffix "$TARGET")"
    sgdisk -Z "$TARGET"
    sgdisk -n1:0:+1M   -t1:ef02 -c1:bios_grub "$TARGET"
    sgdisk -n2:0:+256M -t2:ef00 -c2:ESP       "$TARGET"
    sgdisk -n3:0:+512M -t3:8300 -c3:FLAGSHIP_BOOT "$TARGET"
    sgdisk -n4:0:0     -t4:8309 -c4:FLAGSHIP_ROOT_LUKS "$TARGET"
    # QEMU-validated: sgdisk writes the GPT but the kernel + mdev must re-read it
    # before the partition device nodes (/dev/vda4 ...) exist. partprobe ALONE was
    # not enough; partx -u forces the in-kernel re-read, then we wait for the node.
    partprobe "$TARGET" 2>/dev/null || blockdev --rereadpt "$TARGET" 2>/dev/null || true
    partx -u "$TARGET" 2>/dev/null || true
    mdev -s 2>/dev/null || true
    i=0; while [ ! -b "${TARGET}${s}4" ] && [ "$i" -lt 20 ]; do sleep 1; mdev -s 2>/dev/null; i=$((i+1)); done
    [ -b "${TARGET}${s}4" ] || fail "partition nodes did not appear after re-read"
    mkfs.vfat -F32 "${TARGET}${s}2"
    mkfs.ext4 -L FLAGSHIP_BOOT "${TARGET}${s}3"
}

# ===========================================================================
# PHASE: installing — LUKS-format p4, build LVM, lay down + CONFIGURE base OS.
# LUKS key is a random 64-byte file; first-boot seals it for the phone and
# uploads to .com (the .com-blind relay). Same construction as install.sh.
# ===========================================================================
LUKS_UUID=""
phase_install() {
    log "phase: installing (LUKS + LVM + base OS + configure)"
    report_phase installing
    if [ "$FLAGSHIP_DRY_RUN" = "1" ]; then
        log "  DRY_RUN: head -c64 /dev/urandom > key; cryptsetup luksFormat --type luks2 p4"
        log "  DRY_RUN: cryptsetup open p4 flagship_luks; pvcreate; vgcreate flagship; lvcreate -l100%FREE -n root flagship"
        log "  DRY_RUN: mkfs.ext4 -L FLAGSHIP_ROOT /dev/flagship/root; mount; apk --root /mnt add alpine-base ... (base OS)"
        log "  DRY_RUN: configure: fstab + hostname + crypttab + network/OpenRC + LUKS-aware initramfs + root setup"
        return 0
    fi
    s="$(part_suffix "$TARGET")"; LUKS_PART="${TARGET}${s}4"
    KEY=/run/flagship-luks.key
    head -c 64 /dev/urandom > "$KEY"; chmod 600 "$KEY"
    cryptsetup luksFormat --type luks2 --batch-mode --key-file "$KEY" "$LUKS_PART"
    cryptsetup open --key-file "$KEY" "$LUKS_PART" flagship_luks
    LUKS_UUID="$(cryptsetup luksUUID "$LUKS_PART" 2>/dev/null || blkid -s UUID -o value "$LUKS_PART")"
    pvcreate /dev/mapper/flagship_luks
    vgcreate flagship /dev/mapper/flagship_luks
    lvcreate -l 100%FREE -n root flagship
    mkfs.ext4 -L FLAGSHIP_ROOT /dev/flagship/root
    mkdir -p /mnt
    mount /dev/flagship/root /mnt
    mkdir -p /mnt/boot /mnt/boot/efi /mnt/flagship
    mount "${TARGET}${s}3" /mnt/boot
    mount "${TARGET}${s}2" /mnt/boot/efi
    # Lay down the base OS. Option A (chosen): apk --root installs a minimal
    # Alpine system that HAS a package manager for the first-boot heavy work.
    # Option B would be `dd` a prebuilt base image (faster, fixed size) — see
    # docs/installer-tiny.md trade-off. The package set mirrors install.sh's
    # apt set plus what the installed initramfs needs to unlock LUKS+LVM.
    apk --root /mnt --initdb add alpine-base alpine-conf linux-lts linux-firmware-none \
        openrc busybox busybox-suid mkinitfs \
        cryptsetup lvm2 e2fsprogs dosfstools \
        grub grub-bios grub-efi efibootmgr \
        nodejs npm git curl jq openssl ca-certificates \
        chrony openssh util-linux \
        $FW_PACKAGES || fail "base OS lay-down failed"
    # Persist the recipe + the LUKS key handoff material for first-boot.
    cp "$BLOB_JSON" /mnt/flagship/install-blob.json
    install -m 600 "$KEY" /mnt/flagship/luks.key
    configure_base_os "$KEY"
}

# ---------------------------------------------------------------------------
# Configure the freshly-laid-down base so it comes up HEADLESS on the encrypted
# disk: fstab, hostname, crypttab, network/OpenRC services, root setup, and a
# LUKS+LVM-aware initramfs. This is what install.sh did inline; pulled into its
# own function so the install/wipe sequencing reads cleanly and is testable.
# ---------------------------------------------------------------------------
configure_base_os() {
    _key="$1"
    log "  configuring base OS (fstab/hostname/crypttab/network/OpenRC/initramfs)"
    BOOT_UUID="$(blkid -s UUID -o value "${TARGET}$(part_suffix "$TARGET")3" 2>/dev/null || echo)"
    ESP_UUID="$(blkid -s UUID -o value "${TARGET}$(part_suffix "$TARGET")2" 2>/dev/null || echo)"

    # --- hostname ---
    echo "$HOSTNAME_DEFAULT" > /mnt/etc/hostname
    cat > /mnt/etc/hosts <<EOF
127.0.0.1   localhost localhost.localdomain $HOSTNAME_DEFAULT
::1         localhost localhost.localdomain $HOSTNAME_DEFAULT
EOF

    # --- fstab: root over LVM-over-LUKS, /boot + ESP by UUID ---
    cat > /mnt/etc/fstab <<EOF
/dev/flagship/root  /         ext4  rw,relatime  0 1
UUID=$BOOT_UUID     /boot     ext4  rw,relatime  0 2
UUID=$ESP_UUID      /boot/efi vfat  rw,relatime  0 2
tmpfs               /tmp      tmpfs rw,nosuid,nodev  0 0
EOF

    # --- crypttab: how the installed initramfs unlocks the root container ---
    # SEAM: on real hardware the per-boot key is fetched/relayed by
    # boot-stage.sh / the boot.flagshipserver.com relay (the box NEVER keeps a
    # plaintext key at rest in the production threat model). For a deterministic
    # bring-up — and for the QEMU "installed Alpine boots from disk" proof — we
    # stage the LUKS keyfile on the UNENCRYPTED /boot and reference it from
    # crypttab. The relay path replaces "keyfile on /boot" with "key fetched at
    # premount"; the crypttab/initramfs wiring is otherwise identical, which is
    # exactly why we wire it here.
    install -d -m 700 /mnt/boot/flagship
    install -m 600 "$_key" /mnt/boot/flagship/luks.key
    cat > /mnt/etc/crypttab <<EOF
# <name>        <device>            <key>                       <options>
flagship_luks   UUID=$LUKS_UUID     /boot/flagship/luks.key     luks
EOF

    # --- LUKS+LVM-aware initramfs: Alpine's mkinitfs needs the cryptsetup +
    #     lvm features and the keyfile listed so it can unlock at premount. ---
    if [ -f /mnt/etc/mkinitfs/mkinitfs.conf ]; then
        if grep -q '^features=' /mnt/etc/mkinitfs/mkinitfs.conf; then
            sed -i 's/^features="\(.*\)"/features="\1 cryptsetup cryptkey lvm keymap"/' /mnt/etc/mkinitfs/mkinitfs.conf
        else
            echo 'features="base ext4 cryptsetup cryptkey lvm keymap"' >> /mnt/etc/mkinitfs/mkinitfs.conf
        fi
    else
        mkdir -p /mnt/etc/mkinitfs
        echo 'features="base ext4 cryptsetup cryptkey lvm keymap"' > /mnt/etc/mkinitfs/mkinitfs.conf
    fi
    # Make the keyfile part of the initramfs so premount can read it before
    # /boot is mounted (Alpine's cryptkey feature copies listed files in).
    echo "/boot/flagship/luks.key" >> /mnt/etc/mkinitfs/features.d/flagship.files 2>/dev/null || \
        { mkdir -p /mnt/etc/mkinitfs/features.d; echo "/boot/flagship/luks.key" > /mnt/etc/mkinitfs/features.d/flagship.files; }
    # Build the installed kernel's initramfs (inside the target so it links
    # against the target's modules + cryptsetup, not the live shell's).
    KVER="$(ls /mnt/lib/modules 2>/dev/null | head -1)"
    [ -n "$KVER" ] && chroot /mnt mkinitfs "$KVER" || log "  warn: could not determine installed kernel version for mkinitfs"

    # --- network: headless DHCP on the primary wired NIC + loopback ---
    cat > /mnt/etc/network/interfaces <<'EOF'
auto lo
iface lo inet loopback

auto eth0
iface eth0 inet dhcp
EOF

    # --- OpenRC services for a headless box (no display manager, no getty wars):
    #     networking + sshd + chronyd + the local.d hook that runs first-boot.
    for svc in devfs dmesg mdev hwdrivers modules sysctl hostname bootmisc syslog; do
        chroot /mnt rc-update add "$svc" boot 2>/dev/null || true
    done
    for svc in networking sshd chronyd local crond; do
        chroot /mnt rc-update add "$svc" default 2>/dev/null || true
    done
    for svc in mount-ro killprocs savecache; do
        chroot /mnt rc-update add "$svc" shutdown 2>/dev/null || true
    done

    # --- root setup: locked password (headless; access is via the daemon /
    #     phone-mediated SSH key the first-boot unit installs). A locked root
    #     still boots to a login prompt; it just can't be password-logged-in. ---
    chroot /mnt sh -c "passwd -l root" 2>/dev/null || true
    # Serial + tty consoles so a headless box (and QEMU) reaches a login.
    if [ -f /mnt/etc/inittab ]; then
        grep -q 'ttyS0' /mnt/etc/inittab || \
            echo 'ttyS0::respawn:/sbin/getty -L 115200 ttyS0 vt100' >> /mnt/etc/inittab
    fi
    log "  base OS configured (headless: networking+sshd+chronyd, LUKS-aware initramfs, root locked)"
}

# ===========================================================================
# Drop the first-boot provisioning unit. (SEAM b) — the HEAVY proven sequence
# (clone, npm install, tsc -b, gen-identity, mint-entitlements, register, seal)
# runs HERE, on the installed OS, on its first real boot — NOT in this live
# shell. The body is lifted VERBATIM (adapted to OpenRC/busybox) from the proven
# d-i bootstrap in packages/flagship-burner/src/userdata.ts; it reports
# registering/sealing/pairing/live itself once it has network on the installed
# system.
#
# WIRED (seam b armed). The unit runs the real install-helper invocations with
# the real recipe fields (extracted via jq from /flagship/install-blob.json —
# the blob is laid down by phase_install at /mnt/flagship/, which is /flagship/
# on the booted root) and POSTs to the live .com derived from the recipe's
# registrationUrl. It is idempotent (provisioned.flag) and fail-closed.
#
# CRITICAL ORDERING INVARIANT (from a real-hardware Debian e2e): registration
# MUST happen BEFORE the sealed LUKS key is uploaded —
# control-plane/src/luksKeys.ts handlePutSealedLuksKey returns 404 "unknown
# server" until the server is registered. So: register -> registered.flag ->
# seal -> upload. A failed register aborts BEFORE any seal/upload so the box is
# never left half-provisioned.
#
# Alpine vs the Debian/systemd path (userdata.ts): OpenRC, not systemd. The
# whole sequence runs from this single /etc/local.d unit (the `local` service is
# enabled in the default runlevel below). node/npm/git/jq/openssl are already on
# the target (INSTALLED_OS_PACKAGES). Clone target is /opt/flagship (same as
# userdata.ts). The LUKS key sealed for the phone is the same random key the live
# installer generated (staged at /flagship/luks.key by phase_install).
# ===========================================================================
drop_first_boot_unit() {
    log "dropping first-boot provisioning unit (seam b — WIRED to live .com)"
    if [ "$FLAGSHIP_DRY_RUN" = "1" ]; then
        log "  DRY_RUN: would write /mnt/etc/local.d/10-flagship-provision.start (OpenRC)"
        log "  DRY_RUN: provision runs (on installed OS, NOT here): git clone -> npm install ->"
        log "  DRY_RUN:   tsc -b -> gen-identity -> mint-entitlements -> [registering] register ->"
        log "  DRY_RUN:   [sealing] seal-for-bak + sign-sealed-key -> sealed-luks-key -> [pairing] -> [live]"
        log "  DRY_RUN: not wired to a live .com (the QEMU PoC has no node/.com)"
        return 0
    fi
    mkdir -p /mnt/etc/local.d /mnt/etc/runlevels/default
    # The heredoc is UNQUOTED ('PROV') so the few burn-time constants below
    # ($REPO_URL) are expanded now; everything that must be evaluated on the
    # installed OS at first boot is escaped (\$VAR, \\) so it survives into the
    # dropped script verbatim. The recipe-derived values (domain/user/url/ref)
    # are read with jq AT FIRST BOOT from the laid-down blob, never baked here.
    cat > /mnt/etc/local.d/10-flagship-provision.start <<PROV
#!/bin/sh
# First-boot provisioning — runs the proven heavy sequence on the INSTALLED OS.
# Adapted (OpenRC/busybox) from packages/flagship-burner/src/userdata.ts, the
# d-i bootstrap we ran live on real hardware. Idempotent + fail-closed.
set -eu
exec >>/var/log/flagship-provision.log 2>&1
date
echo "[flagship-provision] starting"

FLAG=/var/flagship/provisioned.flag
[ -e "\$FLAG" ] && { echo "[flagship-provision] already provisioned; exiting"; exit 0; }
mkdir -p /var/flagship

REPO_URL="\${FLAGSHIP_REPO_URL:-$REPO_URL}"
BLOB_JSON=/flagship/install-blob.json
LUKS_KEY=/flagship/luks.key

# Read the recipe fields the daemon + provisioning need (jq is installed on the
# target — INSTALLED_OS_PACKAGES). The blob is the signed InstallBlob laid down
# by the live installer; all byte fields are hex (see iso-personalizer/trailer.ts).
SERVER_DOMAIN="\$(jq -r .serverDomain "\$BLOB_JSON")"
USERNAME="\$(jq -r .username "\$BLOB_JSON")"
SERVER_NAME="\$(jq -r .serverName "\$BLOB_JSON")"
REGISTRATION_URL="\$(jq -r .registrationUrl "\$BLOB_JSON")"
PHONE_DELEGATED_PUBKEY="\$(jq -r .phoneDelegatedPubKey "\$BLOB_JSON")"
AUTH_CODE_SERIAL="\$(jq -r .authCode.serial "\$BLOB_JSON")"
GIT_REF="\$(jq -r '.installerGitRef // "main"' "\$BLOB_JSON")"
[ -n "\$GIT_REF" ] && [ "\$GIT_REF" != "null" ] || GIT_REF=main
echo "[flagship-provision] domain=\$SERVER_DOMAIN user=\$USERNAME ref=\$GIT_REF"

# Status channel: derive CONTROL_PLANE_BASE from registrationUrl exactly like
# userdata.ts (strip the trailing /api/server/register). Best-effort; a failed
# report NEVER fails provisioning.
CONTROL_PLANE_BASE="\$(echo "\$REGISTRATION_URL" | sed 's|/api/server/register\$||')"
report_phase() {
    curl -fsS -m 8 -X POST -H 'content-type: application/json' \\
        --data '{"phase":"'"\$1"'"}' \\
        "\$CONTROL_PLANE_BASE/api/order/\$AUTH_CODE_SERIAL/status" >/dev/null 2>&1 || true
}

# Fail-closed: the seal step below is bound to these fields; empty values once
# mis-sealed a disk on a real box (jq was missing). Refuse to proceed if the
# recipe did not parse.
if [ -z "\$SERVER_DOMAIN" ] || [ "\$SERVER_DOMAIN" = "null" ] || \\
   [ -z "\$PHONE_DELEGATED_PUBKEY" ] || [ "\$PHONE_DELEGATED_PUBKEY" = "null" ]; then
    echo "[flagship-provision] FATAL: empty SERVER_DOMAIN/PHONE_DELEGATED_PUBKEY — refusing"
    report_phase error
    exit 1
fi

# Persist install-time facts the daemon reads on every boot.
echo "\$SERVER_DOMAIN"          > /var/flagship/server-domain
echo "\$USERNAME"               > /var/flagship/username
echo "\$SERVER_NAME"            > /var/flagship/server-name
echo "\$PHONE_DELEGATED_PUBKEY" > /var/flagship/phone-delegated.pub
echo "\$AUTH_CODE_SERIAL"       > /var/flagship/auth-code-serial

# --- Clone + build the daemon (heavy work; node/npm/git are on the target). ---
rm -rf /opt/flagship
git clone --depth 50 --branch "\$GIT_REF" "\$REPO_URL" /opt/flagship || \\
    (git clone --depth 50 "\$REPO_URL" /opt/flagship && \\
     git -C /opt/flagship fetch --depth 50 origin "\$GIT_REF" && \\
     git -C /opt/flagship checkout "\$GIT_REF")
cd /opt/flagship
npm install --no-audit --no-fund --workspaces --include-workspace-root
if [ ! -e /opt/flagship/node_modules/@flagship/protocol/package.json ]; then
    echo "[flagship-provision] WARN: workspace not symlinked; manual linking"
    mkdir -p /opt/flagship/node_modules/@flagship
    for pkg in /opt/flagship/packages/*/; do
        name=\$(jq -r .name "\$pkg/package.json" 2>/dev/null || echo "")
        [ -n "\$name" ] && ln -sfn "\$pkg" "/opt/flagship/node_modules/\$name"
    done
fi
npx tsc -b 2>&1 | tee /var/log/flagship-tsc.log || true

# --- Generate the server identity (STK). ---
mkdir -p /var/flagship/identity
chmod 700 /var/flagship/identity
npx tsx scripts/install-helper.ts gen-identity \\
    --out-priv /var/flagship/identity/identity.priv.hex \\
    --out-pub  /var/flagship/identity/identity.pub.hex \\
    --out-pem  /boot/identity.pem
chmod 600 /var/flagship/identity/identity.priv.hex /boot/identity.pem
SERVER_IDENTITY_PRIV_HEX="\$(tr -d '\\n' < /var/flagship/identity/identity.priv.hex)"
SERVER_IDENTITY_PUB_HEX="\$(tr -d '\\n' < /var/flagship/identity/identity.pub.hex)"

# --- Mint the entitlement bundle the daemon presents on every tunnel HELLO.
#     INTERIM self-sign (no user IRK on the box; the phone holds it) — safe today
#     because the production tunnel hub does not yet verify the RootEntitlement's
#     IRK signature. Same caveat as userdata.ts (cut over to a phone-signed bundle
#     before irkLookup is enabled in production). ---
npx tsx scripts/install-helper.ts mint-entitlements \\
    --irk-priv "\$SERVER_IDENTITY_PRIV_HEX" \\
    --pod-pub "\$SERVER_IDENTITY_PUB_HEX" \\
    --username "\$USERNAME" \\
    --pod-canonical "\$SERVER_DOMAIN" \\
    --out /var/flagship/entitlements.json \\
    || echo "[flagship-provision] WARNING: mint-entitlements failed; daemon will not serve"
chmod 600 /var/flagship/entitlements.json 2>/dev/null || true

# --- Daemon environment (server-daemon reads these two from its process env). ---
mkdir -p /etc/flagship
cat > /etc/flagship/daemon.env <<ENVEOF
FLAGSHIP_SUBDOMAIN=\$SERVER_DOMAIN
FLAGSHIP_IDENTITY_PRIV_HEX=\$SERVER_IDENTITY_PRIV_HEX
ENVEOF
chmod 600 /etc/flagship/daemon.env

# === REGISTER FIRST (the invariant). luksKeys.ts handlePutSealedLuksKey 404s
# "unknown server" until the server is registered, so registration MUST precede
# the sealed-key upload. The auth-code is single-use; we write registered.flag on
# success. Fail-closed: a failed register aborts BEFORE the seal/upload, leaving
# the box NOT half-provisioned. ===
report_phase registering
echo "[flagship-provision] registering server with .com (prereq for sealed-key upload)"
npx tsx scripts/install-helper.ts sign-server-register \\
    --priv-hex "\$SERVER_IDENTITY_PRIV_HEX" \\
    --auth-code-blob "\$BLOB_JSON" \\
    > /run/register-payload.json
if ! curl -fsS -X POST -H 'content-type: application/json' \\
    --data @/run/register-payload.json "\$REGISTRATION_URL"; then
    echo "[flagship-provision] FATAL: registration failed — aborting before seal/upload"
    report_phase error
    exit 1
fi
date > /var/flagship/registered.flag
echo "[flagship-provision] registered with .com"

# === SEAL + UPLOAD the LUKS key for the phone (.com-blind relay). Only AFTER a
# successful register (the 404 invariant). seal-for-bak encrypts the random LUKS
# key against the phone's delegated pubkey; .com stores ciphertext only. ===
report_phase sealing
echo "[flagship-provision] sealing LUKS key for the phone + uploading to .com"
SEALED_LUKS_KEY_HEX="\$(npx tsx scripts/install-helper.ts seal-for-bak \\
    --bak-ed25519-pub "\$PHONE_DELEGATED_PUBKEY" \\
    --in "\$LUKS_KEY" | tr -d '\\n')"
if [ -z "\$SEALED_LUKS_KEY_HEX" ]; then
    echo "[flagship-provision] FATAL: seal-for-bak produced nothing — aborting"
    report_phase error
    exit 1
fi
NOW_MS=\$(date +%s%3N)
npx tsx scripts/install-helper.ts sign-sealed-key \\
    --priv "\$SERVER_IDENTITY_PRIV_HEX" \\
    --server-id "\$SERVER_DOMAIN" \\
    --sealed-hex "\$SEALED_LUKS_KEY_HEX" \\
    --issued-at "\$NOW_MS" \\
    > /run/sealed-key-payload.json
if ! curl -fsS -X POST -H 'content-type: application/json' \\
    --data @/run/sealed-key-payload.json \\
    "\${CONTROL_PLANE_BASE}/api/server/\${SERVER_DOMAIN}/sealed-luks-key"; then
    echo "[flagship-provision] FATAL: sealed-key upload failed — aborting"
    report_phase error
    exit 1
fi
echo "[flagship-provision] sealed LUKS key uploaded"

# --- Start the long-running daemon. We are on the booted OS under OpenRC, so we
#     drop an init script + enable it in the default runlevel + start it now. ---
cat > /etc/init.d/flagship-daemon <<'RCEOF'
#!/sbin/openrc-run
name="flagship-daemon"
description="Flagship server daemon"
directory="/opt/flagship"
command="/usr/bin/npm"
command_args="run start --workspace=@flagship/server-daemon"
command_background="yes"
pidfile="/run/flagship-daemon.pid"
output_log="/var/log/flagship-daemon.log"
error_log="/var/log/flagship-daemon.log"

start_pre() {
    set -a
    . /etc/flagship/daemon.env
    set +a
}

depend() {
    need net
    after firewall
}
RCEOF
chmod +x /etc/init.d/flagship-daemon
rc-update add flagship-daemon default 2>/dev/null || true
rc-service flagship-daemon start 2>/dev/null || true

# === PAIRING — the phone approves the first unlock; on subsequent boots the
# installed initramfs unlocks via the staged keyfile / boot relay. ===
report_phase pairing
echo "[flagship-provision] provisioned; awaiting phone pairing"

# === LIVE — the box is up and serving. ===
report_phase live
date > "\$FLAG"
echo "[flagship-provision] done"
PROV
    chmod +x /mnt/etc/local.d/10-flagship-provision.start
    chroot /mnt rc-update add local default 2>/dev/null || \
        ln -sf /etc/init.d/local /mnt/etc/runlevels/default/local 2>/dev/null || true
}

# ===========================================================================
# Bootloader. GRUB on the bios_grub + ESP partitions (BIOS + UEFI both) so the
# installed Alpine boots on either firmware.
# ===========================================================================
install_bootloader() {
    log "installing bootloader (GRUB BIOS+UEFI)"
    if [ "$FLAGSHIP_DRY_RUN" = "1" ]; then
        log "  DRY_RUN: grub-install --target=i386-pc \$TARGET (BIOS, into bios_grub)"
        log "  DRY_RUN: grub-install --target=x86_64-efi --efi-directory=/boot/efi --removable (UEFI, into ESP)"
        log "  DRY_RUN: grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=flagship (named NVRAM entry)"
        log "  DRY_RUN: grub-mkconfig (root=/dev/flagship/root via crypttab/initramfs chain)"
        return 0
    fi
    # Default GRUB cmdline. The root device is the LVM lv; the LUKS unlock is
    # handled by the installed initramfs via crypttab (keyfile on /boot today;
    # boot.flagshipserver.com relay on real hardware — see configure_base_os).
    mkdir -p /mnt/etc/default
    cat > /mnt/etc/default/grub <<EOF
GRUB_DISTRIBUTOR="Flagship"
GRUB_TIMEOUT=1
GRUB_CMDLINE_LINUX_DEFAULT="quiet rootfstype=ext4"
GRUB_CMDLINE_LINUX="cryptdm=flagship_luks rd.lvm.lv=flagship/root root=/dev/flagship/root"
GRUB_ENABLE_CRYPTODISK=y
EOF
    # BIOS: stage-1.5 into the bios_grub partition + MBR boot code on $TARGET.
    chroot /mnt grub-install --target=i386-pc --boot-directory=/boot "$TARGET" \
        || fail "grub-install (BIOS/i386-pc) failed"
    # UEFI removable path (\EFI\BOOT\BOOTX64.EFI) — boots even with empty NVRAM
    # (USB-style firmware, and what QEMU/OVMF needs without a persisted entry).
    chroot /mnt grub-install --target=x86_64-efi --efi-directory=/boot/efi \
        --boot-directory=/boot --removable \
        || fail "grub-install (UEFI removable) failed"
    # UEFI named entry — adds a "flagship" boot option to NVRAM where supported.
    chroot /mnt grub-install --target=x86_64-efi --efi-directory=/boot/efi \
        --boot-directory=/boot --bootloader-id=flagship 2>/dev/null || \
        log "  note: named NVRAM entry not added (firmware/NVRAM unavailable); removable path covers boot"
    chroot /mnt grub-mkconfig -o /boot/grub/grub.cfg || fail "grub-mkconfig failed"
}

# ===========================================================================
# SUCCESS GATE — only AFTER this returns 0 do we self-wipe the USB + repoint
# the firmware. Verifies the installed disk is genuinely bootable (not just
# that commands exited 0): the GRUB core, a kernel + the freshly-built
# initramfs, the grub.cfg, and the UEFI removable loader must all be present on
# the target. Anything missing -> NOT bootable -> leave the USB, report error.
# This is the explicit, testable success-gating the self-wipe hangs off of.
# ===========================================================================
verify_installed_bootable() {
    log "verifying the installed disk is genuinely bootable (success gate)"
    if [ "$FLAGSHIP_DRY_RUN" = "1" ]; then
        log "  DRY_RUN: would assert grub core + kernel + initramfs + grub.cfg + BOOTX64.EFI exist on target"
        return 0
    fi
    _ok=1
    # GRUB BIOS core + modules.
    [ -d /mnt/boot/grub ] || { log "  MISSING /boot/grub"; _ok=0; }
    [ -s /mnt/boot/grub/grub.cfg ] || { log "  MISSING /boot/grub/grub.cfg"; _ok=0; }
    # A kernel + a built initramfs on /boot (Alpine names them vmlinuz-* /
    # initramfs-*).
    ls /mnt/boot/vmlinuz-* >/dev/null 2>&1 || { log "  MISSING kernel on /boot"; _ok=0; }
    ls /mnt/boot/initramfs-* >/dev/null 2>&1 || { log "  MISSING initramfs on /boot"; _ok=0; }
    # UEFI removable loader.
    [ -s /mnt/boot/efi/EFI/BOOT/BOOTX64.EFI ] || { log "  MISSING UEFI BOOTX64.EFI"; _ok=0; }
    # The grub.cfg must actually reference our root LV (a sanity check that
    # grub-mkconfig saw the right rootfs, not a stale/empty config).
    grep -q 'flagship/root\|flagship_luks' /mnt/boot/grub/grub.cfg 2>/dev/null || \
        { log "  grub.cfg does not reference the flagship root chain"; _ok=0; }
    if [ "$_ok" = "1" ]; then
        log "  VERIFIED bootable: grub core + kernel + initramfs + grub.cfg + BOOTX64.EFI all present"
        return 0
    fi
    log "  NOT bootable — install did not produce a complete boot chain"
    return 1
}

# ===========================================================================
# SELF-WIPE (success-only). The agreed one-shot UX: after we've VERIFIED the
# disk boots, (a) efibootmgr the INTERNAL disk to the front of the boot order,
# and (b) wipe the USB's boot signature so the firmware never re-enters the
# installer. Wiping the USB is clean because Alpine runs entirely from RAM at
# this point — we unmount the USB first. This NEVER runs on a failed install
# (the USB is left intact for retry). Gated entirely on verify_installed_bootable.
# ===========================================================================
efibootmgr_internal_first() {
    log "  efibootmgr: making the internal disk ($TARGET) the boot entry"
    if [ "$FLAGSHIP_DRY_RUN" = "1" ]; then
        log "  DRY_RUN: efibootmgr -c -d $TARGET -p 2 -L Flagship -l '\\EFI\\BOOT\\BOOTX64.EFI'"
        log "  DRY_RUN: efibootmgr -o <new-entry-first> (internal disk ahead of USB)"
        return 0
    fi
    if [ ! -d /sys/firmware/efi ]; then
        log "  not booted via UEFI (no /sys/firmware/efi) — BIOS boot order is firmware/MBR-driven; skipping efibootmgr"
        return 0
    fi
    s="$(part_suffix "$TARGET")"
    # Create a boot entry pointing at the ESP's removable loader, then move it
    # to the front. -p 2 = the ESP partition number in our layout.
    NEW="$(efibootmgr -c -d "$TARGET" -p 2 -L Flagship -l '\EFI\BOOT\BOOTX64.EFI' 2>/dev/null \
        | sed -n 's/^Boot\([0-9A-Fa-f]\{4\}\)\* Flagship$/\1/p' | tail -1)"
    if [ -n "$NEW" ]; then
        REST="$(efibootmgr 2>/dev/null | sed -n 's/^BootOrder: //p' | sed "s/$NEW,\\?//; s/,$//")"
        efibootmgr -o "${NEW}${REST:+,$REST}" 2>/dev/null || true
        log "  efibootmgr: Flagship entry $NEW is first in BootOrder"
    else
        log "  warn: could not create/find the Flagship NVRAM entry; removable BOOTX64.EFI still covers boot"
    fi
}

wipe_usb_boot_signature() {
    log "  wiping the live USB boot signature (one-shot — no installer reboot loop)"
    if [ "$FLAGSHIP_DRY_RUN" = "1" ]; then
        log "  DRY_RUN: umount USB; dd if=/dev/zero of=\$USB_DEV bs=1M count=4 (clobber MBR/GPT primary)"
        log "  DRY_RUN: wipefs -a \$USB_DEV (drop boot signatures so firmware won't re-enter installer)"
        return 0
    fi
    if [ -z "$USB_DEV" ] || [ ! -b "$USB_DEV" ]; then
        log "  warn: USB device not identified — skipping wipe (will report success regardless; efibootmgr already repointed)"
        return 0
    fi
    # Alpine runs from RAM, but unmount any USB mounts first so the wipe is clean.
    for mnt in $(awk -v u="$USB_DEV" '$1 ~ "^" u { print $2 }' /proc/mounts | sort -r); do
        umount -f "$mnt" 2>/dev/null || umount -l "$mnt" 2>/dev/null || true
    done
    # Clobber the first 4 MiB (covers MBR + GPT primary header/entries) then
    # wipefs to drop any remaining signatures. Firmware now finds no bootable
    # signature on the USB and falls through to the internal disk.
    dd if=/dev/zero of="$USB_DEV" bs=1M count=4 conv=fsync 2>/dev/null || true
    wipefs -a "$USB_DEV" 2>/dev/null || true
    blockdev --rereadpt "$USB_DEV" 2>/dev/null || true
    log "  USB boot signature wiped on $USB_DEV"
}

# ===========================================================================
# finish — the success/failure decision point. On a verified-bootable install:
# efibootmgr + USB self-wipe + reboot into the clean disk. On ANY failure
# anywhere above (every step fails fast via fail()/set -e) we never reach here
# with a half install — but verify_installed_bootable() is the FINAL gate: if
# it returns non-zero we report error, leave the USB intact for retry, and do
# NOT wipe.
# ===========================================================================
finish() {
    log "phase: finalizing — running success gate before any wipe/repoint"
    if [ "$FLAGSHIP_DRY_RUN" = "1" ]; then
        # Exercise the full success path's ordering in the dry run.
        if verify_installed_bootable; then
            log "  DRY_RUN: gate PASS -> efibootmgr internal-first -> wipe USB -> umount -> reboot"
            efibootmgr_internal_first
            wipe_usb_boot_signature
        else
            log "  DRY_RUN: gate FAIL -> leave USB intact, report error, do NOT wipe"
        fi
        log "[flagship-installer] DRY-RUN COMPLETE — all phases walked. Halting."
        return 0
    fi
    # REAL path: gate FIRST. Self-wipe + efibootmgr ONLY on success.
    if ! verify_installed_bootable; then
        # Leave the USB intact so the owner can simply reboot to retry.
        umount -R /mnt 2>/dev/null || true
        vgchange -an flagship 2>/dev/null || true
        cryptsetup close flagship_luks 2>/dev/null || true
        fail "installed disk failed the bootable-verification gate; USB left intact for retry"
    fi
    log "  success gate PASSED — committing one-shot handoff"
    sync
    # Repoint firmware BEFORE we drop the mounts (efibootmgr reads /sys, not /mnt).
    efibootmgr_internal_first
    umount -R /mnt 2>/dev/null || true
    vgchange -an flagship 2>/dev/null || true
    cryptsetup close flagship_luks 2>/dev/null || true
    # Now wipe the USB (clean — we run from RAM) so there is no installer loop.
    wipe_usb_boot_signature
    log "install complete; rebooting into the encrypted internal disk"
    sync
    reboot
}

main() {
    log "=== Flagship tiny live installer (dry_run=$FLAGSHIP_DRY_RUN) ==="
    phase_boot
    phase_network
    phase_download
    # Cryptographic recipe-signature gate: the install tools are present now and
    # NO disk has been written yet. Fail-closed here, before any partitioning.
    verify_recipe_signature
    phase_partition
    phase_install
    drop_first_boot_unit
    install_bootloader
    finish
    log "=== installer done ==="
}

# Standalone hook (unit test / pre-flight): `installer.sh verify-recipe
# <blob.json> [sig-file]` runs ONLY the recipe-signature verifier and exits with
# its status. The logging FIFO is skipped (guarded above) so stdout stays clean.
if [ "${1:-}" = "verify-recipe" ]; then
    [ -n "${2:-}" ] && BLOB_JSON="$2"
    [ -n "${3:-}" ] && BLOB_SIG="$3"
    SERIAL=""   # report_phase is a no-op without a serial
    verify_recipe_signature
    exit $?
fi
main "$@"
