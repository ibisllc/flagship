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

## Update ~14:55 (after lead reply 4 edits 1a54eb5ea / d3bafed67)

- Read: Delete dialog = native MessageBox (will check with Narrator, not UIA); setup-error, offline start screen and
  translation fixes on main (4f9e3d664, 5fc9da749, bc4c740f5, 502b78ce0 all confirmed on origin/main).
- **Needs the owner:** a new `studio-release.yml` run from main at or after 4f9e3d664 (I may not dispatch CI). Once it
  exists I rerun on it: offline start screen (HTTP(S)_PROXY=127.0.0.1:9), a forced setup error, and the rows already
  passed (W6/W8 quick rechecks).
- W9 step 3 (tray Restart) now passes (~2 min, no phone prompt). W10 (UAC) is running with the owner now.

## Ack ACTION NOW (b23e04f43), ~15:15 local
- Will run the required rows on studio-release run 42233345531 (36d8106d9) as soon as it finishes (in progress at
  15:15); exe version checked first. Order: W5, W6, W8, W9-W14, W17-W19, W25, W26; owner rows listed as "owner".
- Production webapp still v200 at 15:15; I re-check every 30 min and run W19 / key-file import / W14 / W25 once v204 shows.
- W10 on 78ce3bc55 with the owner: steps 1 (No) and 2 (timeout) pass, but Restart as administrator stops the running
  server BEFORE the UAC prompt, so No/timeout leave it Stopped until Start. Step 3 (Yes): the elevated Studio opened
  (15:06:01) but home5 was not started again 6 min later (no VM, HTTPS fails); owner checking the window. Will rerun W10
  on the release build.

## ~16:15 local: Failure 5 on the release build (W6) — needs you
A new server hosted by 0.3.0+36d8106d9 from the published appliance `ecd620cb` reaches Running in Studio (health report
filled, both approvals done) but answers every TLS handshake with alert 49 `access_denied` and no certificate, 20+ min
later; the phone says "Never came online". Details in the report, "Release build 42233345531". Questions:
1. Did phase B endorse a new box release today (a new server moves to it on first boot)? If so, does its TLS path
   (keyd / tlsd, the certificate request) refuse here? This morning's W6 on the same appliance passed.
2. Is reusing a server name the account had before (deleted earlier) expected to work? I'm rerunning with a never-used
   name now to separate the two.

## ~16:37 local: Failure 5 reproduced with a never-used name
Same result for a brand-new name (Running 15:25:39Z, alert 49 at 15:36Z). Not the name. Remaining suspects: today's
backend (phase B relay / .com changes: alert 49 may come from the relay refusing the SNI for a newly registered box)
or the box release a new server moves to. Next I host one on the old Studio 78ce3bc55 (passed W6 at 05:54Z) to
tell Studio from backend. Is anything deployed to `.services` / the relay since ~06:00Z?

## ~16:57 local: URGENT — Failure 5 is production, not Studio
The OLD Studio 78ce3bc55 (W6 pass at 05:54Z) now fails identically: a new server (Running 15:46:49Z, both approvals
done) gets TLS alert 49 `access_denied` at 15:55:45Z. A server registered last night still serves 200. So every new
server registered since sometime between 05:54Z and 14:51Z can't be reached: likely the relay or `.com` from today's
phase B steps (or the newest endorsed box release a new box moves to on first boot). This blocks W6/W8 and any new
user's first server; please check before the release continues. I'm holding new hosting runs until you answer; the
`<server-G>` VM stays running here for you to test against.

## ~21:05 local: v204 is live — results
- **W19: still FAIL, half fixed.** The browser now shows the comparison code (380 416, same as the phone) and the phone
  connects it ("Browser connected to <server-A>", a 4 h session listed), but the browser lands on the empty keyless Home
  ("Your first server is one tap away", Session "Unpaired"), not the server's page. Same as before on that half.
- **Failure 4: fixed.** A fresh Android key file imports in Edge with no 403; it starts the 3-day device replacement
  ("takes over in 2d 23h"). read-token 403 / pods 401 while waiting — expected? The phone shows only an Activity line.
- **Failure 5 is still open** (no reply yet): home7 still refuses TLS (alert 49). New servers can't come online.
- Next: W14 via a W18 join with "Also make this device an admin" on (the key-file route waits 3 days).

## 2026-11-07 ~13:15Z, after lead reply 5
- Thanks: Failure 5 = the account's abandoned-order cap. **W6 rerun on the release build passes** (Running 10 min after Host,
  HTTPS 200 with Let's Encrypt YE1, phone Online). Stuck servers deleted. Restart count this time: 4x (exit 0).
- Correction: the phone DOES show the key-file recovery (Critical banner with "refuse the recovery from an admin device");
  it appeared after I first looked.
- Next: W8 (FORCE_ISO) on one more server (budget allowing), then W14 via an admin W18 join, capturing the 403 URLs you
  asked for.

## 2026-11-07 ~13:40Z
- **W14 FAIL**: an admin-switched W18 join still lands as "non-admin for the first 14 days"; that browser's Activity shows
  the server's boot approval, "Yes, this is my server" works, but **UNLOCK does nothing and says nothing** (6 min, request
  stays listed, no HTTP error); the phone's Approve on the same request unlocks in 74 s. Either let a reviewed-pending
  device unlock, or disable Unlock with a sentence. Report row has the exact sentences.
- **Trusted devices 403 on Android** = the signed `GET /api/accounts/<account>/directory` (TrustedDevicesViewModel.load()),
  still "This device isn't allowed to do that." on v204 with the main debug build (founding admin phone).
- **Browser 403s after join** (yesterday): not captured then; today's joined browser logged only 404 `messages-state`
  and 404 `recovery/by-username` (both probably fine).
- Recovery reject works on the phone; the phone's Critical banner stays stale afterwards (browser shows Resolved).
