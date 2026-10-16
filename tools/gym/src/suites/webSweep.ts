/**
 * webapp gym scenarios: the every-button sweep (apps/web/e2e/gym/gym-sweep.spec.ts,
 * dimension D7). Each presses every visible control on a group of screens,
 * reached by clicking, and fails on a page error, an unhandled rejection or a
 * control that can't be pressed. The per-control effects are attached as
 * `sweep-<group>.json`.
 */

import type { Scenario } from "../scenario.js";
import { webTotal, shot } from "./helpers.js";

const sweep = (id: string, goal: string, title: string, root: string): Scenario =>
  webTotal(id, goal, title, {
    steps: [
      { kind: "launch", describe: "Reach Home as an admin device with two servers and one app (mocked)." },
      { kind: "tap", describe: "Press every visible control on each screen, coming back after each.", handle: root },
    ],
    assertions: [{ describe: "The screen rendered its controls", handle: root, expect: "present" }],
    screenshots: [shot("sweep", "Failure frame only; the effects are in the JSON attachment.")],
    dimension: "D7",
  });

export const WEB_SWEEP: readonly Scenario[] = [
  sweep(
    "web-total-sweep-home",
    "Every control on Home (Add/Import, Take over, search, filter chips, Move up/down, server cards, Advanced), Activity and the Services list is pressed with no page error.",
    "gym sweep presses every control on Home, Activity and the Services list",
    "#view-home",
  ),
  sweep(
    "web-total-sweep-settings",
    "Every Settings row and every control on the screens they open (Appearance, Privacy, About, AI keys, Account security, Trusted devices, Recovery, Profiles, Browser sessions, Secured sessions, Peer-backup, Companion requests) is pressed with no page error; Sign out, Lock and Remove this device are skipped.",
    "gym sweep presses every control on Settings and the screens its rows open",
    "#view-settings-tab",
  ),
  sweep(
    "web-total-sweep-server",
    "Every control on a server page (apps, monitoring, auto-unlock, front page, power, dead-man, journal, leader, sharing, backup, migrate, update, transfer, revoke, delete), reached from its Home card, is pressed with no page error.",
    "gym sweep presses every control on a server page",
    "#view-server-detail",
  ),
  sweep(
    "web-total-sweep-app",
    "Every control on an app's page, access control, access list, database, environment and edit screens is pressed with no page error.",
    "gym sweep presses every control on an app's pages",
    "#view-service-detail",
  ),
  sweep(
    "web-total-sweep-build",
    "Every control on the build chooser (from the Services tab), git import, IDE connection, Build sessions, AI-key step, install tracker and create-server form is pressed with no page error.",
    "gym sweep presses every control on the build screens",
    "#view-build-source",
  ),
];
