#!/usr/bin/env bash
# Materialize ./public from the tracked old_website.zip at the repo root.
# Kept out of git (see .gitignore) so we don't duplicate the zip's bytes.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
zip="$here/../../old_website.zip"
dest="$here/public"

rm -rf "$dest"
mkdir -p "$dest"
unzip -q "$zip" -d "$dest"
echo "Unpacked $(unzip -l "$zip" | tail -1 | awk '{print $2}') files into $dest"
