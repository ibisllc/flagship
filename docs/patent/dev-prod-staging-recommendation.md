# Recommendation — should we strengthen the patent to explicitly cover the dev→prod staging + security auto-gate?

**Date:** 2026-07-21. **Author:** engineering assessment for the founder + counsel. **NOT legal advice** — the eligibility/scope calls are for a registered patent attorney after a prior-art search. This memo is about *what technical matter to hand counsel and when*.

## Short answer

**Yes — strengthen it, but as a FOLLOW-UP filing, not a scramble before the Build Week deadline.** The core idea ("author against fictitious data, promote to a data-blind prod") is *already claimed* in the current provisional, so we are not exposed on the fundamentals. What is **not** claimed are the specific, defensible mechanisms we just built or specced — and those are exactly the parts worth their own claims. File them once they're enabled (built + concretely described), which is weeks away, not today.

## What the current provisional ALREADY covers (do not refile — verified in `artifacts/patent/build_provisional.py`)

- **Code-zone / data-zone split, no credential path from author to prod data** — method claim 11, node claim 32, isolation mechanisms claim 34, spec §10.
- **Author against pseudonymized / dummy data, reversal map stays local** — claims 19–21, §11.
- **Relationship-preserving synthetic dataset from schema+constraints ("similar but not the same")** — claims 22–23 (referential integrity, edge cases, overlap-test-and-regenerate).
- **Develop-then-promote; prod data principal created only after acceptance; prod data never copied into the workspace** — claim 24 + §12 verbatim: *"Returned code executes first against the dummy environment. Promotion to production occurs only after policy checks and, optionally, human or cryptographic approval. Production data is never copied into the build workspace."*
- **Value-free credential injection (model sees the NAME, never the value)** — claim 18, §15. This is the ONE seam already implemented AND tested in production today.

So the pillar-3 narrative in the video ("the AI writes against fictitious data; the real credential doesn't exist during authoring") is **squarely within the existing claims.** We can say it on camera without over-claiming.

## What is NOT yet claimed — the actual gaps worth adding (ranked)

1. **[P1] `--dev` dual-addressing that selects dev-vs-prod data on the SAME served service.** The claims cover *isolation* and *test-before-promote*, but recite nothing about a request-time routing label binding one deployed artifact to a synthetic principal vs a prod principal. This is distinctive and we're building it (`feat/dev-prod-dataspace` component C — `dev--<slug>` routing, core done).
2. **[P1] The "virtual filesystem / synthetic object-store" leg.** Claim 22 recites a relational "dummy dataset"; there is no claim to a synthetic *filesystem/object-store view* presented to the runtime. The tri-store dev substrate (PG + in-mem KV + virtual FS) is the founder's described mechanism.
3. **[P2] The independent / paid security-review attestation AS the specific promotion precondition, binding the exact artifact digest.** §12 says only "policy checks and, optionally, human or cryptographic approval" — generic. The defensible, monetizable mechanism is: *withhold the prod data principal until a signed attestation from an authority distinct from the author, covering the exact promoted artifact digest, verifies.* We built the fail-closed gate (`feat/dev-prod-dataspace` components D+E: `service-promote/v1` + `code-security-attestation/v1`, digest-bound, tested).
4. **[P2] Per-build ephemeral dataspace lifecycle + seed-reproducibility receipt.** Partly in §12/claim 26 as description; confirm with counsel whether the seed-reproducible lifecycle deserves its own dependent claim.
5. **[P3] Canary/egress-detection tie-in** — the synthetic set embeds canaries; egress raises an exfil signal. The technical complement to "why you pay for review." §12 mentions canaries in prose; a dependent claim binding canaries to a code-zone/prod egress detector would harden it.

Full suggested claim language for each is already drafted in `docs/patent/patent-v2-additions.md`.

## Why FOLLOW-UP, not now

A provisional only secures its filing date for subject matter that is **enabled** (described concretely enough to build). As of today:
- The dev-dataspace mechanisms are **partly built** (`feat/dev-prod-dataspace`: synthesizer + dev/prod split COMPLETE and tested; `--dev` routing, promotion wall, and attestation gate cores DONE and tested; daemon wiring + paid scanner remain). That's far more enabling detail than existed a week ago — but it is NOT on `main`/deployed, and some legs (virtual-FS, live wiring) are still thin.
- **New matter cannot be added to an already-filed provisional at its date.** So anything we want protected must go in the *next* filing regardless — there is no benefit to rushing a thin version in today and a downside (a weakly-enabled claim that counsel can't rely on).

The right sequence (counsel's call to execute):
- **(a)** A **follow-up provisional now** capturing what is already enabled — the marketplace mechanism (built on `feat/marketplace`), the cross-user access-control dependent claim (built + live), and the digest-bound attestation/linkage hook — pulling concrete detail from the branches + live code.
- **(b)** Roll the dev-dataspace mechanism claims (items 1–5) into that follow-up **with the concrete implementation detail from `feat/dev-prod-dataspace`** as it lands, OR into the 12-month nonprovisional — whichever timing counsel prefers. The more of the branch that is merged + tested when we file, the stronger the enablement.

## Eligibility caveat to flag for counsel

The **paid-review / guarantee / insurance** dimension is partly a business method (§101 / Alice risk). Claim the **technical carrier** — the digest-bound, tamper-evident linkage between deployed-artifact-digest ↔ attestation ↔ coverage descriptor — not the underwriting/pricing/indemnity. That is the non-abstract part.

## Bottom line for the founder

- **On camera / in the submission: safe.** The fictitious-data claim is already covered; stressing it is fine and honest (the mechanism is real code on `feat/dev-prod-dataspace`).
- **For the patent: yes, strengthen it** — but via a follow-up filing once the dev-prod mechanism is built out, using the claim shapes in `patent-v2-additions.md`. Don't rush a thin version before today's deadline; there's no filing-date benefit and an enablement cost.
- **Action for counsel:** review `patent-v2-additions.md` (claim shapes) + this memo; decide follow-up-now vs at-12-months; pull enablement detail from `feat/dev-prod-dataspace`, `feat/marketplace`, and the live access-control code.
