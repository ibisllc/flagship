/**
 * webapp gym scenarios: backup/clone, import and migrate
 * (apps/web/e2e/gym/gym-archive.spec.ts). Same rules as web.ts: each
 * `harness` is the exact title of a test in that spec. Sensitive orders are
 * answered as `.com` / an admin-pinned box answers them (gymKit `sensitive`):
 * admin root only, the IRK refused; a demo account keeps the IRK.
 */

import type { Scenario } from "../scenario.js";
import { webTotal, shot } from "./helpers.js";

export const WEB_ARCHIVE: readonly Scenario[] = [
  webTotal(
    "web-total-archive-backup-suggested",
    "Backup/clone server from Home → server card → Backup: the suggested passcode copies to the clipboard, Make the backup waits for 'I've saved the passcode', the box gets the archive id, key and both slots (passcode + account), progress then 'Backup ready' with the left-out app named; Copy download link copies the box's link; Download both files sends an admin-root-signed flagship/archive-download/v1 approval and starts both downloads; Delete from server removes the box's copy; Close closes.",
    "gym archive backup from Home makes a sealed backup with the suggested passcode and downloads both files",
    {
      steps: [
        { kind: "tap", describe: "Home → server card → Backup/clone server.", handle: "#backup-start-btn" },
        { kind: "tap", describe: "Copy the suggested passcode.", handle: "[data-bk-copy-pass]" },
        { kind: "tap", describe: "Tick 'I've saved the passcode', Make the backup.", handle: "[data-bk-go]" },
        { kind: "tap", describe: "Copy download link.", handle: "[data-bk-copy]" },
        { kind: "tap", describe: "Download both files.", handle: "[data-bk-save]" },
        { kind: "tap", describe: "Delete from server, then Close.", handle: "[data-bk-remove]" },
      ],
      assertions: [
        { describe: "Ready", handle: "[data-bk-status]", expect: "text", text: "Backup ready" },
        { describe: "Left-out app named", handle: "[data-bk-error]", expect: "text", text: "Left out" },
      ],
      screenshots: [
        shot("backup-passcode", "The passcode step."),
        shot("backup-ready", "The ready backup."),
        shot("backup-removed", "After Delete from server."),
      ],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-archive-backup-own-passcode",
    "Backup with my own passcode: the rule line refuses a short one, one kind of character and a mismatch, says Good. for a strong match; Use the suggested passcode and back; the box's 'needs about 12 GB' refusal shows in its own words.",
    "gym archive backup with my own passcode checks it and shows the box's refusal",
    {
      steps: [
        { kind: "tap", describe: "Use my own passcode instead.", handle: "[data-bk-own]" },
        { kind: "type", describe: "Weak, mismatched, then a good passcode.", handle: "#bk-pass1" },
        { kind: "tap", describe: "Use the suggested passcode, then own again.", handle: "[data-bk-use-suggested]" },
        { kind: "tap", describe: "Make the backup; the box refuses.", handle: "[data-bk-go]" },
      ],
      assertions: [
        { describe: "Rule", handle: "[data-bk-pass-rule]", expect: "present" },
        { describe: "Box's sentence", handle: "[data-bk-error]", expect: "text", text: "needs about 12 GB" },
      ],
      screenshots: [shot("backup-own-passcode", "Own passcode accepted."), shot("backup-refused", "The box's refusal.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-archive-backup-followed",
    "Opening Backup while the box is already making one follows it (no passcode step) and says why it failed in the box's words.",
    "gym archive a backup already being made is followed when the dialog opens",
    {
      steps: [{ kind: "tap", describe: "Backup/clone server with a backup building.", handle: "#backup-start-btn" }],
      assertions: [{ describe: "Failure reason", handle: "[data-bk-error]", expect: "text", text: "The backup failed: the disk filled up." }],
      screenshots: [shot("backup-followed-failed", "The followed backup's failure.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-archive-non-admin",
    "A non-admin device (downloading a backup and migrating sign under the admin root) sees Backup/clone and Migrate off with the server page's one line why; nothing reaches the box.",
    "gym archive a non-admin device can't start a backup or a migration",
    {
      steps: [{ kind: "launch", describe: "A non-admin device opens a server page." }],
      assertions: [
        { describe: "Backup off", handle: "#backup-start-btn", expect: "disabled" },
        { describe: "Migrate off", handle: "#migrate-start-btn", expect: "disabled" },
        { describe: "Why", handle: "[data-server-admin-only]", expect: "text", text: "Only an admin device can change this server. This device can see it." },
      ],
      screenshots: [shot("backup-migrate-non-admin", "The card, off.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-archive-import-create",
    "Import a backup (Add/Import → Import): the backup file opens with this account's key and asks for its data file; the data file is checked; the name step refuses a taken and a malformed name and shows the address and saved settings; Create mints the recipe (RCK and restore order under the admin root, the AuthCode with the admin root's approval), then uploads the data file to the waiting server, commits the key and lists each app's outcome; Close.",
    "gym archive import a backup creates a server that waits for it and sends it",
    {
      steps: [
        { kind: "tap", describe: "Add/Import → Import a backup.", handle: "[data-choice-import]" },
        { kind: "type", describe: "Pick the backup file, then the data file.", handle: "[data-imp-file]" },
        { kind: "type", describe: "Name: home (taken), Bad_Name, attic.", handle: "#imp-server-name" },
        { kind: "tap", describe: "Create the server.", handle: "[data-imp-create]" },
        { kind: "tap", describe: "Close.", handle: "[data-imp-close]" },
      ],
      assertions: [
        { describe: "Restored", handle: "[data-imp-status]", expect: "text", text: "attic is restored." },
        { describe: "Studio link", handle: "[data-imp-summary] a", expect: "text", text: "Get Flagship Studio" },
      ],
      screenshots: [shot("import-name", "The name step."), shot("import-restored", "The restored apps.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-archive-import-passcode",
    "Import another account's backup: a file that isn't a backup is named; the backup asks for its passcode; a wrong one is refused in words, the right one opens it.",
    "gym archive import another account's backup needs its passcode",
    {
      steps: [
        { kind: "type", describe: "Pick a text file, then both backup files.", handle: "[data-imp-file]" },
        { kind: "type", describe: "Wrong passcode, Open the backup; right one.", handle: "[data-imp-unlock]" },
      ],
      assertions: [
        { describe: "Wrong passcode", handle: "[data-imp-error]", expect: "text", text: "That passcode doesn't open this backup." },
        { describe: "Opened", handle: "[data-imp-name]", expect: "present" },
      ],
      screenshots: [shot("import-wrong-passcode", "Wrong passcode."), shot("import-opened-with-passcode", "Opened.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-archive-send-to-waiting",
    "A server waiting for its backup shows Send the backup and Delete server on its Home card; Send the backup opens the import for that server, which offers 'Send it to office' and restores it there.",
    "gym archive a server waiting for its backup gets it from its Home card",
    {
      steps: [
        { kind: "tap", describe: "Send the backup on office's card.", handle: ".js-send-backup" },
        { kind: "type", describe: "Pick both files.", handle: "[data-imp-file]" },
        { kind: "tap", describe: "Send it to office.", handle: "[data-imp-send-existing]" },
      ],
      assertions: [{ describe: "Restored", handle: "[data-imp-status]", expect: "text", text: "office is restored." }],
      screenshots: [shot("home-awaiting-backup", "The waiting card."), shot("import-send-existing", "Send it to office.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-archive-new-instead",
    "When a server waits for the picked backup, 'Create a new server instead' goes to the name step with the backup's saved name.",
    "gym archive a waiting server's backup can go to a new server instead",
    {
      steps: [{ kind: "tap", describe: "Create a new server instead.", handle: "[data-imp-new-instead]" }],
      assertions: [{ describe: "Create enabled", handle: "[data-imp-create]", expect: "enabled" }],
      screenshots: [shot("import-new-instead", "The name step.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-archive-import-non-admin",
    "A non-admin device has no Add/Import, and its waiting server's Send the backup says only an admin device can add servers; no import opens.",
    "gym archive a non-admin device can't import a backup",
    {
      steps: [{ kind: "tap", describe: "Send the backup on a waiting server.", handle: ".js-send-backup" }],
      assertions: [{ describe: "Refusal", handle: ".modal-title", expect: "text", text: "Admin devices only" }],
      screenshots: [shot("import-non-admin", "The refusal.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-archive-migrate-start",
    "Migrate: without peer backup the dialog says the server has no backup and Start migration is off (Close closes); with it, Start migration posts an admin-root-signed flagship/server-migration/v1 (wipe after hand-off), toasts, shows the timeline with Abort, and holds the SWK for the new box.",
    "gym archive migrate waits for a backup, then starts under the admin root",
    {
      steps: [
        { kind: "tap", describe: "Migrate with no backup; Close.", handle: "[data-mig-cancel]" },
        { kind: "tap", describe: "Migrate with backup; Start migration.", handle: "[data-mig-action]" },
      ],
      assertions: [
        { describe: "Gate", handle: "[data-mig-gate]", expect: "present" },
        { describe: "Timeline", handle: "[data-mig-steps]", expect: "text", text: "Migration authorized" },
      ],
      screenshots: [shot("migrate-gated", "No backup."), shot("migrate-started", "Started.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-archive-migrate-handoff",
    "A pre-seeded migration offers 'Hand off to the new box now': an admin-root-signed confirm-ready, then the freeze (decommission order, wipe after hand-off); a session left at ready offers 'Freeze old server and hand off', which sends only the freeze.",
    "gym archive migrate hands off to the new box, then a ready one freezes",
    {
      steps: [
        { kind: "tap", describe: "Hand off to the new box now.", handle: "[data-mig-action]" },
        { kind: "tap", describe: "Reopen at ready; Freeze old server and hand off.", handle: "[data-mig-action]" },
      ],
      assertions: [{ describe: "Freezing", handle: "[data-mig-wait]", expect: "text", text: "frozen" }],
      screenshots: [shot("migrate-pre-seeded", "Pre-seeded."), shot("migrate-frozen", "Frozen.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-archive-migrate-abort",
    "Abort migration posts an admin-root-signed abort, drops the SWK hold, says the old server stays active, and Close becomes Done.",
    "gym archive migrate abort keeps the old server and the dialog says Done",
    {
      steps: [{ kind: "tap", describe: "Abort migration.", handle: "[data-mig-abort]" }],
      assertions: [{ describe: "Done", handle: "[data-mig-cancel]", expect: "text", text: "Done" }],
      screenshots: [shot("migrate-aborted", "Aborted.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-archive-migrate-demo",
    "A demo account (no admin root pinned) starts a migration with the IRK, which the mock accepts as .com does for it.",
    "gym archive a demo account migrates with the IRK",
    {
      steps: [{ kind: "tap", describe: "Start migration.", handle: "[data-mig-action]" }],
      assertions: [{ describe: "Started", handle: "#toast", expect: "present" }],
      screenshots: [shot("migrate-demo", "Started.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-archive-pending-server",
    "The pending-server page shows the order and its setup checklist from the order's own status; Back returns Home; Cancel order asks first, releases the name under the admin root (voiding the recipe), drops the order and returns Home.",
    "gym archive pending server page cancels the order and goes back",
    {
      steps: [
        { kind: "tap", describe: "← Back.", handle: "#pending-server-back" },
        { kind: "tap", describe: "Cancel order (accept the confirm).", handle: "#pending-server-cancel" },
      ],
      assertions: [{ describe: "Home", handle: "#view-home", expect: "present" }],
      screenshots: [shot("pending-server", "The pending server.")],
      dimension: "D3",
    },
  ),
];
