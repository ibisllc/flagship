# Owner e2e checklist — boot a real box + see live alerts everywhere

Goal: take the project from "code shipped + Worker live" to "the owner
can boot a Debian and an Alpine box and watch each one provision live
on iPhone Lock Screen + Dynamic Island + Apple Watch + Android."

17 tasks across 4 parallel lanes. Each task has a clear "done when"
so the next session can pick up cold without ambiguity. Tick the box
when complete.

**Today's reality (2026-05-27)**: Alpine path is ❌ blocked
(`/api/personalize-iso` returns 503 — no base ISO in R2); Debian
advanced-mode path is ✅ the only working creation route; install-
progress alerts are 🟡 (code wired all the way through, but iPhone +
Android have no app installed yet to receive them; Watch has no
install-progress surface at all). See `docs/next-session-handoff.md`
for the "what works for the owner today?" matrix.

---

## Lane W — Watch surface (🤖 agent-doable)

The Watch app today handles unlock approvals only. These tasks add
the install-progress surface so a glance at the watch shows what
phase a provisioning box is in.

### W1 — Apple Watch install-progress surface (~2-3 h) ✅

**Owner**: 🤖 agent. Pure Swift, no hardware needed.

**Description**: Add `ProvisionTimelineWatchView` (or whatever the
WatchOS target's naming convention is) that mirrors the iOS
`ProvisionTimelineView` ladder: booting → downloading → partitioning
→ installing → registering → sealing → pairing → live, with
done/current/upcoming/error states. Sync the live order id + phase
state from the iPhone via WatchConnectivity (or set up direct APNs
delivery to the paired Watch, whichever is simpler given the existing
Watch app structure). Persist the active order id so opening the
Watch app cold still shows the timeline.

**Key files** (verify these exist before starting):
- `apps/mobile/ios/Sources/FlagshipWatch/...` (or wherever
  the WatchOS target lives — check the Xcode project)
- `apps/mobile/ios/Sources/FlagshipUI/Screens/ProvisionTimelineView.swift`
  — the iOS reference to mirror
- `apps/mobile/ios/Sources/FlagshipCore/...` — the
  `ProvisionPhaseEvent` parser

**Done when**: Watch target builds clean; new view renders the same
8-phase ladder with the same visual states as iOS; WatchConnectivity
(or direct push) carries phase updates within ~2 seconds of the
iPhone receiving them; at least one XCTest verifies the view's state
transitions; ships in the same Archive as TF3.

**Completed**: 2026-05-30, commit `6274f1b`.
The Watch target actually lives at `apps/mobile/ios/App/WatchApp/`
(not `Sources/FlagshipWatch/` as the kickoff said — Xcode-managed
target outside SPM). Picked WatchConnectivity over direct APNs to
match the existing approvals plumbing. Implementation:

- `Sources/FlagshipUI/ViewModels/ProvisionTimelineLadder.swift` —
  extracted the row-projection algorithm out of
  `ProvisionTimelineView` into a pure-Swift, SwiftUI-free type. The
  view now delegates to it. This is the canonical spec.
- `Tests/FlagshipMobileTests/ProvisionTimelineLadderTests.swift` —
  9 new XCTest cases covering pre-checkpoint, in-flight progression,
  current-row detail precedence, terminal live (collapses to all
  done), terminal error at mid-ladder + first-row + empty-detail
  edge case, and the forward-compat unknown-phase sentinel.
- `App/Shared/WatchProvisionTimeline.swift` — Codable wire payload
  (`WatchProtocol.ProvisionTimelineContext`) + parallel ladder
  projection (`WatchProtocol.ProvisionTimelineLadder`) that mirrors
  the FlagshipUI algorithm against the wire-type the watch receives
  (Foundation-only so the watch target doesn't pull in FlagshipAPI).
  Also includes `ProvisionPhaseMapping` that folds the fine-grained
  PROVISION_PHASES wire vocabulary onto the 8-phase ladder.
- `App/Sources/WatchTimelinePublisher.swift` — iPhone-side
  aggregator. Two update paths: `update(from: ProvisionStatus,...)`
  for the polled rich source and `update(from: ProvisionPhaseEvent,...)`
  for the push-driven path. Either commits to `WatchBridge`.
- `App/Sources/WatchBridge.swift` — new `updateProvisionTimeline(_:)`
  that JSON-encodes the context and pushes via
  `WCSession.updateApplicationContext` under the
  `provision-timeline` key (next to the existing `pending` key).
- `App/Sources/FlagshipApp.swift` — wired `ProvisionPhaseBridge.onPhase`
  to also forward to the publisher (using the push's `fqdn` as the
  continuity key so consecutive pushes for the same install
  accumulate history correctly).
- `App/WatchApp/WatchConnectivityClient.swift` — added
  `@Published provisionTimeline`, decodes both payloads, and
  persists each to `UserDefaults` so a cold watch launch shows the
  most-recent snapshot before WCSession reconnects.
- `App/WatchApp/ProvisionTimelineWatchView.swift` — watchOS SwiftUI
  view with a compact rail-with-nodes layout sized for the smallest
  watch face. Uses the same row-state vocabulary as iOS.
- `App/WatchApp/WatchRootView.swift` — active timeline dominates the
  watch face; pending approvals show if no timeline is active;
  inactive (terminal) timeline still surfaces until the phone clears
  it.
- `App/FlagshipApp.xcodeproj/project.pbxproj` — wired 3 new files
  into the right groups + target sources lists (Shared/ visible to
  both FlagshipApp + FlagshipWatchApp; new App/Sources file in
  FlagshipApp only; new WatchApp file in FlagshipWatchApp only).

**Gates** (all green): vitest **333 files / 4286 pass**, tsc -b
clean, iOS xcodebuild FlagshipMobile-Package test **624 tests**
(+9 new from the baseline 615). The watchOS Swift sources typecheck
cleanly against the WatchSimulator26.5 SDK that's installed; full
watchOS-platform build is gated on the owner installing the watchOS
26.5 platform via Xcode → Settings → Components (a TF3 prerequisite
regardless — the Archive needs the Watch target embedded).

### W2 — Watch complication for current phase (~1 h, optional)

**Owner**: 🤖 agent.

**Description**: Single-line `ComplicationFamily` ("Flagship:
sealing", "Flagship: live", etc.) on the watch face when an install
is active; resolves to the normal Watch app icon when no install is
running.

**Done when**: Complication renders correctly on at least one watch
face family in the simulator; updates within a heartbeat of phase
transitions; ships in the same Archive as W1.

---

## Lane TF — iOS TestFlight (📱🖥 owner, ~half-day)

### TF2 — Tick Associated Domains capability (5 min)

**Owner**: 📱 owner. developer.apple.com.

**Description**: developer.apple.com → Identifiers →
`com.flagshipserver.app` → Capabilities → ☑ Associated Domains →
Save.

**Done when**: Capability is checked + saved in the Apple Developer
portal.

### TF3 — Xcode Archive + ASC upload (30 min)

**Owner**: 🖥 owner. **Blocked by**: TF2, W1.

**Description**: Open `apps/mobile/ios/App/FlagshipApp.xcodeproj`.
Scheme **FlagshipMobile**. Destination **Any iOS Device (arm64)**.
Product → Archive → Distribute App → App Store Connect → Upload.
Make sure the Watch target is included so W1 (and W2 if done) ship
in the same build.

**Pre-Archive sanity already passed this session** (615 XCTests on
iPhone 16e simulator) — so any Archive failure is signing /
entitlements / Watch-target related, not code regression.

**Done when**: Build appears in ASC under TestFlight → iOS Builds
with "Processing" → "Ready to Submit" status.

### TF4 — ASC metadata for the build (30 min)

**Owner**: 📱 owner. **Blocked by**: TF3.

**Description**: In ASC (iPhone app is fine):
- Privacy URL: `https://flagshipserver.com/privacy.html`
- 1024 icon: already in the asset catalog; ASC should pick it up
- Screenshots: 6.7" + 6.1" + iPad pro
- "What to Test" copy: should cover the surfaces TestFlight users
  will exercise — create-server, pair-existing-box, install-progress
  timeline (NEW today), recovery, P14 companion dock, P13 server
  revoke. Ask agent to draft if you want a starting point.
- Company: Houston Automation Lab.

**Done when**: All ASC required fields are green; "Submit for
Review" button is enabled (don't click it for TestFlight — internal
testing doesn't need review).

### TF5 — Install TestFlight build on iPhone + Watch (10 min)

**Owner**: 📱⌚ owner. **Blocked by**: TF4.

**Description**: Install via TestFlight on your real iPhone. Grant:
- Push-notifications permission
- Live Activities permission
- Watch app permissions (if iPhone is paired with a Watch)

Open the app once — this is when APNs registers your device's push
token with the cloud. From that moment, any provision-phase push
targeted at your account will land on this phone.

**Done when**: App is installed on your phone; opening it shows the
home screen; your phone is registered in
`https://flagshipserver.com/api/users/<you>/devices` (check via
`curl` if you want explicit verification).

---

## Lane AND — Android Play internal track (🖥📱 owner, ~half-day)

Parallel to Lane TF — no shared dependencies.

### AND1 — Build signed release AAB (15 min)

**Owner**: 🖥 owner.

**Description**:
```sh
cd apps/mobile/android
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
./gradlew :app:bundleRelease
```

**Done when**: AAB lands at
`apps/mobile/android/app/build/outputs/bundle/release/app-release.aab`.

### AND2 — Play Console internal track upload (30 min)

**Owner**: 🖥 owner. **Blocked by**: AND1.

**Description**: Upload the AAB to Play Console → Internal testing
→ new release. Add yourself + up to 4 Gmail-account testers to the
tester list. Save + roll out to internal track (no review needed).

**Done when**: Internal-test opt-in link is shown in the Play
Console release page.

### AND3 — Install Android build on phone (10 min)

**Owner**: 📱 owner. **Blocked by**: AND2.

**Description**: Open the internal-test opt-in link on your Android
device → Play Store → install. Grant push (FCM) + notification
permissions. Open the app to register the FCM token with the cloud.

**Done when**: App is installed; opening it shows the home screen;
notifications permission is granted.

---

## Lane ALP — Alpine `af_packet` (🖥 owner, multi-hour)

The lynchpin between today's "Debian advanced-mode is the only
working path" and the Recommended Alpine apkovl path actually
working. Lane is **independent of the rest until E2E-ALPINE**.

### ALP1 — Custom Alpine initramfs with `af_packet` (multi-hour)

**Owner**: 🖥 owner.

**Description**: The current Alpine base ISO is missing the
`af_packet` kernel module in apkovl mode (the modloop doesn't mount,
so any module not baked into initramfs is unavailable). Two paths:
- **(a)** Bake `af_packet` directly into a custom initramfs.
  More reliable; bypasses the modloop issue entirely.
- **(b)** Fix the modloop mount sequence in apkovl mode. Cleaner;
  benefits any future module dependency, not just `af_packet`.

Either solution must verify the daemon's first-boot network-claim
step (which is where `af_packet` is actually needed) succeeds end-
to-end on the resulting boot.

**Done when**: Booting a stock Alpine ISO with the new initramfs
on a test box reaches the daemon's first-claim step without
"unknown protocol" errors.

### ALP2 — Reproducible Alpine ISO build (~1 h)

**Owner**: 🖥 owner. **Blocked by**: ALP1.

**Description**: Run the existing reproducible-iso CI workflow
(`.github/workflows/build-iso.yml`) with the new initramfs from
ALP1. The workflow already does `SOURCE_DATE_EPOCH`-pinning from
commit timestamp + a pinned Alpine ISO + sha256 verification +
builds twice + `cmp`-asserts byte-identical output.

**Done when**: Workflow run completes green; final ISO + sha256
are saved as artifacts.

### ALP3 — Upload Alpine base ISO to R2 (5 min)

**Owner**: 🖥 owner. **Blocked by**: ALP2.

**Description**:
```sh
npx wrangler r2 object put flagship-alpine-base.iso \
    --file=./alpine-base-flagship.iso --bucket=ISO_BUCKET
```

Then probe:
```sh
curl -s -X POST https://flagshipserver.com/api/personalize-iso \
    -H 'Content-Type: application/json' -d '{}'
```

**Done when**: The probe stops returning the 503
`"base ISO ... not provisioned"` error. A 400 `"malformed body"`
is the correct success-of-precondition signal (the endpoint reached
its body validator).

---

## Lane E2E — the actual run

### E2E-PREP — Pair iPhone + Watch + create test account (10 min)

**Owner**: 📱⌚ owner. **Blocked by**: TF5.

**Description**: On your iPhone, open the TestFlight app. Create a
fresh account (or use a test one). Grant all push + Live Activity +
Watch permissions. Confirm the Watch app is paired and showing
"connected" / ready. Take a screenshot of the empty "no servers
yet" state — useful as a before/after baseline.

**Done when**: Test account exists; Watch app is paired and
reachable; baseline screenshot saved.

### E2E-DEBIAN — Boot a Debian box + observe full alert surface (~1 h)

**Owner**: 🖥📱⌚📦 owner. **Blocked by**: E2E-PREP.

**Description** (the actual demo):
1. In the phone app: Create server → fill form → app shows recipe
   code.
2. Open the Mac burner GUI → click **Advanced options** → select
   **Debian 13 (trixie) netinst** → paste recipe code → burn USB.
3. Insert USB into target machine, boot from it.
4. **Observe on iPhone** (per phase: booting → downloading →
   partitioning → installing → registering → sealing → pairing →
   live):
   - Lock Screen notification banner
   - Live Activity in Dynamic Island — compact view
   - Live Activity in Dynamic Island — expanded view (long-press)
   - Live Activity persists across phase changes
5. **Observe on Watch** (W1):
   - `ProvisionTimelineWatchView` shows the ladder updating live
   - (If W2 done) complication on watch face shows current phase
6. **Verify the server is live**:
   - `curl -s https://<server>.<you>.flagship.services/` → 200
   - Green padlock when opened in a browser (real Let's Encrypt cert)

**Done when**: All 4 iPhone surfaces + 1-2 Watch surfaces fired
correctly across the full 8-phase sequence; live padlock confirmed.

### E2E-ALPINE — Boot an Alpine box (Recommended path) (~1 h)

**Owner**: 🖥📱⌚📦 owner. **Blocked by**: E2E-PREP, ALP3.

**Description**: Same flow as E2E-DEBIAN but the Recommended path:
1. In the phone app: Create server → fill form → app shows recipe.
2. Open `https://flagshipserver.com/ready` → "Download personalized
   ISO" (this is what was 503-ing before ALP3).
3. Open the Mac burner GUI → Quick mode (default) → burn the
   downloaded ISO.
4. Boot target machine → observe all the same alert surfaces.

The apkovl ISO is self-deleting (this is the whole point of the
Recommended path) — verify the installer leaves no recipe artifact
on disk after first boot.

**Done when**: Same as E2E-DEBIAN, plus the self-delete verification.

### E2E-ANDROID — Repeat one e2e on Android (~30 min)

**Owner**: 📱📦 owner. **Blocked by**: AND3.

**Description**: Pick either Debian or Alpine. Use the Android app
to: create server → get recipe → burn (same Mac burner; the AAB
isn't running the burner — it's just providing the recipe) → boot.
Verify FCM push lands + `InstallProgressScreen.kt` renders the
timeline + foreground notification persists across phases.

**Done when**: Same alert-surface observation but on Android.

### VERIFY — Cross-surface sanity + screenshots (15 min)

**Owner**: 📱⌚ owner. **Blocked by**: E2E-DEBIAN.

**Description**: Confirm and screenshot each alert surface from at
least one full e2e run:
1. iPhone Lock Screen banner per phase
2. Dynamic Island compact
3. Dynamic Island expanded
4. Dynamic Island minimal (when another foreground app is active)
5. Watch `ProvisionTimelineWatchView`
6. (Optional, if W2 done) Watch complication on a face

**Done when**: All 5-6 screenshots saved. These become evidence for
the eventual launch blog, ASC "What's New" copy, and bug-bash
documentation. A failure on any surface is a bug to file with the
phase + screenshot attached.

---

## Critical path

```
W1 ──┐
TF2 ─┴─→ TF3 → TF4 → TF5 → E2E-PREP → E2E-DEBIAN → VERIFY
                                ↓ also blocks
                                E2E-ALPINE ←── ALP3 ← ALP2 ← ALP1

AND1 → AND2 → AND3 → E2E-ANDROID         (independent of iOS lane)
W2                                        (optional polish for Watch)
```

Shortest route to "alerts on your phone": **W1 → TF2/3/4/5 →
E2E-PREP → E2E-DEBIAN → VERIFY** — one focused day if W1 starts in
parallel with TF2.
