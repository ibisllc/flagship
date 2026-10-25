# Flagship 0.3: independent security assessment package

This folder is the hand-off to an external security assessor and an external cryptographic
reviewer (architecture v2 work packages V01 and Q01/Q09; `docs/architecture-v2/IMPLEMENTATION-PLAN.md`
§13.1, §14). It says what to assess, how the system is put together, what we think can go wrong,
which cryptography nobody outside the team has reviewed, how to build and run everything, what we
already know is open, and how to report a finding so that it ties to a tested artifact.

| File | What it holds |
|---|---|
| [scope.md](scope.md) | In scope, out of scope, the release under review, rules of engagement |
| [architecture.md](architecture.md) | Components, trust boundaries, data flows, who holds which key |
| [threat-model.md](threat-model.md) | Attackers, assets, security goals, assumptions and exclusions |
| [crypto-pending-review.md](crypto-pending-review.md) | Every cryptographic composition that still needs external review |
| [build-and-run.md](build-and-run.md) | Building, the test suites, the full-test VM, the gym, the drills |
| [adversarial-tests.md](adversarial-tests.md) | The V01 adversarial suite: each test, its boundary, what it proves, its result |
| [known-gaps.md](known-gaps.md) | What is open by our own account: classical bypasses, unverified hardware, unbuilt parts |
| [issue-template.md](issue-template.md) | How to report an issue, tied to a commit and a test |

**Status of this release.** Everything here describes the `integrate/0.3-arch` line (base commit
`8007d3f8f4f69438f1a18d138a6fe4effc823ba1` plus the uncommitted V01/V02 work in that worktree, dated
2026-10-24). None of the architecture-v2 code has been externally reviewed, run on production
hardware, or switched on for real users. Every post-quantum claim is **pending external review**. The
assessor should treat our own labels ("hardware PQ", "PQ, hardware-wrapped", "strict") as claims to
test.

**Source documents** (read in this order): `AGENTS.md` (owner rules: the phone is the trust root,
TLS terminates on the box, an AI never learns who the owner is, per-app visitor identity, ranks),
`SECURITY-HARDENING-PLAN.md` (the authority and ceremony contracts), `docs/architecture-v2/`
(`IMPLEMENTATION-PLAN.md`, `evidence-map.md`, `pq-suites.md`, `crypto-graph.json`, `REGISTER.md`,
`HANDOVER.md`), `SECURITY-0.3-PROGRESS.md`.
