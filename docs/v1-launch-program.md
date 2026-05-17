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
  = `10c65aa`, PR #1 merged): `npx vitest run` → **270 passed / 25 files**
  (257 baseline + 13 from the Phase-1 #28 signer seam on the not-yet-merged
  `feat/piv-ed25519-signer` branch; the pinned `10c65aa` itself is 257).
  On a fresh machine the clone is stale → run `bash scripts/pull-maintainers.sh
  pull` first (idempotent; resets to the pin). This was required on the
  2026-05-17 Mac (clone was at the pre-CaEndorsement base `c009900`; tsc -b
  was red on the two `caTrustChain.ts` `@maintainers/protocol` imports until
  the pull synced it to `10c65aa`).
  - **To continue Phase-1 #28 work:** `pull-maintainers.sh` resets the
    clone to the pin, discarding the local branch checkout (the branch
    is safe on origin). Re-checkout it: `cd maintainers && git fetch
    origin && git checkout feat/piv-ed25519-signer`, then continue
    committing there. The +13 #28 tests live only on that branch; the
    pinned `10c65aa` alone is 257. Always use absolute paths — the
    shell keeps cwd across tool calls, so a bare `cd maintainers`
    compounds (bit this session).
- Android: review-only on this Mac (`/usr/bin/java` is the macOS stub, no real
  JDK). iOS IS verifiable here (Xcode 16.4 / xcodebuild present). This is the
  inverse of the resume-#2 Linux box (JDK present, no xcodebuild).
- `apps/mobile/ios/App/FlagshipApp.xcodeproj/project.pbxproj` shows
  perpetually-modified — deterministic xcodegen artifact, never stage it.

## Phase status at a glance

| Phase | Title | State |
|---|---|---|
| **1** | Genesis ceremony (keystone; YubiKey in hand) | **▶ IN PROGRESS** — #28 keystone (protocol `Ed25519Signer` + CLI `loadSigner`/`PivTransport`) built+green+pushed (draft PR #2); command-threading + genesis UX + native transport + `ca-endorsement` cmd remain |
| 2 | Maintainers as its own product (#35 → #9 → #10) | ☐ blocked on Phase 1 |
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

### 1A. AGENT work (this is where current effort is)

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

### 1B. HUMAN GATE (YubiKey)

In order, after 1A lands and is merged+re-pinned:
1. Human runs `ca-operations.md` "Operation 0 — genesis" with the real
   YubiKey (primary key generates the cold maintainer Ed25519 on-token;
   second YubiKey named in `successors`). Agent walks through, verifies
   every emitted artifact (canonical bytes, signature, chain).
2. Agent bakes the emitted genesis pubkey(s) into `@flagship/protocol`
   `MAINTAINER_GENESIS_PUBKEYS` (#30 flips live).
3. Re-run the #8 suite to prove links 1–4 now resolve with a real genesis.
4. **Deploy nothing yet.**

---

## PHASE 2 — MAINTAINERS AS ITS OWN PRODUCT (#35, then #9, then #10)

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
