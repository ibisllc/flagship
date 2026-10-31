# Flagship 0.3 mega release: release-manager journal

**If you are a new session taking over: read this whole file, then continue the "Plan" from the first
unchecked item.** Update this file as you go: tick items, add a dated line to the "Log", and commit it
(explicit path, `git add RELEASE-0.3-JOURNAL.md`) on `release/0.3`, pushing each time. When the
release lands on `main`, fold what is still true into `AGENTS.md` "Current status" and delete this file.

Owner: Harry (they/them in writing). Budget is limited: don't regenerate things that exist, don't
re-run long suites without a reason, ask before buying or publishing anything.

## What the release is

One linear history: `main` → the isolated 0.3 security commit `cc5425c8a` → UX's 139 commits (first
contact on web/Android/iOS) → the Architecture work (138 commits replayed, then the "Integrate" commit
`ced988cfe`) → follow-up commits listed in the Log. It ships everything: 0.3 hardening, UX, arch-v2
(Rust keyd/broker/core, Podman), milestones 7 (WASI, app groups, per-app databases, GPU G01–G05,
AI01/AI02 local AI) and 8 (V01 adversarial suite + assessment package, V02 canary).

## Where things are

- Worktree: `/Users/harrywinner/flagship-0.3`, branch **`release/0.3`** (pushed to origin). All
  release work happens here. The main checkout `/Users/harrywinner/flagship` is on `main`; don't build there.
- Since 2026-10-25 the only branches are `main`, `release/0.3`, `gym`, `hof-jay`, the unlaunched
  feature branches, `ux-{marketplace,custom-names,custom-domains,outbound-proxy}` (UX's newer copies, to
  fold in when those features are rebased), `device-results/windows-2026-10-17`,
  `wip/coordination-2026-10-16`. Everything else (integrate/*, feat/UX, feat/architecture, every
  backup/*, agent and wip branches, worktree WIP) is archived on origin under
  `refs/archive/2026-10-25/` and listed in `docs/archive/branch-cleanup-2026-10-25.md`.
- Arch handover detail: `docs/architecture-v2/HANDOVER.md`, `docs/architecture-v2/IMPLEMENTATION-PLAN.md`.
  Security plan: `SECURITY-HARDENING-PLAN.md`, progress `SECURITY-0.3-PROGRESS.md`.
- Scratch logs (may vanish on reboot): `/private/tmp/claude-501/-Users-harrywinner-flagship/bf7d42bb-5736-4a9a-83e8-bcfb63f1f061/scratchpad/`.
  Full-VM results persist in `gym-results/full-test-*`.

## Owner decisions (binding)

1. Ship everything now; build all code and test it in gyms. Tests needing unpurchased hardware
   (AMD/Intel/MIG/multi-GPU) may come after the release.
2. New-box stack: the **release gym decides** (`release/box-release.json` `newBoxStack`, set with
   `node scripts/set-new-box-stack.mjs arch-v2|classic`). Every 0.3 security finding must hold on the
   Rust stack too.
3. History linear on `cc5425c8a`; no merge commits of the feature lines; old tips stay as `backup/*`.
4. Name-dibs window opens on release day (`release.sh` asks, sets `DIBS_WINDOW_START/END`, 6 months).
5. Policed app browser ships ON only if the gym's browser group is green
   (`node scripts/set-app-browser.mjs true|false`). Redirects leaving the manifest list are allowed when
   the start URL was approved; local/metadata/Flagship-control destinations always refused; other
   people's public Flagship apps reachable like any public site.
6. Older, still in force: chat to `app.user` (no `.com` lead lookup); per-server `*.<user>` cert grant;
   first contact = pin on first sight + enrollment secret + 6-digit code; `slug--author` labels; the
   webapp is co-equal; passkey recovery check; passphrase min 8 with "Longer is stronger…"; N11 origin
   generations; TOTP never replaces a passphrase.

## Rules

- Commits: imperative subject, body says why, end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and the session line. No Codex trailer.
- zsh: write `${var}` before a `:` (`"${c}:refs/heads/x"`); `$c:r...` is a zsh modifier and silently breaks
  refspecs (it caused two failed pushes on 2026-10-25).
- Stage explicit paths. Subagents share the worktree and never run git; I stage their work.
- Every user-facing string goes through i18n: webapp `node scripts/i18n-pwa.mjs extract|build`;
  Android add to `i18n/android/en.json` then `node scripts/i18n-android.mjs build` (never edit
  strings.xml); iOS `String(localized:)` + harvest; box pages `scripts/i18n-box.mjs`. Gate: `npm run i18n`.
- AI never learns who/where the owner is (`buildModelRedactor`). Never tear down `playstore-test-0725`.
  Never bulk-wipe accounts. Only `main` is deployed. Owner-only secrets/keys/YubiKey steps: ask, don't do.
- Webapp shell is **v184** (minimumSecurity 176); bump on any webapp change and move test pins.
- D1 migrations on this line: 0110–0119 (0114–0118 = arch's renumbered, 0119 update receipts).

## Commands

- Typecheck/tests: `npx tsc -b`, `npx vitest run`, `npm run i18n`, `npm run parity`, `npm run ready`.
- Full suite on a throwaway UpCloud VM (~1 h, deletes itself):
  `bash scripts/full-test-vm.sh --commit <sha>` (token `~/.config/flagship/upcloud-token`; logs in
  `gym-results/full-test-<stamp>/`). crypto-graph fails by design (known Q05/Q08/Q09 classical bypasses).
- CI: runs on every push to `main`/`release/**` (so on release/0.3); to rerun by hand:
  `gh workflow run ci.yml --ref release/0.3` and `rust.yml`.
- Release gym (two passes, arch-v2 then classic): `bash scripts/gym-release-run.sh`. Exit 0 green,
  3 skips, 4 lock held, 5 arch-v2 failed but classic green (→ set classic), 6 only browser-grants failed
  (→ app browser off).
- Release: `bash scripts/release.sh --list`, then `--phase A`, `--phase B` (36 steps, prompts before each
  outward step).
- Android Gradle needs `JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`.
  iOS: project `apps/mobile/ios/App/FlagshipApp.xcodeproj`, scheme `FlagshipApp`, Xcode RC at
  `/Applications/Xcode-27.1.0-Release.Candidate.app`. Disk is tight: clear DerivedData first.

## Mandate (Harry, 2026-10-25) — read this first

"Resume the 0.3 release" means: continue this plan from the first unchecked box, to the very end,
without asking unless a step is marked OWNER. The release ships everything already on release/0.3
PLUS phone USB burn and data sovereignty (box AND phone side: basic offline control of your own box
over the LAN, stopping short of bypassing the Flagship ecosystem — no self-hosted control plane, no
account creation/recovery/transfer offline, boot unlock still via .com), then acceptance with a
heavy security focus on everything new, then the four release stages, until the apps are live in
the stores with new graphics, texts and descriptions of the whole range of improvements, and the
website is updated. Record every step in this file's Log as you go (commit + push it each time).
Also in 0.3 (owner, 2026-10-30): the Rust migration and verifiable runtime distribution, plan section G and Appendix G
Also in 0.3 (owner, 2026-10-30): phone and box TLS, phone-endpoint routing, box offline grace and malicious-app namespace isolation,
plan section H and Appendices H and I (the former PHONE-AND-BOX-TLS-SPEC.md and CONTROL-ENDPOINT-IMPLEMENTATION-SPEC.md). A proposed design: nothing in it is built or validated yet.
(per-service certificates are retired, not built). Not in 0.3 (decided): outbound proxy (later, recommended free BYO-proxy), marketplace/payments,
custom names/domains, retail, browser extension, other-OS installers, alpine, offline boot unlock /
own control plane (next release; notes in docs/data-sovereignty.md).

## Master plan (tick as done; add the commit/run id)

### A. Land the remaining code on release/0.3
- [x] A1 (`8b41f8ff6`; docs/boot-chain-refresh.md; drilled BIOS+UEFI, tools/boot-chain-drill) Boot-chain refresh (agent building it in the release worktree since 2026-10-25): review,
      commit by explicit paths. It lets 0.3 boxes take initramfs/unlock changes via updates.
- [x] A2 (`a03887d5c` incl. A3; branch deleted, tip archived under refs/archive/2026-10-25/landed/) Fast-forward release/0.3 onto feat/phone-usb-burn (13 commits, already on the tip; rebase
      it first if the release moved), delete the feat branch (archive ref first).
- [x] A3 (landed with A2; combined stack: tsc, 3,019 tests, i18n, parity green) Merge feat/data-sovereignty's box half (8 commits) the same way.
- [x] A4 (SECOND AGENT, 2026-10-25: iOS `89587cbfa`, Android `41ffca4ec` + leftovers in the next Log line, webapp vector port; shell **v182**; Android: 8 view-model unit tests, 6 mock-gym scenarios green on the emulator, PQ vectors ported; NOT run by me: iOS gym/VM tests, any physical phone; main agent to review) Build the sovereignty PHONE side (iOS reference, then Android; webapp gets only the
      vector ports — a browser can't do LAN rescue): Swift/Kotlin ports of rescue + keyfile v2 vectors;
      Bonjour (iOS NWBrowser, Info.plist NSBonjourServices `_flagship._tcp`) / Android NsdManager
      discovery by the opaque rescueDiscoveryId; key-bound TLS (trust the pinned box key, not DNS/CA);
      the rescue session (admin-signed, hybrid PQ signature so it works under the strict profile —
      add the PQ half to the rescue order on box + phones); "Rescue my data" (backup over LAN,
      progress, resume) and BASIC OFFLINE CONTROL over LAN-direct when .com/relay are unreachable:
      server status, apps list, start/stop/restart an app, restart/shut down the server, make and
      download a backup — every action an owner-signed order the box verifies, nothing that needs
      .com (no account changes, no device adds, no recovery). Settings entry always present; the
      account-gone screen's rescue button. Box fixes from docs/data-sovereignty.md §7 that the
      promise needs (restore treats a backup's apps as the new host's own; self-delete freshness;
      BoxReadToken timeout). i18n drafts in 6 languages; parity rows; mock-gym scenarios
      (found, not found, wrong key, expired cert, interrupted download resumes, offline controls).
- [x] A5 (SECOND AGENT, 2026-10-25; OWNER still does: OTG write on a real phone + stick, `publish-iso-seed.sh` in release phase A step 20, and the server-comes-online half stays with the live `luks-burn` lane) USB burn finish: seed rebuilt for the release's Debian pin (sha pin is 13.6.0; check
      FLAGSHIP_ISO_MANIFEST), seed publish path + FLAGSHIP_ISO_SEED wiring in release.sh, a QEMU gym
      lane (burned stick boots, installs from the signed artifact, comes online).

### B. Acceptance (security first)
- [~] B0 (SECOND AGENT, 2026-10-25: cause confirmed by reading the scripts and FIXED, see Log; still to confirm on a real box in the D2 live gym: the unlock log and lock-once marker appear on FLAGSHIP_BOOT after a reboot) Check on a real gym box (live gym or debug box) the premount bug the boot-chain agent
      suspects: FLAGSHIP_BOOT's early mount wrote no log until ext4 was preloaded (amd64) / busybox
      present (arm64), so the unlock log, the lock-once marker and the live owner-key read may never
      work on real boxes. If confirmed, fix in packages/boot-chain (ship via the refresh) and gym it.
      Also from A1: drill the full promotion on a real LUKS box with phone approval (live gym lane
      "boot-chain refresh across an update + reboot", D2).
- [x] B1 (SECOND AGENT, 2026-10-25; see Log: AT-RSC added, tag inventory fixed, one real flaw fixed; boot-chain refresh, USB seed, GPU approvals, stack switch, local AI and journal admin-only were already covered by their own refusal tests, which pass) Adversarial suite (tools/adversarial) extended for every new surface: rescue route + mDNS
      (no identity leak on the LAN, stranger can't open a session, replay, downgrade to classical
      under strict, cert-hash binding), offline-control orders (forged/stale/IRK on pinned box),
      boot-chain refresh (daemon-writable source refused, broken initrd falls back), USB seed
      (tampered seed/preseed refused, LUKS key per install), GPU approvals, stack switch, local AI,
      journal admin-only. Fix every finding; 0 it.fails.
- [~] B2 (SECOND AGENT, 2026-10-25: 4 fresh read-only reviewers by surface; the fixable findings are FIXED with tests, the rest are listed in the Log as OPEN for the main agent / owner) Independent security review pass by a fresh agent over the 0.3 diff since main (focus: new
      additions); fix findings; record them in SECURITY-0.3-PROGRESS.md.
- [x] B3 (SECOND AGENT, 2026-10-25) crypto-graph: add nodes for every new order (rescue session, offline orders); schema ok.

### C. Stage 1 — code tests on the frozen tip
- [ ] C1 `bash scripts/full-test-vm.sh --commit <tip>` all green except crypto-graph strict (known,
      until the PQ ceremony); CI + Rust CI green on release/0.3.
- [ ] C2 `npm run ready` (branch drift, tsc, vitest, e2e, parity) and the iOS string harvest.

### D. Stage 2 — gyms
- [ ] D1 Mock gyms on the frozen tip: web (`npm run gym:locked -- --surface web`), iOS, Android
      (one native build at a time); fix failures.
- [ ] D2 Live release gym (rebase `gym` onto release/0.3 first; load gym secrets; see Commands):
      act on its exit code — set newBoxStack (scripts/set-new-box-stack.mjs) and appBrowser
      (scripts/set-app-browser.mjs) and commit. Add live lanes: sovereignty (cut a box off .com,
      rescue + offline control over its private network, import into account B), local-ai, the M7
      drills (WASI, app groups, dedicated DBs, GPU sim), stack switch classic→arch-v2, boot-chain
      refresh across an update + reboot.
- [ ] D3 Live gym green twice in a row; record run ids.

### E. Stage 3 — hardware (OWNER hands; I prepare checklists and drive what I can)
- [x] E1 (SECOND AGENT, 2026-10-25; the OWNER runs it before release phase A and fills its sign-off table) Write docs/runbooks/0.3-hardware-acceptance.md: iPhone + Android dev builds (pair, unlock,
      offline control + rescue on home Wi-Fi with internet cut, GPU card read-only, local AI CPU),
      USB burn from a real Android phone to a stick + metal boot, Mac Studio hosting, Windows/Linux
      Studio (device-test agent runbook), Watch/Wear basics. Ask Harry to run it; record results.

### F. Stage 4 — deploy (a script Harry runs) and launch
- [x] F1 (SECOND AGENT, 2026-10-25; re-read before merging, the OPEN list is the owner's) Update AGENTS.md "Current status" + SECURITY-0.3-PROGRESS.md for the merged release; the
      branch list (USB burn and sovereignty now in; marketplace family etc. still branches).
- [x] F2 (SECOND AGENT, 2026-10-25: the script already found migrations from the ledger and knew the secrets; added the USB seed to step 20; `--dry-run --phase A` lists clean; docs/runbooks/0.3-deploy-sheet.md written; phase B dry-run not re-run) scripts/release.sh updated for everything new (migrations 0110-0119+, secrets, seed,
      boot-chain refresh, rescue, PINS re-pin, box artifact + endorsement, appliances, Studios,
      stores, website); `--dry-run` clean; docs/runbooks/0.3-deploy-sheet.md (what Harry needs ready:
      YubiKeys, PQ ceremony 2c, catalog keys 2b, secrets list, store accounts).
- [ ] F3 (texts done `68b32b475`: store/listings/<lang>.json + scripts/store-assets/listings.mjs; screenshots still to do) Store assets: REAL native screenshots (iOS/Android gym captures, 7 languages, every device
      class) via the store/ pipeline (no webapp stand-ins), new feature graphic, new App Store / Play
      texts and "What's new" covering the whole 0.3 range, in 7 languages; contact sheet for Harry.
- [x] F4 (`68b32b475`: blog/flagship-0-3, landing/FAQ/help/security/how-it-works, 7 languages; deploys with .com) Website: landing + features + security + /studio + release notes/changelog for 0.3, pricing
      unchanged (free), i18n built; deployed with .com.
- [~] F4b (SECOND AGENT, 2026-10-25: `offline-control` and `version` markers RESOLVED; left for the verdicts/owner: usb-burn, app-browser, new-box-stack, canary, findings, pubDate, and the other items below) Before launch, resolve every `TODO-RM <tag>` in docs/release-notes/0.3.md,
      store/listings/*.json and apps/web/public (grep TODO-RM): offline-control (keep only if A4
      landed, and the strict-PQ caveat is gone), usb-burn (seed published + hardware-tested),
      app-browser (gym verdict), new-box-stack (gym verdict: "Podman + Rust", "own database server"
      are arch-v2 only), canary (catalog root pinned in the release run), findings wording, store
      name. Also fix what the texts agent flagged: landing "iOS soon / Android soon" (pinned by
      marketingPages.test.ts), security.html "a stolen server cannot self-unlock" vs opt-in
      Auto-unlock, Raspberry Pi answers say x86_64 only (arm64 appliances exist), docs/index.html
      "Phone pairing" section outdated, docs/data-sovereignty.md header still says parked; pick one
      word for "box" per language (glossary vs site) for the native reviewers.
- [~] F4c (SECOND AGENT, 2026-10-25: product 0.3 + Studio 0.3.0 done on every surface; the iOS version/build and Android versionCode are NOT touched: the OWNER types them at release step 2, because I can't see App Store Connect / Play and they must climb past what was uploaded) Bump the product version to 0.3: release/version.json then `node scripts/check-versions.mjs
      --write` (homepage badge, webapp, iOS, Android, Studios); store build numbers climb (iOS 1.1→
      next, Android versionCode > highest uploaded, Studio 0.3.0).
- [ ] F5 OWNER runs scripts/release.sh phases A and B (I watch logs, fix, re-run); merge release/0.3
      to main (fast-forward); canary; store submissions (iOS + watch, Android + Wear), Studios.
- [ ] F6 After launch: hall of fame (hof-jay), translation review request, hardware receipts, the
      weekly rate-limit check; rebase the feature branches onto main.

### G. Rust migration and verifiable runtime distribution (owner direction, 2026-10-30; part of 0.3, built in this order)
Owner: prefer Rust; never move existing Rust back to TypeScript; migrate for a concrete security, recovery or
performance benefit, not a line count. The requirements are in "Appendix G" below (the former
docs/rust-migration-todo.md, deleted when it was folded in here). Verify the implementer inventory on this branch
before ticking anything (done 2026-10-30: keyd, broker, tlsd/ingress, boot, GPU, WASI, relay codec/core exist in
`rust/crates`; `flagship-core` is 1.5k lines in shadow mode). Order: R1 and the runtime verification first; R2 before the
proxy/controller handover; R4's authority contract before any migrated effect goes live; R7 qualifies independently.
Keep the gateway route; `--host-uds=all` stays disabled. R5 (per-service certificates in keyd) is NOT in 0.3: the owner
agreed on 2026-10-30 that per-service certificates are retired (apps are served under the per-user wildcard).
- [~] G1 (2026-10-30: BUILT and unit-tested, NOT yet proven on a real box: `rust/crates/flagship-updater` verifier/extractor/intent/switch/restore/guard, 70 tests; broker + privd release op run it with the shell scripts as fallback; artifact builds + pins it; the update guard hands over to a pin-checked /usr/local/sbin/flagship-updater; proof comes with the next gym artifact: the `update` group, one-list restart) Independent updater, rollback and recovery supervisor in Rust (staged version dir, atomic switch, health check,
      recovery without Node, persisted update intent, schema-compatible rollback, never roll back keys/revocation/security floors).
- [~] G2 (2026-10-30: lock `release/runtime-lock.json` (Node 24.22.1, real digests, signer key by fingerprint), `flagship-updater runtime verify|install|status` with digest-keyed offline cache, proven live against nodejs.org and against Node's real PGP signature; the artifact install refuses a bundled Node that is not the lock's binary. STILL TO DO: the Flagship-signed manifest at flagshipserver.com/runtime (+ freshness/sequence/revocation), the owner-facing verification view in the apps, wiring `runtime install` into activation if/when Node leaves the artifact, the CI check that the lock and node-pins agree) Runtime lock + verifiable runtime distribution: version-controlled lock (exact Node patch version, per-target
      URL, size, SHA-256, executable digest), signed runtime manifest on flagshipserver.com bound into the endorsed release,
      official-upstream download with the signed SHASUMS256 check, safe extraction, activation through G1, owner-facing
      verification view, the adversarial tests listed in Appendix G section 3.
- [ ] G3 (R2) App reconciliation and runtime ownership in Rust core (reconciler, endpoint table, address pool, scheduling,
      container and local-AI lifecycle; desired state persisted; adopt on restart; one writer; shadow mode performs no effects).
- [ ] G4 (R3) Reverse proxy and streaming transport in the Rust ingress (bounded, backpressure, SSE/WebSocket/uploads, pins/SNI/ALPN).
- [ ] G5 (R4) Authoritative access enforcement and journal at the effect boundary in Rust (shared conformance vectors first).
- [ ] G6 (R6) Constrained backup/restore/migration effects behind keyd/broker (scoped paths, safe extraction).
- [ ] G7 (R7; 2026-10-30 read: `flagship-relay` is a library plus the wiring, 5.4k lines, NOT a running service; the doc `relay-transport.md` section 3 lists what is lacking before it can replace the TS hub: the real `HelloAuthority` (cert ids, RootEntitlement under admin root or IRK, ServiceEntitlement, STK lookup and binding, HELLO signature, ServiceGrants, revocation: needs the entitlement canonical forms in Rust plus `.com` lookups), the outbound relay (AI provider calls go through it: disabled today), eviction, blessing, peer-backup mailboxes, custom-domain pull, the gossip HTTP surface, `/api/health`+stats, the Fly image and a gym canary with mixed-version boxes. The allocator now carries the same own-zone claim fix as the TS hub) Qualify and activate the existing Rust relay (replacement rollout, mixed-version compatibility, rollback).
- [ ] G8 (R8) Consolidate the existing Rust boundaries on amd64 and arm64; remove obsolete TS/Go/shell alternatives only after
      the upgrade/recovery paths are proven.
- [ ] G9 (§2, §4) Retained-TypeScript hardening and inspectable/owner-built releases: execution-surface inventory, one
      qualified Node, frozen locks, unprivileged runtime, SBOM/provenance, isolated owner builds, reproducible-build comparisons.
- [ ] G10 (§5) Completion evidence: startup/CPU/RSS/throughput/p95-p99 benchmarks on amd64 and arm64, shared vectors,
      fuzzing, crash/power-loss, mixed-version and install/update/rollback tests, unsafe/FFI audit, production qualification.

### H. Phone and box TLS, phone routing, offline grace, namespace isolation (owner direction, 2026-10-30; part of 0.3)
Requirements are in "Appendix H" and "Appendix I" below (the former PHONE-AND-BOX-TLS-SPEC.md and CONTROL-ENDPOINT-IMPLEMENTATION-SPEC.md, removed from the working tree when folded in).
It is a PROPOSED design: nothing is implemented, deployed or security-validated. Phone isolation may not be claimed until H1, H2
and H5 pass their adversarial scenarios through the real harness, issuance service and relay. Verified against the current code
2026-10-30 (cert finding): a box cert today carries SANs `<server>.<user>`, `*.<server>.<user>`, `*.<user>` with the box's own key,
which matches the spec's box row; the bare `<user>` name is not issued to anyone yet. Per-service certificates stay retired (G).
- [ ] H1 Trusted issuance service on `.com`: authenticate the device and its current grant, derive the exact order identifiers from
      authorization, verify the CSR and names, own the ACME order lifecycle with service-held credentials (boxes lose arbitrary
      access to the shared account-zone DNS-01 writer), publish only that order's challenge, verify the certificate before delivery,
      refuse every box request for the bare user name (also mixed orders). Inventory existing certificates and prior ACME
      authorizations first and decide how residual authority is closed (Appendix H, "Issuance boundary").
- [ ] H2 Phone certificate for the bare `<user>.flagship.services` (one private key per phone, never uploaded) and the box wildcard
      row; phone-side TLS termination; keep the bare name (NOT `admin.<user>`, which every box wildcard covers).
- [ ] H3 Phone routing through the relay (TS hub and the Rust relay, G7): signed claim bound to account, phone identity, hostname,
      session, freshness and a short lease; only an authorized admin phone; one holder at a time with relay-issued generations;
      handover on explicit foreground acquisition; old connections stay; fail closed, never fall back to a box; exclusivity across
      relay instances. Decide lease durations, replay protection, acquisition ordering, deadlines and revocation propagation first.
- [ ] H4 Box offline grace (Appendix I): the owner chooses 7 days, 30 days or indefinitely at server creation; the phone re-signs about
      daily a permission/app-serving lease (account, box identity and registration generation, policy generation, route and
      certificate scope, times, unique id; indefinite is an explicit representation) via a narrowly delegated renewal key that
      cannot add boxes, widen scope, extend past the grace, alter policy or undo revocation, and never bypasses the admin-root
      biometric. The RELAY enforces expiry: stops admitting app streams, closes them within 5 s, leaves failover sets; the box's
      exact control name stays routable and certifiable (recovery) until explicit revocation. Boxes renew their own certificates
      only near expiry; the issuance service refuses early orders and orders without a valid permission. Show the real next expiry
      and warn before it.
- [ ] H8 Central status assertion and fail-closed revocation (Appendix I section 3-4): short-lived (<=60 s, refreshed every 20 s,
      pushed on revoke) signed status per box with a monotonic revision; relays route only with a fresh unrevoked assertion;
      revocation commits atomically before the admin sees success, terminates the whole tunnel, and is externally observable
      within 65 s; the existing fail-open revocation list cannot be the only mechanism; per-stream route class and deadline.
- [ ] H9 Separate control and app certificates (Appendix I section 2, 5-6): control cert exactly the control name, app cert an
      approved subset of the wildcards, phone cert exactly the bare name; service-owned ACME account, DNS-01 performed centrally,
      apex CAA `issue`/`issuewild` pinned to the service account with `validationmethods=dns-01` (zero per-account CAA), reserve
      control names in the route allocator, migrate existing combined certificates and reusable ACME authorizations first.
- [ ] H5 Malicious-app namespace isolation: app identity and hostnames bound to the trusted installation record, caller derived from
      the harness boundary (not headers or the manifest), no app access to keyd, issuance or relay-claim credentials; host-only
      `__Host-` cookies, exact origin checks, CSRF protection and no sibling CORS for phone-endpoint operations. Pairs with G3/G5.
- [ ] H6 The eleven acceptance scenarios of Appendix H and the ten recovery/revocation scenarios and malicious-app tests of Appendix I as gym groups (negative isolation, relay multi-instance, lease expiry with a
      still-valid certificate, renewal policy, sibling-app web attacks), run through the real harness, issuance service and relay.
- [ ] H7 CA limits: reuse each phone's valid certificate (no issuance per handover); schedule renewals within the issuance limits.

### Appendix G. Rust migration and verifiable runtime distribution: requirements (folded in from docs/rust-migration-todo.md, 2026-10-30)

Owner direction, 2026-10-30: prefer Rust; do not move existing Rust back to TypeScript. Migrate for a concrete security,
recovery or performance benefit, not a line-count target. This is an implementation list, not evidence of shipped
capabilities. Basis: docs/architecture-v2/IMPLEMENTATION-PLAN.md sections 4.1-4.3 (ownership/IPC), 5 (Rust migration and
benchmarks), 6 (key custody and ingress), 11 (relay) and 12 (packaging/rollback).

Owner direction, 2026-10-30: prefer Rust; do not move existing Rust back to
TypeScript. Migrate for a concrete security, recovery or performance benefit,
not a line-count target. This is an implementation TODO, not evidence of shipped
capabilities. Current open-work status remains in `AGENTS.md`.

#### 1. Additional Rust work, in priority order

The implementer's inventory reports keyd, broker, TLS ingress, boot, GPU and WASI
already implemented in Rust, and a Rust relay awaiting production activation.
Verify that inventory in the implementation branch before marking anything done;
those implementations are not present in this main checkout.

- [ ] **R1 — Independent updater, rollback and recovery supervisor.** Move the
  platform update consumer and guard into Rust. Verify release authority, source
  revision, artifact digests, platform compatibility and security floors before
  activation. Stage a complete version separately, atomically switch, health-check
  and recover without needing Node or a working new daemon. Persist update intent
  and survive power loss at each stage. Database/schema compatibility is part of
  rollback; switching executables alone is insufficient. Do not roll back keys,
  revocation epochs or minimum-security state with app data. Starting points:
  `packages/server-daemon/src/updateConsumer.ts` and `updateGuard.ts`.
- [ ] **R2 — App reconciliation and runtime ownership.** Move the app reconciler,
  endpoint table, address pool, resource scheduling and container lifecycle into
  Rust core. Include local-AI container lifecycle, not its chat/provider business
  logic. Persist desired state and operation outcomes. Adopt running workloads
  after restart; use one writer per resource, fencing and idempotent operations.
  Shadow evaluation must perform no effects. Prove handover and recovery without
  duplicate launches, lost volumes or two active controllers.
- [ ] **R3 — Reverse proxy and streaming transport.** Move remaining per-request
  proxying, WebSockets and streaming into the Rust ingress/transport layer. Bound
  connections, queues, body/header sizes, tasks and deadlines; enforce backpressure,
  cancellation and fairness. Preserve HTTP, SSE, uploads, pins, SNI, ALPN and app
  routing behavior. Keep unprivileged product handlers behind authenticated local
  IPC; ingress must not become a general host-control process.
- [ ] **R4 — Authoritative access enforcement and journal.** Establish shared
  conformance vectors first, then move authority verification, replay protection,
  revocation checks and durable access-journal transitions into Rust at the effect
  boundary. Preserve per-app identities and existing admin/rank rules. A TS caller
  cannot grant itself authority or bypass enforcement. Migrate relevant gossip/
  sync validation and state transitions with this owner; leave message/workflow
  orchestration in its existing language where it adds no authority. Inventory
  remote APIs too: local IPC checks cannot repair authorization omitted upstream.
- [ ] **R5 — Complete keyd support for per-service certificates.** Add key creation,
  CSR construction/signing and opaque key handles for authorized additional names.
  Independently validate name/delegation authority, generation, renewal and signing
  context; callers cannot request arbitrary names or a generic signing oracle.
  Exercise migrated apps under their old names. No daemon-held private-key escape
  hatch. Keep ACME networking outside keyd; do not move working Rust ACME code to TS.
  This is the previously deferred certificate feature, not permission to expand 0.3.
- [ ] **R6 — Constrained backup/restore/migration effects.** Put secret-key
  operations and privileged filesystem effects behind existing Rust keyd/broker
  boundaries. Scope volume/path access and defend archive extraction against path
  traversal, links and resource exhaustion. Keep the workflow in its current
  language. Move remaining bulk archive/crypto streaming only when profiling or
  isolation analysis establishes a benefit; use maintained crypto implementations.
- [ ] **R7 — Qualify and activate the existing Rust relay.** Treat this as a
  replacement rollout, not a new rewrite. Prove routing authorization, opaque box
  TLS, echo, quotas, outbound streams, mailbox behavior, bounded flow control,
  drain, mixed-version compatibility and reconnect behavior. Deploy from main
  after gym/canary qualification with a compatible rollback. Relay redundancy is
  separate; canonical broadcast addresses remain a separately deferred feature.
- [ ] **R8 — Consolidate existing Rust boundaries.** Qualify keyd, broker, ingress,
  boot, GPU and WASI on both architectures. Remove obsolete TS/Go/shell alternatives
  only after proving upgrade, recovery and compatibility paths. Never silently
  fall back to raw-key custody or weaker host isolation. Do not delete a necessary
  recovery path simply because it uses another language.

R1 and runtime verification are first. R2 precedes proxy/controller handover;
R4's authority contract must exist before migrated effects become active. R7 can
be qualified independently. Keep the gateway route and `--host-uds=all` disabled.

Basis: [architecture implementation plan](architecture-v2/IMPLEMENTATION-PLAN.md)
§§4.1–4.3 (ownership/IPC), 5 (Rust migration and benchmarks), 6 (key custody and
ingress), 11 (relay) and 12 (packaging/rollback); the implementer's inventory and
the owner's scope decisions in this discussion. Existing Rust is retained even
where a new implementation might otherwise reasonably have been TS.

#### 2. Retained TypeScript and runtime hardening

- [ ] Inventory all retained execution surfaces: box API/product workflows,
  AI/MCP/provider integrations, build tools, Workers, browser and gym. Record
  required authority, secret access, runtime owner and patch mechanism. No broad
  daemon rewrite; no Rust-to-TS migration. Workers/browser execution engines are
  platform-managed and cannot be pinned like the box's Node executable.
- [ ] Use one qualified Node.js runtime for retained box TS/JS unless a measured
  compatibility/security requirement justifies another. TS is normally compiled
  to JS and executed by Node; pin the TypeScript compiler separately. Do not
  introduce Bun, Deno or a runtime TS loader merely to call it a safer interpreter.
- [ ] Create a version-controlled runtime lock with exact patch version, OS,
  architecture, libc/ABI requirements, official versioned download URL, archive
  filename, byte size and SHA-256 for every supported target. Pin the extracted
  executable digest too. No `latest`, major-only ranges or host `PATH` discovery.
  Select actual versions and hashes during implementation from verified upstream
  releases; this TODO supplies no guessed release numbers or checksums.
- [ ] Select a security-supported release line; record upstream support end date,
  advisory review date, known applicable vulnerabilities and compatibility results.
  Maintain distinct recommended versions and minimum-security floors. Pinning is
  not perpetual approval: monitor advisories, qualify patch updates promptly and
  rotate pins through the authenticated release process.
- [ ] Pin compiler, package manager, dependencies and native addons with integrity
  metadata. Build with frozen locks; forbid fallback from a failed locked install
  to dependency re-resolution. Review necessary lifecycle scripts and run them
  only in an isolated build environment without production data or secrets.
- [ ] Run retained Node processes as unprivileged users with narrow IPC capabilities,
  filesystem/network access and resource limits. Sanitize environment, including
  loader/preload settings, and launch an absolute verified executable. The daemon
  cannot modify its runtime or approved code. Qualify `--jitless` where compatible
  with required hardening and performance; do not assume it is free or universal.
  Runtime permission switches supplement OS/process isolation, not replace it.

#### 3. Official binary download; Flagship-published checksum

The owner receives the pinned runtime binary from its official distributor,
not a Flagship-repacked opaque runtime. Flagship publishes the exact approved
checksum and release metadata at flagshipserver.com. This verifies approved bytes
and upstream origin; it does not prove correspondence between binary and source.

- [ ] Define a public, versioned runtime-manifest URL on `flagshipserver.com`
  (new endpoint/path to implement, not an existing service). Publish a readable
  page plus machine-readable signed metadata binding all runtime-lock fields,
  Flagship release, sequence/version, validity and security floor. Bind its digest
  into the endorsed release. The website serves metadata; it cannot mint new trust.
- [ ] Authenticate that metadata using the existing pinned maintainer trust and
  reviewed update/rotation mechanism, independent of the TLS connection to `.com`.
  Add rollback/freeze resistance and bounded offline behavior. Do not trust a new
  signing key fetched from the same page merely because the page supplied it.
- [ ] Download the exact archive directly from the official versioned upstream
  URL. Allow only reviewed upstream distribution/CDN redirects over HTTPS; refuse
  arbitrary redirect destinations and oversized/truncated downloads. Cache by
  digest. The user may manually supply the same official archive for offline use.
- [ ] For Node, verify upstream signed `SHASUMS256.txt` using independently
  provisioned approved Node release keys. Pin the keyring revision/fingerprints and
  define authenticated rotation/revocation; never blindly import a key shipped with
  the download. Confirm the exact archive filename and digest in the signed list.
- [ ] Hash the downloaded archive locally and require agreement among its SHA-256,
  the upstream signed checksum and the Flagship signed manifest. A discrepancy or
  unverifiable signature blocks the new installation and leaves the current
  healthy installation running. Never execute the candidate to identify its version
  before verification.
- [ ] Extract safely into a fresh version directory, rejecting escaping paths,
  unsafe links and special files. Validate required files, permissions and the
  executable digest, then run compatibility/health checks with reduced privileges.
  Activate through R1; protect the installed tree against daemon modification.
- [ ] Provide an owner-facing verification view: exact version/platform, official
  source link, expected checksum from flagshipserver.com, locally computed checksum,
  upstream-signature status, Flagship-signature status and active version. Publish
  reproducible CLI instructions for independent checking, not just a green badge.
- [ ] Test altered archives/metadata, substituted filenames, wrong architecture,
  malicious redirects, stale/replayed metadata, revoked keys, interrupted downloads,
  unsafe extraction, offline cached installs and failed activation. A healthy
  current installation must not stop merely because metadata fetching fails.

Official references: [Node binary verification](https://github.com/nodejs/node#verifying-binaries),
[Node release keys](https://github.com/nodejs/release-keys), and
[Node support policy](https://github.com/nodejs/Release#release-schedule).
An upstream runtime is still a compiled binary. Source verification is a separate
claim requiring a qualified reproducible build; checksums alone cannot provide it.

#### 4. Inspectable releases and owner-built artifacts

- [ ] Publish the exact source revision, dependency locks, toolchain identities,
  build recipe, SBOM and provenance alongside each Flagship release. Preserve
  inspectable TS sources and their relation to executed JS; do not obscure them
  inside a mandatory single opaque executable.
- [ ] Support owner builds in an isolated staging environment while the current
  installation runs. No live keys/data in builds; no in-place production rebuild.
  An unsuccessful build leaves the old installation intact. Use the same versioned
  installation and recovery mechanism for downloaded and locally built artifacts.
- [ ] Establish reproducible builds per platform for Flagship Rust and JS artifacts
  and publish independent digest comparisons. Record unresolved differences rather
  than claiming reproducibility. A locally built artifact matching the endorsed
  digest can use that endorsement; a differing artifact requires an explicit
  owner-authorized local-build policy and distinct provenance, never a forged or
  inferred upstream binary endorsement.
- [ ] Reconcile architecture plan §12.1 with this owner-build option and direct
  official-runtime downloads: the release unit binds the exact runtime digest,
  without requiring Flagship to redistribute its bytes. Builds stay isolated from
  the trusted live installation. Preserve existing phone authorization and recovery.

#### 5. Completion evidence

- [ ] Benchmark cold/warm startup by phase, idle/loaded CPU, total RSS, streaming
  throughput and p95/p99 latency on amd64 and arm64. Compare whole installations,
  including IPC overhead. The reported two-minute startup and 25% CPU target are
  inputs to investigate, not proven Rust gains.
- [ ] Run shared protocol/authority vectors, relevant existing tests, parser fuzzing,
  crash/power-loss recovery, mixed-version and real install/update/rollback tests.
  Audit unsafe/FFI use and dependency changes; Rust alone is not a security proof.
- [ ] Record production qualification before removing old implementations. Implement
  unlaunched application work on its feature branch; keep this design TODO on main.
  Update the single status entry in `AGENTS.md` as work lands.

### Appendix H. Phone and box TLS, routing and namespace isolation: requirements (folded in from PHONE-AND-BOX-TLS-SPEC.md, 2026-10-30)

Status: proposed design from the owner discussion, 2026-10-30. This standalone
spec records the agreed direction and remaining implementation decisions. It
does not claim implementation, deployment, or completed security validation.

### Purpose and trust model

Preserve canonical app URLs on boxes while providing a phone-only HTTPS endpoint
for interactive secret delivery, approvals, temporary sharing, and live sessions.
TLS terminates on the selected device; Fly forwards encrypted traffic.

Visitors and calling apps trust the hosting owner with plaintext delivered to
that owner's app. A deliberately modified host can serve different software or
lie about its app identity. TLS authenticates a hostname, not the executing code
or its author. Author-signed packages establish provenance, not proof that a
host actually executes those packages. Hardware-backed attestation is a possible
future enhancement, outside this spec.

This accepted trust does not excuse a malicious app escaping its sandbox or
tricking the legitimate harness into acting as another app. Nor does it grant
a box phone/admin authority. Boxes must not acquire account-management powers
or impersonate the phone endpoint through their delegated credentials.

### Certificate names

Each device generates and retains its own private TLS key. Phones do not share
one private key, and no private leaf key is uploaded to the issuance service.

| Endpoint | Permitted certificate names |
| --- | --- |
| Each authorized admin phone | `user.flagship.services` |
| Each authorized box | `box.user.flagship.services`, `*.box.user.flagship.services`, `*.user.flagship.services` |

The account wildcard preserves canonical names such as
`app-author.user.flagship.services`. It also covers sibling box names. This
account-wide box TLS authority is an explicit tradeoff: certificate possession
does not itself grant routing authority, but a compromised box that receives
traffic for a sibling name can authenticate that name.

`*.user.flagship.services` does not cover the bare `user.flagship.services`
name. That bare name is reserved for authorized admin phones.

#### Recommendation on `admin.user.flagship.services`

Do not use `admin.user.flagship.services` as the protected phone endpoint: it is
covered by every box's account wildcard. Adding this subdomain would weaken,
not strengthen, the intended certificate boundary. Keep the bare user name.

If a separately named admin endpoint becomes necessary, it needs a namespace
outside every box's allowed certificate names and issuance authority, or
independent authentication to a pinned phone key. A cosmetic subdomain is not
an additional authorization boundary. The bare user endpoint must still
authenticate callers and authorize each sensitive operation.

### Issuance boundary: required before claiming phone isolation

Wildcard exclusion at TLS verification is insufficient by itself. Both
`*.user.flagship.services` and `user.flagship.services` use the DNS-01 TXT name
`_acme-challenge.user.flagship.services`. A box allowed to publish arbitrary
challenge values there can request a certificate for the bare phone name.
Checking only the TXT record name, or enforcing policy only inside the box's
keyd, does not prevent this on a modified host.

The trusted issuance service must:

1. Authenticate the requesting device and verify its current authorization,
   binding account, device identity key, permitted names, and grant validity.
2. Own and control the ACME order lifecycle using service-controlled ACME
   credentials. Box-controlled ACME accounts must not retain arbitrary access
   to the shared account-zone DNS challenge writer.
3. Derive the exact permitted order identifiers from authorization, rather than
   trusting a device's description of its requested challenge.
4. Verify the CSR signature and exact requested names, bind the CSR/public key
   to this authorized request, and reject extra names or mismatched identifiers.
5. Publish only challenges belonging to that validated order, finalize only
   its approved CSR, and verify the resulting certificate before delivery.
6. Refuse every box request for the bare user name, including requests that
   combine it with otherwise allowed box or wildcard names.

The device supplies its CSR and receives the public certificate chain; its
private TLS key remains on the device. Local keyd restrictions remain useful
defense in depth, but the remote issuance service enforces the security boundary.

This design still trusts the DNS/issuance operator for ordinary Web PKI
authentication. Protecting secrets against a compromised operator requires
independently verified phone keys and application-level encryption or signing.
Browser verification code must itself come from a trusted source.

Before rollout, inventory existing certificates and prior issuance authority.
Closing the challenge endpoint does not invalidate certificates already issued
or necessarily eliminate previously validated ACME authorizations. Migration
must address that residual authority before advertising phone isolation.

### Phone routing through Fly

Reuse the existing device-requested relay routing model. The phone app being
actively used requests the bare user's route through its outbound tunnel.

- Only a currently authorized admin phone can claim `user.flagship.services`.
  A box is rejected independently of what certificates it presents.
- Each claim is signed and bound to the account, phone identity, hostname,
  tunnel/session, freshness information, and a short routing-lease expiry.
- One phone holds the route for new connections at a time. Multiple phones may
  hold valid certificates for the same hostname, with different private keys.
- Recommended handover: an explicit foreground acquisition supersedes the
  current holder using a relay-issued generation. Renewal extends the current
  holder's lease and cannot take ownership back after handover.
- Existing connections stay with the original phone until closed or expired;
  they are not transparently moved to another phone.
- Disconnect, expiry, or revocation releases the route. If no eligible phone is
  available, the relay fails closed and never falls back to a box.
- Foreground status is honest-client behaviour, not a remotely provable fact.
  The authorization boundary is admin-phone eligibility, not a claim of activity.

Specify lease durations, replay protection, simultaneous acquisition ordering,
cross-relay coordination, connection deadlines, and revocation propagation
before implementation. The exclusivity rule must hold across relay instances.

The hostname authenticates the account's phone endpoint, not a particular phone.
Operations requiring a specific phone bind the application session to its device
key. Reconnecting after handover requires fresh session authentication where
appropriate; do not copy phone private keys to preserve connections.

Phone hosting is an interactive facility, not an always-on availability promise.
Mobile OS suspension, network changes, and battery policies interrupt tunnels.
Fly remains in the network path, so the domain alone offers no latency guarantee.
Do not replace asynchronous encrypted delivery flows with a mandatory live phone
connection merely because this endpoint exists.

### Box offline grace and expiring authority

Server creation offers:

> Keep this server reachable without an admin phone for…
> 7 days / 30 days / Indefinitely (owner, 2026-10-30; supersedes "One week / One month")

This controls how long Flagship remote access continues without renewal from an
authorized admin phone. It does not power off the server or prevent a modified
host from serving through LAN access or unrelated infrastructure.

Use a signed serving/routing lease as the enforcement mechanism. Expiring only
the Let's Encrypt issuance grant is insufficient: an already-issued certificate
remains usable until its certificate expiry, subject to revocation handling.

- Bind the lease to the account, server identity key, allowed routing scope,
  issuance/expiry times, and a version or revocation generation.
- Renew while an eligible admin phone is available, according to the owner's
  selected maximum grace period. Any eligible admin phone may renew.
- Renew certificate-issuance authorization alongside the serving lease, with
  independent checks in the issuance service and relay.
- Relay expiry prevents new connections and closes existing connections by a
  documented deadline; an indefinite stream must not evade the offline limit.
- Revocation takes precedence over renewal and the indefinite option. A reused
  server name with a different identity key cannot inherit old authority.
- Indefinitely means no phone-contact deadline, not immunity to revocation or
  an infinite certificate lifetime.
- Show the actual next remote-access expiry and warn before it is reached.

Silent renewal must not bypass biometric protection of the admin root. If renewal
must work without reopening that root, use an explicitly authorized, constrained
renewal credential. It may renew only existing approved servers within the owner's
configured policy; it cannot add servers, widen names, change policy, or undo
revocation. Credential lifetime, storage, rotation, and revocation require design.

### Malicious-app namespace isolation

Bind app identity and allowed hostnames to the trusted installation record made
from the approved `flagship.json`. Do not treat an app-writable manifest, request
header, advertised app name, or self-reported caller identity as authority.

Derive the caller from the harness-controlled process/container boundary and
resolve its routes through trusted installation state. A legitimate identity or
namespace change requires a separate authorized update; runtime self-renaming
must not change ownership. Apps cannot access host management credentials,
keyd sockets, certificate issuance credentials, or relay claim credentials.

Browser-facing phone operations must also resist sibling-app attacks: use
host-only `__Host-` authentication cookies where cookies are used, exact origin
checks for sensitive HTTP/WebSocket operations, explicit CSRF protection, and
no broad sibling-origin CORS grants. Sibling subdomains can be same-site, so
SameSite cookies alone do not establish app isolation.

### Required acceptance scenarios

Run adversarial scenarios through the actual harness, isolation boundary,
issuance service, and relay where applicable, not only mocked policy functions.

1. App A attempts to claim app B's canonical and box-local hostnames. Both fail;
   legitimate traffic to A and B still reaches their respective installations.
2. A modifies its `flagship.json` after installation to name B. Routing identity
   remains unchanged, including after restart and reconciliation.
3. A forges `Host`, forwarded headers, app identifiers, and caller metadata to
   obtain B's traffic or authority. The harness rejects the impersonation.
4. A attempts direct access to management, signing, keyd, issuance, and relay
   claim interfaces. It cannot obtain another app's or the host's authority.
5. A box with a valid account-wildcard grant requests the bare user's certificate,
   including mixed-name orders and arbitrary DNS challenge values. Issuance fails.
6. The same box attempts to claim the bare user's relay route. Routing fails
   independently of certificate checks, including with a simulated valid cert.
7. Two admin phones acquire and hand over the route. New connections follow the
   accepted holder, old connections stay bound, and stale renewals cannot retake it.
8. Phone disconnection, suspension, lease expiry, replay, and revocation never
   route the bare user name to a box. Repeat across multiple relay instances.
9. A box's serving lease expires while its TLS certificate is still valid. Remote
   access ends within the specified deadline, including long-lived connections.
10. Renewal succeeds within policy; revoked credentials, widened scope, expired
    grants, and grants for a previous server identity are rejected.
11. A malicious sibling web app attempts cookie injection, CSRF, cross-origin
    reads, and WebSocket access against the phone endpoint. Sensitive operations
    remain protected.

### Readiness and remaining decisions

This is a reasonable security model for trusting hosting owners while isolating
ordinary apps and reserving the phone endpoint. It is not a completed security
assessment. Phone isolation is blocked on trusted ACME-order control, migration
of prior authority, independent relay authorization, and the adversarial tests.

Before shipping, decide the routing/connection deadlines, renewal credential
format, revocation propagation, (settled 2026-10-30: grace is 7 days / 30 days / indefinitely, see Appendix I), and certificate
renewal scheduling. Account for CA issuance limits: separate phone keys do not
avoid limits on repeated certificates with the same identifier set. Avoid issuing
a certificate for every routing handover; reuse each phone's valid certificate.

### Reference

[RFC 8555 §7.1.3](https://www.rfc-editor.org/rfc/rfc8555.html#section-7.1.3)
describes wildcard authorizations;
[§8.4](https://www.rfc-editor.org/rfc/rfc8555.html#section-8.4) describes DNS-01
challenge records. Together they explain why the wildcard and bare user name
share a challenge location and require order-aware issuance enforcement.

### Appendix I. Revocable box recovery endpoint, relay-enforced app lease, central status: requirements (folded in from CONTROL-ENDPOINT-IMPLEMENTATION-SPEC.md, 2026-10-30)

Owner decisions that shape it (2026-10-30): grace choices are **7 days, 30 days, indefinitely** (the word "month" is not used);
the phone's routing claim has no fixed expiry and is kept alive by liveness on the already-authenticated tunnel connection (no
per-beat signatures; about 2 minutes of silence ends routing; the beat carries the revocation sequence number); the dead-man is
enforced by the relay's lease and by the issuance service refusing orders (the box renews its own certificates only near expiry,
under the phone-signed permission); certificates keep normal lifetimes (relay enforcement, not certificate expiry, defines the app
deadline); the box's exact control name stays reachable and certifiable after the app lease lapses, until the owner revokes.
Proposed numeric deadlines below are defaults for implementation and review. Nothing in this appendix is built.

Status: proposed implementation contract, 2026-10-30. No implementation or
deployment is implied. This is a standalone spec; existing repository specs
are not amended. Numeric deadlines below are proposed defaults for implementation
and review, not claims about current behaviour.

#### 1. Required behaviour

A box retains remote access to its exact control hostname when its phone-renewed
app-serving lease expires. The owner can explicitly revoke the box at any time;
that removes all of its Flagship remote access, including recovery access.

The exception is exemption from phone-contact expiry, not exemption from owner
revocation, registration checks, relay authorization, or certificate policy.

| State | Exact control route | App routes | Control cert issuance | App cert issuance |
| --- | --- | --- | --- | --- |
| Registered, not revoked, app lease valid | Allowed | Within lease scope | Allowed | Within grant scope |
| Registered, not revoked, app lease expired | Allowed | Denied | Allowed | Denied |
| Explicitly revoked | Denied | Denied | Denied | Denied |
| Unknown identity or stale central authorization | Denied | Denied | Denied | Denied |

“Allowed” always requires proof of the corresponding device key and all normal
authentication checks. Recovery requests still require authenticated, authorized
callers; a public TLS endpoint does not make its management API public.

#### 2. Names and trust boundaries

For account `user` and registered box `server`:

- Control name: exactly `server.user.flagship.services`.
- Box-local apps: authorized names beneath `server.user.flagship.services`.
- Canonical apps: authorized names such as `app-author.user.flagship.services`.
- Phone name: exactly `user.flagship.services`; never available to boxes.

The control exception covers only the exact control name. It never grants
`*.server.user.flagship.services`, `*.user.flagship.services`, the phone name,
another box's name, or a custom domain. Reserve registered control names in the
route allocator so an app alias cannot collide with them.

Use separate control and app certificates, preferably with separate leaf keys:

| Certificate class | Allowed SANs |
| --- | --- |
| Box control | Exactly the registered control name |
| Box apps | Approved subset of `*.server.user.flagship.services` and `*.user.flagship.services`, requiring current app authority |
| Admin phone | Exactly `user.flagship.services`, requiring current admin-phone authority |

An account wildcard also covers sibling control names. It does not grant their
routes, and native management clients must continue verifying the intended box's
independently pinned identity. Ordinary browser Web PKI alone does not distinguish
two boxes that both possess account-wildcard certificates.

A modified server can serve arbitrary content at its control hostname. The
relay cannot inspect or restrict HTTP paths inside end-to-end TLS. The product
promise is removal of app-name routing, not proof that all app execution or
content delivery has stopped. LAN and unrelated external access are out of scope.

#### 3. Authority records

Implement equivalent typed records using the repository's canonical signing
conventions. Do not introduce a second account-admin trust root.

#### Box registration

Persist account identity, immutable box identity/public key, exact control name,
registration generation, and revocation status. Bind all grants and routes to
the immutable identity and generation, not merely the hostname.

Explicit revocation is terminal for that generation. Re-enrollment requires a
new owner-authorized generation; old credentials do not revive automatically.

#### Owner app-serving policy

The admin authorizes the box, app routing scope, certificate scope, policy
generation, and maximum offline grace. UI choices (owner, 2026-10-30) are 7 days, 30 days, or indefinitely. Explain that this governs app access;
recovery remains available until the box is revoked.

Reducing the grace period or scope advances the policy generation and invalidates
older broader leases. A delayed signed request cannot roll policy backward.

#### App-serving lease

Fields: version/purpose, account, box identity, registration generation, policy
generation, route scope, certificate scope, issued-at, expiry, unique lease ID,
and signature. Indefinite policy uses an explicit representation, not an
overflow-sized timestamp. It remains subject to revocation and central freshness.

Only an authorized admin or a narrowly delegated renewal key can renew. Renewal
keys cannot add boxes, broaden scope, extend beyond the selected grace, alter
policy, or reverse revocation. Bind their use to the current policy generation.
Do not silently unlock or bypass biometric protection of the admin root.

#### Central status assertion

The control plane provides the relay with an authenticated, short-lived status
assertion binding box identity, registration/policy generations, revocation
status, and a monotonically increasing status revision. Maximum lifetime: 60
seconds. Poll/refresh every 20 seconds and also push invalidations when possible.

This assertion is separate from the phone-renewed app lease. The phone may be
offline for weeks while the relay continues refreshing an unrevoked box's
central status. A control-plane outage can therefore interrupt recovery access;
that is the explicit cost of bounded revocation. Never claim unconditional
availability and bounded revocation simultaneously during a partition.

#### 4. Relay admission, routing, and termination

Reuse the existing authenticated tunnel and routing-request mechanisms, but
enforce authorization at route allocation and stream opening, not only HELLO.

For each request, validate the signed binding to the connected device identity,
registration generation, requested hostname, tunnel session, nonce/freshness,
and applicable lease. Reject malformed names rather than normalizing ambiguous
input into an authorized name.

Routing algorithm:

1. Require a fresh, unrevoked central status assertion for this identity.
2. If the requested name equals its registered control name, authorize a control
   route without requiring a phone-renewed app lease.
3. Otherwise require a valid app lease and a trusted installed-app route binding
   for that exact name. Wildcard certificate possession is not route authority.
4. Reject the bare phone name for every box, irrespective of certificates.
5. Reject routes belonging to a different box or account. Do not derive an app
   route from a control-name exception or fall back to a wildcard on denial.

Track route class, original SNI, identity/generations, and authorization deadline
on every forwarded stream. Shared tunnels can remain open for control traffic
after their app routes are removed.

On app lease expiry:

- Stop admitting app streams at the expiry deadline.
- Remove the box from canonical-app allocations and failover candidate sets.
- Close its existing app streams within five seconds.
- Preserve its exact control route and control streams if central status is fresh.
- Never redirect failed app traffic to the control name or the phone.

On explicit revocation:

- Atomically persist the revocation and advance the status revision before
  returning a successful response to the admin.
- Invalidate all routes, allocations, failover memberships, pending claims,
  and parked requests for that box; terminate its entire tunnel and all streams.
- Push to every relay instance. A relay that cannot receive the push loses its
  cached authorization at expiry and must fail closed.
- Require externally observable disconnection within 65 seconds of committed
  revocation: at most 60 seconds of cached status plus five seconds of shutdown.
- Reject reconnection and replay using old credentials or status assertions.

Use monotonic deadlines for cached lifetimes and resist clock rollback. Do not
extend a status assertion past its original expiry when fetching or forwarding
it. Freshness checks must never fail open for this decision. If the existing
revocation-list mechanism fails open on fetch failure, it cannot be the sole
enforcement mechanism for this contract.

Stream classification is based on TLS SNI, not inspection of encrypted HTTP.
A malicious peer can tunnel application content over an allowed control
connection; this is covered by the trust limitation in section 2. Legitimate
frontends must enforce Host/SNI and route bindings and avoid cross-origin
connection reuse bypassing the intended access checks.

#### 5. Trusted certificate issuance

The trusted issuance service (“H1” in the discussion) owns the ACME account and
order lifecycle for control, app, and phone certificates. Devices own leaf keys.
The control-name exception is a policy in this service, not permission for a box
to issue independently through its own ACME account.

Request contract: certificate class, device identity, registration generation,
CSR, applicable authority/grant, request ID, freshness, and device signature.
Derive permitted names from trusted state rather than accepting a request's SAN
list as authorization.

For every order:

1. Check current registration and revocation against authoritative state; fail
   closed when unavailable. Validate app/admin grants where required.
2. Verify the CSR signature, approved key parameters, and exact allowed SAN set.
   Reject additional identifiers, IP SANs, unrelated names, and mixed classes.
3. Create the ACME order under the service-owned account with those exact names.
4. Obtain and publish only the challenges from that order. Devices cannot submit
   arbitrary TXT values for account-zone challenges.
5. Recheck current authorization before challenge completion and finalization.
   If revocation wins an in-flight race and a certificate is nevertheless issued,
   enqueue its CA revocation and record the outcome; relay revocation still holds.
6. Verify the returned chain, SANs, public-key binding, and validity before
   returning the certificate to the requesting device.

Default to centrally performed DNS-01 for all three classes. The box need not
answer an ACME challenge through Fly. If a future deployment uses HTTP-01 or
TLS-ALPN-01 for control certificates, it must update CAA method restrictions
and preserve the same service-controlled order and authorization checks.

Control-only renewal is allowed when the app lease has expired, but is forbidden
after explicit revocation. App-certificate validity need not equal app-lease
validity: relay enforcement defines the app access deadline.

Rate-limit issuance per account/device and retain renewal state. Never create
a new certificate for each route claim, reconnect, or phone handover.

#### 6. CAA and DNS policy

Keep zero per-account/per-box CAA records. Publish an inherited apex policy for
both ordinary and wildcard issuance, pinned to the service-owned ACME account:

```text
flagship.services. CAA 0 issue "letsencrypt.org; accounturi=<service-account-uri>; validationmethods=dns-01"
flagship.services. CAA 0 issuewild "letsencrypt.org; accounturi=<service-account-uri>; validationmethods=dns-01"
```

These are templates, not deployable values. Verify actual CA support, the
production account URI, DNS inheritance, and any more-specific records before
deployment. Remove permissive alternative CAA entries that would authorize
issuance through other accounts. Account migration may temporarily authorize
two service-controlled accounts, never arbitrary box-controlled accounts.

CAA is an issuance backstop, not route authorization or revocation of existing
certificates. DNS administrators and the trusted issuance service retain Web PKI
authority; the phone's application-level identity checks remain necessary where
the threat model includes compromise of those operators.

#### 7. Recovery/control API

The legitimate frontend serves only authenticated recovery/management operations
at the control hostname. Keep ordinary app routing on app hostnames. Enforce
current admin authorization for changes; being able to connect is not permission
to change configuration, renew grants, or restore revoked authority.

Keep native client identity pinning independent of TLS. Browser management uses
host-only authentication cookies, exact Origin checks, CSRF protection, and
restricted WebSocket/CORS admission. Do not trust sibling subdomains merely
because they are same-site.

#### 8. Malicious-app tests

Use the actual harness and isolation boundary, not only mocked handlers. Install
apps A and B from approved manifests and verify legitimate access to both before
and after each attack.

- A edits its runtime `flagship.json` to B's name, then restarts. Its trusted
  installation identity and routes do not change.
- A forges Host/forwarded headers, caller metadata, routing requests, or namespace
  advertisements. It receives neither B's traffic nor B's authority.
- A requests the control route or bare phone route. Both are denied.
- A attempts access to management credentials, host/keyd sockets, certificate
  APIs, and relay signing interfaces. Privilege does not cross the app boundary.
- A attempts cross-origin management actions against the control/phone endpoints.
  Sensitive operations require the correct caller authorization.

#### 9. Acceptance tests for recovery and revocation

1. Expire a box's app lease while its certificates and tunnel remain valid.
   Canonical and box-local app routes stop; existing app streams close within
   five seconds; authenticated control access continues.
2. After expiry, request an exact control certificate successfully. Requests for
   either wildcard, extra SANs, another box, or the phone name fail.
3. Explicitly revoke an active box. Control and app access, including long-lived
   streams and every relay instance, terminate within 65 seconds. Test both push
   delivery and dropped pushes/partitioned relays.
4. Keep a revoked box's valid TLS certificate. Prove it cannot receive a new route
   or reconnect, and issuance/renewal is refused.
5. Replay prior status assertions, app leases, claims, and renewal credentials;
   try a reused hostname with a new key. None restores old authority.
6. Race revocation against certificate issuance and relay reconnect. No race
   permits access beyond the revocation deadline. Late-issued certificates enter
   the CA-revocation queue and are observable.
7. Disconnect the phone past the grace period while keeping the control plane
   available. Recovery continues. Separately stop central status refresh; both
   route classes fail closed when status expires.
8. Verify policy reductions, indefinite grants, clock rollback, restart, failover,
   and multi-relay cache expiry obey the same deadlines and generations.
9. A valid box-wildcard holder attempts bare-user issuance through arbitrary DNS
   challenges or mixed CSR/order names, then attempts a phone route. Issuance and
   routing independently reject it.
10. Verify the effective CAA policy and rejection of issuance from an unapproved
    ACME account in a controlled test zone. Do not consume production rate limits
    or temporarily weaken production CAA for testing.

#### 10. Migration and delivery requirements

- Inventory existing certs, ACME accounts/authorizations, DNS-writing endpoints,
  route caches, and clients before changing authority.
- Introduce separate control/app certificate storage and hostname selection;
  handle old combined certificates explicitly during migration.
- Deploy trusted issuance and verify renewals before enforcing account-pinned
  CAA. Remove arbitrary device-controlled DNS challenge publication.
- Address existing certificates and reusable ACME authorizations. Closing an
  endpoint does not retroactively remove either. Do not advertise the new phone
  isolation guarantee until residual authority is handled.
- Deploy route/status enforcement across all relays before exposing the grace
  setting. Old relays must not remain an authorization bypass.
- Make revocation, status-refresh failures, active route class, lease expiry,
  dropped streams, and certificate-revocation failures observable without logging
  secrets. Show the owner the app-access deadline and revoked/recovery-only state.
- Obtain targeted security review of issuance, relay revocation races, and app
  isolation. Do not equate passing unit tests with the end-to-end guarantee.

No existing server is made irrevocable. The final product promise is: app access
may expire without losing recovery access, but explicit owner revocation removes
all Flagship relay access within the documented deadline.

#### References

- [RFC 8659: CAA processing and inheritance](https://www.rfc-editor.org/rfc/rfc8659.html)
- [RFC 8657: ACME account and validation-method binding](https://www.rfc-editor.org/rfc/rfc8657.html)
- [RFC 8555: ACME](https://www.rfc-editor.org/rfc/rfc8555.html)

## Log

- 2026-10-30 G7 relay service BUILT (not yet deployed, not yet canaried): `flagship-relay` binary (`rust/crates/flagship-relay/src/bin/flagship-relay.rs`, env as the TS hub: PORT, TUNNEL_TCP_PORT, RELAY_ECHO_PORT, FLAGSHIP_SERVICES_APEX, FLAGSHIP_COM_BASE_URL, SERVICES_CONTROL_SECRET, FLAGSHIP_HUB_HOST/KEY_PATH, USAGE_REPORT_SECRET, USAGE_FLUSH_MS, FLAGSHIP_OVER_QUOTA_KBPS, FLAGSHIP_PB_MAIL, FLAGSHIP_OUTBOUND_RELAY, FLAGSHIP_DRAIN_GRACE_MS), hyper HTTP surface on the hub port, usage meter with `.com` budget leases (LeaseBook port), relay blessing provider, 15-minute outbound totals log, drain on SIGINT/SIGTERM; process test passes. STILL OPEN for G7: Fly image/config (a Rust image beside the Node one, `[env]` unchanged), gym canary with old boxes (mixed version, reconnect, drain, rollback), the unported custom-domain pushes and gossip fan-out stay out by decision. Gym 6 started 20:00 UTC from `5db34866b`+ (first Linux build of flagship-updater/relay crates is its artifact step 4b: it got past the build).
- 2026-10-30 gym 5 triage: B3 never registered because its previous-artifact commit was unreachable after the gym branch force-push (now one `gym-artifact-<sha12>` tag per build; `ddfc79f` tagged by hand), so the update/share update verdicts rerun in gym 6; chat-cross-owner sent before the app held its canonical name (the box silently keeps a start local when `lead.mayAdmit` is false, harness.ts:225; the group now waits for the canonical name); backups schedule check counts keys relative to its start; stack-switch moved to the classic pass only (TODO: add `stack-switch` to CLASSIC_GROUPS in scripts/gym-release-run.sh after gym 5 ends); local-ai-cpu needs UpCloud cores (quota 32, fleet uses most): run it after teardown or on a smaller plan; first-contact failure predates the harness fix (re-verify in gym 6).
- 2026-10-30: folded PHONE-AND-BOX-TLS-SPEC.md into the plan as section H and Appendix H (proposed design, nothing built); the spec file was removed. Gym 5 arch-v2 pass: 467 passed, 9 failed (chat-cross-owner x3, first-contact (run predates the harness fix), share update verdict, backups schedule, local-ai-cpu (UpCloud core quota 32), stack-switch (ran on arch-v2, needs the classic pass), fleet home3 never registered).
- 2026-10-24: owner made this session release manager; decisions above. UX rebased onto 0.3 (139),
  web/Android/iOS first contact finished; architecture replayed (138) and integrated (`ced988cfe`).
- 2026-10-24: `ae9448cec` stack switch; `8007d3f8f` full-test-vm.sh + first-run fixes; `d7051eec9`
  client screens; `b7a0fa733` Rust broker (668 conformance cases); `65ac6af3f` M8; `f852205b3` recovery
  page i18n; `2cbd89d6c` M7; `a44fc2208` all 24 adversarial findings fixed.
- 2026-10-25: `90edead1e` Rust test fixes; `135829c9d` integration cleanup (app-browser reach/gate,
  durable grants, shell v178); `28b213c73` Chromium only when the release turns the browser on.
- 2026-10-25: generated store art into `store/out/` (uncommitted, stand-ins; owner didn't need it).
  Journal started.
- 2026-10-25: CI on `90edead1e` (runs 40150736028/40150738064) found, beyond what `135829c9d` fixed:
  the Go TLS frontend built with Go 1.25 fails every handshake (needs 1.26's MessageSigner path;
  go.mod now `go 1.26.0`, so box-artifact.yml builds it right); keyd's peercred test needs root (own
  sudo step in rust.yml); two web gym specs (auto-unlock pins first; recovery link has `&lang=`).
  Fixed in `dd96a774e`. Re-dispatched CI 40153988658 and Rust 40153990297 on it.
- 2026-10-25: AI01/AI02 committed `2045eef9b` (tool broker, redaction coverage, local inference +
  fine-tune, clients; shell **v179**; gym `local-ai-cpu` 13/13 on a throwaway VM; box group `local-ai`
  not run). Known from its report: Android `GymBuildTest.ideConnectionCopyAndRegenerate` clipboard
  timeout (pre-existing); `tools/unseal-crosscheck` vitest needs rustc on PATH; companion sessions may
  read `/api/screens/local-ai` (left as is: owner-side read). Parity green `059251d5d`.
  Started: full VM run on `2045eef9b` (log `scratchpad/full-test-3.log`), iOS build with
  SWIFT_EMIT_LOC_STRINGS into `scratchpad/ios-dd` for the harvest (4 BrowserGrantCenter strings
  pending). Disk had 5.8 GB free.
- 2026-10-25: full VM on `2045eef9b`: vitest 14,439/0 failed, all Rust/Go/tsc OK; crypto-graph fails
  by design (16/16 strict targets reachable via classical keys until the PQ ceremony). CI green.
  Rust CI needed: gVisor registered on the runner (pinned tarball + SHA-512 from appSandbox/gvisor.ts),
  `--no-fail-fast`, and the peercred child run from a copy in /tmp (`hostile.rs`); green on run
  40156714426. iOS harvest + 3 browser-grant translations `5e6a71249`. iOS mock gym running
  (`scratchpad/gym-ios.log`); Android mock gym next.
- 2026-10-25: iOS mock gym on `78fa00740`: 270/276 passed. Failing: GymSweepServerTests
  test_frontPageSavesAnAdminSignedOrder, GymSweepSettingsTests test_appearanceAndAppIconChoices,
  GymSweepShareTests test_ownerCreatesALinkAndCancelsIt + test_sheetRouteCreatesALink,
  GymRelease03Tests test_updatePromptOnceThenSettingsRow + test_updateKeptInRecoveryAndShareSwitch.
  A helper agent is fixing them (uncommitted until it reports). Android mock gym after it.
- 2026-10-25: iOS gym failures fixed `75e9a4a80` (2 real bugs: Share update results switch never
  loaded; recovery-update sheet lost under the closing onboarding cover; share seam pins first;
  2 test races). 8/8 + the two classes 28/28 re-run green. To mirror on Android/web: the
  update-reports load must not hang off a view that only exists once loaded; the recovery prompt
  must wait for a closing sign-in/onboarding screen. Android mock gym running
  (`scratchpad/gym-android.log`).
- 2026-10-25: Android mock gym: 195/202; 7 failing (GymOctoberTest share owner, GymServerPageTest
  migrate, GymShareTest sheet options, GymSettingsTest delete-other-device, GymUxScreensTest watch
  boot key, GymPasskeyBrowserSyncTest grant narrowed, GymUpdateResultsTest kept-in-recovery); a
  helper agent is fixing them (uncommitted until it reports).
- 2026-10-25: `gym` rebased onto `integrate/0.3-arch` (12 gym commits; caTrustChainLoader keeps the
  0.3 PQ lease gate over the gym material; ServerKeys keeps 0.3's removal of infoSTK; pbxproj
  regenerated with xcodegen) and force-pushed (`8a29461dd`; old tip `backup/gym-pre-0.3-2026-10-25`).
  Gym worktree: `~/.cache/flagship/gym-worktree`. Live release gym started:
  `bash scripts/gym-release-run.sh` → `scratchpad/gym-release.log`. Act on its exit code (Commands).
  If `release/0.3` (was integrate/0.3-arch) moves before a gym run, rebase `gym` onto it again (not onto main).
- 2026-10-25: **main has one extra commit `4c54f723c`** (adds only `.github/workflows/box-artifact.yml`;
  its parent `386e29c84` is the old main). GitHub dispatches a workflow only if its file is on the
  default branch, and gym-box-artifact.sh needs box-artifact.yml. Resetting main back by force-push
  was refused by the permission classifier: **ask Harry** whether to (a) let main be reset to
  `386e29c84` (then the release fast-forwards), or (b) keep it and land the release by rebasing it
  onto main (box-artifact.yml add/add conflict: take the release's copy). Until resolved, run the
  release gym with `GYM_BASE_REF=origin/gym` (else gym-refresh rebases gym onto main). Gym secrets:
  `set -a; . /Users/harrywinner/flagship/.gym-secrets.env; set +a` before the gym scripts. Gym
  artifact build: box-artifact.yml run 40167399457 on gym `73fc5eb6e`.
- 2026-10-25: main reset to `386e29c84` with Harry's approval (fast-forward possible again; the
  earlier "main has one extra commit" note is resolved). Harry: the gym must not depend on GitHub CI.
  So the gym builds its box artifact on a throwaway UpCloud VM (`scripts/box-artifact-vm.sh`, shared
  `scripts/lib/upcloud-vm.sh`, `645540751`; amd64 only). Also fixed `62cbea0f3`: the artifact
  assembler refused `flagship-wasi-worker` (every artifact since M7 failed). gym rebased to
  `e760e65c7`; release gym restarted.
- 2026-10-25: the Android gym-fix agent was stopped by the harness (auto-mode verdicts unavailable)
  partway. Its partial edits are uncommitted in the worktree (GymBase.kt, GymUpdateResultsTest.kt,
  SmokeMode.kt, KeystoreWatchBootKeys.kt, ActivityScreen.kt, BrowserGrantScreens.kt, ...): review,
  finish and re-run the 7 Android tests before committing them.
- 2026-10-25: Android gym fixed `86e474641` (2 real bugs: watch start-up key used
  NamedParameterSpec, which Android Keystore refuses; browser-grant reload/toast lost when the last
  request's list left; plus gym pins, share seed, keyboard wait, update-result check). 231/232 of the
  gym package green; the one left (GymDeviceBugsTest Samsung Pass: the text moved into "How this works")
  and the same lost-toast pattern in ChatRequestsList are being fixed (uncommitted, verifying). iOS to
  check later: Allow/Withdraw on an app's page still reload grants and toast when the last card goes;
  the share demo seed must not be cut short by a leaving view.
- 2026-10-25: release-gym VM build needed `--no-same-owner` and GnuPG (`scripts/lib/upcloud-vm.sh`);
  gym at `61c2d1005`; live release gym running again.
- 2026-10-25: Android follow-ups `18ab5b7f8` (chat-request toast; Samsung Pass test). Plan step 8
  started with three helper agents, all uncommitted until they report: (A) gpud share state persisted,
  gpud verifying the owner's approval (R02), WASI logs through privd; (B) journalHttp refuses the IRK
  on admin-pinned boxes, backups include dedicated databases, classic→arch-v2 box migration; (C)
  accelerator owner card on iOS/Android/web, Swift/Kotlin ExportAuthorization scope, iOS checks
  (browser-grant toast on app page, share demo seed). If this session ends: review `git status`,
  finish/verify each area, commit by explicit paths.
- 2026-10-25: GPU/WASI gaps committed `dcdb763f3` (gpud terms persist; gpud verifies
  flagship/gpu-approval/v1 itself; WASI logs via privd + Rust broker `wasi.logs`). Consequence: every
  app GPU claim is refused until the owner signs an approval, so the loop is being closed: the GPU
  agent builds the box side (manifest → AppSpec.accelerator, pendingApprovals on the GPU screens
  route, POST /api/screens/gpu/approvals and /withdraw, push/Activity), the clients agent the
  Approve/Decline/Withdraw UI on all three apps. Release step: re-pin installer/rust/PINS.json
  (gpud and broker changed); hardware runbooks' manual claims need a signed approvalProof.
  Still known after this: revocation and maintenance orders come from the daemon's word; strict-PQ
  half of the approval not required; daemon keeps SupplementaryGroups=systemd-journal (journalHttp,
  dockerHealth read the journal); a VM job whose kept terms are lost can't return its VFIO groups.
- 2026-10-25: daemon gaps committed `521ce5955` (journal admin-root only on pinned boxes; volumeDump
  dumps dedicated DBs; classic→arch-v2 switch order + root step + trial/rollback; its privd setup
  steps landed in `dcdb763f3`). Handed to the apps agent: native journal signing (iOS
  JournalViewModel → sensitiveOrderKey, Android → adminSigningKey; else 403 on pinned boxes), stack
  switch UI + Activity labels, besides accelerators/GPU approvals/ExportAuthorization/iOS checks.
  Still open for the switch: no run on a real classic box (apt without lists, volume move, arm64),
  no gym group, no crypto-graph node for flagship/arch-v2-switch/v1 (nor gpu-approval).
- 2026-10-25: GPU approvals box side `d894a516c` (GET /api/screens/accelerators pendingApprovals +
  approvals; POST /api/screens/accelerators/approvals and /approvals/withdraw; withdraw tag
  flagship/gpu-approval-withdraw/v1; stored in <dataDir>/gpu-approvals.json; push `generic`, Activity
  gpu.approval.*). Crypto graph `1554f7947`. Known: gpud reads owner.json only at keyd start, so after an
  admin-root rotation claims are refused until keyd restarts. The apps agent was given the real paths;
  parity/allowlist.json + features.json + the webapp port of the GPU tags are its to finish.
- 2026-10-25: clients committed `e271dfa8c` (GPU card + signed approvals, stack switch card, journal
  admin signing incl. webapp SENSITIVE_TAGS, ExportAuthorization scope parity, shell **v180**). Step 8
  done. Known, to record in AGENTS.md: GPU Decline is local only (no box route); cooperative GPU
  approvals use trustDomain "owner-apps" and ownerConsent "owner-consent-<issuedAt>" (no input yet);
  the GPU card doesn't refresh on the gpu-approval-request event/push; stack switch never run on a
  real classic box and has no gym group. gym is behind the tip (rebase onto integrate before the next
  release-gym run; the current run uses `61c2d1005`).
- 2026-10-25: **live release gym run 1 (gym `61c2d1005`): every fleet box failed** on both stacks
  (arch-v2: 119 passed / 9 failed / 42 skipped, all failures in `fleet`; classic: fleet 6 failed, the
  rest skipped). Demo-flow boxes register but get no cert; gym-provisioned ones stay at order phase
  "installing". Not LE rate limits (acme-budget-cli: room). browser verdict: skip. Harry approved a
  per-box debug SSH key (`0da1bf58c`: gym/provision `debugSshPublicKey`, fleet env
  `GYM_DEBUG_SSH_PUBKEY`; demo/prod boxes unchanged). Debug run: gym refreshed to `0a997184d`, core
  group with key `scratchpad/gymdbg` (throwaway) → `scratchpad/gym-core-dbg.log`; SSH root@<box ip>.
- 2026-10-25: cause 1 found on a debug box: gym-provisioned boxes asked for the artifact of THIS
  checkout's release/box-release.json commit (main's 386e29c84), which the gym never builds → 404 →
  "FATAL: could not download". Fixed `gym-release-run.sh` (exports GYM_INSTALLER_GIT_REF from the gym
  worktree's box release). Demo-flow boxes (right commit via the Worker's DEMO_INSTALLER_GIT_REF)
  registered but got no cert: still to diagnose. Debug box dbg2.uxdbg03871 (UpCloud
  00a49686-94bc-449d-9220-a200e9594eee) provisioned with the gym commit 0a997184d; destroy it with
  `fleet-cli.ts destroy <id> <fqdn>` when done. Note: gym boxes are Debian 12 (bookworm).
- 2026-10-25: Harry asked to merge everything into release/0.3 and clean out branches/worktrees.
  release/0.3 fast-forwarded to the integrated tip; PSL runbook update from the main checkout carried in
  (`18c99d77e`); every branch checked for containment (merge-tree + line-level absorption); 271 refs
  and 4 worktree WIP snapshots archived under refs/archive/2026-10-25/ then deleted; manifest
  `7e27bca89`. Worktrees left: main checkout (on main), flagship-0.3 (release/0.3), gym worktree.
- 2026-10-25: cause 2 found on a debug box: writeFileDurable's mode went through the daemon's
  UMask=0077, so the Rust launchers (flagship-rust-exec/select) landed 0700 and keyd/core (own users)
  could not exec them → keyd down → daemon never started → no cert. Same bug made the engine marker
  unreadable to the daemon user (falls back to Docker). Fixed `c0f191aba` (fchmod; test
  durableFileMode). Verified by hand on the box: tunnel up, cert, HTTPS 200. Debug box destroyed.
  gym rebased onto release/0.3 (`78f9fa308`); release gym run 2 started → scratchpad/gym-release-2.log.
- 2026-10-25: feature branches being rebased onto release/0.3 by two agents in worktrees
  /Users/harrywinner/flagship-feat-a (marketplace, custom-names, custom-domains, outbound-proxy from the
  ux-* copies; branches rebased/*) and /Users/harrywinner/flagship-feat-b (retail, browser-extension,
  phone-usb-burn, other-os-installers, data-sovereignty, alpine). After review: move feat/* to
  rebased/*, push, archive+delete ux-*, remove the two worktrees. rust/target was deleted (cache).
  Asked Harry: outbound proxy (a) free in 0.3 without the marketplace, or (b) with payments.
- 2026-10-25: Harry: data sovereignty's core stays for the NEXT release. TODO once
  rebased/data-sovereignty exists: add to its docs/data-sovereignty.md the 2026-10-25 discussion:
  boot unlock tries .com then falls back to the LAN (box listens on a fixed port and tries its default
  gateway; the reply is already owner-signed and sealed to the box key so the carrier doesn't matter;
  LAN path limited to private/link-local addresses); phone hotspot as the "serious user" setup
  (phone = gateway); after ~30 min without .com a running box advertises itself over mDNS/Bonjour so
  the phone finds it with no internet ("turn off the internet and wait"); phone-only (browsers can't).
  Open questions: giving users their own control plane ("what if they don't need us anymore?"), how
  to handle LAN networks (static IP, 802.1X, captive portals, VLANs, IPv6-only) and headless servers.
  Phone USB burn: Harry wants it IN this release. Outbound proxy: asked free vs Pro (recommended free
  BYO-proxy; paid = Flagship-run exit/WireGuard/second relay), gated on the initramfs OHTTP piece.
- 2026-10-25: marketplace family rebased (9/17/16/16 commits over the release; shells v181-v184);
  feat/{marketplace,custom-names,custom-domains,outbound-proxy} force-pushed onto it, old tips and the
  ux-* copies archived under refs/archive/2026-10-25/pre-rebase/, ux-* deleted. Agent fixes on those
  branches: custom-names refuses a rename while the account holds PQ bindings/assurance changes;
  outbound-proxy's root health timer no longer feeds the daemon-written curlrc to curl -K (privilege
  escalation under 0.3's unprivileged daemon). Open on custom-names: recovery record v2 names the
  account, so a rename needs a re-signed record before the paid name change launches. iOS strings for
  custom-domains/outbound-proxy wrapped but not harvested.
- 2026-10-25: Harry: nothing more into 0.3 (outbound proxy stays out); but boxes created with 0.3 must
  be able to upgrade to anonymous messaging later. Found: nothing refreshes the initramfs unlock
  script/hooks after install, so an installed box's boot path is frozen. An agent is building the
  "boot-chain refresh" in the release worktree (privd + Rust broker step, regenerate from the
  release's own builders, keep the known-good initrd, GRUB fallback, run on each applied update and
  once on first boot, Activity labels) — uncommitted until it reports. Harry's note: a serious user
  can hide from us with a VPS on their home network anyway, so no more anonymity work now.
- 2026-10-25: all feature branches rebased onto release/0.3 and force-pushed (old tips archived under
  refs/archive/2026-10-25/pre-rebase/): retail 6, browser-extension 1, phone-usb-burn 13,
  other-os-installers 5, data-sovereignty 8 (restores the five reverts that parked its code; strict-PQ
  profile blocks rescue sessions until rescue orders carry a hybrid signature; the 2026-10-25 LAN /
  hotspot / mDNS / own-control-plane notes added to its doc), alpine 4 (still git-clone installs,
  documented). Branches left: main, release/0.3, gym, hof-jay, the feat/* set, alpine,
  device-results/windows-2026-10-17, wip/coordination-2026-10-16. Worktrees: main checkout,
  flagship-0.3, gym worktree.
- NEXT: once the boot-chain agent has committed, fast-forward release/0.3 onto feat/phone-usb-burn
  (Harry wants USB burn IN 0.3), delete that branch, then USB-burn owner steps: rebuild the seed for the
  release's Debian pin (sha pin is 13.6.0), publish it, set FLAGSHIP_ISO_SEED, test OTG write on a real
  phone + stick; plus a gym lane for a burned stick. Update the AGENTS.md branch list.
- 2026-10-25: Harry's mandate recorded (Mandate + Master plan above). USB burn (13) and data
  sovereignty box half (8) landed on release/0.3 at `a03887d5c` (tested together first in a scratch
  worktree /Users/harrywinner/flagship-tmp, which can be reused for side work or removed).
- 2026-10-25: A4 started: an agent builds the sovereignty phone side + basic offline control on branch
  `work/sovereignty-phone` in /Users/harrywinner/flagship-tmp (commits there, not pushed). If this
  session ends: check that branch's log, finish the A4 list, test, then merge into release/0.3
  (rebase onto it first). A1 (boot-chain refresh) is still uncommitted work in the release worktree.
- 2026-10-25: F3/F4 texts started early: an agent drafts docs/release-notes/0.3.md, store listings
  (7 languages) and the website pages in the release worktree (uncommitted until it reports; native
  screenshots come later). Live release gym run 2 still running (scratchpad/gym-release-2.log).
- 2026-10-25: texts landed `68b32b475` (release notes, store listings ×7 with limits check, website +
  blog post). TODO-RM markers to resolve before launch: see F4b. Product version still 0.2: see F4c.
- 2026-10-25: A1 landed `8b41f8ff6` (shell v181; compatibility.json pinned to 181). The feature
  branches feat/marketplace (v181…v184) must renumber above 181 at their next rebase.
- 2026-10-25: release gym run 2 (gym 78f9fa308): boxes come up now. arch-v2 170 pass / 55 fail / 16
  skip (browser verdict: fail); classic 36 pass / 8 fail. Failure list:
  scratchpad/gym2-fails.txt (also derivable from gym-results/release-20261025T170312Z-*). Main
  clusters: app sandbox ("Docker didn't pick up the gVisor runtime" / systemctl code 5) blocking app
  installs, AI staging fence and data layer; cert check expects old SANs; share/remote sessions refused
  by central authorization; no endorsed releases listed; plus first-contact proof, decommission,
  app groups, WASI pinned install, local-AI delete 500, AT-LIVE-19 signature, no Chromium, gpu-sim
  core quota, WORKERS_PLAN=paid. A triage agent is fixing them in the release worktree
  (uncommitted until it reports); then rebase gym onto release/0.3 and run the release gym again.
- 2026-10-25 (SECOND AGENT; main agent was interrupted for lack of funds and will review): finished the A4 Android half in /Users/harrywinner/flagship-tmp (NSD discovery, key-bound TLS, offline control + Rescue my data screens, Settings/server page/account-gone entry points, environment factory, 83 strings reusing the iOS drafts in 6 languages, RescueVectorsTest + KeyfileVectorsTest green, parity/i18n green, Android compiles). Rebased work/sovereignty-phone onto release/0.3 (conflicts: webapp shell took v182, compatibility.json 182, i18n json merged per key then catalogs rebuilt) and fast-forwarded release/0.3. Not done yet: Android/iOS mock-gym scenarios for Android, PQ-gate vectors in Kotlin, release gym triage (gym2 failures: nothing from the earlier triage agent was found uncommitted in the worktree, so it must be redone), A5, B-F.
- 2026-10-25 (SECOND AGENT): A4 leftovers done. Android: `OfflineControlViewModelTest` (8, in `src/testDebug`, against the debug-only in-process box `GymRescue`), `RescuePqVectorsTest` (19 gate cases + hello check, Kotlin half of `rescue/pq-vectors.json`), `GymOfflineControlTest` (6 scenarios: found+each control, not found+typed address, wrong key, stranger, expired cert, interrupted download resumes) green on the `flagship_gym` emulator. Seam: `AppVariant.rescueEnvironment` (release returns null) + launch extra `flagship.smokeRescue`. Unit suite, parity, i18n, release-clean scan green. Checked the §7 box fixes already have tests (restore rewrites creator, self-delete `notBefore`, BoxReadToken 20 s timeout). No bug found in product code; two test-mock slips fixed (status block, Start has no confirm). Next: A5.
- 2026-10-25 (SECOND AGENT): A5 done. The seed pin (13.6.0, sha `54be17b4…`) already equals the release's Debian pin; the iso-seed workflow only ran on the deleted feat/phone-usb-burn, so it now runs on main + release/** (and when the preseed generator changes). New: `scripts/publish-iso-seed.sh <run-id>` (checks the pin, GitHub release asset, switches on FLAGSHIP_ISO_SEED with real url+size), wired into release.sh step 20 (publish); `scripts/iso-seed-pins.test.ts` (workflow/doc/page/wrangler/manifest pins agree + publisher against a stubbed gh); `tools/usb-burn-qemu/` + CI job `burned-stick`: composes the stick as the phone does (real generated preseed into the FLAGSHIP partition), boots it in QEMU as USB via the seed's own BIOS entry, and requires d-i to find the partition, run the recipe's late command and power off. Green on KVM in 2.5 min (run 40254061759). Local seed rebuild on a Mac differs from the pin (expected: the CI container is the reference). Next: B0.
- 2026-10-25 (SECOND AGENT): B0 fix. Both initramfs scripts (unlock, Wi-Fi) mounted `/dev/disk/by-label/FLAGSHIP_BOOT` with a bare `mount`: at init-premount ext4 is not loaded (root is not mounted yet, and an untyped mount only tries filesystems already in /proc/filesystems) and the unlock script did not even wait for udev's by-label link (the Wi-Fi one waited). So the unlock log, the lock-once marker and the live owner-key read could not work. Now one shared shell function (`packages/boot-chain/src/bootFsMount.ts`): bounded wait for the link, `modprobe ext4`, `mount -t ext4`. Tests: `packages/boot-chain/tests/bootFsMount.test.ts` (runs the function against stub mount/modprobe: order, waits for a late link, gives up; both generated scripts contain no bare mount and define the function before use); the premount end-to-end tests set FLAGSHIP_BOOT_WAIT_SECS=0. boot-chain, bootChainRefresh, bootChainIdentity, unseal-crosscheck (all 22 premount tests) green. Boxes get it through the boot-chain refresh on their next update. Next: B1/B3.
- 2026-10-25 (SECOND AGENT): B1 and B3. FLAW FIXED: rescue's hello budget (300/min, reachable by anyone through the relay) was shared with the admin's revoke and rotation intake, so a hello flood blocked cutting off a stolen device without `.com`; intake has its own budget now (test in `server-daemon/tests/rescue.test.ts`). HARDENING: keyd now shape-checks `rescue-hello` like it does session signatures (it only checked the tag). `tools/adversarial/tests/rescue.test.ts` = AT-RSC-01..04 (lifted signatures between hello/session/order, an order moved to another session/server/action, keyd refusals, discovery id); the AT-ENV-10 tag inventory was RED for five new tags (arch-v2-switch, gpu-approval, gpu-approval-withdraw, lan-discovery, offline-control): classified. Adversarial suite 1223 green, 0 it.fails. Not found a bug but left as DESIGN for the reviewer: the hello cap itself still locks the owner out for a minute under a flood (a test pins 429 at 300/min); the discovery id is computable by anyone who knows a server's name and public STK. B3: crypto-graph gains `eff.rescue-session`, `eff.offline-control` (both strict authorization targets, admin root / IRK-where-unpinned edges) and `ver.rescue-hello`; repaired 10 stale evidence references (deleted boot-stage.sh, moved userdata lines); a test now runs `--check-evidence` on the real graph. Strict reachability stays the known failure (18 of 18). Next: B2 (independent review), then C1.
- 2026-10-25 (SECOND AGENT): E1 written: `docs/runbooks/0.3-hardware-acceptance.md` (pair/unlock, the FLAGSHIP_BOOT unlock log check for B0, offline control + rescue with the internet cut incl. stranger and import into a second account, USB burn from an OTG phone + metal boot + single LUKS slot, Mac Studio, Windows/Linux via the device-test agent runbook, local AI + GPU read-only, watch/Wear, sign-off table). B2 reviewers (4, read-only) running.
- 2026-10-25 (SECOND AGENT): B2. Four reviewers (rescue/offline control; boot chain + USB seed; arch-v2 Rust/GPU; .com/control-plane) read the 0.3 diff. FIXED (each with a test that fails on the old code): revoke/rotation intake no longer has any counted budget (a flood of junk, 100/s through the relay, blocked cutting off a stolen device) and offline orders honour the 24 h new-admin cooling like the session; LAN listener: per-source connection cap + 20 s handshake-progress deadline (256 sockets from one host closed the only path when the internet is down); seed stub: recipe only from the partition LABELLED FLAGSHIP, exactly one, else halt (it took any FAT disk's /preseed.cfg; any plugged stick ran root code in the installer); the Android app pins the seed hash itself (`SeedPins.kt`, kept equal to iso-seed.yml by a test; it trusted `.com`'s hash) , so the seed hash changed to `892cf430…` (CI-built; pins updated in doc, security page, wrangler.toml, workflow); hostile key-file Argon2 cost refused (TS, Kotlin, Swift: it crashed/OOMed the importer); Wi-Fi text with line breaks refused (heredoc injection as root in the target); mixed-case server name in a boot suspension refused + D1 lookups lowercased (a lock could sit under a name the lease lookup missed); RSA passkey exponent must be 65537; privd: a bind-mount source must be a regular file, not a link (TS `checkBindSources` + Rust `check_bind_sources`: the daemon could point /run/flagship-daemon/flagship-resolv-x.conf at any host file); local-AI named containers must use a pinned image even on the GPU path (TS + Rust + corpus case, vectors regenerated); gpud no longer falls back to the IRK when owner.json has a damaged admin root. ALSO FOUND BY MY OWN RUN: (a) B0's premount change had not reached the bundled preseed engine, its two native copies, the golden vectors or the byte pins: regenerated (a stale engine would have burned the old premount on every phone-made box); (b) the saved-backup schedule converter drifted an hour in a clock-change week (apps/web test red today, 2026-10-25): both directions use one offset, a 366-day x 5-zone round-trip test; webapp shell v183 (feature branches renumber on rebase).
- 2026-10-25 (SECOND AGENT): B2 OPEN, not fixed (design or owner decisions; severity as the reviewers rated): MED `RELEASE_PQ_PIN`/`CA_LEASE_PQ_PIN` keyIds are empty, so no hybrid companion is required anywhere: this is the PQ ceremony (deploy sheet 2c); until then 0.3 ships classical-only endorsement and must say so. MED `POST /api/server/<d>/health` accepts a raw Ed25519 signature (STK or the unencrypted boot key) over untagged bytes and skips `gateBoxMessage` under strict: needs the health timer to hybrid-sign. MED gpud GPU approvals can be replayed after the owner withdraws them (no root-owned floor/max age; withdrawal is only in the daemon-written file). MED gpud claim fields `container`, `userspace`, `max_runtime_ms`, `share` are daemon-chosen and unsigned. MED root acts on the daemon-written `arch-v2-verdict.json` (a compromised daemon can force a revert, or commit unverified). MED keyd `app-rank/v1` and `device-capability-grant/v2` master evidence has no freshness/revocation check. MED trial boot vs TPM-sealed lease key (PCR 8/9 may change, then the owner must be reachable; unverified whether GRUB measures them). LOW/MED premount trusts any FLAGSHIP_BOOT-labelled ext4 and the first LUKS device (bind to the install UUID / the /boot disk); installer wipes the largest fixed disk without asking when two exist; privd `model-install` checks sha-vs-filename only (no catalog digest/size cap); `POST /api/update-receipts` is anonymous and prunes on a nonce prefix (skewable canary data); re-pair veto and voici-name routes are not rate limited; recovery record without a passkey key is released on the passphrase hash under strict; mDNS unicast reflection (small); journal/arch-v2 HTTP orders have a 5-minute replay window with no nonce. NOT REVIEWED: WASI worker, flagship-runtime, flagship-crypto, typed.rs capability path (needs a follow-up pass).
- 2026-10-25 (SECOND AGENT): F1 (AGENTS.md: 0.3 section, branch list, USB-burn line; SECURITY-0.3-PROGRESS.md: the B2 review) and F2 (`docs/runbooks/0.3-deploy-sheet.md`; seed publish wired into release step 20). C1 is running on UpCloud for `009fa70c3` (`gym-results/full-test-*`, log in scratchpad `c1.log`); i18n (iOS + Android) and parity re-checked green.
- 2026-10-25 (SECOND AGENT): F4c partial (see its line). Also red since my A4 landing, now fixed: `scripts/mobile-clients-inventory.test.ts` did not list the two rescue transports (raw TLS clients that trust the box's pinned key, not the CA pin); listed with the reason. Version tests moved to 0.3 Beta.
- 2026-10-25 (SECOND AGENT): C1 first run on `009fa70c3` (UpCloud, VM deleted, log gym-results/full-test-20261026T021201Z): vitest 14828 pass, 1 fail (the HTTP-client inventory, fixed since), tsc/clippy/cargo test/go/keyd-crosscheck green, crypto-graph red (known). cargo-deny was a FALSE red (the install on the VM failed silently: `full-test-vm.sh` now retries and logs it). Rust CI `deny` job was REALLY red: crypto-bigint 0.7.6 got yanked, `Cargo.lock` moved to 0.7.9 (workspace tests green). D1 Android mock gym, whole suite on the emulator: 249 tests, 3 red: (1) `GymAccountGoneTest` still expected no rescue button (A4 added it for a device that holds the admin key or knows pinned servers): test updated; (2) `GymLiveAccountTest` expected 'pairing isn't available yet' but a debug build on a real backend has used the live pairing relay since the device-pairing work: test rewritten to the real behaviour (stale since before my work); (3) `GymServerPageTest.lockingTheAppDismissesAnOpenSheet` timed out under load and passes alone (flaky; not changed). Web mock gym running.
- 2026-10-25 (SECOND AGENT): D1 so far. WEB mock gym: 354 scenarios; my first two runs showed 28 and 14 red, ALL caused by my own concurrent Playwright runs fighting for the fixed port 8799 (ERR_CONNECTION_REFUSED at 127.0.0.1:8799, ~1.5 s fails); the 14 reds of the second run pass serially (14/14), so web is 354/354 green. Never run two web gyms or a stray `playwright` at once. ANDROID mock gym on the emulator: 249 tests, 3 red, fixed or explained in the previous line. iOS mock gym started (`scratchpad/iosgym.log`, 299 scenarios). LIVE GYM (D2) BLOCKED FOR ME: `gym` rebased onto release/0.3 (two additive conflicts in AppVariant.kt / release Variant.kt between my `rescueEnvironment` and the gym's `adoptLiveIdentity`: kept both; old tip `backup/gym-pre-0.3-rebase2-2026-10-25`, new `cd295e9eb`, force-pushed with lease), then the harness's auto-mode classifier refused `bash scripts/gym-release-run.sh --groups core` (it sources the gym secrets and deploys the gym Worker/Fly app and creates UpCloud servers). I did not work around it; the owner needs to allow it or run it: `set -a; . /Users/harrywinner/flagship/.gym-secrets.env; set +a; GYM_BASE_REF=origin/release/0.3 bash scripts/gym-release-run.sh` (add `--groups core` first to iterate on the gVisor failure). Gym-2's 55 arch-v2 failures: ~35 are ONE cause, `container deploy failed: apps can't start on this server without their sandbox: Docker didn't pick up the gVisor runtime` (also on the classic pass: core, gating, invites, one-list, backups); others: cert SAN check expects the old names (`*.home.<acct>.gym.flagship.services` is now what boxes present: test expectation), share/remote routes refused (`route-not-allowed-for-session`), no endorsed releases listed on the update box, first-contact enrollment proof, lifecycle decommission (home2 still answers after 12 min), WASI install (`/usr/bin/install is...`), local-AI delete 500, AT-LIVE-19 (`invalid signature` reading privd's audit), gpu-sim (UpCloud core limit reached), app browser routes absent.
- 2026-10-25 (SECOND AGENT): F4b partial: removed the `TODO-RM offline-control` comments in 23 places (site pages x7 languages, blog, FAQ, help) and in `docs/release-notes/0.3.md` dropped the 'strict profile refuses rescue' caveat (phones send the hybrid half now; box enforces it, tested). Marketing page tests and i18n green.
- 2026-10-25 (SECOND AGENT): D1 iOS mock gym NOT RUN: it needs about 15 GB of simulator clones and this Mac had 2 GB free (the first attempt took the disk to 189 MB; I killed it, ran `simctl shutdown all` + `simctl erase all`, cleared DerivedData, Gradle build cache, Homebrew cache and my scratch ISOs; now 2.6 GB free). Free about 20 GB (CoreSimulator, ~/.android/avd 11 GB, ~/.gradle) and run `DEVELOPER_DIR=/Applications/Xcode-27.1.0-Release.Candidate.app/Contents/Developer npm run gym:locked -- --surface ios` (299 scenarios, ~1.5 h, one run at a time). Stage status: A done, B0/B1/B3/E1/F1/F2 done, B2 fixed-with-OPEN-list, C1 once on `009fa70c3` (needs a re-run on the final tip), D1 web 354/354 and Android 249 (3 explained) done, iOS pending; D2/D3 need the owner to allow the live gym; F3 screenshots need the iOS and Android gym captures; F4b partial; F4c partial; F5/F6 owner.
- 2026-10-26 (SECOND AGENT): Harry allowed me to run all gyms and asked for a PQ ceremony script. LIVE GYM: fixed the artifact-VM blocker (fresh Debian VM holds the dpkg lock at first boot: `scripts/lib/upcloud-vm.sh` waits with `DPkg::Lock::Timeout=600`), retried the transient Fly 401, reaped the leftover gym server `flagship-gym-uxdbg03871` (Harry approved), then started the FULL release gym: `GYM_BASE_REF=origin/release/0.3 bash scripts/gym-release-run.sh --skip-refresh` (log `scratchpad/gym-full.log`, results `gym-results/release-20261026T*-{arch-v2,classic}`; exit codes in Commands). The refresh already ran and deployed the gym Worker + Fly app from `gym` (`cd295e9eb`). If the run is interrupted: `npx tsx tools/live-e2e/sweep-cli.ts --destroy` (gym-only) before rerunning, and `rm` any `/private/tmp/claude-501/flagship-locks/gym.lock` left by a dead run. iOS mock gym restarted with 21 GB free and a watchdog (`scratchpad/watchdog.sh`, kills it below 2 GB free); log `scratchpad/iosgym.log`. Disk lessons: the iOS gym fills ~14 GB of CoreSimulator clones; after it, `xcrun simctl shutdown all && xcrun simctl erase all`. PQ ceremony script: in progress (`scripts/pq-ceremony.mjs`, see next entries).
- 2026-10-26 (SECOND AGENT): PQ CEREMONY SCRIPT written for Harry to run in his terminal: `node scripts/pq-ceremony.mjs` (also `--status`, `--restart`, `--help`). Seven steps with on-screen instructions: (1) checks (node, age, age-plugin-yubikey, maintainers CLI found+built incl. from a git worktree, protocol built, nothing pinned yet, no key file to overwrite, files clean), (2) one age identity per YubiKey (detects a YubiKey that already has one, refuses the same YubiKey twice, writes the stubs 0600), (3) `pq-release-key.mjs init` (PIN + touch, paper backup prints once), (4) prove: the key id typed from the PAPER, `verify-yubikey` per YubiKey (3 tries), and a `restore-from-paper` rebuild into a throwaway file that is deleted, (5) `pin --ca-lease --box-artifact` + legacy manifests from `~/flagship-release-artifacts` (+ `--legacy-manifest`), `gen-box-release --write`, `tsc -b`, (6) vitest for the PQ-touching suites, (7) commit with explicit paths (asks before commit and before push). After each of steps 2, 3 and 5 it re-checks the disk (distinct recipients, identity file 0600 and complete, key file 0600, binding file, `show-pub` agrees, the id is in releasePqPin.ts / caLeasePq.ts / box-artifact-trust.json and `show-pub` says pinned). Progress in `~/.flagship-release/pq-ceremony.json` (no secrets); resuming re-verifies done steps against the disk. Tests `scripts/pq-ceremony.test.ts` (14): parsers, state, maintainers-dir lookup, preflight guards, and the whole ceremony with fake YubiKeys (happy path; wrong paper id; a YubiKey that cannot open the file then resume without repeating init; refuses an existing key file / existing pin; disk disagreement). BUG FOUND BY THE TESTS: the first draft passed `--key-file` to `init` (which takes `--out`), so a fake-mode run wrote a TEST key file to the real `~/.flagship-release/pq-release-key.age`; deleted it, fixed, and the script now refuses fake mode without its own key file and refuses a real run over a drill's key file. After the ceremony: the pin touches `apps/web/public/webapp/lib/releasePqPin.js`, so the webapp shell must be bumped (v184) with its test pins and `release/compatibility.json`, then retro-sign the marker release (`endorse-release.mjs --pq-only`) and the release script does the rest. Docs: runbook pq-release-key.md and release step 6 text point at the script.
- 2026-10-26 (SECOND AGENT): Harry asked whether the PQ ceremony works with his two latest-generation YubiKeys (main = the authority-ceremony key, backup). Answer given: yes by design, NOT proven on hardware (none was plugged in here). Facts: the age identity goes into a RETIRED PIV slot of each key (age-plugin-yubikey 0.5.1, YubiKey 4/5), slot 9c and the authority keys are untouched; only the main key (the one whose slot 9c holds the release Ed25519 key) signs the PQ binding at step 3; both keys must open the key file at step 4. Needs on each key: PIV enabled, its PIV PIN (and the PIV management key if the authority ceremony changed it: age-plugin-yubikey asks for it), Ed25519 in 9c needs firmware 5.7 (the existing authority flow already depends on that). The script now reads firmware with `ykman info` and warns on an old key or PIV off (test added). The ceremony does not change PINs/PUKs. LIVE GYM: arch-v2 pass finished, classic pass running; ROOT CAUSE FOUND for the ~35 'Docker didn't pick up the gVisor runtime' failures: the gVisor setup runs as a separate ROOT process (`setup.ts` STEPS, via privd) that never ran the daemon boot, so `activeEngine()` defaulted to Docker on Podman boxes and it ran `systemctl reload docker` (exit 5, no such unit). FIXED: `rootEngine()` (engine-active record, else the switch file) moved to engine.ts and installed by the root entry point before any step; test `packages/server-daemon/tests/rootEngine.test.ts`. Second finding, NOT yet fixed: on Podman boxes `[data-layer] DOWN: compose couldn't start the core stores` with docker-compose failing `FileNotFoundError` on the engine socket (the installer relies on `podman.socket` + the compose provider in `/etc/containers/containers.conf.d/40-flagship-compose.conf`); needs a look on a live box (plan: gym Worker secret UPCLOUD_SSH_PUBLIC_KEY + `tools/live-e2e/box-bringup-debug.sh`, delete the secret after). The gym `gym` branch must be rebased onto the fix before the next live run.
- 2026-10-26 (resumed session): full live gym `release-20261026T113114Z-*` (before the rootEngine fix) finished: arch-v2 and classic both red, the same clusters as gym 2 (gVisor "Docker didn't pick up the runtime" / systemctl 5 in ~all app-install groups; AI test copy "can't wall off" follows from the sandbox; enforcement/share/remote skips follow). `gymServersLeft: []`. SECOND finding FIXED by reading, not yet proven live: `DataStack` (dataLayer/stack.ts) brought the core stores up with its own `docker compose`, which on a Podman box falls back to bare `docker-compose` against `/var/run/docker.sock` (absent) = the `FileNotFoundError`. On a Podman box it now starts the root data-services unit (init.sh starts podman.socket and runs `podman compose`); Docker boxes unchanged. Tests in dataLayerStack.test.ts. NEXT: rebase `gym` onto release/0.3, rerun the live gym (`set -a; . /Users/harrywinner/flagship/.gym-secrets.env; set +a; GYM_BASE_REF=origin/release/0.3 bash scripts/gym-release-run.sh`); other known reds to triage after: cert SAN test expectation, update.json (no endorsed releases), release-catalog (no pinned root: PQ/catalog ceremony), WASI `/usr/bin/install`, local-AI delete 500, AT-LIVE-19, lifecycle decommission, UpCloud core quota.
- 2026-10-26 (resumed session): live gym 4 (`release-20261026T150349Z-*`, gym tip `d79b8955`, with the rootEngine + data-layer fixes): arch-v2 and classic still red, but the error moved: the gVisor probe now dies with Podman's `short-name "pgvector/pgvector@sha256:..." did not resolve` (Debian's Podman has no unqualified-search registry). FIXED `registries.conf.d/50-flagship.conf` (`unqualified-search-registries = ["docker.io"]`) written by the gVisor setup step, init.sh's Podman branch and the engine switch (no builder/preseed change). ALSO FIXED: gym SAN checks accept a covering wildcard (`sanCovers`); Rust broker `V1_BINARIES` gained `/usr/bin/install` (WASI drop-in). OPEN: the CLASSIC pass shows the same Podman error, which means classic boxes are not on Docker or the stack param is not honoured (needs a live look); local-ai delete 500, AT-LIVE-19 invalid signature, first-contact enrollment proof, remote/share `route-not-allowed-for-session`, update.json no endorsed releases, lifecycle decommission, browser (no Chromium), gpu-sim UpCloud core quota; most others follow from the sandbox. Core-only rerun on both stacks started (`gym-run5-core.log`).
- 2026-10-26 (resumed session): PQ CEREMONY BLOCKED on a design finding: `init` asks the YubiKey (PIV Ed25519, slot 9c) to sign the hybrid message M' = tag || suite || hybrid public key (1,984 B) || payload; for the key binding that is 6,095 bytes in ONE extended-length APDU (no chaining) and the real card fails with `SCardTransmit 0x80100016`. Fake-YubiKey tests cannot see it. Every PQ companion has the same 1,984-byte key inside M' (about 2.3 KB). Options: (1) ship 0.3 classical-only (already allowed) and fix after; (2) make the Ed25519 half sign a short domain-separated digest of M' (format change in every verifier). Writeup for a YubiKey expert: scratchpad `yubikey-pq-writeup.md`. Also fixed: init signs before writing and removes an orphan seed file; ceremony preflight stops early on an AES management key (age-plugin-yubikey needs TDES; switched on the authority key).
- 2026-10-26 (resumed session): PQ CEREMONY DONE by the owner on the real YubiKeys (release key id `1c07f1ffe8e6e8b89d8b8c8c14544d6f065decfa67ea76ec50c30fadaadb9434`, binding `.maintainers/release-pq/bindings/1c07f1ffe8e6e8b8.json`, paper backup written, both YubiKeys open the file). Cause of the earlier blocker: the v1 binding's Ed25519 message was 6,095 bytes and a YubiKey's PIV applet takes ~3 KB (probes on fw 5.7.4: 300, 2,535 and 3,000 bytes sign through Python and through our Node signer; 6,095 is refused). FIX `e26a9c7be`: compact wire-v2 binding (release-key only, own purpose tag `flagship/pq-key-binding/v2`, drops the repeated ML-DSA key; TS, Rust and `installer/verify-box-artifact.sh` accept it; vectors `bindingsV2`, adversarial AT-ENV-21f-j, a size guard under 2,700 bytes). Per-release companions are 2,273-2,535 bytes. The pin: RELEASE_PQ_PIN, CA_LEASE_PQ_PIN (+ the webapp's hand mirror in maintainerTrust.js, which `pin --ca-lease` now updates), box-artifact trust `pq`, the Kotlin/Swift/webapp key-id lists; marker = `dbdf2e08` (the last release signed before the pin). MISTAKE FIXED: my commit `a550f49a0` had swept in the owner's PIN-reset endorsement for `d39ea287` (a signed classical endorsement of a non-final commit) and pushed it; the ceremony then took it as the marker. Removed the file and re-pinned the marker to `dbdf2e08` (the file stays in git history on origin/release/0.3; it is refused under the pin, nothing was deployed). After the pin ~35 tests assumed nothing was pinned: classical-only fixtures now run against an explicit unpinned state (new `pqKeyIds`/`pqPin`/`caLeasePqPin` options on the webapp notice lib, relay verifier, Kotlin/Swift notice centers; the box-artifact CLI now reads the trust file's `pq` and the manifest's `pqBindings`); full suite 14,939 passed, Rust workspace, Kotlin and Swift notice tests green. Webapp shell v184. STILL TO DO for PQ: the release run must PQ-sign the final endorsement (`endorse-release.mjs --to <final sha> --sign`: PIN + touch three times), `sign-ca-lease` / `sign-box-artifact` for new leases and artifacts, and the retro-sign `--pq-only` is NOT needed (dbdf2e08 is the marker). The live gym still has to run with the pin in place.
- 2026-10-27 (resumed session): arch-v2 ON PODMAN BLOCKER and DECISION B. After the Debian 13 fixes (gym on Debian 13 `c294a1d03`..., `User=root` dropping CAP_SETUID `c294a1d03`, iptables `b4b3ac3d3`, privd 'slow down' retry `e5512d997`, gym-only CA/box-artifact pins, VM helper hardening, classic pass now really classic `929f48a0c`), the core gym on arch-v2 fails only at the app install: nothing answers on the published loopback port. Cause (live box): the daemon-owned bridges are `mode=unmanaged`, so netavark configures no port forwarding, `-p 127.0.0.1:h:c` forwards nothing. OWNER DECISION: option B (keep unmanaged bridges, the daemon dials containers directly through one endpoint resolver, identity = container generation). Design: `docs/architecture-v2/app-endpoints.md` (inventory, resolver properties, existing-user track, launch gate). Classic (Docker) on a NEW Debian 13 box also fails (install 500) and is unresolved; existing boxes stay on Docker. Nothing of B is built yet.
- 2026-10-27 (resumed session): DECISION B BUILT (unit-tested, NOT yet proven live). Design settled after the owner's/advisor's review (`docs/architecture-v2/app-endpoints.md` section 3a): lookup key = service + env + component + role; identity = generation (per deploy, rollback gets a fresh one) AND incarnation (container id + StartedAt); an address belongs to a SERVICE for its life (address-reuse fence: a stale dial can only reach nothing or a later incarnation of the same service), freed only on delete after a 60 s quarantine. Code: `packages/server-daemon/src/endpoints.ts` (EndpointTable with leases registered before dialing and destroyed on invalidation, AddressPool, typed `parseObservation`, `publishFromEngine` that publishes only the container the daemon created (service label, generation, running, network, address), EndpointReconciler that follows engine restarts/deaths every 3 s); `serviceRunner.ts` (Podman: `--ip <service address>`, `--label flagship.service/generation`, NO `-p`; Docker keeps `-p` and loopback through the same table); consumers moved: reverse proxy + WebSockets (`appConnection.ts`: 503 when unavailable, WebSockets closed on invalidation), readiness (`tableAnswers`, per incarnation), staging check_app, local AI (`localAi/service.ts`), dedicated databases (`dataLayer/dedicated.ts`: address, labels, admin URL and the gateway link target from the table; an unlabelled container from an earlier Docker release is accepted as the service's own), app groups (each member has its own component entry + address; links target the member's address), WASI http-proxy workers (loopback entry). Both brokers (privd TS and the Rust broker) now accept `--ip` and the two endpoint labels on a dedicated-database run (tests on both). Daemon suite 3,826 passed. TO PROVE LIVE (gym): that Podman 5.4 honours `--ip` on an `unmanaged` bridge, that the daemon user's direct dial works for every consumer, the negative isolation tests, restart/reboot/replacement/IP-reuse/concurrent-install lanes. KNOWN FOLLOW-UPS: the broker should check `--ip` lies in the named network's subnet and is not its gateway (shape only today); the engine events could replace the 3 s reconcile poll; a local-AI `lease` hands out a base URL, so an in-flight fetch is not tied to the lease (safe by address ownership, not by cancellation); classic (Docker) on a NEW Debian 13 box still returns install 500 (owner: little operational value, new boxes are arch-v2; existing boxes stay on Docker and are covered by the existing-box lanes).
- 2026-10-28 (resumed session): FIRST LIVE PROOF of decision B on a real Debian 13 + Podman + gVisor box (kept gym box, then torn down). Proven: Podman 5.4 honours `--ip` on the `unmanaged` bridge; the app runs with no published port at its service address (10.89.2.x) and the daemon user dials it (200); the reverse proxy serves it over HTTPS (corewho.home.<user>.gym.flagship.services 200 x3); a reinstall got the NEXT address, not the freed one (quarantine); a killed container answers 503 at once (fail closed); after a daemon restart the app is back (~2 min, see below). Negative isolation (manual probes with a throwaway gVisor container on the apps bridge): app B cannot reach app A:80, cannot reach the gateway's SSH port, its internet request is refused by the egress proxy (403), and Podman's own IPAM refuses a second container on A's address. NOTE: the apps can reach the core Postgres port through the gateway (5432 open) by design (their data layer, per-app roles). WHAT BLOCKED CORE: the install returned 500 after the container was already running. Cause (found after the 500 handler began logging the real error, `controlHttp.ts`): the legacy `addOwnerToMembership` path signs a membership record with the BOX key; keyd (TS and Rust) refuses `flagship/membership/v1` on purpose, so every install through that flag failed under keyd. That was also the classic-on-Debian-13 "install 500" (same keyd). FIXED: the install reports `ownerMembership: false` and succeeds (the old membership log no longer decides access). Core is then 22/23 (the 23rd was this). OPEN: (1) the daemon needs about 2 min 15 s to start the runtime after each restart ("browser bundle disabled: connect ETIMEDOUT 172.31.250.2:9222" stalls it; the first core run's checks fired before ServicePlatform was ready, hence 'ServicePlatform not configured' + 404s): fix the stall (do not wait on the browser) and make the harness wait for ServicePlatform; (2) the Worker-CPU fleet check is red on the gym Worker (Free-plan 10 ms) and is not a box issue; (3) a `stack-switch` live group was written (`groups/release03/stackSwitch.ts`, needs a classic pass: `GYM_BOX_STACK=classic ... --groups stack-switch`); not run yet; (4) design gaps vs the owner's review: broker returns a typed record (today the daemon parses `inspect` itself), boot-time pool check against the engine, broker `--ip` subnet check. Next: full arch-v2 gym, then the classic pass with stack-switch, then load/resource tests.


- 2026-10-29 (resumed session): LIVE TRIAGE ON A KEPT ARCH-V2 BOX (Debian 13, Podman 5.4, gVisor; focused groups with `--reuse ... --keep`; fixes hot-patched into the box's dist, then committed). FIXED and proven live: (1) the daemon runs with `umask 0077`, so app sources and WASI configs were 0600 and unreadable to the app's own user: python/node/static now build from a host-side context (`openContextForApp`), WASI `writeAtomic` chmods explicitly (runtimes group fully green; wasi-apps 13/13); (2) the apps gateway accepts a container address on the apps bridge as an owned-port target (group links, dedicated DB); (3) Podman `volume create` is not idempotent (model delete 500): tolerated; (4) LOCAL AI start failed with no log: `checkLocalAiRunArgs` rejected the staging resolver bind mount (`/run/flagship-daemon/flagship-resolv-*.conf`) that both brokers already allow, and the check ran outside the logged block. Fixed and logged; local-ai group 14/14 incl. "108 tok/s measured" and delete. (5) a deploy whose `podman run` fails left a `Created` container holding the name and address (next install: IPAM "already allocated" / "name in use"): now `rm -f` on failure. (6) BIG ONE: the daemon only built the per-app disk-image volumes (`LoopVolumes`) when `getuid()===0`; on arch-v2 the daemon is the unprivileged `flagship` user, so per-app disk limits AND the dedicated database profile (which needs the loop volumes) were silently off (`profile: shared`). The broker path (`privdLoopHost`) already existed; the gate in `runtime.ts` now also allows `runsUnprivileged()`. FIXTURE: `app-groups-db` started the whoami member with `/whoami` twice (the image's entrypoint is already `/whoami`), so it listened on 80 not 7000: fixed; the group now uninstalls its own leftovers first. TO RE-PROVE after (6): app-groups-db, quota, backups, archive/app-copy on a fresh box in the full gym. Debug SSH key and Worker secret still to delete when debugging ends (`~/.ssh/gym-debug*`, `wrangler secret delete UPCLOUD_SSH_PUBLIC_KEY --config wrangler.gym.toml`).

- 2026-10-29 (resumed session, later): MORE LIVE FINDINGS ON THE KEPT ARCH-V2 BOX, ALL FIXED AND COMMITTED (hot-patched into the box, then proven): (1) the daemon ignored SIGTERM (listeners replace Node's default exit and the servers keep the loop alive), so systemd waited its 90 s and killed it on every restart/update: `exitSoon` in `wireShutdownHooks` (restart now ~2 s); (2) the address pool forgot what it had given out after a restart, so Podman refused an install ("requested ip address is already allocated"): the pool is seeded from the engine (`seedFromEngine`: owner from container name + service label, `AddressPool.adopt/occupy`); (3) the dedicated-database URL was rewritten twice (once in the WASI host call, once in `realPgConnect`) and the second rewrite sent it to the SHARED server ("password authentication failed"): one rewrite, through the endpoint table (`registerDedicatedPort`/`loopbackPgUrl`), and the daemon waits until the instance answers on its address; (4) a dedicated database's MIGRATION could not reach it: the sandbox shared the instance's Unix-socket volume, but a socket made inside gVisor is not visible to another sandbox. NOT fixed by weakening gVisor (`--host-uds=all` works but was refused as a sandbox weakening; owner may revisit). Instead the migration runs as a member of the app on the apps network and reaches the instance through the gateway's owned port, like the app does (`buildSandboxPlan` `member`); the gateway's forwarder now re-reads the bridge for a source it has not seen (a container that just started); (5) THE BIG ONE: the Rust broker answers one request at a time per connection and the daemon used ONE connection, so a long call (a 5-minute migration, a build, a dump) froze every other broker call (reconciler, installs, health). `PrivdClient` now spreads calls over up to 8 connections; (6) a deploy whose run failed left a Created container (rm -f on failure); (7) `quota` group: a dedicated database has no role budget (its bound is its own volume), so the DB budget/INSERT-refusal checks are skipped with a reason on the dedicated profile (new boxes); the files budget, ENOSPC, full/Activity and free checks pass live. Results on the kept box: local-ai 14/14, wasi-apps 13/13, runtimes green, app-groups-db 7/7, quota files checks green. STILL OPEN: gating identity headers/role (not re-run), share/remote session scope, tier-2 certs under keyd, update (no endorsed release), first-contact, lifecycle timing, AT-LIVE-19, cloud gossip key (the gossip broadcast host has no TLS terminator: "fetch failed" every 45 s), gpu-sim quota, browser group (no Chromium). Next: tear down the kept fleet, run the full arch-v2 gym on a fresh tip (`GYM_STACKS=arch-v2 bash scripts/gym-release-run.sh`), then classic stack-switch, then load/resource tests. Reminder: delete `~/.ssh/gym-debug*` and the Worker secret `UPCLOUD_SSH_PUBLIC_KEY` when debugging ends.

- 2026-10-29 OWNER DECISION (gVisor sockets): keep the gateway route for a dedicated database's migrations; do NOT enable `--host-uds=all` just to support migrations. If sockets ever need to be shared between sandboxes, that is a separate design decision: name the exact socket, limit which sandboxes can reach it, and check whether gVisor supports a sufficiently narrow permission first. (The migration sandbox already runs through the gateway as a member of the app; the older socket-volume path stays for Docker/classic only.)

- 2026-10-29 (resumed session, evening): FIRST FULL ARCH-V2 GYM on a fresh tip (`release-20261029T170950Z-arch-v2`, box artifact `00baa32a089d`): 46 groups, 339 passed, 34 failed, 11 skipped; exit 1. WHAT THE 34 ARE, grouped: (A) HARNESS MISMATCHES with the 0.3 design, fixed in the gym groups: `share` and `remote` assumed a co-manager/companion session reads `/api/screens/*` (the one authorization layer, SEC-AUTH-002, gives a share session `/api/shares/*` only and denies companion writes before the handler: `route-not-allowed-for-session`) and listed a remote session by a token prefix (the box lists the SHA-256 of the token); `origin-generation` sent `sec-fetch-mode: navigate` through Node's fetch, which replaces it with `cors` (now node:https); AT-LIVE-19 signed the journal read with the IRK on an admin-pinned box (admin root); AT-LIVE-13 read the gateway's pre-handshake close (it intercepts every :443 connection) as "connected"; gpu-sim's tarball lacked `packages/protocol/test-vectors/gpu-approval` that the Rust test includes. (B) REAL BUGS FIXED: keyd's migrate read the admin root from `authCode.adminRootPubHex` but the signed AuthCode carries `adminRootPubKey` (what the daemon reads), so keyd's `owner.json` held no admin root and keyd could never sign `master` (every admin device and every admin-ordered master was asserted manager: invites DEFAULTS/SECOND ADMIN, gating rank→master); the box also stored no proof of an admin-ordered rank (keyd accepts `flagship/app-rank/v1` evidence), now kept with the order (`roles.evidence`) and offered to keyd; a Podman IPAM collision on a fresh box (a container the pool did not place, e.g. a migration sandbox, held an address): the deploy now retries with another address when the engine names the one that is taken. (C) OPEN, NOT FIXABLE IN THE BOX: the relay terminates no TLS for `broadcast--<user>.<apex>` on :443 (curl: connection dropped), so gossip POSTs fail ("fetch failed" every 45 s) and no box learns who leads: `app-names` and `named-links` canonical-address checks cannot pass (they now SKIP with that reason via `relayTerminatesBroadcast`); this is a `.services` (Fly) change, not a 0.3 launch claim (release notes do not promise canonical app addresses). `migrate`'s "home's app serves on home's name from home2" fails with TLS alert internal error: a box with the TLS key in keyd issues no tier-2 certificate (`[runtime] tier-2 service certificates are not issued while the TLS key is held by flagship-keyd`): OWNER/SECURITY DECISION needed (keyd would need a CSR/issuance op for per-service keys). (D) STILL TO REPRODUCE LIVE: access-lists (no access request recorded, approved host still unresolvable inside the app), chat-cross-owner (app not listening within 180 s), one-list restart/power-off answer 500 `internal error` (the handler now logs the cause), share "knock as co-manager: role=null" (probably the external-freshness checkpoint). (E) INFRA/ORDER: first-contact hit the UpCloud 32-core quota (the run holds A1..A3 + B1..B3 + a build VM), update (no endorsed release for a gym box), lifecycle decommission 12.7 min vs 10, browser-grants (no Chromium: `appBrowser` must ship false, release/box-release.json), stack-switch (needs the classic pass). Next: a second refresh (new artifact with these fixes) is building; then a focused kept run of the groups in (D).

- 2026-10-30 (resumed session): FULL ARCH-V2 GYM 3 (`release-20261030T100246Z-arch-v2`, artifact `ad520a501c22`, after fixes): 399 passed, 16 failed, 14 skipped (gym 1: 339/34, gym 2: 323/26). REAL BUGS FOUND AND FIXED THIS ROUND: (1) THE EGRESS RESOLVER FILE (`/run/flagship-daemon/flagship-resolv-*.conf`, bind-mounted as every app's `/etc/resolv.conf`) was 0600 (the daemon's umask 0077): an app (uid 10001) could not read it, fell back to 127.0.0.1 and could not resolve ANY name, so no egress request ever reached the filter and approved hosts stayed unreachable (access-lists): now chmod 0644 after the write; proven live on a kept box (an app's `getaddrinfo` now answers from the filter, an approval opens the host, a deny closes it). Same umask family as the earlier python/node/WASI findings. (2) `/api/power` 500 on every restart/off: the unprivileged daemon cannot write the one-shot lock marker `/boot/flagship-lock-once` (EACCES); the same call sat under the decommission's lock-and-power-off (lifecycle: a decommissioned box never stopped) and every Lock and restart. NEW broker host op `bootlock` (fixed script, both the Rust broker and TS privd, shared corpus regenerated, Rust conformance green) used by `BootUnlockModeSuppressor` when the daemon is unprivileged; a marker that still cannot be written turns a restart into a shutdown (never a reboot into an unrevoked lease). (3) keyd checked the owner's master evidence against the MEMBER ID key (an account device's member id is derived from the owner's AID, so the device grant naming the device key never matched): `signInPubHex` carries the key that signed in (TS + Rust keyd, protocol check, new tests); keyd also now pins the admin root from the AuthCode's `adminRootPubKey`. The box now logs why it asserted manager (`[identity] <app>: keyd did not sign master (...)`) because invites DEFAULTS/SECOND ADMIN still fail on the artifact that had (3): the reason will be in the next run's journal. (4) freshness checkpoints renew at once on install/redeploy (an invitee was refused for up to a minute after an install); (5) Podman IPAM retry; dedicated DB migrations through the gateway; broker call pooling; (6) harness: one-list moved to the LAST phase (it powers `home` off; later groups saw "A1 not online"), writes are never re-sent after a timeout (a re-sent POST made "You already have a service called…"), stale installs are re-signed, delete tolerates already-gone, backups key count and quota tick relaxed. STILL OPEN: invites master (above), first-contact enrollment proof (the daemon cannot read the root-only install blob for `enrollmentKeyHex`? check perms on a live box), one-list "home2 is back: not within 600 s" after a restart (first real reboot of an arch-v2 gym box: needs a look at the console/journal after reboot: REBOOT LANE OF THE LAUNCH GATE), migrate (home2 attach "initiated" after 8 min, then tier-2 certs under keyd), share update verdict (needs an endorsed release), update (no endorsed release), local-ai-cpu and gpu-sim (UpCloud 32-core quota), named-links gossip (relay), browser (ships off). NOT RUN YET: classic stack-switch pass, load/resource tests, full gym twice.

- 2026-10-30 (afternoon) OWNER DECISIONS: (1) URLs carry meaning: `app.server1` is answered by server1; so NO per-service certificate for another server's name (Migrate does not make a server serve a retired name it was not given). The canonical `app.user` / `app--author.user` addresses and the voi.ci shortlink must still work (a leader emerges quickly). (2) NO relay/Fly broadcast for gossip (it would let the relay see traffic between a user's boxes): every box listens on its own `server.user` URL (the harness itself) and boxes gossip directly to each other there; a foreign app reaches another user's app only at the canonical `app--author.targetuser`, and the leader decides what to share with its siblings. CONFIRMED in code: cross-owner chat addresses `receiverAuthor` + `receiverApp` + `targetUser`; there is no way to target a specific server of another user (chat/system.ts: the box the relay routes the canonical name to). (3) The app browser must work. FOUND AND FIXED: gym boxes had no Chromium because `app-browser.compose.yml` used a tmpfs `uid=1000` that Podman refuses (container create failed; the compose provider swallowed it); now `mode=1777`; proven live: the browser bundle is online over Podman and `browser-grants` is 7/7, so `appBrowser` ships ON. ALSO FOUND: Migrate's "serves on home's name from home2" failure was NOT a tier-2 certificate problem: the replacement takes the retired server's NAME through the owner's signed entitlement, but keyd's `policy.json` (which names it may make certificates for) stays the name the box was built with (`home2`), so keyd refused the new name's certificate ("that name is not one this box may have a certificate for"). NEW keyd op `policy.rename` (TS and Rust, tests in both): keyd takes the new name only from the owner's signed `flagship/root-entitlement/v1` for ITS OWN key, inside the same account zone, persists it and allows certificates for it; the daemon hands it the entitlement at load. App tokens (chat, SDK) no longer need the browser bundle. TO DO FOR (2): gossip transport direct to siblings' `server.user` URLs (replacing the Fly broadcast hub) so leaders emerge, canonical addresses and voi.ci work, and app-names/named-links/chat-cross-owner can pass.
- 2026-10-30 (resumed session, owner replies): (1) TEMPORARY RELEASES MAY BE ENDORSED to test updates: use the gym's own throwaway key K (public, committed; `gymTrustMaterial.ts`, pin on the gym branch) for gym boxes, never the prod YubiKey; plan: build the update group's box from the gym branch, endorse two temporary gym tips with K, update between them (+ a failed-health rollback case). NOT built yet. (2) UPSTREAM-SYNC FIXTURE: a tiny public Flagship-ready app repo with two refs (v1, v2) is pure test input: code, not a vouching store and not marketplace infrastructure. Owner: a data-only repo under ibisllc is fine; if it stores code (marketplace precursor) an open-source git server is needed first. Decision pending on which this is (it is a few files of app code). (3) GPU: no extra gym scaffolding; ONE mega hardware run (`gpu-real.sh mega`, runbook step 7b) combined with the owner's phone + Studio + USB-boot + NVIDIA PC sitting. UpCloud GPU quota is 0 (needs support) so no cloud GPU run for now; gpu-sim passed live (91/0). (4) OWNER EXPECTATION: the box harness (daemon) moved to Rust. STATUS: it has NOT. `packages/server-daemon` is 113k lines of TypeScript and still the production daemon; Rust owns keyd, broker, tlsd/ingress, boot, relay codec, wasi worker, gpu; `flagship-core` is 1.5k lines in shadow mode (R02 in progress). The plan lists the Rust core as required, so this is the largest open scope item.
- 2026-10-30 (resumed session): FULL ARCH-V2 GYM 4 (`release-20261030T154619Z-arch-v2`, artifact `ddfc79f84cdf`): 457 passed, 15 failed, 9 skipped, 46 groups. GREEN NOW: invites 16/16 (master/manager/second admin), migrate 10/10 (keyd rename), lifecycle 7/7 (bootlock), gpu-sim 95/0 (flagship-gpud self-test under Podman), browser-grants 7/7 (browser verdict pass; appBrowser can ship true), access-lists 7/7, app-groups-db, wasi-apps, local-ai 12/12, adversarial 21/21, gating, core 29. FAILED, WITH CAUSES: (1) named-links x2, app-names x2, chat-cross-owner x3: ROOT CAUSE FOUND (relay): the hub's allocator rejected every claim for `<app>.<user>` unless the name derived from a canonical the box registered; under the per-box wildcard a box registers no per-app canonicals, so every claim was silently refused and the visitor was parked until the hold timeout (hub log `hold timeout, dropping parked stream`). Direct gossip itself works (frames both ways, `claim route` logged, tlsd serves the wildcard cert for the canonical name). FIXED in `apps/web/src/tunnel/allocator.ts` (a box may claim exactly one label under its OWN user zone; other zones, deeper names and wildcards still refused; tests updated); needs a Fly deploy of the gym hub (gym-refresh without --skip-fly-deploy) and then a rerun. (2) one-list x2: not a box bug. A gym box has no boot worker, so Lock-and-restart is a shutdown by design (never reboot into an unrevoked lease) and nothing powered home2 back on; the harness now starts the VM through UpCloud after the restart order. The real "restart comes back at the phone prompt" path is only provable on hardware or a LUKS gym box (hardware sitting, runbook step 1/2). (3) first-contact 1: no `enrollmentProof` in the first request although `/boot/install-blob.json` held the secret and `enrollmentDeviceInfo` builds the proof from that file when run by hand as the flagship user. CAUSE NOT PINNED (fleet was torn down): the blob read now retries on EACCES and every empty result logs `[enrollment] no proof: <why>`; read that line next run. (4) share 1 / update 1: no endorsed release on a gym tip (owner OK'd temporary endorsements; plan: endorse an ancestor of the gym tip with the gym's own key K, not built). (5) stack-switch: needs the classic pass. (6) local-ai-cpu: UpCloud 32-core quota. (7) fleet 1: Worker CPU against the Free-plan 10 ms; production is on Workers Paid, so `gym-release-run.sh` now defaults WORKERS_PLAN=paid. SKIPPED: gpu-real (no GPU host), release-catalog (no pinned root), upstream-sync (default repo now https://github.com/ibisllc/flagship-sync-fixture, public, v1/v2, created 2026-10-30), activity/quota partial (reasoned skips). Hardware: ONE mega run (`gpu-real.sh mega`, runbook step 7b).
- 2026-10-30 (resumed session, later): RUST MIGRATION PROGRESS (plan section G; all committed on release/0.3, none proven on a box yet). G1: `rust/crates/flagship-updater` (verifier, bounded tar.gz extractor, durable intent journal, atomic switch/restore, boot guard, CLI with the shell installers' flags and exit codes; 70+ tests, clippy -D warnings clean); the broker and TS privd `release` op run it through a fixed launcher (`RELEASE_LAUNCHER`, shared vectors regenerated) with the shell scripts as fallback; the artifact build pins it (`RUST_BINARIES`); the update guard hands over to a pin-checked `/usr/local/sbin/flagship-updater`. Cross-compiling for Linux is NOT possible on this Mac (ring needs a Linux C sysroot): the first Linux build of the new crates is the next gym artifact build, so a compile error there would show in gym 6's step 4b. G2: `release/runtime-lock.json` (Node 24.22.1, real digests of both tar.gz and both executables, signer key 5BE8A3F6 by fingerprint, support end 2028-04-30, upstream key-list revision 481637f8); `flagship-updater runtime verify|install|status|manifest` with a digest-keyed offline cache; proven live against nodejs.org (download, PGP-signed SHASUMS256 via the Rust `pgp` crate, digest, extraction, executable digest all agree) and against Node's real signature; the artifact install refuses a bundled Node that is not the lock's binary (the artifact's Node, from the tar.xz, is byte-identical: e32e2d16...); signed runtime manifest (`flagship/runtime-manifest/v1`, TS + Rust verifiers agree on 19 shared vectors; `tools/box-artifact/runtime-manifest.ts build|sign|verify`; `pq-release-key.mjs sign-runtime-manifest`). STILL TO DO for G2: publish the signed manifest and a page at flagshipserver.com/runtime (needs the owner's YubiKey signing), the owner-facing verification view in the apps, a box API that runs `runtime status`. G9: `docs/architecture-v2/retained-typescript.md` (every retained TS surface: runs as, authority, secrets, runtime owner, patching). G5/G7 foundation: `flagship_crypto::entitlements` (RootEntitlement, ServiceEntitlement, revocation list, TunnelHello v2, ServiceGrant: canonical bytes, cert ids, strict Ed25519, grant window; byte-identical to TS on 18 vectors). G7 (Rust relay): own-zone claim fix mirrored in the allocator; `DirectoryAuthority` (the real HELLO check, TS order, fail-closed except revocation and eviction), `ComDirectory` (keys, signed revocations, STKs, eviction chain with the hub's TTLs), the outbound relay (destination policy on 50 host and 64 address TS verdicts, per-box budgets, credit-windowed splice, SSRF-safe dialling, totals-only logging, `ComHostPolicy`) wired into the hub (`outbound-v1` advertised only when configured). STILL TO DO for G7: the HTTP surface on the hub port (`/api/health`, `/api/stats`, `/pb/m/<id>` mailbox + announce/deliver), the relay blessing provider (hub key + `.com` blessing), a `flagship-relay` binary and Fly image, a gym canary with old boxes (mixed-version, reconnect, drain, rollback). Custom-domain pushes are Pro (feat/custom-domains) and gossip fan-out is dropped by the owner's decision, so neither is ported. CERT FINDING (an agent re-read of docs/cert-model-A-prime-migration.md, then checked live): the box's own certificate carries SANs [<server>.<user>, *.<server>.<user>, *.<user>] with its own key (keyd `namesFor`), which is what serves the canonical `<app>.<user>` address, so retiring tier-2 per-service certificates costs nothing; the box never receives a shared key.
- 2026-10-30 (gym 6 triage, arch-v2 pass): ROOT CAUSE of the share/core CA/relay-trust failures (`ca-gate: no-authorized-ca-keys`, maintainer-trust chain `authorized=false`, probably also the gating/invites member-identity failures): release/0.3 now carries a non-empty `CA_LEASE_PQ_PIN` (PQ ceremony landed), so a CA lease without a verified PQ companion gives no authority, and the gym's self-contained CA chain (key K) has no PQ companion. FIX (apply after the active run ends; gym files must not change mid-run): on the gym branch override `CA_LEASE_PQ_PIN` to empty (`keyIds: []`, `legacyLeases: []`) in `packages/protocol/src/caLeasePq.ts`, or generate a gym PQ companion; then rerun. Also: a leaked 8-core `box-artifact-*` UpCloud VM from an earlier failed run pushed the account over the 32-core quota (first-contact, gpu-sim, local-ai-cpu failed); deleted by hand; the artifact script should destroy its VM on every exit path.
- 2026-10-30 OWNER DECISION (H3, phone routing claim lifetime): the relay's claim to route to a phone has no fixed expiry: the phone holds it indefinitely by a SLOW HEARTBEAT; after about 2 minutes with no beat, routing stops (fail closed). Implementation notes: beats are signed by the phone and carry the claim generation (a higher generation from the same phone, e.g. after a network change, supersedes at once); the relay drops the route on the 2-minute silence, and a holder that misses beats must re-claim rather than resume; beat interval to be chosen well inside the window (proposal: 30 s, so three misses end it).
- 2026-10-30 OWNER DIRECTION (H3, refined): no separate heartbeat and no per-beat signatures. The existing authenticated tunnel connection (wss, long-poll fallback with a setup-minted session token) carries liveness: the relay pings and requires an answer, an unsigned app-level beat on the same socket carries the revocation sequence number (replies carry the `.com`-signed changes), and about 2 minutes of silence ends routing (fails closed). Signatures stay only where they bind authority once: the claim and handover (generation + phone key), the claim record on `.com` for multi-relay exclusivity, and signed leases/revocation entries. Revocation reaches a connected phone within one beat interval (proposal 30 s).
- 2026-10-30 OWNER DECISION (H4, offline grace / dead-man): the grace is enforced by the box losing the authority to get a certificate. Before `.com`/the issuance service lets issuance happen it must see a signature from an admin phone: "the box bearing this signature may mint certificates on my account until date X". X is the dead-man. While the phone is online it re-signs about once a day with a new X (grace window ahead of now: one week / 30 days / indefinite per the owner's setting). So the renewal credential is the phone's signed authorization, not a secret the box holds (settles H4 renewal credential), and the clock is the issuance service's own (not the box's). OPEN consequence: a box keeps serving on its current certificate after X until that certificate expires, so the real stop is min(X, current certificate notAfter); a one-week or one-month window needs certificates no longer-lived than the window (short-lived certificate profile) or the stop is late.
- 2026-10-30 OWNER REFINEMENT (H4): "one month" is replaced by 30 days everywhere (grace options: one week, 30 days, indefinite). Boxes obtain and renew their own certificates themselves, and only close to expiry (not early, to avoid hammering Let's Encrypt; the issuance service refuses an order made before the renewal window opens, so a box cannot spam the CA). What the phone re-signs about daily is the PERMISSION certificate: it grants the box the right to renew until X. The box renews only if a valid, unexpired permission exists at the moment its renewal window opens. Consequence still to settle: the stop is the first renewal after X, which is the current certificate's expiry minus the window; with 90-day certificates a 7- or 30-day grace is not binding, so certificate lifetime (short-lived profile) must be no longer than the shortest grace for the dead-man to mean what it says.
- 2026-10-30 OWNER DECISION (H4, option B): normal certificate lifetimes (no short-lived profile); the box mints for as long as the lease in its phone-authorization allows; the dead-man grace options are therefore set larger than the certificate/renewal window (values to confirm; see below). CODE AUDIT (what exists today, read from `packages/control-plane/src/dns01.ts`, `packages/server-daemon/src/{serverWildcardGrant.ts,acme/letsEncryptIssuer.ts,acme/grantedAccountKey.ts}`): (1) A box's DNS-01 publish for its OWN name (`_acme-challenge.<server>.<user>`) is checked only for the box identity-key signature, freshness (5 min) and "server not revoked": NO phone permission and NO expiry. (2) The user-zone wildcard needs the admin's `server-wildcard-grant/v1`, which is once-per-server with no expiry (`issuedAt` only). (3) Tier-2 service-cert authority (1 h) is being retired. (4) The box holds the ACME account key (sealed grant, or self-generated) and the issuer falls back to TLS-ALPN-01 for NON-wildcard names, which never touches `.com`. So today's `.com` DNS-01 gate is the right chokepoint but is not yet a permission check, and non-wildcard names bypass it. To reuse it for the dead-man: add the phone-signed permission with `notAfter` X to every DNS-01 publish (own name included), check X against `.com`'s clock, and close the ALPN bypass (apex CAA `validationmethods=dns-01` plus `accounturi` pinned to the service-held ACME account, or the issuance service of H1 holding the credentials).
- 2026-10-30 OWNER DECISION (H4 final shape): dead-man grace options are 30 days, 90 days, indefinite. Design: a box must present the admin-phone-signed permission whenever it wants a certificate, and the dead-man is just a nullable `notAfter` (expiry) field on that permission (null = indefinite); the issuance gate checks signature, revocation record and `notAfter` against its own clock. Requirement that follows: EVERY issuance path must pass the gate (own name, wildcards, no TLS-ALPN-01 side door), enforced by apex CAA (`validationmethods=dns-01`, `accounturi` = the service's ACME account) and/or the H1 issuance service holding the ACME credentials.
- 2026-10-30 (owner pointed at `/Users/harrywinner/flagship/CONTROL-ENDPOINT-IMPLEMENTATION-SPEC.md`; read in full; NOT yet folded into the plan, file kept): it answers the dead-man/SSL questions. Answers taken from it: (a) the control exception: a registered, unrevoked box keeps its EXACT control name (route + control certificate) after its phone-renewed app-serving lease expires; app routes and app certificates stop; explicit owner revocation removes everything, recovery included. (b) Enforcement is the RELAY's, not certificate lifetime: the relay stops admitting app streams at lease expiry, closes existing app streams within 5 s, removes the box from canonical-app allocation and failover; app-certificate validity need not equal the lease. This removes the short-lived-certificate concern (options A/B) entirely. (c) Revocation: committed revocation advances a status revision; the relay needs a fresh (<=60 s, refreshed every 20 s) central status assertion per box, fails CLOSED, push on revoke; observable disconnect within 65 s; a control-plane outage interrupts recovery (stated cost). The existing revocation list fails open, so it cannot be the sole mechanism. (d) Renewal credential: a narrowly delegated renewal key bound to the policy generation (cannot add boxes, broaden scope, extend past grace, alter policy or undo revocation); indefinite is an explicit representation, not an overflow timestamp; monotonic deadlines. (e) Issuance: the H1 service owns the ACME account and all orders, derives names from trusted state, centrally performs DNS-01 for control, app and phone classes, rechecks authorization before finalization, enqueues CA revocation if a race still issues; separate control and app certificates/keys; apex CAA `issue`/`issuewild` pinned to the service account with `validationmethods=dns-01`, zero per-account CAA (this resolves the CAA-vs-per-user-account conflict). (f) Names: phone name never to boxes; control cert exactly the control name; app cert an approved subset of `*.server.user` and `*.user`; reserve control names in the route allocator. (g) Tests: 10 acceptance scenarios and malicious-app tests in sections 8-9. DIFFERENCE TO RECONCILE: the spec's grace choices are 7 days / 30 days / indefinite; the owner said 30 days / 90 days / indefinite.

- 2026-10-30: folded CONTROL-ENDPOINT-IMPLEMENTATION-SPEC.md into the plan as Appendix I and items H4 (rewritten), H8, H9 (new), H6 (extended); grace is 7 days / 30 days / indefinitely (owner); the spec file was removed. Settled by it: relay-enforced app lease with a surviving exact control name, central status assertion (60 s, fail closed, 65 s revocation), delegated renewal key, service-owned ACME account with DNS-01 and apex CAA pins. Still open for H: whether control-plane outage may interrupt recovery (spec says yes, the stated cost), the owner-facing wording, and numeric defaults (status 60 s/20 s, stream close 5 s, revocation 65 s).
- 2026-10-30 OWNER DECISIONS on the open list: (10) R5 stays out of 0.3. (11) DO ALL the Rust refactor that has been requested now (plan G, G3 to G10, in the plan's order; the daemon remains TypeScript where G does not move it; every item is proven by its own tests, then on a box through the gym). (12) GPU now: finish everything that can be done without hardware so the owner can run `gpu-real.sh mega` (runbook 7b) on their physical device. (13) The owner is requesting a higher UpCloud core quota; meanwhile work around the 32-core limit (fewer concurrent cores per gym run, groups that need extra VMs run after the fleet is torn down, artifact VM always destroyed). (14) REMIND THE OWNER, at the end of dev/testing, to delete the debug SSH key (`~/.ssh/gym-debug*`) and the Worker secret (`cd apps/com && npx wrangler secret delete UPCLOUD_SSH_PUBLIC_KEY --config wrangler.gym.toml`); remind again when the two clean gym runs are done.
- 2026-10-30 G3 step 1 (Rust core): `flagship-core/src/endpoints.rs` is the Rust twin of `endpoints.ts`: endpoint table with leases and generation/incarnation, drain on stop, invalidate by service/env/component; address pool with quarantine, adopt/occupy/vacate; typed container observation and `matches_expected`; `publish_from_observation`; `EndpointReconciler` following the engine (restart = new incarnation, stop/gone = invalidate); `next_generation`. Shared vectors `packages/server-daemon/test-vectors/endpoints.json` (26 cases) pass in BOTH `endpointVectors.test.ts` and `tests/endpoint_vectors.rs` (+3 reconciler tests); clippy -D warnings clean. NOT wired to anything yet (shadow module). Still open in G3: resource scheduling/admission, container + local-AI lifecycle through the broker, desired-state persistence with adoption on restart for the endpoint table, shadow comparison against the TS controller on a box.
- 2026-10-30 G5 step 1 (Rust core): `flagship-core/src/access_journal.rs` is the Rust twin of `accessJournal.ts`'s rules (entry shape check, key, supersession incl. a share's final end, stable-JSON hash, per-app digest, caps, peers, load/lost semantics). Shared vectors `packages/server-daemon/test-vectors/access-journal.json` are WRITTEN by the TypeScript implementation (`UPDATE_ACCESS_VECTORS=1`) and pass in both languages (+ cap and load tests). Signature verification, rank/admin authority and replay protection are NOT ported yet (that is the rest of R4: the verifiers for rank/mode/remove/join/accept/withdraw/share entries, `serviceAccess.ts` 2.7k lines). This module deliberately does not trust the supplying box: nothing reaches `add` unverified once the verifiers exist.
- 2026-10-30 G5 step 2 (Rust crypto): `flagship-crypto/src/access_orders.rs` ports `appAccessOrders.ts` (app-rank/v1 with all five target kinds and the refused-only-for-device/share rule, service-access-mode/v2, service-allow-remove/v2, restored-access-approve/v1): canonical bytes through the strict v1 builder and strict-Ed25519 verification; the shared `app-access-orders` vectors (signatures made by the TypeScript signer) verify in Rust, with tamper and refusal cases. Still to port for R4: the invite entries (create/redeem/accept/withdraw), the share grant/revoke/leave, and the box's classification of sign-in keys (principal, rank, master evidence).
- 2026-10-30 G5 step 3 (Rust crypto): `flagship-crypto/src/service_invite.rs` ports the invite messages (create incl. `maxN=`/`exp=` suffix rule, redeem, accept, revoke, secret hash). New shared vectors `packages/protocol/test-vectors/service-invite/vectors.json` written by the TypeScript signer (`npx tsx tools/service-invite-vectors.ts`); signatures verify in Rust, the caps are proven to be part of the signed bytes, refusals (separator/control characters, past-safe-integer numbers) hold. With step 2 and the journal rules (step 1), the entry verifiers for rank/mode/remove/join/accept/withdraw are now buildable on top; the share grant/revoke/leave (`serverShare.ts`) and the box's key classification are still to port.
- 2026-10-30 G5 step 4 (Rust crypto): `flagship-crypto/src/server_share.rs` ports the share envelopes (grant, revoke, accept, leave, accept-admin) with the label rule narrowed so JS and Rust agree on "trimmed"; the shared `server-share` and `server-share-accept-admin` vectors (signed by the TypeScript implementation) verify in Rust, including the refusals and every rejection (wrong signer, escalated level, moved server, replayed accept as leave). Share session/offer/list/unlock/inbox/push/update envelopes are not ported yet.
- 2026-10-30 G5 step 5 (Rust core): `flagship-core/src/access_entry.rs` is the authority half of `applyEntry`: `verify_entry(entry, serviceRef, trust)` returns Refused / Skipped (rank orders belong to the rank applier) / Verified{kind facts}. The trust (admin signers, invite-create signers with tiers, installed apps) is the box's OWN state, never the supplier's. Shared verdicts `packages/server-daemon/test-vectors/access-entries.json` are written by the REAL TypeScript applier on a fresh box (`tests/accessEntryVectors.test.ts`, 26 cases incl. IRK refused on an admin-pinned box, stranger, wrong app, tampered time, redeem/accept signed by the wrong key, secret mismatch, uninstalled app, share end by leave/revoke and by impostors); all 26 agree in Rust. Applying (allow-list, caps, later removals, creator standing, withdraw by creator) and the rank entries stay with the TypeScript store for now. This completes the "authority contract" the plan wanted before any migrated effect goes live: next is enforcing at the effect boundary (the proxy deciding on a session, G4/G5), not yet started.
- 2026-10-30 G9 step 1: `docs/architecture-v2/ts-execution-surfaces.md` is the execution-surface inventory (box processes, hosted services, clients/tools) with run-as user, authority, secret reach and patch path for each. It names three gaps: the daemon, TS broker and TS keyd share one Node (the daemon is not `--jitless`; unprivileged-runtime qualification is open); `flagship-tsx` is a runtime TS loader used once at install; no reproducible-build comparison or isolated owner build yet. G9's other items (lock/frozen installs/SBOM) already exist partly in the artifact build; the Node-hardening and owner-build items are open.
- 2026-10-30 G6 audit (read, no code needed yet): the backup restore (`serverArchive/restore.ts`) accepts only regular-file entries whose names match a closed allowlist (`ENTRY_RE`: `manifest.json`, `apps/<slug--slug>/{meta.json,files.tar,source.json,module.wasm,db-N.dump}`), refuses duplicates, caps entries (4096), small entries (2 MiB) and total expanded size (512 GiB), writes each into a 0700 staging dir as the unprivileged daemon, and sends each part into typed engine commands; a files volume is restored by `tar -xpf - -C /data` in a throwaway container (no network, read-only root, all caps dropped except chown/dac_override/fowner/fsetid, only that app's named volume mounted, `assertNoHostPathInDockerArgs`). So traversal, links and exhaustion cannot reach another app's data or the host through the archive; the residual risk is inside the app's own volume (setuid bits are inert under no-new-privileges). Not yet done for G6: running that helper under gVisor, and moving the archive key operations behind keyd (they use the box's archive-key pool in the daemon today).
- 2026-10-30 G8 finding: `.github/workflows/rust.yml` already runs fmt, clippy -D warnings, tests, the gVisor registration and the Linux-only privileged-boundary tests on ubuntu-24.04 AND ubuntu-24.04-arm for every push touching `rust/**`, plus cargo-deny; it was FAILING at its first step (rustfmt) on every push of this branch (a formatting drift in keyd/broker tests and my new modules). Fixed by `cargo fmt --all`. Its next results are the first arm64 evidence for G8/G10.
- 2026-10-30 H step 1 (design, not code): `docs/architecture-v2/issuance-and-lease-records.md` turns the owner's decisions into PROPOSED signed record formats (serving-policy, renewal-key-delegation, serving-lease with nullable `notAfter`, status-assertion with 60 s validity, route-claim for the phone name, certificate-order) and the verifier rules (relay admission, lease expiry, revocation, issuance, no downgrade, liveness is not authority), each phrased as a test. It lists four open questions for the owner (who signs the status assertion; the relay's trust anchor for leases; custody of the renewal key; the route/cert scope listing format). No code for H until those are answered; the formats can then be built with shared vectors like G5.
- 2026-10-31 Rust CI findings (the workflow had never got past rustfmt on this branch): (1) cargo-deny reported FOUR wasmtime/wasmtime-wasi advisories against 49.0.4 (RUSTSEC-2026-0420, -0422, -0423, -0424; type confusion across engines, i31/nullref panics, unchecked borrowed-resource memory): the WASI worker's engine is the sandbox for WebAssembly apps, so this was a real exposure on 0.3. Fixed by moving to wasmtime/wasmtime-wasi =49.0.5 (flagship-wasi tests pass). The artifact build pins the same lockfile. (2) RUSTSEC-2023-0071 (rsa "Marvin" timing attack, no fixed release) is reached only through `pgp` in flagship-updater, which VERIFIES Node's release signatures; recorded in `rust/deny.toml` as not applicable (private-key operations only). (3) the updater's CLI test needs the TypeScript signer: it now skips without `node_modules/.bin/tsx` and the workflow runs `npm ci --ignore-scripts` on Node 24.22.1 first. The Linux/arm64 results of the next run are the first arm64 evidence for G8/G10.
- 2026-10-31 OWNER UPDATE: the UpCloud core quota (32) will NOT be raised. Gyms run inside it: boxes and helper VMs are deleted or reused between groups and runs; a group that needs cores waits for room (harness waits up to 30 min, `upcloudVm.ts` and `fleet.ts`). GPU testing happens on the owner's physical box AFTER all other gyms pass (no UpCloud GPU, no `gpu-real` group in the cloud gym); the cloud gym keeps `gpu-sim`.
- 2026-10-31 (resumed session, gym 8 = `gym-full-8.log`, results `release-20261031T011316Z-arch-v2`, gym `8aa045e9a`, still running at its update phase when taken over): triage of its failures so far, all fixed on release/0.3 (not yet in a gym run): (1) `3f5caaf76` pyapp never went live: its first migration reached its brand-new dedicated database through the gateway 19 s after creation and psql never connected (`server closed the connection unexpectedly`, exit 2), so the deploy failed and runtimes x3, access-lists, api-keys, app-copy, archive x2 and the activity skips all followed from it. Connect-phase psql failures are now retried (5 tries, ~30 s); anything after a connection never is. (2) `f1e53006a` quota: one UND_ERR_CONNECT_TIMEOUT to the relay on the first write; the harness now retries it like ECONNREFUSED (the request never left). (3) `09a6ba188` share: the update to a made-up commit was refused by the release-catalog gate (`not-in-catalog`) before the endorsement check, and that path wrote no lastUpdate; not-in-catalog and below-floor now record the owner-visible `unendorsed` verdict (stale catalog / cohort still record nothing). Killed orphaned `wrangler tail` processes from earlier runs.
- 2026-10-31 gym 8 arch-v2 pass (before update/lifecycle/one-list finished): 398 passed, 10 failed, 10 skipped. NEWLY GREEN: named-links, app-names, chat-cross-owner (the allocator's own-zone claim fix on the gym hub), browser-grants 7/7, backups, gpu-sim, wasi-apps, app-groups-db, local-ai, invites, migrate. All 10 failures have fixes on release/0.3 (entry above). MORE FIXES: (4) `d38fafef9` PRODUCT BUG: the box fetched the signed release catalog only at start and every 6 h while the apps list updates from the index, so a newly published release was offered and then refused `not-in-catalog` for up to 6 h; the gate now re-fetches once (≤1/min) before refusing. (5) `dd4ba02cc` the `update` group could never pass: first-boot moves every new box to the newest listed release, so B3 was current and the only other gym release was older (catalog: `not-newer`). New `scripts/gym-update-target.sh build|publish|unpublish`: the refresh builds the gym tip (child of the box release) one sequence later, gym-key signed (owner allowed temporary gym endorsements), hidden from index and catalog; the group publishes it, orders the move, unpublishes. Adds ~10 min (a second artifact VM build) to each refresh that builds an artifact. Failed-health rollback case still not built. (6) `b659bd7bc` release-catalog group skipped because it read the root from the release checkout; now the gym worktree.
- 2026-10-31 gym 8 FINAL: arch-v2 454 passed / 12 failed / 11 skipped (46 groups; adversarial 20/0, one-list 6/6, lifecycle 7/7 now green); classic 62/5 (8 groups). Every failure explained: the 12 arch-v2 ones by the fixes above; classic gating/invites/core by THE MAC SLEEPING mid-pass (pmset: DarkWake from Deep Idle 22:23; a 20 s TLS probe measured 942 s) → `87110dd87` the run script now holds `caffeinate -i -s` for its own pid; classic update = no update target built yet; classic STACK-SWITCH: the FIRST LIVE classic→arch-v2 switch WORKED (app served on Podman afterwards); the way-back order hit `in-progress` because the trial was still settling (by design, ≤20 min) → `1b1e3c58e` the group waits for `done`. LESSON: never edit `scripts/gym-release-run.sh` while a run is executing it (bash reads scripts as it goes; my caffeinate edit broke the run's final verdict lines: "CH_OTHERS_FAILED: command not found"). Gym run 9 started 2026-10-30 ~23:25 CDT on `1b1e3c58e` with refresh (log `/private/tmp/claude-501/gymlogs/gym-full-9.log`, pid in `gym-full-9.pid`); its refresh is the first to build the hidden update target.
- 2026-10-31 GYM 9 (`release-20261031T041353Z-*`, gym `20e327e3d`, boxes on `4e63da9f`): arch-v2 **496 passed / 1 failed / 6 skipped** (46 groups), classic **108 / 1**. FIRST TIMES LIVE: the `update` group green on both stacks (hidden gym-key update target published, owner order applied in 2.0 min arch-v2 / 4.4 min classic, health gate committed); the full STACK SWITCH classic→arch-v2→classic green (trial settles to done, app served on Podman and back on Docker); runtimes incl. pyapp (migration retry), quota, access-lists, api-keys, app-copy, archive all green. Skips: gpu-real (owner hardware), 3 quota DB checks that don't apply to a dedicated database on arch-v2 (app-groups-db covers it), 2 activity skips following share. FAILURES: (a) share: the verdict still not recorded; ROOT CAUSE `9d1a569d3`: signed update orders run as ledger operations, the step throws to mark the op failed and runOrderOperation rethrows, so applyEndorsedUpdate threw and every caller fell back to apply-failed (no refused update was EVER recorded on a real box; owner orders too); fixed with a test that fails without it. (b) classic backups: one relay ECONNRESET on the archive-approve POST (box never saw it); `9b6b507a5` lets explicitly idempotent writes retry. Also `f4cde1026` the update group keeps the box's updater journal lines (classic showed update-guard + health gate; the arch-v2 Rust-updater line is to read in gym 10's update.json). Starting gym 10.
