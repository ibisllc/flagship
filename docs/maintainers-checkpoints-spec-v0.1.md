# Maintainers Checkpoints Specification

> **Provenance / status.** Draft v0.1, authored by the project owner
> (Harry) with an external advisor, 2026-05-18, as an **additive,
> out-of-band witness layer** for the Maintainers protocol. It is NOT
> the root of trust and does NOT change anything already built/shipped
> in `@ibisllc/maintainers` (Mandate format, canonical bytes, verifier,
> L1/L2/L3/D3, conformance vectors, the pin model are all unchanged).
> It is captured here verbatim so it is not lost; it is roadmapped as
> **Phase H** in `docs/v1-launch-program.md`. Open design details to
> pin before build are tracked in the Phase-H entry + SESSION-HANDOFF
> §0. The canonical home for this spec is ultimately
> `github.com/ibisllc/maintainers`; it lands there (+ the new
> `maintainers-checkpoints` repo) via the governed-PR flow when Phase H
> is built.

Status: Draft v0.1
Primary protocol repo: github.com/ibisllc/maintainers
Checkpoint repo: github.com/ibisllc/maintainers-checkpoints

## 1. Purpose

maintainers-checkpoints is a public, append-only witness log for projects using the Maintainers protocol.

The Maintainers protocol lets consumer applications pin a mandate hash, fetch a project’s .maintainers/ history, verify that the pinned hash is present, and then walk the signed mandate chain forward to derive the current maintainer authority.

The checkpoint repo adds a lightweight public witness layer.

Its purpose is to record that, at a given time, a maintainer authority currently in power for a project asked the checkpoint registry to witness a publicly available mandate hash.

The design goal is to make maintainer authority more grounded, auditable, and easy to verify without requiring a complex transparency-log system.

## 2. Security model

The checkpoint repo is not the root of trust.

The root of trust remains the mandate hash pinned inside the consumer application.

The checkpoint repo provides a public continuity witness.

Together, the model is:

```
Consumer app:
  pins one or more mandate hashes

Project repo:
  publishes .maintainers/ mandate history

Consumer verification:
  fetch .maintainers/
  require pinned hash in chain
  verify signatures and mandate rules forward
  derive current authority

Checkpoints repo:
  records witnessed current mandate hashes

Checkpoint bot:
  verifies PRs before merge

External mirrors:
  clone the checkpoint repo to make silent rewrites harder
```

This design intentionally favors a simple, low-cost trust ceremony over full CT-style transparency infrastructure.

## 3. Non-goals

maintainers-checkpoints does not claim to:

- prevent all equivocation
- prove that every user saw the same project history
- replace local mandate-chain verification
- replace signed releases or reproducible builds
- guarantee that every intermediate mandate transition was witnessed
- serve as a complete or immutable ledger — the registry may prune extra or intermediate checkpoint rows over time (§11); only the project's own `.maintainers/` chain is authoritative and gap-free
- guarantee that the checkpoint repo itself cannot be rewritten unless independent mirrors exist

Instead, it provides a public witness record that can be checked, mirrored, and audited.

## 4. Repositories

### 4.1 Main protocol repository
https://github.com/ibisllc/maintainers

This repo contains:

- protocol specification
- mandate format
- verification rules
- reference CLI tools
- sample consumer verification code
- checkpoint submission tooling

### 4.2 Checkpoint repository
https://github.com/ibisllc/maintainers-checkpoints

This repo contains:

- one checkpoint file per project
- a README explaining checkpoint semantics
- a list of known mirrors/clones
- instructions for universities, labs, and independent operators to mirror the repo

## 5. Checkpoint meaning

A checkpoint row means:

At observed_at, the checkpoint registry verified that current_mandate_hash was publicly available in the project’s .maintainers/ history, verified the mandate chain according to the Maintainers protocol, verified that the checkpoint request was authorized by the current maintainer authority, and verified continuity with the previously witnessed checkpoint for that project.

A checkpoint row does not create authority.

Authority is created by the project’s own signed mandate chain.

The checkpoint row only witnesses that the registry observed and validated a particular current mandate hash.

## 6. File layout

The checkpoint repo should use one file per project.

Recommended layout:

```
checkpoints/
  github.com/
    ibisllc/
      flagship.csv
  gitlab.com/
    example-org/
      example-project.csv
```

The path is derived from the canonical public project repo URL.

For:

https://github.com/ibisllc/flagship

the checkpoint file is:

checkpoints/github.com/ibisllc/flagship.csv

## 7. Checkpoint file format

Each project checkpoint file is a minimal CSV.

```
observed_at,track,current_mandate_hash,flagged
2026-05-18T20:30:00Z,ca,sha256:abc123...,
2026-06-02T14:12:00Z,ca,sha256:def456...,
2026-06-09T09:01:00Z,ca,sha256:ghi789...,rate-cap
```

`flagged` is empty for the overwhelming majority of rows. A header row
with exactly these four columns, in this order, is required.

### 7.1 Columns

**observed_at**

UTC timestamp assigned by the checkpoint registry bot at validation time.

The timestamp must not be blindly trusted from the PR submitter.

Format:

`YYYY-MM-DDTHH:MM:SSZ`

**track**

The mandate-track this row witnesses (per the item-5 multi-track model:
the bot keys continuity **per (project, track)**). A single-track
project records its sole track name (for Flagship v1: `ca`); a project
with more than one mandate-track emits one row per track change under
its track name. Always present (never blank).

Format: a short lowercase track identifier, e.g. `ca`, `release`.

**current_mandate_hash**

The SHA-256 hash of the mandate that the registry verified as current for the project at observed_at.

Format:

`sha256:<hex>`

**flagged**

Empty for a normal row. Set by the bot (never by the submitter) when
the row was appended but warrants human attention — at v0.1 the only
defined value is `rate-cap`, meaning this row exceeded the §10 rule-11
rolling rate cap and was **recorded anyway** (the registry never
refuses to witness — see §10) with a manual-verification ticket opened
to the maintainer. A flagged row is a **fully valid, authority-signed,
continuity-checked checkpoint** in every other respect; the flag is a
review/volume annotation, not a trust downgrade, and does not weaken
§11 continuity (see §11).

Format: empty, or a short lowercase reason token (v0.1: `rate-cap`).

## 8. PR submission model

Checkpoint updates are event-driven.

Project maintainers submit a PR to github.com/ibisllc/maintainers-checkpoints whenever their project’s security-relevant maintainer state changes.

Examples of security-relevant changes:

- origin mandate creation
- maintainer key rotation
- successor set change
- threshold change
- maxDuration/defaultDuration change
- emergency recovery
- release built against a new current mandate

Daily polling is not required for v0.1.

The project maintainer may use the Maintainers CLI to generate the checkpoint request and open the PR automatically.

## 9. PR payload

The merged checkpoint file should remain lean.

However, the PR body or an attached machine-readable file should contain enough information for the bot to validate the request.

A PR submission should include:

- canonical project repo URL
- path to .maintainers/ in that repo
- claimed current mandate hash
- source commit or ref where the mandate chain is publicly available
- cryptographic proof that the current maintainer authority authorized this checkpoint request

Example submission payload:

```json
{
  "schemaVersion": 1,
  "project": {
    "canonicalRepo": "https://github.com/ibisllc/example",
    "maintainersPath": ".maintainers/"
  },
  "checkpoint": {
    "currentMandateHash": "sha256:abc123...",
    "sourceCommit": "git-commit-sha"
  },
  "statement": {
    "type": "maintainers.checkpoint.request.v1",
    "text": "The current maintainer authority for this project requests that this mandate hash be recorded in the public Maintainers Checkpoints repo."
  },
  "proof": {
    "signedByMandate": "sha256:abc123...",
    "signatures": [
      {
        "keyId": "ed25519:...",
        "signature": "base64..."
      }
    ]
  }
}
```

This rich proof does not need to remain in the merged CSV file.

It remains publicly visible in the PR history.

## 10. Bot validation rules

A checkpoint PR must be accepted only if all validation checks pass.

The bot must verify:

1. The canonical project repo is publicly reachable.
2. The declared .maintainers/ path exists.
3. The claimed current_mandate_hash exists in the public .maintainers/ history.
4. The mandate chain verifies according to the Maintainers protocol.
5. The request is signed by the current maintainer authority.
6. If the project already has a checkpoint file, the newly presented chain contains the previously witnessed current_mandate_hash.
7. The new checkpoint row only appends data and does not alter prior rows.
8. The timestamp in the final row is assigned by the checkpoint bot.
9. The file path matches the declared canonical project repo.
10. **No-op rejection.** If the requested `current_mandate_hash` equals
    the project's most recently witnessed hash for the same track, the
    PR is rejected as a no-op. The registry records only *changes* in
    security state; re-submitting the existing head is never accepted.
    (Rule 7 forbids row tampering; this rule additionally forbids
    duplicate-content appends.)
11. **Rate cap — fail OPEN with a flag, never reject.** Per
    (project, track) — the publicly documented cap is at most `N`
    checkpoints within a rolling 30-day window (default `N = 6`,
    generous against the expected handful-per-year cadence and roomy
    enough for a real incident cluster, e.g. emergency-recovery →
    rotation → successor change in the same week). The cap value is
    public and known. **A submission over the cap is still recorded** —
    it is appended like any other row, having passed rules 1–10 and §11
    continuity, with its `flagged` column set to `rate-cap`. The bot
    does NOT reject it: a witness log that refuses to witness during a
    security-incident cluster fails exactly when it is needed most. The
    flag opens a lightweight manual-verification flow: the bot
    auto-sends the project maintainer an "is everything OK with the
    recent checkpoint volume on your project? if unexpected, click here
    to open a ticket" email; an opened ticket escalates to a human
    reviewer. Normal operation is unaffected; over-cap rows are merely
    visible and reviewed, not blocked.

Rules 10 and 11 are **mandatory from v0.1**, not deferred. Their
purpose is anti-bloat, not security — and they achieve it without ever
making the registry refuse a valid witness. Rule 10 makes
duplicate/no-op spam *impossible to merge* (zero-information rows are
rejected outright). Rule 11 makes *volume* impossible to merge
*silently*: every over-cap row is recorded but flagged and actively
reviewed (maintainer ping → optional human ticket), so a flood is
immediately visible and triaged rather than either bloating the repo
unnoticed or — the worse failure — being dropped mid-incident. The
continuity-and-authority rules (3–9) already make spam *expensive* (you
can only checkpoint a project whose current mandate key you hold);
rule 10 closes repetitive duplicates; rule 11 keeps volume observable
and accountable while preserving the absolute witness guarantee.

## 11. Continuity rule

The continuity rule is the key security property of the checkpoint repo.

Let, **scoped per (project, track)**:

```
H_old = latest previously witnessed current_mandate_hash for this track
H_new = newly requested current_mandate_hash
```

`H_old` is the most recent **currently-present** prior row for that
`(project, track)` — flagged rows count for as long as they are
present.

**The registry is a prunable witness, not the authoritative ledger.**
The registry MAY delete rows at any time — not only `rate-cap`-flagged
rows it is not satisfied reflect legitimate use, but also ordinary
intermediate/middle-chain rows dropped for routine housekeeping or
anti-bloat. This is deliberate and does NOT weaken the security model,
because the model **never depended on the checkpoint file being
complete**:

- The authoritative, gap-free mandate-transition history is the
  project's own `.maintainers/` chain, re-verified forward from the
  pin on every submission (rules 3–5). The maintainers protocol admits
  a single authority line — no valid fork or silent rollback can exist
  *in that chain* regardless of what the registry holds.
- §11 only anchors `H_new` to *some* real previously-witnessed hash.
  Pruning can only move that anchor **earlier** to an older still-present
  witnessed row. That is a strictly *weaker* anchor, never a *bypassed*
  one: any accepted `H_new` must still chain through that older real
  mandate **and** present a protocol-valid gap-free chain, so a
  rollback/fork is still rejected — the check degrades gracefully, it
  does not break.
- The registry therefore claims only to hold **checkpoints**, not every
  transition. A missing/pruned row means "this intermediate transition
  was not (or is no longer) witnessed here," never "continuity was
  violated." Completeness is explicitly a non-goal (§3); resilience to
  a sparse or pruned checkpoint history is a designed property (§19).

Deletions are themselves public and auditable: the checkpoints repo is
git-versioned and independently mirrored (§15), so a removal is visible
in history and to every mirror. A registry operator colluding with a
malicious project authority to *launder* a rollback by deleting an
inconvenient witnessed row is out of scope by construction — §13: the
registry is never the trust root; it is a transparency aid whose own
mutations are observable. Honest framing over false assurance: the
checkpoint repo makes silent rollback *harder to hide and easier to
catch*, it does not make it cryptographically impossible — that
guarantee lives only in the project's signed chain.

The one honest caveat: pruning never costs *security*, but each
retained row is a public transparency anchor, so pruning trades away
witness *granularity/value*, not safety. Recommended prune discipline
(SHOULD, not MUST — none of it is load-bearing for the continuity
guarantee): always retain the project's **first** checkpoint (the
genesis anchor, §12) and a reasonable **recent tail**; drop middle
rows preferentially over recent ones; keep flagged rows at least until
their manual-verification ticket is resolved. Over-aggressive pruning
(e.g. keeping only the head) yields a still-*safe* but
nearly-*valueless* witness — the failure mode is "this provided little
public transparency," never "this accepted a rollback."

The bot must fetch the project’s public .maintainers/ chain and verify that the chain leading to H_new contains H_old.

If the presented chain does not contain H_old, the PR must be rejected as a possible rollback, fork, or history rewrite.

This makes the checkpoint repo a public continuity witness.

It prevents the registry from silently accepting a new current mandate that discards a mandate it previously witnessed.

## 12. First checkpoint rule

For the first checkpoint of a project, there is no previous witnessed hash.

The bot must still verify:

- the claimed current mandate hash exists publicly
- the chain is valid
- the checkpoint request is authorized by the current maintainer authority
- the project file path matches the canonical repo

The first checkpoint does not prove that no earlier mandate history existed.

It only records the first state witnessed by the checkpoint registry.

## 13. Authority proof

The PR must not rely on GitHub or GitLab account identity alone.

The PR must include cryptographic proof satisfying the project’s current mandate authority rule.

In other words, the proof should be:

> signed by keys that satisfy the current mandate approval rule

not merely:

> submitted by a GitHub account with write access

This keeps the registry aligned with the Maintainers protocol.

## 14. Consumer-app usage

Consumer apps may use checkpoints as an additional advisory check.

The primary verification flow remains:

1. Fetch project .maintainers/ history.
2. Verify that the app’s pinned mandate hash is present.
3. Walk the chain forward.
4. Derive current authority.
5. Verify operational CA leases or release signatures.

Optional checkpoint verification:

6. Fetch project checkpoint file from maintainers-checkpoints or a mirror.
7. Check whether the derived current mandate hash appears in the checkpoint file.
8. Optionally require that the checkpoint is recent enough or mirrored by enough independent clones.

For offline-capable apps, checkpoint checks should not be mandatory unless the app explicitly adopts that policy.

## 15. Mirror model

The checkpoint repo should invite universities, research labs, security organizations, package registries, and independent operators to clone or mirror the repo.

Mirrors make silent rewrites harder.

The initial mirror list may contain only the canonical repo itself.

Example mirror list in README.md:

```yaml
mirrors:
  - name: Maintainers Checkpoints canonical repo
    url: https://github.com/ibisllc/maintainers-checkpoints
    operator: IBIS LLC / Maintainers project
    server: GitHub
    role: canonical
    update_frequency: continuous
```

Future entries may include:

```yaml
mirrors:
  - name: Example University Security Lab
    url: https://gitlab.example.edu/security/maintainers-checkpoints
    operator: Example University
    server: Self-hosted GitLab
    role: independent mirror
    update_frequency: nightly
    contact: security@example.edu
```

The README should encourage mirrors on non-GitHub infrastructure so that GitHub is not the only shared dependency.

## 16. Mirror listing process

To be listed as a mirror, an operator should open a PR adding:

- mirror name
- mirror URL
- operator name
- contact
- update frequency
- server type
- optional public signing key

The checkpoint repo maintainers may verify that the mirror is reachable and contains recent checkpoint history.

## 17. Main repo README language

The main github.com/ibisllc/maintainers README should explain:

> Maintainers Checkpoints is an optional public witness layer for the Maintainers protocol. Consumer apps still verify authority locally from their pinned mandate hash. The checkpoint repo records witnessed current mandate hashes, and external mirrors can help detect rollback or rewritten checkpoint history.

Suggested short explanation:

> Maintainers gives apps a pinned cryptographic root and lets project authority rotate through signed mandate chains. Maintainers Checkpoints adds a public witness log: when a current maintainer authority changes or reaffirms its security state, it can ask the checkpoint repo to record the current mandate hash. A bot verifies the public chain, authority signature, and continuity with the previous witnessed hash before merging.

## 18. Checkpoint repo README language

The github.com/ibisllc/maintainers-checkpoints README should say:

> This repository is a public checkpoint log for projects using the Maintainers protocol.
>
> Each project has a small CSV file containing rows of:
>
> observed_at,track,current_mandate_hash,flagged
>
> A row means that the checkpoint bot verified, at that time, that the mandate hash was publicly available in the project repo, that the project’s mandate chain was valid, that the request was signed by the current maintainer authority, and that the chain preserved continuity with the previously witnessed checkpoint.
>
> This repository does not define maintainer authority. Authority comes from the project’s own .maintainers/ mandate chain. This repository witnesses current authority claims so they can be publicly audited and mirrored.

## 19. Security properties gained

With pinned mandate hashes plus checkpoints, the system gains:

- local root-of-trust verification through app-pinned mandate hashes
- maintainer rotation without app reshipping
- public witnessing of current maintainer authority
- rollback/rewrite **detection** after first checkpoint (transparency-based: makes silent rollback harder to hide and easier to catch, anchored to the project's signed chain — not a cryptographic prevention; see §11)
- graceful degradation: the security model is resilient to a sparse, pruned, or partially-rewritten checkpoint history — continuity always anchors to the project's own gap-free `.maintainers/` chain, so dropping extra/intermediate rows weakens granularity, never the guarantee (§11)
- public PR-level audit trail for checkpoint authorization
- easy mirroring by universities and independent operators
- low operational burden for project maintainers

## 20. Remaining limitations

The design still does not fully prevent:

- malicious app builds that remove verification code
- compromised app-store distribution
- split views before any checkpoint was witnessed
- split views between checkpoint submissions if nobody asks the registry to witness them
- total compromise of current maintainer authority keys
- fake mirror lists served by a compromised canonical checkpoint repo

These can be reduced later with:

- reproducible builds
- independent release attestation
- multiple checkpoint mirrors
- signed mirror observations
- N-of-M witness policies
- package-registry integration
- university-hosted mirrors

## 21. Recommended v0.1 implementation

For v0.1, implement only:

1. A new repo: github.com/ibisllc/maintainers-checkpoints
2. One CSV file per project: `checkpoints/<host>/<owner>/<repo>.csv`
3. PR-based checkpoint submission.
4. A GitHub Action or bot that validates:
   - repo reachability
   - claimed hash presence
   - mandate chain validity
   - current-authority signature
   - continuity with previous witnessed hash
   - append-only file modification
5. CLI support in github.com/ibisllc/maintainers: `maintainers checkpoint submit`
6. README documentation for mirrors.

## 22. Summary

maintainers-checkpoints adds grounding at almost no cost.

The Maintainers protocol already gives consumer apps a pinned cryptographic root and a way to derive current authority forward from a public mandate chain. The checkpoint repo adds a public, auditable witness layer with a minimal operational footprint: a bot checks PRs, validates authority and continuity, and appends one row per witnessed state.

This is not a full transparency-log network.

It is the easiest useful version of one:

```
pinned app hash
+ public mandate chain
+ public checkpoint rows
+ bot-verified authority
+ continuity checks
+ independent mirrors over time
```

That is enough for a practical v0.1 and strong enough to make the system feel more grounded for real adopters.

---

## Open design details to pin before Phase-H build (orchestrator notes)

These do NOT change anything already shipped; they are checkpoint-layer
specifics to settle so the build is consistent with the LOCKED model:

1. **Authority-proof signing key (§13). — RESOLVED 2026-05-18 (owner):
   HOLDER-SIGNS.** A checkpoint request is signed by the *current
   mandate's `holder`*, identical to how CaEndorsement/ReleaseEndorsement
   are authorized (the shipped holder-signs model, c4.1) — operationally
   light; the security-state *change* itself is already quorum-signed by
   construction (it is a new mandate), so the checkpoint merely witnesses
   it. The bot's check #5 ("signed by the current maintainer authority")
   MUST be implemented as *holder-of-the-current-mandate-signed*, NOT
   the succession quorum; §13's literal "satisfy the current mandate
   approval rule" wording is superseded by this decision for
   consistency across the protocol + multi-maintainer adopters.
2. **Make the checkpoint request a first-class signed envelope.**
   `maintainers.checkpoint.request.v1` should have defined canonical
   bytes (a tagged form analogous to `maintainers/mandate/v1` —
   e.g. `maintainers/checkpoint-request/v1` over
   {canonicalRepo, maintainersPath, currentMandateHash, sourceCommit})
   signed via the existing `signing.ts`, and SHOULD get conformance
   vectors like the other envelopes — so the witness proof is exactly
   as verifiable/portable as the rest of the protocol (not ad-hoc).
3. **Sequencing vs. Gate B. — RESOLVED 2026-05-18 (owner): GENESIS
   NOW, Phase H AFTER.** Run the genesis ceremony immediately; build
   Phase H as a follow-on and submit Flagship's genesis mandates as the
   inaugural checkpoint(s) once `maintainers checkpoint submit` exists
   (the first checkpoint witnesses the genesis retroactively — nothing
   lost).
4. **New-repo creation** `github.com/ibisllc/maintainers-checkpoints`
   is a human/credential action (like the governed PR merges) — a
   human gate within the Phase-H build chunk.
5. **Multi-track checkpoints (owner, 2026-05-18) — FOLD INTO v0.2
   FORMAT.** A project may root multiple independent tracks (e.g. `ca`,
   `release`), each its own lineage/head/continuity. The per-project
   CSV therefore gains a `track` column:
   `observed_at,track,current_mandate_hash`; the §11 continuity rule
   (`H_old ∈ chain(H_new)`) and the §12 first-checkpoint rule are
   enforced **per (project, track)**. One-file-per-project is kept; the
   bot keys continuity by track. Purely additive to this still-draft
   spec — adopt it before any Phase-H build.
6. **Funding / anti-spam (owner question) — RESOLVED 2026-05-19
   (owner).** Split into two parts:

   **(a) Repetitive-spam / repo-bloat → SOLVED IN v0.1, NOT deferred.**
   The owner's concern is the public checkpoints repo growing into a
   nuisance to clone. This is now closed structurally, with no payment:
   the no-op/duplicate rejection and the per-(project,track) rolling
   rate cap are **mandatory v0.1 bot rules** (§10 rules 10–11). Combined
   with the pre-existing bound — every row is authority-signed
   (mass-spam needs mass-key-control) and event-driven (only on real
   security-state changes): rule 10 makes duplicate/no-op rows
   *unmergeable*; rule 11 records over-cap rows but *flags* them, and
   the registry *prunes* flagged/extra/intermediate rows at will (§11,
   §3 — the security model never depended on completeness). So a flood
   can never *persist* in anyone's clone, while the witness never
   refuses a valid checkpoint mid-incident. (Note also: checkpoints
   live in their own repo, separate from `flagship` and the protocol
   repo, so cloning Flagship is never burdened regardless.)

   **(b) A fee → still DEFERRED, and remains the wrong first lever.** A
   pay-per-line fee adds payment rails + a gatekeeper role + an economic
   relationship that conflicts with the free-public-mirror ethos (§15)
   and could deter the independent mirrors the security model depends
   on; it also cuts against Flagship's free-tier-first principle. With
   (a) in place there is no repetitive-spam problem left for a fee to
   solve. At v0.1 the sole project is Flagship — designing payment now
   is premature complexity that contradicts the simplicity value-prop.

   **Residual threat (acknowledged, deliberately unsolved):** a
   determined attacker who *creates many incoherent but individually
   valid projects* — each its own real maintainer key + public
   `.maintainers/` chain + reachable canonical repo — could grow the
   registry along the *project* axis, which the per-project rate cap
   does not bound. The onus is, by construction, shifted onto the host
   platform: to mass-produce this the attacker must first stand up N
   real, publicly-reachable, chain-valid repos with N keys they
   control. On major hosts (GitHub / GitLab / Codeberg) that means
   first defeating *that platform's* own Sybil defenses — account age,
   phone verification, repo-creation limits, abuse takedowns — which
   the registry inherits for free. This makes the attack expensive and
   is a further reason the fee stays deferred. It is **not** a reason to
   require a platform: §13 forbids relying on host identity alone — the
   trust root remains maintainer key + continuity + the bot's
   independent chain verification; "major host" is only a triage /
   friction heuristic, and self-hosted Forgejo / Gitea projects stay
   first-class.

   Minor / self-hosted hosts bring no such inherited Sybil resistance,
   so the bot MUST record a **per-canonical-host-domain project-count
   statistic**. A single minor or unknown domain rooting an unusually
   large number of distinct projects is the clearest spam signal we
   have; at v0.1 this is **observational only** — surfaced for manual
   review, never an auto-reject (a legitimately prolific self-hoster can
   exist) — feeding the escalation ladder rather than gating.

   If the project-axis Sybil ever materializes, escalate in order:
   tighten the bot's canonical-repo liveness/age checks and act on the
   per-host-domain volume signal above; require a minimum repo
   provenance signal; per-submitter (host-identity) project-creation
   cap; sponsorship / academic free tier; and only as the last lever a
   small **one-time, refundable, per-project anti-spam deposit**
   (~$20–50, refunded to honest projects, never charged to mirror
   operators or recognized OSS/academic) — explicitly a Sybil-friction
   deposit, never per-line revenue. Do not build any payment rail until
   this threat is observed in practice.
7. **Scope honesty re TUF/Sigstore (owner question) — recorded.** For
   the *identity/CA-authority* plane (`ca` track) TUF does not fit
   (it models artifacts, not "which online key may currently mint
   live per-request attestations + freshness") — maintainers is the
   right tool there. For the *release/update* plane (`release` track),
   TUF / Sigstore + reproducible-build CI are mature, standard, and
   arguably safer than a hand-rolled track; maintainers' `release`
   track is a deliberately-simplified TUF-targets slice chosen for
   uniformity + a minimal consumer. This justifies treating `release`
   as deferrable / delegable (to app-store signing + repro-build now,
   TUF/Sigstore later) rather than a hard v1 requirement; `ca` is the
   non-negotiable maintainers root.
8. **Bot-as-attack-surface (acknowledged in §20).** The validating
   bot's correctness is security-relevant; mitigations are the
   advisory-only consumer use + the §11 continuity rule + the public
   PR audit trail + mirrors. Keep the bot's verifier = the published
   `@ibisllc/maintainers` (no bespoke re-implementation).
