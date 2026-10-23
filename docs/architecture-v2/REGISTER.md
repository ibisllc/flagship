# Architecture v2: required-deliverable register

The register `IMPLEMENTATION-PLAN.md` §13.3 asks for: one row per §13.1 work package. It records the
deliverable, dependencies, owner, required hardware, required evidence, status and blockers. Nothing
in this file counts as acceptance evidence. A package is **complete** only when its §13.1 evidence
exists as receipts tied to a tested commit or artifact digest (§14). Dropping a required capability
takes an explicit owner decision and a plan revision. A register edit cannot do it.

- **Recorded:** 2026-10-23, on branch `arch/audit` at `152ab3d87` (`release/0.3` `29248cbb1` + the
  A04 skeleton). **Statuses updated** the same day after every `arch/*` branch merged into
  `feat/architecture` (merge shas in the Status column). "Committed" means code and tests exist on
  the branch; none of it is reviewed, run on Linux/real hardware, or switched on.
- **Owner column:** role placeholders from §13. No named people have been assigned (§13 says to
  assign them at kickoff). Every package also needs an independent reviewer, and a security
  reviewer for any privileged or protocol change. Both columns are unassigned throughout.
- **Status values:** `not started`, `in progress (<branch>)`, `committed (<branch> <sha>)`, `blocked`,
  `complete`. "In progress" means a branch exists for the work. It says nothing about how far the
  work has got. Statuses come from the program brief of 2026-10-23, checked against local branch
  refs: no fetch, no review of the branches' contents. On that date every `arch/*` branch still
  pointed at `152ab3d87`, so no package work had been committed on any of them yet.
- **Base already on `release/0.3`:** the column lists hardening work that a package must adopt or
  replace. It is listed so the package does not build a second copy (§6.1, §13.2). Detail and
  citations are in `evidence-map.md` §4.

## Register

| ID | Deliverable (plan §13.1) | Depends on | Owner (placeholder) | Required hardware | Required evidence | Status | Base already on release/0.3 | Blockers / notes |
|---|---|---|---|---|---|---|---|---|
| A01 | Evidence map, key/authority/data-flow inventory across installers, boot, restore, share and update | none | platform + security | none (source); synthetic-trace part needs a disposable box/VM and a gym `.com` | Synthetic trace proves no cloud plaintext; every privileged/key caller assigned | committed (feat/architecture 9be1578a7; synthetic trace outstanding) | n/a | Source inventory done in `evidence-map.md`, `crypto-graph.json`. **Synthetic traffic trace not done** (the brief forbids live services). Callers have no named owners yet (A03/kickoff) |
| A02 | Frozen journey, hardware and performance baseline; compatibility inventory | A01 | verification | 4 GiB/2 vCPU amd64 guest, arm64 guest, commodity bare metal, GPU qualification host (§5.3) | Reproducible reports on both CPU arches and existing clients | not started | `release/compatibility.json` (matrix + test) | GPU host procurement; native device runs (iOS/Android/watch) |
| A03 | ADRs approved; security-team interface ownership; schema/IPC and state-writer settled | A01 | architecture leads | none | Signed-off contract set, open blockers explicit | not started | keyd wire v1, privd wire, N05 ledger, N07 lease exist as de-facto contracts | Every implementation package below runs ahead of this approval. Their acceptance waits on it |
| A04 | Cargo workspace, toolchain/locks, artifact CI, SBOM, fuzz/conformance skeleton | A03 | release | clean amd64 + arm64 CI runners | Reproducible amd64/arm64 builds and verification from a clean runner | committed (feat/architecture 152ab3d87) | `box-artifact.yml` signed TS artifact | Skeleton only. Reproducibility receipts on both arches are still missing. A03 not approved |
| K01 | keyd v1 typed operations, software backend, TS adapter | A03–A04; security custody contract | platform | none (software backend) | All authorized operations plus hostile-caller/unknown-purpose denial; no generic signer | committed (feat/architecture 391732ca2) | TS `flagship-keyd` (`packages/keyd`), `KeydCustodian` adapter | The TS keyd still exposes a generic `unseal` and unscoped derivations (evidence map §1.2). There is no SO_PEERCRED check (`docs/keyd.md`). The daemon falls back to in-process keys unless `FLAGSHIP_KEYD_REQUIRED=1` |
| K02 | Journaled key import, opaque ACME/TLS keys, pin/rotation transition | K01; hardening TLS contract | platform + native | real box for the restart/power-loss matrix | Restart/power-loss matrix; no raw keys in Node/files/env after completion | not started | `keyd migrate`, TLS legacy takeover (`packages/keyd/src/{migrate,tls}.ts`) | Native pin transition needs iOS/Android device runs |
| I01 | Rust local TLS/HTTP ingress and façade | K01; security N01/N02 | platform | none for fuzzing; real box for budgets | Framing/smuggling/slow-client fuzz; ALPN/pin/WS/stream tests; budgets pass | committed (feat/architecture 4b02cf831) | Go `flagship-tlsd` (`installer/tls-frontend`), `controlHttp.ts` strict parser | Replaces the Go frontend. Its first job is to inventory the Go frontend's behaviour (http/1.1 only, DNS-01 only) |
| B01 | Privileged broker; remove daemon Docker/root access | A03–A04; security N05 | platform | disposable Linux guest | Compromised daemon cannot mount host paths, run a shell, grant devices or cross apps | committed (feat/architecture 3847d9406) | TS `packages/privd` (built, **not switched on**) | Daemon still root. The switch-over needs a real-box run plus streaming for docker save/load, loop mounts and chown (`SECURITY-0.3-PROGRESS.md` item 5) |
| R01 | Docker adapter and canonical ExecutionPlan | B01; N05/N12 | runtime | disposable Linux guest | Existing apps adopted with same data/identity; policy installed before start | committed (feat/architecture 3847d9406) | `serviceRunner.ts`, privd docker argument policy | |
| R02 | Durable core reconciler and TS handover | R01; N07 | platform | disposable Linux guest | Crash at every effect, single writer, revoke-race, stale-state tests | committed (feat/architecture 3847d9406) | N05 operation ledger + grant index, N07 lease (`server-daemon/src/authority/`) | Must adopt the TS ledger. Running a second writer is forbidden (§4.3) |
| R03 | Engine selection; containerd/Podman migration and importer | R01, A02 | runtime | amd64 + arm64 hosts for the 2-week scorecard | Replacement passes performance/isolation, volume migration and opt-out qualification | not started | | A02 baseline |
| U01 | Immutable box/boot artifacts, authenticated metadata, transactional updater | A04; hardening supply chain | release | real box for interrupted-update tests | Offline install/update; malicious mirror/CI and interrupted-update tests | not started | Signed k-of-n box artifact, offline verifier, symlink flip (`boxArtifact.ts`, `install-box-artifact.sh`, `artifactUpdate.ts`) | Builds on the 0.3 artifact. The plan's TUF transition is not designed. The first signed artifact is not yet published (`SECURITY-0.3-PROGRESS.md` item 0) |
| BO01 | Rust boot client with v1 interoperability, Debian/Studio integration | A04, U01 | platform | real amd64 + arm64 first boot/reboot/rescue (metal + Studio VMs) | TS/Go/Rust vectors; real first boot/reboot/rescue on both arches | committed (feat/architecture 75ceeaa7e) | Go `flagship-unseal`, `boot-stage.sh` | Depends on U01 (not started). Needs real-hardware receipts |
| BO02 | Qualified TPM/UKI/fresh-release policy and software profile | BO01; N04/N10 | security + platform | TPM 2.0 boards (amd64), arm64 firmware with TPM, vTPM hosts, Secure Boot-capable Studio guests | Physical replay/rollback/TPM-reset drills; no inherited software guarantee | not started | none: no TPM, UKI or Secure Boot code in the repo (evidence map §3) | **TPM/UKI hardware procurement**; N10 review |
| P01 | Versioned manifest/SDK normalization and admission | R01; N05/N11 | runtime + clients | none | v1 unchanged; unknown capability fails; exact-digest phone approval | committed (feat/architecture c1e6b181b; not wired into deploy) | `manifestCapabilities.ts`, N11 publisher releases | This commit was observed on 2026-10-23 at 13:07. It was not in the program brief. Record its status after review. Phone approval needs device runs |
| P02 | Isolated source builders, recipes, provenance, cache policy | P01; N12 | runtime | disposable guest or build VM | §8.3 language fixture matrix; hostile build/credential/cache tests | not started | gVisor app sandbox; migration sandbox | |
| P03 | Backup/restore, migration, resource integration | R02; N09/N13 | runtime | two different machines (cross-hardware restore) | Cross-hardware restore, hostile archives/SQL, disk/inode exhaustion; no authority rollback | not started | bounded archive reads, management reserve | |
| G01 | Hardware probe/catalog, CDI validation, driver maintenance pipeline | B01, U01 | accelerators | none for the software part; each vendor's GPU for the qualified matrix | Exact qualified matrix; invalid hooks/specs denied; no GPU required | committed (feat/architecture 924458ba6; software parts) | none | Qualified matrix needs real NVIDIA/AMD/Intel devices |
| G02 | Exclusive GPU claim journal, attachment and fair queue | G01, R02, P01 | accelerators | NVIDIA CUDA GPU on a qualified host | CUDA numerical test; revocation/crash/double-allocation/residue handling | committed (feat/architecture 924458ba6; software parts) | none | **Real NVIDIA hardware**; R02/P01 not accepted |
| AI01 | Tool broker isolation, redaction coverage, local-inference implementation | B01, P02; N05/N12 | AI + runtime | GPU host for local inference | Prompt injection cannot authorize; no live data/credentials; GPU claims shared with apps | not started | `buildModelRedactor`, AI staging, egress fence | |
| Q01 | Crypto inventory, suite/envelope/migration ADR, external design review | A01/A03; N03/N04 | security | none | Threat model, combiner spec, parameter/library selection, vector plan approved | not started | `crypto-graph.json` (A01 input) | **External cryptographic review** (procurement) |
| Q02 | Crypto implementation and cross-language verification | Q01, A04 | protocol + clients | iPhone, Android phone, Worker for cost limits | Independent KAT/interop, fuzz, device/Worker cost limits | committed (feat/architecture 61027ae1b; draft, unreviewed) | none: no PQ primitive in the repo (evidence map §3) | Runs ahead of Q01 approval. Native device runs |
| Q03 | Hybrid unlock and durable envelope rewrap | Q02, BO01; N10 | boot + protocol | real boot hardware | Downgrade/replay/restore/partial-migration tests; ciphertext-only trace | not started | | |
| Q04 | Hybrid signature enrollment/enforcement and release authority | Q02, U01; N04/N07 | protocol + release | PQ-capable offline signing hardware for release roots | Every critical verifier, recovery and offline rollback tested; AND policy enforced | not started | Release roots are classical (YubiKey Ed25519 / k-of-n Ed25519) | **Procurement**: offline PQ-capable signing tokens/HSM |
| N01 | Transport/parser budgets and relay/LAN/PQ interoperability | I01, Q02 for PQ | networking | real relay + LAN + phones on mobile networks | Large fragmented hellos, slow streams, reconnect/echo/trust regression | committed (feat/architecture 39ed9fdc4) | `tunnel-protocol` v1 | Depends on I01 (not started) |
| V01 | Adversarial integration and independent security assessment | all capability gates | verification | the full hardware matrix | No unresolved critical/high boundary defects | not started | | **External security assessment** (procurement) |
| V02 | Canary runbooks, receipts, cohort monitoring, support docs | V01, U01, A02 | release + clients | maintainer test boxes, canary owner boxes | Actual recovery/update/rollback proof and UX parity before cohort expansion | not started | release-manifest receipts tooling | Consenting canary owners |
| P04 | WASI worker, capability SDK, lifecycle integration | B01, P01, P03 | runtime | none | WASI fixture plus loop/memory/host-call/cache isolation and backup tests | committed (feat/architecture 924458ba6; p1 only, no component model) | none | P03 not started |
| P05 | Single-host app groups and dedicated per-app DB profile | R02, P01, P03 | runtime | disposable guest | Group rollback/consistent restore; hostile DB cannot exhaust sibling/management reserve | not started | | |
| G03 | AMD/ROCm and Intel Level Zero/oneAPI adapters; qualified VM passthrough | G01, B01, R03 | accelerators | **AMD ROCm GPU, Intel Arc/Data Center GPU, IOMMU-capable host** | Real numerical workloads per vendor; IOMMU/group/reset and isolation receipts | not started | | **Real AMD and Intel hardware**; IOMMU host |
| G04 | MIG partitions, cooperative sharing, headless graphics/video | G02, G03 | accelerators | **MIG-capable NVIDIA GPU (A100/H100 class)**; encode/decode-capable GPUs | Partition/fault isolation, fair queueing, render/encode/decode output, revoked jobs | not started | | **MIG hardware** |
| G05 | Single-server multi-GPU training/fine-tuning and checkpoints | G02–G04, AI01 | accelerators + AI | **multi-GPU host** | Atomic gang admission; train/resume, cancel and exhaustion tests | not started | | **Multi-GPU host** |
| AI02 | Local inference product integration, training job UI/SDK | AI01, G03–G05; privacy contract | AI + native | GPU host; phones | No cloud fallback/dataset authority expansion; accurate queue/cost/privacy controls | not started | | Native device runs |
| Q05 | PQ pairing, recovery/passkey replacement, enrollment, all authority paths | Q01–Q04; N03/N04 | security + native | phones with hardware keystores; passkey providers | Forged classical credential cannot enroll, recover, veto, share, grant or downgrade | not started | N03 record v2, N04 veto | WebAuthn/passkeys negotiate classical algorithms only today (platform dependency) |
| Q06 | Full-chain firmware/TPM/client/hypervisor trust; hardware qualification/replacement | Q01, BO02, U01 | security + platform + procurement | **TPM/secure element with PQ-capable algorithms (none known qualified)**, UKI-capable boards, phone/desktop platforms | Real boot/update/rescue/quote-forgery and independent-root tests; unsupported hardware blocks claim | not started | none | **Hardware with PQ boot/attestation roots may not exist commercially**; vendor platform roots (Apple, Google, Microsoft, firmware) are classical |
| Q07 | PQ-authenticated channels, browser/native-assisted path, strict connectors | Q02, I01, N02, Q05 | transport + native | phones; browsers | Forged WebPKI/DNS/directory or classical last leg cannot expose strict data | not started | native STK pin (classical) | WebPKI has no PQ certificates; external AI providers' TLS is outside Flagship's control |
| Q08 | PQ release/bootstrap/tooling, retained-data rekey/re-encryption, backup conversion | Q03/Q04, U01, P03 | release + storage | offline PQ signing hardware; real boxes with data | Forged build/root metadata rejected; resumable conversion and offline restore receipts | not started | | Procurement as Q04 |
| Q09 | Crypto dependency graph, forged-classical adversary harness, full strict assurance | Q05–Q08, V01 | security + verification | the full hardware matrix | Zero unresolved classical-only bypasses; external review and hardware evidence | not started | `crypto-graph.json` + `scripts/crypto-graph-check.mjs` (seeded by A01) | The checker reports bypasses today (`evidence-map.md` §5). That result is the honest one |
| N02 | Rust relay replacement, stream credit/fairness, PQ route/blessing authority | B01, Q02/Q04, ARCH-N01 | networking | Fly (or replacement) relay hosts; boxes on real networks | Relay conformance, bounded queues, mixed-client migration, reconnect, performance | committed (feat/architecture 39ed9fdc4; HELLO crypto, outbound, mailbox, gossip lacking) | TS relay `apps/web/src/tunnel` | Q02/Q04 not accepted, so PQ authority cannot be finished |
| C01 | Breaking-change preflight, scoped opt-out, compatibility, return-to-strict | all migrations, Q05/Q09 | native + security + release | phones, watches, Studios | Decline without data loss; no downgrade spillover; fresh rekey/recovery on strict re-entry | in progress (feat/architecture 361e5d253: policy record + rollout state machine; no native UX) | | Native device runs on every client |

## Blockers that code alone cannot clear

These block completion whatever the software state. §6.10 and §14 forbid closing them with a
disclosure.

1. **GPU hardware, per vendor:** a real NVIDIA CUDA device (G02), an AMD ROCm-supported device and
   an Intel Level Zero device (G03), each with pinned drivers on a qualified host. Mocks cannot
   pass G02–G05 (§9.5).
2. **MIG-capable and multi-GPU hosts:** an A100/H100-class (or newer) MIG device for G04 and a
   multi-GPU single host for G05. Both are also needed for the A02 GPU baseline.
3. **IOMMU / device-passthrough host** with safe group assignment and reset (G03 VM passthrough).
4. **TPM 2.0 and UKI/Secure Boot hardware:** amd64 boards, arm64 firmware with a TPM, vTPM hosts,
   and Studio guests with Secure Boot (BO02, Q06). For the strict full-chain claim, the TPM or
   secure element must actually implement PQ-capable algorithms. No such device is qualified
   today (§6.8), and procurement or replacement may be the only route.
5. **Platform roots outside Flagship's control:** iOS/Android secure boot and app signing, passkey
   providers (WebAuthn negotiates classical algorithms), WebPKI certificates, APNs/FCM, Cloudflare
   and Fly TLS. Each needs a vendor capability, a replacement, or an explicit scoped compatibility
   opt-out (Q05–Q07).
6. **External cryptographic design review** of the hybrid KEM combiner, hybrid signature binding,
   unlock v2 and the release-root policy (Q01, ADR-005, ADR-011). Also an **independent security
   assessment** (V01, Q09).
7. **Procurement:** offline PQ-capable signing tokens or an HSM for the release and maintainer
   roots, which are YubiKey Ed25519 today (Q04/Q08). The external reviewers. The hardware in 1–4.
8. **Native device runs:** iOS, iPadOS, watchOS, Android, Wear OS and all three Studios, on real
   devices. They are needed for A02 baselines, K02 pin transition, Q02 cost limits, Q05 enrollment
   and recovery, C01 opt-out, and the §3 journey suite. Simulators and mock gyms do not count
   (§14).
9. **Synthetic live trace for A01/OQ-01:** a disposable box and gym `.com` with recorded traffic.
   The A01 brief scoped it out (source only), so it remains open.
10. **Contract approval (A03)** is organizational, not hardware. Several packages started before
    it. None of them can be accepted until A03 signs off the contracts they implement.
