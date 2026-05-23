#!/bin/sh
# Steady-state boot stage. Runs from the unencrypted /boot partition on
# every boot, before the LUKS-encrypted root is mounted. Fetches the LUKS
# unlock key and unlocks the root.
#
# A two-tier boot-unlock policy (docs/security-phone-as-unlock-endpoint.md
# §7a + §7a.1), chosen at server creation and baked to
# /boot/flagship-boot-unlock-mode ("auto" or "approve"; absent ⇒ "auto"):
#
#   auto (default) — try a BOX-SEALED LEASE first: GET the box-sealed lease
#      from `.com` and unseal it LOCALLY with /boot/flagship-unseal + the STK
#      key on /boot. No phone, no human. `.com` holds ciphertext only (I1).
#      If there is no lease (first boot, or a revoked lease) fall back to the
#      RELAY. The box NEVER deposits a lease itself (the phone does that,
#      IRK-signed). A stolen box is revocable from the phone (DELETE the lease
#      ⇒ bricked on next reboot).
#
#   approve — phone-gated RELAY on EVERY boot. The box must NOT read a
#      box-sealed lease at all (defense in depth — a critical server cannot
#      self-unlock; a whole-box/disk thief cannot boot it).
#
# RELAY — the box posts an STK-signed SecretRequest to `.com`'s blind mailbox;
#      the user's phone (woken by push) re-seals the LUKS key FOR this box's
#      STK and posts it back; the box polls it, then unseals it LOCALLY with
#      /boot/flagship-unseal. `.com` only ever holds ciphertext — it can
#      withhold (a DoS) but never read the disk key. This is the same
#      POST/poll/unseal/luksOpen flow wired into the Ubuntu/subiquity initramfs.
#
# The legacy PLAINTEXT CONSUME path is RETIRED from the dispatch (strictly
# weaker — `.com` would see the key). It is not a fallback in either mode.
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
#   /boot/server-domain               e.g. "home.harry.flagship.services"
#   /boot/identity.pem                Ed25519 priv key (PKCS8 PEM, 0600)
#   /boot/control-plane-url           optional, defaults to flagshipserver.com
#   /boot/flagship-unseal             static unseal helper (relay/lease; optional)
#   /boot/flagship-boot-unlock-mode   "auto" | "approve"; optional, default "auto"
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
# Boot-unlock policy (docs/security-phone-as-unlock-endpoint.md §7a.1).
# Baked at install; default "auto" if the file is absent.
BOOT_UNLOCK_MODE="$(cat /boot/flagship-boot-unlock-mode 2>/dev/null || echo auto)"

# How long (seconds) to wait for the phone via the relay. The phone is
# push-woken on the POST, so a few minutes is the human-attention budget
# for first boot.
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

# ── unlock_via_box_lease() — "auto" self-unlock, no phone ──────────────────
# GET the box-sealed lease and unseal it LOCALLY with the STK key on /boot.
# `.com` holds ciphertext only (I1). No phone, no human. Returns 0 only if it
# actually unsealed; 404/empty (first boot, or a revoked lease) ⇒ non-zero so
# the caller falls back to the relay. Self-contained so the wave-4a initramfs
# hook can lift it verbatim (it mirrors unlock_via_relay()'s "sealed" parse).
unlock_via_box_lease() {
    if [ ! -x "$UNSEAL_HELPER" ]; then
        echo "flagship: box-lease unavailable — $UNSEAL_HELPER missing/not executable"
        return 1
    fi
    SEED_HEX="$(identity_seed_hex)"
    if [ "${#SEED_HEX}" != 64 ]; then
        echo "flagship: box-lease aborted — could not derive 32-byte seed from $IDENTITY_KEY"
        return 1
    fi

    LEASE_URL="${CONTROL_PLANE}/api/server/${SERVER_DOMAIN}/unlock-key/lease-v2"
    LEASE_RESP=/run/flagship-lease-v2.json
    LEASE_CODE=$(curl -sS -o "$LEASE_RESP" -w "%{http_code}" \
        --max-time 30 "$LEASE_URL" || echo "000")
    if [ "$LEASE_CODE" = "404" ]; then
        echo "flagship: no box-sealed lease (HTTP 404) — falling back"
        return 1
    fi
    if [ "$LEASE_CODE" != "200" ]; then
        echo "flagship: box-lease HTTP $LEASE_CODE; body: $(head -c 200 "$LEASE_RESP" 2>/dev/null)"
        return 1
    fi

    # .com returns {serverDomain,leaseId,stkPub,sealedKey,...}; sealedKey is the
    # box-sealed LUKS key (hex). Extract it the same way unlock_via_relay()
    # extracts "sealed".
    SEALED_KEY=$(sed -n 's/.*"sealedKey":"\([0-9a-fA-F]*\)".*/\1/p' "$LEASE_RESP")
    if [ -z "$SEALED_KEY" ]; then
        echo "flagship: box-lease 200 but no sealedKey: $(head -c 200 "$LEASE_RESP")"
        return 1
    fi

    if "$UNSEAL_HELPER" --identity-priv-hex "$SEED_HEX" --sealed-hex "$SEALED_KEY" \
        > "$OUT_UNLOCK.hex" 2>/run/flagship-unseal.err; then
        tr -d '\n' < "$OUT_UNLOCK.hex" > "$OUT_UNLOCK"
        chmod 600 "$OUT_UNLOCK"
        rm -f "$OUT_UNLOCK.hex"
        echo "flagship: self-unlocked from the box-sealed lease"
        return 0
    fi
    echo "flagship: $UNSEAL_HELPER failed on box-lease: $(head -c 200 /run/flagship-unseal.err 2>/dev/null)"
    rm -f "$OUT_UNLOCK.hex"
    return 1
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

# ── Two-tier dispatch (docs/security-phone-as-unlock-endpoint.md §7a.1) ────
# The legacy plaintext-consume path is RETIRED — never a fallback here.
#   auto:    box-sealed lease (self-unlock, no phone); fall back to the relay.
#   approve: phone relay EVERY boot; the box NEVER reads a box-sealed lease.
# Either way $OUT_UNLOCK ends up with the LUKS key hex.
echo "flagship: boot-unlock mode = $BOOT_UNLOCK_MODE"
if [ "$BOOT_UNLOCK_MODE" = "approve" ]; then
    unlock_via_relay
else
    if ! unlock_via_box_lease; then
        unlock_via_relay
    fi
fi

ROOT_PART=/dev/disk/by-label/FLAGSHIP_ROOT
xxd -r -p "$OUT_UNLOCK" | cryptsetup luksOpen --key-file - "$ROOT_PART" flagship_root
mount /dev/mapper/flagship_root /mnt
shred -u "$OUT_UNLOCK" 2>/dev/null || rm -f "$OUT_UNLOCK"
exec switch_root /mnt /sbin/init
