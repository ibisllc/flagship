# Scope

## Release under review

- Branch `integrate/0.3-arch`, base commit `8007d3f8f4f69438f1a18d138a6fe4effc823ba1` (2026-10-24),
  plus the V01/V02 working-tree changes listed in `adversarial-tests.md`. The release manager
  records the final commit and the box artifact digests (`release/box-release.json`,
  `release/catalog-releases.json`) here before the assessment starts:
  - commit: `<to fill>`
  - box artifact amd64 / arm64 SHA-256: `<to fill>`
  - webapp shell version: `<to fill>` (`release/compatibility.json`)
  - iOS / Android / Studio builds: `<to fill>` (`release/version.json`)
- A finding is always reported against one of these (see `issue-template.md`).

## In scope

1. **The box** (`packages/server-daemon`, `packages/keyd`, `packages/privd`, `installer/`, the Rust
   crates under `rust/crates/` that ship in the artifact: keyd, broker, core, boot, ingress), the
   signed box artifact and its installer and updater, the boot path (`installer/boot-stage.sh`,
   `installer/unseal-helper`, `rust/crates/flagship-boot`, the premount), the app sandbox (gVisor,
   Podman/Docker argument policy, egress fence), the app proxy and access gates, AI staging
   and its redaction, chat between owners, backups and restore.
2. **`.com`** (`apps/com`, `packages/control-plane`, `packages/storage`, `packages/boot-core`
   running in-process): identity, directory, deposits, boot unlock mailbox, recovery records,
   shares, the release catalog and update receipts, rate limits. Also `apps/dns-broker`.
3. **The relay** (`apps/web/src/tunnel`, `rust/crates/flagship-relay`, `packages/tunnel-protocol`):
   SNI passthrough, tunnel hub, PROXY-header echo, outbound AI hub.
4. **Clients** as verifiers and key holders: iOS/iPadOS/watchOS (`apps/mobile/ios`,
   `apps/mobile/shared`), Android/Wear OS (`apps/mobile/android`), the webapp
   (`apps/web/public/webapp`, keyless-web exceptions in `SECURITY-0.3-PROGRESS.md` N06), the three
   Studios (pairing, recipe, VM hosting).
5. **Protocols and cryptography** (`packages/protocol`, `rust/crates/flagship-crypto`,
   `rust/crates/flagship-protocol`): every signed envelope family, the hybrid PQ suites in
   `docs/architecture-v2/pq-suites.md`, the shared vectors under `packages/protocol/test-vectors/`.
6. **Release and operations tooling** that holds authority: `scripts/release.sh`,
   `scripts/endorse-release.mjs`, `scripts/pq-release-key.mjs`, `tools/release-catalog/`,
   `tools/box-artifact/`, `scripts/security-notice.mjs`, the CA tooling in `.maintainers/`.

## Out of scope

- Feature branches not in this release (`feat/marketplace`, `feat/custom-domains`,
  `feat/custom-names`, `feat/outbound-proxy`, `feat/retail`, `feat/browser-extension`,
  `feat/phone-usb-burn`, `feat/other-os-installers`, `feat/data-sovereignty`, `alpine`).
- Third-party providers as such (Cloudflare, Fly, Let's Encrypt, Apple, Google, AI model APIs).
  How Flagship depends on them is in scope.
- Remote display/game streaming and multi-server orchestration (excluded from the product by the
  owner).
- GPU, WASI and app-group code are in scope as code. No hardware receipt exists for them, so a
  finding there is welcome, but the assessment cannot certify them (see `known-gaps.md`).

## Rules of engagement

- Use the gym (`gym.flagshipserver.com`, its own D1, its own Fly app, UpCloud boxes) or a
  throwaway VM from `scripts/full-test-vm.sh`. **Never test against production
  (`flagshipserver.com`, `flagship.services`) or real accounts.** Never touch the store-review
  account `playstore-test-0725`.
- The gym is shared, and one run holds the lock at
  `/private/tmp/claude-501/flagship-locks/gym.lock`. Coordinate with the release manager.
- Report a finding privately (`security@` PGP, `apps/web/public/security/disclosure.html`) and in
  the template's form. The bounty rules on the disclosure page apply.
- Do not publish a finding before its fix ships or 90 days pass, whichever comes first, unless the
  owner agrees otherwise.
