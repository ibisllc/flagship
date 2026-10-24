# Milestone 6 drill on UpCloud (2026-10-24)

One throwaway Debian 13 amd64 VM, `arch-drill-m6-a` (UpCloud `de-fra1`, plan `4xCPU-8GB`, 60 GB
MaxIOPS, label `flagship-env=arch-drill`, public IPv4 94.237.30.127), from the plain Debian 13
template through the UpCloud API with the token the gym tooling reads. No gym Worker, no `.com`,
no account. `tools/arch-drills/m6/setup-box.sh` lays the branch's tree out as an installed release
(pinned Node, `npm ci`, `tsc -b`), builds the Go helper (Go 1.26.3, sha256 from go.dev) and the
Rust `flagship-boot` (`--release --locked`), and runs swtpm. `tools/arch-drills/m6/drill.ts` runs
the phases. Tree: `feat/architecture` at `16ff84fe0` plus the fixes below (`a84cba032`, `068bb2773`
and the load-flush commit).

UpCloud offers no vTPM. swtpm runs behind the kernel's vTPM proxy (`tpm_vtpm_proxy`), so the box
sees `/dev/tpmrm0` with the kernel resource manager, the path it uses on metal. The stand-in for a
measured boot is PCR 7 extended by the drill (swtpm measures nothing itself).

What is real: the generated premount under `/bin/sh`, the Go helper and the Rust compat CLI as its
drop-in, cryptsetup opening a LUKS2 loop volume (an ext4 file inside is read back), curl over TLS,
tpm2-tools, the box's `bootPq.ts` sealing, the boot worker router (`packages/boot-core`) behind a
local HTTPS server. The phone is scripted with the protocol's own TS checks and seals
(`verifyBootPq`, `verifySecretRequestV2`, `buildBootReplyV2`, `sealLeaseV3`). Stubbed: curl's DNS
(`--connect-to` the local worker), `blkid` (names the loop device; the VM root is not LUKS),
`mount` of the FLAGSHIP_BOOT label, and `reboot`. This is not an initramfs boot.

## Result: 24 of 24 before the reboot, 3 of 3 after it

- setup: LUKS2 loop volume ready; `/dev/tpmrm0` is swtpm (manufacturer IBM); PCR 7 carries the
  stand-in measurement.
- relay with the Go helper, then the Rust helper (strict): the daemon sealed the lease key to the
  TPM (`sha256:7`); the request was hybrid-signed; the hybrid reply opened the real volume; the
  per-boot reply key is gone after its one open; no key seed or disk key on any helper argv.
- downgrade (strict): a classical-only reply is refused (`boot-unlock-v2: strict-refuses-v1`); the
  disk stays shut and the box restarts to ask again.
- compatibility: an old phone's classical reply still opens.
- TPM lease (strict, auto): the v3 lease opened with the lease key the TPM released; the phone was
  not asked.
- v1 lease (strict): refused; the box asked the phone and opened with the hybrid reply.
- PCR mismatch: PCR 7 extended again (a changed boot chain): the TPM refuses the lease key; the box
  falls back to the phone, which opens it; after that approved boot the daemon reseals the same
  seed under the new chain; the same lease opens again from the TPM with no phone.
- after a real VM reboot (swtpm state on disk, PCRs reset and re-measured): swtpm came back; the
  lease key still came from the TPM (Rust helper this time), no phone; a changed chain still falls
  back to the phone.

The before-reboot phase was re-run after the last fix (24/24). The after-reboot phase passed with a
real reboot before the load-flush fix; re-running it without a reboot is not meaningful (the PCRs
would be extended twice), so it was not repeated.

## What the drill found and fixed

1. **TPM slots fill up without a resource manager.** Over a raw `/dev/tpm0` (and swtpm's socket),
   tpm2-tools leave the primary, loaded objects and policy sessions in the TPM; the second seal
   failed with "out of memory for object contexts" and then "session contexts". The daemon, the
   Rust boot client and the premount now flush transient objects and loaded and saved sessions
   after every sequence, and between `tpm2_load` and `tpm2_unseal`; the hook stages
   `tpm2_flushcontext`. Behind `/dev/tpmrm0` this is harmless.
2. The drill's own swtpm wiring moved to the vTPM proxy so the box path is the metal one.

## Gates run on the box

- `npx tsc -b`: ok. `go test ./...` (unseal helper): ok.
- `cargo fmt --check`, `cargo clippy --workspace --all-targets --locked -D warnings`: ok.
  `cargo test --workspace --locked`: one failure, the keyd conformance test (the Rust op list put
  `sign.identity` before `sign.hybrid`; fixed, keyd 25/25 and flagship-boot all green on the box
  after). `cargo deny check`: the box's cargo-deny 0.18.3 cannot parse CVSS 4 advisories; run on the
  Mac with the repo's cargo-deny: advisories, bans, licenses, sources ok.
- Full vitest: 12,447 passed, 19 failed. Fixed after: `schemaStatus` (0114 missing from
  KNOWN_MIGRATIONS), `release.test.ts` pending-migration count (0114), the swtpm socket test (the
  load flush above). The rest are the drill tree, not the code: no `.git` in the uploaded tree
  (`release.test.ts` five cases, `release-manifest.test.ts` two, `updateServer.test.ts` git bundle),
  `check-versions.test.ts` and `cronBudget.test.ts` (both pass on the Mac with the full tree),
  `boxArtifact.test.ts` (tar ownership expectation in the root-run VM). Not re-run after the fixes.

## Not covered

A real initramfs boot (first boot, reboot, Wi-Fi), metal or a real TPM (the Windows drill in
`docs/runbooks/device-test-agent.md`), arm64, a phone (iOS/Android ran their unit and vector tests
only), a `.com` or gym, an existing box's premount migration (none exists), a TPM quote.

## Teardown and spend

The coordinator asked to leave the VM running: `arch-drill-m6-a` (uuid
`001bf672-ccde-4d73-bd1a-ddd2918bd412`, 94.237.30.127) is **still up** at the time of writing,
created 2026-10-24 17:18 UTC (about €0.06 an hour for `4xCPU-8GB`). Delete it with
`DELETE /1.3/server/001bf672-ccde-4d73-bd1a-ddd2918bd412?storages=1` after stopping it.
`flagship-demo-playstore-test-0725-…` was not touched.
