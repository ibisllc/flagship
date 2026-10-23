# Vendored post-quantum code

Used by `CFlagshipPQ` (the Swift ports of `packages/protocol/src/pqHybrid.ts`) on every OS
version: CryptoKit's ML-DSA / ML-KEM / X-Wing need iOS 26, the app's floor is iOS 18.

| Directory | Project | Tag | Commit | License |
|---|---|---|---|---|
| `mldsa/` | github.com/pq-code-package/mldsa-native | v2.0.0 | 834a90d5e846ffa1e1611bd24e160bb2e9b86d35 | Apache-2.0 OR ISC OR MIT (`mldsa/LICENSE`) |
| `mlkem/` | github.com/pq-code-package/mlkem-native | v2.0.0 | d1b2fe782888bdb761a50336012923180be7f502 | Apache-2.0 OR ISC OR MIT (`mlkem/LICENSE`) |

Copied unchanged from each project's `mldsa/` / `mlkem/` directory, minus the native
(assembly) backends and `*_native_asm.S`: only the portable C monolithic build is compiled
(`../pq_mldsa.c`, `../pq_mlkem.c` include `mldsa_native.c` / `mlkem_native.c` once each, with
`NO_RANDOMIZED_API`, so the caller supplies all randomness). To update: replace both
directories from the new tag the same way, rerun `swift test` (the shared vectors and the
X-Wing KATs pin the bytes), and update this table.

`../pq_ed25519.c` (the strict point check) is Flagship's own, after TweetNaCl (public domain).
