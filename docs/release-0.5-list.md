# Release 0.5: the work list

Started 2026-11-17 from owner decisions taken during 0.4. Add each item as the owner decides it; the 0.5 journal takes
over once "let's start 0.5" is said.

## Decided for 0.5

0. **FIRST: the store listings** (owner, 2026-11-24). `docs/runbooks/post-0.4-store-listing.md`: API access for
   Claude (App Store Connect key, Play service account), the screenshot improvements the 0.4 set could not make, the
   listing texts, then the upload. The 0.5 release is gated on it (`scripts/check-carryover.mjs`).

1. **The overlay network** (owner, 2026-11-16): key-derived ULA addresses, trusted peers direct and strangers through
   relays, a PQ transport, and one relay mesh. Design: `docs/networking-vision.md`, overlay section.
2. ~~Business / Enterprise plan~~: moved into 0.4 (owner, 2026-11-17: "I meant putting the enterprise features in 0.4").
3. **Cluster backup** (the owner's own servers back each other up, orchestrated by Flagship; a paid feature) and
   **Flagship Vault** (end-to-end encrypted off-site backup space, included in plans plus prepaid blocks). Both are in
   `docs/plans-and-backup-offer.md`.
4. **Community OHTTP relays** (owner, 2026-11-17): volunteers run relays, and a request picks one at random. Registered
   and health-checked, with Sybil limits. The rule from `docs/outbound-proxy.md` "Failure handling" still applies: if
   our infrastructure fails, the system keeps working.
5. **Turn the marketplace on** (owner, 2026-11-19: hidden in 0.4). It is in the code but switched off
   (`docs/runbooks/results/marketplace-findings-2026-11-19.md`). Before the switch: the listing security scanner
   (`scan_grade` ships NULL today; `MARKETPLACE_SCANNER_PUBKEY_HEX`), moderation and reporting (a report/flag on a
   listing, a takedown path, App Review guideline 1.2 for user-generated content), and paid apps (in-app purchase on
   iOS, guideline 3.1.1; Payments step 7 below). Then flip `"marketplace": true` in `release/version.json`, run
   `node scripts/check-versions.mjs --write`, set `MARKETPLACE = "on"` in both wrangler files, bring back the website's
   `/marketplace/` page and links from git history (removed in the `0.4/marketplace-off` website commit), flip the
   tests that expect its absence (they read the switch or say "0.4"), and ship new store builds.

6. ~~**voi.ci posts: a capped server copy, older posts from the phone**~~ pulled into 0.4 (`0.4/posts-cap`, 2026-11-21). (owner, 2026-11-20). `.com` keeps only the
   newest chunks of a page (a cap to choose, e.g. the newest 10 chunks = 200 posts). Chunks stay numbered 0..N, so a
   visitor's browser sees which ones `.com` doesn't hold and asks the owner's phone for them: a signed request over the
   same phone route calls use (`voi.ci/<user>` → the phone's bare name), answered with the chunk exactly as signed in
   the index, so the browser checks it against the index as today. `.com` caches a fetched chunk by its SHA-256 (the
   index pins it, so the cache can never serve a wrong one). Offline phone: "Older posts are on <name>'s phone, which
   is offline right now." Needs a new index version (`chunk-<n>` stops being contiguous on `.com`, or the index lists
   which chunks `.com` holds), phone code on all three apps, and the cap enforced by `.com` at publish with a
   localized refusal. Not in 0.4: it needs a phone update, and 0.4's store builds are being made.
7. **voi.ci comments and reposts** (owner, 2026-11-20). Roots already in 0.4: every post has a stable 32-hex id and a
   permalink (`voi.ci/<user>#p-<id>`). 0.5 design to write:
   - **Comments**: a post's comment stream is keyed by (owner, post id). Followers of a post subscribe to it (a
     subscription is held per visitor key, like Messages' threads, never by account name); a new comment is
     signed by its author, sent to the post owner's phone, which accepts or holds it under the page's message rules
     and fans it out to subscribers (push or the next visit). Best effort: a subscriber who isn't online in time
     misses an update and catches up from the stream on the next visit. Comments show oldest first.
   - **Reposts**: a plain repost puts the original (owner, post id, its chunk hash) on the reposter's page and points
     to the original's comments: one shared stream. A **quote post** is a new post with its own text, so it gets its
     own comment stream; it embeds the original as a card (signed reference, rendered from the original's page) and
     the original can show "quoted by" as a count, not a merged thread. Deleting the original turns the card into
     "This post was removed".
   - Moderation: reports and blocks from Messages apply; App Review 1.2 (user-generated content) needs report, block
     and a takedown path before comments ship.
   - **Owner decision (2026-11-20): who may comment = whoever the owner lets see the page** (public page: anyone the
     page lets in; a limited page: the people it is limited to). One toggle on post creation, "Allow comments", per
     post and sticky from the last choice. No case-by-case moderation (no approval queue). Still needed for the
     stores and the law: the owner can delete a comment on their own post and block its author (Messages' block),
     visitors can report a comment, and `.com` honours takedowns (DMCA, abuse).

- **Rename an account that has servers, pages or Messages** (owner, 2026-11-23). In 0.4 a rename (paid, a friend's name
  grant, or choosing a name at sign-up) only works before the account has a server, a voi.ci page, Messages or a
  quantum-safe key, so the dibs page no longer says "your servers move to the new name with you". Build the re-home in
  docs/naming-recovery-and-name-change.md (every server to `<server>.<new>`, new certificates, the phone re-signs each
  box's entitlement, app links, voi.ci named links, fshp.app names, access lists, offline boxes on their next check-in),
  re-sign pages and Messages records, keep the quantum-safe binding, and teach every client that its account was
  renamed (today a renamed account looks deleted to its other devices). Then put the promise back on the dibs page.

- **Low-order Ed25519 keys, phase 2** (owner, 2026-11-24; external report, severity Low, defence in depth). Phase 1
  (backend, non-breaking) is on `main`: `edSync` refuses any key that is not canonical or is of small order
  (`isAcceptableEd25519PublicKey`) before the memo and the native path; `.com` never attests such a share key; the box
  refuses it as a share member key; shared vectors `packages/protocol/test-vectors/ed25519-low-order/` (TS, Rust).
  Lenient verifiers remain on the clients: CryptoKit (iOS) accepts 10 of the 14 vector keys, the identity key for every
  message; Tink 1.13 (Android) and the webapp's noble/WebCrypto do too. With 0.5:
  1. iOS: one classical Ed25519 helper that refuses these keys before CryptoKit; voi.ci (`CanonicalJson.swift` verify)
     on the strict `PqHybrid` verifier, as Android already is; refuse them at first-sight box-key pins
     (`SecretRequestCoordinator`).
  2. Android: guard every Tink `Ed25519Verify` (or move to BouncyCastle `ed25519VerifyStrict`); refuse at `FirstContact`.
  3. Webapp and voi.ci site: the same rule in both `voiciCore.js` copies, `rescue.js` and every WebCrypto-only Ed25519
     check (`keystore.js`, `serverShare(s).js`, `bootApproval.js`, `boxKeyPins.js`, `maintainerTrust.js`, the Firefox
     extension's `daemonStatus.js`); new shell number, signed shell.
  4. Go boot helper (`installer/unseal-helper`, `lease.go` and `v2.go` verifies): the same guard. Keys there are pinned,
     so it is consistency only; it rides the initramfs, so test a real unlock first.
  5. Swift, Kotlin and Go run the shared vectors.
  6. Decide: full strict verify in `edSync` (noble `zip215: false`: canonical R, cofactorless; honest signatures pass),
     and proof of possession for the share-key attestation (low value: the request already needs the account's admin
     signature and the attestation names no account).
  7. Hygiene: bind `aidPub` and `adminRootPub` into a v2 `ClaimUsername` signature (`usernameClaim.ts`). Not
     exploitable today: `D1UsernameStorage.put` writes both only on the first insert, and swapping them would need the
     victim's own request body (TLS) replayed with other keys inside its 5-minute window.

- **Shrink the phone apps** (owner, 2026-11-24). 0.4 added about 6 MB to each app's download: our libwebrtc build
  (`libwebrtc-157-44099203173` carries every video codec; Android arm64 `libjingle_peerconnection_so.so` 12.8 MB
  installed / 6.1 MB gzipped, iOS arm64 `WebRTC.framework` 10.5 / 5.1 MB) and 1.5 MB of welcome-art PNGs. Calls only
  ever negotiate Opus + VP8 (`checkVoiciCallSdp` / `VoiciCalls.checkSdp` refuse anything else, and the frame crypto's
  clear-header rule is VP8's), so VP9 and AV1 are dead weight. Branch `claude/friendly-goldberg-f0jbky` (`e7be6196e`):
  `tools/libwebrtc/gn-args.txt` drops VP9, libaom and dav1d (H.264 hardware stays); `apply-overlay.py` gains a
  NO_AV1 path for Android's AV1 JNI/jar targets; Android welcome art as WebP (1.49 to 0.14 MB); iOS `WelcomeArt`
  lossy compression. CI run `45414303796`: webrtc-android green, webrtc-ios cancelled (re-dispatch).
  1. Size: `tools/libwebrtc/use-artifacts.sh <green run>`, release builds of both apps, per-ABI `.so` / framework
     size installed and download (App Thinning report, `bundletool get-size`) against 0.4. Under ~1.5 MB of download
     saved per platform: ask the owner whether to keep VP9.
  2. Calls on real devices, audio and video, both directions: iOS and Android each with Chrome and Safari, and iOS
     with Android; audio-only then camera on mid-call, camera flip, an app-placed call and a ring-back; stats show
     VP8 + Opus. Android: `check-aar` passes, no crash at `PeerConnectionFactory` init or reading the codec lists.
  3. All green: `tools/libwebrtc/pin-release.sh <run>`, merge the branch with the new pin, store builds with 0.5.
  4. Webapp: `/welcome-day.png` and `/welcome-night.png` (1.5 MB precached per install; `index.html` `<picture>` and
     the service worker's list) as WebP, PNG fallback optional, in the next signed shell.
  5. Later (not 0.5): VP9 compresses ~30-40 % better than VP8. Using it is a protocol change (the SDP check on three
     platforms, a VP9 clear-header rule in the frame crypto, vectors, VP8 kept for old apps) plus the build flag.

- **Android join registers an empty FCM token** (found 2026-11-26 in the device call test). `JoinDeviceViewModel`'s
  `providerToken` defaults to `""` and `JoinDeviceScreen` never passes one, so every Android join's admit stores a
  `push_tokens` row with platform `fcm` and an empty token, and every push to that account then costs one FCM 400
  ("not a valid FCM registration token"). A build without Firebase (or a phone without Play services) then has only
  that row and never rings. Fix both sides: the join sends the real token of the phone's transport (FCM, or the
  UnifiedPush endpoint with platform `unifiedpush`) or no push registration at all, and `.com`'s admit refuses an
  empty provider token like `serverShares.ts` does (`providerToken required`); delete existing empty rows (one on
  2026-11-26). Same release: `push voip failed` (`pushBridge.ts`) logs which APNs host refused, so a sandbox token
  (Xcode build, 403 `BadEnvironmentKeyInToken` after the sandbox retry) is told apart from a production failure.

- **Store art: three changes that need an app build** (owner, 2026-11-27, from the store-art review; the 0.5 art was
  rendered without them). (1) A "video offered" mark on the ringing screen (iOS `VoiciRingingStage`, Android
  `VoiciCallActivity`; a new i18n string), so slide 01 says the caller offers video. (2) Teal chips on Wear OS (the
  servers list and the tile use the system's grey chips; the brand accent there would match the phone). (3) Wide
  layouts on tablets: a two-pane Social (the list beside the open conversation or the Calls page, iPad and Android
  tablets) and Access control in two columns on a wide screen; the 0.5 art draws both a size larger instead
  (`docs/store-assets/capture-plan.md`, slides 03 and 05). Recapture with `scripts/store-assets/capture-*.sh` after.

- **iOS build chat: English on every language's screen** (found 2026-11-27 rendering the store art). The chat's title
  (`VibeCodeSessionScreen.title`: "Ready to deploy", "Your turn", "Building", "Live", "Failed" …; only "Deploying"
  and "Vibe code" go through `String(localized:)`, though `i18n/ios` already translates them) and the per-reply
  "used N credits" (`ModelMenuText.creditsUsed`, a plain interpolation) are hard-coded English. Wrap both (the
  credits line with a plural), then recapture slide 08 (`capture-ios.sh --only 08`): the 0.5 art shows the English
  title on iPhone and iPad in every language, and its chat has no credits line for that reason.

- **The box's update-order read takes its own read token** (external report, 2026-11-27). The other four consume-once
  deposit reads already need the box's token; `GET /api/server/<d>/update` does not, so anyone with a box's name can
  use up a pending update order. Main already makes the box send its token there (`boxReadToken.ts` OWN_DEPOSIT,
  the update poller's fetch). In 0.5, `.com` gates that read like its siblings (`gateServerRead`; the route test
  `apps/com/test/depositReadGates.test.ts` then expects 401 anonymous). Order: the endorsed box release first (boxes
  learn to send the token through this very lane), then the `.com` that gates it; a box that never took that release
  stops seeing update orders and needs an owner action or a reburn.

- **Org server codes bind to the real box** (external report, 2026-11-27; main keeps unredeemed codes out of the
  export and refuses server-code ceremonies, `e5197fd91`). Before any client issues org server codes: the admin
  client makes an enrolment key carried only in the recipe, `canonicalOrgServerCode` commits to its public key, and
  `handleOrgServerRegister` also needs its signature beside the box's STK (not `delegatedPubKeyHex`). Shared vectors
  TS, Swift, Kotlin.
- **Org reads need the org read token** (external report, 2026-11-27). Main mints and accepts it (seat member key or
  box STK) and requires it where no shipped client reads. In 0.5 the webapp (`orgSeat.js`), iOS, Android and the
  daemon (`orgAuthorityPin.ts`, `orgBoxKeys.ts`, `directory/connector.ts`, plan attestation) send it; `/export` and
  `/keys` need admin or servers-add; `.com` refuses every tokenless org read (no compatibility window, owner). Order:
  the endorsed box release that sends it, then the enforcing `.com`. Shared token vectors. Branch
  `feat/org-read-token-0.5`.
  - **Org invite: link-key proof for read + accept, and withdraw** (found 2026-11-27). Today only the offer is
    encrypted under the link key `k`, so an accept needs no proof that the joiner holds the link. Derive
    `offerKey = HKDF(k, "flagship/org-invite-offer/v1")` and an invite key from `HKDF(k, "flagship/org-invite-key/v1")`
    (Ed25519 plus an ML-DSA half, as accepts are hybrid); `inviteKeyPub` joins `OrgSeatInvite`'s canonical bytes.
    `GET invites/<seat>` needs a fresh invite-key signature over `flagship/org-invite-read/v1|orgId|seatId|issuedAt`
    (±5 min; missing or wrong → 404, as for no invite). The accept carries an invite-key signature over
    `canonicalOrgSeatAccept`, stored and shown in `/seats` so admin clients and connector boxes verify it too. Keep
    the SAS code. New admin-signed withdraw (deletes the invite and any unadmitted accept, logged). Vectors TS, Swift,
    Kotlin, webapp (derivation, read proof, accept proof, negatives); clients webapp `orgJoin`/`orgSeat`, iOS and
    Android `OrgClient`/join/org view models. Pending invites are re-sent after 0.5.
- **Org founder-removal and recovery notices are observed by `.com`** (external report, 2026-11-27; main refuses
  those entries until then, `6dd5a89b0`). The notice is a ceremony keyed by its body hash, opened at least `wait`
  before the append by `.com`'s `openedAt`; the veto window is `[openedAt, openedAt + wait)`; a new `OrgChainOptions`
  input carries the observed open time in every verifier (TS protocol, daemon pin, Swift, Kotlin, webapp bundle).
  Pending approvals and vetoes refuse `notAfter < now` and test the freeze at the signed time or now (as
  `authorizeOrgOrder` does); records get a two-sided `issuedAt` bound. Vectors: a backdated notice, a late veto that
  must count, an evaded freeze. One at a time (owner, 2026-11-27): while one delayed-change notice is open (observed,
  not yet executed, vetoed or withdrawn), `.com` refuses to open another for that org, and the protocol rule holds it
  in every verifier: a delayed change's observed open time must be at or after the previous one's execution. Vector:
  two notices opened in parallel, the second is refused.
- **Per-app visitor identity scoped to the hosting account** (external report, 2026-11-27). App AID v2 =
  HKDF(UMK, `flagship/app-aid/v2|<accountZone>|<appRef>`) in all four twins, their consumers and vectors; a flag day
  (owner: breaking is fine). Settle the zone for fshp.app, custom domains and org zones first.

## Carried over from 0.4

- **Turn on bank transfer for Business batches** (owner, 2026-11-22: launch 0.4 with it off). Built in 0.4; steps in
  `docs/runbooks/payments-setup.md` "Bank transfer for business batches": Stripe bank transfers on (confirm the fee),
  restricted key gains Customers: Write + PaymentIntents: Read, gym sandbox test (partial then full transfer), then
  `STRIPE_BANK_TRANSFER = "1"` on production.

- F14, the parked after-launch work: a second relay by DNS round-robin, Rust production qualification (G10), removing
  old implementations once proven (G8), the gym on IPv6 only, `VOICI_CANONICAL`.
- Payments step 6 (the Monero view wallet, after the accountant's advice) and step 7 (paid marketplace apps, 10% cut).
- WireGuard full tunnel for the outbound proxy.
- OHTTP for every box's setup, and the OHTTP client in the initramfs.
- **Answering while locked from a killed app (owner, 2026-11-21).** "Answer calls while Flagship is locked" works only
  while the app process is alive: VoiciCenter, AppState and the phone route are built by MainActivity, so a call push
  that cold-starts the process finds no call key (VoiciCenter.shared is null) and falls back to "Unlock to answer".
  Build the call path from the push itself (Android FlagshipFcmService, iOS PushKit) without the main screen; test
  with the process killed (`adb shell am kill`) on both phones.

## Reassess at the start of 0.5

- **Voucher-file import on iPhone** (owner, 2026-11-18). 0.4 ships it on Android only. iOS 1.3 takes only the "Load
  into Flagship" link, because a visible file import risks App Review guideline 3.1.1 ("license keys") on the first
  in-app purchase review. Once Apple has approved the in-app purchases, decide whether to add the file import to iOS,
  citing 3.1.3(b) in the review notes. If Apple ever objects to the link, check whether it can be switched off
  without a new build (not verified).
- **Community adapters, turned on together** (2026-11-19). Three pieces must arrive together, or none does anything:
  - the review model: built in 0.4 on Flagship Inference (`apps/com/src/serviceInference.ts`), needs only the
    `FLAGSHIP_INFERENCE_*` settings free AI already uses;
  - `ADAPTER_ATTESTATION_SIGNING_KEY` (`openssl rand -hex 32`, offline copy on the FlagshipKeys volume), with its
    public half added to `release/adapter-vetting-keys.json` in an endorsed box release;
  - `ADAPTER_COMPLAINT_SALT` (`openssl rand -hex 32`).
  Until then `release/adapter-vetting-keys.json` is empty, so boxes keep community adapter lookup off. 0.4 shipped
  them unset on purpose.
- ~~Fit release.sh~~ and ~~remove the VOICI_CALLS switch~~: done in 0.4 (`0.4/release-fit`, 2026-11-21; 32 steps).
- **Make the Google-free push choice visible on Android** (owner, 2026-11-20). FCM is the default where Google Play
  services exist (0.4 sets up Firebase); a phone with a UnifiedPush distributor (ntfy, NextPush, Sunup) already uses
  it instead, even with Play services. Add a Settings line under notifications that says which service delivers
  pushes and, while it is Google, offers "Keep Google out of your notifications: install a UnifiedPush app such as
  ntfy" with a link and a short why (Google sees that a push arrived and when, never what it says or which account).
  Every string through i18n; same idea on the webapp's notification settings if it applies.
- **Marketplace scan secrets before turning the marketplace on:** `SERVICES_CONTROL_SECRET`,
  `FLAGSHIP_SCANNER_PRIV_HEX` and the R2 secrets in the repo (the nightly scan skips while `marketplace` is false).
- Android device reach guard: a test that fails when the merged release manifest has a permission whose implied hardware feature (camera.autofocus, microphone, bluetooth, location.gps, …) is not declared `required="false"` (0.4's phone 12 lost ~1,577 devices this way; fixed in 13). Also build libwebrtc and the TURN FFI for 32-bit x86, or say "calls aren't available on this device" there, and upload native debug symbols to Play.
- Onboarding design pass (owner, 2026-11-21): the overall design looks AI-generated, starting with the logo on the cover (first) screen: plan a real design pass on onboarding, the logo and Home (needs owner direction). The flow itself moved into 0.4 (branch `0.4/onboarding`): no "Lock it to your device." or backup page after creating an account (the voi.ci intro is the one step), Home reminders for cloud recovery, then a backup file, and the voi.ci page, and Cloud recovery says it is a copy locked by a passkey.
- Push registration race: two rows for the same device and token, 13 ms apart (FCM onNewToken and the Settings switch registering together). Dedupe on (device, platform, token) in `.com` (`handlePushRegister`) or serialise in the app.
- From the Play session (2026-11-21): restrict the Gemini API keys Google Cloud flagged; decide whether to exclude Android TV again; look at Play's bundle size warning. (New screenshots and the store name: `docs/runbooks/post-0.4-store-listing.md`.)
- Release testing gap: no test answered a call on a RELEASE build (R8 stripped org.jni_zero: every answer crashed). Add a release-build call smoke to the native gym, and a check that the dex keeps every class the AAR's native code looks up.
