/**
 * webapp gym scenarios: the remaining account, device and tool screens
 * (apps/web/e2e/gym/gym-misc.spec.ts). Same rules as web.ts: each `harness`
 * is the exact title of a test in that spec. Signed requests are re-verified
 * over the webapp's canonical bytes; sensitive ones under the admin root.
 */

import type { Scenario, Dimension } from "../scenario.js";
import { webTotal, shot } from "./helpers.js";

type Check = { describe: string; handle: string; expect: "present" | "absent" | "enabled" | "disabled" | "text"; text?: string };

const row = (id: string, goal: string, title: string, tap: string, checks: Check[], shots: [string, string][], dimension: Dimension = "D3"): Scenario =>
  webTotal(id, goal, title, {
    steps: [
      { kind: "launch", describe: "Reach the screen by clicking from Home or Settings (mocked .com and box)." },
      { kind: "tap", describe: "Press the controls under test.", handle: tap },
    ],
    assertions: checks,
    screenshots: shots.map(([i, d]) => shot(i, d)),
    dimension,
  });

export const WEB_MISC: readonly Scenario[] = [
  row(
    "web-total-misc-security-print-rotate",
    "Account security: Print on the recovery-codes step prints; Rotate admin key can be declined, a wrong phrase cancels it, and ROTATE posts admin-root-rotation/v1 signed by the OLD root, after which the session signs with the new one.",
    "gym misc account security prints the recovery codes and rotates the admin key under the old root",
    "#account-security-rotate-admin",
    [{ describe: "Rotate offered on an admin device", handle: '[data-account-security-rotate="available"]', expect: "present" }],
    [["security-print", "Recovery codes with Print."], ["security-rotated", "After the rotation."]],
    "D4",
  ),
  row(
    "web-total-misc-security-rotate-non-admin",
    "A non-admin device sees why it can't rotate the admin key, and no Rotate button.",
    "gym misc a non-admin device can't rotate the admin key",
    "#settings-tab-account-security",
    [
      { describe: "Explanation", handle: '[data-account-security-rotate="unavailable"]', expect: "present" },
      { describe: "No Rotate", handle: "#account-security-rotate-admin", expect: "absent" },
    ],
    [["security-rotate-non-admin", "The non-admin card."]],
    "D4",
  ),
  row(
    "web-total-misc-devices-managed-names",
    "Trusted devices (admin): Set managed name (decline, then name + lock) PUTs an admin-root-signed encrypted managed profile and the row shows it locked; Remove managed name DELETEs it; Edit account name refuses a blank name, then PUTs an admin-root-signed account profile and the header shows it.",
    "gym misc trusted devices: an admin sets, locks and removes a managed name and renames the account",
    "[data-managed-name]",
    [{ describe: "Edit account name", handle: "#edit-account-display-name", expect: "present" }],
    [["devices-managed-locked", "Managed · locked."], ["devices-account-renamed", "Account renamed."]],
    "D4",
  ),
  row(
    "web-total-misc-devices-non-admin",
    "Trusted devices on a non-admin device: no managed-name or account-name controls, only renaming this device.",
    "gym misc trusted devices on a non-admin device has no managed names or account name",
    "#settings-tab-trusted-devices",
    [
      { describe: "No managed names", handle: "[data-managed-name]", expect: "absent" },
      { describe: "No account name", handle: "#edit-account-display-name", expect: "absent" },
    ],
    [["devices-non-admin", "The non-admin list."]],
    "D4",
  ),
  row(
    "web-total-misc-add-device-non-admin",
    "Adding a device is for admin devices only: a non-admin device sees Add device disabled with the line \"Only an admin device of this account can add devices.\" and never opens a pairing code.",
    "gym misc a non-admin device can't add a device",
    "#settings-tab-trusted-devices",
    [
      { describe: "Add device disabled", handle: "#trusted-devices-add", expect: "disabled" },
      { describe: "Admin-only line", handle: "#trusted-devices-add-note", expect: "text", text: "Only an admin device of this account can add devices." },
    ],
    [["add-device-non-admin", "Add device disabled on a non-admin device."]],
  ),
  row(
    "web-total-misc-add-device-new-code",
    "Add a device: New code starts a fresh pairing (a different join link); Back returns to Trusted devices.",
    "gym misc add a device's New code starts a fresh pairing link",
    "#add-device-restart",
    [{ describe: "Join link", handle: "#add-device-link", expect: "present" }],
    [["add-device-new-code", "After New code."]],
  ),
  row(
    "web-total-misc-recovery",
    "Recovery: View progress opens the re-attach report; Remove cloud recovery (Cancel, then Remove) DELETEs the record IRK-signed over its stored hash and the pill reads off; the legacy wrapped key exports as a file (not the key itself) and imports back.",
    "gym misc recovery: re-attach progress, removing cloud recovery, and a wrapped key exported and imported back",
    "#recovery-cloud-remove",
    [{ describe: "Cloud recovery off", handle: "#recovery-cloud-pill", expect: "text", text: "off" }],
    [["recovery-cloud-removed", "Cloud recovery removed."], ["recovery-wrapped-imported", "Wrapped key imported."]],
  ),
  row(
    "web-total-misc-backup-file-takeover",
    "A .flagshipkey backup file: Open backup file refuses an empty passphrase, Lock this browser refuses a short one, then the restore initiates the re-pair (rotated key signs, registered key proves) and the grace sheet counts down with Finish now off.",
    "gym misc a backup file brings this browser into the account and starts the takeover's grace",
    "#recovery-keyfile-input",
    [
      { describe: "Grace line", handle: "[data-grace-line]", expect: "present" },
      { describe: "Finish now off", handle: "[data-grace-finish]", expect: "disabled" },
    ],
    [["keyfile-grace", "The grace sheet."]],
    "D4",
  ),
  row(
    "web-total-misc-backup-file-takeover-finish",
    "A backup file's takeover after its grace: Finish now posts re-pair/complete naming the rotated key the initiate installed, signed by that key; the sheet closes and the browser signs with the rotated key from then on.",
    "gym misc a backup file's takeover finishes once its grace has passed",
    "[data-grace-finish]",
    [{ describe: "Finish now", handle: "[data-grace-finish]", expect: "enabled" }],
    [["keyfile-grace-ready", "Finish now armed."]],
    "D4",
  ),
  row(
    "web-total-misc-profiles-none",
    "Profiles with none: 'No profiles yet' and Set one up opens the account cover.",
    "gym misc profiles with none offers Set one up, which opens the account cover",
    "#profiles-set-up",
    [{ describe: "Account cover", handle: "#view-bootstrap", expect: "present" }],
    [["profiles-none", "No profiles."]],
  ),
  row(
    "web-total-misc-companion-requests",
    "Companion requests: the Settings row's badge counts pending requests; Deny resolves without signing; Approve signs the name release under the admin root, then resolves; the badge clears.",
    "gym misc companion requests: the Settings badge counts them, Deny and Approve resolve them",
    '[data-action="approve"]',
    [{ describe: "Badge", handle: "#companion-requests-badge", expect: "present" }],
    [["settings-companion-badge", "The badge."]],
    "D4",
  ),
  row(
    "web-total-misc-default-model",
    "AI keys: a saved key's Default model menu asks the current server for that key's models and saves the chosen one on this device.",
    "gym misc a saved key's default model is picked from its menu in AI keys",
    "[data-default-model-for] .mm-trigger",
    [{ describe: "Model rows", handle: "[data-mm-model]", expect: "present" }],
    [["default-model-menu", "The menu."]],
  ),
  row(
    "web-total-misc-privacy-about-links",
    "Privacy's disclosure link and About's flagshipserver.com and Security report links open in a new tab at their addresses.",
    "gym misc Privacy and About open their links in a new tab",
    "#view-privacy a.pill",
    [{ describe: "About", handle: "#view-about", expect: "present" }],
    [["links", "Failure frame only; the new tabs are checked by URL."]],
  ),
  row(
    "web-total-misc-peer-backup",
    "Peer-backup (from Settings): the v2 status shows the state, 'pieces safe', the servers holding the pieces as Server 1..n (never named) with their last proof, what the server keeps for others and, once a backup is at risk, the restore-by date; Refresh re-reads; a pre-v2 box says it needs an update; there is no toggle (peer backup is a backup policy).",
    "gym misc peer-backup shows the v2 status from its Settings row, holders as Server n",
    "[data-pb-holder]",
    [{ describe: "Holders", handle: "[data-pb-holder]", expect: "present" }],
    [["peer-backup-v2", "The v2 status."]],
  ),
  row(
    "web-total-misc-take-over-cancel",
    "Take over a box: Cancel closes the dialog with nothing sent; Scan QR is offered only when the browser has a camera API (and says why when no camera answers).",
    "gym misc the take-over dialog's Cancel closes it, and Scan is offered only with a camera API",
    "[data-claim-cancel]",
    [{ describe: "Home", handle: "#view-home", expect: "present" }],
    [["take-over-dialog", "The dialog."]],
  ),
  row(
    "web-total-misc-pod-pair-unpair",
    "Home → Advanced → Enter a server URL: Unpair asks first (Cancel keeps it); Forget clears this device's server address and session.",
    "gym misc pod pair forgets the server only after Unpair is confirmed",
    "#pod-pair-unpair",
    [{ describe: "Not paired", handle: "#pod-pair-status", expect: "text", text: "Not paired with any server yet" }],
    [["pod-unpaired", "Unpaired."]],
  ),
  row(
    "web-total-misc-remote-link",
    "Settings → Remote: Open the remote page opens remote.<apex> in a new tab.",
    "gym misc Remote opens the remote page in a new tab",
    "#view-companion-dock a",
    [{ describe: "Remote screen", handle: "#view-companion-dock", expect: "present" }],
    [["remote-link", "Failure frame only; the new tab is checked by URL."]],
  ),
  row(
    "web-total-misc-process-url",
    "Settings → Process URL: a non-access link is refused; an access link asks 'Open notes on home?'; Open signs the knock with this account device's key (visitorAID = device key) and shows Signed in with the app link; Manage secured sessions lists it; a locked device is sent to unlock.",
    "gym misc Process URL signs a browser in to an app with this device's key",
    "#aa-authorize",
    [{ describe: "Open link", handle: "#aa-open", expect: "present" }],
    [["process-url-confirm", "The confirm."], ["process-url-signed-in", "Signed in."]],
    "D4",
  ),
  row(
    "web-total-misc-process-url-open",
    "Process URL's Open goes to the app's address.",
    "gym misc Process URL's Open goes to the app",
    "#aa-open",
    [{ describe: "Open link", handle: "#aa-open", expect: "present" }],
    [["process-url-open", "Failure frame only; the navigation is checked by URL."]],
  ),
  row(
    "web-total-misc-invite-no-account",
    "An invite link on a browser with no account says so, and Set up an account opens the account cover.",
    "gym misc an invite link on a browser with no account offers Set up an account",
    "#ir-setup",
    [{ describe: "Account cover", handle: "#view-bootstrap", expect: "present" }],
    [["invite-no-account", "No account yet."]],
  ),
  row(
    "web-total-misc-invite-open-it",
    "After accepting an invite, Open it goes to the app's server.",
    "gym misc an accepted invite's Open it goes to the app's server",
    "#ir-open",
    [{ describe: "Open it", handle: "#ir-open", expect: "present" }],
    [["invite-open-it", "Failure frame only; the navigation is checked by URL."]],
  ),
  row(
    "web-total-misc-browser-viewer",
    "An app with a browser bundle: Open browser viewer lists its tabs, Refresh re-reads them, Stream shows the tab's frames and sends input back down the stream.",
    "gym misc the browser viewer lists an app's tabs, refreshes them and streams one",
    "#bv-refresh",
    [{ describe: "Streaming", handle: "#bv-stream-status", expect: "text", text: "streaming tab t1" }],
    [["browser-viewer-stream", "Streaming."]],
  ),
  row(
    "web-total-misc-create-recipe",
    "Create a server (from Add/Import): name, a 12-hour expiry and 'Authorize each boot' produce a downloaded, secret-free recipe whose AuthCode is IRK-signed, pins the admin root and is approved by it; the RCK is registered under the admin root; Follow its setup opens the pending view on the order's own status.",
    "gym misc create server mints a recipe with its expiry and boot mode, approved under the admin root",
    "#cs-download-recipe",
    [{ describe: "Downloaded", handle: "#cs-status", expect: "text", text: "Recipe downloaded — open it in Flagship Studio." }],
    [["create-server-recipe", "Recipe downloaded."]],
    "D4",
  ),
  row(
    "web-total-misc-join-second-browser",
    "Two browsers through a mocked qr-pipe relay: Add a device's link opens /join in the other, which first asks for the passphrase that locks this browser (a short one refused, then typed twice); both show the same code, each confirms, the admin's IRK-signed admit is verified and posted, the new browser joins under review, and Open <account> leaves the join screen signed in to the account. After a reload the lock screen refuses a wrong passphrase and the chosen one opens the same account key.",
    "gym misc a second browser joins the account through Add a device, opens it, and unlocks it after a reload",
    "#join-open",
    [{ describe: "Admin confirm", handle: "#add-device-confirm", expect: "present" }],
    [["join-admin-sas", "The admin's code."], ["join-under-review", "The new browser under review."], ["join-reload-unlocked", "Unlocked after a reload with the chosen passphrase."]],
    "D4",
  ),
];
