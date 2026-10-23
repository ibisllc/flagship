# flagship-ingress

Box-local TLS ingress in Rust (architecture v2 work package **I01**, `docs/architecture-v2/IMPLEMENTATION-PLAN.md`
§6.2). It is a drop-in candidate for `flagship-tlsd` (`installer/tls-frontend/`, Go): TLS terminates on the
box, the certificate's private key stays in `flagship-keyd`, and every handshake signature is one keyd
`tls.sign` request. Decrypted connections go to the daemon's Unix socket behind the same one-line JSON header.

Nothing in the box uses it yet: the unit, the daemon and the Go frontend are unchanged.

## Layout

| File | What |
|---|---|
| `src/wire.rs` | keyd wire v1: 4-byte big-endian length + JSON, 4 MiB cap checked before buffering, zero length refused |
| `src/keyd.rs` | blocking client for `hello` (v 1, first on every connection), `tls.active`, `tls.sign`; one connection, serialized, one redial on transport failure |
| `src/cert.rs` | keyd's PEM chain parsed once; leaf must be ECDSA P-256; name coverage with rustls-webpki (exact or one left-most wildcard label, like Go's `VerifyHostname`) |
| `src/signer.rs` | rustls `SigningKey`/`Signer` backed by keyd, with the signing-context binding below |
| `src/source.rs` | certificate in service: reloaded on a timer and on demand (SIGHUP, or a handshake that found none); handshakes read memory only |
| `src/guard.rs` | bounds on the first request head (measured, never rewritten) |
| `src/server.rs` | accept, connection cap, handshake deadline, kx policy, header line, half-closing pump, idle timeout, drain |
| `src/args.rs`, `src/main.rs` | the `flagship-ingress` binary; accepts flagship-tlsd's flags in Go `flag` syntax |

## Signing binding (so the ingress is not a general signing oracle)

- **Scheme:** only `ecdsa_secp256r1_sha256`, and only when the peer offered it. The leaf must be P-256.
- **Context:** the bytes rustls passes must be a TLS 1.3 *server* CertificateVerify input (64 spaces, the server
  context string, a 32- or 48-byte transcript hash) or a TLS 1.2 ServerKeyExchange input (two randoms and a
  named-curve ECDHE share of the right length). Anything else is refused before keyd is asked.
- **Key:** only the handle keyd last reported active. The handle it replaced may finish a handshake for one
  handshake-deadline after the switch, then is refused.
- **Answer:** keyd's signature is verified against the leaf's public key before it is sent, so a keyd answer by
  another key fails closed here rather than at the client.
- **Resumption is off** (no session cache, no TLS 1.3 tickets, no 0-RTT): every connection is a fresh keyd-signed
  handshake, so no ticket key exists to inventory and nothing outlives a key rotation.

## Parity with flagship-tlsd

| Behaviour | flagship-tlsd (Go) | flagship-ingress | Test |
|---|---|---|---|
| Flags | `--listen 127.0.0.1:18443 --keyd /run/flagship-keyd/keyd.sock --upstream /run/flagship-tls/upstream.sock --max-conns 4096 --handshake-timeout 10s --refresh 5s` | same names, defaults and Go syntax; extra bounds flags below | `args::tests` |
| Startup line | `listening <addr>` on stdout | same | manual |
| keyd protocol | v1 frames, `hello {v:1, component}` first, 4 MiB cap, one redial | same; component `flagship-ingress` | `says_hello_first_and_redials`, `an_oversize_keyd_frame_fails_closed`, `wire::tests` |
| Key | never in the process; `crypto.Signer` → `tls.sign` | same, plus the binding above | `serves_tls_with_the_key_in_keyd_…`, `refuses_a_signature_by_another_key`, `signer::tests` |
| Hashes | SHA-256 or SHA-384 digests | SHA-256 only (P-256 scheme) | `chooses_only_p256_sha256` |
| TLS versions | 1.2 minimum | 1.2 minimum, 1.3 preferred (rustls has no 1.1 code at all) | `classical_clients_are_still_accepted_…`; Go oracle covers 1.1 refusal |
| ALPN | `http/1.1` only; `acme-tls/1` never negotiated | same; a client offering only an unknown protocol is refused, no ALPN is served with `alpn:""` | `refuses_acme_tls_alpn` |
| Names | only names the leaf covers; no SNI refused | same | `refuses_a_name_the_certificate_does_not_cover` |
| Renewal | `tls.active` re-read every 5 s, no dropped connections | same on a timer, plus on demand (SIGHUP / empty cache) | `picks_up_a_renewal_on_the_timer_…`, `reloads_on_demand`, `no_certificate_yet_…` |
| keyd briefly down | keeps the cached cert; signing fails, so handshakes fail closed | same | `fails_closed_when_keyd_is_down` |
| Upstream | dial Unix socket (3 s), write `{"sni":…,"alpn":…,"tls":…}\n`, copy both ways with half-close | identical bytes and field order; SNI lowercased; same half-close | `serves_tls_…` (asserts raw line), `server::tests` |
| Client bytes | forwarded verbatim | forwarded verbatim | `client_bytes_reach_the_daemon_verbatim` |
| Connection cap | over the cap: closed at once | same | `handshake_deadline_and_connection_cap` |
| Handshake deadline | 10 s | 10 s, also covers ClientHello reading | same test |
| Key exchange | Go defaults; with `go 1.22` in go.mod, GODEBUG compatibility keeps `X25519MLKEM768` off (`tlsmlkem`), so it is classical | `X25519MLKEM768` preferred by the server, X25519/P-256/P-384 accepted; `--kx require-hybrid` refuses classical | `a_client_offering_only_x25519mlkem768_negotiates_it`, `the_server_prefers_the_hybrid_…`, `classical_clients_…` |
| Resumption | Go default tickets (auto-rotated keys) | off (above) | config |
| Shutdown | SIGTERM closes the listener and exits (drops connections) | stops accepting, drains up to `--drain-timeout` (10 s) | manual |

### New bounds (not in flagship-tlsd)

| Bound | Default | Flag | Test |
|---|---|---|---|
| First request head must end within | 20 s after the handshake (else `408`) | `--head-timeout` (0 = Go's plain pipe) | `a_slow_request_head_gets_408_…` |
| Longest head line | 16 KiB (else `431`) | `--max-header-line` | `an_oversize_header_line_gets_431` |
| Largest first head | 32 KiB (else `431`) | `--max-header-bytes` | same |
| No byte either way for | 15 min closes the connection | `--idle-timeout` (0 = off, as Go) | `an_idle_connection_is_closed` |
| keyd round trip | 5 s (Go: 10 s) | `--keyd-timeout` | — |

The head guard only measures the first head and dials the daemon after it, so a slowloris client never holds a
daemon socket. It does not parse, route or rewrite anything: the daemon still sees exactly the client's bytes.
Later requests on a keep-alive connection are bounded by the daemon's own Node HTTP timeouts.

## Identity and forwarding headers

The plan (§6.2) asks for authenticated local metadata to the façade and for client-supplied identity and
forwarding headers to be discarded. Today:

- **Authenticated metadata** is the header line: the ingress writes it before any client byte, on a socket only
  its group may open, so a client cannot forge it (a client sending its own JSON line just sends HTTP noise).
- **Stripping** stays in the daemon, as with flagship-tlsd: its app proxy removes every client `X-Flagship-*`
  header (`identityInjector.ts`, `docs/app-apis.md` §5). The ingress does not rewrite HTTP, because a second HTTP
  interpretation in front of Node's is exactly what §6.2 forbids. It moves here only when the ingress *becomes*
  the HTTP façade (one parser, hyper, re-serialised to the daemon), which changes what the daemon receives and is
  out of scope for a drop-in.
- The negotiated key-exchange group is not in the header line (the field set is identical to Go's); adding a
  `kx` field is a façade/compatibility-policy decision.

## HTTP/2

Not offered. The daemon's upstream socket hands each connection to Node's HTTP/1.1 server
(`tlsUpstream.ts` fakes a `TLSSocket` with `alpnProtocol`), which cannot take `h2` frames. Offering `h2` needs
the façade to terminate HTTP/2 itself, or the daemon to accept it on the socket; both are I01 follow-ups with the
WebSocket/SSE/large-upload measurements §6.2 lists.

## Dependencies and FFI

| Crate | Version | Note |
|---|---|---|
| rustls | =0.23.45 | `aws_lc_rs`, `prefer-post-quantum`, `std`, `tls12`; no `logging`, no `ring` |
| aws-lc-rs | =1.18.1 | the provider; also SHA-256 and the signature check |
| aws-lc-sys | 0.45.0 | **native C (AWS-LC, a BoringSSL fork) built by `cc`/`cmake`** |
| rustls-webpki | =0.103.15 | leaf parsing and name coverage only |
| tokio | =1.53.2 | `rt-multi-thread net time io-util sync signal macros` |
| tokio-rustls | =0.26.6 | `LazyConfigAcceptor` to pick the kx config from the ClientHello |
| serde_json | =1.0.151 | keyd frames and the header line |
| dev: rcgen =0.14.10, p256 =0.13.2 | | test certificates; prehash signing in the fake keyd |

Every crate in `Cargo.lock` reachable from this package was published on or before 2026-10-09 (two weeks before
this work); the newer transitive releases (`cc`, `deranged`, `find-msvc-tools`, `libc`, `syn`, `unicode-ident`)
were pinned back with `cargo update --precise`.

**FFI inventory item (plan §5.2):** aws-lc-sys compiles AWS-LC's C and assembly into the binary. It is the only
provider rustls ships with `X25519MLKEM768`; `ring` has no ML-KEM. Needs: the inventory entry with rationale and
review owner, a pinned AWS-LC source hash in the release build, amd64/arm64 cross builds in CI (a C toolchain on
the builder; `cmake` only if the `cc` path is unavailable), size/CPU/memory qualification, and fuzz coverage of
the handshake path. A FIPS build (`fips` feature, aws-lc-fips-sys) would also need Go and cmake on the builder.
License: ISC / Apache-2.0 / MIT / BSD-3-Clause terms, all in `deny.toml`'s allow list (`cargo deny` is not
installed here, so it was not run).

## Commands

```sh
export PATH=/opt/homebrew/opt/rustup/bin:$PATH
cd rust
cargo fmt --all --check
cargo clippy -p flagship-ingress --all-targets -- -D warnings
cargo test -p flagship-ingress
(cd ../installer/tls-frontend && go test ./...)   # the Go frontend, as the behaviour oracle
```

## Left before it can replace flagship-tlsd

1. **keyd `tls.sign` takes a bare digest.** The ingress-side binding stops misuse through rustls, but a
   compromised ingress can still ask keyd to sign any 32/48-byte digest with the TLS key. Close it in keyd: a
   `tls.sign` v2 that takes the structured input (TLS 1.3 context + transcript hash, or TLS 1.2 randoms + ECDHE
   params) and hashes it itself, plus `SO_PEERCRED` so only the ingress user may call it.
2. **Unit file.** `packages/keyd/src/unit.ts` `tlsdServiceUnit` with the binary swapped (`/opt/flagship/…/flagship-ingress`);
   decide whether it keeps the `flagship-tlsd` unit/user names (simplest: same unit, new `ExecStart`). Confirm the
   tokio runtime under `SystemCallFilter=@system-service ~@resources …` and `MemoryDenyWriteExecute=yes` on the
   appliance (AWS-LC does not JIT; tokio needs `epoll`, `eventfd`, `sched_getaffinity`).
3. **Appliance verify script.** `installer/verify-keyd-unit.sh --tlsd` against the new unit, and
   `installer/verify-box-artifact.sh` / the release manifest to carry the Rust binary (static or glibc, amd64 and
   arm64, reproducible) instead of the Go one.
4. **Rollout.** Ship both binaries; a box-side switch (daemon drop-in) picks one; shadow-run the ingress on a
   second loopback port against the same keyd and compare handshakes and header lines; switch the tunnel's dial
   port atomically; keep the Go binary as the rollback until a release passes the live gym `core` group and native
   pin checks. Endorsed box release required.
5. **Plan §11 transport checks** (with N01): large and fragmented hybrid ClientHellos through the relay SNI parser,
   LAN-direct and mobile fallback; WebSocket, SSE, long uploads and slow receivers through the pump; latency of
   IPC-backed signing (one serialized keyd connection today, as in Go; a small pool if measured to matter).
6. **Resumption policy** decision (kept off here; Go resumes) and whether `--kx require-hybrid` is driven by the
   compatibility policy (C01) rather than a flag.
