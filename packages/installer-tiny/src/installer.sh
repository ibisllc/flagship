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
# DIVISION OF LABOUR (the key architectural insight)
# --------------------------------------------------
# The LIVE installer does ONLY the light, deterministic work that needs no
# package manager and no monorepo build:
#   1. network (baked Wi-Fi via wpa_supplicant, else DHCP)
#   2. partition: bios_grub + ESP + /boot + LUKS -> LVM (vg "flagship", lv "root")
#   3. lay down a base OS onto the encrypted root (apk --root, OR dd a base img)
#   4. drop the first-boot provisioning unit + the recipe + status creds
#   5. install a bootloader, reboot
#
# The HEAVY work (node, `npm install`, `tsc -b`, gen-identity, mint-entitlements,
# register, seal LUKS key) runs FIRST-BOOT on the INSTALLED OS, which has its
# own package manager. That is what makes the live installer tiny: NO node here.
# The proven first-boot sequence is lifted verbatim from
# packages/flagship-burner/src/userdata.ts (the d-i bootstrap), which we ran
# live over SSH on a real box.
#
# This file is a QEMU-validated SKELETON. The partition / luks / base-lay-down
# steps are stubbed with `report_phase` + the exact commands they will run,
# guarded by FLAGSHIP_DRY_RUN so the PoC can boot end-to-end in QEMU without a
# target disk. Remove the dry-run guards (and supply a real recipe) to arm it.
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
BLOB_SIG="${BLOB_SIG:-$FLAGSHIP_DIR/install-blob.sig}"
GIT_REF="${GIT_REF:-main}"
REPO_URL="${REPO_URL:-https://github.com/ibisllc/flagship.git}"
CONTROL_PLANE_BASE="${CONTROL_PLANE_BASE:-https://flagshipserver.com}"
# Curated firmware subset for commodity hardware (see docs eval). Each is an
# Alpine subpackage so the total stays ~50-150MB, not the ~1GB full set.
FW_PACKAGES="${FW_PACKAGES:-linux-firmware-intel linux-firmware-rtw88 linux-firmware-rtw89 linux-firmware-iwlwifi linux-firmware-rtl_nic linux-firmware-ath10k linux-firmware-ath11k linux-firmware-amdgpu linux-firmware-i915 linux-firmware-other}"
# Wi-Fi (burn-time only; never part of the signed blob). Empty => wired DHCP only.
WIFI_SSID="${WIFI_SSID:-}"
WIFI_PSK="${WIFI_PSK:-}"
# Dry-run lets the QEMU PoC walk the whole flow without a real install target.
FLAGSHIP_DRY_RUN="${FLAGSHIP_DRY_RUN:-0}"

LOG=/var/log/flagship-install.log
mkdir -p /var/log "$FLAGSHIP_DIR"
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
# PHASE: booting — the live OS is up; verify our tools + the recipe.
# ===========================================================================
phase_boot() {
    log "phase: booting"
    read_serial
    report_phase booting
    log "recipe serial=${SERIAL:-<none>}"
    # Tool gate: everything the LIVE installer needs. node is deliberately NOT
    # here — it runs first-boot on the installed OS.
    for t in cryptsetup pvcreate vgcreate lvcreate sgdisk mkfs.ext4 mkfs.vfat curl; do
        if command -v "$t" >/dev/null 2>&1; then
            log "  tool ok: $t"
        else
            log "  tool MISSING: $t"
            [ "$FLAGSHIP_DRY_RUN" = "1" ] || fail "required tool missing: $t"
        fi
    done
    # TODO(security): verify $BLOB_SIG over canonical($BLOB_JSON) with the
    # baked genesis pubkey BEFORE trusting any field. The d-i path uses
    # packages/installer-netboot/parse-trailer.sh (openssl Ed25519); port it
    # here. Refuse to install on signature failure.
    log "  recipe signature verify: TODO (parse-trailer.sh port)"
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
        log "  DRY_RUN: would 'apk add cryptsetup lvm2 sgdisk dosfstools e2fsprogs curl ca-certificates $FW_PACKAGES'"
        return 0
    fi
    setup-interfaces -a 2>/dev/null || true   # bring NICs up (Alpine helper)
    udhcpc -i eth0 2>/dev/null || true
    bake_wifi
    # Pick the fastest mirror (QEMU-validated: 'apk add' fails if the repo list
    # only has the cdrom; setup-apkrepos -1 writes a working network mirror) and
    # enable community (sgdisk lives there). Both confirmed live in the PoC.
    setup-apkrepos -1 2>/dev/null || true
    sed -i 's|^#\(.*/community\)|\1|' /etc/apk/repositories 2>/dev/null || true
    apk update
    apk add cryptsetup lvm2 sgdisk partx dosfstools e2fsprogs curl ca-certificates \
        $FW_PACKAGES || fail "apk add of install tools failed"
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
# PHASE: partitioning — the proven layout from installer/install.sh, extended
# to LVM (vg "flagship") so root can grow / add lvs later:
#   p1 bios_grub (1MiB, BIOS GRUB stage-1.5)   -> no fs
#   p2 ESP       (256MiB, FAT32, UEFI)         -> label not applicable
#   p3 /boot     (512MiB, ext4)                -> label FLAGSHIP_BOOT
#   p4 LUKS2     (rest) -> LVM PV -> vg flagship -> lv root (ext4)
#                                                 -> label FLAGSHIP_ROOT
# ===========================================================================
TARGET=""
select_target() {
    # First fixed disk >= 8GiB that isn't the live USB. Mirrors install.sh.
    for d in /dev/nvme0n1 /dev/sda /dev/vda /dev/mmcblk0; do
        [ -b "$d" ] || continue
        sz=$(blockdev --getsize64 "$d" 2>/dev/null || echo 0)
        [ "$sz" -ge $((8 * 1024 * 1024 * 1024)) ] || continue
        TARGET="$d"; break
    done
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
# PHASE: installing — LUKS-format p4, build LVM, lay down the base OS.
# LUKS key is a random 64-byte file; first-boot seals it for the phone and
# uploads to .com (the .com-blind relay). Same construction as install.sh.
# ===========================================================================
phase_install() {
    log "phase: installing (LUKS + LVM + base OS)"
    report_phase installing
    if [ "$FLAGSHIP_DRY_RUN" = "1" ]; then
        log "  DRY_RUN: head -c64 /dev/urandom > key; cryptsetup luksFormat --type luks2 p4"
        log "  DRY_RUN: cryptsetup open p4 flagship; pvcreate; vgcreate flagship; lvcreate -l100%FREE -n root flagship"
        log "  DRY_RUN: mkfs.ext4 -L FLAGSHIP_ROOT /dev/flagship/root; mount; apk --root /mnt add alpine-base ... (base OS)"
        return 0
    fi
    s="$(part_suffix "$TARGET")"; LUKS_PART="${TARGET}${s}4"
    KEY=/run/flagship-luks.key
    head -c 64 /dev/urandom > "$KEY"; chmod 600 "$KEY"
    cryptsetup luksFormat --type luks2 --batch-mode --key-file "$KEY" "$LUKS_PART"
    cryptsetup open --key-file "$KEY" "$LUKS_PART" flagship_luks
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
    # docs/installer-tiny.md trade-off.
    apk --root /mnt --initdb add alpine-base linux-lts openrc \
        nodejs npm git curl jq cryptsetup lvm2 openssl ca-certificates \
        $FW_PACKAGES || fail "base OS lay-down failed"
    # Persist the recipe + the LUKS key handoff material for first-boot.
    cp "$BLOB_JSON" /mnt/flagship/install-blob.json
    install -m 600 "$KEY" /mnt/flagship/luks.key
}

# ===========================================================================
# Drop the first-boot provisioning unit. The HEAVY proven sequence (clone,
# npm install, tsc -b, gen-identity, mint-entitlements, register, seal) runs
# HERE, on the installed OS, on its first real boot — NOT in this live shell.
# The body is lifted from userdata.ts; it reports registering/sealing/pairing/
# live itself once it has network on the installed system.
# ===========================================================================
drop_first_boot_unit() {
    log "dropping first-boot provisioning unit"
    if [ "$FLAGSHIP_DRY_RUN" = "1" ]; then
        log "  DRY_RUN: would write /mnt/etc/local.d/10-flagship-provision.start (OpenRC)"
        log "  DRY_RUN: provision runs: git clone -> npm install -> tsc -b -> gen-identity ->"
        log "  DRY_RUN:   mint-entitlements -> register -> seal-for-bak -> sealed-luks-key -> report_phase live"
        return 0
    fi
    mkdir -p /mnt/etc/local.d /mnt/etc/runlevels/default
    cat > /mnt/etc/local.d/10-flagship-provision.start <<PROV
#!/bin/sh
# First-boot provisioning — runs the proven heavy sequence on the installed OS.
# Source of truth for these exact commands: packages/flagship-burner/src/userdata.ts
set -eu
FLAG=/var/flagship/provisioned.flag
[ -e "\$FLAG" ] && exit 0
CONTROL_PLANE_BASE="$CONTROL_PLANE_BASE"
SERIAL="$SERIAL"
report_phase() { curl -fsS -m 8 -X POST -H 'content-type: application/json' \\
    --data '{"phase":"'"\$1"'"}' "\$CONTROL_PLANE_BASE/api/order/\$SERIAL/status" >/dev/null 2>&1 || true; }
git clone --depth 50 --branch "$GIT_REF" "$REPO_URL" /opt/flagship
cd /opt/flagship
npm install --no-audit --no-fund --workspaces --include-workspace-root
npx tsc -b || true
npx tsx scripts/install-helper.ts gen-identity --out-priv /var/flagship/identity/identity.priv.hex \\
    --out-pub /var/flagship/identity/identity.pub.hex --out-pem /boot/identity.pem
npx tsx scripts/install-helper.ts mint-entitlements ...   # see userdata.ts for full args
report_phase registering
npx tsx scripts/install-helper.ts sign-server-register ...  # POST /api/server/register
report_phase sealing
npx tsx scripts/install-helper.ts seal-for-bak ...          # seal LUKS key for phone
# POST sealed key to /api/server/<domain>/sealed-luks-key (the .com-blind relay)
report_phase pairing
# (phone approves first unlock; boot-stage.sh takes over on subsequent boots)
report_phase live
mkdir -p /var/flagship; date > "\$FLAG"
PROV
    chmod +x /mnt/etc/local.d/10-flagship-provision.start
    ln -sf /etc/init.d/local /mnt/etc/runlevels/default/local 2>/dev/null || true
}

# ===========================================================================
# Bootloader. GRUB on the bios_grub + ESP partitions (BIOS + UEFI both).
# ===========================================================================
install_bootloader() {
    log "installing bootloader (GRUB BIOS+UEFI)"
    if [ "$FLAGSHIP_DRY_RUN" = "1" ]; then
        log "  DRY_RUN: apk --root /mnt add grub grub-bios grub-efi; grub-install --target=i386-pc \$TARGET;"
        log "  DRY_RUN: grub-install --target=x86_64-efi --efi-directory=/boot/efi; grub-mkconfig (root=/dev/flagship/root, cryptdevice)"
        return 0
    fi
    apk --root /mnt add grub grub-bios grub-efi
    # cmdline must carry the LUKS+LVM unlock chain so the installed initramfs
    # can prompt/relay for the key. boot-stage.sh / the relay hook handle the
    # actual unlock; here we just wire the rootfs path.
    chroot /mnt grub-install --target=i386-pc "$TARGET"
    chroot /mnt grub-install --target=x86_64-efi --efi-directory=/boot/efi --removable
    chroot /mnt grub-mkconfig -o /boot/grub/grub.cfg
}

finish() {
    log "phase: live handoff queued; finalizing"
    if [ "$FLAGSHIP_DRY_RUN" = "1" ]; then
        log "  DRY_RUN: would umount, cryptsetup close, reboot"
        log "[flagship-installer] DRY-RUN COMPLETE — all phases walked. Halting."
        return 0
    fi
    sync
    umount -R /mnt 2>/dev/null || true
    vgchange -an flagship 2>/dev/null || true
    cryptsetup close flagship_luks 2>/dev/null || true
    log "install complete; rebooting into the encrypted OS"
    reboot
}

main() {
    log "=== Flagship tiny live installer (dry_run=$FLAGSHIP_DRY_RUN) ==="
    phase_boot
    phase_download
    phase_partition
    phase_install
    drop_first_boot_unit
    install_bootloader
    finish
    log "=== installer done ==="
}
main "$@"
