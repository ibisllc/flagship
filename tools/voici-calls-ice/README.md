# voi.ci call ICE harness

Drives the phone's TURN responder (`rust/crates/flagship-turn-lite`, through `examples/turn_harness.rs`) with real
Chrome WebRTC on both ends, on this machine:

- **caller**: what the voi.ci page does (`packages/flagship-web/src/call.js`): `iceTransportPolicy: "relay"`, no ICE
  server until the answer arrives, then our TURN server as its only one;
- **phone stand-in**: a peer connection with no ICE servers whose one UDP host candidate is the TURN server's only
  permitted peer (the phone's own peer connection).

`--loopback` makes the caller see exactly what it sees on a phone: the relayed address and the peer are `127.0.0.1`
(the harness translates, since Chrome never gathers a loopback candidate). `--v6-candidate` adds the phone's extra
`::1` host candidate (refused by the responder with 403, as on the phone). `--video` adds a video track (a canvas).
TURN runs over plain TCP here; on the phone it is the same byte stream inside TLS.

```sh
cargo build --example turn_harness -p flagship-turn-lite        # in rust/
node tools/voici-calls-ice/run.mjs --ip <this machine's LAN IPv4> --loopback --v6-candidate [--video] [--rate 8000]
```

It prints both sides' ICE/DTLS states and audio bytes, then the mix the responder saw (STUN method/class, DTLS, RTP,
RTCP each way). PASS = ICE connected and audio both ways. `PLAYWRIGHT_FROM=<dir with node_modules>` and
`CARGO_TARGET_DIR` let a worktree without its own `node_modules` or `target/` use another one's.

A healthy 8-second audio run's mix (compare with the phone's `turn mix:` log lines, category `calls`):
binding requests and `c=2` successes both ways (6-7 each), one Allocate (401, then success), one CreatePermission,
one ChannelBind, a few DTLS records, then about 50 RTP packets a second each way on channel 0x4000.

Result 2026-11-16 (Chrome for Testing 1217, release/0.4): PASS for audio, audio + video, rates 8,000 and 320,000
B/s, with and without `--loopback` and `--v6-candidate`. So turn-lite and the browser are not what fails on the
phone; see `docs/voici-calls.md` "As built: media" and the release journal for the phone-side diagnosis.
