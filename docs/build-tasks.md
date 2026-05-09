# Flagship — master build tasks

Source of truth for shipping v1 alpha. Every component, every screen,
every wire format that has to exist before we open the doors.

Conventions:
- Stable IDs (`A.1`, `D.5.2`) — reference these in commits and PRs.
- Effort: **S** = ≤1 day, **M** = 2–5 days, **L** = 1–3 weeks, **XL** = 1+ month.
- Status: ☐ unstarted, ◐ in progress, ☑ done, ⏸ deferred to v2.
- "Deps" = task IDs that block this one.

Companion docs (already written):
- `lifecycle-spec.md` — narrative end-to-end UX.
- `design-system.md` — visual + voice tokens.
- `roadmap.md` — peer-backup deep dive (v2).

**Counts as of last write (2026-05-07 multiplexing-v2 cycle):** 1265
tests green across 130 test files. Multiplexing v2 (controlledDomains
HELLO, last-HELLO-wins, sibling-WS protocol, ClaimUrlCapability,
/api/url/*, /api/live_siblings/*, user-zone wildcard cert, .services
fallback page) shipped. Backend daemon, Worker control-plane, ISO
build, web design system, marketplace backend, push token storage,
LLM-promo + tier subscription storage, VibeCodeSession parser, and
mobile Apps/Marketplace screens are shipped. Live URL deploy /
real-LLM streaming / APNs+FCM bridge / Stripe / sibling-WS endpoint
wiring (N0e-2) / install-policy push fan-out (N0d-2) remain.

See `memory/session_close_2026_05_07_multiplex_v2.md` for the full
push log of the multiplexing-v2 cycle.

---

## A. Web — flagshipserver.com (Cloudflare Worker)

### A.1 Marketing site

| ID | Task | Effort | Status | Deps |
|---|---|---|---|---|
| A.1.1 | `/` landing page | S | ☑ | — |
| A.1.2 | `/how-it-works` page | S | ☑ | — |
| A.1.3 | `/pricing` page | S | ☑ | — |
| A.1.4 | `/security` — architecture explainer with diagrams | M | ☐ | — |
| A.1.5 | `/abuse` — already exists; refresh with new design system | S | ☐ | — |
| A.1.6 | `/docs` — public docs portal (mdBook-style sidebar nav) | M | ☐ | A.1.1 |
| A.1.7 | `/blog` — static blog with RSS | M | ☐ | — |
| A.1.8 | `/.well-known/security.txt` (RFC 9116) | S | ☐ | — |
| A.1.9 | `/open-source` — license, governance, contributors | S | ☐ | — |
| A.1.10 | OG-image generator at `/og?title=...` | S | ☐ | — |

### A.2 Product surfaces (signed-in browser)

| ID | Task | Effort | Status | Deps |
|---|---|---|---|---|
| A.2.1 | `/build/` — paste build code, stream personalized ISO | S | ☑ | — |
| A.2.2 | `/build/?tier={tiny,standard,pro}` — pre-fill order intent | S | ☐ | I.3 |
| A.2.3 | `/download` — phone app links + PWA install | S | ☐ | F.1 |
| A.2.4 | `/marketplace` — listing grid + search + filters | M | ◐ | A.5 |
| A.2.5 | `/marketplace/<creator>/<slug>` — listing detail | M | ☐ | A.5 |
| A.2.6 | `/me/*` — paired-session-gated user area (servers, billing, listings) | L | ☐ | A.6, K.1 |
| A.2.7 | `/admin/*` — Flagship-staff dashboard (takedown, scan queue, refunds) | L | ☐ | A.5 |
| A.2.8 | `/status/` — already exists; refresh with new design + per-region cards | S | ☐ | — |
| A.2.9 | `/dev/create-server` — keep as phone simulator for dev (already exists) | — | ☑ | — |

### A.3 API: account & identity

| ID | Task | Effort | Status | Deps |
|---|---|---|---|---|
| A.3.1 | `POST /api/users/register` — IRK-signed; D1 `users` insert | S | ☐ | A.4.1 |
| A.3.2 | `POST /api/users/check?u=<name>` — availability lookup | S | ☐ | A.3.1 |
| A.3.3 | `GET /api/users/<name>` — public profile (username + listed apps) | S | ☐ | A.5 |
| A.3.4 | Username claim already exists — make consistent with A.3.1 (one row in `usernames` covers both) | S | ☐ | — |
| A.3.5 | `POST /api/users/me/link-push-token` — IRK-signed; encrypted-payload key | M | ☐ | K.1 |
| A.3.6 | `POST /api/users/me/recovery/enroll-cloud-shard` — wrapped UMK in iCloud / Google | M | ☐ | J.1 |

### A.4 D1 migrations

| ID | Migration | Status |
|---|---|---|
| A.4.0 | 0001_initial.sql (usernames, auth_codes, build_tickets) | ☑ |
| A.4.0 | 0002_routing.sql | ☑ |
| A.4.0 | 0003_install_events.sql | ☑ |
| A.4.0 | 0004_luks_keys.sql | ☑ |
| A.4.1 | 0005_marketplace_and_promo.sql (listings, installs, llm_promo, tier, hardware_orders, push_tokens, recovery_shards) | ☑ |
| A.4.2 | 0006_users_with_irk.sql — add `irk_pub_hex` column to `usernames` if not already there + `users_meta` (display_name, push tokens). | S | ☐ |

### A.5 API: marketplace

| ID | Task | Effort | Deps |
|---|---|---|---|
| A.5.1 | `POST /api/marketplace/list` — IRK-signed; insert/update `marketplace_listings` | M | A.4.1 |
| A.5.2 | `DELETE /api/marketplace/<creator>/<slug>` — IRK-signed; status=removed | S | A.5.1 |
| A.5.3 | `GET /api/marketplace/search?q=&cat=&filter=` — D1 query with rank | M | A.5.1 |
| A.5.4 | `GET /api/marketplace/<creator>/<slug>` — single listing | S | A.5.1 |
| A.5.5 | `POST /api/marketplace/<creator>/<slug>/install` — IRK-signed; idempotent install_count++ | S | A.5.1 |
| A.5.6 | `POST /api/marketplace/<creator>/<slug>/screenshots` — multipart, R2 upload, ≤5 files | M | A.5.1 |
| A.5.7 | `POST /api/marketplace/scan/request` — Stripe payment first; queues scan job *(power-user only — see Monetization note below)* | M | L.1, I.1 |
| A.5.8 | `POST /api/marketplace/feature/buy` — Stripe payment; sets `featured_until` *(power-user only — see Monetization note below)* | M | I.1 |
| A.5.9 | `POST /api/admin/marketplace/takedown` — admin-secret gated; status=removed | S | — |

### A.6 API: tier billing & LLM-promo

> **Monetization note (2026-05-09):** A.6.1–A.6.3 (Stripe checkout / portal /
> webhook) and A.5.7–A.5.8 (paid scan, paid feature) are **power-user only**
> and **do NOT gate any v1 alpha user flow**. Per the free-tier-first
> stance documented in `docs/monetization-free-tier-first.md` and memory
> `feedback_monetization_principle.md`, the core user loop (vibe → install
> → run → share → recover) must work end-to-end *without any payment
> surface existing*. The four power-user fees (LLM-promo bootstrap,
> dispatcher overage, custom domains, reserved trademark names) are
> deferred until that bar is hit. This means: the webapp cycle (P0–P5
> in `next-session-webapp-cycle.md`) ships first; A.6.x and the
> companion power-user wiring (P5.1–P5.4 in the cycle plan) ship after.

| ID | Task | Effort | Deps |
|---|---|---|---|
| A.6.1 | `POST /api/tier/checkout` — Stripe Checkout session; returns redirect URL *(power-user, deferred)* | S | I.1 |
| A.6.2 | `POST /api/tier/portal` — Stripe Billing Portal session *(power-user, deferred)* | S | I.1 |
| A.6.3 | `POST /api/tier/webhook` — Stripe webhook; updates `tier_subscriptions` + IRK receipt *(power-user, deferred)* | M | I.1 |
| A.6.4 | `POST /api/llm-promo/issue` — IRK-signed; check daily/lifetime caps; mint scoped key | M | I.2 |
| A.6.5 | `POST /api/llm-promo/usage-report` — provider webhook; updates counters | M | I.2 |
| A.6.6 | `GET /api/llm-promo/status` — current daily / lifetime usage for the calling user | S | A.6.4 |

### A.7 API: hardware orders (Path A)

| ID | Task | Effort | Deps |
|---|---|---|---|
| A.7.1 | `POST /api/hardware/order` — Stripe payment-intent, ship address, IRK-signed | M | I.3 |
| A.7.2 | `POST /api/hardware/order/<id>/ship-update` — admin webhook from fulfillment | S | A.7.1 |
| A.7.3 | `GET /api/hardware/order/<id>` — paired-session gated; status + tracking | S | A.7.1 |
| A.7.4 | `GET /api/box/order/<id>/blob` — box-side fetch of pre-paired build code; box-pre-install-key gated | S | A.7.1 |

### A.8 API: push notification routing

| ID | Task | Effort | Deps |
|---|---|---|---|
| A.8.1 | `POST /api/push/register` — IRK-signed; insert into `push_tokens` | S | K.1 |
| A.8.2 | `DELETE /api/push/<token-id>` — IRK-signed; revoke device | S | A.8.1 |
| A.8.3 | `POST /api/push/relay` — phone or daemon submits encrypted payload + target user; Worker forwards to APNs/FCM | M | K.1, K.2 |

### A.9 API: existing (already shipped, listed for completeness)

A.9.1 ☑ control-plane: auth-codes, build-tickets, server-register, server-revoke,
server-by-domain, routing, ca-cert, install-events, sealed-luks-keys,
unlock-key (deposit/consume), DNS-01 publish/delete, services-endpoints,
admin republish-server-dns / cleanup-apex.

A.9.2 ☐ refresh `/api/_status/probe` to also surface marketplace + LLM-promo health.

---

## B. Web — flagship.services (Fly app)

| ID | Task | Effort | Status |
|---|---|---|---|
| B.1 | Tunnel hub WS on :8443 | — | ☑ |
| B.2 | SNI passthrough on :443 | — | ☑ |
| B.3 | `/api/health` | — | ☑ |
| B.4 | Inter-services peer routing (deferred to v2; see future_inter_services_peering.md) | XL | ⏸ |
| B.5 | TURN relay for symmetric-NAT users (peer-backup users only) | L | ⏸ |

---

## C. Server daemon

### C.1 Already shipped

C.1.1 ☑ TLS terminator + tunnel client + ACME (DNS-01 wildcard).
C.1.2 ☑ Reverse proxy with member gate + signed-header injection.
C.1.3 ☑ AppPlatform install/uninstall + per-app data provisioning + per-app auth tokens.
C.1.4 ☑ AppRunner (docker compose).
C.1.5 ☑ Phone-orders endpoint (PSK-signed; 11 order types).
C.1.6 ☑ Pod-resident browser bundle (BrowserManager + TabRegistry + DomainGate + PhonePipe + apiHandlers).
C.1.7 ☑ Update-pack server + client + scheduler + lineage.
C.1.8 ☑ Subscriber registry + paired-session store + admin proxy + alert-inbox HTTP + identity-rotate HTTP.
C.1.9 ☑ runMigration dispatcher (.sql / .ts / .js).
C.1.10 ☑ Cert renewal scheduler.
C.1.11 ☑ buildCloneApp via /.flagship/update.

### C.2 LLM harness (vibe-coding loop) — NOT YET WIRED

| ID | Task | Effort | Deps |
|---|---|---|---|
| C.2.1 | Provider adapters in `packages/llm-providers` — already partial; complete Anthropic + OpenAI + Google | M | — |
| C.2.2 | `LlmHarness` class on the daemon: streams user prompt → manifest + sources → builds + deploys | L | C.2.1 |
| C.2.3 | Forgejo-side: programmatic repo creation, initial commit, tag | M | C.2.2 |
| C.2.4 | Build pipeline: `docker build` from cloned source, push to local registry, AppRunner deploy | M | C.2.2 |
| C.2.5 | HTTP surface `/api/llm/sessions` + WS `/api/llm/sessions/<id>/stream` (paired-session gated) | M | C.2.2 |
| C.2.6 | System prompt + manifest constraints: tells the LLM the manifest schema, X-Flagship-* contract, "no own auth" rule | M | C.2.2 |
| C.2.7 | Iteration: edit-and-revise within a session; reuses Forgejo repo for diff-based commits | M | C.2.5 |
| C.2.8 | Migrations generation: LLM emits SQL or TS; harness runs `runMigration` after deploy | M | C.2.6 |
| C.2.9 | Save & resume sessions: each session is a Forgejo branch | S | C.2.7 |
| C.2.10 | Cost meter: emit usage to phone via alert; respect promo cap at issue time | S | A.6.4 |
| C.2.11 | Tests: end-to-end "describe → working app" with a fake LLM provider | M | C.2.2 |

### C.3 Browser-viewer relay

| ID | Task | Effort | Deps |
|---|---|---|---|
| C.3.1 | Daemon-side WS `/api/browser/viewer/<tabId>`: streams 2 fps screenshot + accepts touch/key events | M | C.1.6, C.1.8 |
| C.3.2 | Frame-format spec: PNG-or-WebP frame + delta encoding | M | C.3.1 |
| C.3.3 | Tap → CDP `Input.dispatchMouseEvent`; key → `Input.insertText` | S | C.3.1 |
| C.3.4 | Phone-paired-session gate (no app token here) | S | C.1.8 |
| C.3.5 | Tests: stream against FakeCdpServer | M | C.3.1 |

### C.4 Restart hooks (currently stubbed in main())

| ID | Task | Effort |
|---|---|---|
| C.4.1 | `restartContainer(appId)` — `AppRunner.restart` to pick up new bind-mounted source | S |

### C.5 LAN/BLE fallback

| ID | Task | Effort | Status |
|---|---|---|---|
| C.5.1 | mDNS publish `_flagship._tcp` from daemon | S | ⏸ |
| C.5.2 | Phone-side mDNS scan + same-protocol authentication over LAN | M | ⏸ |
| C.5.3 | BLE GATT service for control messages only | M | ⏸ |

### C.6 Recovery / re-pair

| ID | Task | Effort | Deps |
|---|---|---|---|
| C.6.1 | `POST /api/recovery/re-pair` — phone with new IRK supplies signed `RePairRequest` referencing old IRK; daemon verifies via .com lookup of the username's current IRK pubkey + a 24h grace | M | J.1 |
| C.6.2 | Update PSK / membership / paired-session entries owned by the previous phone | M | C.6.1 |
| C.6.3 | Tests | S | C.6.1 |

### C.7 STK (server identity) rotation end-to-end

| ID | Task | Effort | Status |
|---|---|---|---|
| C.7.1 | `/api/identity/pending` HTTP route | — | ☑ |
| C.7.2 | `rotate-server-identity` order executor | — | ☑ |
| C.7.3 | Phone UI to walk the rotate flow (D.7.5) | S | D.7.5 |
| C.7.4 | Tunnel reconnect on new identity (test it actually works under load) | M | C.7.2 |

### C.8 App log streaming

| ID | Task | Effort | Deps |
|---|---|---|---|
| C.8.1 | `GET /api/apps/<id>/logs?tail=200` (paired-session gated, hostIRK-only role) | S | C.1.3 |
| C.8.2 | WS `/api/apps/<id>/logs/stream` for tail-f | M | C.8.1 |

### C.9 Forgejo first-boot provisioning

| ID | Task | Effort |
|---|---|---|
| C.9.1 | Daemon initializes Forgejo on first compose-up: creates per-host org, sets default branch, mints internal token for LlmHarness | M |
| C.9.2 | Per-app repo creation API used by C.2.3 | S |

---

## D. iOS app (apps/mobile/ios/)

Existing scaffolds: `Keystore.swift`, `BiometricGate.swift`, `BootAuthorization.swift` (crypto only). Needs full SwiftUI app.

### D.1 Project shell

| ID | Task | Effort |
|---|---|---|
| D.1.1 | Xcode project with `FlagshipApp` (SwiftUI lifecycle), iOS 17+ deployment | S |
| D.1.2 | Apple Developer team config + bundle id `com.flagship.app` + entitlements (camera, push, biometrics) | S |
| D.1.3 | Theme (Color + Font) layer mirroring `tokens.css` | S |
| D.1.4 | Component primitives: `FSButton`, `FSCard`, `FSPill`, `FSField`, `FSToast` | M |
| D.1.5 | Navigation root: tab bar (Servers, Apps, Activity, Settings) | S |
| D.1.6 | Network layer: typed requests against `flagshipserver.com` + per-server daemon URLs | M |
| D.1.7 | App-local persistence: `KeychainStore` for tokens, `CoreData` for cached server/app metadata | M |

### D.2 Onboarding (no account yet)

| ID | Screen | Notes |
|---|---|---|
| D.2.1 | `WelcomeView` | Two CTAs: "Create account" / "I already have a server" |
| D.2.2 | `ChooseUsernameView` | Live availability check `/api/users/check`; rules `[a-z0-9]{1,32}`; loading + error states |
| D.2.3 | `BiometricSetupView` | Generates UMK in Secure Enclave, derives IRK/BAK/SWK; Face ID prompt; cloud-recovery toggle |
| D.2.4 | `RegisterView` | Posts `RegisterUser` to .com; failure recovery |
| D.2.5 | `PermissionsView` | Push, biometrics, camera; one screen, three opt-in cards |

### D.3 Servers

| ID | Screen | Notes |
|---|---|---|
| D.3.1 | `ServerListView` | Empty state: "No servers yet"; row per server with status pill |
| D.3.2 | `AddServerView` | Two cards: "Order one" / "Build my own" |
| D.3.3 | `OrderTierView` | Three tiers + add-on; price; button → `OrderShippingView` |
| D.3.4 | `OrderShippingView` | Address fields with autocomplete (Apple Maps); validation |
| D.3.5 | `OrderPayView` | Apple Pay sheet (PaymentRequest API to Stripe) |
| D.3.6 | `OrderTrackingView` | Live timeline; deep-link from delivery notification |
| D.3.7 | `BYOHView` | Server name field + share-ratio slider; "Generate build code" |
| D.3.8 | `BuildCodeDisplayView` | QR + 20-char base32 code; live polling for box-online |
| D.3.9 | `ServerDetailView` | Status, uptime, disk, certs (expiry), IP; tabs: Overview / Apps / Browser / Data / System |
| D.3.10 | `ServerSettingsView` | Restart, rotate identity, revoke-self, set backup policy, manage paired browsers, manage subscribers |

### D.4 Approve unlock (push-driven)

| ID | Screen | Notes |
|---|---|---|
| D.4.1 | `ApproveUnlockView` | Server name, requesting IP/SSID, fingerprint; Face ID button; "Not me. Block." ghost-danger |
| D.4.2 | Auto-approve toggle: `from home Wi-Fi for 24h` | Stores SSID hash + expiry locally |
| D.4.3 | Notification quick-action: Approve inline (without opening app) | M |

### D.5 Apps

| ID | Screen | Notes |
|---|---|---|
| D.5.1 | `AppsListView` | Per-server filter; status pills; "+ Vibe-code" / "+ Install someone else's" |
| D.5.2 | `AppOverviewView` | URL, version, members count, last update; Restart / Stop / Settings |
| D.5.3 | `AppMembersView` | List + invite + remove |
| D.5.4 | `InviteCreateView` | Role picker, share method (link / username) |
| D.5.5 | `InviteAcceptView` | App preview, role, accept Face ID |
| D.5.6 | `AppDataView` | Per-store size + status; embed Adminer/MinIO/Redis via SafariView with paired-session token |
| D.5.7 | `AppUpdatesView` | Policy picker, pending diff (read-only file tree), "Apply" |
| D.5.8 | `AppLogsView` | Tail-f with pause/resume; severity filter |
| D.5.9 | `AppSharingView` | Make-public toggle; description editor; screenshot upload; security-scan / featured purchase |
| D.5.10 | `AppLockView` | Big-red panic; freeze all members except owner |

### D.6 Vibe-code

| ID | Screen | Notes |
|---|---|---|
| D.6.1 | `VibeCodeProviderPickView` | "Use Flagship promo (50/day, 200 lifetime)" + "Use my own key" |
| D.6.2 | `VibeCodeAPIKeyView` | Provider dropdown + masked key field + Test button |
| D.6.3 | `VibeCodeDescribeView` | Free-text textarea; example chips; name + visibility + AI provider dropdowns; estimated permissions list |
| D.6.4 | `VibeCodeGeneratingView` | Streaming chat-with-thinking from daemon WS; user can interject |
| D.6.5 | `VibeCodeReviewView` | Manifest + file tree + first migration; "Deploy" / "Save & continue later" |
| D.6.6 | `VibeCodeDeployingView` | Progress: build → migrate → deploy → URL ready |

### D.7 Marketplace

| ID | Screen | Notes |
|---|---|---|
| D.7.1 | `MarketplaceBrowseView` | Grid + categories filter + search; pull-to-refresh |
| D.7.2 | `ListingDetailView` | Screenshots carousel, description, manifest scopes preview, "Install on my server" |
| D.7.3 | `ListingInstallView` | Server picker + scope-approval list (data, browser domains, push) + Face ID |
| D.7.4 | `MyListingsView` | Listings I've made; per-listing edit + scan-status + featured-status |
| D.7.5 | `IdentityRotateView` | Walks rotate-identity flow: confirm → POST /api/identity/pending → show new pubkey → sign rotate-order with PSK |

### D.8 Browser viewer

| ID | Screen | Notes |
|---|---|---|
| D.8.1 | `BrowserViewerView` | Full-screen WebSocket-streamed screenshot + native gesture relay |
| D.8.2 | `BrowserLoginPromptView` | "Log in to amazon.com on your pod" CTA → opens D.8.1 with the pod's tab |
| D.8.3 | `BrowserInputResponseView` | Triggered by `browser-input-needed` push; secure text input + Face ID confirm |

### D.9 AlertInbox / Activity

| ID | Screen | Notes |
|---|---|---|
| D.9.1 | `ActivityFeedView` | Reverse-chrono list; categories: lineage-break, manual-pending, migration-failed, browser-input, security-event, promo-limit |
| D.9.2 | Per-alert detail screens (lineage break, migration failed) with re-anchor / freeze / retry actions | M |
| D.9.3 | Mark-as-read sync via `POST /api/phone/alerts/ack` | S |

### D.10 Settings

| ID | Screen | Notes |
|---|---|---|
| D.10.1 | `SettingsRootView` | Tier, AI provider, recovery, paired browsers, about |
| D.10.2 | `TierSettingsView` | Current tier + usage + change-plan link to web |
| D.10.3 | `AIProviderSettingsView` | BYOK or promo; per-server AI provider choice |
| D.10.4 | `RecoverySettingsView` | iCloud Keychain enrollment status; export wrapped UMK; social-recovery (v2) |
| D.10.5 | `PairedBrowsersView` | List labels + last-seen; revoke per row |
| D.10.6 | `AboutView` | Version, source link, BUSL note |

### D.11 Recovery (lost phone)

| ID | Screen | Notes |
|---|---|---|
| D.11.1 | `RecoverFromCloudView` | Trigger iCloud Keychain unwrap; biometric on new phone |
| D.11.2 | `RecoverServerListView` | Pulls server list from .com via username + signed challenge |
| D.11.3 | `RecoverPairView` | Re-mint paired sessions on each server |

### D.12 Pair-browser

| ID | Screen | Notes |
|---|---|---|
| D.12.1 | `PairBrowserView` | "Pair this device" — generates token, displays QR + URL, sends `add-paired-session` order |

### D.13 Push notification categories

Define in `Info.plist`. Each declares quick-actions:

| Category | Actions |
|---|---|
| `unlock-request` | Approve (foreground), Decline (background) |
| `browser-input` | Open viewer (foreground only) |
| `update-ready` | Open app (foreground), Dismiss |
| `lineage-break` | Open re-anchor (foreground) |
| `promo-limit` | Open BYOK (foreground), Dismiss |
| `security-event` | Open detail (foreground) |
| `app-shared` | Accept (foreground), Decline (background) |

---

## E. Android app (apps/mobile/android/)

Mirror D, with these substitutions:

- Stack: Kotlin + Jetpack Compose + Coroutines + Hilt + Retrofit + Coil.
- Crypto: StrongBox-backed `KeyStore` for UMK; libsodium-jni or Tink for X25519/AES-GCM.
- Biometric: `BiometricPrompt`.
- Push: Firebase Cloud Messaging.
- QR: CameraX + ML Kit Barcode.

| ID | Task | Mirrors | Notes |
|---|---|---|---|
| E.1.1 | Gradle project layout matching the existing `apps/mobile/android` build files | D.1.1 | Already has scaffolds; add Compose Material 3 deps + nav-compose |
| E.1.2 | Theme + components in `ui/theme/` and `ui/components/` | D.1.3, D.1.4 | |
| E.2 | Onboarding screens | D.2 | Same flow; biometric API wrap is `BiometricPrompt` |
| E.3 | Servers screens | D.3 | Order screens use Google Pay sheet (or Stripe Element WebView) |
| E.4 | Approve unlock | D.4 | NotificationCompat.Action quick-actions |
| E.5 | Apps screens | D.5 | |
| E.6 | Vibe-code screens | D.6 | |
| E.7 | Marketplace screens | D.7 | |
| E.8 | Browser viewer | D.8 | |
| E.9 | Activity / alerts | D.9 | |
| E.10 | Settings | D.10 | Recovery uses Google Block Store API |
| E.11 | Recovery | D.11 | |
| E.12 | Pair-browser | D.12 | |
| E.13 | Push categories via FCM data messages + `NotificationChannel` per category | D.13 | |
| E.14 | Tests: instrumented (`androidx.test`) + screenshot tests via Paparazzi | M | |

---

## F. PWA web app (apps/com/web-app/ — was apps/web/public/webapp/)

Mirror the phone app inside a browser tab. Subset of features (no USB flashing).

| ID | Task | Effort | Notes |
|---|---|---|---|
| F.1 | PWA manifest + service worker + offline shell | M | `apps/com/web-app/manifest.webmanifest` |
| F.2 | UMK in IndexedDB wrapped via WebAuthn (`navigator.credentials.create({publicKey: { ... rk: required }})`) | L | Browser-only key custody; lossy but real |
| F.3 | All onboarding (D.2) screens in vanilla JS / lit-html / preact | L | |
| F.4 | All Servers screens; the BYOH path links to `/build/` (PWA can't flash) | L | |
| F.5 | Approve-unlock + browser-input flows via WebPush | M | |
| F.6 | Vibe-code, Apps, Marketplace, Settings screens | L | Largely the same components as web marketing |
| F.7 | Recovery: WebAuthn-only — fewer guarantees than native; explicit warning | M | |

---

## G. Marketplace (cross-cutting)

| ID | Task | Effort | Deps |
|---|---|---|---|
| G.1 | Listing canonical-bytes signature scheme — already shipped via IRK; add to `@flagship/protocol` if not present | S | — |
| G.2 | Daemon: when an app's `manifest.distribution.public = true` AND a marketplace listing exists, auto-add anyone hitting `/.flagship/update` to subscribers (rate-limited) | M | A.5.1 |
| G.3 | Auto-derive `manifest_hash_hex` from cloned repo at listing time; phone re-checks before install | S | A.5.1 |
| G.4 | Worker: ranking score recalc job (cron) — install_count + scan_grade + featured weighting | S | A.5.1 |
| G.5 | Phone install scope-approval UI — show data, browser domains, push, peer-backup-pool implications | M | D.7.3 |
| G.6 | Listing draft mode (status='private') so creators iterate before going public | S | A.5.1 |

---

## H. LLM harness (vibe-coding)

See C.2.x for daemon-side. Phone-side in D.6. Worker-side in A.6.4.

System-level decisions to lock:

| ID | Decision | Notes |
|---|---|---|
| H.1 | First-class providers: Anthropic Sonnet, OpenAI GPT-4o, Google Gemini 1.5 Pro | Promo defaults to Sonnet |
| H.2 | Manifest emit format: bare JSON with single canonical schema_version=1 | |
| H.3 | Source emit format: stream of `=== filename ===\n<content>\n` blocks | Keeps it tool-agnostic |
| H.4 | Migration emit: filename `migrations/0001_<verb>.sql` or `.ts`; we run `runMigration` after deploy | |
| H.5 | LLM forbidden tools: cookies/auth in app code, raw browser CDP, listening on non-app port | Enforced in system prompt + manifest validator |
| H.6 | Failure modes: build fails → show stderr; deploy fails → roll back data; LLM emits unparseable manifest → retry once with the parser error fed back | |
| H.7 | Edit loop UX: "make it greener" → small diff PR style | |

---

## I. Tier billing & checkout

| ID | Task | Effort | Deps |
|---|---|---|---|
| I.1 | Stripe Worker integration (Checkout, Billing Portal, Webhooks) | M | — |
| I.2 | LLM-promo provider key minting (Anthropic scoped keys + OpenAI org keys + usage webhooks) | L | — |
| I.3 | Hardware order checkout + Shippo for shipping labels | L | — |
| I.4 | IRK-receipt format — phone signs `{username, tier, period_end, stripe_subscription_id}` after each upgrade | M | — |
| I.5 | Tier enforcement on the daemon: read tier from local cache; daemon refuses installs over tier limit | S | I.1 |
| I.6 | Promo daily/lifetime cap enforcement at issue time (`A.6.4`) | S | A.6.4 |
| I.7 | Refund flow: `POST /api/admin/refund/<order-id>` — admin-only | S | I.3 |

---

## J. Recovery

| ID | Task | Effort | Notes |
|---|---|---|---|
| J.1 | Wrap UMK with iCloud Keychain (iOS) + Google Block Store (Android) at first setup | M | D.2.3, E.2 |
| J.2 | Recovery flow on new phone: unwrap UMK → re-derive IRK → login challenge to .com | M | D.11, E.11 |
| J.3 | Per-server re-pair: new IRK signs a `re-pair` envelope referencing old IRK; .com confirms in 24h grace; daemon swaps PSK + paired-session entries | M | C.6 |
| J.4 | Membership re-attach: walk all apps; re-issue stable-ids; emit phone alert per app for review | M | J.3 |
| J.5 | Social recovery v2 (deferred): N-of-K Shamir with friend's IRK as guardians | XL | ⏸ |

---

## K. Push notifications

| ID | Task | Effort | Notes |
|---|---|---|---|
| K.1 | APNs cert + auth token bridge in Worker; FCM project + service-account key | M | |
| K.2 | Encrypted-payload spec: phone pre-shares X25519 push pubkey at register; daemon seals payload to it; Worker just relays opaque bytes | M | sealForRecipient already exists |
| K.3 | Per-category Notification config on iOS + Android | S | D.13 |
| K.4 | Quiet hours / Focus integration on iOS; channels with importance on Android | S | |
| K.5 | Tests against APNs sandbox + FCM test app | M | |

---

## L. Marketplace security scan service

| ID | Task | Effort | Notes |
|---|---|---|---|
| L.1 | Scanner CI worker (separate Fly app or GH Actions): clones canonical pod's repo at the listed manifest_hash | M | |
| L.2 | Scan steps: `npm audit`, `trivy fs`, `semgrep --config=p/owasp-top-ten`, dynamic in a sandboxed container | M | |
| L.3 | Letter grade A–F policy: encode in code, document publicly | S | |
| L.4 | Report PDF generation (puppeteer print-to-PDF), upload to R2 | S | |
| L.5 | Webhook back to Worker → updates `marketplace_listings.scan_grade + scan_report_key` | S | A.5.7 |
| L.6 | Re-trigger on each new manifest_hash | S | |
| L.7 | Public report URL: `flagshipserver.com/marketplace/<creator>/<slug>/scan/<hash>.pdf` | S | |

---

## M. Peer-backup distribution (deferred to v2)

Already detailed in `roadmap.md` §1. Listed here for completeness.

| ID | Task | Effort |
|---|---|---|
| M.1 | Local shard registry (sqlite) | M |
| M.2 | Frame-protocol extension on the tunnel | M |
| M.3 | Direct P2P transport (QUIC) | L |
| M.4 | Matchmaker on .com | M |
| M.5 | NAT traversal (STUN/ICE) | M |
| M.6 | Proof-of-storage challenges | M |
| M.7 | Repair daemon | M |
| M.8 | Reciprocity accounting | M |

---

## N. Documentation

| ID | Task | Effort | Status |
|---|---|---|---|
| N.1 | `docs/architecture.md` (in-repo) | S | ⏸ |
| N.2 | `docs/threat-model.md` | M | ⏸ |
| N.3 | `docs/manifest-reference.md` (every field, every constraint) | M | ⏸ |
| N.4 | `docs/app-developer-guide.md` (without LLM, hand-coding apps) | M | ⏸ |
| N.5 | `docs/recovery.md` (lost phone, new phone, revoke server) | S | ⏸ |
| N.6 | `CONTRIBUTING.md` | S | ⏸ |
| N.7 | `SECURITY.md` (disclosure + bounty policy) | S | ⏸ |
| N.8 | Public docs portal at `/docs` (renders the in-repo markdown) | M | A.1.6 |
| N.9 | Blog posts seed: 3 launch posts (philosophy, install demo, marketplace launch) | M | A.1.7 |

---

## O. Reproducible builds + supply chain

| ID | Task | Effort |
|---|---|---|
| O.1 | CI job: build the ISO twice on independent runners + bit-compare | M |
| O.2 | Lockfile audit + Dependabot or equivalent | S |
| O.3 | Signed-release pipeline: tag + sigstore + checksum manifest | M |
| O.4 | NOTICE / LICENSE files audit (every dep) | S |
| O.5 | `.well-known/security.txt` (RFC 9116) | S |
| O.6 | Reproducible Android APK build — set deterministic timestamps + sort entries | S |
| O.7 | iOS reproducible-ish: pin Xcode version + lock `.xcconfig` + checksum the .ipa | S |

---

## P. Operations / SRE

| ID | Task | Effort |
|---|---|---|
| P.1 | Worker logging + metrics (Cloudflare Analytics + Tail) | S |
| P.2 | Per-app metrics on the daemon (CPU/mem from cgroups + http counts) | M |
| P.3 | Status-page widgets driven from `/api/services/endpoints` + per-region probes | S |
| P.4 | Incident runbook (`docs/runbook.md`) | S |
| P.5 | Scheduled jobs: stale auth-codes, sealed-blob TTL, unused Forgejo repos, scan-cache eviction | S |
| P.6 | Cert renewal (already done) | — |
| P.7 | Backup of D1 (Worker cron → R2 dump) | M |
| P.8 | On-call rotation + alerting (Pagerduty / Better Uptime) | S |

---

## Q. Cross-cutting protocol additions

These are wire-format changes that show up in multiple components.

| ID | Type | Purpose |
|---|---|---|
| Q.1 | `set-llm-key` PhoneOrder | Phone delivers wrapped LLM API key to the box |
| Q.2 | `MarketplaceListRequest` canonical-bytes type in `@flagship/protocol` | IRK-signed listing |
| Q.3 | `RegisterUser` canonical-bytes type | IRK-signed user registration |
| Q.4 | `MembershipMutation: freeze / unfreeze` | App lock variant |
| Q.5 | `PushTokenRegister` canonical-bytes type | IRK-signed device registration |
| Q.6 | `LlmPromoIssueRequest` canonical-bytes type | IRK-signed promo key request |
| Q.7 | `IRKReceipt` canonical-bytes type | Phone acknowledgement of a tier change |

---

## R. Build-order recommendation (what we ship, in what order)

Working assumption: 1–2 engineers full time + Claude doing code generation.

| Phase | Goal | Items | Weeks |
|---|---|---|---|
| **R.1** | Marketplace MVP (browse + list + install on existing pods) | A.5, G, A.4.2 | 1 |
| **R.2** | iOS app onboarding + servers + approve-unlock | D.1, D.2, D.3, D.4, K | 4 |
| **R.3** | iOS apps + vibe-code + marketplace browse | D.5, D.6, D.7, C.2 | 4 |
| **R.4** | Android app (mirror iOS, parallel track) | E.* | 4–6 |
| **R.5** | Tier billing + LLM-promo enforcement | I, A.6 | 2 |
| **R.6** | Recovery flow | J, C.6 | 2 |
| **R.7** | Security scan service | L | 1 |
| **R.8** | Docs + reproducible builds + SRE | N, O, P | 2 |
| **R.9** | Public alpha launch | — | 1 |
| **R.10** | Peer-backup, mobile polish, web app | M, F | ongoing |

---

## S. v1 alpha done-when checklist

(Same as `lifecycle-spec.md §15`, kept here for the build-tracker.)

- [ ] iOS app on TestFlight, 5+ external testers
- [ ] Android app on internal-track Play Store, 5+ external testers
- [ ] Marketplace MVP live with ≥10 listings and ≥3 cross-pod installs
- [ ] LLM-promo daily/lifetime cap enforced + tested
- [ ] Update-pack pull working across two pods over 7 days
- [ ] Lineage-break + re-anchor flow exercised live
- [ ] STK rotation exercised live
- [ ] Recovery (lost phone → new phone) exercised live
- [ ] Public security disclosure page + bounty payouts
- [ ] Reproducible-build CI for ISO

When all checked: v1 alpha. Then iterate.

---

## Maintenance

When a task lands: change ☐ → ☑ in this file in the same commit as
the implementation. When a task gets pruned (decided not to build):
strike-through and add a note. When a task gets split, give the new
subtasks fresh IDs (don't reuse).

Long-lived workstreams (R.10) get their own follow-up files referenced
from this one.

---

## Multiplexing v2 (added 2026-05-07)

The v1 alias system (D1 table + `/api/aliases/*` Worker routes + per-
alias SAN expansion on the daemon, briefly shipped in `3fe6854`) was
ripped out and replaced with a controlledDomains-on-HELLO model. New
task IDs:

| ID | Task | Status |
|---|---|---|
| N0a | Rip out v1 app_aliases system | ☑ |
| N0b | Tunnel HELLO controlledDomains + last-HELLO-wins routing | ☑ |
| N0c | User-zone wildcard cert + wildcard CNAME | ☑ |
| N0d | claim-url / release-url PhoneOrders + UrlController | ☑ |
| N0d-2 | Install-policy storage + push fan-out on new server | ☐ |
| N0e | Sibling-WS frame protocol + handshake state machine | ☑ |
| N0e-2 | Sibling WS endpoint at /.flagship/sibling-handshake + outbound client | ☐ |
| N0f | .services fallback page when SNI unclaimed under user zone | ☑ |
| N0g | Rewrite docs/multiplexing.md to FINAL DESIGN | ☑ |
| N0h | ClaimUrlCapability primitives + CapabilityStore + checkCapability | ☑ |
| N0i | App-level sibling API (/api/live_siblings/list,send,poll) | ☑ |
| N0j | App-claim primitives (/api/url/*) with capability enforcement | ☑ |
| N0k | Replication-patterns chapter for the LLM system prompt | ☑ |
| N1 | Wire deploySession end-to-end (vibe-code → AppPlatform.install + Forgejo + docker) | ☐ |
| N2 | Real LLM provider streaming (Anthropic, OpenAI, Google) | ☐ |
| N3 | APNs + FCM push bridge (replaces /api/push/relay simulated:true) | ☐ |
| N4 | Apps list + Apps detail screens (iOS + Android) | ☑ |
| N5 | Marketplace list + detail screens (iOS + Android) | ☑ |
| N8 | Stripe Checkout + tier-subscription webhook | ☐ |
| N9 | Manifest reference + app-developer guide | ☑ |
| N10 | Sweep build-tasks.md statuses | ☑ (this section) |

`N6` (alias UI in Apps detail) folded into `N4`.
`N7` (replication v2) deprecated — replication is no longer harness
territory; the sibling-WS in N0e + N0i is the substrate apps build on.
