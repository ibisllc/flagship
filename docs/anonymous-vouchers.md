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

- **One unit: $1** (owner, 2026-10-13), the unit of everything. Pro = 10
  vouchers/month, Pro Max = 20, name change = 10, dibs claim = 20, a
  marketplace app = its price in dollars. Every voucher looks the same at
  redemption, whatever paid for it, so App Store, Play, Monero and card
  buyers all hide in one crowd. A year of Pro is a 120-voucher stash: one
  blind signature each, trivial to issue and store.
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

People buy a stash (e.g. 120 = a year of Pro) once and spend 10 a month. This replaces an
auto-renewing subscription (one long-lived record per Apple ID, every
renewal and cancellation reported to us, so it can't be made private), and
it breaks the timing link: one purchase, redemptions spread over a year.

**The box holds the stash and pays its own bill.** The stash is imported on
the web or in Studio, stored encrypted on the box, included in its backup,
and the box spends 10 vouchers per month (20 for Pro Max). The phone apps
only show the balance ("11 months left").

## Paying through the App Store / Play

- One-time (consumable) products: packs of 10, 30 and 120 vouchers. Apple 3.1.1
  explicitly routes vouchers for digital services through In-App Purchase.
- After purchase the app sends the receipt plus blinded tokens; we verify the
  receipt with Apple/Google, sign the tokens, and the app hands the stash to
  the box. Never set `appAccountToken` (it ties a purchase to an account).
- **No IP addresses logged** on the signing endpoint.
- Apple/Google keep 15% (small-business programs) and handle sales tax/VAT.
- **Apple still knows who paid** (an Apple ID bought Flagship vouchers), just
  not which Flagship account used them. Users who need Apple out of it use
  Monero.
- Vouchers bought outside the store reach the phone apps only one way: a
  "Load into Flagship" voucher link opened from the web shop (owner decision
  for 0.4, see "Voucher links" below). No code field, no QR scan, no file
  picker in the iOS app, and neither phone app links or steers to the web
  shop. Apple allows this under 3.1.3(b) (Multiplatform Services) because the
  same packs are sold as in-app purchases.
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
- Odd totals (a 7-voucher app) make a spend slightly more distinctive than
  a round 10; acceptable.

## Voucher links: web-bought vouchers into an app (0.4, owner decision)

Built on branch `0.4/voucher-link`. Format: `packages/protocol/src/voucherLink.ts`; shared vectors
`packages/protocol/test-vectors/voucher-link/` (TypeScript, webapp, Swift, Kotlin all replay them byte for byte).

**The goal.** A person with only a phone buys vouchers by card on the web shop, in the phone's browser, and loads
them into the app. `.com` must never learn which account a purchase paid for, so the web page asks for no username
and there is no server-side "reload" endpoint: the vouchers travel from the browser to the app inside a link, and the
part that carries them is never sent to any server.

**Buying signed out (webapp).** `https://webapp.<apex>/?shop=buy` (the Pro page's card link) opens the shop with no
account: pick a pack, pay on Stripe Checkout. The order is the ordinary one (`POST /api/vouchers/stripe/checkout`
with the pack, the key and the commitment; no account), kept in `localStorage` under `flagship.shop.signedOut`,
apart from the signed-in orders. Back from Stripe the browser calls `paid-issue`, unblinds, and keeps the vouchers
under `flagship.shop.ready` until the buyer says they are loaded ("They're loaded: forget them here"). It shows:

- **Load into Flagship**: one button per link (`Load into Flagship (part 2 of 4)` for a big purchase);
- **Download voucher file** (the existing `flagship-vouchers` file) and **Copy link(s)**, as fallbacks.

**The link.** `https://<control apex>/app/vouchers#v=<payload>`, an app link under the existing `/app/<route>`
scheme (AASA `/app/*`, Android `pathPrefix="/app/"`). The payload is base64url (no padding) of:

```
version (1) | part | parts | keyId (8 bytes) | count | sigLen (2 bytes, BE)
| count × (prefix 32 | nonce 32 | signature sigLen) | check (4 bytes)
check = first 4 bytes of SHA-256("flagship/voucher-link/v1|" || every byte before it)
```

At most 30 vouchers a link (about 13,000 characters with a 2048-bit key, 23,000 with 4096), grouped by key; a
bigger purchase is several links, each complete on its own and numbered across the purchase (a 120 pack is 4).
Fragments longer than 32,768 characters are refused before decoding.

**Adding (iOS, Android, webapp).** The app parses the link and, with no network call, plans the import
(`planVoucherLinkImport`): each voucher's signature against the voucher keys the device already holds (the keys it
last read from `GET /api/payments/config`, cached on the device; there is no compiled-in key until the release key
ceremony), then the wallet's own spent nullifiers and vouchers. It asks "Add N vouchers ($N) to this account's
wallet?" with Add / Cancel, plus one line per voucher it leaves out (already in this wallet, already spent, not
signed by Flagship, signed with a key this device doesn't know yet). Add puts the new ones in the sealed wallet
(synced end to end as today). Only an admin device of the account adds (the same rule as spending). The spend happens
later through the normal trickle over the OHTTP relay, so the moment the vouchers arrive says nothing to `.com`.

**Store rules.** The phone apps accept vouchers acquired elsewhere only through this incoming link; they never link,
point or steer to the web shop, and the iOS app has no code field, QR scan or voucher file import. Apple 3.1.3(b)
(Multiplatform Services) allows using items bought on the web when the same items are sold as in-app purchases,
which the 10, 30 and 120 packs are. Google Play: the same posture (no steering; Play Billing sells the same packs).
Review notes: `docs/runbooks/0.4-browser-tasks.md` B6 and C5.

**Anti-abuse.** Per-device store-purchase caps (240 vouchers in 30 days) still apply to store purchases; a link adds
nothing new to buy. A link is idempotent per wallet: opening it again adds nothing ("These vouchers are already in
this wallet."), so it needs no server-side memory of being used. A wallet holds at most 500 vouchers; a link that
would pass that adds nothing. A voucher already spent from another wallet can't be seen offline; `.com` refuses it at
the first spend (`voucher-spent`) and the trickle drops it, as for any voucher.

### Failure handling

Owner rule: our own infrastructure failing never breaks the system. Adding needs no network.

| Failure | What happens | Test |
|---|---|---|
| A truncated or altered link (the end cut off by a chat app, a character changed) | The 4-byte check or the length fails: "This voucher link is incomplete or damaged. Open the whole link again, or use the voucher file." Nothing is added. | vectors `parse` ("truncated", "one character changed", …) in all four ports; `webappPlan.test.ts` "failure handling: a truncated link…"; gym web `gym-vouchers.spec.ts`; iOS/Android gym |
| A forged voucher | Its RSA blind signature doesn't verify under the key it names: left out, or "These vouchers aren't signed by Flagship. Nothing was added." when none is good. | vectors `imports` "a forged voucher alone / among good ones"; `webappPlan.test.ts` |
| An already-spent voucher | Spent from this wallet: its nullifier is in `spent`, so it is left out ("These vouchers were already spent."). Spent elsewhere: refused by `.com` at the first spend and dropped. | vectors `imports` "already spent", "one spent, two new"; `webappPlan.test.ts` |
| The app not installed | The OS doesn't hand the link to an app, so the Worker serves the open-in-app page at the same URL (no redirect). Its web-app option carries the whole link, fragment included, to `webapp.<apex>/app/vouchers#v=…`; the webapp keeps it (memory and the tab's sessionStorage), clears the address bar and asks after the unlock. The Download and Copy fallbacks stay on the shop page. | `webappVoucherLink.test.ts` "keeps an /app/vouchers link…"; gym web `gym-vouchers.spec.ts` (the `/app/vouchers` load) |
| The link opened twice | The second plan finds every voucher in the wallet: "These vouchers are already in this wallet. Nothing was added." No server call either time. | vectors `imports` "the same link opened twice"; `voucherLinkVectors.test.ts`; `webappPlan.test.ts`; gym web, iOS, Android |
| Offline | Native apps write the local sealed copy and sync on the next save; the webapp, which has no local wallet, keeps the checked vouchers in a per-account inbox (`flagship.vouchers.inbox.<user>`) that joins the wallet at the next Plan tick. | `webappPlan.test.ts` "failure handling: offline…"; iOS/Android unit tests |
| The device has never read the voucher key | "This device doesn't know the key these vouchers were signed with yet. Open Settings, Plan once while online, then open the link again." | vectors `imports` "no keys held yet"; `webappPlan.test.ts` |
| A link from a newer format | Version byte above 1: "This voucher link needs a newer version of Flagship." | vectors `parse` "a newer version" |

**Open (owner).** Whether to compile the production voucher key into the apps after the key ceremony (today the
apps trust the keys `.com` served them over TLS, cached); the signed-out web shop keeps bearer vouchers in the
browser's `localStorage` until the buyer forgets them (the same exposure as the pending orders); App Review may
still ask about 3.1.3(b), so the review note says it plainly.

