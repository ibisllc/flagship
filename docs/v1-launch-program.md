# v1-launch program — the phased tracker (authoritative for phase state)

**This file is created and maintained from the `/alpha` (v1-launch) program
prompt. It is the single source of truth for *which phase we are in and what
is done*.** SESSION-HANDOFF.md remains the source of truth for the fine-grained
backlog (§3, the `#1..#35` table), the drift log (§0), and ground-truth gate
state. This file maps that backlog onto the 8-phase launch program and records
per-phase progress newest-first.

Cold-start read order is unchanged: `docs/SESSION-HANDOFF.md` (§0/§3/§5) →
**this file** (open phase) → `docs/build-tasks.md §S` →
`docs/maintainer-ca-endorsement.md §9–§12` → `docs/maintainers-deployment.md`
→ `docs/ca-operations.md` → `CLAUDE.md`. Rebuild the harness TaskList from the
open phase here.

## Ground-truth gate (verify every session — do not trust, re-run)

- flagship: `npx tsc -b` clean · `npx vitest run` → **2526 passed / 225 files**
  on `main`. One known parallel-load flake (deterministically green on re-run;
  SESSION-HANDOFF §0 #3 watch procedure — never blanket-retry / guess-pin).
- maintainers (`maintainers/`, gitignored, pinned `scripts/maintainers.pinned-sha`
  = `833fa45`, **PR #2 MERGED** = Human Gate A satisfied): `npx vitest run` →
  **307 passed / 31 files** **AT THE PIN** on `main` (no longer "on a branch":
  the full #28 scope — keystone +20, `--dry-run` +4, banner/confirm/
  never-log-secrets +9, PC/SC APDU codec + seam +17 — is now first-parent-
  reachable from `833fa45`; the old `10c65aa`/257 baseline is superseded).
  `npx tsc -b` clean. The pin diff `10c65aa..833fa45` touches only
  `packages/cli` + `packages/protocol`; `packages/web-ui` is byte-identical,
  so the `flagshipserver.com/maintainers/` bundle needs no re-bundle and the
  Worker needs no redeploy.
  On a fresh machine the clone is stale → run `bash scripts/pull-maintainers.sh
  pull` first (idempotent; resets to the pin `833fa45`). This was required on
  the 2026-05-17 Mac at session 1 (clone was at the pre-CaEndorsement base
  `c009900`; `tsc -b` was red on the two `caTrustChain.ts`
  `@maintainers/protocol` imports until the pull synced it).
  - **Phase-1 #28 is MERGED — no branch checkout dance anymore.** The old
    "re-checkout `feat/piv-ed25519-signer` after pull" note is obsolete:
    the branch was merged to `main` as `833fa45` and the pin now points
    at it, so `pull-maintainers.sh` lands you exactly on the #28 work.
    Always use absolute paths — the shell keeps cwd across tool calls,
    so a bare `cd maintainers` compounds (bit sessions 3 + 4).
- Android: review-only on this Mac (`/usr/bin/java` is the macOS stub, no real
  JDK). iOS IS verifiable here (Xcode 16.4 / xcodebuild present). This is the
  inverse of the resume-#2 Linux box (JDK present, no xcodebuild).
- `apps/mobile/ios/App/FlagshipApp.xcodeproj/project.pbxproj` shows
  perpetually-modified — deterministic xcodegen artifact, never stage it.

## Phase status at a glance

| Phase | Title | State |
|---|---|---|
| **1** | Genesis ceremony (keystone; YubiKey in hand) | **▶ AGENT-COMPLETE · Human Gate A SATISFIED → only Human Gate B remains.** Keystone + signer threaded through genesis/mandate/takeover/endorsement + `ca-endorsement` command/store + assemble/sign split & `--dry-run` + ceremony banner / typed confirm / never-log-secrets / successor guidance + native PC/SC APDU codec + channel seam (fail-closed; hw round-trip is the gate) all built+green+pushed. **PR #2 MERGED `833fa45`; flagship re-pinned + pulled + both gates re-run green (flagship 2526/225, maintainers 307/31 AT THE PIN); commit `34b6cb5` pushed.** Remaining = **Human Gate B only**, now known **TWO-PART** (s4 verify-before-trust): `connectPcscChannel` is a fail-closed stub by #28 design → (P) human provisions (`pcsclite`+`ykman`, on-token keygen both YubiKeys, plug in, decide DURATION) → (A) agent implements+live-verifies the libpcsclite wiring behind the tested seam (governed PR; never blind) → `--dry-run` → human signs genesis per track → agent verifies+bakes `MAINTAINER_GENESIS_PUBKEYS` (#30 flips live)+re-run #8. `file:` NOT acceptable for the genesis root. Deploy nothing. |
| 2 | Maintainers as its own product (#35 → #9 → #10) | **▶ UNBLOCKED by Gate A** (does NOT need Gate B). Agent build work available now: #35 `SignedPolicy` + static-layout spec + `fetch()` reference client + conformance vectors incl. fail-closed negatives. Design LOCKED below. |
| 3 | The maintainers app (retire the CLI) — #31 + #32 | ☐ blocked on Phase 2 |
| 4 | Real install chain on test hardware — #21 + #22 | ☐ seam built; human/hardware |
| 5 | On-demand VPS + promo AI + real vibe-code | ☐ seam built (#83/#85); human/credential |
| 6 | Mobile apps to stores — #16/#17/#18 + iOS/Android | ☐ seam built; human/accounts |
| 7 | Monitoring dashboard (costs) | ☐ depends on Phase 5 telemetry |
| 8 | Remaining v1-alpha live exercises → tick §S | ☐ human-clocked exercises |

Earlier-numbered phases gate later ones for the *trust-chain* spine
(1→2→3). Phases 4–8 are seam-complete and human/hardware/credential-gated;
they can advance opportunistically when the human gate is satisfiable, but
the program's primary thrust is 1→2→3 first (it is the launch-blocking
critical path and everything downstream verifies against it).

---

## PHASE 1 — GENESIS CEREMONY (keystone)

**Why first:** the real YubiKey is now in hand. Genesis bakes the real
`MAINTAINER_GENESIS_PUBKEYS` into `@flagship/protocol`; until then the #30
chokepoint fail-closes and the entire CA trust chain (#8 link-4 daemon port,
#9 webapp, #10 iOS/Android) is correctly inert. Genesis unblocks the chain.

Backlog mapping: **#27** (genesis ceremony flow), **#28** (PIV-Ed25519
signer), **#30** (baked genesis const — already built + fail-closed-tested,
flips live at the human gate), **#8** (link-4 daemon port — already
built+tested, re-run at the gate to prove it resolves once genesis is real).

### 1A. AGENT work — ✅ COMPLETE (2026-05-17 session 3)

**All 1A items below are DONE, green, pushed; PR #2 is out of draft.**
maintainers `feat/piv-ed25519-signer` tip `a195968`, suite **307/31**,
`tsc -b` clean; flagship gate held **2526/225** (the changes are
CLI-package-only — `@maintainers/protocol` untouched — so flagship's
protocol-only import graph is provably unaffected). What landed:
external `Ed25519Signer`/`privKeySigner` (one signing path) → CLI
`loadSigner`/injectable `PivTransport` → threaded through genesis/
mandate/takeover/endorsement → `ca-endorsement` command + on-disk
store convention → **assemble/sign split + `--dry-run`** (exact
canonical bytes + `.maintainers` diff; no PIN/tap/sign/write;
fidelity-tested; wrong/swapped-key fail-closed guard) → **plain-language
ceremony banner + typed explicit confirm (`--yes` non-interactive
bypass; fail-closed when neither) + whole-surface never-log-secrets
regression + genesis successor/record-pubkey guidance** → **native
PC/SC `piv-apdu` codec (SELECT/VERIFY/GA-Ed25519/GENERATE + BER-TLV +
SW decode, all pure unit-tested) + `piv-pcsc` channel seam; the
optional `pcsclite` binding fail-closes precisely (NEVER a hex
fallback) — the libpcsclite round-trip is verified only at Human Gate
B**. `scripts/rotate-ca.mjs` Step-2 + `ca-operations.md` already point
at `yubikey-piv:` (prior session, origin/main). Original design notes
retained below for provenance.

- **#28 PIV-Ed25519 signer.** Design (verified against source 2026-05-17):
  - `@maintainers/protocol` `sign{Mandate,ReleaseEndorsement,CaEndorsement}`
    today take `signers: { privKey: string }[]` and call `ed25519.sign(bytes,
    priv)` internally — the private key must be in-process. PIV keeps the key
    on the token, so the protocol needs an **external-signer abstraction**:
    `Ed25519Signer { pubKey; sign(bytes) }`, plus a `privKeySigner(priv)`
    wrapper so there is exactly ONE signing/assembly code path. The
    canonical bytes, signature scheme (RFC-8032 Ed25519), verifier and spec
    are **untouched** — a PIV-Ed25519 signature over the canonical bytes is
    byte-identical and verifies unchanged (the §11.1 linchpin). ZERO
    protocol/wire/spec change; an additive signing-API change only,
    back-compatible with every existing `{privKey}` caller and test.
  - CLI: a new `yubikey-piv:` key source in `cli/src/lib/keysource.ts`
    returning an `Ed25519Signer` backed by an **injectable PIV transport**
    (PC/SC: SELECT PIV AID `A0 00 00 03 08`, VERIFY PIN, GENERAL
    AUTHENTICATE Ed25519 over the message; GENERATE / pubkey-read needs no
    PIN). Fake transport in unit tests; the real PC/SC path is the only
    thing the human gate exercises.
  - This is upstream `ibisllc/maintainers` (protocol pkg + CLI). It lands by
    a branch → governed PR (PR #1 precedent) → re-pin
    `scripts/maintainers.pinned-sha` post-merge → `pull-maintainers.sh`.
  - Security-critical; explicitly do-not-bolt-at-session-tail. Build to the
    seam + tests; the hardware sign path is verified only at the gate.
- **Genesis/ceremony UX hardening** (`maintainers genesis` + ceremony
  commands): plain-language ceremony banner ("this is GENESIS — root of
  trust, cannot be undone"), `--dry-run` (print exact canonical bytes + the
  `.maintainers` diff, sign/write nothing), typed explicit confirmation
  before any token touch / file write, NEVER log secrets, "tap your YubiKey
  now" prompts, fail-closed human-readable refusals, second-key/successor
  guidance baked in per §11.2.
- `scripts/rotate-ca.mjs` is the *discipline reference* (safe-ordering,
  dry-run, never-log-secrets, independent-verify-before-irreversible). Once
  the `yubikey-piv:` source exists, rotate-ca's Step-2 fallback command
  string should reference it instead of "staged".

### 1A→Gate-A. ✅ SATISFIED (2026-05-17 session 4)

PR `ibisllc/maintainers#2` was merged by the maintainer (governed step)
as merge commit `833fa45` (tip of `main`, all 8 #28 commits
first-parent-reachable). Agent half done: `scripts/maintainers.pinned-sha`
bumped `10c65aa`→`833fa45`, `pull-maintainers.sh pull` reset the clone,
**both gates re-run green — flagship `tsc -b` clean + `vitest run`
2526/225; maintainers (now at the pin) `tsc -b` clean + `vitest run`
307/31.** web-ui byte-identical between pins ⇒ no Worker redeploy.
Committed `34b6cb5`, pushed to `origin/main`. Phase 2 is now unblocked.

### 1B. HUMAN GATE (YubiKey) — the ONLY remaining Phase-1 item · **TWO-PART** (s4 finding)

**Verify-before-trust finding (2026-05-17 s4, while walking the gate):**
the native PC/SC transport is not executable yet. `piv-pcsc.ts`
`connectPcscChannel()` is — by #28's deliberate design — a fail-closed
stub that throws **unconditionally even with `pcsclite` installed**;
#28 shipped the pure tested `piv-apdu` codec + the `PcscChannel` seam +
this stub, and the real libpcsclite wiring (reader enum → connect →
APDU transmit) is the explicitly-deferred **human-gate increment**,
implementable only with the reader+token present. (Also: `pcsclite`
not installed, `ykman` not installed, no YubiKey plugged in.)
`file:` is NOT acceptable for the genesis root (it would put the root
private half on disk; it is the successor/air-gapped path only). Full
detail = `ca-operations.md` Operation 0 "GATE-B EXECUTION REALITY".

In order, now that 1A is merged + re-pinned (Gate A ✅):
0a. **(P) Human provisions the environment:** install `pcsclite` (so
   `connectPcscChannel` can load the binding) + `ykman`; generate the
   on-token Ed25519 in PIV slot 9c on BOTH YubiKeys (touch=always,
   PIN-once; the exact `ykman` invocation + PIN/PUK policy is the
   §11.4 human knob); export the backup key's slot-9c pubkey to
   `backup-9c.pub`; decide the cold-genesis `<DURATION>` (LOCKED D1 ⇒
   long-lived, e.g. `3650d`); plug in both YubiKeys.
0b. **(A) Agent implements + LIVE-verifies** the `connectPcscChannel`
   libpcsclite wiring (reader enumeration → connect → APDU transmit
   Buffer↔Uint8Array) behind the existing tested `PcscChannel` seam +
   `piv-apdu` codec, proving the round-trip with a NON-destructive
   `getPublicKey` read FIRST. Security-critical native transport — it
   is upstream `maintainers` (governed PR → re-pin, PR #1/#2
   precedent) and is NEVER written blind/bolted: the hardware-in-loop
   verification is the entire reason it is done AT the gate. **UX
   acceptance criterion (hard, user-set):** the tool must NOT assume
   the key/reader is present — no-reader / no-token / not-tapped-yet
   are normal recoverable states → prompt + wait + friendly retry,
   never a fatal `CliError`. Fail-closed = security only (never sign
   with a weaker/wrong key); it must not leak into absent-hardware UX.
   Step-(A) tests MUST cover "no reader" + "token removed mid-prompt"
   → friendly wait/retry → recovers on insert. See
   [[feedback-no-hardware-assumptions]].
0c. **(A, no hardware needed) Build the `register` increment (#9) —
   registration precedes the ceremony (user-chosen 2026-05-17 s4).**
   The protocol already implements `KeyFile`/`EmailRotation`/
   `KeyRedirect` (types/canonical/signing/Envelope) but the CLI has NO
   `register` command. Add it, additive, #28-pattern, governed PR.
   **Commit plan (each green: maintainers tsc -b + suite, then flagship
   gate as the guard since `@maintainers/protocol` is touched):**
   - **c1 ✅ `dc48559`** (pushed `feat/keyfile-register`) — protocol
     additive external self-signer variants `signKeyFileWith` /
     `signKeyRedirectWith` / `signEmailRotationWith` (one signer,
     `signer.pubKey == envelope.pubkey`, fail-closed). ZERO
     canonical/verifier/wire/spec change (§11.1). maintainers 307→**311**;
     flagship guard 2526/225.
   - c2 — `store.ts` `writeKeyFile`/`writeEmailRotation`/`writeKeyRedirect`
     + filename helpers; `ceremony.ts` `CeremonyKind` += `"register" |
     "rotate-email"` + banner cases + `confirmPhrase` (default
     `.toUpperCase()` already covers; banners are bespoke).
   - c3 — `register` command (`assembleKeyFile` + `runRegister`):
     self-signed KeyFile → `.maintainers/keys/<email>.json`; dispatch +
     usage; dry-run/banner/confirm; tests (byte-exact dry-run, no-write,
     self-signed fail-closed, fidelity).
   - c4 — `rotate-email` (EmailRotation + the §3.3 dual-write of the
     `KeyRedirect` replacing `keys/<old-email>.json`) + tests.
   - c5 — genesis additive `--mandate-id <uuid>` (defaults to
     `opts.uuid()`; explicit threads through) so the bootstrap pointer
     is truthful (see the design note below) + test.
   Then docs (this file + ca-operations Operation 0 gain the register
   step) + governed PR → re-pin. **HUMAN GATE: PR merge (PR #1/#2
   precedent).**

   **`introductionMandate` bootstrap — design decision (s4, verified
   against `policy.ts:570-577`).** `KeyFile.introductionMandate` is a
   required Uuid, BUT the verifier trusts the self-signed attestation
   and does NOT cross-check the id (the real security gate is the
   pubkey being named by an authoritative mandate; the field is an
   audit pointer, consistent with spec §2.4 "not authoritative for
   permission decisions"). Chosen for register-before-genesis: **pre-
   mint ONE genesis mandate UUID; `register --introduction-mandate
   <id>` for both KeyFiles; `genesis --mandate-id <id>`** so the
   pointer is *truthful* (a verifier/human can confirm the KeyFile
   points at the real genesis mandate) — NOT a placeholder/sentinel
   (a lie in a signed root-of-trust artifact) and NOT register-after
   (contradicts the user's sequencing). This is why c5 adds the
   additive genesis `--mandate-id`.
0d. **(after 0a+0b+0c) Register the two keys.** Each on-token key
   self-signs its `KeyFile` via `register --signing-key
   yubikey-piv:slot=9c --display-name … --email harry@harrywinner.com
   --introduction-mandate <pre-minted-id>` (and `harry_backup@…` for
   the backup). Needs 0b (PC/SC binding — the on-token keys sign) +
   0c (the command). `--dry-run` first; agent verifies bytes.
1. Human runs `ca-operations.md` "Operation 0 — genesis" with the real
   YubiKey, `--mandate-id <pre-minted-id>`, `--dry-run` first per track
   (agent verifies the canonical bytes), then the signed run per track
   ca/release/ops (typed `GENESIS` + PIN + physical tap). Agent walks
   through, verifies every emitted artifact (canonical bytes,
   signature, chain), incl. that each KeyFile's `introductionMandate`
   == the genesis `mandateId`.
2. Agent bakes the emitted genesis pubkey(s) into `@flagship/protocol`
   `MAINTAINER_GENESIS_PUBKEYS` (currently `Object.freeze([])`,
   fail-closed) — #30 flips live. **Scope of this bake: the one TS
   constant only**, which covers the daemon (#8, wired) and later the
   webapp (#9). It does NOT reach iOS/Android — those are separate
   Swift/Kotlin reimplementations that re-bake the SAME pubkey at
   Phase 2 #10 (see Phase 2's "GENESIS PUBKEY MUST BE RE-BAKED PER
   SURFACE"). Record the exact pubkey value in this tracker + the
   ceremony artifact so the Phase-2 mobile bake is provably the same.
3. Re-run the #8 suite to prove links 1–4 now resolve with a real genesis.
4. **Deploy nothing yet.**

---

## PHASE 2 — MAINTAINERS AS ITS OWN PRODUCT (#35, then #9, then #10)

### Phase-2 DESIGN DECISION (2026-05-17, user-picked) — "pin one key, fetch a folder, verify at your own clock"

Locked after a verify-before-trust read of `verifier.ts`/`types.ts`.
Guideline: minimal value for Flagship, easiest + most secure for any
adopter with our needs. **Three decisions, ZERO `Mandate`/
`CaEndorsement` canonical-bytes change** (the #28 invariant holds; the
only additive spec delta is `SignedPolicy`, appropriate for the
Phase-2 versioned bump):

- **D1 — Policy is genesis-anchored + immutable in v1.** `policy.json`
  (`RootPolicy` + every `TrackPolicy`) today is UNSIGNED and trusted as
  a `verifyTrack` argument — a real hole under HTTP fetch (host can
  weaken the threshold). Fix: a `SignedPolicy` = canonical bytes of the
  policy + ONE Ed25519 signature by the genesis key (reuses existing
  crypto; no new envelope semantics). `verifyTrack` gains a precondition
  — the consumed `TrackPolicy` MUST verify against the baked genesis
  authority, else hard fail-closed. NO per-ceremony threshold (lets one
  compromised holder weaken its own quorum; not minimal). Changing
  quorum/track-set in v1 = a NEW genesis ceremony. ~1 canonical fn +
  ~10 verifier lines, zero policy-mutation governance.
- **D2 — A fixed dumb static layout any host serves** (GitHub raw / S3 /
  CDN / repo-over-HTTPS; no server logic):
  `<base>/origin.json` (RootPolicy + SignedPolicy + per-track genesis
  Mandate; immutable, consumer-pinned) · `<base>/tracks/<t>/log.json`
  (append-only `Mandate[]`) · `<base>/ca-leases.json` (append-only
  `CaEndorsement[]`). Consumer algo: fetch origin → verify SignedPolicy
  vs the hardcoded genesis pubkey → fetch log → `verifyTrack` from
  genesis → fetch leases → `authorizedCaKeys(…, NOW)`. Append-only ⇒
  trivial caching; a stale cache only loses freshness (fail-closed),
  never gains forged authority. **NO `current.json`/`checkpoint_<id>`
  in v1** — the log is tiny; "fetch + re-walk from genesis" is simpler;
  the `verifyTrackFromCheckpoint` primitive stays a pure optimization
  to add only if size demands.
- **D3 — Freshness IS the shipped `CaEndorsement` lease, nothing new.**
  Rule (not mechanism): a consumer MUST require a `CaEndorsement` whose
  `[notBefore,notAfter)` contains its OWN now, judged at its OWN clock.
  Host withholds ⇒ newest lease lapses ⇒ all consumers fail closed
  within one window (default 7d). Cold maintainer track stays
  long-lived; the hot key's short lease is the beacon. No timestamp
  server / snapshot role / CRL.
- **Known, accepted limitation (state it to adopters):** rollback-
  resistance is bounded by the lease window; this is NOT equivocation/
  split-view detection (a host serving different valid histories to
  different consumers). CT-style gossip is deliberately out of scope
  for Flagship's threat model.
- **#35 scope therefore gains:** `SignedPolicy` (canonical fn + the
  genesis-sig `verifyTrack` precondition) + the published static-layout
  spec + a tiny `fetch()` reference client + conformance vectors that
  MUST additionally include *tampered-policy ⇒ reject*,
  *lapsed-lease-at-NOW ⇒ reject*, *withheld/rolled-back log ⇒ reject*
  (on top of the absent/forked-genesis + endorsement-gap negatives).
  #9/#10 get EASIER (fetch 3 JSON files, rerun the same pure verifier).

- **#35**: `npm publish @maintainers/protocol` (semver, `--provenance`,
  `npm ci`-pinnable) + a versioned spec + a published **conformance
  test-vector set that MUST include the mandatory fail-closed negatives**
  (absent genesis ⇒ reject; forked/unknown genesis ⇒ reject; endorsement
  gap / substituted intermediate ⇒ reject — `docs/maintainers-deployment.md`
  "Threat model & applicability boundary"). Flagship DROPS
  `scripts/pull-maintainers.sh` + `maintainers.pinned-sha` and consumes the
  published package like any adopter (honest dogfooding).
  HUMAN GATE: npm org/2FA + `npm publish` (or authorize the agent's publish
  step — may be classifier-blocked even post-approval; if so the human runs
  the one command).
- Then **#9** (webapp link-4: the #8 `caTrustChain.ts` shape in `apps/web`
  + a bundled browser verifier) → **#10** (iOS Swift + Android Kotlin
  reimpl of `verifyTrack`/`verifyCaEndorsements`/`authorizedCaKeys`, each
  PROVEN against the published conformance vectors incl. the fail-closed
  negatives). #10 is the heaviest single item — sequence it, don't tail-bolt.
- **GENESIS PUBKEY MUST BE RE-BAKED PER SURFACE.** The Phase-1 bake
  populates ONLY the one TS constant `@flagship/protocol`
  `MAINTAINER_GENESIS_PUBKEYS` — that covers the daemon (#8, wired) and
  the webapp (#9, once wired). iOS (Swift) and Android (Kotlin) are
  independent reimplementations: each #10 port MUST hardcode the **same**
  genesis pubkey(s) into its own source (today `apps/mobile` contains
  ZERO genesis material — verified). #10's acceptance bar — proven
  against the published conformance vectors incl. the fail-closed
  negatives (absent/forked genesis ⇒ reject) — is the guard that no
  mobile port ships with a wrong/empty/placeholder genesis. Same pubkey
  value, four baked locations (protocol-const, webapp via it, iOS, and
  Android), sequenced Phase 1 → Phase 2.

## PHASE 3 — THE MAINTAINERS APP (retire the CLI) — #31 + #32

- **#31** upstream maintainers web-ui: status/preview/commit-trigger ONLY,
  never a signing view.
- **#32** the generic OSS maintainers NFC-tap app, Android-first (design
  100% in maintainer-ca §11+§12; tap → PIV-Ed25519 → app-direct-commit).
  Multi-week; incremental, each commit green. iOS port needs an Apple
  device. HUMAN GATE: first real ceremony on the Android phone + YubiKey,
  replacing the CLI path end-to-end.

## PHASE 4 — REAL INSTALL CHAIN ON TEST HARDWARE — #21 + #22

- **#21** C4.1c live exercise: real CNAME → Let's-Encrypt cert → green
  padlock → sibling failover. **#22** lazy-SNI → `routeToTunnel` on the
  raw-TCP :443 hot path (correctness core already ships; this is the live
  socket wire). Seam built; HUMAN GATE: flash ISO to the test box, point a
  real DNS name; agent drives install + cert + failover live. `.services`
  API is :8443.

## PHASE 5 — ON-DEMAND VPS + PROMO AI + REAL VIBE-CODE

- Turn `scripts/demo-account.mjs` (#83, built) into a real provisioner: ONE
  command spins up a VPS (provider API behind an injected credential;
  idempotent; deprovision path; cost tags). Stand up the promo-AI path
  (#85 cap built+deployed); real vibe-code on a freshly provisioned pod.
  HUMAN GATE: rent the promo-AI box + supply endpoint/key + VPS-provider
  API credential (injected, never committed; .com secret / env).

## PHASE 6 — MOBILE APPS TO STORES — #16/#17/#18 + iOS/Android

- Finalize iOS (xcodebuild/sign) + Android (signing, FCM); #16/#17/#18
  recovery UI + the live WebAuthn-PRF / cross-device recovery exercise
  scripted for the real phones. HUMAN GATE: Apple Developer + Google Play
  accounts; agent produces builds, human does TestFlight + Play-internal
  uploads + 5 external testers each (build-tasks §S 623-624).

## PHASE 7 — MONITORING DASHBOARD

- Ops dashboard (extend the `/status/` surface): users, apps, pods, and
  COSTS (Phase-5 VPS cost tags + promo-AI usage telemetry). Deployed +
  live-smoked.

## PHASE 8 — REMAINING v1-ALPHA LIVE EXERCISES → TICK §S

`docs/build-tasks.md §S` open boxes: iOS TestFlight (Phase 6), Android Play
(Phase 6), Marketplace MVP ≥10 listings/≥3 cross-pod installs, LLM-promo
cap enforced+tested, update-pack 7-day cross-pod, lineage-break + re-anchor,
STK rotation, recovery lost-phone→new-phone, public security disclosure
page + bounty payouts. (Reproducible-ISO CI is the only §S box already
☑.) Each is a human-clocked live exercise the agent scripts + drives. When
every §S box is ☑ → v1-alpha.

---

## Progress log (newest first)

### 2026-05-17 — session 4 (this Mac): Human Gate A SATISFIED → Phase 2 unblocked

Cold-start: the `maintainers/` clone was on `feat/piv-ed25519-signer` @
`a195968` (clean) from session 3. **Verify-before-trust on the GitHub
side first:** `gh pr view 2` showed PR `ibisllc/maintainers#2` is
**MERGED** (merge commit `833fa45`, base `main`, mergedAt
2026-05-17T19:48Z) — the human did the governed merge between sessions.
`git merge-base --is-ancestor a195968 833fa45` = YES and all 8 #28
commits (`f646f99`..`a195968`) are reachable from the merge; `833fa45`
is the tip of `origin/main`.

**Gate A agent half executed:**
- Bumped `scripts/maintainers.pinned-sha` `10c65aa` → `833fa45` (the
  first-parent-reachable MERGE commit, NOT the branch tip — same rule
  as the PR #1 re-pin `0697bab`).
- `bash scripts/pull-maintainers.sh pull` → clone `git reset --hard`'d
  to `833fa45` cleanly, maintainers deps reinstalled (exit 0).
- **Both gates re-run, sequential, absolute-cwd (the shell-cwd-compound
  hazard bit a verify step again — caught, re-run with explicit `cd`):**
  flagship `npx tsc -b` clean + `npx vitest run` **2526/225 exit 0**;
  maintainers (now AT THE PIN `833fa45`) `npx tsc -b` clean + `npx
  vitest run` **307/31 exit 0**. The maintainers baseline is now
  **307 at the pin** — the +50 #28 tests are first-parent-reachable
  from `main`, the old `10c65aa`/257 is superseded.
- Pin diff `10c65aa..833fa45` = `packages/cli` + `packages/protocol`
  only; `packages/web-ui` byte-identical ⇒ `flagshipserver.com/
  maintainers/` bundle unchanged, **no Worker re-bundle / redeploy**.
  The only flagship runtime consumer is `@maintainers/protocol` via
  `server-daemon/src/caTrustChain.ts`; the green flagship gate proves
  the additive `Ed25519Signer`/`signing.ts` is back-compatible with
  every `{privKey}` caller (the §11.1 linchpin holds end to end).
- Committed `34b6cb5` (`scripts: re-pin maintainers to the PR #2 merge
  commit`, pin file only — `project.pbxproj` left unstaged as always),
  pushed to `origin/main`.

**Phase-1 AGENT work + Human Gate A are both COMPLETE.** The only
remaining Phase-1 item is **Human Gate B** (Operation 0 genesis with
the real YubiKey → agent bakes `MAINTAINER_GENESIS_PUBKEYS`, #30 flips
live, re-run #8). **Phase 2 (#35 → #9 → #10) is now unblocked — it does
NOT require Gate B** — so agent build work (#35 `SignedPolicy` + the
static-layout spec + a `fetch()` reference client + conformance vectors
incl. the fail-closed negatives, per the LOCKED Phase-2 design) may
proceed in parallel with the human-clocked Gate B.

Also this session (`d9b4848`): **Gate B runbook concretized +
source-verified.** `ca-operations.md` "Operation 0 — genesis" was a
conceptual sketch with no command (the verify-before-trust hole that
bit session 1). Rewrote it as a precise per-track (ca/release/ops)
runbook, every CLI detail checked against the merged CLI at the pin —
exact `genesis` invocation, `--dry-run`-first, the `GENESIS`
typed-confirm phrase, the self-signed invariant, successor=2nd-YubiKey
via a one-time `file:` pubkey export, the `npm run build` precondition,
verify/status `--path`, the single-`holder`-pubkey bake + re-bake-per-
surface + record-the-value, "deploy nothing". The two human-owned
non-code-derivable inputs (on-token keygen + PIN/PUK per §11.4; the
cold-genesis `<DURATION>` per LOCKED D1) are flagged. **Gate B is now
*armed* — safe to execute, not just pending.**

Also this session: **separation-of-concerns design Q + the
registration-first increment (#9) started.** The user asked to confirm
"registration ≠ ceremony": each key self-registers under an email id
(harry@ / harry_backup@harrywinner.com), ceremonies are designed
freely, the tool prompts "tap X's key" at sign time. Verify-before-
trust against spec §2.4/§3.2/§3.3 + types: this **is** the protocol —
`KeyFile` (self-signed, email-named, displayName/metadata/emailHistory)
+ `EmailRotation`/`KeyRedirect`; identity-for-trust is the **pubkey**
(spec non-goal: emails "conventional but not load-bearing"), so the
email is a human label, never a credential (free self-registration is
safe ONLY because a non-chained KeyFile has zero authority). The CLI
has NO `register` command though (protocol-implemented, CLI-missing —
same shape as the s1 `ca-endorsement` gap). User chose **build
register first, then genesis**. Increment #9 commit plan in §1B 0c;
**c1 `dc48559` landed + pushed** (`feat/keyfile-register`) — additive
protocol self-signer variants, maintainers 307→**311**, flagship guard
**2526/225**, ZERO wire/spec change. `introductionMandate` bootstrap
resolved (truthful pre-minted shared id + additive genesis
`--mandate-id`; see §1B design note). c2–c5 + governed PR remain.

### 2026-05-17 — session 3 (this Mac): Phase-1 AGENT #28 finished + PR #2 ready

Cold-start: no env-sync drift — the `maintainers/` clone was already on
`feat/piv-ed25519-signer` @ `3a4bbe9` and clean, so `pull-maintainers.sh`
was correctly NOT run (per the continue-rule). Gate at start verified:
flagship **2526/225 · tsc clean**, maintainers (on the branch)
**277/26 · tsc clean** — both exactly the documented baseline. (Note: a
shell-cwd-compound bit a verify step early — the first "flagship" runs
actually ran in `maintainers/`; caught and re-run with absolute paths.
Lesson re-affirmed: always absolute paths / explicit cd.)

Three security-critical commits on `feat/piv-ed25519-signer`, each
green + pushed:

- **`4647582` — assemble/sign split + `--dry-run`.** Every ceremony
  splits into a pure `assemble*` (validate + store + PUBLIC-key reads
  only; no PIN/tap/sign/write) and a phase-2 sign. `--dry-run` runs
  phase 1 and prints the EXACT canonical bytes (hex + utf-8) + the
  unsigned `.maintainers` diff, then stops. New `loadSignerBoundPubKey`
  (PIV public read / `file:` derive — matches what `loadSigner` binds).
  `signAssembled` fail-closes if the resolved signer ≠ assembled
  `signedBy` (wrong/swapped YubiKey). `build*` keep their signatures
  (back-compat). 277 → 281.
- **`d55a86d` — banner + typed confirm + never-log-secrets.**
  `previewConfirmSign` centralizes banner → byte/diff REVIEW → typed
  explicit confirm (ceremony-specific phrase via `ttyConfirm`;
  fail-closed when piped; `--yes` skips ONLY the prompt) → sign, for
  all four commands. Genesis prints successor set + record-pubkey/
  no-escrow guidance. Whole-surface never-log-secrets sweep (PIN +
  `file:` privkey never appear across banner/preview/confirm/advisory/
  success/dry-run/sign-failure). Existing write-path dispatch tests
  pass `--yes`. 281 → 290.
- **`a195968` — native PC/SC stub.** `piv-apdu.ts`: pure, fully
  unit-tested PIV codec (SELECT PIV `A0 00 00 03 08`, VERIFY PIN,
  GENERAL AUTHENTICATE Ed25519 over raw bytes, GENERATE, BER-TLV incl.
  2-byte `7F49`, SW decode, fail-closed extraction). `piv-pcsc.ts`:
  `PcscChannel` seam + `pcscPivTransport` (SELECT→VERIFY→GA/GENERATE,
  61xx/6Cxx chaining) tested against a fake channel; `connectPcscChannel`
  loads the OPTIONAL `pcsclite` binding by dynamic import (no
  package.json/lockfile change) and fail-closes precisely — NEVER a hex
  fallback; libpcsclite round-trip is Human-Gate-B only. `keysource.ts`
  `realPivTransport` now lazily composes it (message still says "native
  PIV/PC/SC transport is not wired in this build" → existing
  fail-closed tests stay green). 290 → **307**.

ZERO protocol/canonical/wire/spec delta across all three (CLI-package
only; `@maintainers/protocol` untouched ⇒ flagship's protocol-only
graph provably unaffected — final flagship gate re-verified
**2526/225 · tsc clean**). **PR #2 flipped out of draft → ready for
review** (tip `a195968`); body updated to the full 8-commit #28 scope.

**Phase-1 AGENT work is COMPLETE.** Remaining is human-only:
**Human Gate A** — governed merge of PR #2 → bump
`scripts/maintainers.pinned-sha` to the merge SHA + `pull-maintainers.sh`
(the classifier may block agent `gh pr merge` even post-approval; if so
the human runs that one command). **Human Gate B** — `ca-operations.md`
Operation 0 genesis with the real YubiKey; agent then walks/verifies,
bakes `MAINTAINER_GENESIS_PUBKEYS` (#30 flips live; re-bake per surface),
re-runs the #8 suite. Deploy nothing.

### 2026-05-17 — session 2 (this Mac): Phase-1 AGENT signer threading + `ca-endorsement`

Cold-start verified ground truth (no env-sync drift this time — the
`maintainers/` clone was already on `feat/piv-ed25519-signer` @ `9e7c495`,
clean). Gate at start: flagship **2526/2526 · tsc clean**; maintainers (on
the branch) **270/270 · tsc clean**. Three security-critical commits on
`feat/piv-ed25519-signer`, each green + pushed (draft PR #2):

- **`d2027df` — thread the external signer through genesis/mandate/
  takeover.** `build*` are async, resolve every key via `loadSigner`/
  `loadSignerPubKey` (+ new `loadSignerPubKeyList` so a successors/holder
  CSV can name a `yubikey-piv:` second key — the §11.2 second-YubiKey
  read). `dispatch`/`run` async, each command `await`ed inside the try so
  a `CliError` still maps to exit 1; bin shim awaits. `CliEnv` gains
  optional `pivTransport`/`pivPin` (default real transport fail-closes —
  NEVER a silent hex fallback). New test drives `buildGenesis` through an
  injected fake PIV token and proves the mandate is byte-identical to the
  hex path and verifies under the protocol verifier (the §11.1 linchpin,
  end to end). 270 → 271.
- **`5148bbf` — thread the signer through release `endorsement` too.**
  §10.1 requires ALL maintainer-key ceremonies to sign via the one path;
  the legacy `loadPrivKey` also *rejected* `yubikey:`, so YubiKey-signed
  releases were impossible. Now `loadSigner` + `signReleaseEndorsementWith`.
- **`3a4bbe9` — add the missing `ca-endorsement` command + the on-disk
  CA-lease store convention.** `ca-operations.md` Op 1 Path B and
  `rotate-ca.mjs` Step 2 both invoked a `ca-endorsement` command that did
  not exist — a real gap (SESSION-HANDOFF §0). `buildCaEndorsement` signs
  via `signCaEndorsementWith`; `store.ts` `writeCaEndorsement` defines
  `.maintainers/ca-endorsements/<ts>-<id>.json` — exactly what
  `rotate-ca.mjs` `readCaEndorsements` already reads. A non-fatal
  human-readable advisory fires when the signer is not the on-disk ca
  authority (but never hard-fails — authority is judged at the verifier's
  clock; overlapping leases / fresh takeovers are legitimate, §5.1/§11.2).
  Tests cross-check end to end against `verifyCaEndorsements`/
  `authorizedCaKeys` (live lease authorizes exactly the hot key; lapsed
  lease fail-closes at the verifier's clock; PIV path byte-identical to
  file:). 271 → **277**.

Flagship-side (this session, → `origin/main`): `scripts/rotate-ca.mjs`
Step-2 fallback now references the real `--signing-key yubikey-piv:slot=9c`
(file: noted as the lower-assurance air-gapped/successor fallback);
`docs/ca-operations.md` Path B corrected (the command + signer source now
exist; "staged" note removed). Flagship gate held **2526/2526 · tsc clean**.

**Phase-1 AGENT remaining (next session, START attentively — security-
critical, do NOT tail-bolt):** `--dry-run` for the four ceremony commands
(print exact canonical bytes + the would-write `.maintainers` diff; sign/
write NOTHING; resolve pubkeys via the no-PIN public read only). This
needs each `build*` refactored to first compute the *unsigned* envelope +
target path, then sign — so the dry-run preview is the SAME bytes the real
run signs (fidelity is the whole point). Then the plain-language ceremony
banner + typed explicit confirm + a never-log-secrets regression test, and
the native PC/SC `PivTransport` stub (APDU encoders pure+tested; the
libpcsclite round-trip fail-closes, verified only at the YubiKey gate).
Then the 1B human gate.

### 2026-05-17 — session 1 from the v1-launch program prompt (this Mac)

- Cold-start on a darwin/Mac box (Xcode 16.4, no JDK). Read SESSION-HANDOFF
  §0/§3/§5, memory MASTER RESUME, ca-operations.md, maintainer-ca §9–§12,
  maintainers-deployment.md, build-tasks §S.
- **Environment-sync drift found+fixed:** the gitignored `maintainers/`
  clone was stale at `c009900` (pre-CaEndorsement); `npx tsc -b` was RED on
  two `caTrustChain.ts` imports of `authorizedCaKeys`/`CaEndorsement`. Ran
  `bash scripts/pull-maintainers.sh pull` → synced to the pin `10c65aa` →
  `tsc -b` clean, `vitest run` **2526/2526**, maintainers suite **257/257**.
  Not a code regression; recorded in SESSION-HANDOFF §0.
- **Created this file** (`docs/v1-launch-program.md`) — first run from the
  program prompt; structured exactly as Phases 1–8; seeded from SESSION-
  HANDOFF §3 + §S. Authoritative for phase state hereafter.
- **Phase 1 design locked** (verified against `@maintainers/protocol` +
  `cli` source): external `Ed25519Signer` abstraction + `privKeySigner`
  wrapper (ONE signing path; ZERO protocol/wire/spec change) → CLI
  `yubikey-piv:` source with injectable transport → genesis/ceremony UX
  hardening. Build in progress on an upstream branch in `maintainers/`;
  lands via governed PR → re-pin.
- **Phase 1 AGENT — two keystone pieces landed (green, pushed):**
  - `protocol` external `Ed25519Signer` abstraction + `privKeySigner`
    (ONE signing path) + `sign*With` async variants — `f646f99`. ZERO
    canonical/verifier/wire/spec change (the §11.1 linchpin);
    back-compatible with every `{privKey}` caller. Tests prove
    byte-identity + token-shaped async signer + M-of-N order.
  - `cli` `loadSigner` + injectable `PivTransport` seam + fail-closed
    `realPivTransport` (no silent hex fallback) + `loadSignerPubKey`
    (no-PIN) + PIN-never-logged test — `9e7c495`.
  - maintainers suite **257 → 270**, `tsc -b` clean. Branch
    `feat/piv-ed25519-signer` PUSHED to `ibisllc/maintainers`; **draft
    PR #2** opened (push+PR pre-authorized §10.4; merge governed).
- **Phase 1 remaining (next session, at a START — security-critical,
  do NOT tail-bolt):** thread `loadSigner`/`loadSignerPubKey` through
  `genesis`/`mandate`/`takeover` (async `build*` + dispatch refactor);
  genesis/ceremony UX hardening (plain-language banner, `--dry-run` =
  print canonical bytes + `.maintainers` diff and write/sign nothing,
  typed explicit confirm, never-log-secrets, fail-closed
  human-readable refusals, second-key/successor guidance); add the
  **missing `ca-endorsement` CLI command** (ca-operations.md
  Operation 1 Path B references it but it does not exist — real gap,
  SESSION-HANDOFF §0); native PC/SC `PivTransport` (verified only at
  the YubiKey human gate). Then 1B human gate. `scripts/rotate-ca.mjs`
  Step-2 fallback string should reference `yubikey-piv:` once the
  command threading lands.
