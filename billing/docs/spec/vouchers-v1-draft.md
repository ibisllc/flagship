# Anonymous vouchers v1 (DRAFT)

Status: **draft, not built.** Nothing here is implemented or stable. It will
become `packages/vouchers` (`@ibisllc/billing-vouchers`) with this document
promoted to `vouchers-v1.md` once the first host has built against it.
Comments and objections are welcome until then.

## Goal

Prepaid credit that a service can accept without ever being able to link a
redeemed voucher to the payment that bought it. To the issuer, a voucher
bought through an app store or by card must be as anonymous as cash.

## The voucher

- **One unit, one value.** A host picks a single unit (e.g. 1 USD) and
  prices everything in whole units. Every voucher looks the same at
  redemption, whatever paid for it, so buyers on every payment rail hide in
  one crowd. Mixed denominations shrink that crowd and are out of scope.
- **Blind-signed** ([RFC 9474](https://www.rfc-editor.org/rfc/rfc9474) RSA
  blind signatures, RSABSSA-SHA384-PSS-Randomized). The buyer's device makes
  random tokens, blinds them, the issuer signs them blind after payment, and
  the device unblinds. At redemption the issuer can check its signature but
  can't tell which payment it came from. Without blinding, "payment X →
  codes → account Z" sits in the issuer's database and nothing is
  anonymous.
- **Double spend:** redemption records the token's hash (a nullifier) in a
  spent-tokens table with an atomic insert; a second redemption of the same
  token fails.
- **Key rotation:** one signing key per long period (e.g. a year), with every
  voucher valid well past its key's rotation. A key that rotates often dates
  the purchase and shrinks the crowd.
- **Bearer tokens:** whoever holds one can spend it. Clients store them in the
  platform keystore or encrypted at rest.

## Buying in bulk, spending over time

A buyer purchases a stash once (e.g. a year's worth) and spends it in
regular amounts. That replaces an auto-renewing subscription (one long-lived
record per buyer at the payment provider, every renewal reported to the
issuer) and breaks the timing link between one purchase and the redemptions
spread over months.

The spender can be a device or service the buyer controls that holds the
stash and pays its own recurring bill, so the buyer doesn't have to redeem
by hand.

## Issuance over a payment rail

The protocol is the same for every rail; only "has this order been paid?"
differs.

- **App stores:** consumable in-app products (packs of N vouchers). The app
  sends the store receipt plus blinded tokens; the issuer verifies the
  receipt with the store and signs. Never attach an account identifier to
  the purchase (on Apple, leave `appAccountToken` unset). The store still
  knows who paid, just not which account spent the vouchers.
- **Cryptocurrency:** a self-serve page quotes a price for a fixed window,
  shows a fresh receiving address per order, makes and blinds the tokens in
  the browser, and signs once a watch-only wallet sees enough confirmations.
  No account, email or username anywhere; the order link keeps its secret
  after `#` so a buyer can come back.
- **Card:** the convenient, less private option; the processor knows the
  buyer.

Issuer rules on every rail: no IP addresses logged on the signing endpoint;
whole vouchers only (an underpayment gets the whole vouchers it covers);
refunds can't be clawed back, since the issuer can't tell which vouchers a
refund produced.

## Open questions

- Sales tax / VAT on rails with no collector and no buyer country.
- Gift-card and unclaimed-property law may set a minimum validity.
- A small anonymity set early on: with few buyers, timing and amounts can
  still single someone out.
- Odd totals (a 7-unit purchase) make a spend slightly more distinctive than
  a round amount.
- Package API: issuance (`blind`, `sign`, `finalize`), redemption (`verify`,
  `spend` against a pluggable nullifier store with its own conformance
  suite), key rotation and published key sets.
