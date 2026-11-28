# Post 0.4 / pre 0.5: the store listings, done properly

Must be done before: 0.5
Status: OPEN

**Triggers.** "post 0.4", "pre 0.5", "next release", "start 0.5", "store listing", "store screenshots". A session
that hears any of them starts here. The 0.5 release is gated on this file: `node scripts/check-carryover.mjs` fails
when the product version in `release/version.json` is above "Must be done before" and the status still says OPEN.
The 0.5 release preflight (`scripts/release.sh`) and vitest (`scripts/check-carryover.test.ts`) both run that check.
To close this runbook, set `Status: DONE <date>` and write what was uploaded under "Log" at the bottom. Never set DONE
to get past the gate: if the owner drops an item, record that under "Log" with the date and the owner's words.

**When.** Once both stores have accepted the 0.4 builds (App Store 1.3 released, Play 0.4 production live). The 0.4
screenshots (`flagship-store-art-0.4.zip`) may already be uploaded by hand by then (`0.4-browser-tasks.md`, "Store
art"); this runbook then replaces them with the improved set below.

## 1. API access for Claude (owner, once)

With these two keys Claude uploads the screenshots and texts itself, instead of a browser session doing it by hand.
Neither key goes in the repo or in a chat. Put the files where shown, then tell Claude "the keys are in place".

**App Store Connect API key** (signing in to Xcode is not enough: Xcode's account can upload builds but cannot edit
listings or screenshots).
1. App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → Generate API Key
   (request access first if the tab asks; only the Account Holder can).
2. Name `flagship-listing`, role **App Manager**.
3. Download the `.p8` (it can be downloaded only once). Note the **Key ID** and the **Issuer ID** at the top of the
   page.
4. On this Mac: `mkdir -p ~/.appstoreconnect/private_keys && mv ~/Downloads/AuthKey_<KeyID>.p8
   ~/.appstoreconnect/private_keys/ && chmod 600 ~/.appstoreconnect/private_keys/*.p8`, then
   `printf '{"keyId":"<KeyID>","issuerId":"<IssuerID>"}\n' > ~/.appstoreconnect/flagship.json` (ids are not secret).
5. To revoke later: the same page, Revoke. A revoked key stops working at once.

**Google Play service account** (Play has no per-user API key).
1. Google Cloud console (console.cloud.google.com), any project you own (or a new one, `flagship-play`): APIs &
   Services → Library → **Google Play Android Developer API** → Enable.
2. IAM & Admin → Service Accounts → Create: name `flagship-listing`, no project roles.
3. The new account → Keys → Add key → JSON. If the organisation policy refuses key creation
   (`iam.disableServiceAccountKeyCreation`), lift it for this project or tell Claude.
4. Play Console → Users and permissions → Invite new users → the service account's e-mail
   (`flagship-listing@<project>.iam.gserviceaccount.com`) → App permissions → Flagship → **View app information** and
   **Manage store presence** only (no release, no financial permissions) → Invite. It can take up to a day to work.
5. On this Mac: `mkdir -p ~/.config/flagship && mv ~/Downloads/<project>-*.json
   ~/.config/flagship/play-service-account.json && chmod 600 ~/.config/flagship/play-service-account.json`.
6. In Play Console → Publishing overview, confirm **Managed publishing** is on.

**Then Claude** writes `scripts/store-assets/store-upload.mjs` (built 2026-11-25/27: `store-upload.mjs play|appstore [--images <pack>] [--apply]`, the App Store part in `appstore-upload.mjs`; keys only on the Chromebook, the Apple `.p8` encrypted to the YubiKey): App Store Connect API with an ES256
JWT from the `.p8` (app info localizations, version localizations, screenshot sets), and the Android Publisher API
v3 edits (listings, images: `deleteall` then `upload` per type and language, commit with
`changesNotSentForReview=true`). It reads the pack from `upload-pack.mjs`, has `--dry-run` (prints every change
against what the store holds now) and refuses a stand-in or missing capture, as the pack does. Show the owner the
dry run before the first real run.

## 2. Screenshot improvements (Claude, before re-rendering)

What the 0.4 set could not do (`docs/store-assets/capture-plan.md` is the per-slide source of truth):

1. **01, the incoming call.** It shows the app's own ringing screen, not the system lock-screen call (CallKit /
   Android's full-screen call UI cannot be captured in a simulator or emulator) and has no "video offered" mark.
   Options: add the video mark to the ringing screen in the apps (i18n string; needs a store build), and/or the owner
   takes real screenshots of the locked-phone call on the test iPhone and Galaxy with the store world's demo account
   (one per language, status bar cleaned in post). Ask the owner which.
2. **02, Social.** Calls live behind the call button (missed-call badge), so the slide shows no call list. Either
   re-shoot 02 on the Calls screen, or build a real two-pane Social on iPad and Android tablets (list + conversation /
   calls) and capture that. Neither app has a two-pane Social today; the second is an app feature: ask the owner.
3. **Android tablet 05** (family and access) is captured at a higher density to fit three members, so its text is
   smaller than the other tablet slides. Fix the layout (two columns on wide screens) or capture with two members.
4. **iPhone 04, German.** App summaries are cut with "…" (English is cut too). Shorten `summaryByLang` in
   `store/demo-world.json` (and `summary`) until each fits one line, or let the row wrap to two lines.
5. **iPad status-bar date** reads "Sat Oct 21" in English in every language: set the simulator's own language and
   region (AppleLanguages / AppleLocale in the simulator's global preferences) before each language's capture in
   `capture-ios.sh`, not only the app's.
6. **French "GB"** where it should say "Go": find the byte-size formatting that is not localized (check iOS and
   Android; the iOS strings already use "Go") and fix it in the app (needs a store build).
7. **Home filter chips clipped** in German and Japanese: an app layout fix (scroll or wrap the chips).
8. **Apple Watch**: the clock shows the real time and the screen title is "Security". Override the watch
   simulator's status bar time (9:41) and capture the servers screen.
9. **Android admin device named "Pixel 9"** in the store world: give it a neutral, per-language name.
10. Re-render (`npm run store-assets:render`), `npm run store-assets:release-check`, `npm run i18n`, look at every
    contact sheet (`store/out/review/<lang>.html`), then `node scripts/store-assets/upload-pack.mjs <dir>`.
11. Optional: a Play promo video (owner's), a refreshed feature graphic if the headline changes.

Already done in 0.4 (do not redo): device ≥ 80 % of the width, centred closing card, landscape tablet captures,
darker eyebrow labels, tighter watch slide, slide order 01 call … 07 watch, the store name on the closing card.

## 3. Listing texts (Claude drafts, owner approves)

Source: `store/listings/<lang>.json` (`appstore`: name, subtitle, promotionalText, description, keywords, whatsNew;
`playstore`: title, shortDescription, fullDescription, whatsNew). Check: `node scripts/store-assets/listings.mjs
counts`.

1. **Check the name took.** App Store name "Flagship: voi.ci & Cloud" and subtitle "Calls & messages on voi.ci"
   were set with 1.3; Play's title the same. Confirm in both consoles, in every language; the old "Flagship Hub"
   must be gone everywhere.
2. **Settle the `_todo` notes** in each listing file against what 0.4 really shipped: plans (which in-app purchase
   rail is live; otherwise "Flagship is free. There is nothing to buy."), direct access (only once fshp.app's old
   records are gone), UnifiedPush (Play only, only with `WEBPUSH_VAPID_*` live), the Firefox extension (only once on
   addons.mozilla.org), Business (only if orgs launched). Remove lines for what did not ship, in every language.
3. **Native review** of every translation: each file's `review` says `"source"` (machine draft) until a native reader
   has gone through it. Ask the owner who reviews which language; record it in the file's `review`.
4. **Keywords** (App Store, 100 characters each language): voi.ci, voici, calls, messages, cloud, server, backup,
   private, in the language. **Promotional text** can change at any time without review: use it for news.
5. **What's New** for the next version (1.3.1 / Play's next code) from `docs/release-notes/`.

## 4. Upload (Claude, with the keys from step 1)

1. `store-upload.mjs --dry-run`, shown to the owner; then the real run.
2. **App Store:** screenshots and version texts go only on a version that is editable ("Prepare for Submission"):
   1.3.1 or the next. Delete the old screenshots in each localization first (the script does), es-ES and es-MX take
   the same files. Never press Submit for Review without the owner's say.
3. **Google Play:** a listing update with managed publishing on, committed with `changesNotSentForReview`; the owner
   sends it for review and publishes in the console. Wear OS images under the Wear OS form factor.
4. Check both stores' public pages in two languages after they go live.

## Log

(dated lines: what was uploaded where, which items the owner dropped, then `Status: DONE <date>` above)

- 2026-11-25/26: Play service account in place (Chromebook). `store-upload.mjs play` staged the 0.4 texts
  (title "Flagship: voi.ci & Cloud", short and full descriptions; en-US, es-ES, es-419, fr-FR, de-DE, pt-BR, ja-JP,
  zh-CN) and the final 0.4 art pack from the Mac (`flagship-play-art-0.4.zip`, sha256 c306f437…: phone, 7", 10" 8
  each, Wear 3, feature graphic; es-419 takes es-ES). Play had still shown the 0.3 texts and screenshots. Staged
  under managed publishing; the owner sends for review. The listing files' `_todo` gates are settled (plans, direct
  access, UnifiedPush, Business shipped); only the Firefox note stays. Open: §2 improved set (owner answers on 01/02),
  §3.3 native review, App Store key and upload.
- 2026-11-27: AI review of all six translations (one reviewer per language, briefed as native store copywriters; the
  human native review of §3.3 is still open), fixes in `de695cca1`; zh-Hans made China-storefront safe (no proxy, no
  ringing promise, no USD). A design review of the 0.4 pack went to the Mac, which is re-rendering both stores with
  it (§2). App Store key set up (Chromebook, encrypted to the YubiKey): with 1.3 live and no editable version, only
  promotional text changed (es-ES, fr-FR, pt-BR). Play: the corrected texts wait until the batch in review is
  published. Next: create 1.3.1 in App Store Connect for names, texts and screenshots; upload the re-rendered pack.
- 2026-11-27: §2 re-rendered on the Mac (not uploaded). New order 01 call (with the caller's voi.ci page in a browser
  frame, caption "Anyone can call you. No number needed."), 02 Home, 03 Social's Calls page, 04 apps (own voi.ci link
  each), 05 access, 06 backups, 07 watch, 08 build chat; Play feature graphic with the ringing phone and a two-part
  line. Done from §2: #2 (Calls page), #3 (Android tablet 05 shows the members at the run's density), #4 (shorter app
  summaries), #5 (iPad date in the simulator's language), #8 (watch clock 9:41; the screen is still titled "Security":
  the watch app has no servers-only screen), #9 ("My phone" per language). Still open: #1 video mark, #6 "GB", #7
  chips (app changes; the first is in docs/release-0.5-list.md with teal Wear chips and wide tablet layouts), and the
  iOS build chat's English title (release-0.5-list). Pack `flagship-store-art-0.4.zip` (309 images, appstore/ and
  playstore/), sha256 f1756b65…c07cc204.
- 2026-11-28: draft2 pack from the Mac (sha256 73ecedb3…855f, 309 images, sources on main): slide 01's frame no
  longer covers the encryption line, locale-aware sizes ("3,4 Go"), French Wear 07b "À déverrouiller", iPad 03 and 05
  at full width (#6 done). App Store: version **1.4** created by API in "Prepare for Submission"
  (`store-upload.mjs appstore --create-version`); names, subtitles, texts and screenshots (iPhone 6.9", iPad 13",
  Watch Ultra) written in all 8 locales, es-MX new; the old 6.1" iPhone sets removed (`--prune APP_IPHONE_61`); the
  English iPhone Duo set (5 old shots) kept until the pack has a Duo size. Not submitted: the owner attaches the 0.5
  build and submits. Play: dry run with draft2 = texts in 7 locales + 40 image sets; staged once the batch in review
  is published. Still open: slide 08's English title on iOS (0.5 build), a Duo capture, §3.3 native review.
