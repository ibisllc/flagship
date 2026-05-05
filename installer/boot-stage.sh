#!/bin/sh
# Steady-state boot stage. Runs on every boot from the unencrypted
# /boot partition. Asks .services for the LUKS unlock material (which the
# user's phone, when next online, decrypted from the sealed key we
# uploaded at install time and pushed back).
#
# Loops until the phone authorizes. No phone, no decryption — server
# is a brick. That's by design.

set -eu

LOG=/var/log/flagship-boot-stage.log
exec >>"$LOG" 2>&1
date

SERVER_DOMAIN="$(cat /boot/server-domain)"
PHONE_DELEGATED_PUBKEY="$(cat /boot/phone-delegated.pub)"
REGISTRATION_BASE="${REGISTRATION_URL%/server/register}"

POLL_URL="${REGISTRATION_BASE}/server/${SERVER_DOMAIN}/unlock-key"
echo "flagship: polling $POLL_URL for phone unlock material"

ATTEMPT=0
while :; do
    ATTEMPT=$((ATTEMPT + 1))
    UNLOCK_PAYLOAD="$(curl -fsSL --max-time 30 "$POLL_URL" || true)"
    if [ -n "$UNLOCK_PAYLOAD" ]; then
        echo "$UNLOCK_PAYLOAD" > /run/unlock-key
        break
    fi
    BACKOFF=$((ATTEMPT < 6 ? ATTEMPT * 5 : 30))
    echo "flagship: no unlock key yet (attempt $ATTEMPT); sleeping $BACKOFF"
    sleep "$BACKOFF"
done

# unlock-key is hex(32 bytes random) — same value the phone unsealed
# from the sealed-luks-key we uploaded at install time.
ROOT_PART=/dev/disk/by-label/FLAGSHIP_ROOT
xxd -r -p /run/unlock-key | cryptsetup luksOpen --key-file - "$ROOT_PART" flagship_root

mount /dev/mapper/flagship_root /mnt
exec switch_root /mnt /sbin/init
