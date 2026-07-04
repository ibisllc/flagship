/**
 * Android gym scenarios — the Android lane of the registry (§10 Phase-5).
 *
 * All NO-BACKEND (the `flagship.smoke*` Intent extras → SmokeMode seeds
 * DemoFixtures + the mock client; see apps/mobile/android .../core/SmokeMode.kt).
 * Each entry's `harness` is the Compose-UI-Test class[#method] identifier the
 * AndroidAdapter passes to AndroidJUnitRunner via
 * `-Pandroid.testInstrumentationRunnerArguments.class` (NO "/"): the classes
 * live under apps/mobile/android/app/src/androidTest (GymSmokeTest +
 * GymEveryMergeTest = every-merge; GymTotalTest = the total tranche). Mirror of
 * the iOS lane (ios.ts), cluster-for-cluster.
 *
 * This file is the Android lane: parallel authors add Android rows here and
 * nowhere else.
 */

import type { Scenario } from "../scenario.js";
import { android, androidTotal, shot } from "./helpers.js";

const PKG = "com.flagshipserver.app.gym";

// ───────────────────────── every-merge (fast gate) ─────────────────────────

const EVERY_MERGE: readonly Scenario[] = [
  android(
    "android-cold-launch-home",
    "Cold launch in smoke mode lands on the seeded Home shell (DemoFixtures pods rendered).",
    `${PKG}.GymSmokeTest`,
    {
      steps: [
        { kind: "launch", describe: "Launch with flagship.smokeMode + smokeTab=home (DemoFixtures seeded)." },
        { kind: "assert", describe: "Home add-server affordance (present only with pods).", handle: "home-add-server" },
      ],
      assertions: [{ describe: "Seeded Home shell present", handle: "home-add-server", expect: "present" }],
      screenshots: [shot("cold-launch", "After launch."), shot("home-ready", "Home with seeded pods.")],
      dimension: "D1",
    },
  ),
  android(
    "android-home-tab",
    "The Home tab renders its large-title landmark in smoke mode.",
    `${PKG}.GymEveryMergeTest#homeTabRenders`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=home." },
        { kind: "assert", describe: "Home title.", handle: "home-title" },
      ],
      assertions: [{ describe: "Home title present", handle: "home-title", expect: "present" }],
      screenshots: [shot("cold-launch", "After launch."), shot("home-ready", "Home shell.")],
      dimension: "D8",
    },
  ),
  android(
    "android-services-tab",
    "The Services tab renders its shell in smoke mode.",
    `${PKG}.GymEveryMergeTest#servicesTabRenders`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=apps." },
        { kind: "assert", describe: "Services title.", handle: "services-title" },
      ],
      assertions: [{ describe: "Services shell present", handle: "services-title", expect: "present" }],
      screenshots: [shot("cold-launch", "After launch."), shot("services-ready", "Services shell.")],
      dimension: "D8",
    },
  ),
  android(
    "android-activity-tab",
    "The Activity tab renders its shell in smoke mode.",
    `${PKG}.GymEveryMergeTest#activityTabRenders`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=activity." },
        { kind: "assert", describe: "Activity title.", handle: "activity-title" },
      ],
      assertions: [{ describe: "Activity shell present", handle: "activity-title", expect: "present" }],
      screenshots: [shot("cold-launch", "After launch."), shot("activity-ready", "Activity shell.")],
      dimension: "D8",
    },
  ),
  android(
    "android-settings-tab",
    "The Settings tab renders its shell + the session-tiers cluster (account-security row + the tier-2 lock-with-passkey).",
    `${PKG}.GymEveryMergeTest#settingsTabRenders`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=settings." },
        { kind: "assert", describe: "Account-security row.", handle: "settings-open-account-security" },
        { kind: "assert", describe: "Tier-2 lock-with-passkey row.", handle: "settings-sign-out-btn" },
      ],
      assertions: [
        { describe: "Account-security row present", handle: "settings-open-account-security", expect: "present" },
        { describe: "Lock-with-passkey present", handle: "settings-sign-out-btn", expect: "present" },
      ],
      screenshots: [shot("cold-launch", "After launch."), shot("settings-ready", "Settings shell.")],
      dimension: "D3",
    },
  ),
  android(
    "android-four-tabs-nav",
    "The four bottom-bar tabs are all reachable from a single launch (nav graph intact).",
    `${PKG}.GymEveryMergeTest#fourTabsReachableFromBottomBar`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=home." },
        { kind: "tap", describe: "Tap Services tab.", handle: "tab-apps" },
        { kind: "tap", describe: "Tap Activity tab.", handle: "tab-activity" },
        { kind: "tap", describe: "Tap Settings tab.", handle: "tab-settings" },
      ],
      assertions: [
        { describe: "Home title after launch", handle: "home-title", expect: "present" },
        { describe: "Services title after tab tap", handle: "services-title", expect: "present" },
        { describe: "Activity title after tab tap", handle: "activity-title", expect: "present" },
        { describe: "Settings title after tab tap", handle: "settings-title", expect: "present" },
      ],
      screenshots: [
        shot("tab-home", "Home tab."),
        shot("tab-apps", "Services tab."),
        shot("tab-activity", "Activity tab."),
        shot("tab-settings", "Settings tab."),
      ],
      dimension: "D8",
    },
  ),
  android(
    "android-create-server-form",
    "Home → add-server goes STRAIGHT to the create-server form (name field + disk-encryption control) — the chooser screen was removed.",
    `${PKG}.GymEveryMergeTest#createServerFormReachable`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=home." },
        { kind: "tap", describe: "Add a server (a NavHost push straight to the form).", handle: "home-add-server" },
        { kind: "assert", describe: "Name field.", handle: "cs-name-field" },
        { kind: "assert", describe: "Disk-encryption control.", handle: "cs-encrypt-disk-toggle" },
      ],
      assertions: [
        { describe: "Name field present", handle: "cs-name-field", expect: "present" },
        { describe: "Disk-encryption control present", handle: "cs-encrypt-disk-toggle", expect: "present" },
      ],
      screenshots: [
        shot("home-ready", "Home."),
        shot("create-server-form", "The create-server form."),
      ],
      dimension: "D1",
    },
  ),
  android(
    "android-operations-sliver",
    "With the ops seed, the global active-operations sliver renders.",
    `${PKG}.GymEveryMergeTest#activeOperationsSliverRenders`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=home + smokeOps." },
        { kind: "assert", describe: "Global operations sliver present.", handle: "global-operations-bar" },
      ],
      assertions: [{ describe: "Operations sliver present", handle: "global-operations-bar", expect: "present" }],
      screenshots: [shot("operations-sliver", "The teal operations sliver.")],
      dimension: "D5",
    },
  ),
];

// ───────────────────── total-gym Tier-1 tranche (§12-G5) ────────────────────
// Android ids match GymTotalTest methods. `total` tier → run ONLY in `gym:total`.

const TOTAL: readonly Scenario[] = [
  // D2 — build modes.
  androidTotal(
    "android-total-build-chooser",
    "D2-B1: Services → Build a service renders the on-main source tiles (scratch/git/mcp).",
    `${PKG}.GymTotalTest#buildChooserRenders`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=apps." },
        { kind: "tap", describe: "Build a service.", handle: "services-build-cta" },
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
  androidTotal(
    "android-total-build-git",
    "D2-B5: the chooser → git import screen renders its Check-repo control.",
    `${PKG}.GymTotalTest#buildGitFitnessScreen`,
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
  androidTotal(
    "android-total-build-mcp",
    "D2-B8: the chooser → MCP IDE-connect screen renders its Create-connection control.",
    `${PKG}.GymTotalTest#buildMcpConnectScreen`,
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
  // D3 — AI-keys manager.
  androidTotal(
    "android-total-ai-keys-manager",
    "D3-C2: Settings → AI keys opens the device-local key manager (the Add-a-key affordance renders).",
    `${PKG}.GymTotalTest#aiKeysManagerRenders`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=settings." },
        { kind: "tap", describe: "AI keys row.", handle: "settings-ai-keys" },
        { kind: "assert", describe: "Add-a-key affordance.", handle: "ai-key-add" },
      ],
      assertions: [
        { describe: "AI-keys title present", handle: "ai-keys-title", expect: "present" },
        { describe: "Add-a-key affordance present", handle: "ai-key-add", expect: "present" },
      ],
      screenshots: [shot("ai-keys", "The AI-keys manager.")],
      dimension: "D3",
    },
  ),
  // D4 — security: trust sliver.
  androidTotal(
    "android-total-trust-sliver",
    "D4-E7: with the untrusted-trust seed, a seeded untrusted verdict renders the red trust sliver.",
    `${PKG}.GymTotalTest#trustSliverRendersUntrusted`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=home + smokeTrustUntrusted." },
        { kind: "assert", describe: "Red trust sliver.", handle: "global-trust-bar" },
      ],
      assertions: [{ describe: "Trust sliver present", handle: "global-trust-bar", expect: "present" }],
      screenshots: [shot("trust-sliver", "The red maintainer-trust sliver.")],
      dimension: "D4",
    },
  ),
  // D5 — server-event seed states.
  androidTotal(
    "android-total-awaiting-unlock",
    "D5-F1: with the awaiting-unlock seed, a box awaiting boot-unlock carries the waiting-for-approval pill on Home.",
    `${PKG}.GymTotalTest#awaitingUnlockPillOnHome`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=home + smokePods=awaiting-unlock." },
        { kind: "assert", describe: "Waiting-for-approval pill on the Cabin row.", handle: "pod-card-waiting-approval" },
      ],
      assertions: [{ describe: "Waiting-for-approval pill present", handle: "pod-card-waiting-approval", expect: "present" }],
      screenshots: [shot("home-awaiting", "Home with a waiting box.")],
      dimension: "D5",
    },
  ),
  androidTotal(
    "android-total-dead-server",
    "D5-F3: with the dead seed, a box that never came online surfaces the never-online status pill on Home.",
    `${PKG}.GymTotalTest#deadServerSurfacesOnHome`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=home + smokePods=dead." },
        { kind: "assert", describe: "Never-online pill.", handle: "pod-card-never-online" },
      ],
      assertions: [{ describe: "Never-online pill present", handle: "pod-card-never-online", expect: "present" }],
      screenshots: [shot("dead-server", "The dead server on Home.")],
      dimension: "D5",
    },
  ),
];

/** The Android lane of the gym registry (every-merge subset + total tranche). */
export const ANDROID_GYM_SCENARIOS: readonly Scenario[] = [...EVERY_MERGE, ...TOTAL];
