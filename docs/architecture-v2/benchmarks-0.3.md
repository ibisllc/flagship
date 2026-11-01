# 0.3 benchmarks and completion evidence (G10)

Measured 2026-11-01 for release plan G8/G10 (`RELEASE-0.3-JOURNAL.md`, Appendix G section 5;
`IMPLEMENTATION-PLAN.md` §5.3). Numbers are what these runs measured on these machines, nothing more. They are
inputs for the §5.3 budgets, not a ratification of them.

## How to rerun

| Script | What it does |
|---|---|
| `scripts/bench/run-vm.sh --phases build,test,fuzz,artifact` | A throwaway UpCloud VM (`bench-g10-*`, deleted at the end): builds every box Rust binary for x86_64 and aarch64, `cargo test` natively and for aarch64 under qemu-user, bounded cargo-fuzz runs, both box artifacts (signed with a throwaway key, verified by `build.ts verify` and `installer/verify-box-artifact.sh`) |
| `scripts/bench/run-vm.sh --phases bench --bins <dir>` | The benchmarks below on a 2-vCPU / 4 GiB amd64 VM (the §5.3 guest) |
| `scripts/bench/arm64-local.sh --bins <dir>` | The same benchmarks on native arm64: Debian 13 arm64 under QEMU with Apple's hypervisor on an Apple-silicon Mac, 2 vCPU / 4 GiB |
| `scripts/bench/startup.ts` | Each Rust service from spawn to ready (socket or "listening" line), cold (page cache dropped, Linux root) and warm (median of 10); then all six running together: idle CPU over 60 s and RSS |
| `scripts/bench/relay.ts` | TS relay (`apps/web/dist/server.js`, its own process) vs `flagship-relay`, against the relay-conformance mock `.com`, one box with a real signed HELLO, visitors with a TLS ClientHello |
| `scripts/bench/access.ts` | TS access decision (in process: `ServiceAccessStore` + `prepareAppRequest`) vs the `flagship-access` binary over its socket (`brokerCall`, one connection per decision, so IPC and the per-call file reads are included); every answer is checked against the 90 shared vectors first |
| `scripts/bench/ingress.ts` | A fake keyd and the real TS daemon proxy code in a child process; `ts` = Rust ingress forwarding to the daemon's TS app proxy, `go` = `flagship-tlsd` then the same TS proxy, `rust` = ingress `--proxy-decide` (TS decides, Rust carries bytes) |

Raw JSON lines and logs: `gym-results/bench-g10-*` on the machine that ran them (not committed).

## Machines

- **amd64**: UpCloud `2xCPU-4GB`, us-nyc1, AMD EPYC 7542 (2 vCPU), 3.8 GiB, Debian 13, kernel 6.12.113+deb13-amd64.
- **arm64**: Debian 13 genericcloud arm64 (kernel 6.12.113+deb13-cloud-arm64), QEMU `-accel hvf -cpu host`, 2 vCPU,
  4 GiB, on an Apple M4 Mac (16 GiB). A virtualised Apple core, not an arm64 server; compare arm64 rows with each
  other, not with amd64.
- Build/test/fuzz: UpCloud `8xCPU-32GB`, us-nyc1, Debian 13.
- Binaries: release builds of the working tree of `release/0.3` on 2026-11-01, `cargo build --release --locked
  --target <triple>`; aarch64 cross-built on the amd64 VM with Debian's aarch64 GNU toolchain.

The load generator is one Node process on the same VM. Where it saturates first (all handshake rates, the TS relay's
download), the figure is a lower bound for both implementations and says nothing about which is faster.

## Rust services: startup, idle CPU, RSS (`startup.ts`)

Ready = spawn to socket (keyd, broker, core, access) or "listening" line (ingress, relay); every path in a temp dir.
Cold = first start after `drop_caches` (root); warm = median of 10. Idle = all six running together for 60 s.

| Service | amd64 cold / warm (ms) | arm64 cold / warm (ms) | idle CPU amd64 / arm64 | idle RSS amd64 / arm64 (MiB) |
|---|---|---|---|---|
| keyd | 21.7 / 3.5 | 18.3 / 0.8 | 0 % / 0 % | 3.5 / 3.0 |
| broker | 15.0 / 3.5 | 8.8 / 0.7 | 0.33 % / 0.12 % | 5.4 / 4.4 |
| core (`serve`) | 12.9 / 4.5 | 9.7 / 1.0 | 0 % / 0 % | 4.8 / 3.9 |
| access | 7.5 / 2.4 | 2.2 / 0.3 | 0 % / 0 % | 2.0 / 1.8 |
| ingress | 17.0 / 5.6 | 5.2 / 1.6 | 0 % / 0 % | 3.9 / 3.2 |
| relay | 10.8 / 2.3 | 6.6 / 0.5 | 0 % / 0 % | 5.4 / 4.5 |
| **all six, total RSS** | | | | **25.0 / 20.9** |

Against §5.3's "new Rust trusted processes, combined steady RSS ≤ 128 MiB": 25 MiB idle on amd64. This is idle with no
apps, no certificate in keyd and an empty core journal; loaded RSS of a populated box is not measured. The broker's
small idle CPU is its own periodic work (not investigated further). Not measured here: the whole box's boot by phase
(LUKS unlock, network, daemon start), the TS daemon's idle CPU, and so the "two-minute startup" and "25 % CPU" inputs
remain uninvestigated; that needs a real arch-v2 box with a journal (gym), not process-level timing.

## Relay: TypeScript hub vs `flagship-relay` (`relay.ts`)

One box tunnel; 500 stream opens; 5,000 echo round trips of 64 B on one stream; 512 MiB down (box → visitor, 64 KiB
DATA frames) and up (visitor → box) through one stream. CPU and peak RSS are the relay process's over the whole run.

| Metric | amd64 TS | amd64 Rust | arm64 TS | arm64 Rust |
|---|---|---|---|---|
| start to listening | 581 ms | 20 ms | 233 ms | 3 ms |
| idle RSS (one box attached) | 132.7 MiB | 6.1 MiB | 128.2 MiB | 5.3 MiB |
| stream open p50 / p95 / p99 | 0.38 / 0.84 / 1.39 ms | 0.28 / 0.41 / 0.68 ms | 0.10 / 0.26 / 0.55 ms | 0.08 / 0.12 / 0.28 ms |
| echo RTT 64 B p50 / p95 / p99 | 0.12 / 0.16 / 0.29 ms | 0.10 / 0.14 / 0.18 ms | 0.052 / 0.064 / 0.081 ms | 0.050 / 0.060 / 0.075 ms |
| download, one stream | 108 MiB/s | 254 MiB/s | 170 MiB/s | 566 MiB/s |
| upload, one stream | 340 MiB/s | 565 MiB/s | 979 MiB/s | 1,737 MiB/s |
| relay CPU over the run | 5.93 s | 1.24 s | 1.76 s | 0.39 s |
| peak RSS | 260.9 MiB | 7.3 MiB | 255.4 MiB | 6.7 MiB |

The TS figure is the production entry (`apps/web/dist/server.js` under plain Node 24.22.1). Throughput is bounded by
the single-process Node load generator as well as by the relay, so the ratios are lower bounds on the difference.
This is the relay as a process on one machine: it says nothing about the missing G7 functions (HelloAuthority
lookups, outbound relay, mailboxes…) or about Fly networking.

## App proxy path: ingress modes (`ingress.ts`)

`ts`: Rust ingress terminates TLS and hands the stream to the daemon's TS app proxy, which forwards to the app.
`go`: `flagship-tlsd` instead of the Rust ingress, same TS proxy. `rust`: ingress `--proxy-decide` (TS still decides
per request over the socket) and carries the bytes to the app itself. Fake keyd in Node (one P-256 sign per
handshake); backend a Node HTTP server; 1 KiB GET; bulk = 64 MiB GET, median of 5.

| Metric | amd64 ts | amd64 go | amd64 rust | arm64 ts | arm64 rust |
|---|---|---|---|---|---|
| handshake p50 / p99, 1 client | 1.65 / 2.06 ms | 1.67 / 2.17 ms | 1.68 / 1.98 ms | 0.55 / 0.64 ms | 0.55 / 0.60 ms |
| handshakes/s, 16 clients | 779 | 790 | 805 | 2,333 | 2,374 |
| new conn + GET p50 / p95 / p99, 1 client | 2.46 / 2.94 / 4.74 ms | 2.53 / 2.94 / 4.42 ms | 2.16 / 2.42 / 2.90 ms | 0.78 / 1.44 / 2.84 ms | 0.70 / 0.76 / 0.86 ms |
| requests/s, 16 clients | 697 | 631 | 741 | 2,227 | 2,247 |
| bulk 64 MiB | 201 MiB/s | 306 MiB/s | 645 MiB/s | 726 MiB/s | 2,020 MiB/s |
| frontend peak RSS | 10.2 MiB | 14.8 MiB | 11.2 MiB | 10.7 MiB | 11.4 MiB |
| daemon (TS) RSS at end | 307 MiB | 296 MiB | 263 MiB | 320 MiB | 262 MiB |

Handshake rates are the same for all three: the single Node client and the Node fake keyd's signing bound them, so
they do not compare the frontends. Go was not available on the arm64 guest. The daemon RSS includes the fake keyd and
the backend app (same child process). Against §5.3 "no > 10 % p95 regression": the Rust proxy path is at or below the
TS path on every latency row measured here.

## Access decisions (`access.ts`)

The 90 "box"-fixture cases of `packages/protocol/test-vectors/access-enforcement/decisions.json`, round-robin, 20 s per
run after 3 s warm-up, 1 and 8 concurrent callers. TS = in process (what the daemon does today); Rust = the
`flagship-access` binary over its socket as the daemon would call it (`brokerCall`: connect, hello, decide), and
"persistent" = 8 reused connections, which isolates the connect cost. Each Rust decision re-reads the access state and
the session file (by design: only the file counts), so the number is IPC + two file reads + the decision.

| Metric | amd64 TS | amd64 Rust | amd64 Rust persistent | arm64 TS | arm64 Rust | arm64 Rust persistent |
|---|---|---|---|---|---|---|
| 1 caller p50 / p95 / p99 (µs) | 14 / 21 / 36 | 248 / 323 / 456 | 160 / 182 / 202 | 4.5 / 6.1 / 9.7 | 76 / 97 / 114 | 58 / 66 / 77 |
| decisions/s, 1 caller | 69,589 | 3,946 | 6,714 | 225,470 | 12,795 | 18,076 |
| 8 callers p50 / p95 / p99 (µs) | 107 / 169 / 200 | 1,350 / 2,406 / 3,789 | 585 / 1,271 / 1,991 | 34 / 51 / 56 | 304 / 534 / 747 | 195 / 400 / 565 |
| decisions/s, 8 callers | 72,555 | 5,452 | 11,920 | 232,614 | 24,214 | 36,189 |
| server RSS idle / peak | (in the daemon) | 2.0 / 5.4 MiB | | (in the daemon) | 1.9 / 5.1 MiB | |

This is the one place where the Rust path is clearly slower: an out-of-process authority costs about 0.15-0.25 ms
per decision on the amd64 guest against 14 µs in process. It is a decision per request (not per byte), well under the
§5.3 "management p95 ≤ 1 s", and it buys the effect-boundary isolation G5 asks for; but if `FLAGSHIP_ACCESS_AUTHORITY=rust`
becomes the default, a persistent connection and caching the parsed files by mtime are the obvious optimisations
(§5.1: a disappointing benchmark triggers optimisation, not removal). Every answer was checked against the vectors
before timing; the first run of this bench found that the socket path disagreed with the contract (below).

**Found by this bench and fixed** (`flagship-access/src/server.rs`): the socket handler lower-cased the session's aid
read from the session file before deciding, so the binary admitted a session whose key was upper-case hex, which the
shared vector "a session whose key is not lower-case hex is anonymous" refuses (the in-process vector test bypassed
the file read). Now kept as written; a socket-path test covers it.

## Tests on both architectures

- **x86_64**: `cargo test --locked --no-fail-fast --workspace --target x86_64-unknown-linux-gnu` green on the
  8-vCPU VM, both runs (incl. the new crash tests and the access fix). Locally (macOS arm64) the workspace minus
  `flagship-relay` passes 599 tests and clippy is clean.
- **aarch64**: the same suite, cross-built, under qemu-user: everything passes except 5 test targets, all of which then
  pass **natively** on the arm64 guest (`arm64-local.sh --tests`, the very same executables): `flagship-broker` lib
  (18), `appdata_files` (5), `typed_authority` (14), `flagship-wasi` `http` (10), `flagship-relay` `binary` (2). The
  qemu-only failures are emulation limits: the broker's descriptor-relative file handling under qemu-user answers
  ENOENT, and tests that spawn a binary with `env_clear()` lose `QEMU_LD_PREFIX`, so the aarch64 loader is not found.
  The first aarch64 run also failed `flagship-boot`'s `cli` tests for that loader reason; with the prefix set they pass.
- Test hygiene found on the way: when `worker_process_checks_serves_and_takes_its_secrets_from_the_box` fails, it
  leaves its spawned `flagship-wasi-worker` running (the child is not killed on panic); under qemu that orphan held the
  test pipe open and hung the run until killed by hand. Harmless natively, but a kill-on-drop guard would be cleaner.
- Both box artifacts were built from the same tree (`build.ts build --arch amd64|arm64` on the amd64 VM, arm64
  cross-built), signed with a throwaway key and accepted by `build.ts verify` and by the bootstrap's
  `installer/verify-box-artifact.sh`. Every native binary inside is the right ELF machine (Node, `flagship-tlsd`,
  `flagship-unseal` and the 8 Rust binaries); `build.ts` now refuses the build otherwise. amd64 96.2 MB, arm64 93.6 MB.
  Release build time on 8 vCPU: x86_64 154 s, aarch64 (cross) 125 s.

## Fuzzing

`cargo +nightly fuzz` with libFuzzer + ASan. Run 1 and 2 on the 8-vCPU amd64 VM (240 s and 120 s per target); the
re-runs after the fixes on this Mac (aarch64-apple-darwin, nightly), because the gym held 30 of the account's 32
UpCloud cores by then.

| Target | Run 1 (240 s) | Run 2 (120 s) | After the fixes |
|---|---|---|---|
| relay `frame_decode` | 7.49 M execs, clean | 4.93 M, clean | |
| relay `payload_parse` | 2.67 M, clean | 1.53 M, clean | |
| relay `sni_parse` | 15.20 M, clean | 6.69 M, clean | |
| `ingress_request_head` | 5.20 M, clean | 3.15 M, clean | |
| `ingress_response_head` | 5.49 M, clean | 2.93 M, clean | |
| `ingress_chunked` | 7.90 M, clean | 4.25 M, clean | |
| `broker_tarcheck` | 2.31 M, clean | 1.19 M, clean | |
| `access_path` | 4.89 M, clean | 3.11 M, clean | 17.34 M in 300 s, clean |
| `access_origin` | **crash** (control char in host) | **crash** (unbracketed `:`/`[` in host) | a third (U+00A0 in host) in the first local run; after its fix 21.95 M in 600 s, clean |

The three `access_origin` crashes were idempotence failures of `normalize_origin` (`flagship-access/src/origin.rs`),
not memory errors; fixed by accepting only printable-ASCII authorities and no `:`/`[`/`]` in an unbracketed host, which
fails closed (no origin counts as cross-origin) and matches the TS twin. Details in `unsafe-audit.md` §3; the inputs
are corpus seeds. The bounded runs above are smoke-level (minutes, not CPU-days); continuous fuzzing (OSS-Fuzz or a
CI cron) is not set up.

## Crash / power-loss

`rust/crates/flagship-updater/tests/crash.rs` starts the real `flagship-updater` for `install` (6 MiB release) and
`restore` and SIGKILLs it at 24 and 12 evenly spaced points, then runs `reconcile`: exactly one complete release is
current and the state files name it, no `.incoming-*` folder or unfinished intent survives, the sequence never goes
down, and rerunning the interrupted command completes; a third test feeds every truncated prefix of the intent file
and a torn `artifact-current.json`. `rust/crates/flagship-core/tests/kill.rs` SIGKILLs a child controller writing
journal entries at 0-150 ms: the lock is free, the term rises, every write the child acknowledged survives, and
handover + reconcile replay the open intents to convergence with no duplicate effect. Green on x86_64 (VM), on aarch64 under qemu-user, and locally (macOS arm64).
Not covered: real power loss (the page cache survives a SIGKILL; no fsync-ordering test under a dropped block
device), and a kill of the whole box mid-update (the gym `update` group covers the happy path only).

## What remains unproven

- Whole-box numbers: boot by phase, the TS daemon's idle/loaded CPU, a populated box's RSS, and the "two minutes" and
  "25 % CPU" figures; the §5.3 commodity bare-metal and GPU hosts.
- arm64 on real hardware or a cloud arm64 server (UpCloud has none): numbers here are a virtualised Apple core.
- An arm64 box installed from the signed arm64 artifact (built, signed and verified here; never booted as a box).
- The relay as a replacement service (G7), mixed-version and rollback runs, production qualification.
