# voi.ci calls (0.4)

Status: plan, 2026-11-08. Nothing built. Owner decisions so far (2026-11-08): audio only; the media goes straight to
the owner's phone over its bare name (`<user>.<servicesApex>`), and `.com` only arranges the call; every admin device
rings; the claim is "quantum-safe calls", and among equally secure designs take the most robust with the best quality.
Measurements and the choice between WebRTC and our own frames: `docs/voici-calls-spike.md` (harness
`tools/spikes/voici-calls/`). Builds on `docs/voici-and-messages.md` (sign-in, pseudonyms, attestations, the mailbox,
abuse) and `docs/architecture-v2/phone-route.md` (the bare name) and `relay-mesh.md` (forwarding).

Feature branch: `feat/voici-calls`, off the branch voi.ci Messages ships on (AGENTS.md: unlaunched features live only on
their branch; this doc and its migrations stay on `main`).

## 0. Decisions in one page

1. **A call is WebRTC, audio only, between the visitor's browser and the answering phone.** The browser's only ICE
   server is `turns:<user>.<servicesApex>:443?transport=tcp` with `iceTransportPolicy: "relay"`. The phone answers that
   TURN connection itself (TLS ends on the phone, as for every bare-name visit) and hands the media to its own WebRTC
   stack on loopback. Nothing else carries media: no third-party TURN, no direct peer-to-peer, no box.
2. **Quantum safety does not depend on any browser's DTLS.** Every audio frame is sealed again in an encoded transform
   with keys from an X-Wing (X25519 + ML-KEM-768) exchange inside the signed call set-up (§3). DTLS 1.3 with
   X25519MLKEM768 underneath (Chrome 153 chose it in the spike) is a second layer where both ends support it.
3. **Nothing about the speech shows on the wire.** Opus `cbr=1;usedtx=0` at 24 kbps in 20 ms frames (exactly 60 bytes
   each in the spike), padded to a fixed size by the frame layer, one frame every 20 ms in silence too. The SDP drops
   the audio-level header extension and every extension the call doesn't need.
4. **`.com` arranges, never carries.** It checks the caller (the Messages rules: blocks, bans, attestations, limits),
   rings every admin device, keeps one call room per call (a Durable Object) for signed set-up messages, picks the
   first answer, and records a content-free missed call. It never sees audio or key material.
5. **Every admin device rings; the first answer wins; the answering device takes the bare name** for the call, even
   from another of the owner's devices that holds it (§5). One call at a time per account.
6. **Calls are off until the owner turns them on**, then by default only callers whose conversation the owner accepted
   (decision D1). The page shows a Call action only while calls are on.
7. **Ringing a phone in a pocket** uses the platforms' calling paths: iOS PushKit VoIP pushes and CallKit, Android a
   high-priority FCM (or UnifiedPush) message and a self-managed Telecom connection with a full-screen notification.

## 1. Flow

```text
browser (voi.ci, signed in to the page: P, B, T as in voici-and-messages.md §6)
  1  POST call request ──▶ .com  checks caller, page acceptsCalls, limits; creates CallRoom(callId)
  2                         .com ──VoIP/FCM push (callId, caller name sealed to the inbox key)──▶ every admin device
  3                         devices ring (CallKit / Telecom); each opens its phone tunnel as a standby (no claim)
  4  browser ◀──wss──▶ CallRoom ◀──wss──▶ ringing devices      (signed set-up messages only)
  5                         first device to answer: signed answer → CallRoom compare-and-set → others: "answered elsewhere"
  6                         answering device claims the bare name with the room's call receipt (pre-empts a holder)
  7  CallRoom → browser: answer (SDP, one-time TURN credential, X-Wing ciphertext), all signed by the owner
  8  browser ──TLS (SNI <user>.<apex>) ─▶ entry relay ─(mesh hop)─▶ holder relay ─▶ phone tunnel ─▶ phone TURN responder
  9  ICE (relay candidates only) → DTLS 1.3 → SRTP, each frame sealed under the X-Wing keys; fingerprints checked
 10  hang-up: either side signs "end"; the room closes; the phone releases the call route
```

Ring timeout 45 s: the room records a missed call in the mailbox (§6) and the browser offers "Send a message instead".

## 2. Signed records

All canonical bytes follow `packages/protocol` (`|`-separated, `flagship/<purpose>/v1`). Vectors in TS, Swift, Kotlin
and the browser library, positive and negative, in `packages/protocol/test-vectors/voici-calls/`.

```text
request  flagship/voici-call-request/v1|<pageId>|<conv>|<callId>|<callerXwingPub>|<offerSdpHash>|<issuedAt>
         signed by B (P-256, the browser key), with the cred (delegation + attestation + thread statement) as on a send
answer   flagship/voici-call-answer/v1|<callId>|<deviceRef>|<H(request)>|<xwingCiphertext>|<answerSdpHash>
           |<turnUser>|<H(turnSecret)>|<issuedAt>
         signed by the owner messages signing key (voici-and-messages.md §1); hybrid-signed on a strict account
receipt  flagship/voici-call-receipt/v1|<account>|<callId>|<deviceRef>|<issuedAt>|<expiresAt>
         signed by .com's CA key (as other CA artifacts), given only to the device whose answer won
end      flagship/voici-call-end/v1|<callId>|<side>|<reason>|<issuedAt>     by B or the owner messages key
```

- `callId` 16 random bytes hex, minted by the browser; `conv` is the Messages conversation id, so blocks, bans and
  reports reuse it.
- `callerXwingPub`: a fresh X-Wing key pair per call, made in the browser (flagship-web already does X-Wing).
- The SDP travels whole beside its hash. The signed hashes bind each side's DTLS fingerprint, so `.com` (or anyone
  between) cannot swap one in. Each side checks the remote DTLS fingerprint against the signed SDP before media flows.
- `turnSecret` is minted by the answering phone, sent in the answer, and good for this call's allocation only.
- `deviceRef`: H(the answering device's key), so the room can tell answers apart without naming devices.

## 3. The frame layer (`flagship/voici-call-frame/v1`)

- `ss` = X-Wing decapsulation of `xwingCiphertext`; `th` = H(request bytes ‖ answer bytes).
- Keys: `k_c2p = HKDF(ss, salt=th, info="flagship/voici-call-frame/v1|c2p")`, `k_p2c` the same with `p2c`. AES-256-GCM.
- Each encoded Opus frame becomes `ctr (8 bytes) ‖ AES-GCM(k_dir, nonce = dir (4) ‖ ctr (8), aad = callId|dir|ctr,
  pad(frame, 64))`. Fixed 64-byte plaintext (a CBR frame is 60 bytes; a longer one is a bug and is refused).
- Rekey every 10 minutes or 2^20 frames: `k' = HKDF(k, info="next")`, counter kept; the receiver accepts the old key
  for 2 s.
- Receivers drop frames whose counter is older than the window (replay) or that fail to open, and never pass an
  unopened frame to the decoder.
- Browsers: `RTCRtpScriptTransform` in a worker (Safari, Firefox, Chrome), `createEncodedStreams` as the Chrome
  fallback. Phones: libwebrtc `FrameEncryptor` / `FrameDecryptor`. The transform must be in place before the first
  frame (the spike lost the first 10-18 frames to a late transform).

What it claims: the audio's confidentiality rests on X-Wing, so a recorded call stays sealed against a future quantum
computer, whatever DTLS the two ends negotiated. Authentication is the signatures above (classical P-256 and Ed25519
for the browser, hybrid for strict owners), which only need to hold while the call is being set up.

## 4. The phone side

- **WebRTC library.** iOS and Android bundle libwebrtc, pinned to a version that negotiates DTLS 1.3 with
  X25519MLKEM768 and exposes the frame encryptor; check both at pin time (the spike proved it Chrome to Chrome only).
  The phone's peer connection allows the loopback adapter (libwebrtc ignores loopback by default:
  `networkIgnoreMask`) and gathers only a loopback host candidate.
- **TURN responder, in Rust, shared.** A small TURN-over-TLS server (RFC 8656 subset: Allocate with the one-time
  long-term credential, Refresh, CreatePermission, ChannelBind, Send/Data and ChannelData; nothing else) in
  `rust/crates/flagship-turn-lite`, linked into both apps the way the other Rust crates are, and used by the gym. Its
  relayed address is a loopback UDP socket paired with the phone's own peer connection. One allocation, for the call
  in progress only; it refuses everything else.
- **The phone endpoint demultiplexes after TLS:** a STUN or ChannelData first byte goes to the TURN responder, while a
  call is active and its credential matches; HTTP goes to today's endpoint (`phone-route.md` §4). Bandwidth cap
  64 kbit/s each way; one TURN connection; refused while no call is answered.
- **Ringing.**
  - iOS: PushKit VoIP push → `CXProvider.reportNewIncomingCall` at once (Apple requires it for every VoIP push; a push
    for a call that already ended is reported and ended immediately). Caller name: the push carries it sealed to the
    inbox key; the app opens it and updates the call. Apple Watch rings through CallKit. CallKit is not allowed in
    the China mainland storefront: calls are off there (the app says so in Settings).
  - Android: high-priority FCM data message (UnifiedPush where the 0.4 item lands) → self-managed `ConnectionService`
    → a full-screen incoming-call notification (`USE_FULL_SCREEN_INTENT`, Play declaration) → a `phoneCall` +
    `microphone` foreground service for the call. Works from Android 10 (the floor). Wear OS answers through Telecom.
- **Background.** A device may hold the bare name in the background only while it has a ringing or active call (rule
  change to `phone-route.md` §4 "Foreground only"); it closes the tunnel when the call ends.

## 5. The bare name during a call

- **Standby while ringing:** each ringing device opens `/phone-tunnel` and stays a standby (no claim), so answering
  is one claim (a round trip to the ledger relay; not measured yet; CallKit shows "Connecting" meanwhile).
- **Pre-emption:** a claim may carry the room's `voici-call-receipt/v1`. The ledger relay accepts it while another of
  the same account's devices holds the name and no call receipt of its own is live; the old holder gets
  `lost reason: call` and becomes a standby. Relays verify the receipt under the CA chain they already trust. A holder
  in a call is never pre-empted: a second caller gets "busy" and a missed call.
- **Relays.** Calls use the mesh's one-hop forwarding like any bare-name visit (the caller's entry relay is rarely the
  holder). Needed before calls ship: bare-name forwarding between relays (today's single relay can't forward between
  instances), and keeping calls off the shared bridge's head-of-line blocking (a bare-name connection with no ALPN is a
  TURN call, so relays can put it on its own bridge connection). `scripts/release.sh` checks the relays' live-call
  count before a relay deploy (a deploy drops every tunnel for 20-60 s).
- **What relays learn:** the caller's IP address, the bare name (so which account was called), when, how long, and a
  constant-rate stream of constant-size records. Never content. The privacy policy says so.

## 6. `.com`

- `POST /api/voici/calls` (the request; checks cheapest first, as the mailbox send: size → shape → page exists and
  `acceptsCalls` → caller not blocked / banned / revoked → limits → signatures → caller allowed by the owner's
  setting → owner not in a call). Answers `{callId, room}` or a refusal code (`calls-off`, `not-allowed`, `busy`,
  `rate-limited` + `retryAfterSec`, the send codes).
- `CallRoom` Durable Object per call: WebSockets to the browser and to each ringing device, relays signed messages,
  compare-and-sets the first answer, mints the receipt, ends the room on hang-up, timeout (45 s ring, 60 min call:
  D3) or both sides gone. Stores nothing after it closes, except the missed-call entry.
- Pushes: APNs `apns-push-type: voip` to the `.voip` topic (a separate token the app registers); FCM high-priority
  data. Payload: `callId`, room host, the caller's name sealed to the inbox key; no other content. "Answered
  elsewhere" and "caller hung up" go the same way to the devices still ringing.
- Missed call: a mailbox entry of kind `voici-missed-call`, sealed to the inbox key, so every owner device shows it
  and Block / Report work on it.
- The page index gains `acceptsCalls` (and the caller rule `callsFrom: accepted|signed-in`): a new index version
  `flagship/voici-page/v2`, v1 still read.
- Limits (`rateLimit.ts` buckets): rings per pseudonym 3 an hour and 10 a day; rings per page 20 an hour; one live
  call per account; new accounts follow the Messages slow start. D1: a `voici_calls` counter row per (page, day) for
  limits only; no call log.

## 7. The visitor's side (voi.ci, `packages/flagship-web`)

- The floating message button (0.4 list, voi.ci section) becomes two actions while calls are on: Message and Call.
- Call: microphone permission on the tap (never on load), "Calling <name>…" with Cancel, ringing timeout, then the
  call screen (mute, hang up, timer, "Quantum-safe call" with the explanation behind (?)), and "Call ended". Echo
  cancellation, noise suppression and auto gain on (`getUserMedia` constraints; WebRTC audio is what Chrome's echo
  canceller covers).
- Headers: `permissions-policy: microphone=(self)` on voi.ci only (`apps/com/src/voiciRoutes.ts`, today
  `microphone=()`), `worker-src 'self'` for the transform worker, `connect-src` keeps the control apex for the room's
  WebSocket. No new third-party host.
- Every string through `i18n/voici-site` (AGENTS.md: no hard-coded English).

## 8. The owner's side (apps)

- Settings → Messages → Calls: off (default) / on; "Who can call: people whose conversation you accepted |
  anyone signed in with Flagship"; Do Not Disturb hours; the China note on iOS.
- The call screen is the system's (CallKit, Telecom). Inside the app: the call in the conversation's thread, missed
  calls in Messages, Block / Report on a call.
- The webapp shows calls in the thread but does not answer (web push can't ring reliably).

## 9. Abuse

- Blocks, bans and reports reuse the conversation's pseudonym (`voici-and-messages.md` §9). A reported call carries no
  content (none exists); a report names the call and its pseudonym, and the abuse tag works the same way.
- The abuse page and terms gain a calls paragraph (what we can and can't see: no recording, no content).

## 10. Tests

- Vectors for every record and the frame layer (TS, Swift, Kotlin, browser).
- The spike harness becomes a CI lane: Chromium caller → SNI relay → `flagship-turn-lite` (replacing coturn) → a
  Chromium "phone", with the emulated link's five scenarios; it fails on any frame not exactly 64 bytes, a negotiated
  audio-level extension, or concealment over a set limit.
- Gym group `calls` on the live gym: two admin phones ring, first answer wins, the other stops; pre-emption of a
  holder; busy; missed call; block during ringing.
- Device runs: iPhone and Android phone (lock screen, background, Bluetooth headset, Wi-Fi ↔ cellular switch, an
  ICE restart), Apple Watch, Wear OS, Safari macOS and iOS, Firefox, Chrome desktop on speakers (acoustic echo).

## 11. Before building: the rest of the spike

1. Safari (macOS, iOS) and Firefox: `cbr=1` honoured, `RTCRtpScriptTransform`, SNI and the certificate check on
   `turns:`, the DTLS group.
2. The libwebrtc builds for iOS and Android: DTLS 1.3 with X25519MLKEM768, the frame encryptor, loopback-only
   gathering.
3. A Chrome laptop on speakers (acoustic echo) and a Bluetooth headset.
4. A call across two real relays (the mesh hop) on a real phone network.

## 12. Work breakdown (estimates, one engineer)

| Chunk | Days |
|---|---|
| Rest of the spike (§11) | 3 |
| Protocol: records, frame layer, vectors in four languages | 4 |
| `flagship-turn-lite` (Rust) + phone endpoint demux | 5 |
| `.com`: request route, CallRoom, receipts, VoIP/FCM pushes, limits, missed calls, page index v2 | 6 |
| Relays: bare-name forwarding, call bridge connection, pre-emption with a receipt, live-call count | 5 |
| voi.ci + flagship-web: call UI, transform worker, headers, strings | 5 |
| iOS: libwebrtc, PushKit + CallKit, background route, settings, strings | 9 |
| Android: libwebrtc, FCM/UnifiedPush + Telecom, foreground service, settings, strings | 9 |
| Tests: CI lane, gym group, device runs | 5 |
| Store, privacy policy, terms, abuse page | 2 |

About 53 days.

## 13. Open decisions (owner)

- **D1** Who may call by default once calls are on: accepted conversations (recommended) or anyone signed in.
- **D2** Do iPads (admin devices) ring as well as phones? Recommended yes (CallKit works on iPad).
- **D3** A maximum call length (recommended 60 minutes, then "Call again").
- **D4** Calls are off in the China mainland storefront (Apple doesn't allow CallKit there). Accept, or ship there
  without CallKit (calls only while the app is open)?
