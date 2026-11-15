# Task 1: release/0.4 full suite (cloud session). PARTIAL, more to come

Tested commit: `2785968307fbf7ba03ab7fbc5b5b65e00a1aed9a` (release/0.4 tip at fetch, "Calls: the Kotlin port of the call records and page index v2")

## (a) Environment
- Linux x86_64 (kernel 6.18), 4 vCPU, 15 GiB RAM, no swap
- node v22.23.4, npm 10.9.9
- Java: **OpenJDK 21 only** (no 17)
- Android SDK: **no**, and it can't be installed here: the egress proxy denies `dl.google.com` (403). `maven.google.com` is reachable, but that doesn't give an SDK.
- Rust: rustup present; the repo pins 1.99.1 (`rust/rust-toolchain.toml`)
- Go 1.24.7
- Postgres: **16.15 only**. `apt.postgresql.org` is denied, so no PG 18.
- `xxd` was missing at first. I installed it for the premount tests (see below).

## (b) `npx tsc -b`
PASS (exit 0, 24 s).

## (c) `npx vitest run`
Still running. So far one failing file:
- `tools/unseal-crosscheck/tests/premount.test.ts`: 17/27 fail. **ENV, not REAL**: `premount.sh: 170: xxd: not found`, so it can't read the boot key. CI runners have xxd. I'll recheck now that xxd is installed.

## (d) i18n / parity
- `npm run i18n`: every check is ok except **store art**, which fails only because Playwright 1.59.1 wants `chromium_headless_shell-1217` and this box has 1243. With `PLAYWRIGHT_BROWSERS_PATH` pointed at the 1243 shell, `i18n-store: ok`. **ENV.**
- `npm run parity`: exit 1, 23 reds:
  - push-categories: 2 red. `voici-call` isn't named in the ios or android push handlers.
  - signed-tags: 20 red. 18 `flagship/org-*` tags are in ios but not android (the Kotlin org-authority port, which Task 2's branch adds). `org-seat-key-wrap` is also missing in web. `voici-call-allow/v1` and `voici-missed-call/v1` are in ios and android but not web.
  - test-vectors: 1 red. No kotlin test reads `org-authority`.

## GitHub Actions on ibisllc release/0.4 (reviewed)
- **Rust workflow fails on every push.** `cargo fmt --check` diffs in `rust/crates/flagship-keyd/src/policy.rs` (lines ~175, 268, 885) and `rust/crates/flagship-keyd/tests/reset.rs` (12, 25). **cargo-deny advisories:** RUSTSEC-2026-0459 (libsqlite3-sys 0.38.2 via rusqlite 0.40.2, needs 0.39 / rusqlite 0.41) and RUSTSEC-2026-0486 (rustix 1.1.4, needs `cargo update -p rustix` to >=1.1.6).
- **CI (tsc + vitest)** mostly shows "cancelled": `cancel-in-progress: true` cancels each run when the next push lands. The last completed run (`c5f5b046`) failed:
  - gate 2/4: `tools/adversarial/tests/envelopeForgery.test.ts:284` has 9 new tags with no forgery coverage (`app-restore-undo`, `box-claim-*` x6, `box-setup-code-key`, `server-restore-stage`). `scripts/compat-matrix.test.ts:28` expected 210, got 208. `scripts/ios-release-clean.test.ts:7` flags `MockScreensClient+RestoreMerge.swift:5`, a Mock in release code.
  - gate 3/4: `scripts/gym-refresh-acme.test.ts:19` expected `https://flagship-acme-gym.fly.dev/dir`, got `''`.
  - gate 4/4: `packages/control-plane/tests/schemaStatus.test.ts:27` doesn't list migration `0141`. `packages/server-daemon/tests/retailClaim/wipeVerifier.test.ts:99` failed with "run 1937: recognizable-plaintext" (randomized, so maybe flaky). `scripts/release-manifest.test.ts:41` failed.
  - web-gym: `home-demo-account`, `home-add-import-choices` and `home-lock-closes-menus` fail.
- Scheduled jobs on main (DNS canary, D1 backup, iso-manifest URLs, release catalog, model table) are all green.
