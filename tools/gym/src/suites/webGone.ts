/**
 * webapp gym scenarios: a removed account (apps/web/e2e/gym/gym-gone.spec.ts,
 * docs/account-gone.md). Same rules as web.ts: each `harness` is the exact
 * title of a test in that spec. The iOS and Android rows join these when the
 * ports land (parity/features.json: account-gone).
 */

import type { Scenario } from "../scenario.js";
import { webTotal, shot } from "./helpers.js";

export const WEB_GONE: readonly Scenario[] = [
  webTotal(
    "web-total-account-gone-screen",
    "When .com answers 404 account-not-found for the signed-in browser's own account, a full-screen This account was removed takes over: every menu and dialog closed, the page behind it inert, nothing more sent for that account, and no error toast.",
    "gym account-gone a removed account shows This account was removed and stops asking",
    {
      steps: [
        { kind: "launch", describe: "Reach Home and open the Add/Restore menu." },
        { kind: "assert", describe: "Home's next read answers account-not-found: the menu closes and the screen shows.", handle: "#account-gone" },
        { kind: "assert", describe: "Twelve more reads and a token mint for that account send nothing.", handle: "#account-gone" },
      ],
      assertions: [
        { describe: "Title", handle: "#account-gone-title", expect: "text", text: "This account was removed" },
        { describe: "Body", handle: "[data-testid=account-gone-body]", expect: "text", text: "This account no longer exists on Flagship. This can happen after a reset." },
        { describe: "Save leads", handle: "[data-testid=account-gone-save]", expect: "text", text: "Save my servers' data" },
        { describe: "Coming soon until the rescue flow lands", handle: "[data-testid=account-gone-save-soon]", expect: "text", text: "Coming soon" },
        { describe: "Create", handle: "[data-testid=account-gone-create]", expect: "text", text: "Create a new account" },
        { describe: "Remove", handle: "[data-testid=account-gone-remove]", expect: "text", text: "Remove it from this browser" },
      ],
      screenshots: [shot("account-gone", "The This account was removed screen over an inert Home.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-account-gone-not-mine",
    "Another account's account-not-found (a shared server's owner) and a 404 without the code leave the browser on Home.",
    "gym account-gone another account's 404, or a 404 with no code, changes nothing",
    {
      steps: [
        { kind: "launch", describe: "Reach Home." },
        { kind: "assert", describe: "A 404 account-not-found for another account and a plain 404 for this one: Home stays.", handle: "#view-home" },
      ],
      assertions: [{ describe: "No screen", handle: "#account-gone", expect: "absent" }],
      screenshots: [shot("account-gone-not-mine", "Home after another account's 404.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-account-gone-remove",
    "Remove it from this browser, on a device that holds an admin key, first asks (Save my data first / Remove anyway); Save my data first opens the key backup and removes nothing; Remove anyway forgets the stored account (keys, profile, caches), returns to the welcome view, and a reload no longer asks to unlock it.",
    "gym account-gone Remove it from this browser forgets the account and returns to the welcome view",
    {
      steps: [
        { kind: "launch", describe: "Reach Home; the account is answered as gone." },
        { kind: "tap", describe: "Remove it from this browser.", handle: "[data-testid=account-gone-remove]" },
        { kind: "assert", describe: "The welcome view shows; after a reload it still does.", handle: "[data-testid=welcome-create]" },
      ],
      assertions: [
        { describe: "Welcome", handle: "[data-testid=welcome-create]", expect: "present" },
        { describe: "Screen gone", handle: "#account-gone", expect: "absent" },
      ],
      screenshots: [shot("account-gone-removed", "The welcome view after removing the account.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-account-gone-create",
    "Create a new account asks the same first, then removes the stored account and opens the create flow's passphrase step.",
    "gym account-gone Create a new account removes the old one and opens the create flow",
    {
      steps: [
        { kind: "launch", describe: "Reach Home; the account is answered as gone." },
        { kind: "tap", describe: "Create a new account.", handle: "[data-testid=account-gone-create]" },
        { kind: "assert", describe: "The passphrase step of the create flow is open.", handle: ".modal-input" },
      ],
      assertions: [{ describe: "Screen gone", handle: "#account-gone", expect: "absent" }],
      screenshots: [shot("account-gone-create", "The create flow after Create a new account.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-account-gone-no-key",
    "A device that holds no admin key and no server key removes the account at once, with no warning.",
    "gym account-gone a device that holds no admin key or server key removes at once",
    {
      steps: [
        { kind: "launch", describe: "Reach Home with no admin key and no server session; the account is answered as gone." },
        { kind: "tap", describe: "Remove it from this browser.", handle: "[data-testid=account-gone-remove]" },
        { kind: "assert", describe: "No warning; the welcome view shows.", handle: "[data-testid=welcome-create]" },
      ],
      assertions: [{ describe: "No warning", handle: "[data-testid=account-gone-confirm]", expect: "absent" }],
      screenshots: [shot("account-gone-no-key", "The welcome view after an immediate removal.")],
      dimension: "D3",
    },
  ),
];
