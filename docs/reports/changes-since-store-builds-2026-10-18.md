# Changes on `main` since the store builds were cut (2026-10-06 to 2026-10-18)

Report for a critical reviewer. Written 2026-10-18 against `origin/main` = `9b5210992`.
Repo: `ibisllc/flagship` (personal cloud: the phone is the trust root, the user runs
their own server, TLS ends on the user's box, `flagshipserver.com` ("`.com`", a
Cloudflare Worker + D1) holds identity and state, `flagship.services` ("`.services`", one
Fly app) is a stateless relay).

## 0. How to read this report

Evidence tags used on every non-trivial claim:

- **[V]** verified by me in this session: I ran the command, read the code, or did the
  public DNS lookup myself. The commands are in section 7.
- **[C]** claimed by a commit message, a doc, or `AGENTS.md`, and I did not independently
  check it. Treat it as an assertion by the author, not as a fact.
- **[N]** not verified by anyone I can find evidence for, or known not to have been run.

Short hashes are commits on `main`. Surface abbreviations: **WEB** webapp, **iOS**,
**AND** Android (+ Wear OS), **STU-M/W/L** Studio for Mac / Windows / Linux, **COM**
`.com` Worker, **SVC** `.services` relay (Fly), **BOX** the user's server daemon,
**INST** installer / VM appliance / builder engine, **SITE** public pages.
Deploy-consequence codes: **[COM]** deploy `.com`; **[SVC]** deploy `.services`;
**[END]** new endorsed box release (YubiKey; boxes only run signed code); **[iOS]** /
**[AND]** new store build; **[STU]** new Studio build; **[APP]** rebuild and republish the
VM appliances; **[D1:nnnn]** D1 migration; **[SEC]** new Worker secret; **[OWN]** a manual
owner step.

Nothing in this report was deployed or signed by me. Production contact was a handful of
public DNS lookups (section 7) and, in revision 2 only, one read-only `SELECT` on prod's D1
migration ledger that the coordinator asked for (section 0.1).

Baseline of sections 1-8: `origin/main` = `9b5210992`. Revision 2 (below) was added later the
same day against `eb449c357` and corrects some statements of revision 1 in place; where a theme
text and section 0.1 disagree, section 0.1 is newer.

### 0.1 Revision 2 (2026-10-18, later): landings since the baseline and what changed in this report

**Landings since `9b5210992`** (`git log 9b5210992..origin/main`, 6 commits, all [V] by `git log`):

| commit | what |
|---|---|
| `a365def74` | live-gym group `freePlan`, a Worker-tail CPU watch in `shared-run.ts`, doorbell budgets on the `update` and `decommission` checks. **Not run** [N]. |
| `df4fab56c` | `scripts/release.sh`: an interactive release runner (1,851 lines now), `scripts/release.test.ts`, section "Run it with the script" in `final-deploy.md`, a line in AGENTS. |
| `d274d8b00` | this report. |
| `9ed418ce3` | `release.sh` reorder: `.services`, then the manual DNS step (wildcard + apex CAA, checked with `dig`), then `.com` with `zone-health` as its post-check; parsers tested against 10 captured-output fixtures in `scripts/release-fixtures/`; checked under macOS bash 3.2. |
| `40195ab9f` | doc fixes for D1-D7 (below). |
| `eb449c357` | doc fix: the wildcard comes before the `.com` deploy (below). |

**Phase A / Phase B release split** (`release.sh --list`, [V] by running it): 27 steps. **Phase A,
steps 1-16, deploys the real state before the Windows test**: preflight, plan acknowledgement, CA
lease, endorsement (YubiKey), VM appliance builds kicked off, secrets (names only), the gym gate
(the owner types `verified`), D1 backup prerequisites, migrations, `.services`, the manual DNS
step, `.com`, a 60-second `exceededCpu` tail, publish the appliances that are ready, redeploy
`.com` for the manifests, and write `device-results/DEPLOYED-FINAL-<date>.md` for the Windows
agent. **Phase B, steps 17-27, runs after the Windows results**: maintenance notice, pre-GA scrub,
reap + `zone-health`, retire the wipe tooling, Studio Windows/Linux, Studio Mac, arm64 appliance,
`.com` redeploy, iOS, Android, final verification. Phase B refuses to start until phase A is
recorded finished (typed `windows-ok` before the scrub). It pins one commit, builds from its own
clean worktree, asks before every outward step, never force-pushes and keeps state in
`~/.flagship-release/state.json`. What I verified: `scripts/release.test.ts` passes (22 tests; I ran
it as the land check for `40195ab9f`). **Not verified: any real run of the script** (it needs a
terminal, a YubiKey and prod logins), that its `dig` and `zone-health` gates behave on real DNS,
and that its step order equals what the owner wants to do by hand. The Studio and store builds in
phase B still depend on what phase A endorses.

**DNS before `.com` (decision, and a correction of this report).** The new `.com` writes no address
record for a box that registers, so deploying it before the wildcard exists leaves a new box's names
unresolvable, and resolvers cache that for 30 minutes. The order is therefore `.services`, wildcard
+ apex CAA by hand, then `.com`. The wildcard is harmless to existing accounts (their own records
keep answering until the guarded trim). My revision 1 repeated the older docs' claim that "deploying
`.com` first is safe and a no-op" (T21 Consequences, section 4.2 item 1); both were wrong for *new*
boxes and are corrected below. The docs said the same (`docs/wildcard-dns.md` s.5 and s.10, runbook
s.6a, ".services: nothing for this change") and are fixed in `eb449c357`.

**Android relay-fallback finding (R3, T12).** Public DNS gives the apex `flagship.services`
Cloudflare edge addresses (172.67.185.244, 104.21.32.109), not the relay `149.248.216.86`, so
`RelayFallbackDns` (`638bce32f`) would send the box's SNI to Cloudflare instead of the relay. The
coordinator says a fix is being made; **as of `eb449c357` no commit has touched
`apps/mobile/android/.../core/RelayFallback.kt` since `638bce32f`** [V `git log`], so it is not
fixed on `main`. I have not tested the handshake.

**Prod D1 ledger (D1).** On the coordinator's request I ran one read-only
`SELECT version FROM schema_version ORDER BY version DESC LIMIT 6` against prod D1 with
`wrangler d1 execute flagship-state --remote`: **0105, 0104, 0103, 0102, 0101, 0100** [V]. So 0104 and
0105 are applied and "0104 pending" in AGENTS was stale. The ledger says nothing about the three
peer-backup secrets or about which `.com` code is deployed [N]; I did not re-measure the live shell
version.

**Doc fixes landed (`40195ab9f`, `eb449c357`), each checked against the code or state first:**
D1 AGENTS and `final-deploy.md` s.4 now state the ledger above; D2 s.1 says Free for launch with the
upgrade signals in s.14 and Paid as the fallback; D3 s.3 says the endorsement **is** required for this
release (`bc59534d4`, `fbff4df7e`, plus `edSync.ts`/`nonceStore.ts` box paths changed after `e07f6ba7`;
`release.sh` computes the same diff); D4 AGENTS no longer says the Android lease signer is unfixed;
D5 the 248-check run is labelled as the per-account layout in the runbook and `wildcard-dns.md` s.9.4
and no longer called the gate (the gate is a fresh run on the commit to deploy); D6 s.13's not-run
list matches the 10-17/10-18 runs; D7 AGENTS: last-updated date, vitest time (~3 min), the
nonexistent `feat/share-server` branch. Also fixed: a dead reference (`wildcard-dns.md` s.11.6 ->
s.9.4). Not fixed, because out of scope for a docs-only contradiction pass: the Android relay
fallback itself, the `release.sh` test coverage of real tools, and everything in section 5 other
than D1-D7.

### 0.2 Revision 3 (2026-10-19): the Windows-round fixes, relay addresses, and the final gym

Written against `origin/main` = `eac81c0eb` (pushed 2026-10-19; baseline of this revision
`59dbc8cac`, 38 commits). Evidence tags as in section 0. This revision is newer than 0.1.

**What the Windows device test (2026-10-19) found, and what landed** (seven fix branches, merged
and pushed). Surface and deploy consequence in brackets.

| fix | surface | consequence |
|---|---|---|
| hosted VMs get a discarding UART (`-chardev null,id=ser-null -serial chardev:ser-null`); with `-serial none` the Debian kernel idled before init and never asked the phone to unlock [V: Linux QEMU pytest 13/13; Windows first boot NOT retested] | STU-W, STU-L, STU-M | [STU] |
| device pairing over the `/qr-pipe` relay, Android and iOS (shared vectors `test-vectors/device-pairing-relay.json`; web, Android and iOS tests read them) [V: Android live both ways with the web; iOS compiles and its tests pass, **no two-device run**] | AND, iOS, WEB | [iOS] [AND] |
| Home marks only the leader; backup save picker on Activity (was 0 bytes); queued biometric prompts; first-run wizard enters Home | AND, iOS, WEB | [AND] [iOS], web shell v155 |
| Studio Start works after a cancelled "Restart as administrator" [N: UAC path needs the owner] | STU-W | [STU] |
| a long marketplace manifest description is shortened, not rejected | COM | [COM] |
| web shell renumbered once to v155 (`SHELL_VERSION`, `WEB_BUILD`, pinned tests) | WEB | web deploy |
| iOS test mock data race (`MockScreensClient.bundleReads`) fixed [V: it crashed the iOS suite after the merge] | iOS tests | none |
| stale `d1-backup` test replaced by one that checks the real age recipient [V] | scripts | none |

**Relay addresses, on both phones** (`docs/relay-addresses.md`, `eac81c0eb`). Compiled-in relay
addresses used to be the only fallback when DNS could not resolve a box (and iOS had none).
Now the phone asks `.com` (`GET /api/services/endpoints`, an answer `.com` already served), keeps
the last answer, **tests each address first** (a handshake under a known box's name that must end
in the box's pinned certificate: the relay is up and authorized), and relies on the compiled-in
pair only last. No protocol, no new signed document: a signed relay hint was built and then
removed on the owner's direction (`904b512ec`). Android: `RelayFallbackDns`,
`RelayAddressCenter`, `TlsPinRelayProber`, `RelayHintFailureInterceptor` (a failed hint reads as an
unresolved name). iOS: `RelayFallback.swift`; URLSession cannot choose an address, so a loopback
CONNECT proxy (`LoopbackAddressShim`) forwards ciphertext and serves only names under the data apex.
Shared rule vectors: `apps/mobile/test-vectors/relay-addresses.json`. The webapp (browser DNS)
and the Studios (they only call `.com`) have nothing to feed. [V: Android 1,879+ unit tests, 0
failures; shared Swift suite 351 tests, 0 failures; iOS app target builds.] **Not verified on a
device: the iOS relay route through a real DNS block, and the Android handshake that the
Windows round saw closed under a DNS block (cause still unknown).** [iOS] [AND]

**Verification of the merged tree before the push** [V]: `npx tsc -b` clean; vitest 841 files and
11,017 tests passed (2 files skipped by design: Linux-only quota tests); `scripts/release-guard.test.ts`
passes 18 of 18 in a clean worktree (it never finishes in a checkout that holds stale
`.claude/worktrees/agent-*` folders); `npm run parity` 0 red.

**Final gym (2026-10-20, gym built from `main` after the endorsement `4be5aae88`)** [V by the
run's own summaries, `gym-results/live-run-2026-10-20T01-13-51-627Z` and `...T02-34-44-490Z`]:
migrate 10/10, backups 8/8, one-list 6/6, update 5/5, fleet 19/19, runtimes 10/10, archive 8/8.
The update check took a box from the previous endorsed release to `875ad977` (reported applied, 4.6
min, inside the 12 min doorbell budget). One archive check was a race in the test (a near-empty box
finishes its backup before the "busy" probe arrives, so the daemon rightly accepted a second one);
the probe now repeats the same archive and key (`19d043da6`). The `archive` group needs `runtimes` in
the same run (it expects the python app). No server or DNS record was left behind. **Not covered by
this gym:** the iOS and Android relay route under a real DNS block, anything on a device, the UAC and
Windows first-boot retests. **Watch:** the Worker tail listed `GET /api/server/:x/migration` at 114 ms
CPU and `POST /api/dev/sample-user/create` at 111 ms, far over the 10 ms Free-plan budget; neither
failed the run, and the migration read may matter for GA (`docs/runbooks/workers-cpu-budget.md`).

### 0.3 Revision 4 (2026-10-20): the principal-engineer review round

A skeptical review of revision 3 (30 commit-sized items) was read, argued with the owner, and
applied; the review document was then deleted. Where the owner's view differed from the review, the
owner's view won. Baseline of this revision `ee70cc4c1`; about 25 commits to `48275f809`. Tags as in section 0.

**Decisions.** (1) Relay addresses: no signed manifest; the relay answers "which address did you
reach me at" and the phone drops an address whose answer is not itself (an owner idea). (2) A failed
relay hint keeps its calm sentence and keeps its real reason in a log. (3) `.com` stays on the Workers
Free plan for now; a command-line tool replaces a dashboard. (4) Everything else built, with peer
backup and the notice lock gated off. (5) Migrate unchanged: it ends with the old server gone; the
careful path is the downloadable `.flagship` file (kept next to Migrate on the server page). (6) Outbound
AI calls get a host list in the database. (7) Bright teal for state borders stays (owner decision of
2026-10-17); the review calls it a contrast defect (2.3:1) and ships it as a known issue.

| Review item | What landed | Where | Evidence |
|---|---|---|---|
| Relay claim overstated (a pin proves the far end, not the first hop) | Echo on the relay (`:8444`, Fly PROXY header); phones require it of any address `.com` recommends; the compiled-in pair is exempt; an untested recommended address is never a last resort; docs corrected | `apps/web/src/lib/addressEcho.ts`, `fly.toml`, Android `RelayAddressCenter.kt`, iOS `RelayFallback.swift`, `docs/relay-addresses.md` | [V] unit tests on all three; [N] that Fly's PROXY header carries the dedicated public address: check right after the first `.services` deploy |
| Hidden real errors | `DiagnosticCode` (same codes on both apps) and a 50-entry `DiagnosticsLog`; `relay-route-unverified`, `relay-pin-mismatch` | `Diagnostics.swift`, `DiagnosticCode.kt` | [V] tests; [N] no screen shows or copies the log yet |
| iOS loopback proxy: background, port reuse, other apps | Renamed `LoopbackAddressShim`; closes on background; cap of 32 clients, 5 s to send the request, 60 s idle; **found and fixed a crash path**: invalidating a session someone is about to use is an Objective-C exception, so it is finished a minute later instead | `RelayFallback.swift`, `FlagshipApp.swift` | [V] tests incl. cap and deadline; [N] whether iOS lets another app reach the port; [N] on a device |
| CPU over 10 ms | Harness scenarios for the live migration reads; steady state is 0.06 ms of JavaScript plus 2 D1 calls, so the gym's 114 ms is a cold isolate, not the handler; the gym now fails a route that is over 10 ms in a fifth of 5+ requests, and notes single cold requests; `npm run ops -- workers` shows Cloudflare's own outcome and CPU numbers | `scripts/cpuHarness.ts`, `tools/live-e2e` | [V] harness; [N] production p99 and `exceededCpu` count: run `npm run ops -- workers --hours 72` |
| Loop-volume conversion | Copy is fingerprinted (type, mode, size, path) against the original before the old folder goes; a cut at every step ends in the old folder or the image | `loopVolumes.ts` | [V] unit tests over a fake host; [N] the real `find` fingerprint runs only in the Linux CI integration test |
| "Backup complete" is not proof | Every backup (scheduled, Back up now, and the one-off file) is read back and opened (size, hash, every frame) before it counts as ready; failure means not kept | `serverArchive/format.ts`, `service.ts` | [V] tests |
| Peer backup | The box refuses the choice (`FLAGSHIP_PEER_BACKUP=on` enables), apps stop offering it (a server already on it keeps showing it) | `backupPolicy/http.ts`, both apps | [V] tests |
| Notice lock | Release builds show the update nag only; a locked phone can still answer a boot unlock (`POST /api/secret-requests`, `POST /api/boot/response`) | `SecurityNoticeFeatures.swift`, `Variant.noticeLockEnabled()`, `UpdateLock` | [V] tests; [N] a locked phone approving a real boot |
| Routing writers | **Found and fixed a race**: two different keys registering the same new name could overwrite each other; the write now refuses to change a key; a test lists every writer | `packages/storage/src/d1.ts`, `routingWriters.test.ts` | [V] the test fails on the old code |
| Outbound AI calls (the hub opens `host:443` for a box) | Host list in D1 (seeded with the providers baked into the apps; new hosts allowed, one flag blocks), per-host totals with no user column, a hub-side check with an offline fallback to the known providers, a plain "address couldn't be reached" message, `npm run outbound-hosts` | migration **0106**, `outboundHosts.ts`, `outboundHostPolicy.ts`, `docs/outbound-hosts.md` | [V] tests; TODO recorded: a heuristic blocker if manual review gets too slow |
| A way to see what is slow or failing | `npm run ops` (health, relay counters including missed redirections, Worker numbers, live CPU tail, wildcard DNS); a 30-minute CI canary on the wildcard | `scripts/ops.ts`, `.github/workflows/dns-canary.yml`, `/api/stats` on `.services` | [V] tests; [N] the Cloudflare GraphQL field names against the live API |
| CI | iOS workflow (shared suite, app tests, release-clean); the Android every-merge gym on an emulator | `.github/workflows/ios.yml`, `android.yml` | [N] neither has run on GitHub yet |
| Release evidence | `npm run release-manifest`: 15 receipts, the files that make each stale, lease/schema/version checks; 14 receipts are MISSING today | `scripts/release-manifest.mjs`, `release/freeze-map.json` | [V] tests |
| Metadata and Preview undefined | `docs/metadata-threat-model.md`, `docs/preview-criteria.md` | | |

**Needs a deploy:** `.com` (migration 0106 first, then the Worker), `.services` (the echo port and
`/api/stats`), an endorsed box release (backup check, loop-volume check, peer gate, outbound
wording), the webapp is unchanged. Apps: new store builds for the relay echo, the lock, peer gate.

**Not done, and why.** Sample-user create made asynchronous (its 111 ms looks like a cold isolate;
measure first). A signed relay manifest (replaced by the echo). A Migrate hold or restore receipt
(owner: Migrate deletes the old server by design). Teal state borders (owner decision). Surfacing the
diagnostics log in a screen. A guard that holds `.com` enforcement until store builds are live: the
order of the admin-root enforcement against the store builds is a release decision for the owner.
Review items that are hardware or production proof stay open and are tracked by the manifest.

## 1. Scope, baselines and size

| | iOS baseline | Android baseline |
|---|---|---|
| Store commit | `b900b609b` (2026-10-08 08:27 -0500, "iOS: build on Xcode 27.1 / the iOS 27 SDK; build 4") | `fffcfb544` (2026-10-06 23:24 -0500, "Android: versionCode 8") |
| On `origin/main` ancestry | yes [V] (`git merge-base --is-ancestor`) | yes [V] |
| Commits to `9b5210992` | **1,108** [V] | **1,121** [V] (the 13 extra are 2026-10-06/07: security pages, iOS floor, Duo shell, build 3) |
| Files changed | 2,909 (+372,733 / -62,646) [V] | 2,921 (+373,944 / -63,215) [V] |

The two store builds are not one moment: Android was cut two days before iOS, and neither is
"the live state". What the stores carry: iOS 1.0 build 4 (approved 2026-10-13 [C] AGENTS);
Android `versionCode 8`, `versionName 0.0.8`, `minSdk 28` [V] (`git show
fffcfb544:apps/mobile/android/app/build.gradle.kts`). The note that the live `.com` was
"shell v114, D1 through 0103" matches AGENTS.md ("measured live on 2026-10-16 evening: shell
v114", D1 "through migration 0103") [C]. `main` is now **webapp shell v153** and migration
**0105** [V]. I did not touch production to re-measure, and `docs/runbooks/final-deploy.md`
section 4 says prod "has 0105 applied", which contradicts AGENTS.md's "0104 pending"
(section 5, "document drift").

Commits per day, author date, all commits on `main` since 2026-10-06 (1,135, so slightly
broader than the baselines): 10-06 15, 10-07 11, 10-08 29, 10-09 27, 10-10 29, 10-11 53,
10-12 88, 10-13 85, 10-14 80, **10-15 198**, **10-16 231**, 10-17 144, 10-18 145 [V]. About
half of everything landed in the last four days.

Where the lines went (`git diff --numstat b900b609b origin/main`, rounded) [V]:

| Area | files | + / - |
|---|---:|---|
| Android app (`apps/mobile/android`) | 661 | +75k / -18k |
| iOS app (`apps/mobile/ios`) | 373 | +46k / -9k |
| Shared Swift (`apps/mobile/shared`) | 152 | +20k / -2k |
| Webapp (`apps/web/public/webapp`) | 175 | +28k / -6k |
| Web unit + e2e/gym specs | 187 | +32k / -3k |
| Box daemon src / tests | 198 / 140 | +35k / -4k ; +23k / -3k |
| Protocol + vectors | 121 | +16k / -1k |
| `.com` Worker (`apps/com`) | 56 | +10k / -1k |
| Other packages (control-plane, storage, services-zone, ...) | 200 | +18k / -5k |
| Studio Mac / Windows / Linux, builder engine | 52 / 52 / 37 / 30 | +2k / +3k / +4k / +1.5k |
| `tools/` (gym, live-e2e) | 104 | +17k / -2k |
| `infra/` (inference shim, build-eval) and `billing/` | 72 and 61 | +8k and +7k |
| `docs/` | 59 | +11k |

Migrations added on `main` in this window (all additive, no down-migrations) [V `git diff
--name-status`]: 0069 `meter_counters`, 0070 `meter_batches`, 0084 `server_health`, 0085-0086
repo adapters, 0087 `server_shares`, 0095 `model_capabilities`, 0096 `server_orders`, 0097
`server_share_push`, 0098 purge plaintext auto-unlock leases, 0100 invite creator, 0101
`rate_limit_log`, 0102 invite revoke proof, 0103 `inference_settings`, **0104
`peer_backup_network`**, **0105 `re_pair_proof`**. `main` deliberately skips 0088-0094 and 0099
(they live on feature branches) [C migrations README].

Owner decisions are quoted from `docs/coordination/2026-10-16/decisions.md` on branch
`origin/wip/coordination-2026-10-16` (read with `git show`; entries dated 2026-10-16 and
2026-10-17) [V that the file says it]. That file has **no entries for 2026-10-18**; the
10-18 owner decisions I cite (0.2 Beta, root wildcard, Workers Free, other-OS installers
moved off `main`, data sovereignty parked) come from commit messages and `AGENTS.md` [C].

## 2. Executive summary

1. The window is dominated by **server-enforced admin-only authority** (add a server, add a
   device, accept a share, change ranks, debug access, env changes): rules that were
   client-side moved into `.com` and the box, with signed vectors in TS/Swift/Kotlin/web.
2. **Backups became a product**: policy at create time, scheduled archives, one `.flagship`
   file, phone copy, per-app disk limits, Migrate as "backup then restore", and a
   cross-account **peer backup** network (design + `.com` + relay + box engine).
3. **GA close-out**: prod-wipe guard, debug endpoints removed, release-clean checks for
   iOS/Android/web, per-install LUKS passphrase with a verified single key slot (and a real
   installer bug where failures looked like success), gVisor mirror, Ubuntu/netboot paths
   moved off `main`.
4. **DNS**: the 200-record Cloudflare cap forced three layouts in one day, ending at **one
   root wildcard plus one apex CAA**. It rests on a Cloudflare behaviour that is *not* RFC
   4592 (T21). The final layout was **never run on the live gym** (T21, risk R1).
5. **`.com` on the Workers Free plan**: a CPU / D1 round-trip diet with a guard test, a "box
   doorbell" that cuts box polling about 4x (needs an endorsed box release), and client
   back-off. Several things still do not fit Free (D1 backup cron, static-asset requests).
6. **UI**: Android Material 3 redesign + tablet, iOS Dynamic Type / haptics / motion polish,
   and a teal token system with unit-tested contrast. The brand teal as a graphic is
   **2.30:1 on paper, below WCAG 1.4.11's 3:1**, by owner choice (T15).
7. **Security notices + forced-update lock** (signed offline by the YubiKey), **account
   gone**, a plain-language error mapper, RCK reuse + atomic swap, the Android auto-unlock
   lease signer fix, and the Windows run's findings (appliance resize, specializer
   reporting, Studio unlock rule).
8. What I verified: full `vitest` on `9b5210992`: **832 files passed, 2 skipped; 10,913
   tests passed, 49 skipped; 0 failed** (179 s); `npx tsc -b` clean; `npm run parity` 0 red;
   a contrast recomputation; GitHub Actions status; public DNS. **Not verified by anyone**:
   any build of the iOS app from `main` on a device, any phone running these builds against
   a real account, Windows/Linux beyond the 10-18 Windows run, most box behaviour on a
   production box, peer backup end to end, the final DNS layout live.
9. The largest release risk is **ordering**: store builds, `.com`, an endorsement and a
   CA-lease renewal (due **2026-11-05**) depend on each other (section 4).
10. Several documents on `main` disagree with each other or with the code (section 5,
    "document drift").

## 3. Themes

Each theme lists: *What/why*, *Decision*, *Commits*, *Tests/gyms*, *Surfaces*, *Not
covered*, *Consequences*, *Risks*. T1-T9 are authority and data; T10-T17 user-visible
quality; T18-T24 release, infrastructure and DNS; T25 the pre-10-15 product work; T26 OS floors.

---

### T1. Admin-only: add a server, add a device

- **What/why.** Every device of an account holds the membership key (IRK), so "only admins add
  servers" was a client rule. `.com` now refuses to create a server (auth-code issue), register
  an RCK, or accept a take-over unless the account's **admin root** (or a device holding an
  admin-root-signed grant) signs, and refuses accounts with no admin root. Adding a *device* is
  also admin-only.
- **Decision.** 2026-10-16 owner: "Adding a device to the account: admin devices only;
  non-admin devices see 'Only an admin device can add devices.'"; add-server enforced by `.com`
  (bodies of `100c0c509`, `71e74bdfe`) [C].
- **Commits.** Tag `flagship/auth-code-admin/v1` + vectors `test-vectors/add-server` `100c0c509`;
  `.com` enforcement (403 `add-server-admin-only`) `71e74bdfe`; box restore order only from the
  admin root on an admin-pinned box `c1b2f98ca`; clients `d4162fe40` iOS, `fcf395e79` AND,
  `874a9f9a4` WEB; flow gates `50ab31a8e`, `a49bf9cc9`, `9a9f4a6f5`, `9c409dc29`. Device
  pairing: the webapp's join sent no device grant/profile and `.com` had refused it **since
  July** `93e8bc9b9`; vectors `e32a43c84`; iOS `831d87ec1`; AND `241c80250`; e2e tools sign with
  an admin root `fa1231738`.
- **Tests/gyms.** `packages/control-plane/tests/addServerAdminOnly.test.ts`,
  `authCodeAdminRoot.test.ts`, `scripts/admin-authority-guard.test.ts` and the CI job
  "Admin-authority guard (Slice D)" (green on `9b5210992` [V `gh run list`]); vectors read by
  TS, webapp, Swift, Kotlin; live gym groups `gating`, `real-account`.
- **Surfaces.** COM, BOX, WEB, iOS, AND.
- **Not covered.** Co-manage is intentionally *not* server-gated (a server check would unmask
  the second account) [C]. On phones, **Add a device / Join an account do not work in release
  builds** (no live `/qr-pipe` relay port): iOS `8bc0d7011`, AND `66902924b` say "isn't
  available yet"; parity row PARTIAL on both [V `npm run parity -- --report`]. Only the webapp
  can add a device.
- **Consequences.** **[iOS][AND] first**, then **[COM]**: current store builds hit the refusal
  when creating a server (AGENTS "Adding a server is admin-only"; `final-deploy.md` s.13) [C].
  **[END]** for the restore-order rule.
- **Risks.** Legacy accounts with no admin root are refused outright (`71e74bdfe`); no one has
  run "create a server on an old real account after the deploy" [N].

### T2. Share a server, co-manager invites, ranks, one list per app

- **What/why.** (a) *Share a server*: another account can view or co-manage a server, never
  destroy it. (b) *Admin-signed acceptance*: only an admin device of the **joining** account may
  accept a co-manage share, enforced by the shared box, `.com` learning nothing new. (c)
  *Co-manager invites*: a co-manager at "Can manage" invites people to the shared server's apps
  at Member and withdraws their own. (d) *Ranks*: member < manager < master; only admins change
  ranks; the box keeps the account's device book. (e) *One list per app* across the account's
  servers, distributed box to box.
- **Decision.** 2026-10-16 owner: "Co-managers can invite people at Member; demoted/removed/
  view-only co-managers can't"; "Co-manage acceptance: no blind tokens; the joining account's
  ADMIN device signs the acceptance and the owner's server verifies it against that account's
  admin root; .com learns nothing new". Owner rules in AGENTS Conventions (ranks, one list,
  per-app identity).
- **Commits.** Share v0 (10-13): spec `98f593b80`, envelopes `dcf618764`, `.com` relay
  `b82cf2459` (**0087**), box `8668f90aa`, clients `34b211360` WEB / `17af9b1ac` AND /
  `fad10f333` iOS. Family v1 (10-14): envelopes `098c2057f`, start-up push `91922d5e8`
  (**0097**), co-manager update `e9e658155`. Admin acceptance (10-16): protocol `d8461bf2d`, box
  `b9d054d53`, `.com` attestation route `7228a80ad`, WEB `ad3ca5e72`, iOS `6ba659a3a`, AND
  `a90a098cc`, live gym `ff6211c25`. Co-manager invites: envelope `ef1f70c0b`, `.com`
  `942d12ec7`, box `a07713c07`, WEB `ada5801f6`, iOS `4182ce862`, AND `0bb5b212d`, relay pinned as
  the third membership-key invite exception `6f3769ec7`. Ranks: names `412d74181`, device book
  `7a0ef8a64`, invites bound to the creating device on `.com` `5cdc69d99` (**0102**; creator
  column **0100** `9fbb946a3`), any device invites at Member `859ce48be`, joins capped at Member
  `5b39fabb5`, one Face ID per admin invite `4e8a5087d`. One list: `c0fb70691`, live check
  `12a18fd73`, leader from the account's servers `3ce20fb28`. Co-managers no longer told "you
  need an invite" on members-only apps `24ec25191`, `a8162aa51`, `20b30dde9`, `ac76e38fa`.
- **Tests/gyms.** `packages/server-daemon/tests/{coManagerInvites,inviteTiers,accessSync,
  memberRoles,shares/shares}.test.ts`; vectors `test-vectors/{co-manager-invite,
  server-share-accept-admin}` (TS/webapp/Swift/Kotlin); live gym groups `share`, `invites`,
  `gating`, `one-list`, `access-lists`; mock-gym scenarios `ios-oct-share-co-manager-*`,
  `android-oct-share-co-manager-*`, web `web-total-share-co-manager-invites` [C].
- **Surfaces.** COM, BOX, WEB, iOS, AND.
- **Not covered.** Admin-proof acceptance and the CA attestation need a **live CA lease** on the
  box (`b9d054d53`: it says "can't check" otherwise); the production lease expires
  **2026-11-05T19:31:05Z** [V `.maintainers/ca-endorsements/bundle.json`]. Cross-box gossip
  never formed live (the hub has no TLS terminator for `broadcast--<user>.<apex>` on :443)
  [C AGENTS], so leadership is now found from the account's servers `3ce20fb28`. No real-phone
  run of any of it [N].
- **Consequences.** **[COM]** (attestation route, invite tiers), **[END]**, **[iOS][AND]**;
  migrations 0087/0097/0100/0102 are in the range AGENTS records as applied/deployed.
- **Risks.** Non-admin device keys are UMK-derived, so one non-admin device's rank versus
  another's is not enforceable against a hostile device of the same person [C AGENTS]. The
  invitee names of a co-manager are sealed under a share-scoped key only that co-manager's
  devices derive (`ef1f70c0b`): an admin cannot read them [C].

### T3. Debug access v2 and signed env changes

- **What/why.** Debug access had a known password, a never-expiring IRK-signed grant, and was
  install-time only. Now `flagship/debug-access/v2`: box + one SSH key + end time (max 7 days),
  admin-signed, with a revoke order, a key-only `Match` block, a timer that closes it, and
  Activity entries. Env changes: `flagship/service-env-change/v1` names exactly one variable,
  op, value hash and a single-use nonce (a captured unset could be replayed before).
- **Decision.** 2026-10-16 owner: "GA: keep owner debug SSH, hardened (key only, admin-signed,
  expiring, revocable, visible)".
- **Commits.** Box `5c1a8d00a`; builder stops baking the key `5ad4d496b`; release guard fails
  any debug password anywhere, dev included `b431674fe`; docs `2c13b0384`, `b94dfdbfb`; WEB
  `34468d0d6`, `c70409613`, `6e200a143` (fresh unlock per grant); iOS `5f3d95260`, `79c8021b7`,
  `1829611bd`, `5d97446bf` (Keystore-only root, no gym seam in Release); AND `ba0beb6a0`,
  `6de7a5cb0`; Linux Studio drops the checkbox `47662477c`. Env: `d29b81f1d` (box, protocol,
  webapp), iOS and AND `e07bd38ae`.
- **Tests/gyms.** `packages/server-daemon/tests/debugAccessGate.test.ts`,
  `packages/protocol/tests/{debugAccess,serviceEnvChange}.test.ts`, `serviceEnv.test.ts`;
  vectors `debug-access`, `service-env-change`; web gym `39f09652e`; live gym `core` checks
  set/set/unset/refused replay `d29b81f1d`.
- **Not covered.** The debug-access gate is on AGENTS' "not validated live on a phone-created
  box" list [C]. The iOS UI-gym twin of the env change "was not re-run after its last fix" [C].
- **Consequences.** **[END]** and **[iOS][AND]** *together* (AGENTS: "Breaking for old boxes and
  builds"); **[COM]** for the shell.
- **Risks.** A debug SSH account on a production box is an intentional backdoor class; controls
  are expiry, admin signature, visibility and the release guard, not absence.

### T4. Backups: policy, scheduled, one `.flagship` file, phone copy, per-app limits, Migrate

- **What/why.** Replaces "two files and a one-off button" with: a **backup policy** chosen at
  create time (phone reserve / peer = 1/3 of the disk / none); **scheduled** archives (daily
  03:00 UTC, 7 daily + 4 weekly, within half the disk) with a key pool deposited by an admin
  device; **one `FLGSHBK1` file** (magic + u64 BE meta length + meta + data) streamed and
  resumable everywhere; **per-app disk limits** so the policy's limit holds; **Migrate** as
  "pause apps, backup, restore on the new box, take over, wipe".
- **Decisions** (decisions.md 2026-10-16): Backup and Migrate stay one-off actions while the
  policy runs separately; manual backup passcode mandatory; restore with failing apps tries
  every app then stops waiting and lists the failures; ONE file for users; Migrate v1 pauses
  apps and shows an estimated downtime first. 2026-10-17: the backup step in Create server has
  **no default** (`b87761d85`).
- **Commits.** Archive/clone + Migrate retires and wipes `72e889fdf`; two files + key slots
  `7d5a6e641`; scheduled `7f94d8207`; policy + limit `8f8e002dc`; passcode + failed-app list
  `3509450c9`; one file `14409cf52`; Migrate over the archive path `3524f5476`; per-app limits
  `f76236ece` (sparse ext4 image per files folder, ballast for lower limits, Postgres role loses
  INSERT/UPDATE at budget, 90 %/95 % brake with no policy), role limits `3c43baead`, orphan
  images `62ae43edc`, CI on real Postgres and loop images `eb144c1df`. Found live: ballast ate
  16 MiB `91ec31931`; ENOENT on a never-made folder `65617b8dc`; a stale heartbeat landed last
  `a54100d36`. Clients: WEB `76a094df2`, `76ea38429`, `9a70f24df`; AND `67e5607ec`, `e37ad7488`;
  iOS `e4c9c4e82`, `9f5287eae`; Create-flow step `b87761d85`, `6b66c3493`, `e16ba6611`.
- **Tests/gyms.** `packages/server-daemon/tests/serverArchive/*`, `backupPolicy/backupPolicy.
  test.ts`, `appQuota*.test.ts` including the `*.integration.test.ts` pair that `ci.yml` runs
  under `sudo` with a real loop device and Docker/Postgres [V `ci.yml` line 82],
  `migrationConsumer.test.ts`; vectors `server-backup`, `server-restore`; live gym groups
  `backups`, `archive`, `migrate`, `quota` (the quota group found the ballast bug, so it ran
  [C `91ec31931`]); mock gyms on all three clients.
- **Not covered.** "Not run on a real box or phone: the whole restore, docker save/load and
  pg_dump/restore (fake ops in tests)" [C AGENTS]; the live-gym groups exercise gym boxes on
  UpCloud only. Android's phone-copy WorkManager worker "not run on a device" [C]. The server's
  description is not carried; Forgejo repos and peer shards are not in a backup [C]. The
  Windows run did not cover backup import [C].
- **Consequences.** **[END]**, **[iOS][AND]**, **[COM]** (shell; the `awaitingBackup` relay shipped
  with the `3e8fef1de` deploy [C]).
- **Risks.** Per-app loop-mounted ext4 images and ballast files are the most invasive box change
  of the window: they change where every app's `/data` lives, and older plain volumes are moved
  into images "when nothing holds them" (`f76236ece`) on boxes that carry real data [C]. Studio's
  delete-server wording now says backups stored on the server die with it `06f685ce4`.

### T5. Peer backup between accounts (v2)

- **What/why.** A server on the Peer policy uses 1/3 of its disk; the other 2/3 is a pool that
  holds other accounts' encrypted 4-of-8 Reed-Solomon bricks plus `.com`-generated filler. Its
  own newest archive is spread over eight other accounts' servers; any four restore it from the
  account key alone. `.com` sees participation and capacity, never who stores for whom.
- **Decision.** 2026-10-16: "peer policy caps it at 1/3 of its disk, with cross-user blind-
  matched peer storage, random filler and storage challenges".
- **Commits.** Protocol + MDS fix `7ca3dbfe3` (the first erasure generator was **not MDS**: with
  k=4,n=8 the survivors {2,4,5,6} were singular, so a backup could be lost with four shards
  alive; Cauchy rows now, every k-of-n in use tested exhaustively), index/AEAD `79a53c408`,
  `.com` `4db2f7f88` (**0104**, RFC 9474 blind tokens), relay mailboxes `0ea6e7a5e`, box engine
  `645e6c3c7`, wired `76a3a321e`, restore into a waiting server `524b32cba`, gym secrets
  `08b1df223`, status compat `2af854e81`; clients WEB `3e9824445`, iOS `cc12850a8`, AND
  `9c6aefa20`.
- **Tests/gyms.** A ten-server simulation on the real `.com` handlers, in memory and on D1 [C
  `645e6c3c7`]; `packages/server-daemon/tests/peerNet*.test.ts`; mock-gym peer-restore scenarios
  (`bd3fac62b`). **There is no live-gym group for peer backup** [V: `tools/live-e2e/groups/`
  has none; WORKLIST D3 "later, needs an endorsed release"].
- **Not covered.** Everything over a real network between two accounts. The gym would run
  `k=1,n=1` (two accounts on one cloud, `08b1df223`), which cannot exercise the erasure path.
  v1 (`packages/server-daemon/src/peerBackup/`, `/api/peer-backup/request-peers`) is **still on
  `main`** beside v2 `peerNet/` [V `ls`, `git grep`].
- **Consequences.** **[D1:0104]** before **[COM]**; **[SEC]** `PB_TOKEN_RSA_JWK`,
  `PB_FILLER_SECRET`, `PB_TAG_SECRET` (never rotate the filler secret: every held filler brick
  stops matching; `docs/peer-backup.md` s.15); **[SVC]** (`0ea6e7a5e` is relay code); **[END]**;
  **[iOS][AND]**. Until the secrets exist the routes answer 503 [C].
- **Risks.** Sybil accounts remain the main residual risk (doc s.7). Relay egress is about 2x
  the archive per weekly generation through Fly (WORKLIST O7, owner to confirm) [C]. Token issue
  counts tell `.com` roughly how big each backup is (doc s.7).

### T6. Add/Restore server and Restore from backup

- **What/why.** One "Add/Restore server" menu (Create / Co-manage / Restore from backup) with a
  single chooser (file, other servers, this phone); a restore creates a server that waits for
  its backup. Locking the app now dismisses every sheet, menu and dialog (a real bug: they
  stayed above the lock screen on all three clients).
- **Commits.** Restore flow `7d5a6e641`; WEB `ba72ee851`, iOS `097142897`, AND `4be9a598f`; the
  menu: WEB `674debb23`, iOS `0503c5419` + `cce95838c`, AND `bbec7034b`; restored apps become the
  importing account's own `3f749b091` (before, a restore installed a cross-creator app and
  recorded an auto-update pull from `<slug>.<oldname>`, a name that is freed on account delete
  and claimable by anyone); pending-view fixes `660b21c75`, `0d31cdea7`.
- **Tests/gyms.** `servicePlatformRestore.test.ts`; mock-gym scenarios on all three; live gym
  `archive`, `backups`.
- **Not covered.** Real-phone restore [N]. "Only the creating device holds a session for the new
  box until another device pairs" [C].
- **Consequences.** **[END]** (`3f749b091`, `c1b2f98ca`), **[iOS][AND]**, **[COM]** shell.
- **Risks.** `3f749b091` closes a name-reuse takeover path and ships only with an endorsed box.

---

### T7. Security notices and the forced-update lock

- **What/why.** One maintainer-signed notice, fetched by every app from one anonymous
  `GET /api/notices` (no auth, no identifiers, no cookies), drives (A) a dismissible
  "we will update on {date}" banner and (B) a full-screen "Update required" lock, allowed
  *only* for a named security reason (advisory id + reason are in the signed bytes). Signed
  offline by the cold ca-track YubiKey with `scripts/security-notice.mjs ... --sign` (previews
  by default; refuses a lock without `--advisory` and `--security-reason`; typed phrase
  `LOCK-USERS`), verified by apps against the baked pin and the device's own clock, fail-open
  on every error, anti-rollback by `seq`, window at most 30 days.
- **Decision.** Owner request (no dated entry in decisions.md) [C `docs/security-notices.md`].
  Design deviates from the first draft on purpose (section 1 of that doc): cold authority not the
  hot CA key, added a signed `none` to retract, one `lockFrom` date.
- **Commits.** Envelope + vectors `11259f3eb`; tool `285f93d43`; route `b83975cf0`
  (committed notice is `null` [V `.maintainers/notices/current.json`]); refuse an unsatisfiable
  minimum `7266fdced`; WEB `2bfc161d8` (shell v144), gym `d9e0b7d10`; iOS `1c5c02ebd`; AND
  `d1cdfe47b`; docs `0326c2162`.
- **Tests/gyms.** `apps/com/test/securityNotices.test.ts` (10 tests, pass [V]); shared vectors
  `packages/protocol/test-vectors/security-notice/vectors.json` read by TS (`securityNoticeVectors.
  test.ts`, pass [V]), webapp, Swift (`SecurityNoticeVectorTests`), Kotlin
  (`SecurityNoticeVectorsTest`); mock gyms `gym-notices.spec.ts`, `GymNoticeTests.swift`,
  `GymNoticesTest.kt`.
- **Surfaces.** COM, WEB, iOS, AND.
- **Not covered.** No notice has ever been signed or served; the YubiKey path with `--sign` has
  not been run by anyone [C "nothing is signed"]. The version-window rule for protocol changes is
  "a design only" (doc s.7) [C]. Current store builds (iOS 4, Android 8) contain **no notice
  client**, so a notice can neither inform nor lock them.
- **Consequences.** **[COM]** (route + shell v144+), **[iOS][AND]**, **[OWN]** to sign a notice
  (needed for the pre-GA maintenance announcement, `final-deploy.md` s.12).
- **Risks (from the doc's own "honest weak spots", all [C])**: a lock is *not* a boundary
  against a hostile `.com` (it can suppress); **a locked phone cannot approve a boot unlock**
  (the lock refuses signing), so a server that reboots while its phone is locked waits until the
  person updates; one notice at a time (a newer `seq` replaces a lock in force); the clock is
  trusted; poll lag up to a deploy + 15 minutes. A wrongly signed lock is capped at 30 days and
  retracted only by another YubiKey signature + `.com` deploy.

### T8. Account gone, and account delete

- **What/why.** After a reset or the pre-GA wipe, a signed-in device used to see 401/403/empty
  200s. Every own-account route on `.com` now answers one stable `404 {code:
  "account-not-found"}` before any auth check; clients show a full-screen "This account was
  removed" (Create a new account / Remove it from this device), stop polling, forget the stored
  account, and **warn before anything discards the device's admin key** (Settings Sign out and
  Remove this device included). Separately, account delete said "Another device is still on this
  account" on **every fresh account** because the last-device check counted the founding device's
  own grant.
- **Decision.** The rescue/"Save my servers' data" button was parked with data sovereignty
  (owner 2026-10-18 [C `3f3d7c153`, `106e46405`]); the screen now says a saved backup can be
  restored into a new account.
- **Commits.** `.com` `3270d3c4e`; WEB `2feca4388` (shell v145), warn-first `98bfd741d` (v146);
  gym + parity + contract `5ee4c58d8`; iOS `b826fcdfc`, `ca0e1c94e`; AND `29c224cdc`; copy
  `106e46405`. Delete: `d1a1ec4b5` (counts live device rows minus the caller; 403
  `other-devices-remain` with a sentence), clients `9abdadb27`, gyms `5edf9d5c0`, record
  `767d5adbb`.
- **Tests/gyms.** `apps/com/test/accountGoneRoutes.test.ts` (11, pass [V]),
  `apps/web/tests/webappAccountGone.test.ts`, `AccountGoneTest.kt`, `GymAccountGoneTests.swift`,
  `GymAccountGoneTest.kt`, `gym-gone.spec.ts`; `accountDeletion.test.ts`.
- **Not covered.** Nobody has run it on a device against a wiped prod account [N]. 404s are
  metered on the `account-resolve` budget so it is also an account-existence oracle by design
  (existence is already revealed by `account/resolve` [C `3270d3c4e`]).
- **Consequences.** **[COM]** (+ shell), **[iOS][AND]**. Without new store builds the current
  builds show their generic refusal line for the new delete body [C AGENTS].
- **Risks.** Demo accounts count as existing "unless they are being cleaned up"; a wiped-then-
  reregistered name would present as a *different* account to a stale device (the screen is
  keyed on 404, not identity) [N - not analysed].

### T9. RCK reuse and the atomic swap

- **What/why.** Every mint made a new random routing key and `.com` pins a name to the first RCK
  it sees, so a retry, a dropped builder socket or a second tap got 409 "subdomain already
  controlled by a different RCK" and orphaned the first registration. Phones now keep the
  pending order's public RCK per name for 24 h and reuse it; `.com` also lets the **same
  account** replace the RCK of a name **no box has activated yet** (routing target empty).
- **Commits.** `1b656fd24` (AND store + `.com` rule); review + race fix `39952ebac` (read-then-
  release-then-register became **one conditional UPDATE** in D1 and in memory: own record, empty
  target, different key); WEB `d3874827e`; iOS `f2e6d29c7`.
- **Tests/gyms.** `packages/control-plane/tests/routing.test.ts`, `serverRelease.test.ts`,
  `packages/storage/tests/parity.test.ts` (D1/in-memory parity over real SQLite),
  `CreateServerRckReuseTest.kt`, `PendingRckStoreTests.swift`, `webappPendingRck.test.ts`
  (pass [V]); cross-account and IRK-refused cases tested "both ways" [C `39952ebac`].
- **Not covered.** Live gym has no retry-after-409 check [N]. Accepted residual: a signed register
  order replayed inside its 5-minute freshness window can flip the key back to an earlier one the
  same admin signed (needs a captured TLS request, yields no key) [C `39952ebac`].
- **Consequences.** **[COM]**; **[iOS][AND]** for the reuse; none for D1.
- **Risks.** This relaxes an invariant ("a name keeps its first RCK") in the identity layer; the
  guarding conditions are admin authority and "target empty". Anything that sets a target
  without going through `SetRoutingTarget` would break the assumption (the reviewer's own list
  in `39952ebac` says cert issuance, hub and transfer do not read the RCK) [C].

### T10. One plain-language error mapper

- **What/why.** Android showed "connection closed", "HTTP 503: error code: 1102"; iOS had about
  115 sites putting `localizedDescription` (Foundation's NSURLErrorDomain wording) on screen.
  `UserErrorText` (AND `cc682dff2`, iOS `3224b1f9a`) maps a throwable to a sentence: dropped
  connections, timeouts, unknown host, 5xx and Cloudflare codes become plain words; a box's
  own sentence is shown when it sent one; a known `.com` reason is shown otherwise; the real
  error stays in the log. Cancel order and "Setup stopped" gained a reason and a next step with
  shell line numbers stripped (AND `3ead3f4c5`, iOS `7bb408fb3`, WEB `d3874827e`). Home header
  names persist and Add/Restore ignores taps for 450 ms after a layout change (AND `66902924b`,
  iOS `ab76d83da`).
- **Decision.** Standing owner brief "clients show the box's own sentence, never a generic one"
  (fixer-brief) [C].
- **Tests/gyms.** `UserErrorTextTest.kt`, `UserErrorTextTests.swift`, `CancelPendingOrderTest.kt`
  / `CancelPendingOrderTests.swift`; gym scenarios for failing then working cancel and a stopped
  install [C].
- **Not covered.** The **webapp has no equivalent mapper** (it was patched screen by screen) [N
  not audited]. Mapper coverage is by call-site migration (~50 AND, ~115 iOS), so a new
  `t.message` site silently regresses; the Android commit adds no lint rule [V by reading
  `cc682dff2`'s stat: no lint file].
- **Consequences.** **[iOS][AND]**.

### T11. Activity: accordions and inline approvals

- **What/why.** Activity was three long cards plus a separate audit-log page. Sections now roll
  open in place (one at a time, bounded inner scroll), account events page in with Load more,
  the server section is named, every row shows date and time, ~20 more server events have plain
  titles. Server approvals are listed and answered **inside** their section (count badge, empty
  state, "Try again", a 409 "already answered" counts as done).
- **Decision.** 2026-10-17 owner: "iOS UX changes are ported in spirit to Android" (decisions.md);
  the iOS version was done first by the coordinator (`2831550a4`).
- **Commits.** iOS `2831550a4`, `ce8152a4c`; AND `4bd9c5678`, `895775419` (list/detail on
  expanded windows), `458efc2f7`; WEB `4286b8c24` (shell v150).
- **Tests/gyms.** `ActivityAccordionTest.kt`, `gym-activity.spec.ts`, iOS gym `9296d15f0`; live
  gym `activity` group.
- **Process note.** The iOS commit `e4c9c4e82` (100 files) was built from a stale tree and
  **silently reverted** this redesign and other landed work; repaired by `080522ff6` and
  `568bd5218` [C REPORT part 3]. Nothing automated prevents a repeat (only a brief rule).
- **Consequences.** **[iOS][AND]**, **[COM]** shell.

### T12. Offline server page

- **What/why.** An offline banner read "Offline - last seen ..." over a paragraph and an empty
  Monitoring section. Now one sentence, "This server has gone offline." with "Check again"
  (button on web, pull-to-refresh on iOS/Android), Monitoring hidden until a re-check finds it
  online. Same wave: a box name the phone cannot resolve (home routers cache NXDOMAIN for the
  zone's 1800 s SOA minimum) must not read as "Couldn't reach the server".
- **Commits.** WEB `e33cc651c` (v149), AND `d8aff34fd`, iOS `f533f3c9b`; DNS handling AND
  `638bce32f` (`RelayFallbackDns` + `DnsRetryInterceptor`), iOS `668281523` (retry 0.5/1.5/3 s).
- **Not covered / defect candidate.** `RelayFallbackDns` falls back to "the addresses of the
  apex, the relay that carries every box's :443 traffic". **Public DNS today resolves the apex
  `flagship.services` to Cloudflare edge addresses (172.67.185.244, 104.21.32.109; AAAA
  2606:4700:...), not to the relay `149.248.216.86` that `wrangler.toml`
  (`SERVICES_PASSTHROUGH_IPV4`) and the wildcard doc name** [V `dig`, `grep`]. The apex is
  Cloudflare-proxied (the wildcard doc says so). So the fallback would connect to Cloudflare's
  edge with the box's SNI, not to the relay; I expect a TLS failure, not a connection to the
  box [inference, not tested]. The commit says "not checked against a live box" [C `638bce32f`].
  With the root wildcard live, a *fresh* lookup resolves directly and the fallback matters only for
  names already negative-cached.
- **Consequences.** **[iOS][AND]**, **[COM]** shell.

### T13. Android Material 3 redesign, polish, tablet

- **What/why.** Owner: native Material 3 look, each page organised like iOS with an Android
  feel, no emoji icons (decisions.md 2026-10-16). Large surgery: theme tokens + `FSScreen`
  (slice 1 `392f5737a`), shared components, IME padding, top toasts `db82e8bf7`, Home
  `e3d575233`, services/settings/server page merged over admin gating `4d039c9a6`, build
  mode/peer backup/import `8208c0cf4`. Polish: compact bar, tonal cards, shared-axis motion
  `cd5adc6c3`; predictive back, haptics, tablet-aligned bar `e69a221fe`; list/detail Activity and
  rail on medium windows `895775419`; 200 % text holds `025fb8c92`; soft danger buttons, Try
  again on every load error, focus ring on switches `7d85e2d4b`; every inline `fontSize` now reads
  the type scale `c4c7cb7b7`; iOS second-pass port `3b97b2bd3`.
- **Tests/gyms.** Android CI (unit tests + debug APK + **release APK incl. Wear + release-clean
  script**) green on `73835be87` [V `gh`]; `TokensTest.kt`; a source test requires a
  `contentDescription` on every `IconButton` (`7d85e2d4b`); ~24 `androidTest` gym files; the gym
  sweep `859e327ac`..`529dc5012`.
- **Not covered.** Instrumented (emulator) gyms are **not** in CI; they were run by agents [C].
  No device review of the redesign by the owner is recorded [N]. Wear OS app "not yet run on a
  device or watch" [C AGENTS].
- **Consequences.** **[AND]**. Floors changed (T26).
- **Risks.** The slices were first built on a branch that "never compiled" and later merged by
  hand over parallel edits (`e3d575233` "merged by hand"); a regression of main's admin gating or
  storage UI would pass unit tests. CI compiles it, which is the only guarantee.

### T14. iOS polish: Dynamic Type, haptics, motion

- **What/why.** Every `FS` font and raw `.system(size:)` mapped to a text style so text follows
  the reader's size (807 + 268 call sites previously ignored it [C REPORT part 3]); continuous
  corners, spring press states, 44 pt targets, haptics on toasts/chips/accordions/hold-to-
  confirm, sentence-case section labels, tinted tile Activity rows (`7ef9052ab`); segmented
  appearance control, soft danger buttons, status colours table, adaptive announcement card
  `01a003129`; loading pulse, retry on load errors, spring list changes `8ac8a3939`, `a5aa8a6c9`;
  rules tests `e044a6b5c`; second pass (split-view shell tried and reverted for the iPad:
  `26a8ea1db` ... `ec012c31e` "the iPad shell stays hand-composed"), chat bubbles, one text
  input look, native Settings List.
- **Tests/gyms.** `PolishRulesTests.swift`, `ThemeTokensTests.swift` (4.5:1 on every surface and
  wash), iOS gym `16918ea9b`, `33f1b0f94`. Several commits are labelled "(wip)" in their subject
  (`26a8ea1db`, `1f1abcbbc`, `f163c6968`, `ac2e523ea`, `42dbe78dd`) but are on `main`.
- **Not covered.** **There is no iOS CI workflow** [V `ls .github/workflows`]. Whether `main`
  builds and passes on iOS at `9b5210992` is recorded only in agent commit bodies, not in a
  machine-checked place; I did **not** build iOS [N]. "Not built for a device or run on a real
  box" for the backups client [C AGENTS].
- **Consequences.** **[iOS]**.

### T15. The teal / contrast token system (webapp, site, iOS, Android)

- **Story (it changed four times in 24 h).** 10-15 darkened the brand teal everywhere
  (`fc75d3bed`, `8adbdfcfd`, `a74a7d6ce`); 10-17 split it into text / graphic / fill roles
  (`dd258fb83`), deepened the graphic teal to `#0E9488` to hold 3:1 (`f06df49f3`, iOS
  `098052168`), then the owner reversed: **brand teal is the light `#14B8A6`**, apps adopt it
  (decisions.md 2026-10-17; web `aa15f6970`, iOS `e16ba6611`, AND `67deef92c`), deep `#0F766E`
  only for inline teal text links, labels/headers ink with a bright-teal marker; focus rings get
  an ink inner ring (`e47e99f8a`, AND `ff56f5ce6`).
- **Measured contrast** (I recomputed WCAG ratios from the committed hex values [V]; the web
  test `themeContrast.test.ts` (36 tests) passes [V]):

  | pair (light theme) | ratio | note |
  |---|---:|---|
  | brand teal `#14B8A6` on canvas `#F7F6F2` | **2.30** | graphic only; below WCAG 1.4.11 (3:1) |
  | same on white / on sunken `#EFEDE7` / canvas-2 `#F0EEE8` | 2.49 / **2.13** / 2.15 | iOS test floors: 2.3 paper, 2.1 sunken |
  | ink `#0A0A09` on teal fill | 7.96 | button label |
  | `--accent` `#0F766E` on canvas / sunken | 5.06 / 4.68 | inline links only (>=4.5) |
  | ok `#166534`, warn `#944D05`, err `#B91C1C` on canvas | 6.59, 5.84, 5.98 | status text >=4.5 on every surface and wash |
  | the rejected `#0F9B8E` on canvas / sunken | 3.18 / 2.94 | why `f06df49f3` moved to `#0E9488` (3.46 / 3.20) |

  Dark theme uses `#2DD4BF` for text and graphics (the tests demand >=3 on dark surfaces).
- **Decision.** Owner 2026-10-17 (twice, the later overriding the first): bright light teal;
  Material/Apple defaults not used for brand colour. The coordinator records the trade-off:
  "bright teal graphics are 2.3:1 on paper (below WCAG 1.4.11's 3:1), accepted for labelled/
  decorative graphics and enforced by tests (icon-only controls must carry labels)" [C REPORT
  part 3, section 16.5]. The web test also scans for teal text outside link selectors and for
  icon-only controls without `aria-label`.
- **Gaps.** iOS and Android assert the same floors in `ThemeTokensTests.swift` / `TokensTest.kt`
  but those are not in an iOS CI job; the site (`tokens.css`) and webapp share tokens, the
  Android/iOS values are hand-copied hex [V `Theme.swift`, `Tokens.kt`]. The 2.3:1 teal is also
  used for **state borders and selected-tab markers**, which are information-bearing UI
  components under 1.4.11 [N not audited]. Dark-theme ratios were not recomputed by me.
- **Consequences.** **[COM]** (site + webapp shell, last shell bump for tokens v141), **[iOS][AND]**.

### T16. One product version, 0.2 Beta

- **What/why.** The owner wants the website, apps and Studios to say the same version.
  `release/version.json` (`product 0.2`, `label Beta`, `iosVersion 1.1`, `iosBuild 5`,
  `androidVersionCode 9`, `studio 0.2.0`) is the single source; `scripts/check-versions.mjs`
  fails on drift and is part of `npm run parity`; `--write` syncs generated surfaces (Xcode
  project, Gradle reads the JSON, Mac `Info.plist` stamped at package time, Studio workflow
  takes its version from the file). About reads "Flagship 0.2 Beta (iOS 1.1, build 5)" /
  "(build 9)".
- **Commits.** `8062a7dcc` (shell v152), gyms `cdbb20337`, Mac Studio core `ace25c6d4`.
- **Tests.** `scripts/check-versions.test.ts` (13, pass [V]), `ProductVersionTests.swift`,
  `webappProductVersion.test.ts`, About pinned in the three gyms; parity "one product version"
  check 0 red [V].
- **Hazards.** Versions are guesses about the stores: iOS 1.1 build 5 must be above anything
  uploaded; Android `versionCode 9` must be above the highest in Play's App bundle explorer
  ("version codes are burned by any upload") [C AGENTS]. The Wear app is `1_000_000 + 9`.
- **Consequences.** **[iOS][AND][STU]**, **[COM]** (site badge + shell).

### T17. No mocks, no developer mode in Release (iOS, Android, webapp)

- **What/why.** Owner: "Release builds contain no mock data and no developer mode (mocks live
  in debug/gym only)" (decisions.md). Android: every mock client / fixture / gym seam moved to
  `src/debug`, main reaches debug-only bits through a `Variant` object that `src/release` defines
  as "nothing", Developer mode removed everywhere, a brand-new live account no longer lists the
  demo box's Plants, Wiki and Scratchpad (`aa3fb7687`, `66b06a861`); iOS `#if DEBUG` over every
  Mock*/Gym* type (`f22a97819`), `scripts/ios-release-clean.mjs` (source scan + `--build` +
  `strings` over every Mach-O) `8e492cc72`; webapp `?debug=1`, Developer section, "Send order
  (debug)" gone (`f9553c09b`, shell v124); plain-vitest scan of webapp, site, Android main source
  sets and `.com`'s `/api/dev` surface `1f4e299fa`; the public `/dev/create-server` phone simulator
  deleted `1f4e299fa`.
- **Real bugs this surfaced.** Android create-server crashed on every fresh real account:
  `Keystore.irkPubHex()` read an unversioned slot `deriveIRK` never wrote (NPE) `1764bb9d5`
  (2 tests fail on old code, pass on new [C]); Android recipes omitted default-valued fields
  (kotlinx `encodeDefaults=false`) so the preseed engine rejected every Android recipe
  ("InstallBlob fields incomplete") `a62f73b2b` - **Burn to USB from Android had never
  worked** (verified only on a local seed, see T18 and risk R9).
- **Tests.** `scripts/release-clean-sources.test.ts` (7, pass [V]), `scripts/ios-release-clean.
  test.ts`, Android CI step `check-release-clean.sh` (green on `73835be87` [V]),
  `webappShipsNoDevTools.test.ts`.
- **Not covered.** iOS `--build` Release scan is not in CI [V no iOS workflow]; `scripts/ready`
  checks it only with `--native` (`7f84dd0ec`). Demo accounts intentionally remain (they are
  real `.com` accounts). Open: Studio's `FLAGSHIP_CONTROL_INSECURE` (Windows pairing over plain
  ws) and the box's `FLAGSHIP_MAINTAINER_PIN_OVERRIDE` seam are env-only and root-gated, left for
  the owner [C AGENTS]. Add a device / Join an account refuse in Release until the relay exists
  (T1).
- **Consequences.** **[iOS][AND][COM]**.

---

### T18. GA close-out (owner-approved, "after the gym's bugs are fixed")

- **What/why.** AGENTS "GA close-out" list, worked down on 10-17/10-18. Owner rule: demo
  accounts stay (they are real `.com` accounts). Item numbers below are AGENTS' list.
- **1. Prod-wipe guard.** The runner defaulted to prod; `WIPE_ENV` and `WIPE_D1` are now required
  and must agree, and a prod wipe needs a person at a terminal typing the database name
  (`8c97a2396`); keep-list preview and scoped deletes `6639d00f1` (the owner chose "keep only
  `playstore-test-0725`" `ca68985e3`); the gym D1 is no longer zeroed between runs `3dd0eb745`.
  Tooling deletion is ready on branch `origin/chore/delete-wipe-tooling` (`60924d5bd`),
  deliberately not on `main`. **The scrub itself has not run** [C AGENTS "Still to run"].
- **2. Burn-time LUKS passphrase.** The old constant `flagship-build-time-luks-rekey-me-
  immediately` was public in the preseed and the bootstrap's removal sat behind `if false`.
  Now a random 48-char passphrase per install is generated inside d-i, handed to partman-crypto,
  and removed by the bootstrap, which **fails the install unless exactly one key slot remains**
  and the removed key no longer opens the disk (`09efc52a5`, design `c5bd5f9d7`, doc
  `docs/luks-burn-passphrase-removal.md`). Proved in a real debian-installer run in QEMU
  (`tools/luks-di-qemu`) [C], and then on a real UpCloud server (`199cb1688`, lane
  `tools/live-e2e/lanes/luks-burn.ts`) [C], which also found two ISO boot bugs (BIOS boots
  landed in the speech installer without the preseed; apt hung on the CD source).
  **The QEMU run exposed an installer bug of the "failure looks like success" class**: the
  `late_command` ended `A && B && beacon || true || ( exit 1 )`, whose `|| true` swallowed every
  failure, so a failed install powered off exactly like a good one; d-i does not stop on a failed
  late_command in the text or newt frontend either. A failed bootstrap now prints
  `*** FLAGSHIP INSTALL FAILED ***` and holds [C `09efc52a5`].
  Tests: `packages/flagship-builder/tests/luksSingleSlot.test.ts` (12, runs the real shell under
  bash with a stub `cryptsetup`, pass [V]), `preseed/userdata/appliance` tests,
  `scripts/release-guard.test.ts` (18, pass [V], including `RELEASE=1` against the real repo).
  **Existing installed boxes keep the old public slot until reburned** (owner decision "not
  scrubbed, they age out") [C].
- **3. Dev flips** - see T17. **5. Debug endpoints** (late-log, Hetzner rescue/destroy/server-
  info, upload-iso, every installer log upload) removed `8cd2a58cd`; installer logs admin-read-
  only and bounded `04176c300`; a cron prune stays until 2026-10-31. **gVisor mirror**: boxes try
  `FLAGSHIP_GVISOR_MIRRORS`, then their own control plane's `/build/iso/`, then upstream,
  SHA-512 pin decides every source (`2889522e3`: storage.googleapis.com answered 403 to
  UpCloud's ranges, so a gym box could never start an app); retry after 30 s not 10 min
  `711e8baaa`. **Ubuntu autoinstall + Debian-netboot** removed from `main` (`51573c911`) to
  `origin/feat/other-os-installers` (73 commits behind `main` [V], "UNTESTED" per its README
  [C]).
- **Not done.** Item 6 (quiet the console) and item 4 (`pro.html` placeholders, branch) remain.
  `FLAGSHIP_CONTROL_INSECURE` and `FLAGSHIP_MAINTAINER_PIN_OVERRIDE` seams left for the owner.
- **Consequences.** **[COM]** (W12 endpoints, simulator page), **[END]** (installer log removal,
  gVisor mirror, bootstrap), **[STU][APP]** (new Studio/phone builds and republished appliances
  carry the verified key removal), **[OWN]**: upload gVisor bundles to R2
  (`scripts/publish-gvisor-mirror.sh`), run the scrub and the reap, merge the wipe-tooling
  deletion.
- **Risks.** The scrub is irreversible except from the 6-hourly R2 D1 dump, **which cannot run on
  the Workers Free plan** (T23); take a manual `wrangler d1 export` first (`final-deploy.md`
  s.12). The Android phone-USB-burn feature is not on `main` (branch `feat/phone-usb-burn`);
  the Android recipe encoding bug fixed in `a62f73b2b` also broke Studio: it parses the same install blob, so an Android-made recipe was rejected there too (T17).

### T19. Windows run and Studio findings

- **What/why.** First run of the released Windows Studio on real hardware (Windows 11, i5-14400F,
  WHPX, against prod, throwaway account) by a "Windows agent" on branch
  `device-results/windows-2026-10-17` [C AGENTS]. Verified passes there [C]: pairing a phone with
  Studio, hosting from the prebuilt appliance, first boot to sealed boot, phone approval, Online
  + Leader, Health, HTTPS 200 with valid TLS (resolved by `--resolve`), sleep inhibit, graceful
  Stop. `.NET` tests 269/269; vitest on Windows: 92 files / 554 tests fail for host reasons
  (directory fsync EPERM, CRLF, POSIX-only tests) [C REPORT part 4].
- **Fixed on `main` from it.**
  - Appliance first-boot **resize with the build key**: on amd64 the specializer died at
    "Expanding the disk" ("Nothing to read on input", `cryptsetup resize` wanted a passphrase on
    stdin) so **every hosted VM stopped at its login prompt** `73562538e`; the 2026-10-13 published
    amd64 appliance has this bug [C AGENTS].
  - **Specializer reports the bootstrap's own failure** instead of dying on an ERR trap
    (`set +e` does not stop it) `baf464184`; owner-facing text names the step, not a shell
    line `68e551cc3`.
  - **Tar race**: GNU tar exits 1 when a file under `/var/lib/apt` changes mid-read; with
    `pipefail` that failed the arm64 appliance build (`35e207cda`, cherry-picked). Runs on the
    fix: arm64 `39158345483` and amd64 `39160505562` are **green** [V `gh run view`].
  - **`FLAGSHIP_CONTROL_HOST`**: Studio Windows/Linux/Mac and the builder CLI hard-coded
    `flagshipserver.com` for install status, health and the seed's boot worker, so a Studio
    pointed at the gym sealed a disk that asked *prod* for its unlock `968a8a594`,
    `6567b6e14`, `7fb0eea4a`, `210b9feb2`, `d4c7ef4c0`.
  - **Unlock from the health report, not the name**: Studio fetched
    `https://<server domain>/` before the box registered, home routers cached the NXDOMAIN for
    the SOA minimum (1800 s), and a healthy box showed "taking longer than expected" for ~30
    minutes; all three Studios now accept the box's signed order-health report (daemon active,
    tunnel up, received after this boot began) `02107c89e`; the sealed-guest copy no longer says
    "Nothing to approve".
  - **Low-memory message** (W-1): "Not enough free memory: this server needs 4 GiB. Close other
    apps and try again." and only QEMU's last real stderr line is shown `63ed5cd12`.
  - LF line endings pinned (`eb08dcdc4`), Windows test agent runbook `301c44c86`.
- **Tests/gyms.** Shared `vm-core-vectors.json` (`bootEvidence`, `qemuFailure`,
  `awaitingUnlockCopy`) pinned in Swift, C#, Python; CI jobs "builder-windows (.NET tests + WPF
  publish)" and "builder-linux (pytest + render smoke)" **green on `ace25c6d4`** [V `gh`]; Mac
  Studio `swift test` 17 pass [C `d4c7ef4c0`]; there is no Mac CI job.
- **Not covered.** Linux Studio has never run on a real Linux desktop; Windows: installer-ISO
  fallback, USB burn + metal boot, webapp + Remote walks, backup import, Restart as administrator,
  the *published* (not CI) appliance, and all Android fixes landed after `eb08dcdc4` [C AGENTS].
  The AGENTS paragraph listed the auto-unlock lease as "not yet fixed" although `64df9098c` fixed
  it (T20); corrected in `40195ab9f`.
- **Consequences.** **[STU]** (all three; version 0.2.0 via `studio-release.yml`, then update
  `INSTALLER_DOWNLOADS` in `apps/com/src/route.ts` and **[COM]**), **[APP]** (rebuild and publish
  both arches: until then "Host on this PC" stalls on every Studio, AGENTS), **[OWN]** publish
  to R2 with `scripts/publish-vm-appliance.sh <run-id>...`.
- **Risks.** The first-boot update of a fresh appliance (`firstBootUpdate.ts`) installs "the
  newest endorsed descendant" with no phone consent (owner: the release signature is the
  consent) [C AGENTS]; a bad endorsement therefore reaches every new server before its owner sees
  it, bounded by the box's health-gate rollback.

### T20. Android auto-unlock lease signer bug (found by the Windows run)

- **What/why.** "Restart always asks the phone." `depositAutoUnlockLease` signed the lease body
  with `orderKey ?: material.signer`, i.e. the **admin root** on any device that holds one (a
  real account's normal case); the boot worker (`packages/boot-core/src/routes.ts`
  `handleDepositLease`) and `.com` verify against the **owner IRK**, so the PUT answered 403
  "invalid lease signature" *after* the unlock reply was already posted: the box unlocked once,
  no lease was ever stored, every restart asked again, and the app surfaced "Approval failed:
  HTTP ..." with the card left up (a second tap got 409 already answered).
- **Fix.** `64df9098c`: sign with `material.signer` (the IRK); a failed deposit no longer fails an
  already-answered approval; retried three times and kept (`PendingLeaseStore`) for the next
  approvals load; the approvals section says "Approved. Automatic unlock couldn't be set up yet;
  it will try again."; the approve card keeps the lease id for the kill switch.
- **Tests.** New shared vector `packages/protocol/test-vectors/auto-unlock-lease` (canonical
  bytes + the IRK and admin-root signatures) read by TS (pass [V]), Kotlin, Swift and the
  webapp; boot-core refuses a root-signed lease with 403; the mock mailbox now applies the worker's
  rules; a gym approves a boot on an admin-root device and checks the lease was stored and the
  next boot self-unlocks [C].
- **Related earlier fix.** The webapp deposits the lease box-sealed (v2) `61bdc8058`; `.com`
  stops accepting plaintext leases `dd4bd383f`; migration 0098 purges stored ones.
- **Consequences.** **[AND]** only (client code; **Play `versionCode 8` has the bug**, so the
  fix has no effect until a new Android store build) [C `64df9098c`, `final-deploy.md` s.11].
- **Risks.** The vector was added *after* the bug shipped; the other clients' signer choice is
  asserted by reading (iOS `lease.sign(with: irk)`), not by a cross-client live check [C].

### T21. DNS: from 12 records per account to one root wildcard

**Why.** The `flagship.services` zone is capped at 200 records on Cloudflare Free (and the SOA
negative-cache time is fixed at 1800 s: `flagship.services. 1800 IN SOA ...` measured
2026-10-18 against `jade.ns.cloudflare.com` [C `docs/wildcard-dns.md`]). Prod held ~154, ~70 of
them leftovers; at ~12 per account only ~3-4 more accounts fit; when full, new boxes (prod and
gym) never got DNS-01 records or a certificate (two gym runs went red) [C AGENTS].

**History in one day (2026-10-18)** [V by `git log`; layout descriptions C]:

| step | commits | records per account with one server |
|---|---|---|
| until 10-18: per box | (pre-window) | **12** = `8 + 4 x servers`: 6 CAA at `<user>` and `*.<user>`, `*.<user>` A+AAAA, pair at `<server>.<user>` and `*.<server>.<user>` |
| assessed | `9973c179c` "assess one wildcard set per account before building it" | - |
| per account (built, minimal CAA set `ff4638a5c`, `7c662b188`, shield + tests `9375eb562`, reap `ab4d52a02`, relay hold `1ddccb2b9`, gym checks `488f99380`, `545b7bd1b`) | `ff4638a5c`..`545b7bd1b` | **4** (`*.<user>` A+AAAA, 2 CAA) + a "challenge shield" that wrote A/AAAA beside each ACME TXT |
| measured, shield off | `690ecd556` (probe), `2963833d7` (shield default off) | 4 |
| **root wildcard (final)** | `272ce0c7d`, `41f4f3925` (reap trims everything at an account/box name), `2abaffcad` (zone-health), `257755719`, `2bb59f878` (hourly sweep opt-in), `d85785702` (broker refuses per-box A), `22f84838e` (shield deleted), `718fbcbde` (safe deletion order), `1c6bda507` (measured) | **0**: the zone holds `*.flagship.services` A+AAAA at the relay (DNS only) and one apex CAA pair; ~4 records at rest, 2 TXT per certificate in flight |

**Measured Cloudflare behaviour** (gym zone `gym.flagship.services`, queried at both
authoritative servers `jade`/`mario` with no recursion plus 1.1.1.1 and 8.8.8.8) [C
`docs/wildcard-dns.md` s.3, s.9; I did **not** repeat these]:

- A record **owned by** a name `N` (A, TXT or CAA) blocks the zone wildcard for everything *below*
  `N` (NXDOMAIN) and answers NODATA for `N`'s other types; siblings and parents are unaffected.
- **Empty non-terminals are NOT applied**: a TXT only at `_acme-challenge.home.alice` leaves
  `home.alice`, `x.home.alice` and every sibling answering from the wildcard. **RFC 4592 says the
  opposite** (a name with any record below it exists and blocks the wildcard). The layout depends
  on this.
- A CAA at `<user>` only makes `<user>` A answer NODATA and its siblings NXDOMAIN (matrix row 7), which is why the CAA lives
  only at the apex.
- **The shield was measured harmful and removed.** With shield on, a random label under the box
  answered NXDOMAIN at jade, 1.1.1.1 and 8.8.8.8 for **5.1 s** during a real issuance (the shield's
  literal A at the box name reached the name servers before its `*.<box>` sibling) - a 5 s window
  that resolvers cache for 30 min. A TXT alone blocks nothing, so the shield code, its switch and
  tests were deleted (`22f84838e`).
- Propagation between the two name servers is uneven: a new record reached jade 3-8 s after it
  reached mario (20-30 ms); deletes flap for up to ~14 s. Legacy deletion order is therefore
  fixed (CAA at `<user>` first, account wildcard last) and the reap CLI waits 15 s between groups
  `718fbcbde`; measured on the gym: 6 back-to-back runs, one 0.1 s NXDOMAIN flicker, residual
  risk "once, for a legacy account, when it first registers a box after the deploy" `1c6bda507`.
- Post-removal flap: challenge TXTs reached jade 6.4 s after creation and, after deletion,
  flapped present/absent at jade for ~32 s; harmless to Let's Encrypt, but a renewal within ~35 s
  of a previous deletion can see the old value [C s.9.4].

**Other pieces.** The relay now closes *every* first-party SNI nobody registered after one fixed
wait, no byte sent, so with a wildcard in DNS a prober cannot tell which accounts are up
`1ddccb2b9` (**[SVC]**); one-label names under the apex close at once. Direct-IP boxes are
refused (`direct-mode-unsupported`; nothing called the route). The DNS broker refuses `publishARecord`
(`d85785702`). The store-review account `playstore-test-0725` can never lose a record
(`718fbcbde`). Reap tooling: `scripts/reap-orphans.mjs` (dry run default, typed count, plan under
a day old, per-record D1+zone re-check) `2a46fa3d5`, `41f4f3925`; `npm run zone-health`
(exit 1 on a missing/wrong/proxied wildcard, missing apex CAA, any record at an account or box name).
Gym: `core` group checks the account holds **zero** records and polls the first box's names every
200 ms through issuance, failing if they go dark; `dns-ent-experiment.ts --canary` (30 s) is in
`gym:total`. Gym zone leftover reaping on teardown `779cb5775`; Let's Encrypt budget check first
`15ac17597` (the zone is not on the Public Suffix List, so gym and prod share the **50
certificates/week** budget).

**Verified by me [V].** `packages/control-plane/tests/rootWildcardDns.test.ts` (29),
`packages/services-zone/tests/rootWildcard.test.ts`, `apps/com/test/prodReap.test.ts` (59) pass.
Public DNS today: apex `flagship.services` -> Cloudflare edge (`172.67.185.244`, `104.21.32.109`;
AAAA `2606:4700:...`), **no apex CAA**, **no `*.flagship.services` record** (query for
`anything-at-all-zz.flagship.services` returns nothing) - i.e. the owner's manual step 6a has
**not** been done yet, as the runbook says.

**NOT verified.**
- The **final** layout on the live gym. The "248 checks, 0 failed, 23 groups, 57 min" run that
  `final-deploy.md` s.6 calls the gate was made with the gym Worker at `2963833d7`
  (docs/wildcard-dns.md s.9.4), and `2963833d7` is an *ancestor* of `272ce0c7d` [V
  `git merge-base`]: the run executed the per-account layout (zone 166 -> 178 at peak = 3 accounts x 4
  records [inference]), **before** `.com` stopped writing per-account records, before the core
  group's "account holds zero records" check (`257755719`), and before the safe-deletion order.
  Roughly 39 commits, 38 files in `apps/com/src`, `packages/control-plane`, `packages/storage`,
  `packages/server-daemon` changed after it [V `git diff --stat`].
- Cloudflare's behaviour is **not RFC 4592** and not documented by Cloudflare as a guarantee. If it
  changes (plan, zone setting), a challenge TXT darkens a box for up to 30 minutes. The standing
  detectors are the weekly gym canary and the per-run probe; there is no production alarm.
- Adding the **apex CAA** (`issue`/`issuewild letsencrypt.org`) when the apex has none: the runbook
  asks the owner to check that Cloudflare's own certificate for the proxied apex stays active [C
  `final-deploy.md` s.6a.4]; no one has done it.
- `flagship.services` apex is a **proxied** site while `*.flagship.services` must be **DNS only**;
  a mistakenly orange wildcard bypasses the relay (zone-health flags it; only when run).

**Consequences.** **[COM]** (no D1, **no endorsed box release**, no client change), **[SVC]** for the
uniform drop timing, **[OWN]** the manual wildcard + CAA step, then dry-run reap, then `--apply`,
then `npm run zone-health` (`final-deploy.md` s.6a, s.8, s.12). Nothing is deleted before the
wildcard exists and equals the relay address; that protects *existing* accounts only. **Order
(revision 2): `.services`, then the manual wildcard + apex CAA, then `.com`**, because the new
`.com` writes no per-box address records and a new box registering before the wildcard exists gets
names that do not resolve (cached 30 minutes). The first version of this report said `.com` first is
safe; that was wrong for new boxes (section 0.1).

### T22. Data sovereignty (parked) and the boot hardening that stayed

- **What/why.** A feature to rescue a server's data over the LAN when `.com` is gone (phone takes
  a backup off its box with no `.com` call, LAN announce under an owner-only id, admin-device
  rescue signers, account-key-file carries the admin key and server list). Built 10-18 morning
  (`5775ff1c8`, `b5450bc80`, `60d12c203`, `283a1fc95`, `be88b889d`, docs `595ec25f6`, `38dc5fb91`),
  then **reverted seven times** (`014b2fb84`, `99b400c19`, `543682d9e`, `4214c2a7e`, `b89216295`,
  `707c4351e`, `d73182510`) and parked (`3f3d7c153`) on `origin/feat/data-sovereignty` "not needed
  at launch" (owner 2026-10-18 [C]). The branch is 1 commit ahead of `main` [V] because the feature
  commits are in `main`'s history.
- **Kept on `main`.** Boot hardening `b73277257`: a rebooting box waits at most 60 s for the relay's
  first HELLO_ACK (it keeps dialing in the background) and serves the on-disk certificate if it
  names the box, even inside the renewal window or past its end (before: it waited forever, and
  refused an in-window certificate so the same reboot left it with none).
- **Box trust fixes the same day.** The re-pair watcher no longer takes `.com`'s word that a
  re-pair finished: the swap (clear paired sessions, re-anchor membership, adopt the new IRK)
  needs a proof chaining from the IRK the box trusts, or an admin-root rotation the box verified
  itself; otherwise it is held a week (`4de997c1c`; `.com` keeps and serves the signatures,
  **[D1:0105]** `ea72f519a`). `BoxReadToken` calls time out after 20 s `2079cf7e8`. A restored
  backup's apps become the importing account's own (T6). Doc: the "forced-cut-off promise"
  `d5f2256db`.
- **Tests.** `packages/server-daemon/tests/rePairWatcher.test.ts`; boot hardening has tests per its
  commit [C].
- **Not covered.** [N] A box that reboots with the relay down was never exercised live. Serving an
  **expired** certificate is a deliberate availability-over-correctness choice: a client that
  refuses expired certificates will still refuse it.
- **Consequences.** **[END]** (all), **[COM]** + **[D1:0105]** for re-pair proofs. Open: the self-
  delete order names the account, not the server, and has no expiry [C AGENTS].

### T23. `.com` on the Workers Free plan: CPU, requests, the doorbell

- **What/why.** Owner 2026-10-18: run `.com` on Workers **Free** (10 ms CPU a request, 100,000
  requests a day, 50 subrequests, every D1 call counts as one). A gym request was killed at ~11 ms
  (Cloudflare 1102, shown by the apps as HTTP 503) because the CA mandate chain was re-verified on
  every request `b1482280f` (a third of a signed device-list request's CPU).
- **Measured** with the in-repo harness (`scripts/cpu-profile.ts`, `scripts/cpu-workerd.ts` using
  real workerd; resolution 10 ms over a batch) [C `docs/runbooks/workers-cpu-budget.md`; I did not
  rerun workerd]:

  | route | D1 calls | workerd ms before -> after |
  |---|---|---|
  | account directory (admin device) | 16 -> 4 | 9.0 -> 4.7 (net of dev floor 6.7 -> 1.9) |
  | `/pods`, `/stream` first connect | 13 -> 3 | 6.3 -> 3.6 / 3.9 |
  | `/stream` held 25 s | **130 -> 8** | over 20 -> 6.5 |
  | `/audit`, device grants | 5 -> 2, 7 -> 2 | 4.0 -> 3.5, 5.1 -> 3.6 |
  | box heartbeat | 4 -> 5 (adds the doorbell) | 4.5-5.1 -> 4.7-4.9 |

  A young isolate's first request is ~1.6-2x those figures; the directory read (heaviest) is ~7.5
  ms cold in workerd, i.e. **2.5 ms from the limit**.
- **Commits.** Native Ed25519 first + remembered verified triples `68bafe4c6`; `RequestD1`
  (reads started together leave as one batch; remembered until a write) `911754178`; hot routes
  made cheap `99931af58`; cold isolate (noble's 20 ms base-point table built at startup) `db5eadee8`;
  harness + guard test `a2510e8b0`, `9b5210992`; client back-off while `.com` fails (a foreground
  app had retried ~17k times a day into a 1102) AND `de8c34e2e`, iOS `bf82b2596`, WEB `73835be87`
  (shell v153); the **doorbell** `7dbac24c3`, `bc59534d4`, `fbff4df7e`; docs `7e1a417eb`,
  `b1c773e15`, `e1e6dde58`; and **after my baseline**, live-gym group `freePlan` + Worker-tail CPU
  watch `a365def74` (landed while I wrote this; not run).
- **The doorbell.** The heartbeat reply says which of ~9 mailbox lanes hold something for the box
  and carries a digest of the alias list, device grants and admin-root rotation chain; the daemon
  answers a poll for an empty lane with a local 404 and replays an unchanged list. Safeguards: every
  poll goes out while the doorbell is missing or older than 12 minutes; each lane is polled for
  real at least hourly; `FLAGSHIP_DOORBELL=0`; a read a person waits on always asks `.com`. Effect
  on requests/day: a box ~4,470 -> ~1,200; accounts that fit under 100,000/day **21 -> ~75**
  (alarm at 70,000 = ~52) [C, derived by the doc's own table]. Cost: a renamed app's new address can
  take up to 5 minutes to route (alias list was every 60 s).
- **Tests.** `apps/com/test/cpuBudget.test.ts` (2, pass [V]; fails on more D1 round trips or a
  worse CPU ratio against a calibration loop), `boxDoorbell.test.ts` (9, pass [V]),
  `packages/server-daemon/tests/doorbell.test.ts`, `packages/storage/tests/requestD1.test.ts`,
  `apps/com/test/warmCrypto.test.ts`. The CPU guard measures Node + node:sqlite, not workerd.
- **Does not fit Free, not fixed** [C]: the **6-hourly D1 backup** (89 D1 calls, cap 50 - "on Free it
  does not run at all"); the other crons (`*/10` demo/alert passes, CT monitor, model capability
  refresh, adapter publish) are unmeasured; **`run_worker_first = ["/*"]`** makes every static file
  a counted request (~190 per webapp shell release per user; the shell moved v114 -> v153 in about
  two days (10-16 to 10-18)); invite-revocation and share-end polls (576 requests/day/box) are not gated; `/stream` stays a
  polling long-poll.
- **Contradiction (fixed in `40195ab9f`).** `final-deploy.md` s.1 said "Workers Paid ($5/month)" as
  the first step while s.14 and AGENTS say Free; s.1 now says Free for launch with Paid as the
  fallback. s.14 still says the D1 backup "already needs a decision before the first deploy" (open).
- **Consequences.** **[COM]** first (shell v153), then **[END]** (the doorbell; "an old box simply
  keeps polling"), **[iOS][AND]** for back-off. The ~75-account ceiling only applies once boxes run
  the endorsed doorbell build; until then ~21.
- **Risks.** (1) The release shape (many tiny shell releases) burns the daily request budget; (2) a
  public launch above ~75 always-on accounts with doorbell, ~21 without, hits Cloudflare error 1027
  until midnight UTC; (3) a CPU regression is only caught by the Node guard, not workerd; (4) the
  held `/stream` now notices a change within 3-10 s instead of 2 s.

### T24. CI, gyms, parity, readiness

- **CI on `main` (read via `gh`, 2026-10-18 ~22:00Z) [V]:** Predeploy guard (apps/com) success and
  Admin-authority guard success and e2e (Playwright + pod-sim) success on `9b5210992`; android
  (unit tests + debug APK + release APK + Wear + release-clean) success on `73835be87`;
  builder-windows and builder-linux success on `ace25c6d4`; vm-appliance success on
  `35e207cda` and `2963833d7` (a `d4c7ef4c0` arm64 run failed, the tar race). **CI (tsc +
  vitest)**: last *completed* run success `a2510e8b0`; runs for `73835be87`, `9b5210992`, and
  `a365def74` were still `in_progress` when I looked (so no completed CI verdict exists for
  `main`'s tip; my local run is the only one on `9b5210992`). `release-guard.yml` has no runs
  (tags only). **There is no iOS workflow.**
- **CI fixes this window.** Node 24 actions + pinned Ubuntu `b92ef8dac`; web gym in CI `fa6a5da75`
  with a 60-minute budget `f68870bf3`; e2e suite brought back to the current app
  `a55acbf4b`, `be39010eb` (four webapp bugs it had been hiding), `c766c41b7`, `3b79b3f52`;
  Windows/Linux Studio tests on shared-input change `dbf3c2c30`; the integration job on real
  Postgres and loop images `eb144c1df`; argon2 test headroom `8b7d4ef80`; billing standalone CI
  `5fb0556c1`; a duplicate import that broke every web gym scenario `f85e9b1cf`.
- **Parity matrix** (`parity/features.json`, `npm run parity`; each row carries code anchors the checker greps):
  `npm run parity` **exit 0, 0 red** at `9b5210992` [V]; eight checks (app-links, push categories,
  in-app links, canonical signed-message tags [31 allowlisted with reasons], Screens BFF fields,
  test-vector consumption [3 allowlisted], product version, feature anchors). The allowlist
  entries I read are by-design platform differences (e.g. iOS Secure Enclave wrap tags) [V]; one
  line, `flagship/acme-account-key-grant/v1` "no client issues, seals or unseals" corresponds to
  AGENTS open item 5 (restricted-device profile-key delivery unimplemented) [C]. Feature matrix
  PARTIALs [V `--report`]: https app links (iOS, web), Add a device (iOS, Android), Studio rows
  (pairing, graceful stop, prune, one-click host on Win/Linux). On 10-16 the checker had 43 reds,
  mostly native ports that lived only on paused branches; by 10-17 it was 1 [C REPORT part 3].
- **Readiness.** `npm run ready` (branch drift, tsc, vitest, e2e, locked gym, parity;
  `-- --native --live` for a release candidate) `dda5ccc56`; its `branches` item is amber/red by
  design. Feature branches that conflict with `main`: `feat/marketplace`, `feat/retail`,
  `feat/phone-usb-burn`, `alpine`, `gym` [C `final-deploy.md` s.0].
- **Live gym** (`tools/live-e2e/shared-run.ts`, one fleet on UpCloud): **23 group files** [V `ls`]:
  accessLists, activity, aiChat, aiStaging, apiKeys, appCopy, archive, backups, core,
  enforcement, gating, invites, lifecycle, mcpIde, migrate, oneList, quota, realAccount, remote,
  runtimes, serverOrder, share, update; plus `freePlan` after my baseline. Recorded runs [C]: 112 checks
  0 failed (10-15, 3 boxes); `live-run-2026-10-16T00-50-30-999Z` invites 14 + gating 21; "244
  checks, 22 groups, ~67 min, peak 4 boxes" (10-17); "248 checks, 0 failed, 23 groups, 57 min"
  (10-18, **pre-root-wildcard code**, T21). Bugs the gym found and `main` fixed: gym boxes never
  showed online, invites of admin-pinned accounts could not be redeemed, gVisor apps had no DNS,
  app backup "include user data" always failed, concurrent pairings 500'd, saved/migrate backup
  ENOENT, the 16 MiB ballast, gVisor retry delay, boot/recovery hosts hard-coded to prod
  (`1936a2052`). Rules learnt: gym boxes clone the `gym` branch (except the `update` box, which
  clones `main`); never `--keep` a full run (the shared zone is 154/200 even without the gym).
- **Not covered by any live run** [C AGENTS + me]: peer backup (no group); the whole server restore
  and docker save/load on a *production* box; share with a live CA attestation was exercised only
  on the gym CA chain; the Free-plan behaviour (new group unrun); the final DNS layout (T21).

### T25. Platform and product work, 2026-10-08 .. 2026-10-14

Compact index. AGENTS.md describes these at length; this table only anchors them so the
reviewer knows they are in the diff. All were on `main` before the last four days, and most
were validated only by unit tests, mock gyms and (from 10-15) the live gym.

| Area | Anchoring commits | Question to ask |
|---|---|---|
| Security fix: username rename route let any account take a reserved handle (`e2e`), bypassing squat fees; retired routes answered at the edge; bundle built from an empty `dist/` | `b3d6852b8`, `c41329733`, `d4ce3f338` | Researcher credits and bounty payments are tracked in agent memory, not in the repo. |
| Update pipeline: fsynced markers, rollback guard, release-list fallback, first-boot update to the newest endorsed release | `a367d9885`, `5e363163d`, `a73f0a41e`, `25422a94b`, `032f45195` | A bad endorsement reaches every new server on first boot; is the health gate enough? |
| AI privacy, staging copy, egress fence, AI calls via the hub relay, app access lists | `610f31a03`, `37ba277d8`, `a1134741f`, `e408e1360`..`c78151b4d` | The fence "fails open for live apps if it can't start" [C AGENTS]. |
| App runtimes + gVisor sandbox (apps cannot write a Dockerfile) | `8ddf19a9e`, `cb08da37d`, `57b69edb4` | "Not yet built on a real box: the three runtimes' builds and a non-root app writing `/data`" [C]. |
| Data layer: Postgres 18 + a files folder per app; MinIO/Redis removed | `70b189ec2`, `a3b4c396e`, `52d0b375b` | An old Postgres 16 cluster is moved aside, not migrated. |
| Apps as API servers, API keys, member sign-in, per-app visitor identity, anonymous visitors get no rank | `85d3e9115`, `4eb09ca6d`, `f92313332`, `72f7768b2`, `6147e4803`, `bb5b3b20a`, `de24d3a20` | Existing invites bound to old contact AIDs need re-inviting (accepted pre-release). |
| Where an app runs, app copy between servers, app links to the right box | `73211505b`, `c22d5eac1` | docker save/load and pg_dump/restore unrun on a real box [C]. |
| LAN-direct (failure is a no-op back to relay) | `657b40a4c`, `c585dda70`, audit `c882f7687`, `cb570c19d`, `7c78629f4`, `f5bb427d2` | Studio VM NAT means LAN-direct can never help a phone on a Studio-hosted VM [C]. |
| Metering core + standalone `billing/`; Free slowed, not cut | `71398e8b9`, `a0412d6f5`, `01eefcf91`, `bafb63e44` | npm publish and the GitHub mirror await the owner. |
| Flagship Inference (free AI): allowance, model menu, compaction, attachments, thinking off, GLM default | `6a0efd2d4`, `ac970ff89`, `3d48adc05`, `0671d065d`, `b45d066f4`, `3e8fef1de` | Not live: shim deployed with keys but no public host (`a1df5e106` binds a domain) and "never run end to end" [C REPORT]. |
| Repo adapters, git import, vibe-code sessions, edit-in-place | `417425ccd`..`1584bfe8c`, `4f1886236`, `c26f72843` | Submit/complain budgets only added 10-16 (`28bff7d8a`). |
| Server order, account read tokens, https app links, QR-first remote, rate limits in Durable Objects, clickjacking + CSP, `durableFile` fail-closed state | `f0af2d06d`..`c9ce3d9b`, `bb3608e93`, `7e0271ed4`, `b3382c70d`, `8a4416da9`, `d0658fb6a`, `94491f6c0`, `9c7eaa219` | Secret `ACCOUNT_READ_TOKEN_SECRET` must exist before the `.com` deploy [C]. |
| Delete / reversible revoke; Android widget, ongoing setup notification, Wear OS | `c8fb3d41f`, `046e3cbe8`, `a4f38b4d1`, `bc6e92e71`, `f6bf0c033` | Wear OS app never run on a device [C]. |

### T26. Minimum OS floors

- **Decision.** Owner rule (2026-10-07): minimum = oldest version still safe to use. 2026-10-17
  owner: "Android minSdk 33 (Android 13), macOS 15 (Sonoma stopped getting fixes), iOS 18 and
  watchOS 11 unchanged" (decisions.md).
- **Commits.** Android + Wear OS minSdk 28 -> **33**, dead API-level branches removed `837b17593`
  (the reasoning: Recents screenshot block for the app lock, sensitive-clipboard flag, runtime
  notification permission exist only from API 33); Studio floor macOS 15 in `e16ba6611`'s subject.
  iOS 18 / watchOS 11 were set *before* the iOS baseline (`29a352eff`).
- **Verified.** `minSdk = 33` in both Gradle files at HEAD [V]; at the Android store commit it was
  28 [V].
- **Not covered.** The claim that Android 9-12 phones are "mostly out of vendor security support"
  is labelled "general knowledge, to verify against vendor bulletins" in AGENTS [C]. **This drops
  every Android 9-12 user from updates** and the Play listing's device count; nobody has measured
  how many that is.
- **Consequences.** **[AND]**, **[STU-M]** (a new Mac Studio build, macOS 15).

---

## 4. Deploy and release consequences

### 4.1 Per-theme table

`Y` = required for the theme to take effect; `o` = optional / shell only; `-` = none. "Builds"
= a new store build is required for users to see it.

| Theme | COM | SVC | END | iOS | AND | STU | APP | D1 / SEC / OWN |
|---|---|---|---|---|---|---|---|---|
| T1 admin-only add server/device | Y | - | Y | **Y first** | **Y first** | - | - | stores before `.com` |
| T2 share / co-manage / ranks / one list | Y | - | Y | Y | Y | - | - | live CA lease (expires 2026-11-05) |
| T3 debug access v2 + env-sign | o | - | Y | Y | Y | Y (Linux checkbox) | - | box + builds together (breaking) |
| T4 backups (policy, scheduled, one file, limits, Migrate) | o | - | Y | Y | Y | o (wording) | - | - |
| T5 peer backup v2 | Y | **Y** | Y | Y | Y | - | - | **D1:0104**, SEC `PB_TOKEN_RSA_JWK` `PB_FILLER_SECRET` `PB_TAG_SECRET` |
| T6 Add/Restore server | o | - | Y | Y | Y | - | - | - |
| T7 security notices | Y | - | - | Y | Y | - | - | OWN: sign a notice (YubiKey) |
| T8 account gone + delete fix | Y | - | - | Y | Y | - | - | - |
| T9 RCK reuse + atomic swap | Y | - | - | Y | Y | - | - | - |
| T10-T14 error mapper, Activity, offline page, M3, iOS polish | o | - | - | Y | Y | - | - | - |
| T15 tokens / T16 0.2 Beta / T17 no-mocks | Y (site, shell) | - | - | Y | Y | Y (0.2.0) | - | version numbers must exceed store maxima |
| T18 GA close-out | Y | - | Y | Y | Y | Y | Y | OWN: gVisor R2 upload, scrub, reap, merge wipe-tooling deletion |
| T19 Windows/Studio findings | Y (download URLs) | - | - | - | - | **Y all three** | **Y both arches** | OWN: `publish-vm-appliance.sh` |
| T20 auto-unlock lease signer | - | - | - | - | **Y** | - | - | Play `versionCode 8` has the bug |
| T21 DNS root wildcard | Y | Y | - | - | - | - | - | OWN: Cloudflare `*` A/AAAA + apex CAA **by hand**, then reap, then `zone-health` |
| T22 boot hardening, re-pair proof | Y | - | Y | - | - | - | - | **D1:0105** before `.com` |
| T23 Workers Free CPU + doorbell | Y | - | Y | Y | Y | - | - | OWN: Free vs Paid decision; D1 backup cron |
| T24 gyms / CI / parity | - | - | - | - | - | - | - | gym Worker via `gym-refresh.sh` |
| T26 floors | - | - | - | Y | Y | Y (Mac) | - | - |

Cross-cutting: **[END] needs the owner's YubiKey** (`node scripts/endorse-release.mjs ... --sign`,
newest endorsement is `e07f6ba7`; box-path commits after it include the doorbell [V], so the
runbook's "no new endorsement needed" was stale; fixed in `40195ab9f`, D3 below). **CA lease renewal due before
2026-11-05** (every CA-chain check fails closed after it: app trust checks, relay blessing, share
acceptance, the box's own bootstrap).

### 4.2 Ordering constraints a deployer can get wrong

1. CA lease renewal first (it is baked into the `.com` bundle); then endorsement (YubiKey); then
   appliance rebuild (bakes the newest *endorsed* release, not `main`); then the gym gate and
   migrations; then `.services`, the manual DNS wildcard + apex CAA, and only then `.com`
   (`release.sh` steps 10-12; revision 1 had `.com` before `.services`, which was wrong, see 0.1).
2. D1 0104 and 0105 **before** `npm run deploy` (the script refuses on migration drift, so a
   forgotten one fails closed). Prod's ledger reads 0105 newest [V, section 0.1]: nothing is pending.
3. Store builds **before** `.com` for T1 (current builds cannot create a server afterwards) - but
   store builds before `.com` also means new clients talk to an old `.com` for a while (T7 and T8 should degrade gracefully, a missing route or no 404 [inference]; T20 is client-only).
4. The root-wildcard manual DNS step must exist before any legacy record is trimmed; do not
   roll it back after the trim (the runbook says so).
5. Do not run a gym run while prod deploys (shared zone, shared Let's Encrypt budget of 50/week).

## 5. Open risks and unverified claims (blunt)

Numbered so the questions below can point at them.

- **R1. The final DNS layout was never run live.** The 248-check "gate" ran on the per-account
  layout (T21). `final-deploy.md` s.6 still says no prod deploy until the gate passes - but it
  passed on different code. A fresh gym run on `main` is the actual gate.
- **R2. Cloudflare non-RFC dependence.** Empty non-terminals are not applied by Cloudflare today;
  RFC 4592 says they should be. Flipping that (plan change, zone setting, or a Cloudflare
  change) darkens a box for up to 30 min per challenge. No production alarm; only a weekly gym
  canary and a per-run probe. The old shield was the wrong answer.
- **R3. Relay fallback assumption is wrong on today's DNS.** Android `RelayFallbackDns` uses the
  apex's addresses as the relay; the apex is Cloudflare-proxied (public DNS: 172.67.x/104.21.x)
  [V]. iOS has retry only. Its test uses a fake resolver [C]. A fix is reported as in progress; not
  on `main` at `eb449c357` [V] (section 0.1).
- **R4. Workers Free ceiling.** ~75 always-on accounts under 100,000 requests/day only with the
  doorbell endorsed (21 without); `run_worker_first = ["/*"]` makes every shell release cost ~190
  requests per user; the D1 backup cron cannot run (89 D1 calls, cap 50); other crons unmeasured;
  CPU guard is Node, not workerd; the directory read is ~7.5 ms cold against a 10 ms cap.
- **R5. CA lease expiry 2026-11-05T19:31:05Z** [V]: hard date; every CA-chain check, share
  acceptance, relay blessing and box bootstrap fails closed after it.
- **R6. Almost every box-side change needs an endorsement** (T1 restore rule, T3, T4, T5, T6,
  T18, T22, T23) and the YubiKey is the only signer; one bad endorsement reaches new servers on
  first boot.
- **R7. No iOS CI and no iOS build verified by me.** iOS correctness at `main` is known only from
  agent commit bodies. Android is compiled and unit-tested in CI (success at `73835be87`), but
  emulator gyms are not in CI.
- **R8. No real-device validation of this window's client work.** AGENTS says so repeatedly (backup
  client, Wear OS, Android worker, webapp restore). The only real-device runs recorded are the
  owner's Samsung (Android 16) for the 10-17 bug fixes and the 10-18 Windows PC.
- **R9. Android Burn-to-USB.** Recipe encoding bug (`a62f73b2b`) meant every Android recipe was rejected
  by the preseed engine; fixed, then "verified" by byte comparison of a stick written from a
  *local* ISO seed; not booted; managed manifest path untested; the feature lives on
  `feat/phone-usb-burn`, not `main` [C REPORT part 2].
- **R10. The security-notice lock can strand a server.** A locked phone cannot approve a boot
  unlock; a rebooting server waits for the person to update (doc s.9). Current store builds contain
  no notice client, so the lock cannot reach them anyway.
- **R11. Teal graphics at 2.30:1** (owner choice) are below WCAG 1.4.11 for UI components; selected-
  state markers and borders use it [N audited].
- **R12. Historic known-public LUKS slot** remains on every already-installed USB box until reburn
  (owner decision) [C].
- **R13. Storage layout rewrite on boxes with data** (T4 per-app loop images, orphan sweeps) has been
  exercised only on gym boxes and a Debian 13 VM [C].
- **R14. Peer backup is unproven end to end**, v1 and v2 code coexist, no live group, prod secrets
  and migration not applied [C].
- **R15. Process failures that touched `main`**: a stale-tree squash silently reverted other
  agents' work (`e4c9c4e82`, repaired `080522ff6`, `568bd5218`); `main` was red for minutes when a
  land check was piped through `tail`; WIP-labelled commits are on `main` (T14); ~14 parallel agents
  edited the same trees [C REPORT part 3].
- **R16. Release numbers are guesses**: iOS 1.1 build 5 and Android `versionCode 9`.
- **R17. Windows test suite is not green on Windows** (92 files fail for host reasons) and the daemon
  suite is Linux-only; `fsync` of a directory fails with EPERM on NTFS [C].
- **R18. Rate-limit and abuse budgets** were re-based onto Durable Objects (10-15) and the owner's
  first weekly check ("not yet checked", AGENTS) has not happened.
- **R19. The doorbell trusts `.com`'s heartbeat reply to skip polls.** A hostile `.com` can already
  withhold orders; the new exposure is bounded delay (hourly forced poll, 12-minute freshness) and
  a replayed unchanged list for up to an hour [C].
- **R20. Flagship Inference** is "built, not live" and unrun end to end; allowances and the model
  lineup are owner settings in D1 (`inference_settings`), changed without a deploy.

### Document drift (docs on `main` that disagreed with each other or the code; D1-D7 fixed in revision 2)

- **D1.** Prod D1/shell state: AGENTS "0104 pending, shell v114" vs `final-deploy.md` s.4 "prod has
  0105 applied". **FIXED**: ledger read, 0105 newest (0.1).
- **D2.** `final-deploy.md` s.1 (Workers Paid first) vs s.14 and AGENTS (Free) [V `grep`]. **FIXED**.
- **D3.** `final-deploy.md` s.3 says the only box-path change after endorsement `e07f6ba7` is a test
  vector; `git log e07f6ba7..origin/main -- packages/server-daemon/src` shows the doorbell commits
  `bc59534d4` and `fbff4df7e` [V]. **FIXED**.
- **D4.** AGENTS "Desktop Studio" says the Android lease signer is "not yet fixed"; `64df9098c` fixed it [V]. **FIXED**.
- **D5.** `final-deploy.md` s.6 "Gate result ... 248 checks" is for `2963833d7`, yet the same section
  says the core group checks zero account records, which landed in `257755719` [V]. **FIXED** (relabelled; a fresh gym run is still needed).
- **D6.** `final-deploy.md` s.13 "Not run by anyone yet: live gym groups quota, share" vs AGENTS
  (22 groups green on 10-17 including them) and the 10-18 23-group run. **FIXED**.
- **D7.** AGENTS "Last updated 2026-10-16" and `vitest ... (~30s)`; the full run is 179 s [V] and the
  file has 10-18 entries. AGENTS still names a nonexistent branch `feat/share-server` [V
  `git branch -r`] although share shipped on `main`. **FIXED**.

## 6. Questions for the reviewer

1. **R1/T21:** Given that the gate run exercised the per-account layout, is it acceptable to deploy
   the root wildcard to prod after one more gym run, or should a canary account run on prod first
   (the zone is shared, so the gym already is "prod DNS")?
2. **R2:** What alarm would you put on "Cloudflare started applying empty non-terminals"? Is one
   apex-level synthetic probe (a throwaway TXT + a sibling query, hourly) acceptable on a Free zone?
3. **R3:** Delete `RelayFallbackDns`, or point it at a name that is guaranteed to be the relay
   (e.g. a DNS-only `relay.flagship.services`)? Would the fallback leak that a name is unresolved?
4. **R4/T23:** Free plan: is shipping a launch on 100,000 requests a day sound, given static assets
   count and the shell moved from v114 (10-16) to v153 (10-18)? Should `webapp.`/`remote.` move to Pages
   before launch?
5. **T7/R10:** Should a security lock exempt the boot-approval path (the doc's own "sharpest
   edge"), at the cost of a field in the signed notice?
6. **T15/R11:** Is 2.30:1 acceptable for selected-state markers and borders, or should state use the
   deep teal and only decorative glyphs use the bright one? Which pairings did the web test cover?
7. **T2:** Is the trust model right that a shared box accepts any account's admin root as long as
   `.com`'s CA attests it is *some* account's sensitive key (it names no account)? What stops a
   throwaway account from being the "joining admin"?
8. **T9:** Is "same account may replace the RCK while the routing target is empty" safe against a
   box registering concurrently (one conditional UPDATE) and against transfer/take-over claims
   (not read the RCK per the commit author)? Where else is the RCK a bearer capability?
9. **T4:** The per-app loop-image migration runs on first boot after the update on boxes with data;
   what is the abort path if moving a volume fails halfway ("staying plain if that fails")?
10. **T18:** Is "installed boxes keep their public LUKS slot until reburned" tolerable for launch, or
    must the bootstrap remove it on update (it cannot without the old passphrase)?
11. **T20/T1:** Both the lease signer bug and the add-server `add-server-admin-only` refusal show that
    **store-build lag** is the main correctness risk. Would you ship `.com` with a server-side
    allowance for old clients, or force a store-build-first order?
12. **R6:** One YubiKey signs every box release and security notice. Is there a second signer or a
    lost-key plan that does not take the product offline?

## 7. How to reproduce the key verifications

```sh
cd /path/to/flagship && git fetch origin
git merge-base --is-ancestor b900b609b origin/main && git merge-base --is-ancestor fffcfb544 origin/main
git rev-list --count b900b609b..origin/main                  # 1108 at 9b5210992
git diff --shortstat b900b609b origin/main                   # 2909 files changed
git worktree add ../report-wt origin/main && cd ../report-wt && npm ci
npx tsc -b                                                   # clean
npx vitest run                                               # 832 passed | 2 skipped files; 10913 passed | 49 skipped tests; ~3 min
node scripts/parity-check.mjs --report                       # 0 red; shows the PARTIAL rows
npx vitest run apps/web/tests/themeContrast.test.ts apps/com/test/cpuBudget.test.ts \
  packages/control-plane/tests/rootWildcardDns.test.ts packages/flagship-builder/tests/luksSingleSlot.test.ts \
  scripts/release-guard.test.ts scripts/release-clean-sources.test.ts                  # 17 files / 287 tests pass
git show origin/wip/coordination-2026-10-16:docs/coordination/2026-10-16/decisions.md   # owner decisions
node -e '...WCAG ratio...'    # section T15 numbers: (lum+0.05) ratio from the hex values in apps/web/public/tokens.css
dig +short A flagship.services @1.1.1.1                      # Cloudflare edge, not 149.248.216.86 (R3)
dig +short CAA flagship.services @1.1.1.1                    # empty: manual step 6a not done
dig +short A anything-at-all.flagship.services @1.1.1.1      # empty: no root wildcard yet
git merge-base --is-ancestor 2963833d7 272ce0c7d && echo "gate run predates root wildcard"
git log --oneline e07f6ba7..origin/main -- packages/server-daemon/src   # doorbell commits after the last endorsement (D3)
gh run list --branch main --limit 40 --json workflowName,conclusion,headSha
```

Live-gym (owner or gym operator only; never during a prod deploy): `bash scripts/gym-refresh.sh`
then `npx tsx tools/live-e2e/shared-run.ts`; DNS canary alone: `npx tsx
tools/live-e2e/dns-ent-experiment.ts --canary`; zone check: `npm run zone-health` (needs
`FLAGSHIP_ADMIN_SECRET`).

## 8. What I ran (verification log)

| Check | Result |
|---|---|
| `git merge-base --is-ancestor` x2, `rev-list --count`, `diff --shortstat` | as in section 1 |
| `npm ci && npx tsc -b` at `9b5210992` (own worktree) | clean |
| `npx vitest run` (whole repo) | 832 files passed / 2 skipped; 10,913 tests passed / 49 skipped; 0 failed; 179 s |
| 17 targeted test files (section 7) | 287 passed |
| `node scripts/parity-check.mjs --json/--report` | 0 red, feature matrix as quoted |
| WCAG ratios recomputed from the committed hex values | matches `themeContrast.test.ts` and the iOS floors (2.3 / 2.1) |
| `gh run list/view` (read-only) | CI table in T24; vm-appliance runs `39158345483`, `39160505562` green |
| Public DNS: A/AAAA/CAA of `flagship.services`, an arbitrary one-label name, `*` | apex = Cloudflare edge; no CAA; no wildcard |
| Revision 2: `wrangler d1 execute ... --remote` read-only `SELECT` of the ledger (at the coordinator's request); `release.sh --list`; `scripts/release.test.ts` | 0105..0100; 27 steps, 16 + 11; 22 tests pass |
| `git merge-base --is-ancestor 2963833d7 272ce0c7d`; `git log e07f6ba7..origin/main -- ...` | R1 and D3 |
| **Not run by me** | any iOS build, any Gradle build or emulator gym, any Swift/C#/Python Studio test, workerd CPU harness, any live gym, anything against production |

I added no tests and changed no code. Revision 1 added only this file; revision 2 also edited
`AGENTS.md`, `docs/runbooks/final-deploy.md` and `docs/wildcard-dns.md` (documentation only).
