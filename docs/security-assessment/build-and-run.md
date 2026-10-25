# Building and running everything

All commands run from the repository root unless a directory is named. The source of truth for these
gates is `docs/architecture-v2/HANDOVER.md` §4.6 and `docs/runbooks/release-readiness.md`.

## 1. Toolchains

- Node 24 (the box's floor is in `release/box-artifact-trust.json` `nodeFloor`), `npm ci`.
- Rust 1.99.1 from `rust/rust-toolchain.toml` (on the maintainers' Mac:
  `PATH=/opt/homebrew/opt/rustup/bin:$PATH`); `cargo-deny`.
- Go (the `installer/tls-frontend` and `installer/unseal-helper` modules).
- Xcode 27.1 (`/Applications/Xcode-27.1.0-Release.Candidate.app`) for iOS; JDK 17 for Android
  (`JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`).
- For the live gym: the gym secrets file `.gym-secrets.env` (`GYM_ADMIN_SECRET`, `GYM_DEMO_IRK_KEK`)
  and an UpCloud token in `~/.config/flagship/upcloud-token`. The release manager provides both.

## 2. Unit, property and vector tests

```sh
npx tsc -b                                         # the whole TS tree
npx vitest run                                     # everything (~12,000 tests; slow on a loaded laptop)
npx vitest run tools/adversarial/tests             # the V01 adversarial suite only (adversarial-tests.md)
node scripts/crypto-graph-check.mjs                # the classical-bypass graph (exits 1 today: known-gaps.md §1)
node scripts/crypto-graph-check.mjs --json         # every path
npm run parity                                     # cross-client parity matrix
(cd rust && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test && cargo deny check)
(cd installer/tls-frontend && go test ./...) ; (cd installer/unseal-helper && go test ./...)
(cd apps/mobile/shared && swift test) ; (cd apps/mobile/ios && swift test)
(cd apps/mobile/android && ./gradlew :app:testDebugUnitTest)
```

Shared vectors live in `packages/protocol/test-vectors/<family>/`. Each family has a generator
under `tools/*-vectors.*` with `--check`. Every port (TS, Rust, Swift, Kotlin, webapp JS, and Go
where listed) reads the same files.

## 3. The full suite on a throwaway VM

```sh
bash scripts/full-test-vm.sh [--commit <sha>] [--keep]
```

This creates a Debian 13 UpCloud VM (8 vCPU / 32 GB, label `flagship-env=release-test`) and runs, at
one commit: tsc, the full vitest, cargo fmt/clippy/test/deny, the Go tests, the crypto-graph check,
and the keyd TS↔Rust cross-check (Linux only). It deletes the VM afterwards, also on failure, and
writes results to `gym-results/full-test-<stamp>/`. This is the reference environment for test
results. The maintainers' laptop is too loaded for hook-heavy suites.

## 4. The live gym (real boxes, real relay, a separate `.com`)

The gym is a copy of production: the `flagship-com-gym` Worker with its own D1, a gym Fly relay, and
UpCloud boxes built from the `gym` branch (main + the gym trust pin).

```sh
bash scripts/gym-release-run.sh                      # refresh, take the gym lock, every group on both stacks
bash scripts/gym-release-run.sh --groups adversarial,canary --skip-refresh
npx tsx tools/live-e2e/shared-run.ts --list          # the groups
```

- The script runs two passes: `arch-v2` (Podman and the Rust path, as new boxes are built) and
  `classic` (Docker and TS keyd, as existing boxes run).
- Exit codes: 0 means both passes are green; 3 means something was skipped (not proven); 5 means
  classic is green but arch-v2 is not; anything else is a failure.
- Groups relevant to this assessment:
  - `adversarial` (AT-LIVE-01..19): forged orders, cross-account keys, central authorization,
    ambiguous paths, identity headers, app egress, stream tickets, certificate names, SNI fronting,
    update replay, arch-v2 effective state.
  - `canary`: receipts counted once, extra fields refused, owner-only switch.
  - `update`: endorsed update, apply and rollback.
  - `gating`, `invites`, `enforcement`, `share`, `first-contact`, `app-names`, `chat-cross-owner`,
    `passkey-recovery`, `release-catalog`.
- The runner tears its fleet down at the end (`/api/gym/teardown`). Never pass `--keep` for a full
  run.
- A box's daemon log for an account the run created:
  `npx tsx tools/live-e2e/journal-cli.ts <demo-user> home 2000 <regex>`.

## 5. Privileged and hardware drills

- `docs/architecture-v2/drills/m5-upcloud.md`: the Rust path, broker, Podman move, LUKS reencrypt
  and power cut (57/57 on Debian 13 amd64).
- `docs/architecture-v2/drills/m6-upcloud.md`: boot unlock v2 with swtpm, before and after a real
  reboot.
- `docs/runbooks/device-test-agent.md`: the metal and device runs (TPM on a Windows PC by native
  USB boot, iOS 26 Secure Enclave ML-DSA, Android StrongBox, a real box's boot unlock v2).
  **None has a receipt yet** (`known-gaps.md` §2).
- `docs/runbooks/security-incident-drills.md`: release-key loss, malicious CI, backup deletion,
  cloud outage.

## 6. Reproducing a finding

Put the test that shows it under `tools/adversarial/tests/` (vitest) or as a `rec.check` in a gym
group (`tools/live-e2e/groups/`). Name the test with an ID (`AT-<AREA>-<nn>`) and the boundary.
While the defect stands, keep it as `it.fails(...)` with a `// FINDING` comment. Turn it into a
plain `it` with the fix. `issue-template.md` says how to tie it to the commit.
