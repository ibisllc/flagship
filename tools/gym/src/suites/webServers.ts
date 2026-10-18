/**
 * webapp gym scenarios: Home's servers and the server page
 * (apps/web/e2e/gym/gym-servers.spec.ts), beyond the ones in web.ts. Same
 * rules as web.ts: each `harness` is the exact title of a test in that spec.
 * The mock answers sensitive orders as `.com` does on an admin-pinned account
 * (gymKit `sensitive`): admin root only, the IRK refused; a demo account keeps
 * the IRK.
 */

import type { Scenario } from "../scenario.js";
import { webTotal, shot } from "./helpers.js";

export const WEB_SERVERS: readonly Scenario[] = [
  webTotal(
    "web-total-server-order-non-admin",
    "A non-admin device of an admin-pinned account sees the server order and the Leader badge but no drag handles, no Add/Restore, and a disabled Make leader that says only an admin device can change the order (.com refuses the IRK it would sign with).",
    "gym servers a non-admin device sees the server order but can't change it or Make leader",
    {
      steps: [
        { kind: "launch", describe: "Reach Home as a non-admin device with two servers." },
        { kind: "assert", describe: "No handles, not reorderable, no Add/Restore.", handle: "#servers-list .js-order-handle" },
        { kind: "tap", describe: "Open office from its Home card.", handle: "[data-open-fqdn]" },
        { kind: "assert", describe: "Make leader disabled with the reason.", handle: "[data-leader-admin-only]" },
      ],
      assertions: [
        { describe: "No drag handles", handle: "#servers-list .js-order-handle", expect: "absent" },
        { describe: "Make leader off", handle: "#make-leader-btn", expect: "disabled" },
        { describe: "Reason", handle: "[data-leader-admin-only]", expect: "text", text: "Only an admin device can change the server order." },
      ],
      screenshots: [shot("order-non-admin", "Home without handles."), shot("leader-non-admin", "Make leader off.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-home-demo-account",
    "A demo account (operator-run, no admin root) shows its demo server and still offers Add/Restore server, the apps' demo exception.",
    "gym servers a demo account shows its demo server and may add servers without an admin root",
    {
      steps: [
        { kind: "launch", describe: "Reach Home as a demo account." },
        { kind: "assert", describe: "The demo server card and Add/Restore.", handle: "#home-add-server" },
        { kind: "tap", describe: "Open Add/Restore.", handle: "#home-add-server" },
      ],
      assertions: [{ describe: "Create choice", handle: "[data-choice-add]", expect: "present" }],
      screenshots: [shot("home-demo", "A demo account's Home.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-home-add-import-choices",
    "Add/Restore server: Cancel closes the menu; Co-manage asks for the owner's share link and refuses anything else; Restore from backup opens the chooser (From a file, From other servers; no From this device in a browser) and From a file opens its picker; Create a server opens the create form.",
    "gym servers each Add or Restore choice opens its flow and Cancel closes the menu",
    {
      steps: [
        { kind: "tap", describe: "Add/Restore → Cancel.", handle: "[data-choice-cancel]" },
        { kind: "tap", describe: "Add/Restore → Co-manage → paste a non-share link.", handle: "[data-choice-co-manage]" },
        { kind: "tap", describe: "Add/Restore → Restore from backup → From a file.", handle: "[data-restore-file]" },
        { kind: "tap", describe: "Add/Restore → Create a server.", handle: "[data-choice-add]" },
      ],
      assertions: [
        { describe: "Share-link refusal", handle: "[data-modal-error]", expect: "text", text: "That isn't a share link." },
        { describe: "Import picker", handle: "[data-imp-file]", expect: "present" },
        { describe: "Create form", handle: "#view-create-server", expect: "present" },
      ],
      screenshots: [
        shot("add-co-manage-prompt", "The share-link prompt."),
        shot("add-import-dialog", "The import picker."),
        shot("add-create-form", "The create form."),
      ],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-home-lock-closes-menus",
    "Locking the app with the Add/Restore menu, the Restore from backup chooser or a prompt open leaves none of it on screen: no dialog or sheet is visible, focusable or holding focus over the lock screen, by either lock button.",
    "gym servers locking the app with a menu or dialog open leaves none of it on screen",
    {
      steps: [
        { kind: "tap", describe: "Open Add/Restore server.", handle: "#home-add-server" },
        { kind: "tap", describe: "Lock the app (PIN lock).", handle: "#settings-pin-lock" },
        { kind: "tap", describe: "Unlock, open Restore from backup and a prompt, lock again.", handle: "#home-add-server" },
      ],
      assertions: [
        { describe: "Lock screen", handle: "#view-pin-unlock", expect: "present" },
        { describe: "No dialog left", handle: "dialog", expect: "absent" },
      ],
      screenshots: [shot("home-locked-no-menu", "The lock screen with no menu over it.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-home-empty-non-admin",
    "A non-admin device with no servers sees 'No servers yet' and that only an admin device can add servers, with no Add/Restore button.",
    "gym servers a non-admin device with no servers is told only an admin device can add one",
    {
      steps: [{ kind: "launch", describe: "Reach Home as a non-admin device; /pods is empty." }],
      assertions: [
        { describe: "Non-admin empty card", handle: "[data-home-empty-non-admin]", expect: "text", text: "Only an admin device of this account can add servers." },
        { describe: "No Add/Restore", handle: "#home-add-server", expect: "absent" },
      ],
      screenshots: [shot("home-empty-non-admin", "The non-admin empty state.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-home-empty-admin",
    "An admin device with no servers gets Add/Restore server and 'Take over' (which opens the take-over dialog).",
    "gym servers an admin device with no servers gets Add or Restore and Take over",
    {
      steps: [
        { kind: "launch", describe: "Reach Home as an admin device; /pods is empty." },
        { kind: "tap", describe: "Take over a box.", handle: "#home-take-over" },
      ],
      assertions: [{ describe: "Take-over dialog", handle: "[data-claim-input]", expect: "present" }],
      screenshots: [shot("home-empty-admin", "The admin empty state.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-server-order-move-down",
    "Home's Move down (keyboard) saves the new order, signed with the admin root.",
    "gym servers Move down on Home saves the new order",
    {
      steps: [{ kind: "tap", describe: "Focus Move home down, press Enter.", handle: ".js-order-down" }],
      assertions: [{ describe: "Order shown", handle: "#servers-list [data-server-cards]", expect: "present" }],
      screenshots: [shot("order-moved-down", "After Move down.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-home-card-opens-server",
    "Tapping a server's card on Home opens that server's page.",
    "gym servers a Home server card opens its server page",
    {
      steps: [{ kind: "tap", describe: "Tap office's card.", handle: "[data-open-fqdn]" }],
      assertions: [{ describe: "Server page for office", handle: "#leader-card", expect: "present" }],
      screenshots: [shot("home-card-opens-server", "The server page.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-make-leader",
    "Make leader (docs/server-order.md) on the second server puts it first: an admin-root-signed order to .com, the toast, a gray Leader pill and 'Waiting for it to confirm the new order.' until the box holds it, then green.",
    "gym servers Make leader puts this server first and waits for it to confirm",
    {
      steps: [
        { kind: "assert", describe: "Second in line.", handle: "#leader-pill" },
        { kind: "tap", describe: "Make leader.", handle: "#make-leader-btn" },
        { kind: "assert", describe: "Waiting note, then confirmed.", handle: "#leader-confirm-note" },
      ],
      assertions: [
        { describe: "Leader pill", handle: "#leader-pill", expect: "text", text: "Leader" },
        { describe: "Waiting note", handle: "#leader-confirm-note", expect: "text", text: "Waiting for it to confirm the new order." },
      ],
      screenshots: [
        shot("leader-card-second", "Before."),
        shot("leader-waiting", "Waiting for the box."),
        shot("leader-confirmed", "Confirmed."),
      ],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-update-dialog-releases",
    "The Update dialog lists other new releases, and under Advanced a release to go back to and a typed-commit field that refuses a short hash and the running commit; Go back sends an admin-root-signed order for the older release; a server on the latest release offers Check again, which asks the box afresh.",
    "gym servers update dialog offers other releases, Go back under Advanced, a typed commit and Check again",
    {
      steps: [
        { kind: "tap", describe: "Open the Update dialog.", handle: "#update-server-btn" },
        { kind: "tap", describe: "Advanced; type a short hash, the running commit, a valid one.", handle: "[data-update-target]" },
        { kind: "tap", describe: "Go back to v1.2.0.", handle: "[data-update-commit]" },
        { kind: "tap", describe: "On the latest release: Check again.", handle: "[data-update-recheck]" },
      ],
      assertions: [
        { describe: "Other releases", handle: "[data-update-others]", expect: "text", text: "Other new releases" },
        { describe: "Typed-commit hint", handle: "[data-update-target-hint]", expect: "present" },
        { describe: "Sent", handle: "[data-update-pending='sent']", expect: "text", text: "Update to v1.2.0 sent" },
      ],
      screenshots: [
        shot("update-advanced", "Advanced."),
        shot("update-went-back", "Go back sent."),
        shot("update-latest-check-again", "Latest release with Check again."),
      ],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-update-stale-order",
    "An update order the server never applied reads 'may be offline' with Send again (reopens the release list) and Forget it (drops it, Update is back).",
    "gym servers an update the server hasn't picked up offers Send again and Forget it",
    {
      steps: [
        { kind: "launch", describe: "A pending order from two days ago." },
        { kind: "tap", describe: "Send again.", handle: "[data-update-send-again]" },
        { kind: "tap", describe: "Forget it.", handle: "[data-update-forget]" },
      ],
      assertions: [
        { describe: "Stale note", handle: "[data-update-pending='stale']", expect: "present" },
        { describe: "Update button back", handle: "#update-server-btn", expect: "present" },
      ],
      screenshots: [shot("update-stale", "The stale order."), shot("update-forgotten", "After Forget it.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-unrevoke-demo-irk",
    "A demo account (no admin root pinned) un-revokes with an IRK-signed request, which the mock accepts as .com does for it.",
    "gym servers a demo account un-revokes with the IRK",
    {
      steps: [{ kind: "tap", describe: "Un-revoke.", handle: "#unrevoke-server-btn" }],
      assertions: [{ describe: "Revoke back", handle: "#revoke-server-btn", expect: "present" }],
      screenshots: [shot("demo-unrevoked", "Restored.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-delete-cancel",
    "The Delete dialog's Cancel closes it and sends nothing, even with the name typed.",
    "gym servers delete dialog Cancel sends nothing",
    {
      steps: [
        { kind: "tap", describe: "Delete → type the name → Cancel.", handle: "[data-delete-cancel]" },
      ],
      assertions: [{ describe: "Still on the server page", handle: "#view-server-detail", expect: "present" }],
      screenshots: [shot("delete-cancel", "Before Cancel.")],
      dimension: "D4",
    },
  ),
];
