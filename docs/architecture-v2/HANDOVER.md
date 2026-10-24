# Architecture v2: handover, merge guide and acceptance checklist

Written 2026-10-24 by the architecture session when the owner handed the work to the release
manager (the "flagship Security" session). **Owner rule (2026-10-24): every work package in
`IMPLEMENTATION-PLAN.md` §13.1 ships in this release, including the ones no milestone below
covered.** Nothing is dropped by being left out of a milestone. `REGISTER.md` is the per-package
record (status, blockers, evidence); this file is the summary, the merge guide and the list the
owner will audit the merged release against.

## 1. Branch facts

- Branch `feat/architecture`, forked from `release/0.3` at `386e29c84`. Pushed to `origin` up to
  the gap fixes (`9950d73ed`); later commits (milestone 6) need a push.
- `release/0.3` has moved since: `21e1b7120` "0.3 security hardening: implement
  SECURITY-HARDENING-PLAN.md" (634 files). About 475 files are changed on both sides
  (server-daemon 134, apps/mobile 100, apps/web 45, protocol 32, flagship-builder 24, keyd 20,
  control-plane 16, privd 10, box-artifact 9, storage 9).
- Rust workspace `rust/` (toolchain 1.99.1, `unsafe_code` forbidden, `cargo deny`): crates
  flagship-protocol, -crypto, -keyd, -broker, -runtime, -core, -boot, -ingress, -relay, -gpu, -wasi.

## 2. What was delivered, by milestone

"Verified" below means tests on a Mac or a throwaway UpCloud Debian 13 VM. **Nothing has run on a
real phone, a real box, or the gym. Nothing is externally reviewed; every PQ claim stays "pending
external review".**

**M0: foundations and the first fixes.** A04 Cargo workspace and CI (`.github/workflows/rust.yml`);
A01 evidence map and `crypto-graph.json`; C01 assurance policy core
(`packages/protocol/src/assurancePolicy.ts`, vectors); manifest v2 (`manifestV2.ts`: accelerator,
resources, health, restart, isolation, WASI runtime, components); keyd v1 in Rust (K01),
ingress (I01), crypto/protocol (Q02), boot client (BO01), relay (N01/N02), broker/runtime/core
(B01/R01/R02), gpu/wasi library crates. Bug fixes: relay crashes, reconnect race, drain-v1,
bounded buffering, SNI reassembly; boot-only key (D1 0110) and premount hardening; per-box LUKS
reencrypt on appliances; TOFU box-key pins on all clients; keyd purpose list; re-pair journal key.

**M1: PQ identity.** `flagship/pq-key-binding/v1` (mutual proof of possession, ML-DSA-65 to
Ed25519); `verifyCriticalSignature` gate (TS `pqTrust.ts`, Rust `flagship-crypto::trust`); keyd
`identity-mldsa.key`, `pq.status`, `sign.hybrid`; `.com` D1 0111 and
`PUT/GET /api/server/:host/pq-key-binding`; webapp pins the box PQ key (shell v167).

**M2: PQ on devices.** iOS: Secure Enclave ML-DSA on iOS 26+ for device keys ("hardware PQ");
otherwise software ML-DSA sealed by the Secure Enclave ("PQ, hardware-wrapped"), C target
`CFlagshipPQ` (mldsa-native/mlkem-native v2.0.0). Android: SecureRandom seed wrapped by a Keystore
AES-GCM key (StrongBox when present), BouncyCastle 1.86. Webapp verify-only (v168). IRK, admin
root and device bindings stored by `.com`; re-paired IRK rebinding waits for wait/veto. Owner
policy chains stored in D1 0112; box replays them with anti-rollback. Verified: swift 413, Android
2384, vitest per package.

**M3: release chain.** `flagship/release-endorsement/v2` companion (YubiKey Ed25519 + ML-DSA-65);
`scripts/pq-release-key.mjs` ceremony (seed only as age-to-two-YubiKeys + checksummed paper
code); `endorse-release.mjs` signs both; box `verifyStore`, `latest-endorsed-release.mjs`, `.com`
`/api/releases` and `flagship_crypto::release` require both once `RELEASE_PQ_PIN` names a key.
Runbook `docs/runbooks/pq-release-key.md`. Verified: vitest 6199; tested with fake YubiKeys only.

**M4: strict mode and PQ transport.** `flagship/pq-session/v1` (X-Wing + hybrid-signed handshake)
in TS/Rust/Swift/Kotlin with shared vectors (35 refusal cases); `pqChannel.ts`; the strict guard
on the box (session-token requests and access sync only over the PQ channel; browsers only if the
owner allowed them; blocked AI providers refused); hybrid orders (`pqSignature`, D1 0113);
Settings › Quantum-safe protection on iOS/Android (readiness, browser question, per-connector
choice with no default, losses listed before leaving strict); custody labels; PQ seeds erased on
wipe/sign-out/remove; security notices need the PQ half once pinned; rate limits on binding PUTs
and policy POSTs. Webapp view-only (v169). Verified: vitest 9031, swift 421, Android 2390.

**M5: Rust path and engine.** Box switch `/var/lib/flagship/arch-v2.json` (on for new boxes,
absent on existing ones); Rust keyd with TS fallback, broker (host power only so far), core in
shadow mode; each Rust binary runs only if its SHA-256 matches `installer/rust/PINS.json` inside
the signed artifact; fallback after three failed runs; update gate rolls back a regressed Rust
binary. Podman engine with runsc, quotas, egress fence, nft bridge isolation; one-time Docker to
Podman move. Per-app browser choice screens; strict re-entry evidence (vectors); Android
admin-device policy signing (shell v170). Drill `drills/m5-upcloud.md`: 57/57 checks, LUKS
reencrypt clean and after a power cut. Found and fixed: the TS keyd unit could never start under
`MemoryDenyWriteExecute` (now `--jitless`).

**Gaps round (after M5).** Siblings pinned through `pqKeyIds` in the hybrid-signed server order
(unbound sibling refused in strict); hybrid companions for the box artifact and CA leases behind
empty pins (`release/box-artifact-trust.json` `pq`, `CA_LEASE_PQ_PIN`); SWK/CGK/pairing/entitlement
deposits only to the server's own read token; keyd slots fill only from an owner-signed delivery
or a 10-minute boot-ceremony token; `inject/v1` and `identity-header/v1` only in fixed shapes,
invitees Member unless an admin raised them; `POST /api/time` CA-signed time with a persisted floor;
Android CryptoObject session for PQ seeds (no second prompt). Full vitest on a quiet VM: 12,400
pass; the Mac hook timeouts were load (same on `release/0.3`).

**M6: PQ boot unlock and TPM** (commits `f9eb22aec`..`068bb2773`; final report pending at the time
of writing, see `drills/m6-upcloud.md` and REGISTER Q03/BO02). Boot unlock v2: hybrid boot key
(ML-DSA half + X-Wing lease key), per-boot reply key, hybrid-sealed replies and v3 leases
(D1 0114); Go `flagship-unseal` and Rust `flagship-boot` open them and honour the time floor;
premount runs v2 with the lease key sealed to the TPM under PolicyPCR (software fallback when no
TPM; TPM keys are classical, the PQ protection is the hybrid seal around them); iOS and Android
seal v2 replies and v3 leases; phones and webapp need the CA lease PQ half once pinned (shell v171);
keyd signs master only with the owner's evidence for that sign-in key; signing tools produce the
artifact and lease PQ companions; Windows TPM and GPU test notes. Drill: before-reboot half
24/24 on UpCloud `94.237.30.127` (VM left up for the release manager); after-reboot half unconfirmed.

## 3. Not done yet (all required for this release)

Milestone 7 (never started):
- **P04 WASI**: Wasmtime worker under the same manifest/approval/quota/backup contracts;
  infinite-loop, OOM, host-call and cache-isolation tests.
- **P05 app groups and dedicated per-app databases**: start order, transactional upgrade and
  rollback, consistent backup; hostile-database tests.
- **G01–G05 GPU**: probe and signed driver catalog, CDI validation; exclusive claim journal and
  fair queue; NVIDIA CUDA, AMD ROCm, Intel oneAPI with numerical tests; VM passthrough; MIG,
  headless graphics and video; single-server multi-GPU training. Needs real hardware receipts per
  vendor (the owner's Windows machine has an NVIDIA GPU and needs a native USB boot; Studio VMs on
  Windows can't pass the GPU through). AMD, Intel, MIG and multi-GPU hardware is not procured.
- **AI01/AI02**: tool broker isolation, local inference and training through the GPU allocator.

Milestone 8 (never started): **V01** external security assessment package; **V02** canary
runbooks, receipts and monitoring; register close-out with receipts per package.

Partly done, carried by the register: **A02** baselines; **A03** ADR approval; **A04**
reproducible amd64/arm64 builds; **K02** native pin transition on devices; **B01** broker scope
beyond host power; **R02** core handover from TS (single writer); **R03** two-week engine scorecard
and arm64; Podman appliance/ISO; **P02** isolated source builders; **P03** backup/restore
integration; **U01** immutable artifacts and TUF transition; **Q05** PQ pairing and passkey
replacement (WebAuthn is classical-only); **Q06** firmware/TPM/hypervisor qualification (vendor
roots are classical); **Q08** retained-data rekey and backup conversion; **Q09** bypass checker
reports bypasses; **N01/N02** relay PQ interoperability; strict re-entry rekey receipt and
recovery test from clients; age file around the release key is classical (keep it private).

## 4. Merge guide (`feat/architecture` with `release/0.3`)

1. **Finish first.** Owner rule: all objectives in §3 are part of the release. Decide with the
   owner whether to merge now and continue on the merged line, or finish on the branch first.
2. **Merge, don't rebase.** The branch is pushed and other work refers to its shas. Merge
   `origin/release/0.3` into `feat/architecture` (or the reverse), resolve, run the gates, then
   fast-forward the release.
3. **D1 migration numbers collide.** Both sides have `0107_boot_suspensions`, `0108_re_pair_veto`,
   `0109_recovery_record_v2` (identical names; check the contents match). Then:
   release `0110_watch_boot_keys`, `0112_recovery_passkey_key`, `0113_adapter_attestations`;
   branch `0110_server_boot_keys`, `0111_pq_key_bindings`, `0112_assurance_policy_changes`,
   `0113_server_order_pq_signature`, `0114_boot_unlock_v2`. Keep the release's numbers (it may
   already be applied somewhere) and renumber the branch's five to the next free numbers after the
   release's highest, in the same order, updating every reference (`git grep -n "011[0-4]_"`,
   migration drift guard in `scripts/predeploy-com.sh`, tests). Prod's D1 ledger read 0105 on
   2026-10-18; check which numbers the gym has applied before renumbering.
4. **Webapp shell number.** Release is v169, branch v171. Take a number above both for the merge
   result and move `release/compatibility.json` webapp-shell current/minimumSecurity/preferred and
   the tests' pins to match (the compat-matrix test checks it).
5. **Conflict policy.** Where both sides change the same rule, keep the hardening's checks and add
   the PQ/strict checks on top; never let a merge relax either side. Hot spots: boot and premount
   (watch boot keys vs boot-only key v2), keyd purposes and `SWK_HKDF_LABELS` (keep every label
   from both sides in TS `policy.ts`, Rust `policy.rs`, `opaqueKey.ts`), re-pair veto and recovery
   (Q05 vs passkey key), deposits and read tokens, privd vs `flagship-broker`, box artifact
   verifier (`tools/box-artifact`, `release/box-artifact-trust.json`), `parity/allowlist.json`
   (union, one line per entry), `Cargo.lock` (take one side then `cargo metadata`; re-pin with
   `cargo update --precise`), `AGENTS.md` and `REGISTER.md` (union).
6. **Gates after the merge.** `npx tsc -b`; full `npx vitest run` on a quiet machine (this Mac's
   load makes hooks time out; a throwaway UpCloud Debian 13 VM worked); in `rust/` with
   `PATH=/opt/homebrew/opt/rustup/bin:$PATH`: `cargo fmt --check`, `cargo clippy --all-targets -- -D
   warnings`, `cargo test`, `cargo deny check`; Go tests (`installer/tls-frontend`, unseal);
   `rustBackend.test.ts` keyd cross-check (Linux); `swift test` and the FlagshipApp build; Android
   `:app:testDebugUnitTest`; `npm run parity` with no new reds; `node scripts/crypto-graph-check.mjs`;
   every shared vector set under `packages/protocol/test-vectors/` passes in every port.

## 5. Items for `scripts/release.sh` and the checklists

- **D1 migrations:** the branch's five (renumbered per §4.3) after the release's, before the `.com`
  deploy.
- **Deploy order:** D1 migrations → endorsed box release → `.com` (with the webapp shell) → iOS and
  Android store builds → republish VM appliances (amd64 and arm64) and Studio. Boxes must verify
  a format before clients issue it (`release/compatibility.json` receiverFirst).
- **Key ceremonies (owner, on the Mac, real YubiKeys):** `scripts/pq-release-key.mjs init`,
  `paper-backup`, `verify-yubikey`, `pin`; then fill `RELEASE_PQ_PIN`
  (`packages/protocol/src/releasePqPin.ts`, webapp `lib/releasePqPin.js`), the box artifact PQ pin
  (`release/box-artifact-trust.json` `pq`) and `CA_LEASE_PQ_PIN` (`.maintainers/ca-pq/README.md`),
  each with its "require PQ after" cut-over. Until then nothing PQ is enforced on releases,
  artifacts, leases or notices.
- **Endorsement:** the endorsed box release must carry the v2 companion and the Rust `PINS.json`
  hashes; reproducibility across two builders is not yet shown.
- **Secrets:** none new found beyond the existing ones; `/api/time` signs with the CA lease key.
- **New-box switch:** `arch-v2.json` on for new boxes means Podman and the Rust keyd ship to every
  new box; existing boxes stay on Docker and TS keyd until they move.
- **Labels and claims:** "hardware PQ" only for Secure Enclave ML-DSA; "PQ, hardware-wrapped"
  otherwise; every PQ claim "pending external review".
- **Hardware receipts the owner must run:** every device before release; TPM unlock on the Windows
  machine by native USB boot; NVIDIA GPU there by native USB boot; iOS 26 Secure Enclave ML-DSA on a
  real iPhone; Android StrongBox; a real box's boot unlock v2.
- **Cleanup:** tear down UpCloud `94.237.30.127` (m6 drill) once its after-reboot half is done or
  dropped; confirm only `playstore-test-0725` remains.

## 6. Acceptance checklist (what the owner's audit will check after the merge)

For each item: present on the release branch, tests passing there, and listed in REGISTER with
evidence or an explicit owner-approved blocker.

1. Every §13.1 row (A01–A04, K01–K02, I01, B01, R01–R03, U01, BO01–BO02, P01–P05, G01–G05,
   AI01–AI02, Q01–Q09, N01–N02, V01–V02, C01) is implemented or has an owner decision recorded;
   none silently dropped.
2. All code from M0–M6 and the gaps round is in the release (no file lost in conflict resolution):
   compare `git diff 386e29c84 068bb2773 --stat` paths against the release tree.
3. Migrations renumbered without gaps or duplicates; the drift guard passes; nothing applied
   twice.
4. Every shared vector set passes in every port (TS, Rust, Swift, Kotlin, webapp, Go where listed).
5. Strict-mode guarantees hold on the merged code: classical-only critical signatures refused in
   strict; stripped PQ refused; policy anti-rollback; no silent browser/connector default.
6. Release chain: both signatures required after the pins are filled; ceremony run with real
   YubiKeys; paper backup exists.
7. Hardening rules from `release/0.3` survived the merge unchanged.
8. Labels honest; "pending external review" everywhere a PQ claim appears.
9. Gates in §4.6 green, with the commit they ran on.
10. Owner hardware receipts recorded; drill VMs torn down.
