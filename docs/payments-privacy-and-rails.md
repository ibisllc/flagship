# Payments: rails, privacy and the recommended mix

Status: **design, for owner review** (2026-11-13). Release 0.4, item F2
"Subscriptions". No code yet beyond what the feature branches already hold
(section 2).

The owner's decision (2026-11-13): "Everything launches now. We need to weigh
the privacy and convenience of mixing Apple/google/stripe and
vouchers/crypto." "Everything" is the marketplace, Pro and Pro Max, custom
domains, custom names (dibs and paid name change) and the outbound proxy.

This doc weighs each way to pay, says what every party learns, checks the
store rules, and recommends one mix. It builds on `docs/anonymous-vouchers.md`
(the $1 blind-signed voucher, owner decisions of 2026-10-13) and
`billing/docs/spec/vouchers-v1-draft.md`, and replaces their open points where
it says so.

Read with: `docs/monetization-free-tier-first.md` (what we charge for),
`docs/naming-recovery-and-name-change.md` §6, §7 and §16 (name change and
dibs), `docs/metering.md` (the egress meter), `docs/outbound-proxy.md` (Pro
gate, OHTTP), `docs/service-access-gating.md` "Separate lists per server
(Pro)" (plan attestation).

## 1. The recommendation in short

1. **One currency.** Everything is priced in $1 blind-signed vouchers. An
   account never holds a payment, a card, a receipt or a store id. It holds
   only a plan and a paid-until date, which `.com` needs to meter the relay.
2. **Every rail is a voucher shop.** Apple in-app purchase, Google Play
   Billing, Stripe on the web and crypto (Monero first, Bitcoin over
   Lightning next) all sell the same vouchers. At redemption they look the
   same, so all buyers hide in one crowd.
3. **Subscriptions are a voucher drip.** A store or Stripe subscription
   mints a month of vouchers per paid period to whoever holds a random claim
   secret (the server). The payer's subscription and the account's plan are
   never joined in our data.
4. **The server pays its own bill.** The account's lead server holds the
   stash, spends 10 (Pro) or 20 (Pro Max) a month, and buys overage, a name
   change or an app from it. Issuing and redeeming go through the OHTTP relay
   the outbound-proxy branch already uses, so `.com` sees no IP at either end.
5. **The plan reaches the box as today:** the CA-signed
   `flagship/plan-attestation/v1`, whose only writer becomes voucher
   redemption. The username-linked Stripe path, the email-matched Monero
   flow and cash by mail on `feat/marketplace` go away.

## 2. What the branches hold today

`feat/marketplace` (tip `3908d2bb0`, 317 files over `main`), and its children
`feat/custom-names`, `feat/custom-domains`, `feat/outbound-proxy`.

| Piece | Where | Keep, change or drop |
| --- | --- | --- |
| `grantTier`, the single tier writer; `TierStorage` with `currentPeriodEnd` | `control-plane/src/tierGrant.ts` | Keep as the writer. Drop the `stripeCustomerId` / `stripeSubscriptionId` fields it stores on the account. |
| `effectiveTierOf` (a lapsed period reads free) | `control-plane/src/metering.ts` | Keep. Metering, custom domains and the proxy gate all read it. |
| Plan attestation: canonical bytes, vectors, `GET /api/users/<u>/plan-attestation` (read token), the box's `accessScope.ts` | `protocol/src/planAttestation.ts`, `control-plane/src/planAttestation.ts`, `server-daemon/src/accessScope.ts` | Keep unchanged. It already says only "account X is plan T until D". |
| Custom domain Pro gate (Free 0, Pro 1, Pro Max unlimited) | `control-plane/src/customDomainEntitlement.ts`, `customDomain.ts`, `customDomainVerifier.ts` | Keep. |
| Outbound proxy Pro gate (daemon-status `tier`, `403 pro-required`) and the OHTTP gateway in `.com` | `feat/outbound-proxy`, `control-plane/src/ohttpGateway.ts` | Keep. Reuse the OHTTP gateway and relay for voucher issue and redeem (section 5.4). |
| Stripe Checkout + webhook, subscriptions and paid apps | `control-plane/src/stripe.ts` | **Rework.** It stamps the username into the session and subscription metadata, so Stripe and our D1 both hold "this card pays for account X". Becomes a voucher shop (section 5.2). |
| Code vouchers (`FLAG-XXXXX-...`, SHA-256 of the code, kinds `tier`, `name-change`, `dibs-claim`, migrations 0052, 0093) | `control-plane/src/voucher.ts` | **Replace** with blind-signed $1 vouchers. Codes are issued by an admin after a payment, so the issuer can link payment, code and redeeming account. |
| Paid name change, consumes a voucher atomically, puts it back on failure | `feat/custom-names` `control-plane/src/nameChange.ts`, migration 0094 | Keep the checks. Change the payment input from a code to 10 (or 20 for dibs) blind vouchers. |
| Marketplace listings, prices (`flagship/set-app-price`), `grantAppPurchase`, install check by username, `app_sales` ledger with `buyer_account`, developer console | `control-plane/src/marketplace.ts`, `appPurchase.ts`, `developer.ts`, migrations 0090, 0091 | **Change.** Drop `buyer_account` from the ledger; licences unbound from the account (section 5.6). |
| `/pro` page: hand-operated, "send cash or Monero and email us your username", Stripe form asks for the username, code redeem form | `apps/web/public/pro.html` | **Rewrite.** Every flow on it links a payer to an account. |
| Allowance read, `TierStatusScreen` on iOS and Android, webapp `proBanner.js` | branch + `docs/mobile-monetization-spec.md` | Keep the read side. The mobile spec's rule "no purchase UI in the iOS app" is replaced by section 6. |
| Voucher core library | `billing/docs/spec/vouchers-v1-draft.md` | Draft only. Build it as `@ibisllc/billing-vouchers`. |

Two older docs disagree: `anonymous-vouchers.md` sells voucher packs by IAP;
`mobile-monetization-spec.md` and `monetization-free-tier-first.md` say the
apps never sell or redeem anything. This doc settles it in section 4.4.

## 3. The rails

Fees and terms below are from memory and public pages as of 2026-11-13.
Every figure marked "(check)" must be confirmed against the provider's
current price list before launch.

### 3.1 Apple in-app purchase and subscriptions

- **How.** StoreKit 2. Consumable products (voucher packs) and
  auto-renewable subscriptions (Pro, Pro Max). We verify the signed
  transaction (JWS) and follow renewals with App Store Server Notifications
  V2 and the App Store Server API.
- **Apple learns and keeps:** the Apple ID, its payment method, its country
  and billing details, that this Apple ID bought from Flagship, which
  product, when, every renewal and cancellation. Apple does not learn the
  Flagship account unless we tell it. We never set `appAccountToken`.
- **We learn:** a transaction id and an original transaction id (stable for
  the life of a subscription), the product, price, currency, the storefront
  country, renewal and refund events. No name, no email, no card.
- **Fees:** 30% standard; 15% under the Small Business Program (under $1M a
  year) and on subscriptions after the first year (check).
- **Refunds:** Apple decides, not us. We can answer consumption requests but
  cannot stop a refund. A refunded pack's vouchers cannot be clawed back.
- **Tax:** Apple is the merchant of record. It collects and remits VAT and
  US sales tax. Nothing for us to file per buyer.
- **Fraud:** Apple carries card fraud. Our exposure is refund abuse
  (buy, spend, ask for a refund).
- **Convenience:** the best on iPhone. Face ID, no card typed, manage or
  cancel in Settings.

### 3.2 Google Play Billing

- **How.** Play Billing Library. One-time consumable products and
  subscriptions. We verify with the Play Developer API
  (`purchases.products`, `purchases.subscriptionsv2`) and follow renewals by
  Real-time Developer Notifications (Pub/Sub). Purchases must be
  acknowledged within 3 days or Google refunds them.
- **Google learns and keeps:** the Google account, payment method, country,
  every purchase and renewal. We never set `obfuscatedAccountId` or
  `obfuscatedProfileId`.
- **We learn:** an order id, a purchase token (stable for a subscription),
  the product, price, region code, renewal and refund events.
- **Fees:** 15% on the first $1M a year and on subscriptions. Google
  announced lower rates in some regions for 2026; reports conflict (check).
- **Refunds, tax, fraud, convenience:** as Apple. Google is the merchant of
  record.

### 3.3 Stripe (cards, Apple Pay and Google Pay on the web)

- **How.** Stripe Checkout on `flagshipserver.com`, one-time payments for
  packs, Stripe Billing for subscriptions.
- **Stripe learns and keeps:** the card number, name on the card, card
  country, often the billing postcode, an email (Checkout collects one;
  whether it can be left out needs checking), IP address and device signals
  (Radar). With Apple Pay or Google Pay, a device token instead of the card
  number, but still a name and the issuing bank. The card network and the
  bank keep "this person paid Flagship".
- **We learn:** whatever Stripe passes to us: email, card country, last four
  digits, amounts. We can choose to keep almost none of it.
- **Fees:** about 2.9% + $0.30 for US cards, plus about 1.5% for
  international cards and 1% for currency conversion; Stripe Tax about 0.5%
  per transaction; $15 per dispute (check). The fixed $0.30 makes $1 or $10
  purchases expensive; packs of 30 or more are the sensible web products.
- **Refunds and chargebacks:** a buyer can dispute a charge for months. We
  lose the money and the dispute fee, and the vouchers are already spent.
- **Tax:** **we are the merchant of record.** We owe VAT to EU and UK
  consumers from the first sale (a non-EU seller has no threshold; EU
  non-Union OSS registration), and US sales tax where we pass a state's
  threshold. Stripe Tax computes it; we register and file. A
  merchant-of-record reseller (Paddle; Stripe's own managed offering) would
  take this over but sees the buyer's email and country and may refuse
  bearer vouchers (check).
- **Fraud:** **bearer vouchers bought with stolen cards are a classic
  carding target** (buy, resell, the real cardholder disputes). Needs Radar,
  3-D Secure, per-card limits and a cap per purchase.
- **Policy risk:** Stripe restricts some prepaid and stored-value
  businesses. Whether selling closed-loop prepaid vouchers is allowed must
  be confirmed with Stripe before we build on it (check).
- **Convenience:** good on the web and desktop; Apple Pay and Google Pay in
  the browser make it one tap.

### 3.4 Anonymous vouchers (not a rail, the currency)

- **How.** RFC 9474 RSA blind signatures, as in `anonymous-vouchers.md`. The
  buyer's device makes random tokens, blinds them, we sign blind after a
  rail confirms payment, the device unblinds. Redemption records each
  token's hash (a nullifier) once.
- **We learn at issue:** "a payment on rail R for N vouchers". At
  redemption: "N valid vouchers were spent for account X on plan T". We
  cannot join the two, by mathematics, not by policy.
- **What can still link them:** network address (fixed by OHTTP, section
  5.4), timing (a buy at 10:02 and a redemption at 10:03), and odd amounts.
  Early on, with few buyers, timing alone may single someone out. Volume
  fixes it; until then we say so plainly.
- **Fees:** none of their own. Key management and a nullifier table.
- **Refunds:** none possible once issued. A store refund costs us the
  vouchers.
- **Tax:** see section 7. Vouchers move the tax point in some regimes.
- **Fraud:** double spend is stopped by the nullifier insert. Theft is like
  cash: whoever holds the file can spend it, so stashes live encrypted on
  the box and in the phone keystore.

### 3.5 Crypto

**Monero (XMR), self-hosted.** Already specified in
`anonymous-vouchers.md`: a self-serve page, a fresh subaddress per order, a
view-only wallet on its own small Fly machine, sign after about 10
confirmations.
- **Learned:** nobody learns the payer's identity. We see an amount arrive at
  a subaddress. The chain hides sender, receiver and amount.
- **Fees:** network fee only (cents), plus the Fly machine.
- **Refunds and chargebacks:** none. No return address. Whole vouchers only.
- **Tax:** no buyer country. Accountant question (section 7).
- **Fraud:** none on payment. Price moves inside the one-hour quote.
- **Risk:** exchanges keep delisting Monero, and the EU anti-money-laundering
  rules from 2027 bar EU crypto providers from handling privacy coins
  (check). Converting XMR to dollars may get harder over time.
- **Convenience:** poor for most people, essential for the few who need it.

**Bitcoin, over Lightning, through self-hosted BTCPay Server.**
- **Learned:** on-chain Bitcoin is a public ledger: anyone, including us,
  can trace coins back towards the exchange that sold them, which knows the
  buyer. Lightning hides much more (the payer is not on chain), but our
  node and channel partners are visible.
- **Fees:** BTCPay self-hosted takes nothing; we pay hosting and channel
  costs. Hosted processors (Coinbase Commerce, OpenNode, BitPay) charge
  about 1% (check), require company KYC and often collect the buyer's email.
- **Refunds, chargebacks, tax:** as Monero.
- **Convenience:** better than Monero for people who already hold Bitcoin.
  Running a Lightning node is real operations work. BTCPay also has a
  Monero plugin, so one BTCPay instance could serve both.

### 3.6 Comparison

| | Apple IAP | Google Play | Stripe | Monero | Lightning (BTCPay) |
| --- | --- | --- | --- | --- | --- |
| Who knows the payer | Apple | Google | Stripe, card network, bank | nobody | exchange that sold the coins, partly |
| What we learn | txn id, country | order id, region | email, card country, last 4 | an amount | an amount |
| Links payer to account in our data (with vouchers) | no | no | no | no | no |
| Our cut of $10 | $8.50 (small business) | $8.50 | about $9.40 on a $10 charge, better on packs | about $10 | about $10 |
| Refund / chargeback risk | refunds, Apple decides | refunds, Google decides | disputes for months | none | none |
| Merchant of record | Apple | Google | us | us | us |
| Fraud exposure for bearer vouchers | low | low | high | none | none |
| Convenience | best on iPhone | best on Android | good on web | poor | fair |

## 4. Store rules

### 4.1 Apple (read from the live guidelines page, 2026-11-13)

What the current App Review Guidelines say, in substance (check the exact
wording again at submission):

- **3.1.1:** unlocking features or functionality inside the app, including
  subscriptions, must use in-app purchase. Apps may not use their own
  unlock mechanisms "such as license keys, augmented reality markers, QR
  codes, cryptocurrencies and cryptocurrency wallets". **Digital gift cards,
  certificates, vouchers and coupons redeemable for digital goods or
  services may only be sold in the app through in-app purchase.**
- **3.1.1(a):** apps may apply for an entitlement to link to another
  purchase method. **On the United States storefront no entitlement is
  needed** for buttons, external links or other calls to action. In every
  other storefront, apps may not include buttons, links or calls to action
  to other purchase methods (except under the entitlements).
- **3.1.3(a) Reader apps:** only magazines, newspapers, books, audio, music
  and video. **Flagship is not a reader app**; this route is closed.
- **3.1.3(b) Multiplatform services:** an app may let users use content,
  subscriptions or features acquired on other platforms or the web,
  "including consumable items in multi-platform games", **provided those
  items are also available as in-app purchases within the app.**
- **3.1.3(e):** goods and services consumed outside the app must use other
  payment methods. Relay bandwidth and a box's features are digital services;
  we should not argue they fall under 3.1.3(e).
- **3.1.3(f) Free stand-alone apps:** a free companion to a paid web-based
  tool for VoIP, cloud storage, email or **web hosting** need not use in-app
  purchase, **provided there is no purchasing inside the app and no calls to
  action for purchase outside it.**

The US position comes from Epic v. Apple. The April 2025 injunction removed
Apple's commission and limits on US link-outs. The Ninth Circuit (December
2025) upheld the contempt finding but sent the commission question back to
the district court, saying Apple may charge a commission tied to its real
costs. Stays were refused in 2026. **Whether Apple now charges anything on US
link-out purchases, and what, is unsettled; check the current guidelines and
Apple's developer news before launch.** The EU (Digital Markets Act
alternative terms), Japan (smartphone act, in force from December 2025) and
South Korea have their own link-out or alternative-payment schemes with
their own fees; none is worth doing for launch.

### 4.2 Google

Google Play's Payments policy requires Play Billing for digital goods and
services bought inside the app. After Epic v. Google, Google runs a US
"external content links" programme and US alternative billing, with
enrolment, reporting and service fees whose current level is reported
inconsistently (fees of 10% to 20% on Google's help pages, some reports that
fees are not assessed yet, a reporting deadline of 1 December 2026). EEA and
some other regions have user choice billing. **All of this must be checked
on Google's Play Console help pages before launch.** Whether Google treats
redeeming outside-bought vouchers in the app like Apple does is also to
check.

### 4.3 What this means for vouchers

- Selling vouchers in the iOS or Android app: allowed only through IAP or
  Play Billing. Fine: they are consumable products.
- Typing a code, scanning a QR code or importing a stash file in the iOS app
  to unlock something: this is the 3.1.1 "own mechanism" Apple names. **Do
  not.** Outside-bought vouchers reach the box through the web or Studio,
  never through the iOS app (as `anonymous-vouchers.md` already said).
- Showing and spending a balance the box already holds, from the app: 3.1.3(b)
  allows using consumables acquired elsewhere if the same items are sold as
  IAP in the app. Since our vouchers are sold as IAP, spending the box's
  balance from the app looks allowed. **Not certain; check with App Review
  (or ask in the review notes) before relying on it.** If Apple disagrees,
  the fallback is that the iOS app spends only vouchers it bought itself,
  and other spends happen on the web.
- Linking to the web shop: US storefront yes, with no scare screen; elsewhere
  no button, no link, no mention.
- A store subscription that delivers vouchers each month (like a monthly
  currency pass in games) is a normal pattern. Check that Apple and Google
  accept a subscription whose benefit is consumable credit.

### 4.4 Two ways to ship the phone apps

- **Option A, sell in the app (recommended).** IAP packs and subscriptions
  on iOS and Android; US users also see "Buy on the web". Most convenient,
  and 3.1.3(b) then covers spending a balance bought elsewhere. Costs 15% on
  store sales and an App Review round per product.
- **Option B, free companion.** Under 3.1.3(f) (web hosting companion) the
  app sells nothing and says nothing about buying, outside the US. Users buy
  on the web or in Studio. No store fee, but outside the US the app cannot
  even say where to buy, and Apple may not see Flagship as a "web hosting
  companion". This is the fallback if Option A is refused.

## 5. The recommended mix

### 5.1 One currency, and what an account holds

- The $1 voucher is the only thing anyone pays with: Pro 10 a month, Pro Max
  20, a name change 10, a dibs claim 20, overage blocks, marketplace apps at
  their price.
- `.com` keeps per account: plan, paid-until, nothing else about money. That
  is what metering and the Pro gates already read.
- `.com` keeps per voucher key: the spent-token nullifiers. Per rail order:
  an order hash and how many vouchers were signed for it (for retries and
  store refund notices), never an account.
- No IP addresses on the issue or redeem paths, and both run behind OHTTP so
  `.com` does not see them in the first place (5.4).

### 5.2 Every rail is a voucher shop

| Rail | Products | Who makes the blinded tokens | Proof of payment the issuer checks |
| --- | --- | --- | --- |
| Apple | consumable packs 10, 30, 120; Pro and Pro Max monthly and yearly subscriptions | the iOS app | signed transaction (JWS), App Store Server API |
| Google | the same | the Android app | purchase token, Play Developer API |
| Stripe | packs 30, 120 (one-off); Pro and Pro Max subscriptions | the browser on the buy page | Checkout session paid (webhook), no username anywhere |
| Monero | any whole number | the browser | view wallet sees the amount at the order's subaddress |
| Lightning | any whole number | the browser | BTCPay invoice settled |

Issuing is idempotent per order: the issuer keeps `hash(order id)` with the
count signed and the blinded messages' hash, so a retry with the same tokens
gets the same signatures and a different set is refused. Store transactions
are finished (Apple) or consumed and acknowledged (Google) only after the
device holds the unblinded vouchers.

### 5.3 Subscriptions without linking the payer to the account

The voucher doc chose packs over subscriptions because a store subscription
is one long-lived record per payer. That record stays with Apple, Google or
Stripe either way. What matters is that we never join it to an account. The
drip does that:

1. **Start.** The buyer subscribes in the app (or on the Stripe page). The
   device sends the proof of payment to the issuer over OHTTP. The issuer
   returns a random **claim secret** and keeps only
   `hash(claim secret) -> subscription id (Apple original transaction id,
   Google purchase token, Stripe subscription id), product, last period
   claimed`.
2. **Hand-over.** The phone gives the claim secret to the account's lead
   server over the paired session (box TLS; `.com` cannot read it). The
   phone keeps a sealed copy.
3. **Each period.** The server claims: claim secret plus 10 or 20 blinded
   tokens, over OHTTP. The issuer checks with the rail that the period is
   paid and not yet claimed, records the period, and signs. A store refund
   or cancellation stops later claims; it cannot reach vouchers already
   issued.
4. **Spending** happens separately (5.4), on the server's own schedule.

What each party learns: the rail knows the payer and that they subscribe to
Flagship. We know "subscription S claimed period P", and separately "account
X paid for period Q". Joining them takes timing, which the server blurs: it
claims when the period opens and spends at a random time in the last week
before its paid-until date, so the two events are days apart and mixed with
every other account's.

Whoever holds the claim secret gets the vouchers, so a subscriber can pay for
someone else's server by handing over the secret. That is a feature.

Packs stay for people who prefer one purchase a year, and are the only
choice on Monero and Lightning (no auto-renewal on crypto).

### 5.4 Redemption: the server pays, through OHTTP

- **Who pays.** The account's lead server (server order) holds the stash and
  spends it. Other servers keep a copy in their backups but do not spend
  while the leader is up. The phone keeps a sealed copy too, so a lost box
  does not lose the money; a spent token simply fails a second time.
- **What a redemption is.** `spend N vouchers for account X, plan T,
  period Q`. It needs **no account credential**: anyone may pay anyone's
  bill, so no device key, read token or server key is shown at redemption.
  `.com` extends paid-until by one month per 10 or 20 vouchers, and refuses
  without consuming when the account is already paid more than 35 days ahead
  (two boxes cannot both pay).
- **Network privacy.** Issue and redeem requests are encapsulated with OHTTP
  (RFC 9458) to `.com`'s gateway through the third-party relay that
  `feat/outbound-proxy` chose (Oblivious Network planned). The relay sees an
  IP and an opaque blob; `.com` sees the request and the relay's address.
  Without this, a phone buying on home Wi-Fi and a box redeeming from the
  same public address would be linked by IP alone. The apps need an OHTTP
  client (Swift: CryptoKit HPKE; Kotlin; the box reuses the branch's TS
  code). Browsers need a JS OHTTP client and a relay that allows CORS
  (check); until then the web shop states that it sees your IP and keeps none
  of it, and works over Tor.
- **First activation** is the weak point: someone buys and wants Pro now.
  The default spends at once (honest copy: "We can see that a purchase and
  an upgrade happened close together"). A switch "Start Pro at a random time
  in the next 24 hours" is offered for those who care.
- **Low balance.** The server raises an Activity entry and a content-free
  push ("Your server's prepaid months are running low") a month before the
  stash runs out, and never spends without a stash: the plan just lapses to
  Free (slowed, never cut, as today).

### 5.5 Overage is prepaid

`monetization-free-tier-first.md` prices overage at $0.05/GB after the
included 250 or 500 GB, billed after the fact. A bill after the fact needs a
payer on file for the account, which is exactly the link we refuse. So:

- Over the included quota, a paid account is slowed like Free, **unless** its
  server has bought top-up blocks: 1 voucher = 20 GB ($0.05/GB), spent
  automatically when the relay's lease nears the quota, within a monthly cap
  the owner sets (default: off, or a small cap; owner question).
- The metering core already supports per-plan "throttle" past the allowance;
  the top-up adds bytes to the account's allowance for the month.

### 5.6 What each feature spends

- **Pro, Pro Max:** monthly redemptions (5.4).
- **Custom domains, outbound proxy, separate lists per server:** no payment of
  their own. They read the plan (Pro gates already built).
- **Name change ($10) and dibs ($20):** `nameChange.ts` keeps every check; the
  entitlement input becomes 10 or 20 blind vouchers, consumed in the same
  transaction and put back (nullifiers deleted) if the rename fails. The
  rename itself shows `.com` old and new names; that is inherent.
- **Marketplace apps.** Today `app_sales` records `buyer_account` and
  installs check "does this username own this app". Change:
  - The server spends the price in vouchers plus a fresh random licence key;
    `.com` CA-signs `flagship/app-licence/v1|<listing>|<licence key>|<issuedAt>`
    and records a sale for the listing only (gross, cut, net; no buyer).
  - The box presents the licence (and proves the key) when it fetches the app
    from the developer's pipe. Neither `.com` nor the developer learns which
    account bought it. This also keeps the per-app identity rule: no id that
    follows a person between apps.
  - If the install path cannot be made anonymous for 0.4, ship the account
    link for paid apps and say so; it is the one place this mix would leak.
  - **Developer payouts** need the developer's legal identity (tax forms,
    bank details). That is a seller's choice and lives with the payout
    provider (Stripe Connect Express is the likely one) or by hand, never in
    the buyer path. Store fees mean a voucher nets us $0.85 to $1.00; the 15%
    default cut barely covers an Apple-bought voucher (owner question).

### 5.7 How the plan reaches the box

Unchanged from `feat/marketplace`: the box fetches
`flagship/plan-attestation/v1|<username>|<tier>|<paidUntil>|<issuedAt>|<expiresAt>`
with its read token, verifies it under the CA chain, and treats a failed
check as "plan unknown", never "lapsed". The outbound proxy keeps reading
`tier` from daemon-status. Changes:

- Voucher redemption (and an admin comp, logged) becomes the only caller of
  `grantTier`. The Stripe webhook no longer calls it.
- The box re-fetches the attestation right after its own redemption, so a new
  Pro takes effect within seconds.
- The attestation carries no money detail and never will.

### 5.8 What each party learns under this mix

| Party | Learns | Never learns |
| --- | --- | --- |
| Apple / Google | the payer, their country, that they buy Flagship vouchers or subscribe | the Flagship account, its servers, what was spent on |
| Stripe, card network, bank | the cardholder, that they paid Flagship | the account |
| Monero / Lightning | (Lightning: our node, partly the route) | the payer (Monero), the account |
| OHTTP relay | an IP talked to Flagship | the content |
| `.com` | per account: plan, paid-until, names, custom domains, marketplace sales totals per listing; per order: rail, count, store country; per subscription: periods claimed | which payer pays which account, IPs on money paths |
| The box | its own stash, claim secrets, licences | the payer's identity |
| A model (the box's AI or an IDE agent) | nothing about money | anything (5.10) |

### 5.9 What still links, said plainly

- Timing at first activation and small crowds at launch.
- Odd amounts (a 7-voucher app).
- A user who pays by card has told their bank they use Flagship; one who pays
  in the app has told Apple or Google. Vouchers keep it out of our data, not
  out of theirs. Monero is the answer for those who need that.
- Pro Max spends 20 a month: the amount reveals the plan, which `.com`
  already knows.

### 5.10 Owner rules

- **An AI never learns who or where the owner is.** Stashes, claim secrets,
  receipts, store country and plan state never enter a prompt, a tool result
  or an AI staging copy; the stash file is excluded from staging, and any
  box text about payments a model could read passes `buildModelRedactor`.
- **Per-app identity.** Unbound marketplace licences (5.6); no payment id is
  shown to an app or a visitor.
- **No identity to `.com` beyond need.** Plan per account is needed for
  metering; nothing else is kept.
- **Only admins change ranks** is untouched; who may spend the stash is an
  owner setting on the box (admin devices by default; an auto-pay setting for
  the monthly bill).
- **No hard-coded English.** All new text in `i18n/<surface>/*.json`,
  including store product names and push text.

## 6. The UX in each app

**iOS (reference client).** Settings, "Plan":
- Plan and paid-until; the lead server's balance ("7 months left");
  auto-pay on or off; overage top-up cap.
- "Get Pro" opens a StoreKit sheet: Pro and Pro Max (monthly, yearly) and
  packs of 10, 30, 120. US storefront only: a plain "Buy on the web (card,
  crypto)" link. Elsewhere nothing about the web.
- After a purchase the app gets the vouchers (or claim secret) over OHTTP and
  hands them to the lead server; if the server is off, it keeps them in the
  Keychain and retries. "Manage subscription" opens Apple's sheet.
- Spends (name change, dibs, an app, a top-up) say "Uses 10 from your
  server's balance" and ask Face ID once.
- Never: a code field, a QR scan or a file import for vouchers.

**Android.** The same with Play Billing; "Buy on the web" in the US only if
the external content links rules allow it at launch (check), otherwise not.

**Webapp and website.** `flagshipserver.com/pro` (rewritten): plans,
privacy notes per rail, and the shop: Stripe (packs, subscriptions),
Monero, Lightning. No sign-in needed. The browser makes the tokens, then
offers "Send to my server" when the signed-in webapp opened it (hand-off
through the owner session, end to end to the box) or a stash file and QR
code to keep. The webapp's Plan section matches iOS and can import a stash
file.

**Studio (Mac, Windows, Linux).** Import a stash file into a server; a link
to the web shop.

**Box.** Holds the stash (encrypted, in its backup), pays monthly, buys
top-ups within the cap, writes Activity entries (paid, low balance, lapsed),
and refuses to spend while the owner has auto-pay off except on an admin
device's signed order.

## 7. Tax, law and refunds (for an accountant and counsel)

- **Store sales:** Apple and Google are merchant of record; their reports are
  enough.
- **Stripe sales:** we are merchant of record. EU/UK VAT from the first sale
  (non-Union OSS), US state sales tax past thresholds. Decide: Stripe direct
  with Stripe Tax, or a merchant-of-record reseller.
- **Vouchers and VAT:** under the EU voucher rules a voucher whose place of
  supply is not known at sale is a multi-purpose voucher, taxed at
  redemption, when we do not know the country either. Ask whether taxing at
  sale on the card country works for Stripe sales, and what to do with crypto.
- **Crypto:** no buyer country. Options: treat all as US sales, geo-limit,
  or ask. Also how to hold or convert XMR as exchanges delist it.
- **Gift-card law:** US rules generally forbid gift certificates expiring in
  under 5 years. Recommendation: vouchers never expire; each yearly signing
  key is accepted for at least 5 years after it retires.
- **Unclaimed property:** some US states claim unspent prepaid balances.
  With bearer vouchers there is no owner address. Ask how this applies to
  IBIS LLC.
- **Prepaid access rules:** closed-loop prepaid usable only with us is
  usually outside money-transmitter rules under daily limits. Confirm.
- **Refunds:** "no refunds, vouchers never expire", except that Apple and
  Google refund under their own rules. Card purchases capped (for example
  120 vouchers per purchase, a monthly cap per card) to limit carding.
- **Terms, Privacy and store labels:** Terms §3/§4, Privacy §2.4, App
  Privacy "Purchases, not linked to you", Play Data safety, the FAQ "Money"
  section (`docs/faq-money-section.html`, which still describes hardware and
  proration and must be rewritten).

## 8. Work breakdown

### 8.1 Exists on the branches (reuse)

Plan attestation end to end; `grantTier` and `effectiveTierOf`; tier-aware
metering; custom domain and outbound proxy Pro gates in all three apps;
OHTTP gateway; name change and dibs checks; marketplace listings, prices,
developer console; allowance read and the Tier status screens; the
`billing/` metering core and the voucher draft spec.

### 8.2 New

1. **`@ibisllc/billing-vouchers`**: RFC 9474 issue and verify (Workers),
   client blind/unblind in TS (browser and box), Swift and Kotlin, shared
   vectors, nullifier store with a conformance suite, yearly key sets
   published and pinned.
2. **`.com` issuer**: issue, claim and redeem routes behind OHTTP; D1
   migrations for nullifiers, order hashes, claim secrets; no IP logging;
   rate limits per order, not per caller.
3. **Rail adapters**: App Store Server API and Notifications V2; Play
   Developer API and RTDN; Stripe Checkout and Billing without any username;
   Monero view wallet machine; BTCPay (Lightning) if chosen.
4. **Box**: stash store (encrypted, backed up), auto-pay, claim schedule,
   random spend timing, top-up purchases, low-balance Activity and push,
   licence store.
5. **Apps**: OHTTP client; StoreKit 2 and Play Billing flows; Plan screens;
   spend confirmations; hand-off to the lead server; the web shop and
   webapp Plan section; Studio import. All strings through i18n.
6. **Rework**: drop username metadata and Stripe ids; replace code vouchers
   and the admin "flip by hand" path; name change takes blind vouchers;
   `app_sales` without `buyer_account`; app licences; prepaid overage in the
   egress lease policy.
7. **Legal and store setup**: products in App Store Connect and Play Console,
   review notes explaining vouchers, Terms, Privacy, labels, tax
   registration.
8. **Tests and gym**: vectors in four ports; a live gym group "payments"
   (sandbox Apple and Google purchases, Stripe test mode, a Monero stagenet
   order, redemption, plan attestation on a box, lapse to Free, a name
   change, a paid app install).

### 8.3 Order to launch (all in 0.4, built in this order)

1. **Decisions** (section 9) and the checks in section 10, with counsel and
   an accountant. Start App Store and Play product review early; the old
   note "blocked until current reviews close" must be rechecked.
2. **Fold the branches** onto `release/0.4` (F2: marketplace, then
   custom-names, custom-domains, outbound-proxy), keeping the Pro gates and
   the OHTTP gateway.
3. **The voucher core and redemption**, plan from vouchers, box stash and
   auto-pay, with admin-issued test vouchers. This alone switches on Pro,
   Pro Max, custom domains, the outbound proxy, name change and dibs.
4. **Web shop with Stripe** (packs first, then subscriptions with claim
   secrets).
5. **Store IAP** on iOS and Android (packs, then subscriptions).
6. **Monero** page and view wallet; Lightning after, if chosen.
7. **Paid marketplace apps** with unbound licences and the payout ledger.
   Free listings can go live at step 3.

If time forces a cut, steps 6 and 7 slip, not the privacy properties of
steps 3 to 5.

## 9. Open questions for the owner

1. **Store subscriptions as a voucher drip** (5.3), or packs only as the
   voucher doc said?
2. **iOS Option A** (sell vouchers and subscriptions by IAP, 15%) or
   **Option B** (free companion, web only)?
3. **Card sales:** Stripe direct (we file VAT and sales tax) or a
   merchant-of-record reseller (sees email and country)?
4. **Crypto at launch:** Monero only, or Monero plus Lightning through
   BTCPay? Hold or convert? Who runs the node?
5. **Overage:** prepaid top-up blocks (recommended) with what default cap?
   This changes "overage applies" on the Pro page.
6. **Refunds and limits:** "no refunds, never expire", and the card caps.
7. **Marketplace:** the platform cut given store fees; payout method;
   unbound licences in 0.4 or the account-linked fallback.
8. **First activation:** default immediate with the 24-hour random option?
9. **Drop cash by mail** and every email-matched flow (yes is recommended).
10. **Who may spend the stash** besides auto-pay: admin devices only?
11. **Prices in stores:** Apple and Google price points ($9.99 versus $10)
    and whether store prices carry the 15% (same voucher, higher price in
    the app) or we absorb it.

## 10. To check with current official sources before building

- Apple App Review Guidelines 3.1.1, 3.1.1(a), 3.1.3(b), 3.1.3(f), and the
  current US link-out commission after the Epic v. Apple remand.
- Whether Apple accepts spending a web-bought balance from the app (3.1.3(b))
  and a subscription that delivers consumable credit.
- Google Play Payments policy, US external content links and alternative
  billing (enrolment, fees, the 1 December 2026 reporting date), EEA user
  choice billing.
- Apple Small Business Program and Google fee rates for 2026.
- Stripe: restricted businesses (prepaid, stored value), whether Checkout
  can skip the email, fees, Stripe Tax, managed merchant of record.
- Processor fees and KYC for any crypto processor; EU AMLR rules on privacy
  coins and exchange delistings.
- OHTTP relay terms (Oblivious Network): browser CORS, volume, cost.
- US gift-card rules, unclaimed property, prepaid access rules; EU voucher
  VAT rules.
