# voi.ci calls v2: video, visitors without an account, paid calls

Status: design, for owner review (2026-11-14). No code. Extends `docs/voici-calls.md` (the audio design, built in
0.4 on `release/0.4`) along the three lines the owner listed at its end. Read with `docs/voici-calls-spike.md`
(measurements), `docs/voici-and-messages.md` (sign-in, pseudonyms, attestations, abuse), `docs/enterprise-accounts.md`
(orgs, seats, plans), `docs/payments-privacy-and-rails.md` (vouchers, rails, store rules) and
`docs/abuse-handling.md`. Section 4 is a short factual briefing on adult content, not a design.

Facts about store, payment-network and legal rules were read from the sources cited inline on 2026-11-14. They are
not legal advice; every "(counsel)" item needs a lawyer before building, and every "(check)" item needs the live
source again at build time.

## 0. The answer in short

1. **Video is an upgrade of an audio call**, never how a call starts. Each side turns its camera on by itself. Same
   path (WebRTC over the answering device's TURNS, relay only), same X-Wing keys, the frame layer gains a video
   format. VP8 first, H.264 (hardware) second, AV1 later. No simulcast (it is one-to-one; simulcast is for
   multi-party servers). 360p at 15-24 fps by default, 720p when the link allows, capped at 1.2 Mbit/s each way.
   Video's frame sizes leak motion; we pad to size buckets and say plainly what still shows (§1.6).
2. **Visitor calls without an account: yes for enterprise (org) pages, no for personal pages** (recommended, §2.6).
   An anonymous caller is a fresh browser key with no attestation and no account to ban, so the controls move to the
   page: business hours, a queue, a per-page budget, proof of work plus an optional privacy-preserving challenge, and
   short-lived blocks. On an org page the org's **box** (not a phone) is the call hub, so agents can answer from the
   app or from a desk in the webapp, and no agent's personal name ever appears to the caller.
3. **Paid calls for org pages, in two phases.** Phase 1: the caller pays the org directly through the org's own
   payment account (Stripe Connect direct charges, the org is the merchant); Flagship takes an application fee and
   never holds the money. Phase 2 (only after counsel): callers pay with Flagship vouchers, which keeps the payer
   private from the org but makes Flagship a payments intermediary with real anti-money-laundering duties (§3.4).
   Calls are bought on the web page, never in the phone apps, so store payment rules do not apply to the caller;
   Apple's 3.1.3(d) would allow non-IAP payment for one-to-one services anyway.
4. **Adult webcam business:** not designed here. §4 lists what the store rules, card networks and laws say. The short
   version: Apple and Google forbid apps that facilitate sexual services, both stores can pull the one app that is
   the trust root of every Flagship server, card networks require identified, age- and consent-verified performers
   and pre-publication review that an end-to-end encrypted live call cannot provide, and US law makes a platform
   that takes a cut and ignores red flags a possible participant in trafficking. The responsible policy is "not
   allowed" (recommended), or a separate, off-store, identified-operator product that is not Flagship.

## 1. Video calls

### 1.1 What stays the same

- The path: browser ↔ entry relay ↔ (mesh hop) ↔ holder relay ↔ the answering device's TURN responder
  (`flagship-turn-lite`), `iceTransportPolicy: "relay"`, TLS ending on the answering device. `.com` arranges and
  never carries.
- The keys: the X-Wing exchange in the signed call request and answer (`voici-calls.md` §2). Video uses its own
  directional keys from the same secret (§1.5), so audio and video counters never collide.
- The signed records: `request` and `answer` gain one field, `media` = `audio` or `audio,video`, the media the side
  is *able* to send. Neither side sends video until it chooses to (§1.4).
- Limits, rings, blocks, reports, 60-minute cap, one call per account: unchanged.

### 1.2 Codecs

| Codec | Browsers | Phones | Encode cost | Fits the frame layer |
|---|---|---|---|---|
| VP8 | all | libwebrtc software (hardware on some Android) | software on iPhone: warm at 720p | yes, with the payload header kept clear (§1.5) |
| H.264 (constrained baseline) | all | hardware everywhere (VideoToolbox, MediaCodec) | lowest battery | yes, but the packetizer parses NAL units: NAL headers must stay clear (§1.5) |
| VP9 | Chrome, Firefox, Safari 17+ | software mostly | high | yes |
| AV1 | Chrome, Firefox, Safari on M3/A17+ hardware (check) | hardware only on recent phones | high in software | yes; best quality per bit |

Plan: **VP8 in phase 1** (it works everywhere and the transform rule is simple and well trodden: Jitsi's end-to-end
encryption keeps 10 bytes clear on a key frame and 3 on a delta frame); **H.264 hardware in phase 2** for battery
and heat on phones, once the transform's NAL handling passes the CI lane on Chrome, Safari and both phones; **AV1
in phase 3** where both ends have hardware. The SDP offers only the codecs of the current phase, so a call never
negotiates one the frame layer doesn't know. The remaining spike items (§1.9) decide whether H.264 can be phase 1.

### 1.3 Bandwidth

Everything rides one TCP connection per leg (the spike's main finding): video adds bytes to a path whose delay
already grows with loss. Rules:

- **Default 360p, 15-24 fps, 300-600 kbit/s; 720p up to 1.2 Mbit/s only on a clean link** (RTT under 100 ms and no
  rising delay for 10 s). `degradationPreference: "maintain-framerate"` for faces; resolution drops first.
- **Audio first.** Audio keeps its constant 24 kbit/s CBR frames and goes out ahead of video in the responder's send
  queue (the TURN responder and the relay call-bridge keep one queue per media type). If the queue holds more than
  150 ms of video, the sender drops video frames to the next key frame and asks for a lower bitrate; audio is
  never queued behind video.
- **Congestion control over TCP.** libwebrtc's delay-based estimator (transport-wide CC) reads TCP retransmissions as
  rising delay, which is what we want; we cap its start at 300 kbit/s and its ceiling at 1.2 Mbit/s.
- **The answering phone's uplink** carries its own video plus the TCP overhead, and its downlink the caller's video.
  On cellular the phone defaults to 360p each way and offers 720p only on Wi-Fi.
- **Relays.** One video call at 600 kbit/s each way is about 0.27 GB per hour per direction per leg; the entry and
  holder relays each see it in and out, a mesh hop doubles it. At Fly's published egress price (about $0.02/GB in
  North America and Europe; check) an hour costs about a cent per relay. The call bridge (`voici-calls.md` §5) keeps
  a call off the shared bridge connection; video makes that mandatory, not optional.
- **The account's relay quota.** Call bytes count toward the account's metered relay bytes like any bare-name visit
  (`docs/metering.md`). A Free account (25 GB, then slowed) gets roughly 90 hours of default video a month. Slowing to
  256 kbit/s past the allowance makes video unusable but keeps audio (24 kbit/s); the app says so before the camera
  turns on.

### 1.4 Starting video, permissions, background

- **Calls start as audio.** Either side taps "Camera"; its video track starts (`RTCRtpTransceiver` already
  negotiated as `sendrecv` but inactive, so no new offer is needed, only `setParameters` active). The other side sees
  "Visitor turned on their camera" and its own camera stays off until it taps too. This avoids a camera turning on
  from a lock screen or a pocket and keeps permission prompts at a moment the person chose.
- **Browser:** `getUserMedia({video})` on the tap, never on load; voi.ci's `permissions-policy` gains
  `camera=(self)` next to `microphone=(self)` (`apps/com/src/voiciRoutes.ts`). A self-view with mirror, a "camera
  off" button, front/back switch on phones.
- **iOS:** `NSCameraUsageDescription` (through i18n, `i18n/ios-infoplist`); CallKit `supportsVideo = true` and
  `hasVideo` updated when video starts. The camera stops when the app leaves the foreground; for video in
  Picture in Picture the app uses `AVPictureInPictureVideoCallViewController` and needs the multitasking camera
  access entitlement (`com.apple.developer.avfoundation.multitasking-camera-access`) to keep its own camera running
  (check the current entitlement rules). Without it, going to the background pauses our video (the remote side
  sees "Camera paused") and keeps audio. Answering from the lock screen is audio; video needs the phone unlocked.
- **Android:** `CAMERA` runtime permission on the tap; the call's foreground service adds type `camera`
  (`FOREGROUND_SERVICE_CAMERA`, Android 14+ declares it); on Android 10-13 the same service type works without the
  extra permission. Camera access from the background is not allowed: as on iOS, the camera pauses when the app is
  not visible, unless it is in Picture in Picture.
- **Watches** (Apple Watch, Wear OS) never show or send video; they answer as audio.
- **The webapp** still doesn't answer (`voici-calls.md` §8), except for org agents (§2.4).

### 1.5 The frame layer for video (`flagship/voici-call-frame/v1`, video)

- Keys: `k_c2p_v = HKDF(ss, salt=th, info="flagship/voici-call-frame/v1|c2p|video")`, `k_p2c_v` likewise. AES-256-GCM.
  Separate counter space; rekey as audio (10 minutes or 2^20 frames).
- Each encoded frame becomes `clear ‖ ctr (8) ‖ AES-GCM(k, nonce = dir ‖ ctr, aad = callId|dir|video|ctr|clear,
  pad(body))`, where `clear` is the codec header the RTP packetizer must read and nothing else: VP8 payload header
  (10 bytes key frame, 3 bytes delta frame); H.264 the NAL unit headers and start codes, each NAL's body sealed
  separately or with a length map (to settle in the spike); AV1 the OBU headers. The `clear` bytes are inside the
  AAD, so changing them breaks the frame. They reveal frame type and resolution, which the RTP stream shows anyway
  inside the TLS to the answering device.
- Padding to buckets (§1.6), then sealed. The receiver checks the bucket size, opens, strips padding, then hands the
  frame to the decoder; a frame that fails to open is dropped and a key frame is requested (one PLI per second at
  most).
- Browsers: the same `RTCRtpScriptTransform` worker; phones: libwebrtc `FrameEncryptor`/`FrameDecryptor` (which see
  the codec header and can leave it clear). If Chrome's SFrame mode (RFC 9605 packetization) ships unflagged on
  every target, it replaces the codec-header rule (check).
- **Cost.** Sealing is cheap: 1.2 Mbit/s is 150 KB/s, and AES-GCM runs at hundreds of MB/s in WebCrypto and with
  hardware AES on phones; per-frame overhead is one async WebCrypto call (well under 1 ms) at 24 fps. X-Wing runs
  once per call. The real cost of the quantum-safe layer for video is **padding bandwidth**, not CPU (§1.6). Quality
  is unaffected except for that bandwidth.

### 1.6 What video leaks, and padding

Audio is constant bitrate, so its wire shape says nothing. Video cannot be made truly constant without wasting most
of the link (key frames are 5-20 times a delta frame), and a variable-size video stream reveals how much moves in
front of the camera (studies of encrypted video streams identify what is being watched from frame sizes alone).

- **Fixed frame rate**: the encoder sends at the chosen fps (frames are never skipped for a static scene; libwebrtc
  is told not to drop static frames).
- **Size buckets**: every sealed video frame is padded up to the next bucket of a short ladder (e.g. 1, 2, 4, 8, 16,
  32, 64 KB), so the wire shows about seven sizes, not exact sizes. Overhead about 25-40% on delta frames (to
  measure).
- **Optional "steady video"** setting per call (off by default): pad every delta frame to the bitrate target's
  frame size and pace key frames, giving a near-constant rate at roughly double the bandwidth.
- **What we claim**: "Quantum-safe video: no one, including Flagship, can see or later decrypt the picture." We do
  not claim the stream hides activity; the (?) help says the amount of movement can show in the traffic's shape, and
  that audio is fully constant.

### 1.7 Battery and heat

- Phone video calls are among the heaviest workloads: camera + encoder + decoder + radio. Hardware H.264 (phase 2)
  roughly halves encode power against software VP8 at the same resolution (measure on device).
- Thermal ladder: on iOS `ProcessInfo.thermalState` and on Android `PowerManager.getThermalHeadroom` /
  `OnThermalStatusChangedListener`: at "serious" drop to 360p/15 fps, at "critical" stop our camera with a notice
  ("Camera turned off: the phone is too warm"). Low Power Mode / battery saver starts at 360p.
- The 60-minute cap applies to video as to audio.

### 1.8 Phased plan

| Phase | Content | Days (one engineer) |
|---|---|---|
| V0 spike | VP8 and H.264 through the transform on Chrome, Safari, Firefox and both phones' libwebrtc; bucket overhead; TCP leg with video + audio priority; thermal on two mid-range phones | 4 |
| V1 | video upgrade, VP8, 360p/720p, bucket padding, browser + iOS + Android UI, camera permissions, thermal ladder, quota notice, i18n | 14 |
| V2 | H.264 hardware, Picture in Picture on both phones (entitlement), "steady video" option | 8 |
| V3 | AV1 where both ends have hardware; QUIC bridge between relays if the mesh moves to it | later |

Tests: the spike harness gains a video lane (fails on a frame outside the bucket ladder, an unopened frame given to
the decoder, or audio delayed by video beyond 40 ms); device runs on iPhone and Android over cellular, with a Wi-Fi
to cellular switch during video.

### 1.9 Open (owner)

- **V-1** Video in 0.4 at all, or after audio has run in production? (Recommended: after; ship V0 and V1 in the next
  release.)
- **V-2** Accept the leak in §1.6 with bucket padding, or require "steady video" always (double bandwidth)?

## 2. Calls from visitors without a Flagship account

### 2.1 What changes without an account

Today a caller is a pseudonym P attested by `.com` ("a Flagship account in good standing vouched for this key"),
with an abuse tag that lets Flagship ban the account behind it. A visitor with no account has none of that:

| | Signed-in caller | Anonymous caller |
|---|---|---|
| Identity | per-page pseudonym P, stable across browsers | a fresh browser key B per browser (per visit if storage is cleared) |
| Who can ban it | Flagship, by account (abuse tag) | nobody durably; the page can block a key, Flagship can rate-limit addresses |
| Cost of a new identity | a new Flagship account (slow start, device caps) | clearing site data |
| Ringing a phone | allowed by the owner's rule | a stranger can ring a phone at will |

So anonymous calls are safe only where ringing a stranger is the point and the answering side is staffed: a
business's support line.

### 2.2 Where calls land on an org page: the box as call hub

An org (`enterprise-accounts.md`) has seats, not one owner, and seats must stay unlinkable from their personal
accounts. The audio design sends media to the answering phone's bare name (`<user>.<apex>`), which would show the
caller the agent's personal account name (SNI, certificate). So org pages do it differently:

- The org names a **call hub server** (one of its boxes, e.g. `support.acme.flagship.services`). The box runs
  `flagship-turn-lite` behind its existing TLS terminator; TLS ends on the org's own box.
- The caller's browser and the answering agent are both TURN clients of that box: the box relays between the two
  allocations, so it carries only sealed frames (the X-Wing keys are made by the caller and the agent's device; the
  box never holds them). This is the same "Flagship never sees media" property, with the org's own hardware in the
  middle instead of the agent's phone.
- Agents answer from the **phone apps** (CallKit / Telecom, as today) or from the **webapp** at a desk ("On shift"
  keeps a WebSocket to the page's queue open, so no push is needed). A browser can't run a TURN responder, which is
  why the box does.
- The answer is signed by the agent's seat key and countersigned by the org's page key (a seat grant scoped to
  "answer calls for page X"); the caller sees "Acme Support" and the agent's display name chosen by the org (the
  seat pseudonym), never an account name.
- Personal pages keep the phone path.

### 2.3 Anonymous caller flow

```text
browser (voi.ci/acme, no sign-in)
  1  page index says acceptsCalls with callsFrom: anyone (org pages only), hours, queue on
  2  browser makes B (non-extractable P-256) and a fresh X-Wing pair; solves the page's admission check (§2.5)
  3  POST /api/voici/calls  {request signed by B, admission proof}   kind "anonymous"
  4  .com: hours open? queue length under cap? address and page budgets? proof valid and unspent? key not blocked?
  5  CallQueue DO for the page: position, estimated wait (no names), "Leave a message instead"
  6  an agent picks up (ring-all on-shift agents, or longest-idle); signed answer; TURN to the hub box; media as §1
```

The record is `flagship/voici-call-request/v1` with `conv` = H(B) (no Messages conversation exists) and a `kind`
field; the browser keeps B in IndexedDB so the agent sees "returning caller" while the same browser keeps its key.
A caller can optionally type a name and a reason before calling (shown to the agent only, sealed to the org's
inbox key like a message).

### 2.4 The org's controls

- **Business hours** per page, in the org's time zone, with holidays; outside them the page shows "Closed: opens at
  9:00" and offers a message (which, for an anonymous visitor, needs the messaging path to accept anonymous messages
  too: same controls, out of scope here).
- **Queue**: maximum length (default 20), maximum wait (default 10 minutes, then "Leave a message"), position shown,
  no hold music in phase 1 (silence frames keep CBR).
- **Routing**: ring all on-shift agents (first answer wins, as today) or longest idle; per-agent "available" toggle.
- **Budgets**: anonymous calls per page per hour and per day (org setting, ceilings set by plan).
- **Blocking**: "Block this caller" blocks B for 30 days (the page's filter, applied first at `.com`); "Block calls
  from this network for 24 hours" blocks the caller's address prefix (an HMAC of the /24 or /56 under a key rotated
  daily, kept in the DO, never written to D1 or logs). Org admins can switch the page to "signed-in callers only" at
  once during an attack.
- **Reports**: the agent can report a call; with no account behind it the report gives Flagship the page, time and
  the hashed prefix only, which is enough to tighten limits, not to identify anyone.

### 2.5 Admission checks that fit the privacy rules

The goal is to make each ring cost the caller something without identifying them or adding a tracker.

| Option | Privacy | Strength | Notes |
|---|---|---|---|
| Per-address rate limit (Durable Object, no storage) | good: address seen, never kept | weak against botnets and CGNAT spillover | always on (exists for every route) |
| **Proof of work** (self-hosted, SHA-256 or Argon2id puzzle, server-issued challenge, difficulty rises with page load) | best: no third party, nothing about the device | moderate: costs a bot farm CPU, costs a phone 1-3 s | recommended default; ALTCHA-style, our own code in `flagship-web` |
| **Private Access Tokens / Privacy Pass** (RFC 9578; Apple devices issue them automatically) | good: the issuer attests "a real device", learns nothing about the site's visitor | good | redeem through Cloudflare's Turnstile or our own issuer; lowers the PoW difficulty for holders |
| Cloudflare Turnstile (managed challenge) | fair: Cloudflare already fronts `.com`, but it adds a script from another origin | good | if used, render it in a sandboxed frame on its own origin (e.g. `check.voi.ci`) that posts a token back, so voi.ci's strict CSP and "no third-party host" rule stay intact |
| reCAPTCHA / hCaptcha | poor (cross-site tracking, Google/Intuition Machines) | good | not recommended |
| Phone number or email verification | poor (an identifier) | good | refused: it is exactly the identity we avoid |

Recommended: rate limit + proof of work always, Private Access Tokens to make it near-free for honest Apple users,
and Turnstile in its own frame only as an attack-time switch the org (or Flagship) can turn on.

### 2.6 Should everyone have this? (owner question)

Recommendation: **org pages only, off by default, with hours and a queue required.** Personal pages keep
"accepted conversations" (D1) and may widen to "anyone signed in with Flagship", never to anonymous.

| | Personal page | Org page |
|---|---|---|
| Who answers | one person's own phones, 24/7 | staff on shift, a queue, hours |
| Harm of an unwanted ring | harassment, stalking, night calls, someone's private phone ringing on demand | a support line doing its job |
| Remedy without accounts | none durable | staff block, budgets, hours, switch to signed-in only |
| Store rules | Apple 1.2 lists "random or anonymous chat" among uses that get apps removed; a personal phone taking anonymous calls looks like it | a business support line is ordinary (businesses already take anonymous phone calls) |
| Payoff | small: friends can sign in | large: customers won't install an app to reach support |

Trade-offs, said plainly: org-only anonymous calls make support reachable from any browser, but they put load
(media through the org's box, budget and abuse handling) on the org and some on us (`.com` admission work and relay
bytes, metered to the org). A middle step for personal pages, if the owner wants one later: anonymous visitors may
leave a **callback request** (a short sealed note), never a ring.

### 2.7 Open (owner)

- **A-1** Anonymous calls on org pages only (recommended), or also on Pro personal pages?
- **A-2** Proof of work as the default admission check; Turnstile only as an attack switch (recommended)?
- **A-3** The call hub on an org box (recommended), or also allow a seat's own phone bare name for small orgs that
  accept linking that seat to its personal account?

## 3. Paid calls for org accounts

Generic: an org page can charge for calls (per minute, a flat fee, or both) and sell in-call items it defines
(e.g. "extend by 15 minutes", "priority in the queue", "follow-up written summary"). Nothing about the feature is
specific to a trade; the terms and §4 decide which trades may use it.

### 3.1 Store rules

- **The caller pays on the voi.ci web page, in a browser.** The App Store and Play rules govern purchases inside the
  apps, not websites; the Flagship apps never sell calls and never link to the call shop outside the US storefront
  (same rule as vouchers, `payments-privacy-and-rails.md` §4.3).
- If an app ever sold calls: Apple **3.1.3(d)** says an app that "enables the purchase of real-time
  person-to-person services between two individuals (for example tutoring students, medical consultations, real
  estate tours, or fitness training)" may use other payment methods; "one-to-few and one-to-many real-time services
  must use in-app purchase" ([Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)).
  A one-to-one support or consultation call fits; a group call would need IAP. Google Play's Payments policy has no
  such named exception (its exemptions are physical goods and services, peer-to-peer payments, bills and
  tax-exempt donations), so an in-app paid call on Android would need Play Billing or a regional alternative-billing
  programme ([Google Play Payments policy](https://support.google.com/googleplay/android-developer/answer/9858738)).
- The org's agents use the apps to answer and see earnings; showing earnings is not a purchase. Payout setup
  happens on the web.

### 3.2 Phase 1: the org is the merchant (Stripe Connect direct charges)

- The org connects its own Stripe account (Express or Standard) from the web console; Stripe does the org's KYB,
  tax forms and payouts. The org sets prices.
- Before the call, the caller's browser runs Stripe Checkout (cards, Apple Pay, Google Pay) for a **prepaid block**
  (e.g. 10 minutes) on the org's account; Flagship's application fee is set on the charge. The checkout result is a
  `flagship/voici-call-ticket/v1|<pageId>|<callId>|<minutes>|<priceRef>|<issuedAt>` signed by `.com`'s CA key after
  the Stripe webhook, bound to the call's B key.
- **Metering** is in the CallQueue / CallRoom DO: it starts at the signed answer and stops at the first signed end,
  or when either side's WebSocket has been silent 15 s. At one minute left the caller gets "Add 10 minutes"
  (a new Checkout, an in-call purchase); at zero the room sends a signed `balance-ended` and both clients hang up.
  `.com` can't cut media it never carries, but the agent's side has no reason to continue unpaid and the caller's
  client ends on the signed notice.
- **In-call items**: priced items the org defines in its page index (`flagship/voici-page/v2` `paidItems`), bought by
  the same Checkout flow, delivered by the agent (the room records "paid: item X"; delivery is the org's duty).
- **What each party learns**: Stripe, the card network and the org's bank learn the payer as with any purchase; the
  org learns what Stripe shows it (by default name and email in Checkout); Flagship learns a charge id, amount and
  page, not the card. The caller is told before paying that the org sees their payment details.
- **Our cut**: an application fee per charge (recommended 10% with a minimum of $0.30, owner decision), on top of
  Stripe's own fees, which the org pays. Enterprise plans could lower it.
- **Refunds**: owner rule "no refunds generally". In phase 1 the org is the merchant, so refunds are the org's
  decision and its chargebacks are its own; Flagship refunds its application fee only when the org refunds. Unused
  prepaid minutes are **change, not a refund**: the remainder of a block is refunded automatically by Stripe partial
  refund (or kept as page credit for the same browser key, org setting). Consumer law to respect (counsel): EU buyers
  of digital services lose the right of withdrawal only after express consent that the service starts at once, so
  Checkout carries that consent line; card networks require the refund policy shown before payment.
- **Fraud**: the org carries card fraud and disputes (Stripe Radar on its account); Flagship's exposure is its fee.
  Flagship caps new orgs (e.g. $500 a day in paid calls for the first 30 days) to keep a stolen-card cash-out from
  running through a fresh org.
- Stripe restricts "content creation platforms that host third-party content" and "sale of stored value or credits
  ... issued by anyone other than the seller" ([Stripe restricted businesses](https://stripe.com/legal/restricted-businesses));
  direct charges keep the org as the seller and avoid stored value. Confirm the platform category with Stripe
  before building (check).

### 3.3 Phase 2: paying with Flagship vouchers (privacy, after counsel)

The privacy-first version: the caller's browser holds $1 blind vouchers (bought on the web shop with card, Monero or
Lightning, `payments-privacy-and-rails.md` §5.2) and spends them into the call, so neither the org nor Flagship
learns who paid.

- **Denomination**: calls need cents. A separate voucher key for "call credit" at $0.10 per token, bought in the same
  packs; or vouchers spent into a per-call escrow and **change** returned as fresh blind tokens at the end.
- **Escrow**: the browser spends N tokens at the room (nullifiers recorded), the room meters as phase 1, then
  credits the org's ledger with minutes used and blind-signs change for the rest to the browser. No refunds beyond
  change (owner rule).
- **Payouts**: the org's earnings ledger on `.com`, paid out through Stripe Connect (the org's legal identity lives
  with Stripe, as for marketplace developers, §5.6 there). Payout hold 60 days (the card dispute window for vouchers
  bought by card), rolling reserve for new orgs, monthly cap until history builds.
- **Our cut**: higher than phase 1 (recommended 20%), because Flagship then carries rail fees (Apple/Google 15%,
  Stripe about 3-5%) and voucher fraud.

### 3.4 Why phase 2 needs counsel first

- **Money transmission and prepaid access.** Vouchers spent only with Flagship are closed-loop prepaid. Vouchers
  that pay third-party businesses, with Flagship collecting and paying out, look like a payments intermediary:
  money-transmitter licensing questions in the US (unless an agent-of-payee structure applies), US prepaid-access
  rules, EU payment-services rules (the commercial-agent and limited-network exclusions are narrow), and DAC7 / US
  1099-K reporting of the orgs' income (counsel).
- **Anti-money-laundering.** Anonymous bearer value in (Monero, gift-card-style vouchers) and identified bank payouts
  out is the shape of a laundering channel: an org can call its own page with vouchers bought by anyone and cash out.
  Processors and banks will ask how it is monitored. Mitigations (holds, caps, KYB, payout limits, a voucher key per
  issue month so payouts funded by fresh card-bought vouchers can be held longer) reduce it; they do not remove it.
- **Stripe's restricted list** (stored value issued by someone other than the seller) applies to selling vouchers
  that are then spent with third parties (check with Stripe).

So phase 1 ships the feature with no money passing through Flagship; phase 2 is a separate decision.

### 3.5 Who may sell calls

- Org (enterprise) accounts only, with a verified business on the payout account (Stripe's KYB), and the page shows
  the org's legal name and support contact next to the price (consumer law; also fewer disputes).
- Terms: a paid-calls schedule (allowed and forbidden categories; §4 decides adult content), the org's duty to
  deliver what it sells, Flagship's right to stop paid calls on a page after reports.
- Categories that card networks treat as high risk (adult, dating/escort, gambling, "inbound teleservices" and
  psychic lines: Visa puts adult content, MCC 5967, in Tier 1 of its Integrity Risk Program, per
  [Visa's VIRP guide (Chile)](https://visa.cl/content/dam/VCOM/regional/lac/SPA/chile/Documents/visa-integrity-risk-program-chile.pdf))
  are excluded in phase 1: they would put Flagship's and the orgs' Stripe accounts at risk.

### 3.6 Work breakdown (phase 1, one engineer)

| Chunk | Days |
|---|---|
| Stripe Connect onboarding, application fee, webhooks, payout views (web) | 6 |
| Call ticket record, vectors (TS, Swift, Kotlin, browser) | 2 |
| CallRoom metering, balance notices, in-call items, change by partial refund | 5 |
| voi.ci: price display, Checkout, in-call top-up, consent lines, i18n | 4 |
| Apps: earnings and per-call paid status (read only), i18n | 4 |
| Terms, privacy policy, paid-calls schedule, store review notes | 2 |

About 23 days, after org accounts and §2 exist.

### 3.7 Open (owner)

- **P-1** Phase 1 with the org as merchant (recommended), or wait for vouchers?
- **P-2** Application fee: 10% (min $0.30)? Lower on Enterprise?
- **P-3** Unused prepaid minutes: automatic partial refund, or page credit for the same browser (org choice)?
- **P-4** Excluded categories list (§3.5), including §4's decision.

## 4. Adult content on paid calls: facts for a decision

The owner floated encouraging a third party to run an adult webcam business on paid calls, with untraceable
customers and action on reports of illicit acts. This section is not a design; it is what the owner needs to decide.

### 4.1 App stores, and what removal would mean

- **Apple 1.1.4** rejects "overtly sexual or pornographic material ... This includes 'hookup' apps and other apps that
  may include pornography or be used to facilitate prostitution, or human trafficking and exploitation." **1.2**: apps
  with user-generated content or services "that end up being used primarily for pornographic content,
  Chatroulette-style experiences, random or anonymous chat ... do not belong on the App Store and may be removed
  without notice." In extreme cases (trafficking, exploitation of children) "appropriate authorities will be notified
  and the apps will be removed from the App Store and blocked from alternative distribution"
  ([Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)).
- **Google Play** does not allow "apps that contain or promote sexual content", including apps that promote
  "sex-related entertainment, escort services, or other services that may be interpreted as providing or soliciting
  sexual acts in exchange for compensation"
  ([Google Play Sexual Content and Profanity](https://support.google.com/googleplay/android-developer/answer/9878810)).
- The test is what the app **facilitates**, not where the money moves: if Flagship's calls become known as a channel
  for paid sexual performances, the Flagship app is the facilitating app even if payment happens on the web.
- **What removal would mean**: the Flagship phone app is the trust root of every server (boot unlock, recovery,
  admin orders, pairing). Removal from either store stops new installs and updates for every user, not just
  callers; repeated violations can end the developer account (IBIS LLC), taking every app under it. Existing
  installs keep working until an OS update or a needed security fix can't ship.

### 4.2 Payment networks and processors

- **Mastercard** (AN 5196, in force October 2021): acquirers of adult content merchants must ensure documented age
  and identity verification of everyone depicted, documented consent, review of content before publication, a
  complaint process (resolved within seven business days) and a way for anyone depicted to have content removed
  ([Mastercard, 2021](https://mastercard.com/news/perspectives/2021/protecting-our-network-protecting-you-preventing-illegal-adult-content-on-our-network);
  [summary, CCBill](https://ccbill.com/blog/new-mastercard-rules)).
- **Visa**: adult content is a Tier 1 "high-integrity risk" category under the Visa Integrity Risk Program (since
  2023); the acquirer must register each merchant and pass a controls assessment
  ([Visa VIRP guide](https://visa.cl/content/dam/VCOM/regional/lac/SPA/chile/Documents/visa-integrity-risk-program-chile.pdf)).
- **Stripe** prohibits "adult services, including prostitution, escorts, pay-per-view ... adult live-chat features"
  and pornography ([Stripe restricted businesses](https://stripe.com/legal/restricted-businesses)). Adult
  businesses use specialist high-risk processors at higher fees and reserves.
- **Live, end-to-end encrypted, unrecorded calls cannot meet "review before publication"**: by design nobody but the
  two parties sees the content. Anonymous payment (vouchers, Monero) is the opposite of what the networks ask
  (identified performers, monitored merchants). A business mixing adult content into Flagship's processor
  relationship would put every Flagship payment at risk.

### 4.3 Law around adult performers (US and EU, in brief)

- **Age and consent records (US 18 U.S.C. 2257, 28 CFR part 75).** A producer of sexually explicit depictions must
  check every performer's age against a government ID, keep the records, and label where they are kept; the
  regulation's definition of a copy includes "the image taken by a webcam"
  ([28 CFR 75.1](https://www.law.cornell.edu/cfr/text/28/75.1)). The Third Circuit struck down the warrantless
  inspection provisions in 2016, but the record-keeping duty itself stands
  ([FSC summary](https://www.freespeechcoalition.com/blog/long-running-2257-legal-battle-over-as-fsc-declares-victory)).
  Who counts as "producer" for a platform that takes a cut is a counsel question.
- **FOSTA-SESTA (2018)** created 18 U.S.C. 2421A (operating an online service with intent to promote or facilitate
  prostitution) and removed Section 230 protection for sex-trafficking claims; under 18 U.S.C. 1591 a party that
  "benefits financially from participation in a venture" it knew, or recklessly disregarded, was trafficking can be
  liable ([H.R. 1865](https://www.congress.gov/bill/115th-congress/house-bill/1865)). Designing a revenue share
  around untraceable customers, knowing the risks below, is the kind of fact such cases are argued on.
- **CSAM reporting (18 U.S.C. 2258A, extended by the REPORT Act, 2024)**: providers must report apparent CSAM, and
  now also child sex trafficking and enticement, to NCMEC when they learn of it, and preserve the report data for a
  year ([S. 474](https://www.congress.gov/bill/118th-congress/senate-bill/474)). Flagship already commits to this on
  the abuse page.
- **Age verification for viewers**: US states require it for sites with a substantial share of sexual content
  (the Supreme Court upheld Texas's law in *Free Speech Coalition v. Paxton*, June 2025); the UK Online Safety Act
  requires "highly effective" age assurance for pornography services (enforced from July 2025). Anonymous customers
  and no account are incompatible with both (counsel for other countries).
- **EU Digital Services Act**: notice-and-action for hosting services (Art. 16), a duty to tell the authorities of
  any suspected crime threatening life or safety (Art. 18), and minors' protection on online platforms (Art. 28);
  the largest adult platforms are designated very large platforms with age-assurance duties
  ([Regulation (EU) 2022/2065](https://eur-lex.europa.eu/eli/reg/2022/2065/oj)).

### 4.4 Why "act on reports" is not enough

- **Nothing is left to review.** A live, end-to-end encrypted, unrecorded call leaves no evidence for Flagship, so a
  report is a claim with nothing to check.
- **The people harmed don't report.** A coerced or trafficked performer, or a child, is not in a position to; a
  paying customer of an illegal act won't. Reports come from rivals and the curious, not victims.
- **This combination is the known typology** for live-streamed child sexual abuse for profit: a local trafficker,
  a remote paying viewer, a live video call, a payment that is hard to trace. IJM and the University of Nottingham
  estimated nearly half a million Filipino children were trafficked to produce such material in 2022, with
  US-originating payments the largest source of suspicious transaction reports there
  ([IJM, Scale of Harm, 2023](https://www.ijm.org/news/1-in-100-children-sexually-exploited-livestreams-new-abuse-images-videos-philippines-last-year-driven-by-foreign-demand)).
  Untraceable customers plus anonymous payment plus encrypted live video is that profile.
- Card-network and legal regimes therefore require **prevention** (verified performers, consent records, review,
  identified merchants), not only reaction.

### 4.5 How it meets Flagship's own rules

- The rules sheet shown before a first publish and a first sign-in already says: "Your page and your messages must
  not contain illegal content, harassment, threats, nudity or sexual content, graphic real-world violence, spam, or
  content that pretends to be someone else." Calls reuse the Messages rules (`voici-calls.md` §9), so sexual content
  on calls is already forbidden.
- The abuse page commits to acting at once on CSAM and reporting it to NCMEC, and to telling the police about threats
  to life or safety (`apps/web/public/abuse.html`, `docs/abuse-handling.md`). An adult business would add reports
  Flagship structurally cannot verify.
- Allowing it would mean changing the terms and the rules sheet in seven languages, the store age ratings, and the
  privacy promises: identity checks for performers and customers would reverse "no identity beyond need".

### 4.6 Policy options

1. **Not allowed (recommended).** Terms and the paid-calls schedule forbid sexual content and sexual services on
   calls and paid calls; adult categories are excluded from payouts; reports lead to the existing notice and
   suspension path, CSAM and trafficking at once. Keeps the store presence, the processors and the product's
   promise intact.
2. **Allowed only for verified, identified operators under strict terms, off-store.** In practice a separate
   product: a separate legal entity and brand, its own high-risk processor, performer ID, age and consent records
   (2257 and Mastercard/Visa rules), viewer age verification where law requires it, identified customers, content
   review that end-to-end encryption prevents, and no connection to the Flagship apps or Flagship's payment
   accounts. It cannot use Flagship's anonymous payment or its store apps, so little of Flagship's design carries
   over.

Decision for the owner: **AD-1** adopt option 1 and write it into the terms' paid-calls schedule.

## 5. Owner rules this design keeps

- **An AI never learns who or where the owner is**: no call metadata, caller name, price, earnings or payout detail
  enters a prompt, a tool result or a staging copy; org support pages are not attached to AI sessions.
- **Per-app identity / unlinkable seats**: agents appear by the org's pseudonym; anonymous callers have per-browser
  keys; nothing links a caller across pages.
- **No hard-coded English**: every new string (call UI, queue, prices, consent lines, refusals) through
  `i18n/voici-site`, `i18n/ios`, `i18n/android`, `i18n/webapp`, `i18n/web`; `npm run i18n` gates.
- **Consent is load-bearing crypto**: answers, tickets and balance notices are signed records the other side checks.
- **Branching**: video, anonymous calls and paid calls ride the release branch only once the owner schedules them;
  paid calls depend on `feat/marketplace`'s payment rail and on org accounts (`feat/enterprise`).

## 6. All open decisions

V-1, V-2 (§1.9); A-1 to A-3 (§2.7); P-1 to P-4 (§3.7); AD-1 (§4.6).
