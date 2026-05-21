#!/bin/sh
# Flagship d-i early-scan — runs in preseed/early_command, BEFORE
# partman wipes the install target.
#
# Why early: the trailer MUST be parsed before partman can touch it.
# Two install topologies:
#   - Hetzner cloud demo: cloud-init wrote [base ISO][trailer] to
#     /dev/sda + a copy at disk-end. partman's crypto recipe ALSO
#     installs to /dev/sda, possibly clobbering the trailer.
#   - Real laptop+USB: trailer lives on the USB stick (e.g. /dev/sdb).
#     The install target is the internal disk (e.g. /dev/sda) which
#     partman wipes. Late-command can't read trailer post-install.
#
# Solution: scan every block device for the FLAGSHIP-BOOT magic.
# When found, parse + verify + stash to /tmp/flagship-blob.env (initrd
# RAM survives partman wipe). late-command sources from there.
set -eu

LOG=/tmp/flagship-early.log
exec >>"$LOG" 2>&1
echo "[early-scan] starting at $(date -u +%FT%TZ)"
echo "[early-scan] available block devices:"
ls -la /dev/sd* /dev/vd* /dev/nvme*n* 2>/dev/null || true
echo

# Try the parse on each candidate; first success wins. parse-trailer
# reads TOTAL_SIZE from the LAST 4 bytes of the block device, then
# seeks back. A device with no trailer there returns garbage TOTAL,
# parse-trailer rejects via the range check. Cost per try is one
# 4-byte dd + a few syscalls — fast even if we try 10 devices.
FOUND=""
for DEV in /dev/sda /dev/sdb /dev/sdc /dev/sdd /dev/sde /dev/vda /dev/vdb /dev/nvme0n1 /dev/nvme1n1 /dev/mmcblk0; do
    [ -b "$DEV" ] || continue
    echo "[early-scan] trying $DEV"
    if /flagship/parse-trailer.sh "$DEV" > /tmp/flagship-blob.env.candidate 2>/dev/null; then
        # parse-trailer wrote the same fields late-command expects:
        # eval would set them, but we want to capture them as a file.
        # parse-trailer emits `KEY='value'` lines — perfect for shell
        # sourcing OR copying as-is.
        mv /tmp/flagship-blob.env.candidate /tmp/flagship-blob.env
        FOUND="$DEV"
        echo "[early-scan] parsed trailer from $DEV"
        break
    fi
done

if [ -z "$FOUND" ]; then
    echo "[early-scan] WARN: no trailer found on any block device"
    echo "[early-scan] devices tried: /dev/{sd,vd}[a-e], /dev/nvme[01]n1, /dev/mmcblk0"
    exit 0  # don't abort install — late-command can still try
fi

# Re-extract the raw blob JSON (parse-trailer emits base64). Stash for
# late-command + the post-log.sh helper.
. /tmp/flagship-blob.env
if [ -n "${FLAGSHIP_BLOB_JSON_BASE64:-}" ]; then
    printf '%s' "$FLAGSHIP_BLOB_JSON_BASE64" | base64 -d > /tmp/flagship-blob.json
fi

# Stash the username so post-log.sh can default to it as the log label.
printf '%s\n' "$FLAGSHIP_USERNAME" > /tmp/flagship-username

echo "[early-scan] done; username=$FLAGSHIP_USERNAME domain=$FLAGSHIP_SERVER_DOMAIN ref=$FLAGSHIP_INSTALLER_GIT_REF"
