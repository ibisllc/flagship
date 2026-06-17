/**
 * iOS / iPad gym scenarios — every-merge subset + the total-gym Tier-1 tranche.
 *
 * All NO-BACKEND (`-smoke-mode` → DemoFixtures + the mock client). Each entry's
 * `harness` is an `-only-testing:` identifier (Target/Class[/method]) into the
 * XCUITest target: GymSmokeTests + GymEveryMergeTests (every-merge) and
 * GymTotalTests (the total tranche). iPad is the SAME classes run against an
 * iPad `-destination` (the adapter handles the destination, §7-C).
 *
 * This file is the iOS lane: parallel authors add iOS rows here and nowhere else.
 */

import type { Scenario } from "../scenario.js";
import { ios, iosTotal, shot } from "./helpers.js";

// ───────────────────────── every-merge (fast gate) ─────────────────────────

const EVERY_MERGE: readonly Scenario[] = [
  ios(
    "ios-cold-launch-home",
    "Cold launch in -smoke-mode lands on the seeded Home shell (DemoFixtures pods rendered).",
    "FlagshipAppUITests/GymSmokeTests",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab home (DemoFixtures seeded)." },
        { kind: "assert", describe: "Home add-server affordance (present only with pods).", handle: "home-add-server" },
      ],
      assertions: [{ describe: "Seeded Home shell present", handle: "home-add-server", expect: "present" }],
      screenshots: [shot("cold-launch", "After launch."), shot("home-ready", "Home with seeded pods.")],
      dimension: "D1",
    },
  ),
  ios(
    "ios-services-tab",
    "The Services tab renders its shell in smoke mode.",
    "FlagshipAppUITests/GymEveryMergeTests/test_servicesTabRenders",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab apps." },
        { kind: "assert", describe: "Services nav bar.", handle: "Services" },
      ],
      assertions: [{ describe: "Services shell present", handle: "Services", expect: "present" }],
      screenshots: [shot("cold-launch", "After launch."), shot("services-ready", "Services shell.")],
      dimension: "D8",
    },
  ),
  ios(
    "ios-activity-tab",
    "The Activity tab renders its shell in smoke mode.",
    "FlagshipAppUITests/GymEveryMergeTests/test_activityTabRenders",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab activity." },
        { kind: "assert", describe: "Provisioning nav bar.", handle: "Provisioning" },
      ],
      assertions: [{ describe: "Activity shell present", handle: "Provisioning", expect: "present" }],
      screenshots: [shot("cold-launch", "After launch."), shot("activity-ready", "Activity shell.")],
      dimension: "D8",
    },
  ),
  ios(
    "ios-settings-tab",
    "The Settings tab renders its shell + the session-tiers cluster (account-security row + the tier-2 sign-out).",
    "FlagshipAppUITests/GymEveryMergeTests/test_settingsTabRenders",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab settings." },
        { kind: "assert", describe: "Settings nav bar + account-security row.", handle: "settings-open-account-security" },
        { kind: "assert", describe: "Tier-2 sign-out row.", handle: "settings-sign-out-btn" },
      ],
      assertions: [
        { describe: "Account-security row present", handle: "settings-open-account-security", expect: "present" },
        { describe: "Sign-out row present", handle: "settings-sign-out-btn", expect: "present" },
      ],
      screenshots: [shot("cold-launch", "After launch."), shot("settings-ready", "Settings shell.")],
      dimension: "D3",
    },
  ),
  ios(
    "ios-create-server-form",
    "Home → add-server opens the create-server form (name step) → advance to the disk-encryption control.",
    "FlagshipAppUITests/GymEveryMergeTests/test_createServerFormReachable",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab home." },
        { kind: "tap", describe: "Add server (in-app = provision a new box).", handle: "home-add-server" },
        { kind: "assert", describe: "Name field (step 0).", handle: "cs-name-field" },
        { kind: "type", describe: "Type a name to enable Next.", handle: "cs-name-field" },
        { kind: "tap", describe: "Next → boot-unlock / disk-encryption step.", handle: "cs-next-button" },
        { kind: "assert", describe: "Disk-encryption toggle (step 1).", handle: "cs-encrypt-disk-toggle" },
      ],
      assertions: [
        { describe: "Name field present", handle: "cs-name-field", expect: "present" },
        { describe: "Disk-encryption toggle present", handle: "cs-encrypt-disk-toggle", expect: "present" },
      ],
      screenshots: [
        shot("home-ready", "Home."),
        shot("create-server-form", "Create-server name step."),
        shot("create-server-encrypt", "The disk-encryption step."),
      ],
      dimension: "D1",
    },
  ),
  ios(
    "ios-operations-sliver",
    "With -smoke-ops seeding one in-flight build, the global active-operations sliver renders.",
    "FlagshipAppUITests/GymEveryMergeTests/test_activeOperationsSliverRenders",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab home -smoke-ops." },
        { kind: "assert", describe: "Global operations sliver present.", handle: "global-operations-bar" },
      ],
      assertions: [{ describe: "Operations sliver present", handle: "global-operations-bar", expect: "present" }],
      screenshots: [shot("operations-sliver", "The teal operations sliver.")],
      dimension: "D5",
    },
  ),
];

// ───────────────────── total-gym Tier-1 tranche (§12-G5) ────────────────────
// iOS ids match GymTotalTests methods. `total` tier → run ONLY in `gym:total`.

const TOTAL: readonly Scenario[] = [
  // D1 — server-detail cards + the revoke confirm sheet.
  iosTotal(
    "ios-total-server-detail-cards",
    "D1: tapping the seeded online pod renders its server-detail cards (lock/power, front-page, journal).",
    "FlagshipAppUITests/GymTotalTests/test_serverDetailRendersCards",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab home." },
        { kind: "tap", describe: "Open the Home pod's detail.", handle: "Home" },
        { kind: "assert", describe: "Power-off control.", handle: "sd-power-off" },
      ],
      assertions: [
        { describe: "Lock/power control present", handle: "sd-power-off", expect: "present" },
        { describe: "Front-page picker present", handle: "sd-front-page-picker", expect: "present" },
        { describe: "Journal action present", handle: "sd-journal-fetch", expect: "present" },
      ],
      screenshots: [shot("server-detail", "The server-detail screen."), shot("server-detail-cards", "Its loaded cards.")],
      dimension: "D1",
    },
  ),
  iosTotal(
    "ios-total-revoke-confirm",
    "D1: the danger-zone revoke opens the hold-to-confirm sheet (the confirm UI — NOT a backend delete).",
    "FlagshipAppUITests/GymTotalTests/test_revokeServerSheetConfirm",
    {
      steps: [
        { kind: "launch", describe: "Open the Home pod's detail." },
        { kind: "tap", describe: "Revoke.", handle: "sd-revoke-server" },
        { kind: "assert", describe: "Hold-to-confirm sheet.", handle: "revoke-confirm-hold" },
      ],
      assertions: [{ describe: "Hold-to-confirm control present", handle: "revoke-confirm-hold", expect: "present" }],
      screenshots: [shot("danger-zone", "The danger zone."), shot("revoke-confirm", "The hold-to-confirm sheet.")],
      dimension: "D1",
    },
  ),
  // D2 — build modes.
  iosTotal(
    "ios-total-build-chooser",
    "D2-B1: the build chooser renders the on-main source tiles (scratch/git/mcp).",
    "FlagshipAppUITests/GymTotalTests/test_buildChooserRenders",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab apps." },
        { kind: "tap", describe: "Build another service.", handle: "Build another service" },
        { kind: "assert", describe: "Scratch tile.", handle: "build-src-scratch" },
      ],
      assertions: [
        { describe: "Scratch tile present", handle: "build-src-scratch", expect: "present" },
        { describe: "Git tile present", handle: "build-src-git", expect: "present" },
        { describe: "MCP tile present", handle: "build-src-mcp", expect: "present" },
      ],
      screenshots: [shot("services-ready", "Services tab."), shot("build-chooser", "The build chooser.")],
      dimension: "D2",
    },
  ),
  iosTotal(
    "ios-total-build-git",
    "D2-B5: the git import (fitness-verdict) screen renders its Check-repo control.",
    "FlagshipAppUITests/GymTotalTests/test_buildGitFitnessScreen",
    {
      steps: [
        { kind: "launch", describe: "Chooser → git." },
        { kind: "assert", describe: "Check-repo control.", handle: "build-git-check" },
      ],
      assertions: [{ describe: "Check-repo control present", handle: "build-git-check", expect: "present" }],
      screenshots: [shot("build-git", "The git import screen.")],
      dimension: "D2",
    },
  ),
  iosTotal(
    "ios-total-build-mcp",
    "D2-B8: the MCP IDE-connect screen renders its Create-connection control.",
    "FlagshipAppUITests/GymTotalTests/test_buildMcpConnectScreen",
    {
      steps: [
        { kind: "launch", describe: "Chooser → mcp." },
        { kind: "assert", describe: "Create-connection control.", handle: "build-mcp-create" },
      ],
      assertions: [{ describe: "Create-connection control present", handle: "build-mcp-create", expect: "present" }],
      screenshots: [shot("build-mcp", "The MCP connect screen.")],
      dimension: "D2",
    },
  ),
  iosTotal(
    "ios-total-ai-key-step",
    "D2-B2 + D7-light: scratch routes through the AI-key step (the use-a-different-key affordance is present).",
    "FlagshipAppUITests/GymTotalTests/test_buildKeyAiStepRenders",
    {
      steps: [
        { kind: "launch", describe: "Chooser → scratch." },
        { kind: "assert", describe: "AI-key step.", handle: "build-key-different" },
      ],
      assertions: [{ describe: "Use-a-different-key affordance present", handle: "build-key-different", expect: "present" }],
      screenshots: [shot("build-key", "The AI-key step.")],
      dimension: "D2",
    },
  ),
  // D3 — AI-keys manager.
  iosTotal(
    "ios-total-ai-keys-manager",
    "D3-C2: Settings → AI keys opens the device-local key manager (the Add-a-key affordance renders).",
    "FlagshipAppUITests/GymTotalTests/test_aiKeysManagerRenders",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab settings." },
        { kind: "tap", describe: "AI keys row.", handle: "AI keys" },
        { kind: "assert", describe: "Add-a-key affordance.", handle: "ai-key-add" },
      ],
      assertions: [{ describe: "Add-a-key affordance present", handle: "ai-key-add", expect: "present" }],
      screenshots: [shot("ai-keys", "The AI-keys manager.")],
      dimension: "D3",
    },
  ),
  // D4 — security: lock screen + trust sliver.
  iosTotal(
    "ios-total-lock-screen",
    "D4-E1: tapping the tier-1 Lock action in Settings re-gates the shell behind the biometric lock screen.",
    "FlagshipAppUITests/GymTotalTests/test_biometricLockScreenTraps",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab settings." },
        { kind: "tap", describe: "Tier-1 Lock action.", handle: "settings-lock-btn" },
        { kind: "assert", describe: "Lock screen.", handle: "biometric-lock-screen" },
      ],
      assertions: [{ describe: "Biometric lock screen present", handle: "biometric-lock-screen", expect: "present" }],
      screenshots: [shot("lock-screen", "The biometric lock screen.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-trust-sliver",
    "D4-E7: with -smoke-trust-untrusted a seeded untrusted verdict renders the red trust sliver.",
    "FlagshipAppUITests/GymTotalTests/test_trustSliverRendersUntrusted",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab home -smoke-trust-untrusted." },
        { kind: "assert", describe: "Red trust sliver.", handle: "global-trust-bar" },
      ],
      assertions: [{ describe: "Trust sliver present", handle: "global-trust-bar", expect: "present" }],
      screenshots: [shot("trust-sliver", "The red maintainer-trust sliver.")],
      dimension: "D4",
    },
  ),
  // D5 — server-event seed states.
  iosTotal(
    "ios-total-awaiting-unlock",
    "D5-F1: with -smoke-awaiting-unlock a box awaiting boot-unlock carries the waiting-for-approval pill on Home.",
    "FlagshipAppUITests/GymTotalTests/test_awaitingUnlockApproveCard",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab home -smoke-awaiting-unlock." },
        { kind: "assert", describe: "Waiting-for-approval pill on the Cabin row.", handle: "pod-card-waiting-approval" },
      ],
      assertions: [{ describe: "Waiting-for-approval pill present", handle: "pod-card-waiting-approval", expect: "present" }],
      screenshots: [shot("home-awaiting", "Home with a waiting box.")],
      dimension: "D5",
    },
  ),
  iosTotal(
    "ios-total-dead-server",
    "D5-F3: with -smoke-dead a box that never came online surfaces the never-online status pill on Home.",
    "FlagshipAppUITests/GymTotalTests/test_deadServerSurfacesOnHome",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab home -smoke-dead." },
        { kind: "assert", describe: "Never-online pill.", handle: "pod-card-never-online" },
      ],
      assertions: [{ describe: "Never-online pill present", handle: "pod-card-never-online", expect: "present" }],
      screenshots: [shot("dead-server", "The dead server on Home.")],
      dimension: "D5",
    },
  ),
];

/** The iOS/iPad lane of the gym registry (every-merge subset + total tranche). */
export const IOS_GYM_SCENARIOS: readonly Scenario[] = [...EVERY_MERGE, ...TOTAL];
