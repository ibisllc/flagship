# ISO reproducibility — verification + investigation runbook

This runbook is for two audiences:

1. **Verifiers** — anyone (Harry, an auditor, a curious user) who wants
   to confirm a published Flagship base ISO is the bytes the public
   source produces.
2. **Maintainers** — when the GHA reproducibility check fails, or when
   a verifier reports a hash mismatch, this is the playbook.

For the build-system mechanics (Alpine pin, xorriso flags, apkovl format),
read [`docs/reproducible-iso-build.md`](../reproducible-iso-build.md). This
file is the operational layer on top of it.

## Why reproducibility is load-bearing

Flagship's whole trust model is "your phone is the keychain; this ISO is
what your phone trusts to boot your server." If the ISO can be built
bit-for-bit by anyone from public source, the user does not have to
trust Harry's laptop, Anthropic's models, GitHub's runners, or any other
intermediary. They trust the bytes themselves, and the bytes are
verifiable.

Every non-determinism source we don't catch becomes a future audit
failure. The CI's "build twice and compare" check is the canary. If it
ever goes red, the artifact does not ship.

## Verify a downloaded ISO locally

The standard verifier procedure. Run from a clean checkout of the repo
at the matching tag.

```sh
# 1. Fetch the published ISO + its sha256.
curl -sLO https://flagshipserver.com/build/iso/flagship-base-alpine-3.21.0-x86_64.iso
curl -sLO https://flagshipserver.com/build/iso/flagship-base-alpine-3.21.0-x86_64.iso.sha256

# 2. Confirm the file matches its sidecar (this only proves the file
#    wasn't corrupted in transit, not that the source built it).
sha256sum -c flagship-base-alpine-3.21.0-x86_64.iso.sha256

# 3. Build the ISO yourself from public source at the matching tag.
git clone https://github.com/ibisllc/flagship.git
cd flagship
git checkout iso-v3.21.0
npm install --no-audit --no-fund

#    Derive SOURCE_DATE_EPOCH the same way CI does: the tag's commit
#    timestamp.
export SOURCE_DATE_EPOCH=$(git log -1 --pretty=%ct iso-v3.21.0)
bash scripts/build-flagship-iso.sh out/flagship-base.iso

# 4. Compare hashes. Identical = the published artifact is the exact
#    bytes the public source produces, with no hidden inputs.
sha256sum out/flagship-base.iso ../flagship-base-alpine-3.21.0-x86_64.iso
```

If the hashes match, the verification is complete — you have proven the
release artifact is the bytes of the source you can read in public.

If they don't match, **the bytes are not trustworthy** and the
investigation procedure below applies.

## Build the ISO once

When you just need to produce an ISO without verifying a release:

```sh
export SOURCE_DATE_EPOCH=$(git log -1 --pretty=%ct HEAD)
bash scripts/build-flagship-iso.sh out/flagship-base.iso
sha256sum out/flagship-base.iso
```

`SOURCE_DATE_EPOCH` propagates to the apkovl emitter (which uses it for
tar mtime fields) and to xorriso (which uses it for ISO volume dates).

## Known sources of non-determinism and their mitigations

| Source | Where it lives | Mitigation | Status |
|---|---|---|---|
| Alpine upstream ISO bytes | `scripts/build-flagship-iso.sh` `ALPINE_SHA256` table | Pinned by sha256; mismatch aborts the build before any further work | **Fixed** |
| Apkovl tar mtime field | `packages/installer-apkovl/src/buildApkovl.ts` | `mtime` opt on `buildApkovl()`, falls back to `process.env.SOURCE_DATE_EPOCH`, then `0`. Threaded through `emit-apkovl.mjs` so the CI build script's exported `SOURCE_DATE_EPOCH` reaches the tar header. Regression tests in `tests/buildApkovl.test.ts`. | **Fixed** — was `Math.floor(Date.now() / 1000)` before; the old code passed the existing reproducibility test only because both calls landed in the same wall-second, but would have failed across a second boundary. |
| Apkovl gzip mtime / OS bytes | `gzipSync(...)` in `buildApkovl.ts` | Node's `gzipSync` does not embed mtime by default; OS byte = 3 (Unix) on Linux runners | **Documented** — relies on Node runtime behavior. The reproducibility unit test catches any drift. |
| Apkovl directory entry order | `BuildApkovlOptions.files` is an ordered array | Caller passes in fixed order; `buildFlagshipApkovl()` hard-codes it | **Fixed** |
| ISO file mtimes inside the filesystem | `scripts/build-flagship-iso.sh` step 3 | `find … -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +` clamps all mtimes | **Fixed** |
| ISO volume id | `scripts/build-flagship-iso.sh` step 4 | `-volid "FLAGSHIP_ALPINE_${VERSION}"` — derived from version, not wall clock | **Fixed** |
| ISO UUID + volume dates | `scripts/build-flagship-iso.sh` step 4 | `-volume_date all_file_dates =$SOURCE_DATE_EPOCH`; UUID derived from `SOURCE_DATE_EPOCH` | **Fixed** |
| Directory walk order during xorriso `-map` | xorriso internals | Single `-map` source ensures xorriso sorts deterministically | **Fixed** |
| `xorriso` binary version | apt-installed on `ubuntu-22.04` runner | Pinned to a major runner image, but apt resolves to whatever's current | **Documented** — known soft pin. Build-twice-and-compare catches divergence. To harden: switch to a digest-pinned debian container. |
| Ubuntu runner base image | `runs-on: ubuntu-22.04` | Soft pin (image SHA not pinned) | **Documented** — same as above. |
| Linker / Node version | `setup-node@v4` with `node-version: "22"` | Pinned to major. apkovl emitter has no native deps, so minor drift is safe | **Documented** |
| `apk` package versions inside the Alpine ISO | Inherited from the upstream Alpine standard ISO | We do **not** override package versions; Alpine ships their own pinned manifest with the ISO | **Documented (TODO)** — for stricter pinning we would extract the apk index, hash it, and bail if it drifts at re-build time. Today: the Alpine ISO sha256 pin transitively pins apk content for the lifetime of that ISO version. |
| Filesystem ordering on the workspace | `mktemp -d` on the runner's tmpfs | Same filesystem semantics across runs of the same runner image | **Documented** |

The "Status" column distinguishes:

- **Fixed** — actively pinned or removed; a regression here breaks the
  build-twice-and-compare check.
- **Documented** — currently relies on something we don't tightly pin
  (runner image, apk index inside Alpine). The CI guard still catches
  drift, but a hostile environment could in principle exploit the
  loophole. Listed so a future hardening pass has a complete agenda.
- **Documented (TODO)** — an explicit follow-up before v1-public.

## CI guard — what it does

`.github/workflows/build-iso.yml` runs on every `iso-v*` tag push and on
manual dispatch. It:

1. Checks out the repo at the tag with `fetch-depth: 0`.
2. Installs xorriso + curl on `ubuntu-22.04`.
3. Sets `SOURCE_DATE_EPOCH` from the tagged commit's timestamp.
4. Installs npm deps for the apkovl emitter.
5. Builds the ISO via `scripts/build-flagship-iso.sh`.
6. **Builds the ISO a second time** and `cmp -s`'s the two outputs. If
   they differ, the workflow fails loudly — that is a reproducibility
   regression and the artifact must not ship.
7. Uploads the ISO + .sha256 as a workflow artifact (always) and as a
   GitHub Release asset (on tag pushes).

Step 6 is the single most important property the pipeline asserts.
Everything else is plumbing.

## Investigation — "the hash doesn't match"

If you (or a verifier) get a different hash than the release notes
claim, this is the playbook.

### Step 1 — confirm the toolchain matches

```sh
# Confirm the git ref.
git rev-parse HEAD
git describe --tags

# Confirm SOURCE_DATE_EPOCH is the *commit* timestamp, not wall-clock.
echo "$SOURCE_DATE_EPOCH"
git log -1 --pretty=%ct

# Confirm Node + xorriso versions.
node --version
xorriso --version | head -1
```

Mismatched `SOURCE_DATE_EPOCH` (e.g. you ran the script without setting
it, and the default kicked in) is by far the most common cause. If this
fixes it, you're done.

### Step 2 — bisect the divergence: apkovl first

If the SOURCE_DATE_EPOCH was correct and the bytes still differ, find
out which layer is responsible. The apkovl is built before the ISO; if
*it* differs across builds, the ISO will too.

```sh
SOURCE_DATE_EPOCH=$(git log -1 --pretty=%ct HEAD)
node packages/installer-apkovl/scripts/emit-apkovl.mjs /tmp/apkovl-a.tar.gz
node packages/installer-apkovl/scripts/emit-apkovl.mjs /tmp/apkovl-b.tar.gz
sha256sum /tmp/apkovl-a.tar.gz /tmp/apkovl-b.tar.gz
```

Two different hashes here = the regression is in `packages/installer-apkovl`.
Most likely a new caller landed that ignores SOURCE_DATE_EPOCH, or a
new file was added that includes wall-clock state (e.g. a build manifest
with a timestamp). Run the unit suite:

```sh
npx vitest run packages/installer-apkovl
```

The "respects an explicit mtime" and "falls back to SOURCE_DATE_EPOCH"
tests catch the most common shapes (including the second-boundary case
that the original "produces byte-identical output" test missed). If
they pass but the emitted bytes still differ, diff the tar contents:

```sh
gunzip -c /tmp/apkovl-a.tar.gz > /tmp/apkovl-a.tar
gunzip -c /tmp/apkovl-b.tar.gz > /tmp/apkovl-b.tar
cmp -l /tmp/apkovl-a.tar /tmp/apkovl-b.tar | head -20
```

The first divergent byte's offset, combined with the USTAR layout (name
at 0, mode at 100, uid at 108, gid at 116, size at 124, mtime at 136,
checksum at 148, …), tells you exactly which field drifted.

### Step 3 — bisect: the ISO layer

If the apkovl is byte-stable but the ISO isn't, the regression is in
`scripts/build-flagship-iso.sh` or xorriso behavior.

```sh
SOURCE_DATE_EPOCH=$(git log -1 --pretty=%ct HEAD)
bash scripts/build-flagship-iso.sh /tmp/iso-a.iso
bash scripts/build-flagship-iso.sh /tmp/iso-b.iso
cmp -l /tmp/iso-a.iso /tmp/iso-b.iso | head -20
```

Common shapes:

- **Volume-descriptor timestamp drift** (offsets 0x8000–0x8400). Means
  `-volume_date` flags didn't take effect; check the xorriso version.
- **Path-table or directory-record drift**. Means xorriso changed its
  sort order between versions; pin xorriso harder (see "soft pins"
  above).
- **El Torito boot-record drift** (around 0x8800). The boot image was
  re-emitted with a fresh timestamp. Check `isohdpfx.bin` source.

### Step 4 — bisect: the runner

If the build is reproducible on your machine but not in CI (or vice
versa), the divergence is in the runner environment. Capture both
environments' fingerprints:

```sh
uname -a
xorriso --version
node --version
sha256sum /usr/bin/xorriso /usr/bin/curl
```

If `xorriso` differs, that's the runner-image soft pin biting. Either
pin the runner image SHA (`runs-on: ubuntu-22.04@<sha>` style — not
supported on GH-hosted runners today, hence the use of a fixed-version
container) or move the build into a digest-pinned container.

### Step 5 — escalate

If all of the above pass and the hashes still differ:

1. File an issue at `https://github.com/ibisllc/flagship/issues`
   tagged `reproducibility`.
2. Attach the diverging `cmp -l … | head -100` output, the two ISO
   `sha256sum`s, the toolchain fingerprint from step 4, and the exact
   `SOURCE_DATE_EPOCH` you used.
3. Do **not** push the divergent artifact to R2 or any release
   channel. The release pipeline is gated on the CI guard for exactly
   this reason — local reproductions that disagree with CI need to be
   reconciled before bytes ship to users.

## Reproducibility outside the standard runner

A user who wants to verify on a Mac, Windows+WSL, or Nix system can do
so — they just need:

- `xorriso` installed and on `$PATH`.
- Node 22+ (LTS).
- Working `curl` with TLS for downloading the upstream Alpine ISO.

The toolchain drift between platforms is real (libc differences, gzip
library version) but the **outputs of `buildApkovl()` and xorriso are
defined in terms of byte layouts, not runtime libraries**. As long as
the tools respect their documented flags, the output is reproducible
across platforms. If a Mac user reports a divergent hash from the
Linux release artifact, walk steps 1-4 above; we have not yet
encountered a real cross-platform divergence as of this writing, but
the surface area is wide and the runbook is here to catch the first
one.

## Pre-release verification — what Harry runs before tagging

Before pushing an `iso-v*` tag (which triggers the release workflow),
Harry should:

```sh
# Local pre-flight: build, build again, compare.
export SOURCE_DATE_EPOCH=$(git log -1 --pretty=%ct HEAD)
bash scripts/build-flagship-iso.sh /tmp/iso-pre-a.iso
bash scripts/build-flagship-iso.sh /tmp/iso-pre-b.iso
cmp -s /tmp/iso-pre-a.iso /tmp/iso-pre-b.iso && echo "OK: bytes match"

# Confirm the apkovl unit suite is green.
npx vitest run packages/installer-apkovl
```

If both checks pass, tag and push. The CI guard will rebuild
independently and ratify the bytes; the GitHub release asset becomes
the authoritative hash for users.

## Source of truth

- Build mechanics: [`docs/reproducible-iso-build.md`](../reproducible-iso-build.md)
- Build script: [`scripts/build-flagship-iso.sh`](../../scripts/build-flagship-iso.sh)
- Apkovl emitter: [`packages/installer-apkovl/scripts/emit-apkovl.mjs`](../../packages/installer-apkovl/scripts/emit-apkovl.mjs)
- Apkovl reproducibility tests: [`packages/installer-apkovl/tests/buildApkovl.test.ts`](../../packages/installer-apkovl/tests/buildApkovl.test.ts)
- CI workflow: [`.github/workflows/build-iso.yml`](../../.github/workflows/build-iso.yml)
