#!/bin/sh
# Steady-state boot stage. Runs from the unencrypted /boot partition on
# every boot, before the LUKS-encrypted root is mounted. Fetches the LUKS
# unlock key and unlocks the root.
#
# This talks to the DEDICATED BOOT WORKER at boot.flagshipserver.com (the
# host is configurable — see BOOT_HOST below). Every call is identity-gated:
# the box is the "box" principal and signs with its STK (server identity)
# key. The contract (apps/boot/src/routes.ts):
#   GET  /api/boot/lease/:serverDomain            box-STK → the box-sealed lease (auto)
#   POST /api/boot/request                        box-STK → announce "I need approval"
#   GET  /api/boot/response/:serverDomain/:nonce  box-STK → poll for the phone's sealed reply
#
# A two-tier boot-unlock policy (docs/security-phone-as-unlock-endpoint.md
# §7a + §7a.1), chosen at server creation and baked to
# /boot/flagship-boot-unlock-mode ("auto" or "approve"; absent ⇒ "auto"):
#
#   auto (default) — try a BOX-SEALED LEASE first: GET the box-sealed lease
#      from the boot worker and unseal it LOCALLY with /boot/flagship-unseal +
#      the STK key on /boot. No phone, no human. The worker holds ciphertext
#      only (I1). If there is no lease (first boot, or a revoked lease) fall
#      back to the RELAY. The box NEVER deposits a lease itself (the phone does
#      that, IRK-signed). A stolen box is revocable from the phone (the owner
#      DELETEs the lease ⇒ bricked on next reboot).
#
#   approve — phone-gated RELAY on EVERY boot. The box must NOT read a
#      box-sealed lease at all (defense in depth — a critical server cannot
#      self-unlock; a whole-box/disk thief cannot boot it).
#
# ONE-SHOT LOCK (/boot/flagship-lock-once): a transient marker the daemon
# drops when the owner taps "Lock and restart"/"Lock and turn off" OR when
# the dead-man timer lapses (packages/server-daemon/src/deadMan.ts —
# BootUnlockModeSuppressor). When present it forces the approve relay for
# THIS boot ONLY, on top of the baseline mode above; it is CONSUMED
# (deleted) after a successful unlock so the NEXT boot reverts to the
# baseline. This makes a manual lock a single-power-cycle event rather than
# a permanent flip to approve-on-every-boot. If the baseline is already
# approve, the marker is a harmless no-op (the box asks regardless).
#
# RELAY — the box POSTs an STK-signed SecretRequest to the boot worker's blind
#      mailbox (/api/boot/request); the user's phone (woken by push) re-seals
#      the LUKS key FOR this box's STK and posts it back; the box polls
#      /api/boot/response, then unseals it LOCALLY with /boot/flagship-unseal.
#      The worker only ever holds ciphertext — it can withhold (a DoS) but never
#      read the disk key. This is the same POST/poll/unseal/luksOpen flow wired
#      into the Ubuntu/subiquity initramfs.
#
# The legacy PLAINTEXT CONSUME path is RETIRED from the dispatch (strictly
# weaker — the worker would see the key). It is not a fallback in either mode.
#
# Cryptography here is pure shell + openssl + curl + xxd:
#   - Ed25519 signing via `openssl pkeyutl -sign -rawin -inkey identity.pem`
#     (the install stage writes the server identity priv key to
#     /boot/identity.pem in PKCS8 PEM form). @flagship/protocol uses
#     @noble/ed25519 (RFC 8032), so the boot worker's `ed.verify` accepts an
#     openssl raw Ed25519 signature over the identical canonical bytes.
#   - canonical-bytes layouts match @flagship/protocol / apps/boot/src/gate.ts:
#       secret-request: flagship/secret-request/v1|<serverDomain>|<hex-stkpub>|<purpose>|<hex-nonce>|<issuedAt>
#       box-auth:       flagship/boot-auth/v1|box|<serverDomain>|<METHOD>|<path>|<hex-pub>|<hex-nonce>|<issuedAt>
#     The box-auth signature travels in the `Authorization` header as
#       Authorization: Flagship-Boot-v1 <base64url(JSON envelope)>
#     where the JSON envelope is
#       {role,serverDomain,method,path,pubKeyHex,nonceHex,issuedAt,signatureHex}.
#     The gate re-extracts the fields by NAME and rebuilds the canonical string,
#     so JSON key order is irrelevant — only the canonical string is signed.
#     base64url = base64 with +→-, /→_, and trailing '=' stripped.
#
# Files expected on /boot:
#   /boot/server-domain               e.g. "home.harry.flagship.services"
#   /boot/identity.pem                Ed25519 priv key (PKCS8 PEM, 0600)
#   /boot/flagship-boot-host          optional, default https://boot.flagshipserver.com
#                                     (enterprise clones override the boot worker)
#   /boot/control-plane-url           optional, legacy; default flagshipserver.com
#   /boot/flagship-unseal             static unseal helper (relay/lease; optional)
#   /boot/flagship-boot-unlock-mode   "auto" | "approve"; optional, default "auto"
#   /boot/flagship-lock-once          one-shot lock marker; optional. Present ⇒
#                                     force the approve relay for THIS boot, then
#                                     delete after a successful unlock.
#
# /boot is unencrypted by design: an attacker who pulls the disk gets the
# identity key, but on the relay path the key is only ever sealed FOR that
# identity in-flight (so the worker never sees it), and on either path the
# identity key alone can't fetch a key — the boot worker only releases what
# the phone has actively provided.

set -eu

LOG=/var/log/flagship-boot-stage.log
mkdir -p /var/log
exec >>"$LOG" 2>&1
date

SERVER_DOMAIN="$(cat /boot/server-domain)"
# The dedicated boot worker (boot.flagshipserver.com). Configurable so a
# burned recipe / enterprise clone can repoint it without touching code —
# mirrors how /boot/flagship-boot-unlock-mode is read. Default if absent.
BOOT_HOST="$(cat /boot/flagship-boot-host 2>/dev/null || echo https://boot.flagshipserver.com)"
BOOT_HOST="${BOOT_HOST%/}"
IDENTITY_KEY=/boot/identity.pem
UNSEAL_HELPER=/boot/flagship-unseal
# Boot-unlock policy (docs/security-phone-as-unlock-endpoint.md §7a.1).
# Baked at install; default "auto" if the file is absent. This is the box's
# BASELINE mode — it is never mutated at runtime by a manual lock.
BOOT_UNLOCK_MODE="$(cat /boot/flagship-boot-unlock-mode 2>/dev/null || echo auto)"
# One-shot lock marker (packages/server-daemon BootUnlockModeSuppressor).
# Present ⇒ force the approve relay for THIS boot only; consumed after a
# successful unlock so the next boot reverts to BOOT_UNLOCK_MODE above.
LOCK_ONCE_MARKER=/boot/flagship-lock-once
LOCK_ONCE="no"
[ -f "$LOCK_ONCE_MARKER" ] && LOCK_ONCE="yes"

# How long (seconds) to wait for the phone via the relay. The phone is
# push-woken on the POST, so a few minutes is the human-attention budget
# for first boot.
RELAY_WINDOW_SECS="${FLAGSHIP_RELAY_WINDOW_SECS:-31536000}"

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

# base64url-encode stdin (base64 then +→-, /→_, strip trailing '=') — the
# encoding apps/boot/src/gate.ts parses the Authorization payload as.
b64url() {
    openssl base64 -A | tr '+/' '-_' | tr -d '='
}

# Epoch milliseconds, PORTABLE. GNU date supports %3N; busybox date (the
# initramfs copy of this routine) prints %N literally, corrupting the signed
# envelope + body issuedAt. Keep this helper in sync with the initramfs premount
# in packages/flagship-burner/src/userdata.ts.
now_ms() {
    _ms=$(date +%s%3N 2>/dev/null)
    case "$_ms" in
        ''|*[!0-9]*) _ms=$(( $(date +%s) * 1000 ));;
    esac
    echo "$_ms"
}

# Build the box-STK `Authorization: Flagship-Boot-v1 <b64url(json)>` header
# value for a boot-worker request. Bound to the exact (method, path,
# serverDomain) so a captured header cannot be retargeted to another route
# (apps/boot/src/gate.ts rule 4). The signature is Ed25519 over the canonical
# bytes
#   flagship/boot-auth/v1|box|<serverDomain>|<METHOD>|<path>|<pub>|<nonce>|<issuedAt>
# signed with the box's STK PRIVATE key (the same /boot/identity.pem used for
# the SecretRequest body sig). Echoes the full header value to stdout.
#
# Args: $1 = HTTP method (uppercase), $2 = request path (no query).
# Uses PUB_HEX (the box STK pub) from the calling scope.
sign_box_auth_header() {
    _bm="$1"
    _bp="$2"
    _bnonce=$(head -c 32 /dev/urandom | xxd -p -c 256 | tr -d '\n')
    _bnow=$(now_ms)
    # Canonical bytes — MUST match canonicalBootAuth() in apps/boot/src/gate.ts
    # byte-for-byte (tag|role|serverDomain|METHOD|path|pubHexLower|nonceHexLower|issuedAt).
    _bcanon="flagship/boot-auth/v1|box|${SERVER_DOMAIN}|${_bm}|${_bp}|${PUB_HEX}|${_bnonce}|${_bnow}"
    _bsig="$(sign_canonical "$_bcanon")"
    # The JSON envelope. The gate re-extracts fields by name, so key order is
    # irrelevant; all values are hex / a method token / an int / a host-safe
    # domain+path, so none need JSON escaping.
    _bjson="$(printf '{"role":"box","serverDomain":"%s","method":"%s","path":"%s","pubKeyHex":"%s","nonceHex":"%s","issuedAt":%s,"signatureHex":"%s"}' \
        "$SERVER_DOMAIN" "$_bm" "$_bp" "$PUB_HEX" "$_bnonce" "$_bnow" "$_bsig")"
    printf 'Flagship-Boot-v1 %s' "$(printf '%s' "$_bjson" | b64url)"
}

# ── unlock_via_box_lease() — "auto" self-unlock, no phone ──────────────────
# GET the box-sealed lease and unseal it LOCALLY with the STK key on /boot.
# The boot worker holds ciphertext only (I1). No phone, no human. Returns 0 only if it
# actually unsealed; 404/empty (first boot, or a revoked lease) ⇒ non-zero so
# the caller falls back to the relay. Self-contained so the wave-4a initramfs
# hook can lift it verbatim (it mirrors unlock_via_relay()'s "sealed" parse).
unlock_via_box_lease() {
    if [ ! -x "$UNSEAL_HELPER" ]; then
        echo "flagship: box-lease unavailable — $UNSEAL_HELPER missing/not executable"
        return 1
    fi
    SEED_HEX="$(identity_seed_hex)"
    PUB_HEX="$(identity_pub_hex)"
    if [ "${#SEED_HEX}" != 64 ] || [ "${#PUB_HEX}" != 64 ]; then
        echo "flagship: box-lease aborted — could not derive 32-byte seed/pub from $IDENTITY_KEY"
        return 1
    fi

    # GET /api/boot/lease/:serverDomain — box-STK gated. The path is bound
    # into the signed Authorization envelope (no query string).
    LEASE_PATH="/api/boot/lease/${SERVER_DOMAIN}"
    LEASE_URL="${BOOT_HOST}${LEASE_PATH}"
    LEASE_AUTH="$(sign_box_auth_header GET "$LEASE_PATH")"
    LEASE_RESP=/run/flagship-lease-v2.json
    LEASE_CODE=$(curl -sS -o "$LEASE_RESP" -w "%{http_code}" \
        -H "Authorization: $LEASE_AUTH" \
        --max-time 30 "$LEASE_URL" || echo "000")
    if [ "$LEASE_CODE" = "404" ]; then
        echo "flagship: no box-sealed lease (HTTP 404) — falling back"
        return 1
    fi
    if [ "$LEASE_CODE" != "200" ]; then
        echo "flagship: box-lease HTTP $LEASE_CODE; body: $(head -c 200 "$LEASE_RESP" 2>/dev/null)"
        return 1
    fi

    # The boot worker returns {serverDomain,leaseId,stkPub,sealedKey,...};
    # sealedKey is the box-sealed LUKS key (hex). Extract it the same way
    # unlock_via_relay() extracts "sealed". The box unseals it locally.
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
    NOW_MS=$(now_ms)
    # The SecretRequest body keeps its OWN STK signature (unchanged):
    # canonicalSecretRequest join order: tag|serverDomain|hex(stkPub)|purpose|hex(nonce)|issuedAt
    # NONCE/NOW_MS/CANONICAL/SIG/REQ_BODY are built ONCE here and reused for every
    # (re-)announce — a heartbeat re-POST replays the SAME signed envelope.
    CANONICAL="flagship/secret-request/v1|${SERVER_DOMAIN}|${PUB_HEX}|unlock-key|${NONCE}|${NOW_MS}"
    SIG="$(sign_canonical "$CANONICAL")"

    # POST /api/boot/request — box-STK gated. The body is the box's STK-signed
    # SecretRequest envelope (its own signature, separate from the box-auth
    # header). The boot worker re-verifies both before parking the request +
    # firing the owner push.
    REQ_PATH="/api/boot/request"
    REQ_URL="${BOOT_HOST}${REQ_PATH}"
    REQ_BODY=$(printf '{"request":{"serverDomain":"%s","stkPub":"%s","purpose":"unlock-key","nonce":"%s","issuedAt":%s},"signature":"%s"}' \
        "$SERVER_DOMAIN" "$PUB_HEX" "$NONCE" "$NOW_MS" "$SIG")

    # post_request: (re-)announce the SAME signed REQ_BODY with a FRESH box-auth
    # header. Idempotent on the worker (same nonce) — the first call parks the
    # request + pushes the phone; later calls only refresh the parked row's TTL.
    post_request() {
        POST_RESP=/run/flagship-secret-request-resp.json
        REQ_AUTH="$(sign_box_auth_header POST "$REQ_PATH")"
        POST_CODE=$(curl -sS -o "$POST_RESP" -w "%{http_code}" \
            -X POST -H 'content-type: application/json' \
            -H "Authorization: $REQ_AUTH" \
            --max-time 30 -d "$REQ_BODY" "$REQ_URL" || echo "000")
        [ "$POST_CODE" = "200" ]
    }

    # DEBUG builds expose a console "manual" passphrase fallback at the unlock
    # prompt; PRODUCTION builds suppress it entirely — there is no offline bypass
    # of the phone-approval unlock. Gated on /boot/flagship-debug-mode, a marker
    # the bootstrap drops ONLY for a debug burn (absent ⇒ production).
    MANUAL_HINT=""
    [ -f /boot/flagship-debug-mode ] && MANUAL_HINT=" (type 'manual' then Enter to unlock by passphrase)"

    # Initial announce. A failed FIRST announce is fatal (fall through to manual);
    # later heartbeat re-announce failures are non-fatal — we keep polling.
    if ! post_request; then
        echo "flagship: relay boot-request HTTP $POST_CODE; body: $(head -c 200 "$POST_RESP" 2>/dev/null)"
        return 1
    fi
    echo "flagship: posted unlock-key boot-request; waiting for phone approval${MANUAL_HINT}"

    # GET /api/boot/response/:serverDomain/:nonce — box-STK gated, polled. The
    # nonce is a PATH segment now (not a query), and is bound into the signed
    # Authorization envelope, so a fresh header is signed for each poll.
    POLL_PATH="/api/boot/response/${SERVER_DOMAIN}/${NONCE}"
    POLL_URL="${BOOT_HOST}${POLL_PATH}"
    # Effectively wait forever for the phone (default ~1 year); the DEADLINE is a
    # backstop so an env override (FLAGSHIP_RELAY_WINDOW_SECS) can still bound it.
    DEADLINE=$(( $(date +%s) + RELAY_WINDOW_SECS ))
    # Re-announce the parked request every HEARTBEAT_SECS so a short worker TTL
    # stays alive while we wait; when the box powers off the TTL lapses and the
    # phone honestly sees "box stopped".
    HEARTBEAT_SECS="${FLAGSHIP_RELAY_HEARTBEAT_SECS:-120}"
    LAST_ANNOUNCE=$(date +%s)
    ATTEMPT=0
    while [ "$(date +%s)" -lt "$DEADLINE" ]; do
        ATTEMPT=$((ATTEMPT + 1))
        RESP=/run/flagship-secret-response.json
        POLL_AUTH="$(sign_box_auth_header GET "$POLL_PATH")"
        CODE=$(curl -sS -o "$RESP" -w "%{http_code}" \
            -H "Authorization: $POLL_AUTH" \
            --max-time 30 "$POLL_URL" || echo "000")

        if [ "$CODE" = "200" ]; then
            # The boot worker returns {serverDomain,requestNonceHex,purpose,sealed,issuedAt}.
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
            # Transient non-200 — we wait forever now, so log and keep polling.
            echo "flagship: relay boot-response HTTP $CODE; body: $(head -c 200 "$RESP" 2>/dev/null)"
        fi

        # Heartbeat: re-announce the parked request to refresh its TTL. A failed
        # re-post is non-fatal — keep polling.
        if [ $(( $(date +%s) - LAST_ANNOUNCE )) -ge "$HEARTBEAT_SECS" ]; then
            if post_request; then
                echo "flagship: heartbeat re-announced boot-request (TTL refreshed)"
            else
                echo "flagship: heartbeat re-announce failed (HTTP $POST_CODE); continuing"
            fi
            LAST_ANNOUNCE=$(date +%s)
        fi

        BACKOFF=$((ATTEMPT < 6 ? ATTEMPT * 3 : 15))
        echo "flagship: no phone reply yet (attempt $ATTEMPT); waiting $BACKOFF${MANUAL_HINT}"
        if [ -n "$MANUAL_HINT" ]; then
            # DEBUG: interruptible wait — any line typed on the console (e.g.
            # "manual") drops to the manual disk passphrase prompt. On a headless
            # box read -t blocks for BACKOFF and times out (acts as the sleep).
            if read -t "$BACKOFF" -r _key < /dev/console 2>/dev/null && [ "$_key" = "manual" ]; then
                echo "flagship: manual unlock selected — falling through to the disk passphrase prompt"
                return 1
            fi
        else
            # PRODUCTION: no console bypass — just wait the backoff and keep polling.
            sleep "$BACKOFF"
        fi
    done

    echo "flagship: relay backstop window (${RELAY_WINDOW_SECS}s) elapsed with no phone reply"
    return 1
}

# ── Two-tier dispatch (docs/security-phone-as-unlock-endpoint.md §7a.1) ────
# The legacy plaintext-consume path is RETIRED — never a fallback here.
#   auto:    box-sealed lease (self-unlock, no phone); fall back to the relay.
#   approve: phone relay EVERY boot; the box NEVER reads a box-sealed lease.
# Either way $OUT_UNLOCK ends up with the LUKS key hex.
#
# EFFECTIVE mode = baseline OR a one-shot lock. The one-shot marker forces
# the approve relay for THIS boot on top of the baseline; we consume it only
# AFTER a successful luksOpen below so a failed/interrupted unlock keeps the
# lock armed for the retry.
EFFECTIVE_MODE="$BOOT_UNLOCK_MODE"
if [ "$LOCK_ONCE" = "yes" ]; then
    echo "flagship: one-shot lock marker present — forcing approve relay for THIS boot"
    EFFECTIVE_MODE="approve"
fi
echo "flagship: boot-unlock mode = $EFFECTIVE_MODE (baseline=$BOOT_UNLOCK_MODE, lock-once=$LOCK_ONCE)"
if [ "$EFFECTIVE_MODE" = "approve" ]; then
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
# CONSUME the one-shot lock marker only now — after a successful unlock — so
# the NEXT boot reverts to the baseline BOOT_UNLOCK_MODE. Done post-luksOpen
# (not pre) so an unlock that never completes leaves the lock armed.
if [ "$LOCK_ONCE" = "yes" ]; then
    rm -f "$LOCK_ONCE_MARKER"
    echo "flagship: consumed one-shot lock marker; next boot reverts to baseline ($BOOT_UNLOCK_MODE)"
fi
exec switch_root /mnt /sbin/init
