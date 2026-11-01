# Relay transport: Rust relay, framing extension and conformance (ARCH-N01 / ARCH-N02)

Status: built on `release/0.3`, qualified locally against the TS hub (§7, 2026-11-01), not deployed. Code:
`rust/crates/flagship-relay` (binary `flagship-relay`, image `Dockerfile.relay`, Fly configs `fly.relay.toml` /
`fly.gym.relay.toml`). Plan: `IMPLEMENTATION-PLAN.md` §5.1 item 7, §11, §14; release plan G7 (R7). Rollout and
rollback: §8.

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

> **Update (fix/relay-fix, merged into `feat/architecture`):** the TypeScript defects in §§2 and 4 are
> fixed there: `sni.ts` reassembles hellos across records (32 KiB / 512 records), frame handlers
> can no longer kill the process, reconnects no longer unregister the new tunnel, DRAIN_NOTICE is
> sent to `drain-v1` boxes on shutdown, and buffering is bounded with backpressure. §§2–4 describe
> the relay as it was before those fixes.

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
| Hub | Cert ids (SHA-256), RootEntitlement under admin root or IRK, ServiceEntitlement, STK lookup and binding, HELLO signature, ServiceGrants (signature, window, pod, revocation), revocation list | R | `DirectoryAuthority` on `flagship_crypto::entitlements` (18 shared vectors) and `ComDirectory` (the TS routes and TTLs); §7 S01/S02 give the TS reason strings |
| Hub | Eviction ("replaced", fail-open) | R | `/api/server/<pod>/eviction-chain`, 30 s cache; §7 S09 |
| Hub | `buildClaimedCanonicals` (own wildcard only, no foreign zone) | R | |
| Hub | HELLO refresh (podCanonical fixed, issuedAt must advance) | R | |
| Hub | DOMAIN_GRANTED snapshots on register / unregister / transfer | R | |
| Hub | REQUEST_TRANSFER | R | Without the TS crash (§4) |
| Hub | Relay blessing + `hubSig` on HELLO_ACK | R | `HubBlessing`: hub key (`FLAGSHIP_HUB_KEY_PATH`), `POST /api/services/hub-blessing` every 12 h, nonce signing; §7 S01 |
| Hub | Decode error → `HELLO_ACK{ok:false}` + close 1002 | R | |
| Hub | Tunnel close → visitor streams closed, unregister, snapshots | R | Unregisters only if the closing tunnel is still the registered one (§4) |
| Hub | Idle close when no canonicals | n/a | Dead code in TS (the list always holds the pod) |
| Hub | Outbound relay (`outbound-v1`: DNS, public-address and host policy, budgets, credit, 15-min totals) | R | `outbound::` (policy on 50 host and 64 address TS verdicts, `ComHostPolicy`); §7 S07 compares refusals; a successful splice to a public host is tested in `tests/outbound_session.rs` only (a local harness has no public address) |
| Hub | Peer-backup mailboxes (`pb-mail-v1`, PIK-signed announce, `/pb/m/<id>`) | R | Shared vectors (`mailbox.json`); §7 S08 |
| Registry | Allocator (FCFS slots, candidate queues, heir choice), `findBySni` order, nudge rule, user lookups | R | Rule-for-rule port with unit tests |
| Registry | Custom-domain redirections | P | Table and lookup order only. The push channel, cold-start pull and lazy resolver are Pro (`feat/custom-domains`) and stay unported by decision |
| Router | ClientHello peek with size cap and deadline | R+X | Larger bounds, multi-record reassembly, pending-hello cap |
| Router | Drop on no SNI / bad hello, counters | R | |
| Router | Park on miss: single-flight per name, nudge every box of the account, poll, replay | R | Bytes a parked visitor may send are now bounded (TS: unbounded) |
| Router | Delayed drop of first-party misses (timing-indistinguishable), capped | R | |
| Router | Per-account metering and over-quota slow-down, both directions | R | `UsageMeter` (`/api/usage/report`, budget leases, LeaseBook port); §7 S06 |
| Router | `routerStats` / `GET /api/stats` | R | Route (x-usage-secret), counters, `recentMisses` (last 20, `no-box-registered` / `hold-timeout`) and the `serving` block (with `phoneRoutes`); §7 S19 |
| Gossip | `broadcast--<user>` POST fan-out to `/internal/gossip` | L | Dropped by owner decision (2026-10-30): never formed live (AGENTS "One access list per app") |
| Echo | PROXY v1/v2, JSON body, 5 s, buffer cap | R | A non-numeric v1 port is refused (TS answers `null`) |
| Flow | Per-stream credit, fair scheduling | X | `stream-credit-v1`, DRR |
| Flow | Bounded queues, slow-receiver cut for v1 peers | R+X | TS bounds and back-pressures since fix/relay-fix; §7 S12 (a stalled visitor never stalls a sibling) |
| Drain | Stop accepting, notify, grace, close | R | `drain-v1` on both; both keep serving until every tunnel has gone or the grace ends, then close 1012; §7 S10 |
| PQ | PQ route and blessing authority bindings (N02) | L | Waits on Q02/Q04 |
| HTTP | `/api/health`, `/api/stats`, `/pb/m/<id>` on the hub port | R | `/api/health` adds `runtime: "rust"` (how the canary tells the two apart); §7 S06, S08, S17 |
| Serving | Serving gate: `servingAdminKey` / `servingPolicy` in HELLO, `.com` record (`/api/internal/serving/:u/:boxPub`), `servingDecision`, app streams closed at `until`, control name stays, apps stopped hold no slot | R | `serving.rs` on `flagship_crypto::serving` (shared vectors); §7 S13–S15 |
| Serving | Pushed revocation feed (`/api/internal/serving-feed`, acks, gap catch-up), contact rules (no new tunnels after 60 s quiet, close all after 10 min) | R | `serving_feed.rs` (tokio-tungstenite over tokio-rustls with webpki roots); §7 S14, S16 |
| Registry | A box's control name is never an app slot (H9); the bare `<account>.<apex>` never resolves to a box | R | The phone route itself is not ported (§7 gaps) |
| Phone | `/phone-tunnel`, vacancy-only claims, `route-held` + standby, `route-vacant` across instances (feed push + 15 s ledger re-read), `route-release/v1`, admin-grant eligibility from `.com`, revocation → 4403 | R | `phone.rs` (claim/release checked against `test-vectors/phone-route`); §7 P01–P06 |

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

After the canary (§8): a box-side `stream-credit-v1` in `tunnelClient.ts`; the §5.3 benchmarks against the TS relay; PQ route and blessing
bindings (N02, waiting on Q02/Q04).

## 7. Conformance harness (both implementations)

`tools/relay-conformance/tests/relayConformance.test.ts` runs one scenario list against the TS hub (`server.ts`
`start()` in process) and the Rust binary (spawned), both pointed at one mock `.com`
(`tools/relay-conformance/harness.ts`) that serves the internal routes the TS hub uses: `/api/username/<u>`,
`/api/cert-revocations/<u>`, `/api/server/by-domain/<id>`, `/api/server/<pod>/eviction-chain`,
`/api/services/hub-blessing`, `/api/usage/report`, `/api/outbound/check|report`, `/api/internal/serving/<u>/<box>`,
`/api/internal/serving-revocations` and the `/api/internal/serving-feed` WebSocket. Both relays get the same
environment (`PORT`, `TUNNEL_TCP_PORT`, `RELAY_ECHO_PORT`, ...); the lost-contact thresholds are shortened with
`FLAGSHIP_SERVING_REFUSE_NEW_MS`, `FLAGSHIP_SERVING_CLOSE_ALL_MS`, `FLAGSHIP_SERVING_CHECK_MS` (both read them;
unset in production). Each scenario asserts the same answer on both: ack reasons verbatim, close codes, bytes.

| Id | Scenario |
|---|---|
| S01 | HELLO admission; capabilities; `hubSig` over the nonce verifies under the blessed hub key; `.com` asked on the TS routes |
| S02 | Refusals: no HELLO, not JSON, unknown server, wrong STK signature, entitlements not under the IRK, stale HELLO, a claim in another account's zone, a revoked root entitlement (same reason strings and close codes) |
| S03 | Routing by SNI (control name, `<app>.<user>`, `<app>.<server>.<user>`), ClientHello and later bytes verbatim both ways (70 KB reply), closes both ways |
| S04 | Unknown name, the account's bare name, no TLS: closed, nothing opened on the box |
| S05 | `:8444` echo, PROXY v1 and v2: identical JSON |
| S06 | Usage reported per account; an over-quota lease slows the account; `/api/stats` guarded by `x-usage-secret` |
| S07 | Outbound: loopback, a forbidden port, metadata hosts refused with the same codes; `FLAGSHIP_OUTBOUND_RELAY=off` → not advertised, `disabled` |
| S08 | Peer-backup mailbox: PIK-signed announce, `POST /pb/m/<id>` carried to the box and back; unknown id 404 |
| S09 | Eviction: a retired STK is answered `replaced` (1008) |
| S10 | Drain: `drain-v1` box gets `DRAIN_NOTICE {graceMs}`, a v1 box nothing; no new tunnels; all closed 1012 after the grace |
| S11 | Reconnect: the old tunnel's close leaves the new one routed; HELLO refresh replay refused, advance accepted |
| S12 | A visitor that never reads (8 MiB queued) does not stall a sibling stream; the relay stays healthy |
| S13 | Serving: matching admin key serves; differing key refused `admin-keys-differ` (1008); no key → control name only |
| S14 | Serving feed: a pushed box revocation ends the tunnel and its routes and is acked; a revoked box is refused; a gap is filled from `serving-revocations?since`; an entry under another key is ignored |
| S15 | Lease end: the app stream closes within 5 s of `notAfter`, the control stream keeps flowing, the app name stops routing, the control name still routes |
| S16 | Feed contact: quiet past the first threshold → new HELLO answered `try-again` (1013); past the second → every tunnel closed 1013 `serving-feed-lost`; the feed back → tunnels accepted |
| S17 | `/api/health` |
| S18 | Outbound success: an allowed host whose (faked) public address is dialled on 443; bytes both ways through the splice |
| S19 | `/api/stats` `recentMisses` names a `no-box-registered` miss |
| P01 | Phone route: an eligible phone claims the vacant bare name (generation 1); a visitor and its presence bytes reach it verbatim; `holding` on a second begin |
| P02 | Refusals: `not-eligible` (a non-admin grant, an unknown key), `bad-signature`, `wrong-generation`, `no-challenge` (nonce reused), `not-holder`, `malformed`; nothing routes |
| P03 | Vacancy-only: a second phone gets `route-held` with the holder's generation and waits; the holder leaving → `route-vacant`, claim → generation 2; signed release (`released`, `lost released`), wrong-generation release refused |
| P04 | The holder's admin grant revoked (`phone-eligibility` push) → closed 4403 and its visitor stream ended within 5 s |
| P05 | Two relays, one ledger: the standby on the other relay gets `route-vacant` from the feed push; the other relay never routes a name it does not hold |
| P06 | The same with the push lost: the standby relay's 15 s ledger re-read tells it (< 17 s) |
| M01 | Mixed versions: the current daemon tunnel client (`superviseTunnelClient`, no new capabilities) registers and serves (`<pod>`, `<app>.<user>`) |
| M02 | Relay restart on the same address: the box reconnects by itself |
| M03 | Rollback and forward: the same box moves Rust → TS (and TS → Rust) across a drain with no change on the box |

Run: `cargo build -p flagship-relay --bin flagship-relay --features conformance` then `npx vitest run tools/relay-conformance` (the Rust half
is skipped, and says so, without the binary; `FLAGSHIP_RELAY_BIN` points elsewhere). `bash scripts/relay-canary.sh
local` runs both steps plus `cargo test -p flagship-relay`.

S18 fakes the provider's public address: the Rust binary built with the test-only `conformance` cargo feature reads
`FLAGSHIP_OUTBOUND_CONFORMANCE_UPSTREAM=<host>=<public ip>=<local ip:port>` (the release image never enables the
feature, so production has no such variable); the TS hub, in process, gets the same mapping by patching `dns.promises.lookup`
and `net.connect` in the test process only. Every policy rule still runs on the public address.

Not covered by the harness: custom-domain redirections and gossip (not ported, above), `stream-credit-v1` (Rust only;
`tests/relay_core.rs`).

## 8. Rollout and rollback

The Rust relay is a drop-in image for the same Fly app: same ports, same `[env]`, same secrets
(`SERVICES_CONTROL_SECRET`, `USAGE_REPORT_SECRET`), same `.com` routes. Boxes need nothing: they redial the same
address after a deploy (M02), and a `drain-v1` box redials at the notice. A rollback is the same move the other way
(M03). Steps (`scripts/relay-canary.sh` prints them; `gym --run` runs the gym ones with a prompt before each):

1. **Local**: `bash scripts/relay-canary.sh local` green on the commit to ship (cargo test, the §7 suite on both).
2. **Gym canary** (the gym relay app is the canary; prod untouched): `GYM_RELAY=rust bash scripts/gym-refresh.sh`
   deploys `fly.gym.relay.toml`; `tools/relay-conformance/live-check.ts --expect rust` confirms which relay answers
   (`/api/health` `runtime`) and the `:8444` echo; then a kept mixed fleet (`shared-run.ts --groups
   core,gating,enforcement,one-list,serving,backups,ai-chat,update --keep`: B3 runs main's daemon, the other boxes
   this release). Rollback drill with the fleet up: `flyctl deploy -c fly.gym.toml` (Node, rolling) →
   `live-check.ts --expect ts --fleet <fleet.json>` (every box answers again, untouched) → forward again with
   `fly.gym.relay.toml` → `live-check.ts --expect rust --fleet ...` → `core` on the kept fleet → teardown.
3. **Prod** (owner, from `main`, never `--strategy=immediate`): `flyctl deploy -c fly.relay.toml -a flagship-services
   --strategy=rolling`; `live-check.ts --relay flagship-services.fly.dev --expect rust`; the release script's relay
   echo check; watch `npm run ops -- services` (tunnels online back to the pre-deploy count) for 30 minutes.
4. **Rollback**: `flyctl deploy -a flagship-services --strategy=rolling` (the default `fly.toml` + `Dockerfile`).
   Nothing else changes: no box, no `.com`, no DNS.

Before step 3: `.com` must serve the serving feed if `FLAGSHIP_SERVING_REVOCATION_PUB` is set (both relays then fail
closed without it); the phone route rides on it on both relays (`FLAGSHIP_PHONE_ROUTE=off` turns it off on both).
