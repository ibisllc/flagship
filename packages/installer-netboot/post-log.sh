#!/bin/sh
# Flagship d-i debug log exfil — POSTs a single chunk to the Worker's
# /api/dev/late-log/<label> endpoint. Best-effort, never blocks.
#
# Args:
#   $1 = stage tag (e.g. "d-i-started", "late-cmd-pre", "npm-ci-done")
#   $2 = optional log file path (cat'd into the body, last 32 KB)
#
# Label defaults to the parsed username from /tmp/flagship-username
# (written by early-scan). Falls back to a hostname-derived tag when
# no trailer has been parsed yet.
#
# d-i environment quirks: GNU curl is not pre-installed in mini.iso
# debian-installer; busybox wget is. wget POST needs `--post-file=`
# (a path on disk, not stdin). We write to a temp file, then try
# curl → wget → /dev/tcp as a last resort. ALL stderr suppressed.
set -eu

STAGE="${1:-stage}"
LOGFILE="${2:-}"

# Pick a label.
if [ -f /tmp/flagship-username ]; then
    LABEL="$(cat /tmp/flagship-username | tr -d '\n')"
elif [ -f /target/var/flagship/username ]; then
    LABEL="$(cat /target/var/flagship/username | tr -d '\n')"
elif [ -f /var/flagship/username ]; then
    LABEL="$(cat /var/flagship/username | tr -d '\n')"
else
    H="$(hostname 2>/dev/null || echo unknown)"
    LABEL="boot-${H}"
fi
LABEL=$(printf '%s' "$LABEL" | tr -c 'A-Za-z0-9._-' '_' | cut -c1-128)

URL="https://flagshipserver.com/api/dev/late-log/${LABEL}"
TS=$(date -u +%FT%TZ 2>/dev/null || date 2>/dev/null || echo unknown)

# Compose body to a temp file (wget --post-file= needs a path).
TMP="/tmp/flagship-post.$$"
{
    printf '### %s [%s]\n' "$TS" "$STAGE"
    if [ -n "$LOGFILE" ] && [ -f "$LOGFILE" ]; then
        tail -c 32768 "$LOGFILE" 2>/dev/null
    fi
} > "$TMP" 2>/dev/null || echo "(no body)" > "$TMP"

# Also keep a LOCAL trace so post-mortem disk forensics show what we
# tried even when network was down.
mkdir -p /tmp/flagship-trace 2>/dev/null || true
cp "$TMP" "/tmp/flagship-trace/${TS}-${STAGE}.txt" 2>/dev/null || true

if command -v curl >/dev/null 2>&1; then
    curl -fsS -X POST --max-time 15 \
        -H 'content-type: text/plain' \
        --data-binary "@$TMP" "$URL" >/dev/null 2>&1 || true
elif command -v wget >/dev/null 2>&1; then
    # GNU + busybox wget: both accept --post-file=PATH.
    wget -q -O- --post-file="$TMP" --timeout=15 "$URL" >/dev/null 2>&1 || true
fi

rm -f "$TMP" 2>/dev/null || true
exit 0
