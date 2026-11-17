# Copy proposal: apps that run from your phone

Status: **proposal, for owner review** (2026-11-17). Nothing is changed yet. Design: `docs/phone-hosted-apps.md`.

The brief: copy that "subtly implies you can build apps that even run directly from your phone", without promising a
feature that doesn't exist. Those two pull against each other, so the proposal is split:

- **(a) True today.** Puts the phone at the centre (you build, approve and control your apps from it). A reader who
  later hears about phone apps finds it natural; nobody today is told something false.
- **(b) Ship only when phone-hosted apps land.** Says it outright.

## The hard line

An implication counts as a claim. App Review reads metadata for the impression it gives (guideline 2.3: "customers
should know what they're getting"; 2.3.1 forbids hidden or misleading features in the description; 2.3.7 applies the
same to the name, subtitle and keywords), and Google Play's metadata policy forbids misleading descriptions. So in
(a) every sentence must be literally true **and** must not leave a reader thinking the phone runs apps today. Concretely, until (b):

- Keep "You need a server" in both store descriptions.
- Never write "no server needed", "runs on your phone", "your phone is the server", "phone apps", "always on", "24/7".
- "From your phone" may describe where you **build and control** apps; never where they **run**.
- Don't add `phone apps`, `no server` or `app builder` to the App Store keywords before (b).

Every English change below also needs its six translations (`docs/i18n.md`; `npm run i18n` is the gate). The
websites are keyed by the English sentence (a changed sentence is a new key; the page shows English until translated);
Android is keyed by resource name, so after changing the English run `node scripts/i18n-android.mjs accept <key>` once
the translations are redone. Store listings: every `store/listings/<lang>.json`, then
`node scripts/store-assets/listings.mjs counts`. Never hand-edit `.xcstrings` or `values-*/strings.xml`.

## (a) Wording that is true today

### a1. Homepage meta description

`apps/web/public/index.html`, line 19, `<meta name="description">`

- Before: `Plug in at home, pair with your mobile device, build and share apps privately. TLS terminates on your hardware. Not even we can eavesdrop.`
- After: `Build apps from your phone and run them on hardware you own. Your phone holds the keys; TLS terminates on your hardware. Not even we can eavesdrop.`

True: the build chat runs on the phone today; the apps run on the box.

### a2. Homepage hero lede

`apps/web/public/index.html`, `<p class="lede">` (line 914)

- Before: `Plug a small box in at home. Pair it with the mobile app on your device. Build and share services privately at <code>yours.flagship.services</code>, with a certificate signed by a key only your hardware holds. Not even we can eavesdrop.`
- After: `Plug a small box in at home. Your phone is the control centre: it holds the keys, approves every start, and is where you build and share apps, at <code>yours.flagship.services</code>, with a certificate signed by a key only your hardware holds. Not even we can eavesdrop.`

### a3. Homepage, How it works, step 03

`apps/web/public/index.html`, `§1`, third `step-card`

- Before: `<h3>Vibe-code a service.</h3>` / `<p>Describe what you want. An AI writes the code and its manifest, with your own key, Flagship Inference, or a model running on your own server. Your server builds it and runs it in its own sandbox.</p>`
- After: `<h3>Build an app from your phone.</h3>` / `<p>Describe what you want in the app. An AI writes the code and its manifest, with your own key, Flagship Inference, or a model running on your own server. Your server builds it and runs it in its own sandbox.</p>`

### a4. Homepage FAQ, "Do I need to be a developer?"

`apps/web/public/index.html`, `#faqAccordion`, third `<details>`

- Before: `No. The mobile app walks you through every step. Vibe-coding means typing what you want; the LLM writes it, the daemon ships it.`
- After: `No. You build apps from your phone by saying what you want; an AI writes it and your server runs it. The app walks you through every step.`

### a5. App Store description bullet

`store/listings/en.json`, `appstore.description`, in WHAT YOU CAN DO

- Before: `• Build apps by describing them, or install them from a git repository.`
- After: `• Build apps from your iPhone by describing them, or install them from a git repository. Your server runs them.`

### a6. Google Play description bullet and short description

`store/listings/en.json`, `playstore.fullDescription`, in WHAT YOU CAN DO

- Before: `• Build apps by describing them, or install them from a git repository.`
- After: `• Build apps from your phone by describing them, or install them from a git repository. Your server runs them.`

`store/listings/en.json`, `playstore.shortDescription` (80 characters at most)

- Before: `Your own private cloud on your own hardware. Your phone holds the keys.` (70)
- After: `Build apps from your phone. Run them on hardware you own. You hold the keys.` (76)

Leave `appstore.subtitle` (`Your cloud, on your hardware`) and `appstore.promotionalText` (the 0.4 news) as they are
for (a): both are accurate and the subtitle is the most-read line under review.

### a7. Welcome screen (iOS and Android)

`apps/mobile/ios/Sources/FlagshipUI/Screens/WelcomeScreen.swift`, line 32 (key in `i18n/ios/en.json`)

- Before: `A personal cloud you actually own. Your phone holds the keys, your server runs the services.`
- After: `A personal cloud you actually own. You build and approve everything from your phone; your server runs your apps.`

`apps/mobile/android/app/src/main/res/values/strings.xml` `a_personal_cloud_you_actually_own` (source in
`i18n/android/en.json`)

- Before: `A personal cloud you actually own. Your phone holds the keys; your server runs the services.`
- After: `A personal cloud you actually own. You build and approve everything from your phone; your server runs your apps.`

"Your phone holds the keys" moves out of this line; it stays in the store descriptions and on the homepage. If the
owner prefers to keep it here: `Your phone holds the keys and is where you build; your server runs your apps.`

### a8. Home quick action (iOS, Android)

`apps/mobile/ios/Sources/FlagshipUI/Screens/HomeScreen.swift` line 545, `title: "Build a service"`,
`subtitle: "Describe it in plain English. Your server builds and runs it."`; Android `describe_it_in_plain_english_your`
(`ui/screens/HomeScreen.kt:602`)

- Before: `Build a service` / `Describe it in plain English. Your server builds and runs it.`
- After: `Build an app` / `Describe it right here. Your server builds and runs it.`

"Service" is one of the old terms the 0.3 checklist flagged (`AGENTS.md`, feat/UX item 8). Changing the title is a
glossary decision across every surface; if it is not taken now, change the subtitle only.

## (b) Wording to ship only when phone-hosted apps land

Ship these together with the feature, in the same release, in every language. Each one names the limits the design
has (the phone answers while the app is open; entries wait otherwise), so the copy can't overclaim later either.

### b1. Homepage hero

`apps/web/public/index.html`, `<h1>`

- Before: `Your stuff, on your hardware, with a real green padlock.`
- After: `Your stuff, on your hardware. Even if that's just your phone.`

`<p class="lede">`: add after the (a2) text:
`No server yet? Build small apps that run from your phone: sign-up sheets, order forms, bookings and polls. Move them to a server when you get one.`

### b2. Homepage, How it works: a fifth card (or a note under §1)

New `step-card` in `apps/web/public/index.html` §1:

- Before: (none)
- After: `<span class="num">Or · Start on your phone</span>` / `<h3>No box? Start with your phone.</h3>` /
  `<p>Small apps can run from your phone. Visitors use them in any browser; while your phone is away, new entries wait, encrypted so only you can read them, until it picks them up. Add a server later and the same app moves there.</p>`

Then §1's heading `Four steps. About ten minutes.` must change too (`Four steps, or start on your phone.`).

### b3. Homepage FAQ: a new question

- Before: (none)
- After: `<summary>Do I need a server?</summary>` / `<p>Not to start. Small apps (sign-up sheets, order forms, bookings, polls) can run from your phone: the page always loads, and new entries wait, sealed to you, until your phone is online. For apps that must answer at any hour, or hold photos and files, add a server and move the app to it.</p>`

### b4. App Store

`store/listings/en.json`

- `appstore.subtitle` before: `Your cloud, on your hardware` → after: `Your cloud, from your phone` (27 characters).
  Only if phone apps are a headline of that release; otherwise keep the subtitle and use the promotional text.
- `appstore.promotionalText` (170 at most) after: `New: apps that run from your phone. Sign-up sheets, orders, bookings and polls, no server needed to start. Move them to a server when you're ready.` (147)
- `appstore.description`, WHAT YOU CAN DO, new first bullet:
  `• No server yet? Build small apps that run from your iPhone: sign-up sheets, order forms, bookings and polls. Visitors use them in any browser. While Flagship is closed, new entries wait, end-to-end encrypted, until your iPhone picks them up.`
- `appstore.description`, last paragraph, before: `You need a server: a spare computer, or a computer that runs Flagship Studio (macOS and Windows; Linux is experimental).`
  after: `Start with your iPhone. For apps that answer at any hour, add a server: a spare computer, or a computer that runs Flagship Studio (macOS and Windows; Linux is experimental).`

### b5. Google Play

`store/listings/en.json`

- `playstore.shortDescription` after: `Build apps on your phone, run them from it, move them to your own server.` (73)
- `playstore.fullDescription`: the same bullet and last paragraph as b4, with "phone" for "iPhone".

### b6. In-app onboarding

- Welcome screen (iOS `WelcomeScreen.swift`; Android `your_stuff_on` / `your_hardware` and
  `a_personal_cloud_you_actually_own`): after: `Your stuff, on your hardware.` (unchanged) and
  `Start with apps that run from your phone. Add a server when you want more.`
- Home, an account with no server (new empty state, iOS `HomeScreen.swift`, Android `HomeScreen.kt`, webapp Home):
  before: the "Add / Restore a server" card alone; after: two cards, `Build an app that runs from your phone` /
  `Sign-up sheets, orders, bookings, polls. Ready in minutes.` and the existing `Add / Restore a server`.
- The phone app's page, a one-time note: `This app is served by your phone. While Flagship is closed, new entries wait for you, encrypted, for up to {days} days.`

### b7. Pricing page

`apps/web/public/pro.html`: a row "Apps that run from your phone" with each plan's count and mailbox limits
(`phone-hosted-apps.md` §3.4), once the owner fixes them.

## Store review risks

| Risk | Where | Mitigation |
|---|---|---|
| Implying a feature that doesn't exist (2.3, 2.3.1, Play metadata policy) | any (a) line read as "the phone runs apps" | (a) says "build from your phone" and "your server runs them" in the same sentence; "You need a server" stays until (b) |
| Subtitle or keywords overclaiming (2.3.7) | b4 subtitle | change the subtitle only in the release that ships phone apps; no "no server" keyword before |
| A reviewer reading "apps run from your phone" as downloaded code (2.5.2) | b1-b6 | say "apps … visitors use in any browser"; never "run code" or "install apps" on the phone; the review notes explain the declarative engine (`phone-hosted-apps.md` §5.3) |
| Implying always-on service (iOS stops apps in the background) | b2-b4 | every (b) text says entries wait while the phone is away; never "always on" or "instant" |
| User-generated content from strangers shown in the app (1.2) | the inbox | block and report exist (Messages); mention them in the review notes |
| Screenshots showing a feature not in the build (2.3.3) | store art | new screenshots only with the (b) release, from native captures |
| "Shop" implying in-app payments (3.1.1) | b1-b4 | say "order forms"; payment is not in v1 and the copy never mentions it |
