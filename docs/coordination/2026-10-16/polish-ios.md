# iOS polish (P1), first pass, 2026-10-17

Screenshot folders (scratchpad/polish-shots/):
- `ios-before/`  iPhone 17 Pro light L, light AX5 (accessibility XXXL), dark L; iPad Pro 13" light L landscape (28 shots each: welcome, connect, lock, Home, add menu, create server, server page x5, Services, app page x5, Activity x4, Settings x4)
- `ios-after1/`  iPhone light L + AX5 after the foundation commit
- `ios-after2/`  iPhone light L, dark L, light AX5 after the second round (accordions, segmented control, tokens)
- `ios-after3/`  iPhone light L and dark L after the brand-teal / section-label round, plus new sub-screen shots: every Settings row (`50-settings-*`), the app's access control (`60-*`), the server's share card (`61-*`)
Driver: `apps/mobile/ios/App/UITests/PolishShotsTests.swift` (opt-in, `TEST_RUNNER_POLISH_DIR`, over the mock clients; set appearance and text size with `simctl ui`). Run scripts: `scratchpad/polish-ios/shoot.sh`.

## What was wrong (critique against the HIG)

1. **Dynamic Type did not work.** 807 `FS.font.*` calls and 268 raw `.system(size:)` calls were fixed point sizes. At the largest accessibility size only titles and the search field grew; every row, card and caption stayed tiny.
2. Cards, buttons and fields had 4 to 6pt square corners while chips, the search field and the tab bar were pills: two shape languages on one screen.
3. Section labels were hand-typed UPPER CASE with tracking (about 75 places), which iOS 26 itself no longer does.
4. No press feedback on custom buttons; no haptics except the QR scanner and the server-order drag; hold-to-confirm buttons had no progress or haptic.
5. Fixed-height controls (34/40/46pt) that clip at larger text; some under 44pt; a few icon-only buttons with no VoiceOver label.
6. Welcome had a blank white placeholder card as its hero. Dashed ghost buttons ("Add/Import a server", "Build another service") read as web, not iOS. Appearance picker was three chunky teal boxes with "AUTO" in capitals. Danger zone was a stack of heavy red outlines.
7. Activity accordions: 14pt corners (every other card was 4), no icon, a trailing time that crushed long details, a 24pt gap between sections.
8. Copy said "box" in ~70 user-visible strings, "Subdomain", "Update firmware", "Migrate to new machine / VM".

## What changed (commits on main)

See the end of this file for the commit list. Summary:
- `FSFont` maps every role to a system text style; `FS.font.scaled(size, weight:, design:)` replaced all `.system(size:)` (nearest text style; >= 36pt stays fixed for the big pairing digits). Tiles are `@ScaledMetric` but capped at 1.4x; rows wrap and stop truncating at accessibility sizes; stat rows and the announcement card restack.
- Radii: sm 8, md 12, lg 16, all `.continuous`.
- `FSPressStyle` (spring settle + dim) on every FS button and chip; `FSRowPressStyle` on rows.
- Haptics: toasts (success / warning / error), chips and segmented control (selection), accordions (selection), hold-to-confirm (light impact on press, success or warning on confirm), plus a fill that grows over the hold.
- Section labels are sentence case, 13pt semibold muted.
- Colour roles (owner, 2026-10-17: the light brand teal is the look): fill #14B8A6 + ink #0A0A09; `accent` (graphics, markers, rings, selected borders, icon tiles) #14B8A6 light, #2DD4BF dark (about 2.3:1 on paper, documented; no icon-only control relies on it); small teal text `primary` #0F766E / #2DD4BF for inline links only; every other teal label is ink semibold with a teal marker (`FSSectionLabel`, the active tab tint, pills, "Active", "This device", counters); status text ok #166534/#4ADE80, warn #944D05/#FBBF24, err #B91C1C/#F87171 with 6 to 8 percent washes. ThemeTokensTests asserts 4.5:1 for text pairs and status text on every surface and wash, the accent's 2.3:1 / 3:1, and a source scan (PolishRulesTests) keeps the accent off text and requires labels on icon-only buttons.
- Create server, Backups step: nothing preselected, options No backup, On my phone, On other servers (one short sentence each), Continue off until a pick, the line "Pick one to continue. You can change it any time in the server's Backups section." (true: the server page's Choose/Change editor; for an unset policy it preselects nothing and Save waits too). Import a backup still reaches delivery without a pick (the server starts "Not chosen yet"). Gym: every create scenario picks one first; the launch seam clears the draft.
- Mac Studio floor macOS 15 (Package.swift, Info.plist, host-build manifests, docs); Studio `swift build` passes; no API needed newer than 15.
- Welcome: phone-to-server illustration (SF Symbols, scales, hidden from VoiceOver), scroll view so it never clips, illustration hidden at accessibility sizes.
- `FSSegmentedControl` (sunken track, sliding thumb) for Appearance and App icon (identifiers and selected trait kept).
- Danger buttons: soft red wash, red text, no outline.
- Activity: tinted icon tiles, time under the text, spring expand, no divider after the last row, tighter spacing.
- Copy: "server" not "box" in user-facing text (screen titles included: "Approve server", "Transfer server"); "Server name"; "Software update"; "Migrate to a new server".
- VoiceOver: labels on three unlabeled icon buttons; toasts post an announcement; selected traits on chips.

## Port to Android (in spirit, native Material 3)

- (Android already landed its own teal split and backup step; the rest below is still the iOS reference.)
- Brand teal as the graphic accent only; text that is not an inline link is ink. Section labels: ink semibold with a 3 x 13dp teal bar before them (`FSSectionLabel`), not muted all-caps. Active tab, counters, pills, "Active": ink.

- Text: everything in `sp` from the type scale; verify at font scale 2.0 (Settings > Display). Rows must wrap, not truncate, at large scale; icon tiles scale but cap at about 1.4x; stat rows (Apps / Sessions / Daemon / Version) restack vertically when they don't fit; announcement cards stack icon above text at the largest scales.
- One corner language: 12dp cards and buttons, 8dp inputs and tiles, 16dp sheets; no square cards beside pill chips.
- Section labels in sentence case, labelMedium/semibold, muted (no all-caps tracking).
- Press feedback: ripple plus a slight dim on every custom button; haptics: success / reject on toasts (`HapticFeedbackType.Confirm` / `Reject`), `TextHandleMove` or `SegmentTick` on chips and segmented choices and accordion toggles, long-press then `LongPress` on hold-to-confirm and `Confirm` when it fires, with a fill that grows across the hold.
- Appearance and App icon: a Material segmented button row (single choice) instead of separate filled boxes; label "Auto" not "AUTO".
- Danger zone: tonal error container buttons (error text on `errorContainer` at low alpha), no outlines.
- Welcome: the phone-to-server picture (phone with a key badge, dotted line with a lock, server with a green status dot) in place of the empty card; whole screen scrolls so it fits at large scale.
- Activity: accordion rows with a tinted icon tile, count badge, chevron that rotates with a spring; event rows put the time under the text; no divider after the last row.
- Colour roles per the coordinator's table (fill, graphic accent, text accent, status text + washes).
- Copy: "server" never "box"; "Server name"; "Software update"; "Migrate to a new server".
- Icon-only buttons need a content description and a 48dp hit area.

## Tests run (all on iPhone 17 Pro simulator, one at a time under the native lock)

- Unit: `FlagshipMobile-Package` 1930 tests, 0 failures (new: ThemeTokensTests contrast and status table, PolishRulesTests, CreateServerDraftFieldsTests backup preselect).
- Gym UI: GymSweepHomeTests 20/20, GymSweepOnboardingTests 11/11, GymSweepSettingsTests 29/29, GymSweepAppTests 20/20, GymSweepServerTests 45/45, GymSweepBuildTests (18) and GymSweepShareTests (10) and GymFeatureMirrorTests (8) all green after two selector fixes, plus the create-flow, backup-policy, access-control and onboarding-smoke scenarios after the backup-step change. Not run: GymOctoberTests in full (only the two access-control scenarios), GymTotalTests, GymEveryMergeTests, GymIPad*, GymLiveTests.
- Selectors updated only where the UI moved: section labels are sentence case ("Your servers", "Browser sessions", "Active"), "Approve server", "Transfer server", "Couldn't read this server's current key", "OpenAI · Work" (case-insensitive), policy lines ("On my phone", "No backup"), Continue disabled until a backup pick.

## Second pass (2026-10-17, after the first report)

Done
- Copy: Access control's mode switch was already a segmented Picker (kept). "id: bright-maple--plants" and "ver:" lines are gone from the Access control and app pages ("Version 1.4.0" stays); "Enable multi-device + 2FA" is "Turn on code protection" (and "Turn off", "Code protection is on"); "Update server" is "Software update"; Migrate text says "new server" everywhere (steps, waiting copy, audit label); "pods" and "LUKS" are gone from user text.
- Shot and critiqued: Create server steps 1 to 3 (with the Backups step), Share this server, Debug access, Migrate (start, progress, hand-off), Backup policy editor, Environment, Database, Browser tabs, Build chooser, Build sessions, Build chat, Create account, and every Settings sub-screen. Folders: `polish-shots/ios-p2-a` (iPhone light L), `ios-p2-b` (iPhone AX5, iPad), `ios-p2-c` (iPad after the Activity split).
- Fixed from the critique: one text input look (`fsInputBox`: sunken, 8pt, 44pt, focus ring) on 30+ fields; chat is bubbles in system type (it was monospace, with "?" and check-mark glyph prefixes); Migrate has a plain heading, 26pt step icons and a safe-abort line instead of a 60-character button; Update to latest is a primary button; database grid fills the card; radio glyphs and icon tiles stop growing past 1.4x and tiles hide at accessibility sizes so text gets the width.
- Focus indicator: `fsFocusRing` (2pt teal ring, 2pt ink inner ring) on every FS button, chip, row and field (hardware keyboard / Full Keyboard Access).
- Settings is a native `List` (inset grouped, native separators and highlight, native row separator inset past the icon tile); custom cards sit in transparent rows. Plain buttons inside list rows (the default style fired every button in a row at once).
- Activity on iPad is a list/detail split (sections left, the selected log right); iPhone keeps the accordions.
- Home search sits in the nav bar on iPad. Settings keeps its reading column.
- Add/Restore server (button, dialog, accessibility id `home-add-server` kept): menu is Create a server, Co-manage a running server, Restore from backup. Restore opens a chooser (From a file, From other servers, From this phone) with one line each; From this phone lists the phone's saved copies by server and date (newest first) and imports one like a picked file, or says why there are none.
- Locking closes everything: the shell is rebuilt under a new id each time the app locks, so no menu, dialog, sheet or half-typed field survives or re-presents (the app reopens at the tab roots after a lock), pending cover items are cleared and every UIKit presentation is dismissed. Gym: open the menu, lock, nothing of it is visible, unlock, it does not return; the same for a sheet. Other presentations audited (the four full-screen covers in RootShell, every `.sheet`/`.confirmationDialog`/`.alert`): all live under the rebuilt shell.

Tried and dropped
- `NavigationSplitView` for the iPad shell: with each destination's NavigationStack kept alive in the detail column, the split view's detail bar showed the first stack's title ("Home" on the Services pane) and hiding it hid the inner bars too; a TabView with a hidden tab bar behaved the same. The iPad sidebar stays hand-composed (it now follows the new tokens). A real split view needs the per-destination navigation paths lifted out of the tabs first.
- Swipe actions on Home server rows and the native `List` for Home: Home keeps its drag-to-reorder (a custom gesture over card rows that a List would change), and delete or revoke already sit behind typed-name confirmations on the server page, so no swipe was added.

Not done
- AX5 re-shot only for Home, Settings, server page, create step 3 (round 2); others checked at the default size.
- The webapp's Add/Restore and Restore from backup strings were taken from the coordinator's brief; Android landed its own. The Android parity anchors for the old "Add/Import a server" text still point at removed strings (`backup-clone-server:android`, `peer-backup-v2:android`): Android's stream fixes those.

## Still below native quality (honest list)

- iPad: still the hand-composed sidebar and a 640 to 720pt content column with wide gutters; the sidebar is not a `NavigationSplitView` (see above), so no sidebar collapse gesture, keyboard shortcuts or column resizing.
- Home is still a card stack over a ScrollView (not a List): no swipe actions, no edit mode.
- Large titles: some pushed pages keep inline titles; no scroll-collapsing behaviour on the server page.
- Not critiqued, only shot: Access control member rows, App page sections, Share a server's owner card, Migrate abort, Backup policy reserve picker at large sizes.
- Loading states still use the old skeleton card shapes (they now pulse); error states offer Try again only on Activity and Services.
- VoiceOver audited in code, never run on a device. The sidebar rows and Restore chooser carry identifiers and traits but their reading order was not listened to.
- Locking resets navigation to the tab roots (a deliberate side effect of closing every presentation).

## Commits on main

7ef9052ab foundation (Dynamic Type, corners, press, haptics, tokens), 098052168 teal #0E9488 (superseded), 01a003129 segmented control / danger / status colours / adaptive card, 9ac4d3e96 Migrate secondary, 8ac8a3939 loading pulse + retry + selectors, a5aa8a6c9 Home springs, e044a6b5c rules tests (installed on the owner's iPhone), e16ba6611 backup step + brand teal + macOS 15, 6be6b35d0 import path, 932fb603e member headers.
