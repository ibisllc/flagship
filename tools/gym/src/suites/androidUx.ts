/**
 * Android gym scenarios: the 0.3 security screens. App chat requests (N08), AI-run consent (N12)
 * the watch boot key (option (a), docs/watch-boot-approval-without-unlock.md) and first contact
 * (docs/first-contact.md), passkey recovery (SEC-REPAIR-001), browser access beyond a manifest
 * (SEC-BROWSER-002) and syncing an imported app with its upstream (N12). Each `harness` is a method
 * of GymUxScreensTest, GymPasskeyBrowserSyncTest or GymUpdateResultsTest (apps/mobile/android/app/src/androidTest). NO
 * BACKEND: the mock box and `.com` check every signature the way the real ones do on an
 * admin-pinned account, and the mock `.com` checks the recovery passkey as the real one does.
 */

import type { Scenario } from "../scenario.js";
import { androidTotal, shot } from "./helpers.js";

const PKG = "com.flagshipserver.app.gym";

export const ANDROID_UX: readonly Scenario[] = [
  androidTotal(
    "android-ux-chat-request-allow-deny",
    "A content-free push wakes the app: a held chat request asks in a dialog that names the sender as a claim ('A remote machine claiming to run …'); Allow sends an admin-signed flagship/chat-approval/v1; the outgoing request waits under Activity → App chat requests, where Deny answers it.",
    `${PKG}.GymUxScreensTest#chatRequestAllowFromTheDialogDenyFromActivity`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=activity as an admin device; the mock box then holds an incoming and an outgoing request and a push lands." },
        { kind: "tap", describe: "Allow in the dialog.", handle: "chat-alert-allow" },
        { kind: "tap", describe: "Not now on the outgoing request.", handle: "chat-alert-not-now" },
        { kind: "tap", describe: "Open App chat requests under Activity.", handle: "activity-section-chat" },
        { kind: "tap", describe: "Deny the outgoing request there.", handle: "chat-request-deny-c0ffee02" },
      ],
      assertions: [
        { describe: "The dialog names the sender as a claim", handle: "chat-alert-title", expect: "text", text: "A remote machine claiming to run" },
        { describe: "The answered request leaves the list", handle: "chat-request-c0ffee02", expect: "absent" },
      ],
      screenshots: [shot("chat-request-dialog", "The chat request dialog."), shot("chat-requests-activity", "App chat requests under Activity.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-ux-chat-always-revoke",
    "Always allow (incoming only) is per claimed sender: it lists '<claimed sender> → <your app>' under Activity; Ask me each time ends that one (unsigned: it only narrows what is open).",
    `${PKG}.GymUxScreensTest#chatAlwaysAllowThenAskMeEachTime`,
    {
      steps: [
        { kind: "tap", describe: "Always allow in the dialog.", handle: "chat-alert-always" },
        { kind: "tap", describe: "Open App chat requests under Activity.", handle: "activity-section-chat" },
        { kind: "tap", describe: "Ask me each time.", handle: "chat-always-revoke-riverside-garden-club--bright-maple-plants" },
      ],
      assertions: [{ describe: "The Always allow is gone", handle: "chat-always-riverside-garden-club--bright-maple-plants", expect: "absent" }],
      screenshots: [shot("chat-always-allow", "An app that takes chats without asking.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-ux-ai-consent-continue",
    "A git adapt the box answers 428 ai-consent shows the most it may use (the run stops there), the provider and who pays; nothing runs until Continue, which resends the adapt once with an admin-signed flagship/ai-repair-consent/v1.",
    `${PKG}.GymUxScreensTest#aiConsentContinueResendsWithASignedConsent`,
    {
      steps: [
        { kind: "tap", describe: "Build with the AI on a repo that isn't ready.", handle: "build-git-adapt" },
        { kind: "assert", describe: "The consent sheet with the estimate.", handle: "ai-consent" },
        { kind: "tap", describe: "Continue.", handle: "ai-consent-continue" },
      ],
      assertions: [
        { describe: "Who pays", handle: "ai-consent-payer", expect: "text", text: "with your own API key" },
        { describe: "The sheet closes", handle: "ai-consent", expect: "absent" },
      ],
      screenshots: [shot("ai-consent", "The AI-run consent sheet.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-ux-ai-consent-cancel",
    "Cancel on the AI-run consent sheet sends nothing more and signs nothing: the verdict stays with Build with the AI.",
    `${PKG}.GymUxScreensTest#aiConsentCancelRunsNothing`,
    {
      steps: [
        { kind: "tap", describe: "Build with the AI.", handle: "build-git-adapt" },
        { kind: "tap", describe: "Cancel.", handle: "ai-consent-cancel" },
      ],
      assertions: [{ describe: "Back on the verdict", handle: "build-git-adapt", expect: "present" }],
      screenshots: [shot("ai-consent-cancelled", "Back on the verdict after Cancel.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-ux-watch-boot-key",
    "Settings → Account security → Approve from watch, then a server's 'Start-ups with this phone locked' switch: on deposits a copy of its disk key sealed to the watch's boot-only Keystore key (attested by the account key, lasting no longer than the delegate); off takes every copy away.",
    `${PKG}.GymUxScreensTest#watchBootKeyPerServerOnAndOff`,
    {
      steps: [
        { kind: "tap", describe: "Approve from watch.", handle: "watch-delegate-toggle" },
        { kind: "tap", describe: "Home's switch on.", handle: "watch-boot-toggle-home" },
        { kind: "assert", describe: "On until a date.", handle: "watch-boot-until-home" },
        { kind: "tap", describe: "Home's switch off.", handle: "watch-boot-toggle-home" },
      ],
      assertions: [{ describe: "Off again", handle: "watch-boot-until-home", expect: "absent" }],
      screenshots: [shot("watch-boot-off", "The per-server switches."), shot("watch-boot-on", "Home on.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-ux-first-contact-code",
    "First contact: a server this phone created sends its entitlement request with the recipe's enrollment proof; Activity → Server approvals shows the six-digit code computed on the phone from that key directly above Approve ('If your machine has a monitor, it is showing this code: …'); Approve pins the key, deletes the secret and signs flagship/server-wildcard-grant/v1 over the pinned key with the admin root.",
    `${PKG}.GymUxScreensTest#firstContactShowsTheCodeThenPinsAndSignsTheGrant`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=activity as an admin device; the mock .com holds a signed entitlement request with a valid proof." },
        { kind: "tap", describe: "Open Server approvals.", handle: "activity-section-approvals" },
        { kind: "assert", describe: "The code box above Approve.", handle: "server-code" },
        { kind: "tap", describe: "Approve.", handle: "secret-request-approve" },
      ],
      assertions: [{ describe: "The code sentence", handle: "server-code", expect: "text", text: "If your machine has a monitor, it is showing this code:" }],
      screenshots: [shot("first-contact-code", "The code box above Approve.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-ux-first-contact-not-from-recipe",
    "First contact refused: a server whose first request lacks the enrollment proof, on the phone holding the recipe's secret, shows 'This server was not built from your recipe. Do not approve it.' and no Approve; nothing is pinned.",
    `${PKG}.GymUxScreensTest#firstContactRefusesAServerNotBuiltFromTheRecipe`,
    {
      steps: [{ kind: "tap", describe: "Open Server approvals.", handle: "activity-section-approvals" }],
      assertions: [
        { describe: "The refusal", handle: "first-contact-refusal", expect: "text", text: "This server was not built from your recipe. Do not approve it." },
        { describe: "No Approve", handle: "secret-request-approve", expect: "absent" },
      ],
      screenshots: [shot("first-contact-refused", "The refused request.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-ux-first-contact-key-changed",
    "After the pin: a request naming another key than the pinned one is refused and shown: 'This server's key changed. If you did not rebuild it, do not approve anything for it.' The pin stays.",
    `${PKG}.GymUxScreensTest#firstContactRefusesAChangedKey`,
    {
      steps: [{ kind: "tap", describe: "Open Server approvals.", handle: "activity-section-approvals" }],
      assertions: [{ describe: "The refusal", handle: "first-contact-refusal", expect: "text", text: "This server's key changed." }],
      screenshots: [shot("first-contact-key-changed", "The changed key, refused.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-ux-recovery-passkey-enrol",
    "Cloud recovery set-up (SEC-REPAIR-001): the passphrase field says 'Longer is stronger and there is no upper limit: a whole sentence you will remember works well'; Configure makes the recovery passkey and sends its attestation object as passkeyAttestationObject beside the signed record, so .com's record now requires the passkey.",
    `${PKG}.GymPasskeyBrowserSyncTest#recoverySetUpSendsThePasskeysAttestation`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=settings as an admin device with the gym passkey app." },
        { kind: "tap", describe: "Cloud recovery, then Set up cloud recovery.", handle: "recovery-setup" },
        { kind: "assert", describe: "The passphrase hint." },
        { kind: "tap", describe: "Configure with a passphrase typed twice." },
      ],
      assertions: [{ describe: "Configured", handle: "recovery-active", expect: "present" }],
      screenshots: [shot("recovery-passphrase-hint", "The recovery passphrase field and its hint.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-ux-recovery-update-once",
    "A recovery record from before .com checked the passkey raises 'Update your account recovery' once per account; Not now is final (asked again: nothing), nothing changes on .com, and Settings → Cloud recovery keeps a quiet 'Update account recovery' row.",
    `${PKG}.GymPasskeyBrowserSyncTest#recoveryUpdateIsOfferedOnceAndNotNowIsFinal`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=home; the mock .com then holds a legacy record and the phone looks again." },
        { kind: "tap", describe: "Not now.", handle: "recovery-update-not-now" },
        { kind: "tap", describe: "Settings → Cloud recovery.", handle: "tab-settings" },
      ],
      assertions: [
        { describe: "The prompt title", handle: "recovery-update-title", expect: "text", text: "Update your account recovery" },
        { describe: "The quiet row", handle: "recovery-update-row", expect: "present" },
      ],
      screenshots: [shot("recovery-update-prompt", "The one-time prompt."), shot("recovery-update-row", "The Settings row.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-ux-recovery-update-passphrase",
    "Update with the passphrase: a wrong one is refused by .com ('That passphrase didn't match.') before anything is replaced; the right one re-enrols with one passkey sheet, sends the attestation and shows 'Account recovery updated.'",
    `${PKG}.GymPasskeyBrowserSyncTest#recoveryUpdateWithThePassphraseReEnrolsWithThePasskey`,
    {
      steps: [
        { kind: "type", describe: "A wrong passphrase, Update.", handle: "recovery-update-passphrase" },
        { kind: "type", describe: "The right passphrase, Update.", handle: "recovery-update-confirm" },
      ],
      assertions: [{ describe: "The wrong passphrase", handle: "recovery-update-error", expect: "text", text: "That passphrase didn't match." }],
      screenshots: [shot("recovery-update-wrong-passphrase", "A wrong passphrase, refused before anything changes.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-ux-browser-grant-allow-deny",
    "A content-free push wakes the app: an app's ask for browser access beyond its manifest raises 'Browser access request' with the verified app ('Plants wants to use this server's browser.'), the exact site, what it can do and how long; 'Allow once' sends an admin-signed flagship/browser-grant/v1 over the ask's own duration; the next ask ('Always allow', a LAN device by address) waits under Activity → Browser access requests, where Deny answers it unsigned.",
    `${PKG}.GymPasskeyBrowserSyncTest#browserGrantAllowOnceFromTheDialogDenyFromActivity`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=activity as an admin device; the mock box then holds two asks and a push lands." },
        { kind: "tap", describe: "Allow once in the dialog.", handle: "browser-grant-allow" },
        { kind: "tap", describe: "Not now on the second ask.", handle: "browser-grant-not-now" },
        { kind: "tap", describe: "Open Browser access requests under Activity.", handle: "activity-section-browser" },
        { kind: "tap", describe: "Deny the second ask there.", handle: "browser-grant-card-deny-6b7c0f1e-2222-4a2b-9c3d-000000000002" },
      ],
      assertions: [
        { describe: "The dialog title", handle: "browser-grant-title", expect: "text", text: "Browser access request" },
        { describe: "Allow names the duration", handle: "browser-grant-allow", expect: "text", text: "Allow once" },
      ],
      screenshots: [shot("browser-grant-dialog", "The browser access dialog."), shot("browser-grant-activity", "Browser access requests under Activity.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-ux-browser-grant-app-page",
    "The app's page has a Browser access section: its own waiting ask (only that app's) with Allow, signed with the admin root.",
    `${PKG}.GymPasskeyBrowserSyncTest#browserGrantOnTheAppsPage`,
    {
      steps: [{ kind: "tap", describe: "Allow once on Plants' page.", handle: "browser-grant-card-allow-6b7c0f1e-1111-4a2b-9c3d-000000000001" }],
      assertions: [{ describe: "The section", handle: "service-detail-browser-access", expect: "present" }],
      screenshots: [shot("browser-grant-app-page", "Browser access on the app's page.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-ux-browser-grant-narrowed",
    "An ask for the session offers 'Allow once' and 'Allow for this session' (shortest first, never longer than asked); Allow once sends the admin-signed flagship/browser-grant/v1 for one visit (the mock box refuses any longer duration), and the grant then reads 'For one visit' under 'Allowed by you'.",
    `${PKG}.GymPasskeyBrowserSyncTest#browserGrantNarrowedToOnceOnTheAppsPage`,
    {
      steps: [
        { kind: "launch", describe: "Open Plants' page with a session ask waiting." },
        { kind: "tap", describe: "Allow once.", handle: "browser-grant-card-allow-once-6b7c0f1e-3333-4a2b-9c3d-000000000003" },
      ],
      assertions: [
        { describe: "Allow once is offered", handle: "browser-grant-card-allow-once-6b7c0f1e-3333-4a2b-9c3d-000000000003", expect: "text", text: "Allow once" },
        { describe: "The ask's own duration", handle: "browser-grant-card-allow-6b7c0f1e-3333-4a2b-9c3d-000000000003", expect: "text", text: "Allow for this session" },
        { describe: "Never longer than asked", handle: "browser-grant-card-allow-service-6b7c0f1e-3333-4a2b-9c3d-000000000003", expect: "absent" },
        { describe: "Allowed by you", handle: "browser-granted-title", expect: "present" },
      ],
      screenshots: [shot("browser-grant-narrow-choices", "Allow once, or for this session."), shot("browser-grant-narrowed-allowed", "Allowed for one visit.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-ux-browser-grant-withdraw",
    "The app's page lists what the owner allowed under 'Allowed by you' (sites, what it can do, how long, the app's words); Withdraw signs flagship/browser-grant-revoke/v1 with the admin root, the grant disappears and 'Browser access withdrawn' shows.",
    `${PKG}.GymPasskeyBrowserSyncTest#browserGrantWithdrawOnTheAppsPage`,
    {
      steps: [
        { kind: "launch", describe: "Open Plants' page; the mock box holds a session grant the owner gave." },
        { kind: "tap", describe: "Withdraw.", handle: "browser-granted-withdraw-bg-0f4c9a1e-2d3b-4c5d-8e6f-7a8b9c0d1e2f" },
      ],
      assertions: [
        { describe: "Allowed by you", handle: "browser-granted-title", expect: "text", text: "Allowed by you" },
        { describe: "Gone after Withdraw", handle: "browser-granted-bg-0f4c9a1e-2d3b-4c5d-8e6f-7a8b9c0d1e2f", expect: "absent" },
      ],
      screenshots: [shot("browser-grant-allowed-by-you", "What the owner allowed, with Withdraw.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-ux-upstream-sync-proposal",
    "An imported app's page offers 'Check for updates from <repo>'; a branch is chosen, POST /api/build/apps/:id/sync answers a proposal shown as the version, counts, conflicts (your version kept) and the new permissions apart ('Internet access', 'Adds: …'); Review and deploy opens the build that holds the merge, ready to deploy, and Deploy installs exactly that build.",
    `${PKG}.GymPasskeyBrowserSyncTest#syncShowsTheProposalThenDeploysTheBuildThatHoldsIt`,
    {
      steps: [
        { kind: "tap", describe: "Check for updates from the repo.", handle: "service-detail-sync" },
        { kind: "type", describe: "A branch, then Check for updates.", handle: "app-sync-ref" },
        { kind: "tap", describe: "Review and deploy.", handle: "app-sync-review" },
        { kind: "tap", describe: "Deploy.", handle: "build-journal-deploy" },
      ],
      assertions: [
        { describe: "The version", handle: "app-sync-version", expect: "text", text: "Version 4f2a9c0e1b7d" },
        { describe: "New permissions apart", handle: "app-sync-permissions", expect: "present" },
      ],
      screenshots: [shot("app-sync-proposal", "The sync proposal.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-ux-upstream-sync-up-to-date",
    "A sync that finds the app already current says 'You already run the latest version from <repo>.'; the box opened no build, so closing discards nothing and nothing deploys.",
    `${PKG}.GymPasskeyBrowserSyncTest#syncUpToDateOpensNoBuild`,
    {
      steps: [{ kind: "tap", describe: "Close.", handle: "app-sync-close" }],
      assertions: [{ describe: "Up to date", handle: "app-sync-up-to-date", expect: "text", text: "You already run the latest version from" }],
      screenshots: [shot("app-sync-up-to-date", "Already up to date.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-ux-upstream-sync-not-imported",
    "An app not imported from a repo has no 'Check for updates' row.",
    `${PKG}.GymPasskeyBrowserSyncTest#syncIsNotOfferedForAnAppNotImported`,
    {
      steps: [{ kind: "launch", describe: "Open Plants with no repo on record." }],
      assertions: [{ describe: "No sync row", handle: "service-detail-sync", expect: "absent" }],
      screenshots: [shot("app-sync-not-offered", "An app with no repo: no sync row.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-ux-update-kept-in-recovery",
    "docs/support/update-rollback.md §5: a failed update the floor kept in recovery (rollbackRefused) reads as stuck on the new release until a fixed one arrives, never 'went back on its own'; the Share update results switch reads the box's /api/update-reports and sends { share } on and off.",
    `${PKG}.GymUpdateResultsTest#aRollbackKeptInRecoveryReadsAsStuckAndTheSwitchSendsTheChoice`,
    {
      steps: [
        { kind: "launch", describe: "Open the Living-room mini-PC server; the box reports rollbackRefused and sharing off." },
        { kind: "tap", describe: "Turn Share update results on, then off.", handle: "sd-update-reports" },
      ],
      assertions: [
        { describe: "Stuck sentence", handle: "sd-update-last-outcome", expect: "present" },
        { describe: "Switch", handle: "sd-update-reports", expect: "present" },
      ],
      screenshots: [shot("update-results", "The update card with a rollback kept in recovery and the switch.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-ux-update-refusal-sentence",
    "A refused update reads as one whole sentence (the request was too old); a box that refuses the session shows no Share update results switch.",
    `${PKG}.GymUpdateResultsTest#aRefusalIsOneSentenceAndARefusedSessionShowsNoSwitch`,
    {
      steps: [{ kind: "launch", describe: "Open the server; the box refused a stale order and answers 403 for /api/update-reports." }],
      assertions: [{ describe: "No switch", handle: "sd-update-reports", expect: "absent" }],
      screenshots: [shot("update-refusal", "A refusal as one sentence, no switch.")],
      dimension: "D3",
    },
  ),
];
