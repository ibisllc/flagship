# Patent v2 — additions to make before a new filing

> Working tracker for subject matter that should be added to (or captured in a
> follow-up provisional alongside) `patent-filing/Flagship_Provisional_Specification.docx`
> / `artifacts/patent/build_provisional.py`. **Not legal advice** — the existing
> draft is explicitly a "claim-support draft for review by a registered patent
> attorney"; everything below is for counsel to review, expand, and finalize
> after a prior-art search. New matter cannot be added to an already-filed
> provisional at its filing date, so anything here that we want protected must
> be in the *next* filing.

Last updated 2026-07-21.

## Context — what the current provisional ALREADY covers (do NOT refile these)

The "AI authors against fictitious data" pillar is already disclosed **and
claimed** in the current draft. For the record, so we don't waste a filing:

- **Code-zone / data-zone structural split, no credential path from author to
  production data** — method **claim 11**, node **claim 32**, isolation
  mechanisms **claim 34**. (§10 of the spec.)
- **Author against pseudonymized / dummy data; reversal map stays local** —
  **claims 19–21**. (§11.)
- **Relationship-preserving synthetic dataset generated from schema+constraints,
  "similar but not the same"** — **claims 22–23** (referential integrity,
  edge cases, overlap-test-and-regenerate). (§12.)
- **Develop-then-promote: code runs against dummy data BEFORE a production data
  principal is issued; production data never copied into the workspace** —
  **claim 24** + spec §12 ("Promotion to production occurs only after policy
  checks and, optionally, human or cryptographic approval").
- **Regulated-data (PHI/HIPAA) embodiment** — §13.
- **Value-free build journal / env-var requests (model sees the NAME, never the
  value)** — **claim 18** + §15. This is the one seam that is ALSO implemented
  and tested today (`serviceEnvStore` / `appEnvStore` / `buildCredentialStore`;
  `vps-e2e` `vibeAppEnv`).

## Gaps to ADD in the next version (the actual TODO)

Two groups below: the **dev-dataspace** items (the "AI authors against
fictitious data" harness) and the **ecosystem** items (marketplace, access
control, insured screening). Each item: what to add, why the current claims
don't reach it, and the suggested claim shape. Priority is rough (P1 = most
exposed / most distinctive).

### P1 — `--dev` dual-addressing to the synthetic dataspace
- **What:** the same deployed service is reachable at two addresses; a dev
  address (e.g. `dev--<slug>.<host>` or a `?…`/suffix convention) routes the
  request to the **synthetic dataspace**, while the base host serves prod. One
  service artifact, two data principals selected by the routing label.
- **Why not covered:** claims 11/24/32 cover *isolation* and *test-before-
  promote*, but recite nothing about a **routing/addressing mechanism** that
  selects dev-vs-prod data at request time on the SAME served service. The
  routing claims (39–40, SNI/route-claim) are about node/tunnel ownership, not
  dev/prod dataspace selection.
- **Suggested claim shape:** dependent on the node/method claim — "wherein a
  request carrying a development indicator in its hostname/path is bound to a
  synthetic data principal, and an otherwise-identical request without the
  indicator is bound to the production data principal, the selection performed
  by the local TLS terminator / app-proxy without exposing the production
  principal to the development path."

### P1 — the "virtual filesystem" leg of the dev substrate
- **What:** the tri-store dev substrate the founder described is **Postgres +
  in-memory DB + virtual/overlay filesystem** presenting synthetic files
  (object-store objects, uploaded documents, blobs) to the app under
  development. The synthetic FS is generated to mirror the shape of the real
  object store without real contents.
- **Why not covered:** claim 22 recites a "dummy dataset" and claim 16 lists
  db-role / object-store / kv principals, but there is **no claim to a synthetic
  *filesystem / object-store* view** distinct from a synthetic relational
  dataset, nor to presenting it as a virtual/overlay mount to the runtime.
- **Suggested claim shape:** dependent — "wherein the dummy environment
  comprises at least a relational store, an in-memory store, and a virtual
  filesystem or synthetic object-store namespace populated with generated
  objects that preserve type, count-distribution, and referential links to the
  synthetic relational rows without containing production object contents."

### P2 — paid / independent security-review gate as a claimed promotion precondition
- **What:** promotion of an artifact from dev to prod is gated on an
  **independent (optionally for-fee) code-security attestation**; the production
  data principal is withheld until a signed pass verdict is presented. This ties
  the business model (pay-us-to-ship-to-prod) to the mechanism.
- **Why not covered:** spec §12 says "policy checks and, optionally, human or
  cryptographic approval" — generic. No claim recites an *independent
  third-party / for-consideration security attestation* as the specific gate,
  nor the withholding of the prod principal pending a signed verdict.
- **Suggested claim shape:** dependent on claim 24 — "wherein providing the
  production data principal to the runtime is conditioned on verifying a signed
  security-attestation issued by an authority distinct from the artifact's
  author, the attestation covering the exact artifact digest promoted."
- **Note:** relates to the existing (unbuilt) marketplace `scan_grade` / Trivy
  gate — but that scans marketplace *listings*, not an owner's own dev→prod
  promotion. Keep the claims distinct.

### P2 — per-build ephemeral dataspace lifecycle + reproducibility receipt
- **What:** the synthetic dataspace is minted per build/session and destroyed
  after, OR retained keyed by a generator-version + seed digest so a build is
  reproducible; the evidence bundle records the synthetic-data generator version
  and seed.
- **Why partly covered:** spec §12 line 564-ish mentions "generated per build
  and destroyed afterward, or retained with an artifact digest," and the
  evidence-bundle claim (26) lists "synthetic-data generator version." Confirm
  with counsel whether the **lifecycle/seed-reproducibility** deserves its own
  dependent claim rather than living only in the description.

### P3 — canary / egress-detection tie-in for the dev dataspace
- **What:** the synthetic dataset embeds canary tokens; egress of a canary from
  the code zone (or from a deployed prod service) raises an exfiltration signal
  — the technical complement to "malicious code in prod is why you pay for
  review."
- **Why partly covered:** §12 mentions "canary values can detect unintended
  egress." Consider a dependent claim binding canaries in the synthetic set to a
  detector on the code-zone egress channel and/or the prod telemetry channel.

## Ecosystem features to add (marketplace / access-control / insured screening)

Founder ask 2026-07-21: confirm the app marketplace, phone-crypto access
control, and the (potentially insured) automated security-screening service are
each adequately claimed; add where not. Assessment per feature below.

### P1 — App marketplace as a sharing/distribution MECHANISM
- **What:** users publish apps others can install; listings carry a manifest of
  the data classes / capabilities the app wants; the *recipient's* node enforces
  those permissions at install (scoped data principals, declared egress domains,
  no host/socket access) exactly as for a self-authored app; provenance +
  authority of a listing are cryptographically verifiable before install.
- **Why NOT adequately covered:** the marketplace currently appears ONLY as an
  *operational-authority track* — claim 45 ("independent authority tracks for …
  marketplaces …") and the §17 update-authority prose ("an untrusted
  marketplace … cannot silently replace the trust root"). That protects *who may
  bless marketplace releases*, NOT the marketplace as a **publish→discover→
  install-with-enforced-manifest** distribution mechanism, nor per-listing
  provenance/permission enforcement on the installing node. That is the
  distinctive, defensible piece and it is unclaimed.
- **Suggested claim shape:** independent method — "publishing a service listing
  comprising an artifact reference and a declarative permission manifest; a
  second user's node verifying the listing's authority and provenance;
  instantiating the service on the second node under data principals and egress
  constraints derived SOLELY from the declared manifest, such that an installed
  third-party service obtains no capability beyond its manifest and the
  publishing author obtains no credential on the installing node." Dependents:
  revocation of a listing propagates to installed instances; the same
  deterministic deployment wall (claim 11/32) applies to marketplace apps;
  royalty/attribution receipts are value-free and pseudonymous.
- **Note:** the marketplace ships only on `feat/marketplace` today; the claim is
  about the *mechanism*, which the spec already partly enables via the shared
  deploy/manifest machinery — confirm enablement detail with counsel.

### P2 — Phone-crypto access control (who-can-access-what) — MOSTLY covered; one gap
- **What:** the owner uses phone-held keys to grant other users/devices scoped
  access to a service and its data classes, verified at the node, revocable,
  without collecting civil identity.
- **Why LARGELY covered already (do not refile the core):** claims **27–30**
  (§16) claim exactly this — a signed capability binding subject → service,
  role, **data scope**, node, expiry, quota; verified at the user-controlled
  node; TLS terminated locally; value-free event receipts; revocation via a
  signed monotonic list (claim 28); proof-of-possession capability (claim 30).
  The daemon injects a signed pseudonymous identity so generated apps need no
  password/session DB (§14). This is one of the STRONGER parts of the draft.
- **The one GAP worth a dependent claim — cross-user shared-app access + data
  classes:** claims 27–30 read as owner→own-service. Add a dependent making
  explicit the **multi-user** case: an owner (or admin root) issues a capability
  granting a DIFFERENT account/device access to a SHARED app, scoped to named
  data classes/roles within that app (read-only vs read-write, per-table or
  per-collection), enforced by the local proxy without the grantee learning the
  owner's civil identity or gaining node administration. Ties access-control to
  the marketplace-shared-app case above.
- **Suggested claim shape:** dependent on claim 27 — "wherein the subject is a
  distinct account or device from the service owner, the grant enumerates named
  data classes and per-class operations within a shared service, and the
  user-controlled node enforces the per-class scope while withholding node
  administration and the owner's identity from the subject."

### P2 — Automated security-screening service WITH guarantees / insurance
- **What:** the paid dev→prod screening (P2 above / harness spec §6) issues a
  signed attestation over the exact artifact digest; the product layers a
  **guarantee** (a warranty that the reviewed artifact meets stated criteria)
  and potentially an **insurance/indemnity** against data leaks attributable to
  code that passed screening.
- **Why NOT covered + the eligibility caveat:** the *technical* screening gate
  is captured by the P2 attestation claim above. The **guarantee/insurance**
  dimension is NOT claimed, and part of it (an insurance product, a coverage
  contract) is a **business method / abstract idea** — low patent-eligibility on
  its own (Alice/§101 risk). Counsel's call. The defensible move is to claim the
  **technical carrier**, not the financial promise.
- **Suggested claim shape (technical hook only):** dependent on the P2
  attestation claim — "wherein the security attestation carries a signed
  coverage descriptor comprising a policy identifier, covered-criteria set, and
  a liability/limit reference bound to the attested artifact digest; and the
  promotion gate records a value-free receipt linking the deployed artifact
  digest, the attestation, and the coverage descriptor, such that a later
  incident can be cryptographically associated with the exact reviewed
  artifact." Keep the *underwriting/pricing/indemnity* out of the claims (or in a
  separate business-method filing counsel may advise against); patent the
  digest-bound, tamper-evident **linkage** that makes a guarantee enforceable and
  auditable — that is the technical, non-abstract part.
- **Complements:** the canary/egress detector (P3) supplies the leak-detection
  signal that an insurance product would rely on; the value-free journal +
  evidence bundle (claims 18/26) supply the audit trail. Cross-reference these
  so the screening/guarantee claim set hangs together.

## Enablement warnings for counsel (why some of the above may need to WAIT)

Implementation status differs across the items — this matters because a
provisional only gets its filing date for subject matter that is **enabled**
(described concretely enough to build). As of 2026-07-21:

- **NOT built (prose only):** the dev-dataspace items — synthetic-data
  generator, dev/prod dataspace router, `--dev` routing, promotion gate,
  virtual-FS substrate, canary detector (verified: authoring is code-only with
  no datastore handle — see `docs/dev-prod-dataspace-harness-spec.md`). Richer
  concrete prose is needed before these get a reliable filing date; ideally file
  after building them.
- **Built, on a branch:** the **marketplace** ships on `feat/marketplace` (real
  `marketplace_listings` table + app code). The publish→install-with-manifest
  mechanism is largely implemented, so the marketplace-mechanism claim is
  probably well-enabled today — pull the concrete details from that branch into
  the filing.
- **Built and live:** the **phone-crypto access-control** core (capabilities,
  scoped grants, revocation, value-free receipts) is implemented and already
  claimed (27–30). Only the cross-user shared-app dependent claim is new, and
  it's enabled by the shipped capability machinery.
- **Partly business-method:** the **insurance/guarantee** layer — claim only the
  digest-bound technical linkage; the underwriting/indemnity is a §101 risk that
  counsel may steer to a separate filing or out of the claims entirely.

For a provisional, only *enabled* subject matter gets the filing date. Options
for counsel: (a) file a follow-up provisional now covering the ALREADY-BUILT
items (marketplace mechanism, cross-user access control, the attestation/linkage
hook) with concrete detail pulled from the branch + live code, plus richer prose
for the unbuilt dev-dataspace items; (b) wait until the dev-dataspace harness is
built and file with real implementation detail; (c) both — a thin follow-up now
for what's enabled, a full nonprovisional at the 12-month mark. New matter cannot
be added to an already-filed provisional at its date.

## Cross-references
- Existing draft: `patent-filing/Flagship_Provisional_Specification.docx`,
  `artifacts/patent/build_provisional.py` (claims list ~line 690).
- Prior-art memo: `patent-filing/Flagship_PriorArt_Memo.docx`.
- Implementation spec for the gap features: `docs/dev-prod-dataspace-harness-spec.md`.
