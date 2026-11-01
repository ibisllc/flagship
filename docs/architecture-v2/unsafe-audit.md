# Unsafe and FFI audit of the Rust crates (0.3, plan G10)

Audited 2026-11-01 on `release/0.3` against `rust/Cargo.lock` (toolchain 1.99.1). Plan rule (IMPLEMENTATION-PLAN
§5.2): first-party security crates forbid `unsafe`; every exception and every third-party FFI needs an inventory
entry, a rationale, review and fuzz coverage. Rust's type system is not a security proof; the process isolation
(systemd sandboxing, separate users, keyd holding keys) still carries the weight.

## 1. First-party code: no `unsafe`, no FFI

- `grep -rnE '\bunsafe\b|extern "C"|#\[link'` over `rust/crates/**/*.rs` finds no `unsafe` block, function, impl
  or `extern` declaration (the only hits are comments and the word "unsafe" in the HTTP-method sense in
  `flagship-access/src/origin.rs`).
- Two independent guards make it a compile error:
  1. `rust/Cargo.toml` `[workspace.lints.rust] unsafe_code = "forbid"`, which every crate inherits with
     `[lints] workspace = true`.
  2. `#![forbid(unsafe_code)]` at every crate root (each `src/lib.rs`, `src/main.rs` and `src/bin/*.rs`) of
     access, boot, broker, core, crypto, gpu, ingress, keyd, protocol, runtime, updater and wasi, so the guard holds
     even if a crate's `[lints]` line is dropped or the crate is built outside the workspace.
- **flagship-relay** relies on the workspace lint only: it was owned by another agent while this audit ran, so its
  roots were not edited. Add `#![forbid(unsafe_code)]` to `src/lib.rs` and `src/bin/flagship-relay.rs` when it is
  next touched. Its fuzz crate (`crates/flagship-relay/fuzz`) and the new `rust/fuzz` both forbid `unsafe`.
- Platform calls go through safe wrappers only: `std::os::unix` (sockets, permissions, symlinks), `rustix`
  (access, boot, broker, core, gpu, updater) and `nix` (keyd). Both wrappers keep the `unsafe` inside them.

## 2. Third-party crates with `unsafe`, native code or FFI

Containment column: which shipped binaries link it, and what bounds the damage.

| Crate (version per Cargo.lock) | Kind | Why it is used | Containment |
|---|---|---|---|
| **aws-lc-sys / aws-lc-rs** | Native C + assembly (AWS-LC, a BoringSSL fork) built by `cmake`/`cc` | The only rustls provider with the hybrid `X25519MLKEM768` key exchange the box's TLS needs (PQ plan §6); `ring` has no ML-KEM | Ingress (and relay) only; ingress holds no private key (signing is a keyd IPC call, `src/signer.rs`), runs unprivileged behind its own socket. Pinned exact; tracked in `deny.toml` advisories. Inputs: TLS records from the network, so covered by AWS-LC's own fuzzing upstream, not ours |
| **ring** | C + assembly (BoringSSL-derived primitives) | rustls's default provider pulled by `ureq` for the updater's and boot's HTTPS fetches; also `rustls-webpki` | Updater and boot are short-lived clients that verify every fetched byte against signatures/digests afterwards; TLS here protects transport only |
| **libsqlite3-sys** (`rusqlite` feature `bundled`) | Bundled SQLite C | Durable journals (core's operation journal in WAL + `synchronous=FULL`, broker state, gpu state) | Database files are private to the owning service; no SQL is built from untrusted text (parameters only); the crash test `flagship-core/tests/kill.rs` kills a writer mid-transaction |
| **wasmtime, cranelift-\*, pulley-interpreter, wasmtime-internal-fiber/-unwinder/-jit-\*** | Pervasive `unsafe`: JIT code generation, executable memory, stack switching, signal handlers | `flagship-wasi` runs WASI apps (plan §8.5) | Isolated in `flagship-wasi-worker`, one process per run, deadline-killed. `Module::deserialize` (unsafe) is never reachable: this crate forbids `unsafe`, so modules are always compiled from bytes (`flagship-wasi/src/lib.rs`). No pooling allocator, no component-model async/threads/gc |
| **rustix, linux-raw-sys** | `unsafe` raw syscalls (inline asm on Linux) | Typed file, socket, process and credential calls without libc string handling | Well-reviewed (Bytecode Alliance); used through its safe API only |
| **nix** | `unsafe` libc wrappers | keyd: `SO_PEERCRED`/`getpeereid` to authenticate callers, `prctl(PR_SET_DUMPABLE, 0)`, `setrlimit(RLIMIT_CORE, 0)`, signal masks | keyd only; the calls are exactly the hardening keyd needs (no core dumps of keys) |
| **libc** | FFI declarations | Pulled by rustix, tokio, mio, getrandom, socket2, nix | Declarations only; the callers above are the audited users |
| **tokio, mio, socket2, signal-hook-registry** | `unsafe` around epoll/sockets/signals | Async runtime of ingress, relay, wasi deadlines | Mainstream, fuzzed upstream; no custom executors |
| **getrandom** | `getrandom(2)` syscall | Keys, nonces | Fails closed (an error, never a weak fallback) |
| **zlib-rs, miniz_oxide, flate2** | `unsafe` SIMD in zlib-rs | Updater's `tar.gz` reader | Input is a release artifact whose SHA-256 is checked against the signed manifest before it is unpacked; the tar layer is bounded (`flagship-updater/src/extract.rs`) |
| **memchr, simdutf8, aho-corasick, regex-automata, hashbrown, smallvec, bytes, zerocopy, zerovec, yoke, bumpalo, crc32fast, simd-adler32** | `unsafe` for SIMD/layout | Parsing and collections | Widely fuzzed upstream; no FFI |
| **curve25519-dalek, fiat-crypto, sha2/sha3/keccak (cpufeatures), aes/ghash/polyval, subtle, zeroize** | `unsafe` for SIMD backends, volatile writes | Signatures, key exchange, AEAD, wiping | RustCrypto/dalek, constant-time by design; `zeroize` uses volatile writes on purpose |
| **cc, cmake, pkg-config, vcpkg, jobserver** | Build-time only | Build aws-lc-sys and libsqlite3-sys | Never in a shipped binary; builds are `--locked` and run in isolated CI/VM builders |
| **windows-\*, winapi-util, winx, r-efi, wasm-bindgen, js-sys, mach2** | Platform FFI for other targets | Transitive, target-gated | Not compiled for `x86_64`/`aarch64-unknown-linux-gnu` |

Pure-Rust crypto with no FFI worth noting: `ml-dsa`, `ml-kem`, `x-wing`, `ed25519-dalek`, `x25519-dalek`, `p256`,
`aes-gcm`, `hkdf`, `hmac`, `pgp` (rpgp, for the Node `SHASUMS256.txt` signature) and its RSA/DSA/ECC helpers.

## 3. Fuzz coverage of the parsers in front of this code

- `crates/flagship-relay/fuzz`: `frame_decode`, `sni_parse`, `payload_parse` (relay wire and SNI).
- `rust/fuzz` (new, 0.3): `ingress_request_head`, `ingress_response_head`, `ingress_chunked`
  (`flagship-ingress/src/http.rs`), `broker_tarcheck` (`flagship-broker/src/tarcheck.rs`, both profiles,
  default and tight limits, `check` against `check_copy`), `access_path`, `access_origin`
  (`flagship-access/src/path.rs`, `origin.rs`). Run: `cargo +nightly fuzz run <target> corpus/<target> --
  -max_total_time=N` from `rust/fuzz`. Bounded run results are in `benchmarks-0.3.md`.
- Fixed after the first bounded runs (2026-11-01): `access_origin` found three non-idempotent inputs in
  `normalize_origin`: a control character in the host (`http://\0\v?…`), a non-ASCII space (`http://t\u{a0}#*`; a
  second pass's `trim` ate either) and an unbracketed host holding `:` or `[` (`http://0[::`, also `http://a:b:80`).
  The authority must now be printable ASCII and an unbracketed host may not hold `:`, `[` or `]`; anything else gives
  no origin, as the TS twin's WHATWG URL parse does for these (browsers send punycoded hosts). An unparseable Origin
  already counts as cross-origin, so the change can only remove a member, never grant one. All three inputs are corpus
  seeds; the target now asserts idempotence without exceptions.

## 4. Open items

- flagship-relay crate roots: add `#![forbid(unsafe_code)]` (section 1).
- aws-lc-sys: record the exact upstream AWS-LC version in each release's SBOM (the box artifact SBOM already lists
  the Cargo.lock entry) and re-review on every bump.
- Re-run this audit whenever `rust/Cargo.lock` adds a `-sys` crate, a `build.rs` that compiles C, or a crate with an
  `extern` block (`cargo tree -e build`, `grep -l 'links =' ~/.cargo/registry/src/*/*/Cargo.toml`).
