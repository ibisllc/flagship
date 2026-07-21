# Spec — synthetic dev-dataspace harness + dev→prod promotion wall

**Status:** design / not started, 2026-07-21. This is the concrete build plan
for the "AI authors against fictitious data, then promotes to a data-blind prod"
feature (patent pillar 3). It exists because a code audit found the mechanism is
**described in the patent draft but NOT implemented** — see
`docs/patent/patent-v2-additions.md`. It builds ON the shipped seams, not from
scratch.

## 0. What already exists (build on these, don't reinvent)

- **Code-only authoring.** The vibecode model's only tools are `requestEnvVar`
  (value-free) and `talkToUser`. It emits a file tree + manifest; it has **no
  datastore handle during authoring** (`packages/server-daemon/src/llm/
  vibeCodeSession.ts`, `systemPrompt.ts`). So the model can't read data today —
  but it also has **nothing realistic to develop against**.
- **Per-service data provisioning at deploy.** `packages/server-daemon/src/
  dataLayer/provisioner.ts` already creates a scoped Postgres db+role, a MinIO
  bucket+key, and a Redis ACL user+prefix per `(creator, slug[, storeName])`
  (`dataLayer/naming.ts`). Credentials are injected into the deployed container
  as `FLAGSHIP_PG_URL`, `FLAGSHIP_PG_DATABASE`, `FLAGSHIP_PG_ROLE`,
  object/kv equivalents.
- **Value-free credential injection.** `serviceEnvStore` / `appEnvStore` seal
  secrets at rest and inject them into the container; the model sees only the
  NAME. Proven by `tools/vps-e2e` `vibeAppEnv`.
- **Deterministic deploy mediator.** `buildmodes/deployArtifact.ts` writes the
  tree, commits to Forgejo, builds a hardened container, serves it behind the
  local TLS proxy / app-proxy (`byLabel()` SNI routing).
- **Manifest declares stores.** `data.stores.{postgres,objects,kv}` in the
  app manifest already drives provisioning.

The gap is three things: (1) a **synthetic dataset** generated from the app's
own schema, (2) a **dev dataspace** the app runs against during authoring +
iteration, addressed separately from prod, and (3) a **promotion wall** that
hands the app a prod data principal only after a gate, with the author never
holding prod data or prod code-write access.

## 1. Target architecture

```
                      ┌─────────────────── user's box (daemon) ────────────────────┐
  author (LLM/IDE) ──▶│  CODE ZONE                    DATA ZONE (prod, sealed)      │
  code-only tools     │  ┌───────────┐   deploy       ┌──────────────────────────┐ │
  no data handle      │  │ workspace │──mediator──────▶│ prod PG db+role          │ │
                      │  │ + manifest│                 │ prod MinIO bucket        │ │
                      │  └─────┬─────┘                 │ prod Redis prefix        │ │
                      │        │ schema                 └──────────────────────────┘ │
                      │        ▼                          ▲ principal issued ONLY     │
                      │  ┌───────────────┐                │ after promotion gate      │
                      │  │ SYNTHESIZER   │                 │                           │
                      │  │ schema→fake   │   dev run       │                           │
                      │  └──────┬────────┘   ┌─────────────┴────────────┐              │
                      │         ▼            │ DEV dataspace (ephemeral) │             │
                      │  ┌────────────────┐  │  synth PG schema+rows     │             │
                      │  │ dev deploy     │─▶│  in-mem KV                 │             │
                      │  │ (dev principal)│  │  virtual FS / synth bucket │            │
                      │  └────────────────┘  └───────────────────────────┘            │
                      └──────────────────────────────────────────────────────────────┘

  request routing:  https://<slug>.<host>.<user>...          → prod dataspace
                    https://dev--<slug>.<host>.<user>...      → dev dataspace
```

Invariant: **the author (any model, IDE, imported repo) only ever touches the
dev dataspace and the code workspace. The prod data principal is created and
injected by the deterministic mediator, is never returned to the author, and is
only issued after the promotion gate passes.** Malicious code that reaches prod
can still exfiltrate at runtime — that residual risk is exactly what the paid
security review (§6) addresses; the harness makes the *authoring model* blind to
prod, not the deployed code.

## 2. Component A — synthetic data synthesizer (`dataLayer/synth/`)

New package area `packages/server-daemon/src/dataLayer/synth/`.

- **Input:** the app's declared schema. Two sources, in priority order:
  1. The first-turn migration the model already emits
     (`migrations/0001_init.sql`, per `systemPrompt.ts`) — parse DDL for tables,
     columns, types, PK/FK, NOT NULL, UNIQUE, CHECK.
  2. A manifest `data.synth` block (optional richer hints: row counts per table,
     column semantic type e.g. `email|name|city|lorem`, value distributions).
- **Generator:** typed, relationship-preserving. Must preserve, per the patent
  claims we want to enable: foreign keys, uniqueness, cardinality, temporal
  ordering, lifecycle/enum states, NULL-ability, boundary values. Use a seeded
  PRNG (seed = `HKDF(SWK, "flagship.synth.v1|<creator>|<slug>|<buildId>")`) so a
  build is reproducible and the seed is recorded in the evidence bundle.
- **Fidelity WITHOUT real data:** the synthesizer is schema+policy driven. It
  does **not** read prod rows. Optional (later): differentially-private
  aggregates computed by a separate local privileged component and passed as
  distribution hints — but v1 is schema-only to keep the "author never sees real
  data" invariant trivially true.
- **Overlap guard:** if any distribution hints are ever derived from real data,
  run the overlap test (n-gram / rare-value / near-duplicate) and regenerate
  suspect rows (patent claim 23). v1 (schema-only) can no-op this but keep the
  hook.
- **Canaries:** embed a small number of canary tokens in the synthetic set so
  egress can be detected downstream (§6 tie-in).
- **Output:** a `SyntheticDataset` = `{ pg: SQL seed script, kv: seed entries,
  objects: [{key, bytes}] }` — one per declared store.

Deliverables: `synth/generate.ts`, `synth/schemaParse.ts`,
`synth/types.ts`, golden vectors in `test-vectors/synth/` (same schema+seed ⇒
byte-identical dataset — this is a claim-support artifact too), unit tests for
FK integrity, uniqueness, enum coverage, boundary inclusion.

## 3. Component B — dev dataspace (ephemeral, per session/build)

Extend `dataLayer/provisioner.ts` with a **dev variant**:

- New identity namespace: `pgDatabase({creator, slug, storeName})` gets a
  `dev_` prefix (or a parallel `AppDataIdentity.space: "dev" | "prod"` field
  threaded through `naming.ts`). Same for MinIO bucket / Redis prefix.
- **Postgres:** a real dev db+role on the same local PG, seeded from the
  synthesizer's SQL. Cheap; dropped on teardown.
- **In-memory KV:** the "in-mem db" leg — back the dev KV with a Redis logical
  DB flagged ephemeral, or an in-process map exposed via the same `FLAGSHIP_KV_*`
  contract. Simpler: reuse Redis with a `dev:` prefix and a short TTL sweep.
- **Virtual filesystem / synthetic object store:** the "virtual filesys" leg.
  Present a dev MinIO bucket pre-populated with the synthesizer's generated
  objects (fake images/docs matching count+type of prod), OR an overlay mount
  (`overlayfs` / a FUSE shim) exposing generated files read-write to the dev
  container with copy-up so writes don't touch prod. v1: dev MinIO bucket is the
  lower-effort path; the overlay FS is a P2 enhancement.
- **Lifecycle:** minted when a vibe session starts building (or on first
  `?dev` hit), destroyed on session end / TTL. Reproducible re-mint from the
  recorded seed.

Deliverables: `provisioner.ts` `provisionDevDataspace()` + `teardownDev()`, the
`space` field through `naming.ts`, tests that dev and prod identities never
collide and that dev teardown never touches a prod db/bucket/prefix.

## 4. Component C — `--dev` request routing to the dev dataspace

The app-proxy already routes `<slug>.<host>.<user>` via `byLabel()` off the SNI
label. Add a dev-addressed variant:

- **Address form:** `dev--<slug>.<host>.<user>.flagship.services` (double-dash is
  already the reserved composite delimiter — `docs/service-addressing-double-dash
  .md` — so `dev--` is parse-safe and covered by the per-box wildcard cert
  `*.<host>.<user>`; **no new cert needed**).
- **Selection:** the app-proxy detects the `dev--` prefix, and routes to the
  **same deployed container** but with the **dev** data principal injected
  (dev PG/KV/objects env), never the prod principal. If the dev dataspace isn't
  live, 409 with "start a dev session first" rather than silently hitting prod.
- **Isolation guarantee:** a request without `dev--` can never reach the dev
  principal and vice-versa; the selection is in the proxy/credential layer, not
  in app code.
- **Alternative considered:** a separate dev container instance. Rejected for v1
  (double the runtime cost); same-container-different-principal is enough because
  the principal is what gates data visibility. Revisit if apps cache the
  principal at boot (then we need a dev container or a principal-reload signal).

Deliverables: app-proxy prefix parse + principal selection, a
`serviceAccessGate` case for `dev--`, tests (dev label → dev principal; prod
label → prod principal; dev with no dev session → 409; cross-leak negative
tests).

## 5. Component D — the promotion wall (dev → prod)

A new signed order + daemon consumer. The prod data principal must not exist for
the app until this passes.

- **State machine per service:** `authoring → dev-deployed → promotion-requested
  → (gate) → prod-deployed`. Prod PG/MinIO/Redis principals are created ONLY on
  entry to `prod-deployed`.
- **Promotion order:** `flagship/service-promote/v1` — owner-IRK (or admin-root
  when the account is admin-pinned — reuse `authorizeSensitiveOrder`) signed,
  binds `(serverId, creator, slug, artifactDigest)`. The digest pins the EXACT
  reviewed artifact.
- **Author cannot self-promote:** promotion is an owner/phone action, not a
  vibecode tool. The author has no tool that creates a prod principal.
- **Deploy split:** `deployArtifact.ts` gains a `target: "dev" | "prod"`. Dev
  deploy injects the dev principal; prod deploy (only after the gate) injects the
  freshly-created prod principal. Production data is never copied into the
  workspace or the dev dataspace.

Deliverables: protocol envelope + canonical bytes + golden vectors
(`packages/protocol/src/servicePromote.ts`), daemon consumer, `deployArtifact`
target param, state persisted in the service record, tests incl. "prod principal
does not exist before promotion" and "author has no promotion tool".

## 6. Component E — the paid security-review gate (the business model)

The promotion order is refused unless a **signed security attestation** for the
exact `artifactDigest` is presented, issued by an authority distinct from the
author.

- **Attestation envelope:** `flagship/code-security-attestation/v1` — signed by a
  Flagship-operated (or maintainer-delegated) review key, over
  `(artifactDigest, verdict, scannerVersions, issuedAt, expiry)`. Verified on the
  box against a pinned review-authority key (reuse the maintainer-trust /
  operational-authority machinery — `docs/maintainer-trust-enforcement.md`).
- **What the review does:** static scan (Trivy + custom checks — the same
  `scan_grade` service the marketplace TODO already needs; build it once, use it
  for both), egress/capability analysis, canary-leak check against the synthetic
  set, dependency inventory. Paid: the review request is the monetized step.
- **Gate wiring:** the `service-promote` consumer calls `verifyAttestation`
  before creating the prod principal. No attestation / wrong digest / expired ⇒
  promotion refused, box stays on dev.
- **Honest framing (must stay in the copy):** this does NOT make prod code unable
  to exfiltrate — a determined author can still write malicious runtime code.
  The gate is a *review checkpoint*, and the value proposition is exactly that
  review. Do not claim the harness prevents prod exfiltration.

Deliverables: attestation protocol + verifier, the review service (can start as
an admin-run CLI over the artifact, later a hosted endpoint), gate wiring +
tests (valid passes, tampered/expired/wrong-digest/wrong-signer all refuse).

## 7. Component F — surface the model to the dev dataspace (make it useful)

Today the model has no data handle. To "develop freely against fake data," the
authored app must run against the dev dataspace and the author must SEE results:

- The dev container gets `FLAGSHIP_PG_URL` etc. pointing at the **dev**
  dataspace (via §3/§4). The app code is unchanged between dev and prod — only
  the injected principal differs.
- The vibecode session's `talkToUser` / preview loop should surface the dev URL
  (`dev--<slug>…`) so the owner can click through and the model can be told
  "your app is live on fake data at <dev URL>". The model still never receives
  rows — it receives the SCHEMA it wrote and, optionally, value-free test
  results / synthetic sample rows the synthesizer explicitly marked shareable.
- Keep the tool boundary: no `query_production_db`, no host paths, no container
  socket, no raw browser (patent claim 13 / `LlmHarness` guards).

## 8. Build order + estimate

1. **Synthesizer (A)** — schema parse + typed generator + golden vectors.
   Self-contained, no infra. ~2–3 days. *Highest patent value; do first.*
2. **Dev dataspace (B)** — provisioner dev variant + teardown. ~2 days.
3. **`--dev` routing (C)** — proxy prefix + principal selection. ~1–2 days.
4. **Promotion wall (D)** — envelope + consumer + deploy target. ~2 days.
5. **Model-to-dev loop (F)** — wire dev URL into the session UX. ~1–2 days.
6. **Security-review gate (E)** — attestation protocol + verifier now; the paid
   scanner service can land incrementally (shares marketplace scanner work).
   ~3–5 days for the gate; scanner service separate.

Cross-cutting: golden vectors for every new envelope (protocol convention);
`tools/vps-e2e/run.ts` gains a "vibecode → dev run on synthetic data → promote
(with attestation) → prod serves; prod principal absent before promotion" stage
(mirrors the existing `vibeAppEnv` stage). All new tables/fields via a
`packages/storage/migrations/` migration; apply before the `.com` deploy.

## 9. Non-goals / explicit residual risk

- Not claimed: preventing a malicious *deployed* app from exfiltrating prod data
  at runtime. Mitigated only by the review gate + runtime container hardening
  (read-only root, dropped caps, single port, declared egress domains — already
  in `deployArtifact`), never by making the model blind.
- Not v1: overlay-FS virtual filesystem (dev MinIO bucket substitutes);
  differentially-private real-data distribution hints (schema-only synth first);
  a separate dev container (same-container-different-principal first).

## 10. Cross-references
- Patent additions this unblocks: `docs/patent/patent-v2-additions.md`.
- Existing seams: `packages/server-daemon/src/dataLayer/`,
  `packages/server-daemon/src/buildmodes/deployArtifact.ts`,
  `packages/server-daemon/src/llm/{vibeCodeSession,systemPrompt}.ts`,
  `docs/build-modes.md`, `docs/service-addressing-double-dash.md`,
  `docs/maintainer-trust-enforcement.md`.
- Marketplace scanner (shares the review service): AGENTS.md "Marketplace
  security scanner" open item.
