#!/usr/bin/env bash
#
# Cut a new distributable build of the Flagship Studio Mac app in one command:
# build -> sign -> notarize -> staple -> DMG -> stage into the website download
# dir (apps/web/public/downloads), which flagshipserver.com/download/mac 302s to.
#
# Auth — use EITHER path (see apps/builder-mac/Makefile header):
#   App Store Connect API key (preferred; no email):
#     FLAGSHIP_SIGNING_ID FLAGSHIP_NOTARY_KEY FLAGSHIP_NOTARY_KEY_ID FLAGSHIP_NOTARY_ISSUER
#   App-specific password stored in macOS Keychain (the configured default):
#     scripts/release-studio.sh --setup-keychain
#   A one-off FLAGSHIP_NOTARY_PASSWORD environment variable remains supported.
#
# Usage:
#   scripts/release-studio.sh --setup-keychain # one-time durable credential setup
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

export FLAGSHIP_SIGNING_ID="${FLAGSHIP_SIGNING_ID:-Developer ID Application: IBIS LLC (8G8RHBU9BN)}"
export FLAGSHIP_APPLE_ID="${FLAGSHIP_APPLE_ID:-kamdemharry@yahoo.fr}"
export FLAGSHIP_TEAM_ID="${FLAGSHIP_TEAM_ID:-8G8RHBU9BN}"
export FLAGSHIP_NOTARY_PROFILE="${FLAGSHIP_NOTARY_PROFILE:-flagship-studio}"

if [ "${1:-}" = "--setup-keychain" ]; then
  : "${FLAGSHIP_NOTARY_PASSWORD:?export FLAGSHIP_NOTARY_PASSWORD once to seed macOS Keychain}"
  echo "▸ Saving the app-specific password in macOS Keychain…"
  xcrun notarytool store-credentials "$FLAGSHIP_NOTARY_PROFILE" \
    --apple-id "$FLAGSHIP_APPLE_ID" \
    --team-id "$FLAGSHIP_TEAM_ID" \
    --password "$FLAGSHIP_NOTARY_PASSWORD"
  echo "✓ Keychain profile '$FLAGSHIP_NOTARY_PROFILE' is ready; the password no longer needs to be exported"
  exit 0
fi

if [ "${1:-}" != "" ] && [ "${1:-}" != "--publish" ]; then
  echo "usage: scripts/release-studio.sh [--setup-keychain|--publish]" >&2
  exit 2
fi

echo "▸ Building + signing + notarizing (uploads to Apple, waits a few minutes)…"
cd "$mac"
if [ -n "${FLAGSHIP_NOTARY_KEY:-}" ]; then
  make release                                          # API-key path (make's check-env)
elif [ -n "${FLAGSHIP_NOTARY_PASSWORD:-}" ]; then
  make package-app sign notarize-with-password staple dmg
else
  make package-app sign notarize-with-keychain staple dmg
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
