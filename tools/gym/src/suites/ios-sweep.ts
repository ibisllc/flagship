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

export const IOS_SWEEP_SCENARIOS: readonly Scenario[] = [...BUILD];
