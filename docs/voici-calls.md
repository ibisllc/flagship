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
6. **A page's first publish turns calls on for people signed in with Flagship** (`callsFrom: signed-in`, never
   anonymous; owner decision 2026-11-16, which replaces "off until the owner turns them on" and D1's accepted-only
   default). A later publish keeps the owner's choice. The page shows a Call action only while calls are on.
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

- Settings → Messages → Calls: on / off (on from the page's first publish, owner decision 2026-11-16); "Who can call"
  (see "Who may call a page" and "First publish" below); Do Not Disturb hours; the China note on iOS.
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

## Owner decisions, 2026-11-14

- **D1:** by default only accepted conversations may call. **D2:** iPads ring too. **D3:** 60-minute limit, then
  "Call again".
- **D4:** in the China mainland storefront, ship calls without ringing (no CallKit): calls work while the app is
  open, if that is legal there (legal check needed before release: Apple's China rules and local rules on encrypted
  voice).
- Built on `release/0.4` (not a separate `feat/voici-calls` branch): calls launch with 0.4.
- Later design work (`docs/voici-calls-v2.md`): video calls; enterprise pages taking calls from visitors without a
  Flagship account (customer support); paid calls for enterprise accounts.

## As built (2026-11-14, `release/0.4` worktree `0.4/calls`)

Built and tested: protocol (TS, Swift, Kotlin, browser), `.com`, the voi.ci visitor side, the phone's TURN responder.
Not built yet: the phone apps' call layer (libwebrtc, CallKit / PushKit, Telecom / ConnectionService, the endpoint
demux, settings and the thread entries), the relays' call work (§5), the CI lane and the gym group.

- **Records** (`packages/protocol/src/voiciCalls.ts`; Swift `VoiciCalls.swift`, Kotlin `core/voici/VoiciCalls.kt`, browser
  `packages/flagship-web/src/callProtocol.js`; vectors `test-vectors/voici-calls/`, `npx tsx tools/voici-calls-vectors.ts`).
  Wire request `{v:1, kind:"voici-call-request", pageId, conv, callId, from, callerXwingPub, offerSdp, issuedAt, cred, sig}`;
  answer `{v:1, kind:"voici-call-answer", callId, deviceRef, requestHash, xwingCiphertext, answerSdp, turnUser (16 bytes
  hex), turnSecret (32 bytes hex), issuedAt, sig}`; receipt `{v:1, kind:"voici-call-receipt", account, callId, deviceRef,
  issuedAt, expiresAt (≤ 65 min), signedBy, signature}`; end `{v:1, kind:"voici-call-end", callId, side, reason, issuedAt,
  sig}` with reasons hangup, cancel, decline, busy, no-answer, limit, failed. New: `flagship/voici-call-allow/v1|<pageId>|
  <conv>|<allow|disallow>|<issuedAt>` by ownerSignPub (an explicit "may call" / "may not call" for one conversation).
  The answer is Ed25519 only; the hybrid signature for strict owners needs an ML-DSA key in the page index (open).
- **Frames.** Epochs follow the counter: epoch = floor(ctr / 30000) (10 minutes of 20 ms frames, which flow at a
  constant rate), so both ends rekey with no signalling and the receiver keeps two epoch keys. Plaintext is
  `u8(len) ‖ frame ‖ zeros` (64 bytes, frame ≤ 63); sealed frames are always 88 bytes. Receiver window 128 frames,
  gap limit 3000.
- **SDP** (`mungeVoiciCallSdp`, `checkVoiciCallSdp`): Opus only, fmtp `minptime=20;useinbandfec=1;cbr=1;usedtx=0;stereo=0;
  sprop-stereo=0;maxaveragebitrate=24000`, ptime 20, every header extension removed except the MID one BUNDLE needs.
- **Page index v2** (`voiciPage.ts`, webapp `lib/voiciPage.js`, Swift `VoiciPage.swift`, Kotlin `VoiciPage.kt`):
  `flagship/voici-page/v2|…|<acceptsMessages>|<acceptsCalls>|<callsFrom>|<inboxEpoch>|…`. Writers sign v2 only while
  calls are on, so pages without calls stay readable by v1 readers. Turning calls on is a publish by an admin device.
- **The TURN credential and the offer.** The browser makes its offer before the request (its hash is signed) and
  calls `setLocalDescription` only after the answer, once `setConfiguration` has the phone's TURN credential: nothing
  is gathered before the call is answered, and the signed offer is exactly the one applied.
- **`.com`** (`packages/control-plane/src/voiciCalls.ts`, `apps/com/src/voiciCallRoutes.ts`, `voiciCallRoom.ts`,
  migration **0146**): routes `POST /api/voici/calls` (CORS voi.ci) → `{callId, room, token, ringMs}`;
  `GET /api/voici/calls/<id>/caller?t=` (Origin voi.ci) and `/device?u=<u>` (device headers of an admin device,
  signed over `GET /api/voici/calls/<id>/device`); `POST /api/voici/pages/<u>/call-allow`;
  `GET /api/voici/pages/<u>/calls?since=` (read token: `{items:[{id, callId, conv, sealed, storedAt}], cursor, more}`);
  `POST /api/accounts/<u>/voici-voip-token` `{token}` / `{token:null}`. "Accepted" = the owner replied, sent an
  unblock (accept) order, or a call-allow; a newer disallow always refuses. A blocked or banned caller is told
  `calls-off`. Buckets `voici-call` (30/h per address), `voici-call-caller` (3/h, 10/day per pseudonym),
  `voici-call-page` (20/h); D1 cap 100 rings per page per day. Switch `VOICI_CALLS` (on in the gym, off in production).
- **Room messages** (JSON over the WebSocket). Room → caller: `ringing`, `answer {answer}`, `ice {candidate}`,
  `ended {reason, end?}`. Room → device: `request {request, ringingAt}`, `won {receipt}`, `answered-elsewhere`,
  `ice`, `ended`, `error {code}`. Device → room: `answer`, `decline`, `ice`, `end`. Caller → room: `ice`, `end`. A
  caller's room socket closing before an answer is a cancel; after one, the media path decides.
- **Pushes.** VoIP (`buildVoipPushSender`): topic `<bundleId>.voip`, `apns-push-type: voip`, priority 10, expiring
  with the ring; body `{"flagship-call": {kind:"voici-call", callId, room, sealed, issuedAt}}`. Other admin devices
  get the same fields as FCM data / UnifiedPush / an APNs alert ("Someone is calling you. Open Flagship to answer.").
  `sealed` = `flagship/voici-call-push/v1` to the inbox key, context [callId], `{v:1, callId, pageId, conv, from}`.
- **Phone TURN responder** `rust/crates/flagship-turn-lite` (sans-IO). The endpoint must choose TURN by the
  connection's first byte being a STUN first byte (`is_turn_first_byte`): ChannelData's range overlaps HTTP methods.

### Owner actions

1. Apple: enable the Voice over IP background mode and the PushKit capability for the iOS app ID; the existing APNs
   auth key (`APNS_KEY_ID`/`APNS_TEAM_ID`/`APNS_PRIVATE_KEY_PEM`) sends VoIP pushes to the `.voip` topic with no new
   certificate. iPad builds need the same (D2).
2. Google Play: the `USE_FULL_SCREEN_INTENT` declaration and the `phoneCall` + `microphone` foreground-service
   declarations when the Android call layer lands.
3. D1 migration 0146, then a `.com` deploy (the `v6` Durable Object migration adds `VoiciCallRoom`); set
   `VOICI_CALLS = "on"` only after the store builds with the call layer ship.
4. D4: the legal check for calls in the China mainland storefront before release.
5. Native review of the voi.ci call strings (machine drafts in six languages).

## As built: video and the phone call layers (2026-11-15, worktree `0.4/calls-phone`)

Owner, 2026-11-14: video calling is in 0.4 as an upgrade of the audio call (`docs/voici-calls-v2.md` §1 only; §2 to §4
are not built). Not compiled for a device yet (iOS: no Xcode build on this Mac under load; Android: no Gradle run).

- **`media`** (request and answer, optional): `audio` or `audio,video`, what that side is able to send. Present, it is
  appended to the canonical bytes (`…|<issuedAt>|<media>`); absent, the record is the audio one above, so stripping it
  only downgrades a call to audio. The answer's media must be within the request's. A video SDP has exactly m=audio then
  m=video, the video section VP8 only (rtx, RED, FEC and other codecs munged away), header extensions MID and
  transport-wide CC only. New SDP refusals: `bad-media`, `not-vp8`, `video-extension`.
- **Video frames** (§1.5, §1.6 of v2): keys `HKDF(ss, th, "flagship/voici-call-frame/v1|<dir>|video")`, own counters,
  epochs as audio (ctr / 30000). Sealed frame = clear VP8 payload header (10 bytes on a key frame, 3 on a delta frame,
  inside the AAD `<callId>|<dir>|video|<ctr>|` ‖ clear) ‖ u64be(ctr) ‖ AES-GCM(u32be(len) ‖ body ‖ zeros), its total
  padded to a bucket: 1 KiB doubling to 1 MiB (a larger frame is refused). Vectors: the `video` section of
  `test-vectors/voici-calls/vectors.json`, read by TS, flagship-web, Swift and Kotlin.
- **Camera states**: the room relays `{t:"camera", state:"on"|"off"|"paused"}` between the caller and the winner (UI only,
  unsigned). voi.ci offers video only when the browser has a camera (no permission asked), asks for the camera on the
  Camera tap, and shows the other side's state; voi.ci's permissions policy is `camera=(self)` while calls are on.
- **Webapp**: missed calls in a thread and "Allow calls from them" / "Don't allow calls from them" (`lib/voiciCalls.js`,
  shell v211). It still never answers.
- **iOS** (`apps/mobile/ios/Sources/FlagshipUI/Calls/`): `VoiciCallCenter` registers PushKit at launch, sends the VoIP
  token to `POST /api/accounts/<u>/voici-voip-token`, reports every VoIP push to CallKit before anything else (a late,
  malformed or second call is reported and ended at once), CallKit Answer / End / Mute drive the room
  (`VoiciCallSession`: request check, signed answer, receipt check, frame keys). `supportsVideo` on, `hasVideo` follows
  either camera, calls stay out of Recents. **China mainland storefront** (`Storefront.current` = `CHN`, remembered):
  no CallKit and no VoIP token (an old one is removed), so `.com` sends the `voici-call` alert push and the open app rings
  on `VoiciCallScreen`; calls work only while the app is open (D4). The camera pauses when the app leaves the foreground
  (the caller sees "Camera paused"). Info.plist: background modes `voip`, `audio`; `NSMicrophoneUsageDescription`; the
  camera sentence now names calls.
- **Android** (`app/.../calls/`): `voici-call` push → `VoiciCallCenter` → a self-managed `ConnectionService`
  (`MANAGE_OWN_CALLS`), the full-screen CallStyle notification (`USE_FULL_SCREEN_INTENT`) and `VoiciCallActivity`
  (Answer / Decline, Mute, Camera, Hang up). The microphone is asked on Answer, the camera on the Camera tap; the call
  runs a `phoneCall` (+ microphone, + camera once granted) foreground service. Leaving the call screen pauses the camera.
- **Media**: both apps go through a small `CallMediaEngine` interface with `CallFrameCrypto` (the frame layer above, p2c
  out, c2p in). Only `StubCallMediaEngine` exists: it refuses every answer, so a call rings, and answering says "This
  version of Flagship can't connect calls yet."

### Open items (owner)

1. **libwebrtc**: decided 2026-11-15 (option A, our own build); built as below ("As built: media"). Still the owner's:
   where the built binary lives for release builds (the CI keeps it as a 90-day workflow artifact only).
2. **Linking the TURN responder**: done through `flagship-turn-ffi` (below).
3. **Answering while locked**: the answer is signed by the owner messages key, derived from the account key, which is
   only in memory while the app is unlocked. A call that arrives with the app locked rings with "Someone on voi.ci" and
   asks to open and unlock Flagship before it can be answered. Decide whether a device-held, call-only signing key
   (Keychain / Keystore, available after first unlock) is acceptable.
4. **D4 legal check** for calls in the China mainland storefront still stands.
5. **Do Not Disturb is per device, not synced** (below). Syncing it through the sealed Messages state blob is possible
   (`.com` sees only ciphertext) but changes the state format in four ports; say if one setting for every device is
   wanted.
6. Native review of the new strings (machine drafts in six languages).

## As built: settings, missed calls, the TURN demux (2026-11-15, worktree `0.4/calls-2`)

- **Calls settings** (Settings → Messages → Page options → Calls, iOS `Calls/VoiciCallsSettingsSection.swift`, Android
  `ui/screens/VoiciCallsSettings.kt`, models `VoiciCallSettings`): Accept calls, Who can call (accepted conversations |
  anyone signed in), Do Not Disturb hours. On/off and who can call live in the signed page index: an admin device
  changes them with a publish of its own (`setCalls`), other devices see them read-only ("Only an admin device can
  change this"), and an unpublished page says "Publish your page to take calls." **Every publish now carries the calls
  fields of the index it replaces** (iOS, Android and the webapp, shell v216); before this, any publish signed v1 and
  turned calls off. Off is a v1 index again; the last "who can call" is remembered on the device.
- **Do Not Disturb** stays on each device (UserDefaults / SharedPreferences) and never reaches `.com` or the index, so
  no server learns the owner's hours or time zone. A quiet device stays out of the room: iOS still reports the VoIP push
  to CallKit (Apple requires it) and ends it at once as unanswered; Android doesn't ring. Another device may answer; an
  unanswered call becomes a missed call. Start == end means all day.
- **China mainland storefront** (iOS no-ring mode, D4): the Calls section adds "In your region, calls ring only while
  Flagship is open."
- **Missed calls** on iOS and Android: `GET /api/voici/pages/<u>/calls`, each item opened under every inbox epoch and
  checked (`openMissedCall`), shown in its conversation's thread in time order ("Missed call" / "Missed video call").
  The thread menu signs `flagship/voici-call-allow/v1` ("Allow calls from them" / "Don't allow calls from them") while
  calls are on.
- **The endpoint demux** (`CallTurnGate`, iOS `Flagship/CallTurnGate.swift` in `PhoneTlsTerminator`, Android
  `phoneroute/CallTurnGate.kt` in `PhoneTunnel`): the first byte after TLS picks HTTP or TURN; TURN is accepted only
  while this device's signed answer is out (armed with its one-time credential, disarmed when the call ends), once per
  call, and only when a responder factory is set. With no responder linked, such a stream is closed.
- **Relays:** bare-name forwarding between relays is already in the Rust mesh (`mesh/mod.rs`, `NameClass::Bare`, the
  phone items of relay-mesh.md §8.4). Not built: the separate call bridge connection, pre-emption with a call receipt,
  and the live-call count in `scripts/release.sh` (§5).
- **Tests:** iOS `VoiciCallsViewModelTests`, `CallTurnGateTests`; Android `VoiciCallSettingsTest`,
  `VoiciCallScreenModelTest`, `CallTurnGateTest`, `VoiciAppTest` (calls setting and call-allow against the in-memory
  `.com`); webapp `webappVoiciOwner.test.ts`. Mock gym: Android `anAdminTurnsCallsOnAndAllowsAVisitorToCall`
  (compiled, not run: no emulator), iOS Page options lists the calls controls (not run). The media CI lane and the live
  gym group `calls` need real WebRTC.


## Owner decisions, 2026-11-15

- **Answering while locked is a setting, off by default**, on the Social (Messages) page: "Answer calls while
  Flagship is locked". Design:
  - Turning it on (an unlock is needed) makes a **call-only key** on that device: iOS Keychain
    `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (Secure Enclave P-256 where available), Android Keystore
    without user authentication (StrongBox where available).
  - The device binds it once under the owner messages key: `flagship/voici-call-key/v1`
    `{username, deviceId, callKeyPub, createdAt}`. The binding is published beside the device's messages
    registration, and `.com` and the caller's browser check an answer against a key the binding names.
  - The call key signs only the call answer and decline (`voici-call` answer purposes). It never signs messages,
    pages or anything else; verifiers refuse it for any other purpose.
  - Turning the setting off, signing out, or removing the device deletes the key and publishes a revocation.
  - When it is off, today's behaviour stays: the phone rings with "Someone on voi.ci" and asks to unlock.
- **Do Not Disturb stays per device**: no server learns the owner's hours or time zone (release-manager call; it
  follows the AI and privacy rules).
- **Only admin devices change the page's call settings**, as designed (a publish of the page index).
- **WebRTC stack**: options in `docs/voici-calls-webrtc-options.md` (recommended: a pinned prebuilt now, our own
  build before GA). The owner's choice is pending. Linking `flagship-turn-lite` (UniFFI vs ports) is decided with it.
- **The terms change (legal minimum) ships with the 0.4 deploy**, not before.

## As built: answering while locked (2026-11-15, worktree `0.4/calls-2`)

Owner decision 2026-11-15, built as designed above. Off by default; on the Social (Messages) page, Calls section:
"Answer calls while Flagship is locked" (admin devices, while calls are on).

- **Records** (`packages/protocol/src/voiciCalls.ts`; Swift `VoiciCalls.swift`, Kotlin `VoiciCalls.kt`, caller side
  `packages/flagship-web/src/callProtocol.js`; vectors `test-vectors/voici-calls/vectors.json` section `callKey`):
  - binding `flagship/voici-call-key/v1|<username>|<deviceId>|<callKeyPub>|<createdAt>`, Ed25519 by the page's
    ownerSignPub; wire `{binding:{username, deviceId, callKeyPub, createdAt}, signature}` (exact keys; callKeyPub a
    valid uncompressed P-256 point, lowercase hex 130; deviceId 32 hex).
  - revoke `flagship/voici-call-key-revoke/v1|<username>|<deviceId>|<callKeyPub>|<revokedAt>`, Ed25519 by ownerSignPub
    or P-256 by the call key itself (sign-out may happen after the owner key is gone).
  - join `flagship/voici-call-join/v1|<username>|<callId>|<deviceId>|<callKeyPub>|<issuedAt>`, P-256 by the call key:
    the locked device's room WebSocket (headers `x-flagship-call-key-device`, `-pub`, `-at`, `-sig`), since the
    account device key that signs the usual device headers needs the unlocked account. This is the one use beyond
    "answer and decline" in the design; the decline itself is the room message on that authenticated socket.
  - the answer may carry `callKey` (the binding proof) with `sig` P-256 (IEEE P1363) by its key; deviceRef must be
    H(callKeyPub). An owner end order may be signed by the call key that answered.
  The key signs only those three tags; every other verifier takes Ed25519 or a different key, so it is refused there.
- **`.com`** (migration **0147**, in `KNOWN_MIGRATIONS`): `voici_call_keys` (one bound key per device) and
  `voici_call_key_revocations` (a revoked key never binds again). Routes `POST /api/accounts/<u>/voici-call-key`
  (device headers of an active admin device; the binding must name that device, be fresh, and verify under the
  page's current ownerSignPub) and `POST /api/accounts/<u>/voici-call-key/revoke` (signature only). The device room
  route takes the call-key join instead of device headers: stored key, not revoked, binding still valid under the
  current ownerSignPub, device still an admin device. The room then accepts from that peer only an answer and end
  signed by that key (`winnerCallKeyPub`).
- **The caller's browser** checks the binding under the page's ownerSignPub and the answer under the bound key (it
  can't see revocations; `.com` refuses a revoked key at join, before the device can answer).
- **Phones.** iOS `Calls/VoiciCallKey.swift`: Secure Enclave P-256 where available (else a software key), stored in
  the Keychain `AfterFirstUnlockThisDeviceOnly`, no user presence. Android `calls/VoiciCallKey.kt`: Keystore EC P-256
  without user authentication, StrongBox where the phone has it. Beside the key: account, device, page, the
  ownerSignPub and the binding (public). A VoIP push / call push with the account locked uses only the call key: the
  caller shows as "Someone on voi.ci" (the inbox key that opens the name is locked) and no local block list is
  checked (`.com` refuses blocked callers before ringing). After an inbox-key rotation the next unlocked refresh
  binds the same key again. Turning the setting off sends an owner-signed revocation; sign-out / removal
  (`Keystore.onWipe`) sends a self-signed one, then deletes the key.
- **Tests:** protocol vectors (TS replay, flagship-web, Swift `testCallKey`, Kotlin `callKey`), control-plane
  `voiciCallKeys.test.ts` (join, refusals, revocation, room), Android `VoiciAppTest` (bind, locked join/answer/end,
  revoke; a non-admin device refused), iOS `VoiciCallKeyTests`. Not run on a device.
- **Open:** a device removed by another admin device stops ringing at once (`.com` checks the admin grant at join) but
  its binding row stays until it revokes itself or is replaced; on iOS, a sign-out that wipes the Keychain before
  `onWipe` runs skips the self-revocation (same effect). The answer is still classical-only (P-256), as the owner
  answer is Ed25519-only today.


## Owner decisions, 2026-11-15 (second round)

- **Everything lands in 0.4**, including our own build of Google's libwebrtc (option A in
  `docs/voici-calls-webrtc-options.md`; no vendor prebuilt) and the webapp safety upgrades
  (`docs/webapp-key-custody.md` 1-6).
- **Calls must work from the voi.ci page in any browser** (the visitor side, audio and video) **and the owner must
  be able to call back from the Social page in the app.**
- Release-manager calls on the locked-answer questions: the extra `flagship/voici-call-join/v1` record is accepted
  (narrower than keeping the account device key available while locked); `.com` deletes a device's call-key
  binding when that device's grant is revoked.

## Calling back (design, 2026-11-15)

Owner clarification: "call back" means a user starts a call to someone **directly from the app's call and chat
logs** (conversation list, thread, call history), not by opening the voi.ci page. The browser handoff below is only
the fallback when the app's media engine is missing. The call history is kept on the device (or in the sealed
Messages state); no server keeps a log of who called whom.

1. **Who can be called back:** the other side of a Messages conversation, who is a signed-in Flagship account with a
   voi.ci page. Their page's call settings apply as usual. An accepted conversation counts for "accepted
   conversations"; their own block list and Do Not Disturb apply.
2. **Same protocol, roles reversed:** the calling app signs the call request as an attested caller with its owner
   messages key; the callee's devices ring through their own push or VoIP path (the app) or show in an open voi.ci
   tab. The X-Wing frame layer, signed SDP hashes and TURNS-to-bare-name are unchanged; the callee's answering
   device is the media endpoint.
3. **Where the media runs:**
   - **In the app (default):** our libwebrtc build through `CallMediaEngine`, from a "Call" / "Video call" button
     in the thread header and on the missed-call row ("Call back").
   - **In the phone's browser (fallback):** if the app's media engine is unavailable (a build without libwebrtc,
     or a failure starting it), "Call back" opens `https://voi.ci/<them>#call=<one-time handoff>` in the system
     browser. The handoff is a short-lived, one-use ticket the app seals to a browser key, like the remote QR
     flow. It signs the browser in as the same account for this one call, and the browser places the call with
     its built-in WebRTC.
   - **The webapp** calls back with the browser's WebRTC.
4. **Missed calls the other way:** an unanswered call back becomes a missed call on the callee's side
   (`flagship/voici-missed-call/v1`), with the caller's name sealed as today.
5. **Strings, settings and tests:** every new string through i18n. View-model tests, mock gym scenarios, a
   browser-to-browser Playwright test against a local `.com` with two voi.ci pages, and a media CI lane once the
   libwebrtc build exists.

## Who may call a page, and ringing a caller back (owner-approved, 2026-11-15)

Owner idea: turning calls on means agreeing to ring. Each page owner picks one mode:
- **Anyone on the internet**: no account needed; a browser visitor calls. Abuse controls from `voici-calls-v2.md`
  §2: a per-page call budget, proof-of-work in the browser, short-lived blocks, optional hours. The page says
  "Anyone can call you here".
- **Callback accounts only**: the caller is signed in with Flagship, and calling counts as consent to being rung
  back **in that conversation**. The ring-back goes through the conversation's mailbox, never to a username or a
  known phone, so the caller stays pseudonymous to the owner.
- The pseudonymous side always dials out and the public side hosts the media (no bare name of the pseudonymous
  side is ever used).
- **Sealed-token push relay** (needed so the mailbox can't be tied to a phone at `.com`): apps give `.com` only
  their push token sealed (fresh randomness each time) to a small separate push-relay service. `.com` hands the
  sealed blob to the relay, which opens it and sends a content-free push. `.com` sees conversations but no tokens;
  the relay sees tokens but no conversations. All pushes, account ones included, use it, so `.com` never holds a
  raw token. Linking needs both to collude; Apple and Google still see that a push reached a device. Its hosting
  is decided at deploy.

### Owner additions (2026-11-15)

- **The call-back choice is a pop-up before the call** on a page open to anyone: "Let <name> call you back?" with
  two buttons, **"Call anonymously"** (no account, no ring-back) and **"Call and allow call-back"** (signs in with
  Flagship, if not already, and attaches the conversation's ring-back channel). On a "callback accounts only" page,
  the pop-up shows only the second choice and says why. The choice is per call and per conversation, and a later
  "Stop call-backs" in the thread withdraws it (the channel is deleted at `.com` and the relay).
- **Push relay hosting (release-manager recommendation, cheapest):** inside the existing Fly relay app
  (`flagship-services`, the Rust relay). `.com` stays on Cloudflare, the relay is on Fly: two providers, two sets
  of secrets. The APNs key and the FCM credentials move to the relay only; `.com` holds no raw push token, and no
  APNs or FCM secret. Extra cost: about $0 (a few HTTP/2 calls per push on a machine already paid for; APNs and
  FCM are free). Limits: we run both halves, so the split guards against one side's breach, a subpoena served on
  one provider, and our own logs, but it is not protection against Flagship itself. A third-party operator would
  be the stronger option later.

### Push relay over the relay network (owner, 2026-11-15)

Owner: the push relay runs on the relays and uses the relay mesh, so that "as more institutions agree to host
Flagship relays, the deeper the obfuscation". Design:
- **Onion path through the mesh.** `.com` doesn't push. It picks a random path of hops among blessed relays (relay
  blessing, `docs/architecture-v2/relay-mesh.md`) and wraps the delivery in layers, one per hop, each sealed to that
  hop's relay key. Each hop learns only the previous and next hop. The entry hop sees `.com` but only ciphertext;
  the last hop (the exit) opens the sealed token and sends the content-free push, but never learns the conversation
  or which `.com` request started it.
- **Exits hold the push credentials.** Apple's APNs key and Google's FCM credentials can't be handed to outside
  institutions, so only Flagship-run relays act as exits. Relays hosted by other institutions are entry and middle
  hops. Each added independent relay widens the set of possible paths, so linking a conversation to a phone needs
  every hop on the path plus the exit to collude.
- **The app registers its token through whichever relay it reaches.** The token is sealed to the exit key set (any
  Flagship exit can open it), and the registration travels to `.com` through the app's own nearest relay. `.com`
  never sees the phone's network address with the registration.
- **Timing:** each hop adds a small random delay (tens of milliseconds) and pads every message to one size, so a
  hop can't match in and out by size. A ring still arrives within a second.
- **Fallback:** with a single relay (today), the path is entry = exit = the Fly relay. That is the about-$0 option,
  with protection exactly as described above, deepening as relays join.
- **Cost:** nothing extra beyond relays we or partners already run; the mesh links already exist.

### Correction: no onion routing, no sealed-token relay (owner, 2026-11-15)

Owner: "we (who run .com and .services) already know the endpoints ... let's not do security cosplay." Agreed. To ring
a phone, whoever sends the push knows the token; Flagship runs `.com`, the relays and the only possible exits (the
APNs/FCM keys are ours), so onion paths through our own relays and a sealed-token split hide nothing from Flagship.
Both are **dropped**: the two subsections above ("Push relay hosting" and "Push relay over the relay network") are
superseded. What we promise instead:
- **The page owner never learns who the caller is**, with or without call-back. The pseudonymous side always dials
  out; its bare name is never used.
- **"Call anonymously"** leaves no ring-back channel.
- **"Call and allow call-back"** tells the caller plainly: "<name> won't learn who you are. Flagship will know this
  conversation can ring your phone." The ring-back uses today's push path on `.com`.
- **Policy, not cryptography:** no log of who called whom, the channel is deleted on "Stop call-backs" or when the
  conversation ends, and pushes carry no content.

### Deleting a conversation, and revealing who you are (owner, 2026-11-15)

**Delete = forget.** Deleting a conversation in the app (either side) is the only control, and it does three things:
1. The app sends a signed delete for that conversation's mailbox to `.com`, which drops the mailbox, any queued
   messages and its ring-back channel at once. Nothing is kept: no archive and no tombstone (mailbox ids are random, so a
   send or delete to a gone id simply fails).
2. The other side's app sees "This conversation was ended" the next time it asks, and can no longer send or ring
   into it. Its own copy of past messages stays on its device until its user deletes it too: we can't erase another
   person's phone, and the sentence in the delete sheet says so ("Messages already on <name>'s device stay there").
3. The device erases its own copy and the conversation's keys.
4. The owner's (or the caller's) other devices forget it too: the delete writes a deletion marker into the account's
   sealed Messages state, and every device that merges it drops the conversation's archived flag, nickname, accepted
   and read marks, reveal, call records and ring-back state (`voici-and-messages.md` §10.1.1; the marker is ciphertext
   to `.com` and is dropped after 30 days).

**Gated by the person (owner, 0.4).** Because a delete forgets the conversation on every device of the account and
cannot be undone, every delete path asks the person first, after the "Delete this conversation?" sheet and before
anything is signed or sent. A cancelled or failed check deletes nothing and sends nothing: no signed delete reaches
`.com`, no deletion marker is written, the device keeps its copy.
- **iOS:** Face ID / Touch ID with the device passcode as fallback (`BiometricGate`, `.deviceOwnerAuthentication`),
  through `DestructiveAuth.askToDeleteConversation` in `MessagesStore.delete` (owner side) and
  `VisitorConversationModel.delete` (caller side). A cancelled prompt shows "The conversation wasn't deleted."
- **Android:** the BiometricPrompt used for sign-out (biometric or device PIN/pattern/password,
  `AndroidVersionPolicy.promptAuthenticators` / `KeyAuthSpec`), through `confirmConversationDelete` in
  `ui/shell/DestructiveAuth.kt`; `VoiciCenter.deleteConversation` and `deleteVisitorConversation` take the prompt as
  a required `authorize` argument and answer `DELETE_NOT_CONFIRMED` without it. A cancel says nothing.
- **Webapp** (owner side only; it has no caller-side conversation screen): when this browser has a custody passkey
  (`lib/keyCustody.js`), one passkey assertion with user verification required (`verifyUserWithPasskey`); without
  one, this device's passphrase, the re-prompt used before admin orders (`lib/freshUnlock.js`
  `confirmUserForDelete`, which asks for it even when the session holds an admin-key handle). Chosen because the
  passphrase is the only user-verification factor a browser without a passkey has; it checks the passphrase unwraps
  the same account key the session holds. Wired through `lib/voiciWorld.js` `deleteConversationGated`.
- **The Calls list** deletes no conversations on any surface, so it has no gate. A phone with no screen lock at all
  has nothing to ask with and deletes without a prompt (as the lock screen's Sign out does).

**No logs.** `.com` and the relays keep no record of mailboxes created, messages passed, rings sent or deletes,
beyond the live mailbox rows themselves and the aggregate counters we already keep (hourly totals, no ids). Rate
limits count in their existing Durable Objects and forget with their window.

**Reveal who I am (Bob's side only).** The conversation's settings on the pseudonymous caller's device have one
switch: "Show <name> who I am". Turning it on sends, inside the end-to-end conversation, a reveal: Bob's voi.ci page
name (or account name, Bob picks which if he has both) and a signature over
`flagship/voici-reveal/v1|<conversationId>|<pageName>|<issuedAt>` by that page's key. Alice's app checks the
signature against the page key `.com` serves for that name and, if it holds, shows a pill on the conversation and
in the call screen: "<pageName> ✓" (tapping it opens the page). A reveal that fails the check shows nothing.
- `.com` never sees the reveal (it travels sealed like any message).
- Turning the switch off sends an un-reveal; Alice's app removes the pill. The sheet says plainly that Alice may
  already have seen it ("Turning this off hides the name, but <name> may already have seen it").
- Alice's side has no reveal switch: the page owner is already known by her page.
- Ring-back is unchanged by a reveal; it still goes through the conversation's channel, never Bob's bare name.

#### What the reveal shows, and "names aren't checked" (owner, 2026-11-16)

- A page is `voi.ci/<username>`; the username is the unique handle and the page's key is bound to it. The display
  name is free text on the page record (1-64 chars, `voici-and-messages.md` §168), never checked. So the reveal
  carries the **username**, plus the display name copied from the caller's signed page record when one is set.
  The pill reads `Philip Jackson (jumbo-karaoke)`, or `jumbo-karaoke` alone with no display name. The reveal's
  signed bytes become `flagship/voici-reveal/v1|<conversationId>|<username>|<displayNameSha256 or ->|<issuedAt>`;
  the display name travels beside it and must hash to the signed value.
- **An info icon sits right by every printed chosen name** (this pill, and anywhere else we print a display
  name). Tapping it shows a sheet: "This is a name the person chose. Flagship doesn't check names, so anyone can
  use any name." The username line says "<username> is this person's voi.ci page."
- **Verification notes (later, possibly paid; not in 0.4 unless the owner says so).** Opt-in for people who *want*
  to be identifiable (a brand, a public figure); anonymous use is untouched, and a reveal is optional anyway.
  `.com` writes a short plain-text note per username, e.g. "We checked that this account controls nike.com" or
  "We checked that this account runs @jumbo-karaoke on Threads", and signs
  `flagship/voici-verified/v1|<username>|<noteSha256>|<issuedAt>|<expiresAt>` with a pinned `.com` attestation key.
  The info sheet then shows that note instead of "doesn't check names".
  - **No links, no fetching.** The note is plain text only (no URLs rendered as links, no markup); the apps never
    turn it into a link and never fetch anything to show it. The caller's app fetches its own current note and
    carries it inside the sealed reveal, so the person viewing it makes no request at all (nothing tells `.com` who
    looked at whom). The viewer checks the signature against the pinned key and the expiry, offline.
  - Open for the owner: price, how checks are done (DNS TXT for domains, a post for social handles), renewal.

#### Release-manager decisions on the calls-callback questions (2026-11-16, from the owner's answers)

1. **Delete keeps nothing, even though `conv` is derived** (`H(pageId, pseudonym)`). The same caller writing again
   after a delete arrives as a **new request** the owner accepts or ignores like any first message. That is what
   "forget" means; no conv-hash tombstone.
2. **The reveal switch lives in the apps.** The owner put it "on Bob's phone", and calls already start from the app's
   call/chat logs, so the apps get a caller-side conversation screen (Social → the conversations this account
   started on other people's pages: messages, Call, and Settings with "Show <name> who I am"). The app holds the
   page key and signs the reveal; voi.ci tabs don't offer the switch. The `{v:1, control}` message body for reveal
   and unreveal goes into all four ports.
3. **Anonymous calls get hours and blocking in 0.4** ("every feature lands with 0.4"): an hours field in the page
   index honoured for anonymous calls like signed-in ones, and an owner route to block a conversation (the caller
   can't call or write again from that pseudonym; for an anonymous browser, the conversation's channel and the
   proof-of-work identity it used). Block survives until the owner unblocks or deletes the conversation.
4. **`.com` flags ring-back availability** on the owner's inbox items (`ringBack: true|false`), so the apps show
   Call back disabled from the start instead of after a refused ring.
5. **Privacy policy §2.11** overstates: no relay passes a visitor's IP to the owner's box or phone. Wording fix
   proposed to the owner (legal text: owner approves).

## As built: calling back, call modes, delete and reveal (2026-11-16, worktree `0.4/calls-callback`)

Built and tested in TS, `.com`, flagship-web, voi.ci and the webapp; the native screens are in progress (below).

- **The browser handoff** (`flagship/voici-call-handoff/v1`, `voiciCalls.ts`; webapp `lib/voiciCallHandoff.js`, a byte
  copy in flagship-web; vectors `voici-calls` section `handoff`): when the app's media engine is missing it signs a
  voi.ci session for the callee's page (its pseudonym there, a delegation of at most 10 minutes to a P-256 key made
  for the call) and opens `https://voi.ci/<callee>#call=<sid>.<k>`. The tab drops the fragment, listens on `/qr-pipe`,
  and the app delivers the session sealed under the pipe key of the sign-in construction; the relay consumes it, so
  it opens once. The session lives in the tab only. Not a signature: the sign-in answer inside is checked as one.
- **Calling pages you know** (you are the visitor dialling out to a public owner): the webapp's Calls view, Call /
  Video call on the reply rows and on Websites you're signed in to, through a voi.ci tab (`lib/voiciCallOut.js`,
  `views/calls.js`, shell **v219**: v217 was taken by the time this rebased onto v218). The call history is the
  device's own record of placed calls plus the page's missed calls; nothing about who called whom is stored on a server.
- **Page call modes**: the v2 index's `callsFrom` also takes `anyone` and `callback` (all four ports).
- **Anonymous calls** (`anyone` pages; `flagship/voici-call-request-anon/v1`, `voiciCallModes.ts`): signed by the
  browser's own key, a conversation derived from it, and a proof of work on a challenge `.com` MACs
  (`flagship/voici-call-pow/v1`, `GET /api/voici/pages/<u>/call-challenge`, 18 bits by default, 2 minutes, spent once,
  secret `VOICI_CALL_POW_SECRET`; unset = anonymous calls refused). Budgets `voici-call-anon-page` (10 an hour, 30 a
  day per page) and `voici-call-challenge`. An anonymous key's conversation can be blocked for 30 days (storage only;
  no owner route yet).
- **The pop-up** on voi.ci ("Let <name> call you back?", "Call anonymously" / "Call and allow call-back", and "<name>
  won't learn who you are. Flagship will know this conversation can ring your phone."). A callback page shows only the
  second with the reason, and takes a signed-in call only once the conversation's channel is attached
  (`ring-back-required`). "Stop call-backs" in the voi.ci thread.
- **Ring-back** (`flagship/voici-ring-back/v1` by the caller; `flagship/voici-ring/v1` by the owner with a hint sealed to
  the caller's thread key, `flagship/voici-ring-hint/v1`): `POST /api/voici/web/ring-back` (with `?u=` and device headers
  from the caller's app, so the ring push reaches that account's devices; a browser's order names no account) and
  `POST /api/voici/pages/<u>/ring` (owner key). The ring goes as a content-free push on today's path (category
  `voici-ring`: VoIP where registered, else the ordinary push) and shows in the caller's thread fetch (`ring`), so an
  open voi.ci tab rings and offers Answer, which dials out. Migration **0149**. The channel goes on Stop call-backs,
  an owner's block, page removal, the caller's account deletion, a conversation delete, or after 90 days.
- **Delete = forget** (`flagship/voici-conv-delete/v1`, `voiciConversation.ts`, `POST /api/voici/web/conv-delete`, by
  the owner, the caller's pseudonym or the caller's browser): the conversation's mail, alerts, channel, ring, call allow
  and missed calls go at once; a test checks zero rows remain in every table, for each signer. No route here logs.
- **Reveal** (`flagship/voici-reveal/v1|<conv>|<username>|<SHA-256 of the display name or ->|<issuedAt>`, Ed25519 by the
  caller's own page key, the display name beside it; unreveal `{kind:"voici-unreveal"}`), carried inside the sealed
  conversation as a message body `{v:1, control:…}`. Records and vectors (`voici-conversation`) are built; no screen
  sends or shows them yet.
- **Call keys** are deleted when a device's grant is revoked (`/device-grants/revoke`, removing a device, a strict
  re-pair; a device that keeps another active grant keeps its binding).
- **The relay and the caller's address:** neither relay passes the visitor's address to a box or phone. The Rust
  relay's OPEN frame carries only the SNI; between relays the bridge OPEN carries an opaque per-process HMAC of the
  address (`mesh/rebalance.rs` `client_key`), and the TS relay is the same. The PROXY header exists only on the
  `:8444` echo listener, between Fly and the relay. The phone's TURN responder reports a fixed address in
  XOR-MAPPED-ADDRESS. The privacy policy (§2.11, "the page owner's phone then sees the IP address the message came
  from") says more than happens.
- **Tests:** protocol vectors (`voiciCallsVectors`, `voiciCallModesVectors`, `voiciConversationVectors`),
  control-plane `voiciCallModes.test.ts`, `voiciCallKeys.test.ts`, flagship-web `call.test.ts`, `callModes.test.ts`,
  webapp `webappVoiciCallOut.test.ts`, and the Playwright lane `apps/web/e2e/voici-calls` (two Chromium contexts
  against a stand-in `.com` running the real request check and room: a handed-off call, a one-use handoff, an anonymous
  call from the pop-up; set-up through the signed answer and both descriptions, ICE stops there).

### Open

1. **Native screens** (iOS, Android; the forks' work is uncommitted in the worktree): calling known pages through
   `CallMediaEngine` with the handoff fallback, the call history, Swift/Kotlin ports of the anonymous request, the
   ring-back and ring (the phone that answers an anonymous call must accept the anon request's hash and bytes), the
   owner's Call in a thread (`POST …/ring`, which `callVisitor(conv)` should call), the caller app's channel attach
   with device headers and ringing on a `voici-ring` push, the page-mode setting, delete and reveal (switch, pill with
   the unchecked-name info icon), every string through i18n.
2. **Delete with a derived conversation id:** the spec assumes random mailbox ids, but `conv` is
   H(pageId, pseudonym), so a later message from the same caller opens the same id again as a new request. Keeping no
   tombstone means "can no longer send into it" holds only until the caller writes again. Owner: accept, or keep a
   minimal tombstone (the conv hash alone)?
3. **Reveal transport:** the caller's conversations live on voi.ci, which doesn't hold the caller's page key, and the
   apps show only reply notices for them. The switch needs a visitor-side conversation screen in the apps (or the
   app signs the reveal and hands it to the tab). The message plaintext `{v:1, control}` form is a change in four ports.
4. Hours for anonymous calls (needs an index field) and an owner route to block an anonymous caller.

### As built: the release-manager decisions (2026-11-16, `0.4/calls-callback`)

- **Call hours** were first built into the page index; the owner then chose to keep them off it (option c, below).
- **Blocking a conversation:** signed-in callers keep the pseudonym block (calls and messages). An anonymous caller's
  conversation, the browser key its proof of work was made for, is blocked by `flagship/voici-anon-block/v1`
  (`POST /api/voici/pages/<u>/anon-block`, owner key) until unblocked. Deleting a conversation drops its block or
  accept too, so a caller who writes again is a new request; the owner can delete an anonymous conversation (16-byte
  conv). The owner's inbox lists `anonBlocks`.
- **`ringBack: true|false`** on every owner inbox item.
- **The control body** `{v:1, control:<reveal|unreveal>}`: TS `openVoiciBodyAny`, the webapp's port; old readers refuse
  it as `inner-schema`. Vectors `voici-conversation` section `control`.
- **Webapp:** the reveal pill "Display Name (username)" on the row and in the thread (checked against the page key
  `.com` serves; anything failing shows nothing), the info icon beside the display name with "This is a name the
  person chose. Flagship doesn't check names, so anyone can use any name.", Call back in the thread menu when the
  caller allowed it (`flagship/voici-ring/v1` with the hint sealed to the caller's thread key), delete sends the
  signed delete with "Messages already on <name>'s device stay there.", Block / Unblock on anonymous missed calls in
  Calls, and the `voici-ring` push. The webapp has no caller-side conversation screen, so no reveal switch (the apps
  have it).

### Delete forgets on every device (2026-11-16, `0.4/conv-forget`)

Before this, a delete on one device left the conversation's `archived` entry, nickname and accepted mark in the
account's synced Messages state, and the union merge brought them back from the owner's other devices (iOS even
archived on delete, so a later message from the same caller arrived hidden). The state now carries per-conversation
deletion markers (v2, `voici-and-messages.md` §10.1.1): newer marker wins over the other side's entries, entries beside
their marker (made after the delete) stay, markers go after 30 days; each device drops what it keeps by itself once
per marker. TS (protocol, webapp, flagship-web), Swift, Kotlin; vectors `test-vectors/messages` `stateForget`, with
the two-device case (A deletes, B on the old state syncs, gone on both and stays gone) in every port and in the apps
(Android `VoiciConversationFlowsTest`, iOS `MessagesForgetTests`). No `.com` change, no migration. Webapp shell v222.

### Call hours stay on the owner's devices (owner decision 2026-11-16, option c; `0.4/calls-callback`)

Hours in the page index would show the owner's time zone to anyone, so they are **never published**:
- `callHours` is gone from the page index (TS, the webapp, flagship-web; a v2 index carrying it is `malformed`, a
  vector in `voici-calls` pageV2). `.com` never answers `closed`.
- The hours are an owner-device setting synced between the owner's own devices: `flagship/voici-call-settings/v1`, a
  sealed blob like the Messages state (key HKDF of the UMK with that info; AES-256-GCM, aad
  `flagship/voici-call-settings/v1|<username>|<version>`) holding `{v:1, hours: null | {days, from, to, zone}, updatedAt}`
  (days seven 0/1 from Monday, from/to `HHMM`, zone IANA or `UTC`; a conflict keeps the newer `updatedAt`). `.com`
  stores only ciphertext (`GET`/`PUT /api/accounts/<u>/voici-call-settings`, device headers, compare-and-set on
  `version`, D1 **0150**), so no server learns the hours or the zone; account deletion drops it.
- **The ringing phone enforces them** (`voiciCallHoursAllow`): outside them it doesn't ring and the call ends as a
  missed call; the caller, anonymous or not, sees "No answer".
- The webapp's Calls sheet edits the synced setting (time zone defaults to the browser's); its note says only the
  owner's devices know the hours. Vectors `voici-call-modes` section `callSettings` (key, sealed blob, refusals,
  shapes, when a call may ring) for Swift and Kotlin.

## First publish: calls and messages on (owner decision 2026-11-16, `0.4/page-defaults`)

Owner: "when someone makes their page public, they should default to 'yes receive calls from non-anon users, and
accept messages'". The page's **first** publish signs a v2 index with `acceptsMessages: 1`, `acceptsCalls: 1`,
`callsFrom: "signed-in"` (`.com`'s `voiciCallerAllowed` takes every signed-in caller for it, with no ring-back channel
needed; anonymous calls stay refused, since only `anyone` takes them). The shared constant is `VOICI_FIRST_PUBLISH`
(`packages/protocol/src/voiciPage.ts`; webapp `lib/voiciOwner.js`, iOS `VoiciCallSettings.firstPublish`, Android
`VoiciCallSettings.FIRST_PUBLISH` + `VoiciOwner.FIRST_PUBLISH_ACCEPTS_MESSAGES`).
- **First** means this device has seen no published index and no removal (iOS `isFirstPublish`, Android
  `VoiciPageUi.firstPublish`, webapp: no page and no removed copy). A first publish that loses a seq race to another
  device's page merges onto that page and keeps its settings. Re-publishing a removed page is not a first publish.
- A switch the owner turned off before publishing (Accept messages, a draft op) is kept: the editor already shows
  messages on for a page that was never published, so the owner sees the default and can change it.
- **Every later publish keeps the owner's choices** (the "every publish carries the calls fields of the index it
  replaces" rule above, and `acceptsMessages` from the merged page).
- **The publish screen says so:** the public warning ("Make your page public?") shows on every first publish, also
  when this device acknowledged it before, with the added sentence "Messages and calls from people signed in with
  Flagship are on. You can turn them off in Page options." (iOS, Android `page-first-publish-defaults`, webapp; six
  languages, machine drafts).
- **Who can call** on iOS and Android now offers "Anyone signed in with Flagship" next to "Anyone on the internet" and
  "People who let you call them back" (the webapp already listed it); calls turned on by hand later start from the same
  mode.
- **Ringing needs nothing more:** Android rings through the account's ordinary push and registers its Telecom phone
  account when a call arrives. iOS sends its VoIP token only while it can sign as the page (`callKeys()`), so before
  this a phone that published its first page rang only after the next unlock: `MessagesStore.index` now calls
  `MessagesStore.callsTurnedOn` (set by `VoiciCallCenter.start`) whenever calls come on, from a publish here or one
  adopted from another device, and the token goes at once. The call-only key ("Answer calls while Flagship is locked")
  stays off by default.
- Tests: protocol `voiciCallsVectors.test.ts`; webapp `webappVoiciOwner.test.ts` (first publish, a switch turned off
  first, re-publish keeps choices, a lost race keeps the stored page's); iOS `PageControlsTests`
  (`test_firstPublish*`, `test_aRepublishKeepsTheOwnersChoices`), `VoiciCallsViewModelTests`; Android `VoiciAppTest`
  (`aFirstPublish*`, `aRepublishKeepsTheOwnersChoices`), `VoiciCallSettingsTest`; gym `GymMessagesTest` checks the
  warning line and that the first publish is a signed-in calls index. Webapp shell **v225**.
