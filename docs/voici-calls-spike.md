# voi.ci calls: transport spike (2026-11-08)

Status: measurement, not a design. It answers one question for the owner: a voi.ci visitor calls the page owner's
phone, audio only, over the phone's bare name (`<user>.flagship.services`: SNI passthrough on the relay, TLS ending
on the phone), with `.com` only arranging the call. Which media path, A or B?

- **A**: WebRTC. The browser's only ICE server is `turns:<user>.<apex>:443?transport=tcp`, and the phone answers it
  with its own TURN responder and its own WebRTC stack.
- **B**: our own frames. WebCodecs Opus, sealed with AES-GCM, one frame per WebSocket message to
  `wss://<user>.<apex>/api/phone/call`.

Owner rule for the choice (2026-11-08): if both are equally secure, in a way that supports the claim "quantum-safe
calls" (including the subtle parts, such as constant bitrate), take the one that is the more robust and gives the
better quality.

Harness: `tools/spikes/voici-calls/` (README there). Raw results: `tools/spikes/voici-calls/results/`.

## 1. Setup and its limits

- Chromium 153.0.8010.12 headless (Playwright), on Linux, at both ends. No Safari, Firefox, iOS or Android yet.
- The relay is a stand-in: raw TCP routed by SNI, bytes untouched. TLS ends on the "phone": a Node TLS server for B,
  and coturn for A, standing in for the TURN responder the phone would run itself.
- The network is emulated in userspace (no netem in this kernel): two network namespaces joined by TUN devices, with
  one-way delay, uniform jitter (order kept), uniform random loss and periodic outages. TCP on it sees a real RTT and
  real retransmissions. It is **one** lossy TCP leg. The real path has two (browser→relay, relay→phone tunnel), or
  three with a mesh hop (§5), and real cellular loss is burstier.
- The speech is synthetic (talk spurts of voiced syllables and pauses), 45 s per run, audio both ways at the same
  time. Every frame is sealed with AES-256-GCM under a fixed test key (in the product, the key comes from an X-Wing
  exchange in the signed call set-up).
- For a like-for-like comparison, both options run the same simple adaptive playout buffer over the measured
  per-frame arrival times ("sim"). A also reports Chrome's own buffer (NetEq), which is what a user would hear. B
  has no real playout engine yet; its numbers are the simulated buffer.

## 2. Security results

| Check | A (WebRTC over TURNS to the phone) | B (own frames over WebSocket) |
|---|---|---|
| Constant frame size, talking or silent | `cbr=1;usedtx=0` in the SDP: **exactly 60 bytes every 20 ms** (default: 3-161 bytes) | WebCodecs `bitrateMode: "constant"`: **exactly 60 bytes** (variable: 3-121 bytes) |
| Audio-level header (a per-packet loudness value) | present by default; **removed from the SDP**, and the call still works | none |
| Our own PQ layer per frame (X-Wing key) | works: an encoded transform sealed and opened every frame, both ways (`createEncodedStreams`; `RTCRtpScriptTransform` also present) | works (it is the whole design) |
| The key exchange under it | DTLS 1.3 (`FEFC`). Chrome offered and **chose X25519MLKEM768** (captured and decoded, `results/dtls-groups.json`) | TLS to the phone; Chrome offers X25519MLKEM768, and the phone's TLS stack decides |
| Outer TLS to the phone, through the relay | Chrome sends **SNI** to a `turns:` server (no ALPN) and offers X25519MLKEM768 | SNI plus ALPN `http/1.1`, offers X25519MLKEM768 |
| Certificate check | Chrome **checks the TURNS certificate**: right name + trusted CA connects, wrong name is refused | normal WebPKI check |
| What the relay sees | TLS records of constant size and rate | the same |

Conclusion: equal. Both can meet a "quantum-safe calls" claim as long as the claim rests on our own X-Wing frame
layer, which is under our control on every platform, plus constant bitrate. A additionally gets a hybrid DTLS key
exchange when both ends' WebRTC supports it (Chrome to Chrome here; the phones' libwebrtc version has to be checked).
In A the RTP headers (sequence number, timestamp, SSRC) are not encrypted, but they travel inside the TLS to the
phone, so the relay never sees them.

## 3. Quality results (45 s, both directions)

One-way network delay of the frames (ms, p50 / p95 / p99). It is the same for A and B, because both run over the
same TCP link:

| Link (one-way delay, jitter, loss) | A | B |
|---|---|---|
| good (40 ms, ±5, 0%) | 41 / 46 / 47-54 | 41 / 45 / 46 |
| typical (60 ms, ±10, 1%) | 63 / 125-149 / 198-212 | 62-63 / 112-166 / 196-223 |
| lossy (60 ms, ±10, 3%) | 66 / 191-204 / 218-291 | 64-65 / 195-199 / 233-236 |
| far (100 ms, ±15, 1%) | 106-107 / 274-305 / 345-358 | 105 / 280-291 / 352-365 |
| handover (60 ms, ±10, 1%, 300 ms outage every 10 s) | 64 / 190-197 / 377-406 | 63 / 182-192 / 379-382 |

Playout: share of audio concealed and the mean buffer (ms). "sim" is the shared simulation, "NetEq" is Chrome's real
playout on A:

| Link | A NetEq conceal % (buffer) | A sim conceal % (buffer) | B sim conceal % (buffer) |
|---|---|---|---|
| good | 0.01-0.03 (33-37) | 0.09-0.5 (57-59) | 0.14-0.27 (57) |
| typical | 0.27-0.55 (173) | 0.91-1.45 (150-164) | 1.06-1.23 (138-172) |
| lossy | 0.32-0.47 (174-266) | 1.32-2.12 (211-228) | 1.45-1.72 (212-221) |
| far | 0.51-1.17 (266-296) | 1.17-1.18 (266-317) | 0.82-1.63 (291) |
| handover | 1.26-1.78 (336-353) | 1.13-1.26 (221-228) | 0.95-1.10 (211-229) |

What the numbers say:

1. **TCP sets the delay, whichever option is used.** At 1% loss, p95 delay is two to three times the base delay;
   at 3% it is three times. A buffer that covers it adds 150-350 ms. Mouth-to-ear (network + buffer + about 40-60 ms
   of codec and device) is about 100 ms on a clean link, 250-300 ms at 1% loss and 400 ms or more on a far or lossy
   link. ITU-T G.114 calls under 150 ms good, 150-400 ms acceptable and over 400 ms poor. Insisting on the
   bare-name route means TCP, and this is its cost for both options.
2. **Chrome's NetEq beats a simple buffer on clean and moderately lossy links** (3-15× less concealment, at a similar
   delay). On far and outage links it is about equal, and it hides gaps by time-stretching (up to 1.2% of
   samples), which listeners notice less than clicks. B would need to build that.
3. Neither option dropped a frame at the sender, so no send queue built up at 24 kbps.
4. A spike artifact: on A, the first 10-18 frames of each call failed to open in the receiver's transform (likely
   frames that reached it before its state was set up; not investigated). Harmless here; the product must make sure
   the transform is in place before media flows.

## 4. What was not measurable here, and is still open

- **Echo.** Chrome 153 reports `echoCancellation` capabilities `[true, false, "remote-only"]` and refuses `"all"`.
  Its echo canceller is defined for WebRTC (remote) audio only. So in B, sound played by the page through Web Audio
  is not cancelled on Chrome (a laptop on speakers echoes), unless B plays its audio through a local loopback
  peer connection. That is not acoustically testable in this container. In A this is built in.
- Safari (macOS, iOS) and Firefox: WebCodecs Opus, `cbr=1` honoured, encoded transforms, SNI and the certificate
  check on `turns:`, the DTLS 1.3 group.
- The phones: whether the bundled libwebrtc (iOS, Android) negotiates DTLS 1.3 with X25519MLKEM768 and supports a
  frame encryptor, and whether an embedded TURN-over-TLS responder fits inside the phone endpoint.
- Real paths: two or three TCP legs, bursty cellular loss, a Wi-Fi/cellular switch (B needs its own resume; A
  can restart ICE).

## 5. Relays: do calls need relay-to-relay forwarding?

No, this can't be confirmed: calls will use it, in the same way as any visit to the bare name. In the mesh design
(`architecture-v2/relay-mesh.md` §7.2 step 3), a visitor's connection reaches the nearest relay (the **entry**),
which forwards it over one bridge hop to the relay holding the phone's tunnel (the **holder**). With many relays,
and institutions running entry relays, the caller and the phone will usually be on different relays. The browser
can't be sent to the holder directly: it reaches a hostname through DNS, and the phone's certificate names only
`<user>.<apex>`.

What that means for calls:

- **Privacy holds:** the mesh carries only ciphertext (TLS ends on the phone), and constant-size frames hide when
  someone talks. An entry relay, including an institution's, still learns the caller's IP address, the bare name
  (from SNI, so the account called), and when and for how long. Hiding SNI from relays is not possible while they
  route by it (ECH hides it from the network, not from the relay that routes).
- **Quality: one more TCP leg.** The mesh's bridges are WebSockets over TCP, one per relay pair, carrying many
  streams. A lost packet on a bridge stalls every stream on it until it is retransmitted, every call included. For
  calls, bridges should either give real-time streams their own connection (or a small pool) or move to a transport
  without head-of-line blocking (QUIC streams) later. Short legs help: an entry near the caller and a holder near the
  phone, with the long distance between two relays on good networks.
- `phone-route.md` §5 notes that today's single relay cannot forward bare-name visitors between instances, so calls
  need the mesh's forwarding before there is more than one relay.

## 6. Recommendation

Security is equal (§2), so by the owner's rule the choice comes down to quality and robustness, and that points to
**A**. The transport is the same TCP for both, so A's advantages are its media engine: Chrome's NetEq measurably
conceals less, and its echo canceller is the only one Chrome applies (B can't match that on Chrome desktop without a
workaround). A also gives ICE restart for network changes, and a hybrid DTLS key exchange as a second PQ layer.

A costs more on the phone: libwebrtc in both apps, plus a TURN-over-TLS responder inside the phone endpoint. Keep B's
frame format as the "quantum-safe" layer in both cases: in A it runs inside the encoded transform and the phones'
frame encryptors, so the claim never depends on a browser's DTLS.

Next tests before a design: Safari, Firefox and two phones (§4); an acoustic echo test on a Chrome laptop; a call
across two real relays.
