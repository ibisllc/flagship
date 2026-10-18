#!/bin/sh
# Flagship d-i stage trace. Keeps a LOCAL copy of a stage's log tail under
# /tmp/flagship-trace/ for post-mortem disk forensics. It used to POST the
# tail to the control plane's /api/dev/late-log endpoint; that endpoint and
# every installer upload are gone (AGENTS.md GA close-out 5), so nothing leaves
# the box. The name stays because preseed.cfg and late-command.sh call it.
#
# Args:
#   $1 = stage tag (e.g. "d-i-started", "late-cmd-pre", "npm-ci-done")
#   $2 = optional log file path (last 32 KB is kept)
set -eu

STAGE="${1:-stage}"
LOGFILE="${2:-}"
TS=$(date -u +%FT%TZ 2>/dev/null || date 2>/dev/null || echo unknown)

mkdir -p /tmp/flagship-trace 2>/dev/null || true
{
    printf '### %s [%s]\n' "$TS" "$STAGE"
    if [ -n "$LOGFILE" ] && [ -f "$LOGFILE" ]; then
        tail -c 32768 "$LOGFILE" 2>/dev/null
    fi
} > "/tmp/flagship-trace/${TS}-${STAGE}.txt" 2>/dev/null || true
exit 0
