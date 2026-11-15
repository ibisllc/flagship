# Task 4: release/0.4 after the merges (cloud session). COMPLETE

Tested commit: `612abfd7a78417b7b4846d154fe0ed6f55d0a753` ("0.4 journal: enterprise-3 merged"), fresh worktree with its own `npm ci`.

## (a) tsc + vitest
- `npx tsc -b`: **PASS** (28 s)
- `npx vitest run`: **ALL GREEN**: 1335 files passed, 5 skipped (1340); 17941 tests passed, 175 skipped (18116). **0 failures**, so there was nothing to rerun.

## (b) i18n / parity
- `npm run i18n`: **PASS** (exit 0; store art run with the local Playwright browser-path workaround, as before)
- `npm run parity`: **PASS** (exit 0, no reds)

## (c) Rust (toolchain 1.99.1)
- `cargo fmt --all --check`: **PASS**
- `cargo test --workspace --locked`: **PASS**: 118 test binaries, **839 passed, 0 failed, 4 ignored** (3m24s). The first attempt died with "No space left on device" (my leftover build trees, an environment problem); the rerun after cleanup is clean.
- `cargo deny check advisories` (cargo-deny 0.20.2, installed here): **advisories ok**. RUSTSEC-2026-0459 / -0486 from report 01 are gone.
- `cargo clippy --workspace --all-targets --locked -- -D warnings` (what `rust.yml` runs, line 49): **FAIL, REAL**, the same failure as CI. 16× `indexing_slicing` "indexing may panic" in `crates/flagship-keyd/src/policy.rs:182–197` (`claim_receipt_ok` indexes `p[1]`…`p[9]`). Once those are fixed, clippy finds two more in the same crate: `print_stdout` at `crates/flagship-keyd/src/main.rs:74` (`println!("{{\"reset\":true}}")`) and 18× `unwrap_used` in `crates/flagship-keyd/tests/reset.rs` (the only keyd test file without the usual `#![allow(clippy::unwrap_used…)]`).

  **Fix pushed on branch `0.4/keyd-clippy-cloudfix`** (one commit `95678b0ca` off 612abfd7a, 3 files, +16/−16):
  - `policy.rs`: `let [_, mode, domain, serial, keys, p5, p6, p7, p8, issued] = p.as_slice() else { return false; };`. The slice pattern also replaces the `p.len() != 10` check, so the function accepts and refuses exactly the same messages.
  - `main.rs:74`: `let _ = writeln!(std::io::stdout(), ...)`, the same style as line 176 (`std::io::Write` is already imported).
  - `tests/reset.rs`: `#![allow(clippy::unwrap_used)]`, as the other keyd test files have.

  With it: workspace clippy **exit 0**, `cargo fmt --check` ok, `cargo test -p flagship-keyd` 58 passed / 0 failed.

## (d) Android (root `node_modules` installed first; JDK 17, SDK 36)
- `:app:assembleDebug`: **PASS**; `:wear:assembleDebug`: **PASS**
- `:app:testDebugUnitTest`: 3016 tests, 6 skipped, **1 failure = the known FLAKY `ModelMenuComposeTest > stagedAttachmentsWithNotice`** (`AppNotIdleException` at `ModelMenuComposeTest.kt:94`); it passes alone. It has now failed under full-suite load in 4 of 5 runs, so it's worth a fix (an idling-resource or `waitUntil` problem in the Compose test).

## (e) GitHub Actions on release/0.4
Runs on `612abfd7a` (the commit I tested):
- **Rust** run 43733666879: **failure**. Failed jobs: `check (ubuntu-24.04)` and `check (ubuntu-24.04-arm)`. First error: `error: indexing may panic --> crates/flagship-keyd/src/policy.rs:182:40` (`(8..=64).contains(&p[3].len())`), then 15 more in 183–197; "could not compile `flagship-keyd` (lib) due to 16 previous errors". Same as (c); fixed on `0.4/keyd-clippy-cloudfix`. The `deny` job passed.
- **CI (tsc + vitest)** run 43733666849: no failed jobs (cancelled or superseded by the next push, which is the usual pattern here).
- **iso-seed** run 43733666865: no failed jobs.
- **Admin-authority guard**: success.

Older runs, for the record:
- CI run 43725856659 @ `d510c346`: failure in `gate (1/4)` only. First error: `scripts/mobile-clients-inventory.test.ts:72` "a raw HTTP client was added; route it through the pinning factory…". That's the report-03 item, now fixed (passes locally at 612abfd7a).
- Rust runs @ `d3d2732f`, `eb2b4c5a`, `47ba5836`: the same keyd clippy failure.

## Summary
release/0.4 @ 612abfd7a is green on tsc, the whole vitest tree, i18n, parity, Rust fmt/test/deny and both Android builds. Remaining:
1. **Rust clippy gate (REAL)**: fix ready on `0.4/keyd-clippy-cloudfix`.
2. **Flaky `ModelMenuComposeTest.stagedAttachmentsWithNotice`** (Android, under load).
