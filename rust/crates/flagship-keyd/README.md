# flagship-keyd (Rust backend)

A second implementation of the `flagship-keyd` v1 contract defined by `packages/keyd`
(`docs/keyd.md`, IMPLEMENTATION-PLAN.md §6.1). It is not a new key service: the wire format,
operations, field names, error codes and messages, policy, rate limits, audit lines and state files
are the TS service's, so either backend can serve the same `/var/lib/flagship-keyd`. The box still
runs the TS backend; nothing here switches it.

## Run it

```sh
export PATH=/opt/homebrew/opt/rustup/bin:$PATH
cd rust && cargo build -p flagship-keyd
FLAGSHIP_KEYD_STATE=/var/lib/flagship-keyd \
FLAGSHIP_KEYD_SOCKET=/run/flagship-keyd/keyd.sock \
FLAGSHIP_KEYD_ALLOW_UIDS=0 FLAGSHIP_KEYD_ALLOW_GIDS=<daemon gid> \
  target/debug/flagship-keyd serve
```

| Variable | Meaning |
|---|---|
| `FLAGSHIP_KEYD_STATE`, `FLAGSHIP_KEYD_SOCKET` | as in `main.ts` |
| `FLAGSHIP_KEYD_ALLOW_UIDS`, `FLAGSHIP_KEYD_ALLOW_GIDS` | comma lists; a caller passes if its peer uid or primary gid is listed. Unset: uid 0 and keyd's own uid only |
| `FLAGSHIP_KEYD_RATE_LIMITS` | replaces the rate-limit table (`{"op": {"perSecond": n, "burst": n}}`), the TS server's `rateLimits` option |

State read at start: `identity.key` (required), `swk.key`, `cgk.key` (0400 hex, refused if
group/other can read them), `policy.json` (enables `tls.*` and `acme.*`), `tls/<handle>.json`,
`tls/active`, `acme-account.key`. Writes the same files in the same formats and modes, and
`audit.log`.

## Tests

```sh
cargo test -p flagship-keyd                      # unit, TS-source conformance, hostile callers
npx tsc -b packages/keyd packages/server-daemon
npx vitest run packages/keyd/tests/rustBackend.test.ts   # TS clients against this binary
```

`rustBackend.test.ts` runs the TS `KeydClient`, `KeydSyncClient` + `opaqueKey`, and the daemon's
`KeydAcmeIssuer` against the binary (`FLAGSHIP_KEYD_RUST_BIN` or `rust/target/debug/flagship-keyd`;
skipped with a message when absent). It also sends about 95 requests, many malformed, to the TS and
Rust backends and requires identical answers, codes and messages; checks byte-identical Ed25519
signatures, ECDSA TLS/ACME signatures and CSRs (both use RFC 6979, low-S); and moves TLS state
between the two backends in both directions. `tests/conformance.rs` reads `policy.ts`, `wire.ts`,
`acme.ts` and `opaqueKey.ts` and fails if the purpose list, op list, error codes, rate limits,
size caps, derivation labels or ACME hosts drift. Linux-only tests are `#[ignore]`d with a
`linux_` prefix (`SO_PEERCRED` against another uid needs root; the dumpable flag).

## What this adds over the TS backend

- Callers are checked by kernel peer credentials (Linux `SO_PEERCRED`, macOS `getpeereid`)
  before a byte is read; a refusal is audited as `op: "connect"`. Socket permissions still apply.
- `RLIMIT_CORE` 0, and on Linux `PR_SET_DUMPABLE` 0 (also blocks same-uid ptrace).
- Keys sit in zeroize-on-drop types; frame buffers, request arguments and responses are zeroed
  after use. Arguments are never logged.

## Where it deliberately differs (fail-closed)

- ACME URLs: only the canonical form `https://<host>[:443]/<path>[?<query>]` is accepted (host matched
  case-insensitively, no percent-escapes, backslashes, fragments or dot segments).
  The TS backend normalises with `new URL` first and would accept some of those.
- X.509 is parsed by `x509-cert` (RFC 5280 profile), stricter than OpenSSL; a revoke certificate
  must be DER (Node also takes PEM bytes). Granted ACME keys: unencrypted PKCS#8 or SEC1 PEM.
- A TLS key file that does not parse, or whose `spkiHex` does not match its key, is skipped at
  load (the TS backend loads it unchecked). A stale `*.tmp` is removed before a write.
- JSON nesting deeper than 128 or a lone surrogate escape closes the connection (bad frame).
  When one read holds a good frame and then a bad one, the TS backend drops both; this one
  answers the good one first.
- Release builds abort on panic (workspace profile); systemd restarts the unit.

## Still missing

- `flagship-keyd migrate` (and `importLegacy`): run the TS migration; it writes the files this
  backend reads.
- No unit, installer or appliance change; the box default stays the TS binary.
- Not run on Linux yet (privileged tests unrun), not fuzzed, no memory locking (`mlockall`) and
  no hardware sealing. Depends on RustCrypto directly, not yet on `flagship-crypto`.
