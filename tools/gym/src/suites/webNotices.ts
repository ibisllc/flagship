/**
 * webapp gym scenarios: security notices (apps/web/e2e/gym/gym-notices.spec.ts,
 * docs/security-notices.md). Same rules as web.ts: each `harness` is the exact
 * title of a test in that spec. The iOS and Android rows join these when the
 * ports land (parity/features.json: security-notices).
 */

import type { Scenario } from "../scenario.js";
import { webTotal, shot } from "./helpers.js";

export const WEB_NOTICES: readonly Scenario[] = [
  webTotal(
    "web-total-notice-maintenance-banner",
    "A maintainer-signed maintenance notice shows a dismissible banner with the date in the person's own format, and the request that fetched it carried no cookie, header or query.",
    "gym notice a maintenance notice shows a dismissible banner with the date",
    {
      steps: [
        { kind: "launch", describe: "Reach Home, then fetch the notice (mocked .com)." },
        { kind: "assert", describe: "The banner shows the sentence with the date filled in.", handle: "#notice-banner" },
        { kind: "tap", describe: "Dismiss it.", handle: "[data-testid=notice-banner-dismiss]" },
      ],
      assertions: [
        { describe: "Banner text", handle: "[data-testid=notice-banner-text]", expect: "text", text: "may be briefly unavailable." },
        { describe: "No lock", handle: "#update-lock", expect: "absent" },
      ],
      screenshots: [shot("notice-banner", "The maintenance banner above Home.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-notice-update-required-lock",
    "A verified update-required notice locks the app: a full-screen Update required with the reason, the advisory and the maintainers' signature, every dialog closed, the page behind it inert, no order or box call sent, and the key backup and Sign out still there.",
    "gym notice a verified update-required notice locks the app until it is updated",
    {
      steps: [
        { kind: "launch", describe: "Reach Home and open the Add/Restore menu." },
        { kind: "assert", describe: "Fetch the notice: the menu closes and the lock shows.", handle: "#update-lock" },
        { kind: "tap", describe: "Back up my account key opens above the lock.", handle: "[data-testid=update-lock-backup]" },
      ],
      assertions: [
        { describe: "Title", handle: "#update-lock-title", expect: "text", text: "Update required" },
        { describe: "Update button", handle: "[data-testid=update-lock-update]", expect: "text", text: "Reload to update" },
        { describe: "Sign out stays", handle: "[data-testid=update-lock-signout]", expect: "present" },
      ],
      screenshots: [shot("update-lock", "The Update required screen.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-notice-lock-lifts",
    "The lock lifts when the build is updated past the minimum or the notice ends (never past validUntil), a signed all clear supersedes it, and replaying an older notice is refused.",
    "gym notice the lock lifts when the build is updated or the notice ends, and an older notice cannot bring it back",
    {
      steps: [
        { kind: "launch", describe: "Reach Home and lock it with a verified notice." },
        { kind: "assert", describe: "Evaluate as a newer build, past validUntil, then after an all clear.", handle: "#update-lock" },
      ],
      assertions: [{ describe: "No lock at the end", handle: "#update-lock", expect: "absent" }],
      screenshots: [shot("notice-lock-lifted", "Home again after the notice was replaced by an all clear.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-notice-fails-open",
    "Fail open: a lock the baked pin can't vouch for (a forged .com), a 500, junk and a window over 30 days lock nothing and show no banner.",
    "gym notice fails open: a lock the baked pin cannot vouch for, an unreachable endpoint and junk lock nothing",
    {
      steps: [
        { kind: "launch", describe: "Reach Home; the mocked .com serves a lock signed by another chain." },
        { kind: "assert", describe: "Home stays usable, no lock, no banner.", handle: "#view-home" },
      ],
      assertions: [
        { describe: "No lock", handle: "#update-lock", expect: "absent" },
        { describe: "No banner", handle: "#notice-banner", expect: "absent" },
      ],
      screenshots: [shot("notice-forged-ignored", "Home after a forged lock was refused.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-notice-grace-nag",
    "An update-required notice with a grace window shows the update banner until its lock date, then locks.",
    "gym notice an update-required notice nags until its lock date, then locks",
    {
      steps: [
        { kind: "launch", describe: "Reach Home and fetch a notice that locks in two days." },
        { kind: "assert", describe: "The banner offers Reload to update.", handle: "[data-testid=notice-banner-update]" },
        { kind: "wait", describe: "Move the clock past the lock date: the lock shows.", handle: "#update-lock" },
      ],
      assertions: [{ describe: "Banner text", handle: "[data-testid=notice-banner-text]", expect: "text", text: "You must update Flagship by " }],
      screenshots: [shot("notice-grace-nag", "The nag banner.")],
      dimension: "D4",
    },
  ),
];
