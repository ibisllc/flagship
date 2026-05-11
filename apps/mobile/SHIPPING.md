# Shipping the mobile clients

Both `apps/mobile/ios/` and `apps/mobile/android/` carry substantial
real code (~20 Swift files / 17 Kotlin files covering keystore,
biometric gate, boot-authorization, the major screens) but neither
has been actually built, signed, or distributed to testers.

This doc is the handoff: what's done, what's needed, and what
shipping each app requires that this repo can't do on its own.

## Current state (verified 2026-05-11)

### iOS — `apps/mobile/ios/`

- `Package.swift` declares a Swift package; targets are
  `Flagship` (model + keystore) and `FlagshipUI` (SwiftUI screens).
- Sources:
  - `Flagship/Keystore.swift` — iOS Keychain wrap of the UMK seed.
  - `Flagship/BiometricGate.swift` — `LAContext`-gated key access.
  - `Flagship/BootAuthorization.swift` — signs BootApproval claims.
  - `FlagshipUI/Screens/` — Welcome, ChooseUsername, ApproveUnlock,
    VibeCode, and other screens.
  - `FlagshipUI/Theme.swift`, `Components.swift` — design tokens +
    reusable views matching the webapp's look.
- `FlagshipAPI/Models/ScreensModels.swift` — Codable mirror of
  `packages/server-daemon/src/screens/types.ts` (kept in lockstep
  with the webapp BFF contract).

### Android — `apps/mobile/android/`

- Standard Android Studio module layout under
  `app/src/main/java/com/flagship/`:
  - `keystore/` — StrongBox-gated UMK wrap (Android Keystore).
  - `api/ScreensModels.kt` — kotlinx-serialization mirror of the
    same Screens contract; sealed classes for tagged unions.
  - `MainActivity.kt` + `ui/` — Compose screens.

## What's missing to ship

| Item | iOS | Android |
|---|---|---|
| Xcode / Android Studio build to verify the project compiles | ✗ | ✗ |
| Apple Developer / Play Console account | ✗ | ✗ |
| Signing certificate / keystore | ✗ | ✗ |
| Bundle ID / package name reservation | ✗ | ✗ |
| App icon assets at all required sizes | ✗ | ✗ |
| Launch screen / splash screen polish | ✗ | ✗ |
| APNs entitlement + push topic setup (matches the existing `APNS_BUNDLE_ID` wrangler secret) | ✗ | n/a |
| FCM project + service-account key (matches the existing `FCM_PROJECT_ID` wrangler secret) | n/a | ✗ |
| Privacy nutrition labels / data-safety form | ✗ | ✗ |
| App-store screenshots + copy | ✗ | ✗ |
| TestFlight / Play internal-track distribution | ✗ | ✗ |
| ≥5 external testers | ✗ | ✗ |

## What this repo CAN'T do

This codebase lives on Linux. Building either app requires:

- **iOS**: an Apple Silicon Mac running Xcode 15+. You need an
  Apple Developer Program membership ($99/year) to get signing
  certificates and to upload to TestFlight. The simulator can run
  the app for development, but real-device testing is required
  before App Store distribution (notification entitlements need
  device-level verification).
- **Android**: Android Studio Hedgehog+ on any platform. The Play
  Developer account costs $25 one-time. Internal-track distribution
  requires a signed APK or AAB; we recommend generating an upload
  key + enabling Play App Signing on first upload.

## Recommended next steps

1. **iOS first** (smaller distribution friction beyond Apple's
   $99/year). Open `apps/mobile/ios/` in Xcode; run on the iOS
   simulator; fix any compile errors. Add the Push Notifications
   capability + register an APNs key matching `APNS_KEY_ID`. Add
   app icon assets. TestFlight upload.
2. **Android second**. Open `apps/mobile/android/` in Android
   Studio; run on the emulator; resolve compile errors. Register
   an FCM project + paste the service-account JSON into the
   wrangler secret. Build a signed AAB. Play Console internal track.
3. Use the **5-external-tester** requirement from
   `docs/build-tasks.md` section S as the gate for moving to public
   release.

## Wire-level contract

Both apps consume the same `/api/screens/*` BFF endpoints the webapp
uses. The Codable / kotlinx-serialization models under
`apps/mobile/{ios,android}/Sources/.../api/ScreensModels.{swift,kt}`
mirror `packages/server-daemon/src/screens/types.ts` — keep them in
lockstep when adding new screens.

Push notifications are platform-native (APNs for iOS, FCM for
Android, Web Push for the webapp) but all three platforms hit the
same `/api/push/register` endpoint with their respective
`providerToken` shapes (`platform=apns|fcm|webpush`). Wire-level
work is already in place; mobile clients just need to call it.
