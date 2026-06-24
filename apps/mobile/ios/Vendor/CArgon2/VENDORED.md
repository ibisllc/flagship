# Vendored: phc-winner-argon2

This is a local copy of the reference Argon2 implementation, vendored to
eliminate an SPM git-submodule dependency (the previous `Argon2Kit` package
pulled `phc-winner-argon2` as a submodule, whose clone was intermittently
flaky in this environment and broke the iOS build with
"Missing package product 'Argon2Kit'").

- **Source repo:** https://github.com/P-H-C/phc-winner-argon2
- **Pinned revision:** `62358ba2123abd17fccf2a108a301d4b52c01a7c`
  (the exact revision `Argon2Kit` 0.1.1 pinned its submodule to)
- **Vendored on:** 2026-06-24
- **License:** see `LICENSE` (dual CC0 1.0 / Apache-2.0)

## What was copied

The portable (non-SIMD) reference build only — identical to the subset
`Argon2Kit` 0.1.1 compiled:

- `src/argon2.c`, `src/core.c`, `src/encoding.c`, `src/ref.c`, `src/thread.c`
- `src/blake2/blake2b.c`
- headers: `src/core.h`, `src/encoding.h`, `src/thread.h`,
  `src/blake2/blake2.h`, `src/blake2/blake2-impl.h`,
  `src/blake2/blamka-round-ref.h`, `include/argon2.h`

We deliberately use `ref.c` (portable) rather than `opt.c` (SSE/AVX): it is
the safe choice across all iOS arches and is the exact file `Argon2Kit`
compiled. The optimized `opt.c` is NOT included.

## Byte-compatibility

The Argon2 output is byte-identical to the previous `Argon2Kit` (same source,
same revision, same `ref.c` build), and therefore stays cross-platform
compatible with Android (BouncyCastle) + webapp (WASM) for the `.flagshipkey`
backup KDF and the recovery KDF. A known-answer vector pins this in
`FlagshipMobileTests/VendoredArgon2Tests.swift`.
