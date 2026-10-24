/**
 * webapp gym scenarios for the feat/UX round (apps/web/e2e/gym/gym-ux.spec.ts):
 * languages (docs/i18n.md), named links (docs/named-links.md), the `.com`
 * name dibs notice, and the owner UI round (Home, Activity, Settings). Same
 * rules as web.ts: each `harness` is the exact title of a test in that spec.
 * The cheap, single-screen checks run every merge; the rest in `gym:total`.
 */

import type { Scenario } from "../scenario.js";
import { web, webTotal, shot } from "./helpers.js";

const LANGUAGE_STEPS = [
  { kind: "launch" as const, describe: "Browser locale set; create and unlock an account, waiting on the page's structure only." },
  { kind: "tap" as const, describe: "Home, then the Services, Activity and Settings tabs.", handle: "#tab-bar" },
  { kind: "assert" as const, describe: "Known catalog values show; none of those screens' English sentences remain.", handle: "#view-settings-tab" },
];

export const WEB_UX: readonly Scenario[] = [
  // ── every merge ──
  web(
    "web-ux-language-fr",
    "A French browser gets Home, Services, Activity and Settings in French (html lang fr, catalog values shown, no English sentences left).",
    "gym ux language a French browser gets Home, Services, Activity and Settings in French",
    {
      steps: LANGUAGE_STEPS,
      assertions: [
        { describe: "Add / Restore in French", handle: "#home-add-server", expect: "text", text: "Ajouter / restaurer un serveur" },
        { describe: "AI API keys row in French", handle: "#settings-tab-providers", expect: "text", text: "Clés d’API d’IA" },
      ],
      screenshots: [shot("language-fr-settings", "Settings in French.")],
      dimension: "D3",
    },
  ),
  web(
    "web-ux-language-en",
    "An English-first browser stays in English on the same four screens.",
    "gym ux language an English-first browser stays in English",
    {
      steps: LANGUAGE_STEPS,
      assertions: [{ describe: "English button", handle: "#home-add-server", expect: "text", text: "Add / Restore a server" }],
      screenshots: [shot("language-en-settings", "Settings in English.")],
      dimension: "D3",
    },
  ),
  web(
    "web-ux-owner-home-activity",
    "Home's button reads exactly Add / Restore a server; Activity with no server shows the same Add a server first card as Services.",
    "gym ux owner round Home's add button and Activity with no server show the new wording and the Services card",
    {
      steps: [
        { kind: "launch", describe: "Reach Home on an admin device; .com lists no servers." },
        { kind: "tap", describe: "Activity, then Services.", handle: "#tab-bar" },
        { kind: "assert", describe: "Both show the identical no-server card.", handle: "[data-no-server]" },
      ],
      assertions: [
        { describe: "Home button", handle: "#home-add-server", expect: "text", text: "Add / Restore a server" },
        { describe: "No-server card", handle: "#activity-no-server .empty-headline", expect: "text", text: "Add a server first" },
      ],
      screenshots: [shot("activity-no-server", "Activity with no server.")],
      dimension: "D3",
    },
  ),
  web(
    "web-ux-owner-recovery-help",
    "Cloud recovery's How this works sits behind a (?) that opens a dialog, which Close and Escape both dismiss.",
    "gym ux owner round Cloud recovery's (?) opens How this works and closes it",
    {
      steps: [
        { kind: "tap", describe: "Settings, then Cloud recovery.", handle: "#settings-tab-recovery" },
        { kind: "tap", describe: "The (?) button.", handle: "#recovery-help" },
        { kind: "tap", describe: "Close.", handle: "#recovery-help-close" },
      ],
      assertions: [{ describe: "Help title", handle: "#recovery-help-dialog .modal-title", expect: "text", text: "How this works" }],
      screenshots: [shot("recovery-help", "The How this works dialog.")],
      dimension: "D3",
    },
  ),
  web(
    "web-ux-owner-settings-buttons",
    "Settings' bottom: Sign out, Remove this device and Delete account carry the danger style; Lock the app is a plain button.",
    "gym ux owner round Sign out, Remove device and Delete account are red and Lock the app is plain",
    {
      steps: [
        { kind: "tap", describe: "Settings.", handle: "[data-tab-target=settings]" },
        { kind: "assert", describe: "Danger classes on the three, none on Lock.", handle: "#settings-danger-zone-card" },
      ],
      assertions: [{ describe: "Lock the app", handle: "#settings-pin-lock", expect: "text", text: "Lock the app" }],
      screenshots: [shot("settings-bottom", "The bottom of Settings.")],
      dimension: "D7",
    },
  ),
  web(
    "web-ux-dibs-closed",
    "With the dibs window closed Home shows no Claim your .com name notice.",
    "gym ux dibs Home shows no dibs notice while the window is closed",
    {
      steps: [
        { kind: "launch", describe: "Reach Home; .com's name-dibs window answers closed." },
        { kind: "assert", describe: "No notice.", handle: "#home-dibs-banner" },
      ],
      assertions: [{ describe: "No notice", handle: "#home-dibs-banner", expect: "absent" }],
      screenshots: [shot("dibs-closed", "Home with no dibs notice.")],
      dimension: "D3",
    },
  ),

  // ── total ──
  webTotal(
    "web-ux-language-ja",
    "A Japanese browser gets Home, Services, Activity and Settings in Japanese.",
    "gym ux language a Japanese browser gets Home, Services, Activity and Settings in Japanese",
    {
      steps: LANGUAGE_STEPS,
      assertions: [{ describe: "Add / Restore in Japanese", handle: "#home-add-server", expect: "text", text: "サーバーを追加 / 復元" }],
      screenshots: [shot("language-ja-settings", "Settings in Japanese.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-ux-language-pt-br",
    "A Brazilian Portuguese browser gets Home's button and Settings' rows in pt-BR.",
    "gym ux language a Brazilian Portuguese browser gets Home and Settings in pt-BR",
    {
      steps: LANGUAGE_STEPS,
      assertions: [{ describe: "Add / Restore in pt-BR", handle: "#home-add-server", expect: "text", text: "Adicionar / restaurar um servidor" }],
      screenshots: [shot("language-pt-BR-settings", "Settings in pt-BR.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-ux-language-zh-hans",
    "A Simplified Chinese browser (zh-CN) gets Home's button and Settings' rows in zh-Hans.",
    "gym ux language a Simplified Chinese browser gets Home and Settings in zh-Hans",
    {
      steps: LANGUAGE_STEPS,
      assertions: [{ describe: "Add / Restore in zh-Hans", handle: "#home-add-server", expect: "text", text: "添加 / 恢复服务器" }],
      screenshots: [shot("language-zh-Hans-settings", "Settings in zh-Hans.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-ux-named-link-set",
    "The service page shows Your link with the random code; local and .com checks speak (At least 4 characters, Letters…, Reserved, Available); Save sends a signed set order and the field shows the name with Use default.",
    "gym ux named links the service page shows Your link and an admin sets a name with a signed order",
    {
      steps: [
        { kind: "launch", describe: "Open the notes service page; .com's links answer carries the link state." },
        { kind: "type", describe: "halloweenparty", handle: "[data-lf=input]" },
        { kind: "tap", describe: "Save.", handle: "[data-lf=actions] button" },
      ],
      assertions: [
        { describe: "Label", handle: "[data-lf=root] label", expect: "text", text: "Your link" },
        { describe: "Use default", handle: "[data-lf=actions] button", expect: "present" },
      ],
      screenshots: [shot("named-link-set", "The link field after a name is set.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-ux-named-link-admin-root",
    "An admin device signs the voici-name order with the admin root, the only key .com accepts on an admin-pinned account (expected to fail until lib/adminRoot.js lists flagship/voici-name/v1).",
    "gym ux named links an admin device signs the order with the admin root, as .com requires",
    {
      steps: [
        { kind: "type", describe: "halloweenparty", handle: "[data-lf=input]" },
        { kind: "tap", describe: "Save.", handle: "[data-lf=actions] button" },
      ],
      assertions: [{ describe: "Name kept", handle: "[data-lf=input]", expect: "present" }],
      screenshots: [shot("named-link-admin-root", "The field after Save.")],
      dimension: "D6",
    },
  ),
  webTotal(
    "web-ux-named-link-refusals",
    "Each .com refusal (taken, reserved, dibs with its domain, change-limit with the next time, name-limit, rate-limited, app-not-running) reads as a sentence, never a code.",
    "gym ux named links each refusal from .com reads as a sentence",
    {
      steps: [
        { kind: "type", describe: "One name per refusal.", handle: "[data-lf=input]" },
        { kind: "tap", describe: "Save; .com refuses.", handle: "[data-lf=actions] button" },
      ],
      assertions: [{ describe: "Message", handle: "[data-lf=msg]", expect: "present" }],
      screenshots: [shot("named-link-refused", "The field after a refusal.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-ux-named-link-dibs",
    "A name held for a .com owner says so and offers I own it, which opens the claim screen with the name filled in.",
    "gym ux named links a .com holder's name offers I own it, and the claim screen opens with it",
    {
      steps: [
        { kind: "type", describe: "halloweenparty", handle: "[data-lf=input]" },
        { kind: "tap", describe: "I own it.", handle: "[data-lf=actions] button" },
      ],
      assertions: [{ describe: "Claim dialog", handle: "dialog[aria-label=\"Claim your .com name\"]", expect: "present" }],
      screenshots: [shot("named-link-dibs", "The claim screen with the name filled in.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-ux-named-link-change-limit",
    "With no changes left the field says when the next change is, and the 60-day release note shows under a live name.",
    "gym ux named links at the change limit the field says when the next change is",
    {
      steps: [{ kind: "launch", describe: "Open the service page with changesLeft 0." }],
      assertions: [{ describe: "Release note", handle: "[data-lf=note]", expect: "text", text: "Unused for 60 days, it's released." }],
      screenshots: [shot("named-link-change-limit", "The field at the change limit.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-ux-named-link-clear",
    "Use default asks first (Cancel sends nothing), then a signed clear brings the random code back.",
    "gym ux named links clearing a name asks first and brings the random code back",
    {
      steps: [
        { kind: "tap", describe: "Use default, Cancel, then Use default and Replace.", handle: "[data-lf=actions] button" },
        { kind: "assert", describe: "The field holds the random code.", handle: "[data-lf=input]" },
      ],
      assertions: [{ describe: "Field", handle: "[data-lf=input]", expect: "present" }],
      screenshots: [shot("named-link-cleared", "The field back on the random code.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-ux-dibs-open",
    "While .com's dibs window is open Home shows Own a .com? with the closing date and Claim your .com name, which opens the claim screen.",
    "gym ux dibs Home shows Claim your .com name while the window is open and the claim screen opens",
    {
      steps: [
        { kind: "launch", describe: "Reach Home; name-dibs/window answers open until 2027-04-25." },
        { kind: "tap", describe: "Claim your .com name.", handle: "#home-dibs-banner [data-ann-cta]" },
      ],
      assertions: [
        { describe: "Notice", handle: "#home-dibs-banner", expect: "present" },
        { describe: "Claim dialog", handle: "dialog[aria-label=\"Claim your .com name\"]", expect: "present" },
      ],
      screenshots: [shot("dibs-banner", "Home with the dibs notice.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-ux-owner-ai-keys",
    "AI API keys: each key is one compact row (name · provider, masked key, Default tag); its ⋯ menu holds the key settings, Make default and Delete key, which asks first.",
    "gym ux owner round AI API keys are compact rows with Make default and a confirmed Delete key",
    {
      steps: [
        { kind: "launch", describe: "Two saved keys; open Settings → AI API keys." },
        { kind: "tap", describe: "⋯, Make default; ⋯, Delete key, Cancel, then Delete.", handle: "[data-action=more]" },
      ],
      assertions: [{ describe: "Heading", handle: "#view-settings > h2", expect: "text", text: "AI API keys" }],
      screenshots: [shot("ai-keys-rows", "The compact key rows.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-ux-owner-scan-or-link",
    "Scan a code or enter a link (Process URL is gone) refuses junk with a sentence and opens a pasted join link on the join screen, which still waits for the match code.",
    "gym ux owner round Scan a code or enter a link opens a pasted join link and refuses junk",
    {
      steps: [
        { kind: "tap", describe: "Settings → Scan a code or enter a link.", handle: "#settings-tab-join-account" },
        { kind: "type", describe: "Junk, then a /join link.", handle: "[data-join-input]" },
      ],
      assertions: [
        { describe: "Row", handle: "#settings-tab-join-account", expect: "text", text: "Scan a code or enter a link" },
        { describe: "No Process URL", handle: "#settings-tab-process-url", expect: "absent" },
      ],
      screenshots: [shot("scan-or-link-refused", "The dialog refusing junk.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-ux-chat-request-answer",
    "A held app chat request shows in a sheet (the sender is a claim, with its phrase and count) and under Activity; Allow and Deny are owner-signed flagship/chat-approval/v1 answers, an outgoing request offers no Always allow, and Not now leaves it waiting in Activity.",
    "gym ux chat requests a request shows in a sheet and under Activity, and Allow and Deny send signed answers",
    {
      steps: [
        { kind: "launch", describe: "Reach Home on an admin device; the box holds an incoming and an outgoing chat request." },
        { kind: "tap", describe: "Allow the incoming one, Deny the outgoing one; a socket event brings a third: Not now, then Deny it in Activity.", handle: "[data-chat-sheet]" },
      ],
      assertions: [
        { describe: "Sheet", handle: "[data-chat-sheet]", expect: "present" },
        { describe: "Activity heading", handle: "#activity-chat-heading", expect: "text", text: "App chat requests" },
      ],
      screenshots: [shot("chat-request-sheet", "The chat request sheet."), shot("chat-request-activity", "A waiting request under Activity.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-ux-chat-always-revoke",
    "Always allow (signed) says it lets any remote machine in; Activity lists the app under Apps that take chats without asking, and Ask me each time ends it.",
    "gym ux chat requests Always allow is listed under Activity and Ask me each time ends it",
    {
      steps: [
        { kind: "tap", describe: "Always allow in the sheet.", handle: "[data-choice=always]" },
        { kind: "tap", describe: "Activity, then Ask me each time.", handle: "[data-chat-revoke]" },
      ],
      assertions: [{ describe: "Always row", handle: "[data-chat-always]", expect: "present" }],
      screenshots: [shot("chat-always-listed", "An Always allow under Activity.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-ux-ai-consent-continue",
    "An AI adapt answered 428 ai-consent shows the token range and who pays before anything runs; Continue resends it once with a signed flagship/ai-repair-consent/v1 covering the estimate.",
    "gym ux ai consent an adapt shows the estimate first and Continue resends it with a signed consent",
    {
      steps: [
        { kind: "tap", describe: "Reopen a not-fit git build and tap Use AI to adapt and deploy.", handle: "#build-git-adapt" },
        { kind: "tap", describe: "Continue.", handle: "[data-choice=continue]" },
      ],
      assertions: [{ describe: "Consent sheet", handle: "[data-ai-consent]", expect: "text", text: "This uses AI that costs money" }],
      screenshots: [shot("ai-consent-sheet", "The AI cost estimate.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-ux-ai-consent-cancel",
    "Cancel on the AI cost estimate sends nothing more and follows nothing; the adapt stays on offer.",
    "gym ux ai consent Cancel sends nothing more and offers the adapt again",
    {
      steps: [{ kind: "tap", describe: "Use AI to adapt and deploy, then Cancel.", handle: "[data-choice=cancel]" }],
      assertions: [{ describe: "Adapt offered", handle: "#build-git-adapt", expect: "present" }],
      screenshots: [shot("ai-consent-cancelled", "The verdict after Cancel.")],
      dimension: "D4",
    },
  ),
];
