# Task 4: release/0.4 after the merges (cloud session). PARTIAL: cargo test, Android and the 612abfd7a CI runs pending

Tested commit: `612abfd7a78417b7b4846d154fe0ed6f55d0a753` ("0.4 journal: enterprise-3 merged"), fresh worktree with its own `npm ci`.

## (a) tsc + vitest
- `npx tsc -b`: **PASS** (28 s)
- `npx vitest run`: **ALL GREEN**: 1335 files passed, 5 skipped (1340); 17941 tests passed, 175 skipped (18116). **0 failures**, so there was nothing to rerun.

## (b) i18n / parity
- `npm run i18n`: **PASS** (exit 0; store art run with the local Playwright browser-path workaround, as before)
- `npm run parity`: **PASS** (exit 0, no reds)

## (c) Rust
- `cargo fmt --all --check`: **PASS** (exit 0)
- `cargo test --workspace --locked`: rerunning. The first attempt ran out of disk in this container (my own leftover build trees). That was an environment problem; I cleaned up and restarted.

## (e) GitHub Actions on release/0.4
Runs for `612abfd7a` were still **in progress** when I looked (CI, Rust, iso-seed; the Admin-authority guard is green). Last completed:
- **CI (tsc + vitest)** run 43725856659 @ `d510c346` ("0.4 journal: cloud report 03"): failure in **gate (1/4)** only. First error: `scripts/mobile-clients-inventory.test.ts:72`, "a raw HTTP client was added; route it through the pinning factory or list why it never reaches a box". That's the report-03 item, which passes locally at 612abfd7a.
- **Rust** run 43713571653 @ `d3d2732f`: `check (ubuntu-24.04)` and `check (ubuntu-24.04-arm)` failed. First error: clippy `indexing_slicing`, "indexing may panic" at `crates/flagship-keyd/src/policy.rs:194:28` (`receipt_text_ok(p[6])`), also 195:28 and 196:26, "could not compile `flagship-keyd` (lib) due to 16 previous errors". **Note:** the workflow runs clippy with `-D` lints. This report's `cargo test` doesn't run clippy, so I'll also run `cargo clippy` the way CI does.
- Earlier CI runs on this branch are mostly `cancelled` by `cancel-in-progress` on newer pushes.
