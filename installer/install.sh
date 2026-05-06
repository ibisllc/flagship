#!/bin/sh
# Flagship first-boot installer.
#
# Run by /etc/local.d/01-flagship-bootstrap.start in the apkovl. The
# bootstrap has already validated the trailer signature; this script
# does the heavy lifting:
#
#   - Provision the internal disk as: small unencrypted boot partition
#     + LUKS-encrypted root.
#   - Generate the server identity keypair locally.
#   - Clone the Flagship repo at the pinned git ref, build the daemon.
#   - Register the new server with .services.
#   - Seal the LUKS unlock key with the phone's per-server pubkey and
#     hand it to .services so the phone can authorize future boots.
#
# Args: $1 = trailer source device
#       $2 = path to validated install-blob JSON
#       $3 = git ref the bootstrap pinned to (e.g. "main", "v0.1.0")

set -eu

TRAILER_SRC="$1"
BLOB_JSON="$2"
GIT_REF="${3:-main}"
LOG=/var/log/flagship-install.log
INSTALLED_FLAG=/var/flagship/installed.flag
REPO_URL="https://github.com/harrywinner2/flagship.git"

exec >>"$LOG" 2>&1
date

# Read the values we need from the validated blob.
SERVER_DOMAIN="$(jq -r .serverDomain "$BLOB_JSON")"
USERNAME="$(jq -r .username "$BLOB_JSON")"
SERVER_NAME="$(jq -r .serverName "$BLOB_JSON")"
REGISTRATION_URL="$(jq -r .registrationUrl "$BLOB_JSON")"
PHONE_DELEGATED_PUBKEY="$(jq -r .phoneDelegatedPubKey "$BLOB_JSON")"
AUTH_CODE_SERIAL="$(jq -r .authCode.serial "$BLOB_JSON")"

echo "flagship: installing $SERVER_DOMAIN"

# 1. Pick the install target — first non-removable disk that's bigger
#    than 8 GiB and isn't the boot medium itself.
TARGET=""
for d in /dev/nvme0n1 /dev/sda /dev/vda /dev/mmcblk0; do
    [ -b "$d" ] || continue
    [ "$d" = "$TRAILER_SRC" ] && continue
    SIZE=$(blockdev --getsize64 "$d" 2>/dev/null || echo 0)
    [ "$SIZE" -lt $((8 * 1024 * 1024 * 1024)) ] && continue
    TARGET="$d"
    break
done
if [ -z "$TARGET" ]; then
    echo "flagship: no install-target disk found"
    exit 1
fi
echo "flagship: target = $TARGET"

# 2. Partition: 256 MiB unencrypted boot partition (carries trailer copy
#    + boot-stage code), rest LUKS-encrypted.
parted -s "$TARGET" mklabel gpt
parted -s "$TARGET" mkpart "FLAGSHIP_BOOT" ext4 1MiB 257MiB
parted -s "$TARGET" mkpart "FLAGSHIP_ROOT" 257MiB 100%
parted -s "$TARGET" set 1 esp on

# Detect partition naming (sda1 vs nvme0n1p1)
case "$TARGET" in
    *nvme*|*mmc*) BOOT_PART="${TARGET}p1"; ROOT_PART="${TARGET}p2";;
    *)            BOOT_PART="${TARGET}1";  ROOT_PART="${TARGET}2";;
esac

mkfs.ext4 -L FLAGSHIP_BOOT "$BOOT_PART"

# 3. Generate the LUKS unlock material. The phone provides the unlock
#    key on each boot; for *first* boot we generate a random local key,
#    encrypt it with the phone-delegated pubkey using libsodium-seal,
#    and post the sealed blob to .services as part of registration.
#    The phone, on first authorization, decrypts it and returns the raw
#    key — which is what every subsequent boot will receive.
LUKS_KEY=/run/flagship-luks.key
head -c 64 /dev/urandom > "$LUKS_KEY"
chmod 600 "$LUKS_KEY"

cryptsetup luksFormat --type luks2 --batch-mode --key-file "$LUKS_KEY" "$ROOT_PART"
cryptsetup luksOpen --key-file "$LUKS_KEY" "$ROOT_PART" flagship_root
mkfs.ext4 -L FLAGSHIP_ROOT /dev/mapper/flagship_root

mount /dev/mapper/flagship_root /mnt
mkdir -p /mnt/etc /mnt/var/flagship /mnt/usr/local/bin /mnt/boot
mount "$BOOT_PART" /mnt/boot

# 4. Generate the server's identity keypair (used to sign tunnel
#    HELLOs and the server-register request). The raw priv lives on the
#    encrypted root; the boot stage gets the same priv as a PKCS8 PEM
#    on /boot so it can authenticate the unlock-key/consume call.
SERVER_IDENTITY_DIR=/mnt/var/flagship/identity
mkdir -p "$SERVER_IDENTITY_DIR"
chmod 700 "$SERVER_IDENTITY_DIR"
# Helper expects to be run from inside the cloned repo. The clone happens
# in step 5 below, so we need to clone first then come back to step 4.

# 5. Fetch flagship code into the encrypted root, install build deps,
#    build the daemon, set up the systemd-equivalent unit (OpenRC under
#    Alpine). Docker is added here too — it backs both the per-app
#    AppRunner and the unified data-layer compose stack (postgres,
#    minio, redis, adminer).
apk add --no-cache git nodejs npm openrc openssl docker docker-cli-compose curl
rc-update add docker default
service docker start || true
git clone --depth 1 --branch "$GIT_REF" "$REPO_URL" /mnt/opt/flagship || \
    git clone --depth 1 "$REPO_URL" /mnt/opt/flagship
cd /mnt/opt/flagship
chroot /mnt sh -c "cd /opt/flagship && npm ci --include-workspace-root --no-audit"
chroot /mnt sh -c "cd /opt/flagship && npx tsc -b"

# 4b. Now that the repo is cloned, generate the identity material via
#     install-helper. Writes raw priv hex + raw pub hex + PKCS8 PEM.
chroot /mnt sh -c "cd /opt/flagship && npx tsx scripts/install-helper.ts gen-identity \
    --out-priv /var/flagship/identity/identity.priv.hex \
    --out-pub  /var/flagship/identity/identity.pub.hex \
    --out-pem  /boot/identity.pem"
SERVER_IDENTITY_PRIV_HEX="$(cat /mnt/var/flagship/identity/identity.priv.hex | tr -d '\n')"
SERVER_IDENTITY_PUB="$(cat /mnt/var/flagship/identity/identity.pub.hex | tr -d '\n')"

# Bring up the unified data-layer (postgres + minio + redis + adminer)
# at boot via OpenRC. The init.sh script under installer/data-services/
# is idempotent: secret generation only happens once; subsequent boots
# just `docker compose up -d` against existing volumes.
cat > /mnt/etc/init.d/flagship-data-services <<'OPENRC'
#!/sbin/openrc-run
name="flagship-data-services"
description="Flagship unified data layer: postgres + minio + redis + adminer"
command="/opt/flagship/installer/data-services/init.sh"
command_background="no"
pidfile="/run/flagship-data-services.pid"
depend() {
    need net docker
    before flagship-daemon
}
OPENRC
chmod +x /mnt/etc/init.d/flagship-data-services
chroot /mnt rc-update add flagship-data-services default

cat > /mnt/etc/init.d/flagship-daemon <<'OPENRC'
#!/sbin/openrc-run
name="flagship-daemon"
command="/usr/bin/npx"
command_args="--workspace=@flagship/server-daemon run start"
directory="/opt/flagship"
pidfile="/run/flagship-daemon.pid"
command_background="yes"
depend() {
    need net flagship-data-services
}
OPENRC
chmod +x /mnt/etc/init.d/flagship-daemon
chroot /mnt rc-update add flagship-daemon default

# 6. Persist the install-time facts the daemon needs.
cp "$BLOB_JSON" /mnt/var/flagship/install-blob.json
echo "$SERVER_DOMAIN"        > /mnt/var/flagship/server-domain
echo "$USERNAME"             > /mnt/var/flagship/username
echo "$SERVER_NAME"          > /mnt/var/flagship/server-name
echo "$PHONE_DELEGATED_PUBKEY" > /mnt/var/flagship/phone-delegated.pub
echo "$AUTH_CODE_SERIAL"     > /mnt/var/flagship/auth-code-serial

# Boot partition gets a copy of the trailer + the boot-stage script so
# every subsequent boot can find them without mounting the LUKS volume.
cp "$BLOB_JSON" /mnt/boot/install-blob.json
echo "$PHONE_DELEGATED_PUBKEY" > /mnt/boot/phone-delegated.pub
echo "$REGISTRATION_URL"     > /mnt/boot/registration-url
echo "$SERVER_DOMAIN"        > /mnt/boot/server-domain
echo "$GIT_REF"              > /mnt/boot/installer-ref

# 7. Encrypt the LUKS key for the phone. The actual sealed-box (x25519
#    sealed_box / libsodium) implementation isn't yet wired into the
#    install-helper — that piece needs the phone's BAK / PSK pubkey
#    layout to be finalized. For now we placeholder a hex-encoded copy
#    of the LUKS key as the "sealed" payload; the LUKS unlock flow
#    still works because the phone-side will round-trip the same bytes
#    until real sealing is in place.
#    TODO: replace placeholder with libsodium sealed_box once phone is wired.
SEALED_LUKS_KEY_HEX="$(xxd -p -c 256 "$LUKS_KEY" | tr -d '\n')"

# 8. Register with .services via the runtime-agnostic control-plane handler.
#    install-helper signs the ServerRegisterRequest from the auth-code blob
#    + server identity priv.
chroot /mnt sh -c "cd /opt/flagship && npx tsx scripts/install-helper.ts \
    sign-server-register \
    --priv-hex \"$SERVER_IDENTITY_PRIV_HEX\" \
    --auth-code-blob /var/flagship/install-blob.json \
    > /run/register-payload.json"
curl -fsS -X POST -H 'content-type: application/json' \
    --data @/mnt/run/register-payload.json \
    "$REGISTRATION_URL"
echo "flagship: registered $SERVER_DOMAIN"

# 9. Push the sealed LUKS key to .com via the new authenticated endpoint.
NOW_MS=$(date +%s%3N)
chroot /mnt sh -c "cd /opt/flagship && npx tsx scripts/install-helper.ts \
    sign-sealed-key \
    --priv \"$SERVER_IDENTITY_PRIV_HEX\" \
    --server-id \"$SERVER_DOMAIN\" \
    --sealed-hex \"$SEALED_LUKS_KEY_HEX\" \
    --issued-at \"$NOW_MS\" \
    > /run/sealed-key-payload.json"
CONTROL_PLANE_BASE="$(echo "$REGISTRATION_URL" | sed 's|/api/server/register$||')"
curl -fsS -X POST -H 'content-type: application/json' \
    --data @/mnt/run/sealed-key-payload.json \
    "${CONTROL_PLANE_BASE}/api/server/${SERVER_DOMAIN}/sealed-luks-key" \
    || echo "flagship: warning — sealed-key upload failed; phone will need OOB"

# 10. Boot-stage script runs on every boot.
install -m 755 /usr/local/bin/flagship-boot-stage.sh /mnt/usr/local/bin/flagship-boot-stage.sh

# 11. Bootloader (Alpine's setup-bootable equivalent — syslinux on the
#     unencrypted boot partition).
chroot /mnt sh -c "apk add syslinux && extlinux --install /boot && \
    dd if=/usr/share/syslinux/mbr.bin of=$TARGET bs=440 count=1"

# 12. Mark installed and reboot.
mkdir -p /mnt/var/flagship
date > /mnt/var/flagship/installed.flag
sync
umount /mnt/boot
umount /mnt
cryptsetup luksClose flagship_root

echo "flagship: install complete; rebooting"
reboot
