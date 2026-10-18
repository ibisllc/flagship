# Owner decisions, 2026-10-16 (hand to any worker; also recorded in the docs named)
- LAN-direct ships in the MVP, provided every failure is a no-op back to relay + a log line (docs/lan-direct.md, launch-mvp.md).
- Co-managers can invite people at Member; demoted/removed/view-only co-managers can't (docs/service-access-gating.md "Co-manager invites").
- GA: keep owner debug SSH, hardened (key only, admin-signed, expiring, revocable, visible) (docs/recipe-delivery-and-remote-install.md).
- GA close-out happens after the gym's bugs are fixed.
- Release builds contain no mock data and no developer mode (mocks live in debug/gym only).
- Android: native Material 3 look, each page organised like the iOS app, with an Android feel; no emoji icons.
- Welcome: one "Connect to an existing account" (sign in by account name OR scan/paste a pairing code/link on one page), all apps.
- Welcome + lock screens: big green primary, secondary just below, gap, "Patent Pending" at the bottom, all apps.
- Every manual test becomes a gym scenario (mock + live).
- Backups: Backup and Migrate buttons stay one-off actions. The backup POLICY (set at create, viewable/editable on the server page) runs separately; phone policy caps the server at the phone's reserve; peer policy caps it at 1/3 of its disk, with cross-user blind-matched peer storage, random filler and storage challenges.
- Manual backup passcode is mandatory; the UI says it's needed to import into an account that isn't yours.
- Restore with failing apps: try every app, then stop waiting; list the failures.
- Co-manage acceptance: no blind tokens; the joining account's ADMIN device signs the acceptance and the owner's server verifies it against that account's admin root; .com learns nothing new (docs/share-a-server.md).
- Migrate v1: apps pause during the move; show an estimated downtime first, a 'moving to a new server' page while paused, and progress; live replication later.
- Backups: ONE file only for users (magic FLGSHBK1 + u64 BE meta length + meta + data); no two-file option anywhere in the UI; streamed + resumable on every platform.
- Adding a device to the account: admin devices only; non-admin devices see 'Only an admin device can add devices.'

## 2026-10-17 (owner): iOS UX changes are ported in spirit to Android
Every UX improvement the owner approves on iOS (the reference client) gets an Android port in the same spirit (native Material 3, not a copy), tracked as a task. First: Activity tab accordions (see WORKLIST F3/F4).

## 2026-10-17 (owner)
- Primary button colour: the teal we have now stays (iOS, Android, webapp). No separate "brand green".
- UI polish to native state of the art is NOT optional for GA: every screen on iOS and Android must look native and deliberate, not AI-generated. Tracked as WORKLIST P1 (iOS) and P2 (Android).

## 2026-10-17 (owner, later)
- Brand teal is the LIGHT teal #14B8A6 (used for a month on web, site and iOS until the 10-15/10-16 darkening). Apps adopt it, not the reverse. Deep #0F766E only for inline teal text links; labels/headers ink with a bright-teal marker.
- Minimum OS = earliest version with reasonable security (existing rule): Android minSdk 33 (Android 13), macOS 15 (Sonoma stopped getting fixes), iOS 18 and watchOS 11 unchanged.
- Backup step in Create server: NO default (user picks), options No backup / On my phone / On other servers, says it can be changed later on the server's Backups section, short descriptions.
