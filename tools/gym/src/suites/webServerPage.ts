/**
 * webapp gym scenarios: Home's banners and cards, and the rest of the server
 * page (apps/web/e2e/gym/gym-serverpage.spec.ts). Same rules as web.ts: each
 * `harness` is the exact title of a test in that spec. Sensitive orders are
 * answered as `.com` / an admin-pinned box does (gymKit `sensitive`).
 */

import type { Scenario } from "../scenario.js";
import { webTotal, shot } from "./helpers.js";

type Row = [id: string, goal: string, title: string, handle: string, point: string, dimension?: "D1" | "D3" | "D4"];

const ROWS: Row[] = [
  ["web-total-home-recovery-nudge", "Home's 'Your account isn't backed up yet' nudge: Secure my account opens Recovery; the x dismisses it and it stays away across renders.", "gym serverpage the recovery nudge opens recovery, and once dismissed stays away", "#home-recovery-banner", "home-recovery-nudge"],
  ["web-total-home-device-removed", "When the account's directory no longer lists this device, Home shows a non-dismissible 'This device was removed from your account' banner; Sign in again clears the session slots and reloads out of the signed-in shell.", "gym serverpage a device removed from the account is told so and Sign in again reloads to unlock", "#home-account-reset-banner", "home-device-removed", "D4"],
  ["web-total-home-locked-list", "A 401 from .com on /pods shows 'Your server list is locked' with Show my servers, which mints a fresh read token and reads the list again.", "gym serverpage a locked server list shows Show my servers, which reads it again", "#home-show-my-servers", "home-locked"],
  ["web-total-home-never-seen-delete", "A never-seen card's Delete server opens the typed-name delete; it sends a wipe-now decommission and the name release, both under the admin root, and the card goes.", "gym serverpage Delete on a never-seen card wipes and frees its name under the admin root", ".js-delete-server", "home-never-seen", "D4"],
  ["web-total-home-awaiting-backup-delete", "An awaiting-backup card offers Send the backup and Delete server; the delete's Cancel sends nothing and keeps the card.", "gym serverpage Delete on an awaiting-backup card opens the delete and Cancel keeps it", ".js-delete-server", "home-awaiting-backup-delete"],
  ["web-total-home-pending-delete", "A pending order's 'Delete server (free name)' asks the browser first (declining sends nothing), then releases the name under the admin root and the card goes.", "gym serverpage Delete on a pending order frees the name after the browser's confirm", ".js-delete-dead-server", "home-pending-card", "D4"],
  ["web-total-home-studio-link", "The empty Home's Get Flagship Studio link opens flagshipserver.com/studio in a new tab (noopener).", "gym serverpage the empty Home links to Flagship Studio in a new tab", "#servers-list a[href=\"https://flagshipserver.com/studio\"]", "home-studio-link"],
  ["web-total-ops-bar-keyboard", "The operations bar is a keyboard button: Enter and Space open its operation's screen.", "gym serverpage the operations bar opens its operation from the keyboard", "#global-operations-bar", "ops-bar", "D3"],
  ["web-total-home-drag-cancel", "A drag cancelled by pointercancel or a window blur puts the order back, and a press without moving saves nothing; no server order is sent.", "gym serverpage a drag that's cancelled or dropped in place changes nothing", ".js-order-handle", "drag-cancelled"],
  ["web-total-home-provider-chip", "Home's AI provider chip (Flagship Inference, 'settings') opens AI keys.", "gym serverpage Home's AI provider chip opens AI keys", "#chip-settings", "home-provider-chip", "D3"],
  ["web-total-server-not-paired", "A server this browser has no session for opens to 'This server isn't paired with this browser yet' with Pair this server; a box that refuses the pairing gets its own sentence and the button back.", "gym serverpage a server this browser has no session for offers Pair this server", "#sd-pair-server", "server-not-paired"],
  ["web-total-server-monitoring", "The Monitoring rows show the box's numbers (CPU, memory, disk with its warn tone, network, certificate); an unhealthy Health row opens itself; every row opens and closes its detail.", "gym serverpage Monitoring rows open and close and show the box's numbers", "#monitor-pane", "monitoring-open"],
  ["web-total-server-power-restart", "Lock and restart asks first (Cancel sends nothing), counts down on the button, then sends an admin-root-signed power-off order with mode restart and says the server is restarting.", "gym serverpage Lock and restart asks, counts down and sends a signed restart", "#power-restart-btn", "power-restart-confirm", "D4"],
  ["web-total-server-deadman", "The dead-man lock: window and lockout selects, Enable, Affirm (fresh nonce, countdown), Tighten now (5 minutes) and Disable each send an admin-root-signed order with the chosen values.", "gym serverpage the dead-man lock enables, affirms, tightens and disables under the admin root", "#deadman-card", "deadman-on", "D4"],
  ["web-total-server-journal", "The journal reads the chosen unit and line count (an IRK-signed read) and shows the lines.", "gym serverpage the journal reads the chosen unit and line count", "#journal-fetch-btn", "journal-read"],
  ["web-total-server-front-page", "The front page lists the box's apps; Save points visitors at one (admin-root-signed set-front-page), and saving the default page clears it.", "gym serverpage the front page points visitors at an app under the admin root", "#front-page-save", "front-page-set", "D4"],
  ["web-total-server-auto-unlock", "Auto-unlock reopens the disk key .com holds for this account, seals it for this box's key only, signs the 7-day lease and lists it (Renew for 7 more days).", "gym serverpage auto-unlock seals the disk key for this box and lists the lease", "#auto-unlock-enable", "auto-unlock-on", "D4"],
  ["web-total-update-other-row", "The Update dialog's row for another new release orders that release (admin root).", "gym serverpage an update row for another new release orders that release", "[data-update-action=\"update\"]", "update-other-row"],
  ["web-total-server-app-rows", "The server page's app row opens that app, whose Back returns to the server page; Create app here opens Build.", "gym serverpage an app row opens the app and Back returns to the server, Create app here opens Build", "[data-open-app]", "server-apps", "D3"],
  ["web-total-server-non-admin-controls", "A non-admin device sees power, dead-man and front page off with the page's admin-only line, while reads (journal, monitoring) stay on; nothing is sent.", "gym serverpage a non-admin device sees power, dead-man and front page off", "[data-server-admin-only]", "server-non-admin-controls", "D4"],
  ["web-total-finalize-replace", "Trusted devices' Replace pending banner keeps Finalize now off inside the grace window; after it, Finalize posts the next key's completion and moves this device to it.", "gym serverpage Trusted devices finalizes a replacement once its grace is over", "#finalize-replace-btn", "finalize-waiting", "D4"],
  ["web-total-browser-viewer", "An app with a browser bundle opens its browser viewer, which lists the box's tabs and Refresh tabs re-reads them.", "gym serverpage an app's browser viewer lists its tabs and refreshes them", "#sd-open-browser", "browser-viewer"],
  ["web-total-serverpage-pair-server", "Pair this server on a server this browser has no session for signs an add-paired-session order to that box, stores its token and reloads the page with it (auto-pair used to read a field /pods doesn't send, so it never paired anything).", "gym serverpage Pair this server pairs a server this browser has no session for", "#sd-pair-server", "server-not-paired", "D3"],
];

export const WEB_SERVER_PAGE: readonly Scenario[] = ROWS.map(([id, goal, title, handle, point, dimension]) =>
  webTotal(id, goal, title, {
    steps: [
      { kind: "launch", describe: "Reach Home with the screen's data mocked." },
      { kind: "tap", describe: "Press the control and follow what it does.", handle },
    ],
    assertions: [{ describe: "The control is on screen", handle, expect: "present" }],
    screenshots: [shot(point, "The screen at its key point.")],
    dimension: dimension ?? "D1",
  }),
);
