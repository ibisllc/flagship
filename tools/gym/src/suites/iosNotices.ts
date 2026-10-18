/**
 * iOS gym scenarios: security notices (apps/mobile/ios/App/UITests/GymNoticeTests.swift,
 * docs/security-notices.md section 6.6). Same five as the webapp's
 * (suites/webNotices.ts), mock tier: `-smoke-mode -gym-notice <names>` serves the
 * signed vectors from a mocked `.com` against a throwaway authority (Debug
 * builds only).
 */

import type { Scenario } from "../scenario.js";
import { iosTotal, shot } from "./helpers.js";

const N = "FlagshipAppUITests/GymNoticeTests/";

export const IOS_NOTICES: readonly Scenario[] = [
  iosTotal(
    "ios-total-notice-maintenance-banner",
    "A maintainer-signed maintenance notice shows a dismissible banner with the date in the person's own format, and no Update button.",
    N + "test_maintenanceNoticeShowsADismissibleBannerWithTheDate",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -gym-notice maintenance (the mocked .com serves the signed notice)." },
        { kind: "assert", describe: "The banner shows the sentence with the date filled in.", handle: "notice-banner-text" },
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
  iosTotal(
    "ios-total-notice-update-required-lock",
    "A verified update-required notice locks the app: a full-screen Update required with the reason, the advisory and the maintainers' signature, every menu closed, nothing behind it reachable, and the key backup and Sign out still there.",
    N + "test_verifiedUpdateRequiredNoticeLocksTheAppUntilItIsUpdated",
    {
      steps: [
        { kind: "launch", describe: "Reach Home and open the Add/Restore menu." },
        { kind: "assert", describe: "The notice arrives: the menu closes and the lock shows.", handle: "update-lock-title" },
        { kind: "tap", describe: "Back up my account key opens above the lock.", handle: "update-lock-backup" },
      ],
      assertions: [
        { describe: "Title", handle: "update-lock-title", expect: "text", text: "Update required" },
        { describe: "Update button", handle: "update-lock-update", expect: "text", text: "Update Flagship" },
        { describe: "Sign out stays", handle: "update-lock-signout", expect: "present" },
      ],
      screenshots: [shot("update-lock", "The Update required screen.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-notice-lock-lifts",
    "The lock lifts when the build is updated past the minimum or the notice ends (never past validUntil), a signed all clear supersedes it, and replaying an older notice is refused.",
    N + "test_lockLiftsWhenTheBuildIsUpdatedOrTheNoticeEndsAndAnOlderNoticeCannotBringItBack",
    {
      steps: [
        { kind: "launch", describe: "Launch with a lock, then a signed all clear, then the old lock replayed." },
        { kind: "assert", describe: "The lock shows, then lifts, and stays lifted.", handle: "update-lock-title" },
      ],
      assertions: [{ describe: "No lock at the end", handle: "update-lock-title", expect: "absent" }],
      screenshots: [shot("notice-lock-lifted", "Home again after the all clear.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-notice-fails-open",
    "Fail open: a lock the pin can't vouch for (a forged .com), a 500, junk and an empty answer lock nothing and show no banner.",
    N + "test_failsOpenForALockTheBakedPinCannotVouchForAnUnreachableEndpointAndJunk",
    {
      steps: [
        { kind: "launch", describe: "Launch; the mocked .com serves a lock signed by another key, a 500, junk and a 204." },
        { kind: "assert", describe: "Home stays usable, no lock, no banner.", handle: "home-add-server" },
      ],
      assertions: [
        { describe: "No lock", handle: "update-lock", expect: "absent" },
        { describe: "No banner", handle: "notice-banner", expect: "absent" },
      ],
      screenshots: [shot("notice-forged-ignored", "Home after a forged lock was refused.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-notice-grace-nag",
    "An update-required notice with a grace window shows the update banner until its lock date, then locks.",
    N + "test_updateRequiredNoticeNagsUntilItsLockDateThenLocks",
    {
      steps: [
        { kind: "launch", describe: "Launch 40 seconds before the lock date." },
        { kind: "assert", describe: "The banner offers Update.", handle: "notice-banner-update" },
        { kind: "wait", describe: "The clock passes the lock date: the lock shows.", handle: "update-lock-title" },
      ],
      assertions: [{ describe: "Banner text", handle: "notice-banner-text", expect: "text", text: "You must update Flagship by " }],
      screenshots: [shot("notice-grace-nag", "The nag banner.")],
      dimension: "D4",
    },
  ),
];
