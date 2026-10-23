#!/bin/bash
# Flip /opt/flagship back to an already-installed release (SEC-UPD-001). Nothing is downloaded,
# built or resolved: the release directory was verified when it was installed, and release
# directories are immutable. Used by the update guard and the daemon's health gate.
#
#   rollback-box-artifact.sh <40-hex commit> [--releases D] [--current P] [--state D] [--bin D]
set -u
commit="${1:-}"; shift || true
releases=/opt/flagship-releases current=/opt/flagship state=/var/flagship bin=/usr/local/bin
while [ $# -gt 0 ]; do
  case "$1" in
    --releases) releases="$2"; shift 2 ;;
    --current) current="$2"; shift 2 ;;
    --state) state="$2"; shift 2 ;;
    --bin) bin="$2"; shift 2 ;;
    *) echo "usage: $0 <commit> [--releases D] [--current P] [--state D] [--bin D]" >&2; exit 2 ;;
  esac
done
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "refused: not a full commit" >&2; exit 2; }
dest="$releases/$commit"
[ -d "$dest/app" ] && [ -f "$dest/INSTALLED.json" ] && [ -x "$dest/app/.runtime/node/bin/node" ] \
  || { echo "refused: release $commit is not installed on this box" >&2; exit 3; }
[ "$(jq -r .commit "$dest/INSTALLED.json" 2>/dev/null)" = "$commit" ] || { echo "refused: release record names another commit" >&2; exit 3; }
[ -L "$current" ] || [ ! -e "$current" ] || { echo "refused: $current is not a release link" >&2; exit 3; }
ln -sfn "$dest/app" "$current.new" || exit 3
if mv -T "$current.new" "$current" 2>/dev/null; then :; else mv -f -h "$current.new" "$current" || exit 3; fi
ln -sfn "$dest/app/.runtime/node/bin/node" "$bin/node.new" && { mv -f -T "$bin/node.new" "$bin/node" 2>/dev/null || mv -f "$bin/node.new" "$bin/node"; }
cp -f "$dest/INSTALLED.json" "$state/artifact-current.json.new" && mv -f "$state/artifact-current.json.new" "$state/artifact-current.json" || exit 3
sync
echo "rolled back: $commit"
