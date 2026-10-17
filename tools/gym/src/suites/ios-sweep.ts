/**
 * iOS button sweep (GymSweep*Tests): every control a screen offers is
 * pressed from its tab and its effect checked against the mock clients
 * (navigation, the order the mock received and the key that signed it,
 * sheet content, state). Mock tier, `total` tier. One row per test method.
 */

import type { Scenario } from "../scenario.js";
import type { Dimension } from "../scenario.js";
import { iosTotal, shot } from "./helpers.js";

const T = "FlagshipAppUITests/";

/**
 * A sweep row: `presses` are the controls the test taps in order (handles
 * as the test names them); `checks` the elements whose presence proves the
 * effect.
 */
function sweep(
  id: string,
  goal: string,
  harness: string,
  presses: readonly string[],
  checks: readonly string[],
  dimension: Dimension = "D1",
): Scenario {
  return iosTotal(id, goal, T + harness, {
    steps: [
      { kind: "launch", describe: "Launch -smoke-mode on the scenario's tab." },
      ...presses.map((h) => ({ kind: "tap" as const, describe: `Press ${h}.`, handle: h })),
      ...checks.map((h) => ({ kind: "assert" as const, describe: `Check ${h}.`, handle: h })),
    ],
    assertions: checks.map((h) => ({ describe: `${h} shows the effect`, handle: h, expect: "present" as const })),
    screenshots: [shot(id.replace(/^ios-sweep-/, ""), "After the presses.")],
    dimension,
  });
}

const BUILD: readonly Scenario[] = [
  sweep(
    "ios-sweep-build-interrupted-git",
    "A git build a restart cut off (-smoke-build-interrupted): Build sessions shows the box's sentence; Run the AI again or deploy reopens it with both actions; Deploy puts it live.",
    "GymSweepBuildTests/test_interruptedGitBuildOffersRunAgainAndDeploy",
    ["build-source-journal-link", "recipes", "build-journal-open-git", "build-git-deploy-kept"],
    ["build-journal-failed-reason", "build-git-adapt-error", "Installed"],
    "D2",
  ),
];

const SERVER: readonly Scenario[] = [
  sweep(
    "ios-sweep-backups-app-full",
    "An app whose files folder is full (the mock's Wiki) is named on the server's Backups section with the sentence that new data is refused.",
    "GymSweepServerTests/test_aFullAppIsNamedOnTheBackupsSection",
    ["Home"],
    ["sd-backups-storage-0"],
  ),
  sweep(
    "ios-sweep-backups-fresh-admin",
    "No backups yet on an admin device (-smoke-backups-fresh): the Backups section deposits the box's keys with one approval (signed flagship/server-archive-keys/v1), then shows Next backup.",
    "GymSweepServerTests/test_backupsFreshAdminDepositsKeysThenShowsNextBackup",
    ["Home"],
    ["sd-backups-status", "sd-backups-next"],
  ),
  sweep(
    "ios-sweep-backups-non-admin",
    "A non-admin device with an empty key pool (-smoke-backups-waiting): the box's waiting reason; Back up now, Change and Delete disabled with the admin-only sentence.",
    "GymSweepServerTests/test_backupsNonAdminShowsTheBoxReasonAndAdminOnlyControls",
    ["Home"],
    ["sd-backups-next", "sd-backups-admin-only"],
  ),
  sweep(
    "ios-sweep-backups-run-now",
    "Back up now (-smoke-backups-ready): running progress, then the new backup is listed first.",
    "GymSweepServerTests/test_backUpNowShowsProgressThenListsTheBackup",
    ["Home", "sd-backups-run"],
    ["sd-backups-status"],
  ),
  sweep(
    "ios-sweep-backups-failed-run",
    "The last run failed (-smoke-backups-failed): a red line with the box's sentence.",
    "GymSweepServerTests/test_aFailedRunShowsTheBoxSentence",
    ["Home"],
    ["sd-backups-failed"],
  ),
  sweep(
    "ios-sweep-backups-weekly-schedule",
    "Weekly on Sunday evening in Chicago is sent as Monday 03:00 UTC (minute 180, weekday 1).",
    "GymSweepServerTests/test_weeklyScheduleInLocalTimeIsSentInUtc",
    ["Home", "sd-backups-schedule-change", "Weekly", "backup-schedule-weekday", "Sunday", "backup-schedule-save"],
    ["sd-backups-schedule"],
  ),
  sweep(
    "ios-sweep-backups-download-delete",
    "Download a saved backup as one .flagship file, then Delete one after the confirm dialog.",
    "GymSweepServerTests/test_downloadOneFileAndDeleteWithConfirmation",
    ["Home", "sd-backup-download-<id>", "sd-backup-delete-<id>", "Delete"],
    ["sd-backup-save-<id>", "sd-backups-note"],
  ),
  sweep(
    "ios-sweep-backups-create-policy",
    "The create form's backup policy: the three options in the shared words, with the phone reserve for phone-side.",
    "GymSweepServerTests/test_createFormOffersThePoliciesWithTheReserve",
    ["home-add-server", "cs-next-button", "cs-next-button", "cs-backup-policy-none"],
    ["cs-backup-policy-phone-only"],
  ),
  sweep(
    "ios-sweep-backups-policy-change",
    "Change the backup policy Phone-side to Peer-distributed: an admin-root-signed flagship/backup-policy/v1.",
    "GymSweepServerTests/test_changePolicyPhoneToPeerIsSigned",
    ["Home", "sd-backups-policy-change", "backup-policy-peer", "backup-policy-save"],
    ["sd-backups-policy"],
  ),
  sweep(
    "ios-sweep-backups-policy-over-limit",
    "Over the limit with peer backups (-smoke-backups-peer-over): the box's over-limit sentence in red, the peer status, and a refused change (409 over-backup-limit) with the box's sentence.",
    "GymSweepServerTests/test_overLimitPeerStatusAndARefusedChange",
    ["Home", "sd-backups-policy-change", "backup-policy-phone-only", "backup-policy-save"],
    ["sd-backups-over-limit", "sd-backups-peer", "backup-policy-error"],
  ),
  sweep(
    "ios-sweep-backups-policy-choose",
    "Not chosen yet: Choose No backups; the schedule hides and Back up now stays.",
    "GymSweepServerTests/test_notChosenYetOffersChoose",
    ["Home", "sd-backups-policy-change", "backup-policy-none", "backup-policy-save"],
    ["sd-backups-policy", "sd-backups-run"],
  ),
  sweep(
    "ios-sweep-restore-one-failed",
    "Import one .flagship file onto a waiting server (-smoke-restore-one-failed): every app is tried, the result says Restored 1 app and names the one that failed with the box's reason; Home then shows the server as normal.",
    "GymSweepServerTests/test_restoreOneFileNamesTheAppThatFailed",
    ["Waiting for its backup", "import-backup-send-existing", "import-backup-done"],
    ["import-backup-restored", "import-backup-failed-app"],
  ),
  sweep(
    "ios-sweep-import-cut-short",
    "Import a backup refuses a cut-short .flagship file with its sentence (-smoke-restore-damaged).",
    "GymSweepServerTests/test_importRefusesACutShortFile",
    ["home-add-server", "home-import-backup"],
    ["import-backup-error"],
  ),
];

export const IOS_SWEEP_SCENARIOS: readonly Scenario[] = [...BUILD, ...SERVER];
