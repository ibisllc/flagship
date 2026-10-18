# Device test agent: Windows PC and Chromebook

You are a Claude Code agent on one of Harry's test machines (a Windows PC or a
Chromebook). The Mac can't run these checks, so you run them, with Harry doing
the steps that need hands (a phone, a USB stick, a reboot into a stick). Work
through your machine's list below, record every result, and push the results
so the coordinating agent on the Mac can fix what fails.

## Rules

- **Test, don't fix product code here.** If something fails, collect the
  evidence (exact message, screenshot description, logs, timings) and move on.
  The Mac fixes and ships; you re-test after Harry pulls again. You may fix this
  runbook if a step is wrong; say so in your report.
- **Never push to `main` or any `feat/*` branch.** Results go to your own
  branch (see "Report").
- **Never deploy anything** and never run `wrangler`, `flyctl` or
  `scripts/*deploy*`/`release*` scripts.
- **Accounts.** Use the account Harry names for the run. Destructive steps
  (Delete server, Migrate, Wipe & restart, Revoke) only on a server Harry says
  is disposable. Never touch the store reviewer account `playstore-test-0725`.
- **Privacy.** Don't paste account names, server names, IPs, Wi-Fi names or
  passwords into the report; write `<account>`, `<server>`, `<ssid>`.
- **Ask Harry** whenever a step needs the phone, a USB stick, a BIOS boot menu,
  or a password. Tell him exactly what to tap, and what you expect to see.

## Setup (both machines)

```sh
git clone https://github.com/ibisllc/flagship.git && cd flagship   # or: git pull
git checkout main && git pull
```

`AGENTS.md` (loaded through `CLAUDE.md`) is the project's orientation; read
"Desktop Studio" and "Validating on Windows and Linux". The detailed Studio
steps are in `docs/runbooks/desktop-windows-linux-validation.md`; this file says
which of them to run and how to report.

**Which Studio build to test:** the newest successful `studio-release.yml` run
on `main`, not the published release, unless Harry says otherwise:

```sh
gh run list --workflow studio-release.yml --branch main --status success --limit 3
gh run download <run-id> --dir studio-build      # Windows zip + Linux AppImage
```

If `gh` isn't signed in, ask Harry to run `gh auth login`, or fall back to the
published release (`https://flagshipserver.com/download/windows` or
`/download/linux`) and note that in the report.

Write down the build you test (run id or release version, Help → About).

## Windows PC

Run sections 2.1–2.8 of `desktop-windows-linux-validation.md` with the CI
build, then:

1. **Webapp in Edge and Chrome.** Open `https://webapp.flagshipserver.com/`,
   sign in (Harry's phone approves), install it as an app (Edge: ⋯ → Apps →
   Install). Walk: Home (server list, drag to reorder, Make leader, Add/Restore
   server menu), a server page (Health, Backup / Migrate card, Activity,
   Diagnostics, Settings), an app page (Access control, Members, Runs on, API
   keys, Database, Backup now), Settings (Lock the app, Sign out, Browser
   sessions, Danger zone). Note anything that errors, looks broken, or reads
   oddly.
2. **Remote.** Open `https://remote.flagshipserver.com/`: a QR shows at once;
   Harry scans it, picks a server, approves. Pass = the browser opens that
   server's page.
3. **Backup to this PC.** On a disposable server: Backups → Back up now (a
   passcode is required; the app says why) → download the single `.flagship`
   file to the PC. Then Add/Restore server →
   Restore from backup → From a file onto a new server hosted by Studio on this PC. Pass = the
   apps come back and open.
4. **USB burn + metal boot.** Section 2.7: burn a stick with Wi-Fi, boot a spare
   machine from it, approve the unlock on the phone, green padlock.
5. **Logs to collect on any failure:** `%LOCALAPPDATA%\FlagshipBuilder\`
   (VMs, Appliances, any `*.log`), `%LOCALAPPDATA%\flagship-builder\`, the
   Studio window's own error text, and `powercfg /requests` output for the
   sleep check.

## Chromebook

1. **Webapp in Chrome.** Same walk as Windows item 1. Install it (Chrome ⋮ →
   Cast, save and share → Install page as app). Check it opens from the shelf
   and that notifications can be turned on (Settings → notifications) and
   arrive when a server comes online or an app asks for access.
2. **Remote.** Same as Windows item 2.
3. **Android app on ChromeOS** (if the Chromebook runs Android apps): install
   Flagship from Play. Note the version (Play may still serve the older store
   build: that's useful, record what works and what doesn't). Sign in with
   recovery under "Connect to an existing account". Walk Home, a server page and an app
   page. Note any layout problems with a keyboard/trackpad and window
   resizing.
4. **Linux Studio (optional, if Linux development environment is on).** In the
   Linux terminal: `ls -l /dev/kvm` (hosting needs it; most Chromebooks don't
   expose it, and that's a valid "not supported" result). Install
   prerequisites from section 3 of the validation runbook, run the AppImage,
   pair, and try section 3 steps 1–2. For USB burning, Harry must first share the
   stick with Linux (ChromeOS Settings → Developers → Linux → Manage USB
   devices). Record which parts work.
5. **Logs:** `~/.cache/flagship-builder/`, `~/.config/flagship-builder/`, the
   terminal output of the AppImage, and Chrome's DevTools console for the
   webapp (Harry can open it with Ctrl+Shift+J).

## Report

Write `device-results/<machine>-<YYYY-MM-DD>.md` (`<machine>` = `windows` or
`chromebook`) with:

```markdown
# Device results: <machine>, <date>
Build: <run id / version>   OS: <Windows 11 23H2 / ChromeOS 1xx>   Hardware: <cpu, ram>

| # | Check | Result | Time | Notes / evidence |
|---|-------|--------|------|------------------|
| W2.2 | Pairing at launch | pass / FAIL / blocked / n/a | 0:40 | ... |

## Failures (one section each)
What you did, what you expected, what happened (exact text), logs (attach
short excerpts inline; put long logs in device-results/logs/<machine>-<date>/).

## Runbook problems
Steps that were wrong or unclear, and what you changed.
```

Then push it on your own branch and tell Harry it's there:

```sh
git checkout -b device-results/<machine>-<YYYY-MM-DD>
git add device-results/
git commit -m "Record <machine> device results for <date>"
git push -u origin HEAD
```
