# Session handoff — portable cold-start (works on ANY dev machine)

**Read this FIRST.** This file is the in-repo, machine-portable source of
truth. The richer agent-memory (`~/.claude/projects/.../memory/
project_resume_2026_05_16.md`) is local to one machine and the harness
TaskList does NOT persist across sessions — so the authoritative backlog
lives **here, in git**. Rebuild your task list from §3 below.

Last updated: 2026-05-18 (**v1-launch program session 8/9**, Mac/darwin
box. **★ READ §0 TOP ENTRY FIRST — it is the full resume anchor.** The
top entry supersedes the older PR#6/`df992f2` narrative in this header:
PRs #5/#6/#7/#8 are MERGED, pin advanced to **`393b7a7`** (PR#8), the
PIN-echo+EBADF bug from #7's reader is fixed at the OS level, and the
owner ran `selftest-pin` in their OWN real terminal — **PASS: no echo,
no crash**. Both gates re-verified at the pin (maintainers tsc clean +
386/386·37; flagship tsc clean), `pcsclite` re-installed. **NEXT = the
owner rotates the exposed PIV PIN, then re-runs the `ca`-only ceremony
in their own terminal** (nothing signed yet; `.maintainers/` clean).
**GATE-B IN PROGRESS (s8 cont.):** the user provisioned both YubiKeys
(on-token Ed25519 slot-9c, PIN/PUK/PIN-protected-mgmt-key hardened);
the orchestrator implemented + **independently LIVE-verified** the
native libpcsclite `connectPcscChannel` binding **and fixed the
pre-existing GET-METADATA pubkey-parse bug it surfaced** (real metadata
is `04→86`, not GENERATE's `7F49{86}`) — the production
`loadSignerPubKey("yubikey-piv:slot=9c")` path now returns the real
slot-9c oracle `2137e739…71d7` 3/3, PIN+PUK counters provably untouched.
**Governed PR #6 (`feat/gate-b-pcsc-binding` `59363fa`) is OPEN** —
awaiting the human merge → re-pin → the signed genesis ceremony.
Net of session 8: the **entire agent-side Phase A** (the maintainers
protocol product: c4.6 de-version + c4.7 spec + c5 conformance +
ceremony hardening + governed PRs #3/#4/#5 merged & re-pinned `df992f2`
+ the `@maintainers/protocol`→`@ibisllc/maintainers@0.1.0` rename)
**AND the agent-doable Phase E** (marketplace security-scan service
built `9aac1ec`; iOS / Recovery-J.3-J.4 / E2E-rig-13-scenarios-CI
verify-before-trust-confirmed already built) are **COMPLETE, gate-green
(flagship `95f88a7` 2567/227, maintainers `df992f2` 370/36), pushed.**
**Everything still open is HUMAN / CREDENTIAL / HARDWARE / CI /
LIVE-EXERCISE gated** (Gate B genesis; Phase C bake-the-pin blocked on
it; Phase F ISO/VPS = env-gated here [no qemu/docker/Linux; x86_64] +
paid-VPS; §S live exercises; iOS TestFlight; Android on a JDK box; the
deferred `npm publish` — the user's pasted npm token is BURNED, revoke
it). The orchestrator faked nothing and stopped cleanly at the
boundary; §0 top entry has the precise copy-pasteable unblock runbook
per gate. (Prior session-8 narrative follows for history.) Thin-
orchestrator + ONE fresh subagent for the
chunk, verify-before-trust: env-sync drift caught at cold start (local
`maintainers/` clone stale at `dc48559`/c1 — non-destructively
ff-only-merged to `208978a`/c4.5e; both baseline gates re-verified green
BEFORE work). c4.6 = pure rename + Mandate wire `version 2→1` + canonical
tag `maintainers/mandate/v2→/v1`; **NOT a trust-model change** (L1/L2/L3/
D3 untouched). maintainers **`a8ac151`** (`feat/keyfile-register`, 38
files, 7 `git mv` renames, 330/33) + flagship **`c5995c9`** (`main`, 13
files, regenerated `.maintainers/` artifact to v1, 2529/225) — both
pushed; pin UNCHANGED `833fa45` (re-pin is the later governed step). ★
Subagent's load-bearing find (verify-before-trust confirmed it): the
real canonical-tag site was the local `joinTagged2` builder (hardcoded
`/v2`), DISTINCT from the descriptive comment — renamed
`joinTagged2→joinTaggedMandate` with `/v1`; that is what makes
`mandatePinHash` genuinely change (the `.maintainers/` mandate
signatures changed, KeyFiles byte-unchanged, regeneration
byte-deterministic). **c4.7 spec ALSO LANDED** (maintainers `f509849`:
`docs/spec/v1.md` rewritten 607→971 under the final name to the LOCKED
model, authored against the landed code as ground truth; section
numbers preserved). **c5 ALSO LANDED** (maintainers `6acca14`: spec
§7.1 published-fetch layout + §12 Conformance; a dependency-free
`fetch()` reference client `fetchClient.ts`; a deterministic generator
+ the portable artifact `maintainers/conformance/` (17 vectors:
4 happy + all 10 mandatory fail-closed negatives + totality + CA-no-pin)
+ `conformance.test.ts` replaying every vector through the LANDED
verifier; maintainers 330/33 → **358/35**, flagship 2529/225).
**Ceremony-tooling hardening ALSO LANDED** (maintainers `10979ab`:
typed PC/SC error taxonomy + the no-hardware prompt+wait+retry UX
+ dry-run byte-fidelity, up to the gate — the native libpcsclite
binding deliberately NOT written blind; flagship `6cd2c55`:
ca-operations Operation 0 reconciled to the de-versioned
`upsert-mandate` reality; maintainers 358/35 → **370/36**, flagship
2529/225). **PR #3 (14-commit Phase-2 spine) + PR #4 (npm
packaging-prep) were both MERGED by the maintainer; agent re-pinned
`scripts/maintainers.pinned-sha` → `8e8915e` (PR#3) then → **`4a272b9`**
(PR#4, the current pin; flagship `aceb204`), both gates GREEN at each
pin.** **★ npm-name finding (verify-before-trust):** `@maintainers/
protocol` is PERMANENTLY unpublishable — an unrelated unscoped
`maintainers` pkg (another npm user) blocks creating the `@maintainers`
npm org. **Renamed `@maintainers/protocol` → `@ibisllc/maintainers`**
(free; clean `github.com/ibisllc/maintainers` provenance) — maintainers
`5f93129` (**governed PR #5 OPEN**, 43 files, pure specifier swap, no
semantic change) + flagship `11f3a06` (consumer rename: server-daemon +
the 2 `.mjs` + lockfile + the regenerated `node_modules/@ibisllc/
maintainers` workspace symlink [old `@maintainers/protocol` scope dir
gone] + a prose/comment sweep of the active flagship docs so the final
name never churns again). Orchestrator re-verified both gates
(maintainers 370/36; flagship 2529/225 via the new symlink) + `npm pack
--dry-run` → `@ibisllc/maintainers@0.1.0`. **PR #5 MERGED;
re-pinned `maintainers.pinned-sha` → `df992f2` (flagship `0eddcb8`),
both gates GREEN at the pin (maintainers 370/36; flagship 2529/225 via
the `@ibisllc/maintainers` symlink). ⇒ THE ENTIRE AGENT-SIDE PHASE A IS
COMPLETE.** Now in **Phase E** (per the user's "proceed critical-path").
**iOS verified code-complete + GREEN at current HEAD** (build SUCCEEDED
+ **232 XCTests 0 failures**, grown 110→232; zero `@maintainers`
coupling so unaffected by this session) — the ONLY remaining iOS work
is the **user-side TestFlight gate** (punch list in
[[project-testflight-blockers]] / §S: wrangler APNs secrets, Apple
"Associated Domains" tick, Xcode Archive+upload, ASC metadata,
real-device push smoke, 5 testers — none agent-advanceable). **Android
real-impl is environment-gated on THIS Mac (no JDK → review-only;
needs a JDK/Android-SDK box).** **★ THE AGENT-DOABLE PHASE E IS
COMPLETE:** marketplace security-scan service BUILT (`9aac1ec`, gate
2567/227); Recovery J.3/J.4 verified code-complete+wired+tested green
(gap = lost-phone LIVE exercise = Phase G, NOT code); the E2E rig + ALL
13 plan scenarios (S1–S13, S7 folded in `s06-long-lived-lease.spec.ts`)
+ `.github/workflows/e2e.yml` are ALL already built (backlog #15; gap =
a green run on a real GitHub Actions runner = CI-execution gate, the
CLI cannot trigger Actions — same seam as build-iso.yml; NOT code).
iOS code-complete+green (human TestFlight gate). The only net-new
Phase-E code needed was the scanner. **Next agent chunk = Phase F's
agent-doable part: build the personalized ISO via the reproducible
path + smoke it locally with QEMU/KVM** (the real-VPS boot is a paid
credential gate — user supplies the API token). DEFERRED
human/credential follow-ups (off the critical path,
user's pace): create the `ibisllc` npm org + a fresh `@ibisllc`-scoped
bypass-2FA token (the earlier pasted token is BURNED — revoke it) →
`npm publish @ibisllc/maintainers@0.1.0` → flagship drops
`pull-maintainers.sh`+`maintainers.pinned-sha`+the workspace symlink;
**HUMAN Gate B** genesis ceremony (runbook armed in
`docs/ca-operations.md` Operation 0); iOS TestFlight; Android on a JDK
box. The orchestrator PAUSES at each human gate; it does NOT fake the
publish/ceremony/upload. See §0 (top entries) for full detail.
PRIOR HEADER (s7 — the c4.5 v1→v2 cutover) follows for history:
**THE ENTIRE c4.5 v1→v2 CUTOVER LANDED — v1 is fully removed; v2
is the SOLE trust path.** verify-before-trust per chunk: **c4.5a**
`650fee2` (worker) · **c4.5b** `429a57c` (web-ui, signing views deleted
#31) · **c4.5c** `fba0657` (extension) · **c4.5d** `616b8f9` (cli,
collapsed verbs deleted) · **c4.5e-pre** flagship `def22ca` (4 missed
flagship v1 consumers re-based) · **c4.5e** `208978a` (protocol v1
removal). **★ Critical invariant: flagship resolves `@maintainers/
protocol` via a LIVE node_modules symlink to the maintainers working
tree, NOT the pin — so a protocol change DOES hit the flagship guard;
the `.mjs` scripts are invisible to a tsc-graph grep (vitest-only).**
PRIOR HEADER (s6) follows for history:
**Phase 2 v2 spine — the entire flagship-side migration LANDED.** s6:
**c4.1** `6cfee83` (maintainers `feat/keyfile-register`: the
v2 endorsement layer, additive — `verifyChainOfEndorsementsV2`/
`verifyCaEndorsementsV2`/`authorizedCaKeysV2`, holder-signs; maintainers
**371/36**), **c4.3** `5fb2fdf` (flagship: #30 generalised —
`MAINTAINER_PINNED_MANDATE_HASH`), **c4.4** `ff8ce91` (flagship: the
LIVE trust consumer `releaseVerifier.ts`/`caTrustChain.ts` migrated to
verify-forward-from-pin — **the flagship gate is now a REAL v2 consumer
check**, new honest baseline **2529/225**, tsc clean both). flagship no
longer imports ANY v1 Mandate-path symbol. Branch pin UNCHANGED
`833fa45` (never pin an unmerged tip). **ALL FOUR consumer re-bases
LANDED s7: c4.5a (worker) `650fee2`, c4.5b (web-ui) `429a57c`, c4.5c
(extension) `fba0657`, c4.5d (cli — collapsed verbs deleted) `616b8f9`
(maintainers now **382/37**, flagship guard **2529/225** unchanged). No
consumer imports v1 anymore. Next = c4.5e (protocol v1-removal,
STRICTLY LAST — the only remaining v1 holder).** The
maintainers v1→v2 cutover is CONSUMER-FIRST decomposed per the s7
verify-before-trust correction — the "one atomic commit" call is
SUPERSEDED; ~30 files / 5 pkgs incl. the forgotten `extension`;
sub-sequence c4.5a worker ✅ → b web-ui ✅ → c extension ✅ → d cli ✅ → e
protocol-removal-LAST, each its own green commit, v2 coexists with v1
until e; each the next attentive START, NOT a tail-bolt → **c4.6
de-version rename** (user decision s6: "v2" is a
transitional dev artifact — the protocol is UNRELEASED; drop the `V2`
suffix + Mandate envelope `version 2→1` + tag `maintainers/mandate/v2→
/v1`; MUST precede c5/Gate B as it changes `mandatePinHash`) → c4.7
spec → c5 → governed PR → re-pin → npm publish →
**THEN** Human Gate B. The prior "c4.2" (separate additive Envelope
rework) was deleted as over-decomposition (folds into c4.5). Phase-1
Gate B remains the only open Phase-1 item, downstream of the v2 redesign
merge+re-pin. See §0 (session 6 entry) for the full per-commit detail.)

## 0. Drift log (verify-before-trust findings, newest first)

- **2026-05-20 (v1-launch s9 cont. — Plan A live-run attempt
  EXPOSED two architectural gaps; checkpoint before refactor):**
  Drove the operator CLI (`node scripts/sample-user.mjs create
  demo-alice --display "Demo Alice"`) against real Hetzner from
  the operator's interactive shell. **14 incremental Hetzner-
  client bug-fixes landed** (`ac0dc27` → `4027246`), making the
  CLI walk all the way from D1 row reserve through ISO build /
  R2 upload / Hetzner provision / rescue-mode + `dd` / reboot
  cleanly. Then surfaced the two REAL blockers we hadn't yet seen:

  **Gap 1 — `synthesizeBlob` is OFFLINE-ONLY.** The personalize-iso
  CLI has two modes (`packages/iso-personalizer/src/cli.ts:8-13`):
  `synthesizeBlob` (self-signed; "useful for offline tests that
  just need the trailer to round-trip") vs. `--blob-json` (uses a
  REAL build ticket from `.com`; what the harness's e2e mode
  uses, per cli.ts:139-140). My Phase E CLI calls the
  personalizer in synthesizeBlob mode — so the daemon's
  first-boot `/api/server/register` is rejected by `.com`
  because `.com` never issued the trailer's serial. The install
  silently never completes; `/api/users/demo-alice/pods` never
  shows the daemon. **The whole `create-sample-user` flow needs
  to switch to mint-real-ticket-via-.com THEN `--blob-json`
  personalize**. Roughly: derive deterministic IRK from username
  → claim username with that IRK → mint auth-code → mint
  build-ticket → install blob → pass to personalize via
  --blob-json.

  **Gap 2 — `/api/users/<u>/pods` returns HTTP 500 for ALL
  users** (probed with both `demo-alice` AND the real
  `harry11911a`; both 1101). This is a Worker-wide bug, NOT
  demo-specific. Hypothesis: stale column reference fallout
  from the App→Service rename — `daemon_status.apps_served` →
  `daemon_status.services_served_json` migration in-place but
  the prod D1 may have only the old column. `handleGetUserPods`
  at `packages/control-plane/src/podInventory.ts:62` reads
  `status.servicesServedJson` — if D1 still has the old
  `apps_served`, the in-Worker read returns undefined and the
  subsequent `JSON.parse(undefined)` throws an uncaught
  exception → Cloudflare 1101. Needs a prod-D1 column probe
  + (a) a `0031_daemon_status_services_served.sql` migration
  if the column doesn't exist, or (b) handler-side tolerance
  for the legacy column name.

  **What's GREEN at code level** (all on main; tsc + vitest +
  iOS xcodebuild + Android gradle all clean):
  - Plan A Phases A-E shipped + 14 Hetzner-runtime fixes;
    the CLI walks the full chain to a `temp server id=N;
    awaiting daemon + ACME…` state. The only thing that
    doesn't work past that is the daemon registering.
  - Plan B Phases 1-5 shipped; account-type + TOTP +
    quarantine + audit + push fan-out all in.
  - Mobile mirrors (iOS+Android+webapp) for both plans.

  **What's RED at runtime:**
  - `/api/users/<u>/pods` 500 (probably stale column).
  - `synthesizeBlob` path can't register on .com — the WHOLE
    Phase F live test is blocked on this.
  - Plan A Phase F (live e2e of the demo flow) → NOT
    achievable until the --blob-json refactor lands.

  **Action items captured for the next session** (see
  `docs/next-session-prompt.md`):
  1. Diagnose + fix `/pods` 500 (probably a 1-line column-name
     migration or handler patch).
  2. Refactor `scripts/sample-user.mjs` to mint a real auth-
     code + build-ticket against `.com` BEFORE personalizing —
     using deterministic IRK derived from the demo username.
  3. Switch the personalize step from synthesizeBlob to
     `--blob-json` with the real install-blob envelope.
  4. Live re-run; iterate until the daemon actually registers
     and the green padlock appears.
  5. Mobile e2e: open iOS / webapp, type `demo-alice`, observe
     the demo-mode connect flow against the real VPS.
  6. NEW DESIGN ITEM: corporate / restricted-device addressing
     (`harry` vs `harry.ipad` → `USERKEYHASH.*` vs
     `USERKEYHASH.DEVICEKEYHASH`) — added to Plan B v2
     hardening list.

  Heap of committed-but-untested operational state right now:
  - `0027_demo_users.sql` + `0028_account_type.sql` +
    `0029_re_pair_alerts.sql` + `0030_audit_events_v12.sql` all
    APPLIED to remote D1 in this session.
  - Hetzner secrets `HCLOUD_TOKEN` + `DEMO_PUBLIC_SSH_KEY` NOT
    yet set on Worker (operator-runnable from local shell
    instead via the CLI's own `env.HCLOUD_TOKEN`).
  - `flagship-iso-temp` R2 bucket exists with dev-url public
    access enabled (the URL is baked into
    scripts/sample-user.mjs:611-613).
  - `apps/com/wrangler.toml [vars] DEMO_PUBLIC_SSH_KEY_ID` —
    NOT set; only needed when the Worker provisions on
    /connect, which we haven't reached.
  - Personalized ISO cache at
    `~/.cache/flagship-demo-isos/demo-alice-home-faafc1b9.iso`
    on the operator's Mac. Auto-rebuilds when needed.
  - The R2 object `demo-isos/demo-alice-0eaddd0f.iso` is still
    in the bucket; orphaned but harmless.
  - `demo-alice` D1 row: `region='fsn1', size='cpx11',
    state='none', snapshot_id=NULL` — i.e. unprovisioned. Safe
    to leave; the next attempt will re-use the row idempotently.

- **2026-05-19/20 (v1-launch s9 cont. — ★★★ marathon: Plan A demo
  system + Plan B v1.2 security cascade ALL CODE-COMPLETE):** Long
  sequential dispatch driving both plans to a green tree. Test count
  rose from baseline 2675 to **2944 passing** (+269) across 248 test
  files; `npx tsc -b` clean; iOS xcodebuild 266/266; Android gradle
  439/439. Order:
  1. **App → Service rename** (TS `cdfd676` + iOS `7ece3e8` + Android
     `3b19cb3` + docs/webapp `6af50da`) — pre-release wire-format
     break; 8 canonical-bytes tags + 11 protocol types + ~40 functions
     + 24 daemon files. Avoids the Apple "app store within an app"
     framing.
  2. **Plan A — sample-user / Hetzner demo VPSs.** Six phases:
     - `c6c30fa` Phase A: rescue-mode + dd Hetzner bridge in
       `tools/vps-e2e/`. Hetzner Cloud has no custom-ISO upload API,
       so the harness now boots Ubuntu, enables rescue, SSHes in, and
       `wget | dd | reboot` the personalized ISO from a presigned R2
       URL. Harness operator-runnable; **live run gated on operator
       HCLOUD_TOKEN visibility** — agent processes can't see it.
     - `b91296d` Phase B: `docs/sample-users.md` (1500-line
       implementation-grade spec).
     - `43612c5` Phase C: Worker side — `demo_users` table, 7
       endpoints, R2-snapshot lifecycle, `*/10 * * * *` cron with
       idle reaper + provisioning poller, MAX_CONCURRENT_DEMO_VPS=5
       soft cap, `/api/users/check` extension embeds a `demoServer`
       block.
     - `f801fd1` Phase D: iOS/Android/webapp parse `demoServer`,
       render ONE real device, POST `/connect`, poll until
       `status='up'`. Backward-compat with legacy `testAccount`
       fixtures path.
     - `54dae28` + `228ef98` Phase E: `scripts/sample-user.mjs`
       operator CLI; Phase A's HetznerProvider wired live for
       `provisionTempVps` / `awaitDaemonReady` / `snapshot`.
       Operator-runnable end-to-end with HCLOUD_TOKEN +
       FLAGSHIP_ADMIN_SECRET + `~/.ssh/flagship-demo-ssh`.
     - **Phase F (live test) is operator-driven** — needs HCLOUD_TOKEN
       in a shell agent processes can't reach. To do the first live
       run:
       ```sh
       export HCLOUD_TOKEN=<token>
       export FLAGSHIP_ADMIN_SECRET=<secret>
       wrangler secret put HCLOUD_TOKEN  # in apps/com
       wrangler secret put DEMO_PUBLIC_SSH_KEY < ~/.ssh/flagship-demo-ssh.pub
       wrangler r2 bucket create flagship-iso-temp
       node scripts/sample-user.mjs create demo-alice --display "Demo Alice"
       ```
       Then verify by typing `demo-alice` on iOS/webapp.
  3. **Plan B — v1.2 security cascade.** Five phases:
     - `5970012` Phase 1: schema — `usernames.account_type/
       totp_secret_encrypted/recovery_codes_hashes_json/totp_enrolled_at`,
       `pending_re_pairs.grace_seconds/totp_required/totp_proof_consumed`,
       `push_tokens.quarantine_until`. The doc said `users` /
       `paired_sessions` but the actual tables are `usernames` /
       `push_tokens` (the daemon's `pairedSessionStore` is a separate
       JSON file irrelevant to Worker-enforced quarantine).
     - `834c99a` Phase 2: re-pair grace mapping — single ⇒ 7-day,
       multi ⇒ 24h + TOTP-required gate; 14-day quarantine on the
       caller's `push_tokens` row blocking revoke-others power; new
       `POST /api/users/:u/devices/:id/disconnect` endpoint;
       T+0 / T+1d / T+3d / T+6d / urgent push schedule via
       `*/10 * * * *` cron + bitfield idempotency.
     - `e885908` Phase 3: TOTP — `otpauth` + AES-GCM-wrapped secret
       (KEK from `FLAGSHIP_TOTP_KEK`), 10 single-use argon2id-hashed
       recovery codes, four endpoints (`/totp/enroll-begin`,
       `/enroll-confirm`, `/verify`, `/disable`), real re-pair
       verification replacing Phase 2's structural placeholder.
       Three new canonical-bytes envelopes.
     - `ae8b2dd` Phase 4: iOS/Android/webapp UI — account-type badge,
       enrollment QR + sample-code + 10-recovery-codes display gate,
       Trusted-Devices quarantine indicator + disabled
       Remove/Replace/Wipe menu entries during quarantine.
     - `1e44eaf` Phase 5: audit + push fan-out — 7 new
       `AuditEventKind` values + 3 new `audit_events` columns
       (`account_type_at_event`, `quarantine_until`,
       `recovery_method`); real push fan-out on the v1.2 events
       (re-pair initiate, T+1d/T+3d/T+6d nudges, T+7d urgent,
       quarantine-blocked-revoke, TOTP-failed-rate); `pushBridge`
       adapter `wrapForwarderAsV12Fanout` shared between route +
       cron paths.
  4. **Plan A Phase F + Plan B operational steps remain (operator):**
     - Plan A Phase F live test (HCLOUD_TOKEN + Hetzner project +
       first `create-sample-user demo-alice`).
     - Plan B: optionally enable for the operator's account — set
       `wrangler secret put FLAGSHIP_TOTP_KEK` (32-byte hex), then
       walk through the iOS / webapp enrollment flow to mint the
       first TOTP enrollment, exercise recovery code consumption,
       and observe the audit + push fan-out under live conditions.
     - No regression risk to existing accounts: the migrations
       default everyone to `account_type='single'` with the existing
       (now extended) 7-day grace.

  This entry supersedes the long sequence of intermediate Plan-A /
  Plan-B phase entries that would otherwise repeat the per-commit
  detail above.

- **2026-05-19 (v1-launch s9 cont. — ★★★ CEREMONY LANDED LIVE → "finished
  product" pillar (a) DONE):** First-ever `FLAGSHIP_CA_PRIV_HEX` mint
  on the `flagship-com` Worker, paired with a YubiKey-signed
  `CaEndorsement` (14d window). `CA_ENDORSEMENT_ENFORCE = "true"`
  flipped + deployed; three independent post-flip probes all green
  (live `/api/users/{harry11911a,hk}/pubkey-cert` HTTP 200; signature
  verifies under the new CA pubkey; `/api/health` 200). The #30
  maintainer→CA chokepoint is now armed against live prod for the
  first time — every CA-signed `UserPubKeyBinding` / `DemoDirective`
  must verify forward from the baked pin
  `5016749377…e801ae` over the committed ca-track mandate +
  `bundle.json` at the per-request `now`. Concrete identities:
  * **Hot CA pubkey:**
    `230ad9ed20e56d79e836690e351cb5538fb4aca9e509d9adc9755da81cd235cc`
  * **Endorsement signer:** YubiKey #1 (ca-track genesis holder,
    `2137e739f00550b0e6a33a75366ebaf16f66f3492f733d0a8010ba91ab5e71d7`)
  * **Lease window:** `2026-05-19T22:40:29.858Z` → `2026-06-02T22:40:29.858Z`
  * **Endorsement file:**
    `.maintainers/ca-endorsements/20260519T224029-5f02554c.json`
  * **Worker versions:** OBSERVE deploy `fec232cf…`; ENFORCE deploy
    `bd0b96c9-b6dd-498e-9019-854f82250824`.
  * **Tooling that did it:** `scripts/rotate-and-endorse-ca.mjs` — a
    new one-process driver that combines keygen + maintainers-CLI
    YubiKey ceremony + local-verify + `bundle.json` regen + `wrangler
    secret put`, ordering fail-safe (Cloudflare untouched if the
    YubiKey step fails). Reuses `rotate-ca.mjs` pure helpers; 21 unit
    tests; committed at `5f74c76`. Ceremony state at `d7f4fb6`;
    ENFORCE flip at `0e7d1fb`.
  * **Recurring chore:** re-run `node scripts/rotate-and-endorse-ca.mjs
    --days 14` before `2026-06-02T22:40:29.858Z`. With ENFORCE armed,
    a lapsed lease = hard directory-attestation outage by design;
    stand-down = remove the `CA_ENDORSEMENT_ENFORCE` line and
    redeploy.
  * **What this unblocks:** every consumer that pins
    `MAINTAINER_PINNED_MANDATE_HASH` (iOS, Android, server-daemon,
    webapp) can now consume `signedBy`-anchored `UserPubKeyBinding`s
    from `.com` and verify the directory attestation chain forward
    from the pin — the trust root is no longer "stuff in a Worker
    secret"; it's the genesis YubiKey, gated through a renewable
    lease. The §S "v1-alpha done-when" item this satisfies is the
    operational-CA-rotation discipline.
  * **What's NOT done (still human, even after this):** running an
    e2e VPS test against the live `.com`/`.services` (Phase F);
    iOS TestFlight + Android Play (live app surfaces); the UI
    follow-ons below (env-var KV pane, push-on-AI-ask, talkToUser
    chat surface, Apps→Service rename).
  Pillar (a) of the "finished product" 4-part definition is now LIVE.
  Pillars (b)–(d) (free signup/server creation, vibecoded apps with
  BYOK env-vars, CLI VPS-create harness) remain agent-doable in part
  and human-gated in part — see §0a + §3.

- **2026-05-19 (v1-launch s9 cont. — ★ ceremony starting; VPS-access
  plan; SPEC ADDITIONS for the UI follow-on; "Apps"→"Service" rename
  queued):** Owner decision: run the CaEndorsement ceremony NOW
  (Op-1b → live `.com`/`.services` CA-authorized hot keys), provision
  VPS-creation access so live e2e runs can happen, and pin four spec
  additions for the UI follow-on. Recorded:
  * **Env-var KV pane** on each app's page (signed `set-app-env` order
    from chunk `9d9c79c`).
  * **Phone-alert path** when the AI needs the user: wire the new
    `request-env-var` and `talk-to-user` session events
    (`vibeCodeSession.ts`, commit `b1120e4`) to the existing Web-Push
    RFC8291 channel — when the model pauses on a tool-call, fire a
    push to the owner's phone so they can come back and respond.
  * **Chat UI for `talkToUser`** during vibecoding — a per-session
    surface that displays the model's `talk-to-user` messages and
    POSTs replies to `/api/llm/sessions/<id>/user-reply`.
  * **"Apps" → "Service" rename in the user-facing UI** — Apple App
    Store policy concern (avoid the "app-store-within-an-app" framing
    Apple reviewers flag). Scope = user-visible labels/copy only:
    iOS Swift strings, Android `strings.xml`, webapp PWA UI strings,
    any marketing pages under `apps/web/public/` that say "Apps".
    INTERNAL code symbols (`InstalledApp`, `AppPlatform`, the
    `InstallAppRequest` protocol envelope, `/api/apps/*` routes) stay
    as-is — they're not user-visible and renaming them is unnecessary
    churn.
  **VPS-access credential model (decided here; same discipline as the
  npm token):** owner provisions a short-lived, scoped, budget-capped
  cloud token (e.g. Hetzner Cloud project-scoped, 1-day expiry, cheapest
  VPS class) in their own shell env (`export HCLOUD_TOKEN=...`); the
  harness reads it via `--provider-token-env HCLOUD_TOKEN`; the
  orchestrator can invoke the harness via Bash and the env var is
  inherited but I never echo / pipe / paste the token. First live run
  should be supervised (owner watching), then iterate. **Pin `1789a59`
  stays the maintainers protocol pin** (npm consumption); the
  maintainers clone at `flagship/maintainers/` (gitignored, branch
  `chore/npm-github-metadata` @ `a908a1d`) is the dev workspace where
  the ceremony CLI runs from.

- **2026-05-19 (v1-launch s9 cont. — ★ MULTI-TURN VIBECODE + structured
  tools (`requestEnvVar` value-free + `talkToUser`) + live
  `buildUserContext` wiring landed (`b1120e4`); the full daemon-side
  "build an app on your box, chat with the AI, set env vars via clear
  contract" foundation is complete):** Owner reframed BYOK→generic
  env vars (9d9c79c) and then specified that the model needs a
  clear-contract way to ask the owner for env vars + to chat as it
  works (no on-phone pattern-matching). Recon honestly verdicted
  "substantial" (one-shot today; providers don't forward tools; no
  reply path). Built it: six layers — (1) provider adapters
  (Anthropic/OpenAI/OpenRouter/Google) forward `tools` + parse native
  tool-call deltas; Ollama documented as text-only fallback; (2)
  parser unchanged for text — tool_use bypasses out-of-band; (3)
  session multi-turn state machine (`awaiting-tool-response`,
  `receiveToolUse`/`pushEnvVarAck`/`pushUserReply`, `endAssistant`
  gated, deploy 409s from awaiting); (4) HTTP endpoints
  `/sessions/<id>/{user-reply,tool-ack}`; (5) `vibeCodeTools.ts` —
  `requestEnvVar`'s ack is the structural `EnvVarAckPayload`
  (`readonly` + a compile-time `_NoValueField<T>` guard — adding a
  `value` field is a TS error), `talkToUser` free-form non-secret;
  (6) `vibeCodeStartStreaming.ts` assembles the system prompt via
  `buildUserContext` (passing `appEnvStore.names(appId)` — NEVER
  `.get()`), attaches `VIBE_CODE_TOOLS` to `ChatRequest.tools`. **Four
  invariants, all structural + sentinel-tested:** A `requestEnvVar`
  ack value-free (type-locked + runtime test); B chat-not-a-
  secret-channel (system prompt forbids; observational secret-shape
  heuristic logs but doesn't block); C live wiring uses `.names()`
  only (NamesOnlyStore test asserts `getCalls===0`; orchestrator
  independently grep-confirmed `envStore.get()` exists in the codebase
  ONLY at `appPlatform.ts:274` — the runtime-injection point, not a
  prompt/tool path); D tools array carries schemas only (sentinel-
  absent on the wire). Orchestrator audited scope (only
  `packages/llm-providers/` + `packages/server-daemon/src/llm/` +
  `screens/types.ts` + tests; apps/com/web/maintainers/.maintainers/
  protocol-auth/tools/vps-e2e untouched), re-ran gates: flagship
  `tsc -b` clean + vitest **2624/231 → 2653/235** (+29 tests +4 files:
  toolUse 8, vibeCodeToolHttp 6, vibeCodeMultiTurn 10,
  vibeCodeStartStreaming 4, +1 streamIntoSession; every prior pass).
  No new runtime dependency. **OUT OF SCOPE (still follow-on):** the
  multi-surface UI (phone/webapp/iOS/Android) for the new
  `request-env-var` event + the env-var KV editor + the `talk-to-user`
  chat surface. This chunk is the foundation the UI hooks into. **★
  The daemon/protocol/provider foundation of all four "finished
  product" pillars is now complete and verified.** Remaining
  agent-doable = the multi-surface UI (env-var editor + the new
  vibecode events). Everything else is the human/credential/ceremony/
  deploy path (CaEndorsement YubiKey ceremony + enforce-flip + deploy;
  paid-VPS live `create-vps` run; PR #15 merge; iOS TestFlight;
  Android Play; Phase G live exercises).

- **2026-05-19 (v1-launch s9 cont. — ★ GENERIC per-app ENV VARS landed
  (`9d9c79c`), replacing chunk-2's AI-specific BYOK; the "finished
  product" foundation arc is COMPLETE):** Owner reframed BYOK →
  generic per-app env vars (not an AI-credentials pipe; "set
  OPENAI_API_KEY as a var"). Decided (owner): NAMES-ONLY to the
  vibecode model; the generic store REPLACES chunk-2. Landed:
  `appEnvStore.ts` (generic sealed `Record<string,string>`, kept
  chunk-2's SWK-AEAD/0o600/forget; `names()` = names only) **replacing
  deleted `appByokStore.ts`+`appByokRuntime.ts`+the `/.flagship/llm/
  chat` proxy** (appByok 18 tests faithfully migrated→appEnv 24, +6);
  a new owner-IRK-signed `SetAppEnvRequest` in `@flagship/protocol`
  `auth.ts` (tag `flagship/set-app-env/v1`, sorted keys, mirrors
  `InstallAppRequest`); daemon `setEnv` verifies IRK, rejects
  wrong-signer/reserved `FLAGSHIP_*`, stores sealed; values injected
  into the deployed app's runtime env below reserved vars. **Two
  STRUCTURAL + sentinel-tested security invariants:** (1)
  values-never-to-model — the prompt builder param is
  `appEnvNames: string[]` (cannot carry a value); (2)
  values-never-exported — values live only in the separate sealed
  store dir, never in the app git-bundle (test walks the deployed
  tree). Harness stage 7 un-gated → real `vibeAppEnv` (stage 8 CA
  stays gated). Orchestrator verify-before-trust: scope confined
  (apps/com/web/maintainers/.maintainers untouched ⇒ `tsc -b` fully
  covers it — no standalone gap), chunk-2 removal clean (zero dangling
  refs), both invariants re-verified, gates re-run independently:
  flagship `tsc -b` clean + vitest **2614/231 → 2624/231** (+10;
  auth 64, appEnv 24; all prior pass). **★ HONEST scope (subagent-
  flagged, NOT hidden):** the FOUNDATION is built+proven and
  values-to-runtime is LIVE; remaining agent-doable = (a) small: wire
  `store.names(appId)` into the live vibecode `buildUserContext` call
  (the names-only safety+rendering exist; live call-site population is
  follow-on), (b) larger: the phone/webapp/iOS/Android key/value
  editor UI + the Screens-BFF passthrough to `POST /api/apps/:appId/
  env`. **Net of the whole "finished product" arc — the foundation of
  ALL four pillars is now built+verified:** CA-authorized hot keys
  (deploy-safe gate, `d507cda`; go-live = human Op-1b ceremony+enforce
  +deploy), free account/server (already live), generic env vars to
  develop-on-your-box-controlled-from-phone (`9d9c79c`; UI follow-on),
  `create-vps --iso` harness (`75d9465`). npm loop closed (`3c62147`);
  `/maintainers/` page dropped (`cdaa532`); npm↔GH metadata = PR #15.
  EVERYTHING ELSE to a *live* finished product is human/credential:
  the CaEndorsement YubiKey ceremony+enforce-flip+deploy, the paid-VPS
  live `create-vps` run, PR #15 merge, iOS TestFlight, Android Play,
  Phase G §S live exercises, + the env-var UI follow-on.

- **2026-05-19 (v1-launch s9 cont. — ★ CHUNK 3: the `.com` CA hot-key
  gate landed DEPLOY-SAFE (`d507cda`); `/maintainers/` page dropped;
  npm↔GH metadata = PR #15; CA pillar is now consumer-complete):**
  Sequence this turn: dropped the non-load-bearing
  `flagshipserver.com/maintainers/` web surface (`cdaa532` — not our
  responsibility to host; adopters serve `.maintainers/` via git GET,
  transparency = the checkpoints repo, ops = the CLI); opened governed
  **PR #15** (`chore/npm-github-metadata`) adding
  `repository`/`homepage`/`bugs` + README npm↔GitHub cross-links —
  owner merges when ready, **no 0.1.0 republish**, zero flagship
  impact; then **chunk 3**: wired the already-built #30 chokepoint so
  the live `.com` hot `FLAGSHIP_CA_PRIV_HEX` (signs
  `UserPubKeyBinding`@`pubkeyCert.ts:45` + `DemoDirective`@
  `usersCheck.ts:129`) is authorized ONLY by a CaEndorsement that
  verifies FORWARD from the baked genesis pin. **Two non-negotiables,
  independently verified by the orchestrator:** (i) FULL real
  verification — `apps/com/src/caTrustChainLoader.ts` static-imports
  the committed ca-track mandate chain + `.maintainers/ca-endorsements/
  bundle.json` and runs the REAL `verifyMandateChainFromPin`→
  `authorizedCaKeys` per request (pure fns, Worker-safe; a wrong-pin
  discriminating test proves no TTL/pre-verified shortcut); (ii)
  DEPLOY-SAFE — there is NO committed CaEndorsement yet (needs the
  human YubiKey ceremony), so the gate defaults to **OBSERVE** (runs
  the verification, logs the verdict, does NOT block); ENFORCE engages
  ONLY when `CA_ENDORSEMENT_ENFORCE === "true"` (literal). The decisive
  `caGate.test.ts` asserts the OBSERVE response is `toEqual(noGate)`
  byte-identical — landing+deploying changes NOTHING observable in
  production until a human flips enforce. Independent gates: flagship
  `tsc -b` clean + vitest **2602/229→2614/231** (+12; caGate 8 +
  caTrustChainLoader 4); the disclosed `apps/com`-not-in-`tsc -b` gap
  CLOSED by a standalone `tsc -p apps/com` (0 errors in the touched
  Worker files; the 7 errors are pre-existing in untouched buildRelay/
  rateLimit/route.test/pushBridge). Also: daemon `releaseVerifier.ts`
  gained the `.maintainers/ca-endorsements` read + `caTrustChainFromFolder`
  parity; `docs/ca-operations.md` "Operation 1b" = the full
  CaEndorsement ceremony runbook + the explicit
  deploy-OBSERVE-then-flip-ENFORCE steps. **GO-LIVE for CA-authorized
  hot keys = human-only:** run `maintainers ca-endorsement` (ca-track
  holder key#1 YubiKey, `--scope flagship/directory-attestation`,
  ~7d) → verify → commit `.maintainers/ca-endorsements/` + regenerate
  `bundle.json` → deploy OBSERVE + confirm `ca-gate authorized:true`
  logs → `wrangler deploy --var CA_ENDORSEMENT_ENFORCE:true`. **★
  Remaining to "finished" (honest):** agent-doable = ONLY the BYOK
  `@flagship/protocol`+webapp signed-order carrier (turns harness
  stage 7 green). Everything else is irreducibly human/credential:
  the CaEndorsement YubiKey ceremony + enforce-flip + `.com`/`.services`
  deploy; the live paid-VPS `create-vps --iso` run; PR #15 merge;
  iOS TestFlight; Android Play; Phase G §S live exercises.

- **2026-05-19 (v1-launch s9 cont. — ★★ npm LOOP CLOSED: flagship now
  consumes `@ibisllc/maintainers@0.1.0` from public npm as a real
  adopter; THE PINNED-CLONE/PULL-SCRIPT/RE-PIN WORKFLOW IS RETIRED):**
  Owner published `@ibisllc/maintainers@0.1.0` (independently verified
  live + consumable from registry.npmjs.org; ships
  dist+conformance+SPEC). Flagship migrated (commit **`3c62147`**):
  root `package.json` drops the `maintainers/packages/protocol`
  workspace member + pull pre/postinstall; `packages/server-daemon`
  dep `*`→exact **`0.1.0`**; root + server-daemon tsconfig drop the
  clone project refs (types via NodeNext from
  `node_modules/@ibisllc/maintainers/dist`); **`scripts/
  pull-maintainers.sh` + `scripts/maintainers.pinned-sha` DELETED**;
  Dockerfile git/bash clone+pull steps removed. Cross-language hazard
  (iOS+Android conformance loaded the shared artifact via the clone
  path, run under xcodebuild/gradle NOT vitest) fixed: both repoint to
  `node_modules/@ibisllc/maintainers/conformance` (iOS XCTSkip→thrown
  error, fail-not-skip). **All 3 gates independently re-run GREEN:**
  flagship `tsc -b` clean + vitest **2602/229** unchanged; iOS
  `xcodebuild` TEST SUCCEEDED, `MaintainersConformanceTests` 2 tests 0
  skipped (artifact found at npm path); Android
  `:app:testDebugUnitTest` BUILD SUCCESSFUL, `MaintainersConformanceTest`
  2/0/0/0 (suite 192/0/0/0).
  **★★★ OPERATING-MODEL CHANGE — read this, future sessions:** the
  governed-maintainers-PR → re-pin `scripts/maintainers.pinned-sha` →
  `pull-maintainers.sh pull` → re-gate loop that this entire session
  used is **GONE**. Those files/commands no longer exist. The
  `flagship/maintainers/` clone may still sit on disk (gitignored,
  untouched) but flagship NO LONGER depends on it. **Future
  maintainers-protocol changes = land in `ibisllc/maintainers`, `npm
  publish` a NEW version, then bump
  `packages/server-daemon/package.json`'s `@ibisllc/maintainers` to
  that version + `npm install` + re-gate.** Any older §0 entry below
  describing re-pin/pull-script is HISTORICAL — do not execute it.
  **Known follow-up (flagged, owner decision pending — NOT silently
  scoped):** the deleted pull-maintainers `bundle` step esbuilt the
  gitignored static bundle `apps/web/public/maintainers/lib/web-ui.js`
  for `flagshipserver.com/maintainers/`; the npm package ships no
  web-ui source, so a clean Docker/CI build no longer regenerates it
  (present on local disk; current deploy unaffected). Options posed to
  owner: vendor the built bundle into git / publish web-ui separately /
  drop the `/maintainers/` page (#31 already shrank it to status-only)
  / accept as flagged. Remaining toward "finished": chunk 3 =
  CA-endorsement consumer gate (+human YubiKey ceremony runbook); the
  BYOK protocol/webapp signed-order carrier; then the irreducible human
  gates (CaEndorsement signing, deploy, paid-VPS live `create-vps` run,
  mobile store, Phase G).

- **2026-05-19 (v1-launch program s9 cont. — "finished product" drive:
  e2e-VPS harness + BYOK daemon-half landed; npm-publish defect caught;
  npm org `ibisllc` GRANTED):** Owner asked (ultrathink) to drive to a
  finished, live-e2e product. Honest split stated: buildable parts
  agent-doable; live cutover irreducibly gated (npm/CaEndorsement-
  YubiKey/paid-VPS/no-Linux). Explore mapped real state: build→install→
  green-padlock + free account/server are LIVE; **CA-authorized hot
  keys NOT live** (links 2-4 code-ready but uncalled — `.com` signs
  pubkey-cert with raw `FLAGSHIP_CA_PRIV_HEX`, no CaEndorsement gate);
  **BYOK vibe-apps NOT e2e** (key never persisted). Landed: **(chunk 1)
  `tools/vps-e2e/` `create-vps --iso` harness** `75d9465` — pure core +
  injected provider/HTTP, teardown-always, 9 stages with the 2
  not-wired pillars HONESTLY `known-gated` (NOT faked), Hetzner
  ref-adapter wiring-only, `--plan` runs zero-cred; flagship
  2563/226→2584/228. **(chunk 2) per-app BYOK secure persistence +
  runtime seam** `6f9fe22` — `appByokStore`(sealed-at-rest via the
  existing `@flagship/protocol` AEAD, 0o600)+`appByokRuntime`+proxy;
  key never in signed wire/logs/errors/public surface; recon found the
  gap is (b) "key never persisted"; the full phone/webapp→signed-order
  →deployed-app carrier is OUT OF SCOPE (needs `@flagship/protocol`+
  webapp) — STOPPED there, harness stage 7 stays `known-gated` with
  reason narrowed (daemon wired; carrier pending); flagship
  2584/228→2602/229. **★ npm-publish-prep (verify-before-trust):** the
  npm org `ibisllc` is GRANTED (owner). `maintainers/packages/protocol`
  `@ibisllc/maintainers@0.1.0` `npm pack` is otherwise clean (ships
  dist+conformance+SPEC, no src/secret leak) BUT top-level
  `main`/`types` = `./src/index.ts` (NOT in `files[]` tarball) — modern
  `exports`-aware consumers OK (exports→dist), legacy-resolution
  consumers + an immutable first 0.1.0 = real defect. Fix (empirically determined; the
  first `publishConfig` guess was DISCARDED as publish-time-only/
  weaker): a 2-line top-level change — `main`→`./dist/index.js`,
  `types`→`./dist/index.d.ts` (exports + publishConfig unchanged).
  Safe in-workspace because both repos use `moduleResolution:NodeNext`
  with NO `customConditions`/`paths` for this pkg → NodeNext honors
  `exports` & IGNORES top-level main/types (the `@maintainers/source`
  condition is dormant; live resolution is purely `exports["."]`→
  `dist`). Orchestrator independently re-verified WITH the change:
  maintainers tsc clean + 467/41 unchanged; **flagship tsc clean
  (decisive no-regression proof)**; packed tarball main/types=dist
  (PACK-verifiable); src absent; external ESM + `tsc --noEmit` types
  resolve under both `bundler` & legacy `node`. = **governed PR #14
  OPEN** (`chore/protocol-publish-manifest-dist`, github.com/ibisllc/
  maintainers/pull/14). POST-MERGE PUBLISH RUNBOOK: (1) owner merges
  #14 → (2) agent re-pins flagship → PR#14 first-parent merge SHA +
  `pull-maintainers.sh pull` + re-gate (the pinned clone becomes the
  CORRECTED tree — DO NOT publish from `016f263`, it still has the
  src-pointer bug) → (3) owner, from the re-pinned `maintainers/
  packages/protocol` with their `ibisllc` npm login (NO token via the
  agent; revoke the burned `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`):
  `npm whoami` → `npm view @ibisllc/maintainers version` (expect E404)
  → `npm publish --dry-run` → `npm publish` (access:public + prepack
  build automatic) → (4) confirm `npm view @ibisllc/maintainers` shows
  0.1.0 → (5) agent chunk = flagship drops pull-script/pin/symlink,
  consumes `@ibisllc/maintainers@0.1.0` from npm like any adopter +
  re-verifies. Remaining
  toward "finished": chunk 3 = CA-endorsement consumer gate (pillar 2,
  + human YubiKey ceremony runbook); the BYOK protocol/webapp carrier;
  then the irreducible human gates (CaEndorsement signing, deploy,
  paid-VPS live `create-vps` run, mobile, Phase G). Pin `016f263`
  until PR #14 merges (DO NOT publish from `016f263` — src-pointer bug;
  publish only from the post-#14 re-pinned tree).

- **2026-05-19 (v1-launch program session 9 cont. — PR #13 MERGED +
  FINAL re-pin `016f263`; Phase H agent-side COMPLETE; building the
  requested real-VPS e2e harness):** Owner merged PR #13. Final
  governed re-pin `f27bbbe` → **`016f263d8b57b8288ac9c234c8dca1d21cf80f29`**
  (PR#13 first-parent merge), pull + re-gate — maintainers `tsc -b`
  clean + vitest **467/467·41**; flagship `tsc -b` clean (standalone,
  pwd-verified); pcsclite re-installed. **The entire maintainers
  protocol product is now landed + merged + pinned: genesis-signed `ca`
  root → checkpoint-request envelope (#10) → bot validation-rules
  (#11) → `checkpoint submit` CLI (#12) → bot Action adapter (#13);
  plus the guided CLI wizard (#9) and the PIN-reader fix (#8).** Owner
  asked (ultrathink) to drive to a finished, live-e2e-tested product
  (CA-authorized hot keys; free account/server creation; BYOK
  vibe-coded apps; a `create-vps --iso` end-to-end test tool). Honest
  split recorded: the *buildable+verifiable* parts are agent-doable;
  the *live cutover* is irreducibly gated (npm approval PENDING; no
  cloud-provider token; YubiKey for the CA-endorsement ceremony; no
  Linux/qemu here to build an ISO). Plan: build the `create-vps --iso`
  harness (pure core + injected provider/HTTP/SSH I/O, hermetically
  tested, one-command-from-live), audit the 3 pillars + close
  agent-doable gaps, hand off the credentialed runbook. npm token
  `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` still BURNED — revoke.
  Pin `016f263` is now STABLE (no more maintainers chunks pending).

- **2026-05-19 (v1-launch program session 9 cont. — PHASE H chunk 4
  (checkpoint-bot Action adapter) = governed PR #13 OPEN; ★ AGENT-DOABLE
  v1-LAUNCH BACKLOG EXHAUSTED after this):** Fresh subagent added
  `packages/server-adapters/checkpoints-bot/` mirroring
  `server-adapters/cloudflare-worker` (`bot.ts` PURE core
  `runCheckpointBotOnSubmission(deps)` — all I/O injected, imports only
  `@ibisllc/maintainers`, NO node:fs/net/child_process [confirmed:
  the only match is the absence-asserting JSDoc at bot.ts:33], reuses
  `validateCheckpointSubmission` VERBATIM, effects returned as data:
  accept⇒one §7 4-col append-only line +iff rule-11 over-cap the
  manual-verify ping; reject⇒PR decision; `action.ts` THIN real-I/O
  entrypoint, node:fs/child_process only, NO @actions/octokit, wiring-
  only/typechecked-not-run-here, its pure helpers unit-tested — one
  caught+fixed a real `.git/` path bug). Verify-before-trust: confined
  scope (`checkpoints-bot/**` + ONE root-tsconfig ref line;
  protocol/cli/conformance/docs **git-clean**), no new dep, re-ran
  gates independently — maintainers `tsc -b` clean + vitest
  **467/467·41** (+25 hermetic incl rule-11-fail-open-ping /
  prunable-witness-accept / append-only-single-line+forged-tail-reject
  / each reject→decision; conformance 30 / wizard 12 / checkpointBot 22
  / checkpointSubmit 12 unchanged; 0 failed); flagship `tsc -b` clean
  (STANDALONE from repo root, pwd echoed = `/Users/harrywinner/
  flagship`, exit 0 — NOT chained after a maintainers cd this time).
  Branch `feat/checkpoint-bot-action-adapter` off pin `f27bbbe` (no
  `Co-Authored-By`), pushed, **governed PR #13 OPEN**
  (https://github.com/ibisllc/maintainers/pull/13). **★ NEXT —
  HUMAN-MERGE GATE:** owner merges #13 → agent re-pins → pull →
  re-gate → `npm i pcsclite --no-save`. Pin `f27bbbe` until #13
  merges. **★★ AFTER #13 THE AGENT-DOABLE v1-LAUNCH BACKLOG IS
  EXHAUSTED.** Everything remaining is HUMAN / CREDENTIAL / ENV /
  LIVE-EXERCISE gated (see §0a "Remaining human-only punch list"
  below) — the orchestrator should STOP spawning build chunks and hand
  off cleanly, not invent speculative work.

### §0a — Remaining human-only punch list (post-PR-#13; nothing here is agent-doable on this Mac)

1. **Merge PR #13** → tell the agent → it does the final re-pin (this
   is the only remaining agent action, and it is gated on the merge).
2. **Create `github.com/ibisllc/maintainers-checkpoints`** (the public
   witness repo) + wire its GitHub Action to the landed
   `checkpoints-bot` adapter; submit Flagship's genesis `ca` mandate as
   the inaugural checkpoint via `maintainers checkpoint submit`.
3. **npm publish** `@ibisllc/maintainers` — the earlier pasted token is
   BURNED (revoke `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` at
   npmjs.com); create the `ibisllc` npm org + a fresh token; then
   flagship can drop `pull-maintainers.sh`+pin+symlink (a later chunk).
4. **iOS** TestFlight (archive+sign+upload+5 testers) — Mac-side human.
5. **Android** Play internal track (signing+FCM+upload+5 testers) —
   JDK/SDK now installed here, but store upload is human/credential.
6. **Phase F** real personalized-ISO boot on a paid cloud VPS (this
   Mac is darwin/arm64 — no qemu/docker/Linux; the repro-build CI is
   already DONE/verified).
7. **Phase G** the §S v1-alpha live-exercise checklist
   (update-pack / lineage-break / STK rotation / recovery-from-lost-
   phone / 7-day peer-backup) — each a live human exercise.
8. **Rotate** the #7-exposed PIV PIN if not already (done in-session
   per the genesis entry — re-confirm).

- **2026-05-19 (v1-launch program session 9 cont. — PR #12 MERGED +
  re-pinned `f27bbbe`; next = Phase-H chunk 4 = bot Action adapter):**
  Owner merged PR #12 (`checkpoint submit` CLI verb). Governed re-pin:
  `scripts/maintainers.pinned-sha` `c8d3fc0` →
  **`f27bbbec5b39e7cf469a1e373ec6255366bcb41d`** (PR#12 first-parent
  merge), `pull-maintainers.sh pull` (clone detached-clean), re-ran
  BOTH gates — maintainers `tsc -b` clean + vitest **442/442·40**;
  flagship `tsc -b` clean. **Process note (recurring, now 3×):** the
  flagship gate was first chained after a `cd …/maintainers` and a
  cwd-guard `test` short-circuited it — and the `|| echo CLEAN`
  mislabeled the SKIPPED gate as CLEAN (the `cwd=…/maintainers` in the
  message was the tell). Re-ran flagship tsc STANDALONE from the repo
  root (pwd printed = `/Users/harrywinner/flagship`, exit 0, 0 TS) ⇒
  genuinely CLEAN. **Lesson: run the flagship gate as its own command
  with `pwd` echoed; never chain it after a maintainers-dir cd; never
  let `||` turn a skip into a pass.** pcsclite re-installed. Pin
  `f27bbbe`. **NEXT (program — the LAST agent-doable Phase-H unit,
  governed maintainers PR):** chunk 4 = the **checkpoint-bot Action
  adapter**: a PURE `runCheckpointBotOnSubmission(deps)` core (injected
  fetch-chain / read-CSV / append-row / post-decision / now / rateCap
  → calls `validateCheckpointSubmission`, maps accept→CSV-append +
  rule-11 manual-verify ping, reject→PR-decision) fully hermetically
  tested, PLUS a thin GitHub-Action entrypoint that wires real I/O
  (authored + typechecked but only truly exercised once the
  human-gated `ibisllc/maintainers-checkpoints` repo + a real PR
  exist). Mirror the existing `server-adapters` pattern; keep the core
  dependency-free (any `@actions/*` scoped to the entrypoint only +
  flagged). After chunk 4 the agent-doable Phase-H backlog is
  EXHAUSTED — remaining = human/credential/env gates (repo creation,
  first real checkpoint, Phase F paid VPS, Phase G live, iOS/Android
  store uploads).

- **2026-05-19 (v1-launch program session 9 cont. — PHASE H chunk 3:
  `maintainers checkpoint submit` CLI verb = governed PR #12 OPEN,
  awaiting human merge):** Fresh subagent added `commands/
  checkpointSubmit.ts` mirroring `caEndorsement.ts` (pure assemble →
  `previewConfirmSign` banner+byte-preview+typed `CHECKPOINT-SUBMIT`
  confirm+PIN → `signCheckpointRequestWith`); dispatch `checkpoint
  submit`; ceremony kind+banner; H_new from a local `.maintainers`
  store (verify.ts way) or `--current-mandate-hash` (`sha256:<64hex>`);
  `--source-commit` advisory; PR-open NOT bundled (no net dep — emits
  payload + `gh` instructions). **★ Integration verified:** the emitted
  §9 payload carries a REAL signed `CheckpointRequest`
  (`proof.request === botPayload.request`); §9 replay-binding holds BY
  CONSTRUCTION (every payload field sourced from the signed request);
  orchestrator confirmed the hermetic ROUND-TRIP test genuinely feeds
  the verb's `botPayload` + a matching verified chain into
  `validateCheckpointSubmission` ⇒ `accept:true`+expected row, and the
  TAMPER negative ⇒ `request-repo-mismatch` — chunk-3↔chunk-2 provably
  compose. Verify-before-trust: confined scope (4 `packages/cli`
  files; protocol/conformance/docs/wizard **git-clean**), no `--yes`
  weakening (reuses `previewConfirmSign`/`signAssembled` verbatim),
  non-interactive deterministic fail-closed, re-ran gates independently
  — maintainers `tsc -b` clean + vitest **442/442·40** (was 430/39;
  +12 hermetic `checkpointSubmit.test.ts`; conformance 30 / wizard 12 /
  checkpointBot 22 unchanged; 0 failed); flagship `tsc -b` clean (repo
  root, cwd asserted). Branch `feat/checkpoint-submit-cli` off pin
  `c8d3fc0` (no `Co-Authored-By`), pushed, **governed PR #12 OPEN**
  (https://github.com/ibisllc/maintainers/pull/12). **★ NEXT —
  HUMAN-MERGE GATE:** owner merges #12 → agent re-pins → pull →
  re-gate → `npm i pcsclite --no-save`. Pin `c8d3fc0` until #12
  merges. After #12: Phase-H **chunk 4 = the thin GitHub-Action shell**
  over `validateCheckpointSubmission` (octokit/fs glue; lightly
  unit-testable with injected fakes) — the LAST agent-doable Phase-H
  unit; the `ibisllc/maintainers-checkpoints` repo creation + the
  first real checkpoint submission are human/credential gates.

- **2026-05-19 (v1-launch program session 9 cont. — PR #11 MERGED +
  re-pinned `c8d3fc0`; next Phase-H chunk 3 = `checkpoint submit` CLI
  verb):** Owner merged PR #11 (bot validation-rules library). Governed
  re-pin: `scripts/maintainers.pinned-sha` `b497c5e` →
  **`c8d3fc0758f18ac4c9f9952a0658c636d0dff22e`** (PR#11 first-parent
  merge; carries `checkpointBot.ts`), `pull-maintainers.sh pull` (clone
  detached-clean), re-ran BOTH gates — maintainers `tsc -b` clean +
  vitest **430/430·39**; flagship `tsc -b` clean (run from repo root
  with a cwd assertion; a cwd-poisoned first attempt that re-checked
  the maintainers pkg was caught + corrected — recurring hazard, always
  assert `pwd` before the flagship gate) — re-installed the pull-wiped
  `pcsclite`. Pin `c8d3fc0`. **NEXT (program, governed maintainers
  PR):** Phase-H chunk 3 = the **`maintainers checkpoint submit` CLI
  verb** — build + holder-sign a `CheckpointRequest` (reusing
  `signCheckpointRequest`/`canonicalCheckpointRequest`), emit the §9
  PR payload + a CSV-row preview, byte-preview + typed-confirm + PIN
  like the other verbs, dry-run + hermetic tests; confined to
  `packages/cli`. (The thin GitHub-Action shell over `checkpointBot` is
  chunk 4; the `ibisllc/maintainers-checkpoints` repo creation stays a
  human gate.)

- **2026-05-19 (v1-launch program session 9 cont. — PHASE H chunk 2:
  bot validation-rules library = governed PR #11 OPEN, awaiting human
  merge):** Fresh subagent built `checkpointBot.ts` —
  `validateCheckpointSubmission(input)` pure/runtime-agnostic (all I/O
  injected; no fs/net/octokit; Action shell + the
  `ibisllc/maintainers-checkpoints` repo remain a later chunk / human
  gate). Implements spec §10 rules 1–11 / §11 / §12 / §13, reusing the
  landed verifiers verbatim (`verifyMandateChainFromPin`,
  `currentAuthority`, `verifyCheckpointRequest` = rule 5 holder-signs
  NOT quorum, `mandatePinHash`). Orchestrator verify-before-trust: read
  the decision core — rule 3 anchors to the VALIDATED chain not the
  served log; a §9 replay-binding guard (signed request must bind the
  PR's repo/path/hash; `sourceCommit` advisory/unbound); §11 continuity
  anchors to the verified gap-free chain NOT CSV completeness
  (prunable-witness-safe — confirmed the sparse-CSV test asserts
  accept:true); rule 11 the ONLY fail-open (over-cap N+1 ⇒ accept +
  `flagged:"rate-cap"` + manual-verify action, never reject;
  exactly-at-cap no flag — correct boundary); total/fail-closed like
  the siblings — confirmed confined scope (`packages/protocol/**` only;
  shared `conformance/manifest.json`+17 vectors **byte-untouched**;
  pure, no new dep), re-ran gates independently — maintainers `tsc -b`
  clean + vitest **430/430·39** (was 408/38; +22 hermetic
  `checkpointBot.test.ts`; conformance 30 / wizard 12 unchanged; 0
  failed); flagship `tsc -b` clean (additive, not imported). Branch
  `feat/checkpoint-bot-rules` off pin `b497c5e` (no `Co-Authored-By`),
  pushed, **governed PR #11 OPEN**
  (https://github.com/ibisllc/maintainers/pull/11). **★ NEXT —
  HUMAN-MERGE GATE:** owner merges #11 → agent re-pins → pull →
  re-gate → `npm i pcsclite --no-save`. Pin `b497c5e` until #11
  merges. Then Phase-H chunk 3 = the thin GitHub-Action shell over this
  library + the `maintainers checkpoint submit` CLI verb (the
  `maintainers-checkpoints` repo creation stays a human gate).

- **2026-05-19 (v1-launch program session 9 cont. — PR #10 MERGED +
  re-pinned `b497c5e`; next Phase-H chunk = bot validation rules):**
  Owner merged PR #10 (checkpoint-request envelope). Governed re-pin:
  `scripts/maintainers.pinned-sha` `5a3079e` →
  **`b497c5e4ea067a520ea71727b6c78a59c1d0fe1a`** (PR#10 first-parent
  merge; carries `checkpointRequest.ts` + the additive conformance
  set), `pull-maintainers.sh pull` (clone detached-clean at the pin),
  re-ran BOTH gates — maintainers `tsc -b` clean + vitest **408/408·38**
  (conformance.test 30); flagship `tsc -b` clean (run from repo root;
  a cwd-poisoned first attempt that re-checked the CLI pkg was caught +
  corrected) — re-installed the pull-wiped `pcsclite` (resolves). Pin
  `b497c5e`. **NEXT (program, agent-doable, governed maintainers PR):**
  Phase-H chunk 2 = the **bot validation rules** — implement the §10
  rules (1–11, incl. holder-signs check #5 via `verifyCheckpointRequest`,
  no-op rule 10, fail-OPEN rate-cap rule 11 → `flagged=rate-cap`),
  §11 continuity (per (project,track), prunable-witness-aware), §12
  first-checkpoint, the 4-col CSV append, as a pure runtime-agnostic
  validator library in the maintainers protocol/package (NOT the
  GitHub Action wiring or the `ibisllc/maintainers-checkpoints` repo —
  that repo creation is a human gate; the Action is a thin shell over
  the library). Then chunk 3 = `maintainers checkpoint submit` CLI.

- **2026-05-19 (v1-launch program session 9 cont. — PHASE H
  FOUNDATION: `checkpoint-request/v1` signed envelope = governed PR
  #10 OPEN, awaiting human merge):** Continuing the program post-push,
  a fresh subagent built the foundational Phase-H piece: the
  `maintainers/checkpoint-request/v1` first-class signed envelope
  (`CheckpointRequest` type + `canonicalCheckpointRequest` +
  `signCheckpointRequest`/`…With` + `verifyCheckpointRequest`),
  mirroring `CaEndorsement` exactly; **holder-signs** per the RESOLVED
  open-detail item 1 (authorised iff a sig over the canonical bytes
  verifies under the holder of the mandate current at `now` via
  `currentAuthority`/`verifyMandateChainFromPin`; quorum governs
  succession only); total/fail-closed like the siblings. **★
  Orchestrator caught + briefed the cross-repo hazard:** the iOS/
  Android conformance ports hard-pin `count==17` + replay-all against
  the SHARED `conformance/manifest.json` under xcodebuild/gradle (NOT
  `npx vitest`) — a shared-manifest mutation is a SILENT cross-repo
  break invisible to the flagship TS gate. So the new conformance is
  ADDITIVE & isolated at `conformance/checkpoint-request/` (7 det-gen
  vectors: 1 happy + 6 fail-closed negatives), shared 17-set proven
  **byte-identical** (`git status` on it empty — independently
  verified). Verify-before-trust: read the verifier (holder-signs not
  quorum; canonicalization-throw⇒signature-invalid; absent pin⇒
  no-authority-at-now; no fallback; never throws), confirmed confined
  scope (only `packages/protocol/**` + the additive set; no flagship/
  shared-manifest/CLI/bot), re-ran gates independently — maintainers
  `tsc -b` clean + vitest **408/408·38** (was 398/38; +10 all in
  `conformance.test.ts` → now 30 = 20 shared + 10 new; 0 failed).
  Committed `feat/checkpoint-request-envelope` off pin `5a3079e` (repo-
  local identity `Harry Winner <kamdemharry@gmail.com>`; no
  `Co-Authored-By`), pushed, **governed PR #10 OPEN**
  (https://github.com/ibisllc/maintainers/pull/10). **★ NEXT —
  HUMAN-MERGE GATE:** owner merges PR #10 → agent re-pins
  `scripts/maintainers.pinned-sha` → PR#10 first-parent merge SHA +
  `pull-maintainers.sh pull` + re-gate + `npm i pcsclite --no-save`.
  Pin `5a3079e` until #10 merges. (Later Phase-H chunks: bot validation
  rules + CSV registry + `maintainers checkpoint submit` CLI; the
  `ibisllc/maintainers-checkpoints` repo creation is a human gate.)

- **2026-05-19 (v1-launch program session 9 cont. — PR #9 MERGED +
  re-pinned `5a3079e`; checkpoint spec refined; `main` pushed to
  origin):** Owner authorized: push `main` + merge PR #9. PR #9
  (guided menu wizard) squash-merged → **`5a3079e4f9d7ee212abdf64838249de6f61d8bd0`**
  (on origin/main, carries `lib/wizard.ts`+index wiring). Agent ran the
  governed re-pin: `scripts/maintainers.pinned-sha` `393b7a7` →
  **`5a3079e`**, `pull-maintainers.sh pull` (clone detached-clean at
  the pin, off the deleted feature branch), re-ran BOTH gates at the
  pin — maintainers `tsc -b` clean + vitest **398/398·38** (wizard 12,
  conformance 20, 0 failed); flagship `tsc -b` clean — re-installed the
  pull-wiped `pcsclite` (resolves). **Checkpoint spec (Phase H)
  refined** per 3 owner messages, committed `6d8c6a2` (reviewable
  draft): §10 rule 11 now **fails OPEN with a `flagged=rate-cap` row +
  auto manual-verify ticket** (never rejects — a witness must not
  refuse mid-incident); CSV is 4-col `observed_at,track,
  current_mandate_hash,flagged`; the registry is a **prunable witness**
  (may drop flagged AND ordinary middle-chain rows — security rests on
  the project's own gap-free `.maintainers/` chain, §11 anchors to any
  present prior hash; completeness is a §3 non-goal, graceful
  degradation a §19 property; honest caveat: pruning costs witness
  value not safety). Git identity auto-detect broke (hostname
  `Mac.(none)`) → set **repo-local** `Harry Winner
  <kamdemharry@gmail.com>` (matches owner's own commits; future commits
  only). `main` (this whole session's verified work + the owner's
  `260e426` + the spec edit + this re-pin) **pushed to
  `origin/main`**. Pin `5a3079e`; genesis/Phase-B/C all intact &
  verified (earlier entries). NEXT: Phase D remainder / Phase H build /
  Phase F (env-gated) / Phase G — owner's call.

- **2026-05-19 (v1-launch program session 9 cont. — PHASE D started:
  guided menu wizard = governed PR #9 OPEN, awaiting human merge):**
  Per the owner steering (CLI is first-class), a fresh subagent added a
  guided menu wizard: bare `maintainers` in an interactive terminal →
  numbered menu (status/register-key/issue-renew-mandate/CA-endorsement/
  verify/quit); `maintainers menu` forces it. THIN front-end — gathers
  inputs, builds the SAME flag argv, re-dispatches through the existing
  `dispatch()` handlers, so byte-preview/typed-confirm/no-echo-PIN/tap
  are the UNCHANGED path. Orchestrator verify-before-trust: audited
  scope (only `packages/cli/src/index.ts` + new `lib/wizard.ts` + new
  `tests/wizard.test.ts`; protocol/conformance/.maintainers untouched),
  grep-proved **ZERO `--yes`/skip-confirm emission** (only negative
  comments), read the core (non-interactive ⇒ deterministic `CliError`
  no-hang; PIN never menu-prompted; `--dry-run` only on explicit yes;
  bare non-interactive byte-unchanged `printUsage`+0), re-ran both
  gates independently — maintainers `tsc -b` clean + vitest **398/398·
  38** (386/37 +12 hermetic wizard tests; conformance still 20/20; 0
  failed). Committed on branch `feat/guided-menu-wizard` **`d8ffac1`**
  off pin `393b7a7` (no `Co-Authored-By`), pushed, **governed PR #9
  OPEN** (https://github.com/ibisllc/maintainers/pull/9). **★ NEXT —
  HUMAN-MERGE GATE (agent never merges a governed maintainers PR /
  never pins an unmerged tip):** owner merges PR #9 → agent re-pins
  `scripts/maintainers.pinned-sha` → PR#9 first-parent merge SHA +
  `bash scripts/pull-maintainers.sh pull` + re-run both gates +
  re-install `pcsclite` (`cd maintainers/packages/cli && npm i pcsclite
  --no-save` — the pull wipes the non-manifest dep). Phase D remainder
  (more CLI polish / #31 web-ui already enforced / #32 NFC app
  human-gated) continues after. Pin `393b7a7` until #9 merges.

- **2026-05-19 (v1-launch program session 9 cont. — ★★ PHASE C
  COMPLETE: the genesis pin is baked + conformance-verified on EVERY
  surface):** **#10 Android** — fresh subagent built the Kotlin mirror
  of #10 iOS (`apps/mobile/android/app/src/main/java/com/flagshipserver/
  app/core/MaintainersTrust.kt`, Google Tink `subtle.Ed25519Verify` +
  JDK SHA-256, NO new Gradle dep) byte-identical to the TS reference,
  baked `pinnedMandateHash` = the exact anchor `5016749377de…01ae`,
  + a JVM unit test loading the SHARED `maintainers/conformance/`
  artifact from disk at runtime and replaying all 17 vectors.
  Orchestrator verify-before-trust: audited scope (2 new `.kt` files
  only; TS/iOS/maintainers/.maintainers/pin/docs/build-scripts/version-
  catalog untouched; `.kotlin/` build-artifact + gitignored
  `google-services.json` placeholder excluded from the commit),
  confirmed loads-from-disk (not transcribed), independently re-ran
  `:app:testDebugUnitTest --rerun-tasks` (JAVA_HOME-prefixed) ⇒ BUILD
  SUCCESSFUL, parsed the JUnit XML: **192/192, 0 failures, 0 skipped**;
  `MaintainersConformanceTest` suite present with **2 testcases,
  skipped=0** (the 17-vector replay genuinely executed, not skipped).
  Committed flagship `main` **`f946592`** (2 `.kt` files, no
  `Co-Authored-By`). **Pre-existing env note (NOT introduced here):**
  `:app:testDebugUnitTest` needs the gitignored `app/google-services.
  json` (the `com.google.gms.google-services` plugin aborts without
  it); a subagent-created minimal gitignored placeholder is on disk
  (never committed) — a clean checkout / Android CI must provision that
  file before Android unit tests run. **⇒ PHASE C (#30/#9/#10) IS
  COMPLETE:** the signed genesis root (`mandatePinHash
  5016749377de…01ae`) is now baked AND conformance-verified on all
  surfaces — `@flagship/protocol` const `d110675` (daemon #8 + webapp
  #9), iOS `a67c1e5`, Android `f946592` — each replaying the identical
  c5 17-vector set with matching verdicts. The full trust chain from
  genesis to every consumer is wired. Pin `393b7a7`; nothing else
  changed. NEXT (program order, each with a gating nuance): Phase D
  (maintainers app **+ first-class GUI-like CLI** per the 2026-05-19
  steering — design-heavy, agent-doable), Phase F (ISO/VPS —
  env-gated here: darwin/arm64, no qemu/docker/Linux; real VPS = paid),
  Phase H (Maintainers Checkpoints — additive, agent-doable), Phase G
  (§S live exercises — largely human/live).

- **2026-05-19 (v1-launch program session 9 cont. — #10 iOS LANDED;
  owner steering: CLI is FIRST-CLASS not retired; Android tooling
  installed ⇒ #10 Android now agent-doable here):** **#10 iOS** —
  fresh subagent built a greenfield Swift maintainers verify-forward
  port (`apps/mobile/ios/Sources/FlagshipCore/MaintainersTrust.swift`,
  CryptoKit only, no SwiftPM dep) mirroring the TS canonical bytes +
  verifier + endorsement/CA-lease logic, baked
  `MaintainersTrust.pinnedMandateHash` = the exact anchor
  `5016749377de…01ae`, + a new XCTest that loads the SHARED
  `maintainers/conformance/` artifact from disk at runtime and replays
  all 17 vectors. Orchestrator verify-before-trust: audited scope (2
  new additive files only; no Package.swift/TS/.maintainers/pin/docs
  change; pbxproj pre-existing), confirmed loads-from-disk (not
  transcribed), re-ran the gate independently — `xcodebuild test`
  iOS-Sim ⇒ **TEST SUCCEEDED, 234/234, 0 failures**, and the
  conformance suite **actually executed** (both tests started+passed,
  NOT `XCTSkip`'d). Committed flagship `main` **`a67c1e5`** (2 files,
  no `Co-Authored-By`). NOTE: `swift test` fails for this package
  (pre-existing unguarded `import UIKit` in `FlagshipUI/Push/
  PushRegistrar.swift`, commit `fb911f3` — NOT introduced here); the
  correct gate is `xcodebuild test -scheme FlagshipMobile-Package
  -destination 'platform=iOS Simulator,name=iPhone 16 Plus,OS=18.5'`.
  **★ OWNER STEERING (2026-05-19) — the maintainers CLI is NOT retired
  / NOT demoted to an air-gapped escape hatch:** the repo must ship
  runnable, user-friendly **GUI-like sample CLI code** (guided menu/TUI
  management, not raw flags); the NFC app is an ADDITIONAL surface, not
  a replacement. This SUPERSEDES every "retire the CLI" / "replace the
  CLI path" / "CLI is the escape hatch" line in this file,
  `v1-launch-program.md` (Phase 3 banner added), `ca-operations.md`,
  and the task list. Captured in [[feedback-maintainers-cli-first-class]].
  **★ TOOLING INSTALLED (owner-authorized):** Homebrew `openjdk@17`
  (`/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`) +
  `android-commandlinetools` cask + SDK `platform-tools`/`platforms;
  android-35`/`build-tools;35.0.0` under `~/Library/Android/sdk`
  (licenses accepted). `~/.gradle/gradle.properties`
  `org.gradle.java.home=<JDK17>`; gitignored `apps/mobile/android/
  local.properties` `sdk.dir=~/Library/Android/sdk`. **Gotcha:** the
  `gradlew` launcher needs `JAVA_HOME` in the ENV (shell env doesn't
  persist between tool calls) — every Gradle call must prefix
  `export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`.
  Smoke-verified `./gradlew :app:help` ⇒ BUILD SUCCESSFUL (Gradle
  8.10.2). ⇒ **#10 Android is now agent-doable + gate-verifiable here**
  (was env-gated). Details: [[reference-android-toolchain]]. **NEXT =
  #10 Android** (Kotlin maintainers verify-forward port + baked pin +
  conformance-replay JVM unit test — the Kotlin mirror of #10 iOS).
  Pin `393b7a7`; nothing else changed.

- **2026-05-19 (v1-launch program session 9 cont. — PHASE C CORE
  LANDED: the genesis pin is BAKED into `@flagship/protocol` (#30 →
  daemon #8 + webapp #9); #10 mobile decomposed):** One fresh subagent
  baked `MAINTAINER_PINNED_MANDATE_HASH` `""` →
  `5016749377de07fd3296e8207539bbe52b40fb58f971d946f4cc8990c7e801ae`
  in `packages/protocol/src/maintainerCa.ts`. This one const is the
  link-1 anchor consumed via `?? default` by `releaseVerifier.ts` +
  `caTrustChain.ts`, so it covers the daemon (#8) AND the webapp (#9)
  in one edit. Flipping `""`→hash changes behavior everywhere
  (empty⇒fail-closed → verify-forward-from-pin); the 6 fallout tests
  (3 files) were reconciled FAITHFULLY — each now passes an explicit
  `""` pin (same expectations: `pin-unconfigured` / `validMandates 0`
  / port-not-consulted), and the "ships empty" test now asserts the
  exact anchor AND retains `maintainerPinConfigured("")===false`.
  Orchestrator verify-before-trust: audited the diff (scope confined
  to the const+comment + those 4 files; **zero production logic
  changed** — pure data flip; `it()` counts unchanged 9/9·9/9·8/8; no
  skip/only/todo; read every test-body diff — faithful, no gutted
  assertion/tautology), re-ran ALL gates independently: flagship
  `tsc -b` clean + vitest **2563/2563·226·0-failed** (no hidden
  fallout anywhere), maintainers `tsc -b` clean + vitest **386/386·37**
  incl the **c5 conformance replay ✓20/20** (consumer verify-forward
  correct, no wrong/empty pin shipped). Committed flagship `main`
  **`d110675`** (4 files, no `Co-Authored-By`; pin `393b7a7`
  unchanged). **#10 mobile re-bake decomposed (subagent investigation,
  no mobile code changed):** iOS `apps/mobile/ios` (136 Swift files,
  SwiftPM, `swift`+`xcodebuild`+built `.build` + XCTest harness all
  present) has **NO maintainers verify-forward consumer and NO pin
  const** — so #10-iOS is an **agent-doable GREENFIELD chunk** (add a
  Swift pinned-hash const + a verify-forward consumer + an XCTest that
  replays the c5 portable vectors; NOT a one-line bake) — NEXT. Android
  `apps/mobile/android` (115 Kotlin files, Gradle) likewise has no
  maintainers code AND **this machine has NO JDK** (`java`→"Unable to
  locate a Java Runtime", no `gradle`) ⇒ #10-Android is **human/
  env-gated** (author-blind possible but uncompilable/untestable here;
  defer to a JDK box). No flagship-side conformance replay exists (not
  invented). Phase C core = the load-bearing v1 trust path; DONE.

- **2026-05-19 (v1-launch program session 9 cont. — ★★ GATE B / PHASE
  B COMPLETE: the genesis is SIGNED, VERIFIED, and COMMITTED; entering
  Phase C):** `create-key #2` (backup persona, key#2 `dba78ab5…0392`,
  after PIN-rotate + token swap; agent-driven corrected dry-run
  confirmed key#2 not key#1, then owner real run) wrote
  `keys/hello+backup@harrywinner.com.json`. Final independent
  verification of the COMPLETE store: 2 self-signed KeyFiles (key#1
  maintainer, key#2 backup-maintainer) + the unchanged ca ORIGIN
  mandate; `verify` exit 0 (`verify: OK`); `status` ca anchored 1/1
  valid; **`mandatePinHash()` recomputed from the STORED FILE via the
  protocol's own canonicalizer = the recorded anchor
  `5016749377de07fd3296e8207539bbe52b40fb58f971d946f4cc8990c7e801ae`
  exactly**; mandate carries `signedBy`+`signatures`. Committed
  atomically to flagship `main` **`1b86908`** (3 artifacts only; no
  `Co-Authored-By`; `.maintainers/` now fully tracked). The
  #7-exposed key#1 PIN was rotated by the owner (does not affect the
  signed mandate). **Gate B is satisfied; nothing deployed.** **NEXT =
  PHASE C** (#30/#9/#10): bake the SAME anchor
  `5016749377de…01ae` into FOUR surfaces — `@flagship/protocol`
  `maintainerCa.ts` `MAINTAINER_PINNED_MANDATE_HASH` (covers daemon #8
  + webapp #9 via the const), iOS (Swift), Android (Kotlin) — then
  re-gate + the c5 portable conformance replay so no surface ships
  with an empty/wrong pin. Pin `393b7a7`; agent-doable (code, not
  hardware).

- **2026-05-19 (v1-launch program session 9 cont. — ★ GENESIS `ca`
  ORIGIN SIGNED + independently verified; the root of trust now
  EXISTS; REMAINING = rotate the exposed key#1 PIN + create-key#2
  (backup persona) + commit `.maintainers/`):** The owner ran the real
  ceremony at pin `393b7a7`: `create-key #1` (1st attempt failed
  benignly — touch/PIN timing, nothing written; 2nd succeeded →
  `keys/hello@harrywinner.com.json`, key#1 `2137e739…71d7`) then
  `upsert-mandate --track ca` ORIGIN (hand-typed `UPSERT-MANDATE`, PIN
  + tap) → **wrote `tracks/ca/mandates/20260519T120808-706880c9.json`**.
  **★ THE CANONICAL ANCHOR (irreversible; bake per surface in Phase C):
  `mandatePinHash = 5016749377de07fd3296e8207539bbe52b40fb58f971d946f4cc8990c7e801ae`**
  — orchestrator INDEPENDENTLY recomputed `sha256(canonical bytes)` and
  it matches the CLI's printed `PIN (canonical hash)` exactly; `verify`
  exits 0 (`verify: OK`), `status` shows ca anchored 1/1 valid, holder
  key#1, successors [key#1 `2137e739…71d7`, key#2 `dba78ab5…0392`],
  rule 1-of-2 minSuccessors=1 maxDuration=315360000s(3650d), issued
  2026-05-19T12:08:08.205Z → expires 2026-08-27T12:08:08.205Z (100d).
  mandateId `706880c9-477e-4a8c-823c-9f8451b6930f`. Structure ==
  the pre-verified dry-run (fresh id/timestamps as expected).
  **PIN posture (honest, NOT a redo):** the owner did not confirm
  rotating the exposed PIN before signing. The mandate is nonetheless
  VALID and needs NO redo — the PIN is use-authorization, not key
  material and not part of the Ed25519 signature; `mandatePinHash` is
  PIN-independent. Residual risk is physical-theft-only (touch=ALWAYS
  still required); fully closed by `ykman piv access change-pin` now,
  which has zero effect on the signed mandate. **REMAINING (owner, own
  terminal):** (1) `ykman piv access change-pin` (key#1 still inserted
  — rotate before key#1 is reused/stored). (2) physically SWAP key#1
  out / key#2 in → tell the agent → agent runs the corrected
  `create-key #2` **dry-run** (`--signing-key yubikey-piv:slot=9c`,
  NOT `file:` — the earlier privkey trap; must resolve key#2
  `dba78ab5…0392`) → owner real `create-key #2` (`--display-name
  "Harry Winner (backup)" --email hello+backup@harrywinner.com --role
  backup-maintainer`, `--yes` OK, PIN + tap). (3) Agent final-verifies
  + commits `.maintainers/` (2 KeyFiles + the 1 ca ORIGIN mandate;
  pin `393b7a7`) → **Phase C** bakes `5016749377de…01ae` into the four
  surfaces (protocol-const → daemon + webapp; iOS; Android — SAME
  value). `.maintainers/` currently has key#1 KeyFile + the ca ORIGIN
  mandate (uncommitted, intentionally — the commit is atomic after
  create-key#2).

- **2026-05-19 (v1-launch program session 9 cont. — PR #8 MERGED +
  re-pinned + HUMAN real-terminal selftest PASSED; ★ REMAINING = rotate
  PIN + re-run the `ca`-only ceremony; nothing signed, `.maintainers/`
  clean):** The owner merged governed **PR #8** (squash
  `393b7a77935ae9b9bb680bd46f0924befb377d0c` on `origin/main`). Agent
  re-pinned `scripts/maintainers.pinned-sha` `835bbc6` →
  **`393b7a7`** (PR#8 first-parent merge SHA — fix verified present:
  `setRawMode(true)`, piv-pin.ts +452), ran `pull-maintainers.sh pull`
  (clone now detached AT the pin, clean, OFF the feature branch),
  re-ran BOTH gates at the pin (maintainers `tsc -b` clean + vitest
  **386/386·37·0-failed** 1.40s; flagship `tsc -b` clean, run from the
  repo root — a first attempt had a cwd-poisoning bug that re-ran the
  maintainers gate; caught + corrected), re-installed the non-manifest
  `pcsclite` (`packages/cli`, resolvable), confirmed `bin/maintainers`
  runs and `selftest-pin` fail-closes deterministically on piped/
  non-interactive input. **★ The owner ran `selftest-pin` in their OWN
  real terminal against the fixed code: PASS — prompt shown, NOTHING
  echoed, clean exit, non-empty read (a 6-byte dummy; the printed SHA
  is of the dummy, never a PIN).** That is the real-terminal acceptance
  gate met directly by the human, not by agent green checkmarks — the
  exact gap a `setRawMode` spy could not close is now closed.
  **REMAINING (owner, in their own terminal):** (1) **rotate the
  exposed PIV PIN** — the original was shown on screen by the #7 bug;
  `ykman piv access change-pin`. (2) Re-run the `ca`-only ceremony:
  `node packages/cli/bin/maintainers create-key #1` (key#1 "Harry
  Winner"/hello@harrywinner.com/maintainer; `--yes` acceptable; PIN +
  tap) → `upsert-mandate --track ca` ORIGIN (key#1 self-signed;
  successors=[key#1 `2137e739…71d7`, key#2 `dba78ab5…0392`] both
  `file:` pubkeys; threshold 1; minSuccessors 1; duration 100d;
  maxDuration 3650d; project flagship/hello@harrywinner.com; `--path
  ../.maintainers`; **NO `--yes`** — hand-type `UPSERT-MANDATE` + PIN +
  tap) → **swap to key#2** → agent-driven corrected `create-key #2`
  dry-run (`--signing-key yubikey-piv:slot=9c`, NOT `file:`) → owner
  real `create-key #2` ("Harry Winner (backup)"/
  hello+backup@harrywinner.com/backup-maintainer). (3) Agent verifies
  all 3 artifacts + records the single `ca`-track `mandatePinHash` +
  commits `.maintainers/` → Phase C. Pin `393b7a7`; nothing signed yet;
  tree clean.

- **2026-05-18 (v1-launch program session 9 — PR #7's PIN reader
  ECHOED the real PIN + crashed `EBADF`; OS-level fix is governed PR #8
  OPEN; ★ HUMAN-MERGE GATE — nothing signed, tree clean, pin `835bbc6`):**
  PR #7 was merged and the agent re-pinned `scripts/maintainers.pinned-sha`
  → **`835bbc6`** (PR#7 first-parent merge). The owner then ran the
  **real** `create-key #1` (ca-only) in their own terminal — and the
  PR-#7 PIN reader **(1) echoed every keystroke of the real PIN to the
  screen, then (2) crashed with an unhandled `EBADF` 'error' right after
  the prompt.** Owner reported it; agent OWNED the verify-before-trust
  gap honestly: code review + a hermetic suite that (correctly) injects
  a fake TTY *structurally cannot* prove real-terminal no-echo — that
  exact green combination passed for #7 and still shipped an echoing
  PIN. **Root causes:** (1) it read `/dev/tty` via generic `fs` streams,
  which have no `setRawMode`; terminal echo is OS-level termios, not a
  readline output-write property, so echo was never suppressed; (2) the
  single `/dev/tty` fd was double-closed on teardown with no `'error'`
  listener ⇒ the late `EBADF` became an unhandled `'error'` and crashed
  the process. **Fix (mechanism, not symptom)** on
  `feat/gate-b-piv-pin-noecho-fix` **`7ad159f`** (governed **PR #8
  OPEN**): open `/dev/tty` once as real `tty.ReadStream`/`tty.WriteStream`,
  put the terminal in **raw mode** so the *kernel* stops echoing, read
  bytes ourselves (Backspace/Ctrl-C/Ctrl-D/EOF handled, nothing written
  for typed chars), restore cooked mode in `finally`; **fail closed if
  `setRawMode` is unavailable** (same taxonomy as the non-interactive /
  no-`/dev/tty` aborts; `--yes` still never skips the PIN); lifetime
  swallowing `'error'` handlers on both streams + single `closed`-guarded
  `fs.closeSync` ⇒ a teardown/`EBADF` can never be unhandled, crash, or
  mask the signing outcome; PIN still never argv/env/file/log/error/stack.
  **Plus a hidden non-secret `selftest-pin` command** driving the SAME
  reader: the human types a throwaway dummy in a real terminal and sees
  only verdict + byte length + SHA-256, never the value — the
  **non-skippable real-terminal acceptance gate** that closes the gap a
  `setRawMode` spy cannot. Orchestrator independently audited (scope
  confined to `index.ts`+`piv-pin.ts`+its test; protocol/canonical/
  `piv-apdu`/`connectPcscChannel`/the `upsert-mandate` confirm UNtouched;
  `defaultEnv.pivPin` wiring unchanged; `selftest-pin` hidden from
  `printUsage`, never wired into signing), verified the tests assert the
  REAL properties (incl. an `EBADF`-swallow regression on the *real*
  `openControllingTty`), and re-ran BOTH gates: maintainers `tsc -b`
  clean + vitest **386/386, 37 files, 0 failed** (1.30s,
  hardware-independent); flagship `tsc -b` clean (real consumer via the
  workspace symlink). Committed (no `Co-Authored-By`), pushed, PR #8
  opened. **★ NEXT — HUMAN-MERGE GATE (the agent does NOT merge a
  governed maintainers PR / never pins an unmerged tip):**
  1. Owner merges PR #8 (`gh pr merge 8 --repo ibisllc/maintainers
     --squash` or via the UI).
  2. Agent re-pins `scripts/maintainers.pinned-sha` → PR#8 **first-parent
     merge SHA**; runs `bash scripts/pull-maintainers.sh pull`; re-runs
     BOTH gates at the new pin; **re-installs the non-manifest ceremony
     dep** `cd maintainers/packages/cli && npm i pcsclite --no-save`
     (the pull's `npm install` does NOT restore it).
  3. Owner runs **`node packages/cli/bin/maintainers selftest-pin`** in
     their OWN real terminal, types a **DUMMY** (e.g. `test123`, NOT a
     PIN) → must see the prompt, NOTHING echoed, `SELFTEST PASS` + a
     byte length + SHA, and no crash. Only that re-trusts the IO path.
  4. Owner **rotates the YubiKey PIV PIN** (the original was shown on
     screen by the #7 bug — treat it as exposed; `ykman piv access
     change-pin`).
  5. Owner re-runs the `ca`-only ceremony in their own terminal:
     `create-key #1` (key#1; `--yes` acceptable, PIN+tap) →
     `upsert-mandate --track ca` ORIGIN (key#1; **NO `--yes`**, hand-type
     `UPSERT-MANDATE` + PIN + tap) → swap to key#2 → agent-driven
     corrected `create-key #2` dry-run (`--signing-key
     yubikey-piv:slot=9c`, NOT `file:`) → owner real `create-key #2` →
     agent verifies all 3 artifacts + records the single ca-track
     `mandatePinHash` + commits `.maintainers/`. Then Phase C.
  Nothing signed yet; `.maintainers/` clean; pin `835bbc6` until PR #8
  merges.

- **2026-05-18 (v1-launch program session 8 cont. — the REAL `ca`
  ceremony surfaced + fixed a 2nd deferred-seam gap; PR #7 open):**
  The owner ran the real `create-key #1` (ca-only scope). First via
  Claude's `!` prefix → the typed-confirm correctly **fail-closed**
  (non-interactive; nothing signed — the ceremony hardening working).
  Re-run in the owner's real terminal → typed `CREATE-KEY` accepted,
  then `error: yubikey-piv: a PIN provider is required (the command
  must prompt; the PIN is never read from argv and never logged)`.
  **Verify-before-trust root cause:** `defaultEnv` (index.ts) wired
  `pivTransport` but **never `pivPin`** — the interactive PIN reader
  existed only as an injectable seam; dry-runs never exercised it (they
  do the no-PIN public read), so the REAL ceremony is the first thing
  that needs a PIN and it correctly fail-closed (nothing signed).
  **Owner UX point conceded + recorded:** the hand-typed confirm is
  over-gatekeeping for the non-load-bearing/redoable `create-key`
  (`--yes` is acceptable there — already works, verified); keep it
  mandatory only for the irreversible `upsert-mandate`/`ca-endorsement`.
  Fix landed on `feat/gate-b-piv-pin-provider` **`c67c788`** (governed
  **PR #7 open**): new `packages/cli/src/lib/piv-pin.ts` `pivPinFromTty`
  + `defaultEnv.pivPin` wiring. Orchestrator READ the actual code +
  verified the security contract (no-echo `/dev/tty` not the stdin
  pipe; never argv/env/file/log/error/stack; non-interactive ⇒
  deterministic CliError BEFORE opening any device — never hangs/
  fabricates; one prompt, no auto-retry ⇒ never burns the 3-try
  counter; fd always closed; no fallback) + re-ran both gates
  (maintainers tsc clean + vitest **372/36 → 379/37**, +7 hermetic, 0
  failed, 1.37s hardware-independent; flagship tsc clean). Confined to
  index.ts(+14) + 2 new piv-pin files; protocol/canonical/piv-apdu/
  connectPcscChannel/the upsert-mandate-confirm untouched; pin
  `ce6691c` unchanged. **The PIN must NEVER transit the agent** — it
  is read no-echo locally; the owner's real ceremony run post-merge IS
  the live end-to-end verification. **Next:** merge PR #7 → agent
  re-pins to its first-parent merge SHA + reruns both gates +
  re-installs the `pcsclite` ceremony dep → owner re-runs the
  `ca`-only ceremony **in their own terminal** (create-key#1 →
  upsert-mandate --track ca ORIGIN, both key#1; then swap to key#2 →
  agent-driven corrected create-key#2 dry-run → owner real
  create-key#2) → agent verifies + records the single ca
  `mandatePinHash` + commits `.maintainers/`. Nothing signed yet; tree
  clean.

- **2026-05-18 (v1-launch program session 8 cont. — genesis SCOPE
  decided: `ca` ONLY; ops dropped; release deferred):** After a
  multi-turn simplicity/threat-model dialogue (the owner pushed hard
  on "maintainers must be simpler than existing frameworks or use
  them"), the irreversible genesis scope is settled: **sign the `ca`
  track ORIGIN only.** `ops` dropped (no concrete v1 consumer —
  speculative ceremony complexity). `release` **deferred**: its own
  small *isolated* later genesis if/when a release-role actually
  exists; for v1-alpha, self-hosted-update integrity rides on
  app-store signing + reproducible-build CI, and TUF/Sigstore are the
  mature standards for that slice (recorded honestly — maintainers'
  `release` track is a deliberately-simplified TUF-targets slice;
  maintainers' genuine sweet spot is the `ca`/identity-authority plane
  TUF cannot model). A later `release` genesis does NOT touch the `ca`
  root; the checkpoint multi-track `track` column already accommodates
  it. Key dialogue outcomes recorded so they are not re-litigated:
  (a) hot-Cloudflare-key-signs-releases was REJECTED — it collapses
  the cold/hot split (identity-attestation blast radius is time-boxed
  + self-healing; a malicious release is persistent RCE on every box;
  reproducible-build SHA = integrity, NOT authority/freshness);
  (b) the *cold* key could sign both but two tracks cost the same now
  and stay separable — not worth permanent coupling; (c) only TWO keys
  exist (primary key#1 + backup key#2), held across track(s) — NOT
  per-track-distinct; their distinctness = the no-escrow
  threshold-1-of-{primary,backup} recovery. **Ceremony (ca-only),
  about to run; NOTHING signed yet, pin `ce6691c`, tree clean:**
  (1) `create-key #1` (key#1 on-token: "Harry Winner" /
  hello@harrywinner.com / maintainer), (2) `upsert-mandate --track ca`
  ORIGIN (key#1 self-signed; successors=[key#1 `2137e739…71d7`, key#2
  `dba78ab5…0392`] both `file:` pubkeys; threshold 1; minSuccessors 1;
  duration 100d; maxDuration 3650d; project flagship /
  hello@harrywinner.com; `--path ../.maintainers`), — both with key#1
  plugged in; then (3) **swap to key#2** → `create-key #2` (key#2
  on-token: "Harry Winner (backup)" / hello+backup@harrywinner.com /
  backup-maintainer). ★ `--signing-key file:<pubkey>` = a PRIVATE-key
  source (the CLI derives a pub from it) — a verify-before-trust
  dry-run catch; create-key #2 MUST use `--signing-key
  yubikey-piv:slot=9c` with key#2 physically present, NOT a file
  shortcut. `--successors file:<pubkey>` IS used literally (correct).
  Real runs are human-performed (typed `CREATE-KEY`/`UPSERT-MANDATE`
  confirm + PIN + tap; never `--yes`/`--dry-run`); orchestrator drives
  the corrected create-key#2 dry-run + verifies every artifact +
  records the single **ca-track `mandatePinHash`** (Phase C bakes that
  one value into 4 surfaces) + commits `.maintainers/` (2 KeyFiles + 1
  ca ORIGIN). All dry-runs were verified structurally correct
  (FROM-SCRATCH ORIGIN recognised post-placeholder-cleanup; PIN/PUK
  3/3 unchanged by dry-runs).

- **2026-05-18 (v1-launch program session 8 cont. — genesis
  decision-gate RESOLVED; NEW Phase H "Maintainers Checkpoints"
  roadmapped, additive):** The owner sought an independent second
  opinion on "single pinned mandate-hash as the sole anchor" and
  adopted a **Maintainers Checkpoints** witness layer — full spec
  captured verbatim at `docs/maintainers-checkpoints-spec-v0.1.md`,
  roadmapped as **Phase H**, recorded in the v1-launch progress log +
  [[project-resume-2026-05-16]]. It is a public append-only mirrorable
  witness log (separate `ibisllc/maintainers-checkpoints` repo, 1
  CSV/project, PR-based, bot-validated incl. the §11 continuity rule
  `H_old ∈ chain(H_new)`) + a `maintainers checkpoint submit` CLI + an
  OPTIONAL advisory consumer check. **★ Verify-before-trust assessment
  (confirmed to the owner): it is PURELY ADDITIVE — zero change to the
  shipped Mandate/canonical/verifier/L1-L3/D3/conformance/pin; it does
  NOT change "what is already built"; and being inherently post-genesis
  it does NOT block Gate B.** ⇒ The decision-gate that paused the
  genesis is resolved (the owner's "iffy on its own" concern is now
  met by an additive layer, not a root change). 5 open Phase-H build
  details (do NOT lose) are at the foot of the spec file: (1)
  authority-proof signing = holder-signs vs succession-quorum
  (the shipped model is holder-signs; pin this for bot/spec
  consistency); (2) make the checkpoint request a first-class
  canonical-bytes signed envelope `maintainers/checkpoint-request/v1`
  + conformance vectors (not ad-hoc); (3) sequencing vs Gate B
  (genesis-now vs build-tooling-first — posed to owner); (4) creating
  `github.com/ibisllc/maintainers-checkpoints` is a human/credential
  gate; (5) the validating bot is itself an attack surface (mitigated
  by advisory-only + §11 continuity + public PR trail + mirrors; keep
  its verifier = the published `@ibisllc/maintainers`, no bespoke
  re-impl). **Genesis is UNBLOCKED; awaiting the owner's 2 pin-down
  answers (sequencing; authority-signing-semantics) + the 2 persona
  identities, then dry-runs → human-signed real runs.** Pin `ce6691c`
  unchanged; nothing signed; tree clean.

- **2026-05-18 (v1-launch program session 8 cont. — Gate-B genesis
  PREREQUISITE landed; pre-ceremony dry-run caught TWO real defects;
  Option-2 adopter-faithful path chosen):** Re-pinned to PR#6 merge
  `ce6691c` (flagship `a1a53ed`, gates 372/36 · 2567/227), re-installed
  the `pcsclite` ceremony dep (`--no-save`). The **pre-ceremony dry-run
  did its job** — caught two defects BEFORE any irreversible signing
  (nothing signed; PIN/PUK still 3/3):
  - **(1) Runbook command drift:** Operation 0 said
    `node packages/cli/dist/index.js …` but `dist/index.js` is
    exports-only (no self-exec; tests call `dispatch()`); the real
    entry is `node packages/cli/bin/maintainers …`. Fixed in
    ca-operations (5×).
  - **(2) Procedure vs committed-artifact conflict:** a from-scratch
    ORIGIN refuses if a track mandate already exists — and
    `../.maintainers` shipped committed deterministic PLACEHOLDER
    genesis mandates (`bootstrap-flagship-maintainers.mjs` scaffold).
    **User's deciding criterion = "what does a real adopter do?": a
    fresh adopter has no placeholder; clean from-scratch ORIGIN by the
    YubiKey, bake THAT hash ⇒ Option 2 — retire the placeholder
    scaffold so Flagship == an honest adopter reference template.**
  - **Conceptual model confirmed (do not re-litigate):** "backup is
    the only recovery" = the catastrophic case only (can't satisfy the
    current mandate's approvalRule ⇒ chain dead, no escrow); while you
    still can, you may redefine holder/successors/threshold freely next
    mandate. holder/successors/threshold independent per mandate; a
    maintainer may self-exclude from `successors` (irrevocable; bounded
    by `minSuccessors`). Branch/equivocation defense = pin-is-floor +
    public append-only canonical log (community DETECTION) + signed
    timestamps/bounded maxDuration + D3 NOW-clock lease +
    ReleaseEndorsement; full equivocation PREVENTION (CT gossip) is an
    EXPLICITLY ACCEPTED out-of-scope limitation. `create-key` gets the
    same test→dry→real treatment (the email↔pubkey KeyFile layer the
    GUI successor-selection needs).
  - **Landed `2016985` (flagship `main`; orchestrator audited +
    re-ran the gate):** `git rm` the 5 placeholders + the 2 scaffold
    files; `.maintainers/` now clean (README only); chain already
    fail-closed via the empty `MAINTAINER_PINNED_MANDATE_HASH`
    (UNCHANGED `""` — NO ceremony/bake performed). No reader needed
    conversion (server-daemon/installer tests build own fixtures +
    already assert pin-unconfigured fail-closed; no hook/CI ran the
    scaffold). `ca-operations.md` Operation 0 reconciled to the
    adopter-identical flow (bin/maintainers; (P) → `create-key` ×2
    (dry→real) → from-scratch `upsert-mandate` ORIGIN ×3
    `ca`/`release`/`ops` (dry→real) → `verify`/`status` → record each
    `mandatePinHash`; bake = Phase C). Flagship-only; ZERO maintainers/
    protocol/pin change. Gate **2567/227 → 2563/226** (−4 = exactly the
    obsolete bootstrap test; 0 failed; no real coverage lost). Pin
    `ce6691c` unchanged.
  - **NEXT (params decided; awaiting only the 2 persona identities):**
    ORIGIN per track — `--duration 100d --max-duration 3650d`
    (user-chosen frozen ceiling), `--signing-key yubikey-piv:slot=9c`,
    `--holder` omitted (self-signed ORIGIN), `--successors` = BOTH keys
    (key#1 `2137e739…71d7` + key#2 `dba78ab5…0392`, as `file:` pubkeys)
    `--threshold 1 --min-successors 1`, `--project-name flagship
    --project-contact hello@harrywinner.com --path ../.maintainers`.
    `create-key` ×2 needs the user's persona display-name/email/role
    (primary=key#1, backup=key#2). Then orchestrator drives all
    dry-runs (non-destructive; verify exact canonical bytes) → human
    performs each real signed run (typed confirm + PIN + tap) →
    orchestrator `verify`/`status` + records the 4-surface
    `mandatePinHash`. `file:` NOT acceptable for the root signer.
- **2026-05-18 (v1-launch program session 8 cont. — GATE-B step (A)
  DONE + a pre-existing root-of-trust bug caught & fixed; PR #6 open,
  awaiting governed merge):** The user provisioned BOTH YubiKeys
  (on-token Ed25519 slot-9c; PIN set, PUK set, PIN-protected randomly-
  generated mgmt key — confirmed via `ykman piv info`). Orchestrator
  preconditions: fixed the predicted `-g` pcsclite blocker (the user's
  `npm i -g pcsclite` is NOT Node-resolvable from the CLI; installed
  `pcsclite` into `maintainers/node_modules` via `--no-save` — §28
  optional dynamic import, NOT in package.json/lockfile, transient
  ceremony-build dep); captured the **independent oracle** = key-#1
  slot-9c pubkey `2137e739f00550b0e6a33a75366ebaf16f66f3492f733d0a8010
  ba91ab5e71d7` via PIN-less `ykman piv keys export`.
  - **Step (A) — native binding** (subagent → orchestrator verify):
    `connectPcscChannel`'s fail-closed stub body replaced with the real
    libpcsclite wiring behind the unchanged `PcscChannel` seam +
    `piv-apdu` codec (reader/card bounded wait → `connect(SCARD_SHARE_
    SHARED)` → `Uint8Array↔Buffer` transmit; PC/SC → typed taxonomy).
  - **★ The hardware gate caught a pre-existing, hardware-only,
    root-of-trust bug (verify-before-trust's whole purpose):**
    `getPublicKey` issues GET METADATA (INS 0xF7, no-PIN) but parsed it
    with `extractEd25519PublicKey`, which only knows the **GENERATE**
    template `7F49{86}`. A REAL YubiKey 5.7.4 GET METADATA response is
    a flat TLV seq — pubkey under top-level `0x04 → 0x86` (32 B), **no
    `7F49`** — so the production no-PIN signer-pubkey path threw on
    every real token (synthetic unit fixtures never caught it). Fixed
    via a dedicated strict fail-closed `extractMetadataPublicKey`
    (Ed25519-alg sanity; `0x04→0x86`; exactly 32 B); `generateEd25519`
    keeps `extractEd25519PublicKey` for the genuine GENERATE shape;
    hermetic regression test built from the REAL captured metadata
    bytes + 5 fail-closed negatives; no coverage deleted.
  - **Orchestrator independent verify-before-trust (never trusted the
    subagents):** audited the diff (5 cli files; `piv-apdu` change
    confined to the pubkey-parse area; binding body + 2 test-
    hermeticity fixes preserved; pin/protocol/lockfile untouched);
    re-ran the hermetic gate itself (tsc -b clean + vitest **370 →
    372/36, 0 failed, ~1.3 s** — hardware-independent, build-not-wired
    assertions injected not env-dependent); and **independently
    re-drove BOTH the raw transport AND the full production path
    `loadSignerPubKey("yubikey-piv:slot=9c")` against the real token,
    3/3 === the oracle, with `ykman` PIN tries AND PUK tries `3/3`
    unchanged BEFORE and AFTER (provably no PIN / touch / sign / write
    — non-destructive public read only).** Throwaway `/tmp` harnesses
    scrubbed. cwd-poisoning recurred once (a maintainers-cwd then a
    relative `docs/` path → "No such file"; caught, re-run with
    absolute `cd /Users/harrywinner/flagship`).
  - **Committed `feat/gate-b-pcsc-binding` `59363fa` (off `df992f2`),
    pushed; governed PR `ibisllc/maintainers#6` OPEN.** `pcsclite` NOT
    added to any manifest. Pin `df992f2` UNCHANGED (re-pin on the
    governed merge — PR #1..#5 precedent).
  - **NEXT (after the human merges PR #6):** (1) re-pin
    `scripts/maintainers.pinned-sha` → PR#6 first-parent merge commit;
    `pull-maintainers.sh pull`; re-run both gates. (2) **Re-install the
    ceremony-build dep** — `pull-maintainers.sh` `npm install` will NOT
    restore `pcsclite` (optional, not in manifest): re-run `cd
    /Users/harrywinner/flagship/maintainers && npm i pcsclite --no-save`
    before the ceremony. (3) With key #1 plugged in: `--dry-run` all 3
    tracks (ca, release, ops) — no PIN/tap, the no-PIN pubkey read now
    works on real hw (proven). (4) The human runs each real
    `upsert-mandate` (types `UPSERT-MANDATE` + PIN + tap). (5) Agent
    `verify`/`status`, recompute + record each track's `mandatePinHash`
    (Phase C bakes that into 4 surfaces). `file:` NOT acceptable for
    the genesis root. Deploy nothing. Full runbook =
    `docs/ca-operations.md` Operation 0.

- **2026-05-18 (v1-launch program session 8 — ★ AGENT-DOABLE WORK
  EXHAUSTED ON THIS ENV; clean documented stop at the human/credential/
  hardware boundary):** Phase F recon (verify-before-trust +
  [[feedback-no-hardware-assumptions]]): this box is **darwin/arm64
  with NO qemu, NO docker/colima/lima, NO Linux**; the ISO is **Alpine
  x86_64** built by a **Linux-only** `scripts/build-flagship-iso.sh`
  (`xorriso`, `runs-on: ubuntu-22.04`). ⇒ the Phase-F agent-doable part
  (ISO build + local QEMU smoke) **cannot be responsibly performed or
  verified here** (same env-gate class as Android-no-JDK). The
  *reproducible ISO build itself is already CI-proven* (§S
  reproducible-build ✅, build-iso.yml builds twice + cmp). Also
  verified the last two candidate §S items are **code-complete** (gap
  is live/operational, not agent code): **#4 LLM-promo cap** =
  `packages/control-plane/src/llmPromo.ts` + 5 green test files
  (`control-plane/tests/llmPromo.test.ts`, `apps/web/tests/
  {llmPromo,webappPromoUi,surfaceSplit}.test.ts`, `storage/tests/
  inMemory.test.ts`); deployed per backlog #3 — gap = the live cap
  demonstration. **#9 security disclosure** = `apps/web/public/
  security/disclosure.html` (9.2 KB) + `report.html` (5.2 KB) exist —
  gap = operational bounty payouts (not code).
  - **★ STATE OF THE WHOLE PROGRAM (this is the resume anchor):**
    flagship `main` tip `95f88a7` (gate **2567/227** tsc-clean);
    maintainers pinned `df992f2` (gate **370/36** tsc-clean); package
    is `@ibisllc/maintainers@0.1.0`. Working tree clean except the
    perpetual `project.pbxproj` xcodegen artifact (never commit). ALL
    agent work committed + pushed.
    - **Phase A (agent-side): COMPLETE** — c4.6/c4.7/c5 + ceremony
      hardening + PRs #3/#4/#5 merged + re-pinned + the rename.
    - **Phase E (agent-doable): COMPLETE** — marketplace scanner BUILT
      (`9aac1ec`); iOS code-complete+232-XCTests-green; Recovery
      J.3/J.4 + the E2E rig+13-scenarios+CI verified already built.
    - **Phase B — HUMAN+HARDWARE:** the genesis ceremony. (P)
      provisioning checklist is armed in `docs/ca-operations.md`
      Operation 0: install `pcsclite`+`ykman`; `ykman piv keys
      generate --algorithm ED25519 --pin-policy ONCE --touch-policy
      ALWAYS 9c …` on BOTH YubiKeys; decide DURATION (LOCKED D1
      long-lived, e.g. `3650d`) + policy (`--threshold`/
      `--min-successors`/`--max-duration`). Then the agent implements
      + LIVE-verifies the `connectPcscChannel` libpcsclite binding
      WITH the reader/token (governed `maintainers` PR + re-pin; the
      in-code GATE-(A) plan is in `packages/cli/src/lib/piv-pcsc.ts`),
      `--dry-run`, then the human types `UPSERT-MANDATE` + PIN + taps;
      agent verifies the chain + records `mandatePinHash`.
    - **Phase C — BLOCKED on Gate B** (needs the genesis mandate hash):
      bake `MAINTAINER_PINNED_MANDATE_HASH` per surface (protocol-const
      + webapp via it + iOS + Android — 4 locations, one value) + wire
      #9 (webapp link-4) / #10 (iOS+Android verify-forward reimpl),
      each PROVEN against the published `maintainers/conformance/`
      vectors incl. the absent/forked-pin reject.
    - **Phase D:** #31 (web-ui status/preview-only) already enforced
      (signing views deleted in c4.5b); #32 (generic OSS NFC-tap app,
      Android-first) is a multi-week upstream app, post-merge — NOT a
      v1-launch blocker.
    - **Phase F — ENV + CREDENTIAL gate:** needs a Linux/x86_64 box
      (or Docker) with qemu/KVM to build+smoke the ISO, then a PAID
      VPS that boots a custom ISO (Vultr `vultr-cli iso create --url`,
      or Hetzner `hcloud` / Scaleway `scw`) — user supplies the API
      token (`! export VULTR_API_KEY=…`). Chain: phone-sim mints a
      build code at `flagshipserver.com/dev/create-server` → `/build/`
      personalizes the ISO → boot on the VPS → first-boot installer
      (LUKS + register) → tunnel up → `curl https://<server>.<user>.
      flagship.services/` real green padlock → exercise unlock-on-boot
      / auto-unlock-lease+renewal / WebAuthn-PRF recovery / Web Push.
    - **Phase G — LIVE/HUMAN exercises** to tick §S: iOS TestFlight
      (`[[project-testflight-blockers]]`: 4 wrangler APNs `secret put`
      in `apps/com/`, Apple "Associated Domains" tick, Archive→ASC,
      ASC metadata, real-device push smoke, 5 testers); Android on a
      JDK box → Play internal; marketplace ≥10 listings + ≥3
      cross-pod installs (scanner code now exists); update-pack 7-day
      two-pod; lineage-break live; STK rotation live; recovery
      lost-phone live; LLM-cap live demo; bounty payouts.
    - **DEFERRED non-blocking:** `npm publish @ibisllc/maintainers
      @0.1.0` — create the `ibisllc` npm org + a FRESH `@ibisllc`-
      scoped bypass-2FA token (**the token the user pasted earlier is
      BURNED — revoke it at npmjs.com → Access Tokens**); then `cd
      maintainers/packages/protocol && npm publish --access public`
      (the orchestrator then verifies it + does the flagship-drops-
      `pull-maintainers.sh`+`maintainers.pinned-sha`+symlink chunk —
      the symlink-is-live-consumer gotcha ends there). Off the
      critical path (the pull-script bootstrap works).
  - **The orchestrator did NOT fake any gate.** Clean stop per the
    program's §5: everything agent-doable on this env is landed +
    gate-green + pushed + documented; each remaining step has a
    precise copy-pasteable runbook above / in `ca-operations.md`. A
    resume on a Linux+qemu box can take Phase F directly; the human
    gates are independent and can proceed in any order.

- **2026-05-18 (v1-launch program session 8 — Phase E agent-doable
  work COMPLETE; recon-vs-prompt discrepancies recorded):**
  Verify-before-trust over the prompt's Phase-E framing (the prompt
  lists iOS/recovery/E2E as build work; the in-repo reality is they're
  built):
  - **Recovery J.3/J.4 = code-complete, runtime-wired, tested green**
    (NOT greenfield as the prompt implies). J.3 = `server-daemon/src/
    postRecovery/rePairWatcher.ts` (327 ln: new-IRK re-pair envelope →
    `.com` 24h grace → `/api/users/:u/re-pair/complete` atomic IRK swap
    → daemon polls, drops paired-session tokens, restart-safe marker);
    `.com` routes wired `apps/com/src/controlPlaneRoutes.ts:200-203,668`
    (RE_PAIR_INITIATE/OBJECT/COMPLETE/GET); daemon wires `RePairWatcher`
    in `index.ts:31-33`. J.4 = `postRecovery/stableIdReissuer.ts`
    (356 ln: `reissueStableIds` walks `appPlatform.list()` → re-issues
    stable-ids → per-app alert-inbox summaries). Tests green in the
    2567/227 gate: `control-plane/tests/rePair.test.ts` (~12+ cases:
    initiate/grace/object/complete/If-Match-ETag-race/412/404/cancel),
    `server-daemon/tests/rePairWatcher.test.ts`. **The §S "Recovery
    (lost phone → new phone) exercised live" gap is the LIVE EXERCISE
    (Phase G; 2 phones + live pod + .com), NOT code. Do not rebuild.**
  - **E2E rig + ALL 13 plan scenarios + CI = already built** (backlog
    #15). `apps/web/e2e/` rig (fixtures/flows/pod-sim/playwright.config)
    + 17 specs s00–s16 covering plan S1–S13 (★ **S7 "Silent
    auto-renewal — CRITICAL" is folded into
    `flows/s06-long-lived-lease.spec.ts:72`**, not a missing `s07-`
    file — verified it mirrors the plan's S7 12h-within-window steps) +
    extra surfaces S14–S16, + `.github/workflows/e2e.yml` (3.8 KB,
    chromium-only, wrangler-dev + Playwright). **Gap = a green run on a
    real GitHub Actions runner — a CI-execution gate (the CLI cannot
    trigger/run Actions; identical seam to build-iso.yml), NOT a code
    gap.**
  - **⇒ THE AGENT-DOABLE PHASE E IS COMPLETE.** The only net-new
    Phase-E code required was the marketplace scanner (`9aac1ec`,
    landed+verified this session). iOS = code-complete+232-XCTests-green
    (human TestFlight gate). Android = real-impl but env-gated on this
    Mac (no JDK; needs a JDK/Android-SDK box). Phase-E's residual items
    are ALL human/credential/CI/live-exercise gates.
  - **Next agent chunk = Phase F's agent-doable part: build the
    personalized ISO via the reproducible-build path
    (`scripts/build-flagship-iso.sh` + the `build-iso.yml`
    determinism path) and SMOKE IT LOCALLY with QEMU/KVM** (free,
    deterministic, CLI). The TRUE end-to-end on a real cloud VPS is a
    PAID CREDENTIAL gate (user supplies the API token; candidates
    Vultr `vultr-cli` / Hetzner `hcloud` / Scaleway `scw`). Per the
    program: drive the agent-doable build+local-smoke; PAUSE at the
    paid-VPS credential gate with the copy-pasteable runbook.

- **2026-05-18 (v1-launch program session 8 — Phase E: marketplace
  security-scan service BUILT; latent wire-contract bug fixed):**
  flagship `9aac1ec`, pushed. A non-functional scaffold existed at
  `services/marketplace-scanner/` (already in root tsconfig +
  vitest.config). A fresh subagent built it into a real fail-closed
  pure-core + injected-ports service. **★ verify-before-trust caught a
  latent wire-contract bug:** the scaffold's `scanResult.ts` hand-rolled
  the canonical tag `flagship/marketplace-scan/v1`, but the landed
  `@flagship/protocol` + the (already-built) `control-plane`
  `handleMarketplaceScanResult` use `flagship/marketplace-scan-result/
  v1` — the scaffold could NEVER have produced a result `.com` accepts.
  Fixed by reusing `@flagship/protocol`'s `signMarketplaceScanResult`/
  `verifyMarketplaceScanResult` (zero hand-rolled bytes — the
  iOS-Mock-matches-Worker-wire discipline). Orchestrator-audited:
  change set confined to `services/marketplace-scanner/` (ZERO
  protocol/control-plane/storage/migration change — the receive side +
  `scan_grade`/`scan_report_key`/`scan_completed_at` schema were
  already built); the signed postback round-trips through the REAL
  landed `verifyMarketplaceScanResult` (construct→sign→verify ✓;
  tamper-any-field/forge/wrong-key→reject ✓); fail-closed asserted
  (`SCAN_ERROR_GRADE`="F" for ANY error string, `isPassingGrade`∈
  {A,B,C} — a clone/tool/timeout/hash-mismatch can never yield a
  passing grade, and the F is still scanner-signed; no unsigned/bypass
  path); real git/trivy/npm/semgrep/R2/postback isolated behind ports
  (vitest never execs them — they're a thin `adapters.ts` live edge).
  Deterministic A–F worst-dominates policy in `POLICY.md` + `grade.ts`.
  Orchestrator re-ran the gate itself: flagship tsc -b clean + vitest
  **2529/225 → 2567/227** (+38, 0 failed). §L "docker image" vs the
  landed "clone-repo-at-manifest_hash" envelope reconciled:
  `imageDigestHex` = sha256 of the scanned source tree at the pinned
  hash (semantically "which artifact got the grade"; zero wire change).
  Pin `df992f2` unchanged. **Next Phase-E chunk: verify/complete
  Recovery J.3/J.4** (recon: substantially BUILT already —
  `server-daemon/src/postRecovery/{rePairWatcher,stableIdReissuer}.ts`
  + `control-plane/tests/rePair.test.ts` + `server-daemon/tests/
  rePairWatcher.test.ts`; the §S gap is the lost-phone LIVE exercise,
  Phase G, not greenfield code — verify completeness, don't rebuild)
  → then E2E rig 13 scenarios + CI.

- **2026-05-18 (v1-launch program session 8, Mac/darwin — PR #5
  merged + re-pinned `df992f2`; agent-Phase-A COMPLETE; entered Phase
  E; iOS verified GREEN/human-gated, Android env-gated here):** The
  human merged governed **PR #5** (the `@maintainers/protocol`→
  `@ibisllc/maintainers` rename). Verify-before-trust: `gh pr view 5`
  MERGED, merge `df992f2` (first parent `4a272b9` = old pin, second
  `5f93129` = rename branch tip; `git diff df992f2 5f93129` empty ⇒
  merged tree == gate-verified tree). Re-pinned
  `scripts/maintainers.pinned-sha` `4a272b9`→**`df992f2`** (first-parent
  merge commit, PR#1..#5 rule), `pull-maintainers.sh` reset the clone,
  both gates re-run GREEN AT THE PIN (maintainers tsc -b clean +
  370/36; flagship tsc -b clean + 2529/225, resolving
  `@ibisllc/maintainers` via the regenerated workspace symlink).
  Committed flagship `0eddcb8` (pin only). **⇒ THE ENTIRE AGENT-SIDE
  PHASE A IS COMPLETE** (protocol-product spine c4.6/c4.7/c5 + ceremony
  hardening + governed PRs #3/#4/#5 merged+re-pinned + the
  npm-publishable `@ibisllc/maintainers` rename).
  - **★ Phase-E verify-before-trust over the prompt's framing (docs
    win):** the prompt lists "iOS real impl" as build work, but the
    in-repo+memory reality is iOS is **production-grade + fully green**.
    Orchestrator regression-verified at current HEAD on this Mac
    (Xcode 16.4): `xcodegen generate` + `xcodebuild …FlagshipApp build`
    = **BUILD SUCCEEDED**; `xcodebuild -scheme FlagshipMobile-Package …
    test` = **232 tests, 0 failures, TEST SUCCEEDED** (the suite grew
    110→232; iOS has ZERO `@maintainers`/`maintainers/protocol` import
    coupling — provably unaffected by this session's heavy
    maintainers-rename work; that is WHY it stayed green). The pbxproj
    is the regenerated xcodegen artifact — left unstaged as always.
    **There is NO iOS implementation gap; every remaining iOS step is
    the user-side TestFlight gate** ([[project-testflight-blockers]]:
    4 wrangler APNs `secret put` in `apps/com/`, Apple-portal
    "Associated Domains" capability tick on `com.flagshipserver.app`,
    Xcode Archive→Distribute→ASC, ASC metadata [privacy URL / 1024²
    icon / screenshots / nutrition labels / "what to test"],
    real-device push smoke [sim never yields a real APNs token],
    invite 5 external testers [Apple beta review 1–2 d]). None
    agent-advanceable — do NOT spawn an iOS "impl" subagent; it's done.
  - **★ Android env-gate (this Mac):** Android is real-impl work (the
    Kotlin is canonical-bytes-mirror scaffolds, not a built app) but
    this Mac has **no real JDK** (`/usr/bin/java` stub) → Android is
    **review-only here**; a Gradle build/verify needs a JDK+Android-SDK
    box (the resume-#2 Linux box had it; this darwin box does not). Do
    not bolt unverifiable Android changes here — env-gated.
  - **Next agent chunk = the marketplace security-scan service**
    (`marketplace_listings.scan_grade` ships NULL today; CLAUDE.md
    outstanding #4 — pull a docker image → Trivy + custom checks →
    post back grade + an R2 report; MVP-blocking for the public
    marketplace; fully agent-doable, flagship-vitest-verifiable, no
    human/hardware/credential gate). Recon also found **Recovery
    J.3/J.4 is substantially BUILT already** (`server-daemon/src/
    postRecovery/{rePairWatcher,stableIdReissuer}.ts` + `control-plane/
    tests/rePair.test.ts` + `server-daemon/tests/rePairWatcher.test.ts`)
    — contradicts the prompt's "needs building" framing; the gap is
    the live exercise (Phase G), not greenfield code (verify when its
    turn comes). The **E2E rig exists** (backlog #15: 46 tests/17
    files, `apps/web/e2e/flows/`) — gap = the full 13 scenarios per
    `docs/e2e-test-plan.md` + CI. Phase-E agent order (env-aware):
    marketplace scanner → recovery J.3/J.4 verify/complete → E2E
    scenarios; iOS = human-gated handoff (done), Android = env-gated.

- **2026-05-18 (v1-launch program session 8, Mac/darwin — PR #3+#4
  merged + re-pinned; `@maintainers/protocol`→`@ibisllc/maintainers`
  rename landed, PR #5 open):** The human merged governed **PR #3**
  (Phase-2 spine) then **PR #4** (npm packaging-prep). Verify-before-
  trust: re-pinned `scripts/maintainers.pinned-sha` `833fa45`→`8e8915e`
  (PR#3 first-parent merge; flagship `ea9f707`) then `8e8915e`→
  **`4a272b9`** (PR#4 first-parent merge; flagship `aceb204`), both
  gates re-verified GREEN at each pin (maintainers 370/36; flagship
  2529/225). **★ npm-publish blocked by a namespace fact (not our
  code):** `npm publish` advanced ENEEDAUTH→403(2FA)→**404 "Scope not
  found"**. Root cause via `npm view`: an unrelated unscoped
  `maintainers@1.0.0` (owner `alestoraldous`) EXISTS ⇒ npm forbids
  creating an org named `maintainers` ⇒ the `@maintainers` scope is
  **permanently unobtainable** ⇒ `@maintainers/protocol` is
  unpublishable. `@ibisllc/maintainers` is free (`npm view` E404) and
  is the clean `github.com/ibisllc/maintainers` provenance mapping.
  User decided (AskUserQuestion): rename now, publish later, then
  proceed critical-path. **Scoped npm names do NOT collide with
  unscoped ones; the blocker is org-name==existing-package
  reservation. Lesson: pick the npm scope BEFORE the first publish
  attempt; a scoped package needs its org creatable.**
  - A fresh subagent did the **pure specifier rename**
    `@maintainers/protocol`→`@ibisllc/maintainers` (43 maintainers
    files on branch `chore/rename-protocol-to-ibisllc-maintainers`
    `5f93129`, **governed PR #5 OPEN**; +60/−60, zero semantic change;
    `package.json` name only [exports/files/publishConfig/prepack/
    version 0.1.0 preserved; dir unmoved]; sibling `@maintainers/*`
    names + the `@maintainers/source` export-condition deliberately
    LEFT — distinct tokens). Flagship side `11f3a06` on `main`:
    server-daemon dep+imports, the 2 `.mjs` (vitest-only blind spot),
    installer-apkovl test, regenerated root `package-lock.json`, and
    the **npm-workspace symlink regenerated** (`node_modules/@ibisllc/
    maintainers`→`maintainers/packages/protocol`; old `@maintainers`
    scope dir removed — flagship's `package.json` `workspaces` lists
    the PATH so it auto-relinks from the new `name`). Byte-identity
    pair (`bootstrap-flagship-maintainers.mjs:209` generated-README ↔
    committed `.maintainers/README.md`) changed in lockstep (the
    bootstrap test SHA-compares; flagship vitest green proves it).
    Orchestrator added a **prose/comment sweep** of the ACTIVE flagship
    docs (`ca-operations.md` operator runbook, `maintainer-ca-
    endorsement.md`, `maintainers-deployment.md`, `plan-…-demo.md`,
    `rotate-ca.mjs/.test.ts`, `maintainerCa.ts` module-doc — that
    module stays `@ibisllc/maintainers`-import-FREE, comment only;
    flagship `dist/` is gitignored, regenerates) so the final name
    never churns; the orchestrator-owned historical trackers
    (SESSION-HANDOFF/v1-launch-program) intentionally KEEP their
    period-accurate `@maintainers/protocol` mentions (a log, not
    rewritten). Verify-before-trust: orchestrator audited the diff
    (name-only pkg change; siblings intact; zero residual specifier;
    pin/orchestrator-docs untouched; pbxproj NOT staged) + re-ran BOTH
    gates itself — maintainers tsc -b clean + **370/36**; flagship
    tsc -b clean + **2529/225** (via the regenerated `@ibisllc/
    maintainers` symlink — the live consumer proof) + after the prose
    sweep re-ran flagship again still 2529/225; `npm pack --dry-run` →
    `@ibisllc/maintainers@0.1.0`, `ibisllc-maintainers-0.1.0.tgz`, 67
    files.
  - **★ token hygiene:** the user pasted a live bypass-2FA npm token in
    cleartext. Used transiently (private `mktemp` npmrc, `trap`-removed,
    NEVER `~/.npmrc`/repo/memory) — scrubbed. **The user MUST revoke
    that token (`npm_FUNp…`) at npmjs.com → Access Tokens; treat as
    burned.** Future publishes need a fresh `@ibisllc`-scoped
    granular+bypass-2FA token created AFTER the `ibisllc` org exists.
  - **Next:** merge **PR #5** → agent re-pins `maintainers.pinned-sha`
    to its first-parent merge SHA + reruns both gates + commits → THEN
    **proceed the critical path** (Gate B prep / Phase E) per the user.
    npm publish + flagship-drops-pull-script(+symlink) are DEFERRED
    tracked follow-ups (off the critical path; the pull-script
    bootstrap still works). `docs/ca-operations.md` Operation 0 holds
    the armed Gate-B (P) provisioning checklist.

- **2026-05-18 (v1-launch program session 8, Mac/darwin — PR #3
  MERGED + re-pinned + npm packaging-prep landed (PR #4 open)):** The
  human merged the governed **PR #3** (`feat/keyfile-register`→`main`,
  the entire 14-commit Phase-2 v2 spine). Verify-before-trust:
  confirmed `gh pr view 3` MERGED, merge commit **`8e8915e`** (parents
  = `833fa45` old-pin first-parent + `10979ab` branch tip; `git diff
  8e8915e 10979ab` EMPTY ⇒ the merged tree == the gate-verified tree).
  Re-pinned `scripts/maintainers.pinned-sha` `833fa45`→`8e8915e` (the
  **first-parent merge commit**, NOT the branch tip — PR #1/#2 rule),
  ran `pull-maintainers.sh pull` (reset clone to the pin), re-ran BOTH
  gates AT THE PIN: maintainers tsc -b clean + **370/36**; flagship
  tsc -b clean + **2529/225**. Committed flagship `ea9f707` (pin file
  only). **★ User-asked release audit (answered honestly):** the
  shipped code is 100% de-versioned — ZERO `…V2` code symbols, ZERO
  `version: 2`, ZERO `maintainers/mandate/v2`; the ONLY "v2" tokens in
  the whole tree are TWO `docs/spec/v1.md` sentences that explicitly
  say "there is no v2" (deliberate forward-compat clarification, not
  residue). Release-completeness audit: key-signing (`signing.ts`+
  `create-key`), mandates (`canonicalMandate`/`verifier`/
  `upsert-mandate`), endorsements (`endorsement`/`caEndorsement`),
  ceremonies (`ceremony.ts` dry-run + PC/SC seam), helper tools
  (verify/status) — all present + gate-green; the ONLY deliberately-
  incomplete piece is the native libpcsclite transmit (the Gate-B (A)
  hardware increment, fail-closed stub by design, `file:` fallback +
  armed runbook).
  - **★ npm-publish-readiness finding (verify-before-trust caught it):
    the package was NOT one-command-publishable** — `"private": true`
    (npm refuses), `main`/`types`/`exports`→raw `./src/*.ts`, no
    `files` allowlist, conformance vectors+spec outside the package
    dir. A fresh subagent did the packaging-prep (a real chunk, not a
    one-liner) on a NEW branch off `8e8915e` (`feat/publish-protocol`,
    NOT the merged `feat/keyfile-register`): remove `private`, add
    `publishConfig.access:public`, a **conditional `exports`** that
    keeps the in-repo/flagship-symlink resolution byte-unchanged
    (top-level `main`/`types`→`./src/index.ts`) while published/`types`
    →compiled `./dist/`, a `files` allowlist, a `prepack` (tsc -b +
    deterministically stage the repo-root `conformance/`+`docs/spec/
    v1.md` into the tarball — gitignored pack artifacts), a package
    README + byte-identical package LICENSE. Version stays **0.1.0**
    (the spec is "Draft, targeting v1.0 on independent interop" — the
    future #9/#10; 1.0.0 over-claims). Verify-before-trust:
    orchestrator re-ran BOTH gates with **`tsc -b --force`** (cache-
    defeating, the symlink-resolution guardrail) — maintainers clean +
    370/36; flagship clean + **2529/225** (held); `npm pack --dry-run`
    = 67 files / 69.5 kB (dist js+d.ts + README + LICENSE + SPEC.md +
    17 vectors + manifest; NO src/tests/tsconfig); `npm publish
    --dry-run --access public` validates. Committed
    `feat/publish-protocol` `1e9705f`, pushed, **governed PR #4 open**.
    Zero protocol/spec/conformance semantic change; pin + program
    trackers untouched.
  - **Next, HUMAN-gated in order:** (1) merge **PR #4**
    (`ibisllc/maintainers#4`) → agent re-pins
    `scripts/maintainers.pinned-sha` to ITS first-parent merge SHA +
    reruns both gates + commits; (2) **HUMAN** `cd /Users/harrywinner/
    flagship/maintainers/packages/protocol && npm publish --access
    public` (npm login/org/2FA; `prepack` auto-builds+bundles); (3)
    flagship DROPS `scripts/pull-maintainers.sh` +
    `maintainers.pinned-sha` + the `node_modules/@maintainers/protocol`
    symlink and consumes `@maintainers/protocol@0.1.0` like any adopter
    (the symlink-is-live-consumer gotcha ENDS here — update memory);
    (4) **HUMAN Gate B** genesis ceremony (the (P) provisioning + the
    signed `upsert-mandate`; runbook = `docs/ca-operations.md`
    Operation 0). The orchestrator PAUSES at each gate — never fakes
    the merge/publish/ceremony.

- **2026-05-18 (v1-launch program session 8, Mac/darwin — ceremony
  tooling hardened UP TO the hardware gate; the agent-side Phase-A
  spine is DONE; PAUSED at the human/credential gate):** maintainers
  **`10979ab`** + flagship **`6cd2c55`**, both pushed. One fresh
  subagent hardened the genesis-ceremony tooling to the documented
  (P)/(A) gate WITHOUT writing the security-critical native libpcsclite
  transport blind (verify-before-trust confirmed: `connectPcscChannel`
  still fail-closes via the new typed `PcscBuildError`; ZERO real
  `reader.transmit`/`pcsclite()`/`.connect({` calls anywhere). Three
  pieces: (A) `docs/ca-operations.md` Operation 0 reconciled to the
  de-versioned reality (`upsert-mandate` not `genesis`;
  `MAINTAINER_PINNED_MANDATE_HASH` not `MAINTAINER_GENESIS_PUBKEYS`; no
  `policy.json`; tag `maintainers/mandate/v1`; confirm phrase
  `UPSERT-MANDATE`; c5 conformance ref; + a copy-pasteable (P)
  provisioning checklist + a dry-run-vs-needs-YubiKey table — every
  command source-verified vs the landed CLI). (B) a typed transport
  taxonomy — `PcscNotReadyError` (recoverable: prompt+wait+poll+retry)
  / `PcscSecurityError` (FATAL, never a software fallback) /
  `PcscBuildError` (FATAL, non-recoverable build cond — not retried),
  all `extends CliError`; `piv-connect.ts`
  `connectPcscChannelWithPrompt` loop branches ONLY on
  `isRecoverableNotReady`, non-interactive fails closed immediately,
  bounded deadline, returns ONLY a real channel or throws (no
  degraded/fallback path) — [[feedback-no-hardware-assumptions]]
  satisfied; fully fake-injected tests. (C) dry-run byte-fidelity: a
  new test proves a from-scratch genesis `upsert-mandate --dry-run`
  preview == `canonicalMandate` of the real signed envelope (uuid/ts
  pinned) and the real sig verifies over precisely the previewed bytes,
  nothing written; the libpcsclite API contract for the gate-(A) step
  is recorded in-code so it is mechanical, not invented under pressure.
  Verify-before-trust: orchestrator audited (pin + SESSION-HANDOFF +
  v1-launch-program untouched; native binding NOT written; the loop has
  no fallback return; ca-operations stale terms appear ONLY as explicit
  migration negations) + re-ran both gates itself — maintainers tsc -b
  clean + **358/35 → 370/36** (+12, 0 failed); flagship tsc -b clean +
  **2529/225** (doc-only on the flagship side). cwd-poisoning hazard
  recurred during the audit (a `cd /flagship` then a maintainers-path
  grep "No such file" — caught, re-run with the correct repo path; the
  documented §0 trap, 4th time).
  - **★ The agent-side Phase-A protocol-product spine + ceremony
    hardening are COMPLETE. Everything remaining in Phase A and all of
    Phase B is HUMAN/CREDENTIAL/HARDWARE-gated** — the orchestrator
    PAUSES here per the human-gate protocol (PREPARE→PAUSE→WATCH→VERIFY,
    never fake). The exact remaining human steps, in order:
    **(1) governed PR merge** — push is done (`feat/keyfile-register`
    tip `10979ab`); the maintainer merges `ibisllc/maintainers`
    `feat/keyfile-register` → `main` on GitHub (PR #1/#2 precedent);
    then the agent bumps `scripts/maintainers.pinned-sha` to the
    **first-parent merge commit** (NOT the branch tip — the PR #1/#2
    rule), runs `pull-maintainers.sh`, re-runs BOTH gates, commits the
    pin bump. **(2) `npm publish @maintainers/protocol`** — HUMAN (npm
    org + 2FA; classifier may block even post-approval — the human runs
    the one `npm publish` command; semver/`--provenance`). **(3)
    flagship drops** `scripts/pull-maintainers.sh` + `maintainers.
    pinned-sha` + the `node_modules/@maintainers/protocol` symlink and
    consumes the published package like any adopter (honest dogfooding;
    update [[feedback-no-hardware-assumptions]]-adjacent gotcha memory:
    the symlink invariant ENDS here). **(4) Gate B** — the (P)
    provisioning checklist (now in `ca-operations.md` Operation 0:
    install `pcsclite`+`ykman`, `ykman piv keys generate --algorithm
    ED25519 --pin-policy ONCE --touch-policy ALWAYS 9c …` on BOTH
    YubiKeys, decide `<DURATION>`+policy) → the agent implements +
    LIVE-verifies `connectPcscChannel`'s libpcsclite wiring WITH the
    real reader/token (governed `maintainers` PR + re-pin; non-
    destructive pubkey read first; NEVER blind) → `--dry-run` → the
    human types `UPSERT-MANDATE` + PIN + taps → the agent verifies the
    chain + records `mandatePinHash` (the per-surface bake is Phase C).
    `file:` is NOT acceptable for the genesis root.
- **2026-05-18 (v1-launch program session 8, Mac/darwin — c5
  LANDED; ★ stale-layout discrepancy reconciled):** maintainers
  **`6acca14`** (`feat/keyfile-register`, 25 files, +3525), pushed.
  One fresh subagent built the three #35 portable-artifact pieces
  (additive — zero model/canonical/verifier change): (1) spec §7.1
  published-fetch layout + §12 Conformance (section numbers preserved);
  (2) a dependency-free `fetch()` reference client
  `packages/protocol/src/fetchClient.ts` (`verifyFromFetch`, total,
  fail-closed); (3) a deterministic real-Ed25519-signed generator
  `packages/protocol/scripts/gen-conformance.ts` → the portable
  artifact `maintainers/conformance/` (manifest + 17 vectors) +
  `conformance.test.ts`. **★ Discrepancy the orchestrator flagged &
  the subagent honored:** the program prompt + old `#35`/D2 prose name
  a static layout `origin.json`/`tracks/<t>/log.json`/`ca-leases.json`
  — that vocabulary is STALE (pre-v2-lock). The LANDED published-fetch
  convention (per `extension/src/fetcher.ts`) is a committed
  `.maintainers/index.json` (`{version:1,tracks,keys,endorsements}`,
  every path under `.maintainers/`, anti-redirect). c5 documents/uses
  ONLY that — one published layout shared by extension + reference
  client + #9/#10; zero divergence found. **Cold-start rule: trust the
  in-repo docs + landed code over the prompt when they disagree (the
  prompt's §F also says origin.json/log.json/ca-leases.json — read it
  as the `.maintainers/index.json` convention).** Verify-before-trust:
  orchestrator audited the change set (pin untouched; zero `…V2`;
  conformance.test.ts imports the REAL `verifier.ts`/`endorsement.ts`/
  `caEndorsement.ts` — not mocks — and asserts BOTH `accepted` and the
  exact `rejectReason` per vector so a silent accept-flip FAILS the
  suite; spot-checked neg-4 self-renewal genuinely fails closed —
  `now` past the expired root window so it can't fall back, rejects
  `signer-not-in-successor-set`; generator uses real `signMandate` +
  fixed seeds ⇒ genuine signatures over genuine canonical bytes, a
  mis-implementing port FAILS the vectors) + re-ran BOTH gates itself:
  maintainers tsc -b clean + vitest **330/33 → 358/35** (+28, 0
  failed — the conformance suite passing IS the proof all 17 vectors
  replay correctly through the landed verifier); flagship tsc -b clean
  + **2529/225** unchanged (new exported file compiles via the live
  symlink, doesn't touch flagship's graph). The 17 vectors (4 happy +
  neg-1..10 incl. 10a rolled-back & 10b tampered-root + totality + CA
  no-pin) are the security guard for #9/#10. **The c4.6/c4.7/c5
  protocol-product spine is DONE. Next = the ceremony-tooling
  hardening** (native PC/SC YubiKey PIV binding behind the tested
  `connectPcscChannel` seam — currently a fail-closed stub that throws
  even with `pcsclite` present; make `create-key`/`upsert-mandate`/
  `ca-endorsement` + `ca-operations.md` Operation 0 concrete &
  dry-run-clean; the transport must NEVER assume key/reader present —
  prompt+wait+retry, fail-closed is security-only — see
  [[feedback-no-hardware-assumptions]]). HARDWARE-in-loop live verify
  is a human gate; lands upstream via a governed `maintainers` PR.
  **A fresh attentive START — security-critical native transport, do
  NOT tail-bolt or write the binding blind.**
- **2026-05-18 (v1-launch program session 8, Mac/darwin — c4.7 spec
  LANDED):** maintainers **`f509849`** (`feat/keyfile-register`),
  pushed. One fresh subagent rewrote `docs/spec/v1.md` (607→971 lines)
  end to end, in place, directly under the final de-versioned name to
  the LOCKED model — **authored against the LANDED code as ground
  truth** (canonical.ts/verifier.ts/endorsement.ts/caEndorsement.ts/
  types.ts), §3.1 transcribes the exact 15-slot `canonicalMandate`
  field order + `maintainers/mandate/v1` tag + `mandatePinHash`; §4
  L1-pin-is-the-floor verify-forward + L2/L3 one-rule; §5.0/§5.1
  holder-signs + D3 (unchanged); §5.2 rewritten "the pin IS the floor";
  §8 from-scratch boundary + accepted no-equivocation limitation; §9
  single shipped wire version 1 (fail-closed on unknown). Removed every
  trace of genesis-walk / `policy.json` / `RootPolicy`/`TrackPolicy`/
  `SignedPolicy` / checkpoint-not-floor / `selfRenewable` / `…V2` —
  verify-before-trust confirmed the only `v2`/`policy.json`/
  `selfRenewable` strings left are **explicit ABSENCE statements**
  ("there is no v2", "no `policy.json` at any level", "`selfRenewable`
  deliberately **not** part of the protocol"), not residue. Section
  numbers PRESERVED ⇒ inbound `§N.N` refs stay valid; added an
  informative §11.1 so the long-standing signing.ts/cli `§11.1` refs
  resolve. Two forced single-token JSDoc fixes (`docs/spec/v2.md` —
  a path that never existed — → `docs/spec/v1.md`) in `types.ts`/
  `verifier.ts`; no symbol/behavior change; the "LOCKED v2 model"
  design-lineage prose left per the c4.6 boundary. **Code-wins
  discipline:** reject reasons present in the type unions that the
  landed holder-signs code never emits are deliberately NOT presented
  as protocol-emittable. Orchestrator audited the diff (3 files; pin
  untouched; no flagship change — the `project.pbxproj` entry is the
  pre-existing xcodegen artifact, not the subagent's) + re-ran BOTH
  full gates itself: maintainers tsc -b clean + 330/33 exit 0; flagship
  tsc -b clean + 2529/225 exit 0. 3 files, +651/−287. **Next = c5 —
  publishable spec + a `fetch()` reference client + a conformance
  test-vector set that MUST include every fail-closed negative
  (absent/forked pin, pin-not-in-log, self-renewal-attempt,
  sub-threshold, under-minSuccessors, over-maxDuration, endorsement-gap,
  lapsed-lease-at-NOW, tampered/rolled-back history). A fresh attentive
  START.**
- **2026-05-18 (v1-launch program session 8, Mac/darwin — c4.6
  DE-VERSION RENAME LANDED; cold-start env-sync drift caught & fixed):**
  Thin-orchestrator model: oriented from the in-repo authority docs,
  rebuilt the TaskList (ephemeral by design), spawned ONE fresh
  general-purpose subagent with a self-contained brief for c4.6, then
  verified-before-trust (audited the diff + re-ran BOTH full gates
  myself + committed/pushed). **c4.6 = the de-version rename** (user
  decision s6): the maintainers protocol is unreleased; "v2" was a
  transitional cutover artifact; c4.5e made it the sole path so the
  first-ever shipped name must not be "v2". Dropped the `V2` code-symbol
  suffix everywhere (`MandateV2→Mandate`, `verifier/endorsement/
  caEndorsementV2.ts`+symbols→plain, `currentAuthorityV2`/
  `verifyChainOfEndorsementsV2`/`verifyCaEndorsementsV2`/
  `authorizedCaKeysV2`/`signMandateV2(With)`/`canonicalMandateV2`/
  `isMandateV2`/`readMandatesV2`/`writeMandateV2`/`ApprovalRuleV2`→
  plain, `VerifiedChainV2→VerifiedChain`), reset the **Mandate**
  envelope wire `version: 2→1` + canonical tag `maintainers/mandate/
  v2→/v1`. **NOT a trust-model change** — L1/L2/L3/D3 untouched, no
  verifier logic / threshold / holder-signs / fail-closed assertion
  changed (fail-closed negatives recomputed to new expected values,
  never weakened). Only Mandate ever carried the bogus v2; KeyFile/
  ReleaseEndorsement/CaEndorsement stay v1.
  - **★ env-sync drift caught at cold start (verify-before-trust paid
    off immediately):** the gitignored `maintainers/` clone was stale on
    `feat/keyfile-register`@`dc48559` (c1 ONLY — missing c2..c4.5e).
    `git reset --hard` was (correctly) classifier-blocked as
    destructive; re-verified the tree was provably clean + strictly 0
    ahead / 9 behind, then `git merge --ff-only origin/feat/keyfile-
    register` → `208978a` (non-destructive, refuses if not a clean FF).
    Both baseline gates re-verified GREEN before any work (maintainers
    330/33 tsc-clean; flagship 2529/225 tsc-clean). **Cold-start rule
    reaffirmed: the `maintainers/` clone is a gitignored sub-clone that
    can lag the pushed branch by many commits — fetch + `--ff-only`
    merge to `origin/feat/keyfile-register` (NOT `pull-maintainers.sh`,
    which resets to the pin and discards the v2 branch); never `reset
    --hard` (destructive — use ff-only).**
  - **★ subagent's load-bearing find (orchestrator confirmed it in the
    audited diff):** the real canonical-tag site was the *local*
    `joinTagged2` builder in `canonical.ts` (hardcoded
    `${TAG_PREFIX}/${kind}/v2`), DISTINCT from the descriptive comment
    at line 262. A naive `maintainers/mandate/v2` regex would have left
    it untouched ⇒ the signature would have been byte-identical (the pin
    would NOT have changed — c4.6 silently a no-op on the load-bearing
    output). Renamed `joinTagged2→joinTaggedMandate` with the `/v1`
    literal; `mandatePinHash` genuinely changes (ca-track example:
    `3724ad7e…664c`→`5eac384e…faab`; the `.maintainers/` mandate
    signatures changed, KeyFiles byte-unchanged, regeneration
    byte-deterministic across two runs). Also handled mid-token V2
    (`signMandateV2With`, `isV2Shape→isMandateShape`) the `\w+V2\b`
    regex misses, and a missed nested consumer
    `packages/server-adapters/cloudflare-worker` (not under
    `packages/*/src`).
  - **Landed:** maintainers `a8ac151` (`feat/keyfile-register`, 38
    files, 7 `git mv` renames history-preserved, +476/−477) + flagship
    `c5995c9` (`main`, 13 files, +77/−77, regenerated `.maintainers/`
    artifact to v1) — both pushed. Pin UNCHANGED `833fa45` (re-pin is
    the later governed Phase-A.merge step; never pin an unmerged tip).
    `apps/mobile/.../project.pbxproj` (pre-existing xcodegen artifact)
    explicitly NOT staged; `dist/` (gitignored) + `docs/` not in either
    commit. Orchestrator re-ran both FULL gates itself (file-redirect
    for real exit codes, never `| tail`): maintainers tsc -b clean +
    330/33 exit 0; flagship tsc -b clean + 2529/225 exit 0. **Next =
    c4.7 spec — author the protocol spec DIRECTLY under the final
    de-versioned name (rewrites §5.2 "the pin IS the floor"; dissolves
    policy.json/SignedPolicy; documents L1/L2/L3 + mandatePinHash +
    holder-signs + the from-scratch boundary; D3 unchanged). A fresh
    attentive START — do NOT tail-bolt.**
- **2026-05-18 (v1-launch program session 7 cont. — c4.5e LANDED;
  THE WHOLE c4.5 CUTOVER COMPLETE; ★ two canonical invariants
  corrected):** **c4.5e `208978a` (maintainers `feat/keyfile-register`)
  + c4.5e-pre `def22ca` (flagship `main`), both pushed.** v1 is fully
  removed from `packages/protocol`; v2 is the SOLE trust path.
  - **c4.5e** deleted the v1 genesis-walk verifier + v1 endorsement/
    ca-endorsement verifiers + their tests (verifier/endorsement/
    caEndorsement.ts + .test.ts; checkpoint.test.ts — L1 replaced the
    genesis-walk/checkpoint concept). Shared result types re-homed
    BEFORE deletion (EndorsementFailReason/VerifiedEndorsements →
    endorsementV2.ts; CaEndorsementFailReason/VerifiedCaEndorsements/
    DEFAULT_CLOCK_SKEW_MS → caEndorsementV2.ts; still re-exported via
    index ⇒ consumer public surface unchanged). Pruned v1 Mandate/
    TrackPolicy/RootPolicy/ApprovalRule (types.ts), v1 canonicalMandate
    (canonical.ts — `joinTagged` KEPT, 6+ non-v1 fns use it), v1
    signMandate/signMandateWith (signing.ts), the 3 v1 index export
    lines. `Envelope` union `Mandate`→`MandateV2` (zero consumers
    outside protocol, verified). Pure deletion+re-home, no v2 semantics
    changed. 17 files, +77/−2176. maintainers tsc -b --force clean +
    vitest **382/37 → 330/33** (−52/−4 = the deleted v1 test files;
    v2 trust-path tests verifierV2 21 / endorsementV2 16 /
    caEndorsementV2 11 are now the SOLE trust coverage, all pass).
  - **★ THE FINDING (verify-before-trust did its job):** the first
    c4.5e gate run broke the **flagship guard** (4 fails / 2 files) —
    contradicting the handoff's "flagship provably unaffected via the
    pin". Two canonical invariants were WRONG: **(1)** `node_modules/
    @maintainers/protocol` is a **LIVE symlink** to `maintainers/
    packages/protocol` (the working tree), NOT a pinned vendored copy
    — so ANY protocol change hits the flagship guard locally (CI/Docker
    differ: `pull-maintainers.sh` clones at the pinned SHA there; the
    pin is a CI-time isolation, not a local one). c4.5a–d stayed green
    only because they never touched protocol. **(2)** c4.4's "flagship
    imports zero v1 since c4.4" was incomplete — it migrated only the
    server-daemon runtime consumer; **4 flagship files still imported
    v1**: `scripts/bootstrap-flagship-maintainers.mjs` (PROD),
    `scripts/verify-endorsement.mjs`, `scripts/bootstrap-flagship-
    maintainers.test.ts`, `packages/installer-apkovl/tests/
    endorsementVerification.test.ts` — the two `.mjs` were invisible to
    a tsc-graph symbol grep (so `tsc -b` passed; only vitest runtime
    failed). c4.5e was HELD (git stash), the user chose **consumer-
    first**, and **c4.5e-pre** re-based all 4 to v2 (mirroring c4.4)
    WHILE v1 still coexisted — incl. regenerating the committed
    `./.maintainers/` artifact to the v2 shape (root + 3 per-track
    `policy.json` deleted, 3 mandates rewritten v2, byte-deterministic;
    KeyFiles byte-unchanged). flagship `def22ca`: tsc clean + **2529/
    225 ALL PASS**. THEN the stash was popped and c4.5e committed with
    the FULL gate green both sides. **Lesson for any cold start: locally
    the flagship guard IS a live consumer check of the maintainers
    working tree — run it after EVERY maintainers protocol change; the
    pin only isolates CI/Docker.** flagship is genuinely v1-free as of
    `def22ca`.
  - Process: orchestrator + ONE subagent at a time, verify-before-trust
    on every chunk (re-ran the FULL gate itself with file-redirect for
    real exit codes — a `| tail` pipeline hides vitest's exit AND
    truncates the verdict; that mistake was caught and corrected
    mid-session). The harness TaskList reset mid-run (ephemeral by
    design) — rebuilt from these in-repo docs (the whole point of this
    file). **Next = c4.6 de-version rename (a fresh attentive START,
    NOT a tail-bolt — it changes `mandatePinHash`, security-sensitive).**
- **2026-05-18 (v1-launch program session 7 cont. — c4.5d LANDED;
  ALL consumers now v2):** **c4.5d `616b8f9` (maintainers
  `feat/keyfile-register`), pushed.** `packages/cli` re-based off v1
  onto v2; per the LOCKED "CLI verbs" decision the three collapsed v1
  verbs `genesis`/`mandate`/`takeover` (= the from-scratch/renewal/
  takeover cases of the ONE landed `upsert-mandate`) were DELETED and
  unwired from `index.ts`/`args.ts`. `verify.ts` → `verifyMandate
  ChainFromPin`+`currentAuthorityV2`+`verifyChainOfEndorsementsV2`,
  no-baked-pin `safePinHash` anchor (no `--pin` flag exists; none
  invented). `lib/store.ts` → v2 on-disk convention via the existing
  `readMandatesV2`. `endorsement.ts`/`caEndorsement.ts` authority →
  `currentAuthorityV2`/`authorizedCaKeysV2` (still EMIT v1
  ReleaseEndorsement/CaEndorsement — unchanged by the v2 model).
  Subagent self-corrected an assertion-design error: an on-disk tamper
  surfaces as `root-signature-invalid` (the preview anchor recomputes
  the hash over the tampered bytes, so the pin still matches the file —
  the signature is what breaks), still a hard fail-closed; the pure
  `pin-not-in-log`/forked/unauthorised-successor negatives moved to the
  protocol-layer test where each is genuinely reachable. 18 files,
  +553/−1454. **Verify-before-trust applied:** orchestrator re-ran the
  FULL gate itself pwd-confirmed (maintainers tsc -b clean + vitest
  **385/37 → 382/37**, net −3 deleted-verb tests, expected; flagship
  guard tsc -b clean + **2529/225** unchanged), audited the diff
  (confined to `packages/cli`, protocol/pin untouched, zero forbidden
  v1 symbols, fail-closed negatives confirmed asserted) before
  commit+push. **All four consumers (worker/web-ui/extension/cli) are
  now on v2; nothing imports v1. c4.5e (protocol v1-removal) is now
  unblocked and is the STRICTLY-LAST chunk.**
- **2026-05-18 (v1-launch program session 7 cont. — c4.5c LANDED):**
  **c4.5c `fba0657` (maintainers `feat/keyfile-register`), pushed.**
  `packages/extension` (the browser-extension verifier — a pure
  consumer, no signing surface) re-based off v1 onto v2 while v1 still
  coexists in protocol (additive; protocol removal is c4.5e, last).
  `verifier-logic.ts`: `verifyTrack`/`currentAuthority`/
  `lastExpiredMandate`/`verifyChainOfEndorsements` →
  `verifyMandateChainFromPin`+`currentAuthorityV2`+
  `verifyChainOfEndorsementsV2`; expiry derived from
  `currentAuthorityV2===null`+last-valid (no v1 holder-in-window split).
  `fetcher.ts` → v2 on-disk convention (no policy.json/RootPolicy/
  TrackPolicy; v1 shapes dropped pre-verifier). Preview anchor = first
  on-repo mandate's `mandatePinHash` via a `safePinHash` wrapper
  (non-canonicalizable ⇒ ""⇒`no-pin`⇒fail-closed); the c4.5a/c4.5b
  no-baked-pin pattern, boundary documented. CA track was never
  separately endorsement-verified ⇒ no `*V2` CA call wired (behaviour
  preserved). 9 files, +520/−313. **Verify-before-trust applied:** the
  subagent's "green" was NOT trusted — orchestrator re-ran the FULL
  gate itself with pwd-confirmed cwd (maintainers tsc -b clean + vitest
  **378/37 → 385/37**, +7; flagship guard tsc -b clean + **2529/225**
  unchanged) and audited the diff (confined to `packages/extension`,
  protocol untouched, pin `833fa45` unchanged, zero forbidden v1
  symbols) before commit+push. **Next = c4.5d (cli); c4.5e last.**
- **2026-05-18 (v1-launch program session 7 cont. — c4.5b LANDED,
  orchestrator-driven, recovered after a prior session looped 9h):**
  the prior session persisted the execution-model decision (`9dd3154`)
  then looped for ~9h WITHOUT corrupting anything — repo clean, no bad
  commits, pin unchanged, no crons/tasks/wakeups armed. Recovery
  re-verified the start gate green at baseline (flagship **2529/225**,
  maintainers **373/36** @ `650fee2`, both tsc clean) then resumed
  c4.5 as **orchestrator + ONE subagent at a time** (user-chosen mode:
  documented model but strictly serial, no parallel fan-out).
  - **c4.5b LANDED `429a57c` (maintainers `feat/keyfile-register`),
    pushed.** `packages/web-ui` re-based off the v1 Mandate/policy path
    onto v2 verify-forward-from-pin while v1 still coexists in protocol
    (additive — protocol untouched, removed last in c4.5e). Per #31
    (web-ui is STATUS/PREVIEW only, NEVER a signing surface) the three
    signing views `onboard`/`renew`/`takeover` + their v1 mandate/policy
    builders were DELETED, not ported (the program's own directive).
    `project.ts`/`state.ts` → `verifyMandateChainFromPin` +
    `currentAuthorityV2` over the v2 on-disk convention
    (`tracks/<t>/mandates/*.json` v2-filtered, no policy.json/
    rootPolicy/TrackPolicy); `adapter.ts` uses a local v2-only envelope
    union mirroring c4.5a's `WorkerEnvelope`; preview anchor = first
    on-repo mandate's `mandatePinHash` (the c4.5a `summarizeState`
    no-baked-pin pattern; security boundary unchanged + documented).
    Tests rewritten to v2 fixtures incl. the mandated fail-closed
    negatives (empty-pin⇒`no-pin`⇒reject, pin-not-in-log⇒reject,
    unauthorised-successor⇒`signer-not-in-successor-set`). 16 files,
    +586/−1938.
  - **Verify-before-trust applied as designed:** the chunk's
    self-reported "green" was NOT trusted — the orchestrator
    re-ran the FULL gate itself (maintainers `tsc -b` clean + vitest
    **373/36 → 378/37**, +5 from the new v2 coverage; flagship guard
    `tsc -b` clean + **2529/225** unchanged, web-ui not in flagship's
    import graph + protocol untouched ⇒ provably unaffected) and audited
    the diff (confined to `packages/web-ui`, protocol untouched, pin
    `833fa45` unchanged, zero forbidden v1 symbols, fail-closed negatives
    asserted) BEFORE commit+push.
  - **★ cwd-poisoning recurred and was caught (the documented §0
    hazard).** A backgrounded flagship-guard command launched with the
    persistent cwd poisoned to `…/maintainers` (a prior `cd` persisted)
    re-ran the *maintainers* gate instead (37/378, not 225/2529); caught
    by inspecting the count, re-run with explicit `cd /home/kamdemharry/
    flagship && pwd && …`. Discipline reaffirmed: EVERY command (incl.
    backgrounded) must start with an explicit absolute `cd /abs &&` or
    use `git -C`; never rely on the persistent cwd. Next = c4.5c
    (extension) then c4.5d (cli), order-free; c4.5e strictly last.
- **2026-05-18 (v1-launch program session 7 — EXECUTION-MODEL DECISION,
  user-directed):** the program now runs as **ORCHESTRATOR +
  fresh-subagent-per-chunk**, parallel where genuinely independent. This
  is the canonical execution model; a cold start MUST adopt it (the
  redesigned program prompt encodes it in full; this is the in-repo
  anchor so it survives even if the prompt isn't reused verbatim).
  - **Orchestrator stays thin:** orients from these docs, decomposes,
    delegates each chunk to a BRAND-NEW subagent with a SELF-CONTAINED
    brief (none of the orchestrator's context). The brief MUST cite the
    in-repo authority docs (this §0 + §3-tail; v1-launch-program "LOCKED
    v2" + the relevant s7 log) and the established v2 re-base PATTERN
    (`c4.4` server-daemon + `c4.5a` cloudflare-worker, both landed —
    verifyMandateChainFromPin / currentAuthorityV2 /
    verifyChainOfEndorsementsV2 / holder-signs / the v2 on-disk
    convention, no policy.json), list the exact files + the exact v2
    contract + the FORBIDDEN v1 symbols, and the invariants (model
    LOCKED, NO Co-Authored-By, do NOT touch
    `scripts/maintainers.pinned-sha`, do NOT push, absolute paths).
  - **Parallel is REAL but BOUNDED by the gate.** Read-only mapping/
    design fan-out (Explore/Plan subagents) is ALWAYS parallel-safe (no
    writes ⇒ no collision) — use it for unmapped surfaces (the
    `extension` package is unmapped). Disjoint-package IMPLEMENTATION
    chunks may run concurrently ONLY as `isolation:"worktree"`
    subagents that run the maintainers-internal tsc+vitest in their own
    worktree and **return a verified diff — NO commit, NO push**.
  - **THE SERIALIZATION SPINE (security-critical, non-negotiable):** the
    shared branch `feat/keyfile-register` + the whole-monorepo
    maintainers gate + the cross-repo flagship guard CANNOT be driven by
    concurrent writers. The orchestrator integrates returned chunks
    STRICTLY ONE AT A TIME: apply diff → **re-run the FULL gate ITSELF**
    (maintainers tsc+vitest AND the flagship guard; NEVER trust a
    subagent's "green" — verify-before-trust) → only if green
    `git -C maintainers commit -F -` (heredoc, NO Co-Authored-By) +
    push → update docs/memory → next chunk. One chunk = one commit; pin
    NEVER moved on an unmerged tip.
  - **Concrete parallel map (current work):** c4.5b (web-ui) / c4.5c
    (extension) / c4.5d (cli) are DISJOINT packages ⇒ design fan-out in
    parallel, implement in parallel worktrees, **integrate serially**
    (v1 still coexists in protocol ⇒ flagship guard 2529/225 each
    integration). **c4.5e is STRICTLY LAST** (serial; only when b+c+d
    pushed and no consumer imports v1). c4.6 de-version rename / c4.7
    spec / c5 are inherently serial. Later: #10 iOS ‖ Android are
    independent ⇒ parallel worktree subagents, serial-integrate.
  - Naively running concurrent writer-subagents on the shared branch
    would corrupt the load-bearing trust path — that is WHY the spine is
    serialized; this is not optional.
- **2026-05-18 (v1-launch program session 7, Linux box):**
  - **★ c4.5 VERIFY-BEFORE-TRUST CORRECTION — "one atomic commit"
    was wrong; consumer-first is the safe path.** Before touching code,
    an exhaustive Explore fan-out inventoried EVERY v1-symbol reference
    across the whole maintainers tree. The true blast radius of the v1
    removal is **~30 files across FIVE packages** — protocol, cli,
    web-ui, cloudflare-worker, **AND `packages/extension/` (which the
    session-6 c4.5 plan FORGOT entirely: `verifier-logic.ts` +
    `fetcher.ts` + `tests/fixtures/build-fixture.ts` +
    `verifier-logic.test.ts` all consume v1)** — including substantial
    rewrites of security-critical verification code (worker `policy.ts`
    authority/`summarizeState`, extension `verifier-logic.ts`, web-ui
    `views/project.ts`+`renew.ts`+`takeover.ts`+`state.ts`,
    cli `verify.ts`+`caEndorsement.ts`). The session-6 "c4.5 = ONE
    atomic commit, cannot be partialed" call was made WITHOUT this
    inventory. **With it: a blind 30-file atomic rewrite of
    trust-verification code is unsafe and violates the "attentive,
    never rushed on the load-bearing path" discipline.** It CAN be
    safely partialed: "cannot be partialed" is true ONLY if v1 is
    removed from protocol FIRST. The v2 symbols already exist
    (c1/c2/c4.1), so each consumer can be re-based to v2 **while v1
    still coexists in protocol** (additive — maintainers gate green
    each step), and v1 is removed from protocol **last**, once nothing
    imports it. This is the EXACT consumer-first→removal-last pattern
    that safely landed the flagship side (c4.3 #30 → c4.4 consumer →
    then removal). **New sub-sequence:** `c4.5a worker → c4.5b web-ui
    → c4.5c extension → c4.5d cli → c4.5e protocol v1-removal` — a–d
    are order-free + independent (each its own green commit, v2
    coexisting with v1); **c4.5e (the protocol removal + re-home the
    shared VerifiedEndorsements/EndorsementFailReason/
    VerifiedCaEndorsements types) MUST be last**, when no consumer
    imports v1. This is a COMMIT-SEQUENCING correction (engineering
    autonomy; same class as the c4.2 deletion), **NOT a v2-model
    change** (the LOCKED model is untouched). The web-ui signing views
    (onboard/renew/takeover) are *correctly deleted* per #31 ("NEVER a
    signing view") — the program's own directive, not a shortcut;
    web-ui keeps status/preview only. After c4.5e the de-version
    rename is **c4.6** (unchanged), then **c4.7** spec, c5, … (also
    unchanged). Start gate re-verified green at s7 open: maintainers
    **371/36 · tsc clean**; flagship **2529/225 · tsc clean** (gate
    re-run; cwd-poisoning hazard recurred TWICE — a compound
    `cd …/maintainers && …` ran a later half in maintainers; caught
    via `pwd` both times, re-run with absolute path. Use `git -C` /
    explicit `cd /abs &&` per step).
  - **c4.5a LANDED `650fee2` (maintainers `feat/keyfile-register`),
    pushed.** The cloudflare-worker write-gate re-based off the v1
    Mandate path onto v2 WHILE v1 still coexists in protocol (additive
    — protocol untouched): `policy.ts` RepoState =
    `Map<string,MandateV2[]>` + no policy.json; a local `WorkerEnvelope`
    union (v2-only, doesn't touch the protocol `Envelope`);
    parseEnvelope Mandate⇒v2 (v1⇒`mandate-version-unsupported`);
    checkMandateAuthority = empty-track⇒valid self-signed v2 ROOT,
    non-empty⇒verify-forward-from-the-first-on-repo-mandate (the L3
    one rule); endorsement/ca authority = `currentAuthorityV2` +
    holder-signs (Ca still judged at NOW — §5.1 unchanged);
    `summarizeState`/RepoSummary v2 (drop rootPolicy/approvalRule).
    `worker.ts` `fetchMaintainersState` drops the policy.json reads,
    reads version-2 mandates. `worker.test.ts` untouched (helper-only).
    `policy.test.ts` fully rewritten to v2 fixtures. maintainers tsc
    -b clean + vitest **371→373/36**; flagship guard **2529/225** tsc
    clean (worker is NOT in flagship's import graph + protocol
    unchanged ⇒ provably unaffected). pin UNCHANGED `833fa45`.
    **Next = c4.5b / c4.5c / c4.5d (order-free) → c4.5e LAST.**
    Deliberately NOT started a 2nd large security-sensitive sub-commit
    this turn (would be a rushed tail-bolt on the load-bearing path —
    same discipline call as end-of-s6).
- **2026-05-17 (v1-launch program session 6, Linux box):**
  - **No env drift (verify-before-trust).** Cold start: `maintainers/`
    clone already on `feat/keyfile-register`@`2fa2b0c` (c3b); start gate
    re-run green at baseline — maintainers **344/34 · tsc clean**,
    flagship **2526/225 · tsc clean**. `pwd` checked; absolute
    `cd /home/kamdemharry/flagship &&` / `git -C` used throughout (no
    background-cd cwd poisoning).
  - **★ Phase-2 v2 spine — c4.1 + c4.3 + c4.4 LANDED (the flagship-side
    v2 migration, attentively, NOT tail-bolted).** Three tested commits,
    each gate-green + pushed:
    - **c4.1 `6cfee83` (maintainers `feat/keyfile-register`)** — the v2
      endorsement layer, **strictly ADDITIVE** (v1 endorsement.ts/
      caEndorsement.ts/verifier.ts untouched ⇒ flagship guard provably
      back-compatible). `endorsementV2.ts`
      `verifyChainOfEndorsementsV2(endorsements, releaseChain)` +
      `caEndorsementV2.ts` `verifyCaEndorsementsV2`/`authorizedCaKeysV2`:
      identical structural/cryptographic checks, authority swapped to
      **`currentAuthorityV2` + holder-signs** (L2 dissolved
      `TrackPolicy.approvalRule` ⇒ the mandate `holder` IS the
      operational signer; the quorum is succession-only — the forced,
      non-litigated consequence of the LOCKED model, NOT a new
      decision). Reuses the v1 `VerifiedEndorsements`/
      `VerifiedCaEndorsements` result shapes so consumers swap with no
      downstream change. **27 new tests** incl. holder-rotation-per-
      issuedAt + every fail-closed negative incl. the absent/forked-pin
      chain. maintainers **344→371/36**; flagship guard **2526/225**.
    - **c4.3 `5fb2fdf` (flagship `main`)** — **#30 generalised**.
      `@flagship/protocol` `maintainerCa.ts`:
      `MAINTAINER_GENESIS_PUBKEYS` (string[]) →
      `MAINTAINER_PINNED_MANDATE_HASH` ("" until Gate B);
      `maintainerGenesisConfigured`→`maintainerPinConfigured`;
      `CaArtifactReject` `genesis-unconfigured`→`pin-unconfigured`; the
      `genesisPubkeys` param →`pinnedMandateHash` (string). Module stays
      `@maintainers/protocol`-free (mobile mirrors); `CaTrustChain`
      interface UNCHANGED — the injected port closes over the baked pin
      and does verify-forward-from-pin internally (c4.4). Blast radius:
      maintainerCa.ts/.test.ts + the #30-reason rename in caTrustChain
      .ts/.test.ts. flagship **2526/225**.
    - **c4.4 `ff8ce91` (flagship `main`)** — **the LIVE trust consumer
      migrated.** `server-daemon` `releaseVerifier.ts` +
      `caTrustChain.ts` moved off `verifyTrack`/`TrackPolicy`/policy.json
      /`currentAuthority`/`verifyChainOfEndorsements` onto
      `verifyMandateChainFromPin`/`currentAuthorityV2`/
      `verifyChainOfEndorsementsV2`/`authorizedCaKeysV2` + the v2
      on-disk convention (tracks/<t>/mandates/*.json version-2-filtered,
      NO policy.json — mirrors the cli `readMandatesV2`). `Release
      VerifierOptions` gains `pinnedMandateHash` (defaults to the EMPTY
      baked `MAINTAINER_PINNED_MANDATE_HASH` ⇒ fully fail-closed
      pre-Gate-B; overridable so tests exercise the post-ceremony path).
      **The `ReleaseStatus`/`ReleaseStatusResponse` wire shapes are kept
      byte-stable** (BFF + Swift/Kotlin mirror): `hasPolicy`/
      `rootPolicyPresent` repurposed, semantics documented; so
      `releaseStatusProvider.ts`/`screens` untouched.
      `verifyEndorsementChainAgainstGit` (git-walk) unchanged. Tests
      rewritten to v2 fixtures incl. new fail-closed negatives (empty
      pin, forked pin/pin-not-in-log, tampered-mandate-breaks-anchor).
      **From here the flagship gate is a REAL consumer check of
      `@maintainers/protocol` v2, not just a guard.** flagship tsc -b
      clean + **vitest 2526→2529/225** (+3 from new fail-closed
      coverage — the new honest baseline). Branch pin UNCHANGED
      `833fa45`. flagship no longer imports ANY v1 Mandate-path symbol.
  - **Decomposition correction (honest, verify-before-trust).** The
    prior plan's separate additive "Envelope rework" (old c4.2) was
    over-decomposition: it would force expand-then-contract on the
    large worker/web-ui security surface only to delete the v1 half.
    The handoff itself names exactly THREE logical changes —
    *(a) maintainers-side removal/spec, (b) flagship-side consumer
    migrate, (c) #30 generalise*. **The worker/web-ui MandateV2-into-
    `Envelope` re-base folds into the v1-removal cutover (c4.5)** —
    atomic, no dual-version collision (v1 `Mandate` leaves `Envelope`
    exactly as `MandateV2` enters). c4.2 deleted from the plan.
  - **★ User decision (2026-05-17 s6) — DE-VERSION the protocol
    ("v2" is a transitional dev artifact, not a real version).** The
    maintainers protocol is UNRELEASED and never used (no real genesis,
    nothing pinned, zero adopters); shipping its first-ever version
    named "v2" — and baking the canonical tag `maintainers/mandate/v2`
    into `mandatePinHash`, which Gate B freezes FOREVER — is permanent
    nonsense. Mandated step **c4.6 — de-version rename:** drop the `V2`
    code-symbol suffix (`MandateV2`→`Mandate`, `verifierV2.ts`→
    `verifier.ts`, `currentAuthorityV2`→`currentAuthority`,
    `verifyChainOfEndorsementsV2`→`verifyChainOfEndorsements`,
    `endorsementV2.ts`/`caEndorsementV2.ts` back to their plain names,
    `verifyCaEndorsementsV2`/`authorizedCaKeysV2`→plain; `isMandateV2`/
    `readMandatesV2`→plain) AND reset the Mandate envelope `version: 2
    → 1` + the canonical tag `maintainers/mandate/v2 →
    maintainers/mandate/v1` (KEEP a numeric wire version — that is good
    engineering; the nonsense is only "v1 named v2"). Note: only the
    *Mandate* envelope ever carried the bogus v2 — ReleaseEndorsement /
    CaEndorsement / KeyFile / … are already `version: 1`. **Sequencing
    (load-bearing): c4.5 (frees the names) → c4.6 de-version rename →
    c4.7 spec (authored DIRECTLY under the final name) → c5 (published
    spec + conformance vectors).** It changes `mandatePinHash` output —
    acceptable ONLY because nothing is pinned yet (the SAME "no real
    genesis exists yet" window the v2 lock relied on); it therefore
    MUST precede c5 and Gate B. It is a coordinated flagship-consumer
    rename too (flagship imports `MandateV2`/`currentAuthorityV2`/
    `MAINTAINER_PINNED_MANDATE_HASH`/…) — flagship gate as a REAL
    consumer check, same as c4.4. NOT a trust-model change (the LOCKED
    v2 design is unchanged — only naming + the wire version integer).
  - **Discipline call (honest):** **c4.5 is the next attentive START —
    NOT tail-bolted at the end of this long 3-commit session.** It is
    the single most delicate remaining maintainers change (retire the
    v1 Mandate path in `@maintainers/protocol` AND re-base the entire
    worker + web-ui onto v2 AND rewrite all their tests, in ONE green
    commit — it cannot be safely partialed while keeping the maintainers
    gate green). Deliberately left for a fresh session's full attention.
- **2026-05-17 (v1-launch program session 5, Linux box):**
  - **No env-sync drift (verify-before-trust).** Cold start: `maintainers/`
    clone was on `feat/ca-endorsement`@`10c65aa` (stale). Per the
    continue-rule, NOT `pull-maintainers` (it would reset to the pin and
    discard the v2 branch); instead `git -C maintainers fetch origin &&
    checkout feat/keyfile-register` → `dc48559` (c1) on top of the merged
    pin `833fa45`. Start gate verified at baseline: maintainers (on the
    branch) **311/31 · tsc clean** (307 pin + 4 c1), flagship **2526/225 ·
    tsc clean**. `pwd` checked — no background-cd cwd poisoning this
    session (absolute `cd /home/kamdemharry/flagship &&` used for every
    flagship gate; `git -C` for all maintainers git).
  - **★ Phase-2 v2 spine — c2 LANDED (the load-bearing trust path,
    attentively, NOT tail-bolted).** `5f3b146` on `feat/keyfile-register`,
    pushed: the v2 protocol *core* in `@maintainers/protocol`, **strictly
    additive** (v1 fully intact ⇒ flagship guard provably back-compatible).
    `MandateV2` (inline policy), `canonicalMandateV2` (`maintainers/
    mandate/v2`, fixed 15-slot, non-negative-integer encoder for
    cross-language byte-stability) + `mandatePinHash` (sha256 of canonical
    bytes — content-bound, signature-independent; the #30-generalised
    baked value), `signMandateV2`/`signMandateV2With`,
    **`verifyMandateChainFromPin`** (L1 pin-is-the-floor verify-forward +
    multi-pin + fail-closed on no-pin/pin-not-in-log; L3 ONE rule, no
    self-renewal; TOTAL — never throws on adversarial input) +
    `currentAuthorityV2`. **Verify-before-trust catch:** adding `MandateV2`
    to the v1 `Envelope` union broke the kind-discriminated switch in the
    cloudflare-worker + web-ui adapters (`policy.ts` TS2345) — so
    `MandateV2` is deliberately KEPT OUT of `Envelope` (that store/adapter
    rework is c4); this kept c2 truly additive. **21 new tests** assert
    the happy path + L1 multi-pin + 2-of-3 threshold **and every
    fail-closed negative** (no-pin, pin-not-in-log, forked/tampered pin,
    root-sig-invalid, root-not-self-signed, self-renewal-attempt,
    sub-threshold, under-minSuccessors, over-maxDuration,
    issued-before-predecessor, signed-by-not-in-sigs,
    rolled-back/dropped-intermediate, duplicate-id, cross-track-ignore,
    adversarial-input totality) + pin content-binding + signMandateV2With
    byte-identity. maintainers **332/32 · tsc clean**; flagship guard
    **2526/225 · tsc clean**. Branch pushed; **pin UNCHANGED `833fa45`**
    (upstream branch is pushed, NEVER pinned until the governed merge).
  - **c3 (the CLI verbs) LANDED — same session, on user "continue with
    c3", two attentive commits, NOT tail-bolted.** Each its own logical
    change, each gate-green + pushed:
    - **c3a `23a4d35` — `create-key`.** Self-registered KeyFile via the
      c1 `signKeyFileWith` seam; INDEPENDENT + non-load-bearing
      (`--introduction-mandate` defaults to the nil UUID — the v1-era
      `--mandate-id`/`introductionMandate` bootstrap is OBSOLETE). ONE
      #28 ceremony path; `CeremonyKind` gains `create-key` (honest
      LOW-STAKES banner) + a generic `Assembled.bannerExtra` hook;
      `store.ts` `writeKeyFile`/`keyFileFilename` (append-only). 3 tests.
    - **c3b `2fa2b0c` — `upsert-mandate` (the ONE mandate verb).**
      genesis/mandate/takeover collapse in (from-scratch ORIGIN \|
      succession; renew=rotate=takeover=repolicy, no self-renewal).
      **Headline = fail-closed PRE-FLIGHT:** every predecessor-rule
      check makeable from PUBLIC reads refuses in `assemble` BEFORE any
      token touch — tests prove it with a token whose sign/PIN throw.
      Honest scoped boundary: single-signer only ⇒ pred.threshold > 1 is
      fail-closed-refused (multi-sig quorum collection = scoped
      follow-up; c2 verifier enforces threshold regardless). `store.ts`
      `readMandatesV2`/`writeMandateV2` (file-per-mandate, v2-filtered;
      no policy.json — the published `log.json` is the later c5
      artifact). 9 tests incl. round-trip readMandatesV2 →
      verifyMandateChainFromPin → currentAuthorityV2.
    Both: maintainers `tsc -b` clean + `vitest run` 335 then **344/34**;
    flagship guard **2526/225 · tsc clean** (CLI-only —
    `@maintainers/protocol` untouched). genesis/mandate/takeover remain
    (retired in c4). Branch pushed; **pin UNCHANGED `833fa45`**.
  - **Verify-before-trust note:** `mandateFilename`'s `Pick<Mandate,
    "issuedAt"|"mandateId">` param accepts a `MandateV2` structurally
    (extra props are fine for a non-literal arg) — so v2 reuses it with
    NO widening; confirmed by tsc + the green round-trip tests.
  - **Discipline call (honest):** c4 (retire v1 path + spec→v2 +
    **migrate the LIVE flagship trust consumer** `caTrustChain.ts`/
    `releaseVerifier.ts` + #30-generalised bake) is the next attentive
    START — it changes flagship runtime trust code (the flagship gate is
    no longer just a back-compat guard there) and is security-critical;
    deliberately NOT tail-bolted after two large CLI commits this turn.
- **2026-05-17 (v1-launch program session 4, Mac/darwin):**
  - **★ PHASE-2 RE-LOCKED v2 (user-authorized override of the prior
    D1/D2 lock) — the trust model changed; this is the new
    authority.** A multi-turn verify-before-trust design dialogue
    converged on a strictly better model, explicitly re-locked by the
    user: **(L1)** a pinned `Mandate` is an INDEPENDENT trust anchor
    (genesis = merely "the first pin"); verify FORWARD from it; multiple
    pins coexist forever — **rewrites spec §5.2 "the pin IS the floor"**,
    replaces D2. **(L2)** succession policy folds INTO the Mandate (no
    separate policy file) — **dissolves D1 + the `SignedPolicy`
    envelope entirely** (the unsigned-policy hole vanishes; the rule
    governing K+1 is signed into K). **(L3)** NO self-renewal — ONE
    rule: K+1 valid iff its sigs satisfy K's embedded `approvalRule`
    over K's signer set AND obey `minSuccessors`/`maxDuration`;
    `selfRenewable` knob rejected; bounded duration ⇒ perpetuation
    needs periodic re-quorum (emergent anti-rubber-hose); solo founder =
    `successors=[self,backups],threshold=1`. D3 (CaEndorse NOW-clock
    freshness) UNCHANGED. **Consequences:** Mandate **v2**
    canonical-bytes/verifier change (OK only because no real genesis
    exists yet) ⇒ **the Phase-2 v2 redesign now PRECEDES Phase-1 Gate
    B** (Gate B freezes the pinned-mandate shape FOREVER); **#30
    generalised** → bake the pinned *Mandate canonical hash* per
    surface, NOT `MAINTAINER_GENESIS_PUBKEYS`; CLI = `createKey` +
    `upsertMandate` (genesis/mandate/takeover collapse in); the prior
    register `--mandate-id`/`introductionMandate` sub-plan is OBSOLETE;
    `c1 dc48559` STAYS (KeyFile self-signer parity, still needed for
    `createKey`). Authoritative detail = `docs/v1-launch-program.md`
    "Phase-2 DESIGN DECISION — LOCKED v2" + phase table + spine note +
    §1B SUPERSEDED banner. **Next agent build = the v2 protocol
    redesign upstream (the new #35 spine), at a START, attentively —
    NOT a tail-bolt (the verifier + Mandate canonical bytes are the
    load-bearing path).**
  - **Registration-first increment (#9) started (user-chosen).** User
    asked to confirm "registration ≠ ceremony" (each key self-registers
    under an email id; ceremonies designed freely; tool prompts "tap
    X's key"). Verify-before-trust vs spec §2.4/§3.2/§3.3 + `types.ts`:
    this IS the protocol — `KeyFile` (self-signed, email-named) +
    `EmailRotation`/`KeyRedirect`; identity-for-trust = the **pubkey**
    (spec non-goal: emails "conventional but **not load-bearing**"), so
    the email is a human label, never a credential. **Real gap (same
    shape as the s1 `ca-endorsement` gap):** protocol implements
    KeyFile/EmailRotation, the **CLI has NO `register` command**. User
    chose build register FIRST, then genesis. **`introductionMandate`
    bootstrap decision** (verified `policy.ts:570-577` — verifier
    trusts the self-signed attestation, doesn't cross-check the id;
    it's an audit pointer): pre-mint ONE genesis mandate UUID, both
    KeyFiles `register --introduction-mandate <id>`, `genesis
    --mandate-id <id>` ⇒ pointer is *truthful* (no placeholder lie in
    a root artifact; no register-after). #9 commit plan = program doc
    §1B "0c"; **c1 `dc48559` LANDED + pushed** on
    `feat/keyfile-register` (additive protocol self-signer variants
    `signKeyFileWith`/`signKeyRedirectWith`/`signEmailRotationWith` —
    one signer, `signer.pubKey==envelope.pubkey`, fail-closed; ZERO
    canonical/verifier/wire/spec change §11.1). **maintainers 307→311
    on the branch; flagship guard 2526/225, tsc clean both.** c2–c5 +
    docs + governed PR remain (governed merge = a Human-Gate-A-style
    step → re-pin). This is upstream → branch is pushed, NOT pinned
    (pin stays `833fa45` until merge).
  - **Human Gate A SATISFIED (verify-before-trust on the GitHub side):**
    `gh pr view 2 --repo ibisllc/maintainers` showed PR #2 **MERGED**
    (merge commit `833fa45`, base `main`, mergedAt 19:48Z) — the human
    did the governed merge between sessions 3 and 4. Verified before
    re-pinning: `git merge-base --is-ancestor a195968 833fa45` = YES,
    all 8 #28 commits (`f646f99`..`a195968`) reachable from the merge,
    `833fa45` = tip of `origin/main`.
  - **Gate A agent half executed + both gates re-run green:** bumped
    `scripts/maintainers.pinned-sha` `10c65aa`→`833fa45` (the
    first-parent-reachable MERGE commit, NOT branch tip — same rule as
    the PR #1 re-pin `0697bab`); `pull-maintainers.sh pull` reset the
    clone cleanly; **flagship `npx tsc -b` clean + `npx vitest run`
    2526/225 exit 0; maintainers (now AT THE PIN `833fa45`) `npx tsc
    -b` clean + `npx vitest run` 307/31 exit 0.** Committed `34b6cb5`
    (pin file only — `project.pbxproj` left unstaged as always), pushed
    `origin/main`.
  - **Maintainers baseline moved 257 → 307 AT THE PIN.** The +50 #28
    tests are now first-parent-reachable from `main`; the old
    `10c65aa`/257 baseline is superseded. Every doc that said
    "maintainers 257 at the pin / 307 only on the branch" is now stale
    — the branch was merged; pin == merge == 307.
  - **No redeploy needed (verified, not assumed):** `git diff --stat
    10c65aa..833fa45` = `packages/cli` + `packages/protocol` only;
    `packages/web-ui` byte-identical, so the `flagshipserver.com/
    maintainers/` esbuild bundle is unchanged and the Worker needs no
    redeploy. The only flagship runtime consumer is
    `@maintainers/protocol` via `server-daemon/src/caTrustChain.ts`;
    the green flagship gate proves the additive `Ed25519Signer`/
    `signing.ts` is back-compatible with every `{privKey}` caller.
  - **Shell-cwd-compound hazard bit again (caught, not shipped):** an
    early verify `cd /Users/.../maintainers && git …` poisoned the
    persistent cwd; subsequent "flagship" commands used explicit
    absolute `cd /Users/harrywinner/flagship &&`. The §0 "ALWAYS
    absolute paths" rule stands — this is the 3rd session it has tried
    to bite.
  - **Gate B runbook concretized + source-verified (`d9b4848`):**
    `ca-operations.md` "Operation 0 — genesis" was a 10-line conceptual
    sketch with NO command — the same verify-before-trust hole that bit
    session 1. Rewrote it as a precise step-by-step runbook, every CLI
    detail checked against the merged CLI at the pin (genesis is
    PER-TRACK ⇒ 3 runs ca/release/ops; exact `node
    packages/cli/dist/index.js genesis …` line; `--dry-run` first;
    typed-confirm phrase is exactly `GENESIS`; self-signed invariant;
    successor=2nd YubiKey via a one-time `file:` pubkey export; `npm
    run build` precondition since `dist/` is gitignored; `verify`/
    `status` both take `--path`; bake the single shared `holder`
    pubkey; deploy nothing). Two human-owned non-derivable inputs
    flagged: on-token keygen + PIN/PUK (`ykman`; §11.4 open knob) and
    the cold-genesis `<DURATION>` (LOCKED Phase-2 D1 long-lived track).
  - **Gate-B EXECUTION BLOCKER found (verify-before-trust, attempting
    to walk it after the user chose "walk Gate B now"):** the native
    PC/SC transport is NOT executable yet. `piv-pcsc.ts`
    `connectPcscChannel()` is — by #28's deliberate design — a
    fail-closed stub that throws **unconditionally even when `pcsclite`
    is installed** (`void mod; throw CliError("…no PC/SC reader/token
    round-trip…verified only at the YubiKey ceremony gate")`). #28
    shipped the pure tested `piv-apdu` codec + the `PcscChannel` seam +
    this stub; the real binding wiring (reader enum → connect → APDU
    transmit Buffer↔Uint8Array) is the explicitly-deferred **human-gate
    increment**, implementable only with the real reader+token present.
    The two hardware-INDEPENDENT prep blockers: `pcsclite` binding NOT
    installed, `ykman` NOT installed. **CORRECTION (user-flagged, same
    turn): the "no YubiKey in the USB tree" recon line was
    UNINFORMATIVE and is NOT a blocker** — the key was never requested
    to be plugged in, so an empty USB scan proves nothing; do not
    trust/repeat it. The real blocker is purely the unconditional-throw
    stub + the two absent tools, none of which depend on plug-in state.
    So Gate B is a TWO-PART ordered step — **(P)** human provisions env (install `pcsclite` +
    `ykman`; on-token keygen; plug in both YubiKeys) → **(A)** agent
    implements + LIVE-verifies the `connectPcscChannel` libpcsclite
    wiring behind the tested seam (non-destructive public-key read
    first; security-critical native transport; lands upstream via a
    governed `maintainers` PR + re-pin like PR #1/#2; NEVER written
    blind) → then `--dry-run` → the signed ceremony. **`file:` is NOT
    acceptable for the genesis root** (would put the root private half
    on disk; it is the successor/air-gapped lower-assurance path only).
    **STEP-(A) UX REQUIREMENT (user, hard): the transport must NEVER
    assume the key/reader is present.** Absent reader / absent token /
    not-tapped-yet are NORMAL recoverable states → prompt + wait +
    friendly retry ("Insert your YubiKey…", poll for the reader), NOT a
    fatal `CliError`. Fail-closed is a SECURITY property only (never
    silently sign with a weaker/wrong key); it must not leak into the UX
    of ordinary absent-hardware. See [[feedback-no-hardware-assumptions]].
    Recorded as the GATE-B EXECUTION REALITY callout in
    `ca-operations.md` Operation 0. **No genesis material fabricated;
    nothing signed; binding NOT written blind; stopped with the crisp
    provisioning ask.** Gate B is *armed*; step (A) is the next agent
    increment (hardware-in-loop).
  - **Phase 2 unblocked:** Gate A satisfied ⇒ Phase 2 (#35 → #9 → #10)
    no longer blocked on Phase 1 (it does NOT need Gate B). Only Human
    Gate B (YubiKey genesis) remains in Phase 1. **Phase-2 #35 START
    plan** (next agent build, attentively at a START — NOT a tail-bolt;
    upstream `maintainers` new branch → governed PR, PR #1/#2
    precedent): per the LOCKED design, (1) additive `SignedPolicy` =
    canonical bytes of `RootPolicy`+`TrackPolicy` + ONE genesis-key
    Ed25519 sig (reuses `signing.ts`; ~1 canonical fn) + a `verifyTrack`
    precondition that the consumed `TrackPolicy` MUST verify vs the
    baked genesis authority else hard fail-closed (~10 verifier lines);
    (2) the published static-layout spec
    (`origin.json`/`tracks/<t>/log.json`/`ca-leases.json`) + a tiny
    `fetch()` reference client; (3) conformance vectors that MUST
    include the fail-closed negatives (tampered-policy / lapsed-lease-
    at-NOW / withheld-rolled-back-log / absent-forked-genesis /
    endorsement-gap); (4) `npm publish @maintainers/protocol`
    (semver/`--provenance` — Human Gate: npm org/2FA); (5) flagship
    DROPS `pull-maintainers.sh` + `maintainers.pinned-sha`. Read
    `maintainers/packages/protocol/src/verifier.ts` + `types.ts` +
    `signing.ts` FIRST; ZERO `Mandate`/`CaEndorsement` wire delta —
    `SignedPolicy` is the only additive spec change.
- **2026-05-17 (v1-launch program session 3, Mac/darwin):**
  - **No env-sync drift** (verify-before-trust): the gitignored
    `maintainers/` clone was already on `feat/piv-ed25519-signer` @
    `3a4bbe9` and clean → `pull-maintainers.sh` correctly NOT run (it
    would discard the branch for the pin). Start gate confirmed:
    flagship **2526/225 · tsc clean**, maintainers (on the branch)
    **277/26 · tsc clean** — exactly the documented baseline.
  - **Re-confirmed shell-cwd-compound hazard (caught, not shipped):**
    a background `cd maintainers` left the persistent cwd in
    `maintainers/`, so the first two "flagship" gate runs actually ran
    the maintainers suite. Caught immediately (277 ≠ 2526), re-run with
    absolute `cd /Users/harrywinner/flagship &&` — flagship gate then
    verified 2526/225. The §0/program-prompt "ALWAYS absolute paths"
    rule stands; this is exactly the trap it warns about.
  - **Phase-1 #28 — three security-critical commits landed (green,
    pushed); PR #2 flipped out of draft:**
    - `4647582` assemble/sign split + `--dry-run` (exact canonical
      bytes + `.maintainers` diff; no PIN/tap/sign/write;
      `loadSignerBoundPubKey`; `signAssembled` swap-guard). 277→281.
    - `d55a86d` ceremony banner + typed confirm (`ttyConfirm`,
      ceremony-phrase, `--yes` bypass, fail-closed when piped) +
      whole-surface never-log-secrets sweep + genesis successor
      guidance. Existing write-path dispatch tests now pass `--yes`.
      281→290.
    - `a195968` native PC/SC stub: pure tested `piv-apdu` codec +
      `piv-pcsc` channel seam; optional `pcsclite` dynamic-import
      fail-closes precisely (no package.json/lockfile change; NEVER a
      hex fallback; libpcsclite round-trip = Human Gate B only).
      290→**307**.
    - ZERO protocol/canonical/wire/spec delta — all changes are in
      `maintainers/packages/cli` only; `@maintainers/protocol` is
      untouched, so flagship's protocol-only import graph is **provably
      outside** the change (same basis §0 uses for pin-SHA/Android).
      The final flagship gate was still re-run as the guard: **2526/225
      · tsc clean** (baseline held). `tsc -b` clean throughout
      maintainers.
  - **PR #2 (`ibisllc/maintainers#2`) is now READY (out of draft)**,
    tip `a195968`, body rewritten to the full 8-commit #28 scope.
    Phase-1 AGENT work is **complete**; only Human Gate A (governed PR
    #2 merge → re-pin) and Human Gate B (YubiKey genesis) remain.
  - **Phase-2 design LOCKED (user-picked, 2026-05-17):** "pin one key,
    fetch a folder, verify at your own clock" — D1 genesis-signed
    immutable `SignedPolicy` (closes the unsigned-`policy.json` hole;
    no per-ceremony threshold), D2 a dumb static `origin.json`/
    `tracks/<t>/log.json`/`ca-leases.json` layout (no `current.json`/
    checkpoint files in v1), D3 freshness = the shipped `CaEndorsement`
    NOW-clock lease (nothing new). ZERO Mandate/CaEndorsement wire
    delta; only additive `SignedPolicy`. Full rationale + #35 scope
    delta + the accepted limitation (no equivocation/split-view
    detection) in `docs/v1-launch-program.md` → "Phase-2 DESIGN
    DECISION". This is the Phase-2 acceptance bar; do not re-litigate
    without the user.
- **2026-05-17 (v1-launch program session 2, Mac/darwin):**
  - **No env-sync drift this session** (verify-before-trust): the
    gitignored `maintainers/` clone was already on
    `feat/piv-ed25519-signer` @ `9e7c495` (clean) from session 1 —
    `pull-maintainers.sh` was therefore NOT run (it would discard the
    branch checkout for the pin). Gate at start confirmed: flagship
    **2526/2526 · tsc clean**, maintainers (on branch) **270/270 · tsc
    clean**. Continue rule holds for the next cold start: if the clone
    is stale, `pull-maintainers.sh` then `git fetch && git checkout
    feat/piv-ed25519-signer`; if already on the branch & clean, do NOT
    pull.
  - **Phase-1 #28 — three security-critical commits landed (green,
    pushed, draft PR #2):**
    - `d2027df` thread the external signer through genesis/mandate/
      takeover: async `build*`, keys via `loadSigner`/`loadSignerPubKey`
      (+ new `loadSignerPubKeyList` for a `yubikey-piv:` second key in a
      successors/holder CSV — §11.2), `signMandateWith`. `dispatch`/
      `run` async; each command `await`ed inside the try so a `CliError`
      still maps to exit 1; bin shim awaits. `CliEnv` gains optional
      `pivTransport`/`pivPin` (real transport fail-closes — NEVER a
      silent hex fallback). New test proves the YubiKey-PIV genesis is
      byte-identical to the hex path and verifies (the §11.1 linchpin
      end to end). 270→271.
    - `5148bbf` thread the signer through release `endorsement` too
      (§10.1: ALL maintainer-key ceremonies on the one path; the legacy
      `loadPrivKey` had also *rejected* `yubikey:`). 271.
    - `3a4bbe9` add the missing **`ca-endorsement` command** +
      `store.ts` `writeCaEndorsement` defining
      `.maintainers/ca-endorsements/<ts>-<id>.json` — exactly what
      `rotate-ca.mjs` `readCaEndorsements` already reads. Closes the
      real gap from session-1 §0 (Op 1 Path B referenced a nonexistent
      command). Non-fatal advisory when the signer is not the on-disk
      ca authority; never hard-fails (authority is the verifier's call
      at its own clock; overlapping leases/takeovers are legitimate).
      Cross-checked end to end vs `verifyCaEndorsements`/
      `authorizedCaKeys`. 271→**277**.
    - ZERO protocol/canonical/wire/spec delta across all three (a
      PIV-Ed25519 signature over the canonical bytes is byte-identical
      RFC-8032 Ed25519). `tsc -b` clean throughout.
  - **Flagship-side (→ origin/main):** `scripts/rotate-ca.mjs` Step-2
    fallback now references `--signing-key yubikey-piv:slot=9c` (file:
    documented as the lower-assurance air-gapped/successor fallback);
    `docs/ca-operations.md` Path B corrected — the command + signer
    source now exist, "staged" note removed. `rotate-ca.test.ts` is
    pure-logic (doesn't exercise the print path) so the string change
    is test-safe; flagship gate held **2526/2526 · tsc clean**.
  - **Phase-1 AGENT remaining (next session START, attentively — do NOT
    tail-bolt; security-critical ceremony surface):** (1) `--dry-run`
    for genesis/mandate/takeover/ca-endorsement — print the EXACT
    canonical bytes + the would-write `.maintainers` diff and sign/
    write nothing; resolve pubkeys via the no-PIN public read only.
    **This requires refactoring each `build*` to first compute the
    *unsigned* envelope + target path, then sign**, so the dry-run
    preview is the same bytes the real run signs (fidelity is the
    point; uuid/timestamps differ across separate invocations — note
    that in the banner). (2) Plain-language per-ceremony banner + typed
    explicit confirm before any token-touch/write (injectable;
    `--yes`/non-interactive bypass for tests) + a regression test
    asserting PIN/seed never appears in any emitted line + second-key/
    successor guidance. (3) Native PC/SC `PivTransport` stub: APDU
    encode/parse (SELECT PIV AID `A0 00 00 03 08`, VERIFY PIN, GENERAL
    AUTHENTICATE Ed25519, GENERATE) as pure tested functions behind a
    channel seam; the libpcsclite round-trip fail-closes precisely (no
    new mandatory dep; NEVER a hex fallback), verified only at the
    YubiKey gate. Then 1B human gate.
- **2026-05-17 (v1-launch program session 1, Mac/darwin):**
  - **NEW authoritative tracker:** `docs/v1-launch-program.md` created
    (first run from the `/alpha` Phases-1-8 prompt). It is now the
    source of truth for *which phase + what's done*; this file stays
    the fine-grained backlog/drift/gate source. Cold-start read order
    adds it after §0/§3/§5.
  - **Cold-start env-sync drift (found+fixed, NOT a regression):** on
    this Mac the gitignored `maintainers/` clone was stale at
    `c009900` (pre-CaEndorsement) → `npx tsc -b` RED on two
    `packages/server-daemon/src/caTrustChain.ts` imports of
    `authorizedCaKeys`/`CaEndorsement`. Fix is the documented one:
    `bash scripts/pull-maintainers.sh pull` (idempotent; resets to the
    pin `10c65aa`). Then flagship gate **2526/2526 · tsc -b clean**,
    maintainers suite **257/257**. **Every cold start on a fresh
    machine must run pull-maintainers first** (the clone is not
    vendored). `timeout(1)` is absent on macOS — don't wrap commands
    in it.
  - **Environment delta (this box):** darwin/Mac, Xcode 16.4
    (xcodebuild present → iOS verifiable here), **no real JDK**
    (`/usr/bin/java` stub → Android review-only here). Inverse of the
    resume-#2 Linux box. iOS sim UDIDs in memory may be stale.
  - **Phase 1 / #28 — two keystone pieces built+green+pushed:**
    `protocol` external `Ed25519Signer` (`f646f99`: interface +
    `privKeySigner` wrapper [ONE signing path] + `sign*With` async
    variants; **ZERO canonical/verifier/wire/spec change** — the
    §11.1 linchpin; back-compat with all `{privKey}` callers) and
    `cli` `loadSigner`/`PivTransport` seam (`9e7c495`: injectable PIV
    transport, fail-closed `realPivTransport` [no silent hex
    fallback], `loadSignerPubKey` no-PIN read, PIN-never-logged
    test). maintainers **257→270** green, `tsc -b` clean. On upstream
    branch `feat/piv-ed25519-signer`, **draft PR
    `ibisllc/maintainers#2`** (push+PR pre-authorized §10.4; merge
    governed; on merge bump `scripts/maintainers.pinned-sha` +
    re-pull). Branch is PUSHED (durable — not lost like the original
    `feat/ca-endorsement`).
  - **Real gap surfaced (verify-before-trust):** `docs/ca-operations.md`
    Operation 1 Path B invokes `node packages/cli/bin/maintainers
    ca-endorsement …` but **no `ca-endorsement` CLI command exists**
    (commands = genesis/mandate/endorsement[=Release]/takeover/verify/
    status; the CaEndorsement *protocol* sign/verify landed in PR #1,
    the *issue-a-lease command* did not). Blocks Operation 1 (weekly
    lease) at the human gate. Tracked in the #28 row + program doc
    Phase 1; build it with the command-threading increment.
  - **Phase 1 remainder (deliberately NOT tail-bolted — security-
    critical ceremony surface):** thread `loadSigner` through
    genesis/mandate/takeover (async `build*` refactor); genesis/
    ceremony UX hardening (banner, `--dry-run` = print canonical
    bytes + `.maintainers` diff & write nothing, typed confirm,
    never-log-secrets, fail-closed reasons); the `ca-endorsement`
    command; native PC/SC `PivTransport` (verified only at the
    YubiKey human gate). Start the NEXT session attentively, not at a
    tail.
- **2026-05-16 (resume #2, #8 done + #9/#10 SCOPE CORRECTED):** the
  governed PR #1 was merged by the maintainer (authorized via the
  session prompt); re-pinned `scripts/maintainers.pinned-sha` →
  `10c65aa` (merge commit, NOT branch tip `5cace76`); `0697bab`.
  `pull-maintainers.sh` reset the snapshot cleanly;
  `@maintainers/protocol` now exports the CA API. **#8 daemon port
  built + tested** (`beb6279`: `caTrustChain.ts` + `releaseVerifier.ts`
  `verifiedTrackFromFolder`; 7 tests; gate 2521). **But the handoff's
  "#8/#9/#10 = mechanical 1-liner per call site via `authorizedCaKeys`"
  was inaccurate** (verify-before-trust): (a) there is **NO production
  call site** of the #30 chokepoint anywhere in flagship — only tests
  reference the raw `verifyDemoDirective`/`verifyUserPubKeyBinding`;
  (b) the maintainers store reader (even post-merge) only knows
  `endorsements/` = `ReleaseEndorsement` — there is **no on-disk
  CaEndorsement directory convention** in the spec or store, and
  flagship's `.maintainers/` has zero endorsements; (c) genesis stays
  empty so the #30 chokepoint fail-closes and the port is never
  consulted regardless. So #8 took CaEndorsements as an **injected
  arg** (invents no disk path); #9 (webapp) needs the upstream store
  convention + a bundled browser verifier; #10 (iOS/Android) ALSO
  needs a Swift+Kotlin reimpl of the TS-only maintainers verify — it
  is the heaviest item, NOT a session-tail 1-liner. #9/#10 re-scoped
  in §3; the real unblock is the upstream CaEndorsement store
  convention (#31/#27 territory), not flagship wiring.
- **2026-05-16 (resume #2, #3 flake — CORROBORATED):** the §0
  parallel-run flake **reproduced once** under heavy concurrent load
  (`1 failed / 2513 passed`) during the post-re-pin gate, then was
  **deterministically green on the immediate verbose re-run**
  (`2514/2514`) and again at `2521/2521` after #8. `tsc -b` clean
  throughout; the changed files (pin SHA, Android, `maintainers/`) are
  provably outside the flagship TS/vitest graph. `personalize.test.ts
  > personalizeStream` was observed at **~19 s** under load (30 000 ms
  `testTimeout`) — consistent with the #3 verdict (rare
  timeout-under-CPU-contention, not a logic bug). No new action;
  watch procedure unchanged.
- **2026-05-16 (resume #2, #33 — FULLY CLOSED):** after the
  `assembleDebug` `@Composable` fix, `./gradlew :app:testDebugUnitTest`
  surfaced a second never-run layer — 4 latent test failures (was the
  whole point of #33). Root causes + faithful fixes: (a) 3 Robolectric
  classes missing the `@Config(sdk = [33])` pin every passing class
  here already carries (Robolectric 4.13 max SDK 34 < targetSdk 35);
  (b) `KeystoreIrkVersionTest`/`KeystoreWipeTest` called production
  `Keystore.attach()` (needs hardware AndroidKeyStore) instead of the
  `attachForTest(prefs)` seam their own docstrings describe; (c)
  `MockScreensClientTest.appsList_returnsKnownApps` asserted the
  pre-#20 bare-name shape vs the iOS source-of-truth namespaced IDs.
  Fixed in `d960691`; **`assembleDebug` green + `testDebugUnitTest`
  190/190, 0 failures.** #33 done. Note: `build-tasks §S:624`
  ("Android on internal-track Play, 5+ testers") is a *launch gate*
  (signing + Play upload + testers), NOT this build/test prerequisite —
  deliberately left unticked; ticking it would be false.
- **2026-05-16 (resume #2, #3 vitest flake — TRIAGED, no code change):**
  the one-off "1 failed / 2503 passed" parallel-run flake. Both §0
  named candidates ruled out **by inspection**:
  `renewIfNeeded.test.ts` is fully deterministic (injected `now`, fake
  issuer, no I/O/shared state); `dns-broker/test/index.test.ts` mutates
  only `globalThis.fetch`/`_internal.ipBuckets` and restores them in
  `afterEach` — and vitest 2.x here runs the **default `forks` pool
  with per-file isolation** (no custom `pool`/`isolate` in
  `vitest.config.ts`), so cross-file contamination is structurally
  impossible. They were "candidates" only because they emit expected
  negative-path stderr (visually noticeable in a failed run's tail) —
  correlation, not the failing assertion. Verdict: **rare
  timeout-under-CPU-contention at maximal fork parallelism, not a
  logic/product bug** (additive-only changes since; `tsc -b` clean;
  2514/2514 green on this session's cold full run). No safe
  evidence-based deterministic fix exists; a speculative spec-pin or
  retry is forbidden by the §0 note itself and would mask. **Watch
  procedure:** on recurrence, capture `npx vitest run
  --reporter=verbose` (names the failing spec + its duration vs the
  30 000 ms `testTimeout`); only then pin/raise that specific spec's
  timeout. #3 closed as triaged.
- **2026-05-16 (resume #2, this Linux box — ENVIRONMENT DELTA):** the
  prior handoff repeatedly asserted "Android review-only (no JDK —
  `/usr/bin/java` is the macOS stub)". **False on this machine:** this
  is a Linux box with **OpenJDK 17 + Gradle 8.10.2 + a populated
  `ANDROID_HOME=/home/kamdemharry/android-sdk`** (platforms 34/35,
  build-tools 34.0.0). #33 is therefore **UNBLOCKED here** and was
  executed. Conversely iOS xcodebuild is **not** available on Linux —
  #7/#79A/iOS-port verification flips from "verifiable here" to
  "review-only here". Pin paths absolutely: the harness shell keeps
  cwd across calls, so a bare `cd apps/mobile/android` compounds.
- **2026-05-16 (resume #2, #33 — REAL never-compiled drift FOUND+
  FIXED):** first real `./gradlew :app:assembleDebug` failed at
  `:app:compileDebugKotlin` — a misplaced `@Composable` annotation in
  `AppDetailScreen.kt` landed on the top-level `STEM_RE` regex const
  (591) instead of `ReplaceStemDialog` (596); the `STEM_RE` decl + its
  comment had been inserted between the annotation and its fn. 3 Kotlin
  errors. Exactly the latent review-faithful drift #33 predicted.
  Fixed by moving the annotation back onto the fn. (Note: a
  `… | tail` pipe masks Gradle's exit code as the pipe's — always read
  `BUILD SUCCESSFUL/FAILED` or `${PIPESTATUS[0]}`, never trust the
  background "exit 0".)
- **2026-05-16 (resume #2, #34 — TRIAGED → v2-deferred):**
  `inheritance.ts` (#77) verdict: **deliberate v2 seam, not a v1 gap.**
  Built+exported+unit-tested (`inheritance.test.ts`), NOT route-wired,
  NOT cron-wired; absent from `build-tasks §S` and `CLAUDE.md`
  outstanding work. Recorded in the new `docs/policy/inheritance.md`
  (the decision record the module's own docstring already pointed at —
  it had been dangling). No v1 action; #34 closed.
- **2026-05-16 (resume, CRITICAL):** `feat/ca-endorsement`
  (`496abae7`) — claimed in `docs/maintainer-ca-endorsement.md` §8/§9
  as "BUILT, durable locally in `./maintainers`" — **did NOT exist on
  this machine and was never pushed anywhere reachable.** `maintainers/`
  is git-ignored and pulled fresh by `pull-maintainers.sh` at the
  pinned SHA (`c009900`); the prior session's local-only branch was
  lost with the original Mac. **Resolution:** the `CaEndorsement`
  workstream was **faithfully reconstructed** from the authoritative
  spec (`docs/maintainer-ca-endorsement.md` §4 + §9, with
  `ReleaseEndorsement` as the explicit template), 4 commits on a fresh
  `feat/ca-endorsement` (tip `5cace76`), **257 maintainers tests green**
  (was 231; +26), `tsc -b` clean across the maintainers workspace;
  pushed to `ibisllc/maintainers`; **PR #1 open**
  (https://github.com/ibisllc/maintainers/pull/1) — merge is governed.
  Exports delivered exactly per §9: `verifyCaEndorsements`,
  `authorizedCaKeys`, `verifyTrackFromCheckpoint`,
  `checkpointFromVerifiedTrack` (+ `signCaEndorsement`,
  `canonicalCaEndorsement`, `CaEndorsement` type).
- **2026-05-16 (resume, minor):** maintainers repo at base `c009900`
  `tsc -b` is clean; adding `CaEndorsement` to the `Envelope` union
  necessarily touched every dispatch site in `cloudflare-worker
  policy.ts` + `web-ui adapter.ts` (parse/canonical/signatures/
  authority/commit-message) — all handled in commit 1, no behavior
  change to existing envelopes.
- **2026-05-16 (resume):** flagship ground truth verified —
  `git log` matches, `tsc -b` clean, `vitest run` **2492 / 221**
  (baseline holds); spot-checked #4/#12/#14/#23 exist in code.
- **2026-05-16 (resume, flake — DISCOVERY):** one intermittent test
  failure observed once under the full `vitest run` (`1 failed | 2503
  passed`), deterministically green on every isolated + full re-run
  (`2504`/`2509` passed). Not introduced by the resume changes (tsc
  clean; additive-only). Likely a parallelism/timing-sensitive spec
  (candidates seen emitting expected negative-path stderr under load:
  `apps/dns-broker/test/index.test.ts`,
  `packages/server-daemon/tests/renewIfNeeded.test.ts`). Triage in
  the discovery sweep — pin the flaky spec or add a deterministic
  wait; do not mask with a blanket retry.

- **2026-05-16 (resume, Android build-blocker — FOUND+FIXED):** while
  wiring #20, found `AppDetailScreen.kt` + `TrustedDevicesScreen.kt`
  construct 3 plain (non-`androidx.lifecycle.ViewModel`) classes via
  Compose `viewModel(factory=…)` (`fun <VM:ViewModel> viewModel`) —
  the Android module would NOT compile (latent in the #80/#81
  review-faithful work; Android is review-only here so it was never
  caught). Fixed: `RenameAppViewModel`/`ReplaceDeviceViewModel`/
  `WipeRestartViewModel` now `: ViewModel()` (commit `c06ca9f`),
  matching the already-correct `TrustedDevicesViewModel`. Other
  screens that construct plain VMs via `remember{VM()}`
  (ActivityScreen/ServerDetailScreen) are fine — that is the correct
  convention for a plain VM and is what #20's AppsListScreen uses.
  Next JDK-equipped session should still run a real Gradle build to
  shake out any further never-compiled Android drift.

- **2026-05-16 (resume, discovery sweep — step 4):** systematic
  TODO/FIXME/501/stub grep + spot-checked ✅-done claims
  (#4/#5/#6/#12/#14/#23) — all substantively real in code.
  Net-new findings:
  - **`packages/control-plane/src/inheritance.ts`**: a built module
    (`InheritanceStorage` + declaration handlers) with **no
    `apps/com` route wiring** and a deliberately-deferred
    `recordSigningActivity` cross-call (rePair/username-claim don't
    invoke it). Not in §S or this backlog → likely v2/future, but
    needs a one-line triage verdict (v1-unwired vs v2-deferred) →
    discovery task added.
  - **`scripts/check-push-secrets.mjs`**: covered by a vitest test
    but NOT wired into any CI workflow (manual/operator guard only).
    Minor — `marketplace-scan.yml` is the pattern to copy if the
    next session wants it auto-run; recorded, not built (no repo
    secrets in a CLI session to validate a live check).
  - 501s in `luksKeys.ts`/`screensHttp.ts` + `backupLoop.ts` TODO-v2
    + `serverMetrics` stubbed history + `stableIdReissuer.ts`
    "stubbed" are all intentional/documented or already-tracked
    (stableIdReissuer = the known Recovery J.4 v1 item) — NOT new.

## 1. Cold-start read order

1. **This file** (state + backlog).
2. `docs/plan-external-domains-and-demo.md` — the master tracker; every
   phase has a progress note with exact commit SHAs + what's done/open.
   Its **Track P** + `docs/maintainer-ca-endorsement.md` **§10–§12** are
   the maintainer→CA design (read §10/§11/§12 in order).
3. `docs/build-tasks.md §S` — the v1-alpha ☐→☑ checklist.
4. `docs/ca-operations.md` — CA/maintainer runbook (+ the 2026-05-16
   "SECURITY-MODEL CORRECTION" / "CEREMONY SURFACE UPDATE" /
   "OSS-GENERIC REFRAME" sections).
5. `CLAUDE.md` — repo orientation + ops commands.
6. If on the original Mac: the `~/.claude` memories add live context;
   on any other machine, this file + the docs above are sufficient.

## 2. Live production state (verify before relying)

- **Gate:** `npx tsc -b` clean · `npx vitest run` → **2526 passed / 225
  files** on `main` (resume #2: +7 #8 caTrustChain → 2521; then +5 from
  the user's own `5b7d140` `/alpha` route tests → 2526). One
  pre-existing intermittent flake under heavy parallel load
  (deterministically green on re-run) — see §0 #3 + watch procedure.
  Everything pushed to `origin/main` (direct-to-main is this repo's
  convention; pushes work without prompt).
- **`.com` Worker `flagship-com`:** last deploy version `70a43eea`
  (the #24 install-policy fan-out). D1 migrations applied through
  **`0025`** (`0025_install_policy_fanout`, applied remote 2026-05-16
  resume: `changed_db:true`, 16 tables; `install_policy_fanout`
  confirmed live; `/api/health` ok). Secrets verified live: all 4
  `APNS_*` + `WEBPUSH_*` + `SERVICES_CONTROL_SECRET` set (run
  `node scripts/check-push-secrets.mjs`). `SERVICES_BASE_URL=
  https://flagship-services.fly.dev:8443` (the `.services` API is on
  the **:8443** TLS-term port, NOT apex :443).
- **`.services` Fly app `flagship-services`:** deployed earlier this
  session-chain; the lazy-SNI resolver + commit changes since are
  build-to-seam (not wired into the raw-TCP hot path — task #22).
- **iOS app:** builds clean from HEAD (`cd apps/mobile/ios/App &&
  xcodegen generate && xcodebuild -project FlagshipApp.xcodeproj
  -scheme FlagshipApp -destination 'platform=iOS Simulator,id=<udid>'
  build`); 232 XCTests green. *(Verified on the original Mac;
  **not** re-verifiable on the current Linux box — no xcodebuild.
  See §0 ENVIRONMENT DELTA.)*
- **Android app:** `cd apps/mobile/android && ./gradlew
  :app:assembleDebug :app:testDebugUnitTest` — green on this Linux
  box (JDK17 + `ANDROID_HOME`); **190 unit tests, 0 fail** as of
  `d960691`. Android is the CLI-verifiable mobile target here.
- **Known benign:** `apps/mobile/ios/App/FlagshipApp.xcodeproj/
  project.pbxproj` shows perpetually-modified — it is a deterministic
  xcodegen artifact regenerated by `xcodegen generate` from
  `project.yml`. NOT a source change; intentionally never staged;
  regenerates identically on any machine. Do not commit it.

## 3. THE BACKLOG (rebuild your TaskList from this table)

> ⚠ **Rows #8/#9/#10/#27/#28/#30/#35 below predate the s4 Phase-2 v2
> re-lock and describe the v1-era model (SignedPolicy, per-track
> genesis, `MAINTAINER_GENESIS_PUBKEYS` pubkeys, register `--mandate-id`
> bootstrap).** Those mechanics are SUPERSEDED — authoritative now is
> `docs/v1-launch-program.md` "Phase-2 DESIGN DECISION — LOCKED v2"
> (pinned-mandate anchor + in-mandate policy + L3 one-rule; Mandate v2;
> #30 bakes the pinned-mandate *hash*; `createKey`+`upsertMandate`;
> the v2 redesign PRECEDES Gate B). Rebuild the TaskList from the v2
> lock + the revised spine, not from the literal pre-v2 row text.

Status key: ✅ done · ⛔ blocked-by-design/governed/real-infra (seam
built + documented; not effort-blocked) · ▶ buildable now.

| # | Item | Status | What's needed / where |
|---|---|---|---|
| 1 | Phase 6 webapp #80/#81 | ✅ | deployed+verified |
| 2 | Phase 6 Android #80/#81 | ✅ | review-faithful → now **compile+test-verified** on Linux (#33: assembleDebug + 190 unit tests green) |
| 3 | #85 demo LLM cap | ✅ | deployed |
| 4 | #83 demo provision/decommission CLI | ✅ | `scripts/demo-account.mjs` |
| 5 | C4.1c daemon ACME+sibling seam | ✅ | runtime wiring = #21 |
| 6 | replace-time DELETE(old fqdn) | ✅ | deployed |
| 7 | #79A C2.4 iOS Live setCustomDomain | ✅ | 232 XCTests green |
| 8 | maintainer→CA link-4 daemon | ✅ | **Built+tested** (`beb6279`): `caTrustChain.ts` `makeCaTrustChain` (adapts `@maintainers/protocol` `authorizedCaKeys`→#30 `CaTrustChain`; now-ms→Date) + `releaseVerifier.ts` `verifiedTrackFromFolder` disk bridge; 7 tests; gate 2521. Correctly inert (#30 fail-closed until genesis). |
| 9 | maintainer→CA link-4 webapp | ⛔ | **Scope corrected (§0): NOT a 1-liner.** Same shape as #8 in `apps/web`, but blocked on the genuine upstream gap (no on-disk CaEndorsement store convention — see §0) + needs a bundled maintainers verifier / browser `.maintainers` source. No #30 call site exists yet. Post upstream-store-convention. |
| 10 | maintainer→CA link-4 iOS/Android | ⛔ | **Scope corrected (§0): the heaviest, NOT a 1-liner.** Needs a Swift+Kotlin reimplementation of maintainers `verifyTrack`/`verifyCaEndorsements`/`authorizedCaKeys` (TS-only today) + the upstream CaEndorsement store convention + a call site. Explicitly do-not-bolt-at-session-tail (security-critical crypto). |
| 11 | **Track P 1-2: push `feat/ca-endorsement` + PR** | ✅* | **RECONSTRUCTED (drift §0) + pushed; PR #1 open** (`ibisllc/maintainers#1`, tip `5cace76`, 257 green). *Remaining = governed: on merge bump `scripts/maintainers.pinned-sha` to the merge SHA + run `pull-maintainers.sh` (do NOT pin to the unmerged branch tip). |
| 12 | lazy-SNI seam+endpoint | ✅ | deployed; socket wiring = #22 |
| 13 | C-iso verify+tick §S | ✅ | |
| 14 | B-scan auto-trigger | ✅ | deployed (`400186b0`) |
| 15 | B-e2e rig | ✅ | Rig was already built + green (B-tsc done, e2e `tsc` clean, **46 tests / 17 files** collect; last-run passed). The real gap = no CI ran it. Added `.github/workflows/e2e.yml` (chromium-only; README's wrangler-dev procedure; pull_request + dispatch). First green run is on a real GitHub runner (CLI can't run Actions — same seam as build-iso.yml). |
| 16 | B-A2 Replace-device "Take over now" UI | ⛔ | v1.1-deferred by the project's own code/copy; needs the live cross-device recovery exercise. VM complete; initiate leg wired |
| 17 | B-A3 webapp full Wipe ceremony | ⛔ | v1.1-deferred by CLAUDE.md/in-product copy; needs live cross-device WebAuthn-PRF exercise. Seam exists (keystore IDB + lib/recovery.js + WipeRestart envelope) |
| 18 | C-A1 live WebAuthn wrappers | ⛔ | needs a real authenticator/device; iOS ASAuth PRF stub, iOS18+ only — document the iOS17 fallback |
| 19 | Audit | ✅ | 17 findings → tasks #23–#26 + #14 rescope |
| 20 | Android apps-list /links fan-out | ✅ | `AppsListViewModel.kt` (Kotlin mirror of the iOS VM) + `AppsListScreen` rewired off `sampleApps()` via the `remember{VM}` convention (ActivityScreen pattern, NOT the broken `viewModel()` one); merge faithful to iOS AppsTab.AppRow; fixed 2 pre-existing dead nav routes now exercised (`apps/`→`app-detail/`, `vibe-code/describe`→`vibe/describe`). Review-only (no JDK). Spun off the ViewModel-base build-blocker fix |
| 21 | C4.1c runtime wiring + live exercise | ⛔ | real-infra (real CNAME→LE cert→green padlock→sibling failover). Steps in plan-doc Phase 4 note |
| 22 | lazy-SNI → routeToTunnel wiring | ⛔ | raw-TCP :443 hot path, no unit harness — focused pass; correctness core (push+cold-start) already shipped |
| 23 | verify push secret injection (audit N3) | ✅ | verified live; `scripts/check-push-secrets.mjs` guard |
| 24 | N0d-2 install-policy push fan-out | ✅ | `install_policy_fanout` store (types/inMemory/d1/0025) + serverRegister best-effort at-most-once empty-payload "server-registered" fan-out + apps/com wiring; 8 tests. build-tasks:664 ☑. Deployed (mig 0025 + Worker) |
| 25 | N0e-2 daemon sibling-WS auto-dial | ✅* | `siblingHandshakeClient.ts`: `startPersistentSiblingHandshakeClient` + `SiblingHandshakeClientManager` (reconnect/backoff/jitter/`setPeers`) at parity with cert-sync `SiblingClientManager`; router setSibling/removeSibling symmetric with the inbound accept; 5 tests; exported. build-tasks:666 ☑. *Joint runtime `setPeers`-from-discovery instantiation = live exercise (→ #16; neither persistent supervisor is runtime-instantiated by precedent) |
| 26 | verify Forgejo + real-LLM streaming (audit N1/N2) | ⛔(mostly) | largely real-infra: real provider key + live daemon; add Forgejo+vibe-code e2e smoke |
| 27 | Track P 3 genesis ceremony (app-primary + CLI fallback) | ⛔ | Upstream `ibisllc/maintainers` CLI, sequenced **post PR #1 merge** (§5); the real genesis run is human+YubiKey. Seam = the complete design in maintainer-ca §10.3/§11.2 + ca-operations "Operation 0" + the now-reconstructed PR #1 protocol; tests use the deterministic placeholder genesis (#30 already fail-closed-tested). Don't pile more unmerged upstream behind the governed PR. |
| 28 | Track P 4 PIV-Ed25519 signer (**Phase 1**) | ✅ AGENT (human gates remain) | **AGENT-COMPLETE+green+pushed** (2026-05-17 s1–s3): `protocol` `Ed25519Signer` (`f646f99`) + `cli` `loadSigner`/`PivTransport` (`9e7c495`) + threaded through genesis/mandate/takeover (`d2027df`) + release endorsement (`5148bbf`) + `ca-endorsement` command & `.maintainers/ca-endorsements/` store (`3a4bbe9`) + **assemble/sign split & `--dry-run`** (`4647582`) + **ceremony banner / typed confirm / never-log-secrets / successor guidance** (`d55a86d`) + **native PC/SC `piv-apdu` codec + `piv-pcsc` channel seam, fail-closed** (`a195968`). ZERO protocol/wire/spec delta (CLI-package only — `@maintainers/protocol` untouched); maintainers 257→**307**. **PR `ibisllc/maintainers#2` MERGED `833fa45` (Human Gate A ✅ — session 4).** Agent half done: re-pinned `scripts/maintainers.pinned-sha` `10c65aa`→`833fa45` + `pull-maintainers.sh` + both gates re-run green (flagship 2526/225; maintainers 307/31 **AT THE PIN**); commit `34b6cb5` pushed; web-ui byte-identical between pins ⇒ no Worker redeploy. **Remaining = Human Gate B (TWO-PART, s4 finding):** `connectPcscChannel` is a fail-closed stub by #28 design (throws even with `pcsclite` present) — the real libpcsclite wiring is the deferred human-gate increment. (P) human provisions (`pcsclite`+`ykman`, on-token keygen both YubiKeys, plug in, decide DURATION) → (A) agent implements+live-verifies the binding behind the tested seam (governed `maintainers` PR + re-pin; never blind) → `--dry-run` → human signs genesis per track → agent verifies+bakes `MAINTAINER_GENESIS_PUBKEYS` (#30 flips live)+re-run #8. `file:` NOT acceptable for the genesis root. Design: maintainer-ca §10.1/§11.1 + ca-operations Operation 0 "GATE-B EXECUTION REALITY" + program doc Phase 1. |
| 29 | Track P 5 OPTIONAL hosted committer | ✅* | IS the upstream `maintainers/.../server-adapters/cloudflare-worker` Model A worker (`worker.ts` POST /commit — holds only a GitHub PAT, no maintainer/CA key; `policy.ts` = verify→commit gate). M1 (`6beb3dd`, PR #1) made `policy.ts` CaEndorsement-aware incl. `checkCaEndorsementAuthority` (NOW-clock + lease window). §12.1 downscopes to opt-in (default = app-direct-commit #32); NOT a launch blocker. *Remaining = governed/operator: deploy Worker + provision `GITHUB_MAINTAINERS_PAT` (post PR #1 merge). A flagship `.com` route would duplicate the upstream worker + contradict §12.1 — intentionally not built. |
| 30 | Track P 6 baked `MAINTAINER_GENESIS_PUBKEYS` + fail-closed link-1 | ✅ | `@flagship/protocol` `maintainerCa.ts`: empty baked const + `verifyCaSigned{DemoDirective,UserPubKeyBinding}` chokepoint, fail-closed `genesis-unconfigured` (chain port never consulted); injectable-genesis seam for #8/#9/#10; 9 tests. Flagship baseline now **2514** |
| 31 | Track P maintainers web-ui status/preview only | ⛔ | Upstream maintainers web-ui, **post PR #1 merge** (§5). NO signing view ever. Seam = ca-operations.md "Next upstream increment" (REPLACED by status/preview/commit-trigger-only per §10.1) — design complete; it's upstream-after-merge, not flagship code. |
| 32 | **Track P generic OSS maintainers NFC-tap app** | ⛔ | Largest: a NEW Android-first app, home **upstream `ibisllc/maintainers`**, review-only here (no JDK; cf. #33). Multi-week; **post PR #1 merge**. Seam = the complete §11+§12 design (per-repo profile, hardware-stored git cred, tap→PIV-Ed25519→app-direct-commit; PIV-Ed25519 == std Ed25519 ⇒ no protocol change). Not closeable at a CLI session tail. |
| 33 | Android real Gradle build (never-compiled drift) | ✅ | **DONE on this Linux box** (JDK17+SDK present — env delta §0). `7c37d5e` main-source `@Composable` fix → `assembleDebug` green; `d960691` 4 never-run test fixes → `testDebugUnitTest` **190/190, 0 fail**. Remaining for C-Android = the operator Play-upload gate (`§S:624`: signing + internal track + 5 testers), NOT a code/CLI item. |
| 34 | Triage `inheritance.ts` (v1-unwired vs v2-deferred) | ✅ | **Verdict: v2-deferred, deliberate seam.** Built+exported+unit-tested, not route/cron-wired, absent from §S + CLAUDE.md. Recorded in new `docs/policy/inheritance.md` (the decision record the module docstring already pointed at — was dangling). No v1 action. §0. |
| 35 | **Transition maintainers consumption: clone-SHA pull → adopter-friendly (MUST)** | ⛔ trigger-gated | The `scripts/maintainers.pinned-sha` + `pull-maintainers.sh` clone-at-build model is a **pre-1.0 dogfooding bootstrap ONLY**, not a distribution mechanism — a bespoke clone script is the opposite of the maintainers objective ("usable by others' projects easily"). **MUST transition when the spec is deemed mature = flagship↔maintainers co-development ends (expected SOON: primitives all coded, only e2e testing remains):** (a) `npm publish @maintainers/protocol` (semver, `--provenance`, lockfile/`npm ci` pinnable); (b) versioned spec + **published conformance test vectors** as the primary portable artifact (de-risks #9/#10 + every non-TS adopter) — these vectors **MUST include the mandatory fail-closed negative cases** (absent genesis ⇒ reject; forked/unknown genesis ⇒ reject; endorsement gap / substituted intermediate ⇒ reject) so no port can pass conformance while silently weakening fail-closed; (c) flagship drops the pull-script and consumes the published package like any adopter (makes the dogfooding honest). Full rationale: `docs/maintainers-deployment.md` → "Adoption: the pull-script is a bootstrap, NOT the distribution" + "Threat model & applicability boundary" (maintainers propagates trust from a pinned root, never creates it; guarantee scales with the independent population that can detect divergence — for agreed-canonical-source projects). Do NOT let the pull-script ossify into the integration story. |

Maintainer→CA progress: **#11 push+PR ✅ → PR #1 merge (governed) ✅ →
re-pin `10c65aa` ✅ → #8 link-4 daemon ✅ → #28 AGENT-complete (keystone
+ signer threading + `ca-endorsement` command/store + `--dry-run` +
banner/confirm + native PC/SC) ✅ → PR #2 merge (Human Gate A,
governed) ✅ → re-pin `833fa45` + both gates green ✅** (2026-05-17
sessions 1–4). **The ONLY remaining Phase-1 item is Human Gate B**
(Operation 0 genesis with the real YubiKey → agent bakes
`MAINTAINER_GENESIS_PUBKEYS`, #30 flips live, re-run #8; deploy
nothing). **Phase 2 (#35 → #9 → #10) is now UNBLOCKED (does NOT need
Gate B)** — the agent build work is **#35 reshaped to the LOCKED
Phase-2 **v2** model** (`docs/v1-launch-program.md` "Phase-2 DESIGN
DECISION — LOCKED v2"; `SignedPolicy` is SUPERSEDED — there is no
separate policy artifact). The v2 redesign is the new #35 spine and
**PRECEDES Gate B** (Gate B freezes the pinned-mandate shape forever).
**Progress (2026-05-17 session 5): c2 LANDED + pushed** on
`feat/keyfile-register` (`5f3b146`) — the v2 protocol *core*, the
load-bearing trust path, landed additively (v1 fully intact): `MandateV2`
(inline succession policy: `approvalRule` threshold / `successors` /
`minSuccessors` / `maxDurationSeconds` / `defaultDurationSeconds` /
optional `project`), `canonicalMandateV2` (tag `maintainers/mandate/v2`,
fixed 15-slot, integer encoder) + `mandatePinHash` (sha256 of canonical
bytes — the #30-generalised baked value, content-bound), `signMandateV2`
(+`With`), and **`verifyMandateChainFromPin`** = L1 (pin IS the floor,
verify FORWARD, multi-pin, fail-closed on no-pin/pin-not-in-log) + L3
(ONE rule, no self-renewal) + `currentAuthorityV2`; TOTAL (never throws).
**21 new tests covering every fail-closed negative**; maintainers
**332/32** tsc-clean, flagship guard **2526/225** tsc-clean. **c3 (the
CLI verbs) then LANDED the same session — c3a `23a4d35` `create-key`
(KeyFile self-reg via the c1 seam; `--introduction-mandate`→nil-UUID;
`writeKeyFile`) + c3b `2fa2b0c` `upsert-mandate` (the ONE verb:
from-scratch ORIGIN \| succession; fail-closed pre-flight refuses
BEFORE any tap; single-signer scoped boundary; `readMandatesV2`/
`writeMandateV2`); maintainers 332→335→344/34; flagship guard
2526/225.** genesis/mandate/takeover remain (retired in c4.5). Branch
pushed, **NOT pinned** (pin stays `833fa45` until the governed merge).

**Progress (2026-05-17 session 6): c4.1 + c4.3 + c4.4 LANDED + pushed —
the entire flagship-side v2 migration.** c4.1 `6cfee83` (maintainers
branch): the v2 endorsement layer, strictly ADDITIVE
(`verifyChainOfEndorsementsV2`/`verifyCaEndorsementsV2`/
`authorizedCaKeysV2`; authority via `currentAuthorityV2` +
**holder-signs** — L2 dissolved `TrackPolicy.approvalRule`, the forced
consequence; reuses v1 result shapes); 27 tests; maintainers
**344→371/36**. c4.3 `5fb2fdf` (flagship): **#30 generalised** —
`MAINTAINER_GENESIS_PUBKEYS`→`MAINTAINER_PINNED_MANDATE_HASH`(""),
`maintainerPinConfigured`, reject `pin-unconfigured`,
param`pinnedMandateHash`; module stays `@maintainers/protocol`-free,
`CaTrustChain` iface UNCHANGED. c4.4 `ff8ce91` (flagship): **the LIVE
trust consumer migrated** — `server-daemon` `releaseVerifier.ts`+
`caTrustChain.ts` → `verifyMandateChainFromPin`/`currentAuthorityV2`/v2
endorsement layer + the v2 on-disk convention (no policy.json);
`pinnedMandateHash` opt (EMPTY baked default ⇒ fully fail-closed
pre-Gate-B); wire DTOs byte-stable; **flagship gate now a REAL v2
consumer check**, tsc clean + **vitest 2526→2529/225** (new honest
baseline). flagship no longer imports ANY v1 Mandate-path symbol.
(Plan correction: the old separate-additive-`Envelope`-rework "c4.2"
was deleted — that re-base folds into c4.5, atomic, no dual-version
collision.)

**Remaining v2 spine:** **c4.5 — the maintainers v1→v2 cutover, now
decomposed CONSUMER-FIRST (s7 verify-before-trust correction; the
"one atomic commit" call is SUPERSEDED — see §0 s7).** The full
inventory showed ~30 files across FIVE packages (incl. the forgotten
`extension`); a blind atomic rewrite of trust-verification code is
unsafe. v2 symbols already exist (additive), so each consumer is
re-based to v2 while v1 still coexists in protocol, each its OWN green
commit, and v1 is removed from protocol LAST:
- **c4.5a** worker (`cloudflare-worker` policy.ts/worker.ts +
  policy.test.ts/worker.test.ts) → v2 (verifyMandateChainFromPin /
  currentAuthorityV2 / holder-signs; Envelope handling tolerant of
  MandateV2 while v1 still present).
- **c4.5b** web-ui: re-base parse-folder/adapter/state to v2; **DELETE
  the v1 signing views** onboard/renew/takeover + the v1 signing
  builders in envelopes.ts (correct per #31 — NEVER a signing view;
  web-ui = status/preview only) + project.ts → v2; rewrite web-ui tests.
- **c4.5c** extension: verifier-logic.ts/fetcher.ts +
  tests/fixtures/build-fixture.ts + verifier-logic.test.ts → v2.
- **c4.5d** cli: DELETE commands/genesis|mandate|takeover (already
  superseded by upsert-mandate c3b) + their v1-only tests
  (envelopes.test.ts, dryrun v1 parts) + the index.ts wiring/re-exports;
  re-base verify.ts/caEndorsement.ts/lib/store.ts (readStore→v2-only;
  delete writeMandate v1/isMandate v1) to v2; fix caEndorsement.test.ts.
- **c4.5e (LAST — only when NO consumer imports v1):** remove the v1
  Mandate path from `@maintainers/protocol` — delete verifier.ts /
  endorsement.ts / caEndorsement.ts (v1); delete `canonicalMandate` +
  `signMandate`/`signMandateWith`; delete `Mandate`(v1)/`RootPolicy`/
  `TrackPolicy`/`ApprovalRule`(v1) from types.ts + narrow `Envelope` to
  `MandateV2|…`; **re-home the shared `VerifiedEndorsements`/
  `EndorsementFailReason`/`VerifiedCaEndorsements`/`DEFAULT_CLOCK_SKEW_MS`
  types into endorsementV2.ts/caEndorsementV2.ts** (they currently
  import them from the v1 files); KEEP `joinTagged` (used by 6 non-v1
  canonical fns); delete the v1-only protocol tests
  (verifier/checkpoint/endorsement/caEndorsement) + the v1 parts of
  canonical.test.ts/signing.test.ts/encryptedBlobAdapter.test.ts.
a–d are order-free + independent; **e MUST be last.** Each commit:
maintainers tsc -b + vitest green, flagship guard 2529/225 (it stays
green throughout — flagship already imports zero v1; from c4.4 it is a
REAL v2 consumer check). Push each to feat/keyfile-register.
→ **c4.6 de-version rename** (user decision s6 — "v2" is a transitional
dev artifact; the protocol is unreleased): drop the `V2` code-symbol
suffix everywhere + reset the Mandate envelope `version: 2→1` +
canonical tag `maintainers/mandate/v2→/v1` (keep a numeric wire version
— only Mandate ever carried the bogus v2). Coordinated flagship-consumer
rename (flagship gate a REAL consumer check). NOT a trust-model change.
Changes `mandatePinHash` — acceptable ONLY pre-pin (same window the v2
lock relied on) ⇒ MUST precede c4.7/c5/Gate B.
→ **c4.7** spec (authored DIRECTLY under the final name): rewrites §5.2
"the pin IS the floor"; dissolves policy.json/SignedPolicy; documents
L1/L2/L3 + mandatePinHash + the holder-signs endorsement model + the
from-scratch boundary + D3 unchanged) → **c5** published spec + static layout + `fetch()`
client + conformance vectors (ALL fail-closed negatives) → governed PR
(Human Gate, PR #1/#2 precedent) → re-pin → `npm publish` (Human Gate:
npm org/2FA) → flagship DROPS `pull-maintainers.sh`/
`maintainers.pinned-sha`. **THEN** Gate B (the first `upsert-mandate`,
its hash pinned) → #9 (webapp) → #10 (iOS Swift + Android Kotlin
reimpl, heaviest — sequence it) → Phase 3 cluster. c4.5a–e is the
security-critical cutover (consumer-first; e last) — START each
attentively, one tested green commit, **do NOT tail-bolt**.

## 4. Working discipline (non-negotiable — this is how the tree stayed clean)

- One logical change per commit, each individually tested. `npx tsc -b
  && npx vitest run` must stay green (**2526 baseline**) before every
  commit. Commit with `git commit -F -` (heredoc — NEVER `-m` with
  backticks/`$()`). No `Co-Authored-By` trailer. Push each tested
  commit to `origin/main`.
- After any backend change: deploy + live-smoke. `.com`:
  `cd apps/com && npx wrangler d1 execute flagship-state --file=… 
  --remote --yes` (migrations) then `npx wrangler deploy`. `.services`:
  `$HOME/.fly/bin/flyctl deploy --remote-only --strategy=immediate
  --yes -a flagship-services`. `.services` HTTP is on `:8443`, not :443.
- Keep `docs/plan-external-domains-and-demo.md` per-phase notes,
  `docs/build-tasks.md §S`, and THIS file current as you close items.
- Real-infra/governed/live-exercise items: build to the seam + tests +
  document the live step; don't bolt unverifiable changes into proven
  hot paths (cert plane, raw-TCP :443) at session tail.
- iOS verifiable here via xcodebuild+XCTest; Android review-only (no
  JDK — `/usr/bin/java` is the macOS stub); webapp = `node --check` +
  vitest served-asset tests.

## 5. Recommended next-session order (highest value, unblocked first)

> **2026-05-17: `docs/v1-launch-program.md` governs phase order** (the
> `/alpha` Phases 1-8). We are in **Phase 1**; **Phase-1 AGENT work +
> Human Gate A are BOTH COMPLETE.** Session 4: PR
> `ibisllc/maintainers#2` was merged by the maintainer (Gate A
> governed step) as `833fa45`; the agent re-pinned
> `scripts/maintainers.pinned-sha` `10c65aa`→`833fa45`, ran
> `pull-maintainers.sh`, and re-ran both gates green — **flagship
> `tsc -b` clean + `vitest run` 2526/225; maintainers (now AT THE PIN,
> baseline 257→307) `tsc -b` clean + `vitest run` 307/31** — commit
> `34b6cb5` pushed. web-ui byte-identical between pins ⇒ no Worker
> redeploy.
>
> **★ Immediate next thrust = the Phase-2 v2 protocol redesign
> (re-locked s4; it now PRECEDES Gate B).** Authoritative detail =
> `docs/v1-launch-program.md` "Phase-2 DESIGN DECISION — LOCKED v2".
> **Status (s6): c2+c3 (s5) AND c4.1+c4.3+c4.4 (s6) are LANDED +
> pushed.** maintainers `feat/keyfile-register` tip **`6cfee83`** (c4.1
> v2 endorsement layer, additive; maintainers **371/36**); flagship
> `main` tip **`ff8ce91`** (c4.3 `5fb2fdf` #30 generalised + c4.4
> `ff8ce91` LIVE consumer migrated — `releaseVerifier.ts`/
> `caTrustChain.ts` now verify-forward-from-pin; **flagship gate is a
> REAL v2 consumer check**, **2529/225** the new honest baseline).
> Branch NOT pinned (pin stays `833fa45` until the governed merge).
> genesis/mandate/takeover + the v1 Mandate path remain (retired in
> **c4.5e**). **c4.5a (worker) LANDED s7 `650fee2`; Next =
> c4.5b/c4.5c/c4.5d (order-free) → c4.5e LAST — each the next
> attentive START; do NOT tail-bolt.** c4.5 is CONSUMER-FIRST
> decomposed (s7
> verify-before-trust correction — the "one atomic commit" call is
> SUPERSEDED; the true blast radius is ~30 files / 5 packages incl.
> the forgotten `extension`; see §0 s7 + the §3-tail spine): each
> consumer re-based to v2 while v1 still coexists in protocol (each
> its own green commit), v1 removed from protocol LAST. Order:
> **c4.5a worker → c4.5b web-ui (delete the v1 signing views per #31)
> → c4.5c extension → c4.5d cli (delete genesis/mandate/takeover) →
> c4.5e protocol v1-removal (LAST; re-home the shared
> VerifiedEndorsements/EndorsementFailReason/VerifiedCaEndorsements
> types)**. a–d order-free; e strictly last. flagship guard 2529/225
> throughout (flagship already imports zero v1). → **c4.6
> de-version rename** (user decision s6 — "v2" is a transitional dev
> artifact; the protocol is UNRELEASED: drop the `V2` code-symbol
> suffix everywhere + Mandate envelope `version 2→1` + canonical tag
> `maintainers/mandate/v2→/v1`; keep a numeric wire version; NOT a
> trust-model change; coordinated flagship-consumer rename; MUST
> precede c4.7/c5/Gate B since it changes `mandatePinHash` — OK only
> pre-pin) → **c4.7** spec (authored directly under the final name) →
> **c5** (published spec + static layout + `fetch()`
> client + conformance vectors, ALL fail-closed negatives) → governed
> PR → re-pin → `npm publish` → flagship drops the pull-script.
> Build it upstream in `maintainers/` on `feat/keyfile-register` →
> governed PR → re-pin, **at a START, attentively — NOT a tail-bolt**
> (the verifier + Mandate canonical bytes are the load-bearing trust
> path). Full scope:
> Mandate **v2** canonical bytes with inline succession policy
> (`approvalRule` `threshold N of […]`, `successors`, `minSuccessors`,
> `maxDuration`, `defaultDuration`); the **L3 one-rule** verify-forward
> (no self-renewal; K+1 valid iff it satisfies K's embedded rule + K's
> constraints); the **L1 pinned-mandate anchor** (verify forward from
> any pinned mandate; multiple pins coexist; rewrites spec §5.2);
> `createKey` (KeyFile self-reg — `c1 dc48559` stays) + `upsertMandate`
> (the one verb; `genesis`/`mandate`/`takeover` collapse in); **#30
> generalised** to bake the pinned-mandate canonical hash; published
> v2 conformance vectors incl. ALL fail-closed negatives
> (absent/forked pin, pin-not-in-log, self-renewal-attempt,
> sub-threshold, under-minSuccessors, over-maxDuration, endorsement-gap,
> lapsed-lease-at-NOW, tampered history). One logical change per
> commit; maintainers tsc -b + suite green, then flagship gate as the
> guard (`@maintainers/protocol` is in flagship's graph), each commit.
> HUMAN GATES: governed PR merge (PR #1/#2 precedent) + `npm publish`
> (org/2FA; classifier may block — human runs the one command).
> **THEN Gate B** (the keystone, now downstream of the redesign): it
> stays TWO-PART — **(P)** human provisions `pcsclite`+`ykman`, on-token
> Ed25519 PIV slot 9c on BOTH YubiKeys (touch=always, PIN-once; PIN/PUK
> = §11.4 human knob), plug in, set the create-time policy (`threshold`,
> `minSuccessors`, `maxDuration`); **(A)** agent implements +
> LIVE-verifies `connectPcscChannel`'s libpcsclite wiring behind the
> tested seam (non-destructive pubkey read FIRST; NEVER written blind;
> the no-hardware-assumptions UX bar — see
> [[feedback-no-hardware-assumptions]]) → `--dry-run` → human signs the
> **from-scratch `upsertMandate`** (typed confirm + PIN + tap) → agent
> verifies the chain + bakes the **pinned-mandate hash** (#30, per
> surface; record the exact value) + re-runs #8. Deploy nothing.
> `file:` NOT acceptable for the root. **HUMAN GATE — stop with the
> crisp provisioning ask; never fabricate the pinned mandate / never
> write the binding blind.** Then #9 webapp → #10 mobile (re-verify
> against the published v2 vectors).

**Resume #2 2026-05-16 (Linux box) closed #33 (real Gradle build +
190 unit tests green; 2 latent-drift fixes), #34 (triaged →
v2-deferred), #3 (flake triaged + corroborated), #4 (GOVERNED PR #1
merged by the maintainer + re-pinned `10c65aa`), and #8 (link-4
daemon port built+tested). Prior resume: #11/#30/#24/#25/#20/#15/#29.
Net: flagship 2526/2526 (incl. the user's own `/alpha` commit),
Android 190/190, all pushed.** Next
session, in order:

1. **Define the upstream on-disk CaEndorsement store convention.**
   This is the real gap surfaced this resume (§0): the maintainers
   store reader knows only `endorsements/` = `ReleaseEndorsement`;
   there is no directory/spec for CaEndorsements. It is upstream
   `ibisllc/maintainers` work (spec §3.7 + `cli/src/lib/store.ts` +
   the protocol's `verifyCaEndorsements`). It unblocks #9 + #10 and
   makes #8's injected-arg seam loadable from disk. Sequence it with
   #31 (upstream web-ui) post-merge.
2. **#9 (webapp) → #10 (iOS/Android)** link-4 — only AFTER step 1.
   #9 = the #8 adapter shape in `apps/web` + a bundled browser
   verifier. #10 = a Swift+Kotlin reimplementation of the TS-only
   maintainers verify (`verifyTrack`/`verifyCaEndorsements`/
   `authorizedCaKeys`) — the heaviest, security-critical; NOT a
   1-liner, do not bolt at a session tail. (#8 is the done reference
   implementation: `caTrustChain.ts`.)
3. **#27/#28/#31/#32** the maintainer→CA ceremony build — upstream
   `ibisllc/maintainers`. #28 is security-critical (rotate-ca) +
   needs a real YubiKey; #27 genesis run is human; #32 is a
   multi-week new app. Design 100% in maintainer-ca §9–§12 +
   ca-operations.md. #30 baked-genesis flips #8's port live.
4. ⛔ real-infra/live-device backlog (#16-row items: C4.1c live cert
   exercise, lazy-SNI socket wiring, B-A2/B-A3, C-A1, Forgejo/LLM,
   the joint sibling-supervisor runtime instantiation) — only when
   the device/infra is available; each documented to the seam. Note:
   on a Linux box iOS xcodebuild is unavailable (#7/#79A/iOS-port
   verification is review-only here); Android is now the
   CLI-verifiable mobile target.
5. If the flake (§0 #3) recurs: follow the §0 watch procedure
   (`--reporter=verbose`, then pin/raise that *specific* spec) —
   do NOT blanket-retry or guess-pin.
