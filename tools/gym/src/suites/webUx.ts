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
  webTotal(
    "web-ux-first-contact-proof",
    "First contact: the device that made the recipe checks the box's enrollment proof, shows the code it computes from the key directly above Approve, pins the key on Approve, mints the entitlement for it and posts an admin-signed flagship/server-wildcard-grant/v1 over the pinned key.",
    "gym ux first contact a good proof shows the code above Approve, pins the key and sends the app-name grant",
    {
      steps: [
        { kind: "launch", describe: "Reach Home on an admin device that kept the recipe's enrollment secret; a new box asks for its entitlement with a good proof." },
        { kind: "tap", describe: "Yes, this is my box.", handle: "[data-approve-id]" },
      ],
      assertions: [{ describe: "Code box", handle: "[data-server-code]", expect: "present" }],
      screenshots: [shot("first-contact-code-box", "The code above Approve.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-ux-first-contact-bad-proof",
    "A first request whose enrollment proof is wrong or missing reads \"This server was not built from your recipe. Do not approve it.\" with no Approve, and nothing is pinned or answered.",
    "gym ux first contact a wrong or missing proof is refused and nothing is pinned",
    {
      steps: [{ kind: "launch", describe: "Two new boxes ask: one with a wrong proof, one with none." }],
      assertions: [{ describe: "Refusal", handle: "[data-first-contact-refusal=not-your-recipe]", expect: "present" }],
      screenshots: [shot("first-contact-not-your-recipe", "Both requests refused.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-ux-first-contact-key-changed",
    "After the pin, a request under another key reads \"This server's key changed. If you did not rebuild it, do not approve anything for it.\" with no Approve, and Home's card says the same.",
    "gym ux first contact a request under a key other than the pin is refused, and Home says so",
    {
      steps: [{ kind: "launch", describe: "The server is pinned; a start-up request arrives under another key." }],
      assertions: [{ describe: "Refusal", handle: "[data-first-contact-refusal=key-changed]", expect: "present" }],
      screenshots: [shot("first-contact-key-changed", "The refused request.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-ux-first-contact-first-sight",
    "A device without the recipe's secret shows the same code box and pins the key on first sight, then sends the app-name grant.",
    "gym ux first contact a device without the recipe's secret pins on first sight with the code box",
    {
      steps: [{ kind: "tap", describe: "Yes, this is my box.", handle: "[data-approve-id]" }],
      assertions: [{ describe: "Code box", handle: "[data-server-code]", expect: "present" }],
      screenshots: [shot("first-contact-first-sight", "The code on first sight.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-ux-first-contact-silent-grant",
    "On a pinned server's page an admin device that reads granted:false signs the app-name grant silently over the pinned key.",
    "gym ux first contact the server page signs the app-name grant silently when the server has none",
    {
      steps: [{ kind: "launch", describe: "Open a pinned server's page; the server holds no grant." }],
      assertions: [{ describe: "No key card", handle: "#server-key-card", expect: "absent" }],
      screenshots: [shot("first-contact-silent-grant", "The server page after the silent grant.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-ux-recovery-passkey-challenge",
    "SEC-REPAIR-001: the recovery window (its real origin, a virtual WebAuthn authenticator with PRF) enrols with the attestation object beside the result, then recovers in order: passphrase, .com's challenge, ONE passkey sheet that gives the PRF and signs the challenge, and the fetch carrying that assertion.",
    "gym ux passkey recovery the recovery window signs .com's challenge in the one passkey sheet and the fetch carries it",
    {
      steps: [
        { kind: "launch", describe: "Open recovery.flagshipserver.com/#enroll with a PRF-capable virtual authenticator; enrol with a passphrase." },
        { kind: "tap", describe: "Recover with the same passphrase.", handle: "#recover-go" },
      ],
      assertions: [{ describe: "Recover view", handle: "#view-recover", expect: "present" }],
      screenshots: [shot("recovery-window-done", "The recovery window after a passkey-checked recovery.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-ux-recovery-passkey-legacy-update",
    "A recovery record from before the passkey check (passkeyLegacy) offers Update your account recovery once in the recovery window: Update makes a new passkey over the same passphrase and hands back its attestation; Not now is remembered and the next recovery asks nothing.",
    "gym ux passkey recovery a record from before offers Update once; Update sends a new passkey, Not now is remembered",
    {
      steps: [
        { kind: "tap", describe: "Recover a record from before; Update.", handle: "#recover-update-go" },
        { kind: "tap", describe: "Recover again; Not now. Recover a third time.", handle: "#recover-update-later" },
      ],
      assertions: [{ describe: "Update panel title", handle: "#recover-update-title", expect: "text", text: "Update your account recovery" }],
      screenshots: [shot("recovery-window-update", "The one-time update in the recovery window.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-ux-recovery-update-prompt",
    "On the first Home of a session the webapp asks once to update a recovery record from before (Update / Not now); Not now is remembered per account and Settings keeps a quiet Update account recovery row.",
    "gym ux recovery update a record from before is asked about once; Not now is remembered and Settings keeps Update",
    {
      steps: [
        { kind: "launch", describe: "Reach Home on an admin device; .com says the record has passkeyRequired false." },
        { kind: "tap", describe: "Not now, then Home again, then Settings, Cloud recovery.", handle: "[data-modal-choice=later]" },
      ],
      assertions: [{ describe: "Settings row", handle: "#recovery-cloud-update", expect: "text", text: "Update account recovery" }],
      screenshots: [shot("recovery-update-prompt", "The one-time prompt."), shot("recovery-update-row", "Settings keeps the Update row.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-ux-recovery-update-run",
    "Update account recovery re-enrols through the recovery window and the signed record goes to .com with passkeyAttestationObject beside the claim (never inside the signed bytes); the row then goes away.",
    "gym ux recovery update Update re-enrols and the record carries the passkey's attestation",
    {
      steps: [{ kind: "tap", describe: "Settings, Cloud recovery, Update account recovery.", handle: "#recovery-cloud-update" }],
      assertions: [{ describe: "Row gone", handle: "#recovery-cloud-update", expect: "absent" }],
      screenshots: [shot("recovery-updated", "Cloud recovery after the update.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-ux-wipe-restart-attestation",
    "Wipe & restart sends newPasskeyAttestationObject, the attestation of the new recovery passkey whose credential id the old key signs.",
    "gym ux recovery update wipe and restart sends the new passkey's attestation",
    {
      steps: [{ kind: "tap", describe: "Trusted devices, Wipe & restart, a new browser passphrase.", handle: "#wipe-restart-btn" }],
      assertions: [{ describe: "Wipe button", handle: "#wipe-restart-btn", expect: "present" }],
      screenshots: [shot("wipe-restart-attestation", "After the wipe request.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-ux-browser-grant-sheet",
    "SEC-BROWSER-002: an app's browser-access request shows in a sheet and under Activity from its structured fields (the verified app name, each site exactly, wildcards spelled out, local network, capabilities, duration, the app's own words quoted); Allow is labelled by the ask's duration and signs flagship/browser-grant/v1 for it; Deny is unsigned.",
    "gym ux browser grants an ask shows in a sheet and under Activity; Allow signs the ask's duration and Deny is unsigned",
    {
      steps: [
        { kind: "launch", describe: "Reach Home on an admin device; the box holds a session ask and a one-visit whole-LAN ask." },
        { kind: "tap", describe: "Allow for this session; Not now on the second, then Deny it under Activity.", handle: "[data-browser-grant-sheet]" },
      ],
      assertions: [
        { describe: "Sheet", handle: "[data-browser-grant-sheet]", expect: "present" },
        { describe: "Activity heading", handle: "#activity-browser-heading", expect: "text", text: "Browser access requests" },
      ],
      screenshots: [shot("browser-grant-sheet", "The browser access sheet."), shot("browser-grant-activity", "A waiting ask under Activity.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-ux-browser-grant-app-page",
    "The app's page has a Browser access section: the manifest's sites (Approved when you installed it) and this app's waiting asks, answered in place with a signed Always allow.",
    "gym ux browser grants the app's page lists what the manifest grants and answers a waiting ask",
    {
      steps: [{ kind: "tap", describe: "Open the app's page; Always allow on the waiting ask.", handle: "#sd-browser-access" }],
      assertions: [{ describe: "Manifest sites", handle: "[data-browser-manifest]", expect: "present" }],
      screenshots: [shot("browser-grant-app-page", "Browser access on the app's page.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-ux-upstream-sync-proposal",
    "N12: an imported app's page offers Check for updates from <repo>; the box's three-way proposal shows the version, new permissions apart and before the code, the counts and the conflicts (your version kept), and Review and deploy opens the existing git build screen; nothing is deployed.",
    "gym ux upstream sync the proposal shows new permissions apart and the conflicts, then opens the build to deploy",
    {
      steps: [
        { kind: "tap", describe: "Check for updates from github.com/alice/notes with ref v2.0.", handle: "#sd-sync-upstream" },
        { kind: "tap", describe: "Review and deploy.", handle: "[data-sync-choice=review]" },
      ],
      assertions: [{ describe: "New permissions", handle: "[data-sync-capabilities]", expect: "present" }],
      screenshots: [shot("upstream-sync-proposal", "The sync proposal.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-ux-upstream-sync-up-to-date",
    "Already the latest version: the sheet says so and Close discards the build the check opened; an app the box did not import answers 404 and the sheet says it can't check for updates.",
    "gym ux upstream sync up to date discards the opened build, and an app not imported here says so",
    {
      steps: [{ kind: "tap", describe: "Check for updates (up to date), Close; check again (404), Cancel.", handle: "#sd-sync-upstream" }],
      assertions: [{ describe: "Up to date", handle: "[data-sync-up-to-date]", expect: "present" }],
      screenshots: [shot("upstream-sync-up-to-date", "Already the latest version.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-ux-upstream-sync-no-repo",
    "An app with no repo on record offers no update check.",
    "gym ux upstream sync an app with no repo offers no check",
    {
      steps: [{ kind: "launch", describe: "Open an editable app with no import or adapter repo." }],
      assertions: [{ describe: "No sync row", handle: "#sd-sync-upstream", expect: "absent" }],
      screenshots: [shot("upstream-sync-no-repo", "An app page with no update check.")],
      dimension: "D4",
    },
  ),
];
