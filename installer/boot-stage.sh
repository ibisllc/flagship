#!/bin/sh
# Steady-state boot stage. Runs from the unencrypted /boot partition on
# every boot, before the LUKS-encrypted root is mounted. Polls the .com
# control plane for the unsealed LUKS unlock key — which the user's
# phone deposits after biometric approval — and unlocks the root.
#
# No phone, no decryption. A stolen server with no phone is a brick.
#
# Cryptography here is pure shell + openssl + curl + xxd:
#   - Ed25519 signing via `openssl pkeyutl -sign -rawin -inkey identity.pem`
#     (the install stage writes the server identity priv key to
#     /boot/identity.pem in PKCS8 PEM form).
#   - canonical-bytes layout matches @flagship/protocol's
#     `canonicalConsumeUnlockKey`:
#       flagship/consume-unlock-key/v1|<serverId>|<hex-nonce>|<issuedAt>
#
# Files expected on /boot:
#   /boot/server-domain         e.g. "home.harry.flagship.services"
#   /boot/identity.pem          Ed25519 priv key (PKCS8 PEM, 0600)
#   /boot/control-plane-url     optional, defaults to flagshipserver.com
#
# /boot is unencrypted by design: an attacker who pulls the disk gets
# the identity key, but the unlock key is only ever in-flight for the
# brief window between phone deposit and boot consume. Without the
# phone, the identity key alone can't fetch a key — the control plane
# only releases what the phone has actively deposited.

set -eu

LOG=/var/log/flagship-boot-stage.log
mkdir -p /var/log
exec >>"$LOG" 2>&1
date

SERVER_DOMAIN="$(cat /boot/server-domain)"
CONTROL_PLANE="$(cat /boot/control-plane-url 2>/dev/null || echo https://flagshipserver.com)"
IDENTITY_KEY=/boot/identity.pem

if [ ! -f "$IDENTITY_KEY" ]; then
    echo "flagship: missing $IDENTITY_KEY (install must write a PKCS8 PEM)"
    exit 1
fi

CONSUME_URL="${CONTROL_PLANE}/api/server/${SERVER_DOMAIN}/unlock-key/consume"
echo "flagship: polling ${CONSUME_URL}"

# Sign canonical-bytes for ConsumeUnlockKey with the server identity
# Ed25519 private key. Returns the signature as 128-char hex.
#
# OpenSSL 3.0+ requires a file (not stdin) for oneshot rawin mode, so we
# stage the canonical bytes to a tmpfile in /run.
sign_consume() {
    canonical="$1"
    msgfile="/run/flagship-consume-msg.bin"
    printf '%s' "$canonical" > "$msgfile"
    openssl pkeyutl -sign -rawin -inkey "$IDENTITY_KEY" -in "$msgfile" 2>/dev/null \
        | xxd -p -c 256 \
        | tr -d '\n'
    rm -f "$msgfile"
}

ATTEMPT=0
while :; do
    ATTEMPT=$((ATTEMPT + 1))
    NONCE=$(head -c 32 /dev/urandom | xxd -p -c 256 | tr -d '\n')
    NOW_MS=$(date +%s%3N)
    CANONICAL="flagship/consume-unlock-key/v1|${SERVER_DOMAIN}|${NONCE}|${NOW_MS}"
    SIG="$(sign_consume "$CANONICAL")"

    BODY=$(printf '{"request":{"serverId":"%s","nonce":"%s","issuedAt":%s},"signature":"%s"}' \
        "$SERVER_DOMAIN" "$NONCE" "$NOW_MS" "$SIG")

    HTTP_BODY=/run/flagship-consume-resp.json
    HTTP_CODE=$(curl -sS -o "$HTTP_BODY" -w "%{http_code}" \
        -X POST -H 'content-type: application/json' \
        --max-time 30 -d "$BODY" "$CONSUME_URL" || echo "000")

    if [ "$HTTP_CODE" = "200" ]; then
        # Response shape: {"unlockKey":"<hex>","depositedAt":<ms>,"expiresAt":<ms>}
        UNLOCK_HEX=$(sed -n 's/.*"unlockKey":"\([0-9a-f]*\)".*/\1/p' "$HTTP_BODY")
        if [ -n "$UNLOCK_HEX" ]; then
            echo "flagship: got unlock key (attempt $ATTEMPT)"
            printf '%s' "$UNLOCK_HEX" > /run/unlock-key
            chmod 600 /run/unlock-key
            break
        fi
        echo "flagship: 200 but unlockKey missing in response: $(head -c 200 "$HTTP_BODY")"
    elif [ "$HTTP_CODE" = "404" ]; then
        : # phone hasn't deposited yet — expected; keep polling
    else
        echo "flagship: HTTP $HTTP_CODE on consume; body: $(head -c 200 "$HTTP_BODY")"
    fi

    BACKOFF=$((ATTEMPT < 6 ? ATTEMPT * 5 : 30))
    echo "flagship: no unlock key yet (attempt $ATTEMPT); sleeping $BACKOFF"
    sleep "$BACKOFF"
done

ROOT_PART=/dev/disk/by-label/FLAGSHIP_ROOT
xxd -r -p /run/unlock-key | cryptsetup luksOpen --key-file - "$ROOT_PART" flagship_root
mount /dev/mapper/flagship_root /mnt
shred -u /run/unlock-key 2>/dev/null || rm -f /run/unlock-key
exec switch_root /mnt /sbin/init
