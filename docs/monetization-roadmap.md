# Monetization roadmap — the `feat/marketplace` push

This branch is the home of the **monetization push**. The canonical *design*
lives on `main` in `monetization-free-tier-first.md` (a workspace artifact);
this file is the build plan — the task breakdown we work through here.

**Companion docs (this branch):**
- `mobile-monetization-spec.md` — the **Mac-only mobile work** written up
  implementation-ready (couldn't compile Swift/Kotlin on the Linux dev box):
  #23 (the #6/#7 allowance dashboard + over-cap alert) and #19's mobile half.
- `monetization-remaining-tasks.md` — actionable design notes for every
  remaining non-mobile task (#5, #12, #15–#22).

## Topology (decided 2026-06-14)

- **`main`** holds the **cost-recovery floor** — the public-egress metering
  plumbing (`packages/control-plane/src/metering.ts`, the relay `UsageMeter`,
  `apps/com` `/api/usage/*`), the `0051_usage_counters` migration (applied to
  prod), and the canonical design doc. It's dormant until deployed and stays on
  `main` as shipped infrastructure (forward-only; we do NOT scrub it).
- **`feat/marketplace`** (this branch) holds the **product push** — Pro billing,
  the marketplace, paid apps, the funnel, dashboards, and the `/pro` page — built
  on top of the metering foundation merged in from `main`.

## The model (one paragraph)

The free cloud is the **razor**; the marketplace is the **blades**. Most users
never pay and never see a paywall ("you may never know we take money"). Money
comes from three orthogonal streams: **bandwidth** (cost recovery, hard gate at
the relay), **Pro membership** (value capture, flat + soft feature gates), and
the **marketplace cut** (ecosystem, hard gate at distribution). Nothing gates
basic function or security; we sell a *better* version. "Start from an
app already adapted to Flagship" makes the paid path the low-friction path.

## Phases & tasks (tracked in the task system; branch = feat/marketplace)

### Phase 0 — finish the floor (metering is built; make it usable + safe to turn on)
- **#8** Admin tier-grant tool (manual cash/Monero → set tier+expiry) — the entitlement-WRITE path.
- **#9** Voucher system (prepaid Pro, no identity; web-only redemption).
- **#5** Activate metering: reconcile Fly secret + deploy Worker & Fly — **blocked by #8, #9** (don't flip the hard cap on before an upgrade path exists).
- **#6** Usage/allowance dashboard (webapp + mobile).
- **#7** "Approaching/over allowance" alert → `/pro` (App-Review-safe on mobile).
- **#12** Owner: fill `/pro` mailing + XMR addresses, deploy.

### Phase 1 — Pro membership (capture the 95% who never trip the meter)
- **#10** Reframe the donation banner → always-available "become a Pro member".
- **#11** Stripe web checkout + webhook → set tier (convenient/less-private lane; later).
- **#22** Lock the numbers (free cap, Pro price/quota, overage, app cut %, token bundle).

### Phase 2 — the golden goose (marketplace)
- **#13** Marketplace security scanner (`scan_grade`) — **prerequisite** (a scanner skeleton already lives in `services/marketplace-scanner`).
- **#14** Paid-app purchase + gated distribution — **blocked by #13**; enforce at purchase (no runtime DRM), web-sold (no Apple tax).
- **#15** Developer onboarding, payouts, generous cut (e.g. 90/10).
- **#16** "Create app" marketplace-first funnel (marketplace default on-ramp; keep vibe-coding prominent).
- **#17** Bundle capped, sale-funded customization tokens with purchases (BYOK upsell after).
- **#18** Seed first-party Flagship-adapted apps (solve the cold-start).
- **#19** Mobile marketplace: install-what-you-own (no in-app buy; App-Review-safe).

### Phase 3 — Pro power features (soft, box-side gates)
- **#20** Turnkey login/SSO gateway (keep "make app private" free + private-by-default).
- **#21** Gate browser-in-harness as a Pro/paid capability.

## Two sequencing rules (encoded as task blockers)
1. **Admin-grant + voucher before activating the cap** (#8/#9 → #5) — never strand free users at 50 GB with no way up.
2. **Scanner before selling apps** (#13 → #14) — don't sell what we haven't vetted; taking money makes us liable.

## Build progress (updated 2026-06-15)

**Landed on `feat/marketplace` (committed, tested, NOT pushed/deployed):**
- **#8 tier-grant** — `grantTier` is the single entitlement writer (extend-on-
  re-pay; absolute-period-end + Stripe-id passthrough added for #11).
- **#9 vouchers** — bearer prepaid-Pro codes (100-bit, SHA-256-stored, atomic
  single-use); admin issue + public redeem; redeem form on `/pro`. (mig 0052)
- **#10 Pro banner** — webapp "become a Pro member" home banner.
- **#11 Stripe** — sig-verified webhook (sub + cancel) → tier, idempotent
  (mig 0053 + event store); `createCheckoutSession`; `/pro` card-checkout form.
  Fully env-gated (ships dark until `STRIPE_*` set).
- **allowance read** — `GET /api/users/:u/allowance` (public metadata, rate-
  limited) — the data source the dashboards/alerts consume.
- **#6/#7 webapp** — usage/allowance card + over-cap upgrade alert → `/pro`.
- **#13 scanner** — Trivy seam + pipeline in `services/marketplace-scanner`.
- **#14 paid apps** — price on listings + `app_purchases` (mig 0054); gated
  install (402 + price when unowned); Stripe app-checkout (mode=payment) +
  webhook → `grantAppPurchase` (single writer); `GET /api/users/:u/purchases`
  (install-what-you-own, feeds #19); admin set-price + comp-grant.

**Deploy set for the above (owner):** apply migrations **0052, 0053, 0054** to
prod D1; the new routes ride the normal Worker deploy (`npx tsc -b && wrangler
deploy`); set `STRIPE_*` secrets/vars to light up the card lane (#12). Metering
itself still gated behind #5 (don't flip the free hard cap until the upgrade
path is deployed — which it now is in code).

**Remaining:** #5 (owner deploy), #6/#7 **mobile mirror** (iOS/Android — Mac-
build only, not done here), #12 (owner), #15 dev payouts/cut, #16 create-app
funnel, #17 customization tokens, #18 seed apps, #19 mobile install-what-you-own
(backend ready), #20 SSO gateway, #21 gate browser-in-harness, #22 lock numbers.

**Test-env note:** the new D1 store tests (`stripeEventStore`, `appPurchaseStore`)
+ the existing `parity` test need **node ≥ 22** (`node:sqlite`); they're skipped
on a node-20 box. The unseal-crosscheck tests need Go on PATH. All pass in CI.
