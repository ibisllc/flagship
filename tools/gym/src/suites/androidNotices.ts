/**
 * Android gym scenarios: security notices (docs/security-notices.md section
 * 6.6), the same five as the webapp's webNotices.ts. Each `harness` is a method
 * of GymNoticesTest (apps/mobile/android/app/src/androidTest). NO BACKEND: a
 * throwaway authority stands in for the maintainers' key and the mock `.com`
 * answers the poll.
 */

import type { Scenario } from "../scenario.js";
import { androidTotal, shot } from "./helpers.js";

const PKG = "com.flagshipserver.app.gym";

export const ANDROID_NOTICES: readonly Scenario[] = [
  androidTotal(
    "android-total-notice-maintenance-banner",
    "A maintainer-signed maintenance notice shows a dismissible banner with the date in the person's own format and no lock.",
    `${PKG}.GymNoticesTest#aMaintenanceNoticeShowsADismissibleBannerWithTheDate`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=home, then the mock .com serves a maintenance notice." },
        { kind: "assert", describe: "The banner shows the sentence with the date filled in.", handle: "notice-banner" },
        { kind: "tap", describe: "Dismiss it.", handle: "notice-banner-dismiss" },
      ],
      assertions: [
        { describe: "Banner text", handle: "notice-banner-text", expect: "text", text: "may be briefly unavailable." },
        { describe: "No lock", handle: "update-lock", expect: "absent" },
      ],
      screenshots: [shot("notice-banner", "The maintenance banner above Home.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-total-notice-update-required-lock",
    "A verified update-required notice locks the app: a full-screen Update required with the reason, the advisory and the maintainers' signature, every menu closed, the app behind it inaccessible, no write or box call sent, and the store link, the key backup and Sign out still there.",
    `${PKG}.GymNoticesTest#aVerifiedUpdateRequiredNoticeLocksTheAppUntilItIsUpdated`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=home as an admin device and open the Add/Restore menu." },
        { kind: "assert", describe: "Serve the notice: the menu closes and the lock shows.", handle: "update-lock" },
        { kind: "tap", describe: "Back up my account key opens above the lock.", handle: "update-lock-backup" },
      ],
      assertions: [
        { describe: "Title", handle: "update-lock-title", expect: "text", text: "Update required" },
        { describe: "Sign out stays", handle: "update-lock-signout", expect: "present" },
        { describe: "Home is inaccessible", handle: "home-title", expect: "absent" },
      ],
      screenshots: [shot("update-lock", "The Update required screen."), shot("backup-above-lock", "The key backup above the lock.")],
      dimension: "D4",
    },
  ),
  androidTotal(
    "android-total-notice-lock-lifts",
    "The lock lifts when the notice ends (never past validUntil) or a signed all clear supersedes it, and replaying an older notice is refused.",
    `${PKG}.GymNoticesTest#theLockLiftsWhenTheNoticeEndsAndAnOlderNoticeCannotBringItBack`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=home and lock it with a verified notice." },
        { kind: "assert", describe: "Move the clock past validUntil, then serve an all clear.", handle: "update-lock" },
      ],
      assertions: [{ describe: "No lock at the end", handle: "update-lock", expect: "absent" }],
      screenshots: [shot("notice-lock-lifted", "Home again after the all clear.")],
      dimension: "D4",
    },
  ),
  androidTotal(
    "android-total-notice-fails-open",
    "Fail open: a lock the baked pin can't vouch for (a forged .com), an unreachable endpoint, junk and an expired notice lock nothing and show no banner.",
    `${PKG}.GymNoticesTest#failsOpenAForgedLockAnUnreachableEndpointAndJunkLockNothing`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=home; the mock .com serves a lock signed by another chain." },
        { kind: "assert", describe: "Home stays usable, no lock, no banner.", handle: "home-title" },
      ],
      assertions: [
        { describe: "No lock", handle: "update-lock", expect: "absent" },
        { describe: "No banner", handle: "notice-banner", expect: "absent" },
      ],
      screenshots: [shot("notice-forged-ignored", "Home after a forged lock was refused.")],
      dimension: "D4",
    },
  ),
  androidTotal(
    "android-total-notice-grace-nag",
    "An update-required notice with a grace window shows the update banner until its lock date, then locks.",
    `${PKG}.GymNoticesTest#anUpdateRequiredNoticeNagsUntilItsLockDateThenLocks`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=home and serve a notice that locks in two days." },
        { kind: "assert", describe: "The banner offers Update.", handle: "notice-banner-update" },
        { kind: "wait", describe: "Move the clock past the lock date: the lock shows.", handle: "update-lock" },
      ],
      assertions: [{ describe: "Banner text", handle: "notice-banner-text", expect: "text", text: "You must update Flagship by " }],
      screenshots: [shot("notice-grace-nag", "The nag banner.")],
      dimension: "D4",
    },
  ),
];
