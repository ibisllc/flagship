/**
 * Android gym scenarios: a removed account (docs/account-gone.md) and the
 * admin-key confirmations of the same screen and of Sign out. Each `harness` is
 * a method of GymAccountGoneTest (apps/mobile/android/app/src/androidTest).
 * NO BACKEND: a scenario flips the state the shared HTTP client sets when .com
 * answers 404 account-not-found.
 */

import type { Scenario } from "../scenario.js";
import { androidTotal, shot } from "./helpers.js";

const PKG = "com.flagshipserver.app.gym";

export const ANDROID_GONE: readonly Scenario[] = [
  androidTotal(
    "android-total-account-gone-screen",
    "When .com answers 404 account-not-found for the signed-in phone's own account, a full-screen This account was removed takes over: every menu closed, the app behind it inaccessible, a line saying a saved backup can be restored into a new account, then Create a new account, then a quiet Remove it from this device.",
    `${PKG}.GymAccountGoneTest#theScreenTakesOverAndTheAppBehindItGoesQuiet`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=home as an admin device and open the Add/Restore menu." },
        { kind: "assert", describe: "The account is reported gone: the menu closes and the screen shows.", handle: "account-gone" },
      ],
      assertions: [
        { describe: "Title", handle: "account-gone-title", expect: "text", text: "This account was removed" },
        { describe: "Restore hint", handle: "account-gone-restore-hint", expect: "text", text: "If you saved a backup of your servers, you can restore it into a new account." },
        { describe: "No rescue button", handle: "account-gone-save", expect: "absent" },
        { describe: "Create", handle: "account-gone-create", expect: "text", text: "Create a new account" },
        { describe: "Remove", handle: "account-gone-remove", expect: "text", text: "Remove it from this device" },
        { describe: "Home is inaccessible", handle: "home-title", expect: "absent" },
      ],
      screenshots: [shot("account-gone", "The This account was removed screen.")],
      dimension: "D4",
    },
  ),
  androidTotal(
    "android-total-account-gone-not-mine",
    "Another account's account-not-found, a 404 without the code and a 401 for this account leave the phone on Home.",
    `${PKG}.GymAccountGoneTest#anotherAccountsNotFoundChangesNothing`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=home." },
        { kind: "assert", describe: "Those answers change nothing; this account's 404 does.", handle: "home-title" },
      ],
      assertions: [{ describe: "No screen", handle: "account-gone", expect: "absent" }],
      screenshots: [shot("not-mine", "Home after answers that are not this account's.")],
      dimension: "D4",
    },
  ),
  androidTotal(
    "android-total-account-gone-remove-no-keys",
    "On a device that holds no admin key and no server key, Remove it from this device signs out at once.",
    `${PKG}.GymAccountGoneTest#removingFromADeviceWithNoKeysSignsOutAtOnce`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=home with no servers." },
        { kind: "tap", describe: "Remove it from this device.", handle: "account-gone-remove" },
        { kind: "assert", describe: "Welcome shows.", handle: "welcome-create" },
      ],
      assertions: [{ describe: "Welcome", handle: "welcome-create", expect: "present" }],
      screenshots: [shot("removed-no-keys", "Welcome after removing.")],
      dimension: "D4",
    },
  ),
  androidTotal(
    "android-total-account-gone-remove-admin-asks",
    "On an admin device, Remove it from this device shows, in place of the buttons, a warning that it also removes the admin key, with Save my account key first (the key backup) and Remove anyway.",
    `${PKG}.GymAccountGoneTest#removingFromAnAdminDeviceWarnsInPlaceOfTheButtonsAndSaveMyDataFirstOpensTheKeyBackup`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=home as an admin device; the account is reported gone." },
        { kind: "tap", describe: "Remove it from this device.", handle: "account-gone-remove" },
        { kind: "assert", describe: "The warning names the admin key.", handle: "account-gone-warning-text" },
        { kind: "tap", describe: "Remove anyway.", handle: "account-gone-remove-anyway" },
      ],
      assertions: [
        { describe: "Warning title", handle: "account-gone-warning-title", expect: "text", text: "Remove this account from this device?" },
        { describe: "Remove anyway", handle: "account-gone-remove-anyway", expect: "text", text: "Remove anyway" },
        { describe: "Welcome at the end", handle: "welcome-create", expect: "present" },
      ],
      screenshots: [shot("remove-asks-first", "The warning in place of the buttons.")],
      dimension: "D4",
    },
  ),
  androidTotal(
    "android-total-account-gone-create-admin-asks",
    "On an admin device, Create a new account shows the same warning, then opens the create step.",
    `${PKG}.GymAccountGoneTest#creatingANewAccountOnAnAdminDeviceWarnsThenOpensTheCreateStep`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=home as an admin device; the account is reported gone." },
        { kind: "tap", describe: "Create a new account.", handle: "account-gone-create" },
        { kind: "tap", describe: "Remove anyway.", handle: "account-gone-remove-anyway" },
      ],
      assertions: [{ describe: "The screen is gone and the create step shows", handle: "account-gone", expect: "absent" }],
      screenshots: [shot("create-after-gone", "The create step.")],
      dimension: "D4",
    },
  ),
  androidTotal(
    "android-total-sign-out-admin-warning",
    "Sign out on an admin device warns that it removes the admin key: save first or sign out anyway until a key file was written, then what to keep.",
    `${PKG}.GymAccountGoneTest#signOutOnAnAdminDeviceWarnsAboutTheAdminKey`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=settings as an admin device." },
        { kind: "tap", describe: "Sign out.", handle: "settings-sign-out-btn" },
        { kind: "assert", describe: "The warning shows.", handle: "settings-sign-out-admin-warning" },
      ],
      assertions: [{ describe: "Warning", handle: "settings-sign-out-admin-warning", expect: "present" }],
      screenshots: [shot("sign-out-admin-warning", "The sign-out confirmation on an admin device.")],
      dimension: "D4",
    },
  ),
  androidTotal(
    "android-total-remove-device-admin-warning",
    "Remove this device in Settings on an admin device shows the same warning, with Save my account key first and Remove anyway.",
    `${PKG}.GymAccountGoneTest#removeThisDeviceOnAnAdminDeviceWarnsFirst`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=settings as an admin device." },
        { kind: "tap", describe: "Remove this device from account.", handle: "settings-remove-device-btn" },
        { kind: "assert", describe: "The warning shows.", handle: "settings-remove-confirm" },
      ],
      assertions: [{ describe: "Remove anyway", handle: "settings-remove-confirm", expect: "text", text: "Remove anyway" }],
      screenshots: [shot("remove-device-admin-warning", "The warning.")],
      dimension: "D4",
    },
  ),
  androidTotal(
    "android-total-remove-device-no-admin-cancel",
    "Remove this device in Settings on a device that is not an admin is the ordinary question and stops at Cancel.",
    `${PKG}.GymSettingsTest#removeDeviceStopsAtCancelOnADeviceThatIsNotAnAdmin`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=settings." },
        { kind: "tap", describe: "Remove this device from account.", handle: "settings-remove-device-btn" },
      ],
      assertions: [{ describe: "Settings stays", handle: "settings-title", expect: "present" }],
      screenshots: [shot("remove-device-cancel", "Settings after Cancel.")],
      dimension: "D4",
    },
  ),
  androidTotal(
    "android-total-sign-out-no-admin-warning",
    "Sign out on a device that is not an admin has no admin-key warning.",
    `${PKG}.GymAccountGoneTest#signOutOnADeviceThatIsNotAnAdminHasNoAdminWarning`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=settings." },
        { kind: "tap", describe: "Sign out.", handle: "settings-sign-out-btn" },
      ],
      assertions: [{ describe: "No warning", handle: "settings-sign-out-admin-warning", expect: "absent" }],
      screenshots: [shot("sign-out-no-admin-warning", "The ordinary sign-out confirmation.")],
      dimension: "D4",
    },
  ),
];
