# Session handoff — portable cold-start (works on ANY dev machine)

**Read this FIRST.** This file is the in-repo, machine-portable source of
truth. The richer agent-memory (`~/.claude/projects/.../memory/
project_resume_2026_05_16.md`) is local to one machine and the harness
TaskList does NOT persist across sessions — so the authoritative backlog
lives **here, in git**. Rebuild your task list from §3 below.

Last updated: 2026-05-17 (**v1-launch program session 6**, Linux box.
**Phase 2 v2 spine — the entire flagship-side migration LANDED.** This
session: **c4.1** `6cfee83` (maintainers `feat/keyfile-register`: the
v2 endorsement layer, additive — `verifyChainOfEndorsementsV2`/
`verifyCaEndorsementsV2`/`authorizedCaKeysV2`, holder-signs; maintainers
**371/36**), **c4.3** `5fb2fdf` (flagship: #30 generalised —
`MAINTAINER_PINNED_MANDATE_HASH`), **c4.4** `ff8ce91` (flagship: the
LIVE trust consumer `releaseVerifier.ts`/`caTrustChain.ts` migrated to
verify-forward-from-pin — **the flagship gate is now a REAL v2 consumer
check**, new honest baseline **2529/225**, tsc clean both). flagship no
longer imports ANY v1 Mandate-path symbol. Branch pin UNCHANGED
`833fa45` (never pin an unmerged tip). **Next = c4.5** (the maintainers
v1→v2 cutover: retire the v1 Mandate path + re-base worker/web-ui onto
v2 in ONE atomic green commit — the next attentive START, NOT a
tail-bolt) → **c4.6 de-version rename** (user decision s6: "v2" is a
transitional dev artifact — the protocol is UNRELEASED; drop the `V2`
suffix + Mandate envelope `version 2→1` + tag `maintainers/mandate/v2→
/v1`; MUST precede c5/Gate B as it changes `mandatePinHash`) → c4.7
spec → c5 → governed PR → re-pin → npm publish →
**THEN** Human Gate B. The prior "c4.2" (separate additive Envelope
rework) was deleted as over-decomposition (folds into c4.5). Phase-1
Gate B remains the only open Phase-1 item, downstream of the v2 redesign
merge+re-pin. See §0 (session 6 entry) for the full per-commit detail.)

## 0. Drift log (verify-before-trust findings, newest first)

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
    Operation 1 Path B invokes `node packages/cli/dist/index.js
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

**Remaining v2 spine:** **c4.5** (the next attentive START — the single
most delicate maintainers change; do NOT tail-bolt): the maintainers
v1→v2 cutover in ONE green commit (cannot be safely partialed while the
maintainers gate stays green) — retire the v1 Mandate path in
`@maintainers/protocol` (canonicalMandate v1 / verifyTrack / checkpoint
/ RootPolicy / TrackPolicy / the now-v1-superseded endorsement.ts +
caEndorsement.ts / currentAuthority / lastExpiredMandate / policy.json
plumbing / genesis|mandate|takeover CLI + v1 store fns + their tests)
AND re-base the worker (`cloudflare-worker` policy.ts/worker.ts) +
web-ui (parse-folder/envelopes/adapter/views) onto v2 (`Envelope`
becomes `MandateV2|…`; worker write-gate uses
`verifyMandateChainFromPin`/holder-signs; web-ui = status/preview only
per #31 — drop the v1 signing builders) + rewrite all maintainers
tests. flagship guard 2529/225 (passes precisely because flagship no
longer imports v1; re-home the shared `VerifiedEndorsements`/
`EndorsementFailReason`/`VerifiedCaEndorsements` types into the v2 files
since endorsementV2/caEndorsementV2 import them from the v1 files).
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
reimpl, heaviest — sequence it) → Phase 3 cluster. c4.5 is the
security-critical cutover — START it attentively, **do NOT tail-bolt**.

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
> **c4.5**). **Next = c4.5 (the next attentive START; do NOT
> tail-bolt — the single most delicate maintainers change):** the
> maintainers v1→v2 cutover in ONE green commit (cannot be safely
> partialed) — retire the v1 Mandate path in `@maintainers/protocol`
> AND re-base the worker + web-ui onto v2 (`Envelope`→`MandateV2|…`;
> web-ui = status/preview only per #31, drop the v1 signing builders) +
> rewrite all maintainers tests; re-home the shared
> `VerifiedEndorsements`/`EndorsementFailReason`/`VerifiedCaEndorsements`
> types into the v2 files (endorsementV2/caEndorsementV2 currently
> import them from the v1 files being removed). flagship guard 2529/225
> (passes precisely because flagship no longer imports v1). → **c4.6
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
