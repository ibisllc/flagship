# Mac release pipeline for Flagship Studio.
#
# Two flows:
#   make build       — debug build to test locally (no cert needed)
#   make release     — signed + notarized .app + zip + dmg (needs your
#                      Developer ID Application cert + an Apple ID)
#
# Set these in your shell before `make release`:
#   FLAGSHIP_SIGNING_ID    — "Developer ID Application: Your Name (TEAMID)"
#   FLAGSHIP_APPLE_ID      — your Apple Developer email
#   FLAGSHIP_TEAM_ID       — your 10-char team id (also in the signing-id)
#   FLAGSHIP_NOTARY_KEY    — path to App-Store-Connect API key (.p8)
#   FLAGSHIP_NOTARY_KEY_ID — 10-char key id
#   FLAGSHIP_NOTARY_ISSUER — issuer UUID
#
# (You can use an app-specific password from appleid.apple.com instead
# of the API key — see the `notarize-with-password` target.)

# BIN_SRC = the binary swift-build emits (matches the SwiftPM target).
# BIN     = the binary name inside the .app (renamed on copy).
# APP_NAME = the user-facing .app bundle name (Finder + Dock).
BIN_SRC = FlagshipBuilder
BIN = FlagshipStudio
APP_NAME = Flagship Studio
BUILD_DIR = .build/release
APP_BUNDLE = $(BUILD_DIR)/$(APP_NAME).app
PRESEED_ENGINE = $(BUILD_DIR)/FlagshipBuilder_FlagshipBuilderCore.bundle/preseed-engine.js
ZIP_FILE = $(BUILD_DIR)/$(BIN).zip
DMG_FILE = $(BUILD_DIR)/$(BIN).dmg

.PHONY: build release sign notarize staple dmg clean check-env

build:
	swift build -c debug

build-release:
	swift build -c release

# Single command — does the whole release: build, package as .app,
# sign, notarize, staple, dmg. Reads env vars at the top of this
# Makefile.
release: check-env build-release sign notarize staple dmg
	@echo "✓ Signed + notarized + DMG: $(DMG_FILE)"

# Verify all required env vars are present before doing anything
# expensive.
check-env:
	@test -n "$$FLAGSHIP_SIGNING_ID"    || (echo "✗ FLAGSHIP_SIGNING_ID not set"; exit 1)
	@test -n "$$FLAGSHIP_APPLE_ID"      || (echo "✗ FLAGSHIP_APPLE_ID not set"; exit 1)
	@test -n "$$FLAGSHIP_TEAM_ID"       || (echo "✗ FLAGSHIP_TEAM_ID not set"; exit 1)
	@test -n "$$FLAGSHIP_NOTARY_KEY"    || (echo "✗ FLAGSHIP_NOTARY_KEY not set"; exit 1)
	@test -n "$$FLAGSHIP_NOTARY_KEY_ID" || (echo "✗ FLAGSHIP_NOTARY_KEY_ID not set"; exit 1)
	@test -n "$$FLAGSHIP_NOTARY_ISSUER" || (echo "✗ FLAGSHIP_NOTARY_ISSUER not set"; exit 1)
	@echo "✓ env complete"

# Re-package the swift-build binary as a proper .app bundle: the main app +
# the privileged helper (Contents/MacOS), the LaunchDaemon plist
# (Contents/Library/LaunchDaemons), and a self-contained xorriso
# (Contents/Helpers). Fully native — no node/npm runtime.
package-app: build-release
	rm -rf "$(APP_BUNDLE)"
	mkdir -p "$(APP_BUNDLE)/Contents/MacOS"
	mkdir -p "$(APP_BUNDLE)/Contents/Resources"
	mkdir -p "$(APP_BUNDLE)/Contents/Helpers"
	mkdir -p "$(APP_BUNDLE)/Contents/Library/LaunchDaemons"
	cp "$(BUILD_DIR)/$(BIN_SRC)" "$(APP_BUNDLE)/Contents/MacOS/$(BIN)"
	cp "$(BUILD_DIR)/FlagshipBuilderHelper" "$(APP_BUNDLE)/Contents/MacOS/FlagshipBuilderHelper"
	cp "$(PRESEED_ENGINE)" "$(APP_BUNDLE)/Contents/Resources/preseed-engine.js"
	cp Info.plist "$(APP_BUNDLE)/Contents/Info.plist"
	cp HelperDaemon.plist "$(APP_BUNDLE)/Contents/Library/LaunchDaemons/com.flagshipserver.Builder.helper.plist"
	cp AppIcon.icns "$(APP_BUNDLE)/Contents/Resources/AppIcon.icns"
	cp menubar.png "$(APP_BUNDLE)/Contents/Resources/menubar.png"
	cp licenses/xorriso-COPYING.txt "$(APP_BUNDLE)/Contents/Resources/LICENSE-xorriso.txt"
	@if command -v xorriso >/dev/null; then \
	    cp -L "$$(command -v xorriso)" "$(APP_BUNDLE)/Contents/Helpers/xorriso"; \
	    echo "✓ Bundled xorriso (self-contained: depends only on macOS system libs)"; \
	else \
	    echo "⚠ xorriso not found — install it (brew install xorriso) for a self-contained app"; \
	fi
	@echo "✓ Packaged: $(APP_BUNDLE)"

# Sign with hardened runtime + entitlements. Sign inside-out: the embedded
# privileged helper first (its own identifier + entitlements), then the app
# bundle. The helper's signing identifier must match the LaunchDaemon Label
# so SMAppService accepts it.
sign: package-app
	@if [ -f "$(APP_BUNDLE)/Contents/Helpers/xorriso" ]; then \
	    codesign --force --options runtime --timestamp \
	        --sign "$$FLAGSHIP_SIGNING_ID" \
	        "$(APP_BUNDLE)/Contents/Helpers/xorriso"; \
	    echo "✓ Signed xorriso"; \
	fi
	codesign --force --options runtime --timestamp \
	    -i com.flagshipserver.Builder.helper \
	    --entitlements helper-entitlements.plist \
	    --sign "$$FLAGSHIP_SIGNING_ID" \
	    "$(APP_BUNDLE)/Contents/MacOS/FlagshipBuilderHelper"
	codesign --force --options runtime --timestamp \
	    --entitlements entitlements.plist \
	    --sign "$$FLAGSHIP_SIGNING_ID" \
	    "$(APP_BUNDLE)"
	@echo "✓ Signed: $(APP_BUNDLE)"
	codesign -dvv "$(APP_BUNDLE)" 2>&1 | head -10

# Zip the bundle (notarytool needs a zip / dmg / pkg).
$(ZIP_FILE): $(APP_BUNDLE)
	cd $(BUILD_DIR) && /usr/bin/ditto -c -k --keepParent "$(APP_NAME).app" "$(BIN).zip"

# Submit to Apple's notary service + wait for the verdict.
notarize: $(ZIP_FILE)
	xcrun notarytool submit $(ZIP_FILE) \
	    --key "$$FLAGSHIP_NOTARY_KEY" \
	    --key-id "$$FLAGSHIP_NOTARY_KEY_ID" \
	    --issuer "$$FLAGSHIP_NOTARY_ISSUER" \
	    --wait
	@echo "✓ Notarized"

# Alternative for users who prefer an app-specific password to the
# API key. Set FLAGSHIP_NOTARY_PASSWORD (an app-specific password from
# appleid.apple.com) and run this target instead of `notarize`.
notarize-with-password: $(ZIP_FILE)
	xcrun notarytool submit $(ZIP_FILE) \
	    --apple-id "$$FLAGSHIP_APPLE_ID" \
	    --team-id "$$FLAGSHIP_TEAM_ID" \
	    --password "$$FLAGSHIP_NOTARY_PASSWORD" \
	    --wait

# Staple the notarization ticket onto the bundle so Gatekeeper accepts
# it offline. Must run AFTER notarize succeeds.
staple: $(APP_BUNDLE)
	xcrun stapler staple "$(APP_BUNDLE)"
	xcrun stapler validate "$(APP_BUNDLE)"
	@echo "✓ Stapled"

# Wrap the signed+notarized+stapled .app in a DMG that users can drag
# into /Applications. The DMG is what you upload to your website /
# GitHub release.
dmg: $(APP_BUNDLE)
	rm -f "$(DMG_FILE)"
	hdiutil create -volname "$(APP_NAME)" \
	    -srcfolder "$(APP_BUNDLE)" \
	    -ov -format UDZO "$(DMG_FILE)"
	@echo "✓ DMG: $(DMG_FILE)"

clean:
	rm -rf .build
	swift package clean
