# Report for critique: the "simplest tasks" pass (2026-10-16 night) + Part 2 (device bugs, USB burn; 2026-10-17)

Audience: a stronger model asked to critique this work. Everything below is checkable; commit ids and commands are given.
Repo: `ibisllc/flagship` (personal-cloud project: phone is the trust root, user's own server, `.com` Worker for identity,
`.services` relay). Owner rules that constrained this pass: **no `Co-Authored-By`/`Claude-Session` trailers**; **only `main`
is deployed**; **imperative subject + why-body commits**; land via a shared lock script (`land-main.sh`) that rebases on
`origin/main`, runs a check, pushes `HEAD:main`.

## 1. What was asked
"Now that we have a list of tasks to do, pick the simplest ones and do them … Go step by step. Compact memory between tasks."
The list is `WORKLIST.md` (streams A Android, B iOS, C cross-platform, D live gym, owner items). Context: ~14 parallel agents had
just been paused after a day of work (wip branches `wip/*-2026-10-16`), and the owner wanted sequential, low-token progress.

## 2. How "simple" was chosen
Criteria I applied: (a) no new behaviour or protocol, (b) verifiable from this Mac without a native build or deploy, (c) no
dependency on any paused agent's branch, (d) low merge-conflict risk against 14 agents editing the same trees.
I did **not** touch anything on the wip branches, the build locks, the gym, prod, or the store/YubiKey items.

## 3. Landed (all on `origin/main`, in this order)
| # | Commit | What | Files |
|---|--------|------|-------|
| T1 | `179858197` | Home backup banner gets its full stop (iOS+Android). "box"→"server" in Activity approvals ("SERVER APPROVALS", "Approve a server's boot", "Sign in to approve a server."). iOS recovery text says the passkey may be in "iCloud Keychain or your password manager". | 7 (4 Swift, 3 Kotlin), 8+/8- |
| T2 | `5e069d33c` | Six stale lines in `AGENTS.md` corrected (see §4). | 1, 11+/8- |
| T3 | `06f685ce4` | Delete-server confirmation in Mac (2 places), Windows, Linux Studio no longer says backups "live with your phone/account, not here". Now: identity stays with the account; backups stored on this server are deleted with it; copies on a phone or peers (per backup policy) are not. | 3, 7+/5- |
| T4 | `f2f995552` | `parity/features.json`: fixed the one broken anchor (`studio-version:linux`), cleared 3 "marked missing but matches" warnings, tightened anchors to ones that prove the feature, and downgraded Mac's version row `present`→`partial`. | 1, 8+/8- |

Net effect on `node scripts/parity-check.mjs --json`: feature errors 1→0, warnings 3→0, total red 41→40. The 40 remaining reds
are signed-tag / test-vector findings caused by **native ports that exist only on paused wip branches** (backup-policy,
debug-access v2, share-accept-admin, etc.). I deliberately did not allowlist or hide them.

## 4. Evidence per task (what was verified vs. assumed)
**T1.** `git grep` showed no test, doc, parity anchor or gym registry pins the old strings. `xcrun swiftc -parse` passed on the 4
changed Swift files. **Kotlin was not compiled.** No tests were run (none relevant). Landed with only `git diff --check`.
**T2** (each claim checked, not copied from the audit that suggested it):
1. "Clients at parity (shell v101)" → "since" (wording only).
2. `.com` Worker line: recorded deploy kept (`3e8fef1de`/`f8c619da`/v113); added: live shell measured **v114** by `curl` on
   `webapp.flagshipserver.com/service-worker.js`; main is **v131**; D1 0104 pending. 0104 "pending" was proven by querying prod
   D1 (`SELECT name FROM sqlite_master WHERE name IN ('pb_holders','pb_leases','pb_token_serials')` → empty).
3. iOS install Live Activity "never starts" → starts on first checkpoint: `b7c49cbf0` exists; `InstallProgressBridge.swift:68`
   invokes `onStart?`; `FlagshipApp.swift` `wireInstallProgressBridge` installs the handler.
4. Stalled-boot advisory "Mac only" → Mac+Linux+Windows: "Taking longer than expected" found in `builder-linux/wizard.py:2027`,
   `vm/manager.py:163`, `builder-windows/src/VM/VMManager.cs:94`.
5/6. Feature-branch paragraph: each `origin/feat/*` `service-worker.js` read → v117–v120.
**T3.** Premise checked in code: scheduled archives are stored on the box's own disk (`serverArchive/saved.ts`, per the backup
agent's report), so deleting the VM deletes them. `swiftc -parse` and `py_compile` pass. **C# not compiled** (no `dotnet`; same
string-concatenation pattern, read by eye). **Linux pytest not run** (pytest not installed for this Python). No test pins the text.
**T4.** Every status flip was backed by grep of the implementation *and* of its call site (e.g. `HostPower.KeepAwake` called from
`Wizard.cs:67`; `IsoBaseCache.PruneUnused()` called from `ApplianceHosting.cs:29`; `WifiCredentialStore` constructed in
`Wizard.cs:690`; `SleepInhibitor` used in `wizard.py:2369`). The checker itself rejected my first Windows-Wi-Fi anchor
(`new WifiCredentialStore` – the code uses target-typed `new()`), which I fixed; this is the strongest evidence the anchors are real.

## 5. Considered and not done (with reasons)
- **Webapp heading "Approve a box's boot"** (`apps/web/public/webapp/index.html`): any webapp change needs a shell-version bump and
  8 test files pin `v131`; several agents land webapp changes concurrently. Edited, then **reverted**; recorded as a follow-up.
- **iOS Create-server subdomain prefilled "home"** (M6): changes view-model behaviour (`vm.name` starts `""`), needs Swift tests
  and a build. Belongs to stream B.
- **DNS-zone leftover reaping** (owner item O1): listing the ~70 stale records needs a Cloudflare token (not available) or a new
  admin route (none exists; building one is a prod change, not "simple"). `FLAGSHIP_ADMIN_SECRET` is in the environment but no
  read-only zone route exists. Recorded as blocked.
- **Mac Studio version stamping**: real bug found (shipped Mac app reports 0.1.0 vs Windows/Linux 0.1.3). The fix touches
  `scripts/release-studio.sh` (a release script; earlier in this project reading it right after a publish was denied by the
  permission system). Left alone; surfaced in the parity row.
- **Signed-tag/test-vector reds (40)** and **actionable iCloud-Keychain error hints** in `RealAccountLoginViewModel.swift`: left as
  is (the latter is correct advice).

## 6. Things that went wrong during the pass (so you can judge process quality)
- zsh quirks cost two retries: unquoted `--include=*.swift` globs, and `$ref:refs/...` parsed as a `:r` modifier (earlier, during
  branch backup). Fixed by `git grep` and `${var}` quoting.
- A first-pass **negative grep** ("stalled" in Windows/Linux) falsely suggested a claim was wrong; widening the pattern showed it
  was right. Policy adopted: a negative grep needs a second, differently-phrased query before editing.
- `python -I -m pytest` hid user site-packages (pytest missing) and the non-isolated retry also failed: tests simply not available.

## 7. Risks and weak spots (where I'd push if I were reviewing)
1. **T1 landed with essentially no compile verification** for Kotlin (and Swift only parse-checked). Risk is tiny (literals) but non-zero.
2. **T3 wording may still overpromise**: on `main` today the phones' background backup fetch is *not* landed (only on
   `wip/backups-*`), so "copies kept on your phone" is true only for manual downloads. I hedged with "depending on its backup policy".
3. **T2's v114 deploy is unattributed.** I wrote that it was "not recorded here" instead of guessing a commit. A reader may want
   the real deploying commit.
4. **T4 relies on the project's own anchor checker as the oracle.** The parity audit itself warned that "many anchors only prove
   a file exists"; I tightened the six I touched but did not audit the other ~60 anchors.
5. **"box→server" sweep is only the strings that were reported.** Other user-visible "box" wording may remain (not audited).
6. **Landing process**: I used `land-main.sh` with a whitespace-only check for three of four commits (no tsc/vitest) because the
   changes could not affect them; a stricter policy would run `npx tsc -b && npx vitest run` anyway.
7. The wider repo is in a split state (see §8); a critic should check I did not make it worse (I believe I did not: each commit is
   independent of the paused branches and conflict-free on rebase).

## 8. State of the wider repo (unchanged by me)
- 14 agents paused; work saved on `wip/*-2026-10-16` (+ `wip/auto-*` for cut-off ones). Order of work: `WORKLIST.md`.
- Not deployed: `.com` (needs D1 0104 + 3 peer-backup secrets), `.services`, any box release (YubiKey), store builds, CA lease
  renewal due **2026-11-05**.
- Open owner decisions recorded in `decisions.md`; DNS zone at 154/200 records (≈3–4 more accounts fit).

## 9. Questions for the critic
1. Was "simple" the right cut, or should T3 have been left until backups land (to avoid wording that is only partly true today)?
2. Is downgrading Mac's `studio-version` to `partial` the right use of the matrix, or should a failing check be added instead?
3. Is landing literal-only native edits without a compile acceptable given the project's "land only green work" norm?
4. Anything in T2's `.com` line that could mislead a deployer (it mentions a pending migration but not the 3 secrets)?
5. Which of the skipped items would you have done first, and which of my skips was actually avoidable?

## 10. Reproduce
```
git fetch origin && git log --oneline 179858197^..f2f995552
node scripts/parity-check.mjs --json | node -e 'const j=JSON.parse(require("fs").readFileSync(0));console.log(j.red,j.features.errors,j.features.warnings)'
curl -s https://webapp.flagshipserver.com/service-worker.js | grep -m1 'SHELL_VERSION ='
git grep -n "backups live with your phone" origin/main      # expect no output
```


---
# Part 2 (2026-10-17): real-phone bug fixing and the USB burn test

Same rules as above (no trailers, only main deployed, land via `land-main.sh`). Per-task log: `REPORT-LOG.md` T5, T6, T6b.
The owner's Samsung (Android 16) was driven over adb by me; agents only used the emulator; I never read private phone content
(one accidental screenshot while a chat app showed was deleted unseen).

## 11. Landed in Part 2
| # | Commit | What | Evidence |
|---|--------|------|----------|
| T5a | `c4cccf4a4` (A1 agent) | Android: no mock fallback in live mode; mocks + developer mode moved to `src/debug`; release-clean check script; cloud-recovery fixes; subdomain default "home" + draft survival; error logging; BiometricGate (prompt only while RESUMED); cold-start lock; off-main-thread key wrap | verified on the real phone: M11, M12, no fixtures, M6 |
| T5b | `1764bb9d5` (me) | `Keystore.irkPubHex()` read the unversioned `irk.seed` slot while `deriveIRK` caches `irk.seed.v<N>`: NullPointerException broke create server, delete, migrate, transfer, SWK deposit, trust bar on fresh accounts (M8) | root cause found from the new step log; 2 Robolectric tests fail on old code (9 run/2 failed), pass on fix; on device: mint, registered with .com, "Watching the new box come online" |
| T6a | `250d2e68b`, `4575e7f2d` | Key-backup screen states the passphrase rule it enforces (12+ chars, 3 of 4 classes) with a "Too weak." error; iOS wording only (its rule is length-only) | first hypothesis (stale Compose enable) disproved by experiment; device log `wrap start/done` 0.65 s |
| T6b | `a62f73b2b` | `@EncodeDefault` on `WireBlob.version/registrationUrl/installerGitRef` and `WireAuthCode.version`: kotlinx omits defaults, so the preseed engine rejected every Android recipe ("InstallBlob fields incomplete") | new JSON-shape test fails on old code; burn then succeeded |
| B1 | `3576f5e66` (iOS agent) | iOS Release has no mocks/developer mode (`#if DEBUG`), `scripts/ios-release-clean.mjs` + vitest | Release scan clean on 4 Mach-O files, 1881 unit tests, mock gym 6/6 |

## 12. USB burn on the phone (feat/phone-usb-burn rebased to e148b207c, unlaunched branch)
Flow: Create server, Burn, "Choose local seed..." (debug-only, adb-pushed ISO, sha256 `ad91527d...`), owner granted USB access,
"Erase and write", about 70 s, "All done". Two failures on the way were not USB bugs: prod `.com` rejects platform `android`
(the server half exists only on the branch), and the Android recipe bug above (a real main bug).
**Stick checked on the Mac (root copy run by the owner):** first 790,626,304 bytes byte-identical to the seed ISO; at LBA 1544192 a
FAT16 volume `FLAGSHIP` with `PRESEED.CFG` (84,899 B) generated at burn time whose late_command references the install blob.
**Not verified:** boot on metal (no spare PC), the blob's contents/signature, and the managed manifest-download path (needs the
branch deployed to the gym; the permission system blocked D1/R2/SSH steps there, so three owner-run commands are listed in the gym-burn agent's report).

## 13. Weak spots for the critic
1. The burn used a **local seed**, so the product path (manifest download from `.com`) is untested end to end.
2. I verified the write by byte comparison, not by booting; "All done" in the app proves nothing about the stick.
3. I inspected the preseed by `grep` counts only; I did not parse or verify the embedded signed blob.
4. The M8 fix lives in a getter with an `init` fallback; a better design might make the cache key a single constant owned by `deriveIRK`. Tests cover the symptom, not that invariant.
5. Burn polling loop kept running two minutes after an error (token waste); fixed. Disk ran out twice (1.3 GB, 2.4 GB free); a Disk rule was added to the agent brief.
6. Four stale pending orders (`home`..`home4`) sit in the throwaway account `nimble-caracal` because of my create tests; they expire by themselves.
7. The debug gym-pinned APK shows "Control server certificate expired" against prod; the wording is misleading.
8. The preseed still carries the known build-time disk passphrase (GA close-out item 2, tracked, not new).

## 14. Questions for the critic (Part 2)
1. Is a debug-only "Choose local seed..." an acceptable substitute for testing the manifest path, or should the gym deploy have been escalated to the owner first?
2. Should `a62f73b2b` have shipped with a cross-platform golden vector (TS/Swift/Kotlin) for the recipe wire shape instead of an Android-only JSON test?
3. Is moving the ownership of the IRK seed cache key into one place worth doing before store builds?
4. Was handing the owner a `sudo` copy script the lowest-privilege way to verify the stick?

---
# Part 3 (2026-10-17, day): parity, gym, polish, GA close-out

Rules as before. 8 agents in parallel (Android, iOS, web/box, live gym), coordinator verifies and relays. Everything below is on `origin/main`; nothing was deployed by an agent (prod deploys are owner-run; the permission classifier blocks them).

## 15. What landed (by theme)
- **Native ports at parity** (iOS/Android/web): co-manager invites, admin-only share acceptance, debug access v2, env-sign, backups (policy, scheduled, one `.flagship` file, phone copy, per-app storage limits + alert), peer backup v2 status + restore from other servers, admin-only Add device, one "Connect to an existing account" page. Parity check: 43 reds -> 1 (real gap: webapp ACME key grant). 14 signed-tag allowlist entries were added with one-line reasons (review them).
- **Live gym on UpCloud:** 22 groups / 244 checks green (runs 7, 8 consecutive; run 5 earlier). Bugs found and fixed: saved/migrate backup ENOENT on a box with no on-demand archive; per-app ballast ate 16 MiB of every limit (ext4 reserve); gVisor retry after 10 min; gym boxes cloned main's prod trust pin; update group needed a box on main.
- **CI on GitHub:** green except Android release-clean (fixed after); causes were a duplicate import breaking all web gym scenarios, two stale e2e specs, a 30 min timeout vs a 35 min tier (now 60), and a stale test file clobbered by a squashed commit.
- **Polish (owner: not optional):** iOS Dynamic Type (807+268 call sites previously ignored it), haptics, motion, accessibility labels, input look, chat bubbles, Settings as native List; Android Material 3 (type scale, compact bars, tonal cards, motion, predictive back, haptics, tablet rail, list/detail Activity, focus ring); webapp/site contrast system with tests. Owner decisions: brand teal is the light #14B8A6 (graphics/fills); deep #0F766E only for inline text links; labels ink + teal marker; focus = teal ring + ink inner ring; status text deepened.
- **Owner UX:** Add/Restore server menu (Create, Co-manage, Restore from backup: file / other servers / this phone); backup step in Create server has no default; locking the app now dismisses every dialog/sheet/menu on all three clients (real bug: they stayed above the lock screen).
- **GA close-out (owner-approved, demo accounts kept):** prod-wipe script guarded (env + typed target, TTY only); W12/late-log debug endpoints removed; dev flips scanned out of release paths (+ /dev/create-server page deleted); gVisor mirror list (R2 then upstream, SHA-512 pinned). LUKS passphrase removal NOT built: design + 9-step test plan in docs/luks-burn-passphrase-removal.md (gym boxes are unencrypted cloud boxes, so no live proof there).
- **Floors:** Android minSdk 33 (Wear OS 4), macOS 15 (Sonoma stopped getting fixes; one source only, verify on Apple's page), iOS 18/watchOS 11 unchanged.
- **Website:** ghost button border (a reset removed border-bottom), em dashes removed from all public pages (+ a test).

## 16. Process failures worth a critic's eye
1. A squashed iOS commit (e4c9c4e82, 100 files) was built from a stale tree and silently reverted others' landed work (iOS Activity redesign, a web test fix, Android parts); found by me from an Android agent's note, repaired in 080522ff6 and 568bd5218. Rule added to the agent brief ("never clobber landed work"). Nothing automated prevents a repeat.
2. main was red for minutes after an agent piped its land check through `tail`; rule: land checks unpiped.
3. I relayed an unverified claim ("iOS says Software update") from an agent report; caught by the next agent. Verify before relaying.
4. Disk hit 100% twice; agents lowered the brief's 5 GB floor on their own once.
5. My first teal split kept too much dark teal; history showed the light teal had been the brand for a month, darkened only 2 days earlier by an agent-driven commit. Contrast needs vs owner taste: bright teal graphics are 2.3:1 on paper (below WCAG 1.4.11's 3:1), accepted for labelled/decorative graphics and enforced by tests (icon-only controls must carry labels).
6. Several gym tests are timing-flaky under load (load average ~25 from the owner's hosted VM); waits were added, root causes unproven for two.

## 17. Open / for the critic
- Is the 2.3:1 graphic teal an acceptable accessibility trade-off?
- Is a removal-by-design for the LUKS slot right (random per-install passphrase) vs sealing the slot with the TPM-less phone key?
- 14 allowlisted signed-tag differences: any that hide a real gap?
- Release readiness: server-side changes since endorsement 91ec31931 (gym fixes, gVisor mirror, wipe guard, installer log removal) need another endorsement + .com deploy; store builds wait for that.
- Free AI: shim deployed with keys on 10-14 but no public host (route landed a1df5e106, deploy is owner-run); never run end to end.
