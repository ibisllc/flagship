/**
 * iOS gym scenarios: a removed account and the admin-key warnings
 * (apps/mobile/ios/App/UITests/GymAccountGoneTests.swift, docs/account-gone.md).
 * The same scenarios as the webapp's (suites/webGone.ts) plus the Settings
 * Sign out and Remove this device warnings. Mock tier: `-gym-account-gone <s>`
 * feeds the real detector the 404 account-not-found `.com` would send (Debug
 * builds only).
 */

import type { Scenario } from "../scenario.js";
import { iosTotal, shot } from "./helpers.js";

const G = "FlagshipAppUITests/GymAccountGoneTests/";

export const IOS_GONE: readonly Scenario[] = [
  iosTotal(
    "ios-total-account-gone-screen",
    "When .com answers 404 account-not-found for the signed-in device's own account, a full-screen This account was removed takes over: every menu closed, nothing behind it reachable, Save my servers' data disabled with Coming soon, then Create a new account and a quiet Remove it from this device.",
    G + "test_removedAccountShowsTheScreenAndClosesWhatWasOpen",
    {
      steps: [
        { kind: "launch", describe: "Reach Home and open the Add/Restore menu." },
        { kind: "assert", describe: "The answer arrives: the menu closes and the screen shows.", handle: "account-gone-title" },
      ],
      assertions: [
        { describe: "Title", handle: "account-gone-title", expect: "text", text: "This account was removed" },
        { describe: "Body", handle: "account-gone-body", expect: "text", text: "This account no longer exists on Flagship. This can happen after a reset." },
        { describe: "Coming soon", handle: "account-gone-coming-soon", expect: "text", text: "Coming soon" },
        { describe: "Create", handle: "account-gone-create", expect: "text", text: "Create a new account" },
        { describe: "Remove", handle: "account-gone-remove", expect: "text", text: "Remove it from this device" },
      ],
      screenshots: [shot("account-gone", "The This account was removed screen.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-account-gone-not-mine",
    "Another account's account-not-found (a shared server's owner) and a 404 without the code leave the device on Home.",
    G + "test_anotherAccountsNotFoundOrANotFoundWithNoCodeChangesNothing",
    {
      steps: [
        { kind: "launch", describe: "Reach Home." },
        { kind: "assert", describe: "A 404 for another account and a plain 404 for this one: Home stays.", handle: "account-gone" },
      ],
      assertions: [{ describe: "No screen", handle: "account-gone", expect: "absent" }],
      screenshots: [shot("account-gone-not-mine", "Home after another account's 404.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-total-account-gone-remove",
    "Remove it from this device on a device that holds the admin key warns first (Save my data first opens the account backup and removes nothing); only Remove anyway forgets the account and returns to Welcome.",
    G + "test_removeOnAnAdminDeviceWarnsFirstAndOnlyRemoveAnywayRemoves",
    {
      steps: [
        { kind: "launch", describe: "Reach Home on an admin device; the account is answered as gone." },
        { kind: "tap", describe: "Remove it from this device.", handle: "account-gone-remove" },
        { kind: "tap", describe: "Save my data first.", handle: "account-gone-save-first" },
        { kind: "tap", describe: "Remove anyway.", handle: "account-gone-remove-anyway" },
      ],
      assertions: [
        { describe: "Warning", handle: "account-gone-warning-message", expect: "text", text: "This also removes this device's admin key." },
        { describe: "Welcome after Remove anyway", handle: "welcome-create", expect: "present" },
      ],
      screenshots: [shot("account-gone-warning", "The removal warning in place of the buttons."), shot("account-gone-removed", "Welcome after removing.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-account-gone-create",
    "Create a new account on an admin device warns first, then removes the stored account and opens the create flow's name step.",
    G + "test_createANewAccountOnAnAdminDeviceWarnsThenOpensTheCreateFlow",
    {
      steps: [
        { kind: "launch", describe: "Reach Home on an admin device; the account is answered as gone." },
        { kind: "tap", describe: "Create a new account.", handle: "account-gone-create" },
        { kind: "tap", describe: "Remove anyway.", handle: "account-gone-remove-anyway" },
      ],
      assertions: [{ describe: "Create flow", handle: "suggest-username-name", expect: "present" }],
      screenshots: [shot("account-gone-create", "The create flow after Create a new account.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-total-account-gone-no-key",
    "A device that holds no admin key or server key removes at once, with no warning.",
    G + "test_aDeviceThatHoldsNoKeyRemovesAtOnce",
    {
      steps: [
        { kind: "launch", describe: "Reach Home on a device without the admin root; the account is answered as gone." },
        { kind: "tap", describe: "Remove it from this device.", handle: "account-gone-remove" },
      ],
      assertions: [{ describe: "Welcome", handle: "welcome-create", expect: "present" }],
      screenshots: [shot("account-gone-no-key", "Welcome after removing.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-total-signout-admin-warning",
    "Settings Sign out on an admin device whose key is not backed up says it removes the admin key; Save my data first opens the account backup and signs nothing out.",
    G + "test_signOutOnAnAdminDeviceWarnsAndSaveMyDataFirstSignsNothingOut",
    {
      steps: [
        { kind: "launch", describe: "Open Settings on an admin device." },
        { kind: "tap", describe: "Sign out.", handle: "settings-sign-out-btn" },
        { kind: "tap", describe: "Save my data first.", handle: "Save my data first" },
      ],
      assertions: [{ describe: "Account backup opens", handle: "keyfile-export-create", expect: "present" }],
      screenshots: [shot("signout-admin-warning", "The Sign out warning.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-total-signout-backed-up",
    "Settings Sign out after an account-key file was written says what to keep (the file and its passphrase), with Cancel and Sign out.",
    G + "test_signOutAfterAKeyBackupSaysWhatToKeep",
    {
      steps: [
        { kind: "launch", describe: "Open Settings on an admin device that wrote a key file." },
        { kind: "tap", describe: "Sign out, then Sign out.", handle: "settings-sign-out-btn" },
      ],
      assertions: [{ describe: "Welcome", handle: "welcome-create", expect: "present" }],
      screenshots: [shot("signout-backed-up", "The Sign out message once a key file exists.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-total-remove-device-admin-warning",
    "Settings Remove this device on a device that holds the admin key shows the same removal warning (Save my data first, Remove anyway).",
    G + "test_removeThisDeviceInSettingsWarnsOnAnAdminDevice",
    {
      steps: [
        { kind: "launch", describe: "Open Settings on an admin device." },
        { kind: "tap", describe: "Remove this device from account.", handle: "remove-from-account-btn" },
      ],
      assertions: [{ describe: "Warning", handle: "Remove anyway", expect: "present" }],
      screenshots: [shot("remove-device-warning", "The removal warning.")],
      dimension: "D3",
    },
  ),
];
