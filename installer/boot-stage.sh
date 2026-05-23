#!/bin/sh
# Steady-state boot stage. Runs from the unencrypted /boot partition on
# every boot, before the LUKS-encrypted root is mounted. Fetches the LUKS
# unlock key and unlocks the root.
#
# No phone (and no box-sealed lease), no decryption. A stolen server with
# no phone is a brick.
#
# TWO paths, tried in order (docs/security-phone-as-unlock-endpoint.md):
#
#   1. RELAY (preferred) — the box posts an STK-signed SecretRequest to
#      `.com`'s blind mailbox; the user's phone (woken by push) re-seals
#      the LUKS key FOR this box's STK and posts it back; the box polls
#      it, then unseals it LOCALLY with /boot/flagship-unseal. `.com`
#      only ever holds ciphertext — it can withhold (a DoS) but never
#      read the disk key. This is the same POST/poll/unseal/luksOpen flow
#      wave 4 wires into the Ubuntu/subiquity initramfs.
#
#   2. PLAINTEXT CONSUME (fallback) — the legacy path: the phone deposits
#      the key plaintext at `.com`, which one-shot relays it via
#      /unlock-key/consume. Kept so a box still boots during the
#      transition (and if /boot/flagship-unseal is absent on an older
#      ISO). `.com` sees the key for that window — weaker, hence fallback.
#
# Cryptography here is pure shell + openssl + curl + xxd:
#   - Ed25519 signing via `openssl pkeyutl -sign -rawin -inkey identity.pem`
#     (the install stage writes the server identity priv key to
#     /boot/identity.pem in PKCS8 PEM form).
#   - canonical-bytes layouts match @flagship/protocol:
#       consume:        flagship/consume-unlock-key/v1|<serverId>|<hex-nonce>|<issuedAt>
#       secret-request: flagship/secret-request/v1|<serverDomain>|<hex-stkpub>|<purpose>|<hex-nonce>|<issuedAt>
#
# Files expected on /boot:
#   /boot/server-domain         e.g. "home.harry.flagship.services"
#   /boot/identity.pem          Ed25519 priv key (PKCS8 PEM, 0600)
#   /boot/control-plane-url     optional, defaults to flagshipserver.com
#   /boot/flagship-unseal       static unseal helper (relay path; optional)
#
# /boot is unencrypted by design: an attacker who pulls the disk gets the
# identity key, but on the relay path the key is only ever sealed FOR that
# identity in-flight (so .com never sees it), and on either path the
# identity key alone can't fetch a key — the control plane only releases
# what the phone has actively provided.

set -eu

LOG=/var/log/flagship-boot-stage.log
mkdir -p /var/log
exec >>"$LOG" 2>&1
date

SERVER_DOMAIN="$(cat /boot/server-domain)"
CONTROL_PLANE="$(cat /boot/control-plane-url 2>/dev/null || echo https://flagshipserver.com)"
IDENTITY_KEY=/boot/identity.pem
UNSEAL_HELPER=/boot/flagship-unseal

# How long (seconds) to wait for the phone via the relay before falling
# back to the plaintext consume path. The phone is push-woken on the
# POST, so a few minutes is the human-attention budget for first boot.
RELAY_WINDOW_SECS="${FLAGSHIP_RELAY_WINDOW_SECS:-180}"

if [ ! -f "$IDENTITY_KEY" ]; then
    echo "flagship: missing $IDENTITY_KEY (install must write a PKCS8 PEM)"
    exit 1
fi

OUT_UNLOCK=/run/unlock-key

# Sign canonical-bytes with the server identity Ed25519 private key.
# Returns the signature as 128-char hex. OpenSSL 3.0+ requires a file
# (not stdin) for oneshot rawin mode, so we stage the bytes to /run.
sign_canonical() {
    canonical="$1"
    msgfile="/run/flagship-sign-msg.bin"
    printf '%s' "$canonical" > "$msgfile"
    openssl pkeyutl -sign -rawin -inkey "$IDENTITY_KEY" -in "$msgfile" 2>/dev/null \
        | xxd -p -c 256 \
        | tr -d '\n'
    rm -f "$msgfile"
}

# The box's STK identity, derived from the on-/boot PKCS8 PEM:
#   - seed (32-byte Ed25519 priv): the last 32 bytes of the 48-byte PKCS8
#     DER (fixed 16-byte ASN.1 prefix). This is the SAME 32-byte seed the
#     daemon uses as Keypair.privateKey and that /boot/flagship-unseal
#     wants for --identity-priv-hex.
#   - pubkey (the STK pubkey, signed into the SecretRequest): the last 32
#     bytes of the 44-byte SubjectPublicKeyInfo DER.
identity_seed_hex() {
    openssl pkey -in "$IDENTITY_KEY" -outform DER 2>/dev/null \
        | xxd -p -c 256 | tr -d '\n' | tail -c 64
}
identity_pub_hex() {
    openssl pkey -in "$IDENTITY_KEY" -pubout -outform DER 2>/dev/null \
        | xxd -p -c 256 | tr -d '\n' | tail -c 64
}

# ── Path 1: RELAY ──────────────────────────────────────────────────────
# POST an STK-signed SecretRequest{purpose:"unlock-key"} → poll the
# mailbox for the phone's sealed reply → unseal it LOCALLY with
# /boot/flagship-unseal → write the LUKS key hex to $OUT_UNLOCK.
#
# Returns 0 on success ($OUT_UNLOCK populated), non-zero on any failure
# (no helper, no reply within the window, helper non-zero, network) so the
# caller can fall back. Self-contained so wave 4 can lift it verbatim into
# the Ubuntu/subiquity initramfs.
unlock_via_relay() {
    if [ ! -x "$UNSEAL_HELPER" ]; then
        echo "flagship: relay unavailable — $UNSEAL_HELPER missing/not executable"
        return 1
    fi

    SEED_HEX="$(identity_seed_hex)"
    PUB_HEX="$(identity_pub_hex)"
    if [ "${#SEED_HEX}" != 64 ] || [ "${#PUB_HEX}" != 64 ]; then
        echo "flagship: relay aborted — could not derive 32-byte seed/pub from $IDENTITY_KEY"
        return 1
    fi

    NONCE=$(head -c 32 /dev/urandom | xxd -p -c 256 | tr -d '\n')
    NOW_MS=$(date +%s%3N)
    # canonicalSecretRequest join order: tag|serverDomain|hex(stkPub)|purpose|hex(nonce)|issuedAt
    CANONICAL="flagship/secret-request/v1|${SERVER_DOMAIN}|${PUB_HEX}|unlock-key|${NONCE}|${NOW_MS}"
    SIG="$(sign_canonical "$CANONICAL")"

    REQ_URL="${CONTROL_PLANE}/api/server/${SERVER_DOMAIN}/secret-request"
    REQ_BODY=$(printf '{"request":{"serverDomain":"%s","stkPub":"%s","purpose":"unlock-key","nonce":"%s","issuedAt":%s},"signature":"%s"}' \
        "$SERVER_DOMAIN" "$PUB_HEX" "$NONCE" "$NOW_MS" "$SIG")

    POST_RESP=/run/flagship-secret-request-resp.json
    POST_CODE=$(curl -sS -o "$POST_RESP" -w "%{http_code}" \
        -X POST -H 'content-type: application/json' \
        --max-time 30 -d "$REQ_BODY" "$REQ_URL" || echo "000")
    if [ "$POST_CODE" != "200" ]; then
        echo "flagship: relay secret-request HTTP $POST_CODE; body: $(head -c 200 "$POST_RESP" 2>/dev/null)"
        return 1
    fi
    echo "flagship: posted unlock-key secret-request; waiting up to ${RELAY_WINDOW_SECS}s for the phone"

    POLL_URL="${CONTROL_PLANE}/api/server/${SERVER_DOMAIN}/secret-response?nonce=${NONCE}"
    DEADLINE=$(( $(date +%s) + RELAY_WINDOW_SECS ))
    ATTEMPT=0
    while [ "$(date +%s)" -lt "$DEADLINE" ]; do
        ATTEMPT=$((ATTEMPT + 1))
        RESP=/run/flagship-secret-response.json
        CODE=$(curl -sS -o "$RESP" -w "%{http_code}" \
            --max-time 30 "$POLL_URL" || echo "000")

        if [ "$CODE" = "200" ]; then
            # .com returns {serverDomain,requestNonceHex,purpose,sealed,issuedAt}.
            # The unseal helper's --response-json wants the same shape but with
            # `sealedHex` instead of `sealed`; transform it. The helper verifies
            # the bound (nonce, purpose) against what we sent, so a replayed /
            # repurposed reply is rejected inside the helper.
            SEALED=$(sed -n 's/.*"sealed":"\([0-9a-fA-F]*\)".*/\1/p' "$RESP")
            if [ -z "$SEALED" ]; then
                echo "flagship: relay 200 but no sealed payload: $(head -c 200 "$RESP")"
                return 1
            fi
            HELPER_JSON=/run/flagship-unseal-input.json
            printf '{"serverDomain":"%s","requestNonceHex":"%s","purpose":"unlock-key","sealedHex":"%s","issuedAt":0}' \
                "$SERVER_DOMAIN" "$NONCE" "$SEALED" > "$HELPER_JSON"

            if "$UNSEAL_HELPER" --identity-priv-hex "$SEED_HEX" --response-json "$HELPER_JSON" \
                > "$OUT_UNLOCK.hex" 2>/run/flagship-unseal.err; then
                tr -d '\n' < "$OUT_UNLOCK.hex" > "$OUT_UNLOCK"
                chmod 600 "$OUT_UNLOCK"
                rm -f "$OUT_UNLOCK.hex" "$HELPER_JSON"
                echo "flagship: relay unsealed the unlock key (attempt $ATTEMPT)"
                return 0
            fi
            echo "flagship: $UNSEAL_HELPER failed: $(head -c 200 /run/flagship-unseal.err 2>/dev/null)"
            rm -f "$OUT_UNLOCK.hex" "$HELPER_JSON"
            return 1
        elif [ "$CODE" = "404" ]; then
            : # no reply yet — expected; keep polling
        else
            echo "flagship: relay secret-response HTTP $CODE; body: $(head -c 200 "$RESP" 2>/dev/null)"
            return 1
        fi

        BACKOFF=$((ATTEMPT < 6 ? ATTEMPT * 3 : 15))
        echo "flagship: no phone reply yet (attempt $ATTEMPT); sleeping $BACKOFF"
        sleep "$BACKOFF"
    done

    echo "flagship: relay window (${RELAY_WINDOW_SECS}s) elapsed with no phone reply"
    return 1
}

# ── Path 2: PLAINTEXT CONSUME (fallback) ───────────────────────────────
# The legacy /unlock-key/consume path: poll until the phone has deposited
# the plaintext key, write it to $OUT_UNLOCK. Loops indefinitely (a box
# with no phone correctly blocks here, exactly as before). Returns 0 once
# the key is in hand.
unlock_via_plaintext_consume() {
    CONSUME_URL="${CONTROL_PLANE}/api/server/${SERVER_DOMAIN}/unlock-key/consume"
    echo "flagship: falling back to plaintext consume at ${CONSUME_URL}"

    ATTEMPT=0
    while :; do
        ATTEMPT=$((ATTEMPT + 1))
        NONCE=$(head -c 32 /dev/urandom | xxd -p -c 256 | tr -d '\n')
        NOW_MS=$(date +%s%3N)
        CANONICAL="flagship/consume-unlock-key/v1|${SERVER_DOMAIN}|${NONCE}|${NOW_MS}"
        SIG="$(sign_canonical "$CANONICAL")"

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
                echo "flagship: got unlock key via consume (attempt $ATTEMPT)"
                printf '%s' "$UNLOCK_HEX" > "$OUT_UNLOCK"
                chmod 600 "$OUT_UNLOCK"
                return 0
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
}

# Try the sealed relay first; fall back to the plaintext consume path so a
# box still boots during the transition (or on an older ISO with no
# unseal helper). Either way $OUT_UNLOCK ends up with the LUKS key hex.
if ! unlock_via_relay; then
    unlock_via_plaintext_consume
fi

ROOT_PART=/dev/disk/by-label/FLAGSHIP_ROOT
xxd -r -p "$OUT_UNLOCK" | cryptsetup luksOpen --key-file - "$ROOT_PART" flagship_root
mount /dev/mapper/flagship_root /mnt
shred -u "$OUT_UNLOCK" 2>/dev/null || rm -f "$OUT_UNLOCK"
exec switch_root /mnt /sbin/init
