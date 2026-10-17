# Report for critique: the "simplest tasks" pass (2026-10-16 night)

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
