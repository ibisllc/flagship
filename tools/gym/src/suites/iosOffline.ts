/**
 * iOS gym scenarios: Offline control and "Rescue my data" (docs/data-sovereignty.md), each a
 * method of GymOfflineControlTests (apps/mobile/ios/App/UITests). Mock tier: `-smoke-rescue
 * <scenario>` runs the real view model against an in-process box (GymRescue, Debug builds only):
 * found by its opaque Bonjour id, checked by its pinned key, every action an owner-signed order.
 */

import type { Scenario } from "../scenario.js";
import { iosTotal, shot } from "./helpers.js";

const G = "FlagshipAppUITests/GymOfflineControlTests/";

export const IOS_OFFLINE: readonly Scenario[] = [
  iosTotal(
    "ios-total-offline-found-controls",
    "Settings → Offline control finds the server on this Wi-Fi by its opaque id, checks it by its pinned key with no .com, shows its status and apps, and stops, starts and restarts an app and restarts the server, each a signed order the box checks.",
    G + "test_foundServerConnectsAndEachControlIsSigned",
    {
      steps: [
        { kind: "launch", describe: "Settings, -smoke-rescue found; open Offline control.", handle: "settings-open-offline-control" },
        { kind: "tap", describe: "Connect.", handle: "offline-connect-home" },
        { kind: "tap", describe: "Stop the app, confirm; Start; Restart, confirm; Restart the server, confirm.", handle: "offline-app-stop-" },
      ],
      assertions: [
        { describe: "Connected by key", handle: "offline-connected-title", expect: "present" },
        { describe: "Status card", handle: "offline-status", expect: "present" },
        { describe: "Server restarting notice", handle: "offline-notice", expect: "text", text: "The server is restarting. To unlock its disk it needs Flagship, so while Flagship can't be reached it stays locked after the restart." },
      ],
      screenshots: [shot("offline-connected", "Connected: status, apps, controls."), shot("offline-server-restarting", "After Restart the server.")],
      dimension: "D6",
    },
  ),
  iosTotal(
    "ios-total-offline-not-found",
    "Nothing answers on the Wi-Fi and nothing was seen before: the screen says so, and a typed name and address connects.",
    G + "test_notFoundSaysSoAndATypedAddressConnects",
    {
      steps: [
        { kind: "launch", describe: "Settings, -smoke-rescue not-found; open Offline control; Connect.", handle: "offline-connect-home" },
        { kind: "type", describe: "The server's name and 192.168.1.20; Connect to this address.", handle: "offline-manual-connect" },
      ],
      assertions: [
        { describe: "Not found", handle: "offline-error", expect: "present" },
        { describe: "The typed address connects", handle: "offline-connected-title", expect: "present" },
      ],
      screenshots: [shot("offline-not-found", "Not found on this Wi-Fi.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-offline-wrong-key",
    "A machine that answers but can't prove the server's pinned key is refused before anything is signed or sent.",
    G + "test_aMachineWithAnotherKeyIsNotYourServer",
    {
      steps: [{ kind: "launch", describe: "-smoke-rescue wrong-key; Connect.", handle: "offline-connect-home" }],
      assertions: [{ describe: "Not your server", handle: "offline-error", expect: "present" }, { describe: "Not connected", handle: "offline-connected-title", expect: "absent" }],
      screenshots: [shot("offline-wrong-key", "Refused: not your server.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-total-offline-expired-cert",
    "An expired web certificate doesn't stop rescue: the server is checked by its key and the screen says so.",
    G + "test_anExpiredCertificateStillWorksByKey",
    {
      steps: [{ kind: "launch", describe: "-smoke-rescue expired-cert; Connect.", handle: "offline-connect-home" }],
      assertions: [{ describe: "Connected", handle: "offline-connected-title", expect: "present" }, { describe: "Certificate note", handle: "offline-cert-note", expect: "present" }],
      screenshots: [shot("offline-expired-cert", "Connected with an expired certificate.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-offline-rescue-resume",
    "Rescue my data: the passcode must be saved first, the backup is made, the download breaks halfway, and Resume finishes it from the parts already in.",
    G + "test_anInterruptedDownloadResumes",
    {
      steps: [
        { kind: "tap", describe: "Rescue my data; I've saved the passcode; Make and download the backup.", handle: "offline-backup-start" },
        { kind: "tap", describe: "Resume the download.", handle: "offline-backup-resume" },
      ],
      assertions: [{ describe: "Interrupted", handle: "offline-backup-interrupted", expect: "present" }, { describe: "Saved", handle: "offline-backup-saved", expect: "present" }],
      screenshots: [shot("offline-download-interrupted", "The download stopped halfway."), shot("offline-backup-saved", "The .flagship file is saved.")],
      dimension: "D6",
    },
  ),
  iosTotal(
    "ios-total-offline-stranger",
    "A device whose key the server doesn't pin is refused, and the screen shows the server's own sentence.",
    G + "test_theServerRefusesAStrangerInItsOwnWords",
    {
      steps: [{ kind: "launch", describe: "-smoke-rescue stranger; Connect.", handle: "offline-connect-home" }],
      assertions: [{ describe: "The box's refusal", handle: "offline-error", expect: "present" }],
      screenshots: [shot("offline-stranger", "The server refuses the session.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-total-account-gone-save-data",
    "This account was removed puts Save my servers' data first, and it opens Offline control, which still reaches the server with the account gone.",
    G + "test_theAccountGoneScreenOffersToSaveTheServersData",
    {
      steps: [
        { kind: "launch", describe: "Admin device; the account is answered as gone.", handle: "account-gone-save" },
        { kind: "tap", describe: "Save my servers' data; Connect.", handle: "offline-connect-home" },
      ],
      assertions: [{ describe: "Save my servers' data", handle: "account-gone-save", expect: "text", text: "Save my servers' data" }, { describe: "Connected", handle: "offline-connected-title", expect: "present" }],
      screenshots: [shot("account-gone-save", "The removed-account screen with Save my servers' data first.")],
      dimension: "D4",
    },
  ),
];
