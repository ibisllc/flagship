/**
 * webapp gym scenarios: Settings → Plan (apps/web/e2e/gym/gym-plan.spec.ts, docs/payments-privacy-and-rails.md
 * "As built") and the signed-out voucher shop with its "Load into Flagship" link (apps/web/e2e/gym/gym-vouchers.spec.ts,
 * docs/anonymous-vouchers.md "Voucher links"). Same rules as web.ts: each `harness` is the exact title of a test in that spec.
 */

import type { Scenario } from "../scenario.js";
import { webTotal, shot } from "./helpers.js";

export const WEB_PLAN: readonly Scenario[] = [
  webTotal(
    "web-total-plan-vouchers-and-pro",
    "Settings → Plan on an admin device: the gym's test vouchers fill the balance (shown as round dollars and months, never units), the wallet reaches .com sealed, and choosing Pro asks for the passphrase and spends one voucher with no credential, cookie or device header.",
    "gym plan test vouchers fill the balance and choosing Pro spends one, unlinked",
    {
      steps: [
        { kind: "launch", describe: "Reach Home and open Settings → Plan." },
        { kind: "tap", describe: "Add 30 test vouchers.", handle: "#plan-add-test" },
        { kind: "tap", describe: "Choose Pro and confirm with the passphrase.", handle: "[data-testid=plan-choice-pro]" },
      ],
      assertions: [
        { describe: "Balance after the test issue", handle: "#plan-balance-amount", expect: "text", text: "$29" },
        { describe: "Plan", handle: "#plan-current-name", expect: "text", text: "Pro" },
        { describe: "Shop present (card payments off in this scenario)", handle: "[data-testid=plan-shop]", expect: "present" },
      ],
      screenshots: [shot("plan-empty", "Plan before any voucher."), shot("plan-pro", "Plan on Pro with the balance.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-plan-stripe-shop",
    "Settings → Plan with card payments on: Buy $30 asks .com for a Stripe Checkout Session that names nobody (no credential, cookie or device header), opens Stripe's page, and on the return the paid session's blind signatures fill the balance to $30 while the wallet reaches .com sealed (docs/payments-privacy-and-rails.md §11).",
    "gym plan buying a pack by card goes through Stripe Checkout and fills the balance, unlinked",
    {
      steps: [
        { kind: "launch", describe: "Reach Home and open Settings → Plan with the Stripe rail on." },
        { kind: "tap", describe: "Buy $30.", handle: "[data-testid=plan-pack-30]" },
        { kind: "assert", describe: "Back from Stripe, Plan opens again and asks for the signatures.", handle: "#plan-balance-amount" },
      ],
      assertions: [
        { describe: "Balance after the purchase", handle: "#plan-balance-amount", expect: "text", text: "$30" },
        { describe: "Shop", handle: "[data-testid=plan-shop]", expect: "present" },
      ],
      screenshots: [shot("plan-shop", "Plan's card shop."), shot("plan-bought", "Plan after a card purchase.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-plan-read-only",
    "On a device that isn't an admin of the account, Plan shows the plan and balance read-only: the switches are disabled, there is no test button, and nothing is spent.",
    "gym plan a device that isn't an admin reads the plan and changes nothing",
    {
      steps: [
        { kind: "launch", describe: "Reach Home as a non-admin device and open Settings → Plan." },
        { kind: "assert", describe: "The read-only note shows.", handle: "[data-testid=plan-read-only]" },
      ],
      assertions: [
        { describe: "Read-only note", handle: "[data-testid=plan-read-only]", expect: "present" },
        { describe: "No test button", handle: "#plan-add-test", expect: "absent" },
      ],
      screenshots: [shot("plan-read-only", "Plan read-only on a device that isn't an admin.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-vouchers-shop-signed-out",
    "A browser with no account buys a pack on the voucher shop: Stripe Checkout opens, and on the return the vouchers are offered as a Load into Flagship app link (vouchers only in the fragment), a file and a copy; no request names an account, and with no app installed the link reaches the webapp, which keeps it for after the unlock and clears the address.",
    "gym vouchers a browser with no account buys a pack and gets a Load into Flagship link, unlinked",
    {
      steps: [
        { kind: "launch", describe: "Open the webapp at ?shop=buy with no account." },
        { kind: "tap", describe: "Buy the $10 pack.", handle: "[data-testid=voucher-shop-pack-10]" },
        { kind: "assert", describe: "Back from Stripe, the vouchers are ready.", handle: "[data-testid=voucher-shop-ready]" },
      ],
      assertions: [
        { describe: "Ready line", handle: "[data-testid=voucher-shop-ready]", expect: "text", text: "Your 10 vouchers ($10) are ready." },
        { describe: "Load into Flagship link", handle: "[data-testid=voucher-shop-load]", expect: "present" },
        { describe: "Voucher file download", handle: "[data-testid=voucher-shop-download]", expect: "present" },
      ],
      screenshots: [shot("shop-signed-out", "The voucher shop with no account."), shot("shop-ready", "The vouchers ready as a link, a file and a copy.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-vouchers-link-import",
    "In a signed-in webapp a voucher link asks before adding, adds its vouchers to the sealed wallet without sending any voucher anywhere, opening it again adds nothing, and a truncated link is refused as damaged.",
    "gym vouchers a voucher link adds once, the second open adds nothing, a truncated one is refused",
    {
      steps: [
        { kind: "launch", describe: "Reach Home on an admin device and open Settings → Plan once." },
        { kind: "tap", describe: "Open the voucher link and add.", handle: "[data-testid=voucher-link-add]" },
        { kind: "assert", describe: "Open the same link again, then a truncated one.", handle: "[data-testid=voucher-link-outcome]" },
      ],
      assertions: [
        { describe: "Balance after the link", handle: "#plan-balance-amount", expect: "text", text: "$3" },
        {
          describe: "Truncated link refused",
          handle: "[data-testid=voucher-link-outcome]",
          expect: "text",
          text: "This voucher link is incomplete or damaged. Open the whole link again, or use the voucher file.",
        },
      ],
      screenshots: [shot("link-confirm", "The voucher link asks before adding."), shot("link-damaged", "A truncated voucher link refused.")],
      dimension: "D4",
    },
  ),
];
