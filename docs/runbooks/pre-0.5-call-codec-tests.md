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

**State (2026-11-27).** Merged into `release/0.5`; **not pinned**: `tools/libwebrtc/release.env` and the
`webrtcRelease` line of `apps/mobile/ios/Package.swift` still point at `libwebrtc-157-44099203173`, so builds of
`release/0.5` still ship the old, full libwebrtc until step 3. The new libraries are CI run **45414303796**
(`.github/workflows/libwebrtc.yml`, branch `claude/friendly-goldberg-f0jbky`); its `libwebrtc` artifact is kept until
**2027-02-23** (rerun the workflow on `release/0.5` if it has expired, then use the new run id below). Its
`SHA256SUMS`: `WebRTC.xcframework.zip 6b6cbae8…09324`, `libwebrtc.aar d7e040a1…f403`,
`FlagshipTurn.xcframework.zip 4d4ff7ae…0543`, `flagship-turn-android.zip 8eb2998f…6804`.

## 1. Test builds with the new libraries (Claude, on the Mac)

`tools/libwebrtc/use-artifacts.sh 45414303796 --record` unpacks the libraries into the git-ignored vendor folders
(which win over the pinned release) and writes the pin to `tools/libwebrtc/artifacts.sha256`. Then:
- **iOS:** an ad-hoc export (`method release-testing`; a development build gets a sandbox VoIP token and never rings),
  installed with `xcrun devicectl device install app`. Override the version on the command line
  (`MARKETING_VERSION=… CURRENT_PROJECT_VERSION=…`) with a build number above every burned one.
- **Android:** a debug build with a separate application id suffix (a "calltest" app beside the store app), installed
  over adb on the owner's phone.
Disk rule: `use-artifacts.sh --clean` and delete DerivedData when done. Never build WebRTC on the Mac.

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

## 3. Pin (Claude, after the owner's go)

1. Publish the run's output as a GitHub release (as `libwebrtc-157-44099203173` was: a pre-release holding exactly the
   four files and `SHA256SUMS`), tag `libwebrtc-157-45414303796`.
2. `tools/libwebrtc/pin-release.sh libwebrtc-157-45414303796` (it checks the release's `SHA256SUMS` against the pin),
   commit `release.env`, `Package.swift`, `artifacts.sha256` on `release/0.5`.
3. A clean build of both apps from the pin (no vendor folders), one call from the matrix again, then the size check
   (`strings` for dav1d / libaom must find nothing).

## Log

- 2026-11-27: merged into `release/0.5` unpinned (owner: keep the repo lean, test before release). Matrix row 1 passed.
