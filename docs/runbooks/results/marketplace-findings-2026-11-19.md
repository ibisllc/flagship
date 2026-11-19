# Marketplace exposure in Flagship 0.4: findings (read-only)

Repo: `~/flagship-0.4`, `release/0.4` @ `59d184f4c` (local `main` = `206c089ca`, 3 journal-only commits behind; same code).
Nothing was edited. Production D1 could not be queried (the read-only `wrangler d1 execute` was refused), so the
number of rows in prod `marketplace_listings` is unknown.

## 0. Headline

- The marketplace is NEW in 0.4 on every client. 0.3 (`studio-v0.3.0` tag) and the 0.2 endorsed release
  (`dbdf2e08`) have no marketplace screen, no box BFF route and no `.com` route. It came in with the fold of
  `feat/marketplace` (`e2ac5f585`, `0cd486149f`; journal F2, "EVERYTHING launches in 0.4", owner 2026-11-13).
- There is NO gate anywhere: no flag, no `#if DEBUG`, no plan check, no server capability. The only conditions are
  "has a server" (`pods` non-empty) and the device-capability scope `install-service` (restricted sub-devices).
- There is NO server-side switch any client reads that could hide it. Hiding it needs new store builds.
- The iOS store capture already shows it: `~/flagship-art-review/2026-11-ui-pass/ios-phone/home-proxy-badge__phone-light__after.png`
  has the "Browse the marketplace" card on Home.
- Precedent: commit `0149d8cbfc` (2026-06-05) "remove the marketplace from the public marketing site ... Per the
  decision to ship to App Store review without the marketplace". The 0.4 fold brought all of it back.

## 1. Entry points

### Webapp (`apps/web/public/webapp`, shell v239)
| Entry | Where | Gate |
|---|---|---|
| Services tab card "Browse the marketplace, vibe-code ..." with **Marketplace** and **Developer** buttons | `index.html:524-533` (`services-list-open-marketplace`, `services-list-open-developer`), wired `app.js:402-404` | Marketplace button: device scope `install-service` only (`home.js:1667`). Developer: none |
| Build chooser tile "Get from the marketplace" | `index.html:828` `build-src-market`, `views/build-source.js:52` | none |
| Setup wizard last step "Browse marketplace" | `views/wizard.js:441`, `:611-617` (step `demo-app`) | none |
| URL `?view=view-marketplace` / alias `marketplace`, `developer` | `lib/deepLink.js:163`, `lib/router.js:165-166` | none |
| "Publish this app" after every AI build (box signs a listing to `.com`) | `views/vibe-code.js:942,1005-1012,1132-1150` | none (shows whenever the build result renders) |
| Developer console (marketplace sales) | `views/developer.js` -> `GET /api/developer/sales/<creator>` | none |
| Tier & usage, Plan (Pro) | `views/tier-status.js`, `lib/plan.js` | Plans, not marketplace: launching in 0.4, out of scope |

### iOS (`apps/mobile/ios`, 1.3 build 9)
| Entry | Where | Gate |
|---|---|---|
| Home quick action "Browse the marketplace" (2nd card, accessibility id `quick-action-install-service`) | `Screens/HomeScreen.swift:562-572`, wired `Shell/HomeTab.swift:250` (`linker.pending = .marketplace`) | `canInstall` (device scope) only |
| Services tab bottom card "Marketplace / Services your neighbours built" | `Shell/ServicesTab.swift:151` `marketplaceCard`, `:382-396` | none |
| Build chooser tile "Get from the marketplace" (`build-src-market`) | `Screens/BuildModesScreens.swift:114-120`, wired `ServicesTab.swift:1205` | none |
| Deep link `flagship://marketplace` and `https://flagshipserver.com/app/marketplace` | `shared/.../FlagshipCore/DeepLink.swift:324`, `ServicesTab.swift:109`, `RootShell.swift:457` | none |
| Detail / install / LLM-key env screen | `ServicesTab.swift:766-1060`, `ViewModels/MarketplaceViewModel.swift`, `ServiceEnvScreen.swift` | reached only from the above |
| No publish, no developer screen on iOS | | |
| Settings "Subscription" (Plan, Tier & usage) | `SettingsScreen.swift:542` | Plans, out of scope |

### Android (`apps/mobile/android`, versionCode 12)
| Entry | Where | Gate |
|---|---|---|
| Services empty state: ghost button "Browse marketplace" under "Build a service" | `ui/screens/ServicesListScreen.kt:227-231` | shows only when no apps installed |
| Build chooser tile "Get from the marketplace" | `ui/screens/BuildModeScreens.kt:265-269` | none |
| Deep link `flagship://marketplace` / `/app/marketplace` | `core/DeepLink.kt:282`, `ui/shell/tabs/ServicesTab.kt:157-159`, `RootShell.kt:132` | none |
| Screens | `ui/screens/MarketplaceScreens.kt`, `viewmodels/MarketplaceViewModel.kt`, nav `ServicesTab.kt:300-305` | |
| No Home quick action (Home has only "Build a service", `HomeScreen.kt:671`), no publish, no developer screen | | |

### Website (`apps/web/public`, plus 6 generated locales from `i18n/web`)
- `/marketplace/` page is back (310 lines): six invented listings with scan grades "A"/"B" and install counts
  (`432 installs`, `1,204 installs`), "Verified scan only" filter. The scanner does not exist.
- Homepage: §3 "Things people actually built last week. Real services from real users." with invented apps and "A"
  grades (this section is ALREADY LIVE on production today) and, new in 0.4, the link "Browse the full marketplace"
  (`index.html:1112-1115`, segment `i18n/web/segments.json:647`).
- Footer "Services" -> `/marketplace/` on ~14 pages (index, pro, help, docs, privacy, open-source, blog, status,
  security, abuse, dibs, 404, disambiguate) x 7 locales; 404 page suggests "Marketplace ->".
- `docs/index.html:117` "Or install someone else's".
- Legal/FAQ: `terms.html:140,172` (featured placement, listing licence), `privacy.html:109,245,286` (§2.13 listing
  data), `faq.html:387` (marketplace promotion fees), `security.html:163`. These were on main before; leave or soften
  (owner call; harmless if the feature is described as "when it opens").

## 2. What each screen does against production

Routes in the 0.4 code:
- `.com` (`apps/com/src/controlPlaneRoutes.ts:1027-1032, 4065-4200`): `POST /api/marketplace/list`,
  `GET /api/marketplace/search`, `GET|DELETE /api/marketplace/:c/:s`, `POST .../install`, `POST .../scan`
  (503 unless `MARKETPLACE_SCANNER_PUBKEY_HEX`), `POST .../price`, admin price/grant, internal scan queue,
  `GET /api/developer/sales/:creator`. Env knobs: `MARKETPLACE_SCANNER_PUBKEY_HEX`, `MARKETPLACE_INSTALL_BLOCKED_GRADES`,
  `MARKETPLACE_CUT_BPS`. None is set in `apps/com/wrangler.toml`, and none disables the routes. `SITE_PUBLIC = "1"`, so
  the coming-soon gate is off and does not cover API routes anyway.
- Box BFF (`packages/server-daemon/src/screens/screensHttp.ts:1234-1262`): `GET /api/screens/marketplace-browse`
  proxies `.com /api/marketplace/search` (502 `marketplace fetch failed: <status>` on any non-200);
  `POST /api/screens/marketplace/publish` signs a listing with the box key and posts `.com /api/marketplace/list`.
  Install = `.com GET /api/marketplace/:c/:s` (manifest) + box `POST /api/services` + `.com POST .../install`.

Production now (probed 2026-11-19): `/api/health` 200; `/api/marketplace/search`, `/api/payments/config`,
`/api/tier/status` all 404 `{"error":"not found"}`: prod `.com` predates the fold. `/marketplace/` serves the
homepage (asset fallback).

What a user sees, by state:
| State | Webapp | iOS | Android |
|---|---|---|---|
| No server | "The marketplace is coming soon." | "The marketplace is coming soon." | "Add a server first ..." |
| Box on 0.3 (every prod box until it updates; route absent) | red error card (box 404) | ErrorCard | ErrorCard + Retry |
| Box on 0.4, `.com` not yet on 0.4 (today) | error card "marketplace fetch failed: 404" | ErrorCard same text | ErrorCard same text |
| Both on 0.4, table empty | "no listings yet" | **blank**: search field, nothing under it (no empty-state text in `.loaded`) | **blank**: same |
| Both on 0.4, table has rows | listings with an "ungraded" pill and Install ("This app has not been security-scanned yet") | same, with "Install with caution" | same |

Risks once `.com` 0.4 is live: any box owner can publish (webapp "Publish this app" after every build), and every
user immediately browses and installs that unscanned, unmoderated listing. There is no report/flag or takedown UI.
For App Review that is user-generated content without moderation (guideline 1.2) and an in-app catalogue of
installable software, and the reviewer account will see either an error, a blank page or whatever is in prod D1.
Paid listings (`price`, `payment-required` on iOS) also raise 3.1.1 (IAP) for 0.5.

## 3. Server-side switch

None exists. Checked: no `/api/features`, `/api/config`, remote-config or kill switch in `.com` or any client.
`GET /api/payments/config` is the only public config all three clients read (webapp `lib/plan.js:190`, iOS
`PaymentsCom.swift:175`, Android `PaymentsClient.kt:119`), and they parse it loosely, so a new field would not break
them, but they read it only for the Plan screens and none of them reads a marketplace flag. So hiding the marketplace
needs a store build either way, and a switch added now would only help from 0.4 on.

A server switch that later turns on a hidden marketplace in an already-reviewed iOS build is itself a review risk
(guideline 2.3.1, hidden/dormant features), and 0.5's paid apps need new builds anyway (IAP rules). So for the
phones a build-time gate is the right tool; `.com` gets an env switch as defence in depth.

## 4. Store listings, website, release notes

- `store/listings/*.json` (all 7 languages): no marketplace text. What's New (en line 20/26) lists calls, Social,
  direct access, Pro/Pro Max, Business, restore, etc. No marketplace.
- `docs/release-notes/0.4.md:21`: "Left out on purpose ... Monero and paid marketplace apps (not built)". The
  free marketplace is neither listed nor excluded there.
- `docs/store-assets/store-assets-brief.md:78`: "No marketplace ... they are not in main" (now stale).
- Website: see §1. The 0.4 site adds `/marketplace/`, the homepage link and footer links; the invented §3 listings
  are already live.
- Store screenshots: the iOS Home capture shows "Browse the marketplace" (see §0). Re-capture after the change.

## 5. Recommendation: one build-time switch, plus a `.com` env switch

Single source: add `"marketplace": false` to `release/version.json`; `scripts/check-versions.mjs --write`
propagates it the same way it does `product`/`label` (and `STUDIO_EXPERIMENTAL`), and `npm run parity` fails on drift.
0.5 flips it to `true` and ships new builds.

Webapp (deploys with `.com`)
1. `lib/buildInfo.js`: `export const MARKETPLACE_ENABLED = false;` (written by check-versions).
2. `index.html`: give `#services-list-open-marketplace`, `#services-list-open-developer` and `#build-src-market` the
   `hidden` class and reword the note (or hide the whole card: "Vibe-code" duplicates the Build button). In `app.js`
   init, unhide them only when `MARKETPLACE_ENABLED`.
3. `views/wizard.js:436-443`: render only "Finish" in step `demo-app` when off.
4. `lib/deepLink.js:163` and `lib/router.js:165-166`: ignore `view-marketplace` / `marketplace` / `developer` when off.
5. `views/vibe-code.js` `publishMarkup`: return `""` when off.
6. Bump `SHELL_VERSION` (v240) and the pins that follow it.

`.com`
7. `wrangler.toml [vars]`: `MARKETPLACE = "off"`; `controlPlaneRoutes.ts`: when not `"on"`, every public
   `/api/marketplace/*` route and `/api/developer/sales/*` answer 404 `{error:"not found", code:"marketplace-off"}`
   (admin and internal routes may stay). This stops publishing from any box or old client and keeps listings out of
   reach. Optional: the same var makes `route.ts` 404 `/marketplace/`.

Website (English sources, then regenerate the locales with the i18n web tool)
8. Remove `apps/web/public/marketplace/index.html` from the build (or 404 via the var), the homepage link
   (`index.html:1111-1116`) and the footer/404/docs `/marketplace/` links. Strongly consider removing the homepage §3
   invented listings with "A" grades too (they are live now and claim "Real services from real users" and a scan that
   doesn't exist), as `0149d8cbfc` did. Keep the terms/privacy paragraphs or phrase them as "when the marketplace opens".
   Drop `pages.json:23` and the segments only used by the page.

iOS
9. `Shell/ProductVersion.swift` (or a `Features` enum in `FlagshipCore` so shared code sees it):
   `static let marketplace = false` (written by check-versions).
10. `HomeScreen.swift:562`: wrap the second `actionRow` in `if ProductVersion.marketplace`; with one action use a
    single column on regular width too, so the iPad grid has no hole.
11. `ServicesTab.swift:151`: `if ProductVersion.marketplace { marketplaceCard(c: c) }`; `:109` ignore `.marketplace`
    when off.
12. `BuildModesScreens.swift:114-120`: wrap the `build-src-market` tile.
13. `DeepLink.swift:324`: return `nil` (or fall through) for `marketplace` when off.

Android
14. `app/build.gradle.kts`: `buildConfigField("boolean", "MARKETPLACE", releaseVersion["marketplace"].toString())`.
15. `ServicesListScreen.kt:227-231`, `BuildModeScreens.kt:265-269`: wrap in `if (BuildConfig.MARKETPLACE)`.
16. `DeepLink.kt:282`: `"marketplace" -> Marketplace.takeIf { BuildConfig.MARKETPLACE }`; `ServicesTab.kt:157`.

Leave in place (unreachable, so 0.5 only flips the switch): the screens, view models, clients, box BFF routes,
`.com` handlers, D1 tables and all their unit tests.

Docs: `docs/release-notes/0.4.md` "Left out on purpose": add "the marketplace (opens in 0.5)"; fix
`store-assets-brief.md:78`; AGENTS.md status line.

### Effort
About one working day of code and tests (webapp 2 h, `.com` + site 2 h, iOS 1.5 h, Android 1.5 h, tests 2 h),
then the usual store rebuilds (iOS 1.3 build 10?, Android versionCode 13 if 12 was already uploaded) and re-capture of
the iOS Home screenshots in seven languages.

### Tests to add or change
- `apps/com/test/route.test.ts`: `MARKETPLACE` unset/"off" -> `GET /api/marketplace/search`, `GET /api/marketplace/a/b`,
  `POST /api/marketplace/list`, `GET /api/developer/sales/x` are 404 `marketplace-off`; "on" -> 200 as today.
- `scripts/check-versions` test / `npm run parity`: the new field reaches buildInfo.js, ProductVersion.swift, gradle.
- Webapp vitest: `webappBuildModesView.test.ts` (expects `enterMarketplace`; assert the tile is hidden when off);
  new test that the services card buttons, the wizard button and the publish button are absent and
  `?view=view-marketplace` is ignored when off; `webappStatic.test.ts` unchanged.
- Site: `marketingPages.test.ts:31,41,382` (the `/marketplace/` page) and `e2e/flows/s14-marketing-surface.spec.ts:44,301`
  (path list and 404 suggestions) change to "not linked / 404"; `e2e/flows/s03-marketplace.spec.ts` runs only when on.
- iOS: `DeepLinkTests` (marketplace link -> nil when off); a UI/gym check that `quick-action-install-service` and
  `build-src-market` do not exist; Marketplace* view-model tests stay.
- Android: `AppLinkTest`/deep-link test (marketplace -> null); a Compose test that the empty Services state has no
  "Browse marketplace" and the build chooser has three tiles; existing `MarketplaceViewModelTest` stays.
- `npm run i18n`: strings stay referenced (gated, not deleted), so the gate should stay green; check after removing
  the site page.
