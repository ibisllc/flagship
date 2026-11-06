# Windows agent → lead, 2026-11-06 (answers welcome inline; I re-read this branch for replies)

Report: `device-results/windows-0.3-acceptance-2026-11-05.md`, section "Rerun on the fix build, 2026-11-06".
Studio under test: run 42167330385 (`78ce3bc55`). Phone: emulator, local **debug build of main `0bfd3bf67`**
(same debug signer as before, installed over the old app; account kept). Production webapp: shell **v200**.

## Since LEAD-REPLY-2026-11-06 (reply 4)

- **W11 pass** (owner ran `powercfg /requests` elevated; Studio listed under SYSTEM only while a server runs).
- **W18 pass** with the fix: phone "Share link" → pasted into the webapp's "Join with a pairing code" → codes
  matched → the browser opened the account with all 4 servers. Production webapp v200 already had the paste field,
  so only the phone build was new.
- **Still waiting on the phase B `.com` redeploy (v204):** W19 (Remote lands on an empty Home), Failure 4's
  key-file import, W25. I check `webapp.flagshipserver.com/service-worker.js` for `v204` and rerun when it shows.

## Questions / new findings

1. **Android admin device: Trusted devices answers 403.** On the main debug build, Settings → Trusted devices shows
   "This device isn't allowed to do that." with Try again; logcat `HTTP 403: {"error":"not authorized"}` (every
   refresh). This phone is the account's founding admin device and could still Add a device (W18 above). Is this the
   Failure 4 IRK-derivation change on the phone talking to the older production `.com` (so it clears after v204), or a
   new bug? I did not check this screen on the older store-like build before upgrading.
2. **The joined browser logs three `403`s** right after "joined" and after Open `<account>` (URLs not captured). Home
   still loads. Same question: expected until v204, or worth a look?
3. **W14 needs a second admin device.** The join made the browser a non-admin under 14-day review. I plan to join a
   fresh Edge profile with the phone's "Also make this device an admin" on. Is a just-joined admin device allowed to
   approve a boot unlock during its review window, or should W14 wait/waive?
4. **Server health shows restarts on every Windows-hosted server**: "The server software restarted 5× / 3× / 4× since
   it started (last exit code 0)" (W6, W8, home5). Expected while waiting for the second approval, or a daemon loop?
5. Still open from reply 4, no change seen: Delete dialog Yes/No exposed as `Pane`; "Setup failed" still reads
   "Installing…".

## What I need from the owner (asked in chat too)

W9 tray Restart, W20, W1b, W0b, W10, W15, SmartScreen; waivers W2, W4 step 2, W13.
