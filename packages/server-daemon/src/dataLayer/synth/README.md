# Synthetic dev-dataspace harness (`feat/dev-prod-dataspace`)

Implements the "AI authors against fictitious data, then promotes to a
data-blind prod" feature (patent pillar 3). Full design:
`docs/dev-prod-dataspace-harness-spec.md`. Patent tracking:
`docs/patent/patent-v2-additions.md`.

This branch exists because a code audit found the mechanism was **described in
the patent draft but not implemented**. It builds ON the shipped data-layer
seams (`../provisioner.ts`, `../naming.ts`, `../../buildmodes/deployArtifact.ts`,
`../../llm/vibeCodeSession.ts`), not from scratch.

## Build order (spec §8) and status

| # | Component | Status |
|---|-----------|--------|
| A | **Synthesizer** — schema→typed fake data, seeded/reproducible, FK/uniqueness/enum/boundary-preserving, canaries | ✅ **done** — `synth/` + golden vector + 12 tests |
| B | Dev dataspace — provisioner `dev` variant + teardown | ✅ **done** — `space:"dev"\|"prod"` through `naming.ts`; `provisionDevDataspace()` (seeds PG from synth SQL) + `teardownDevDataspace()` in `../provisioner.ts`; `PostgresAdmin.execSql`; dev/prod isolation + teardown-never-touches-prod tests |
| C | `--dev` routing — app-proxy prefix + dev principal selection | 🟡 **core done** — `devRouting.ts` pure parser (`parseSpaceLabel`: prod byte-identical, `dev--` diverts) + `selectDataPrincipal` (dev-with-no-session → explicit 409, never silent prod fall-through) + tests. Wiring into `runtime.ts` `byLabel` path + the injector still TODO |
| D | Promotion wall — `flagship/service-promote/v1` + gate + state machine | 🟡 **core done** — protocol envelope (`servicePromote.ts`) + `promoteGate.ts` (pure gate: owner/admin auth AND digest-bound attestation, fail-closed) + `ServiceSpaceState` machine + tests. Consumer wiring into `deployArtifact` (target:"dev"\|"prod") still TODO |
| E | Paid security-review gate — `flagship/code-security-attestation/v1` + verifier | 🟡 **envelope + verifier done** — `CodeSecurityAttestation` signed/verified by a pinned review key; enforced inside `promoteGate`. The paid scanner SERVICE that issues attestations is separate (shares the marketplace Trivy scanner) |
| F | Model-to-dev loop — surface the dev URL into the vibecode session | ⬜ not started |

## What's in this package (Component A)

- `types.ts` — `AppSchema`, `SchemaColumn`, `SyntheticDataset`, hints.
- `schemaParse.ts` — tolerant Postgres `CREATE TABLE` DDL parser (the subset the
  vibecode model emits in `migrations/0001_init.sql`). Never throws.
- `generate.ts` — deterministic generator. SHA-256 counter-mode PRNG keyed by a
  seed (no `Math.random`, no `Date.now()` — reproducible). Preserves FK
  integrity, uniqueness, enum coverage, NOT-NULL, temporal order, boundary
  values; embeds canary tokens. `datasetToSql()` renders an FK-safe seed script.
- Never reads production rows — the "author is blind to prod" invariant is
  trivially true because prod data is not an input.

Golden vector: `test-vectors/synth/golden.json` (same schema+seed ⇒ byte-
identical dataset; pinned by `tests/synth.test.ts`).

## Invariant (spec §1)

The author (any model / IDE / imported repo) only ever touches the dev
dataspace and the code workspace. The prod data principal is created and
injected by the deterministic mediator, is never returned to the author, and is
only issued after the promotion gate (D) passes its attestation check (E).
This harness makes the *authoring model* blind to prod — it does **not** stop a
malicious *deployed* app from exfiltrating at runtime; that residual risk is
what the paid review gate addresses. Keep that framing honest in all copy.
