/**
 * iOS gym scenarios for release 0.3's client screens (apps/mobile/ios/App/UITests/GymRelease03Tests.swift):
 * recovery checked by the passkey and its once-only update (SEC-REPAIR-001), wipe & restart's new passkey,
 * browser access requests (SEC-BROWSER-002) and an imported app's upstream sync (N12). Mock tier; seams in
 * Sources/FlagshipUI/Gym/GymSweepSeams+Release03.swift.
 */

import type { Scenario } from "../scenario.js";
import { iosTotal, shot } from "./helpers.js";

const N = "FlagshipAppUITests/GymRelease03Tests/";

export const IOS_RELEASE03: readonly Scenario[] = [
  iosTotal(
    "ios-total-recovery-passkey-restore",
    "Restoring an account whose recovery record holds its passkey's key: after the passphrase, one passkey sheet unwraps and signs .com's challenge, and the fetch carries that signature.",
    N + "test_restoreSignsComsChallenge",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-onboarding -smoke-recovery-passkey." },
        { kind: "type", describe: "Join sole-maple, type the recovery passphrase, Restore access." },
        { kind: "assert", describe: "The mock .com saw the passkey checked." },
      ],
      assertions: [{ describe: "Restore runs", handle: "login-takeover-continue", expect: "present" }],
      screenshots: [shot("recovery-passkey-checked", "After the passkey-checked restore.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-recovery-passkey-refused",
    ".com refuses the recovery passkey's signature: the restore says That passkey isn't the one your account recovery uses.",
    N + "test_restoreRefusedPasskeySaysWhy",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-onboarding -smoke-recovery-passkey -smoke-recovery-passkey-refused." },
        { kind: "type", describe: "Join sole-maple, type the passphrase, Restore access." },
      ],
      assertions: [
        { describe: "Refusal sentence", handle: "login-takeover-error", expect: "text", text: "That passkey isn't the one your account recovery uses." },
      ],
      screenshots: [shot("recovery-passkey-refused", "The refusal under Restore access.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-recovery-passkey-setup",
    "Setting up cloud recovery sends the passkey's attestation object beside the signed record, under the shared passphrase hint.",
    N + "test_setupSendsThePasskeyAndShowsTheHint",
    {
      steps: [
        { kind: "launch", describe: "Launch on Settings; open Cloud recovery." },
        { kind: "type", describe: "Type the passphrase twice; Set up recovery." },
      ],
      assertions: [
        { describe: "Hint", handle: "recovery-enroll-hint", expect: "text", text: "Longer is stronger and there is no upper limit: a whole sentence you will remember works well" },
      ],
      screenshots: [shot("recovery-passkey-setup", "Cloud recovery setup with the passphrase hint.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-recovery-update-prompt",
    "A recovery record from before the passkey check: Home asks once (Update your account recovery); Not now leaves a quiet Settings row that updates it with one passkey sheet, after which the row is gone.",
    N + "test_updatePromptOnceThenSettingsRow",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-recovery-legacy on Home." },
        { kind: "tap", describe: "Not now; Settings → Update account recovery; type the passphrase twice; Update." },
      ],
      assertions: [
        { describe: "Prompt title", handle: "recovery-update-title", expect: "text", text: "Update your account recovery" },
      ],
      screenshots: [shot("recovery-update-prompt", "The once-only update prompt on Home.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-recovery-update-once",
    "The update prompt is never repeated on a device that was asked before.",
    N + "test_updatePromptIsNotRepeated",
    {
      steps: [{ kind: "launch", describe: "Launch -smoke-recovery-legacy -smoke-recovery-asked on Home." }],
      assertions: [{ describe: "No prompt", handle: "recovery-update-title", expect: "absent" }],
      screenshots: [shot("recovery-update-not-repeated", "Home with no second prompt.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-wipe-restart-passkey",
    "Wipe & restart carries the new passkey's attestation object (newPasskeyAttestationObject) beside the old key's signature.",
    N + "test_wipeRestartAttestsTheNewPasskey",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-trusted-devices on Settings." },
        { kind: "tap", describe: "Another device's menu → Wipe & restart… → Wipe and start over." },
      ],
      assertions: [{ describe: "Wipe asked", handle: "trusted-device-menu-abababababababababababababababab", expect: "present" }],
      screenshots: [shot("wipe-restart-passkey", "After Wipe and start over.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-browser-grant-inbox",
    "Browser access requests in the inbox: the verified app, the exact sites (a wildcard says it reaches every address under it), what it can do, how long and the app's own words; Allow once signs flagship/browser-grant/v1 with the admin root, and a session request on a local device is denied with no signature.",
    N + "test_browserGrantAllowOnceThenDeny",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-browser-grant on Home." },
        { kind: "tap", describe: "Allow once; Close; Deny the next." },
      ],
      assertions: [
        { describe: "Ask", handle: "browser-grant-title", expect: "text", text: "plants wants to use this server's browser." },
        { describe: "Local network", handle: "browser-grant-lan", expect: "text", text: "These devices on your network: 192.168.1.20" },
      ],
      screenshots: [shot("browser-grant-once", "A one-visit browser request.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-browser-grant-app-page",
    "The app page's Browser access lists the sites approved at install and answers a waiting request there (Always allow for a request that lasts until removed).",
    N + "test_browserAccessOnTheAppPage",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-browser-grant-app on Apps; open Plants." },
        { kind: "tap", describe: "Always allow." },
      ],
      assertions: [{ describe: "Approved at install", handle: "app-browser-manifest", expect: "text", text: "Approved when you installed it" }],
      screenshots: [shot("browser-access-app-page", "Browser access on the app page.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-browser-grant-narrow",
    "The owner grants less than was asked: a session request offers Allow once beside Allow for this session (never Always allow); Allow once signs flagship/browser-grant/v1 for one visit and the box records a once grant.",
    N + "test_browserGrantNarrowedToOnce",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-browser-grant-narrow on Home." },
        { kind: "tap", describe: "Allow once." },
      ],
      assertions: [
        { describe: "Allow once offered", handle: "browser-grant-allow-once", expect: "present" },
        { describe: "Nothing wider", handle: "browser-grant-allow-service", expect: "absent" },
      ],
      screenshots: [shot("browser-grant-narrow", "A session request with Allow once.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-browser-grant-withdraw",
    "The app page's Browser access lists what the owner allowed beyond the manifest (Allowed by you); Withdraw signs flagship/browser-grant-revoke/v1 behind Face ID and the grant is gone.",
    N + "test_browserGrantWithdrawOnTheAppPage",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-browser-grant-granted on Apps; open Plants." },
        { kind: "tap", describe: "Withdraw." },
      ],
      assertions: [
        { describe: "Allowed by you", handle: "app-browser-granted-title", expect: "text", text: "Allowed by you" },
        { describe: "Withdrawn", handle: "app-browser-note", expect: "text", text: "Browser access withdrawn" },
      ],
      screenshots: [shot("browser-grant-granted", "Allowed by you with Withdraw.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-upstream-sync-proposal",
    "An imported app checks its repo at a chosen ref: the proposal shows the version, the counts, the conflict kept as the owner's and the new permission on its own; Review and deploy opens the existing git build screen and nothing goes live before that.",
    N + "test_syncProposalThenReview",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-upstream-sync on Apps; open Plants." },
        { kind: "tap", describe: "Check for updates from github.com/ana/plants; type v2; Check for updates; Review and deploy." },
      ],
      assertions: [
        { describe: "Version", handle: "sync-version", expect: "text", text: "Version abcdef012345" },
        { describe: "Permissions apart", handle: "sync-permissions", expect: "present" },
      ],
      screenshots: [shot("sync-proposal", "The sync proposal.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-upstream-sync-current",
    "Already on the latest upstream version: it says so, and the box opened no build, so closing discards nothing.",
    N + "test_syncUpToDateOpensNoBuild",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-upstream-sync-current on Apps; open Plants." },
        { kind: "tap", describe: "Check for updates; Close." },
      ],
      assertions: [{ describe: "Up to date", handle: "sync-up-to-date", expect: "present" }],
      screenshots: [shot("sync-up-to-date", "Already on the latest upstream version.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-update-kept-in-recovery",
    "docs/support/update-rollback.md §5: a failed update the floor kept in recovery (rollbackRefused) reads as stuck on the new release until a fixed one arrives, never \"went back on its own\"; the Share update results switch is off and posts { share } to the box's /api/update-reports on and off.",
    N + "test_updateKeptInRecoveryAndShareSwitch",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-update-kept-in-recovery on Home; open the Home server." },
        { kind: "tap", describe: "Turn Share update results on, then off." },
      ],
      assertions: [
        { describe: "Stuck sentence", handle: "sd-update-last-outcome", expect: "present" },
        { describe: "Switch", handle: "sd-update-reports", expect: "present" },
      ],
      screenshots: [shot("update-results", "The update card with a rollback kept in recovery and the switch.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-update-refusal-sentence",
    "A refused update reads as one whole sentence (the request was too old); a box that refuses the session shows no Share update results switch.",
    N + "test_updateRefusalSentenceAndNoSwitchWhenRefused",
    {
      steps: [{ kind: "launch", describe: "Launch -smoke-update-refused-stale on Home; open the Home server." }],
      assertions: [
        { describe: "Refusal sentence", handle: "sd-update-last-outcome", expect: "text", text: "The server refused the last update: the request was too old. Send it again." },
        { describe: "No switch", handle: "sd-update-reports", expect: "absent" },
      ],
      screenshots: [shot("update-refusal", "A refusal as one sentence, no switch.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-gpus-card",
    "The server page's GPUs card lists each GPU with its model, memory and state (in use, free, set aside after a fault), the app that holds it with Stop, the apps waiting, and says when new GPU work is paused.",
    N + "test_acceleratorsShowWhoHoldsEachGpu",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-accelerators -smoke-accelerators-paused; open Home's server page." },
        { kind: "assert", describe: "Read the GPUs card." },
      ],
      assertions: [
        { describe: "The holder", handle: "accelerator-holder-0", expect: "text", text: "Used by Plants" },
        { describe: "The queue", handle: "accelerator-queue-bright-maple--wiki", expect: "text", text: "Wiki is waiting" },
      ],
      screenshots: [shot("accelerators-card", "The GPUs card.")],
      dimension: "D1",
    },
  ),
  iosTotal(
    "ios-total-gpus-stop",
    "Stop asks first; Cancel sends nothing; Stop posts the allocation to /api/screens/accelerators/stop, says the app no longer has the GPU, reloads, and the app waiting gets it.",
    N + "test_acceleratorStopAsksThenFreesTheGpu",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-accelerators; open Home's server page." },
        { kind: "tap", describe: "Stop, Cancel, Stop, then Stop in the dialog." },
      ],
      assertions: [
        { describe: "Notice", handle: "accelerators-notice", expect: "text", text: "Plants no longer has the GPU." },
        { describe: "Wiki gets it", handle: "accelerator-holder-0", expect: "text", text: "Starting for Wiki" },
      ],
      screenshots: [shot("accelerators-stopped", "After Stop.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-total-gpus-none",
    "A box with no GPU (no GPU service) shows no GPUs card.",
    N + "test_noGpuShowsNoCard",
    {
      steps: [{ kind: "launch", describe: "Launch -smoke-accelerators-none; open Home's server page and scroll it." }],
      assertions: [{ describe: "No card", handle: "accelerators-card", expect: "absent" }],
      screenshots: [shot("accelerators-none", "The server page with no GPUs card.")],
      dimension: "D1",
    },
  ),
  iosTotal(
    "ios-total-browser-access-last-card",
    "An app with no browser sites of its own: Allow on its only request takes the card away, the grants reload under Allowed by you and the note stays; Withdraw on the last grant takes that card away and the note says Browser access withdrawn.",
    N + "test_browserAccessLastRequestThenLastGrant",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-browser-grant-alone on Apps; put off the inbox; open Plants." },
        { kind: "tap", describe: "Allow once, then Withdraw." },
      ],
      assertions: [
        { describe: "Reloaded grant", handle: "app-browser-granted-title", expect: "text", text: "Allowed by you" },
        { describe: "Withdrawn", handle: "app-browser-note", expect: "text", text: "Browser access withdrawn" },
      ],
      screenshots: [shot("browser-access-last-request", "The grant after the last request."), shot("browser-access-last-grant", "The note after the last grant.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-gpus-approve",
    "Apps asking to use a GPU show their exact terms; Approve signs flagship/gpu-approval/v1 with the admin root; Decline hides the ask and sends nothing; a sharing request is approved with a trust domain and consent; Withdraw signs flagship/gpu-approval-withdraw/v1.",
    N + "test_gpuApprovalApproveDeclineWithdraw",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-accelerators -smoke-gpu-approvals; open Home's server page." },
        { kind: "tap", describe: "Approve Render, Decline Train, Approve Stream, Withdraw Photos." },
      ],
      assertions: [{ describe: "Withdrawn", handle: "accelerators-notice", expect: "text", text: "Photos can no longer use the GPU." }],
      screenshots: [shot("gpu-approval-pending", "Requests with their terms."), shot("gpu-approval-answered", "After the answers.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-gpus-approve-read-only",
    "A device without the admin root sees GPU requests and approvals read-only with the admin-only line.",
    N + "test_gpuApprovalReadOnlyOnANonAdminDevice",
    {
      steps: [{ kind: "launch", describe: "Launch without the admin root, -smoke-accelerators -smoke-gpu-approvals." }],
      assertions: [{ describe: "Admin-only line", handle: "gpu-approval-admin-only", expect: "present" }],
      screenshots: [shot("gpu-approval-read-only", "Read-only requests.")],
      dimension: "D6",
    },
  ),
  iosTotal(
    "ios-total-stack-move",
    "Container stack: Move to the new stack signs flagship/arch-v2-switch/v1 with the admin root and dry-runs it (the box's plan); Move now sends it; the card follows the move to its trial.",
    N + "test_stackMoveDryRunThenMove",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-stack; open Home's server page." },
        { kind: "tap", describe: "Move to the new stack, then Move now." },
      ],
      assertions: [{ describe: "On the new stack", handle: "stack-current", expect: "text", text: "This server runs the new stack (Podman and the Rust services)." }],
      screenshots: [shot("stack-plan", "The dry run's plan."), shot("stack-trial", "The trial.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-stack-blocked",
    "Container stack: a plan without room shows the box's sentence and Move now stays off.",
    N + "test_stackMoveBlockedSaysWhy",
    {
      steps: [{ kind: "launch", describe: "Launch -smoke-stack-blocked; Move to the new stack." }],
      assertions: [{ describe: "Blocker", handle: "stack-blocker-0", expect: "present" }],
      screenshots: [shot("stack-blocked", "The refusal.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-total-stack-admin-only",
    "A device without the admin root has no Container stack card.",
    N + "test_stackCardIsAdminOnly",
    {
      steps: [{ kind: "launch", describe: "Launch without the admin root, -smoke-stack." }],
      assertions: [{ describe: "No card", handle: "stack-card", expect: "absent" }],
      screenshots: [shot("stack-admin-only", "No card.")],
      dimension: "D6",
    },
  ),
];
