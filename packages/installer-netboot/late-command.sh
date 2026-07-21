#!/bin/bash
# Flagship netboot late-command — W12.
#
# Runs INSIDE the chrooted /target (= installed Debian rootfs), invoked
# by preseed/late_command via `in-target`. By this point d-i has:
#   - partitioned /dev/sda with the encrypted-LVM atomic recipe,
#   - LUKS-formatted the root volume with a placeholder passphrase,
#   - bootstrapped a minimal Debian rootfs into the encrypted LVM,
#   - installed pkgsel/include packages (openssh-server git curl jq
#     nodejs npm cryptsetup lvm2 ca-certificates xxd).
#
# Our job here is everything that was in installer/install.sh for the
# Alpine path, adapted for the Debian/systemd world:
#   1. Parse + validate the trailer from /dev/sda (our trailer lives at
#      disk_size - trailer_size, written by the Worker's cloud-init).
#   2. Rotate the LUKS passphrase from the d-i placeholder to one
#      derived from the install blob + the phone-delegated pubkey.
#   3. Clone the Flagship repo at the pinned git ref + build the daemon.
#   4. Generate the server identity keypair.
#   5. Install systemd units (flagship-data-services + flagship-boot-stage
#      + flagship-daemon, ordered).
#   6. Seal the LUKS key for the phone + register with .com.
#
# All non-fatal best-effort, because d-i aborts the install if
# late-command fails; we'd rather have a slightly-broken first boot
# than a half-installed disk we have to nuke and reprovision.

set -euo pipefail
exec >>/var/log/flagship-late-command.log 2>&1
echo "[flagship] late-command starting at $(date)"

REPO_URL="${FLAGSHIP_REPO_URL:-https://github.com/ibisllc/flagship.git}"

# Best-effort post-log helper (no-op if missing).
post_stage() {
    [ -x /root/post-log.sh ] && /root/post-log.sh "$1" "${2:-/var/log/flagship-late-command.log}" || true
}

# ── 1. Get the trailer-derived env ──────────────────────────────
# preseed's early_command parsed the trailer BEFORE partman wiped the
# install target (Hetzner) or while the USB was still mounted (real
# install). Parsed values were stashed at /tmp/flagship-blob.env in
# initrd RAM, then copied to /root/flagship-blob.env across the
# chroot boundary. Prefer that pre-parsed env; fall back to parsing
# /dev/sda directly only if the stash is missing (older preseed).
if [ -f /root/flagship-blob.env ]; then
    echo "[flagship] sourcing pre-parsed trailer env from /root/flagship-blob.env"
    set -a
    . /root/flagship-blob.env
    set +a
    # post-log.sh inside the chroot needs /tmp/flagship-username to
    # default to the right label.
    mkdir -p /tmp
    printf '%s\n' "$FLAGSHIP_USERNAME" > /tmp/flagship-username
else
    echo "[flagship] no pre-parsed env — falling back to direct /dev/sda parse"
    if ! eval "$(/root/parse-trailer.sh /dev/sda)"; then
        echo "[flagship] FATAL: trailer parse/verify failed" >&2
        post_stage "FATAL-trailer-parse-failed"
        exit 1
    fi
    mkdir -p /tmp
    printf '%s\n' "$FLAGSHIP_USERNAME" > /tmp/flagship-username
fi
echo "[flagship] trailer verified — username=$FLAGSHIP_USERNAME domain=$FLAGSHIP_SERVER_DOMAIN ref=$FLAGSHIP_INSTALLER_GIT_REF"
post_stage "trailer-loaded"

# Validate installer git-ref shape (same allowlist as the apkovl
# bootstrap's validate_ref). Refs go onto a git CLI; defense in depth.
case "$FLAGSHIP_INSTALLER_GIT_REF" in
    ""|"null"|*..*) echo "[flagship] FATAL: bad installer git ref" >&2; exit 1;;
    *[!A-Za-z0-9._/-]*) echo "[flagship] FATAL: ref has disallowed chars" >&2; exit 1;;
esac

mkdir -p /var/flagship /boot/flagship

# Drop the validated blob JSON onto the installed rootfs for the
# daemon's first-boot reads.
echo "$FLAGSHIP_BLOB_JSON_BASE64" | base64 -d > /var/flagship/install-blob.json
chmod 600 /var/flagship/install-blob.json
echo "$FLAGSHIP_SERVER_DOMAIN" > /var/flagship/server-domain
echo "$FLAGSHIP_USERNAME"      > /var/flagship/username
echo "$FLAGSHIP_SERVER_NAME"   > /var/flagship/server-name
echo "$FLAGSHIP_PHONE_DELEGATED_PUBKEY" > /var/flagship/phone-delegated.pub
echo "$FLAGSHIP_AUTH_CODE_SERIAL"       > /var/flagship/auth-code-serial

# Boot-partition copies so steady-state boot-stage can find them
# without mounting the LUKS root.
cp /var/flagship/install-blob.json /boot/install-blob.json
echo "$FLAGSHIP_PHONE_DELEGATED_PUBKEY" > /boot/phone-delegated.pub
echo "$FLAGSHIP_REGISTRATION_URL"       > /boot/registration-url
echo "$FLAGSHIP_SERVER_DOMAIN"          > /boot/server-domain
echo "$FLAGSHIP_INSTALLER_GIT_REF"      > /boot/installer-ref

# ── 2. Rotate the LUKS passphrase ────────────────────────────────
# d-i set the LUKS passphrase to the placeholder
# "flagship-firstboot-placeholder" from the preseed; we now mint the
# real first-boot LUKS key (random 64 bytes), add it to the LUKS
# header, and remove the placeholder. Identifying which partition is
# the LUKS-encrypted root: d-i's `atomic` recipe puts the encrypted
# physical-volume on /dev/sda5 (or sda3 on UEFI-only disks) with the
# LVM rootfs on top. We look it up via cryptsetup's status table.
PLACEHOLDER_PASS="flagship-firstboot-placeholder"
LUKS_KEY=/run/flagship-luks.key
mkdir -p /run
head -c 64 /dev/urandom > "$LUKS_KEY"
chmod 600 "$LUKS_KEY"

# Find the LUKS PV. d-i registers it under /dev/mapper/<name>_crypt
# (typically sda5_crypt). The underlying block device is what we need
# to luksAddKey on.
CRYPT_NAME=""
for d in /dev/mapper/*_crypt; do
    [ -e "$d" ] || continue
    CRYPT_NAME="$(basename "$d")"
    break
done
if [[ -z "$CRYPT_NAME" ]]; then
    echo "[flagship] warning: no /dev/mapper/*_crypt; LUKS key rotation skipped"
else
    UNDERLYING=$(cryptsetup status "$CRYPT_NAME" 2>/dev/null | awk '/device:/ {print $2}' || true)
    if [[ -n "$UNDERLYING" && -b "$UNDERLYING" ]]; then
        echo "[flagship] rotating LUKS key on $UNDERLYING (mapper=$CRYPT_NAME)"
        # `--key-file -` reads the existing passphrase from stdin; the
        # new key file goes onto a fresh slot.
        if printf '%s' "$PLACEHOLDER_PASS" | \
                cryptsetup luksAddKey "$UNDERLYING" "$LUKS_KEY" --key-file - 2>>/var/log/flagship-late-command.log; then
            # Remove the placeholder once the real key is in place.
            printf '%s' "$PLACEHOLDER_PASS" | \
                cryptsetup luksRemoveKey "$UNDERLYING" --key-file - 2>>/var/log/flagship-late-command.log || \
                echo "[flagship] warning: placeholder LUKS slot remained — manually remove later"
            echo "[flagship] LUKS key rotated"
        else
            echo "[flagship] warning: luksAddKey failed; keeping placeholder for now"
        fi
    else
        echo "[flagship] warning: underlying block device for $CRYPT_NAME unknown"
    fi
fi

post_stage "luks-rotation-done"

# ── 3. Clone the Flagship repo at the pinned ref ────────────────
echo "[flagship] cloning $REPO_URL @ $FLAGSHIP_INSTALLER_GIT_REF into /opt/flagship"
rm -rf /opt/flagship
if ! git clone --depth 50 --branch "$FLAGSHIP_INSTALLER_GIT_REF" "$REPO_URL" /opt/flagship 2>>/var/log/flagship-late-command.log; then
    # Fallback: ref is a commit SHA rather than a branch/tag.
    git clone --depth 50 "$REPO_URL" /opt/flagship
    git -C /opt/flagship fetch --depth 50 origin "$FLAGSHIP_INSTALLER_GIT_REF"
    git -C /opt/flagship checkout "$FLAGSHIP_INSTALLER_GIT_REF"
fi

post_stage "git-clone-done"

cd /opt/flagship
echo "[flagship] npm ci"
npm ci --omit=optional --no-audit --no-fund || {
    echo "[flagship] npm ci failed — daemon will not start until repaired" >&2
}
post_stage "npm-ci-done"
echo "[flagship] tsc -b"
npx tsc -b || echo "[flagship] tsc -b reported errors — daemon may still start" >&2
post_stage "tsc-done"

# ── 4. Generate server identity ─────────────────────────────────
echo "[flagship] generating server identity"
mkdir -p /var/flagship/identity
chmod 700 /var/flagship/identity
npx tsx scripts/install-helper.ts gen-identity \
    --out-priv /var/flagship/identity/identity.priv.hex \
    --out-pub  /var/flagship/identity/identity.pub.hex \
    --out-pem  /boot/identity.pem
chmod 600 /var/flagship/identity/identity.priv.hex /boot/identity.pem

SERVER_IDENTITY_PRIV_HEX="$(tr -d '\n' < /var/flagship/identity/identity.priv.hex)"

# ── 5. Systemd units ────────────────────────────────────────────
echo "[flagship] writing systemd units"

# 5a. flagship-data-services — the unified data layer (postgres + minio
# + redis + adminer) under docker compose. The init.sh script under
# installer/data-services/ is idempotent: secret generation only
# happens once; subsequent boots just `docker compose up -d`.
cat > /etc/systemd/system/flagship-data-services.service <<'UNIT'
[Unit]
Description=Flagship unified data layer (postgres + minio + redis + adminer)
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/opt/flagship/installer/data-services/init.sh
# ExecStop makes `systemctl stop flagship-data-services` ACTUALLY stop the
# compose containers. Without it (Type=oneshot + RemainAfterExit) the unit only
# marks itself inactive while postgres/minio/redis/forgejo keep running — so a
# migration/decommission "freeze" walked live, torn data. `stop` (not `down`)
# preserves the data volumes; this is a write-freeze, not a wipe.
ExecStop=/usr/bin/docker compose -f /opt/flagship/installer/data-services/docker-compose.yml --env-file /var/flagship/data-services.env stop
TimeoutStartSec=300
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
UNIT

# 5b. flagship-boot-stage — runs on every boot BEFORE the encrypted
# root is needed. Polls .com for the unlock-key, opens the LUKS volume,
# then exits. (On the cloud demo path the LUKS root is already open
# from the install, but the same unit runs cleanly on subsequent
# bare-metal boots too.)
cat > /etc/systemd/system/flagship-boot-stage.service <<'UNIT'
[Unit]
Description=Flagship steady-state boot stage (phone-mediated LUKS unlock)
After=network-online.target
Wants=network-online.target
Before=flagship-data-services.service flagship-daemon.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/flagship-boot-stage.sh

[Install]
WantedBy=multi-user.target
UNIT

# 5c. flagship-daemon — the actual server-daemon process.
cat > /etc/systemd/system/flagship-daemon.service <<'UNIT'
[Unit]
Description=Flagship server daemon
After=flagship-data-services.service flagship-boot-stage.service network-online.target
Wants=network-online.target
Requires=flagship-data-services.service
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=/opt/flagship
ExecStart=/usr/bin/npx --workspace=@flagship/server-daemon run start
# `always`, NOT `on-failure`: the daemon exits 0 to request a self-restart after
# provisioning a post-boot secret (SWK/CGK deposit), rotating the admin root, or
# committing an update. `on-failure` treats exit 0 as success and would leave the
# box dead after it consumes its SWK, before it ever serves HTTPS.
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

# Install boot-stage from the freshly-cloned repo.
install -m 755 /opt/flagship/installer/boot-stage.sh /usr/local/bin/flagship-boot-stage.sh

systemctl daemon-reload
systemctl enable flagship-data-services.service flagship-boot-stage.service flagship-daemon.service
echo "[flagship] systemd units installed + enabled"

# ── 6. Seal LUKS key for the phone + register ───────────────────
# Only meaningful when the LUKS key rotation above succeeded — if it
# didn't we have no key to seal.
if [[ -s "$LUKS_KEY" && -n "${FLAGSHIP_PHONE_DELEGATED_PUBKEY:-}" ]]; then
    echo "[flagship] sealing LUKS key for phone-delegated pubkey"
    SEALED_LUKS_KEY_HEX="$(cd /opt/flagship && npx tsx scripts/install-helper.ts \
        seal-for-bak \
        --bak-ed25519-pub "$FLAGSHIP_PHONE_DELEGATED_PUBKEY" \
        --in "$LUKS_KEY" | tr -d '\n' || echo '')"
    shred -u "$LUKS_KEY" 2>/dev/null || rm -f "$LUKS_KEY"

    if [[ -n "$SEALED_LUKS_KEY_HEX" ]]; then
        # First-boot registration is a oneshot systemd unit so we don't
        # block the install if .com is unreachable from inside d-i's
        # post-install chroot (which sometimes has limited egress).
        cat > /etc/systemd/system/flagship-first-boot-register.service <<UNIT
[Unit]
Description=Flagship first-boot registration with .com
After=network-online.target
Wants=network-online.target
ConditionPathExists=!/var/flagship/registered.flag

[Service]
Type=oneshot
WorkingDirectory=/opt/flagship
ExecStart=/bin/bash -lc 'NOW=\$(date +%s%3N) && \
  npx tsx scripts/install-helper.ts sign-server-register \
      --priv-hex "$SERVER_IDENTITY_PRIV_HEX" \
      --auth-code-blob /var/flagship/install-blob.json \
      > /run/register-payload.json && \
  curl -fsS -X POST -H "content-type: application/json" \
      --data @/run/register-payload.json \
      "$FLAGSHIP_REGISTRATION_URL" && \
  CTRL_BASE=\$(echo "$FLAGSHIP_REGISTRATION_URL" | sed "s|/api/server/register\$||") && \
  npx tsx scripts/install-helper.ts sign-sealed-key \
      --priv "$SERVER_IDENTITY_PRIV_HEX" \
      --server-id "$FLAGSHIP_SERVER_DOMAIN" \
      --sealed-hex "$SEALED_LUKS_KEY_HEX" \
      --issued-at \$NOW \
      > /run/sealed-key-payload.json && \
  curl -fsS -X POST -H "content-type: application/json" \
      --data @/run/sealed-key-payload.json \
      "\${CTRL_BASE}/api/server/$FLAGSHIP_SERVER_DOMAIN/sealed-luks-key" && \
  date > /var/flagship/registered.flag'

[Install]
WantedBy=multi-user.target
UNIT
        systemctl enable flagship-first-boot-register.service
        echo "[flagship] first-boot registration unit enabled"
    else
        echo "[flagship] warning: seal-for-bak produced empty output; skipping registration unit"
    fi
fi

# Mark installed.
date > /var/flagship/installed.flag
echo "[flagship] late-command done at $(date)"
post_stage "late-command-done"
