import { BURN_PASSPHRASE, type UserDataOptions } from "./userdata.js";
import { buildDebianPreseed } from "./preseed.js";
import { buildAppliancePrepareScript } from "./appliance.js";
import { utf8ToBase64 } from "./base64.js";

/** Build a secret-free Debian installer that creates the generalized base.
 * The synthetic recipe exists only to reuse the proven encrypted partitioning,
 * package, GRUB, and poweroff template; its normal late command is replaced in
 * full, so no recipe/bootstrap artifact enters the installed image. */
export function buildDebianApplianceFactoryPreseed(gitRef: string): string {
  const zeros32 = new Uint8Array(32);
  const zeros64Bytes = new Uint8Array(64);
  const zeros64 = "00".repeat(64);
  const factoryOptions = {
    blob: {
      version: 2,
      serverDomain: "factory.invalid",
      username: "factory",
      serverName: "base",
      phoneDelegatedPubKey: zeros32,
      registrationUrl: "https://factory.invalid/register",
      authCode: {
        version: 1,
        serial: "VMFACTORY01",
        username: "factory",
        serverName: "base",
        serverDomain: "factory.invalid",
        delegatedPubKey: zeros32,
        userPubKey: zeros32,
        issuedAt: 0,
        expiresAt: 4_102_444_800_000,
      },
      authCodeUserSignature: zeros64Bytes,
      installerGitRef: gitRef,
      rckPubKey: zeros32,
    },
    blobSignatureHex: zeros64,
    encryptRoot: true,
  } as unknown as UserDataOptions;
  const base = buildDebianPreseed(factoryOptions);
  const prepareB64 = utf8ToBase64(buildAppliancePrepareScript({ gitRef }));
  const lateCommand =
    `touch /tmp/flagship-installer-telemetry.done; ` +
    `echo '${prepareB64}' | base64 -d > /target/usr/local/sbin/flagship-appliance-prepare.sh; ` +
    `chmod 700 /target/usr/local/sbin/flagship-appliance-prepare.sh; ` +
    `in-target /usr/local/sbin/flagship-appliance-prepare.sh`;
  const result = base
    .replace(/^d-i preseed\/early_command string .*$/m, "d-i preseed/early_command string true")
    .replace(/^d-i preseed\/late_command string .*$/m,
      `d-i preseed/late_command string ${lateCommand}`)
    .replaceAll("https://flagshipserver.com/api/order/VMFACTORY01/status",
      "http://127.0.0.1:9/factory-telemetry-disabled");
  if (result.includes("factory.invalid")) {
    throw new Error("factory-only synthetic recipe escaped into appliance preseed");
  }
  return result;
}

/** The customer appliance remains LUKS-encrypted even though Debian's official
 * cloud image is not: the cloud disk is only a disposable build host, and this
 * script copies it into a separate encrypted target before generalization. */
export function buildDebianCloudApplianceFactoryUserData(gitRef: string): string {
  const prepareB64 = utf8ToBase64(buildAppliancePrepareScript({ gitRef }));
  const migrate = `#!/bin/bash
set -euo pipefail
exec > >(tee -a /var/log/flagship-appliance-cloud-factory.log) 2>&1
FACTORY_CONSOLE=/dev/null
for _console in /dev/hvc0 /dev/ttyAMA0; do
    if [ -c "$_console" ]; then FACTORY_CONSOLE="$_console"; break; fi
done
factory_stage() {
    printf '[appliance-factory] %s\n' "$1"
    timeout 2 sh -c 'printf "[appliance-factory] %s\\n" "$1" > "$2"' sh "$1" "$FACTORY_CONSOLE" || true
}
factory_failure() {
    factory_stage "failed line=$1 rc=$2"
    _prepare_log="\${TARGET_ROOT:-/nonexistent}/var/log/flagship-appliance-prepare.log"
    if [ -f "$_prepare_log" ]; then
        timeout 4 sh -c 'tail -80 "$1" > "$2"' sh "$_prepare_log" "$FACTORY_CONSOLE" || true
    fi
    systemctl poweroff --no-block >/dev/null 2>&1 || true
}
trap 'rc=$?; factory_failure "$LINENO" "$rc"' ERR
factory_stage "cloud conversion start"
export DEBIAN_FRONTEND=noninteractive

factory_stage "waiting for factory network"
for _attempt in $(seq 1 5); do
    if getent ahostsv4 deb.debian.org >/dev/null 2>&1; then break; fi
    sleep 2
done
if ! getent ahostsv4 deb.debian.org >/dev/null 2>&1; then
    factory_stage "using QEMU user-network DNS fallback"
    rm -f /etc/resolv.conf
    printf 'nameserver 10.0.2.3\noptions timeout:2 attempts:3\n' > /etc/resolv.conf
fi
for _attempt in $(seq 1 40); do
    if getent ahostsv4 deb.debian.org >/dev/null 2>&1; then break; fi
    sleep 2
done
getent ahostsv4 deb.debian.org >/dev/null 2>&1 || {
    echo "[appliance-factory] DNS unavailable after normal and QEMU fallback resolution"
    factory_failure "$LINENO" 1
    exit 1
}
factory_stage "factory network ready"

SOURCE_ROOT="$(findmnt -n -o SOURCE /)"
SOURCE_PARENT="$(lsblk -no PKNAME "$SOURCE_ROOT" | head -n1)"
TARGET_DEV=/dev/vdb
[ -b "$TARGET_DEV" ] || { echo "[appliance-factory] target disk missing: $TARGET_DEV"; exit 1; }
[ "/dev/$SOURCE_PARENT" != "$TARGET_DEV" ] || { echo "[appliance-factory] refusing source disk"; exit 1; }
[ "$(lsblk -dnro TYPE "$TARGET_DEV")" = disk ] || { echo "[appliance-factory] target is not a whole disk"; exit 1; }
[ "$(blockdev --getsize64 "$TARGET_DEV")" -ge 8589934592 ] || { echo "[appliance-factory] target is too small"; exit 1; }
if lsblk -nrpo MOUNTPOINT "$TARGET_DEV" | grep -q '[^[:space:]]'; then
    echo "[appliance-factory] target already mounted"
    exit 1
fi

APT_RETRY=(-o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20)
factory_stage "installing factory prerequisites"
timeout -k 10 120 apt-get "\${APT_RETRY[@]}" update
timeout -k 10 120 apt-get "\${APT_RETRY[@]}" install -y --no-install-recommends gdisk cryptsetup cryptsetup-initramfs rsync dosfstools parted
factory_stage "factory prerequisites ready"
sgdisk --zap-all "$TARGET_DEV"
sgdisk -n 1:1MiB:+512MiB -t 1:ef00 -c 1:EFI "$TARGET_DEV"
sgdisk -n 2:0:+768MiB -t 2:8300 -c 2:flagship_boot "$TARGET_DEV"
sgdisk -n 3:0:0 -t 3:8309 -c 3:flagship_root "$TARGET_DEV"
partprobe "$TARGET_DEV"
udevadm settle
factory_stage "target partitioned"

FACTORY_KEY=/run/flagship-appliance-factory.key
printf '%s' '${BURN_PASSPHRASE}' > "$FACTORY_KEY"
chmod 600 "$FACTORY_KEY"
cryptsetup luksFormat --type luks2 --batch-mode --key-file="$FACTORY_KEY" "$TARGET_DEV"3
factory_stage "LUKS header formatted"
if ! timeout 60 cryptsetup --debug open --key-file="$FACTORY_KEY" "$TARGET_DEV"3 flagship_root \
    >/run/flagship-cryptsetup-open.log 2>&1; then
    timeout 4 sh -c 'cat /run/flagship-cryptsetup-open.log > "$1"' sh "$FACTORY_CONSOLE" || true
    exit 1
fi
rm -f "$FACTORY_KEY"
factory_stage "target encrypted"
mkfs.ext4 -F -L flagship_root /dev/mapper/flagship_root
mkfs.ext4 -F -L FLAGSHIP_BOOT "$TARGET_DEV"2
mkfs.vfat -F 32 -n FLAGSHIPEFI "$TARGET_DEV"1
factory_stage "filesystems ready"

TARGET_ROOT=/mnt/flagship-target
mkdir -p "$TARGET_ROOT"
mount /dev/mapper/flagship_root "$TARGET_ROOT"
tar --one-file-system --numeric-owner --acls --xattrs --xattrs-include='*' \
    --exclude=./boot --exclude=./dev --exclude=./proc --exclude=./sys --exclude=./run \
    --exclude=./tmp --exclude=./mnt --exclude=./media --exclude=./lost+found \
    --exclude=./var/log --exclude=./var/lib/cloud \
    -C / -cpf - . | \
    tar --numeric-owner --acls --xattrs --xattrs-include='*' -C "$TARGET_ROOT" -xpf -
factory_stage "base filesystem copied"
chroot "$TARGET_ROOT" passwd -l debian >/dev/null 2>&1 || true
mkdir -p "$TARGET_ROOT"/{dev,proc,sys,run,tmp,mnt,media,boot,var/log,var/lib/cloud}
chmod 1777 "$TARGET_ROOT/tmp"
mount "$TARGET_DEV"2 "$TARGET_ROOT/boot"
tar --one-file-system --numeric-owner --acls --xattrs --xattrs-include='*' \
    -C /boot -cpf - . | \
    tar --numeric-owner --acls --xattrs --xattrs-include='*' -C "$TARGET_ROOT/boot" -xpf -
mkdir -p "$TARGET_ROOT/boot/efi"
mount "$TARGET_DEV"1 "$TARGET_ROOT/boot/efi"
mount --rbind /dev "$TARGET_ROOT/dev"
mount --make-rslave "$TARGET_ROOT/dev"
mount -t proc proc "$TARGET_ROOT/proc"
mount --rbind /sys "$TARGET_ROOT/sys"
mount --make-rslave "$TARGET_ROOT/sys"
mount --rbind /run "$TARGET_ROOT/run"
mount --make-rslave "$TARGET_ROOT/run"

ROOT_UUID="$(blkid -s UUID -o value "$TARGET_DEV"3)"
BOOT_UUID="$(blkid -s UUID -o value "$TARGET_DEV"2)"
EFI_UUID="$(blkid -s UUID -o value "$TARGET_DEV"1)"
cat > "$TARGET_ROOT/etc/fstab" <<EOF
/dev/mapper/flagship_root / ext4 defaults 0 1
UUID=$BOOT_UUID /boot ext4 defaults 0 2
UUID=$EFI_UUID /boot/efi vfat umask=0077 0 1
EOF
printf 'flagship_root UUID=%s /etc/flagship/appliance-build.key luks,initramfs\n' "$ROOT_UUID" > "$TARGET_ROOT/etc/crypttab"
echo '${prepareB64}' | base64 -d > "$TARGET_ROOT/usr/local/sbin/flagship-appliance-prepare.sh"
chmod 700 "$TARGET_ROOT/usr/local/sbin/flagship-appliance-prepare.sh"

ARCH="$(chroot "$TARGET_ROOT" dpkg --print-architecture)"
case "$ARCH" in
  arm64) GRUB_TARGET=arm64-efi; GRUB_PACKAGE=grub-efi-arm64-bin; GRUB_FALLBACK=BOOTAA64.EFI ;;
  amd64) GRUB_TARGET=x86_64-efi; GRUB_PACKAGE=grub-efi-amd64-bin; GRUB_FALLBACK=BOOTX64.EFI ;;
  *) echo "[appliance-factory] unsupported Debian architecture: $ARCH"; exit 1 ;;
esac
chroot "$TARGET_ROOT" apt-get update
chroot "$TARGET_ROOT" apt-get install -y --no-install-recommends "$GRUB_PACKAGE" grub2-common
chroot "$TARGET_ROOT" /usr/local/sbin/flagship-appliance-prepare.sh
factory_stage "Flagship workspace prepared"
mkdir -p "$TARGET_ROOT/etc/default/grub.d"
cat > "$TARGET_ROOT/etc/default/grub.d/flagship-root.cfg" <<'GRUBCFG'
GRUB_DISABLE_LINUX_UUID=true
GRUB_DISABLE_LINUX_PARTUUID=true
GRUBCFG
chroot "$TARGET_ROOT" grub-install --target="$GRUB_TARGET" --efi-directory=/boot/efi --bootloader-id=debian --removable --no-nvram
chroot "$TARGET_ROOT" update-grub
[ -s "$TARGET_ROOT/boot/efi/EFI/BOOT/$GRUB_FALLBACK" ] || {
    echo "[appliance-factory] removable EFI loader missing: EFI/BOOT/$GRUB_FALLBACK"
    exit 1
}
factory_stage "bootloader installed"

mkdir -p "$TARGET_ROOT/etc/systemd/network"
cat > "$TARGET_ROOT/etc/systemd/network/20-flagship-wired.network" <<'NETWORK'
[Match]
Type=ether

[Network]
DHCP=yes
IPv6AcceptRA=yes
NETWORK
chroot "$TARGET_ROOT" systemctl enable systemd-networkd.service systemd-networkd-wait-online.service
touch "$TARGET_ROOT/etc/cloud/cloud-init.disabled"
rm -rf "$TARGET_ROOT/var/lib/cloud" "$TARGET_ROOT/root/.ssh" "$TARGET_ROOT/home/debian/.ssh"
cp /var/log/flagship-appliance-cloud-factory.log "$TARGET_ROOT/var/log/flagship-appliance-cloud-factory.log"
chroot "$TARGET_ROOT" update-initramfs -u
sync
echo "[appliance-factory] encrypted generalized target ready"
systemctl poweroff
`;
  const migrateB64 = utf8ToBase64(migrate);
  return `#cloud-config
write_files:
  - path: /usr/local/sbin/flagship-cloud-to-appliance.sh
    owner: root:root
    permissions: '0700'
    encoding: b64
    content: ${migrateB64}
runcmd:
  - [ /usr/local/sbin/flagship-cloud-to-appliance.sh ]
`;
}
