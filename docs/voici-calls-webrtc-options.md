# voi.ci calls: which WebRTC stack the phones use

Status: options for the owner (2026-11-15). Nothing is chosen; the apps ship `StubCallMediaEngine` until then.
Read with `docs/voici-calls.md` (the call design, §11.2 the frame layer) and `docs/voici-calls-spike.md` (the
measurements that chose WebRTC over our own frames).

## What the phone's stack must do

- Talk to the **visitor's browser**, which uses its own built-in WebRTC. So the phone must speak standard WebRTC:
  ICE (relay candidates only, over TURNS to the phone's bare name), DTLS-SRTP, Opus, VP8 (video, v2 §1).
- Let us **seal every frame** before it leaves (`FrameEncryptor` / `FrameDecryptor` in libwebrtc terms). Quantum
  safety comes from that X-Wing frame layer (`voici-calls.md` §2), not from DTLS. DTLS 1.3 with X25519MLKEM768 is
  welcome when available but is **not** a requirement any more: the earlier wording overstated it.
- Good audio: echo cancellation, noise suppression and gain control. Hardware video codecs. Background audio
  (CallKit / ConnectionService).
- Size and supply chain: the phone app is the trust root of every Flagship server, so a third-party binary inside
  it is a real risk to weigh.

## Options

| | A. libwebrtc, built by us | B. libwebrtc, a maintained prebuilt (LiveKit `webrtc-sdk`, Stream `stream-webrtc-android` / `WebRTC.xcframework`) | C. Pion (Go, via gomobile) | D. Rust: str0m or webrtc-rs | E. No WebRTC: our own frames (WebCodecs in the browser) |
|---|---|---|---|---|---|
| Browser interop | Best: the same code as Chrome | Best (a fork of the same code) | Good, widely used with browsers | str0m good; webrtc-rs says "early stage" | Needs our own browser client; no WebRTC |
| Frame sealing hook | `FrameEncryptor` / `FrameDecryptor` built in | Same; LiveKit's fork exposes `FrameCryptor` (check the exact API on the pinned build) | We own the RTP path, so it's easy | We own the RTP path (sans-IO in str0m) | Ours by design |
| Echo cancel / noise / gain | Built in (WebRTC APM) | Built in | **None**: use the platform (iOS VoiceProcessingIO, Android AEC/NS) | **None**, same as C | Browser side via `getUserMedia`; phone side via the platform |
| Codecs | Opus, VP8/VP9/AV1, H.264 hardware | Same | Bring your own (libopus, libvpx or platform) | Bring your own | Bring your own (WebCodecs in the browser) |
| DTLS 1.3 / PQ group | Whatever upstream enables; a self-build can turn on what BoringSSL has | Lags upstream | pion/dtls (check DTLS 1.3 status) | Depends on the crate (check) | Not needed (our own transport) |
| Binary size | Large (roughly 10-25 MB per architecture; measure) | Same | Go runtime + stack, a few MB, plus codecs | Small stack, plus codecs | Smallest |
| Build and upkeep | Heaviest: depot_tools, hours per build, tens of GB; we must follow Chrome's security releases | Lightest: a pinned dependency; we follow the vendor | Moderate; a second language (Go) in both apps | Moderate; fits our Rust crates (keyd, relay, ingress) | Heaviest product work: jitter buffer, loss concealment, congestion control are ours |
| Supply chain | Ours: reproducible from an upstream tag | A vendor's binary in the trust-root app (pin by hash; still their build) | Source we compile | Source we compile | Ours |

## Recommendation

**B now, A before general availability.**
- **B now:** pin LiveKit's prebuilt by version and checksum, behind the existing `CallMediaEngine` interface. That
  unblocks real calls in 0.4 quickly; the X-Wing frame layer keeps the call quantum-safe whatever DTLS the vendor's
  build negotiates.
- **A before GA:** in CI, build libwebrtc from the same upstream tag, so the trust-root app carries no vendor
  binary. Because both A and B are libwebrtc, the switch is a dependency swap behind the same interface.
- **Why not C, D or E:** each one makes us own echo cancellation and codecs on both phones. That is months of audio
  work, and audio quality is what users judge calls by. D stays attractive later because it would share code with
  our Rust relay, but webrtc-rs calls itself early stage.

## Owner decision needed

1. Accept B now plus A before GA? Or go straight to A, which delays real calls by the CI build work (about 1-2 weeks)?
2. Which vendor for B: LiveKit (maintains a FrameCryptor-capable fork for iOS and Android) or Stream?

## Sources (read 2026-11-15)
- OpenSSL adds DTLS 1.3: https://openssl-library.org/post/2026-09-09-dtls-1.3/
- RFC 10024, PQ/T hybrids for TLS 1.3: https://datatracker.ietf.org/doc/html/rfc10024
- LiveKit webrtc-sdk (prebuilt iOS and Android): https://github.com/webrtc-sdk , https://github.com/webrtc-sdk/android
- webrtc-rs status: https://github.com/webrtc-rs/webrtc , https://webrtc.rs/blog/2026/01/18/rtc-feature-complete-whats-next
- Pion: https://pion.ly/blog/

## Where the built library lives (owner question, 2026-11-15)

**Users never download it separately.** libwebrtc is compiled into the iOS app and the Android APK/AAB at build time,
the same way every other library is. Browsers (voi.ci visitors, the webapp) use the copy their vendor ships, so the
web needs nothing from us.

The only question is where our **build machines** fetch the finished library from when they build the apps. Building
libwebrtc takes hours, needs about 30 GB of disk, and doesn't fit on this Mac, so the apps don't rebuild it on every
app build. Options:

| | How | Pros | Cons |
|---|---|---|---|
| 1. Release asset on the public repo | CI builds it and attaches it to a GitHub Release, e.g. `libwebrtc-<milestone>`. SPM `binaryTarget(url:checksum:)` and Gradle download it, checked by SHA-256. | Free, simple, and anyone can rebuild it and compare checksums (the source and the build script are public anyway). | It's a public download (harmless: it's an open-source library). |
| 2. Private bucket (R2) | CI uploads it to a private R2 bucket; build machines use a read token. | Not public. | One more secret on every build machine and in CI; costs a little. |
| 3. Git LFS in the repo | Commit the binaries with LFS. | No extra service. | Tens to hundreds of MB per version in LFS; LFS bandwidth quotas. |
| 4. No storage: build it inside every app release workflow | The app's release CI builds libwebrtc first, then the app. | Nothing stored anywhere. | Every app release takes hours longer; local builds can't use it. |

**Recommendation: 1.** It's free and verifiable, and the library is open source. The checksum pin in the app makes a
swapped file fail the build. Whichever you choose, the app itself carries the library inside it; nothing changes for
users.
