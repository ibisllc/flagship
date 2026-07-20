#!/usr/bin/env bash
#
# Cut a new distributable build of the Flagship Studio Mac app in one command:
# build -> sign -> notarize -> staple -> DMG -> stage into the website download
# dir (apps/web/public/downloads), which flagshipserver.com/download/mac 302s to.
#
# Auth — set EITHER path's vars first (see apps/builder-mac/Makefile header):
#   App Store Connect API key (preferred; no email):
#     FLAGSHIP_SIGNING_ID FLAGSHIP_NOTARY_KEY FLAGSHIP_NOTARY_KEY_ID FLAGSHIP_NOTARY_ISSUER
#   App-specific password (appleid.apple.com, uses your Apple ID):
#     FLAGSHIP_SIGNING_ID FLAGSHIP_APPLE_ID FLAGSHIP_TEAM_ID FLAGSHIP_NOTARY_PASSWORD
#
# Usage:
#   scripts/release-studio.sh            # build + notarize + stage the DMG locally
#   scripts/release-studio.sh --publish  # + git add/commit/push + deploy the Worker
#
# Note: --publish commits the ~2.3 MB DMG into git. That's convenient for a few
# test builds; if this becomes frequent, move the binary to R2 / a GitHub release
# and point INSTALLER_DOWNLOADS.mac (apps/com/src/route.ts) at that URL instead.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mac="$repo/apps/builder-mac"
dmg_src="$mac/.build/release/FlagshipStudio.dmg"
dmg_dest="$repo/apps/web/public/downloads/FlagshipStudio.dmg"

: "${FLAGSHIP_SIGNING_ID:?set FLAGSHIP_SIGNING_ID (your Developer ID Application cert)}"

echo "▸ Building + signing + notarizing (uploads to Apple, waits a few minutes)…"
cd "$mac"
if [ -n "${FLAGSHIP_NOTARY_KEY:-}" ]; then
  make release                                          # API-key path (make's check-env)
else
  : "${FLAGSHIP_NOTARY_PASSWORD:?set FLAGSHIP_NOTARY_PASSWORD (or the API-key vars)}"
  make package-app sign notarize-with-password staple dmg
fi

echo "▸ Staging the DMG into the site…"
mkdir -p "$(dirname "$dmg_dest")"
cp "$dmg_src" "$dmg_dest"
echo "✓ Staged $dmg_dest ($(du -h "$dmg_dest" | cut -f1))"

if [ "${1:-}" = "--publish" ]; then
  echo "▸ Committing + pushing + deploying…"
  cd "$repo"
  git add apps/web/public/downloads/FlagshipStudio.dmg
  git commit -m "Publish a new Flagship Studio build" || echo "(nothing new to commit)"
  git push origin main
  npx tsc -b                                            # the Worker bundles built dist/
  (cd apps/com && npm run deploy)
  echo "✓ Published — live at https://flagshipserver.com/download/mac"
else
  echo
  echo "Local build staged. To publish it:"
  echo "  scripts/release-studio.sh --publish"
  echo "or manually: git add + commit + push, then: npx tsc -b && (cd apps/com && npm run deploy)"
fi
