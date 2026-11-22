# Release 0.5: the work list

Started 2026-11-17 from owner decisions taken during 0.4. Add each item as the owner decides it; the 0.5 journal takes
over once "let's start 0.5" is said.

## Decided for 0.5

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

6. **voi.ci posts: a capped server copy, older posts from the phone** (owner, 2026-11-20). `.com` keeps only the
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

## Carried over from 0.4

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
- **Service worker: a non-JSON shell manifest is "missing", not "broken"** (CI agent, 2026-11-20). An HTML answer
  for `/shell-manifest.json` (wrangler dev's SPA fallback, the gym Worker) leaves a service worker that never
  installs. Fix `checkAgainstManifest` in apps/web/public/webapp/service-worker.js; needs a shell bump and re-sign.
- **Marketplace scan secrets before turning the marketplace on:** `SERVICES_CONTROL_SECRET`,
  `FLAGSHIP_SCANNER_PRIV_HEX` and the R2 secrets in the repo (the nightly scan skips while `marketplace` is false).
- Android device reach guard: a test that fails when the merged release manifest has a permission whose implied hardware feature (camera.autofocus, microphone, bluetooth, location.gps, …) is not declared `required="false"` (0.4's phone 12 lost ~1,577 devices this way; fixed in 13). Also build libwebrtc and the TURN FFI for 32-bit x86, or say "calls aren't available on this device" there, and upload native debug symbols to Play.
- Account creation, first screens (owner, 2026-11-21; discuss before building): the "Lock it to your device." screen right after creating an account (Android `ui/screens/BiometricSetupScreen.kt`; check the iOS and webapp equivalents) feels strange and unnecessary. Owner's proposal: go straight to Home, as older versions did, with a reminder to set up cloud recovery. Also rethink how cloud recovery is shown: today it is a toggle, and it isn't clear what turning it on means or why there is no password field (it is passkey-based: say so in plain words, or make it a guided step instead of a switch).
  - Same flow, more from the owner (2026-11-21): the backup page that follows also feels weird and should be skipped (a Home reminder instead, like cloud recovery). Home has no reminder or link to create a social (voi.ci) page: add one. The overall design looks AI-generated, starting with the logo on the cover (first) screen: plan a real design pass on onboarding, the logo and Home.
  - Keep (owner, 2026-11-21): the onboarding page that pushes the voi.ci page (iOS `Onboarding/OnboardingFlow.swift` intro; Android `ui/screens/VoiciIntroSheet.kt`) stays: it is the one onboarding step after account creation; lock and backup become Home reminders.
- Push registration race: two rows for the same device and token, 13 ms apart (FCM onNewToken and the Settings switch registering together). Dedupe on (device, platform, token) in `.com` (`handlePushRegister`) or serialise in the app.
- From the Play session (2026-11-21): restrict the Gemini API keys Google Cloud flagged; decide whether to exclude Android TV again; look at Play's bundle size warning; new iOS screenshots; rename the App Store listing from "Flagship Hub" (name/subtitle) when 1.3 is live.
- Release testing gap: no test answered a call on a RELEASE build (R8 stripped org.jni_zero: every answer crashed). Add a release-build call smoke to the native gym, and a check that the dex keeps every class the AAR's native code looks up.
