# Inspectable releases, owner builds and reproducibility (release 0.3, plan G9; Appendix G section 4)

Status 2026-11-01: tooling and box-side decision built and tested; one local reproducibility comparison measured
(section 4). Nothing here is deployed, and no comparison against a CI-built endorsed artifact or between two different
machines has been run.

## 1. What every box release publishes

`tools/box-artifact/build.ts build` writes, per commit and architecture, beside the artifact:

| File | What it is | Bound by |
|---|---|---|
| `flagship-box-<c12>-<arch>.tar.gz` | The release: compiled JS **and its TypeScript sources** (`packages/*/src` next to `dist/`, with source maps where `tsc` emits them), `node_modules` from the lock, the official Node executable, Go and Rust binaries, `BUILD-INFO.json`, `installer/rust/PINS.json` | `artifactSha256` in the signed manifest |
| `….sbom.json` | CycloneDX 1.5 (`sbom.ts`): every npm package with version, SHA-512 from its integrity, purl, and `scope` required/excluded by whether the artifact carries it; every Cargo crate with its registry SHA-256; every Go module from `go.sum`; the Node archive by SHA-256 and official URL. No clock and a name-based serial, so the same inputs give the same bytes | `sbomSha256` in the signed manifest |
| `….provenance.json` | in-toto Statement v1 with a SLSA Provenance v1 predicate (`provenance.ts`): subjects (artifact and SBOM digests), the exact commit, the locks and toolchain pins by SHA-256 (`package-lock.json`, `rust/Cargo.lock`, `rust/rust-toolchain.toml`, both `go.mod`, `release/runtime-lock.json`, `node-pins.json`, the Node archive), the tool versions (node, npm, typescript, go, rustc, cargo), the steps and any flag that changes the output, and the builder | `provenanceSha256` in the signed manifest |
| `….manifest.json` | The manifest signed by the release keys (and the PQ companion), naming all of the above plus Node version/digest and the lock digest | the release signatures |

The release run (`scripts/release.sh`, `box-artifact` step) and the gym (`scripts/gym-box-artifact.sh`) upload every file
in the output folder to R2 next to each other, so the SBOM and provenance are served at
`https://flagshipserver.com/build/iso/<name>.{sbom,provenance}.json` beside the artifact and manifest. The manifest
format did not change (it already carried `sbomSha256` and `provenanceSha256`); the SBOM and provenance contents did.

The provenance names its builder. The release workflow is `https://github.com/<workflow ref>`; anyone else's build is
`https://flagshipserver.com/build/owner-local/v1` (or `--builder-id`). Two builders of the same commit therefore produce
the same artifact digest but different provenance digests: the owner never reuses the endorsed provenance for their own
build and never produces a manifest claiming the release keys.

## 2. Pins a reproducible build depends on

- Source: `git archive <40-hex commit>` (never a branch), `SOURCE_DATE_EPOCH` = the commit time.
- JS: `npm ci --ignore-scripts --os=linux --cpu=<arch>` from the committed lock; the TypeScript compiler pinned exactly
  (`typescript: 5.9.3` in the root `package.json`, `assertCompilerPinned`) and run by path.
- Node: 24.22.1, the official archive by SHA-256 (`node-pins.json`, `release/runtime-lock.json`); also the Node that
  runs the build tools on every builder, with the npm its archive ships (its zlib writes the gzip, its npm lays out
  `node_modules`); `build.ts` refuses another Node or npm (`assertBuildToolchain`), owner builds included.
- Go: **1.26.3** on every builder. Until 2026-11-01 the release workflow took Go from `go.mod`'s `go 1.26.0` line while
  the VM path installed 1.26.3, so the two builders' Go binaries could not have matched; the workflow now names 1.26.3
  and a test keeps it equal to `VM_GO` (`tools/box-artifact/tests/inspectable.test.ts`). `GOTOOLCHAIN=local` in owner builds.
- Rust: `rust/rust-toolchain.toml` (1.99.1), `--locked`, `CARGO_INCREMENTAL=0`, paths remapped, no build id.
- Archive: sorted entries, root owner, normalized modes, fixed mtimes, gzip header zeroed (`tar.ts`).

**Not pinned (unresolved):** the builder's operating system. CI builds on Ubuntu 24.04 runners and the VM path on
Debian 13; the Rust binaries link against the system's C runtime objects and are built with the system linker, so a
CI build and a VM or owner build are expected to differ in `installer/rust/*` until both build inside the same pinned
container image (a `debian:13@sha256:…` build image is the proposed fix; not done). Go is built with `CGO_ENABLED=0`
and is not affected.

## 3. Owner builds

`bash scripts/owner-build.sh --commit <c> --arch <a> --out <dir> [--where local|vm]`

- **Isolated staging, never in place.** `--where local` builds in a fresh folder with its own HOME, TMPDIR, npm and Go
  caches, under `env -i` (PATH, locale and the toolchain homes only), with the commit's own build tools installed from
  its own lock with scripts off. It refuses to run on a Flagship server (`/etc/flagship/daemon.env`, keyd's state or a
  release runtime present): no live keys or data, and nothing it does can change the running installation, so a failed
  build leaves the box as it was. `--where vm` uses the throwaway UpCloud VM (`scripts/box-artifact-vm.sh`; the
  owner's token; amd64). A build on the box itself inside a sandbox is not offered in 0.3.
- **Compare with the endorsement.** It fetches the endorsed manifest for the same commit and architecture and runs
  `tools/box-artifact/compare.ts endorsed`: `matches` only when the local SHA-256 and size equal the signed manifest's
  and that manifest verifies against the pinned release keys (`release/box-artifact-trust.json`). Then the owner's
  build IS the endorsed release and installs through the normal path with the endorsed manifest (same updater, same
  rollback, same phone-authorized update order). `differs` prints both digests.
- **A differing build is the owner's own code.** A box refuses it by default. The installers (`install-box-artifact.sh`,
  `flagship-updater`) accept only a manifest the release keys signed over the measured digest, and the decision
  function `packages/server-daemon/src/localBuildPolicy.ts admitArtifact` returns `local-build-policy-off` for any
  differing artifact unless the box's owner-builds setting is on, which 0.3 has no way to turn on.
- **The owner's policy record (designed, not wired).** `flagship/local-build-policy/v1|<server domain>|<commit>|<arch>|
  <artifact sha256>|<provenance sha256>|<issuedAtMs>|<expiresAtMs>`, signed by the account's admin root, at most 30 days,
  naming one exact build for one server. With the setting on, `admitArtifact` accepts only a record whose signature,
  server, commit, architecture, artifact and provenance digests and time window all match (`basis: owner-local-build`),
  and it is reported as the owner's build, never as an endorsement. Still to do before it can be offered: the setting
  and its admin-signed switch, the phones' signing screen, the installer path that carries the record instead of a
  release manifest, and how a box with an owner build returns to endorsed releases (anti-rollback sequence).

## 4. Reproducibility comparisons

`bash scripts/repro-compare.sh --commit <c> --arch <a> --out <dir> [--no-rust] [--second-where vm | --against <dir>]`
builds A locally and B independently (a second staging folder with a different umask, a VM, or an artifact already in
hand such as the endorsed one), then `compare.ts files` lists every entry that is only in one or differs in content,
mode, type, link or mtime, grouped by area, into `<dir>/report.json`.

Measured:

| Date | Commit, arch | A | B | Result |
|---|---|---|---|---|
| 2026-11-01 | `f0c3bcb8c17e` (release/0.3), amd64, `--no-rust`, PGP check skipped (offline; the archive digest was checked) | this Mac (Darwin arm64, M4): build tools on Node 24.2.0, Go 1.26.3 cross-compiling, official Node 24.22.1 linux-x64 archive | the same Mac, a second staging folder (own HOME, TMPDIR, npm and Go caches, fresh installs), umask 0002 instead of 0022 | **identical**: 79,731,382 bytes, 9,778 entries, SHA-256 `f731cfccf6895cfb94eb75e242c41f4964fdf358c657187e94b1991e16422d0f`; the SBOM and provenance files were identical too |
| 2026-11-02 | `3ee8a991913a` (release/0.3), amd64, `--no-rust` on both sides, full PGP check of SHASUMS256 on both | this Mac (Darwin arm64): build tools on Node 24.2.0 / npm 11.3.0, Go 1.26.3 cross-compiling | a throwaway UpCloud Debian 13 VM (`--second-where vm`, 2xCPU-4GB, de-fra1, labelled `flagship-env=gym`, deleted at the end): Node 24.22.1 / npm 11.19.1, Go 1.26.3 linux/amd64 | **one entry differs**, 9,933 entries each: `flagship/app/node_modules/.package-lock.json` (npm's hidden lockfile; 126,214 vs 89,814 bytes). npm 11.3.0 keeps 71 entries for optional platform packages it did not install (`@esbuild/*` for other platforms); npm 11.19.1 leaves them out; the 203 shared entries are identical and no installed file differs. The SBOMs are byte-identical (`5dd235bb…`); the provenance differs only in the artifact digest and the recorded tool versions. Archives: A `92e1552b…` (80,219,209 bytes), B `e60a2e51…` (81,776,437 bytes; gzip from a different zlib) |

What this does and does not show: the JS half (export, `npm ci` for linux-x64, `tsc`, the bundled Node, the Go
helpers, the archive writer) does not depend on the staging folder, caches, umask or timing on one machine. It used
that commit's own build tools, so the new CycloneDX SBOM and in-toto provenance were not part of it (their bytes are
covered by the determinism tests; the new `build.ts` refuses that commit, as it should, because its `package.json` does
not pin TypeScript exactly). **Not measured:** the Rust binaries (this Mac cannot link for Linux), arm64, two different
machines, CI against the VM, and any owner build against an endorsed artifact. Expected sources of difference across
machines, in order: the build OS for Rust (section 2), the Node that runs the build tools (its zlib writes the gzip:
CI and the VM use 24.22.1; this measurement used 24.2.0 for both A and B, so it says nothing across Node versions), and
the Go version (now pinned). The 2026-11-02 row is the first two-machine measurement (Mac against a Linux VM, `--no-rust` on both:
`box-artifact-vm.sh --no-rust`, so the Mac, which cannot link Rust for Linux, compares like with like). Its one
difference comes from the npm that runs the install, not from the machine: npm's hidden lockfile records what that
npm chose to keep. Both causes are now closed (2026-11-02, after that run): `node_modules/.package-lock.json` (npm's
cache of the tree for its own next run; no npm runs on a box) is left out of every artifact (`assemble.ts`
`skipInApp`), and `build.ts` refuses to build unless the Node running it is `release/runtime-lock.json`'s version
and its npm is the one inside that release's verified official archive (`assertBuildToolchain`; for 24.22.1, npm
11.19.1). CI (`box-artifact.yml`, `node-version: 24.22.1`, setup-node's bundled npm; `runtime-pins.test.ts` keeps it
equal to the lock) and the VM builder (`upcloud-vm.sh`, now from the lock rather than the floor) already met it; an
owner build on a Mac needs Node 24.22.1 installed (this Mac ran 24.2.0 and would now be refused). The npm and Node
versions stay in the provenance's `toolchain`. Still not measured: the Rust binaries across
machines, arm64, and a comparison against the CI-built endorsed artifact (`--against`; no 0.3 artifact is published
yet). Run it with a short `TMPDIR` on macOS (`TMPDIR=/tmp`): under the default `/var/folders/…` path the gpg agent's
socket path is too long and the build stops at "could not import any pinned Node release key".

## 5. Reconciling plan §12.1

§12.1's release unit "packages … retained Node runtime/JS"; Appendix G section 3 wants the owner to get Node from its
official distributor. Both hold: the release unit binds the runtime by digest (manifest `nodeSha256`, the runtime lock,
the runtime manifest of G2) whether the artifact carries the official executable (today) or the box fetches the same
official archive and checks it (`flagship-updater runtime`, G2). An owner build uses the same pins and the same
versioned install and recovery mechanism as a downloaded release; it is staged away from the live installation and
never compiles on the trusted host.
