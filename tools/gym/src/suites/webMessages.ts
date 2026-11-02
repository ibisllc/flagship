/**
 * webapp gym scenarios: voi.ci pages and Messages (apps/web/e2e/gym/gym-messages.spec.ts,
 * docs/voici-and-messages.md §5, §6, §9, §10, §11; release 0.3 H11 chunk F). Same rules as web.ts: each `harness`
 * is the exact title of a test in that spec. The iOS (`GymMessages*`) and Android rows join these when chunks D and E
 * land.
 */

import type { Scenario } from "../scenario.js";
import { webTotal, shot } from "./helpers.js";

export const WEB_MESSAGES: readonly Scenario[] = [
  webTotal(
    "web-messages-thread-reply",
    "A visitor's message (a CA-attested pseudonym, a delegated P-256 browser key, sealed to the page's inbox key) shows under Requests as Visitor XXXX with an unread dot and a tab badge; a forged copy never shows; its link is a button that asks Open <host>? with the whole address; the owner's reply is signed under the page's ownerSignPub, opens with the visitor's thread key, moves the conversation out of Requests and shows Sent.",
    "gym messages owner reads a verified message and replies",
    {
      steps: [
        { kind: "launch", describe: "Publish the owner's page accepting messages; the inbox holds one real and one forged message." },
        { kind: "tap", describe: "Messages tab → Requests → the conversation.", handle: "#messages-list [data-conv]" },
        { kind: "tap", describe: "The link in the message, then Cancel.", handle: "[data-msg-link]" },
        { kind: "tap", describe: "Write a reply and Send.", handle: "#thread-send" },
      ],
      assertions: [
        { describe: "Unread badge", handle: "#messages-tab-badge", expect: "text", text: "1" },
        { describe: "Status under the reply", handle: "[data-testid=thread-status]", expect: "text", text: "Sent" },
        { describe: "No longer a request", handle: "[data-testid=thread-request]", expect: "absent" },
      ],
      screenshots: [shot("messages-requests", "Requests with one unread visitor."), shot("messages-thread-reply", "A thread after the owner's reply.")],
      dimension: "D6",
    },
  ),
  webTotal(
    "web-messages-page-publish",
    "The page editor on an admin device: the O1 warning card, a photo re-encoded in the browser, display name, bio, a link whose known-site label appears as it is typed, Accept messages, a post; everything grayed Not published yet until Publish, which shows the Page and message rules once and then the warning confirm; the index is signed by the admin root at seq 1 and the photo piece is a JPEG with no APP1/APP2 within 150 KiB.",
    "gym messages page editor publishes after the warning",
    {
      steps: [
        { kind: "launch", describe: "Messages tab with no page published." },
        { kind: "tap", describe: "Your page → pick a photo, fill the profile, add a link, Save profile.", handle: "#pe-save-profile" },
        { kind: "tap", describe: "Accept messages, write a post, Post.", handle: "#pe-post-add" },
        { kind: "tap", describe: "Publish → I agree → Publish.", handle: "#pe-publish" },
      ],
      assertions: [
        { describe: "Warning", handle: "[data-testid=voici-warning]", expect: "text", text: "Anyone can see this page. It shares your username with your apps and servers, so people can connect them." },
        { describe: "Published", handle: "[data-testid=page-status]", expect: "text", text: "Published at voi.ci/smoketest" },
      ],
      screenshots: [shot("page-editor-pending", "Unpublished changes grayed."), shot("page-editor-published", "The editor after the first publish.")],
      dimension: "D6",
    },
  ),
  webTotal(
    "web-messages-page-draft",
    "On a device without the admin root the editor has no Publish button and says why; a new post is sealed under the drafts key, signed by this device's account key with its admin-signed grant, deposited in the drafts lane, and shown grayed Waiting for an admin device to publish; nothing is published.",
    "gym messages a device without the admin root sends a draft and shows it grayed",
    {
      steps: [
        { kind: "launch", describe: "Messages tab as a non-admin device." },
        { kind: "tap", describe: "Your page → write a post → Post.", handle: "#pe-post-add" },
      ],
      assertions: [
        { describe: "Admin-only line", handle: "[data-testid=page-admin-only]", expect: "text", text: "Only an admin device can publish your page. Changes you make here wait for it." },
        { describe: "No Publish", handle: "#pe-publish", expect: "absent" },
        { describe: "Grayed", handle: "[data-testid=page-status]", expect: "text", text: "Waiting for an admin device to publish" },
      ],
      screenshots: [shot("page-editor-draft", "A draft waiting for the admin device.")],
      dimension: "D6",
    },
  ),
  webTotal(
    "web-messages-block-report",
    "A thread's menu renames the visitor (the nickname lives only in the sealed state blob), Accept sends a signed unblock order (.com's Accept), a message's Report sends a report signed by the page's messages key with no text attached, and Block signs flagship/voici-block/v1 for .com's filter, adds the pseudonym to the state's blocks and hides the conversation.",
    "gym messages rename block and report a visitor",
    {
      steps: [
        { kind: "launch", describe: "Publish the owner's page; one visitor message waits." },
        { kind: "tap", describe: "More → Rename → Spammer.", handle: "#thread-menu" },
        { kind: "tap", describe: "Report on the message → Spam.", handle: "[data-msg-report]" },
        { kind: "tap", describe: "More → Block → Block.", handle: "#thread-menu" },
      ],
      assertions: [
        { describe: "Renamed", handle: "#thread-title", expect: "text", text: "Spammer" },
        { describe: "Hidden after block", handle: "#messages-list [data-conv]", expect: "absent" },
      ],
      screenshots: [shot("messages-after-block", "Messages after blocking the only visitor.")],
      dimension: "D6",
    },
  ),
  webTotal(
    "web-messages-sign-in-approval",
    "Sign in with Flagship from the webapp (slow tier): a voi.ci sign-in link opens the approval with the page's verified display name, the same 6-digit code as the voi.ci tab over /qr-pipe, and how the visitor appears; Approve shows the rules once and asks for this device's passphrase; the attestation request says deviceCheckRef none; the sealed answer passes voi.ci's checkVoiciSignInAnswer; Settings → Messages lists the website.",
    "gym messages approve a voi.ci sign-in on the slow tier",
    {
      steps: [
        { kind: "launch", describe: "Open a voi.ci sign-in link for Bob's page; the pipe is played by the test." },
        { kind: "tap", describe: "Approve → I agree → passphrase.", handle: "#voici-sign-in-approve" },
      ],
      assertions: [
        { describe: "Title", handle: "[data-testid=voici-sign-in-title]", expect: "text", text: "Sign in to voi.ci to message Bob Builder?" },
        { describe: "Done", handle: "[data-testid=voici-sign-in-done]", expect: "text", text: "Signed in. You can go back to voi.ci." },
      ],
      screenshots: [shot("voici-sign-in-approve", "The approval with the shared code."), shot("messages-settings-signed-in", "Settings → Messages listing the website.")],
      dimension: "D6",
    },
  ),
  webTotal(
    "web-messages-reply-alert",
    "Reply alerts on the visitor's side (owner decision): for a voi.ci page this browser signed in to, opening the app fetches its own thread with a key P delegated to (flagship/voici-thread-fetch/v1) and, for an owner reply that checks and opens with the thread key and is newer than the last seen, shows one row You have a reply on voi.ci/<x> (and the tab badge) that opens https://voi.ci/<x>; the conversation is not shown in the app; once opened the row stays gone for that reply.",
    "gym messages a reply on a voi.ci page this account wrote to shows once",
    {
      steps: [
        { kind: "launch", describe: "This account signed in to Bob's page; Bob replied." },
        { kind: "tap", describe: "Messages tab → the reply row.", handle: "[data-reply-page]" },
      ],
      assertions: [
        { describe: "Reply row", handle: "[data-reply-page]", expect: "text", text: "You have a reply on voi.ci/bob" },
        { describe: "Badge", handle: "#messages-tab-badge", expect: "text", text: "1" },
      ],
      screenshots: [shot("messages-reply-alert", "A reply waiting on a voi.ci page.")],
      dimension: "D6",
    },
  ),
];
