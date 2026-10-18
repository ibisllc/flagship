# Android polish (P2), first slice, 2026-10-17

Screenshots: /private/tmp/claude-501/-Users-harrywinner-flagship/9d44d343-7b43-4e78-b071-875da7d51493/scratchpad/polish-shots/before (font 1.0 light), before-fs13 (font 1.3 light), r2 (after, 1.3 light: Home, server page), r2-dark (after, dark; the Activity shot caught the splash).
Commits on main: c4c7cb7b7 (type scale), Activity/headers commit, landed as 4cefeb436.

Before -> after
- ~176 inline TextStyle(fontSize=...) in 27 files (BuildModeScreens 61, PeerBackup, Activity, DebugAccess, onboarding, components...) -> MaterialTheme.typography roles. Left: Glance widget, avatar monogram size, Welcome headline (displaySmall with 40sp override), a few non-Composable-safe cases.
- Activity: own header with 24dp gutter and Row title -> FSScreen large top bar like other tabs (16dp gutter), Refresh in the bar.
- Section headers: 16dp extra indent off the card edge -> 4dp, marked as accessibility headings. Screen subtitle no longer indented 4dp past the title.
Checked at font 1.3 (light) and dark: Welcome, Home, Services, Activity, Settings, server page: no clipping found.
Not done: tablet profile, predictive back audit, haptics audit, copy audit, every other screen.

## Second slice (landed c48669c63)
Shots: polish-shots/r3 (light 1.3), r3l (light 1.3 other screens), r3d (dark), r3t (tablet 1600x2560@300dp), r4 (dark 1.3).
- Top bar: Medium bar (tall empty band) -> compact bar on every screen; tablet bar shares the body's 640dp reading width so titles align with the column.
- Cards: uniform outlines removed; cards separate by tone (white on paper / lifted near-black); banners keep accent.
- Hostnames: middle-ellipsis without the .flagship.services suffix; server address wraps at dots.
- "Your servers" count padding matches its header; Add/Import is a FilledTonalButton; dismiss target 48dp.
- Motion: shared-axis transition on all 7 NavHosts, cards animate size, button labels crossfade.
- Back: android:enableOnBackInvokedCallback=true; Create server system back steps pages.
- Haptics: CONFIRM (VIRTUAL_KEY below API 30) on primary buttons, LONG_PRESS on danger buttons.
- Copy: user-facing 'box' -> 'server' in ~46 strings (except the install-complete line that mirrors the control plane's own string, provisionStatus.ts: needs a server-side change, then Android/iOS/web together).
- Section headers: Backups and Debug access now teal FSSectionHeader.
Not reviewed visually: Migrate, Share screens, Peer backup page, Debug access card open state, Backups edit sheets, build chat conversation, Recovery flows beyond the first page.

## Third slice (landed 99f72f9fd)
Shots: polish-shots/r5 (light), r6 (dark 1.3), r7 (light+dark after teal split).
- Teal roles: fill #14B8A6 + ink #0A0A09 (buttons, selection via secondaryContainer, nav indicator); accent #0E9488 light / #2DD4BF dark (graphics, section marker, icons); accentText/primary #0F766E light / #2DD4BF dark (small text). Status text #166534/#944D05 (old #15803D/#A15C07 removed, widget palette too) + soft washes. TealContrastTest holds every pairing.
- ic_shortcut_*: graphics on launcher surfaces -> #0E9488. wear ic_launcher: a filled disc -> #14B8A6 with #0A0A09 glyph (white on fill teal is only ~2.5:1).
- Create-server slider (no ticks, 6dp step bar, titleMedium value), Backups row actions as text buttons, Front page list, radio picker for lost server, chip-row edge fades, FSAppear row fade-in + animateContentSize on Services/Home lists, Welcome drawn illustration, backup/migrate buttons secondary, Update primary only when a release exists, BackHandler on import passcode step.
- Install-complete string: control plane + Android + iOS + webapp (shell v138).
Gym stability: serverPageListsItsApps (no wait for rows), membersListShowsInvitedBy (clicked before the button enabled), flagshipInference save (30s keystore wait). Machine load average was 15-23 from a VZ VM during failing runs.

## Fourth slice (landed 131c62181)
Shots: polish-shots/r9. Labels: Update firmware -> Update server; Backup/clone server -> Back up this server (button: Back up with a passcode..., as iOS had), iOS + web + Android; peer-restore intro shortened on all three. Add device renders in debug/gym (Variant.allowScreenCapture / stubCamera, both false in release). Migrate + Add device failed states have Try again. Gym 'box' sweep finished (comments/messages). Remaining: Add device error text in the mock is the mock relay's own message (artifact).

## Fifth slice (landed bd3fac62b)
Teal: Material primary = brand #14B8A6 (dark #2DD4BF); accentText #0F766E only for text buttons/links/pills (TextButton wrapper). Create-server backup step: none preselected. minSdk 33 (app + wear), dead branches removed, AGENTS.md floors updated. Shots: polish-shots/r10.

## Sixth slice (landed 6837b59a8)
Home drag: list-level gesture (rows' handle pointer input was reset when the row recomposed from scratch at drag start). Focus ring (teal outer 2dp + ink/cream inner 2dp). AGENTS floors wording. Shots: polish-shots/r11.

## Seventh slice (landed with the iOS-port pass)
Soft danger buttons, Try again on every load error, haptics (toasts, chips, segments, accordion), focus rings on switches/radios/search/selectable rows, announcement cards stack at large text, Activity list/detail at expanded width, rail on medium+, 200% text fixes (nav cap 1.3x, Welcome scroll), pulsing loading rows, Activity tiles/time/spring, AccessibilityRulesTest. Shots r12 r13.
