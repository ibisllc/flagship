# Monetization — remaining tasks (design notes)

> Companion to `docs/monetization-roadmap.md` (the task list + what's landed) and
> `docs/mobile-monetization-spec.md` (the Mac-only mobile work: #23 + #19's mobile
> half). This file holds **actionable design notes** for the remaining
> non-mobile tasks so each can be picked up cold. Built primitives to reuse:
> `grantTier` (the tier writer), `grantAppPurchase` (the app-ownership writer),
> the Stripe webhook (sub + app, idempotent), vouchers, the metering quota model
> (`metering.ts`), the marketplace listing/scan pipeline. Migrations to date:
> 0051 usage, 0052 vouchers, 0053 stripe-events, 0054 app-purchases.

Conventions for everything below: entitlement writes go through the existing
single-writer primitives (never write `tier_subscriptions` / `app_purchases`
directly); `.com` stays content-blind; no in-app purchase UI (web-only payment,
App Review 3.1.1); env-gate anything needing external keys so it ships dark.

---

## #5 — Activate metering (owner deploy; no code)

**Goal.** Turn the free-tier 50 GB hard cap ON in production, safely.

**Steps (in order — the sequencing rule: upgrade path must exist FIRST, which it
now does in code):**
1. Apply migrations to prod D1: `0051` (already applied per CLAUDE.md), **0052,
   0053, 0054** (`cd apps/com && npx wrangler d1 execute flagship-state
   --file=../../packages/storage/migrations/00XX_*.sql --remote`).
2. Reconcile the relay secret: ensure `USAGE_REPORT_SECRET` (Worker) ==
   `USAGE_REPORT_SECRET` (Fly) — a fresh `openssl rand -hex 32` piped to both via
   `wrangler secret put` + `fly secrets import` without printing it (as done for
   the staged value).
3. `npx tsc -b && (cd apps/com && npx wrangler deploy)`; `flyctl deploy
   --remote-only -a flagship-services` (the relay `UsageMeter` is OFF unless the
   secret is set — setting it + deploying flips it on).
4. **Verify** with a throwaway account: drive egress, watch `/api/usage/report`
   batches land, confirm `/api/users/:u/allowance` reflects usage, and that a free
   account over 50 GB stops admitting new public traffic (`admit:false`).

**Done when:** a free account hard-caps at 50 GB and a paid one bills overage
instead; the dashboards show live numbers.

---

## #12 — Fill `/pro` + Stripe config (owner; no code)

**Goal.** Make the `/pro` page real + light the card lane.

**Steps:**
- Edit `apps/web/public/pro.html`: replace `[ your mailing address … ]` and `[
  your Monero address … ]` placeholders.
- Set Stripe (all `wrangler secret put` except price ids/urls which can be
  `[vars]`): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_HOBBY`,
  `STRIPE_PRICE_MAKER`, `STRIPE_SUCCESS_URL` (`https://flagshipserver.com/pro?ok=1`),
  `STRIPE_CANCEL_URL` (`https://flagshipserver.com/pro`). In Stripe: create the two
  recurring Prices + a webhook endpoint → `https://flagshipserver.com/api/stripe/webhook`
  subscribed to `checkout.session.completed`, `invoice.paid`,
  `customer.subscription.deleted`.
- Deploy the Worker. Until set, the card lane 503s and the page falls back to
  cash/Monero/voucher (already wired).

**Done when:** a card checkout from `/pro` completes and the account flips to Pro
within a minute; a voucher redeem already works today.

---

## #15 — Developer onboarding, payouts, revenue cut

**Goal.** Let third-party devs list **paid** apps, get paid, and let us take a
generous cut (e.g. 90/10 dev-favourable — confirm in #22).

**Approach.**
- **Pricing self-serve.** Today price is admin-set (`setPrice`, curated). Add a
  creator-signed `set-app-price` path: extend the listing claim OR a sibling IRK
  envelope (`flagship/marketplace/set-price/v1|creator|slug|priceUsdCents|issuedAt`)
  verified against the creator's registered IRK — keeps the writer single
  (`marketplace.setPrice`) but authorizes the creator, not just admin. (Chose a
  sibling envelope earlier specifically to avoid a canonical-bytes ripple on the
  listing claim — keep that.)
- **Payout ledger.** New migration: `app_sales` (event_id PK from Stripe, creator,
  slug, username, gross_cents, fee_cents, net_cents, created_at). Populate it in
  the Stripe **app** webhook branch alongside `grantAppPurchase` (same idempotent
  event). `net_cents = gross - round(gross * CUT)`.
- **Connect vs manual.** v1: manual payouts off the ledger (a `/api/admin/
  payouts?creator=` report). v2: Stripe Connect (transfer to the dev's connected
  account at purchase) — bigger lift, defer.
- **Dev console (web).** A `/developer` page (or webapp section) showing a dev's
  listings, prices, sales totals, pending payout. Read-only auth via the dev's
  account.

**Constraints.** Tax/VAT is real once money flows to third parties — note as a
legal gate before public dev signup; first-party apps (#18) don't need it.
**Depends on:** #14 (done). **Done when:** a dev sets a price, a sale records a
ledger row with the cut, and the admin payout report sums correctly.

---

## #16 — "Create app" marketplace-first funnel

**Goal.** Make "start from an app already adapted to Flagship" the low-friction
default on-ramp, without burying vibe-coding.

**Approach (web/webapp + mobile create flows).**
- The create/add-service entry (`CreateServerStub` / add-service chooser) leads
  with **"Browse the marketplace"** (install a ready app) as the primary action,
  with **"Build your own (vibe-code)"** kept prominent as the secondary.
- For a **paid** app the funnel is: browse → listing detail (price, scan grade) →
  **buy on the web** (Stripe `app-checkout`) → return → install (now owned) →
  optional customization tokens (#17).
- Surface the **scan grade** (A–F) prominently on listing cards/detail (the data
  exists: `scan_grade`) so "vetted" is visible — ties the safety story to the buy.

**Where:** webapp `views/` marketplace + add-service; mobile add-service chooser
(see mobile spec §5). **Depends on:** #14, #13 (done), #18 (need apps to show).
**Done when:** the default add-service path shows the marketplace first and a paid
install round-trips through the web buy.

---

## #17 — Bundle capped customization tokens with app purchases

**Goal.** A paid app comes with a **capped, sale-funded** budget of LLM
customization tokens ("throw in tokens to tweak your installed app"), with a BYOK
upsell once exhausted. Caps protect the margin (the sale funded a fixed budget).

**Approach.**
- New migration: `customization_grants` (username, creator, slug, tokens_total,
  tokens_used, granted_at, PK(username,creator,slug)) — a per-purchase budget.
- Grant in the same place app ownership is granted (`grantAppPurchase` →
  optionally seed a token budget from a per-listing `bundled_tokens` column on
  the listing, set with the price in #15). Single idempotent write.
- **Spend path** lives on the **box** (the harness/LLM provider runs box-side, the
  vibe-code/customization loop is on the pod). The box meters tokens against the
  grant; when exhausted it prompts BYOK (the existing `llm-promo`/BYOK paths).
  `.com` only holds the *grant* (entitlement), the box holds the *meter* — keep
  content-blind: the box reports "budget exhausted", not the prompts.
- A `GET /api/users/:u/customization-grants` read for the client to show
  remaining tokens.

**Constraints.** The token *value* must be ≤ a fraction of the app price so it's
never a loss leader (lock the ratio in #22). **Depends on:** #14, #15 (price +
bundled_tokens). **Done when:** buying a token-bundled app seeds a budget, the box
spends against it, and exhaustion routes to BYOK.

---

## #18 — Seed first-party Flagship-adapted apps (cold-start)

**Goal.** Solve the empty-marketplace problem: ship a handful of polished,
Flagship-native apps (some free, some paid) so the marketplace isn't bare on day
one and the buy flow has real targets.

**Approach.**
- Build/adapt 3–5 apps against the data layer (`unified_data_layer` —
  Postgres/MinIO/Redis per box) + the manifest (`flagship.app.json`) +
  pod-resident browser where relevant. Candidates: a notes/wiki, a read-later, a
  photos/gallery, a personal dashboard, a link-shortener UI over `voi.ci`.
- List them as first-party (`creator` = a Flagship account), run them through the
  scanner (#13) for a real grade, set prices on a couple (curated via `setPrice`).
- These are **app projects**, not platform code — they live in their own repos/
  marketplace listings, not necessarily in this monorepo. Workspace artifacts
  (the listing rows) go straight to prod D1 like other feature tables.

**Depends on:** #14, #13. **Done when:** the marketplace shows ≥3 vetted
first-party apps, ≥1 paid, all installable end-to-end.

---

## #19 — Mobile install-what-you-own (backend DONE)

Backend shipped: `GET /api/users/:u/purchases` + 402-gated install + serialized
`is_paid`/`price_usd_cents`. **Remaining is mobile + the web purchase-return
flow** — see `docs/mobile-monetization-spec.md §5`. Web side: a small "your apps"
list in the webapp marketplace and a clean post-checkout return to the listing
showing ownership. **Done when:** a user who bought an app on the web can install
it on any box from any client, and re-find it under "your apps".

---

## #20 — Turnkey login/SSO gateway (Pro / paid capability)

**Goal.** A one-switch "put this app behind login" / "single-sign-on across my
apps" capability, sold as Pro (or a paid add-on). **Keep "make an app private"
free + private-by-default** — we sell the *turnkey gateway*, not basic access
control.

**Approach.** This is a **box-side** feature (the gateway runs in the daemon /
harness in front of the app, terminating the session on the box — content-blind to
`.com`). The Pro/paid check is a **soft gate**: the box asks `.com`
`GET /api/users/:u/allowance` (or a dedicated entitlement read) for tier, and
enables the gateway toggle only for Pro. A lapsed sub disables the toggle but must
**not** lock the user out of their own data (fail-safe: gateway off ⇒ app reverts
to its prior private-by-default posture, never public).

**Constraints.** Security primitives stay free; this is convenience/turnkey.
**Depends on:** tier read (done). **Done when:** a Pro box can one-switch a login
gateway in front of an app; non-Pro sees the upsell; lapse degrades gracefully.

---

## #21 — Gate browser-in-harness as a Pro/paid capability

**Goal.** The pod-resident Chromium ("browser in the harness", one per pod, phone-
piped creds) is a premium capability — gate spinning it up behind Pro/paid.

**Approach.** Soft, box-side gate (same shape as #20): the daemon checks tier
before launching/keeping the harness browser; non-Pro gets the upsell. **Must fail
safe** — gating *new* browser sessions is fine; never destroy existing data or a
running session a user depends on mid-cycle. Consider a generous free trial / one
free browser so the feature is discoverable.

**Where:** `packages/server-daemon` (the browser bundle/runner) + a tier check via
`.com`. **Constraints.** Don't gate anything security-relevant; this is a compute-
heavy convenience. **Depends on:** tier read (done). **Done when:** browser-in-
harness launch is Pro-gated with a clean upsell and graceful non-Pro behaviour.

---

## #22 — Lock the monetization numbers

**Goal.** One authoritative table every surface reads from, so copy never drifts.

**Numbers to lock** (current values in `docs/monetization-free-tier-first.md`):
free **50 GB/mo** hard cap; Pro (`hobby`) **250 GB**; Pro Max (`maker`) **1 TB**;
overage **$0.05/GB** (paid only); Pro **price/mo** (confirm); app marketplace
**cut %** (e.g. 10%); customization **token bundle** size + value ratio (#17);
the `MAX_APP_PRICE_CENTS` cap (currently $1000).

**Approach.** These already live as constants
(`MONTHLY_EGRESS_QUOTA_BYTES`, `OVERAGE_USD_PER_GB`, `MAX_APP_PRICE_CENTS`). The
task is: (a) decide the still-open ones (Pro price, cut %, token ratio), (b) make
sure `pro.html`, the webapp allowance/banner copy, the mobile spec, and the design
doc all cite the SAME values, and (c) add a test asserting the quota constants
match the documented table so a change can't silently desync. **Done when:** the
numbers are decided, single-sourced, and a test pins them.

---

## Sequencing reminder

The two hard rules (already encoded as task blockers): **#8/#9 before #5** (don't
cap free users before an upgrade path exists — now satisfied), and **#13 before
#14** (don't sell unvetted apps — satisfied). For the rest: #15 before public dev
signup; #18 before #16 is meaningful (need apps to funnel into); #17 after #15
(needs per-listing bundled-tokens); #20/#21 are independent box-side gates.
