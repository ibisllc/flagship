# Pre 0.5: device calls on the new call media stack, then pin it

Must be done before: 0.5
Status: OPEN

**Why.** 0.5 changes the codec stack under every voi.ci call. The libwebrtc build config on `release/0.5`
(`tools/libwebrtc/gn-args.txt`, `apply-overlay.py`) drops VP9 (`rtc_libvpx_build_vp9=false`) and AV1 (libaom,
dav1d, and their Android JNI halves); calls already negotiate only Opus and VP8 (`checkVoiciCallSdp`). This makes the
apps smaller (iOS `__TEXT` 10.47 → 7.60 MB, installed −2.9 MB; Android
about −3.0 MB on arm64). Every browser and both apps still offer VP8 and Opus, but a codec mismatch shows up only in a
real call, so the full device matrix below must pass **before** this build is pinned, and before 0.5's store builds.
`scripts/check-carryover.mjs` fails the 0.5 release preflight and vitest while this file is OPEN. Close it with
`Status: DONE <date>` and a Log line, never to get past the gate.

**State (2026-11-27).** Pinned on `release/0.5` (owner: its builds must carry the smaller stack, so the tests catch
what breaks): `tools/libwebrtc/release.env`, the `webrtcRelease` line of `apps/mobile/ios/Package.swift` and
`artifacts.sha256` point at the pre-release **`libwebrtc-157-45414303796`** (CI run 45414303796 from `e7be6196e`).
`main` stays on `libwebrtc-157-44099203173` until 0.5 lands. Its `SHA256SUMS`: `WebRTC.xcframework.zip 6b6cbae8…09324`,
`libwebrtc.aar d7e040a1…f403`, `FlagshipTurn.xcframework.zip 4d4ff7ae…0543`, `flagship-turn-android.zip 8eb2998f…6804`.

## 1. Test builds (Claude, on the Mac)

Any build of `release/0.5` uses the pinned smaller stack (no vendor folders needed: an `apps/mobile/ios/Vendor/WebRTC` or
`apps/mobile/android/vendor/webrtc` left over from earlier testing wins over the pin, so delete those first).
- **iOS:** an ad-hoc export (`method release-testing`; a development build gets a sandbox VoIP token and never rings),
  installed with `xcrun devicectl device install app`. Override the version on the command line
  (`MARKETING_VERSION=… CURRENT_PROJECT_VERSION=…`) with a build number above every burned one.
- **Android:** a debug build with a separate application id suffix (a "calltest" app beside the store app), installed
  over adb on the owner's phone.
Disk rule: delete DerivedData when done. Never build WebRTC on the Mac.

## 2. The call matrix (owner with Claude)

Each call: rings, both sides hear each other, video on both ways, hang-up from each side. In
`chrome://webrtc-internals` (or Safari's WebRTC logging) confirm the codecs are **VP8** and **Opus**.

| # | Caller → callee | Result |
|---|---|---|
| 1 | Android Chrome → locked iPhone (ad-hoc 1.3.1 (16), new libs) | **pass 2026-11-27** (audio and video) |
| 2 | Mac Safari → iPhone | |
| 3 | Mac Chrome → iPhone | |
| 4 | Browser → Android app (needs ntfy installed for UnifiedPush, or FCM) | |
| 5 | iPhone app → Android app, and back | |
| 6 | Camera turned on mid-call, camera flip, on both apps | |
| 7 | A call placed from the app (not the browser), and ringing back a missed call | |
| 8 | Firefox → iPhone and → Android | |

## 3. If a row fails

Fix it on `release/0.5`. A fix inside libwebrtc means a new run of `.github/workflows/libwebrtc.yml` on `release/0.5`,
then a pre-release of its output (the four files, `manifest.json`, `SHA256SUMS`), `artifacts.sha256` from its
`SHA256SUMS`, `tools/libwebrtc/pin-release.sh <tag>`, and the whole matrix again. When every row passes, the size check
(`strings` on the built app finds no dav1d / libaom), then close this runbook.

## Log

- 2026-11-27: merged into `release/0.5` (owner: keep the repo lean, test before release); branch
  `claude/friendly-goldberg-f0jbky` deleted. Pinned to `libwebrtc-157-45414303796` the same day. Matrix row 1 passed
  (on an ad-hoc build with the same libraries from the vendor folders).
