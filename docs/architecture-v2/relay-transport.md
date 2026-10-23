# Relay transport: Rust relay, framing extension and conformance (ARCH-N01 / ARCH-N02)

Status: proposed, built on branch `arch/relay` (2026-10-23), not deployed. Code:
`rust/crates/flagship-relay`. Plan: `IMPLEMENTATION-PLAN.md` §5.1 item 7, §11, §14.

The Rust relay is a drop-in for the `.services` data plane (`apps/web/src/tunnel`,
`apps/web/src/lib/addressEcho.ts`): raw-TCP SNI passthrough, the tunnel hub WebSocket at
`/tunnel`, and the PROXY-header echo. TLS still ends on the box; the relay reads TLS record
framing and the ClientHello's `server_name`, nothing else.

## 1. ADR: a negotiated v1 extension, not frame protocol v2

**Context.** Hub-opened streams (visitor ↔ box) have no flow control in v1. The TS hub writes
box DATA to the visitor socket ignoring backpressure and box sockets the same way, so one slow
visitor or one bulk upload can grow memory without bound and one stream can delay every other
stream on the tunnel. The plan requires bounded per-stream credit and fairness, without ever
sending an unknown frame to an old peer (a v1 `decodeFrame` returns an error on an unknown type
and both TS ends then close the tunnel).

**Decision.** Keep the v1 wire format (`u32 streamId | u8 type | u32 len | payload`, 1 MiB
payload cap) and add two capability-gated features:

| Capability | Frame | Direction | Payload | Meaning |
|---|---|---|---|---|
| `stream-credit-v1` | `0x06 STREAM_CREDIT` | both | `u32 BE` bytes, > 0 | Return credit on a hub-opened stream (ids `1..0x7fffffff`) |
| `drain-v1` | `0x05 DRAIN_NOTICE` | hub → box | JSON `{"graceMs":n}` | The hub is going away; reconnect now |

Negotiation: the box lists what it supports in its HELLO as `capabilities: [...]` (a new,
optional field; the TS hub ignores unknown HELLO fields). The hub answers with the subset it
also supports in HELLO_ACK `capabilities`, the field `outbound-v1` / `pb-mail-v1` already use.
A feature is on for a tunnel only when both lists name it. The hub never puts an extension in
the ACK the box did not offer, so an old box never sees one, and an old hub never offers one,
so a new box never uses one against it. Unknown capability strings are ignored both ways.

Credit semantics (the outbound-v1 scheme applied to hub-opened streams):

- Each direction of each stream starts with 256 KiB (`STREAM_INITIAL_WINDOW`). DATA payload
  bytes spend it; the ClientHello DATA the hub sends after OPEN counts.
- A receiver returns credit as its sink drains (the hub: once bytes are written to the
  visitor's socket), batched at ≥ a quarter window. Granted credit above 1 MiB outstanding is
  ignored, as outbound-v1 does.
- DATA past the remaining window is a protocol violation for that stream only: the hub drops
  the visitor and sends `CLOSE`. Credit for an unknown stream is ignored.
- `OUTBOUND_CREDIT` (0x42) keeps its meaning on outbound streams; 0x06 never appears there.

Fairness does not need negotiation (v1 receivers already accept interleaved frames): the hub's
writer sends control frames first, then DATA by deficit round robin across streams (16 KiB
quantum), coalescing at most 64 KiB of frames per WebSocket message.

**Peers without the extension (every deployed box today).** Memory stays bounded anyway:
each stream's visitor-bound queue is capped (256 KiB + one frame) and so is the tunnel's total
(16 MiB). When a queue is full the hub stops reading that tunnel (TCP backpressure to the box)
for at most `slow_receiver_grace` (2 s), then closes the slow stream (`CLOSE` to the box, reset
to the visitor) and resumes. Box-bound bytes are capped per stream and per tunnel; a visitor
waits (its TCP window closes) instead of being buffered.

**Why not v2.** Everything required here fits in two frame types and the existing JSON
capability channel. A v2 header (flags, varint lengths, priorities, a pre-HELLO version
exchange) would need dual stacks on every box, phone-facing fallback and the gym before any
user benefit. Revisit v2 when one of these is needed: TCP half-close (v1 has none: both TS ends
turn a visitor FIN into a full `CLOSE`, so a client that half-closes after its request loses
the reply), frames above 1 MiB, PQ channel binding inside the frame layer, or a QUIC carrier.
QUIC remains an implementation choice for the hub ↔ box carrier, measured against the
WebSocket-over-Fly-TLS carrier, not a new public transport.

**Security notes.** `capabilities` in HELLO is outside the STK-signed envelope. It can only
turn on features both ends implement; stripping it in transit (inside Fly TLS) only falls back
to the v1 bounds. It carries no authority.

**Drain today.** `FRAME_DRAIN_NOTICE` (0x05) is defined in `frames.ts`, but `isFrameType`
leaves it out, so a TS box closes its tunnel on receiving it, and no TS code sends it. The
`fly.toml` comment describing a drain-notice migration describes nothing that runs; rolling
deploys rely on the box's reconnect. `drain-v1` makes the notice real for boxes that opt in;
everyone else just sees the close. Active TCP streams are never claimed to migrate.

## 2. SNI parsing and post-quantum ClientHellos

Real rustls ClientHellos offering `X25519MLKEM768` (a 1216-byte share plus an X25519 share,
1501 bytes, larger than one Ethernet segment) and the same hellos under small record limits
(`max_fragment_size`), checked against `sni.ts` with `node tools/sni-pq-check.mjs` on every
prefix, the way `sniRouter.ts` re-parses after each chunk:

| Hello | Bytes | Records | `sni.ts` (TS router) | Rust |
|---|---|---|---|---|
| rustls classical X25519 | 279 | 1 | routed | routed |
| rustls X25519MLKEM768 + X25519 | 1501 | 1 | **routed at every TCP split** | routed at every TCP split |
| same, 32-byte records | 1776 | 56 | dropped: "handshake length exceeds record" | routed |
| same, 512-byte records | 1511 | 3 | dropped | routed |
| same, 1400-byte records | 1506 | 2 | dropped | routed |
| padded to ~19.5 KB, two 16 KiB records | 19510 | 2 | dropped: peek buffer (16 KiB) exceeded | routed |

So the TS relay handles today's PQ browser hellos (one record, several TCP segments: it
buffers on "incomplete"); it drops any ClientHello split across TLS records, which RFC 8446
§5.1 allows and some stacks and middleboxes do, and any hello over 16 KiB. Before hybrid TLS is
required anywhere, the TS router either needs reassembly or must be replaced.

The Rust parser (`sni.rs`) gives the same result, reason string and `need_at_least` as
`sni.ts` on every single-record input: checked against the real `sni.ts` on the hellos above,
and against `parse_client_hello_ts_compat` (a step-for-step port of `sni.ts`) on 40,000
mutated hellos in `tests/robustness.rs` and in the `sni_parse` fuzz target. It additionally
reassembles a hello across records. It is incremental (linear work however the bytes or records are
sliced) and bounded: 32 KiB raw, 24 KiB hello body, 512 records, a 10 s deadline, at most 4096
hellos being read at once, a non-handshake or empty record refused. "Need more" and "reject"
are distinct results. Under ECH the name it returns is the outer public name; the relay does
not assume it can see an inner name.

The PQ share in these tests is a stand-in of the right size (ring has no ML-KEM, and
aws-lc-rs's licence is outside `deny.toml`); rustls itself builds and frames the hello, which is
all an SNI parser sees. A capture from a current browser is a good addition to the vectors.

## 3. Conformance with the TypeScript relay

R = reproduced (tested), P = partial, L = lacking, X = Rust-only extension.

| Area | TS behaviour | Rust | Notes |
|---|---|---|---|
| Frames | v1 codec, `frames.ts` / `outboundFrames.ts` / `mailFrames.ts` / `peerBackupFrames.ts` | R | Byte-identical against `test-vectors/frames.json` (TS-generated), same refusals; streaming decoder never reserves a declared length |
| Hub | `/tunnel` WebSocket upgrade | R | Plain WS behind Fly's TLS; other paths 404 |
| Hub | Refuse to start as `.services` without signature verification | R | `require_verified_authority` |
| Hub | First frame must be HELLO; `parseHello` checks | R | Same reason strings and close codes |
| Hub | HELLO age, serverId = podCanonical, pod shape, user zone, service-entitlement expiry / username / key binding | R | `hello::structural_checks` |
| Hub | Cert ids (SHA-256), RootEntitlement under admin root or IRK, ServiceEntitlement, STK lookup and binding, HELLO signature, ServiceGrants (signature, window, pod, revocation), revocation list | L | Behind the `HelloAuthority` trait; no implementation in this crate yet (needs `flagship-crypto` and `.com` lookups with the TS cache TTLs) |
| Hub | Eviction ("replaced", fail-open) | P | Hook and refusal path; lookup and 30 s cache lacking |
| Hub | `buildClaimedCanonicals` (own wildcard only, no foreign zone) | R | |
| Hub | HELLO refresh (podCanonical fixed, issuedAt must advance) | R | |
| Hub | DOMAIN_GRANTED snapshots on register / unregister / transfer | R | |
| Hub | REQUEST_TRANSFER | R | Without the TS crash (§4) |
| Hub | Relay blessing + `hubSig` on HELLO_ACK | P | Attached from a `BlessingSource`; hub key, `.com` blessing fetch, refresh and nonce signing lacking |
| Hub | Decode error → `HELLO_ACK{ok:false}` + close 1002 | R | |
| Hub | Tunnel close → visitor streams closed, unregister, snapshots | R | Unregisters only if the closing tunnel is still the registered one (§4) |
| Hub | Idle close when no canonicals | n/a | Dead code in TS (the list always holds the pod) |
| Hub | Outbound relay (`outbound-v1`: DNS, public-address and host policy, budgets, credit, 15-min totals) | L | Not advertised; OUTBOUND_OPEN answered `disabled`, as a TS hub without it |
| Hub | Peer-backup mailboxes (`pb-mail-v1`, PIK-signed announce, `/pb/m/<id>`) | L | Not advertised; frames ignored, as a TS hub without it |
| Registry | Allocator (FCFS slots, candidate queues, heir choice), `findBySni` order, nudge rule, user lookups | R | Rule-for-rule port with unit tests |
| Registry | Custom-domain redirections | P | Table and lookup order; `.com` push channel, cold-start pull and lazy resolver lacking |
| Router | ClientHello peek with size cap and deadline | R+X | Larger bounds, multi-record reassembly, pending-hello cap |
| Router | Drop on no SNI / bad hello, counters | R | |
| Router | Park on miss: single-flight per name, nudge every box of the account, poll, replay | R | Bytes a parked visitor may send are now bounded (TS: unbounded) |
| Router | Delayed drop of first-party misses (timing-indistinguishable), capped | R | |
| Router | Per-account metering and over-quota slow-down, both directions | P | `Meter` trait, token bucket, pause both directions; `.com` report/lease protocol lacking |
| Router | `routerStats` / `GET /api/stats` | P | Counters; missed-name ring and HTTP route lacking |
| Gossip | `broadcast--<user>` POST fan-out to `/internal/gossip` | L | Registry lookup and stream origination exist; the HTTP surface does not |
| Echo | PROXY v1/v2, JSON body, 5 s, buffer cap | R | A non-numeric v1 port is refused (TS answers `null`) |
| Flow | Per-stream credit, fair scheduling | X | `stream-credit-v1`, DRR |
| Flow | Bounded queues, slow-receiver cut for v1 peers | X | TS buffers without bound |
| Drain | Stop accepting, notify, grace, close | X | `drain-v1`; TS has no drain |
| PQ | PQ route and blessing authority bindings (N02) | L | Waits on Q02/Q04 |
| HTTP | `/api/health` and the rest of the `:3000` surface | L | |

## 4. Defects found in the TypeScript relay

1. **A registered box can crash the relay process.** `REQUEST_TRANSFER` with the payload
   `null` makes `handleFrame` read `null.fqdn` outside its `try`; the rejection from
   `void drain()` is unhandled and Node exits with code 1, dropping every tunnel on the
   machine. Reproduced against the real `startTunnelHub` (dev mode) on 2026-10-23. Any
   account owner with one authenticated box can repeat it. Fix: guard `body` before reading
   it, and catch around `drain()`.
2. **A reconnect can be unrouted by the old tunnel's close.** `ws.on("close")` calls
   `registry.unregister(podCanonical)` unconditionally; when a box reconnects before its old
   WebSocket's close fires, the old close removes the new tunnel and its allocator entry.
3. **The drain notice cannot be delivered** (§1).
4. **Unbounded buffering**: visitor writes ignore backpressure; a parked visitor's bytes are
   kept without limit; `ws` accepts 100 MiB messages and every message re-concatenates the
   buffer; no cap on hellos being read at once.
5. Hub stream ids wrap without skipping ids still in use; `accountFromCanonical` hard-codes
   `.flagship.services`, so on the gym apex every account meters as `gym`.

## 5. Tests and how to run them

```sh
export PATH=/opt/homebrew/opt/rustup/bin:$PATH
cd rust
cargo fmt --all --check
cargo clippy -p flagship-relay --all-targets -- -D warnings
cargo test -p flagship-relay              # unit, vectors, SNI/PQ, robustness, relay over sockets

node tools/tunnel-frame-vectors.mjs --check   # TS-generated frame vectors are current
node tools/sni-pq-check.mjs                   # sni.ts on the PQ hellos (table in §2)
FLAGSHIP_WRITE_SNI_VECTORS=1 cargo test -p flagship-relay --test sni_pq   # regenerate hellos

# Fuzzing (nightly + cargo-fuzz; the fuzz crate is its own workspace)
cd crates/flagship-relay/fuzz && cargo +nightly fuzz run sni_parse
```

`tests/relay_core.rs` runs the relay on loopback with real WebSocket boxes and TCP visitors:
routing by SNI across accounts, verbatim ClientHello replay, HELLO refusals, extension
negotiation (a strict v1 box never sees 0x05/0x06), credit in both directions and overrun,
slow-visitor cut without stalling a sibling stream, DRR interleaving under a full tunnel,
cancellation both ways, reconnect, park-and-release with replay, delayed and immediate drops,
the peek deadline, the null REQUEST_TRANSFER, over-quota slow-down, the PROXY echo and drain.

## 6. Next

Implement `HelloAuthority` on `flagship-crypto` with the TS lookups and caches, then the
blessing provider, the outbound relay and mailboxes; the HTTP surface (health, stats, gossip,
mailbox, redirection control); `.com` metering leases; a box-side `stream-credit-v1` /
`drain-v1` in `tunnelClient.ts`; then a mixed-fleet gym run (old and new boxes on one Rust
hub) and the §5.3 benchmarks against the TS relay before any canary.
