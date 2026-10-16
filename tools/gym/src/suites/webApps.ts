/**
 * webapp gym scenarios: the Services list and app pages
 * (apps/web/e2e/gym/gym-members.spec.ts), beyond gym-apps' rows in web.ts.
 * Same rules as web.ts: each `harness` is the exact title of a test in that
 * spec. The mock answers each admin order as an admin-pinned box or `.com`
 * does (gymKit `sensitive`): the admin root only, the IRK refused; a demo
 * account keeps the IRK.
 */

import type { Scenario } from "../scenario.js";
import { webTotal, shot } from "./helpers.js";

export const WEB_APPS: readonly Scenario[] = [
  webTotal(
    "web-total-members-services-list",
    "Services tab: search narrows and Clear restores the cards, All/Yours/Shared filter by creator, the card's short link copies, Refresh asks the box again, the card opens the app page (its Refresh re-reads it, Back returns to the list), and the list's Back goes Home.",
    "gym members the Services tab searches, filters, copies a link and opens an app card",
    {
      steps: [
        { kind: "tap", describe: "Services tab.", handle: '[data-tab-target="apps"]' },
        { kind: "type", describe: "Search 'ladder', then clear.", handle: "#apps-search" },
        { kind: "tap", describe: "Shared, Yours, All chips.", handle: "[data-chip]" },
        { kind: "tap", describe: "Copy short link.", handle: "[data-copy]" },
        { kind: "tap", describe: "Open notes; Refresh; Back; Back.", handle: '[data-action="open"]' },
      ],
      assertions: [
        { describe: "App cards", handle: "#services-list-content .fs-app-card", expect: "present" },
        { describe: "Home after Back", handle: "#view-home", expect: "present" },
      ],
      screenshots: [shot("services-list", "The list with its short links.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-members-mode-open-again",
    "Access control: Members only's Cancel leaves the app open and sends nothing; after going members-only, Open to all needs no confirmation and is an admin-root-signed service-access-mode/v2; Refresh re-reads the box and Back returns to the app page.",
    "gym members access control goes back to Open to all, and Members only can be cancelled",
    {
      steps: [
        { kind: "tap", describe: "Members only → Cancel.", handle: '#sa-mode [data-mode="restricted"]' },
        { kind: "tap", describe: "Members only → OK, then Open to all.", handle: '#sa-mode [data-mode="open"]' },
        { kind: "tap", describe: "Refresh, then Back.", handle: "#service-access-back" },
      ],
      assertions: [{ describe: "Open again", handle: "#sa-mode-status", expect: "text", text: "Anyone can open it. Members who sign in get their rank." }],
      screenshots: [shot("access-open-again", "Back to Open to all.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-members-invite-manager",
    "An admin device invites a person at Manager with a photo: the create to .com is admin-root-signed and carries the name and photo only sealed; Manager rides an admin-root app-rank/v1 order; the result shows the box link (author, invite and app in the fragment), a QR, Copy link and Share.",
    "gym members an admin invites a person at Manager with a photo and gets the link, QR, Copy and Share",
    {
      steps: [
        { kind: "tap", describe: "+ Add person; Rank Manager; name; photo.", handle: "#sa-add-person" },
        { kind: "tap", describe: "Create invite link.", handle: "#sa-add-go" },
        { kind: "tap", describe: "Copy link, then Share.", handle: "#sa-copy" },
      ],
      assertions: [
        { describe: "Created", handle: "#sa-add-status", expect: "text", text: "Invite for Robin created." },
        { describe: "QR", handle: "#sa-qr svg", expect: "present" },
      ],
      screenshots: [shot("invite-manager-link", "The link, QR and the new row at Manager.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-members-group-invite",
    "A group invite at Master signs its limit (5) and expiry (7 days) into the admin-root create, sets Master with an app-rank order, lists '0 of 5 joined · expires…' with the crown, and Revoke's Cancel keeps it.",
    "gym members a group invite at Master carries its limit and expiry, and Revoke can be cancelled",
    {
      steps: [
        { kind: "tap", describe: "+ Add group; Max uses 5; 7 days; Master.", handle: "#sa-add-group" },
        { kind: "tap", describe: "Create, then Revoke → Cancel.", handle: '[data-action="sa-remove"]' },
      ],
      assertions: [{ describe: "Group created", handle: "#sa-add-status", expect: "text", text: "Group Chess club created." }],
      screenshots: [shot("group-invite", "The group row.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-members-approve-first-finalize",
    "An approve-first invite is sent with approvalMode manual and shows its hint; Finalize refuses an empty or junk paste without asking the box, and a real acceptance (signed with the invitee's per-app id) posts only {accept, acceptSig} to the box and says it's granted.",
    "gym members an approve-first invite shows its hint and Finalize grants a pasted acceptance",
    {
      steps: [
        { kind: "tap", describe: "I approve them first; Create.", handle: "#sa-approve" },
        { kind: "type", describe: "Paste junk, then a real reply.", handle: "#sa-accept-input" },
        { kind: "tap", describe: "Finalize & grant access.", handle: "#sa-accept-go" },
      ],
      assertions: [
        { describe: "Hint", handle: "#sa-manual-hint", expect: "present" },
        { describe: "Granted", handle: "#sa-accept-status", expect: "text", text: "Granted — they can open it now." },
      ],
      screenshots: [shot("approve-first-invite", "The approve-first row."), shot("finalize-granted", "Granted.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-members-remove-member",
    "Removing a joined member: Cancel sends nothing; Remove posts an admin-root invite revoke to .com, the same revoke to the box, and an admin-root service-allow-remove/v2 that prunes their id.",
    "gym members an admin removes a member, and the box prunes them under the admin root",
    {
      steps: [{ kind: "tap", describe: "Remove Sam → Cancel, then → Remove.", handle: '[data-action="sa-remove"]' }],
      assertions: [{ describe: "No members left", handle: "#sa-members-title", expect: "text", text: "Members (0)" }],
      screenshots: [shot("member-removed", "After the removal.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-members-invite-redeem",
    "The invitee opens a /invite#server=…&k=…&a=…&i=…&s=… link: Unlock, Accept & get access posts the raw secret to that box signed with their id for that app (never the global AID), 'You're in', and Go to Flagship lands on Home.",
    "gym members the invitee opens the invite link, unlocks and accepts",
    {
      steps: [
        { kind: "launch", describe: "Open the invite link on a locked device." },
        { kind: "tap", describe: "Unlock, then Accept.", handle: "#ir-accept" },
        { kind: "tap", describe: "Go to Flagship.", handle: "#ir-home" },
      ],
      assertions: [{ describe: "Accept shown", handle: "#ir-accept", expect: "present" }],
      screenshots: [shot("invite-accept", "Accept this invite."), shot("invite-in", "You're in.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-members-invite-acceptance-code",
    "An approve-first invite's invitee gets an acceptance code (an app link to the control apex naming the box, the invite, the app and a signature in its fragment) with a QR, Copy code and Share.",
    "gym members an approve-first invitee gets an acceptance code to copy and send back",
    {
      steps: [
        { kind: "tap", describe: "Unlock, Accept (box answers pending).", handle: "#ir-accept" },
        { kind: "tap", describe: "Copy code, Share, Done.", handle: "#ir-accept-copy" },
      ],
      assertions: [{ describe: "Code QR", handle: "#ir-accept-qr svg", expect: "present" }],
      screenshots: [shot("invite-acceptance-code", "The acceptance code.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-members-access-ignore-dismiss-view",
    "Internet access: Ignore drops a request with an unsigned dismiss and leaves the list alone; Dismiss drops the suggested list; View access list opens the live list (not the draft), whose Refresh re-reads and Back returns to the app page.",
    "gym members internet access Ignore, Dismiss a suggestion and View access list",
    {
      steps: [
        { kind: "tap", describe: "Ignore.", handle: '[data-access-act="ignore"]' },
        { kind: "tap", describe: "Dismiss the suggestion.", handle: '[data-access-draft-act="dismiss"]' },
        { kind: "tap", describe: "View access list; Refresh; Back.", handle: "#sd-access-view" },
      ],
      assertions: [{ describe: "Editor", handle: "#app-access-text", expect: "present" }],
      screenshots: [shot("access-ignored-dismissed", "After Ignore and Dismiss.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-members-legacy-egress",
    "An older box (no access lists): Allow signs every declared host into an admin-root flagship/app-egress/v1, Stop access signs an empty list.",
    "gym members an older box's internet access is allowed and stopped with admin-root approvals",
    {
      steps: [
        { kind: "tap", describe: "Allow.", handle: "#sd-egress-allow" },
        { kind: "tap", describe: "Stop access.", handle: "#sd-egress-stop" },
      ],
      assertions: [{ describe: "Allow back", handle: "#sd-egress-allow", expect: "present" }],
      screenshots: [shot("egress-pending", "The request."), shot("egress-stopped", "Stopped.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-members-egress-non-admin",
    "A non-admin device sees an older box's egress card read-only with the admin-only sentence, and the global access alert never shows (nor asks the box).",
    "gym members a non-admin device sees an older box's egress read-only and gets no access alerts",
    {
      steps: [{ kind: "launch", describe: "Open the app as a non-admin device; force an access check." }],
      assertions: [
        { describe: "No Allow", handle: "#sd-egress-allow", expect: "absent" },
        { describe: "No sheet", handle: "[data-access-sheet]", expect: "absent" },
      ],
      screenshots: [shot("egress-non-admin", "Read-only.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-members-access-alert-allow",
    "The global access alert ('notes wants to reach api.openai.com'): Allow signs the list under the admin root, the answered sheet's View access list opens the editor with the new list.",
    "gym members the access-request alert allows a host and opens the access list",
    {
      steps: [
        { kind: "tap", describe: "Allow.", handle: '[data-choice="allow"]' },
        { kind: "tap", describe: "View access list.", handle: '[data-choice="view"]' },
      ],
      assertions: [{ describe: "Answered", handle: "[data-access-answered]", expect: "present" }],
      screenshots: [shot("access-alert", "The sheet."), shot("access-alert-answered", "Answered.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-members-access-alert-later",
    "Access alerts in order: a suggestion's Not now, a request's Not now, another's Escape, a Deny (admin-root list) then Close; none returns on the next check; a fresh suggestion's Review opens the editor on the draft.",
    "gym members the access alerts' Not now, Escape, Deny and Close, and a suggestion's Review",
    {
      steps: [
        { kind: "tap", describe: "Not now ×2, Escape.", handle: '[data-choice="later"]' },
        { kind: "tap", describe: "Deny, then Close.", handle: '[data-choice="deny"]' },
        { kind: "tap", describe: "Review a new suggestion.", handle: '[data-choice="review"]' },
      ],
      assertions: [{ describe: "Draft editor", handle: "[data-access-draft-note]", expect: "present" }],
      screenshots: [shot("access-draft-alert", "The suggestion sheet."), shot("access-draft-review", "The draft in the editor.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-members-demo-access",
    "A demo account (no admin root) allows an access request on the app page; the list is IRK-signed and accepted.",
    "gym members a demo account allows an access request with the IRK",
    {
      steps: [{ kind: "tap", describe: "Allow.", handle: '[data-access-act="allow"]' }],
      assertions: [{ describe: "App page", handle: "#view-service-detail", expect: "present" }],
      screenshots: [shot("demo-access-allowed", "Allowed.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-members-api-key-write",
    "API keys: Cancel closes the form and sends nothing; Read & write chosen and Enter in the name creates an admin-root-signed write key; Copy puts the secret on the clipboard; Revoke's Cancel keeps the key.",
    "gym members API keys: Read & write by Enter, Copy the secret, Cancel and a cancelled revoke",
    {
      steps: [
        { kind: "tap", describe: "Create key → Cancel.", handle: "#sd-api-key-cancel" },
        { kind: "type", describe: "Read & write; name; Enter.", handle: "#sd-api-key-label" },
        { kind: "tap", describe: "Copy, Done, Revoke → Cancel.", handle: "#sd-api-key-copy" },
      ],
      assertions: [{ describe: "Secret shown", handle: "#sd-api-key-secret", expect: "present" }],
      screenshots: [shot("api-key-write-copied", "The write key, copied.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-members-database-paging",
    "Database: Next/Previous page a 250-row table (offset=100), Refresh re-reads, Export CSV downloads the box's file with the session; SQL on a second store (store select), a write's confirm is withdrawn by an edit, and the confirmed write is admin-root-signed for that store; Back steps to the tables then the app page.",
    "gym members the database pages a table, exports CSV and runs SQL on a second store",
    {
      steps: [
        { kind: "tap", describe: "Next, Previous, Refresh.", handle: "#app-db-next" },
        { kind: "tap", describe: "Export CSV.", handle: "#app-db-export" },
        { kind: "tap", describe: "Run SQL on analytics; confirm a write.", handle: "#app-db-store" },
      ],
      assertions: [{ describe: "Write ran", handle: "[data-db-result]", expect: "text", text: "DELETE · 3 rows" }],
      screenshots: [shot("db-paged", "Page 1."), shot("db-second-store", "The write on analytics.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-members-remove-app",
    "Remove app: Cancel sends nothing; Remove signs an admin-root uninstall to this server, toasts and returns to the Services list.",
    "gym members Remove app: Cancel keeps it, Remove signs the uninstall and returns to the list",
    {
      steps: [{ kind: "tap", describe: "Remove app → Cancel, then → Remove app.", handle: "#service-detail-remove-btn" }],
      assertions: [{ describe: "Back on the list", handle: "#view-services-list", expect: "present" }],
      screenshots: [shot("app-removed", "After removing.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-members-edit-service",
    "Edit this service: Describe the change (AI-key step → What should change?) — a 413 offers the IDE, a 409 says it's already being changed, then the chat opens on a session that edits this service; Use your IDE opens the connect screen for it and creates an edit connection; the Backs return to the chooser and the app.",
    "gym members Edit this service: describe a change with AI, the refusals, and your IDE",
    {
      steps: [
        { kind: "tap", describe: "Edit this service → Describe the change → Use this key.", handle: "#edit-service-ai" },
        { kind: "tap", describe: "Start ×3.", handle: "#edit-describe-start" },
        { kind: "tap", describe: "Use your IDE → Create a connection.", handle: "#edit-service-ide" },
      ],
      assertions: [{ describe: "Chooser title", handle: "#edit-service-title", expect: "text", text: "Edit notes" }],
      screenshots: [shot("edit-chooser", "The chooser."), shot("edit-ide", "The IDE connection.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-members-service-env",
    "Configure environment: Save refuses an empty name, saves a variable (IRK-signed set-service-env, the value cleared and never shown), Remove after confirm unsets one, a declined confirm sends nothing, and Back clears a typed value.",
    "gym members Configure environment saves and removes a variable",
    {
      steps: [
        { kind: "type", describe: "Name + value; Save.", handle: "#service-env-save" },
        { kind: "tap", describe: "Remove (confirm), Remove (decline).", handle: ".service-env-remove" },
        { kind: "tap", describe: "Back.", handle: "#service-env-back" },
      ],
      assertions: [{ describe: "App page", handle: "#view-service-detail", expect: "present" }],
      screenshots: [shot("env-saved", "Saved.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-members-adapter-report",
    "Report a problem with the adapter: Cancel closes; Send is off until there's text, posts the trimmed note to the box, and Done closes the thanks.",
    "gym members Report a problem with the adapter: Cancel, then send the note",
    {
      steps: [
        { kind: "tap", describe: "Report → Cancel.", handle: "[data-report-cancel]" },
        { kind: "tap", describe: "Report → type → Send → Done.", handle: "#adapter-report-send" },
      ],
      assertions: [{ describe: "Sent", handle: "[data-report-sent]", expect: "present" }],
      screenshots: [shot("adapter-report-sent", "Sent.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-members-domains-replace",
    "Web domains: both copy buttons copy their links; Replace's prompt cancelled, a bad stem refused, the confirm cancelled send nothing; a confirmed Replace posts an IRK-signed rename to .com and the page shows the new short link.",
    "gym members web domains copy their links and Replace renames the stem",
    {
      steps: [
        { kind: "tap", describe: "Copy short, copy canonical.", handle: "[data-copy]" },
        { kind: "tap", describe: "Replace ×4.", handle: "#sd-replace-stem" },
      ],
      assertions: [{ describe: "New short link", handle: '[data-section="short"] a', expect: "text", text: "voi.ci/j0ts" }],
      screenshots: [shot("domains-renamed", "Renamed.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-members-mock-refuses-irk",
    "The mock's own rule: an IRK signature over an app access list gets the admin-pinned box's 403, an admin-root one passes (so the app-page tests catch a regression to IRK signing).",
    "gym members an IRK-signed app order is refused the way an admin-pinned box refuses it",
    {
      steps: [{ kind: "launch", describe: "Sign one list both ways and ask the mock." }],
      assertions: [{ describe: "Home", handle: "#view-home", expect: "present" }],
      screenshots: [shot("mock-refuses-irk", "Home, after the check.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-members-second-invite-link",
    "After a second invite, Copy and Share hand over only the newest link (each invite used to stack another handler, so Copy wrote both links and Share shared both).",
    "gym members a second invite's Copy and Share hand over only the newest link",
    {
      steps: [
        { kind: "tap", describe: "Invite Ana, then Ben.", handle: "#sa-add-go" },
        { kind: "tap", describe: "Copy, then Share.", handle: "#sa-copy" },
      ],
      assertions: [{ describe: "The newest link on screen", handle: "#sa-link", expect: "present" }],
      screenshots: [shot("invite-second-link", "After the second invite.")],
      dimension: "D3",
    },
  ),
];
