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

### Windows PC: architecture v2 drills (branch `feat/architecture`, milestones 6 and 7)

The owner's Windows test machine has a TPM 2.0 and an NVIDIA GPU. Both drills below run on the
**metal**, booted natively from a USB stick, never in a Studio VM: Studio's hosted VMs on Windows
get no TPM (a VM's virtual TPM would be the Windows host's, which protects nothing against that
host, plan §7) and no GPU (Studio cannot pass a GPU through to a guest).

**A. TPM unlock drill (milestone 6, `docs/architecture-v2/pq-suites.md` §19).**

1. Back up anything on the spare internal disk or use a second disk: the install wipes it. In the
   firmware: TPM (fTPM / PTT) on, Secure Boot as it ships, USB boot allowed.
2. In Studio built from `feat/architecture`, burn a USB stick for a disposable demo account on the
   gym (never `playstore-test-0725`), boot the PC from it, and approve the first unlock on the
   phone (iOS or Android built from `feat/architecture`).
3. Once the box is online: on the box (debug access), check
   `ls /boot/flagship-boot-mldsa.key /boot/flagship-lease-kem.tpm/` and
   `cat /boot/flagship-lease-kem.tpm/pcrs` (expect `sha256:` and the measured PCRs, 7 at least),
   and that `/boot/flagship-lease-kem.key` is absent. Record `tpm2_getcap properties-fixed`
   (manufacturer, firmware version).
4. Turn auto-unlock on from the phone (the phone deposits a v3 lease). Reboot: pass = it unlocks
   with no phone prompt, and `/boot/flagship-unlock.log` says "unlocked from the auto-unlock lease".
5. **PCR mismatch:** toggle Secure Boot (or boot once with a different boot entry) and reboot.
   Pass = the log says "the TPM did not release the lease key" and the phone is asked; approve it.
   Reboot again with nothing changed: pass = no prompt (the daemon resealed after the approved boot).
6. **Strict:** on the phone, Settings, Quantum-safe protection, turn strict on for this server.
   Reboot with auto-unlock off: pass = the phone's approval works (v2); then try approving from the
   webapp: pass = the box refuses it (`strict-refuses-v1` in the unlock log) and the webapp says to
   use the phone.
7. **TPM clear / reset:** in the firmware, clear the TPM, boot. Pass = the box asks the phone (no
   lease opens) and, after approval, `/boot/flagship-lease-kem.tpm/` is rewritten. Record whether
   any step needed a recovery passphrase.
8. Report the receipts as in "Report" below (one file per drill), with the unlock log, the
   `pcrs` file and the TPM vendor line.

**B. NVIDIA GPU test (milestone 7).** Use the same native USB boot (a Studio VM cannot reach the
GPU). The steps come with milestone 7; until then only record `lspci -nn | grep -i nvidia` and the
driver the box reports.

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
