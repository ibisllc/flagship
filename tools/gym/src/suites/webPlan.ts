/**
 * webapp gym scenarios: Settings → Plan (apps/web/e2e/gym/gym-plan.spec.ts, docs/payments-privacy-and-rails.md
 * "As built"). Same rules as web.ts: each `harness` is the exact title of a test in that spec.
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
        { describe: "Shop not on sale", handle: "[data-testid=plan-shop]", expect: "present" },
      ],
      screenshots: [shot("plan-empty", "Plan before any voucher."), shot("plan-pro", "Plan on Pro with the balance.")],
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
];
