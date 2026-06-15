# Monetization — free-tier-first

Flagship is OSS + self-host first. **The default user pays $0 forever.**
The platform's value is captured by the user, on the user's own hardware,
under the user's own keys. Anything we charge for sits at the edges, on
power-user surfaces that the OSS code lets a determined user route around
by self-hosting harder.

This document is the canonical design statement. If a future RFC, slash
command, or feature pitch reads like "let's gate X behind a paywall," the
first question to ask is: **does the OSS escape hatch still hold?** If
yes, the feature stays free.

## What's free, forever

Every piece of the core user loop is free, and not as a trial:

- **Vibe-coding** — describe an app, the LLM emits manifest+Dockerfile+source,
  the daemon builds and installs it. (LLM costs are paid by the user's own
  key after the bootstrap; see below.)
- **App install + run** — any number of apps, on the user's hardware.
- **BYOK LLM access** — the user's API key (Anthropic, OpenAI, Google) is
  sealed under SWK and the daemon talks directly to the provider; flagship
  is never in the credential path.
- **Default subdomain** — every user gets `<server>.<user>.flagship.services`
  with a real Let's Encrypt cert. Forever-free, no DNS to configure.
- **Ordinary dispatcher relay** — inbound TLS-passthrough from the tunnel
  hub to the user's box. A monthly free quota covers normal personal use
  indefinitely; bandwidth-heavy hosting is the only case that hits the
  quota.
- **Normal account names** — first-come-first-served, free, forever.
- **Peer-backup with friends** — opt-in reciprocal Reed-Solomon backup
  amongst people who already trust each other. No payment surface; no
  central matchmaker fee.
- **All admin / app-management surfaces on the user's own hardware** —
  paired-session-gated; the phone is the trust root.

## What we charge for (only four things)

Each of the four power-user surfaces is something the OSS user can
substitute for — but doing so requires extra setup that most users
won't bother with. We capture the convenience premium, not a monopoly.

### 1. LLM-promo bootstrap credits

A small, capped pool of LLM credits a brand-new user can spend through
Flagship-issued provider keys, *before* setting up BYOK. This makes the
first-vibe-code experience friction-free.

- **Why a user pays:** they want to try Flagship before deciding whether
  to bring their own LLM key.
- **Free-tier behavior:** daily + lifetime caps on credits. The promo
  surfaces a "switch to BYOK" prompt at every session boundary; one tap
  takes you to the BYOK setup flow.
- **What it is NOT:** a product line. Flagship does not sell LLM tokens
  as a margin-bearing service. The promo is a bootstrap; pricing
  approximates cost-pass-through.
- **OSS escape hatch:** users self-provision an Anthropic / OpenAI /
  Google key the moment they're comfortable; the promo is then unused.

### 2. Dispatcher relay overage

The tunnel hub at `flagship.services` routes inbound TLS traffic to the
user's box. For most personal-cloud workloads (a photo album, a habit
tracker, a chat for 10 friends), the free monthly quota is plenty. Apps
that act as public-facing services with material bandwidth — a podcast
RSS feed with 5k subscribers, a real social-media presence — pay
per-GB above the quota.

- **Why a user pays:** their app's bandwidth genuinely exceeds personal-
  use levels. We're a CDN edge for them at that point.
- **Free-tier behavior:** the quota is generous enough that 95%+ of
  users never approach it; usage stats live in the tier dashboard so
  surprise overages are impossible.
- **OSS escape hatch:** run your own VPS as the dispatcher. The protocol
  is open; the only gating is whose hub the user's daemon connects to.

#### Locked pricing + the cost basis (2026-06-14)

The only cost that scales with usage is **public-ingress egress through the
`.services` relay** — all visitor traffic transits the Fly app (`iad`, SNI
passthrough), and Fly bills outbound at **$0.02/GB** (NA/EU; our single
region). Everything else (box compute, storage, apps) runs on the user's
hardware and costs us $0. Fixed baseline is ~$20/mo (2 Fly machines +
Workers Paid $5 + R2/D1 ~$1 + domains), so break-even is ~4 paid subs; the
real control is bounding free egress (one viral free box at 1 TB/mo = ~$20).

| Tier | Monthly public-egress quota | Our worst-case cost | Price |
| --- | --- | --- | --- |
| **Free** | **50 GB** (hard cap → relay stops admitting new public traffic) | ~$1/mo (avg free user ≈ cents) | $0 |
| **Pro** (paid tier) | **250 GB** + overage | $5/mo at the included max | **$5/mo** or anonymous voucher |
| Overage (paid only) | beyond the included quota | — | **$0.05/GB** (~2.5× our cost) |

The free cap is the one dial that matters: max exposure per free user =
`cap × $0.02`. 50 GB → $1; 100 GB → $2. Tune to taste; never remove it.
**Do NOT gate server/box count or device profiles** — meter the bandwidth,
not the count (a 3-low-traffic-box user costs nothing; a 1-viral-box user
costs a lot). See `0051_usage_counters.sql` + `packages/control-plane/
src/metering.ts` (built on `feat/metering`).

### 3. Custom domains

`example.com` instead of `<pod>.<user>.flagship.services`. The default
subdomain stays free forever; vanity domains are the upgrade.

- **Why a user pays:** brand, migration off the default subdomain,
  preference for personal-domain identity.
- **Free-tier behavior:** the default subdomain is forever-free and
  never deprecated. A custom domain is purely additive.
- **OSS escape hatch:** point a CNAME at the dispatcher manually and
  run your own ACME flow. The custom-domain fee buys turnkey
  provisioning + SAN management, not the right to use a domain.

### 4. Reserved / trademark account names

Hold a name a brand owns even when the brand isn't actively running
anything on Flagship — analogous to GitHub's name reservation. Normal
usernames are first-come-first-served and free forever; brands pay to
hold a name they aren't using.

- **Why a user pays:** they have a trademark to defend or a brand to
  reserve.
- **Free-tier behavior:** ordinary users get FCFS names with no holding
  fee. The reservation flow is opt-in.
- **OSS escape hatch:** at some level, name allocation has to be
  centralized; this is the one fee that doesn't have a clean self-host
  bypass. It exists primarily to deter trademark squatting, not as a
  revenue lever.

## What we don't charge for

To make the principle concrete, here are things we explicitly will NOT
gate behind payment, even if a future contributor finds them tempting:

- **Number of apps installed** — install as many as you want.
- **Number of paired devices / sessions** — phone, two laptops, an
  iPad: free.
- **Number of users invited to an app** — share with as many friends
  as you want.
- **Storage size** — limited only by the user's hardware.
- **Backup destinations** — peer-backup with anyone who'll reciprocate.
- **App migration / export** — full app backup ships in N11; no fee.
- **Recovery flows** — cloud-shard via iCloud Keychain / Google Block
  Store is part of the free identity layer.
- **Source-code visibility** — the LLM's output is in the user's
  Forgejo, browseable via the existing daemon API, free.

## Decision recipe

When a feature proposal includes a payment surface, walk through:

1. **Is this on the core user loop?** (vibe → install → run → share →
   recover) If yes, it stays free. Full stop.
2. **Does the OSS escape hatch hold?** If a determined self-hoster can
   replicate the feature without paying us, the fee is for convenience,
   not access. That's acceptable.
3. **Does it match one of the four surfaces above?** If yes, route it
   through that surface's pricing primitive. If no, default to free.
4. **Would charging here erode the trust pitch?** Flagship's whole
   credibility rests on "your data, your hardware, your keys." If the
   fee makes us look like we've captured the platform, kill it.

## Out of scope this cycle

- Stripe checkout / portal / webhook (`build-tasks.md` A.6.1–A.6.3) is
  deferred. None of it gates v1 alpha.
- Custom-domain CNAME provisioning is deferred (P5.2 in the cycle plan).
- Reserved / trademark reservation flow is deferred (P5.3).
- **Metering INFRASTRUCTURE** (usage accounting + quota model + the
  relay-report endpoint) is being built on the **`feat/metering`** branch —
  the DB migration + this doc stay on `main` (workspace artifacts), the
  application code stays on the branch until launch. No payment SURFACE
  (Stripe checkout, in-app paywall, voucher UI) ships until the core loop is
  proven without one. **Voucher redemption is web-only** (a `.com` page):
  an in-app "enter voucher" screen reads to App Review as circumventing IAP,
  so the apps only ever *reflect* the `plus` entitlement, never sell it.

The core user loop must work end-to-end *without any payment surface
existing* before we plumb any of those four. That's the gate for
unlocking P5.

## Companion memory

`feedback_monetization_principle.md` is the durable in-context reminder
of this stance for future sessions. If memory and this doc ever
disagree, this doc is canonical and memory should be updated.
