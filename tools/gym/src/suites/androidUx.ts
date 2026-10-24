/**
 * Android gym scenarios: the 0.3 security screens. App chat requests (N08), AI-run consent (N12)
 * and the watch boot key (option (a), docs/watch-boot-approval-without-unlock.md). Each `harness`
 * is a method of GymUxScreensTest (apps/mobile/android/app/src/androidTest). NO BACKEND: the mock
 * box and `.com` check every signature the way the real ones do on an admin-pinned account.
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
];
