# Mac release pipeline for Flagship Burner.
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

APP_NAME = FlagshipBurner
BUILD_DIR = .build/release
APP_BUNDLE = $(BUILD_DIR)/$(APP_NAME).app
ZIP_FILE = $(BUILD_DIR)/$(APP_NAME).zip
DMG_FILE = $(BUILD_DIR)/$(APP_NAME).dmg

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

# Re-package the swift-build binary as a proper .app bundle so codesign
# is happy. SwiftPM produces a bare executable in .build/release; the
# Mac wants Contents/MacOS/<binary> + Contents/Info.plist.
package-app: build-release
	rm -rf $(APP_BUNDLE)
	mkdir -p $(APP_BUNDLE)/Contents/MacOS
	mkdir -p $(APP_BUNDLE)/Contents/Resources
	cp $(BUILD_DIR)/$(APP_NAME) $(APP_BUNDLE)/Contents/MacOS/$(APP_NAME)
	cp Info.plist $(APP_BUNDLE)/Contents/Info.plist
	@echo "✓ Packaged: $(APP_BUNDLE)"

# Sign with hardened runtime + entitlements. The hardened runtime is
# a notarization prereq.
sign: package-app
	codesign --deep --sign "$$FLAGSHIP_SIGNING_ID" \
	    --force --options runtime \
	    --entitlements entitlements.plist \
	    --timestamp \
	    $(APP_BUNDLE)
	@echo "✓ Signed: $(APP_BUNDLE)"
	codesign -dvv $(APP_BUNDLE) 2>&1 | head -10

# Zip the bundle (notarytool needs a zip / dmg / pkg).
$(ZIP_FILE): $(APP_BUNDLE)
	cd $(BUILD_DIR) && /usr/bin/ditto -c -k --keepParent $(APP_NAME).app $(APP_NAME).zip

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
	xcrun stapler staple $(APP_BUNDLE)
	xcrun stapler validate $(APP_BUNDLE)
	@echo "✓ Stapled"

# Wrap the signed+notarized+stapled .app in a DMG that users can drag
# into /Applications. The DMG is what you upload to your website /
# GitHub release.
dmg: $(APP_BUNDLE)
	rm -f $(DMG_FILE)
	hdiutil create -volname "$(APP_NAME)" \
	    -srcfolder $(APP_BUNDLE) \
	    -ov -format UDZO $(DMG_FILE)
	@echo "✓ DMG: $(DMG_FILE)"

clean:
	rm -rf .build
	swift package clean
