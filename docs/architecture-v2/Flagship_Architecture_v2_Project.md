# Flagship Architecture v2 — Architectural Revamp Project

**Status:** Proposed design / decision document, not an implementation or completed security audit  
**Date:** 2026-10-23  
**Repository:** https://github.com/ibisllc/flagship  
**Scope:** secure personal-cloud boot and identity; post-quantum migration; Rust trusted core; polyglot app deployment; OCI isolation; GPU/CUDA; AI harness; networking, storage, orchestration, recovery, upgrades.

## 1. Executive decision

Evolve Flagship into a **Rust security and orchestration core** controlling a **language-neutral OCI application platform**, with an **opt-in GPU/CUDA device broker** and a **hybrid post-quantum cryptographic roadmap**. Retain TypeScript for web/control-plane components where it provides value. Avoid a wholesale rewrite or mandatory Kubernetes dependency.

**Non-negotiable:** Control plane must not need plaintext disk-unlock secrets; apps must not get host root or unrestricted devices; the platform must work without a GPU; critical boot/update paths must be independently recoverable; security claims must be tested, not inferred from use of Rust or PQ algorithms.

## 2. Evidence and assumptions

The public README (checked 2026-10-23) describes: phone as trust root; server boot via Alpine and signed recipe; LUKS disk; Cloudflare Worker/D1/R2 control plane; Fly raw-TCP SNI passthrough and tunnel WebSocket; TLS terminated on user hardware; TypeScript packages `protocol`, `server-daemon`, `tunnel-protocol`, `control-plane`, `services-zone`, `llm-providers`, plus `apps/mobile`, `installer`, and `test-vectors`. Source: https://github.com/ibisllc/flagship .

**Unverified:** actual code paths for plaintext unlock key transit, implementation of key derivation and recovery, secure-boot measurement, current app runner isolation, GPU support, code-level authentication, and precise release/rollback behavior. These require repository-level audit before changes. Treat all proposed mitigations below as target requirements, not findings of existing vulnerabilities.

## 3. Goals, non-goals, threat model

### Goals
- Private, user-owned servers and data, with no platform-side content decryption.
- Secure remote first boot, reboot, pairing, recovery, revocation, and update.
- Crypto-agile versioned protocols, quantum-resistant confidentiality and authentication where feasible.
- Run OCI-packaged apps in any language with no Flagship-language lock-in.
- Support AI-generated apps and a resident AI harness under the same policy engine.
- Opt-in CUDA, NVIDIA GPUs, and eventually other accelerators and graphics APIs.
- Default single-host install; optional future multi-node scheduling.
- Usable on commodity hardware, including systems without TPM or GPU, with accurately labeled assurance tiers.

### Non-goals for initial v2
- Guaranteeing protection against a physically compromised running machine or malicious kernel.
- Secure multi-tenant GPU sharing against all hostile workloads without dedicated hardware/isolation review.
- Automatic Kubernetes deployment on every personal server.
- Guaranteeing CUDA on AMD/Intel hardware; those require distinct backends.
- Replacing all TypeScript, mobile UI, or infrastructure simultaneously.

### Adversaries
Compromised Flagship control plane; malicious relay/tunnel operator; intercepted/replayed network traffic; hostile or compromised user-hosted apps; malicious generated code and prompt injection; supply-chain compromise; stolen phone; lost recovery material; physical theft of powered-off server; compromised boot media; malicious firmware/kernel; cross-container attack; GPU driver vulnerabilities; future quantum-capable attacker.

### Assurance tiers
- **Standard:** disk encryption, remote owner approval, app sandboxing; boot identity based on provisioned keys; no verified boot-state claim.
- **Verified:** TPM2 + measured boot + hardware-bound attestation, secure update and rollback protection; subject to platform compatibility and attestation validation.
- **High isolation:** dedicated VMs or dedicated GPU/device assignment for hostile workloads, where hardware supports it.

## 4. Component architecture and trust boundaries

```
Phone (owner root / hardware-backed keys)
    | signed, freshness-bound authorization
    v
Control plane (routing, enrollment, policy metadata; ciphertext only)
    |                         Tunnel relay (opaque TCP)
    v                               |
User server: early boot agent <-----+
    | measured-boot verification + session-bound encrypted unlock secret
    v
LUKS encrypted host + Rust privileged broker
    |        |                 |
    |        |                 +-- GPU device broker -> CDI / NVIDIA runtime
    |        +-- app scheduler -> OCI runtime -> isolated workloads
    +-- network ingress -> app service routing, per-app identity
```

**Trust boundaries:** phone vs control plane; control plane vs server; early boot vs running host; privileged broker vs app workloads; app vs app; app vs GPU kernel/driver; AI harness vs generated code; update signer vs execution environment. Explicitly document what each boundary cannot protect against.

### Proposed modules
- `flagship-boot` (Rust): minimal initramfs client, enrollment, attestation, session-bound secret intake, unlock; no application scheduler.
- `flagship-core` (Rust): daemon, local identity, policy, service lifecycle, reconciliation.
- `flagship-broker` (Rust, narrow privilege): privileged operations through authenticated Unix socket; never exposes arbitrary host shell.
- `flagship-runtime` (Rust): OCI lifecycle adapter (containerd or Podman), app manifests, quotas, health and restart policies.
- `flagship-gpu` (Rust): inventory, authorization, allocation and CDI device mapping.
- `flagship-crypto` (Rust): versioned envelopes, signatures, key agreement; audited cryptographic implementations, not homemade primitives.
- `flagship-sdk`: language-neutral OpenAPI/JSON Schema and gRPC/protobuf where appropriate; Rust, TS, Python SDKs first.
- Existing Cloudflare/TypeScript control plane, web UI, Studio, native mobile shells retained and incrementally integrated.

## 5. Secure boot and disk unlock protocol

### Principle
A remote unlock secret must eventually reach a legitimate server boot environment (or an equivalent authorized key-release mechanism), but **need not be exposed to the control plane**. End-to-end encryption alone does **not** authenticate boot integrity.

### Proposed flow
1. On provisioning, owner phone binds a device identity, approved boot policy, and recovery plan to a server; enroll TPM attestation key/approved measurements if supported.
2. Early boot starts a minimal verified initramfs with no user applications. It generates a fresh ephemeral key exchange context and one-time boot nonce.
3. Boot request includes device identity, nonce, protocol version, ephemeral public keys, expiration, and (verified tier) signed TPM quote binding the challenge, keys, and measured boot state.
4. Phone validates enrolled identity, freshness, signature/attestation chain, approved measurements, policy version, and displayed user action. **A mere signed ephemeral key is insufficient if the signing key is accessible to a compromised boot environment.**
5. Phone derives an encryption key through a reviewed hybrid X25519 + ML-KEM-768 protocol, with transcript binding and domain-separated KDF, and sends a session-bound authenticated ciphertext containing a **LUKS keyslot unlock credential** (not necessarily the volume master key).
6. Control plane relays only ciphertext; early boot decrypts in memory, unlocks the volume, clears avoidable temporary copies, and reports boot success through an authenticated channel.
7. Replay is prevented through nonce, expiration, per-device monotonic state where feasible, and anti-downgrade policies. Log only metadata, never secret material.
8. On failure: rate-limit, allow safe retry, retain recovery mode, never brick device after partial update.

### Critical decisions
- Exact LUKS keyslot design; TPM2 policy binding vs phone-only release vs optional unattended reboot.
- Which hardware can provide meaningful attestation; TPM quotes do not automatically guarantee a safe runtime after unlock.
- Secure Boot signing chain and measured boot implementation on Alpine/target hardware.
- Phone-offline and lost-phone recovery, multiple authorized owners, emergency unlock, server restore.
- How to rotate secrets without requiring destructive re-encryption of all disks.

## 6. Post-quantum and cryptographic agility

**Baseline:** retain AES-256-class symmetric protection, strong KDFs, Argon2id for passwords where relevant, LUKS2; focus PQ migration on public-key exchange and signatures. NIST standards: FIPS 203 ML-KEM; FIPS 204 ML-DSA; FIPS 205 SLH-DSA. Sources: https://csrc.nist.gov/pubs/fips/203/final and https://csrc.nist.gov/pubs/fips/204/final .

- **Key exchange:** reviewed hybrid X25519 + ML-KEM-768 construction, never concatenate shared secrets ad hoc without a vetted combiner and transcript binding.
- **Identity:** plan hybrid Ed25519 + ML-DSA-65 signatures for security-critical operations. Mobile Secure Enclave/Keystore may not support PQ signing natively; model key custody, backup and compromise carefully.
- **TLS:** use modern TLS stack with hybrid PQ key agreement where interoperable; certificate signatures and browser support remain separate migration tracks. Existing browsers may negotiate classical suites.
- **Data envelopes:** include protocol version, algorithm suite, key IDs, ciphertext metadata, authentication context, anti-replay properties and authenticated migration flags.
- **Migration:** new keys, rewrap historical sealed secrets, handle historical captured sessions honestly (cannot retroactively protect them), revoke old keys, test mixed versions, reject downgrade after cutover.
- **Cryptographic agility:** no unversioned crypto or silently permissive fallback; use external audit, published test vectors, fuzz/property testing.

## 7. Polyglot app model

**Design rule:** Flagship runs artifacts, not programming languages. Any language capable of producing a Linux container image is supported: Rust, Go, Python, Node/TypeScript, Java/Kotlin, C/C++, C#, Ruby, PHP, Elixir, Julia, R, etc. WebAssembly/WASI can be an additional lightweight sandbox, not a replacement for OCI.

### App deployment contract
- OCI image by immutable digest, optional reproducible build from Dockerfile or Buildpacks; SBOM and signature/attestation when available.
- Declarative `flagship.yaml`: app ID/version, image/build, ports, health checks, CPU/RAM/disk, volumes, network policy, secret references, GPU needs, capabilities, restart/update policy.
- API gateway maps `<service>.<server>.<user>.flagship.services` to private app endpoints without leaking host network access.
- Per-app identity, secret scoping, filesystem isolation, network egress policy, lifecycle logging, audit trail.
- App store and local/third-party images use the same policy enforcement; signed marketplace metadata is not equivalent to safe code.

### Secure defaults
Rootless where possible; no privileged containers; drop Linux capabilities; seccomp, AppArmor/SELinux as supported; user namespaces; read-only root FS; immutable images; tmpfs scratch; explicit persistent volumes; no host PID/network/mount namespace; no Docker socket mounts; no host device mounts except broker-authorized CDI devices; resource quotas; per-app firewall and egress policies; image scanning and provenance; prompt injection treated as untrusted content.

**Isolation tiers:** normal trusted apps = rootless OCI; untrusted third-party/generated apps = stronger seccomp and preferably VM-based sandbox (Kata/Firecracker or equivalent where supported); GPU apps = separate explicit device-access tier with stronger warnings, and dedicated VM/device for high-risk code. A container is not a hard security boundary against a compromised host kernel.

## 8. Orchestration architecture

**Initial choice:** single-node reconciliation controller + OCI runtime, not Kubernetes as a mandatory dependency. Evaluate containerd vs Podman empirically for rootless operation, GPU/CDI, health checks, restart semantics, networking, and image security. A small Rust supervisor owns desired state; runtime owns container lifecycle.

Desired state: apps, image digest, policy, secrets refs, network endpoints, volumes, resources, GPU claims, health and update strategy. Reconciler creates/updates/stops workloads idempotently, records events and crash loops, and rolls back failed app releases. Keep core platform upgrades separate from app upgrades.

**Optional future cluster:** k3s or another conformant scheduler only for multi-node installations. Do not invent a second incompatible application manifest; translate Flagship's declarative API to local runtime or Kubernetes resources. Multi-node data consistency, storage, networking and trust need separate design.

## 9. GPU/CUDA and graphics support

### Scope
1. **AI harness:** GPU inference and optional fine-tuning/training workers; CPU fallback.
2. **Generated/user apps:** explicit GPU request for CUDA workloads, PyTorch, JAX, llama.cpp, custom kernels, rendering, video transcoding and supported graphics pipelines.
3. **Graphics:** support headless EGL/Vulkan/OpenGL and video encode/decode where host/driver allow. Remote desktop/game-streaming requires separate display, input, codec, latency, authentication and streaming design; CUDA alone does not provide interactive graphics.

### Implementation
- Detect vendor, model, driver/runtime compatibility, GPU UUID, VRAM, compute capability, MIG capability, and supported graphics features.
- For NVIDIA, install supported host driver and NVIDIA Container Toolkit; use **Container Device Interface (CDI)** to pass explicit GPU or MIG device IDs to OCI containers. Do not grant `/dev` wholesale. Source: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/cdi-support.html .
- Provide curated, pinned CUDA base images and per-app compatibility validation. Container CUDA user-space must be compatible with the host driver. Do not silently upgrade host drivers during app installation.
- Schedule based on GPU capability and available VRAM; enforce app quotas for CPU/RAM/storage and GPU allocation; document that VRAM quotas and secure GPU sharing cannot be guaranteed on all consumer cards.
- MVP: exclusive GPU assignment to one untrusted workload at a time; queue others. Later: supported MIG partitions or controlled time-sharing for trusted workloads, with explicit isolation limits.
- Distinguish **host system GPU**, **harness GPU**, and **app GPU**; all allocations pass through the same broker and policy engine. Reserve headroom for host UI and recovery where appropriate.
- NVIDIA/CUDA first; AMD ROCm and Intel Level Zero/oneAPI through separate backends later; no CUDA compatibility promise for non-NVIDIA GPUs.
- Guard against GPU driver escape and denial of service: patch cadence, signed drivers, constrained device injection, crash isolation, admission controls, health resets, and optional dedicated GPU/VM for high-risk workloads.

NVIDIA docs: https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/cdi.html ; https://github.com/NVIDIA/k8s-device-plugin .

## 10. AI harness and generated-app security

- Separate **planner/model process**, **tool broker**, **builder**, **test runner**, and **deployed app**. Generated code is never executed with harness credentials or host privileges.
- Harness tools use short-lived scoped capabilities, explicit user approvals for destructive actions and network/data exfiltration-sensitive actions.
- Build in ephemeral sandbox with network off by default; dependency fetching through controlled mirror/allowlist; produce signed/pinned artifact and SBOM.
- Automated checks: static analysis, dependency scanning, secret scanning, policy linting, unit tests, runtime smoke tests, fuzzing for security-sensitive components.
- GPU harness and GPU app may use the same physical GPU only under brokered allocation; no implicit sharing of model caches, host paths, credentials or CUDA IPC handles.
- Support BYOK models and local inference; isolate provider credentials; prevent prompt-injected application content from becoming privileged instructions.
- Record auditable provenance from prompt/spec -> source -> build -> test -> image digest -> approval -> deployment; protect privacy of prompts and source code.

## 11. Network, DNS, TLS, identity

Retain raw-TCP SNI passthrough and user-server TLS termination if validated; add per-service authorization, explicit port publication and rate limits. Define wildcard DNS behavior and certificate issuance/renewal limits; assess scalable cert strategy without claiming wildcard DNS covers arbitrary multi-level labels. App-to-app communications use service identities, ACLs and encrypted transport where necessary. Keep certificate lifecycle distinct from phone-held device identity. Provide private-only apps, public apps, and owner-only apps as explicit modes.

## 12. Storage, backup, recovery

- App data lives in dedicated per-app volumes under encrypted storage; explicit backup/restore contract.
- Snapshot support where filesystem permits; encrypted off-host backups with separately recoverable keys; test disaster restore to different hardware.
- LUKS credential rotation and recovery path for lost phone, TPM replacement, dead motherboard, forgotten PIN, corrupted updates.
- Zero-knowledge recovery means platform cannot rescue users who lose every recovery credential; communicate this plainly and provide multiple authorized devices/offline recovery codes or threshold recovery options.
- Ensure volumes are never accidentally mounted into build sandboxes or unrelated apps.

## 13. Update, supply chain, and operations

- Reproducible/pinned builds; signed release manifests; independent trust anchors; threshold release signing where practical; secure boot integration; measured rollouts; rollback protection without bricking.
- Installer must verify scripts/assets cryptographically, including fetched content at pinned revisions; no unauthenticated remote shell scripts in trusted path.
- Versioned protocol migration and backwards compatibility matrix; encrypted state migrations; rollback-safe disk layouts.
- Observability: local-only by default for content-sensitive logs; opt-in anonymized telemetry; security event audit, health dashboards, performance and GPU utilization.
- Continuous threat modeling, fuzzing, dependency updates, container escape testing, penetration tests and independent crypto review.

## 14. Phased implementation plan and acceptance gates

### P0 — Baseline & decisions (1–3 weeks estimate)
Deliver: architecture decision records (ADRs), code inventory, key-flow diagrams, existing runtime audit, threat model, hardware matrix, app deployment and GPU proof-of-concept criteria.
**Exit:** verify whether control plane ever handles plaintext unlock keys; identify boot trust assumptions; inventory current app execution and dependencies.

### P1 — Security protocol & recovery (3–6 weeks)
Implement versioned crypto envelopes and authenticated boot session design; build threat-model test suite; prototype end-to-end encrypted unlock and lost-phone recovery; verify TPM and no-TPM tiers.
**Exit:** control-plane compromise test cannot reveal unlock credential; replay/downgrade fail closed; recovery demo works.

### P2 — Rust core and runtime (4–8 weeks)
Build Rust boot agent, privileged broker, daemon/supervisor adapters, migration shims; OCI runtime integration, per-app policy, network/volume lifecycle.
**Exit:** existing user server and app paths work; privilege/escape tests; upgrade and rollback demonstrated.

### P3 — Universal app platform (3–6 weeks)
Manifest schema, SDKs, Buildpacks/Dockerfile pipeline, signed images, language sample apps, private/public routing, backups and quotas.
**Exit:** Rust, Python, Node, Go, Java, C++ and .NET example apps deploy from source and OCI image without host privileges.

### P4 — GPU and AI harness (4–8 weeks)
NVIDIA detection and CDI broker, CUDA image templates, GPU inference/training/graphics smoke tests, harness sandbox and GPU scheduling; CPU fallback.
**Exit:** `nvidia-smi` and CUDA/PyTorch tests inside a scoped container; non-GPU server still works; unauthorized app cannot request GPU; competing jobs queue safely.

### P5 — PQ migration, production hardening (4–10 weeks)
Hybrid key exchange, hybrid identity rollout where feasible, TLS negotiation, historical blob rewrapping, signed updates, external review and fault-injection exercises.
**Exit:** test vectors and cross-version migration pass; no downgrade; key recovery; audit findings resolved before claims of quantum-safe operation.

*Estimates are directional engineering windows, not commitments; workstreams overlap. Prioritize security proof and working vertical slices over rewrite volume.*

## 15. Project epics / suggested GitHub issues

- **E01** Audit trust boundaries and plaintext key paths [P0, blocker]
- **E02** Boot attestation and assurance-tier policy [P0/P1, blocker]
- **E03** Zero-knowledge boot-key relay [P1, blocker]
- **E04** Recovery, phone loss, server replacement [P1, blocker]
- **E05** Versioned cryptographic protocol / hybrid PQ exchange [P1/P5]
- **E06** Rust boot agent + narrow privileged broker [P2]
- **E07** Rust daemon and OCI runtime adapter [P2]
- **E08** App manifest v1 and polyglot build pipeline [P3]
- **E09** Container security policies / isolation tiers [P2/P3, blocker]
- **E10** App storage, backup and network routing [P3]
- **E11** GPU inventory, CDI and CUDA runtime [P4]
- **E12** GPU admission, scheduling and graphics workloads [P4]
- **E13** AI harness tool/build/deploy isolation [P4]
- **E14** Signed releases, secure updates, rollback protection [P2/P5]
- **E15** External security review and adversarial tests [P5]
- **E16** Optional multi-node architecture ADR [later]

## 16. Open questions and decisions register

| ID | Open question | Proposed default | Consequence / evidence needed |
|---|---|---|---|
| OQ-01 | Does current control plane ever receive plaintext unlock material? | Assume unknown until traced | Inspect boot/key paths and packet/log tests |
| OQ-02 | Is TPM2/Secure Boot mandatory? | No; explicit Verified tier | Commodity hardware reach vs assurance |
| OQ-03 | Must reboot work without phone? | Owner-selectable unattended mode | Threat model for unattended key release |
| OQ-04 | What happens if phone is lost? | Multiple authorized devices + offline recovery | Recovery ceremony and threat model |
| OQ-05 | Which Linux base/initramfs? | Keep Alpine initially | Driver, secure boot and OCI compatibility |
| OQ-06 | containerd or Podman? | Benchmark before ADR | Rootless, CDI, API, ops, footprint |
| OQ-07 | VM isolation for generated apps by default? | Strong sandbox when supported | CPU/RAM cost, hardware virtualization |
| OQ-08 | Who may deploy public apps? | Owner approval + policy | Exposure and abuse prevention |
| OQ-09 | Which GPU classes? | NVIDIA Linux x86_64 first | Driver/CUDA support matrix |
| OQ-10 | GPU sharing policy? | Exclusive assignment initially | Security, VRAM, throughput |
| OQ-11 | Graphics target? | Headless EGL/Vulkan/encode first | Remote display needs separate protocol |
| OQ-12 | AI harness location? | Local by default, cloud optional | Privacy, cost, CPU/GPU capability |
| OQ-13 | Can AI-generated apps access LAN? | Deny by default | SSRF/exfiltration and IoT risk |
| OQ-14 | Should clusters be supported in v2? | Defer; single-node first | Scope and complexity |
| OQ-15 | PQ key custody on phones? | Hardware-bound classical + software PQ protected by hardware key | Platform crypto APIs, security review |
| OQ-16 | Certificate strategy and wildcard DNS? | Retain existing SNI TLS until tested | ACME limits and browser compatibility |
| OQ-17 | What are minimum supported host specs? | Define tiered requirements | Old laptop viability |
| OQ-18 | Can apps install host drivers? | Never directly | Host stability and trust |
| OQ-19 | How are apps monetized/licensed? | Out of security core | Marketplace and licensing design |
| OQ-20 | Is cross-app GPU isolation sufficient? | Do not claim hard isolation | Vendor/hardware/driver threat model |
| OQ-21 | What is source of truth for server config? | Signed desired-state policy with local cache | Offline operation and reconciliation |
| OQ-22 | What is update signing root and revocation scheme? | Offline root, rotating release keys | Compromise and recovery drills |

## 17. Definition of done for v2

A clean install on CPU-only commodity hardware can be enrolled, remotely unlocked, recovered and updated without disclosing unlock material to Flagship services; apps in multiple languages deploy from OCI images with least privilege, persistent encrypted volumes and reliable routing; GPU-capable hardware can run owner-approved CUDA and AI workloads through a broker without raw host access; all privileged boundaries and key lifecycle operations are tested; external security review is completed; documented assurance levels accurately distinguish what the platform does and does not protect.

## 18. Immediate next actions

1. Read `AGENTS.md`, `CLAUDE.md`, boot/install scripts, daemon, crypto/protocol, service runner, tunnel and AI harness code. Produce an evidence-backed current-state map, distinguishing observed implementation from documentation.
2. Write ADR-001 (Rust/TypeScript boundaries), ADR-002 (unlock + attestation), ADR-003 (OCI runtime), ADR-004 (GPU/CDI), ADR-005 (PQ algorithms), ADR-006 (app sandbox tiers), ADR-007 (recovery).
3. Build one vertical slice: phone-authorized encrypted unlock -> Rust broker -> isolated Rust/Python OCI apps -> GPU CUDA test when hardware available.
4. Run adversarial tests before migrating existing users or changing marketing claims.

## References
- Flagship repository: https://github.com/ibisllc/flagship
- NIST ML-KEM: https://csrc.nist.gov/pubs/fips/203/final
- NIST ML-DSA: https://csrc.nist.gov/pubs/fips/204/final
- NVIDIA CDI: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/cdi-support.html
- NVIDIA GPU Operator CDI: https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/cdi.html
- NVIDIA Kubernetes GPU plugin: https://github.com/NVIDIA/k8s-device-plugin
