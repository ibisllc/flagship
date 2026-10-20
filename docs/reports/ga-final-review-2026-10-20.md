# Flagship GA: last-pass review

Written 2026-10-20 in answer to `docs/reports/ga-final-review-request-2026-10-20.md`, against
`main` at `a0f167c2b`. Tags: **[V]** verified from code, docs or a command I ran; **[I]** inferred;
**[G]** a guess. Nothing was deployed, signed or published; production was only read (`npm run ops --
health`, `curl`/`dig`/`openssl` against public endpoints, one 404 probe on a made-up account name).

What I ran [V]: `npx vitest run` without `scripts/release-guard.test.ts`: 850 files passed, 2 skipped;
11,062 tests passed, 50 skipped, 0 failed (141 s). `scripts/release-guard.test.ts` alone: still running
after 150 s in this checkout (30 folders under `.claude/worktrees`), so the request's "hangs" is right.
`npx tsc -b`: clean. `npm run parity`: 0 red. `npm run release-manifest`: 14 blockers, lease/schema/versions
ok. `node scripts/ios-release-clean.mjs`: clean. `swift test` (shared): 360 tests, 0 failures. Android
`:app:testDebugUnitTest`: exit 0, Gradle said up to date; the result files (03:47 today) add up to
1,892 tests, 0 failures, 6 skipped.

## 1. Verdict

**Not ready.** The code is well tested at the unit level. Four things are still wrong, though: data
loss in a shipped flow, a live disk-encryption bypass in the published installers, a single-person
outage of boot unlock for every user, and public claims that are false. The 14 missing hardware and
production receipts are real, but they are not what decides this. The things below would still be
wrong with every receipt in hand.

The five things that decide it:

1. **Migrate wipes the old server after a failed restore** (B1). The new box signs take-over once
   *any* restore has finished, even one in which every app failed. That ack opens the old box's wipe.
2. **The Studios on the site today write USB installs with a LUKS passphrase that is in the public
   repo** (B2). The fix landed 2026-10-18; the Mac DMG is from 10-14 and Windows/Linux are 0.1.3 from
   10-15.
3. **On the Workers Free plan, one person can stop every box from unlocking for the rest of the UTC
   day** (B3, B4). `boot.flagshipserver.com` runs on the Worker. Every unlisted path runs the Worker.
   There is no account cap. The hub's new outbound host check turns one box into ~170,000 `.com`
   requests a day.
4. **The release chain is further along, and further behind, than the docs say** (B5). Live `.com`
   already runs code from 10-18 or later, so the 10-16 admin-only rule for adding a server is very
   likely already refusing the current store builds. The newest endorsed box release (`875ad977`)
   contains none of round 2: no peer gate, no backup check.
5. **Public claims are false** (B7, B8). The FAQ sells hardware, refunds and Stripe cards, though
   nothing is sold, which is also what Apple was told. It says every key stays in the Secure Enclave
   and that a breach leaks only a username. The privacy page says BYOK AI goes "directly" to the
   provider. "Preview" appears nowhere a user can see, and Linux fails the repo's own Preview
   definition.

## 2. Blockers

Each is something that applies to the product **as the owner decided it**. Disagreements with
decisions are in section 7.

### B1. Migrate wipes the old server after a failed restore

- **Failure.** `commitRestore` calls `opts.wait?.finish(w.archiveId)` once `installArchive` returns,
  however many apps failed, even all of them. It only lists the failures in Activity [V
  `packages/server-daemon/src/serverArchive/service.ts:1191-1206`]. `restoredAny()` is `done.size > 0`
  [V `serverArchive/restoreWait.ts:169`]. Migrate's `restore` is `restoredAny() ? complete : waiting`
  [V `packages/server-daemon/src/index.ts:1657-1660`]. So the new box posts `pre-seeded`, and after
  the freeze `take-over` [V `migrationConsumer.ts:381-411`]. `.com` then sets the successor-confirm
  [V `packages/control-plane/src/serverMigration.ts:536-546`], and the old box's
  `wipe-after-handoff` wipes [V `decommissionConsumer.ts:412-424`,
  `pollMigrationAwareHandoffConfirm`]. The webapp tells the owner "Data restored. Confirm the hand-off"
  at `pre-seeded` [V `apps/web/public/webapp/lib/serverMigration.js:433`]. I found no per-app check
  before the freeze [I].
- **Who is hurt.** Any owner whose app fails to restore on the new box (an image that won't load, a
  failed `pg_restore`, a full disk). The only other copy is the `.flagship` file, and only if they
  downloaded it [I].
- **Smallest change (one commit, box).** Call `finish()` only when every app is `done`. Otherwise keep
  the server waiting with the failures listed, and allow a retry. Then `restoredAny` can't be true
  after a partial restore and Migrate never acks. Add a test: one app fails to install, no `pre-seeded`
  ack is posted, and the old box is never told to wipe. A second commit for the three apps: show the
  failed apps at the hand-off step and keep "Confirm" off.
- **Proof.** Extend the `destructive-restore-drill` receipt with an app whose restore is made to fail.

The owner's decision that Migrate ends with the old server deleted still stands. This blocker is only
about the case where the move did not actually succeed.

### B2. Published Studios burn a public LUKS passphrase into USB installs

- **Failure.** Before `09efc52a5` (2026-10-18 10:23), the preseed carried
  `BURN_PASSPHRASE = "flagship-build-time-luks-rekey-me-immediately"`, and the slot was never removed [V
  `docs/luks-burn-passphrase-removal.md` §1]. The repo is public [V `gh repo view`: PUBLIC]. The Mac
  Studio bundles its own `preseed-engine.js` [V
  `apps/builder-mac/Sources/FlagshipBuilderCore/Resources/preseed-engine.js`, changed in `09efc52a5`].
  The DMG served at `/downloads/FlagshipStudio.dmg` is the file committed 2026-10-14 [V file date;
  `apps/web/public/downloads/`]. `/download/windows` and `/download/linux` redirect to `studio-v0.1.3`,
  tagged 2026-10-15 [V `apps/com/src/route.ts:423-424`, live 302, `git log studio-v0.1.3`]. The published
  Studios are therefore older than the fix [V], and a USB install written by them today keeps a slot that
  opens with a string from git history [I: inferred from build dates; I did not unpack the DMG]. The VM
  appliances were republished from `072ee32de`, which is after the fix [V manifests].
- **Who is hurt.** Everyone who installs from a USB stick before the Studios are republished. Anyone
  with physical access to such a disk (a stolen box, a disposed drive) can open it.
- **Smallest change.** Republish all three Studios from `main` now (`release.sh` Phase B steps
  `studiowl` and `studiomac` already do this) rather than waiting for GA. Then one commit:
  `release-manifest` fails when a published Studio was built from a commit that does not contain
  `09efc52a5`. For boxes already installed, see section 7, item 3.
- **Proof.** Write a USB from the republished Studio on each OS, install, and run `cryptsetup luksDump`
  on the box: exactly one slot.

### B3. The Workers Free daily request cap is a global boot-unlock outage

- **Failure.** Free allows 100,000 Worker requests a day [V `docs/runbooks/workers-cpu-budget.md:13`].
  `boot.flagshipserver.com` is a custom domain of the same Worker [V `apps/com/wrangler.toml:63`], as
  are `recovery.` and `voi.ci/*`. The Worker runs first on `/*` except 46 listed static files [V AGENTS,
  `scripts/predeploy-com.sh`], so a request for any made-up path counts. The budget itself says about
  75 accounts fit, and only after an endorsed box release ships the doorbell (21 before) [V runbook
  lines 153-155]. Nothing in `.com` caps accounts [V: no such code]. The "alarm at 70,000" is a person
  reading a dashboard [V `scripts/release.sh:269`].
- **Who is hurt.** Every user, at once. Past the limit, Cloudflare fails the Worker's requests until
  00:00 UTC [I, from Cloudflare's documented Free behaviour], so a box that reboots cannot be
  unlocked. Reaching the limit takes about 1.2 requests a second for a day from anyone on the internet
  [I], or account growth past ~75.
- **Smallest change, as decided (one commit).** An enforced account cap on `.com` (env, refusal with a
  sentence) set well under the ceiling, e.g. 40. Also a Cloudflare rate-limiting rule on
  `flagshipserver.com` in front of the Worker (configuration, owner). The real fix is in section 7,
  item 1.
- **Proof.** `npm run ops -- workers --hours 72` (it needs `CLOUDFLARE_API_TOKEN`, which I did not
  have) and the dashboard's requests per day, recorded as a receipt.

### B4. The outbound host check lets one box spend `.com`'s daily quota

- **Failure.** On a cache miss, the hub posts `/api/outbound/check` for every host it opens [V
  `apps/web/src/tunnel/outboundHostPolicy.ts:66-85`]. The cache is per host, 2 min allowed and 1 min
  blocked [V :91]. A box may open 120 streams a minute [V `docs/outbound-hosts.md:41`]. One box opening
  random names under a domain it controls is therefore up to 172,800 `.com` requests a day [I]. The
  100-new-hosts-a-day cap makes `.com` answer "refused", but every new name is still a request [I, from
  the same cache rule].
- **Who is hurt.** As B3. Any account with a box can trigger it, from their own root shell, and the
  hub cannot tell this from its own harness [V `docs/outbound-hosts.md` "The known risk"].
- **Smallest change (one commit, hub).** At most N hosts not yet seen per tunnel per hour (e.g. 10),
  refused locally after that. When `.com` says the daily cap is reached, refuse every unseen host
  locally until 00:00 UTC.

### B5. Store builds and live `.com` are already out of order; endorsed boxes lack round 2

- **Live state [V].** The webapp serves shell **v153** (`service-worker.js` on `webapp.`). `.com`
  answers `{"code":"account-not-found"}` (the 2026-10-18 account-gone code) for a made-up account. The
  relay echo is not deployed: `:8444` resets, and `/api/stats` is 404. The root wildcard is live
  (`*.flagship.services` → `149.248.216.86`).
- **Inferred [I].** `.com` therefore runs code from after `71e74bdfe` (2026-10-16, "Refuse new servers
  on .com unless an admin device signs"). The store builds are older (iOS build 4 from 2026-10-08,
  Android vc 8 from 2026-10-06) and cannot sign `flagship/auth-code-admin/v1`. So the apps people can
  install today very likely cannot add a server on a real account. The request treats "hold `.com`
  enforcement until store builds are live" (item 20) as a future decision. It has already been decided,
  by deploy.
- **Endorsed boxes [V].** The newest endorsed release is `875ad977` (2026-10-19 18:20). None of
  `857c4e163`, `bdc9408f5` (peer gate), `664ac23b3` (backup check), `40a9c0e82` (loop-volume check),
  `ef72d246f` or `3c00c279a` is in it. A new box moves to it on first boot (`firstBootUpdate.ts`). So on
  boxes today, "peer backup off" and "backups are checked" are not true.
- **Smallest change.** No code. Before the gate comes off: new store builds approved and live, an
  endorsed box release at or after `a0f167c2b`, and the `.services` deploy. Record all three as
  receipts. Correct AGENTS.md (section 9, change 13).

### B6. The peer-backup gate does not close the door

- **Failure.** The box checks `peerAllowed` only on the route for *changing* the policy [V
  `packages/server-daemon/src/backupPolicy/http.ts:68`]. A policy chosen at create time comes in through
  `adoptFromPairingJson` → `adopt()` with no gate [V `backupPolicy/policy.ts:93-104`,
  `index.ts:1245-1248`], and the peer engine runs whenever the policy is Peer [V `peerNet/engine.ts:140`].
  The webapp still offers Peer at create time (`index.html:863`, value `peer`) and in a server's Backups
  section (`views/server-backups.js:52`) [V]. Revision 4 says "the webapp is unchanged". iOS offers it
  only when the bound value is already `.peer` [V `ServerBackupsSection.swift:40`], and the create
  draft restores a saved "peer" [V `CreateServerDraftStore.swift`], so an old draft gets through [I].
- **Who is hurt.** Owners who pick it from the webapp get an unproven cross-account backup, and their
  box reserves 2/3 of its disk for other accounts. Other accounts' data lands on boxes whose owners
  were told the feature is off.
- **Smallest change (one commit).** Run the `peerAllowed` check inside `BackupPolicyStore.adopt` so
  both paths refuse. Remove the Peer radio from the webapp's create form and Backups section unless the
  current policy is Peer. Drop a saved "peer" draft on iOS and Android.

### B7. Public claims that are false (privacy product, store review)

All [V] against the pages and code named; fix in one commit, using `docs/metadata-threat-model.md` as
the source:

- `faq.html` "Can Flagship read my data?": "If we get hacked tomorrow, the worst thing leaked about you
  is your username." `.com` holds device keys, server names, heartbeat IPs, health, push tokens, orders,
  audit events, metering and invites (metadata doc §`.com`).
- `faq.html` "What if my phone is compromised?" and `docs/index.html:129`: "every key sits in the
  Secure Enclave / StrongBox ..., never leaves the chip unwrapped, and every sensitive action requires
  a fresh biometric prompt." On iOS only a P-256 wrapping key is in the Secure Enclave
  (`Keystore.swift:1618-1630`). The UMK is unwrapped and cached in memory for the session
  (`Keystore.swift:113-122`), and the account device key is kept `AfterFirstUnlock` (`:1397-1400`).
- `privacy.html` §3: "If you BYOK, prompts go directly from your daemon to the provider." The hub relay
  is on by default per key (AGENTS "AI privacy, staging and egress"; `docs/outbound-hosts.md`), and
  `.com` now stores per-host totals.
- `privacy.html` "What we collect" omits most of what the metadata doc lists. §2.5 says Fly logs SNI
  for 30 days, while the metadata doc says `.services` "keeps no per-connection log". One of them is
  wrong.
- `faq.html` "Money & subscriptions": hardware refunds, "Stripe takes cards", one-tap cancellation with
  proration, a "peer-backup pool" add-on. Nothing is sold at launch, and that is what Apple was told
  (`docs/launch-mvp.md`). This is also unlaunched-feature literature on `main`, against the branch rule
  in AGENTS.md. `terms.html` has 6 Stripe/refund/subscription mentions to check the same way.
- `faq.html` is stale in places that will mislead: "TLS-ALPN-01 today"; sharing a service has "your
  friend's box pull the source"; "object-storage buckets" (MinIO is gone); "a one-shot promo path that
  shows a fresh key" (now Flagship Inference); "Outbound network access is allowlisted in the manifest"
  (now owner-approved access lists). "If you shut down ... your TLS cert keeps renewing ... as long as
  DNS resolves" needs `.com` for DNS-01 [I], and "one DNS change away" ignores that we own
  `flagship.services`.
- Homepage "We structurally cannot read your data" (`index.html:1008`) and `abuse.html`. We control
  the `flagship.services` zone, so we can obtain a publicly logged certificate for any box name. The
  apps pin the box's STK-signed certificate; a browser visitor does not [I]. Say it the way the
  metadata doc does: content is protected, and mis-issuance would be visible in CT.
- `abuse.html` says nothing about outbound connections from the relay's address, which the AI egress
  now makes possible. Add a section, using the same address as `docs/outbound-hosts.md`
  ("security@"), not a second one ("abuse@flagship.services").
- Live apex CAA names `digicert.com`, `pki.goog`, `ssl.com` and `comodoca.com` as well as
  `letsencrypt.org` [V `dig CAA flagship.services`]. AGENTS says the apex CAA is Let's Encrypt only. This
  is probably Cloudflare's Universal SSL adding its CAs [I]; nothing in the zone is proxied, so
  switching it off should leave Let's Encrypt only.

### B8. "Preview" is not shown, and Linux does not meet the repo's own definition

- `docs/launch-mvp.md`: "Windows and Linux Studio ship marked 'preview'". Neither the homepage, nor
  `/studio`, nor either Studio says Preview [V: grep, no match outside the coming-soon gate].
- `docs/preview-criteria.md` says a surface "may be called Preview only if all of these have passed on
  real hardware" (install, pair, first boot, restart, stop/update, recover). Its own table then lists
  Linux as Preview while saying none of 1-6 has run, and Wear as Preview without a hardware run [V].
  By its definition, Linux and Wear cannot ship as Preview at GA. Windows passed parts of 1-4 on
  2026-10-18 (AGENTS), on 0.1.3 plus a CI appliance, not on what is published now.
- **Smallest change (one commit).** Show "Preview" next to the Windows link (homepage, `/studio`) and
  in the Windows Studio's title. Hide the Linux link and leave the Wear APK out of the Play upload
  until each has a hardware run (or rename that tier honestly, e.g. "Experimental", and say so). Fix
  the criteria table.

## 3. App (iOS, Android, Wear)

- **First run, pairing.** iOS pairing over `/qr-pipe` has no two-device run (receipt). Adding a device
  is admin-only in the webapp. AGENTS says iOS/Android "don't gate Add device to admins" yet, and `.com`
  can't enforce it [V AGENTS "Adding a device is admin-only"]. A non-admin phone can therefore still
  offer Add a device [I]. That is not a GA safety issue, but the parity row is open.
- **Server page, backups.** "Back up now (with a passcode)" sits above Migrate as decided. The backup
  check (`checkDataFile`) proves size, SHA-256 and that every frame decrypts with the in-memory content
  key [V `serverArchive/format.ts:155-170`]. It does **not** reopen the `.flagship-backup` file through
  its account or passcode slot, and it does not look inside the dumps. Activity now says "Backup ready
  and checked" [V `service.ts:383`]. A slot-wrapping bug or a truncated `pg_dump` would still read as
  checked. Change 10.
- **Migrate.** See B1. Apart from that, the hand-off gate is careful: release before claim, final delta
  flushed, rebind before successor-confirm, power off without wiping on timeout [V
  `serverMigration.ts:515-546`, `decommissionConsumer.ts:405-445`].
- **Update, account removal.** Not exercised. The code paths have gym scenarios (AGENTS); I did not
  run them. `account-not-found` comes back before any auth check, which tells anyone whether an account
  name exists [V live]. Names are already public in CT logs (metadata doc), so it is low.
- **Relay echo.** The echo server strips a PROXY v1/v2 header and replies with `dst` [V
  `apps/web/src/lib/addressEcho.ts`]. Fly ends TLS on `:8444` with `proxy_proto` [V `fly.toml:91-100`].
  Both phones verify `flagship-services.fly.dev` with hostname checking and compare parsed address
  bytes, so the uncompressed IPv6 the echo prints still matches [V `RelayAddressCenter.kt:113-135`,
  `RelayFallback.swift:55-69,98-125`]. A recommended address must pass the pinned probe and the echo;
  the seed is exempt [V `RelayAddressCenter.kt:168`]. Two caveats. (a) If Fly writes an IPv4 connection
  as an IPv4-mapped IPv6 `dst`, Android maps it back to IPv4 and matches, while iOS `IPv6Address`
  gives 16 bytes and fails; only the live receipt will tell [I]. Failure falls back to the seed, which
  is safe. (b) The echo is not live (B5).
- **iOS shim.** The limits (32 clients, 5 s head, 60 s idle) and suspend-on-background are in [V
  `RelayFallback.swift:325,389-400,582-595`]. The crash fix is real: the old session is finished 60 s
  later, not invalidated [V :594]. New defect [I]: `session(for:)` reads `forwarder` under the lock,
  then starts a shim outside it. Two concurrent first callers both start one, the second overwrites
  `forwarder`, and the first listener is never stopped, including on background [V :614-622]. Change 12.
  I can't settle whether another app can reach the loopback port; my guess is that iOS does not isolate
  loopback between apps that are running [G].
- **Notice lock.** Off in native release builds: `SecurityNoticeFeatures.lockEnabled = false` outside
  DEBUG; Android `Variant.noticeLockEnabled()` [V]. The native lock exempts `POST /api/secret-requests`
  and `boot./api/boot/response` [V `UpdateLock.kt:58-59`, `UpdateLock.swift:47`]. The **webapp lock is
  not gated off and has no boot exemption** [V `apps/web/public/webapp/lib/updateLock.js:51-56`;
  `lib/bootApproval.js` uses those routes]. That is less dangerous, since the webapp updates itself, but
  it contradicts "lock gated off". Change 11.
- **Diagnostics.** The codes and a 50-entry log exist on both phones; no screen shows them [V doc]. As
  decided. Support will have nothing to ask a user for.
- **Accessibility.** Teal state borders at 2.3:1 ship as a known issue (owner decision). I did not
  audit beyond that.
- **Android DNS-block handshake.** I didn't find a cause in `LanAwareSocketFactory` (it creates plain
  sockets, so OkHttp keeps the SNI) or in the relay's SNI parser (it buffers across TCP segments and
  errors only when one handshake message spans TLS records) [V `LanDirect.kt:254-290`,
  `packages/tunnel-protocol/src/sni.ts:24-55`]. Next places to look [G]: whether the
  closed handshake comes from Fly's `:443` (raw TCP, dedicated IPv4 only) being dialed on the IPv6
  seed through a network that breaks v6, and OkHttp's `ConnectionSpec` fallback.
- **Wear.** No hardware run, not in any receipt. See B8.

## 4. Studios (Mac, Windows, Linux)

- **What is published is old.** Mac DMG 2026-10-14; Windows/Linux `studio-v0.1.3` 2026-10-15, with 18
  commits to `apps/builder-windows|builder-linux|desktop-shared` and 11 to `apps/builder-mac` since
  [V `git log studio-v0.1.3..HEAD`]. The published Studios miss the LUKS fix (B2), the unlock-watch fix
  (the 30-minute "taking longer than expected"), the not-enough-memory message and the
  graceful-restart fixes [I from AGENTS dates]. `release/version.json` says Studio 0.2.0; the manifest's
  "versions ok" doesn't compare that with what is served [V].
- **Install, first boot, UAC, stop/start.** Not exercised; all are receipts. The UAC restart and the
  republished-appliance first boot have no run after their fixes (receipts
  `windows-uac-restart`, `windows-hosted-vm-first-boot`).
- **OS and runtime floors against the owner's "oldest still safe" rule.** `/studio` says "Windows 10
  and 11" [V `studio/index.html:96`]; Windows 10's consumer extended security updates ended in
  October 2026 [I, check Microsoft's page]. The Windows Studio targets `net8.0-windows` [V
  `FlagshipBuilder.csproj:5`]; .NET 8 support ends 2026-11-10 [I], three weeks after today. The Linux
  AppImage "needs Node.js 20 or later" [V]; Node 20 left support in April 2026 [I]. Mac: macOS 15,
  consistent.
- **Mac hosting.** `docs/launch-mvp.md` requires "a diagnosis of the guest memory corruption seen in
  home2's VM" before launch. The cache-mode change is "unverified that it cures it" (AGENTS), and no
  receipt tracks it [V].
- **Preview honesty.** See B8.

## 5. Site and webapp

- Store links resolve: App Store 301 to "flagship-hub", Play 200; Studio downloads 200/302 [V curl].
  The homepage badge says "v0.2 Beta" [V `index.html:918`], matching `release/version.json`.
- False or stale claims: B7.
- No "Preview" anywhere: B8.
- `privacy.html` and `terms.html` are dated 2026-10-14, before the outbound host list and the metadata
  doc [V]. They need a new date with the B7 changes, and the terms' 14-day notice rule applies to
  material changes [V `terms.html:191`].
- The FAQ promises "escrow instructions for the build pipeline before public launch" [V]. Either
  publish them or remove the promise.
- The webapp is behind `main` by two shell versions (live v153, `main` v155) [V]. That's normal
  between deploys.

## 6. Control plane and relay

- **Echo.** Correct as written, not deployed (B5, section 3).
- **Outbound host list.** Migration 0106 is additive with `IF NOT EXISTS` and seeds four hosts [V].
  Nothing in it names a user [V]. The amplification is B4, and default-allow is section 7, item 2. With
  `.com` unreachable, the hub falls back to the compiled-in providers [V `outboundHostPolicy.ts:81-83`],
  which fails safe.
- **`/api/stats`.** Requires `x-usage-secret` with a timing-safe compare; it answers 503 when the
  secret is unset [V `apps/web/src/server.ts:368-383`]. Not live yet.
- **Deploy order.** 0106 before the Worker, as the docs say. The `.com` side works without `.services`.
  `.services` without 0106 makes `/api/outbound/check` fail, and the hub then allows only known
  providers [I]. `release.sh` and AGENTS deploy `.services` with `--strategy=immediate` [V
  `scripts/release.sh:280`], against `fly.toml`'s own reasoning for `rolling` + DrainNotice [V
  `fly.toml:18-27`]. At GA real boxes will be attached, so use rolling (change 14).
- **Routing race fix.** Correct: the upsert's `WHERE routing.rck_pubkey_hex = excluded.rck_pubkey_hex`
  plus `meta.changes` refuses a different RCK, while a same-RCK re-register still counts a change [V
  `packages/storage/src/d1.ts:689-720`].
- **What works on the gym but not on Free.** The daily request cap, not CPU (B3). The gym Worker does
  not enforce Free limits (AGENTS). Both rounds measured CPU and neither tested the request budget.
- **CA lease.** The renewal landed (`072ee32de`, ends 2027-01-17) [V]. AGENTS still lists it as urgent
  [V]. Boxes read the lease from their own checkout [V `releaseVerifier.ts:72-76`], so a box still
  below `072ee32de` loses CA-checked features (share accept, relay blessing) after 2026-11-05 unless it
  updates [I]. Current endorsed releases contain it [V], and from now on every box needs an update at
  least every ~90 days.

## 7. Where I disagree

Owner decisions first, as asked, listed apart from the findings.

1. **Workers Free for GA (decision 3).** The binding limit is 100,000 requests a day, not CPU. It
   puts boot unlock, recovery and `voi.ci` behind a limit that one person can exhaust (B3, B4) and
   that ~75 accounts reach by themselves. Workers Paid removes the hard stop; its usage is billed
   instead [I, Cloudflare's published plans]. An account cap (B3's change) is the least I would ship
   on Free, and it makes GA an invite list.
2. **Outbound hosts allowed by default (decision 6).** Allow-by-default makes the hub an HTTPS tunnel
   to any public host for anyone with a box, from the same Fly address that carries every inbound
   connection. Abuse reports against that address risk the relay itself (a Fly suspension, or an IP
   on blocklists) [I]. The hard part (recording new hosts) is already built. Default new hosts to
   `blocked` with a "pending" note, and keep the seed plus Flagship's own inference host allowed.
   A new provider then needs one `npm run outbound-hosts -- allow`, and the box's message already
   tells the user to switch the relay off for that key.
3. **"Installed boxes keep their old slot; they age out"** (LUKS doc, 2026-10-18). The passphrase is
   public. An endorsed update can test it (`cryptsetup open --test-passphrase`), kill only that slot,
   and run the existing single-slot assertion, with the same code the installer now uses. That is one
   commit and closes a full-disk-encryption bypass on every USB-installed box.
4. **Migrate (decision 5).** I agree with "Migrate ends with the old server gone". I disagree that the
   current code meets it; see B1.
5. **Teal (decision 7).** No objection to shipping it as a known issue. It fails WCAG 1.4.11 for state
   borders, so do not claim WCAG AA anywhere.

On the round-1 findings and round-2 changes:

- **3.3 "CPU could fail in production" was overstated:** can't confirm or refute. I had no production
  token. Both rounds missed the requests-a-day limit, which is the real Free-plan risk.
- **3.3 "the pin doesn't prove the first hop":** confirmed [V], and the echo is the right shape.
- **3.3 "Migrate's wipe is by design":** refuted for a failed restore (B1).
- **3.3 "the iOS forwarder isn't our server":** agreed. Whether other apps can reach it is still open
  [G].
- **3.2 routing race, crash path, backup check moved, schema ledger:** all four confirmed in code [V].
  The backup check's scope is narrower than "opened" suggests (section 3).
- **Round 2, "Peer backup: fixed":** not fixed (B6).
- **Round 2, "Notice lock: fixed":** native only (section 3).
- **Round 2, "Release evidence: fixed":** the manifest misses what `docs/launch-mvp.md` requires on real
  hardware (a phone-created box updated from all three apps then deleted; losing a phone and
  recovering; the Mac VM memory-corruption diagnosis; LAN-direct on a metal box's Wi-Fi). It has no
  check that published Studios, appliances and store builds match `main`, and two
  `android-auto-unlock` globs match no file (`*AutoUnlock*`, `*utoUnlock*`). The fix touched
  `PendingLeaseStore.kt`, which no receipt watches [V `git show --stat 64df9098c`].
- **Round 1, item 7 (one D1 query for the join migration), declined:** fine for CPU. A D1 call counts
  against the per-request query limit on Free, not against the 100,000 requests a day [I].
- **Scope conflict nobody raised:** `docs/launch-mvp.md` puts free AI credits in the launch.
  `preview-criteria.md` says Flagship Inference is "off", and `.com` reports it unavailable while
  `FLAGSHIP_INFERENCE_ENDPOINT` is unset [V `handleFreeAiStatus`: `available = block !==
  "unconfigured"`]. As things stand, building an app at GA needs the user's own AI key. The owner has
  to choose: deploy the shim, or change the MVP and the store copy.

## 8. What I could not judge

- Anything on a device, a Windows PC, a Linux desktop or a real box (all 14 receipts).
- Production Worker CPU, `exceededCpu` counts and requests per day (no Cloudflare token).
- Which commit live `.com` runs, and whether 0106 is applied (I can only bound it from below: ≥
  2026-10-18).
- What Fly writes in the PROXY header's `dst`.
- Whether iOS lets another app connect to the shim's loopback port.
- The contents of the published DMG and 0.1.3 assets (I inferred from dates and did not unpack them).
- App Store Connect and Play Console state, export-compliance answers.
- Cloudflare's exact behaviour past the Free daily limit, and whether Universal SSL is what adds the
  extra CAA records.
- The home2/leticia memory and disk corruption.

## 9. Changes and proofs

### Concrete changes, one commit each, most blocking first

1. **Box:** finish a restore only when every app is restored, so Migrate never acks or wipes after a
   partial restore. Add a test with one failing app. (B1)
2. **Apps (web, iOS, Android):** at Migrate's hand-off step, list failed apps and keep "Confirm" off.
   (B1)
3. **Box:** apply `peerAllowed` inside `BackupPolicyStore.adopt` (the create-time path too). (B6)
4. **Webapp, iOS, Android:** remove the Peer choice at create and in Backups unless the policy is
   already Peer; drop a saved "peer" draft. (B6)
5. **Hub:** a per-tunnel cap on unseen-host checks, and a local refusal once `.com` reports the daily
   cap. (B4)
6. **`.com`:** an enforced account cap with a refusal sentence, if Free stays. (B3)
7. **`release-manifest`:** fail when a published Studio or appliance predates `09efc52a5` or does not
   match `release/version.json`; add receipts for the `launch-mvp.md` hardware list; fix the two dead
   `android-auto-unlock` globs and add `PendingLeaseStore.kt`/`PhoneEndpoint.kt`. (B2, section 7)
8. **Box:** on update, find and kill the public burn-passphrase slot, then assert a single slot.
   (Section 7, item 3)
9. **Site:** rewrite the FAQ's privacy, services, money and "if we go away" answers. Correct the
   privacy page's lists, the BYOK sentence and the log retention against `docs/metadata-threat-model.md`.
   Add outbound abuse to `abuse.html`. Add the DNS/CT caveat to "structurally cannot read". Re-date
   privacy and terms. (B7)
10. **Site and Studios:** a "Preview" label on Windows (homepage, `/studio`, app title). Hide Linux and
    hold the Wear upload until a hardware run, or rename the tier. Windows 11 only; Node 22+ for the
    AppImage. Fix the `preview-criteria.md` table. (B8)
11. **Box:** the backup check also reopens the `.flagship-backup` file through its account slot (and
    the passcode slot when present) and lists each dump (`pg_restore --list`, `tar -t`). (Section 3)
12. **Webapp:** gate the notice lock off as on native, or add the two boot routes to
    `updateLockAllows`. (Section 3)
13. **iOS:** serialize the shim start in `RelayRoute.session(for:)` and stop a losing listener.
    (Section 3)
14. **`release.sh`, AGENTS, `final-deploy.md`:** deploy `.services` with `--strategy=rolling`, as
    `fly.toml` intends. (Section 6)
15. **AGENTS.md:** the CA lease is renewed; `.com` is live at shell v153 with 10-18 code (so admin-only
    create is live against the old store builds); the appliances were republished from `072ee32de`;
    the wildcard is live with extra CAA issuers; the newest endorsed release `875ad977` has none of
    round 2. (B5)
16. **Windows Studio:** move from .NET 8 (support ends 2026-11-10) to .NET 10. (Section 4)
17. **`release-guard.sh`:** enumerate files with `git ls-files`, not `grep -r` over the tree (the test
    hangs in a checkout with worktrees). (Section 0)

### Proofs the owner must produce (hardware or production)

1. **Now, not at GA:** republish all three Studios from `main`. Then a USB install from each shows
   exactly one LUKS slot. (B2)
2. **Before the gate comes off:** new store builds approved and live, then an endorsed box release at
   or after `a0f167c2b`, then the `.services` deploy. Record each as a receipt. (B5)
3. 72 hours of production requests per day and `exceededCpu` (`npm run ops -- workers --hours 72`,
   dashboard), plus the decision on Free or Paid. (B3)
4. A Migrate in which one app is made to fail: the old server stays and is not wiped. (B1)
5. The 14 receipts `npm run release-manifest` lists. Add to them a phone-created box updated from all
   three apps then deleted, a lost-phone recovery, LAN-direct from both phones on a metal box's Wi-Fi,
   and a decision on the Mac VM memory corruption (`docs/launch-mvp.md`).
6. `relay-echo-live`, checked on IPv4 and IPv6, noting whether `dst` comes back IPv4-mapped. (Section 3)
7. `npm run zone-health` after switching off Universal SSL on `flagship.services`, with CAA showing Let's
   Encrypt only. (B7)
8. A decision on Flagship Inference at launch: deploy the shim, or remove free credits from the MVP and
   the store copy. (Section 7)
