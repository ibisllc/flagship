/**
 * webapp gym scenarios: onboarding, the cover, the wizard and their prompts
 * (apps/web/e2e/gym/gym-onboarding.spec.ts). Same rules as web.ts: each
 * `harness` is the exact title of a test in that spec.
 */

import type { Scenario } from "../scenario.js";
import { webTotal, shot } from "./helpers.js";

export const WEB_ONBOARDING: readonly Scenario[] = [
  webTotal(
    "web-total-onboarding-create-account",
    "Create a new account to the end: both passphrases, the random handle sheet with ↻ Try another, Name this account (empty refused) and Name this device, then the account-open POST, checked as .com checks it: the username claim under the IRK, the account profile under the admin root it publishes (not the IRK), the device profile under the device key, the names only as ciphertext; lands on Secure your account as an admin device.",
    "gym onboarding creates an account to the end with a suggested handle and its two names",
    {
      steps: [
        { kind: "tap", describe: "Create a new account → passphrase ×2.", handle: "#bootstrap-create" },
        { kind: "tap", describe: "Try another, then Continue.", handle: "[data-suggest-regen]" },
        { kind: "type", describe: "Name the account and the device.", handle: ".modal-input" },
        { kind: "assert", describe: "POST /api/accounts with valid signatures; the wizard's secure step.", handle: "#view-wizard" },
      ],
      assertions: [
        { describe: "Second handle shown after Try another", handle: "[data-suggest-name]", expect: "present" },
        { describe: "Secure your account", handle: "#view-wizard .card-title", expect: "text", text: "Secure your account" },
      ],
      screenshots: [shot("handle-sheet", "The handle sheet."), shot("account-opened-secure-step", "The secure step.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-onboarding-cancels",
    "Cancel at the passphrase prompt makes no key; a short passphrase and a mismatch are refused in the prompts; Cancel on the handle sheet or at Name this device opens no account (no POST /api/accounts); the trade-offs link is a real link.",
    "gym onboarding Cancel on the passphrase prompt or the handle sheet opens no account",
    {
      steps: [
        { kind: "tap", describe: "Create → Cancel.", handle: "[data-modal-cancel]" },
        { kind: "tap", describe: "Create → passphrases → handle sheet Cancel.", handle: "[data-suggest-name]" },
      ],
      assertions: [{ describe: "Still on the cover", handle: "#view-bootstrap", expect: "present" }],
      screenshots: [shot("handle-sheet-cancel", "The sheet before Cancel.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-onboarding-wizard-skips",
    "The wizard's secure step offers the passkey (pre-chosen) and the backup file; Skip asks 'Skip backup?' (Back stays, Skip anyway moves on); each later step skips (recovery twice, add server, peer-backup Maybe later, Finish) to Home, leaving Home's reminder on and no peer-backup 'no'.",
    "gym onboarding the secure step's Skip asks first, then each later step skips to Home",
    {
      steps: [
        { kind: "tap", describe: "Switch the backup method radios.", handle: "#wizard-secure-file" },
        { kind: "tap", describe: "Skip → Back, Skip → Skip anyway.", handle: "#wizard-secure-skip" },
        { kind: "tap", describe: "Skip recovery ×2, Skip add server, Maybe later, Finish.", handle: "#wizard-skip-demo" },
      ],
      assertions: [{ describe: "Home", handle: "#view-home", expect: "present" }],
      screenshots: [shot("wizard-secure", "The secure step."), shot("wizard-finish", "The last step.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-onboarding-wizard-keyfile",
    "Choosing the backup file and Continue runs the .flagshipkey ceremony; once the file downloads the step is done and no reminder is pinned.",
    "gym onboarding the secure step's backup file runs the key file ceremony and advances",
    {
      steps: [
        { kind: "tap", describe: "Backup file → Continue.", handle: "#wizard-secure-continue" },
        { kind: "type", describe: "Strong passphrase ×2, every acknowledgement, Create.", handle: "[data-pass1]" },
      ],
      assertions: [{ describe: "Next step", handle: "#view-wizard .card-title", expect: "text", text: "Set recovery passphrase" }],
      screenshots: [shot("wizard-keyfile-ceremony", "The ceremony.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-onboarding-wizard-actions",
    "The wizard's action buttons open their screens: Set up recovery → Recovery, Add a server → the create form, Enable peer-backup → Peer-backup (recorded 'enabled'); No thanks records 'declined' and moves on.",
    "gym onboarding Set up recovery, Add a server, peer-backup Enable and No thanks open their screens",
    {
      steps: [
        { kind: "tap", describe: "Set up recovery.", handle: "#wizard-go-recovery" },
        { kind: "tap", describe: "Add a server.", handle: "#wizard-go-create-server" },
        { kind: "tap", describe: "Enable peer-backup; No thanks.", handle: "#wizard-pb-enable" },
      ],
      assertions: [
        { describe: "Recovery", handle: "#view-recovery", expect: "present" },
        { describe: "Create form", handle: "#view-create-server", expect: "present" },
        { describe: "Peer-backup", handle: "#view-peer-backup", expect: "present" },
      ],
      screenshots: [shot("wizard-add-server", "The create form from the wizard.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-onboarding-wizard-username",
    "Generate moves on to the username step; a malformed name is refused; a taken one shows the taken panel with the trademark mailto link and sends nothing; a free one asks both names, opens the account (valid signatures, admin root, not the IRK) and moves to Secure your account.",
    "gym onboarding the username step refuses a bad name, shows a taken one with the trademark link, then opens the account",
    {
      steps: [
        { kind: "tap", describe: "Generate.", handle: "#wizard-go-bootstrap" },
        { kind: "type", describe: "AB, then taken, then ourhouse.", handle: "#wizard-username-input" },
        { kind: "tap", describe: "Open my account.", handle: "#wizard-go-username" },
      ],
      assertions: [
        { describe: "Trademark link", handle: "#wizard-trademark-claim", expect: "present" },
        { describe: "Secure step", handle: "#view-wizard .card-title", expect: "text", text: "Secure your account" },
      ],
      screenshots: [shot("wizard-username-taken", "The taken panel.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-onboarding-signin-paths",
    "Sign in: a malformed name is refused (Enter or the button) before any lookup; an unknown name says 'No account by that name'; a taken name lists the ways back in with the passkey off and why; Scan a pairing code's Cancel does nothing and a link opens the join screen; Import a key file opens Recovery.",
    "gym onboarding signing in: an unknown name, a taken name's access options, and a pairing code",
    {
      steps: [
        { kind: "type", describe: "AB + Enter; nobodyhere; harry.", handle: "#bootstrap-username" },
        { kind: "tap", describe: "Scan a pairing code; Import a key file.", handle: "[data-access]" },
      ],
      assertions: [
        { describe: "Access options", handle: "#bootstrap-access", expect: "present" },
        { describe: "Join screen", handle: "#view-join", expect: "present" },
      ],
      screenshots: [shot("signin-access-options", "The access options.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-onboarding-signin-multi",
    "A multi-device account's 'Recover with your passkey' explains the 24-hour take-over (Cancel stops), then asks for a recovery code (empty refused); Cancel sends nothing to .com and leaves no key.",
    "gym onboarding a multi-device account asks for a recovery code before taking over, and Cancel sends nothing",
    {
      steps: [
        { kind: "tap", describe: "Recover → Cancel; Recover → Take over.", handle: '[data-access="recover"]' },
        { kind: "assert", describe: "Recovery code prompt.", handle: ".modal-title" },
      ],
      assertions: [{ describe: "Still on the cover", handle: "#view-bootstrap", expect: "present" }],
      screenshots: [shot("signin-recovery-code", "The recovery code prompt.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-onboarding-signin-demo",
    "Signing in to a demo account name joins it as a fresh device (no claim, no account POST) and lands on Home with its demo server.",
    "gym onboarding signing in to a demo account joins it and lands on Home",
    {
      steps: [{ kind: "type", describe: "gymdemo → Sign in.", handle: "#bootstrap-continue" }],
      assertions: [{ describe: "Home", handle: "#view-home", expect: "present" }],
      screenshots: [shot("signin-demo-home", "The demo's Home.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-onboarding-reopen-after-reload",
    "A new account reopens after a reload with the passphrase the owner chose, as the same admin device (opening the account used to re-wrap the key under a random passphrase and leave the admin root behind).",
    "gym onboarding a new account unlocks again with its passphrase after a reload",
    {
      steps: [
        { kind: "launch", describe: "Create an account to the end." },
        { kind: "tap", describe: "Reload and unlock with the passphrase.", handle: "#unlock-go" },
      ],
      assertions: [{ describe: "Unlocked", handle: "#toast", expect: "present" }],
      screenshots: [shot("account-reopened", "After the reload.")],
      dimension: "D1",
    },
  ),
];
