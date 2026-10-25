# Flagship architecture v2: implementation plan

Date: 2026-10-23. Revision 2: owner-directed complete scope. Status: required delivery scope with implementation designs subject to verification; implementation and production qualification remain outstanding.

Audience: platform, security/protocol, native-client, runtime/build, release, and verification teams.

## 1. Delivery decision and scope

Deliver the entire architecture scope as one completion contract: Rust trusted core and relay, a replacement OCI engine, broad polyglot and WASI execution, NVIDIA/AMD/Intel acceleration, GPU sharing and headless graphics, local inference and single-server training, and post-quantum confidentiality AND authentication across every trust dependency. These are required deliverables, not optional enhancements or later phases. Dependency ordering, prototypes and safe deployment cohorts remain necessary engineering controls; none constitutes completion or permits dropping scope.

Minimize changes to ordinary UX, but permit breaking protocols, dependency replacements, key rotations, migrations and hardware requirements when needed for the security target. Users must be able to decline or explicitly opt out through the supported compatibility policy in §3.1. Preserve data and recovery; do not preserve an insecure dependency merely to avoid a breaking change. The only removed wishlist items are remote desktop/game/video streaming and platform multi-server orchestration. Applications may coordinate themselves using the existing limited, authorized server-chat interface; this project adds no cluster scheduler or broader chat authority.

The [architecture proposal](Flagship_Architecture_v2_Project.md) supplies direction. [SECURITY-HARDENING-PLAN.md](../../SECURITY-HARDENING-PLAN.md), especially §§16–18, owns authority, approvals, recovery, revocation, and user-facing security behavior. This plan supplies process boundaries, implementation interfaces, sequencing, migration, performance criteria, and delivery assignments. Where they differ, explicit owner decisions and the security plan's invariants take precedence. The security team must confirm its current contracts before each dependent implementation begins; do not treat a design document as evidence that its code has shipped.

Revision 2 records the owner's subsequent direction: the previously deferred wishlist is mandatory, dependency/security-driven breaking changes are authorized with user opt-out, and remote streaming plus platform multi-server orchestration are excluded. This direction supersedes the original proposal's phased/optional scope. The preserved proposal remains unchanged for provenance. “Streaming” in existing HTTP/SSE, file transfers and AI responses remains supported; the exclusion concerns a new remote display/game/video-streaming product.

Immediate containment of live security problems continues independently. Rust, GPU work, or PQ research must never delay those fixes. Interim security fixes may ship while the program is underway, but must not be labelled architecture-v2 completion. All required capability and quantum-assurance gates in §14 must pass for completion.

### 1.1 Source and evidence baseline

- Proposal copied verbatim from the supplied Downloads file; SHA-256 `93409114bb7e4d1e12178b3a0f13e8cc88d236155d403bdf516f62fe7537b49a`.
- Security plan examined: root `SECURITY-HARDENING-PLAN.md`, dated 2026-10-22; SHA-256 `04ae6bc9cfae10cc921e8ad058280e11958cb32d6dbdb5000dc92dc40287a513`. No `.mm` source was located. This Markdown version is the working dependency.
- Checkout examined: `feat/multilingual`, commit `97095cff30d14a1618175ec10098d901b76c531c`; local `main` was `386e29c84899283c167c9ce983d2dc2acbaa4f11`. Relevant boot routes, unlock protocol, custodian, runner, and manifest files had no diff against local main. No remote refresh or production inspection was performed. The security implementation underway may be ahead of these snapshots.
- Findings below are source observations, not a complete audit or proof of production behavior. Baseline work A01/A02 requires revalidation against the current main commit and the actual endorsed artifacts. No live accounts, private workloads, or production logs are needed for this planning work.

### 1.2 Amend the proposal's defaults

| Proposal default | Implementation decision | Reason |
|---|---|---|
| Retain Alpine | Retain deployed Debian and its existing installer/appliance flows | Alpine is parked; changing OS adds unrelated migration and recovery risk |
| New `flagship.yaml` | Evolve `flagship.app.json`; normalize old and new versions into one internal model | Existing tools, imports, app identity, and generated apps already use it |
| Runtime engine | Deliver a constrained transition adapter and migrate to the selected containerd or Podman backend | Engine replacement is required; benchmarking chooses the backend and configuration |
| Rootless OCI for normal apps | Preserve gVisor for all existing app/staging workloads; rootless is additional defense | Rootless alone would reduce the present isolation boundary |
| New service URL hierarchy | Preserve deployed naming/parser/certificate contracts | URLs are locators; architecture must not change app identity or bookmarks |
| New unlock encryption | Preserve ciphertext-only behavior and strengthen session/boot binding | The inspected boot worker already stores sealed leases and responses |
| AI local by default | Preserve the owner's existing provider choice; add local inference as an option | No surprise model downloads, cost, behavior, or hardware requirement |
| PQ near the end | Complete full trust-chain PQ protection, including authentication, as a required gate | TLS key exchange alone cannot satisfy the owner’s target |

## 2. Current implementation and migration seams

Paths below are repository-relative and identify the implementation a team must inspect, preserve, and ultimately retire or adapt.

| Area | Observed starting point | Architecture work |
|---|---|---|
| Boot | `apps/boot`, `packages/boot-core/src/{gate,routes,nonceStore}.ts`: separate Worker, identity-gated sealed lease/response handling | Retain service split; add reviewed protocol versions and suspension/freshness integration |
| Early unlock | `installer/boot-stage.sh`, `installer/unseal-helper/internal/unseal/unseal.go`, `packages/protocol/src/{unlock,phoneEndpoint,encryption}.ts` | Rust compatibility client first; then session-bound hybrid envelopes and measured-boot profile |
| Key custody | `packages/server-daemon/src/keyCustodian.ts`: in-process raw key ownership; includes generic signing and derived-key returns | Replace with typed out-of-process operations; inventory every caller before removal |
| TLS | `packages/server-daemon/src/{certManager,acme/letsEncryptIssuer,acme/persistentStore}.ts` | Isolated local TLS ingress and opaque signing; maintain issuance/pin behavior |
| Runtime | `packages/server-daemon/src/serviceRunner.ts`: Docker orchestration, restricted mounts, resource flags | Broker-validated execution plans and a runtime adapter; remove general daemon access to Docker |
| Sandboxing | `packages/server-daemon/src/appSandbox/{gvisor,state}.ts`: pinned runsc; fail-closed startup | Preserve policy, package runtime in endorsed artifacts, qualify GPU extension separately |
| App packaging | `packages/protocol/src/manifest.ts`, daemon `runtimes/{catalog,buildFile,buildContext}.ts` | Versioned manifest normalization; OCI digest promotion; broaden build recipes |
| Storage | daemon `appQuota/`, `dataLayer/`, `backupPolicy/`, `serverArchive/` | Preserve app volumes and data APIs; separate security state from restorable application state |
| Transport | `packages/tunnel-protocol/src/{frames,sni}.ts`; `apps/web/src/tunnel/`; daemon tunnel code | Keep current wire; bounded flow control/parser qualification and required Rust relay replacement |
| Updates | daemon `selfUpdateReleaseGate.ts`, boot/startup wiring, release scripts | Preserve owner + maintainer authorization; bind complete immutable artifact set and security floors |
| AI | daemon `llm/`, `llmHarness.ts`, `buildmodes/`, `egress/` | Separate tools/builds from planner, preserve redaction and sample-only staging |

Important qualifications:

1. The boot code's ciphertext-only model is visible in routes and local unsealing. This does not prove every installer, recovery, sharing, or historical path is free of plaintext transit. Trace those paths and inspect synthetic traffic in Baseline work A01/A02.
2. A copied sealed auto-unlock lease plus its private decryption key can remain usable despite deletion at the Worker. A nonce or database expiry does not repair this. Security-plan N10 owns the replay-resistant hardware design and the weaker software-profile disclosure.
3. Current app quota documentation acknowledges soft PostgreSQL enforcement and delayed enforcement in some paths. Preserve compatibility but do not label that a hard hostile-tenant storage boundary.
4. Existing runtime documentation says build `RUN` steps still need isolation work. Do not carry a host-authorized builder into the new polyglot platform.
5. No performance improvement is established by this source review. Rust is a means of narrowing authority and controlling resources, not a performance result.

## 3. Product compatibility contract

Freeze a synthetic journey suite before implementation. The suite covers account/device enrollment, Studio install, first unlock, automatic and approved reboot, Home/Apps views, app create/import/run/update, server sharing, native and browser access, lock/revoke, backup/restore, and server replacement. Include iOS, Android, web/Remote, watches where relevant, and all Studios. Keep current supported OS floors unless a security-critical capability requires a newer branch. A convenience-only Rust binding restriction is insufficient. Unsupported devices retain the explicit compatibility/recovery path; no unsupported device is labelled quantum-safe.

Preserve:

- Existing app identity, per-app visitor identity derivation, three ranks, membership signatures, grant scope, URL, cookie origin, and stored data.
- Phone approval frequency and wording established by the security work. Architecture changes use its existing inbox, permission page, status/error model, and security sliver.
- Current API responses through a compatibility façade while internals move. Preserve HTTP status, error codes, WebSockets, streaming, cancellation, and notification behavior.
- CPU-only boxes, 4 GiB Studio guests, and offline local-owner management within the security plan's authority rules.
- Existing app data paths and database credentials until an independently reviewed migration requires change.

Only new GPU capability, a newly supported isolation profile, or a meaningful security-policy change needs new product controls. Driver setup belongs to an explicit server maintenance action, not every app install. New version negotiation and internal engine names stay out of ordinary flows. Unsupported functions return actionable upgrade/capability status rather than forcing all users through setup again.

Acceptance: no gratuitous new prompt for ordinary operations; approved migration/opt-out controls reuse the security plan’s UX; identity rotations are explained and authorized; old URLs are retained where secure, while old signatures are accepted only within the explicit compatibility profile; no data loss. Evaluate multilingual layouts and accessibility using existing UI patterns. Security improvements that intentionally change behavior are tested against the security plan, not treated as compatibility defects.

### 3.1 Mandatory user opt-out and breaking-change contract

Implement two explicit policies: **Strict quantum-resistant** and **Compatibility (reduced protection)**. These are supported product policies, not hidden development flags. Strict is the target/default for new capable installations; existing owners receive a preflight and native choice before a breaking migration. Declining leaves data and ordinary compatible workflows intact; a cloud outage, ignored prompt or unsupported device is never consent. Using local inference, GPU hardware or WASI is optional for the owner; implementing them is mandatory for the teams.

The native migration screen must explain affected devices/apps, required downloads or hardware, key/data conversion, expected interruption, recovery prerequisite and effects on access. Offer migrate, defer, or continue compatibility for the exact scope. Reuse the security plan's biometric signing and durable operation model. Do not require a reinstall when a safe migration exists; if one is necessary, provide verified export/restore and a documented rollback boundary before consent.

Record opt-out as an authenticated policy change with subject, installation/data/service scope, prior/new policy, generation, affected peer set and acknowledged protection loss. A server, app, relay or old client cannot request a downgrade on the owner's behalf. A transition away from enforced strict mode requires currently active native authority satisfying that strict policy; if lost, use its reviewed recovery path. It creates a new authorized policy epoch rather than resetting anti-rollback counters or accepting stale classical messages.

Strict peers never accept legacy signatures simply because another device opted out. Mixed-mode communication obeys the stricter data/recipient policy: refuse incompatible access or obtain explicit authorization to export that exact data/workflow into compatibility. No broad toggle may silently weaken other accounts, recipients or strict installations. Quarantine legacy sessions, token audiences, trust stores and code paths; old recovery credentials cannot become an alternate route into strict authority. Test malicious negotiation, copied compatibility settings and revoked opt-out signers.

Keep the same ordinary screens, with persistent accurate per-scope assurance status in the existing security UI. Show concrete limitations (for example, browser connection or firmware root) rather than a single misleading green badge. Turning strict back on requires complete verifier checks, fresh enrollment where needed, rekeying and re-encryption of material exposed through compatibility, and a tested recovery credential. Already exported or captured plaintext/ciphertext cannot be recalled.

Compatibility must remain security-maintained within the published platform support policy; it is not an option to run known-vulnerable binaries, disable isolation, skip signature validation, or bypass the security team's stop-ship controls. It may omit unavailable PQ guarantees. Deliver legacy protocol adapters in current supported code, not an indefinitely frozen old release. Publish support requirements and advance notice for platform end of security support, plus export/recovery and hardware-migration paths. Opt-out cannot force incompatible peers or an unsupported external provider to cooperate.

## 4. Target architecture and authority ownership

```text
Native phone ── existing signed operations / future reviewed hybrid envelopes
   │
   ├── .com: identity and ciphertext metadata       boot Worker: sealed mailbox/policy
   │
   └── relay / LAN ── box-local ingress ── app endpoint or API compatibility façade
                           │
                           ├── keyd: opaque identity, ACME and TLS operations
                           └── core: authorization, desired state, reconciliation
                                      │
                              typed privileged broker
                               /         |          \
                         OCI adapter   volumes/net   GPU admission
                              │                       │
                       gVisor app/build          qualified GPU sandbox

Early boot: signed boot environment → flagship-boot → cryptsetup → encrypted host
Planner/AI: unprivileged process → scoped tool broker → isolated staging/build
```

The diagram is logical. `runtime` and `gpu` initially are libraries used by the broker/controller; they do not each require another privileged daemon. Keep custody, network ingress, general orchestration, and host mutation in separate processes because they have distinct authority. Avoid unnecessary network microservices on a small home box.

### 4.1 Proposed code layout and process boundaries

Create a root Cargo workspace with crates under `rust/`; this is a proposed path, not present code. Keep existing TypeScript packages and mobile projects.

| Crate/component | Execution identity and access | Explicit exclusions |
|---|---|---|
| `flagship-protocol` | Pure parsing/canonicalization/version schemas; TS/Rust/native conformance | No IO or private-key storage |
| `flagship-crypto` | Small reviewed wrapper over selected crypto providers | No custom primitives or general application policy |
| `flagship-keyd` | Dedicated account, private encrypted state, constrained TPM access, AF_UNIX | No Internet, Docker, arbitrary signing, file reads, plugins, shell |
| `flagship-boot` | Minimal early-boot privilege; bounded mailbox/TLS client; TPM and cryptsetup integration | No app runtime, AI, package installation or general daemon dependency |
| `flagship-ingress` | Network-facing, no root after socket setup; local TLS/HTTP; constrained signer access | No container socket, storage admin, arbitrary key operation |
| `flagship-core` | Unprivileged controller, durable operation/state DB, existing API adapter | No host shell, raw keys, Docker socket or arbitrary paths |
| `flagship-broker` | Narrow root/capability service; typed container, volume, network and update operations | No caller-authored command line, OCI spec, hook, path or environment injection |
| `flagship-runtime` | Adapter library constructing approved runtime requests | No authorization decisions delegated to app manifests |
| `flagship-gpu` | Inventory/admission library plus small confined probe helper | No app-selected CDI files or driver installation |
| `flagship-relay` | Rust opaque-stream relay, bounded queues, PQ-verified routing and service authority | No box TLS termination, content keys or generic host execution |
| `flagship-wasi` | Confined WASI worker with brokered capabilities and quotas | No ambient filesystem/network/device authority or host plugin loading |
| TS compatibility host | Existing business logic/AI/ACME network workflows under reduced privileges | No inherited root or generic broker escape hatch |

Implement the complete Rust boundary inventory and Rust relay; migrate one authority owner at a time to avoid duplicate writers. TypeScript may remain for UI, business workflows and the control plane only where it does not own privileged effects or bypass the required PQ verifiers. Integrate the required bounded verifier implementation into every retaining component; replace a component or hosting dependency if it cannot meet the contract. An FFI/WASM dependency needs its own deployment, size, CPU, and memory qualification.

### 4.2 Local IPC contract

Define versioned schemas before implementing callers. Default to bounded length-prefixed typed messages over Unix sockets; use a deterministic reviewed representation for signed objects. Preserve v1 canonical bytes exactly. IPC serialization is not automatically the signature representation.

Each request carries `protocolVersion`, `requestId`, typed operation, operation-record reference, target installation/generation, expected state revision, deadline, and bounded payload. Peer credentials identify the connecting service; an asserted UID/device/app ID in JSON grants nothing. Use separate sockets/allowlists for callers where practical. Constrain socket descriptors, message count, nesting, string sizes, response sizes, concurrency, and deadlines. Large uploads use a separate validated streaming/FD path, never unbounded IPC messages.

The broker and keyd independently validate the authority relevant to their effects. A compromised core cannot authorize itself by writing `approved=true`. They verify signed grants and durable authority generations, or a narrowly scoped capability issued by the security authority with exact object/digest binding. Revocation data must reach each effect boundary; socket membership alone is not authority.

Example broker operations: `PrepareAppVolume`, `ApplyNetworkPolicy`, `StartApprovedWorkload`, `StopWorkload`, `ActivateRelease`, `RequestShutdown`. Example keyd operations: `SignBoxHello`, `CreateTlsCsr`, `SignAcmeRequest`, `OpenBootEnvelope`. Replace generic `signAsBox` through a complete purpose inventory. Reject unknown operations and security-bearing fields; no `Exec`, arbitrary `Mount`, `SignBytes`, or `GetPrivateKey` endpoint.

Filesystem operations resolve broker-owned IDs into allowlisted objects, open safely without symlink traversal, and act on the validated descriptor. Validate inherited descriptors and descriptor type. Broker-generated argv uses absolute pinned binaries with a minimal environment; no shell expansion. Install systemd hardening, seccomp and service-user isolation, and test effective appliance properties rather than only unit-file strings.

### 4.3 Durable state and reconciliation

Use a small transactional local store (proposed SQLite with WAL, verified durability settings) on encrypted storage for operation journal, desired state, artifact references, volume mappings, and reconciliation checkpoints. The security team owns authority schemas. Keep security floors, revocation epochs, consumed approvals, and leader terms outside app backups and app rollback snapshots; protect hardware anti-rollback state as specified by that team.

Normalize desired state to an `ExecutionPlan`: app installation ID, generation, immutable image/platform digest, manifest digest, effective capabilities, resource reservation, volume IDs, network-policy digest, secret-handle references, health/restart policy, and optional device claim. Bind approvals to this digest and the expected previous revision. Persist intent before effects; mark observed runtime IDs afterwards. Reconcile after crash by deterministic workload labels and generation, not by launching another copy blindly.

There is exactly one active controller per host and one writer for each migrated resource. During shadow evaluation Rust computes decisions without performing mutations. At handover, pause the TS controller, persist a checkpoint, acquire the new controller lock, adopt existing workloads, compare state, and enable effects. Failure returns to a compatible old controller or restricted management; never run both writers. Retry safe effects idempotently; destructive effects with unknown outcomes require inspection/reconciliation.

## 5. Rust migration and performance work

### 5.1 Required work in dependency order

1. Establish Rust builds, schemas, fuzz harnesses, conformance vectors and signed packaging.
2. Move custody behind keyd with v1 behavior; replace raw-key callers and protect imports.
3. Move host mutation behind the broker while retaining the existing Docker engine.
4. Introduce maintained local TLS/HTTP ingress; keep existing business handlers behind authenticated local transport.
5. Move app reconciliation and resource scheduling into core; adopt existing containers and volumes.
6. Replace shell/Go early boot with Rust while preserving v1 vectors and recovery, then add the reviewed v2 protocol.
7. Replace the relay with Rust and qualify all existing transport functions. Use measured evidence to optimize hot paths; a disappointing benchmark triggers optimization, not removal of the required Rust deliverable.

Security fixes already implemented in TypeScript stay authoritative until a replacement passes the same tests. Never translate code mechanically and assume that authorization, cancellation or parser behavior followed it.

### 5.2 Engineering rules

Pin toolchain and dependencies; commit Cargo.lock; build amd64/arm64 artifacts in isolated CI. First-party security crates forbid unsafe code by default; exceptions and third-party FFI require inventory, rationale, review and fuzz coverage. Limit feature sets and dependencies; track licenses, advisories and native crypto libraries. Use structured errors, checked lengths, bounded task creation, cancellation, zeroization and disabled core dumps for key users. Avoid logging sensitive arguments or immutable string copies of secrets. Rust's ownership rules do not replace process isolation or cryptographic review.

### 5.3 Benchmark contract

Baseline work A01/A02 records reproducible baseline distributions using synthetic data on (a) a 4 GiB/2-vCPU amd64 guest, (b) comparable arm64 guest, (c) commodity bare metal, and (d) the GPU qualification host. Pin kernels, versions, workloads and hardware; record cold/warm states, repetitions, p50/p95/p99, CPU, RSS, IO, and error rate. Exclude human approval time from boot/operation latency but report it separately when measuring UX.

Proposed release budgets, to be ratified after the baseline rather than presented as measured facts:

| Metric | Initial gate/target |
|---|---|
| Existing HTTP/WS journeys | No >10% p95 regression versus same-machine baseline without reviewed security justification |
| Control responsiveness under app/build saturation | Local authenticated management p95 ≤1 s; reachable revocation ≤5 s, following N05 |
| New Rust trusted processes, idle CPU-only | Combined steady RSS target ≤128 MiB; whole-platform footprint must also fit the existing 4 GiB guest |
| Idle daemon/control CPU | Target ≥25% reduction after core adoption; no extra polling to obtain it |
| Bulk transfer | ≥90% baseline throughput at bounded memory; memory independent of transferred object size |
| Crash/reconcile | Adopt/recover desired app state within 30 s after core restart, excluding image pull/app startup |
| Boot | ≤10% automated-time regression on unchanged profile; report TPM/PQ increments separately |
| GPU compute | Target ≥90% same-driver isolated-container baseline; compare identical model/batch/precision |

If these targets are unattainable, publish the bottleneck and make a gate decision before rollout. Do not weaken sandboxing to win a benchmark. Bound queues and use backpressure; prefer fewer copies, streamed archives, cached immutable public metadata, and event-driven reconciliation. Do not cache authorization beyond its freshness policy. Reserve CPU, memory, disk/inodes and an IPC lane for lock/revoke/recovery before admitting workloads; test reserve exhaustion explicitly.

## 6. Key custody, TLS and cryptographic migration

### 6.1 One custody implementation shared with hardening

The architecture team implements the Rust backend for the security team's `flagship-keyd` contract; it does not introduce a second key service. Inventory STK, SWK, CGK, TLS/ACME, backup, LUKS, provider and ephemeral keys by owner, readers, storage, derivation, transport, rotation and recovery. Distinguish raw roots from permissible app-scoped derived material. A derived value still has authority and must have scope, lifetime and revocation semantics.

Import existing keys once through a privileged migration job bound to the exact source and expected public identity. Verify sign/decrypt round trips, journal completion and atomically switch handles. Preserve recovery until the new path has passed an actual restart. Remove old readers and environment/PEM copies only after cutover; rotate rather than claiming flash erasure. Software custody, TPM-sealed seed and genuinely hardware-non-exportable keys are distinct properties. Do not label imported Ed25519 or PQ seeds as TPM-native keys.

### 6.2 Local TLS ingress

Prototype a small Rust ingress using maintained TLS and HTTP libraries (rustls and a maintained HTTP stack are candidates), against the security plan's opaque signer requirements. Measure IPC-backed signing and TPM latency, renewal, SNI, ALPN, TLS 1.3, native pins, HTTP/1.1 and HTTP/2, WebSockets, SSE and large uploads. TLS session ticket keys and resumption policy belong in the key/rotation inventory too.

The signer accepts only the dedicated TLS service and a permitted key/SAN generation; bind and validate TLS signing context so it cannot become a general signing oracle. Termination necessarily exposes session plaintext and ephemeral traffic keys inside the ingress; neither Rust nor opaque long-term keys changes that fact. No PEM reaches Node. ACME networking stays outside keyd with job-scoped signing and SAN validation. Qualify the exact opaque-signing integration before choosing a library or promising hardware compatibility.

Install behind the existing tunnel and LAN listeners, shadow parser fixtures, then switch the listener atomically. Pass authenticated local metadata to the API façade and discard client-supplied identity/forwarding headers. No second ambiguous HTTP interpretation may alter authorization. Keep old certificate serving until the new leaf and native pin transition pass; retirement follows the security plan.

### 6.3 PQ inventory and coverage ledger

Maintain a machine-readable ledger for every public-key dependency, including dependencies outside application messages:

| Surface | Required target | Cutover prerequisite |
|---|---|---|
| Phone→boot unlock responses | Reviewed hybrid X25519 + ML-KEM-768 confidentiality | Native/boot vectors, authenticated ephemeral context, recovery and anti-downgrade |
| Long-lived sealed secrets, backups, recovery and peer key grants | Versioned hybrid wrapping where public-key sealing is used | All recipients and recovery devices can restore; migration receipt |
| Native↔box transport | Hybrid key exchange AND PQ-authenticated endpoint/channel binding | Replace native transport dependencies where needed; no classical-only identity bypass |
| Browser↔box transport | PQ confidentiality and endpoint authentication in a qualified browser/native-assisted path | Unsupported bare-browser private access requires explicit compatibility opt-out; §6.7 |
| Owner/device/STK critical signatures | Ed25519 AND ML-DSA-65 under a reviewed bound-key suite | Enrollment, device authority, backup, rotation and every verifier upgraded |
| Release/maintainer/routing authority | Hybrid or separately reviewed PQ signature policy | Trust-anchor migration, size/CPU checks, offline recovery and threshold tooling |
| Secure Boot/TPM/WebPKI roots | Eliminate classical-only security roots from every claimed strict path, including the verifier bootstrap | Required hardware/platform qualification or replacement; unresolved roots block the claim, §6.8 |

FIPS 203 defines ML-KEM and FIPS 204 defines ML-DSA; they do not specify Flagship's complete hybrid protocol. Use their current errata and reviewed implementations. [NIST ML-KEM](https://csrc.nist.gov/pubs/fips/203/final), [NIST ML-DSA](https://csrc.nist.gov/pubs/fips/204/final).

### 6.4 Protocol design requirements

Use new purpose/version tags for changed signed semantics; preserve deployed v1 bytes. Define exact canonical encodings, integer ranges, normalization, duplicate/unknown field rules, size bounds, key IDs, suite IDs and explicit optional-field semantics. Envelope context binds sender/recipient, installation/authority generation, purpose, session nonce, selected suite, relevant policy digest and ciphertext metadata. Never derive PQ keys by reusing an Ed25519 seed through an undocumented conversion.

Hybrid exchange must use a reviewed combiner and transcript binding, including both algorithm contributions and negotiation. ML-KEM is a KEM, not an application signature or complete authenticated channel. The PQ design review must resolve chosen-ciphertext behavior, decapsulation errors, replay, randomness failures, forward secrecy, downgrade and cross-protocol attacks. Test negative vectors and interoperable implementations, not just self-round-trips.

For hybrid signatures, both components cover the same typed transcript and bound classical/PQ public-key association. Verification after cutover requires both, not either. Protect software PQ private material using native hardware-gated wrapping where available; distinguish this from hardware execution of PQ signing. Preserve biometric semantics and the security team's active-device authority. Account root possession must not bypass recovery wait/veto.

Publish TS/Rust/Swift/Kotlin vectors and the boot-client equivalent. Evaluate a small Rust crypto library exposed via Swift/JNI and bounded WASM on Workers, versus independent native implementations; choose through build support, auditability and cross-implementation tests. Website JavaScript must not acquire private keys to enable PQ; the keyless-web rule remains intact. Test phone energy, UI responsiveness, app size and Worker CPU/body limits. Do not place kilobyte PQ signatures into a header without testing every proxy limit; use a versioned request-body envelope where necessary.

### 6.5 Rollout state machine

Per installation/authority, persist `legacy → capable → prepared → enforced → retired`. Capability advertisements alone never change trust. `prepared` requires bound new public keys, compatible verified recipients and a successful recovery check; `enforced` is an authorized monotonic policy transition. Install verifiers before issuers. Once enforced, stripping a suite, replaying capability metadata, or restoring old state cannot re-enable classical-only acceptance. Old clients get a specific upgrade/recovery path for affected actions; unrelated local apps continue.

Rewrap existing secrets through authorized endpoints, never in `.com`. Journal object version, previous/new ciphertext digest and verified recipient acknowledgement; interrupted migration resumes idempotently. Retain needed old readers until the compatibility gate passes, then retire keys/envelopes under policy. A historical backup may require offline legacy recovery and immediate re-encryption before admission. Rewrapping cannot protect ciphertext already captured with classical wrapping. If a historical wrap exposes a long-lived data key, rotate that key and re-encrypt retained protected data before declaring it migrated; do not imply rewrapping alone repairs that exposure.

rustls documents hybrid `X25519MLKEM768` support with its aws-lc-rs provider. This makes it a candidate for transport, not proof of native client support or PQ certificates. Pin and test a stable release at implementation time. [rustls defaults](https://docs.rs/rustls/latest/rustls/manual/_05_defaults/index.html).

### 6.6 Full trust-chain closure: required, not a disclosure-only ledger

Threat model: recorded traffic/storage now and an active quantum-capable network/storage attacker later; signature forgery against classical public-key schemes; substitution of enrollment, recovery, software and policy; and powered-off/boot tampering on profiles claiming physical protection. Retain the existing exclusions for a malicious running kernel, invasive hardware extraction and loss of every recovery secret. PQ cryptography does not repair those exclusions. Evaluate confidentiality and authenticity separately and evaluate physical boot assurance separately from network cryptography; aggregate claims are the intersection, never the best individual score.

Build a machine-readable cryptographic dependency graph, not only a list of algorithms. Nodes include keys, verifiers, executables, firmware, artifacts, transports, storage envelopes, administrative channels and external services. Edges record which node can replace, authorize, recover, unwrap, execute or downgrade another. A classical-only signature on the executable performing PQ verification is a bypass unless independent prior trust prevents its replacement. A PQ data channel controlled by a forgeable enrollment directory is likewise incomplete.

For every confidentiality/authorization target, demonstrate that breaking all classical public-key primitives still does not reveal protected data or authorize an effect. Use test doubles that accept forged classical credentials/certificates and a malicious directory/mirror; strict flows must still require their independent PQ or adequate symmetric proof. Test every alternative, fallback, recovery and administrative path. Closing the graph requires replacement or independent PQ/symmetric protection of each reachable bypass, not merely adding a second signature in a non-enforcing field. Availability against a malicious cloud remains a documented limitation; it cannot become permission to release secrets.

Mandatory inventory includes account/device/admin/BAK/STK/RCK authority; SWK/CGK wrapping and per-app identity; invitations and visitor proofs; phone pairing and Studio enrollment; shared-server unlock; recovery/veto clocks and checkpoints; relay blessings and certificates; boot/DNS-broker/maintainer authority; app publisher/adapters and image signing; backup/export/clone archives; browser tickets; APNs/FCM/web-push; SSH/debug access; Git/registry/CI credentials; signing infrastructure; firmware/UKI/drivers; and local/cloud AI connectors. Every item has a responsible owner and a qualified strict disposition.

### 6.7 Transport, browser, naming and external dependencies

Implement PQ-authenticated channel establishment as well as hybrid key exchange. Use a reviewed maintained protocol/library; an application-layer identity handshake, if needed for certificate interoperability, must bind the actual secure-channel transcript/exporter, both endpoint identities, intended service, roles, ephemeral exchange and freshness. Release no bearer, credential, user payload or sensitive request before that binding is verified. Do not assemble a new cryptographic protocol from independent signatures and DH results without external review. PQ key exchange authenticated only by forgeable classical certificates fails the active-attacker requirement.

WebPKI, ACME, DNS/DNSSEC and human names may remain interoperable locator/certificate services only if they cannot replace strict endpoint identity or bootstrap authority. Keep box-local TLS termination. In strict native paths, pin independently authenticated PQ roots and verify every transition. Certificate issuance and DNS changes may affect reachability but cannot cause release of private user data to an impostor.

For web access, deliver a reviewed native-assisted or suitably qualified browser transport and trusted UI delivery path. Ordinary website JavaScript cannot reliably rescue a page whose WebPKI/code-delivery trust has already been replaced. Preserve the security plan's ban on website-held private signing/channel keys. A native bridge must verify content and endpoint identity, enforce exact origins, CSRF/request binding, app isolation and local IPC authorization; it must not create an unauthenticated loopback proxy or arbitrary native signing oracle. If the browser/platform cannot enforce strict authentication and code provenance, refuse strict private access there and offer native access or an explicit compatibility choice. Public-web publishing may opt out for that audience, but cannot weaken private/admin sessions on the same box. Preserve distinct origins and authorization scopes.

Every outbound provider/database/API that receives sensitive content is part of its data path. Strict use requires qualified PQ exchange AND endpoint authentication, or an application-level PQ envelope to a verified cooperating recipient. A proxy with a classical last leg does not solve the problem. Replace providers/dependencies, use local inference/services, or block the strict connector until supported. Implement a per-connector compatibility opt-out; no automatic external failover with weaker protection. Minimize notification content and require signed/PQ-validated state fetches; forged content-free wakeups cannot authorize work. Audit notification metadata separately rather than implying zero metadata exposure.

SSH/debug, administrative APIs, database connections crossing trust boundaries, remote builders and registry access receive the same treatment. Where upstream authenticity is classical-only, require independently authenticated pinned artifacts approved through PQ release authority; download integrity by digest is insufficient if an attacker can replace that digest. Third-party app runtime libraries may initiate their own classical network traffic: inventory/declare it and constrain strict egress through approved connectors or refuse that strict app profile. The platform cannot declare arbitrary user code's crypto safe merely by packaging it in OCI.

### 6.8 Boot roots, hardware and trusted client execution

Deliver a qualified full-chain boot profile: immutable or independently provisioned PQ/symmetric trust anchor → early verifier → firmware/boot policy → UKI/kernel/initramfs → userspace/keyd and approved drivers. Cryptographic enforcement must occur before code or keys can be exposed to substituted code. A PQ-checking second-stage bootloader beneath a forgeable replaceable classical first stage does not close the chain. Include option ROMs, firmware update authorization, module loading, rescue images and rollback policy in the review. Immutable trusted hash provisioning can remove a signature dependency only when replacement and updates are actually controlled and recovery is tested.

Inventory TPM/secure-element algorithm implementations, attestation roots, endorsement/enrollment dependencies, object authorization, sealed-storage protection and policy-update algorithms. Do not infer capability from the label TPM 2.0 or from publication of a newer specification. Qualify actual vendor firmware and devices supporting the required algorithms; replace hardware or introduce a reviewed independent hardware root if necessary. Classical quotes plus a software PQ signature from attacker-controlled boot code are not PQ attestation. TCG's PQ-readiness work is a capability lead, not proof that installed hardware implements it. [TCG TPM PQ readiness](https://www.trustedcomputinggroup.org/resources/blogs/is-your-tpm-truly-pqc-ready).

Phones, watches, Studio desktops and hypervisor hosts also execute verifiers and protect roots. Inventory their secure boot, app-signing/update and hardware-keystore trust assumptions. Add native PQ verifier/update protections where enforceable; authenticate initial provisioning independently of a mutable cloud download. A PQ signature checked inside an app cannot defeat a malicious replacement of that checker by the operating system. For the full physical-chain claim, require qualified vendor/platform support or replacement hardware/software and a supported migration path. Network-PQ qualification on an otherwise trusted classical platform is a narrower profile, not full-chain completion.

No team is instructed to invent a TPM capability, bypass OS protections or claim consumer hardware can be repaired purely by software. Where the required enforcement is unavailable, procurement/vendor/platform replacement is a required work item with evidence and an unresolved completion blocker. Owners may select compatibility on their current hardware. The strict implementation must still be qualified on real supported hardware before closing this requirement.

### 6.9 Recovery, durable data, roots and symmetric strength

Replace classical-only authorization in enrollment, recovery, veto, key replacement, sharing, app access and release policy. Retain the existing security plan's recovery wait/veto and active-device semantics; algorithm changes must not create a bare-root bypass. Enroll new PQ keys through current authenticated authority before classical trust becomes suspect; if it is already suspect, require an independent owner-held trusted secret, physical verification or other reviewed trust bootstrap. A classical signature alone cannot safely bootstrap a new PQ root against an already quantum-capable impersonator.

Passkeys/WebAuthn and PRF-based recovery must be reviewed as complete mechanisms: credential signature algorithm, authenticator custody, PRF secrecy, cloud sync, record lookup, unwrap, authority and recovery activation. WebAuthn negotiates public-key algorithms; the presence of the API is not PQ assurance. Require an independent PQ/symmetric proof and recovery wrapping root where a classical assertion or synced/derived key could bypass strict protection. Provide a native recoverable high-entropy secret path (target at least 256 random bits before encoding), multiple PQ-capable enrolled devices, and authenticated offline recovery artifacts. A short PIN/biometric is a local authorization factor, not a high-entropy remote encryption secret. Preserve the native ceremony while replacing its cryptographic dependencies. [WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/).

Audit symmetric algorithms and parameter sizes, RNG/entropy, KDF/domain separation, AEAD nonce uniqueness, tag bounds and per-key usage limits. Target at least 128-bit post-quantum security strength in the reviewed construction: AES-256-class protection and appropriate HMAC/HKDF/hash choices; use SHA-384/512 where the required collision bound calls for it. Do not claim that Argon2id manufactures entropy or that a “512-bit LUKS key” automatically describes cipher strength: record the actual XTS component sizes, keyslot KDF and integrity/authentication model. LUKS confidentiality alone does not authenticate mutable root files. Bind immutable code to verified manifests/boot and authenticate data/backups at the correct layer. Select limits through crypto review, not arbitrary algorithm-name substitution.

Rotate keys whose historical classical wrapping can expose future data. Re-encrypt retained data, snapshots and new backup generations where required; regenerate backup/recovery envelopes for every authorized recipient, retire old live copies and account for offline archives. Disk-volume-key rotation/re-encryption must be resumable with a verified header/backup and tested interruption recovery. Keep legacy recovery in an isolated import path that cannot restore old authority; owners choosing not to convert retain explicit compatibility status. Captured historical ciphertext and plaintext cannot be made confidential retroactively, and SSD/cloud deletion cannot be proved by overwriting a filename.

Use independently controlled offline PQ release roots, reviewed threshold authorization and PQ-authenticated time/floor metadata. Multiple full PQ signatures under a policy threshold are acceptable without inventing threshold cryptographic primitives. Evaluate standardized SLH-DSA for infrequently used offline roots/algorithm diversity and ML-DSA for frequent operations; parameter choices require benchmarks and review. TUF metadata, app/adapter attestations, OCI signatures, CI provenance, recovery media and their verifiers all need enforced PQ coverage; classical-only TUF/signing tooling must be extended, replaced or protected by a fully enforced PQ envelope with an independently pinned bootstrap. A classical vendor/app-store signature can remain an additional packaging requirement, not the sole security root for a strict claim. [NIST SLH-DSA](https://csrc.nist.gov/pubs/fips/205/final).

### 6.10 Quantum acceptance evidence and dependency replacement rule

Q05–Q09 close the dependency graph. For each strict profile produce: threat/claim statement, cryptographic bill of materials, authenticated trust-anchor provisioning, key lifecycle and compromise procedure, protocol vectors, real native/hardware receipts, interoperability/denial tests, independent review and a graph report with zero unmitigated classical-only bypasses. Include build-time and runtime dependency owners and supported update mechanisms. Version/algorithm negotiation cannot convert a strict request into compatibility; only the authorized policy transition in §3.1 can.

Replace a library, operating-system service, firmware/hardware platform, cloud host or provider when necessary; compatibility with current dependencies is not a veto. Keep maintained reviewed implementations and independent assurance: “Rust-only,” “PQ-capable,” “hardware-backed” and a successful round trip are not proof. A missing ecosystem capability remains a delivery blocker until implemented/qualified or the owner explicitly revises scope. It cannot be hidden in a residual-risk appendix and marked complete. Numerical performance budgets may be revised with measured security justification, but security goals cannot be silently reduced to meet them.

## 7. Boot, measured state and recovery integration

Implement Rust boot in two steps. First reproduce existing request signing, sealed-response parsing and cryptsetup handoff using shared vectors and the existing TS↔Go cross-check as an oracle. Keep the emergency boot path independent of core, OCI, GPU, DNS convenience features and app storage. Use bounded network retries, approved endpoints, authenticated time/freshness policy, and secret transfer through a pipe/FD rather than argv, environment or disk files. Inspect the actual generated Debian initramfs and every Studio installer; editing `installer/boot-stage.sh` alone is insufficient.

Then implement the security team's approved session/attestation protocol. A boot request binds fresh ephemeral exchange keys, nonce, boot/authority/suspension generations, protocol suite and policy. On the verified profile, a fresh phone challenge and TPM quote bind these to enrolled attestation identity and measured UKI/boot policy; verify the event log and approved measurements, not merely quote validity. Bind the response to that exact session and accept it once. Obtain cryptographic review for unattended fresh-release policy; a reusable encrypted blob with a JSON expiry is not the solution.

Retain software-isolated and hardware-isolated support; display the distinctions through the security team's existing UX. Commodity x86 TPM, arm64 firmware, virtual TPM, firmware updates and Studio guest Secure Boot require separate qualification. A virtual TPM managed by the desktop host does not protect against compromise of that host. Do not automatically upgrade a box's assurance label from capability detection.

Define LUKS credential management explicitly: use a high-entropy keyslot credential; inventory all slots and recovery copies; add/test a replacement before removing the old slot; back up headers securely; record which authority can recover each copy. Changing a keyslot does not revoke a stolen volume key or plaintext. Whole-volume re-encryption is a required, owner-authorized migration operation where historical key exposure or cipher configuration makes it necessary. Implement resumable, backed-up re-encryption and an explicit compatibility opt-out; never perform destructive conversion silently.

Required recovery matrix: phone unavailable; all phones lost with valid recovery; TPM reset; motherboard replacement; corrupt new UKI; outdated rescue media; interrupted credential rotation; suspended box; cloud outage; disk full; clock rollback. New hardware obtains a new box identity while retaining authorized application/data identity. Recovery must preserve revocation floors and the security plan's waits/vetoes. At least one supported rescue path uses verified artifacts and owner-held recovery material without the general daemon, GPU or registry. Total loss of all recovery authority cannot be repaired by Flagship decrypting data.

For updates, stage signed UKI and matching root/userspace artifact without changing disk layout where possible; maintain known-good boot entries and a constrained rescue image. A boot success marker alone is insufficient: require identity, custody, network, management and storage readiness before acceptance. Protect anti-rollback state independently of mutable app data. Security N10/TPM policy review is a hard dependency; this document does not prescribe an unreviewed TPM policy recipe.

## 8. OCI platform and polyglot builds

### 8.1 Manifest and execution contracts

Keep `flagship.app.json` as the authoring file. Add a schema version only when behavior/security semantics require it, with a pure v1→internal-model adapter. Reject unsupported security fields rather than silently ignoring GPU, network or isolation requirements. Pin both the OCI multi-platform index digest and selected platform manifest digest in the admitted execution record.

The normalized model adds artifact/provenance reference, resource requests/limits, explicit scratch and persistent-volume references, health/startup checks, restart policy, network capabilities, secret references, isolation profile, and optional accelerator requirements. Existing names, data-store APIs, access modes and publisher/installation identity remain unchanged. Do not let a manifest self-grant privileges.

Illustrative new accelerator field, subject to schema review:

```json
{
  "accelerator": {
    "backend": "nvidia-cuda",
    "count": 1,
    "minimumMemoryMiB": 8192,
    "capabilities": ["compute"],
    "sharing": "exclusive",
    "fallback": "cpu-if-supported"
  }
}
```

Minimum memory is an admission requirement, not a VRAM quota guarantee. CPU fallback is valid only if the app includes a tested CPU execution path and the effective approval permits it. Resource/incompatibility failures must not silently change model quality, send data to a cloud provider, or relax isolation.

### 8.2 Runtime adapter decision

Define `inspectCapabilities`, `prepareImage`, `create`, `start`, `stop`, `inspect`, `events`, `logs`, and `delete` against broker-owned execution plans. No generic passthrough CLI/API. Initial adapter uses Docker with the current runsc policy. Removing Docker socket access from Node is a release criterion even while Docker remains a privileged dependency.

Timebox a two-week evaluation of Docker baseline, containerd and Podman on both architectures. Score: effective rootless/user-namespace support, runsc compatibility, CDI, network-policy enforcement, cgroup accounting, reconnect/restart adoption, log bounds, digest verification, offline artifacts, volume migration, rootless port performance, disk footprint and operational maintenance. Select and deliver containerd or Podman based on this evidence. Keeping Docker is permitted only in the migration/opt-out compatibility path, not as fulfillment of R03. If neither meets the isolation contract, fix the backend/integration or replace the dependency; the package remains incomplete until it passes. Support one production engine per box, not an indefinite fleet of interchangeable backends.

When changing engines, stop one app, checkpoint consistent data, retain image digests and volume mapping, import/adopt via the new adapter, verify health/access/data, then switch routing. Never have two engines mount the same writable data concurrently. Preserve the old compatible path until validated. Do not migrate PostgreSQL major version or filesystem in the same release.

### 8.3 Build pipeline

Support two admission paths: curated runtime recipe (existing Node/Python/static, expanded gradually) and owner-approved immutable vendor OCI artifact. Source import becomes fetch → isolated dependency acquisition → isolated build → scan/test → immutable artifact → exact digest approval/promotion. An upstream signature proves provenance, not sandbox safety.

Buildkits/buildpacks/Dockerfiles are executable untrusted inputs. Run them in an ephemeral sandbox/VM with scoped temporary storage, restricted dependency egress, no live data, no daemon socket, no host credentials, no host devices, and hard CPU/RAM/disk/time limits. If the chosen builder cannot meet this contract under runsc, use a qualified build VM or a trusted remote build service with explicit privacy policy; do not execute on the host as a fallback. Dependency fetch may use the security team's approved proxy/mirror with digest/lock validation and scoped secrets. Delete credentials before export; scan image layers and logs for leakage.

The AI continues to produce approved runtime-recipe inputs. Broadening the supported language catalog does not grant it arbitrary Dockerfile authority. Vendor build files are admitted through the existing import/security policy. Bind source revision, dependency locks, builder/toolchain digest, network policy, tests, SBOM and final image digest in provenance. Cache only immutable public dependency layers across apps; private source, credentials and model/session caches remain scoped. Cache metadata and writable cache mounts cannot cross trust boundaries.

Deliver reference apps for Rust, Go, Node/TS, Python, Java, C++, and .NET. Each must deploy from pinned OCI and from its approved source recipe, survive restart/update/rollback, write persistent data, obey egress, back up/restore, and show the same existing UI. “Any language” means supported Linux OCI ABI, architecture and syscall profile, not every arbitrary image or privileged appliance. Also deliver and test Ruby, PHP, Elixir, Julia and R recipes, plus Kotlin/JVM and C build variants. WASI and single-host multi-container app groups are required deliverables (§8.5), without introducing cross-server scheduling.

### 8.4 Storage, quotas and network

Preserve current per-app files images, database names and data API. Move mounting/admin authority into typed broker operations. Separate app schema migrations from platform migrations. Creator migrations run only as the app's constrained identity inside its sandbox; SQL never runs as production cluster admin. Coordinate quiesce, consistent backup and restore validation before irreversible migration. A healthy old binary cannot safely read an incompatible new schema: require expand/contract migrations or explicit maintenance/restore, not an automatic false rollback.

Keep backups encrypted and scope-checked; restore into quarantined quota-limited storage, verify complete manifests and archive paths, reconcile current authority, then admit code anew. Never restore sessions, consumed approvals or leader leases as live authority. Ensure inode, log, image-cache, DB temporary/WAL and build limits protect management reserve. Benchmark existing loop-volume IO before considering filesystem replacement. Deliver a dedicated per-app database profile with enforceable resource limits for hostile-workload isolation; shared Postgres remains a documented compatibility/owner-selected profile. Neither may bypass hard host reserve limits.

Enforce policy before workload start and after network/runtime restart. Preserve N02 address classification and dial-time enforcement in every host fetcher, runtime network, browser, model provider and GPU worker. Per-app identity maps to installation generation, not an easily reused container IP. Filter IPv4 and IPv6, DNS, UDP and alternative transports; no host networking, metadata access or implicit LAN grant. Use the existing access modes and authorization model; architecture creates no new rank or cloud-visible member directory.

### 8.5 Required WASI, app groups and harder data isolation

Deliver a Wasmtime-based or equivalently reviewed WASI execution backend integrated with the same manifest, app identity, approvals, logs, health, quotas, storage, backup and update contracts as OCI. Pin the supported WASI/component-model version and ship a language/SDK fixture. Run it in a confined worker process; grant only explicit directory handles and brokered network/secret capabilities. Limit linear memory, table growth, compilation, fuel/epoch time and host-call concurrency; cancel blocking host calls and test infinite loops/OOM. Treat serialized compiled modules as executable artifacts, reject untrusted cached native artifacts and isolate compilation. JIT/FFI/runtime dependencies belong in the trusted-base inventory. Wasmtime documents sandbox design and security considerations; qualify the actual pinned configuration. [Wasmtime security](https://docs.wasmtime.dev/security.html).

Deliver single-host multi-container app groups for applications requiring a web process, worker and private data component. All members share one explicitly defined app trust boundary and approval digest; different apps never gain shared mounts/secrets/network from grouping. Specify startup ordering, internal-only endpoints, health, aggregate quotas, transactional upgrade/rollback, consistent backup and failure behavior. Explicitly exclude cross-server placement, distributed scheduling, cluster membership and Kubernetes controllers. Applications needing coordination use the existing limited server-chat API, with no added discovery or authorization bypass.

Deliver dedicated database instances/volumes under the app's budget for strict hostile-workload resource isolation, with authenticated lifecycle, migrations and consistent backups. Publish compatibility limits for the existing shared-Postgres profile. Test a hostile query, WAL/temp growth, many connections and process failure while management reserve and sibling apps remain responsive. Data conversion is owner-authorized, reversible where schema permits, and part of migration/opt-out tooling.

## 9. GPU/CUDA work package

### 9.1 Required supported capability set

Deliver qualified NVIDIA CUDA, AMD ROCm and Intel Level Zero/oneAPI compute backends; GPU sharing/MIG where hardware supports it; headless EGL/OpenGL/Vulkan and video encode/decode; and single-server inference, fine-tuning and training, including multi-GPU jobs on one server. These are mandatory parts of v2. CPU-only amd64/arm64 remain first-class. Publish exact hardware/software coverage: at least one real supported device for each vendor backend, a MIG-capable device, and a multi-GPU host. Do not claim CUDA compatibility for AMD/Intel. Apple Studio guests, ordinary hosted VMs and unsupported cards must report unavailable hardware honestly; capability requirements do not imply impossible passthrough. Remote display/input/game streaming and multi-server scheduling are explicitly excluded.

Prefer the existing gVisor isolation extended through nvproxy/CDI where qualified. gVisor documents selected driver/hardware support and exposes part of the host NVIDIA driver; it is not complete GPU-driver isolation. Exact combinations must be tested. Dedicated VM/device assignment is an additional high-isolation option where IOMMU groups, reset and hardware permit; failure to support it never authorizes runc fallback. [gVisor GPU support](https://gvisor.dev/docs/user_guide/gpu/).

### 9.2 Device authority and scheduling

Inventory locally: vendor/model, locally scoped device ID, driver/toolkit/kernel version, supported compute/graphics/video features, memory and host/display ownership. Do not send stable GPU UUIDs to cloud telemetry. `flagship-gpu` creates a durable allocation journal keyed by device, app installation, operation, generation and effective policy. Only the broker resolves a local approved claim into CDI devices.

State machine: `requested → admitted → reserved → attached → running → draining → released`, with `failed` and `quarantined` outcomes. Acquire exclusive device ownership transactionally before starting a workload. On crash, reconcile actual processes/containers and open device ownership before returning capacity; a stale heartbeat is not proof a GPU is free. A GPU kill/reset may affect every user of that physical device, so quarantine or require maintenance if safe isolation cannot be proven.

The default policy assigns a non-display GPU exclusively to one workload at a time; inference, app jobs and training all use the same allocator. Long-running inference may hold the device; show queued status, allow explicit stop/release, and use bounded fair queues. Do not promise transparent preemption or checkpointing of arbitrary CUDA jobs. Implement the explicitly selected sharing policies in §9.5. Cross-app CUDA IPC and implicit cache sharing stay prohibited; shared scheduling never merges app identities or credentials. VRAM telemetry supports admission; it is not an enforceable hard memory partition on every card. Exclusive scheduling does not prove protection from driver vulnerabilities or residual-memory leaks. Qualify cleanup/reset between security contexts; quarantine on failure.

### 9.3 CDI and driver lifecycle

Generate CDI specifications only from pinned host tooling, in a root-owned directory. Treat hooks, libraries, mounts and environment changes in CDI as privileged code/configuration: verify provenance and expected paths, reject app-supplied CDI documents, `all` devices, management capabilities, arbitrary hooks and broader-than-approved capability injection. Reconcile specs after driver/MIG/device changes. NVIDIA documents that CDI describes device access and requires host driver/tooling; this is configuration, not an authorization boundary. [NVIDIA CDI](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/cdi-support.html).

Use a signed compatibility catalog tying GPU model, host kernel/module signing, driver, runsc, toolkit and approved CUDA userspace image digests. Never select a mutable “latest” CUDA tag. Driver updates are host maintenance releases with reboot/rollback and Secure Boot module-signing/measurement tests. Apps cannot install drivers or bypass unsupported-driver checks. A driver vulnerability may temporarily disable GPU admission while CPU apps remain available.

### 9.4 GPU acceptance

Require vector-add numerical verification, PyTorch inference against expected outputs, bounded allocation/OOM tests, two-job exclusion/queueing, denied device access from a non-GPU app, broker restart, worker crash, hot-unplug where possible, driver fault, revocation, full disk, and CPU fallback. `nvidia-smi` alone is not acceptance. Qualify graphics with actual headless render/encode/decode tests; do not infer it from CUDA success. Record exact hardware/software matrix and residual risks. No hardware receipt means the profile is unqualified, even if CI mocks pass.

### 9.5 Required vendor backends, sharing, graphics and training

Expose one typed device-provider interface: enumerate capabilities, validate compatibility, reserve, attach under an approved isolation profile, observe, drain and release/quarantine. Implement NVIDIA/CUDA, AMD/ROCm and Intel Level Zero/oneAPI providers with pinned userspace images, driver qualification and actual numerical workloads. Do not emulate unsupported vendor APIs or infer qualification across models. Publish backend-specific supported hardware and test receipts; AMD's ROCm compatibility matrix and Intel's maintained runtime documentation are inputs to pin selection, not guarantees from a generic device name. [AMD ROCm](https://rocm.docs.amd.com/en/latest/).

Where gVisor cannot safely mediate a backend's required devices/ioctls, deliver dedicated VM/device passthrough with IOMMU isolation, safe group assignment and reset/cleanup. This stronger profile is a required implementation, not an option to abandon non-NVIDIA support. A host without safe virtualization/device assignment refuses that capability while CPU applications continue. Do not silently grant raw host devices to an ordinary container. Host/display-owned devices are never reset or reassigned without the explicitly supported maintenance/graphics policy.

Implement three allocation policies: exclusive device; hardware-isolated partition on qualified devices (including MIG); and explicitly owner-selected cooperative sharing/time slicing for workloads in an allowed trust domain. Partition administration is broker-only; apps cannot create/destroy MIG partitions or receive management capabilities. Persist device/partition identity and topology generation; reconcile after reboot/partition change before admitting work. Prevent memory oversubscription, enforce available hardware controls and disclose limits where memory/time budgets are admission rather than hard isolation. Hostile workloads must use qualified hardware partition/isolation or exclusive dedicated VM/device policies; owner consent to cooperative sharing cannot override cross-app secrecy requirements. NVIDIA documents MIG partitions and cooperative MPS behavior; neither naming a partition nor enabling MPS proves complete host-driver isolation. [NVIDIA MIG](https://docs.nvidia.com/datacenter/tesla/mig-user-guide/latest/index.html), [NVIDIA MPS](https://docs.nvidia.com/deploy/mps/latest/index.html).

Deliver headless EGL/OpenGL/Vulkan rendering and supported hardware encoding/decoding using explicitly approved graphics/video capabilities, confined library/device injection and per-job budgets. Require output verification against known fixtures and separate compute/graphics/video permission diffs. No display capture, remote input or network streaming protocol is included. A render/transcode app may produce files through its normal storage/API without turning Flagship into a streaming product.

Deliver single-server fine-tuning/training with one and multiple GPUs: atomic gang reservation, topology validation, bounded inter-device access within one app/job, dataset/version binding, checkpoint integrity and restart, cancellation, max runtime, disk/VRAM exhaustion and fair competition with inference. Framework checkpoints are untrusted artifacts; prohibit arbitrary host-code deserialization. All GPUs in a job belong to the same admitted app generation. No multi-server training coordinator is built into Flagship. Independent apps may use the constrained chat API for their own workflows without new platform powers.

G03–G05 acceptance requires real AMD and Intel compute tests, MIG concurrent-job isolation/fault tests, cooperative scheduling under quotas, VM passthrough/reset recovery, headless rendering/video results and multi-GPU checkpoint/resume. Include cross-app buffer/cache/descriptor access attempts and revocation during an active job. Mocked devices or a “not implemented” backend cannot satisfy the completion gate.

## 10. AI harness integration

Retain the TS planner while extracting a capability-checked tool broker, disposable builder/test runner and production deployment boundary. All tool calls map to typed operations under N05, N12 and the owner decisions. Model output is untrusted data. The model never chooses its own authority, live data source, approval summary, provider credential scope or GPU allocation.

Preserve `buildModelRedactor` at every model-readable boundary, including new Rust errors, builder stderr, GPU errors and local inference output. Use synthetic staging datasets; redact host identity/addresses/environment. Provider credentials stay in a scoped connector/proxy, not the model/build environment. Cancellation and parent revocation stop queued and active tools; reconcile uncertain deployment outcomes.

Add local inference as a separate sandboxed service with pinned model weights/license provenance, download/storage budgets and GPU claims. Parsing model formats and loading custom model code is untrusted execution; no automatic remote-code trust. Share public immutable weights read-only only when policy permits; isolate prompt/KV caches and adapters. Model unavailability never silently switches a private request to cloud. Reuse existing provider selection and cost-consent behavior. Deliver isolated single-server fine-tuning/training jobs with explicit dataset mounts, checkpoint/resume, resource budgets and artifact provenance. Platform qualification uses synthetic or public fixtures. The existing model-privacy and sample-only AI-staging rule still applies: this architecture does not authorize the planner or IDE agents to read live personal data. Any app training on data granted to that app remains inside that app’s authority; broadening model-visible personal data requires a separate owner privacy decision, not a silent training feature.

## 11. Networking and relay continuity

Keep `.services` as the raw stream relay with TLS terminating on the user's box. Preserve RCK routing authorization, relay blessing/echo behavior, native identity pins, DNS wildcard behavior, ACME challenge routing and deployed service-name parsers. The proposal's example hostname is not a naming migration. Keep certificate SAN coverage distinct from wildcard DNS; exercise every existing URL form.

Before enabling hybrid TLS, test larger and fragmented ClientHello messages across LAN, tunnel, relay SNI parser and mobile fallback; bound parsing memory/deadlines without rejecting legitimate PQ clients. Test HTTP/2 and WebSocket flow control, long uploads, slow receivers, cancellation, per-stream/connection limits and fairness. ECH is a separate routing design: an SNI router cannot assume it can inspect encrypted inner names. Do not accidentally enable an incompatible routing assumption.

The current frame protocol remains v1 for the first Rust slices. New features require explicit capability negotiation; unknown frames cannot be emitted to old peers. Deliver bounded per-stream credit/fairness in the Rust transport; select a compatible framing extension or v2 through the interoperability ADR. Compare QUIC to the existing WebSocket carrier as an implementation choice, not a requirement to add another public transport. Do not claim transparent migration of arbitrary active TCP streams across a relay failure without proven state transfer; preserve reconnect and accurate failure semantics.

Relay redundancy proceeds as an operational workstream independently of rewriting it. The Rust relay is required and must reproduce all routing, quota, outbound, mailbox, drain, echo and trust behavior, including the new PQ trust bindings. ASN/IPv6 allocation remains a separate infrastructure procurement project. Platform multi-server orchestration is excluded, not deferred: apps can coordinate through existing limited server-chat under its permissions, rate limits and fencing rules. Existing backup/replica/security-policy propagation is preserved without adding a cluster scheduler.

## 12. Packaging, migration and production rollout

### 12.1 Immutable release unit

Release engineering packages exact Rust binaries, retained Node runtime/JS, boot helpers, runsc, runtime tooling and required dependencies for each architecture. Host driver/kernel/UKI components have explicit compatibility metadata. Production installs/updates verify and unpack these artifacts; they do not resolve packages or compile code on the owner's trusted host. App builds are a separate sandboxed activity.

Use established update metadata such as TUF for roots, targets, snapshot/timestamp, delegation, rotation and rollback/freeze resistance; preserve the existing maintainer endorsement plus phone-authorized install decision. TUF does not install software or solve initial trust bootstrap. Define how the existing pinned root authenticates the transition. [TUF specification](https://theupdateframework.github.io/specification/latest/).

Release manifest binds source commit already on main, all artifact digests, architecture, dependency locks/SBOM/provenance, required schema/IPC/wire ranges, minimum security floor, approved boot policy and recovery artifact. Expired catalog blocks new updates, not unrelated healthy local apps. Security floor changes require the reviewed authority policy; a compromised online service cannot unilaterally brick the fleet.

### 12.2 Compatibility and rollback matrix

| Transition | Reader first | Writer/activation second | Rollback constraint |
|---|---|---|---|
| keyd IPC | Install keyd and compatibility client | Migrate keys, switch callers | No return to raw-key-exporting code below security floor |
| Rust ingress | Pin/cert support and local façade | Listener switch | Known-good ingress with same key handles and pin policy |
| core adoption | Importer and shadow reconciler | Stop old writer; adopt | Compatible state reader only; no duplicate controller |
| manifest extension | New verifier/normalizer on box and clients | New manifest emission | Old boxes refuse unsupported features; no silent stripping |
| hybrid crypto | All receiver/verifier and recovery support | Authorized enforcement epoch | No classical-only rollback after enforcement |
| boot/TPM policy | Rescue + old/new policy qualification | Signed boot entry change | Known-good state above floor; recovery if unavailable |
| GPU | Qualified host catalog and broker | Explicit approved allocation | GPU may stop; CPU management/data remain intact |

Define exact supported versions in a machine-readable compatibility matrix, not “latest.” Test current release, previous supported release, and an offline client returning after the supported window. Separate minimum-security version from recommended version. Watch and shared/co-manager flows are part of the matrix. Preserve owner recovery when an old client can no longer sign a sensitive operation.

### 12.3 Cutover runbook template

1. Preflight versions, disk reserve, backup verification, recovery access, signed artifacts and effective authority; decline safely before mutations.
2. Stage and verify immutable files; journal migration intent and previous version. Never expose private data in migration telemetry.
3. Perform additive state migration, validate outputs, then switch one authority/resource owner atomically.
4. Exercise management, unlock/lock policy, identity pin, app health, data read/write and backup readiness using synthetic canary fixtures where possible.
5. Mark accepted only after health gates; retain a compatible rollback artifact and journal. Prune after the defined retention window and verified recovery.
6. On failure, roll back code only if schema and security floors allow. Otherwise preserve data, stop affected admission, and enter restricted native management/recovery.

Gym → maintainers' test boxes → consenting canary owners → staged cohorts. Suggested cohort observation is at least 48 hours including reboot, update and backup cycles; increase for boot/driver changes. Halt on any unauthorized effect, key exposure, data corruption, failed recovery, or security-state rollback. Performance regressions outside agreed budgets halt expansion pending review. Report denominators and profiles, not only a green percentage. Do not combine engine, crypto, GPU-driver and disk-layout changes in one cohort.

Unlaunched architecture capabilities stay on feature branches. Docs/specs belong on main; fixes to launched security behavior follow the security team's approved main path. Use independent branches such as `feat/rust-custody`, `feat/rust-broker`, `feat/polyglot-runtime`, `feat/gpu-runtime`, and `feat/pq-protocol`; dependent branches branch from their actual prerequisite. No umbrella branch containing unrelated features, no dormant feature flags as a substitute for branch isolation. Merge a coherent qualified capability before deploying production; only main is deployed. This planning change does not switch, rebase or deploy the current multilingual workspace.

## 13. Team ownership and executable backlog

Assign real named owners and reviewers at kickoff. Role names below are allocation placeholders, not assignments already made. Each package requires an independent reviewer; a security owner reviews every privileged/protocol change. Teams consume the same schema/vector repository and authority contracts.

| Team | Ownership | Interfaces to others |
|---|---|---|
| Security/protocol | Existing ceremonies, authority/recovery/freshness, crypto review | Versioned schemas, vectors, decisions, negative tests |
| Rust/platform | Custody, broker, ingress, core, boot | Typed IPC, operation journal, compatibility adapters |
| Runtime/build | OCI adapters, manifests, builders, storage/network integration | ExecutionPlan, artifact evidence, sandbox conformance |
| Accelerators/AI | GPU qualification/scheduling and local inference | Device claims, compatibility catalog, scoped tools |
| Native/web | Existing UX integration, crypto/capability support, recovery | Native signing and truthful status; no parallel ceremony |
| Release/verification | Reproducible delivery, gym, hardware matrix, benchmarks, rollout | Signed artifacts, receipts, compatibility matrix |

### 13.1 Work packages

Each row is issue-ready scope. Split implementation into reviewable PRs after the listed contract is approved. “Evidence” is mandatory, not optional testing advice.

| ID / owner | Deliverable and implementation boundary | Dependencies | Acceptance evidence |
|---|---|---|---|
| A01 / platform + security | Rebase evidence map on current main/artifacts; key/authority/data-flow inventory across all installers, boot, restore, share and update paths | None | Synthetic trace proves no cloud plaintext; every privileged/key caller assigned |
| A02 / verification | Frozen journey, hardware and performance baseline; compatibility inventory | A01 | Reproducible reports on both CPU arches and existing clients |
| A03 / architecture leads | Approve ADRs and security-team interface ownership; settle schema/IPC and state writer | A01 | Signed-off contract set, open blockers explicit |
| A04 / release | Cargo workspace, toolchain/locks, artifact CI, SBOM, fuzz/conformance skeleton | A03 | Reproducible amd64/arm64 builds and verification from clean runner |
| K01 / platform | keyd v1 typed operations, software backend, TS adapter | A03–A04; security custody contract | All authorized operations plus hostile caller/unknown-purpose denial; no generic signer |
| K02 / platform + native | Journaled key import, opaque ACME/TLS keys, pin/rotation transition | K01; hardening TLS contract | Restart/power-loss matrix, no raw keys in Node/files/env after completion |
| I01 / platform | Rust local TLS/HTTP ingress and façade | K01; security N01/N02 | Framing/smuggling/slow-client fuzz; ALPN/pin/WS/stream tests; budgets pass |
| B01 / platform | Privileged broker; remove daemon Docker/root access | A03–A04; security N05 | Compromised daemon cannot mount host paths, run shell, grant devices or cross-app operations |
| R01 / runtime | Docker adapter and canonical ExecutionPlan | B01; N05/N12 | Existing apps adopted with same data/identity; policy installed before start |
| R02 / platform | Durable core reconciler and TS handover | R01; N07 authority contracts | Crash at every effect, single writer, revoke-race and stale-state tests |
| R03 / runtime | Engine selection, required containerd/Podman migration and importer | R01, A02 | Selected replacement passes performance/isolation, volume migration and opt-out qualification |
| U01 / release | Immutable box/boot artifacts, authenticated metadata, transactional updater | A04; hardening supply-chain work | Offline install/update; malicious mirror/CI and interrupted-update tests |
| BO01 / platform | Rust boot client with v1 interoperability, Debian/Studio integration | A04, U01 | TS/Go/Rust vectors; real first boot/reboot/rescue on both arches |
| BO02 / security + platform | Qualified TPM/UKI/fresh-release policy and software profile | BO01; N04/N10 designs | Physical replay/rollback/TPM-reset drills; no inherited software guarantee |
| P01 / runtime + clients | Versioned manifest/SDK normalization and admission | R01; N05/N11 | v1 unchanged; unknown capability fails; exact digest phone approval |
| P02 / runtime | Isolated source builders, recipes, provenance and cache policy | P01; N12 | Complete language fixture matrix in §8.3; hostile build/credential/cache tests |
| P03 / runtime | Backup/restore, migration and resource integration | R02; N09/N13 | Cross-hardware restore, hostile archives/SQL, disk/inode exhaustion; no authority rollback |
| G01 / accelerators | Hardware probe/catalog, CDI validation, driver maintenance pipeline | B01, U01 | Exact qualified matrix; invalid hooks/specs denied; no GPU required |
| G02 / accelerators | Exclusive GPU claim journal, runtime attachment and fair queue | G01, R02, P01 | CUDA numerical test; revocation/crash/double-allocation/residue handling |
| AI01 / AI + runtime | Tool broker isolation, redaction coverage, required local-inference implementation | B01, P02; N05/N12 | Prompt injection cannot authorize; no live data/credentials; GPU claims shared with apps |
| Q01 / security | Crypto inventory, suite/envelope/migration ADR, external design review | A01/A03; N03/N04 | Threat model, binding/combiner specification, parameter/library selection and vector plan approved |
| Q02 / protocol + clients | Crypto implementation and cross-language verification | Q01, A04 | Independent KAT/interoperability, fuzz, device/Worker cost limits |
| Q03 / boot + protocol | Hybrid unlock and durable envelope rewrap | Q02, BO01; N10 for verified claims | Downgrade/replay/restore/partial-migration tests; ciphertext-only trace |
| Q04 / protocol + release | Hybrid signature enrollment/enforcement and release authority | Q02, U01; N04/N07 | Every critical verifier, recovery and offline rollback tested; AND policy enforced |
| N01 / networking | Transport/parser budgets and relay/LAN/PQ interoperability | I01, Q02 for PQ cases | Large fragmented hellos, slow streams, reconnect/echo/trust regression |
| V01 / verification | Adversarial integration and independent security assessment | All required capability gates | No unresolved critical/high boundary defects; findings tied to tested artifact |
| V02 / release + clients | Canary runbooks, receipts, cohort monitoring and support docs | V01, U01, A02 | Actual recovery/update/rollback proof and UX parity before cohort expansion |
| P04 / runtime | WASI worker, capability SDK and lifecycle integration | B01, P01, P03 | WASI fixture plus infinite-loop/memory/host-call/cache isolation and backup tests |
| P05 / runtime | Single-host app groups and dedicated per-app database profile | R02, P01, P03 | Group rollback/consistent restore; hostile DB cannot exhaust sibling/management reserve |
| G03 / accelerators | AMD/ROCm and Intel Level Zero/oneAPI adapters; qualified VM passthrough | G01, B01, R03 | Real numerical workloads per vendor; IOMMU/group/reset and app isolation receipts |
| G04 / accelerators | MIG partitions, cooperative sharing and headless graphics/video | G02, G03 | Partition/fault isolation, fair queueing, render/encode/decode output and revoked-job tests |
| G05 / accelerators + AI | Single-server multi-GPU training/fine-tuning and checkpoints | G02–G04, AI01 | Atomic gang admission; synthetic dataset train/resume, cancellation and resource-exhaustion tests |
| AI02 / AI + native | Local inference product integration and training job UI/SDK | AI01, G03–G05; privacy contract | No cloud fallback/dataset authority expansion; accurate queue/cost/privacy controls |
| Q05 / security + native | PQ pairing, recovery/passkey replacement, enrollment and all authority paths | Q01–Q04; security N03/N04 | Forged classical credential cannot enroll, recover, veto, share, grant or downgrade strict authority |
| Q06 / security + platform + procurement | Full-chain firmware/TPM/client/hypervisor trust and hardware qualification/replacement | Q01, BO02, U01 | Real boot/update/rescue/quote forgery and independent-root tests; unsupported hardware blocks claim |
| Q07 / transport + native | PQ-authenticated channels, trusted browser/native-assisted path and strict connectors | Q02, I01, N02, Q05 | Forged WebPKI/DNS/directory or classical last leg cannot expose strict data; browser/connector opt-out tests |
| Q08 / release + storage | PQ release/bootstrap/tooling, retained-data rekey/re-encryption and backup conversion | Q03/Q04, U01, P03 | Corrupt/forged build/root metadata rejected; resumable conversion and offline restore receipts |
| Q09 / security + verification | Crypto dependency graph, forged-classical adversary harness, full strict assurance | Q05–Q08, V01 | Zero unresolved classical-only bypasses in claimed profile; external review and hardware evidence |
| N02 / networking | Required Rust relay replacement, stream credit/fairness, PQ route/blessing authority | B01, Q02/Q04, ARCH-N01 | Entire relay conformance, bounded queues, mixed-client migration, disconnect/reconnect and performance |
| C01 / native + security + release | Breaking-change preflight, scoped opt-out, maintained compatibility and return-to-strict | All affected migrations, Q05/Q09 | Decline without data loss; no downgrade spillover; fresh rekey/recovery on strict re-entry |

Architecture backlog IDs `N01`/`N02` concern transport/relay; security-plan `N01`/`N02` concern HTTP framing/destination policy. Use full prefixes (`ARCH-N01`, `SEC-N01`, etc.) in issue trackers to avoid ambiguity.

### 13.2 Security-plan dependency map

| Hardening work | Architecture consumption; no duplicate owner |
|---|---|
| §§5–8 custody/TLS/artifacts | K01/K02/I01/U01 use the same key and release contracts |
| N01/N02 parser/dial policy | I01/R01/P02/AI01/N01 enforce at actual effects |
| N03/N04 recovery/device authority | Q01–Q04/BO02 preserve signed records and wait/veto |
| N05 transaction/revocation | Broker, reconciler, GPU and tools all execute its operation model |
| N06 keyless web | Native PQ integration; web receives no new signing/channel private keys |
| N07 freshness/fencing | Core/state import and peer operations preserve epochs, leases and membership |
| N08 chat | Preserve existing contracts; no new chat product scope in architecture |
| N09/N11 restore/identity | P01/P03 retain installation generation, publisher lineage and inert restored authority |
| N10 physical/replay claims | BO02/Q03; hardware release blocked on actual review and receipts |
| N12 model/build | P02/AI01 use sample staging, scoped credentials and provenance |
| N13/N14 operations/UX | A02/U01/V02; resource reserve, floors, sliver and established approvals |

### 13.3 Dependency graph and completion accountability

There are no reduced-scope phases or partial-v2 completion milestones. Teams must estimate and staff the full backlog, including Q05–Q09, G03–G05, P04/P05, AI02, N02 and C01 above. The earlier 24–36 week estimate covered a smaller scope and is withdrawn. Required hardware/vendor changes have no credible fixed completion date until procurement, platform capability and independent review are established. An unavailable vendor capability is a tracked blocker, not permission to declare the requirement optional.

Dependency order: baseline/contracts → reproducible artifacts and crypto design → custody/broker and verifier implementations → runtime/boot/ingress/relay and native integration → complete capability qualification → recoverable opt-out/migration → independent assessment. GPU, language/WASI, crypto and relay teams can implement against the same frozen contracts concurrently. Intermediate synthetic vertical slices are test fixtures, not separate product scope or acceptance substitutes.

One accountable program owner maintains a required-deliverable register: package, owner, dependencies, supported hardware, tests, measured result, blockers, reviewer and completion status. Replacing a library or backend is an engineering decision; dropping a required capability requires an explicit new owner decision and a visible plan revision. User opt-out affects the selected deployment profile, never whether implementers must build the feature.

Retain staged production rollout, atomic cutovers and rollback checks for safety. The project is complete only when every required row passes and the full strict profile passes its trust-chain gate. Intermediate hardening patches are allowed and necessary, but must be labelled accurately.

## 14. Verification, evidence and release definition

Run existing `npx tsc -b`, relevant Vitest tests, parity and release-readiness gates alongside new Rust checks. Add `cargo fmt --check`, clippy, locked tests, dependency policy checks and fuzz jobs. Shared vector validation covers TypeScript, Rust, Swift, Kotlin and transitional Go. Privileged Linux tests run on isolated disposable guests, not the developer host or production boxes.

Mandatory adversarial matrix:

- **Authority:** compromised daemon/AI/app; forged caller; stale installation; altered approval digest; revoked parent; two concurrent admins; replay; unsupported version; full journal disk.
- **Parsers:** malformed IPC, signatures and archives; oversized/deep payloads; HTTP ambiguity; fragmented PQ handshakes; slow input; cancellation and queue exhaustion.
- **Process isolation:** effective UID/caps/mount/network/systemd state; app and builder denial of keyd, broker and runtime sockets; prohibited device/host paths.
- **Durability:** kill/power loss before and after each migration/activation boundary; old controller restart; partial filesystem/DB write; stale restore; absent anti-rollback state.
- **Crypto:** KATs, invalid keys/ciphertexts/signatures, one missing hybrid component, substitution of key association, suite stripping, nonce reuse, old enrollment and restore credentials.
- **Resources:** CPU/memory/PID/disk/inode/WAL/log/handshake floods while phone lock/revoke/recovery remains responsive; enforce per-app and global admission.
- **Recovery:** real backup to different hardware; lost phone; TPM replacement; corrupt UKI; failed driver; suspended boot and copied lease; cloud/registry outage.
- **UX:** existing journeys and security-plan ceremonies, offline/stale clients, watch/co-manager permissions, translations, accurate pending/failure states and no redundant prompts.

Each receipt records tested commit/artifact digest, environment/profile, procedure, expected/actual result, metrics, privacy-safe evidence and reviewer. Mock success cannot substitute for a boot, GPU, native-biometric or restore receipt. Maintain an explicit list of unqualified profiles and remaining classical cryptographic dependencies.

One conjunctive completion gate (all items required):

1. **Rust and runtime:** Rust custody, broker, boot, ingress, core and relay operate in production-qualified artifacts; replacement OCI engine, secure app groups and strict resource profiles pass migration and opt-out tests.
2. **Application technologies:** every language fixture in §8.3, OCI import/build and WASI pass lifecycle, isolation, data and authorization tests.
3. **Acceleration:** NVIDIA, AMD and Intel backends, exclusive assignment, qualified sharing/MIG, dedicated-VM device isolation, headless graphics/video and single-server multi-GPU training pass real-hardware tests. Hardware not advertising a capability may refuse it; the overall implementation still requires qualified hardware for every promised capability class.
4. **Complete PQ paths:** confidentiality, authentication, authorization, bootstrap, recovery, release/update, external connectors and the claimed boot/hardware trust chain meet §§6.6–6.10. Every classical-only alternative either cannot undermine strict mode or is confined to explicitly opted-out compatibility use. Disclosure alone does not close a strict-mode blocker.
5. **User control:** users can decline migration and select scoped compatibility without data loss, unnoticed weakening of strict peers, or loss of recovery. Returning to strict mode performs the required rekey/revalidation.
6. **Evidence:** performance budgets, existing/security-plan journeys, independent cryptographic/security review and all required receipts pass. No unqualified platform inherits a whole-system quantum-safe label.

“Quantum-safe” is a bounded engineering claim about resistance to known quantum attacks under an explicit threat model, not a promise against future cryptanalysis or malicious hardware. Full v2 acceptance requires no unresolved classical-only cryptographic bypass in that claimed model. If hardware or a platform dependency cannot yet meet it, that strict profile and the corresponding completion gate remain blocked; deliver the fix/replacement rather than declaring it done with a disclaimer.

## 15. Decisions still requiring evidence

| ADR | Proposed decision | Required before implementation/enforcement |
|---|---|---|
| ADR-001 Rust boundaries | Process split in §4; keep TS business/control plane | Threat model, caller/effect inventory, resource budget |
| ADR-002 boot/attestation | Debian Rust boot; software + qualified hardware profiles | N10 policy prototype, slot/recovery matrix and real TPM evidence |
| ADR-003 OCI engine | Required containerd/Podman replacement, Docker transition adapter | R03 scorecard, migration and opt-out conformance |
| ADR-004 GPU | NVIDIA/AMD/Intel, exclusive + qualified sharing, graphics/video | All vendor/profile receipts, isolation/cleanup and maintenance rollback |
| ADR-005 PQ | Hybrid KEM and AND-signature targets; versioned rollout | External protocol/library review, native custody and complete verifier map |
| ADR-006 isolation | Preserve runsc; qualified VM for additional profiles | Syscall/build compatibility; no fallback weakening |
| ADR-007 recovery | Reuse security authority/ceremonies | Cross-hardware restore, offline rescue, legacy envelope policy |
| ADR-008 ingress | Maintained Rust TLS/HTTP with opaque signer | Signer context, TPM performance, ACME/pin/stream tests |
| ADR-009 state/update | Transactional local journal; separate security high-water marks | Power-loss/floor/recovery proof and artifact bootstrap design |
| ADR-010 performance | Ratify §5 budgets against baseline | Real CPU/GPU measurements and hardware minimums |
| ADR-011 full PQ trust graph | All classical-only bypasses removed from claimed strict paths | Q05–Q09, initial-root provenance, hardware receipts and independent review |
| ADR-012 user opt-out | Scoped authenticated compatibility, maintained adapters and safe re-entry | C01; native approval, peer isolation, backup/rekey and end-of-support tests |
| ADR-013 additional runtimes/devices | Required WASI, app groups, vendor GPU backends and sharing | P04/P05/G03–G05 conformance; no cross-server scheduler |

These are engineering gate decisions, not reasons to stop all work pending a product redesign. Teams can implement agreed compatibility interfaces and test harnesses while a dependent protocol is reviewed. Necessary dependency, protocol and hardware replacements are already authorized in scope, subject to evidence, existing security invariants and the user's migration/opt-out choice. Changes to privacy, rank semantics or recovery authority beyond that scope still require the existing security/product decision process. Coordinate ceremony implementation with that team rather than asking the owner to reauthorize the scope already agreed here.

## 16. Traceability to the global proposal

| Proposal epic | Implementation packages |
|---|---|
| E01 trust/key audit | A01–A03 |
| E02 attestation | BO02; security N10 |
| E03 ciphertext-only boot relay | A01, BO01, Q03; retain existing behavior |
| E04 recovery | BO02, P03, Q03/Q04; security N03/N04/N09 |
| E05 versioned/PQ crypto | Q01–Q09; full dependency graph required |
| E06 Rust boot/broker | BO01, B01 |
| E07 Rust daemon/runtime | K01/K02, I01, R01–R03, N02 Rust relay |
| E08 app manifest/builds | P01/P02/P04/P05 |
| E09 isolation | B01, R01, P02, G01/G02 |
| E10 storage/network/backup | P03, ARCH-N01 |
| E11 GPU/CDI | G01/G03; all vendor backends |
| E12 GPU scheduling/graphics | G02–G05; all required |
| E13 harness isolation | AI01/AI02/P02/G05 |
| E14 releases/rollback | U01, Q08, C01, V02 |
| E15 external review/adversarial tests | Q01/Q09, V01/V02 |
| E16 clustering | Explicitly excluded by owner; applications may use existing limited server-chat |

Disposition of the proposal's open questions:

| Questions | Resolution or evidence owner |
|---|---|
| OQ-01 plaintext transit | Inspected boot path is sealed; A01 must verify every path and artifact |
| OQ-02/03/04 hardware, unattended boot, phone loss | Preserve supported modes; security team owns authority/recovery, BO02 qualifies physical claims |
| OQ-05 Linux base | Debian retained; no Alpine revival in this project |
| OQ-06 runtime engine | ADR-003 selects required containerd/Podman migration; Docker only for transition/opt-out |
| OQ-07 VM default | Keep runsc baseline; no mandatory nested virtualization; qualified stronger profiles separately |
| OQ-08 public deployment | Existing admin/capability approval contract; no architecture-created public-deploy right |
| OQ-09/10/11 GPU and graphics | All three vendor backends, sharing and headless graphics required; remote streaming excluded |
| OQ-12 harness location | Existing provider choice retained; local inference opt-in |
| OQ-13 LAN | Denied unless granted through existing per-service security policy; never implicit from GPU/OCI |
| OQ-14 clusters | Excluded; applications coordinate through existing limited server-chat |
| OQ-15 phone PQ custody | Q01/Q02 and native review; hardware-wrapped software key is not hardware PQ signing |
| OQ-16 certificates/DNS | Existing addressing/cert strategy retained; I01/ARCH-N01 interoperability gate |
| OQ-17 host minimums | Preserve existing 4 GiB guests; A02 establishes measured CPU/GPU profile requirements |
| OQ-18 host drivers | Host maintenance release only; app installation cannot install them |
| OQ-19 monetization | Excluded; marketplace/payments retain their existing branch boundaries |
| OQ-20 GPU isolation | G01–G05 enforce qualified isolation policies; no universal hard-isolation promise for arbitrary GPUs |
| OQ-21 configuration authority | Signed effective desired state plus transactional local journal and one controller |
| OQ-22 update roots | Preserve existing endorsement/owner approval; U01 defines authenticated metadata transition and recovery |

## 17. Reference map

- Direction: [Flagship Architecture v2 proposal](Flagship_Architecture_v2_Project.md).
- Authority and user-facing protocol: [security-hardening plan](../../SECURITY-HARDENING-PLAN.md).
- Existing runtime/isolation/storage detail: [app runtimes](../app-runtimes.md), [AI privacy and staging](../ai-privacy-and-staging.md), [service access](../service-access-gating.md).
- Operations and compatibility: [release readiness](../runbooks/release-readiness.md), [relay addresses](../relay-addresses.md), [wildcard DNS](../wildcard-dns.md).
- External sources checked during planning: NIST ML-KEM/ML-DSA/SLH-DSA, rustls defaults, gVisor GPU support, NVIDIA CDI/MIG/MPS, AMD ROCm, Wasmtime security, WebAuthn, TCG PQ readiness and TUF, linked at their relevant decisions above. Recheck exact versions, advisories, errata and supported hardware when pinning artifacts; live documentation is not a release receipt.
