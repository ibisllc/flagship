# Payments setup (owner): Stripe, the App Store and Google Play

Everything only the owner can do to switch on the voucher shops of release 0.4: card payments on the web through
Stripe Checkout, in-app purchase on iPhone and iPad (StoreKit 2) and Google Play Billing on Android. The code is on
branch `0.4/payments-rails`; how it works is `docs/payments-privacy-and-rails.md` §11. Do the **gym (Stripe
sandbox) first** (part A), then production (part B). Nothing here is done by an agent: no account, product, key or purchase
was created while building it.

What is sold: packs of 10, 30 and 120 blind-signed $1 vouchers (`config.packs`), priced $10, $30 and $120 on Stripe
and Play. The App Store has no $120.00 price point, so its 120 pack is **$119.99**; the product id, not the price,
decides the voucher count, and the iOS app shows StoreKit's localized `displayPrice` for each pack. The store fee is
absorbed. No subscriptions yet (a later step). No refunds of our own: vouchers never expire.

Settings the code reads (all on the `.com` Worker; a rail is off until its settings exist):

| Name | Kind | Production | Gym |
| --- | --- | --- | --- |
| `STRIPE_SECRET_KEY` | secret | restricted live key `rk_live_…` | restricted test key `rk_test_…` |
| `STRIPE_WEBHOOK_SECRET` | secret | the live endpoint's `whsec_…` | the test endpoint's `whsec_…` |
| `APPLE_IAP_ENVIRONMENTS` | secret (or var) | `Production` | `Sandbox` (already a var in `wrangler.gym.toml`) |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | secret | the service account's JSON key | the same key is fine |
| `GOOGLE_PLAY_ALLOW_TEST` | var | never set | `1` (already in `wrangler.gym.toml`) |
| `VOUCHER_SIGNING_KEYS` | secret | the yearly voucher key (`node scripts/voucher-key.mjs new <file>`) | a separate gym key |
| `STRIPE_TAX_BEHAVIOR`, `STRIPE_TAX_CODE`, `STRIPE_VOUCHER_SUCCESS_URL`, `_CANCEL_URL`, `APPLE_BUNDLE_ID`, `GOOGLE_PLAY_PACKAGE_NAME` | optional | defaults: `inclusive`, `txcd_10000000`, the webapp, `com.flagshipserver.app` | same |

Never set `STRIPE_PRICE_HOBBY` / `STRIPE_PRICE_MAKER`: they belong to the old username-linked subscription lane
(`/api/stripe/checkout`), which the vouchers replace and which stays off without them.

## 0. Before anything

1. **Ask Stripe whether prepaid vouchers are allowed** (Stripe's restricted-businesses list covers stored value and
   prepaid). Dashboard → Help → Contact support, and describe it as: "We sell prepaid credit for our own hosting
   service, in $1 units, usable only with our service, never redeemable for cash, never expiring. Packs of $10, $30
   and $120, one-time payments through Stripe Checkout." Keep their answer. Don't go live before a yes.
2. **Accountant:** Stripe sales make IBIS LLC the merchant of record (EU/UK VAT from the first sale, US sales tax
   past state thresholds). Decide which registrations to add in Stripe Tax (step A1.4) and whether the vouchers
   are taxed at sale (`docs/payments-privacy-and-rails.md` §7). Apple and Google handle tax on store sales.
3. **D1 migration 0153** (`voucher_payments`) goes to the gym and to production before each Worker deploy (B1).

Names as the consoles show them: the App Store app is **Flagship Hub** (App Store Connect app id `6768945985`); the
Play developer account is **Houston Automation Lab** (IBIS LLC, D-U-N-S 137326825). Status of the first browser run:
`docs/runbooks/0.4-browser-tasks.md` "Status".

## Part A: the gym in a Stripe sandbox

### A1. Stripe (sandbox)

Stripe's old test mode is now a **Sandbox**: pick it from the account menu at the top left. A sandbox is a separate
environment: its keys, webhooks, payment methods, tax settings and Radar rules are not shared with live, and some
live-only settings (the invoice template) are hidden there. Everything here is redone in live ("Stripe live pass").

1. **Restricted key.** Developers → API keys → **Create restricted key** → "Building your own integration".
   Name: `flagship-gym-vouchers`. Permissions: **Checkout Sessions: Write** (it includes read). Everything else:
   None. Create, and copy the `rk_test_…` value once.
   If a test purchase fails with "The provided key does not have the required permissions" the message names the
   resource; give that one resource the access it names and nothing else (Stripe Tax on a Checkout Session needs
   no extra permission as far as we know; this is the fallback).
2. **Webhook.** Workbench → **Webhooks** → Create an **event destination** (done 2026-11-17 in the sandbox:
   `flagship-gym-vouchers`, `we_1UczXNRpImRXwdCTjGrijaCw`):
   - Events: `charge.refunded`, `charge.dispute.created` (only these two)
   - Payload: **Snapshot**; API version: **`2025-03-31.basil`**. The code pins the same version on its own Stripe
     calls (`voucherRails.ts` `STRIPE_API_VERSION`) and its tests read basil-shaped `charge` and `dispute` objects;
     move both together if the version ever changes.
   - Destination: Webhook endpoint, URL `https://gym.flagshipserver.com/api/stripe/webhook`, description
     `Flagship gym: voucher refunds and disputes`
   Create, then **Reveal** the signing secret (`whsec_…`).
3. **Payment methods.** Settings → Payments → Payment methods: Cards on; Apple Pay on; **[OWNER CONFIRMS]** Google
   Pay on (turning it on accepts Google's Google Pay API Terms of Service). Checkout shows them where the buyer's
   browser supports them. Business batches take cards (with the wallets), and bank transfer only when `.com` has
   `STRIPE_BANK_TRANSFER = "1"` ("Bank transfer for business batches" below). Leave Link as you like (Link stores the buyer's details at
   Stripe, not with us).
4. **Stripe Tax.** Settings → Tax: turn on; Origin address: IBIS LLC's address (head office Texas); **Include tax
   in prices: Yes** (inclusive; the code sends `tax_behavior=inclusive` on each line anyway, so the $10 shown is the
   $10 paid, tested in `voucherRails.test.ts`); preset product category: Electronically Supplied Services, the
   code sends `txcd_10000000` unless `STRIPE_TAX_CODE` says otherwise (ask the accountant whether a gift-card or
   voucher code fits better). Registrations: add the ones the accountant names, in the sandbox and again in live.
   (Sandbox done 2026-11-17: inclusive, `txcd_10000000`, no registrations yet.)
5. **Branding and receipts.** Settings → Branding: the Flagship icon and colour. Settings → Business → Public
   details: support email and URL `https://flagshipserver.com/support`. **Leave the statement descriptor alone**:
   it is account-wide and IBIS LLC sells other products on the same account. The code sets
   `payment_intent_data.statement_descriptor_suffix = FLAGSHIP` on every voucher and batch Checkout Session
   (`voucherRails.ts` `STRIPE_STATEMENT_SUFFIX`); Stripe joins it to the account's shortened descriptor prefix
   (prefix, separator and suffix: 22 characters at most, at least one letter, none of `< > \ ' " *`).
   Settings → Customer emails: "Successful payments" on (Stripe emails the receipt; Checkout asks for an email in
   any case, and only Stripe keeps it).
6. **Radar.** Radar → Rules: keep "Request 3D Secure if 3DS is required for card" and add
   `Request 3D Secure if :risk_level: = 'elevated'`. Bearer vouchers attract stolen cards; the most a single
   purchase can buy is $120.
7. **Secrets on the gym Worker** (from `apps/com`, paste each value at the prompt):
   ```sh
   cd apps/com
   npx wrangler secret put STRIPE_SECRET_KEY --config wrangler.gym.toml        # rk_test_…
   npx wrangler secret put STRIPE_WEBHOOK_SECRET --config wrangler.gym.toml    # whsec_… of the gym endpoint
   ```
   `gym-refresh.sh` copies prod's secret *names* to the gym; these come first, so it finds them already there.

### A2. Apple (sandbox)

The App Store parts (A2.1 to A2.4) are the same records production uses; do them once.

1. **Agreements, tax and banking.** App Store Connect → Business: accept the **Paid Apps** agreement, add the bank
   account (the one Stripe pays out to is fine), the tax forms (W-9 for IBIS LLC, then the countries' forms Apple
   asks for) and the contacts (Finance, Legal, Technical). Products can't be tested in the sandbox until the
   agreement is Active.
2. **Small Business Program.** developer.apple.com/app-store/small-business-program → Enroll (15% instead of 30%
   under $1M a year).
3. **The three products.** App Store Connect → Apps → Flagship Hub → Monetization → **In-App Purchases** → +, type
   **Consumable**, for each row:

   | Reference name | Product ID | Price |
   | --- | --- | --- |
   | Vouchers 10 | `com.flagshipserver.app.vouchers.10` | $10.00 (US) |
   | Vouchers 30 | `com.flagshipserver.app.vouchers.30` | $30.00 |
   | Vouchers 120 | `com.flagshipserver.app.vouchers.120` | $119.99 (Apple has no $120.00 price point) |

   The product id fixes how many vouchers a purchase gives, whatever the price, and the app shows StoreKit's
   localized price; if a listed price isn't in Apple's price list take the nearest and say so to the developers.
   (Created 2026-11-17: Apple IDs 6836151300, 6836152101, 6836152683.) Availability: all countries and regions.
   Family Sharing: off (consumables can't use it). Localizations (Display Name, Description), in every language
   the app ships:

   | Language | Display name (10 / 30 / 120) | Description |
   | --- | --- | --- |
   | English (U.S.) | 10 vouchers / 30 vouchers / 120 vouchers | Adds $10 / $30 / $120 to your Flagship balance. |
   | German | 10 Gutscheine / 30 Gutscheine / 120 Gutscheine | Fügt deinem Flagship-Guthaben 10 $ / 30 $ / 120 $ hinzu. |
   | Spanish (Spain and Mexico) | 10 vales / 30 vales / 120 vales | Añade 10 $ / 30 $ / 120 $ a tu saldo de Flagship. |
   | French | 10 bons / 30 bons / 120 bons | Ajoute 10 $ / 30 $ / 120 $ à votre solde Flagship. |
   | Japanese | バウチャー 10 枚 / 30 枚 / 120 枚 | Flagship の残高に 10 / 30 / 120 ドルを追加します。 |
   | Portuguese (Brazil) | 10 vales / 30 vales / 120 vales | Adiciona US$ 10 / 30 / 120 ao seu saldo da Flagship. |
   | Chinese (Simplified) | 10 张代金券 / 30 张 / 120 张 | 为你的 Flagship 余额增加 10 / 30 / 120 美元。 |

   (Machine drafts like the apps' strings; a native speaker should read them with the other store text.)
   Review information: a screenshot of Settings → Plan with the packs showing (iPhone), and the note in A2.6.
   Tax category: the default (App Store software) unless the accountant says otherwise.
4. **Server notifications.** App Information → **App Store Server Notifications** (no version picker: new URLs are
   Version 2);
   Production Server URL `https://flagshipserver.com/api/vouchers/apple/notifications`;
   Sandbox Server URL `https://gym.flagshipserver.com/api/vouchers/apple/notifications`. They tell `.com` about
   refunds (it then refuses to sign for that purchase if the phone hasn't been paid out yet).
5. **App Privacy.** App Store Connect → App Privacy: add **Purchases → Purchase History**: collected, **not linked
   to the user's identity**, not used for tracking, purpose App Functionality. (`.com` keeps a hash of each
   transaction id and the day, never an account.)
6. **Review notes** (App Review Information → Notes; add to `docs/runbooks/store-review-notes.md` when submitting):
   > Flagship sells prepaid credit for its hosting service as consumable in-app purchases (10, 30 or 120 vouchers,
   > each worth $1 of credit; App Store prices $10.00, $30.00 and $119.99). Vouchers are spent automatically on the user's Flagship plan (Pro: 10 a month, Pro Max: 20) from
   > Settings → Plan. They are bought only through in-app purchase inside the app; the app has no other way to buy,
   > enter a code, scan or import credit. Vouchers are privacy-preserving: our server signs them blind, so it never
   > learns which account a purchase paid for. To test: create an account (it takes a minute), open Settings →
   > Plan, buy the 10-voucher pack with a sandbox account; the balance shows $10. Choosing Pro then spends from it.
7. **Sandbox testers.** Users and Access → Sandbox → Testers → +: a fresh email per tester. On the test iPhone:
   Settings → Developer (or App Store) → Sandbox Account → sign in. A TestFlight or development build of the gym
   app then buys at no charge; its transactions say `environment: Sandbox`, which the gym accepts.
8. The first in-app purchases must be submitted **with an app version** (select them on the version page under
   In-App Purchases before Submit for Review).

The iOS app sells only through in-app purchase and shows no link to the web shop. Apple allows a plain link to
another way to pay on the **US storefront** (guideline 3.1.1(a), after Epic v. Apple), but not elsewhere; we left it
out of 0.4 so one build passes review everywhere. Adding a US-only "Buy on the web" link later is a code change.

### A3. Google Play (licence testers)

1. **Payments profile.** Play Console → Setup → **Payments profile**: create or link the merchant payments
   profile (IBIS LLC, bank account, tax info: W-9). Without it the products page stays locked.
2. **Upload a build that has Play Billing** to the internal testing track first (Play only lets you create
   products for an app whose uploaded bundle declares the billing permission). Any 0.4 build from
   `0.4/payments-rails` (or later) has it.
3. **The three products.** Monetize with Play → Products → **One-time products** → Create:

   | Product ID | Name | Description | Default price |
   | --- | --- | --- | --- |
   | `com.flagshipserver.app.vouchers.10` | 10 vouchers | Adds $10 to your Flagship balance. | USD 10.00 |
   | `com.flagshipserver.app.vouchers.30` | 30 vouchers | Adds $30 to your Flagship balance. | USD 30.00 |
   | `com.flagshipserver.app.vouchers.120` | 120 vouchers | Adds $120 to your Flagship balance. | USD 120.00 |

   Translations: the table in A2.3. Purchase options: keep the single default "Buy" option (marked backwards
   compatible); multi-quantity purchases: off (the code accepts a quantity, but the app buys one at a time). Let
   Play convert the price for other countries. **Activate** each product. They are consumed by the app after delivery;
   Play has no separate "consumable" switch.
4. **Service account for verification.** Done 2026-11-17 (no secret here):
   - Account **`flagship-play-verify@flagshipserver.iam.gserviceaccount.com`**, in Google Cloud project
     **`flagshipserver`**, with **no project roles**; the Google Play Android Developer API is enabled in that
     project.
   - In Play Console (Users and permissions) it has app permissions on Flagship only: View app information (Play
     forces it), **View financial data** and **Manage orders and subscriptions**. No account permissions.
   - Its JSON key is `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` on both Workers (production and gym).
   - Google can take **up to 24 hours** before the API accepts a new service account: a `401`/`403` from the Play
     Developer API on the first day is that wait, not a broken key.

   To rebuild it:
   1. Play Console has **no "API access" page** any more (no project is linked from Play). Google Cloud console
      (console.cloud.google.com) → any project of the owner's (`flagshipserver`) → APIs & Services → enable
      **Google Play Android Developer API**.
   2. IAM & Admin → Service Accounts → Create: name `flagship-play-verify`, no project roles. Keys → Add key →
      JSON → download.
   3. Play Console → **Users and permissions** → Invite new users → the service account's email → App
      permissions → add Flagship with only: **View financial data, orders and cancellation survey responses** and
      **Manage orders and subscriptions** (the second lets `.com` acknowledge a purchase). No account permissions.
      It can take up to 24 hours before the API accepts the key.
   4. Put it on the gym Worker (and later production) from the file, then delete the downloaded file:
      ```sh
      cd apps/com
      npx wrangler secret put GOOGLE_PLAY_SERVICE_ACCOUNT_JSON --config wrangler.gym.toml < ~/Downloads/flagship-play-verify-*.json
      ```
5. **Licence testers.** Play Console → Setup → **License testing**: add the testers' Google accounts, response
   "RESPOND_NORMALLY". Their purchases are free and come back as test purchases, which only the gym accepts
   (`GOOGLE_PLAY_ALLOW_TEST=1`).
6. **Data safety.** App content → Data safety: Financial info → **Purchase history**: collected, not shared,
   required, purpose App functionality. Note in the form's text that it is not linked to the account.
7. Real-time developer notifications (refunds) are not used yet; refunded Play purchases are an accepted loss
   (`docs/payments-privacy-and-rails.md` §11 "Refunds without an account").

### A4. Try it in the gym

1. Gym D1: `cd apps/com && npx wrangler d1 execute flagship-state-gym --remote --config wrangler.gym.toml --file=../../packages/storage/migrations/0153_voucher_payments.sql`
2. `bash scripts/gym-refresh.sh` (deploys the gym Worker with the branch's code once it is on `gym-0.4`).
3. `curl -s https://gym.flagshipserver.com/api/payments/config | jq .rails` shows `stripe`, `apple`, `google` true
   for each rail you set up.
4. Web: open `https://webapp.gym.flagshipserver.com`, Settings → Plan → **Buy $10**, pay with card
   `4242 4242 4242 4242`, any future date, any CVC; back in the webapp the balance shows $10 within a few seconds.
   A 3-D Secure card (`4000 0027 6000 3184`) checks the challenge path. In Stripe → Payments, refund it: the
   webhook log shows a 200 from `/api/stripe/webhook`.
5. iPhone: a gym build signed in with the sandbox tester buys the 10 pack; the balance shows $10.
6. Android: an internal-track gym build with a licence tester buys the 10 pack; the balance shows $10.

## Part B: production

1. **D1 0153 on production**, before the `.com` deploy (`docs/runbooks/final-deploy.md` §4):
   ```sh
   cd apps/com
   npx wrangler d1 execute flagship-state --remote --file=../../packages/storage/migrations/0153_voucher_payments.sql
   npx wrangler d1 execute flagship-state --remote --command "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES ('0153', $(date +%s)000)"
   ```
2. **Stripe live mode:** the "Stripe live pass" below, after Stripe's written yes.
3. **Production secrets** (paste at each prompt):
   ```sh
   cd apps/com
   npx wrangler secret put STRIPE_SECRET_KEY                  # rk_live_…
   npx wrangler secret put STRIPE_WEBHOOK_SECRET              # whsec_… of the live endpoint
   npx wrangler secret put APPLE_IAP_ENVIRONMENTS             # Production
   npx wrangler secret put GOOGLE_PLAY_SERVICE_ACCOUNT_JSON < ~/Downloads/flagship-play-verify-*.json
   ```
   A rail switches on as soon as its secret exists, so set them together with (or just before) the release that
   ships the 0.4 apps; until a store's products are approved the phone simply shows no packs.
4. **Deploy `.com`** through the release (`npm run deploy` in `apps/com`; webapp shell v231 ships with it).
5. **Submit** the iOS version with its three in-app purchases (A2.8) and the Android release with its active
   products, with the notes from A2.6.
6. **First live check:** buy the $10 pack once on the web with a real card, then refund it in Stripe; the balance
   keeps the vouchers (a refund can't reach them) and the webhook log shows 200. Check
   `npx wrangler d1 execute flagship-state --remote --command "SELECT rail, units, day, state FROM voucher_payments"`
   shows rows without any account.
7. **Terms, Privacy and the FAQ**: Terms §3/§4 (vouchers, no refunds, never expire), Privacy §2.4 (what Stripe,
   Apple and Google learn; what `.com` keeps), `docs/faq-money-section.html`: still to write before launch
   (`docs/payments-privacy-and-rails.md` §7).

## Stripe live pass

The sandbox is separate, so all of A1 is redone in live mode (the same list is in `0.4-browser-tasks.md`, "Stripe
live pass"). Before it: on 2026-11-17 the live account showed "Update your business website URL to resume payouts";
the owner fixes it under Settings → Business, or live payouts stay blocked.

1. Live restricted key `flagship-com-vouchers` (Checkout Sessions: Write) → production `STRIPE_SECRET_KEY`.
2. Live event destination `https://flagshipserver.com/api/stripe/webhook`, events `charge.refunded` and
   `charge.dispute.created`, Snapshot, `2025-03-31.basil` → production `STRIPE_WEBHOOK_SECRET`.
3. Live payment methods: Cards, Apple Pay, Google Pay (**[OWNER CONFIRMS]**: Google's terms).
4. Stripe Tax: Include tax in prices Yes, Electronically Supplied Services, registrations from the accountant.
5. The Radar rule (A1.6).
6. Branding and the "Successful payments" emails (A1.5).
7. Invoice template (live only): footer and "Show tax ID on invoices". The invoice number prefix is account-wide,
   shared with IBIS's other products: changing it is the owner's call, not a setup step.
8. Public details: support URL `https://flagshipserver.com/support` and the support email. The statement descriptor
   stays as it is (the code adds the `FLAGSHIP` suffix).
9. Settings → Payouts shows the bank account and a payout schedule.

## Bank transfer for business batches

Built in 0.4 (2026-11-21), off until the owner turns it on. Checked against Stripe's docs
(docs.stripe.com/payments/bank-transfers/accept-a-payment, Checkout): Checkout offers bank transfer
(`customer_balance`) in `mode=payment` only on a session that names an existing Customer, and the payment is
delayed (the session completes unpaid and turns paid once the money arrives).

How it works (`voucherRails.ts` `handleStripeBatchCheckout`, `handleBatchIssue`):
- The org admin presses "Pay by bank transfer" (shown only while `GET /api/payments/config` says
  `rails.stripeBank`). `.com` creates an **empty** Customer (metadata `flagship_kind=voucher-batch` only: no name,
  email or address) and a Checkout Session for it with `customer_update[name|address]=auto`, so the company's name,
  address and tax id come from the Checkout form as they do for cards; nothing names an org, account or seat. The
  session allows only `customer_balance` with `funding_type=bank_transfer`, `us_bank_transfer` (USD).
- Stripe shows the company its bank details and reconciles the transfer. The browser keeps the batch pending (and
  the buyer keeps the batch key file); "Add to the org's wallet" answers "That batch isn't paid yet. A bank transfer
  can take a few days." until the session is paid **and** its PaymentIntent has `amount_received >= amount` (a short
  transfer never counts). An expired session or a canceled PaymentIntent answers `payment-void` (410): start a new
  batch.
- Signing is the same as a card batch: same commitment, chunks, refund and dispute handling.

Owner, to turn it on (live, after the card batch works):
1. Stripe Dashboard → Settings → Payments → Payment methods: **Bank transfers** on (**[OWNER CONFIRMS]**: Stripe's
   fee for bank transfers, and which currencies; the code asks for USD US bank transfer only).
2. The restricted key (`flagship-com-vouchers`) gains **Customers: Write** and **PaymentIntents: Read** (card batches
   need neither; only bank sessions read their PaymentIntent).
3. `apps/com/wrangler.toml` `[vars]`: `STRIPE_BANK_TRANSFER = "1"` (gym: `wrangler.gym.toml`, sandbox first), then
   deploy `.com`.
4. Test in the gym: a batch of 100 by bank transfer; in the sandbox, fund the customer balance from the Customer's
   page ("Send test bank transfer"), first part of the amount (still unpaid), then the rest (vouchers sign).

Not built: a manual `send_invoice` invoice from the Dashboard still turns into no vouchers (`batch-issue` reads only
Checkout Sessions); use the Checkout bank transfer above instead.

## Refunds, in one place

- Stripe: a refund or a dispute arrives by webhook; `.com` marks the payment and won't sign for it later. Vouchers
  already signed stay valid (nothing links them to the payment). Answer disputes in the Dashboard with the receipt.
- Apple: Apple decides refunds; the notification marks the payment. A consumption request (Apple asking whether the
  item was delivered) needs an App Store Server API key we don't use yet; it is safe to leave unanswered.
- Google: Google decides; not followed yet.
- Each phone caps its own store purchases at $240 in 30 days. The loss is accepted at these prices.
