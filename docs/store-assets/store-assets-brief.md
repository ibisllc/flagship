# Flagship store assets: creative brief (v2, for owner review before build)

Status: **proposal**. Nothing here is built. The owner approves or edits this brief, then asks for the build
(README.md in this folder). Every size below must be re-checked against the stores' own pages on build day
(they change); the build script should fail rather than guess.

## 1. What we are making

App Store (iPhone, iPad, Apple Watch) and Google Play (phone, 7" and 10" tablet, Wear OS) listing visuals for
Flagship 0.2 Beta in **en, es, fr, de, pt-BR, ja, zh-Hans**: captioned screenshots, the Play feature graphic and the
hi-res icon. One template system and one string table produce every language and size; no asset is ever hand-edited
per language.

Out of scope for this round: app preview videos, Mac/Windows/Linux Studio listings (Studio is not on a store), right-
to-left languages, Traditional Chinese (not a shipped language; the apps show it English, see
`test-vectors/language-negotiation.json`).

## 2. The idea

**Lead with the outcome a stranger understands in one glance, then the trust story.** A cold store visitor does not
yet know what "the phone is the key" protects. The first frame says what they get (their own cloud, at home, that only
they can read), the second shows the one moment no competitor has (the phone approving a server's start-up), the third
shows it is useful on day one (apps). Everything after that is for the visitor who is already interested.

Tone: calm, exact, a little ceremonial. Short sentences, no exclamation marks, no superlatives ("best", "ultimate",
"military-grade"), no fear marketing. Every caption must be literally true of 0.2 Beta (App Review guideline 2.3,
Play's metadata policy): if a reviewer could not reproduce it in the app, it does not go on a slide.

## 3. Look

The store art uses the product's own design system (`docs/design-system.md`), so the listing looks like the app it
sells. The first draft's palette (`#0B1220`, `#F8FAFC`) and Inter were not Flagship's and are dropped.

| Role | Light slides | Dark slides |
|---|---|---|
| Background | paper `#F7F6F2` | warm near-black `#0A0A09` |
| Caption text | ink `#14140F` | cream `#ECE7D6` |
| Accent (one per slide: a rule, a ring, a marker) | teal `#14B8A6`, never as text on paper (2.3:1) | `#2DD4BF` |
| Hairlines | `#E5E3DC` | `#25231C` |

* **Type.** Captions in Geist 500, tight tracking (−0.02em), sentence case. The small eyebrow above a caption
  (slide number and theme word, e.g. `01 · YOUR SERVER`) in Geist Mono, uppercase, letter-spaced, ink-muted.
  Geist has no Japanese or Chinese glyphs: ja uses **Noto Sans JP** and zh-Hans **Noto Sans SC** (both OFL), weight
  500 for captions, matched visually to Geist's x-height; the eyebrow stays Geist Mono (it is digits and a Latin
  theme word, translated words in the eyebrow go to Noto). No mixed-script line uses a fallback chain the renderer
  picks at random: the template sets the font per language.
* **Mark.** The square/ring/core logo appears once per strip, large and cropped, on slide 1 and the closing slide.
  It is not repeated on every frame (it reads as an ad, and costs caption room).
* **Devices.** Real screens in a flat, current-generation device outline (no 3D tilt, no hands, no stock photos, no
  flags or globes). Light and dark alternate by slide (1 light, 2 dark, 3 light …) so the strip has rhythm, and both
  themes are shown honestly.
* **Continuity.** A single teal hairline runs across the bottom of every slide at the same height, so the strip
  scrolls as one line. It is the only decoration.
* **Legibility at thumbnail size.** In search results Apple shows three screenshots at roughly 1/7 scale. Captions are
  sized so the cap height is at least 3.2 % of the image height (≈ 92 px on a 2868 px iPhone frame; CJK glyphs at the
  same em size, which reads ~10 % larger, so they are set at 0.92 em), never more than two lines.

## 4. The story (7 slides; Play shows up to 8, the App Store up to 10)

Seven is enough to tell it once; a ten-slide strip repeated itself (the draft's "nothing leaves unsealed" and "your
phone is the key" were the same claim twice). The first three carry the listing: they are the ones shown in search.

| # | Theme (eyebrow) | Caption (English, ≤ 6 words) | Screen captured | Mock-gym state (proposed name; to add) |
|---|---|---|---|---|
| 1 | YOUR SERVER | Your own cloud, at home. | Home: two servers online, one leader, apps count | `world=home-two-servers` |
| 2 | YOUR PHONE | It starts only when you approve. | The start-up approval sheet with Face ID / fingerprint prompt | `world=unlock-request` |
| 3 | YOUR APPS | Apps that live on your server. | Services list with 5 apps (Notes, Photos, Recipes, Chess Club, Budget) | `world=apps` |
| 4 | YOUR PEOPLE | Invite family. Keep the keys. | An app's Access control: Members only, three members with ranks | `world=members` |
| 5 | YOUR BACKUPS | Backups only you can open. | Backups section: nightly backup kept on this phone, last backup today | `world=backups` |
| 6 | AT A GLANCE | Status on your wrist. | Watch (iOS) / Wear OS tile: two servers online, nothing waiting | `world=home-two-servers` |
| 7 | (none) | Flagship. Your cloud, your keys. | Closing card: the mark, the caption, `flagshipserver.com` | (template only) |

Why these and not the draft's:
* **Build with AI is not a slide in 0.2.** Free AI credits are a limited-time promotion with a weekly allowance; a
  price or "free" claim in a screenshot outlives the promotion and Apple and Google both reject outdated pricing in
  art. It can come back as slide 4 when it is a standing feature, with "your own AI key" as the honest caption.
* **No marketplace, payments, custom domains or name change**: they are not in `main` (AGENTS.md "Unlaunched
  features"), so they cannot be shown.
* **"Encrypted at rest, keys on device"** is real but abstract; slide 2 *shows* it (the server waits for the phone),
  and slide 5 says what it means for backups.
* **Watch/Wear** moves to slide 6 and is cut first if a listing wants fewer.

Five-slide cut (if a store surface trims): 1, 2, 3, 5, 7.
Caption alternatives the owner may prefer (all ≤ 6 words): slide 1 "A personal cloud you own."; slide 2 "Nothing
starts without your phone."; slide 3 "Install apps on your server."; slide 5 "Encrypted backups, kept by you."

### Claims each caption must stay true to

* Slide 1 "at home": the server runs on the owner's hardware (a box, or a VM in Studio on their computer). Hosted
  servers in a datacentre are not shown or implied.
* Slide 2: true for the default unlock mode (phone approval each start). Auto-unlock exists and is opt-in; the slide
  must not say "always".
* Slide 4 "Keep the keys": people invited to an app get access to that app, never the account keys
  (`docs/service-access-gating.md`). Do not caption "share your server" here: that is a different feature (co-manage).
* Slide 5: backups are encrypted to the account; a passcode backup opens elsewhere. "Only you can open" holds for the
  default (no passcode) backup shown on screen.
* The listing never says flagshipserver.com "cannot read" anything without the qualifier the app itself uses: it
  relays encrypted traffic and holds the account identity.

## 5. Demo data (the screens must not show a real person)

Captures come from the apps' **mock gym** (iOS `GymProbe` + `smokeInitialDestination`, Android's smoke world), never
from a real account. The data set is fixed in one file, `store/demo-world.json`, shared by both platforms:
* Account `@river-otter` (a generated handle, like a real one); servers `home` and `cabin`; apps Notes, Photos,
  Recipes, Chess Club, Budget; members "Ana", "Kenji", "Lea" (first names only, from different languages, so no
  locale looks like the default).
* Times are relative ("today", "2 min ago"), so no date format is pinned to one locale.
* The same world in every language: only the UI language changes between captures, which is what makes the strip
  comparable and the review sheet useful.
* Nothing from a real box, no real IP, no real domain other than `flagshipserver.com`; the AI-privacy rule in AGENTS.md
  applies to screenshots too.

## 6. Localisation

* Screens are the **real app running in each language** (iOS `-AppleLanguages (ja) -AppleLocale ja_JP`; Android
  per-app language via `adb shell cmd locale set-app-locales com.flagshipserver.app --locales ja`), never English UI
  with translated captions on top.
* Captions live in a new key/value surface **`i18n/store/`** (`en.json` keyed by name, e.g. `slide1_caption`,
  `slide1_eyebrow`, `closing_caption`), so they get the gate's placeholder, markup, glossary and stale-English checks
  (`translated-from.json`, since the surface is name-keyed) for free. They use the glossary words (server, backup,
  phone …) and the keep-terms stay Latin (Flagship, Face ID, Apple Watch, Wear OS).
* Translate meaning, not words, and keep to two lines at the caption size; the template measures each rendered line
  and fails the build if one overflows (that is the length check; character counts do not work for CJK).
* Japanese and Chinese get their own line breaks: the string may carry `\n` where the language wants it, and the
  template never breaks inside a word in Latin scripts. Japanese captions end without "。" (store convention for
  headlines); Chinese likewise without "。".
* Store **metadata** (name, subtitle, keywords, description, promo text, release notes) is a separate deliverable in
  `i18n/store-metadata/` and is not in this round, but the slide captions must not contradict it.
* Draft caption translations for review are in §10; they are machine drafts like the rest of `i18n/` until a native
  reviewer signs them off (`i18n/REVIEW.md`).

## 7. Deliverables and sizes (verify against the store pages on build day)

| Store | Class | Pixel size (portrait) | Count per language | Notes |
|---|---|---|---|---|
| App Store | iPhone 6.9" | 1320 × 2868 | 6 (slides 1-5, 7) | Required class; Apple scales it down for smaller iPhones. |
| App Store | iPad 13" | 2064 × 2752 | 6 | Required because the app runs on iPad. iPad captures use the split view. |
| App Store | Apple Watch | 422 × 514 (Ultra) | 1-2 (slide 6 screens, no caption) | Watch shots carry no caption text (too small). |
| Google Play | Phone | 1080 × 1920 (9:16) | 7 | Play accepts 320-3840 px per side, 2:1 max ratio. |
| Google Play | 7" tablet | 1200 × 1920 | 7 | |
| Google Play | 10" tablet | 1600 × 2560 | 7 | |
| Google Play | Wear OS | 384 × 384 (1:1) | 2 (slide 6) | Round-safe: content inside the inscribed circle. |
| Google Play | Feature graphic | 1024 × 500 | 1 | Mark + "Your cloud, your keys." No device frame, nothing within 15 % of the edges. |
| Google Play | Hi-res icon | 512 × 512, 32-bit PNG | 1 (language-neutral) | From the existing app icon, not redrawn. |

Files: `store/out/<store>/<lang>/<class>/<nn>-<theme>.png`, e.g.
`store/out/appstore/ja/iphone-6.9/02-phone.png`, plus `store/out/manifest.json` listing every file with its pixel size
and SHA-256. Store language folders use each store's own codes (App Store `zh-Hans`, `pt-BR`; Play `zh-CN`, `pt-BR`),
mapped from `i18n/locales.json` (add `appStoreId` / `playStoreId` columns there rather than a second table).

## 8. Build plan (once approved)

1. `store/demo-world.json` + a gym switch on each platform that loads it (iOS `GymProbe`, Android smoke world), and a
   capture route per slide (the "Mock-gym state" column; these worlds do not exist yet).
2. Capture scripts: iOS via `xcodebuild test` on a UI-test target that walks the seven states per language and saves
   `XCUIScreen` shots (fastlane `snapshot` is an option, not a requirement); Android via an instrumented test +
   `UiDevice.takeScreenshot` on a Pixel 9 / Pixel Tablet / Wear emulator image. Both write raw captures to
   `store/captures/<platform>/<lang>/<device>/<nn>.png`.
3. One HTML/SVG template per slide type (phone, tablet, watch, closing, feature graphic), rendered by headless
   Chromium (already in the toolchain) at each exact size, fed by `i18n/store/<lang>.json` and the captures. Fonts
   are self-hosted (Geist, Geist Mono, Noto Sans JP/SC), never fetched at render time.
4. Checks, wired into `npm run i18n` as `scripts/i18n-store.mjs check`: every language × class × slide exists at its
   exact size; no caption line overflows; captions pass the shared lint; manifest hashes match the files.
5. A contact sheet per language (`store/out/review/<lang>.html`: all slides side by side at thumbnail and full size)
   for the native reviewer and the owner.

Rough effort: demo world and capture routes 1-2 days per platform (most of it is the iOS UI-test target), templates
and renderer 1 day, checks and contact sheets half a day.

## 9. Risks and open questions for the owner

* **Is slide 2 too inside-baseball as frame two?** The alternative is slide 3 (apps) second and the approval third.
  Recommendation: keep the approval second; it is the one thing no other personal-cloud listing can show.
* **iPhone or iPad split view on the iPad frames?** Recommendation: split view (list + detail), it is what makes an
  iPad shot look intentional.
* **Beta label.** The product says "0.2 Beta" everywhere; App Store art must not say "Beta" (TestFlight is the beta
  channel; a "Beta" word in production art draws rejections). Recommendation: no version or Beta in any image.
* **Patent pending** stays out of the art (legal text in a screenshot is not useful and is hard to keep current).
* The iOS app currently fails to type-check at `ContentView.swift:149` with the newest Xcode; captures need a building
  app first (see the handoff note in this folder).

## 10. Draft caption translations (machine drafts for review)

| Key | en | es | fr | de | pt-BR | ja | zh-Hans |
|---|---|---|---|---|---|---|---|
| slide1 | Your own cloud, at home. | Tu propia nube, en casa. | Votre propre cloud, chez vous. | Deine eigene Cloud, zu Hause. | Sua própria nuvem, em casa. | 自分だけのクラウドを、自宅に | 你自己的云，就在家里 |
| slide2 | It starts only when you approve. | Solo arranca cuando tú lo apruebas. | Il ne démarre qu’avec votre accord. | Er startet nur mit deiner Freigabe. | Só inicia quando você aprova. | あなたが承認したときだけ起動 | 只有你批准，它才会启动 |
| slide3 | Apps that live on your server. | Apps que viven en tu servidor. | Des apps qui vivent sur votre serveur. | Apps, die auf deinem Server leben. | Apps que vivem no seu servidor. | アプリはあなたのサーバーに | 应用运行在你的服务器上 |
| slide4 | Invite family. Keep the keys. | Invita a tu familia. Las claves, para ti. | Invitez vos proches. Gardez les clés. | Lade Familie ein. Die Schlüssel bleiben bei dir. | Convide a família. As chaves ficam com você. | 家族を招待。鍵はあなたの手元に | 邀请家人，钥匙留在你手里 |
| slide5 | Backups only you can open. | Copias de seguridad que solo tú puedes abrir. | Des sauvegardes que vous seul pouvez ouvrir. | Backups, die nur du öffnen kannst. | Backups que só você pode abrir. | 開けるのはあなただけのバックアップ | 只有你能打开的备份 |
| slide6 | Status on your wrist. | El estado, en tu muñeca. | L’état, à votre poignet. | Der Status am Handgelenk. | O status no seu pulso. | 状態は手首で確認 | 状态尽在手腕 |
| closing | Flagship. Your cloud, your keys. | Flagship. Tu nube, tus claves. | Flagship. Votre cloud, vos clés. | Flagship. Deine Cloud, deine Schlüssel. | Flagship. Sua nuvem, suas chaves. | Flagship。あなたのクラウド、あなたの鍵 | Flagship。你的云，你的密钥 |

Notes for the reviewer: fr "vous seul" is masculine-default; "vous seul(e)" is not used in headlines, a neutral
alternative is "Des sauvegardes que vous êtes seul à ouvrir" (still gendered) or "Des sauvegardes rien qu’à vous".
de slide4 is long for a headline; "Familie einladen. Schlüssel behalten." is the short form. es slide5 may need two
lines on iPhone.

## Revision notes

* v2 (Claude, 2026-10-22). Rewrote the brief after reading the design system, AGENTS.md and the apps:
  - Palette and type now the product's own (`#F7F6F2` / `#14140F` / teal `#14B8A6`, Geist + Geist Mono, Noto Sans
    JP/SC for CJK); the draft's navy/Inter were not Flagship's. Added the thumbnail legibility rule.
  - Story cut from 10 to 7 slides, outcome first ("Your own cloud, at home."), the phone approval second; dropped the
    AI-build slide (a time-limited free promotion must not be in store art), the duplicate trust slide, and anything
    unlaunched. Added the five-slide cut and caption alternatives the draft asked for.
  - Added the claims each caption must stay true to, the fixed demo world from the mock gym (no real person or box),
    per-platform language switching for captures, and the `i18n/store/` surface so captions get the same gate as the
    apps.
  - Replaced "confirm sizes" with a size table, file naming, a manifest and a build-failing check; flagged items that
    need re-checking on build day.
  - Answered the draft's questions in §4 and §9 and added draft caption translations (§10) for the reviewer.
