/**
 * webapp gym scenarios: sharing a server, both sides
 * (apps/web/e2e/gym/gym-sharing.spec.ts). Same rules as web.ts: each
 * `harness` is the exact title of a test in that spec. Owner orders verify
 * under the admin root (the mock refuses the IRK as `.com` does); the
 * co-manager's under its per-share member key.
 */

import type { Scenario } from "../scenario.js";
import { webTotal, shot } from "./helpers.js";

export const WEB_SHARING: readonly Scenario[] = [
  webTotal(
    "web-total-sharing-owner-confirm-cancel",
    "Owner's 'Shared with' card: a matching code's Yes, confirm posts an admin-root-signed flagship/server-share/v1 grant with the acceptance; a mismatched code's No, cancel (Keep it sends nothing; Cancel link revokes on .com, admin-root-signed); a broken answer's Cancel link does the same.",
    "gym sharing owner confirms a matching code and cancels a mismatched one",
    {
      steps: [
        { kind: "launch", describe: "Owner's server page with two accepted links and one broken answer." },
        { kind: "tap", describe: "Bo: No, cancel → Keep it, then → Cancel link.", handle: "[data-share-cancel]" },
        { kind: "tap", describe: "Cy (broken): Cancel link.", handle: "[data-share-cancel]" },
        { kind: "tap", describe: "Ana: Yes, confirm.", handle: "[data-share-confirm]" },
      ],
      assertions: [
        { describe: "Codes shown", handle: "[data-share-sas]", expect: "present" },
        { describe: "Confirmed toast", handle: "#toast", expect: "text", text: "Ana can now manage this server" },
      ],
      screenshots: [shot("owner-awaiting-codes", "Codes to check."), shot("owner-confirmed", "Ana confirmed.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-sharing-owner-level-switches-remove",
    "Owner changes an active co-manager's level and 'Can see app data' (each an admin-root-signed grant to the box); 'Can approve start-up' asks first (Cancel puts the switch back), Allow sends the grant and a flagship/server-share-unlock/v1 deposit whose sealed key opens with the co-manager's member key; Remove ends it on the box and .com.",
    "gym sharing owner changes a co-manager's level, switches and removes them",
    {
      steps: [
        { kind: "tap", describe: "Level → Can view.", handle: "[data-share-level]" },
        { kind: "tap", describe: "Can see app data on.", handle: "[data-share-opt=\"seeAppData\"]" },
        { kind: "tap", describe: "Start-up approval → Cancel, then → Allow.", handle: "[data-share-opt=\"unlockAtBoot\"]" },
        { kind: "tap", describe: "Remove → Remove.", handle: "[data-share-remove]" },
      ],
      assertions: [{ describe: "Removed toast", handle: "#toast", expect: "text", text: "Removed Sam" }],
      screenshots: [shot("owner-active-share", "Sam's row."), shot("owner-switches", "After the switches.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-sharing-owner-offered-links",
    "An unopened link's Copy link copies the share link and Cancel (confirmed) revokes it on .com under the admin root; an expired link has no Copy and its Remove revokes it.",
    "gym sharing owner copies or cancels an unopened link and removes an expired one",
    {
      steps: [
        { kind: "tap", describe: "Dee: Copy link.", handle: "[data-share-copy]" },
        { kind: "tap", describe: "Dee: Cancel → Cancel link.", handle: "[data-share-cancel]" },
        { kind: "tap", describe: "Eli (expired): Remove.", handle: "[data-share-cancel]" },
      ],
      assertions: [{ describe: "Copied toast", handle: "#toast", expect: "text", text: "Link copied" }],
      screenshots: [shot("owner-offered-links", "Waiting and expired links.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-sharing-share-sheet",
    "Share sheet: Cancel closes it with nothing sent; Create (Can manage, start-up approval and app data on) posts an admin-root-signed flagship/server-share-offer/v1 whose sealed offer carries those choices and the box's key; Copy link, Share (navigator.share) and Done (reloads the card).",
    "gym sharing owner's share sheet: Cancel sends nothing, Create signs the offer, Copy link, Share and Done",
    {
      steps: [
        { kind: "tap", describe: "Share this server → Cancel.", handle: "[data-share-close]" },
        { kind: "tap", describe: "Share this server → fill, tick all → Create link.", handle: "[data-share-create]" },
        { kind: "tap", describe: "Copy link, Share, Done.", handle: "[data-share-done]" },
      ],
      assertions: [{ describe: "Link shown", handle: "[data-share-link]", expect: "present" }],
      screenshots: [shot("share-sheet-all-on", "Every option on."), shot("share-sheet-link-ready", "The link.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-sharing-non-admin-read-only",
    "A non-admin device of an admin-pinned account (every share order signs under the admin root) sees who the server is shared with read-only, 'Only an admin device can share this server.' instead of Share this server, and the server page's other orders (update, backup, migrate, power, dead-man, transfer, revoke, delete) off with one line why; nothing is sent.",
    "gym sharing a non-admin device sees who the server is shared with but can't change it",
    {
      steps: [{ kind: "launch", describe: "A non-admin device opens a server shared with Sam." }],
      assertions: [
        { describe: "No Share button", handle: "#share-server-btn", expect: "absent" },
        { describe: "Admin-only note", handle: "[data-share-admin-only]", expect: "text", text: "Only an admin device can share this server." },
        { describe: "Server orders off", handle: "#update-server-btn", expect: "disabled" },
      ],
      screenshots: [shot("share-non-admin-read-only", "The read-only page.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-sharing-member-link",
    "Co-manager opening a share link: Not now goes Home with nothing accepted; a link .com doesn't know shows its error and Back to servers; Accept asks for the passphrase once and seals an admin-root-signed flagship/server-share-accept-admin/v1 with .com's attestation, saves the inbox entry and, once the owner confirms, 'Open home' lands on the shared server; the page's and the accept view's Back go Home.",
    "gym sharing co-manager link: Not now, a bad link's Back to servers, and Open once the owner confirms",
    {
      steps: [
        { kind: "tap", describe: "Not now.", handle: "[data-share-decline]" },
        { kind: "tap", describe: "Bad link → Back to servers.", handle: "[data-share-home]" },
        { kind: "tap", describe: "Accept → owner confirms → Open home.", handle: "[data-share-open]" },
        { kind: "tap", describe: "Back from the page and from the accept view.", handle: "#share-accept-back" },
      ],
      assertions: [{ describe: "Shared page at manage level", handle: "#shared-server-sub", expect: "text", text: "Can manage" }],
      screenshots: [shot("member-bad-link", "The bad link."), shot("member-confirmed", "Open after the owner confirmed.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-sharing-member-non-admin",
    "Only an admin device of the joining account accepts a co-manage share (the shared server checks the admin root's signature): a non-admin device's share link reads 'Only an admin device of your account can accept a co-manage invitation.' with Back to servers and no Accept; nothing is fetched or posted.",
    "gym sharing a non-admin device can't accept a co-manage link",
    {
      steps: [
        { kind: "launch", describe: "A non-admin device opens a share link." },
        { kind: "tap", describe: "Back to servers.", handle: "[data-share-home]" },
      ],
      assertions: [
        { describe: "Refusal", handle: "#share-accept-content", expect: "text", text: "Only an admin device of your account can accept a co-manage invitation." },
        { describe: "No Accept", handle: "[data-share-accept]", expect: "absent" },
      ],
      screenshots: [shot("member-non-admin-refused", "The refusal.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-sharing-member-demo-accept",
    "A demo account's device holds no admin root: Accept (no passphrase) has .com's demo signer sign flagship/server-share-accept-admin/v1 with the demo account's admin root, and seals that with the attestation, so the shared server checks it like any account's.",
    "gym sharing a demo account's device accepts through .com's demo signer",
    {
      steps: [{ kind: "tap", describe: "Accept.", handle: "[data-share-accept]" }],
      assertions: [{ describe: "Waiting for the owner", handle: "[data-share-waiting]", expect: "present" }],
      screenshots: [shot("member-demo-accepted", "Accepted on a demo account.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-sharing-member-notify",
    "Co-manager with start-up approval: 'Notify this device when it needs to start' posts a member-key-signed flagship/server-share-push/v1 (put, with the Web Push subscription and the link token); .com's unlock-not-shared refusal reads 'The owner hasn't let you approve this server's start-up.' and the switch goes back off; turning it off posts a signed delete.",
    "gym sharing co-manager turns start-up notices on and off",
    {
      steps: [
        { kind: "tap", describe: "Open home from Home's Shared with me.", handle: "[data-open-share]" },
        { kind: "tap", describe: "Notify on (refused), on, off.", handle: "#shared-notify-toggle" },
      ],
      assertions: [{ describe: "On toast", handle: "#toast", expect: "text", text: "Notices turned off" }],
      screenshots: [shot("member-notify-off", "Off."), shot("member-notify-on", "On.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-sharing-member-update",
    "Co-manager at Can manage: 'Update to v1.4.0' asks first (Cancel sends nothing); the box's busy refusal shows in words; Update posts a member-key-signed flagship/server-share-update/v1 to /api/shares/update over the share session and the card says it's updating.",
    "gym sharing co-manager updates a shared server to the newest release",
    {
      steps: [
        { kind: "tap", describe: "Update → Cancel; Update → Update (busy); Update → Update.", handle: "#shared-release-btn" },
      ],
      assertions: [{ describe: "Updating", handle: "#shared-release-offer", expect: "text", text: "Updating to v1.4.0" }],
      screenshots: [shot("member-update-offer", "The offer."), shot("member-update-sent", "Sent.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-sharing-member-approve-startup",
    "A shared server that is starting shows 'Waiting to start' with Approve start-up on its Home row; that opens the page, whose Approve start-up opens this account's copy of the disk key and answers the boot gate (Flagship-Boot-v1 share auth) sealed for the pinned server key.",
    "gym sharing co-manager approves a waiting start-up from its Home row",
    {
      steps: [
        { kind: "tap", describe: "Home row: Approve start-up.", handle: "[data-shared-approve]" },
        { kind: "tap", describe: "Page: Approve start-up.", handle: "#shared-startup-approve" },
      ],
      assertions: [{ describe: "Unlocking", handle: "#toast", expect: "text", text: "home is unlocking" }],
      screenshots: [shot("member-row-waiting-to-start", "The Home row."), shot("member-startup-approved", "Approved.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-sharing-member-access-list",
    "Co-manager at Can manage: a members-only app reads 'Members only. As a co-manager you can open it.' (never 'You need an invite'); saving an app's access list posts it signed with the member key; Refresh reads the page again; Back goes Home.",
    "gym sharing co-manager saves an app's access list, opens members-only apps, refreshes and goes back",
    {
      steps: [
        { kind: "tap", describe: "Internet access → edit → Save.", handle: "[data-access-save]" },
        { kind: "tap", describe: "Refresh, Back.", handle: "#shared-server-refresh" },
      ],
      assertions: [
        { describe: "Members-only line", handle: "[data-members-only]", expect: "text", text: "As a co-manager you can open it." },
        { describe: "Saved", handle: "#toast", expect: "text", text: "Access list saved" },
      ],
      screenshots: [shot("member-access-saved", "Saved.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-sharing-member-view-leave",
    "Co-manager at Can view: no Update, access or notice controls; Leave asks first (Cancel sends nothing), then posts a member-key-signed flagship/server-share-leave/v1 to the box and .com (with the link token), drops the inbox entry and returns Home.",
    "gym sharing co-manager at view level gets no Update or access controls and leaves the server",
    {
      steps: [{ kind: "tap", describe: "Leave → Cancel; Leave → Leave.", handle: "#shared-leave-btn" }],
      assertions: [
        { describe: "No Update", handle: "#shared-release-card", expect: "absent" },
        { describe: "Left", handle: "#toast", expect: "text", text: "You left home" },
      ],
      screenshots: [shot("member-view-level", "View level.")],
      dimension: "D4",
    },
  ),
];
