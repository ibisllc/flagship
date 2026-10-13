# Anonymous vouchers: one way to pay for everything

Status: **spec, not built** (owner decisions 2026-10-13). Code will live on
`feat/marketplace`; replaces the hand-matched Monero flow and the
tier-and-days codes in `packages/control-plane/src/voucher.ts` there.

## Goal

Every purchase (Pro, Pro Max, name change, dibs, later marketplace apps) is
paid in vouchers, and **we can never link a voucher to the payment that
bought it**. To us, an App Store voucher must be as anonymous as cash. The
owner runs it from a phone: no cash envelopes, no matching emails by hand.

## The voucher

- **One unit: $10.** Pro = 1 voucher/month, Pro Max = 2, name change = 1,
  dibs claim = 2. Every voucher looks the same at redemption, whatever paid
  for it, so App Store, Play, Monero and card buyers all hide in one crowd.
- **Blind-signed** (RFC 9474 RSA blind signatures). The buyer's device makes
  random tokens, blinds them, we sign them blind after payment, the device
  unblinds. At redemption we can check our signature but can't tell which
  payment it came from. Without blinding, "payment X → codes → account Z"
  sits in our database and nothing is anonymous.
- **Double-spend:** redemption records the token's hash (a nullifier) in a
  spent-tokens table; atomic insert, single use.
- **One signing key per year,** with every voucher valid well past its key's
  rotation. A key that rotates often dates the purchase.
- **Bearer tokens:** whoever holds one can spend it. Stored in the Keychain
  (iOS), Keystore (Android), and encrypted on the box.

## Buying in bulk, spending monthly

People buy a stash (e.g. 12) once and spend one a month. This replaces an
auto-renewing subscription (one long-lived record per Apple ID, every
renewal and cancellation reported to us, so it can't be made private), and
it breaks the timing link: one purchase, redemptions spread over a year.

**The box holds the stash and pays its own bill.** The stash is imported on
the web or in Studio, stored encrypted on the box, included in its backup,
and the box spends one voucher per period (two for Pro Max). The phone apps
only show the balance ("11 months left").

## Paying through the App Store / Play

- One-time (consumable) products: 1, 3 and 12 vouchers. Apple 3.1.1
  explicitly routes vouchers for digital services through In-App Purchase.
- After purchase the app sends the receipt plus blinded tokens; we verify the
  receipt with Apple/Google, sign the tokens, and the app hands the stash to
  the box. Never set `appAccountToken` (it ties a purchase to an account).
- **No IP addresses logged** on the signing endpoint.
- Apple/Google keep 15% (small-business programs) and handle sales tax/VAT.
- **Apple still knows who paid** (an Apple ID bought Flagship vouchers), just
  not which Flagship account used them. Users who need Apple out of it use
  Monero.
- Vouchers bought outside the store are **never** typed or imported in the
  phone apps (Apple reads that as getting around IAP); they go to the box via
  the web or Studio.
- Refunds can't be clawed back (we can't tell which vouchers a refund
  produced). Accepted loss at these prices; answer Apple's refund
  consumption requests with "delivered".
- Blocked until the current App Store / Play reviews close: we told Apple
  nothing is sold. Then update Terms §3/§4, Privacy §2.4, the App Privacy
  labels ("Purchases", not linked to identity) and get each product approved.

## Paying with Monero: a self-serve page

1. Pick a quantity; the page shows the XMR price, fixed for one hour, and a
   fresh subaddress per order (with a QR code).
2. The browser makes and blinds the tokens and keeps them.
3. A **view-only wallet** watches for the payment: it can see money arrive,
   can't spend it. The spend key stays in the owner's phone wallet, so a
   server breach can't steal funds.
4. After ~10 confirmations (~20 min) we sign; the browser unblinds and offers
   the stash as a file and a QR code.
5. No account, email or username anywhere. The order link keeps its secret
   after `#` (never sent to the server) so a buyer can come back.

Decisions taken in the spec (revisit if wrong):

- **Whole vouchers only:** an underpayment gets the whole vouchers it covers;
  the rest is lost (no return address to refund, and a balance would need a
  lasting record).
- **The watch-only wallet runs on its own small Fly machine** (a Worker can't
  run a Monero wallet), not inside the `.services` relay.
- **The page works over Tor** (Cloudflare must not challenge Tor visitors).

Card (Stripe) stays as the convenient, less private option. Mailed cash is
dropped, or kept as an unadvertised last resort.

## Open

- Tax: Monero sales have no collector for sales tax/VAT and no buyer
  country. Ask an accountant.
- Gift-card law: some US states limit voucher expiry and claim unspent
  balances; this may set the minimum validity.
- Small anonymity set early on: with few buyers, timing and amounts can still
  single someone out. Improves with volume.
- Marketplace app prices in vouchers: whole $10 units, or a smaller unit for
  cheap apps. See `services-marketplace.md`.
