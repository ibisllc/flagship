# Mobile monetization spec — the Mac-only work (iOS + Android)

> **Why this doc exists.** The monetization push (`feat/marketplace`) was built on
> a Linux dev box, where Swift/Kotlin **cannot compile or test** (no `xcodebuild`,
> no Android SDK/JDK in that environment). So the **mobile mirrors** of the
> already-shipped backend + webapp work were written up here in
> implementation-ready detail instead of as unverifiable code. Build + test these
> on the Mac (`xcodebuild test …` / `./gradlew … testDebugUnitTest` with
> `JAVA_HOME=/opt/homebrew/opt/openjdk@17`). Everything below has a **live
> backend** already on this branch — the mobile side is pure client work.
>
> Covers task **#23** (the #6/#7 allowance dashboard + over-cap alert on mobile)
> and the mobile half of **#19** (install-what-you-own).

## 0. Ground rules (read first)

- **App Review (3.1.1 — non-negotiable).** No in-app purchase, voucher-redeem,
  subscribe, or price-collection UI inside the iOS app. The app *reflects*
  entitlements and may **link out** to the web (`/pro`, app checkout) in the
  system browser. Android is laxer but **mirror the same rule** for one codepath
  and one mental model. The pattern is: show status → "Manage on the web" →
  `Link(destination:)` / `Intent(ACTION_VIEW)` to `https://flagshipserver.com/pro`.
- **Source-of-truth pattern to copy.** The `FrontPage` feature is the canonical
  shape of a small read-feature and exists on both platforms — mirror it file by
  file (model in `core`, client in `api`, a `…ViewModel`, a screen/card, and
  `core` + `viewmodel` tests). Don't invent a new structure.
- **Where it mounts.** Both apps already have a **`TierStatusScreen` +
  `TierStatusViewModel`** (the subscription screen, mirroring webapp
  `views/tier-status.js`) that already renders a tier badge + a usage progress
  bar (dispatcher usage, sourced from the pod's BFF). The **bandwidth allowance**
  is the same visual shape from a *different* source (`.com`), so the clean home
  for the full dashboard (#6) is **a new section on `TierStatusScreen`**. The
  **over-cap alert (#7)** additionally wants a **compact banner on the Home
  screen** so the nudge shows without navigating (this is what the webapp does on
  `views/home.js`). See §4 for the webapp-parity note.

## 1. The backend contract (already live on this branch)

`GET https://flagshipserver.com/api/users/<username>/allowance` — **public,
unauthenticated** (account metadata only, same disclosure class as `/pods`;
edge-rate-limited `user-allowance` 60/min·IP). Returns:

```jsonc
{
  "ok": true,
  "username": "alice",
  "tier": "free" | "hobby" | "maker",
  "period": "2026-06",            // current UTC month; quota resets monthly
  "usedBytes": 13297000000,
  "quotaBytes": 53687091200,
  "remainingBytes": 40390091200,
  "usedFraction": 0.2476,          // 0..1, clamped
  "overQuota": false,
  "overageUsd": 0,                 // paid tiers only; 0 for free
  "state": "ok" | "approaching" | "over",  // approaching ≥80% · over >100%
  "hardCapped": false              // true ⇒ free + over ⇒ public traffic paused
}
```

Definitions that MUST match the webapp + server (`packages/control-plane/src/metering.ts`,
`apps/web/public/webapp/lib/allowance.js`):

| concept | rule |
|---|---|
| tier label | `free`→"Free", `hobby`→"Pro" (250 GB), `maker`→"Pro Max" (1 TB) |
| `state` | `ok` < 80% · `approaching` ≥ 80% & ≤ 100% · `over` > 100% |
| colour | ok → accent/teal · approaching → amber/warn · over → red/err |
| bytes → display | GB with **one decimal**: `usedBytes / 1024³` → `"12.4 GB of 50 GB"` |
| hard cap | `hardCapped` (free + over): "public traffic is paused until next month or until you upgrade" |
| paid over | `over && !hardCapped`: "over your plan's bandwidth — overage applies" |
| unknown user | endpoint returns free/zero defaults (no existence oracle) — render the card, no error |

Upgrade target for #7's CTA: open `https://flagshipserver.com/pro` in the system
browser.

## 2. iOS implementation (apps/mobile/ios + apps/mobile/shared)

Mirror `FrontPage*`. Files to add:

1. **`shared/Sources/FlagshipAPI/Client/AllowanceClient.swift`** — protocol +
   `LiveAllowanceClient`. This is a **plain `.com` GET** (NOT box-pinned — model
   it on `LiveScreensClient`'s `https://flagshipserver.com/api/marketplace/...`
   read, not on the box-pinned `FrontPageClient`). Shape:
   ```swift
   public struct Allowance: Equatable, Sendable {
       public let tier: String            // "free" | "hobby" | "maker"
       public let usedBytes: Int64
       public let quotaBytes: Int64
       public let usedFraction: Double
       public let overageUsd: Double
       public let state: String           // "ok" | "approaching" | "over"
       public let hardCapped: Bool
       public let period: String
   }
   public protocol AllowanceClient: Sendable {
       func getAllowance(username: String) async throws -> Allowance
   }
   ```
   `LiveAllowanceClient` does `URL(string: "https://flagshipserver.com/api/users/\(enc)/allowance")`,
   decodes the JSON, maps snake→camel. On any failure THROW (the VM swallows it).
2. **`shared/Sources/FlagshipCore/AllowanceFormat.swift`** — **pure** helpers so
   the formatting is unit-testable without UIKit (this is where the webapp parity
   lives): `tierLabel(_)`, `gb(_ bytes:)→String` (one decimal), `usedOfQuota(_,_)`,
   `barTone(state:)→enum {ok,approaching,over}`, `shouldAlert(state:)→Bool`,
   `alertCopy(state:hardCapped:tier:)→String`. Copy strings verbatim from §1 /
   `apps/web/public/webapp/lib/allowance.js`.
3. **`ios/Sources/FlagshipUI/ViewModels/AllowanceViewModel.swift`** — `@Observable`
   (mirror `FrontPageViewModel`): `enum State { idle, loading, loaded(Allowance), failed }`,
   `func load(username:)` calls the client, sets `.loaded`/`.failed`. Inject the
   client (env-injected like the others) so a mock can drive tests.
4. **`ios/Sources/FlagshipUI/Screens/AllowanceSection.swift`** — a `View` for the
   `TierStatusScreen` section: title "Public bandwidth", the GB-of-GB line, a
   progress bar tinted by `barTone`, the period ("Resets 1 Jul"), and — when
   `shouldAlert` — an inline upgrade row with `Link(destination: URL(string:
   "https://flagshipserver.com/pro")!) { … "Upgrade to Pro" }`. Reuse `FSColors`,
   `FS.space`, the existing `ServerCardSkeleton`/`ErrorCard` for idle/fail.
5. **Mount.** Add the section into `TierStatusScreen.body` (after the existing
   `dispatcherSection`). Wire `AllowanceViewModel` where `TierStatusViewModel` is
   constructed (same env/session that provides the username).
6. **Home over-cap banner (#7).** In `HomeScreen.swift`, add a compact banner that
   appears ONLY when `state` is `approaching`/`over` (load via the same VM,
   fire-and-forget). Tap → open `/pro`. Keep it dismissible-free (it self-hides
   when back under cap).

**Tests** (`ios/Tests/FlagshipMobileTests/`):
- `AllowanceFormatTests.swift` — gb() one-decimal, tier labels, bar tone per
  state, alert-copy branches (approaching / over+hardCapped / over+paid),
  clamped fraction. (Mirror `FrontPageCanonicalTests`.)
- `AllowanceViewModelTests.swift` — loaded/failed transitions against a mock
  `AllowanceClient`; alert shows only for approaching/over. (Mirror
  `FrontPageViewModelTests`.)
- Add an `AllowanceClient` case to the existing mock client used by VM tests.

**Build/test:** `xcodebuild test -scheme FlagshipMobile-Package -destination
'platform=iOS Simulator,id=<sim>,arch=arm64'` (plain `swift test` fails on UIKit).

## 3. Android implementation (apps/mobile/android)

Mirror `FrontPage*` / the existing `TierStatus*`. Package root
`com.flagshipserver.app`. Files:

1. **`api/AllowanceClient.kt`** + an `AllowanceResponse` `@Serializable` (mirror
   the existing `api/TierStatusResponse.kt`). Plain `.com` GET to
   `https://flagshipserver.com/api/users/$username/allowance`; map to a domain
   `Allowance` data class. Add an `allowance()` stub to `MockScreensClient` for
   tests (the codebase already has `MockScreensClient.tierStatus`).
2. **`core/AllowanceFormat.kt`** — pure helpers, the formatting parity twin of the
   iOS `AllowanceFormat` and webapp `allowance.js` (same function names/rules).
3. **`viewmodels/AllowanceViewModel.kt`** — mirror `TierStatusViewModel` /
   `FrontPageViewModel`: a `StateFlow<UiState>` with `Idle/Loading/Loaded/Failed`,
   `fun load(username)`.
4. **`ui/screens/`** — add an `AllowanceSection` composable into `TierStatusScreen.kt`
   (after the existing usage bar); colour the `LinearProgressIndicator` by state.
   Over-cap → an upgrade row that does
   `Intent(Intent.ACTION_VIEW, Uri.parse("https://flagshipserver.com/pro"))`
   (use the `LocalUriHandler`/`uriHandler.openUri(...)` idiom if present, else the
   Intent). Add the compact over-cap banner to the Home composable for #7.
5. **Tests** (`app/src/test/.../`): `core/AllowanceFormatTest.kt` (formatting +
   copy branches) and `viewmodels/AllowanceViewModelTest.kt` (load/fail + alert
   gating), mirroring `FrontPageViewModelTest`/`TierStatusViewModelTest`.

**Build/test:** `JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew :app:testDebugUnitTest`.

## 4. Webapp-parity note (reconcile when you do the mobile work)

The webapp #6/#7 card was built (on an older tree, by a worker) onto
**`views/home.js`** as a standalone full card. The mobile-native home for the
*full* dashboard is **`TierStatusScreen`** (the subscription screen). To keep all
surfaces telling one story, pick ONE and apply everywhere:
- **Recommended:** full dashboard on the **tier-status** surface (both
  `views/tier-status.js` and `TierStatusScreen`), + a compact over-cap **banner**
  on Home (all surfaces). This puts the detail where "your plan" lives and the
  urgent nudge where the user already is.
- If you instead keep the full card on Home (matching today's webapp), mirror
  that placement on mobile Home and skip the tier-status section.
Either way: **all three surfaces must match** (copy, thresholds, colours, GB
formatting) — they share the §1 contract.

## 5. Install-what-you-own — mobile half of #19

Backend is **live**: `GET /api/users/<u>/purchases` →
`{ ok, purchases: [{ creator, slug, purchased_at, source }] }`; paid installs are
gated server-side (`POST /api/marketplace/<c>/<s>/install?username=<u>` returns
**402 + `{ price_usd_cents }`** when unowned, 200 when free/owned). Mobile work:

- **Marketplace listing detail:** when `is_paid` (from the listing JSON —
  `price_usd_cents` / `is_paid` are now serialized), show the price and, **instead
  of an in-app buy button**, a **"Buy on the web"** `Link`/`Intent` to the web
  purchase flow (the web initiates Stripe `app-checkout`; the app never shows
  payment UI — App Review 3.1.1). After returning, the listing reflects ownership.
- **Install button gating:** on install, if the response is **402**, route the
  user to the same "buy on the web" link rather than erroring. If 200, proceed.
- **"Your apps" / install-what-you-own:** add a section (Apps/marketplace tab or
  account) listing `GET /api/users/:u/purchases` so a user can re-install what
  they own on any box. Read-only; no payment UI.
- Mirror the `FrontPage`/marketplace client patterns; add `core`+`viewmodel`
  tests as above. Same build/test commands.

## 6. Definition of done (per platform)

- Allowance section renders on `TierStatusScreen` with correct tier label, GB-of-GB,
  state-tinted bar, period; matches the webapp pixel-for-rule.
- Over-cap/approaching banner on Home → opens `/pro` in the browser; hidden under cap.
- No in-app purchase/price-entry UI anywhere (3.1.1).
- `core`/format + viewmodel unit tests green (`xcodebuild test` / `gradlew
  testDebugUnitTest`).
- (#19) paid listings show "buy on the web"; 402 on install routes to the web buy;
  "your apps" lists `/purchases`.
