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
| **1** | Genesis ceremony (keystone) — **now: the first `upsertMandate`, its hash pinned** | **▶ Gate A SATISFIED; #28 done. Gate B RE-SEQUENCED behind the Phase-2 v2 lock (s4).** The genesis is no longer "per-track self-signed Mandate v1 + bake pubkeys" — it is **the first `upsertMandate` (Mandate v2, inline policy), whose canonical hash is the per-surface pin** (#30 generalised). Because Gate B freezes the pinned-mandate shape **forever**, the **Phase-2 v2 protocol redesign MUST land + be re-pinned BEFORE Gate B.** Gate B itself stays TWO-PART (P: human provisions `pcsclite`+`ykman`, on-token keygen both YubiKeys, plug in, set policy/`maxDuration`; A: agent implements+live-verifies the `connectPcscChannel` libpcsclite wiring behind the tested seam, never blind) → `--dry-run` → human signs the from-scratch `upsertMandate` → agent verifies + bakes the **pinned-mandate hash** + re-runs #8. `file:` NOT acceptable. Deploy nothing. |
| **2** | Maintainers as its own product — **v2 protocol redesign (now a Gate-B prerequisite)** | **✅ AGENT-SIDE PHASE A **and** AGENT-DOABLE PHASE E COMPLETE (s8). PR #3/#4/#5 merged + re-pinned `df992f2`; package `@ibisllc/maintainers`; gates green.** Phase E: marketplace scanner BUILT (`9aac1ec`, 2567/227); iOS verified green (human TestFlight gate); Recovery J.3/J.4 verified built+wired+tested (gap = live exercise); E2E rig+13 scenarios+CI all already built (gap = green Actions run). Android env-gated here (no JDK). **Next agent chunk = Phase F's agent-doable part: build the personalized ISO + local QEMU/KVM smoke (the real-VPS boot is a paid credential gate).** DEFERRED human/credential: npm publish (ibisllc org+fresh token; earlier token BURNED), Gate B genesis, iOS TestFlight, Android JDK-box, the §S live exercises, a green e2e Actions run. DEFERRED human follow-ups (off critical path): create `ibisllc` npm org + fresh `@ibisllc` token (earlier token BURNED — revoke) → npm publish → flagship drops pull-script/symlink; Gate B genesis; iOS TestFlight; Android on a JDK box. (Prior s8 detail:) **PR #3+#4 MERGED + re-pinned `4a272b9`; package RENAMED `@maintainers/protocol`→`@ibisllc/maintainers` (PR #5 OPEN→merged); per user "rename now, publish later → proceed critical-path".** Maintainer merged PR #3 (Phase-2 spine) + PR #4 (npm packaging-prep); agent re-pinned (`ea9f707`→`aceb204`), gates green at each pin. The `@maintainers` npm scope is permanently unobtainable (an unrelated unscoped `maintainers` pkg blocks the org), so renamed to `@ibisllc/maintainers` — maintainers `5f93129` (**governed PR #5 open**, pure specifier swap, no semantic change) + flagship `11f3a06` (consumer rename + regenerated workspace symlink + prose sweep); re-verified maintainers 370/36 · flagship 2529/225 · `npm pack`→`@ibisllc/maintainers@0.1.0`. **Next:** merge PR #5 → agent re-pin → **proceed critical-path** (Gate B prep / Phase E). npm publish + flagship-drops-pull-script(+symlink) are DEFERRED tracked follow-ups (off critical path; user revoke the leaked bypass-2FA token + create the `ibisllc` org for the later publish). **Prior state (all LANDED):** c4.6 maintainers `a8ac151` + flagship `c5995c9`; c4.7 `f509849`; c5 `6acca14` (spec §7.1/§12 + `fetch()` client + portable `maintainers/conformance/` 17-vector set); ceremony hardening maintainers `10979ab` (typed PC/SC taxonomy + no-hardware UX + dry-run byte-fidelity; native binding deliberately NOT written blind) + flagship `6cd2c55` (ca-operations Operation 0 reconciled). maintainers `feat/keyfile-register` tip `10979ab` (**370/36**); flagship `main` (**2529/225**); all pushed; pin UNCHANGED `833fa45`. **Remaining Phase-A + all Phase-B is HUMAN-gated** (governed PR merge → agent re-pin → HUMAN `npm publish` → flagship drops pull-script → HUMAN Gate B genesis ceremony). The exact copy-pasteable human steps are in SESSION-HANDOFF §0 (top entry) + `docs/ca-operations.md` Operation 0. Per the LOCKED v2 design below. **c1 `dc48559`** + **c2 `5f3b146`** (v2 core) + **c3a `23a4d35`** + **c3b `2fa2b0c`** (CLI verbs) — s5. **s6: c4.1 `6cfee83`** (v2 endorsement layer, additive — `verifyChainOfEndorsementsV2`/`verifyCaEndorsementsV2`/`authorizedCaKeysV2`, holder-signs; maintainers **371/36**) + **c4.3 `5fb2fdf`** (flagship #30 generalised → `MAINTAINER_PINNED_MANDATE_HASH`) + **c4.4 `ff8ce91`** (the LIVE flagship trust consumer `releaseVerifier.ts`/`caTrustChain.ts` migrated to verify-forward-from-pin; **flagship gate now a REAL v2 consumer check**, new baseline **2529/225**) — all LANDED + pushed on `feat/keyfile-register` / `main`; NOT pinned (`833fa45`). flagship no longer imports ANY v1 Mandate-path symbol. genesis/mandate/takeover + the v1 Mandate path remain (retired in **c4.5e**). **Remaining:** **c4.5 — the maintainers v1→v2 cutover, CONSUMER-FIRST decomposed (s7 verify-before-trust correction; the "one atomic commit" call is SUPERSEDED — the true blast radius is ~30 files / 5 packages incl. the forgotten `extension`; consumer-first→removal-last is safe because the v2 symbols already exist additively):** **c4.5a worker `650fee2` ✅** → **c4.5b web-ui `429a57c` ✅** (signing views onboard/renew/takeover DELETED per #31) → **c4.5c extension `fba0657` ✅** (pure verifier) → **c4.5d cli `616b8f9` ✅** (genesis/mandate/takeover verbs DELETED — collapsed into the landed upsert-mandate) → **c4.5e-pre flagship `def22ca` ✅** (verify-before-trust found 4 MISSED flagship v1 consumers — flagship resolves @maintainers/protocol via a LIVE symlink not the pin; re-based incl. the regenerated v2 .maintainers/ artifact) → **c4.5e protocol v1-removal `208978a` ✅ — DONE, v1 fully gone, v2 is the SOLE trust path** (maintainers **382/37 → 330/33**, flagship guard **2529/225 ALL PASS**). ~~**c4.5e protocol v1-removal (LAST;~~ re-home the shared VerifiedEndorsements/EndorsementFailReason/VerifiedCaEndorsements types)** — a–d order-free + independent, each its OWN green commit (v2 coexists with v1 until e), flagship guard 2529/225 throughout. → **c4.6 de-version rename `a8ac151` (maintainers) + `c5995c9` (flagship) ✅ — LANDED s8** (dropped the `V2` code-symbol suffix everywhere + reset the Mandate envelope `version 2→1` + canonical tag `maintainers/mandate/v2→/v1`; the real load-bearing tag site was the local `joinTagged2` builder, not the comment — renamed `joinTaggedMandate`/`/v1` so `mandatePinHash` genuinely changes; `.maintainers/` artifact regenerated to v1, KeyFiles byte-unchanged, byte-deterministic; NOT a trust-model change; maintainers 330/33, flagship 2529/225, pin UNCHANGED `833fa45`) → **c4.7** spec (authored directly under the final name) → **c5** published spec + `fetch()` client + conformance vectors → governed PR → re-pin → `npm publish` → drop pull-script. (The old separate-additive-`Envelope` "c4.2" was deleted as over-decomposition — folds into c4.5.) **This redesign PRECEDES Gate B** (it defines the artifact the ceremony freezes forever). |
| 3 | The maintainers app (retire the CLI) — #31 + #32 | ☐ blocked on Phase 2 |
| 4 | Real install chain on test hardware — #21 + #22 | ☐ seam built; human/hardware |
| 5 | On-demand VPS + promo AI + real vibe-code | ☐ seam built (#83/#85); human/credential |
| 6 | Mobile apps to stores — #16/#17/#18 + iOS/Android | ☐ seam built; human/accounts |
| 7 | Monitoring dashboard (costs) | ☐ depends on Phase 5 telemetry |
| 8 | Remaining v1-alpha live exercises → tick §S | ☐ human-clocked exercises |

**Trust-chain spine ordering REVISED (s4 v2 lock):** the Phase-2 v2
protocol redesign now **precedes** Phase-1's Gate B (Gate B freezes the
pinned-mandate shape forever, so the v2 Mandate must be final + pinned
first). Effective critical path: **Phase-2 v2 protocol redesign +
re-pin → Gate B (the first `upsertMandate`, hash pinned) → #9 webapp →
#10 mobile → Phase 3**. Phases 4–8 are seam-complete and
human/hardware/credential-gated; they may advance opportunistically
when their human gate is satisfiable, but the launch-blocking thrust is
the spine above (everything downstream verifies against the pin).

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

### 1B. HUMAN GATE (YubiKey)

> ⚠ **PARTIALLY SUPERSEDED by the Phase-2 v2 LOCK (s4).** The
> `connectPcscChannel`/PC-SC TWO-PART finding (P provisions / A
> implements+live-verifies the libpcsclite wiring, never blind) and
> the no-hardware-assumptions UX bar **still hold verbatim**. But the
> v1-era specifics below — *per-track* genesis, baking
> `MAINTAINER_GENESIS_PUBKEYS` (pubkeys), the `register` c1–c5 plan
> with c5 `--mandate-id`, the `introductionMandate` pre-mint, the
> 0c/0d/1/2 steps — are **OBSOLETE.** Under the v2 lock: genesis = the
> **first `upsertMandate`** (Mandate v2, inline policy, set the
> `threshold N of […]` + `minSuccessors` + `maxDuration` at create);
> the per-surface pin = **its canonical hash** (#30 generalised), not a
> pubkey list; `createKey` is independent + non-load-bearing (no
> `introductionMandate` bootstrap). And Gate B is **gated on the
> Phase-2 v2 protocol redesign landing + re-pinning first** (it freezes
> the pinned-mandate shape forever). Authoritative = "Phase-2 DESIGN
> DECISION — LOCKED v2" above. Read steps below ONLY for the still-valid
> PC/SC + provisioning + UX content.

#### 1B (historical detail — PC/SC + provisioning still valid; mandate specifics superseded) · TWO-PART (s4 finding)

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

### Phase-2 DESIGN DECISION — **LOCKED v2 (2026-05-17 s4, user-authorized override of the prior D1/D2 lock)**

> SUPERSEDES the prior "pin one key, fetch a folder" D1/D2 lock.
> D3 (freshness = `CaEndorsement` NOW-clock lease) is **unchanged** and
> carried forward. Deliberated with the user across s4 and explicitly
> re-locked; it overrides a previously-LOCKED decision and changes a
> security invariant, so it is recorded with full rationale. **Do NOT
> re-litigate without the user.**

**The model: "pin a mandate, verify forward; the mandate carries its
own succession rule; there is no privileged self-renewal."**

- **L1 — A pinned `Mandate` is an INDEPENDENT trust anchor (generalises
  "genesis").** A consumer bakes the canonical hash of *some* Mandate
  into its signed build and verifies the chain **forward** from it.
  Genesis is merely "the first pin." Multiple pinned roots coexist
  **forever**: an old build pinned at M₀ and a newer build pinned at a
  later, more-cosigned Mᵢ both remain independently valid — nothing
  requires walking back to genesis. REPLACES prior D2 ("genesis is the
  only anchor; checkpoints are optimization-not-floor") and **rewrites
  spec §5.2: the pin IS the floor.** Fail-closed preserved: no baked
  pin ⇒ reject all (the #30 invariant, generalised).
- **L2 — Succession policy lives INSIDE the `Mandate` (no separate
  policy file).** Each Mandate carries `approvalRule`
  (`threshold N of [pubkeys]`), `successors`, `minSuccessors`,
  `maxDuration`, `defaultDuration` (+ the project-level `contact` /
  track-list on the from-scratch mandate). DISSOLVES prior D1: the
  unsigned-`policy.json` hole and the `SignedPolicy` envelope are
  **gone** — the rule governing mandate K+1 is signed *into* mandate K,
  as trustworthy as the chain itself. No separate policy artifact
  exists.
- **L3 — No self-renewal; ONE uniform succession rule.** No privileged
  "holder extends in-window" path. Mandate K+1 is valid **iff** its
  signatures satisfy **K's embedded `approvalRule`** over **K's
  authorised signer set**, AND K+1 obeys K's constraints
  (`successors.length ≥ K.minSuccessors`, `duration ≤ K.maxDuration`).
  Renewal = rotation = takeover = removal = repolicy = that ONE
  mechanism. Solo founder: `successors=[self,backups], threshold=1`
  (renewal effort identical to self-renew today); growth = issue a
  mandate with real `threshold N of [M people]` and the strong property
  switches on **automatically — no knob, no exploitable exemption**.
  Bounded `maxDuration` ⇒ perpetuation structurally requires the quorum
  to periodically re-convene (the anti-rubber-hose property, emergent
  not configured). The `selfRenewable` knob was explicitly REJECTED (a
  control the adversary can decline to engage is not a control).
  Removes the verifier's holder-in-window-vs-after-expiry split — a
  real simplification of the load-bearing path.
- **D3 — Freshness IS the shipped `CaEndorsement` lease, nothing new.**
  Rule (not mechanism): a consumer MUST require a `CaEndorsement` whose
  `[notBefore,notAfter)` contains its OWN now, judged at its OWN clock.
  Host withholds ⇒ newest lease lapses ⇒ all consumers fail closed
  within one window (default 7d). Cold maintainer track stays
  long-lived; the hot key's short lease is the beacon. No timestamp
  server / snapshot role / CRL.
- **Accepted limitation (state to adopters), UNCHANGED + clarified:**
  still NO equivocation/split-view detection (a host serving divergent
  *valid* forward-histories to different consumers is undetectable).
  Multi-pin does NOT add equivocation detection; it *narrows* the
  rollback window (a later pin discards everything before it). CT-style
  gossip remains out of scope for Flagship's threat model.
- **Security boundary, explicit.** "From-scratch" `upsertMandate` is
  unauthenticated by the protocol — anyone with push can mint an
  "origin." 100% of the trust is *which mandate's hash is compiled into
  the signed app/release*; the protocol guarantees only "verify forward
  from the baked pin, unforgeably," and distributing the correct pin
  rides the existing signed-release trust (the bake IS the ceremony). A
  captured *valid quorum* can re-set policy arbitrarily — the only
  guard is the pin (consumers on an earlier, stronger pin are
  unaffected until they ship a build with a newer pin). Inherent;
  pinning is the answer.

> **Naming addendum (user decision 2026-05-17 s6):** the "**v2**" label
> throughout this section is a *transitional development artifact* used
> only to let the new model coexist with v1 during the cutover. The
> maintainers protocol is **unreleased and never used**, so its
> first-ever shipped version must NOT be called "v2". Once v1 is fully
> removed (**c4.5**), a dedicated **c4.6 de-version rename** drops the
> `V2` code-symbol suffix everywhere and resets the Mandate envelope to
> `version: 1` / canonical tag `maintainers/mandate/v1` (a numeric wire
> version is kept — good engineering; only "v1 named v2" is the
> nonsense). This is **naming + the wire-version integer only — NOT a
> trust-model change**; everything in L1/L2/L3/D3 below is unchanged.
> It changes `mandatePinHash`, so it MUST land before c5 and Gate B
> (acceptable in the same pre-pin window noted just below).

- This is a **`Mandate` canonical-bytes / verifier change** (inline
  policy; the one-rule authorisation; pinned-anchor verify-forward; the
  envelope's eventual released version is **1**, see the naming addendum
  above — "v2" here is transitional). It is NOT additive. It is
  acceptable *precisely because there is no real genesis yet*
  (`MAINTAINER_PINNED_MANDATE_HASH` empty; no chain; nothing pinned).
  Once Gate B runs, the pinned mandate's shape is **frozen forever.**
- ⇒ **The locked-model protocol redesign MUST land (governed PR →
  re-pin) BEFORE Gate B.** Phase-2's protocol spine is now a
  **prerequisite of Phase-1's Gate B**, not "after" it. Revised
  ordering: *Phase-2 protocol redesign → Gate B (genesis = the first
  `upsertMandate`, its hash pinned) → the rest.*
- **#30 generalised:** bake the **pinned Mandate's canonical hash** per
  surface (protocol-const, webapp via it, iOS, Android — same value),
  NOT a `MAINTAINER_GENESIS_PUBKEYS` pubkey list. Fail-closed when
  unset. Re-bake-per-surface discipline unchanged.
- **CLI verbs:** `createKey` (KeyFile self-registration — KEPT;
  `c1 dc48559` stays; human-identity layer hangs off pubkeys, NOT
  load-bearing) **+** `upsertMandate` (the ONE mandate verb:
  fetch-if-exists → design next → sign per the *predecessor's* embedded
  rule; from-scratch sets initial policy freely). `genesis` / `mandate`
  / `takeover` collapse into `upsertMandate`. The prior
  `--mandate-id` / `introductionMandate`-bootstrap sub-plan is
  **OBSOLETE** (no separate policy/`SignedPolicy`; `createKey` is
  independent + non-load-bearing).

- **#35 (reshaped to v2)**: implement the locked v2 protocol in
  `maintainers` (Mandate **v2** canonical bytes incl. inline policy;
  the L3 one-rule verify-forward; pinned-mandate anchor; `createKey` +
  `upsertMandate` CLI) → governed PR → re-pin (this is the Gate-B
  prerequisite). Then `npm publish @maintainers/protocol` (semver,
  `--provenance`, `npm ci`-pinnable) + the versioned **v2 spec** +
  `fetch()` reference client + a published **conformance test-vector
  set** that MUST include the v2 fail-closed negatives: *absent/forked
  pin ⇒ reject*, *pin-not-in-log ⇒ reject*, *self-renewal-attempt ⇒
  reject*, *sub-threshold signers ⇒ reject*, *under-`minSuccessors` ⇒
  reject*, *over-`maxDuration` ⇒ reject*, *endorsement-gap ⇒ reject*,
  *lapsed-lease-at-NOW ⇒ reject*, *tampered/rolled-back history ⇒
  reject*. Flagship DROPS `scripts/pull-maintainers.sh` +
  `maintainers.pinned-sha` and consumes the published package like any
  adopter (honest dogfooding). HUMAN GATES: the governed PR merge
  (PR #1/#2 precedent), and npm org/2FA + `npm publish` (classifier may
  block even post-approval — if so the human runs the one command).
- Then **#9** (webapp link-4: the #8 `caTrustChain.ts` shape in
  `apps/web` + a bundled browser verifier) → **#10** (iOS Swift +
  Android Kotlin reimpl of the v2 verify-forward + freshness, each
  PROVEN against the published v2 conformance vectors incl. every
  fail-closed negative). #10 is the heaviest single item — sequence it,
  don't tail-bolt.
- **THE PINNED-MANDATE HASH MUST BE RE-BAKED PER SURFACE.** The
  Phase-1/Gate-B bake populates the one TS constant in
  `@flagship/protocol` (#30 generalised: the *pinned Mandate canonical
  hash*, not a pubkey list) — that covers the daemon (#8, wired) and
  the webapp (#9, once wired). iOS (Swift) and Android (Kotlin) are
  independent reimplementations: each #10 port MUST hardcode the
  **same** pinned-mandate hash into its own source (today `apps/mobile`
  contains ZERO genesis material — verified). #10's acceptance bar —
  proven against the published v2 vectors incl. *absent/forked pin ⇒
  reject* — is the guard that no port ships with a wrong/empty/
  placeholder pin. Same hash value, four baked locations
  (protocol-const, webapp via it, iOS, Android), sequenced:
  Phase-2-protocol-redesign → Gate B → per-surface re-bake.

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

### 2026-05-18 — session 8 cont. (Mac/darwin): genesis scope decided — `ca` ONLY (ops dropped, release deferred); ceremony about to run

Multi-turn simplicity/threat-model + TUF-comparison dialogue with the
owner. Outcome: the irreversible genesis signs **`ca` only**. `ops`
dropped (no v1 consumer). `release` deferred to its own isolated later
genesis if a release-role materializes (app-store signing +
reproducible-build CI + TUF/Sigstore cover the self-hosted-update slice
for alpha; honest finding: maintainers' sweet spot is the
`ca`/identity-authority plane TUF can't model — `release` is a
simplified TUF-targets slice, deferrable/delegable). Rejected:
hot-Cloudflare-key signing releases (collapses the cold/hot split;
SHA=integrity≠authority). Two keys only (primary+backup), not
per-track. Full reasoning + the exact ceremony in SESSION-HANDOFF §0;
checkpoint-spec open-details updated (multi-track `track` column,
funding-deferral, TUF scope-honesty) `f79b16f`. Ceremony (ca-only),
about to run, nothing signed yet (pin `ce6691c`, tree clean):
create-key#1 (key#1) → upsert-mandate --track ca ORIGIN (key#1,
successors=[key#1,key#2], threshold 1, 100d/3650d) → swap → create-key#2
(key#2). Then verify + record the single ca `mandatePinHash` (Phase C
bakes it 4×) + commit `.maintainers/`.

### 2026-05-18 — session 8 cont. (Mac/darwin): NEW Phase H roadmapped — Maintainers Checkpoints witness layer (additive; post-genesis; does NOT block Gate B)

After an external second opinion, the owner adopted a **Maintainers
Checkpoints** layer (full spec captured verbatim at
`docs/maintainers-checkpoints-spec-v0.1.md`). It is a public,
append-only, mirrorable **witness log** (`github.com/ibisllc/
maintainers-checkpoints`, one CSV per project, PR-based, bot-validated:
repo-reachable + claimed-hash-present + chain-valid + current-authority-
signed + §11 continuity `H_old ∈ chain(H_new)` + append-only) plus a
`maintainers checkpoint submit` CLI + an *optional advisory* consumer
check. **It directly closes the previously-accepted gap (single
bake-path / equivocation detection-not-prevention) at low cost and is
PURELY ADDITIVE — zero change to the shipped Mandate format / canonical
bytes / verifier / L1-L3/D3 / conformance vectors / pin model.** It is
inherently post-genesis (cannot witness a non-existent mandate) ⇒ it
does **NOT block Gate B**. Roadmapped as **Phase H** (build after
genesis; or build the `checkpoint submit` tooling first so genesis is
the inaugural checkpoint — a sequencing decision posed to the owner).
Five open design details to pin before build are recorded at the foot
of the spec file + SESSION-HANDOFF §0 (chief among them: authority-proof
= holder-signs vs succession-quorum; make the request a first-class
tagged signed envelope `maintainers/checkpoint-request/v1` + conformance
vectors; new-repo creation is a human gate). Decision-gate that paused
the genesis is RESOLVED — the owner's concern is addressed by this
additive layer, so the genesis ceremony is unblocked.

### 2026-05-18 — session 8 cont. (Mac/darwin): Gate-B genesis prerequisite landed (placeholder scaffold retired; adopter-faithful); pre-ceremony dry-run caught 2 defects

Re-pinned to PR#6 merge `ce6691c` (flagship `a1a53ed`; gates 372/36 ·
2567/227; pcsclite ceremony dep re-installed). The pre-ceremony dry-run
(verify-before-trust) caught, before any irreversible signing: (1) the
runbook's `node packages/cli/dist/index.js …` is exports-only — real
entry is `node packages/cli/bin/maintainers …` (fixed 5×); (2) a
from-scratch ORIGIN conflicts with the committed deterministic
placeholder genesis mandates. User's deciding criterion — "what does a
real adopter do?" — chose **Option 2**: retire the placeholder scaffold
so Flagship's setup is byte-identical to a fresh adopter's (honest
reference template, the Phase-A objective). Confirmed the trust model
to the user (recovery-vs-redefine; independent holder/successors/
threshold + self-exclusion; branch defense = pin-floor + public log +
timestamps/lease + ReleaseEndorsement, with equivocation-prevention an
explicitly accepted out-of-scope limitation). **Landed flagship
`2016985`** (orchestrator-audited + gate re-run): `git rm` the 5
committed placeholders + the 2 `bootstrap-flagship-maintainers.{mjs,
test.ts}` scaffold files; `.maintainers/` clean (README only); chain
already fail-closed via the empty `MAINTAINER_PINNED_MANDATE_HASH`
(unchanged `""` — no ceremony/bake performed); `ca-operations.md`
Operation 0 reconciled to the adopter-identical flow ((P) → create-key
×2 → from-scratch ORIGIN ×3 → verify/status → record mandatePinHash;
bake = Phase C). Flagship-only; zero maintainers/protocol/pin change;
gate 2567/227 → **2563/226** (−4 = the obsolete bootstrap test; 0
failed). Pin `ce6691c`. Next: 2 persona identities → drive all
dry-runs → human signs each real run → record the 4-surface pin.

### 2026-05-18 — session 8 cont. (Mac/darwin): GATE-B step (A) done + a root-of-trust codec bug caught & fixed (PR #6 open)

User provisioned both YubiKeys (on-token Ed25519 slot-9c; PIN/PUK set;
PIN-protected random mgmt key — ykman-confirmed). Orchestrator fixed
the predicted `-g` pcsclite resolution blocker (installed local
`--no-save`, §28 optional dep) and captured the independent oracle
(key-#1 slot-9c pubkey `2137e739…71d7`). Subagent #1 implemented the
real native libpcsclite `connectPcscChannel` binding (behind the
unchanged seam + piv-apdu codec; PC/SC→typed taxonomy). ★ The hardware
gate surfaced a pre-existing root-of-trust bug: `getPublicKey` parsed
the no-PIN GET-METADATA response with the GENERATE-only `7F49{86}`
parser, but real metadata is `0x04→0x86` — it threw on every real
token. Subagent #2 fixed it (dedicated strict `extractMetadataPublicKey`;
GENERATE path preserved; real-bytes hermetic regression + 5 negatives).
Orchestrator verify-before-trust (never trusted either subagent):
audited the confined diff; re-ran the hermetic gate itself (372/36, 0
failed, ~1.3 s, hardware-independent); and **independently re-drove
both the raw transport and the full production path
`loadSignerPubKey("yubikey-piv:slot=9c")` against the real token, 3/3
=== the oracle, ykman PIN+PUK 3/3 unchanged before+after (non-
destructive — no PIN/touch/sign)**. Committed `feat/gate-b-pcsc-binding`
`59363fa`, governed **PR #6 open**, pin `df992f2` unchanged. Next:
human merges PR #6 → re-pin → re-install pcsclite ceremony-dep →
dry-run all 3 tracks → human performs the signed `upsert-mandate` per
track → record each `mandatePinHash` (→ Phase C bake). Runbook =
`docs/ca-operations.md` Operation 0.

### 2026-05-18 — session 8 (Mac/darwin): agent-doable Phase E COMPLETE — recon showed J.3/J.4 + E2E already built

Verify-before-trust over the prompt's Phase-E framing (docs/landed-code
win). **Recovery J.3/J.4** = code-complete + runtime-wired + tested
green (NOT greenfield): `server-daemon/src/postRecovery/rePairWatcher.ts`
(J.3 — 24h-grace IRK swap + paired-session drop, restart-safe; `.com`
routes `controlPlaneRoutes.ts:200-203,668`; daemon wires it in
`index.ts`) + `stableIdReissuer.ts` (J.4 — walk apps → re-issue
stable-ids → per-app alert) + green tests (`control-plane/tests/
rePair.test.ts` ~12+ cases, `server-daemon/tests/rePairWatcher.test.ts`)
in the 2567/227 gate. **E2E rig + all 13 plan scenarios + CI** already
built (backlog #15): `apps/web/e2e/` + 17 specs s00–s16 (S7 "silent
auto-renewal—CRITICAL" folded into `s06-long-lived-lease.spec.ts:72`,
verified) + `.github/workflows/e2e.yml`. Both gaps are non-code:
J.3/J.4 ⇒ the lost-phone LIVE exercise (Phase G); E2E ⇒ a green run on
a real GitHub Actions runner (CI-execution gate, CLI can't trigger
Actions — same seam as build-iso.yml). The only net-new Phase-E code
was the marketplace scanner (`9aac1ec`, prior entry). iOS
code-complete+green (human TestFlight gate); Android env-gated here (no
JDK). **⇒ agent-doable Phase E done. Next = Phase F agent-doable: build
the personalized ISO (reproducible path) + local QEMU/KVM smoke; the
real-VPS boot is a paid credential gate (user API token).**

### 2026-05-18 — session 8 (Mac/darwin): Phase E — marketplace security-scan service built (wire-contract bug fixed)

flagship `9aac1ec`. Built the missing scanner/producer at
`services/marketplace-scanner/` (a non-functional scaffold existed; the
.com receive side + `scan_grade` schema + the protocol envelope were
already built). ★ Fixed a latent wire-contract bug — the scaffold
hand-rolled tag `flagship/marketplace-scan/v1` vs the landed
`flagship/marketplace-scan-result/v1`; rewrote to reuse
`@flagship/protocol`'s `signMarketplaceScanResult`/
`verifyMarketplaceScanResult` (guaranteed byte-match; proven:
construct→sign→LANDED-verify ✓, tamper/forge/wrong-key→reject).
Fail-closed (any clone/tool/timeout/hash-mismatch ⇒ "F", still
scanner-signed; `isPassingGrade`∈{A,B,C}); real git/trivy/npm/semgrep/
R2/postback behind injected ports (gate never execs them). Pure-core +
ports + thin live adapter. ZERO protocol/control-plane/storage/
migration change. Orchestrator re-ran the gate: flagship tsc -b clean +
vitest 2529/225 → **2567/227** (+38, 0 failed). Next Phase-E:
verify/complete Recovery J.3/J.4 (recon: substantially built; gap = the
live exercise, Phase G) → E2E 13 scenarios + CI. iOS verified
green/human-gated; Android env-gated (no JDK here).

### 2026-05-18 — session 8 (Mac/darwin box): PR #5 merged → re-pinned `df992f2` → AGENT-SIDE PHASE A COMPLETE; entered Phase E (iOS verified green/human-gated)

Maintainer merged governed **PR #5** (the `@maintainers/protocol`→
`@ibisllc/maintainers` rename). Verify-before-trust: merge `df992f2`
(first-parent `4a272b9`=old pin; merged tree == verified `5f93129`).
Re-pinned `scripts/maintainers.pinned-sha` `4a272b9`→**`df992f2`**,
`pull-maintainers.sh` reset the clone, both gates GREEN at the pin
(maintainers 370/36; flagship 2529/225 via the `@ibisllc/maintainers`
symlink); flagship `0eddcb8`. **⇒ THE ENTIRE AGENT-SIDE PHASE A IS
COMPLETE** (protocol-product spine + ceremony hardening + PRs #3/#4/#5
merged & re-pinned + the npm-publishable rename). Per the user,
proceeding the critical path (Phase E).

**Phase E entry — verify-before-trust over the prompt's framing (docs
win):** the prompt lists "iOS real impl" as build work; the in-repo +
memory reality is iOS is production-grade + fully green. Orchestrator
regression-verified at current HEAD on this Mac (Xcode 16.4):
`xcodebuild …FlagshipApp build` = BUILD SUCCEEDED; `xcodebuild -scheme
FlagshipMobile-Package … test` = **232 tests, 0 failures** (suite grew
110→232; iOS has zero `@maintainers` coupling ⇒ provably unaffected by
this session's maintainers-rename work). **No iOS implementation gap —
every remaining iOS step is the user-side TestFlight gate**
([[project-testflight-blockers]]). Android is real-impl work but
env-gated on this Mac (no JDK → review-only). Recon found **Recovery
J.3/J.4 substantially BUILT already** (postRecovery/rePairWatcher +
stableIdReissuer + tests — the gap is the live exercise, Phase G, not
greenfield code) and the **E2E rig exists** (backlog #15; gap = the 13
scenarios + CI). **Next agent chunk = the marketplace security-scan
service** (scan_grade NULL today; CLAUDE.md #4; fully agent-doable,
vitest-verifiable, no gate) → then recovery J.3/J.4 verify/complete →
E2E scenarios. iOS = done (human-gated handoff); Android = env-gated.

### 2026-05-18 — session 8 (Mac/darwin box): PR #4 merged → re-pinned `4a272b9`; `@maintainers/protocol`→`@ibisllc/maintainers` rename (PR #5 open)

Maintainer merged governed **PR #4** (npm packaging-prep). Agent
re-pinned `scripts/maintainers.pinned-sha` `8e8915e`→**`4a272b9`** (PR#4
first-parent merge commit; flagship `aceb204`), both gates GREEN at the
pin (maintainers 370/36; flagship 2529/225). Publish attempt then hit a
**namespace fact** (not our code): `npm publish` went ENEEDAUTH → 403
(2FA) → 404 **"Scope not found"**. `npm view` proved an unrelated
unscoped `maintainers@1.0.0` (owner `alestoraldous`) exists ⇒ npm
forbids creating an org named `maintainers` ⇒ `@maintainers` scope is
permanently unobtainable ⇒ `@maintainers/protocol` unpublishable.
`@ibisllc/maintainers` is free (E404) + the clean
`github.com/ibisllc/maintainers` provenance mapping. User chose (via
AskUserQuestion): **rename now, publish later, then proceed
critical-path.**

A fresh subagent did the pure specifier rename
`@maintainers/protocol`→`@ibisllc/maintainers` — maintainers `5f93129`
(branch `chore/rename-protocol-to-ibisllc-maintainers`, **governed PR
#5 open**; 43 files, +60/−60, zero protocol/canonical/verifier/spec/
version change; `package.json` name only, exports/files/publishConfig/
prepack/0.1.0 preserved, dir unmoved; sibling `@maintainers/*` +
`@maintainers/source` deliberately left). Flagship `11f3a06`: consumer
imports + the 2 `.mjs` + lockfile + the regenerated
`node_modules/@ibisllc/maintainers` npm-workspace symlink (old scope
dir removed; flagship `workspaces` lists the PATH so it auto-relinks
from the new name) + the byte-identity `.mjs:209`↔`.maintainers/
README.md` pair in lockstep + an orchestrator prose/comment sweep of
the ACTIVE flagship docs (ca-operations runbook etc.) so the final name
never churns (orchestrator-owned historical trackers keep their
period-accurate mentions). Verify-before-trust: orchestrator audited
(name-only; siblings intact; zero residual specifier; pin/trackers
untouched; pbxproj not staged) + re-ran BOTH gates — maintainers tsc -b
clean + **370/36**; flagship tsc -b clean + **2529/225** via the
regenerated symlink (re-run again post-sweep, still green); `npm pack
--dry-run` → `@ibisllc/maintainers@0.1.0`, 67 files. Token hygiene: the
user's pasted bypass-2FA token used transiently + scrubbed; **user must
revoke it**; future publish needs a fresh `@ibisllc`-scoped token after
the `ibisllc` org exists. **Next: merge PR #5 → agent re-pin → proceed
the critical path (Gate B prep / Phase E). npm publish +
flagship-drops-pull-script(+symlink) are DEFERRED tracked follow-ups.**

### 2026-05-18 — session 8 (Mac/darwin box): PR #3 MERGED → re-pinned `8e8915e`; npm packaging-prep landed (PR #4 open)

The maintainer merged the governed **PR #3** (`feat/keyfile-register`→
`main`: the entire 14-commit Phase-2 v2 spine). Verify-before-trust:
`gh pr view 3` MERGED, merge commit **`8e8915e`** (first parent =
old-pin `833fa45`, second = branch tip `10979ab`; `git diff 8e8915e
10979ab` empty ⇒ merged tree == gate-verified tree). Re-pinned
`scripts/maintainers.pinned-sha` `833fa45`→`8e8915e` (the first-parent
merge commit, PR #1/#2 rule), `pull-maintainers.sh` reset the clone,
both gates re-run GREEN AT THE PIN (maintainers 370/36; flagship
2529/225); flagship `ea9f707`. User-asked release audit answered: code
100% de-versioned (zero `…V2`/`version:2`/`mandate/v2`; the only "v2"
text is two spec sentences explicitly stating "there is no v2"); all
release surfaces present + gate-green; only the native libpcsclite
transmit is the deliberate Gate-B hardware increment.

Then a fresh subagent did the **npm packaging-prep** (verify-before-
trust caught that the package was NOT one-command-publishable —
`private:true`, raw-TS exports, no `files`, vectors/spec outside the
pkg). On a NEW branch off `8e8915e` (`feat/publish-protocol`, NOT the
merged dev branch): removed `private`, `publishConfig.access:public`,
a conditional `exports` that keeps the flagship live-symlink resolution
byte-unchanged while shipping compiled `dist/`, a `files` allowlist, a
`prepack` that builds + deterministically stages the repo-root
`conformance/` + `docs/spec/v1.md` into the tarball, a package README
+ byte-identical LICENSE; version stays 0.1.0 (spec is Draft-targeting-
1.0-on-independent-interop). Orchestrator re-verified with `tsc -b
--force` on BOTH repos (the cache-defeating symlink guardrail):
maintainers clean + 370/36; flagship clean + **2529/225**; `npm pack
--dry-run` 67 files (dist + README + LICENSE + SPEC.md + 17 vectors +
manifest; no src/tests/tsconfig); `npm publish --dry-run --access
public` validates. Committed `1e9705f`, pushed, **governed PR #4
open**. Zero protocol/spec/conformance semantic change. **Next,
HUMAN-gated in order:** merge PR #4 → agent re-pins to its merge SHA +
reruns gates → HUMAN `npm publish --access public` → flagship drops
pull-script + symlink + consumes the published pkg → HUMAN Gate B.

### 2026-05-18 — session 8 (Mac/darwin box): ceremony tooling hardened UP TO the hardware gate — agent-side Phase A DONE, PAUSED at the human gate

**maintainers `10979ab` + flagship `6cd2c55`, both pushed.** A fresh
subagent hardened the genesis-ceremony tooling to the documented
(P)/(A) gate WITHOUT writing the security-critical native libpcsclite
transport blind. (A) `docs/ca-operations.md` Operation 0 reconciled to
the de-versioned reality (`upsert-mandate` not `genesis`;
`MAINTAINER_PINNED_MANDATE_HASH` not `MAINTAINER_GENESIS_PUBKEYS`; no
`policy.json`; tag `maintainers/mandate/v1`; confirm phrase
`UPSERT-MANDATE`; c5 conformance ref; + a copy-pasteable (P)
provisioning checklist + a dry-run-vs-needs-YubiKey table; every command
source-verified vs the landed CLI). (B) typed PC/SC error taxonomy
(`PcscNotReadyError` recoverable / `PcscSecurityError` fatal-no-fallback
/ `PcscBuildError` fatal-not-retried, all `extends CliError`) +
`piv-connect.ts` `connectPcscChannelWithPrompt` (prompt+wait+poll loop,
branches only on `isRecoverableNotReady`, non-interactive fails closed
immediately, bounded, no degraded/fallback return — satisfies
[[feedback-no-hardware-assumptions]]); fully fake-injected tests. (C)
dry-run byte-fidelity test (genesis `upsert-mandate --dry-run` preview
== `canonicalMandate` of the real signed envelope, sig verifies over
precisely the previewed bytes, nothing written); the libpcsclite API
contract for the gate-(A) step recorded in-code. Verify-before-trust:
orchestrator audited (native binding NOT written — zero real libpcsclite
calls; pin + program trackers untouched; loop has no fallback;
ca-operations stale terms appear ONLY as migration negations) + re-ran
both gates — maintainers 358/35 → **370/36** (+12); flagship
**2529/225** (doc-only). **The agent-side Phase-A protocol-product
spine + ceremony hardening is COMPLETE. Everything remaining (Phase-A
governed-PR/re-pin/npm-publish/drop-pull-script + all of Phase-B Gate
B) is HUMAN/CREDENTIAL/HARDWARE-gated — the orchestrator PAUSES per the
human-gate protocol. The exact ordered copy-pasteable human steps are
in SESSION-HANDOFF §0 (top entry) + ca-operations Operation 0.**

### 2026-05-18 — session 8 (Mac/darwin box): c5 LANDED — publishable layout + fetch() reference client + the portable conformance vector set

**maintainers `6acca14` (`feat/keyfile-register`), pushed.** The #35
portable-artifact requirement, additive (zero model/canonical/verifier
change): (1) `docs/spec/v1.md` §7.1 documents the published-fetch
layout as the HTTP/raw-content form of the §7 Git-adapter layout — the
EXISTING `.maintainers/index.json` convention (`{version:1,tracks,keys,
endorsements}`, every path under `.maintainers/`, anti-redirect), NOT
the stale pre-v2 `origin.json`/`log.json`/`ca-leases.json` vocabulary —
+ §12 Conformance (vector format, the "conformant iff every vector incl.
every fail-closed negative" criterion, named the primary portable
artifact); section numbers preserved. (2) `packages/protocol/src/
fetchClient.ts` (`verifyFromFetch`) — dependency-free, total,
fail-closed; GETs `<base>/.maintainers/index.json` then the listed
files and runs the landed verifier at the caller's own `now`;
byte-consistent with `extension/src/fetcher.ts` (one published layout,
not a fork). (3) `packages/protocol/scripts/gen-conformance.ts` — a
deterministic generator (real Ed25519 signing, fixed seeds/timestamps/
UUIDs) emitting the portable `maintainers/conformance/` (manifest + 17
vectors) + `conformance.test.ts` replaying EVERY vector through the
LANDED `verifier.ts`/`endorsement.ts`/`caEndorsement.ts` asserting both
`accepted` and the exact `rejectReason` (the suite FAILS if any
expected reject silently flips to accept — the guard for #9/#10), plus
totality, presence of all 10 mandatory negatives, byte-deterministic
regeneration. Vectors: 4 happy + neg-1..10 (absent/forked/
pin-not-in-log, self-renewal, sub-threshold, under-minSuccessors,
over-maxDuration, endorsement-gap, lapsed-lease-at-NOW, 10a rolled-back
+ 10b tampered-root) + totality + CA-no-pin; each negative maps to the
exact landed reason. Verify-before-trust: orchestrator audited the diff
(pin untouched; conformance test uses the real verifier not mocks;
neg-4 spot-checked genuinely fail-closed; generator real-signs ⇒
genuine canonical bytes) + re-ran both gates — maintainers 330/33 →
**358/35** (+28, 0 failed); flagship **2529/225** unchanged. **The
c4.6/c4.7/c5 protocol-product spine is DONE. Next = ceremony-tooling
hardening (native PC/SC YubiKey PIV binding behind the tested
`connectPcscChannel` seam; make create-key/upsert-mandate/ca-endorsement
+ ca-operations Operation 0 concrete & dry-run-clean; the transport
must never assume key/reader present). A fresh attentive START —
security-critical native transport; lands upstream via a governed
maintainers PR; hardware-in-loop verify is a human gate.**

### 2026-05-18 — session 8 (Mac/darwin box): c4.7 SPEC LANDED — protocol spec rewritten under the final name to the LOCKED model

**maintainers `f509849` (`feat/keyfile-register`), pushed.** One fresh
subagent rewrote `docs/spec/v1.md` (607→971 lines) end to end, in
place, directly under the final de-versioned name — **authored against
the LANDED code as ground truth** (canonical.ts/verifier.ts/
endorsement.ts/caEndorsement.ts/types.ts), so the publishable normative
artifact matches the implementation exactly (c5 derives conformance
vectors from it). §3.1 transcribes the exact 15-slot `canonicalMandate`
field order + `maintainers/mandate/v1` tag + `mandatePinHash`; §4 = L1
pin-is-the-floor verify-forward (multi-pin, fail-closed) + L2/L3 one
forward-succession rule (no self-renewal); §5.0/§5.1 = holder-signs
endorsements + D3 lease-at-the-consumer's-own-clock (unchanged); §5.2
rewritten to "the pin IS the floor"; §8 = the from-scratch security
boundary + the accepted no-equivocation-detection limitation; §9 = the
single shipped wire version 1 (fail-closed on an unknown version).
Removed every trace of genesis-walk / policy.json / RootPolicy /
TrackPolicy / SignedPolicy / checkpoint-not-floor / selfRenewable /
`…V2`. Section numbers preserved (inbound `§N.N` refs stay valid);
added an informative §11.1 (external PIV-Ed25519 signers) that makes
the long-standing signing.ts/cli `§11.1` refs resolve. Two forced
single-token JSDoc path fixes (`docs/spec/v2.md`, a path that never
existed, → `docs/spec/v1.md`) in types.ts/verifier.ts — no symbol/
behavior change; the "LOCKED v2 model" design-lineage prose left per
the c4.6 boundary. Code-wins discipline: reject reasons in the type
unions the holder-signs code never emits are not presented as
protocol-emittable. Verify-before-trust: orchestrator audited the diff
(3 files; pin untouched; cross-checked the §3.1 slot order against
canonical.ts verbatim; confirmed the `v2`/`policy.json`/`selfRenewable`
spec hits are explicit ABSENCE statements not residue) + re-ran BOTH
full gates itself — maintainers tsc -b clean + 330/33; flagship tsc -b
clean + 2529/225. 3 files, +651/−287. **Next = c5 — publishable spec
+ a `fetch()` reference client + a conformance test-vector set that
MUST include every fail-closed negative. A fresh attentive START.**

### 2026-05-18 — session 8 (Mac/darwin box): c4.6 DE-VERSION RENAME LANDED — the protocol's first-ever shipped name is final

**maintainers `a8ac151` (`feat/keyfile-register`) + flagship `c5995c9`
(`main`), both pushed.** Thin-orchestrator + ONE fresh general-purpose
subagent with a self-contained brief; verify-before-trust on return
(orchestrator audited the diff + re-ran BOTH full gates itself +
committed/pushed — the subagent's "green" was never trusted).

c4.6 (user decision s6 — the naming addendum in "Phase-2 DESIGN
DECISION — LOCKED v2"): the maintainers protocol is unreleased and was
never used; the `V2` symbol suffix + `maintainers/mandate/v2` tag were a
transitional artifact so the new model could coexist with v1 during the
cutover. c4.5e made v2 the sole trust path, so the first-ever shipped
name must not be "v2". Dropped the `V2` code-symbol suffix everywhere
(`MandateV2→Mandate`, `verifier/endorsement/caEndorsementV2.ts`+symbols
→ plain, `currentAuthorityV2`/`verifyChainOfEndorsementsV2`/
`verifyCaEndorsementsV2`/`authorizedCaKeysV2`/`signMandateV2(With)`/
`canonicalMandateV2`/`isMandateV2`/`readMandatesV2`/`writeMandateV2`/
`ApprovalRuleV2`→plain, `VerifiedChainV2→VerifiedChain`), reset the
**Mandate** envelope wire `version: 2→1` + canonical tag
`maintainers/mandate/v2→/v1`. **NOT a trust-model change** — L1/L2/L3/D3
untouched; no verifier logic / threshold / holder-signs / fail-closed
assertion changed (fail-closed negatives recomputed to the new expected
values, never weakened). Only the Mandate envelope ever carried the
bogus v2; KeyFile/ReleaseEndorsement/CaEndorsement stay v1. Changes
`mandatePinHash` — acceptable only because nothing is pinned yet; it
therefore lands BEFORE c4.7/c5/Gate B.

- **★ env-sync drift caught at cold start:** the gitignored
  `maintainers/` clone was stale at `feat/keyfile-register`@`dc48559`
  (c1 only — missing c2..c4.5e). Non-destructively
  `git merge --ff-only origin/feat/keyfile-register` → `208978a`
  (`reset --hard` was correctly classifier-blocked as destructive;
  ff-only after proving 0-ahead/9-behind + clean tree is safe). Both
  baseline gates re-verified GREEN before any work.
- **★ subagent's load-bearing find (orchestrator confirmed in the
  audited diff):** the real canonical-tag site was the *local*
  `joinTagged2` builder in `canonical.ts` (hardcoded `/v2`), DISTINCT
  from the descriptive comment — a naive `maintainers/mandate/v2` regex
  would have left it untouched and c4.6 would have been a silent no-op
  on the signed bytes (the pin would NOT have changed). Renamed
  `joinTagged2→joinTaggedMandate`/`/v1`; `mandatePinHash` genuinely
  changes (ca-track: `3724ad7e…664c`→`5eac384e…faab`; `.maintainers/`
  mandate signatures changed, KeyFiles byte-unchanged, regeneration
  byte-deterministic across two runs). Also caught mid-token V2
  (`signMandateV2With`, `isV2Shape`) and a missed nested consumer
  `packages/server-adapters/cloudflare-worker`.

maintainers `a8ac151`: 38 files, 7 `git mv` renames (history
preserved), +476/−477, tsc -b clean + vitest **330/33**. flagship
`c5995c9`: 13 files, +77/−77 (regenerated `.maintainers/` artifact to
v1), tsc -b clean + vitest **2529/225**. Pin UNCHANGED `833fa45`
(re-pin is the later governed Phase-A.merge step; never pin an unmerged
tip). `apps/mobile/.../project.pbxproj` (pre-existing xcodegen artifact)
explicitly NOT staged; `dist/` (gitignored) + `docs/` not in either
commit. **Next = c4.7 spec — author the protocol spec DIRECTLY under
the final de-versioned name (rewrites §5.2 "the pin IS the floor";
dissolves policy.json/SignedPolicy; documents L1/L2/L3 + mandatePinHash
+ holder-signs + the from-scratch boundary; D3 unchanged). A fresh
attentive START — do NOT tail-bolt.**

### 2026-05-18 — session 7 cont. (Linux box): c4.5e + c4.5e-pre LANDED — THE ENTIRE c4.5 v1→v2 CUTOVER COMPLETE

**c4.5e `208978a` (maintainers) + c4.5e-pre `def22ca` (flagship), both
pushed.** v1 is fully removed from `packages/protocol`; v2 is the SOLE
trust path. **c4.5e**: deleted the v1 genesis-walk verifier + v1
endorsement/ca-endorsement verifiers + their tests (verifier/
endorsement/caEndorsement.ts + .test.ts; checkpoint.test.ts — L1
replaced the genesis-walk/checkpoint concept); re-homed the shared
result types BEFORE deletion (→ endorsementV2/caEndorsementV2, still
re-exported via index ⇒ public surface unchanged); pruned v1 Mandate/
TrackPolicy/RootPolicy/ApprovalRule + canonicalMandate + signMandate +
the 3 v1 index lines; `Envelope` union `Mandate`→`MandateV2` (zero
consumers outside protocol). 17 files, +77/−2176; maintainers
**382/37 → 330/33** (v2 trust-path tests now the sole coverage, all
pass).

**★ verify-before-trust caught a load-bearing regression and corrected
TWO canonical invariants.** The first c4.5e gate run broke the flagship
guard (4 fails). Findings: **(1)** `node_modules/@maintainers/protocol`
is a **LIVE symlink** to the maintainers working tree, NOT the pinned
copy — so any protocol change hits the flagship guard locally (the pin
isolates only CI/Docker via `pull-maintainers.sh`); c4.5a–d stayed
green only because they never touched protocol. **(2)** c4.4's
"flagship is v1-free" was incomplete: 4 flagship files still imported
v1 (`scripts/bootstrap-flagship-maintainers.mjs` PROD,
`scripts/verify-endorsement.mjs`, + 2 tests; the `.mjs` invisible to a
tsc grep ⇒ `tsc -b` passed, vitest failed). c4.5e was stashed; the
user chose **consumer-first**; **c4.5e-pre** re-based all 4 to v2
(mirroring c4.4) WHILE v1 still coexisted, incl. regenerating the
committed `./.maintainers/` artifact to the v2 shape (policy.json
deleted, mandates v2, byte-deterministic; KeyFiles unchanged) — flagship
`def22ca`, **2529/225 ALL PASS**. Then the stash was popped and c4.5e
committed with the FULL gate green both sides. **Cold-start lesson:
locally the flagship guard is a LIVE consumer check of the maintainers
working tree — run it after EVERY maintainers protocol change.**

Process: recovered a prior s7 session that looped ~9h (zero damage);
orchestrator + ONE subagent at a time (user-chosen serial mode),
verify-before-trust on every chunk (full gate re-run by the
orchestrator via file-redirect for real exit codes — a `| tail`
pipeline hides vitest's exit + truncates the verdict; caught & fixed
mid-run). **Next = c4.6 de-version rename (a fresh attentive START —
changes `mandatePinHash`, security-sensitive, MUST NOT be tail-bolted)
→ c4.7 spec → c5 → governed PR → re-pin → npm publish → Gate B.**

### 2026-05-18 — session 7 cont. (Linux box): c4.5d LANDED — ALL consumers now v2 (cli v2 re-base + collapsed verbs deleted)

**c4.5d `616b8f9` (maintainers `feat/keyfile-register`), pushed.**
`packages/cli` re-based off v1 onto v2. Per the LOCKED "CLI verbs"
decision the collapsed v1 verbs `genesis`/`mandate`/`takeover` (= the
from-scratch/renewal/takeover cases of the ONE landed `upsert-mandate`,
c3b) were DELETED + unwired (index.ts/args.ts/help). `verify.ts` →
`verifyMandateChainFromPin`+`currentAuthorityV2`+
`verifyChainOfEndorsementsV2` with the no-baked-pin `safePinHash` anchor
(no `--pin` flag exists; none invented). `lib/store.ts` → v2 on-disk
convention via the existing `readMandatesV2`. `endorsement.ts`/
`caEndorsement.ts` authority → v2 (still EMIT v1 ReleaseEndorsement/
CaEndorsement, unchanged by the model). The subagent self-corrected an
assertion-design error: an on-disk tamper ⇒ `root-signature-invalid`
(the preview anchor recomputes the hash over the tampered bytes, so the
pin still matches the file — the signature breaks), still a hard
fail-closed; pure `pin-not-in-log`/forked/unauthorised-successor moved
to the protocol-layer test where each is genuinely reachable. 18 files,
+553/−1454. Verify-before-trust: orchestrator re-ran the FULL gate
pwd-confirmed — maintainers tsc -b clean + vitest **385/37 → 382/37**
(net −3 deleted-verb tests, expected); flagship guard tsc -b clean +
**2529/225** unchanged; diff audited (confined to `packages/cli`,
protocol/pin untouched, zero forbidden v1 symbols) before commit+push.

**All four consumers (worker/web-ui/extension/cli) are now on v2;
nothing imports v1. c4.5e (protocol v1-removal) is unblocked and is the
STRICTLY-LAST chunk → then c4.6 de-version → c4.7 spec → c5 → governed
PR → re-pin → npm publish → Gate B (all unchanged).**

### 2026-05-18 — session 7 cont. (Linux box): c4.5c LANDED (extension v2 re-base)

**c4.5c `fba0657` (maintainers `feat/keyfile-register`), pushed.**
`packages/extension` (browser-extension verifier — pure consumer, no
signing surface) re-based off v1 onto v2 while v1 still coexists in
protocol. `verifier-logic.ts` → `verifyMandateChainFromPin`+
`currentAuthorityV2`+`verifyChainOfEndorsementsV2`; `fetcher.ts` → v2
on-disk convention (no policy.json/RootPolicy/TrackPolicy). Preview
anchor = first on-repo mandate's `mandatePinHash` via `safePinHash`
fail-closed (the c4.5a/c4.5b no-baked-pin pattern). CA track was never
separately endorsement-verified ⇒ no `*V2` CA call (behaviour
preserved). 9 files, +520/−313. Verify-before-trust: orchestrator
re-ran the FULL gate itself with pwd-confirmed cwd — maintainers tsc -b
clean + vitest **378/37 → 385/37** (+7); flagship guard tsc -b clean +
**2529/225** unchanged; diff audited (confined to `packages/extension`,
protocol/pin untouched, zero forbidden v1 symbols) before commit+push.
**Next = c4.5d (cli) → c4.5e (protocol v1-removal) STRICTLY LAST → c4.6
→ c4.7 → c5 → governed PR → re-pin → npm publish → Gate B.**

### 2026-05-18 — session 7 cont. (Linux box): recovered a 9h-looped session → c4.5b LANDED (orchestrator, one subagent at a time)

A prior session persisted the execution-model decision (`9dd3154`) then
looped ~9h. Recovery verified it caused **zero damage** (repo clean, no
spurious commits, pin `833fa45` unchanged, no crons/tasks/wakeups
armed). Start gate re-verified green at baseline — flagship **2529/225**,
maintainers **373/36** @ `650fee2`, both tsc clean. User chose to resume
c4.5 as **orchestrator + ONE subagent at a time** (the documented model
but strictly serial — no parallel design fan-out, no parallel worktrees).

**c4.5b LANDED `429a57c` (maintainers `feat/keyfile-register`),
pushed.** `packages/web-ui` re-based off the v1 Mandate/policy path onto
v2 verify-forward-from-pin while v1 still coexists in protocol (additive;
protocol removal is c4.5e, last). Per **#31** (web-ui is STATUS/PREVIEW
only, NEVER a signing surface — the program's own directive) the three
signing views `onboard`/`renew`/`takeover` and their v1 mandate/policy
builders were DELETED, not ported. `project.ts`/`state.ts` →
`verifyMandateChainFromPin` + `currentAuthorityV2` over the v2 on-disk
convention (no policy.json/rootPolicy/TrackPolicy); `adapter.ts` →
local v2-only envelope union (the c4.5a `WorkerEnvelope` pattern);
preview anchor = first on-repo mandate's `mandatePinHash` (the c4.5a
`summarizeState` no-baked-pin pattern; security boundary unchanged +
documented). Tests rewritten to v2 fixtures incl. the mandated
fail-closed negatives. 16 files, +586/−1938.

**Verify-before-trust applied:** the subagent's self-reported "green"
was NOT trusted — the orchestrator re-ran the FULL gate itself
(maintainers tsc -b clean + vitest **373/36 → 378/37**, +5 new v2
coverage; flagship guard tsc -b clean + **2529/225** unchanged) and
audited the diff (confined to `packages/web-ui`, protocol untouched, pin
unchanged, zero forbidden v1 symbols) before commit+push. The
cwd-poisoning hazard recurred (a backgrounded flagship-guard ran in the
poisoned `…/maintainers` cwd → 37/378 not 225/2529; caught by the count,
re-run with explicit `cd /abs && pwd && …`). **Next = c4.5c (extension)
then c4.5d (cli), order-free; c4.5e strictly last; then c4.6 → c4.7 →
c5 → governed PR → re-pin → npm publish → Gate B (all unchanged).**

### 2026-05-18 — session 7 (Linux box): c4.5 verify-before-trust correction — consumer-first, not one atomic commit

Cold continuation (user "continue", new day, healthy context — the
fresh attentive START c4.5 was deferred for). Start gate re-verified
green: maintainers **371/36 · tsc clean**; flagship **2529/225 · tsc
clean** (the flagship half of a compound `cd …/maintainers && …`
re-ran in maintainers — the cwd-poisoning hazard; caught via `pwd`,
flagship re-run with an absolute path).

**Before touching code**, an exhaustive Explore fan-out inventoried
EVERY v1-symbol reference across the whole maintainers tree. Finding:
the v1-removal blast radius is **~30 files across FIVE packages** —
protocol, cli, web-ui, cloudflare-worker, **and `packages/extension/`,
which the session-6 c4.5 plan FORGOT entirely** (`verifier-logic.ts`,
`fetcher.ts`, `tests/fixtures/build-fixture.ts`,
`verifier-logic.test.ts` all consume v1) — including substantial
rewrites of security-critical verification code (worker `policy.ts`
authority + `summarizeState`, extension `verifier-logic.ts`, web-ui
`views/project.ts`/`renew.ts`/`takeover.ts`/`state.ts`, cli
`verify.ts`/`caEndorsement.ts`/`lib/store.ts`).

**Correction (engineering autonomy; NOT a v2-model change — same class
as the c4.2 deletion):** the session-6 "c4.5 = ONE atomic commit,
cannot be partialed" call was made WITHOUT this inventory. A blind
30-file atomic rewrite of trust-verification code is unsafe and
violates the "attentive, never rushed on the load-bearing path"
discipline. "Cannot be partialed" is true ONLY if v1 is removed from
protocol FIRST. The v2 symbols already exist (c1/c2/c4.1), so each
consumer is re-based to v2 **while v1 still coexists in protocol**
(additive — maintainers gate green each step), and v1 is removed from
protocol **last**. This is the EXACT consumer-first→removal-last
pattern that safely landed the flagship side (c4.3 → c4.4 → would-be
removal). **New sub-sequence: c4.5a worker → c4.5b web-ui (delete the
v1 signing views per #31) → c4.5c extension → c4.5d cli (delete
genesis/mandate/takeover) → c4.5e protocol v1-removal (LAST; re-home
the shared VerifiedEndorsements/EndorsementFailReason/
VerifiedCaEndorsements/DEFAULT_CLOCK_SKEW_MS types into
endorsementV2/caEndorsementV2; KEEP `joinTagged` — used by 6 non-v1
canonical fns).** a–d order-free + independent; e strictly last. Each
its own green commit (maintainers tsc -b + vitest; flagship guard
2529/225 — flagship already imports zero v1). Then c4.6 de-version
rename → c4.7 spec → c5 → governed PR → re-pin → npm publish → Gate B
(all unchanged). Recorded in SESSION-HANDOFF §0 (s7) + header +
§3-tail + §5 and here + the phase-2 row + memory; the unsafe atomic
must NOT be attempted.

**c4.5a LANDED `650fee2` (maintainers `feat/keyfile-register`),
pushed.** The cloudflare-worker write-gate re-based off the v1 Mandate
path onto v2 WHILE v1 still coexists in protocol (additive — protocol
untouched, removed last in c4.5e). `policy.ts`: RepoState =
`Map<string,MandateV2[]>`, no policy.json; a local `WorkerEnvelope`
union (v2-only, doesn't touch the protocol `Envelope` which still has
v1 Mandate); parseEnvelope Mandate⇒v2 (v1⇒`mandate-version-
unsupported`); checkMandateAuthority = empty-track⇒valid self-signed
v2 ROOT (from-scratch is protocol-unauthenticated by design),
non-empty⇒verify-forward-from-the-first-on-repo-mandate (the L3 one
rule); endorsement/ca authority = `currentAuthorityV2` + holder-signs
(Ca judged at NOW — §5.1 unchanged); `summarizeState`/RepoSummary v2.
`worker.ts` `fetchMaintainersState` drops the policy.json reads, reads
version-2 mandates. `worker.test.ts` untouched (helper-only).
`policy.test.ts` fully rewritten to v2 fixtures. maintainers tsc -b
clean + vitest **371→373/36**; flagship guard **2529/225** tsc clean
(worker NOT in flagship's import graph + protocol unchanged ⇒ provably
unaffected). pin UNCHANGED `833fa45`. **Next = c4.5b / c4.5c / c4.5d
(order-free) → c4.5e LAST.** A 2nd large security-sensitive sub-commit
was deliberately NOT started this turn (rushing it would be a
tail-bolt on the load-bearing path — the same end-of-session
discipline call as s6).

**EXECUTION-MODEL DECISION (s7, user-directed):** the program now runs
as ORCHESTRATOR + fresh-subagent-per-chunk, parallel where genuinely
independent. Canonical detail = SESSION-HANDOFF §0 top entry
"EXECUTION-MODEL DECISION" + the redesigned program prompt. Read-only
design fan-out is always parallel-safe; disjoint-package implementation
runs in parallel `isolation:"worktree"` subagents returning verified
diffs (NO commit/push); the orchestrator integrates STRICTLY ONE AT A
TIME, re-running the FULL gate itself (never trusting a subagent's
"green"), then commits+pushes. c4.5b/c/d parallel; c4.5e/c4.6/c4.7/c5
serial. The gate→commit→push spine is serialized — concurrent writers
on the shared branch would corrupt the trust path; non-negotiable.

### 2026-05-17 — session 6 (Linux box): Phase-2 v2 spine — c4.1 + c4.3 + c4.4 (the entire flagship-side v2 migration) landed

Cold start: `maintainers/` clone already on `feat/keyfile-register`@
`2fa2b0c` (c3b). Start gate re-run green at baseline — maintainers
**344/34 · tsc clean**, flagship **2526/225 · tsc clean**. Three tested
commits, each gate-green + pushed; pin UNCHANGED `833fa45`.

**Decomposition correction (honest).** The prior plan's separate
additive "Envelope rework" (c4.2) was over-decomposition: it would
force expand-then-contract on the large worker/web-ui security surface
only to delete the v1 half. The handoff itself names exactly THREE
logical changes — *(a) maintainers-side removal/spec, (b) flagship-side
consumer migrate, (c) #30 generalise*. The worker/web-ui MandateV2-into-
`Envelope` re-base folds into the v1-removal cutover (**c4.5**) —
atomic, no dual-version collision (v1 `Mandate` leaves `Envelope`
exactly as `MandateV2` enters). c4.2 deleted from the plan.

**c4.1 `6cfee83` (maintainers `feat/keyfile-register`) — the v2
endorsement layer, strictly ADDITIVE** (v1 endorsement.ts/
caEndorsement.ts/verifier.ts untouched ⇒ flagship guard provably
back-compatible):
- `endorsementV2.ts` `verifyChainOfEndorsementsV2(endorsements,
  releaseChain: VerifiedChainV2)` — identical structural/cryptographic
  checks as v1 (predecessor chain, intermediateMerkleRoot,
  signature-over-canonical-bytes, duplicate-id, genesis-vs-non-genesis),
  authority swapped to `currentAuthorityV2(chain, e.issuedAt)` +
  **holder-signs**.
- `caEndorsementV2.ts` `verifyCaEndorsementsV2`/`authorizedCaKeysV2` —
  same §5.1 NOW-clock lease semantics (D3 unchanged), authority via
  `currentAuthorityV2(chain, now)` + holder-signs.
- **Holder-signs is the FORCED consequence of the LOCKED model, NOT a
  new decision:** L2 dissolves `policy.json`/`TrackPolicy`, so a
  per-endorsement `approvalRule` artifact no longer exists; the only
  signed authority statement is the mandate, whose `holder` IS "the
  operational authority for the track (signs ReleaseEndorsement /
  CaEndorsement)". The succession quorum
  (`approvalRule`/`minSuccessors`/`maxDurationSeconds`) governs K→K+1
  ONLY. Reuses the v1 `VerifiedEndorsements`/`VerifiedCaEndorsements`
  result shapes so the consumer call swaps with no downstream change.
- **27 new tests** incl. holder-rotation-resolves-per-issuedAt and
  every fail-closed negative incl. the absent/forked-pin chain ⇒
  no-authority. maintainers `tsc -b` clean + vitest **344→371/36**;
  flagship guard **2526/225** (additive ⇒ provably back-compatible).

**c4.3 `5fb2fdf` (flagship `main`) — #30 generalised.** `@flagship/
protocol` `maintainerCa.ts`: `MAINTAINER_GENESIS_PUBKEYS` (string[]) →
`MAINTAINER_PINNED_MANDATE_HASH` ("" until Gate B);
`maintainerGenesisConfigured`→`maintainerPinConfigured`;
`CaArtifactReject` `genesis-unconfigured`→`pin-unconfigured`; the
`genesisPubkeys` param → `pinnedMandateHash` (string). Module stays
`@maintainers/protocol`-free (ships to the mobile mirrors); the
`CaTrustChain` interface is UNCHANGED — the injected port closes over
the baked pin and does verify-forward-from-pin internally (c4.4). Blast
radius: maintainerCa.ts/.test.ts + the #30-reason rename in
caTrustChain.ts/.test.ts. flagship tsc -b clean + vitest **2526/225**.

**c4.4 `ff8ce91` (flagship `main`) — the LIVE trust consumer migrated.**
`server-daemon` `releaseVerifier.ts` + `caTrustChain.ts` moved off
`verifyTrack`/`TrackPolicy`/policy.json/`currentAuthority`/
`verifyChainOfEndorsements` onto `verifyMandateChainFromPin`/
`currentAuthorityV2`/`verifyChainOfEndorsementsV2`/`authorizedCaKeysV2`
+ the v2 on-disk convention (`tracks/<t>/mandates/*.json`
version-2-filtered, NO policy.json — mirrors the cli `readMandatesV2`).
`ReleaseVerifierOptions` gains `pinnedMandateHash` (defaults to the
EMPTY baked `MAINTAINER_PINNED_MANDATE_HASH` ⇒ every chain fail-closed
pre-Gate-B; overridable so tests exercise the post-ceremony path —
mirrors the maintainerCa injectable-pin seam). The `ReleaseStatus`/
`ReleaseStatusResponse` wire shapes kept byte-stable (BFF + Swift/
Kotlin mirror): `hasPolicy`→"track anchored a v2 chain",
`rootPolicyPresent`→"usable .maintainers root present" (documented;
there is no policy.json in v2) ⇒ `releaseStatusProvider.ts`/`screens`
UNTOUCHED. `verifyEndorsementChainAgainstGit` (the git-walk) unchanged.
Tests rewritten to v2 fixtures incl. new fail-closed negatives
(empty pin, forked pin/pin-not-in-log, tampered-mandate-breaks-anchor).
**From here the flagship gate is a REAL `@maintainers/protocol` v2
consumer check, not just a back-compat guard.** flagship tsc -b clean +
vitest **2526→2529/225** (+3 from the new fail-closed coverage — the
new honest baseline). flagship no longer imports ANY v1 Mandate-path
symbol; pin UNCHANGED `833fa45`. Deploy NOTHING (the bake flips live
only at Gate B).

**Remaining v2 spine:** **c4.5** the maintainers v1→v2 cutover in ONE
atomic green commit (cannot be safely partialed while the maintainers
gate stays green) — retire the v1 Mandate path in `@maintainers/
protocol` (canonicalMandate v1 / verifyTrack / checkpoint / RootPolicy
/ TrackPolicy / the v1-superseded endorsement.ts+caEndorsement.ts /
currentAuthority / lastExpiredMandate / policy.json / genesis|mandate|
takeover CLI + v1 store fns + their tests; **re-home the shared
`VerifiedEndorsements`/`EndorsementFailReason`/`VerifiedCaEndorsements`
types into the v2 files** since endorsementV2/caEndorsementV2 currently
import them from the v1 files) AND re-base the worker
(`cloudflare-worker` policy.ts/worker.ts) + web-ui (parse-folder/
envelopes/adapter/views) onto v2 (`Envelope`→`MandateV2|…`; worker
write-gate uses verifyMandateChainFromPin/holder-signs; web-ui =
status/preview only per #31, drop the v1 signing builders) + rewrite
all maintainers tests. flagship guard 2529/225 (passes precisely
because flagship no longer imports v1). → **c4.6 de-version rename**
(user decision 2026-05-17 s6 — "v2" is a transitional development
artifact, NOT a real version: the maintainers protocol is UNRELEASED
and never used, so its first-ever version must not be called "v2", and
the canonical tag `maintainers/mandate/v2` must not be frozen forever
by Gate B's pin. Drop the `V2` code-symbol suffix everywhere
(`MandateV2`→`Mandate`, `verifierV2.ts`→`verifier.ts`,
`currentAuthorityV2`→`currentAuthority`,
`verifyChainOfEndorsementsV2`→`verifyChainOfEndorsements`,
`endorsementV2.ts`/`caEndorsementV2.ts`→plain,
`verifyCaEndorsementsV2`/`authorizedCaKeysV2`→plain,
`isMandateV2`/`readMandatesV2`→plain) + reset the Mandate envelope
`version: 2→1` + canonical tag `maintainers/mandate/v2→/v1` (KEEP a
numeric wire version — versioning a wire format is good engineering;
the nonsense is only "v1 named v2"; note ReleaseEndorsement/
CaEndorsement/KeyFile are already `version: 1` — only Mandate carried
the bogus v2). NOT a trust-model change (the LOCKED design is
untouched). It is a coordinated flagship-consumer rename (flagship
imports `MandateV2`/`currentAuthorityV2`/`MAINTAINER_PINNED_MANDATE_
HASH`/… — flagship gate as a REAL consumer check, same as c4.4). It
changes `mandatePinHash` output, so it MUST land before c4.7/c5 and
Gate B — acceptable ONLY because nothing is pinned yet, the SAME "no
real genesis exists yet" window the v2 lock itself relied on.) →
**c4.7** spec (authored DIRECTLY under the final name) → **c5**
published spec + static layout + `fetch()` client + conformance
vectors (ALL fail-closed negatives) → governed PR (Human Gate) →
re-pin → `npm publish` (Human Gate) → flagship drops the pull-script.
**THEN** Gate B. c4.5 is the security-critical cutover and the single
most delicate remaining maintainers change — deliberately left for a
fresh session's full attention (NOT tail-bolted at the end of this
3-commit session).

### 2026-05-17 — session 5 (Linux box): Phase-2 v2 spine — c2 (protocol core) + c3 (CLI verbs) landed

Cold-start: `maintainers/` clone was stale on `feat/ca-endorsement`
@`10c65aa`. Per the continue-rule, did NOT `pull-maintainers` (would
reset to the pin + discard the v2 branch); instead `git -C maintainers
fetch && checkout feat/keyfile-register` → `dc48559` (c1, atop the
merged pin `833fa45`). Start gate at baseline: maintainers (on branch)
**311/31 · tsc clean**, flagship **2526/225 · tsc clean**.

**c2 `5f3b146` (the load-bearing trust path, landed attentively — NOT
tail-bolted), pushed to `origin/feat/keyfile-register`:** the v2
protocol *core* in `@maintainers/protocol`, **strictly additive** (v1
fully intact):

- `types.ts` `MandateV2` (version 2): succession policy folded IN —
  `approvalRule` (threshold over the predecessor's `successors` set),
  `successors`, `minSuccessors`, `maxDurationSeconds`,
  `defaultDurationSeconds`, optional `project` (from-scratch only).
  Deliberately NOT in the v1 `Envelope` union (verify-before-trust:
  doing so broke the kind-discriminated switch in the worker/web-ui
  adapters — that store rework is c4; keeping it out kept c2 additive).
- `canonical.ts` `canonicalMandateV2` (tag `maintainers/mandate/v2`,
  fixed 15-slot layout, non-negative-integer encoder for
  cross-language byte-stability) + `mandatePinHash` = sha256 of the
  canonical bytes — the #30-generalised baked value; content-bound and
  signature-independent, so a hash match is bit-identity (what makes L1
  sound).
- `signing.ts` `signMandateV2` + `signMandateV2With` (external/
  YubiKey-PIV signer), mirroring the proven #28 pattern.
- `verifierV2.ts` `verifyMandateChainFromPin` = **L1** (the pin IS the
  floor; find the root by canonical-hash; verify FORWARD; multiple pins
  coexist; no-pin / pin-not-in-log ⇒ reject all — #30 generalised) +
  **L3** (ONE rule, no self-renewal: K+1 valid iff every signer ∈
  K.successors, distinct ≥ K.approvalRule.threshold, K+1.successors ≥
  K.minSuccessors, window ≤ K.maxDurationSeconds; the
  holder-in-window-vs-after-expiry split is gone) + `currentAuthorityV2`
  (v1's operational semantics over the new chain). **TOTAL** — never
  throws on adversarial input; fail-closed is a return value.
- 21 new tests: happy path + L1 multi-pin coexistence + 2-of-3
  threshold **and every fail-closed negative the model promises**
  (no-pin, pin-not-in-log, forked/tampered pin, root-signature-invalid,
  root-not-self-signed, self-renewal-attempt, sub-threshold,
  under-minSuccessors, over-maxDuration, issued-before-predecessor,
  signed-by-not-in-signatures, rolled-back/dropped-intermediate,
  duplicate-id, cross-track-ignore, adversarial-input totality) + pin
  content-binding + signMandateV2With byte-identity.

maintainers `npx tsc -b` clean + `npx vitest run` **332/32** (311+21);
flagship gate as the guard (`@maintainers/protocol` is in flagship's
import graph) **2526/225 · tsc clean** — the additive change is
provably back-compatible (flagship imports only v1 symbols). Branch
pushed; **pin UNCHANGED `833fa45`** (an upstream branch is pushed,
NEVER pinned until the governed merge).

**Update — c3 (the CLI verbs) LANDED later the same session, two
attentive commits, NOT tail-bolted:**

- **c3a `23a4d35` — `create-key`.** Self-registered KeyFile via the c1
  `signKeyFileWith` self-signer seam. INDEPENDENT + non-load-bearing
  (trust operates on the pubkey; emails "conventional but not
  load-bearing"); the v1-era `--mandate-id`/`introductionMandate`
  bootstrap is OBSOLETE — `--introduction-mandate` defaults to the nil
  UUID ("self-registered, no introduction"). Runs on the ONE #28
  ceremony path; `CeremonyKind` gains `create-key` (honest LOW-STAKES
  banner) + a generic `Assembled.bannerExtra` hook; `store.ts`
  `writeKeyFile`/`keyFileFilename` (append-only). 3 tests. 332→335.
- **c3b `2fa2b0c` — `upsert-mandate` (the ONE mandate verb).**
  genesis/mandate/takeover collapse in: no prior ⇒ FROM-SCRATCH ORIGIN
  (sets policy freely, self-signed, trusted via its baked
  `mandatePinHash`; requires `--project-name`); prior ⇒ SUCCESSION
  (renew = rotate = takeover = repolicy, the ONE mechanism, no
  self-renewal). **Fail-closed PRE-FLIGHT**: every predecessor-rule
  check makeable from PUBLIC reads (signer ∈ pred.successors;
  pred.threshold; window ≤ pred.maxDuration; clock-skew; threshold ≤
  successors; successors ≥ minSuccessors) runs in `assemble` and
  refuses BEFORE any token touch — tests prove it with a token whose
  sign/PIN throw. Honest scoped boundary: single-signer only ⇒
  pred.threshold > 1 is fail-closed-refused (multi-sig quorum
  collection is a scoped follow-up; the c2 verifier enforces threshold
  regardless). `store.ts` `readMandatesV2`/`writeMandateV2` (reuse the
  file-per-mandate convention, version-2-filtered; no policy.json; the
  published `log.json` is the later c5 artifact). 9 tests (incl.
  round-trip readMandatesV2 → verifyMandateChainFromPin →
  currentAuthorityV2). 335→**344**.

Both: maintainers `tsc -b` clean; flagship guard 2526/225 tsc-clean
(CLI-only, `@maintainers/protocol` untouched). genesis/mandate/takeover
remain (retired in c4). Branch pushed; **pin UNCHANGED `833fa45`**.

**Remaining v2 spine:** **c4** (the next attentive START — NOT a
tail-bolt; it migrates the live flagship trust consumer): retire the v1
Mandate path (canonicalMandate v1 / verifyTrack / checkpoint /
RootPolicy / TrackPolicy / policy.json; carry MandateV2 into the
worker/web-ui `Envelope` kind+version discrimination; remove
genesis/mandate/takeover) + rewrite `docs/spec` to **v2** (rewrites
§5.2 "the pin IS the floor"; dissolves `policy.json`/`SignedPolicy`) +
migrate the flagship consumer (`server-daemon` `caTrustChain.ts` /
`releaseVerifier.ts`) to verify-forward-from-pin + **#30 generalised**
(bake the pinned-mandate canonical hash per surface; fail-closed
unset) → **c5** published v2 spec + static layout
(`origin.json`/`tracks/<t>/log.json`/`ca-leases.json`) + `fetch()`
reference client + conformance vectors (ALL fail-closed negatives) →
governed PR (Human Gate, PR #1/#2 precedent) → re-pin → `npm publish`
(Human Gate: npm org/2FA) → flagship DROPS `pull-maintainers.sh`/
`maintainers.pinned-sha`. THEN Gate B (the first `upsert-mandate`, its
hash pinned) → #9 → #10 → Phase 3.

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

**Then (same session) the design dialogue escalated to a full Phase-2
re-lock — "Phase-2 DESIGN DECISION — LOCKED v2", user-authorized
override of the prior D1/D2 lock.** Through a multi-turn verify-before-
trust dialogue the user converged on a strictly better model and
explicitly re-locked it: **(L1)** a pinned `Mandate` is an independent
trust anchor (genesis = "first pin"), verify FORWARD, multiple pins
coexist forever — rewrites spec §5.2 "the pin IS the floor", replaces
D2; **(L2)** succession policy folded INTO the Mandate (no separate
policy file) — dissolves D1 and the `SignedPolicy` envelope entirely;
**(L3)** NO self-renewal — ONE rule: K+1 valid iff it satisfies K's
embedded `approvalRule` over K's signer set + obeys `minSuccessors`/
`maxDuration`; `selfRenewable` knob rejected; bounded duration ⇒
perpetuation needs periodic re-quorum (emergent anti-rubber-hose);
solo founder = `successors=[self,backups],threshold=1`. D3 (CaEndorse
NOW-freshness) unchanged. Consequences: **Mandate v2 canonical-bytes /
verifier change** (acceptable ONLY because no real genesis exists yet)
⇒ **the Phase-2 v2 redesign now PRECEDES Gate B** (Gate B freezes the
pinned-mandate shape forever); **#30 generalised** to bake the pinned
*mandate hash* not a pubkey list; CLI = `createKey` + `upsertMandate`
(genesis/mandate/takeover collapse in); the prior `--mandate-id`/
`introductionMandate` sub-plan is OBSOLETE; **`c1 dc48559` stays**
(KeyFile self-signer parity, still needed for `createKey`). Phase
table + spine ordering + §1B banner updated; full rationale in the
"Phase-2 DESIGN DECISION — LOCKED v2" section. Next: build the v2
redesign upstream (the new #35 spine) under this lock — attentively,
at a START, NOT a tail-bolt (security-critical; the verifier + Mandate
canonical bytes are the load-bearing path).

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
