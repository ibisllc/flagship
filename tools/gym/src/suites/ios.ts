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
import { IOS_SWEEP_SCENARIOS } from "./ios-sweep.js";
import { IOS_NOTICES } from "./iosNotices.js";
import { IOS_GONE } from "./iosGone.js";

// ───────────────────────── every-merge (fast gate) ─────────────────────────

const EVERY_MERGE: readonly Scenario[] = [
  ios(
    "ios-cold-launch-home",
    "Cold launch in -smoke-mode lands on the seeded Home shell (DemoFixtures pods rendered).",
    "FlagshipAppUITests/GymSmokeTests",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab home -smoke-admin-root (DemoFixtures seeded; an admin device)." },
        { kind: "assert", describe: "Home's Add/Import a server (admin devices only).", handle: "home-add-server" },
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
    "Home → Add/Import a server → Create a new server opens the create-server form (name step), then advance to the disk-encryption control.",
    "FlagshipAppUITests/GymEveryMergeTests/test_createServerFormReachable",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab home -smoke-admin-root (an admin device)." },
        { kind: "tap", describe: "Add/Import a server.", handle: "home-add-server" },
        { kind: "tap", describe: "Create a new server.", handle: "home-add-new-server" },
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
    "ios-home-non-admin",
    "A device without the account's admin root (not an admin device): Home lists the servers with no Add/Import a server and so no menu (docs/service-access-gating.md 'Account members').",
    "FlagshipAppUITests/GymEveryMergeTests/test_nonAdminHomeHasNoAddServer",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab home without -smoke-admin-root." },
        { kind: "assert", describe: "The server list drew.", handle: "YOUR SERVERS" },
      ],
      assertions: [
        { describe: "No Add/Import a server", handle: "home-add-server", expect: "absent" },
        { describe: "No menu", handle: "home-add-new-server", expect: "absent" },
      ],
      screenshots: [shot("home-non-admin", "Home on a non-admin device.")],
      dimension: "D1",
    },
  ),
  ios(
    "ios-import-backup",
    "Home → Add/Import a server → Import a backup opens the restore flow at its first step: pick the archive's files (admin device).",
    "FlagshipAppUITests/GymEveryMergeTests/test_importBackupOpensTheRestoreFlow",
    {
      steps: [
        { kind: "tap", describe: "Add/Import a server.", handle: "home-add-server" },
        { kind: "tap", describe: "Import a backup.", handle: "home-import-backup" },
        { kind: "assert", describe: "Pick the files.", handle: "import-backup-choose" },
      ],
      assertions: [{ describe: "File picker step", handle: "import-backup-choose", expect: "present" }],
      screenshots: [shot("import-backup-pick", "The first step.")],
      dimension: "D1",
    },
  ),
  ios(
    "ios-awaiting-backup",
    "A server made to restore a backup (-smoke-awaiting-backup) reads 'Waiting for its backup' on Home; tapping it opens the send flow.",
    "FlagshipAppUITests/GymEveryMergeTests/test_aServerWaitingForItsBackupOffersToSendIt",
    {
      steps: [
        { kind: "assert", describe: "Home marks the waiting server.", handle: "Waiting for its backup" },
        { kind: "tap", describe: "Open it.", handle: "Waiting for its backup" },
        { kind: "assert", describe: "The send flow.", handle: "import-backup-choose" },
      ],
      assertions: [{ describe: "Send flow", handle: "import-backup-choose", expect: "present" }],
      screenshots: [shot("home-awaiting-backup", "Home."), shot("send-backup-pick", "Send flow.")],
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
    "D2-B2 + D7-light: with Flagship Inference and no own key, scratch lands on Describe (model menu); the AI-key step lists Flagship Inference and a way to add a key.",
    "FlagshipAppUITests/GymTotalTests/test_buildKeyAiStepRenders",
    {
      steps: [
        { kind: "launch", describe: "Chooser → scratch." },
        { kind: "assert", describe: "Describe with the model menu.", handle: "describe-model-menu" },
        { kind: "assert", describe: "Back: the AI-key step.", handle: "build-key-free-ai" },
      ],
      assertions: [
        { describe: "Model menu on Describe", handle: "describe-model-menu", expect: "present" },
        { describe: "Flagship Inference on the key step", handle: "build-key-free-ai", expect: "present" },
      ],
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

// ───────────────────── total-gym Tier-1: the iPad surface (§7-C, D8) ─────────
// These scenarios bind to GymIPadTests, which the iOS adapter routes to the
// iPad `-destination` (every other iOS scenario runs on the iPhone). The
// adaptive iPad shell already exists (RootShell.iPadShell); these ASSERT it
// renders — the 280pt sidebar (not the iPhone TabView), the reading-column
// width clamp, and inline (not large) nav titles.

const IPAD: readonly Scenario[] = [
  iosTotal(
    "ios-ipad-sidebar-not-tabview",
    "D8/iPad: the regular-size-class shell renders the 280pt sidebar and NOT the iPhone TabView (no tab bar).",
    "FlagshipAppUITests/GymIPadTests/test_iPadRendersSidebarNotTabView",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab home -smoke-admin-root on the iPad destination." },
        { kind: "assert", describe: "The seeded Home shell.", handle: "home-add-server" },
        { kind: "assert", describe: "The iPad sidebar.", handle: "ipad-sidebar" },
      ],
      assertions: [
        { describe: "iPad sidebar present", handle: "ipad-sidebar", expect: "present" },
        { describe: "No iPhone TabView tab bar", expect: "absent" },
      ],
      screenshots: [shot("ipad-home", "Home on iPad."), shot("ipad-sidebar", "The 280pt sidebar.")],
      dimension: "D8",
    },
  ),
  iosTotal(
    "ios-ipad-sidebar-navigates",
    "D8/iPad: tapping a sidebar destination row swaps the content pane (sidebar is the live navigator).",
    "FlagshipAppUITests/GymIPadTests/test_iPadSidebarNavigatesContentPane",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab home on iPad." },
        { kind: "tap", describe: "The Services sidebar row.", handle: "ipad-sidebar" },
        { kind: "assert", describe: "The Services content pane.", handle: "Services" },
      ],
      assertions: [{ describe: "Services content pane shown", handle: "Services", expect: "present" }],
      screenshots: [shot("ipad-services-pane", "The Services pane via the sidebar.")],
      dimension: "D8",
    },
  ),
  iosTotal(
    "ios-ipad-reading-column",
    "D8/iPad: the hero screens clamp their content to the ~640pt reading column on the wide iPad pane.",
    "FlagshipAppUITests/GymIPadTests/test_iPadReadingColumnConstrainsWidth",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab home -smoke-admin-root on iPad." },
        { kind: "assert", describe: "A reading-column-bounded control.", handle: "home-add-server" },
      ],
      assertions: [{ describe: "Content clamped below the iPad pane width", handle: "home-add-server", expect: "present" }],
      screenshots: [shot("ipad-reading-column", "The clamped reading column.")],
      dimension: "D8",
    },
  ),
  iosTotal(
    "ios-ipad-inline-titles",
    "D8/iPad: hero screens use inline (not large) nav titles in the regular size class.",
    "FlagshipAppUITests/GymIPadTests/test_iPadUsesInlineNavTitles",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab home on iPad." },
        { kind: "assert", describe: "The Home nav bar (inline title).", handle: "Home" },
      ],
      assertions: [{ describe: "Inline nav title (no large out-of-bar title)", handle: "Home", expect: "present" }],
      screenshots: [shot("ipad-inline-title", "The inline Home title.")],
      dimension: "D8",
    },
  ),
];

// ───────── total-gym Tier-1: deeper D1–D6 coverage (GymTotalDetailTests) ─────
// Beyond the "screen renders" tranche above into control sweeps + multi-step
// flows the demo fixtures can drive with NO backend. Destructive controls are
// asserted at the CONFIRM stage only (never fired — Tier-1; §7-G).

const TOTAL_DETAIL: readonly Scenario[] = [
  // D1 — server-detail control sweep + the full create-server step flow.
  iosTotal(
    "ios-total-detail-backup-passcode",
    "D1: Backup/clone server opens with a suggested passcode; Start stays off until the passcode is saved.",
    "FlagshipAppUITests/GymTotalDetailTests/test_backupStartsWithThePasscode",
    {
      steps: [
        { kind: "tap", describe: "Home server → Backup/clone server.", handle: "sd-backup-server" },
        { kind: "assert", describe: "Suggested passcode.", handle: "backup-suggested-passcode" },
      ],
      assertions: [
        { describe: "Passcode suggested", handle: "backup-suggested-passcode", expect: "present" },
        { describe: "Start waits for the passcode", handle: "backup-start", expect: "present" },
      ],
      screenshots: [shot("backup-passcode", "The passcode step.")],
      dimension: "D1",
    },
  ),
  iosTotal(
    "ios-total-detail-deadman-screen",
    "D1: the dead-man (auto lock-down) card opens its screen; the enable toggle renders.",
    "FlagshipAppUITests/GymTotalDetailTests/test_serverDetailDeadManScreenOpens",
    {
      steps: [
        { kind: "launch", describe: "Open the Home pod's detail." },
        { kind: "tap", describe: "Auto lock-down card.", handle: "sd-deadman-open" },
        { kind: "assert", describe: "Dead-man enable toggle.", handle: "deadman-toggle" },
      ],
      assertions: [{ describe: "Dead-man enable toggle present", handle: "deadman-toggle", expect: "present" }],
      screenshots: [shot("server-detail-deadman-card", "The card."), shot("deadman-screen", "The lock-down screen.")],
      dimension: "D1",
    },
  ),
  iosTotal(
    "ios-total-detail-journal-controls",
    "D1: the Diagnostics journal card renders the unit picker + View-journal control.",
    "FlagshipAppUITests/GymTotalDetailTests/test_serverDetailJournalControls",
    {
      steps: [
        { kind: "launch", describe: "Open the Home pod's detail." },
        { kind: "assert", describe: "View-journal control.", handle: "sd-journal-fetch" },
      ],
      assertions: [{ describe: "View-journal control present", handle: "sd-journal-fetch", expect: "present" }],
      screenshots: [shot("server-detail-journal", "The journal diagnostics card.")],
      dimension: "D1",
    },
  ),
  iosTotal(
    "ios-total-detail-frontpage-picker",
    "D1: the front-page (owner-assignable apex) picker renders on server-detail.",
    "FlagshipAppUITests/GymTotalDetailTests/test_serverDetailFrontPagePicker",
    {
      steps: [
        { kind: "launch", describe: "Open the Home pod's detail." },
        { kind: "assert", describe: "Front-page picker.", handle: "sd-front-page-picker" },
      ],
      assertions: [{ describe: "Front-page picker present", handle: "sd-front-page-picker", expect: "present" }],
      screenshots: [shot("server-detail-frontpage", "The front-page picker.")],
      dimension: "D1",
    },
  ),
  iosTotal(
    "ios-total-detail-delete-dead",
    "D1/D5: a dead box's detail still offers Delete (the box never answers, the page doesn't need it to).",
    "FlagshipAppUITests/GymTotalDetailTests/test_serverDetailDeadServerDeleteButton",
    {
      steps: [
        { kind: "launch", describe: "Open the dead box (Attic) detail (-smoke-dead)." },
        { kind: "assert", describe: "Delete button.", handle: "sd-delete-server" },
      ],
      assertions: [{ describe: "Delete offered", handle: "sd-delete-server", expect: "present" }],
      screenshots: [shot("server-detail-delete", "The delete button.")],
      dimension: "D1",
    },
  ),
  iosTotal(
    "ios-total-create-server-full-flow",
    "D1-A4: walk the create-server wizard — name → boot-unlock + encryption → backup policy.",
    "FlagshipAppUITests/GymTotalDetailTests/test_createServerFullStepFlow",
    {
      steps: [
        { kind: "tap", describe: "Add/Import a server (-smoke-admin-root: an admin device).", handle: "home-add-server" },
        { kind: "tap", describe: "Create a new server.", handle: "home-add-new-server" },
        { kind: "type", describe: "Name (step 0).", handle: "cs-name-field" },
        { kind: "tap", describe: "Next → step 1.", handle: "cs-next-button" },
        { kind: "assert", describe: "Disk-encryption toggle (step 1).", handle: "cs-encrypt-disk-toggle" },
        { kind: "tap", describe: "Next → step 2.", handle: "cs-next-button" },
        { kind: "assert", describe: "Backup-policy radio (step 2).", handle: "cs-backup-policy-none" },
      ],
      assertions: [
        { describe: "Disk-encryption toggle present", handle: "cs-encrypt-disk-toggle", expect: "present" },
        { describe: "Backup-policy radio present", handle: "cs-backup-policy-none", expect: "present" },
        { describe: "Continue (→ scan) present", handle: "cs-continue-button", expect: "present" },
      ],
      screenshots: [
        shot("create-step0-name", "Step 0 name."),
        shot("create-step1-bootunlock", "Step 1 boot-unlock."),
        shot("create-step2-backup", "Step 2 backup policy."),
      ],
      dimension: "D1",
    },
  ),
  // D2 — build modes, deeper.
  iosTotal(
    "ios-total-build-git-verdict",
    "D2-B5: paste a Flagship-ready git URL → Check → the fitness verdict resolves (Install/Build-with-AI).",
    "FlagshipAppUITests/GymTotalDetailTests/test_buildGitFitnessVerdict",
    {
      steps: [
        { kind: "tap", describe: "Chooser → git.", handle: "build-src-git" },
        { kind: "type", describe: "A Flagship-ready repo URL." },
        { kind: "tap", describe: "Check repo.", handle: "build-git-check" },
        { kind: "assert", describe: "Verdict CTA.", handle: "build-git-deploy" },
      ],
      assertions: [{ describe: "Fitness verdict resolved", handle: "build-git-deploy", expect: "present" }],
      screenshots: [shot("build-git-verdict", "The fitness verdict.")],
      dimension: "D2",
    },
  ),
  iosTotal(
    "ios-total-build-mcp-connect",
    "D2-B8: MCP create-connection → the copyable IDE config + rotate controls render.",
    "FlagshipAppUITests/GymTotalDetailTests/test_buildMcpConnect",
    {
      steps: [
        { kind: "tap", describe: "Chooser → mcp.", handle: "build-src-mcp" },
        { kind: "tap", describe: "Create a connection.", handle: "build-mcp-create" },
        { kind: "assert", describe: "Copy IDE config.", handle: "build-mcp-copy-config" },
      ],
      assertions: [{ describe: "Post-connection controls present", handle: "build-mcp-copy-config", expect: "present" }],
      screenshots: [shot("build-mcp-pre", "Before connect."), shot("build-mcp-connected", "After connect.")],
      dimension: "D2",
    },
  ),
  iosTotal(
    "ios-total-build-mcp-ide-configs",
    "Connect your IDE shows each IDE's own config: Claude Code with its claude mcp add --scope user command, Cursor, VS Code (servers) and Cline (streamableHttp), each saying where it goes; URLs copy unescaped; keep it in the IDE's user settings.",
    "FlagshipAppUITests/GymTotalDetailTests/test_buildMcpIdeConfigs",
    {
      steps: [
        { kind: "tap", describe: "Create a connection.", handle: "build-mcp-create" },
        { kind: "tap", describe: "VS Code.", handle: "VS Code" },
        { kind: "tap", describe: "Cline.", handle: "Cline" },
      ],
      assertions: [
        { describe: "Claude Code command", handle: "build-mcp-ide-command", expect: "present" },
        { describe: "User-settings warning", handle: "build-mcp-user-settings", expect: "present" },
      ],
      screenshots: [shot("build-mcp-ide-claude-code", "Claude Code."), shot("build-mcp-ide-cline", "Cline.")],
      dimension: "D2",
    },
  ),
  iosTotal(
    "ios-total-build-journal-list",
    "D2-B10: the build journal opens from the chooser's View-past-builds link.",
    "FlagshipAppUITests/GymTotalDetailTests/test_buildJournalList",
    {
      steps: [
        { kind: "tap", describe: "Chooser → View past builds.", handle: "build-source-journal-link" },
        { kind: "assert", describe: "Build journal screen.", handle: "Build journal" },
      ],
      assertions: [{ describe: "Build journal screen shown", handle: "Build journal", expect: "present" }],
      screenshots: [shot("build-journal", "The build journal.")],
      dimension: "D2",
    },
  ),
  iosTotal(
    "ios-total-vibecode-chat",
    "D2-B3: the scratch vibe-code chat screen (reached via the seeded build op) renders its composer.",
    "FlagshipAppUITests/GymTotalDetailTests/test_vibeCodeChatScreenRenders",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab apps -smoke-ops." },
        { kind: "tap", describe: "The build operation sliver.", handle: "global-operations-bar" },
        { kind: "assert", describe: "The env-var composer the AI is waiting on, over the live link.", handle: "vibecode-envvar-field" },
      ],
      assertions: [{ describe: "Env-var composer present on a live app", handle: "vibecode-envvar-field", expect: "present" }],
      screenshots: [shot("ops-sliver-apps", "The ops sliver."), shot("vibecode-chat", "The chat screen.")],
      dimension: "D2",
    },
  ),
  // D3 — settings: gating, AI keys, security.
  iosTotal(
    "ios-total-session-tiers-gate",
    "D3-C1: with no recovery (-smoke-no-recovery), tapping the greyed tier-2 button shows the recovery toast — not the destructive path.",
    "FlagshipAppUITests/GymTotalDetailTests/test_sessionTiersRecoveryGate",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab settings -smoke-no-recovery." },
        { kind: "tap", describe: "The greyed tier-2 Sign out.", handle: "settings-sign-out-btn" },
        { kind: "assert", describe: "The recovery-required toast.", handle: "Set up account recovery to use this." },
      ],
      assertions: [
        { describe: "Recovery toast shown", handle: "Set up account recovery to use this.", expect: "present" },
        { describe: "No destructive confirm dialog", expect: "absent" },
      ],
      screenshots: [shot("settings-tiers-gated", "The gated tiers."), shot("settings-recovery-toast", "The toast.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-total-ai-keys-add-form",
    "D3-C2: AI-keys manager Add-a-key reveals the provider picker + the secure key field.",
    "FlagshipAppUITests/GymTotalDetailTests/test_aiKeysManagerAddForm",
    {
      steps: [
        { kind: "tap", describe: "Settings → AI keys.", handle: "AI keys" },
        { kind: "tap", describe: "Add a key.", handle: "ai-key-add" },
        { kind: "assert", describe: "The provider picker.", handle: "ai-key-provider" },
      ],
      assertions: [{ describe: "Provider picker present", handle: "ai-key-provider", expect: "present" }],
      screenshots: [shot("ai-keys-add-form", "The add-key form.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-total-account-security-enroll",
    "D3-C3: account-security TOTP enroll (QR + manual secret). SKIPPED — GYM-FOUND: the Settings row is unwired (no .accountSecurity route), so the screen is unreachable.",
    "FlagshipAppUITests/GymTotalDetailTests/test_accountSecurityTotpEnrollStages",
    {
      steps: [
        { kind: "tap", describe: "Settings → Account security.", handle: "settings-open-account-security" },
        { kind: "assert", describe: "Enrollment QR (when reachable).", handle: "account-security-qr" },
      ],
      assertions: [{ describe: "Enrollment QR present (when the nav is wired)", handle: "account-security-qr", expect: "present" }],
      screenshots: [shot("account-security-unwired", "The unwired row (bug).")],
      dimension: "D3",
    },
  ),
  // D4 — global security experience.
  iosTotal(
    "ios-total-lock-trap-launch",
    "D4-E1: launching with -smoke-locked traps the shell behind the biometric lock screen.",
    "FlagshipAppUITests/GymTotalDetailTests/test_lockScreenTrapsOnLaunch",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab home -smoke-locked -smoke-admin-root." },
        { kind: "assert", describe: "The biometric lock screen.", handle: "biometric-lock-screen" },
      ],
      assertions: [
        { describe: "Lock screen present", handle: "biometric-lock-screen", expect: "present" },
        { describe: "Home controls gated (not hittable)", handle: "home-add-server", expect: "disabled" },
      ],
      screenshots: [shot("lock-screen-launch", "The launch lock screen.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-trust-override-sheet",
    "D4-E8: tapping the red trust sliver (-smoke-trust-untrusted) opens the Continue-anyway override sheet.",
    "FlagshipAppUITests/GymTotalDetailTests/test_trustOverrideSheetOpens",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab home -smoke-trust-untrusted." },
        { kind: "tap", describe: "The red trust sliver.", handle: "global-trust-bar" },
        { kind: "assert", describe: "The override sheet.", handle: "Continue anyway?" },
      ],
      assertions: [{ describe: "Override sheet shown", handle: "Continue anyway?", expect: "present" }],
      screenshots: [shot("trust-sliver-detail", "The sliver."), shot("trust-override-sheet", "The override sheet.")],
      dimension: "D4",
    },
  ),
  // D5 — server-event → server-detail.
  iosTotal(
    "ios-total-detail-awaiting-unlock",
    "D5-F1: a box awaiting unlock (-smoke-awaiting-unlock) opens its detail with boot-unlock controls and no dead-box decommission.",
    "FlagshipAppUITests/GymTotalDetailTests/test_serverDetailAwaitingUnlockSurfaces",
    {
      steps: [
        { kind: "launch", describe: "Open the waiting box (Cabin) detail (-smoke-awaiting-unlock)." },
        { kind: "assert", describe: "A boot-unlock / power control.", handle: "sd-power-off" },
      ],
      assertions: [
        { describe: "Boot-unlock controls surface", handle: "sd-power-off", expect: "present" },
        { describe: "No dead-box decommission card", handle: "sd-decommission-dead-server", expect: "absent" },
      ],
      screenshots: [shot("server-detail-awaiting", "The waiting box's detail.")],
      dimension: "D5",
    },
  ),
];

// ───── total-gym Tier-1: webapp feature-tranche mirrors (GymFeatureMirrorTests) ─────
// iOS twins of web-total-transfer-offer / -box-inbox / -pod-switcher /
// -cs-advanced-toggles / -admin-root-state / -rotate-admin-ceremony /
// -promote-admin-toggle. The Slice-D admin surfaces ride the new
// `-smoke-admin-root` launch arg (GymSeams.forceAdminRoot) — a demo session
// never mints a real admin master root. NOT mirrored: the acquirer take-over
// claim (web-total-transfer-claim) — deep-link/QR-only entry on mobile and its
// verify stage needs a REAL signed offer (a signed-offer fixture seam is
// disproportionate for a render assert).

const FEATURE_MIRRORS: readonly Scenario[] = [
  iosTotal(
    "ios-total-transfer-offer-entry",
    "D1 (transfer-a-box, giver): server-detail's transfer entry opens the giver ceremony — the type-the-FQDN confirm field + the danger CTA (confirm stage only; nothing signed).",
    "FlagshipAppUITests/GymFeatureMirrorTests/test_transferOfferEntryOpensCeremony",
    {
      steps: [
        { kind: "launch", describe: "Open the Home pod's detail." },
        { kind: "tap", describe: "Transfer to another account.", handle: "sd-transfer-server" },
        { kind: "assert", describe: "Type-to-confirm field.", handle: "transfer-confirm-field" },
      ],
      assertions: [
        { describe: "Confirm field present", handle: "transfer-confirm-field", expect: "present" },
        { describe: "Transfer CTA present", handle: "transfer-start", expect: "present" },
      ],
      screenshots: [shot("transfer-entry", "The entry card."), shot("transfer-confirm-gate", "The type-to-confirm gate.")],
      dimension: "D1",
    },
  ),
  iosTotal(
    "ios-total-box-inbox-approve",
    "D5 (box-request inbox): a box awaiting boot-unlock (-smoke-awaiting-unlock) surfaces the one-tap Approve/Deny card at the top of its detail (never fired).",
    "FlagshipAppUITests/GymFeatureMirrorTests/test_boxInboxApproveCard",
    {
      steps: [
        { kind: "launch", describe: "Open the waiting box (Cabin) detail (-smoke-awaiting-unlock)." },
        { kind: "assert", describe: "Approve card.", handle: "sd-approve-unlock" },
      ],
      assertions: [
        { describe: "Approve affordance present", handle: "sd-approve-unlock", expect: "present" },
        { describe: "Deny affordance present", handle: "sd-deny-unlock", expect: "present" },
      ],
      screenshots: [shot("inbox-approve-card", "The one-tap approve card.")],
      dimension: "D5",
    },
  ),
  iosTotal(
    "ios-total-pod-switcher",
    "D5 (multi-pod): the Services tab renders the PodSwitcher (3 seeded pods); tapping it opens the pod menu.",
    "FlagshipAppUITests/GymFeatureMirrorTests/test_podSwitcherOpensMenu",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab apps." },
        { kind: "tap", describe: "The pod switcher.", handle: "pod-switcher" },
        { kind: "assert", describe: "The pod menu.", handle: "pod-switcher-menu" },
      ],
      assertions: [
        { describe: "Switcher present", handle: "pod-switcher", expect: "present" },
        { describe: "Menu opens", handle: "pod-switcher-menu", expect: "present" },
      ],
      screenshots: [shot("pod-switcher", "The switcher."), shot("pod-switcher-menu", "The open menu.")],
      dimension: "D5",
    },
  ),
  iosTotal(
    "ios-total-cs-advanced-toggles",
    "D4 (one-shot pairing security choices): the create-server step-1 Advanced section — default OFF, children hidden; open → embed-secrets + debug-friendly default OFF; closing RESETS an armed debug-friendly.",
    "FlagshipAppUITests/GymFeatureMirrorTests/test_createServerAdvancedTogglesResetRule",
    {
      steps: [
        { kind: "launch", describe: "Create-server → step 1 (name → Next)." },
        { kind: "assert", describe: "Advanced default OFF.", handle: "cs-advanced-toggle" },
        { kind: "tap", describe: "Open Advanced; arm debug-friendly.", handle: "cs-debug-friendly-toggle" },
        { kind: "tap", describe: "Close + reopen Advanced.", handle: "cs-advanced-toggle" },
        { kind: "assert", describe: "Debug-friendly RESET to off.", handle: "cs-debug-friendly-toggle" },
      ],
      assertions: [
        { describe: "Advanced toggle present + default OFF", handle: "cs-advanced-toggle", expect: "present" },
        { describe: "Embed-secrets toggle revealed", handle: "cs-embed-secrets-toggle", expect: "present" },
        { describe: "Debug-friendly reset on close", handle: "cs-debug-friendly-toggle", expect: "present" },
      ],
      screenshots: [shot("cs-advanced-open", "The opened Advanced section."), shot("cs-advanced-reset", "The reset-on-close rule.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-admin-root-state",
    "D3 (Slice D §5): Account security reports THIS device's admin standing — non-admin (demo default) shows NO rotate card; -smoke-admin-root renders the Admin-key card + Rotate.",
    "FlagshipAppUITests/GymFeatureMirrorTests/test_adminRootStateGatesRotateCard",
    {
      steps: [
        { kind: "launch", describe: "Settings → Account security (no admin seed)." },
        { kind: "assert", describe: "No rotate control.", handle: "rotate-admin-btn" },
        { kind: "launch", describe: "Relaunch with -smoke-admin-root." },
        { kind: "assert", describe: "Rotate control present.", handle: "rotate-admin-btn" },
      ],
      assertions: [
        { describe: "Rotate absent on a non-admin device", handle: "rotate-admin-btn", expect: "absent" },
        { describe: "Rotate present on an admin device", handle: "rotate-admin-btn", expect: "present" },
      ],
      screenshots: [shot("admin-root-non-admin", "The non-admin state."), shot("admin-root-admin", "The admin card with Rotate.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-total-rotate-admin-ceremony",
    "D4 (Slice D §5): Rotate admin key opens its revoke-semantic warning alert; Cancel rotates nothing.",
    "FlagshipAppUITests/GymFeatureMirrorTests/test_rotateAdminCeremonyFirstScreen",
    {
      steps: [
        { kind: "launch", describe: "Account security as an admin device (-smoke-admin-root)." },
        { kind: "tap", describe: "Rotate admin key.", handle: "rotate-admin-btn" },
        { kind: "assert", describe: "The warning alert.", handle: "Rotate your admin key?" },
        { kind: "tap", describe: "Cancel — nothing rotated." },
      ],
      assertions: [
        { describe: "Warning ceremony opens", handle: "Rotate your admin key?", expect: "present" },
        { describe: "No rotation after Cancel", handle: "rotate-admin-done-msg", expect: "absent" },
      ],
      screenshots: [shot("rotate-admin-ceremony", "The warning alert."), shot("rotate-admin-cancelled", "Intact after Cancel.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-total-promote-admin-toggle",
    "D3 (Slice D D-4): the promote-to-admin toggle appears ONLY on an admin device's add-device SAS ceremony (default OFF); a non-admin device cannot add a device at all (the row is disabled with \"Only an admin device of this account can add devices.\").",
    "FlagshipAppUITests/GymFeatureMirrorTests/test_promoteAdminToggleAdminOnly",
    {
      steps: [
        { kind: "launch", describe: "Settings (no admin seed): the Add a device row is disabled." },
        { kind: "assert", describe: "The admin-only sentence replaces the note.", handle: "settings-add-device-admin-only" },
        { kind: "assert", describe: "No promote toggle.", handle: "add-device-promote-admin-toggle" },
        { kind: "launch", describe: "Relaunch with -smoke-admin-root; reopen Add a device." },
        { kind: "assert", describe: "Promote toggle present, default OFF.", handle: "add-device-promote-admin-toggle" },
      ],
      assertions: [
        { describe: "Admin-only sentence on a non-admin device", handle: "settings-add-device-admin-only", expect: "present" },
        { describe: "Toggle absent on a non-admin device", handle: "add-device-promote-admin-toggle", expect: "absent" },
        { describe: "Toggle present + default OFF on an admin device", handle: "add-device-promote-admin-toggle", expect: "present" },
      ],
      screenshots: [shot("promote-absent-non-admin", "No promote section."), shot("promote-toggle-admin", "The default-OFF toggle.")],
      dimension: "D3",
    },
  ),
];

// ───── total-gym Tier-1: the October 2026 features (GymOctoberTests) ─────
// Handles are shared with Android (GymOctoberTest) and the webapp where the
// surfaces name them alike; see docs/ui-test-gym.md §8.

const O = "FlagshipAppUITests/GymOctoberTests/";

const OCTOBER: readonly Scenario[] = [
  iosTotal(
    "ios-oct-onboarding-walk",
    "D1-A1: Welcome → handle → Open account → skip backup → empty Home → Add/Import a server → Create a new server → designer → delivery chooser, against the mock clients (-smoke-onboarding).",
    "FlagshipAppUITests/OnboardingSmokeTests/test_coldLaunchReachesDeliveryChooser",
    {
      steps: [
        { kind: "tap", describe: "Create your account → Continue.", handle: "open-account-continue" },
        { kind: "tap", describe: "Skip the backup.", handle: "secure-account-skip-anyway" },
        { kind: "tap", describe: "Add/Import a server (the account's opener holds the admin root).", handle: "home-add-server" },
        { kind: "tap", describe: "Create a new server.", handle: "home-add-new-server" },
        { kind: "assert", describe: "Delivery chooser.", handle: "cs-delivery-pair" },
      ],
      assertions: [{ describe: "Delivery chooser offers pairing", handle: "cs-delivery-pair", expect: "present" }],
      screenshots: [shot("onboarding-delivery", "The delivery chooser.")],
      dimension: "D1",
    },
  ),
  iosTotal(
    "ios-connect-account-page",
    "Welcome offers Create your account + one Connect to an existing account; the connect page holds sign-in by account name above an 'or' and the pairing code (scan + paste) below; a name in the code field gets a sentence (-smoke-onboarding).",
    "FlagshipAppUITests/OnboardingSmokeTests/test_connectPageHoldsSignInAndPairing",
    {
      steps: [
        { kind: "tap", describe: "Connect to an existing account.", handle: "welcome-connect" },
        { kind: "assert", describe: "Both halves.", handle: "connect-pair-field" },
        { kind: "tap", describe: "Join with an account name typed as the code.", handle: "connect-pair-continue" },
      ],
      assertions: [
        { describe: "Sign-in field", handle: "connect-name-field", expect: "present" },
        { describe: "Scan a code", handle: "connect-scan", expect: "present" },
      ],
      screenshots: [shot("welcome", "Welcome: primary, secondary, Patent Pending."), shot("connect-account", "The connect page.")],
      dimension: "D1",
    },
  ),
  iosTotal(
    "ios-connect-sign-in-demo",
    "Connect to an existing account → the account name 'demo' → Continue opens the mock demo account (-smoke-onboarding).",
    "FlagshipAppUITests/OnboardingSmokeTests/test_connectSignInWithAccountName",
    {
      steps: [
        { kind: "type", describe: "Type demo.", handle: "connect-name-field" },
        { kind: "tap", describe: "Continue.", handle: "connect-name-continue" },
      ],
      assertions: [{ describe: "Lands in the app", handle: "Home", expect: "present" }],
      screenshots: [shot("connect-demo-home", "The demo account's Home.")],
      dimension: "D1",
    },
  ),
  iosTotal(
    "ios-connect-link-to-join",
    "A pairing link typed into the account-name field opens the join flow (-smoke-onboarding).",
    "FlagshipAppUITests/OnboardingSmokeTests/test_connectPairingLinkInNameFieldOpensJoin",
    {
      steps: [
        { kind: "type", describe: "Paste a /join link as the name.", handle: "connect-name-field" },
        { kind: "tap", describe: "Continue.", handle: "connect-name-continue" },
      ],
      assertions: [{ describe: "Join an account", handle: "Join an account", expect: "present" }],
      screenshots: [shot("connect-link-to-join", "The join flow.")],
      dimension: "D1",
    },
  ),
  iosTotal(
    "ios-connect-scan",
    "Scan a code on the connect page opens the in-app scanner (-smoke-onboarding).",
    "FlagshipAppUITests/OnboardingSmokeTests/test_connectScanOpensScanner",
    {
      steps: [{ kind: "tap", describe: "Scan a code.", handle: "connect-scan" }],
      assertions: [{ describe: "Join an account", handle: "Join an account", expect: "present" }],
      screenshots: [shot("connect-scanner", "The in-app scanner.")],
      dimension: "D1",
    },
  ),
  iosTotal(
    "ios-oct-access-alert-answer",
    "D5: the app-wide '<App> wants to reach <host>' sheet (-smoke-access-alert): Allow then Deny sign the list and confirm; then nothing covers Home.",
    O + "test_appAccessAlertAllowThenDeny",
    {
      steps: [
        { kind: "assert", describe: "The sheet asks.", handle: "access-alert-title" },
        { kind: "tap", describe: "Allow.", handle: "access-alert-allow" },
        { kind: "assert", describe: "Answered.", handle: "access-alert-done" },
        { kind: "tap", describe: "Deny the next host.", handle: "access-alert-deny" },
      ],
      assertions: [
        { describe: "Allow confirmed", handle: "access-alert-done", expect: "present" },
        { describe: "Home usable afterwards", handle: "home-add-server", expect: "enabled" },
      ],
      screenshots: [shot("access-alert-ask", "The question."), shot("access-alert-allowed", "The answer.")],
      dimension: "D5",
    },
  ),
  iosTotal(
    "ios-oct-service-env",
    "D6: Configure environment on Plants: a name the box can't take is refused on the phone; saving PLANT_TOKEN keeps WEATHER_API_KEY; removing WEATHER_API_KEY leaves PLANT_TOKEN. Each is one signed service-env-change the mock box checks (app, op, value hash, nonce spent once).",
    O + "test_serviceEnvSetsAndRemovesOneVariable",
    {
      steps: [
        { kind: "tap", describe: "Plants → More → Configure environment.", handle: "service-detail-env-menu-item" },
        { kind: "tap", describe: "Save a bad name, then PLANT_TOKEN; remove WEATHER_API_KEY.", handle: "service-env-save-btn" },
      ],
      assertions: [
        { describe: "New variable listed", handle: "service-env-row-PLANT_TOKEN", expect: "present" },
        { describe: "Removed variable gone", handle: "service-env-row-WEATHER_API_KEY", expect: "absent" },
      ],
      screenshots: [shot("service-env-saved", "Both variables."), shot("service-env-removed", "Only the new one.")],
      dimension: "D6",
    },
  ),
  iosTotal(
    "ios-oct-app-storage-limits",
    "D6: Plants' page shows its files folder and database against their limits (2.0 GB of 5.0 GB; 300 MB of 1.0 GB) with no full note.",
    O + "test_appStorageShowsLimits",
    {
      steps: [{ kind: "tap", describe: "Open Plants.", handle: "service-detail-storage" }],
      assertions: [
        { describe: "Files line", handle: "service-detail-storage-files", expect: "present" },
        { describe: "No full note", handle: "service-detail-storage-full", expect: "absent" },
      ],
      screenshots: [shot("app-storage-limits", "Storage against limits.")],
      dimension: "D6",
    },
  ),
  iosTotal(
    "ios-oct-app-storage-full",
    "D6: a full app (Wiki's files folder) says new data is refused until space is freed or the limit raised.",
    O + "test_aFullAppSaysNewDataIsRefused",
    {
      steps: [{ kind: "tap", describe: "Open Wiki.", handle: "service-detail-storage" }],
      assertions: [{ describe: "Full sentence", handle: "service-detail-storage-full", expect: "present" }],
      screenshots: [shot("app-storage-full", "The full sentence.")],
      dimension: "D6",
    },
  ),
  iosTotal(
    "ios-oct-access-alert-not-now",
    "D5: 'Not now' closes the access sheet and leaves the request on the box.",
    O + "test_appAccessAlertNotNowCloses",
    {
      steps: [{ kind: "tap", describe: "Not now.", handle: "access-alert-not-now" }],
      assertions: [{ describe: "Sheet closed", handle: "access-alert-title", expect: "absent" }],
      screenshots: [shot("access-alert-closed", "Home after Not now.")],
      dimension: "D5",
    },
  ),
  iosTotal(
    "ios-oct-access-list-service-page",
    "D6: the service page's Internet access section answers a waiting host; the signed list then allows it.",
    O + "test_serviceAccessPendingAllowFromServicePage",
    {
      steps: [
        { kind: "tap", describe: "Services → Plants → Allow.", handle: "service-detail-access-allow" },
        { kind: "tap", describe: "View the list.", handle: "service-detail-access-view-list" },
        { kind: "assert", describe: "The editor holds the allow rule.", handle: "access-list-editor" },
      ],
      assertions: [{ describe: "List allows the host", handle: "access-list-editor", expect: "present" }],
      screenshots: [shot("service-access-pending", "Waiting hosts."), shot("service-access-allowed", "Answered.")],
      dimension: "D6",
    },
  ),
  iosTotal(
    "ios-oct-access-control-ranks",
    "D3: Access control shows Open to all, Members (4) with ranks, and switching to Members only (confirmed) takes effect (-smoke-access-fixture).",
    O + "test_accessControlModeAndRanks",
    {
      steps: [
        { kind: "tap", describe: "Plants → Access control.", handle: "service-detail-open-access" },
        { kind: "assert", describe: "Ranks listed.", handle: "service-access-members-title" },
        { kind: "tap", describe: "Members only → confirm.", handle: "service-access-restrict-toggle" },
      ],
      assertions: [
        { describe: "Members (4)", handle: "service-access-members-title", expect: "present" },
        { describe: "Members only status", handle: "service-access-mode-status", expect: "present" },
      ],
      screenshots: [shot("access-control-open", "Open to all."), shot("access-control-members-only", "Members only.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-oct-access-control-rank-locked-non-admin",
    "D3: rank picker locked on a non-admin device: Add person shows Member with 'Only an admin device can give a higher rank', ranks are read-only and only its own member invite can be removed (-smoke-access-fixture -smoke-non-admin-device).",
    O + "test_accessControlRankLockedOnNonAdminDevice",
    {
      steps: [
        { kind: "tap", describe: "Plants → Access control.", handle: "service-detail-open-access" },
        { kind: "assert", describe: "Sam's rank is read-only.", handle: "service-access-role-sam-bright-maple--plants" },
        { kind: "tap", describe: "+ Add person.", handle: "service-access-add-person" },
        { kind: "assert", describe: "The locked picker says why.", handle: "service-access-member-only-reason" },
      ],
      assertions: [
        { describe: "Rank locked to Member", handle: "service-access-new-role", expect: "present" },
        { describe: "Why it is locked", handle: "service-access-member-only-reason", expect: "present" },
        { describe: "No remove on an admin's invite", handle: "service-access-remove-priya-bright-maple--plants", expect: "absent" },
      ],
      screenshots: [shot("access-control-non-admin-list", "Read-only ranks."), shot("access-control-rank-locked", "Locked picker.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-oct-access-control-invited-by",
    "D3: members list shows Invited by: this device, the admin's iPad by name (decrypted on the phone), another device for an unnamed one, nothing for old rows; an admin device revokes each in one tap (-smoke-access-fixture).",
    O + "test_accessControlMembersShowInvitedBy",
    {
      steps: [
        { kind: "tap", describe: "Plants → Access control.", handle: "service-detail-open-access" },
        { kind: "assert", describe: "Sam: Invited by this device.", handle: "service-access-invited-by-sam-bright-maple--plants" },
        { kind: "assert", describe: "Priya: Invited by Harry's iPad.", handle: "service-access-invited-by-priya-bright-maple--plants" },
      ],
      assertions: [
        { describe: "Invited by line", handle: "service-access-invited-by-sam-bright-maple--plants", expect: "present" },
        { describe: "One-tap Revoke", handle: "service-access-revoke-sam-bright-maple--plants", expect: "present" },
        { describe: "Old rows show nothing", handle: "service-access-invited-by-jordan-bright-maple--plants", expect: "absent" },
      ],
      screenshots: [shot("access-control-invited-by", "Who invited each member.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-oct-access-control-account-members-admin",
    "D3: Account members lists this device (Admin device · This device), the iPad by its decrypted name, a refused unnamed device and Mum's co-managing account with their ranks; an admin device's rank menu offers Member, Manager, Master and Refuse (no owner), and refusing Mum takes effect (-smoke-access-fixture).",
    O + "test_accessControlAccountMembersAdminRanksAndRefuses",
    {
      steps: [
        { kind: "tap", describe: "Plants → Access control.", handle: "service-detail-open-access" },
        { kind: "assert", describe: "Account members listed.", handle: "service-access-account-members-title" },
        { kind: "tap", describe: "Mum's rank → Refuse.", handle: "service-access-account-rank-0f1e2d3c4b5a69788796a5b4c3d2e1f0" },
      ],
      assertions: [
        { describe: "Account members (4)", handle: "service-access-account-members-title", expect: "present" },
        { describe: "iPad named on the phone", handle: `service-access-account-name-${"1a".repeat(16)}`, expect: "present" },
        { describe: "Refused device shows Refused", handle: `service-access-account-rank-${"2b".repeat(16)}`, expect: "present" },
      ],
      screenshots: [shot("access-control-account-members", "Account members."), shot("access-control-account-refused", "Mum refused.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-oct-access-control-account-members-non-admin",
    "D3: on a non-admin device Account members are read-only (this device shows Manager, 'Device · This device') and the Open to all / Members only toggle is disabled with 'Only an admin device can change who may open it.' (-smoke-access-fixture -smoke-non-admin-device).",
    O + "test_accessControlAccountMembersReadOnlyOnNonAdminDevice",
    {
      steps: [
        { kind: "tap", describe: "Plants → Access control.", handle: "service-detail-open-access" },
        { kind: "assert", describe: "This device's rank is read-only.", handle: `service-access-account-rank-${"d0".repeat(16)}` },
      ],
      assertions: [
        { describe: "Read-only rank", handle: `service-access-account-rank-${"d0".repeat(16)}`, expect: "present" },
        { describe: "Mode is admin-only", handle: "service-access-mode-admin-only", expect: "present" },
      ],
      screenshots: [shot("access-control-account-read-only", "Read-only account members.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-oct-access-control-member-rank-why",
    "D3: a device an admin set to Member gets no '+ Add person / group', only 'Only an admin can let you invite people to this app.', and can't withdraw its own invite (-smoke-access-fixture -smoke-member-rank-device).",
    O + "test_accessControlMemberRankDeviceSaysWhyItCannotInvite",
    {
      steps: [
        { kind: "tap", describe: "Plants → Access control.", handle: "service-detail-open-access" },
        { kind: "assert", describe: "Why it can't invite.", handle: "service-access-invite-why" },
      ],
      assertions: [
        { describe: "Why-line", handle: "service-access-invite-why", expect: "present" },
        { describe: "No + Add person", handle: "service-access-add-person", expect: "absent" },
        { describe: "No withdraw of its own invite", handle: "service-access-remove-sam-bright-maple--plants", expect: "absent" },
      ],
      screenshots: [shot("access-control-member-why", "Why a Member device can't invite.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-oct-access-control-list-scope-locked",
    "D3: without Pro, 'Separate list on each server' is off and disabled with 'Comes with Pro.' (no purchase link in the app) and there is no server picker (-smoke-access-fixture -smoke-list-scope free; feat/marketplace).",
    O + "test_accessControlListScopeLockedWithoutPro",
    {
      steps: [
        { kind: "tap", describe: "Plants → Access control.", handle: "service-detail-open-access" },
        { kind: "assert", describe: "The switch is locked.", handle: "service-access-list-scope-toggle" },
      ],
      assertions: [
        { describe: "Separate-lists switch", handle: "service-access-list-scope-toggle", expect: "present" },
        { describe: "Comes with Pro.", handle: "service-access-list-scope-pro", expect: "present" },
        { describe: "No server picker", handle: "service-access-server-picker", expect: "absent" },
      ],
      screenshots: [shot("access-control-list-scope-locked", "Locked without Pro.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-oct-access-control-list-scope-picker",
    "D3: on Pro an admin device turns on 'Separate list on each server' (confirmed, signed with the admin root); the server picker then lists Home and Office and picking Office loads that server's list (-smoke-access-fixture -smoke-list-scope pro; feat/marketplace).",
    O + "test_accessControlListScopeTurnOnShowsServerPicker",
    {
      steps: [
        { kind: "tap", describe: "Plants → Access control.", handle: "service-detail-open-access" },
        { kind: "tap", describe: "Separate list on each server → confirm.", handle: "service-access-list-scope-toggle" },
        { kind: "tap", describe: "Pick Office.", handle: "service-access-server-picker" },
      ],
      assertions: [
        { describe: "Switch on", handle: "service-access-list-scope-toggle", expect: "present" },
        { describe: "Server picker", handle: "service-access-server-picker", expect: "present" },
        { describe: "No Pro line", handle: "service-access-list-scope-pro", expect: "absent" },
        { describe: "Office's members", handle: "service-access-members-title", expect: "present" },
      ],
      screenshots: [
        shot("access-control-list-scope-off", "Pro: one list."),
        shot("access-control-list-scope-on", "Separate lists + picker."),
        shot("access-control-list-scope-office", "Office's list."),
      ],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-oct-tier-status-separate-lists-warning",
    "D3: Tier & usage on Pro with an app keeping a separate access list on each server warns '1 app has a separate access list on each server. When Pro ends it will use Home's list.' (-smoke-access-fixture -smoke-list-scope separate; feat/marketplace).",
    O + "test_tierStatusWarnsAboutSeparateLists",
    {
      steps: [
        { kind: "tap", describe: "Settings → Tier & usage.", handle: "settings-open-subscription" },
        { kind: "assert", describe: "The warning card.", handle: "tier-status-separate-lists-warning" },
      ],
      assertions: [{ describe: "Separate-lists warning", handle: "tier-status-separate-lists-warning", expect: "present" }],
      screenshots: [shot("tier-status-separate-lists", "Before Pro ends.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-oct-server-order-leader-pending",
    "D1: Make leader on Office's page; until the box confirms, the page and Home show the leader in gray.",
    O + "test_makeLeaderWaitsForTheServerToConfirm",
    {
      steps: [
        { kind: "tap", describe: "Office → Make leader.", handle: "sd-make-leader" },
        { kind: "assert", describe: "Waiting to confirm.", handle: "sd-leader-pending" },
        { kind: "assert", describe: "Gray Leader badge on Home.", handle: "leader-badge-pending" },
      ],
      assertions: [{ describe: "Leader pending until ack", handle: "sd-leader-pending", expect: "present" }],
      screenshots: [shot("server-order-pending", "Waiting."), shot("server-order-home-gray", "Gray badge.")],
      dimension: "D1",
    },
  ),
  iosTotal(
    "ios-oct-flagship-inference-credits",
    "D3: Settings → AI keys lists Flagship Inference first with '1,840 free credits left · 500 added each week'.",
    O + "test_flagshipInferenceCreditsInAiKeys",
    {
      steps: [{ kind: "assert", describe: "Credits line.", handle: "free-ai-status" }],
      assertions: [{ describe: "Credits shown", handle: "free-ai-status", expect: "present" }],
      screenshots: [shot("flagship-inference-credits", "The credits line.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-oct-api-key-create",
    "D6: an app's API keys section lists its keys; creating one shows the secret once.",
    O + "test_apiKeyCreateShowsTheSecretOnce",
    {
      steps: [
        { kind: "tap", describe: "Create a key.", handle: "service-detail-api-keys-create" },
        { kind: "assert", describe: "Secret shown once.", handle: "api-key-secret" },
      ],
      assertions: [{ describe: "Secret + warning", handle: "api-key-shown-once-warning", expect: "present" }],
      screenshots: [shot("api-key-created", "The new key.")],
      dimension: "D6",
    },
  ),
  iosTotal(
    "ios-oct-database-browse",
    "D6: an app's Database opens a table as a paged grid.",
    O + "test_databaseBrowsesATable",
    {
      steps: [
        { kind: "tap", describe: "Open database → plants.", handle: "database-table-plants" },
        { kind: "assert", describe: "Grid.", handle: "database-grid" },
      ],
      assertions: [{ describe: "Grid + page line", handle: "database-page-label", expect: "present" }],
      screenshots: [shot("database-grid", "The grid.")],
      dimension: "D6",
    },
  ),
  iosTotal(
    "ios-oct-runs-on",
    "D1: an app page lists the servers it runs on; a server page lists its apps and offers Create app here.",
    O + "test_runsOnListsServersAndServerPageListsApps",
    {
      steps: [
        { kind: "assert", describe: "Runs on rows.", handle: "runs-on-home.bright-maple.flagship.services" },
        { kind: "assert", describe: "Server's apps.", handle: "server-create-app-here" },
      ],
      assertions: [{ describe: "Create app here", handle: "server-create-app-here", expect: "present" }],
      screenshots: [shot("runs-on", "Runs on."), shot("server-apps", "Server apps.")],
      dimension: "D1",
    },
  ),
  iosTotal(
    "ios-oct-update-card",
    "D1: the server page's update card names the new release and how the last update went.",
    O + "test_updateCardOffersTheNewRelease",
    {
      steps: [{ kind: "assert", describe: "Update card.", handle: "sd-update-available" }],
      assertions: [{ describe: "Last update line", handle: "sd-update-last-outcome", expect: "present" }],
      screenshots: [shot("update-card", "The card.")],
      dimension: "D1",
    },
  ),
  iosTotal(
    "ios-oct-debug-access",
    "D1: an admin device (-smoke-admin-root) turns debug access on with a pasted SSH key for an hour (warning shown, Face ID per grant), the banner shows until when, then turns it off.",
    O + "test_debugAccessOnBannerOff",
    {
      steps: [
        { kind: "tap", describe: "Turn on.", handle: "sd-debug-access-on" },
        { kind: "assert", describe: "The warning.", handle: "sd-debug-access-warning" },
        { kind: "tap", describe: "Paste a key, 1 hour, Turn on.", handle: "sd-debug-access-submit" },
        { kind: "assert", describe: "The banner.", handle: "sd-debug-access-banner" },
        { kind: "tap", describe: "Turn off.", handle: "sd-debug-access-off" },
      ],
      assertions: [{ describe: "Turn on offered again", handle: "sd-debug-access-on", expect: "present" }],
      screenshots: [shot("debug-access-form", "The form."), shot("debug-access-on", "On."), shot("debug-access-off", "Off.")],
      dimension: "D1",
    },
  ),
  iosTotal(
    "ios-oct-debug-access-read-only",
    "D3: a device without the admin root sees debug access read-only.",
    O + "test_debugAccessReadOnlyOnANonAdminDevice",
    {
      steps: [{ kind: "assert", describe: "Admin-only line.", handle: "sd-debug-access-admin-only" }],
      assertions: [{ describe: "No Turn on", handle: "sd-debug-access-on", expect: "absent" }],
      screenshots: [shot("debug-access-read-only", "Read-only.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-oct-offline-server",
    "D5: an offline server's page (Music) says it's offline (not 'Connecting…') and still offers Revoke.",
    O + "test_offlineServerPageSaysOffline",
    {
      steps: [{ kind: "assert", describe: "Offline state.", handle: "server-detail-offline" }],
      assertions: [
        { describe: "Offline copy", handle: "server-detail-offline", expect: "present" },
        { describe: "Revoke still offered", handle: "sd-revoke-server", expect: "present" },
      ],
      screenshots: [shot("server-offline", "The offline page.")],
      dimension: "D5",
    },
  ),
  iosTotal(
    "ios-oct-unrevoke",
    "D1: a revoked server (-smoke-revoked) says so and Un-revoke restores it.",
    O + "test_unrevokeRestoresARevokedServer",
    {
      steps: [
        { kind: "tap", describe: "Garage → Un-revoke.", handle: "sd-unrevoke-server" },
        { kind: "assert", describe: "Revoke offered again.", handle: "sd-revoke-server" },
      ],
      assertions: [{ describe: "Restored", handle: "sd-revoke-server", expect: "present" }],
      screenshots: [shot("revoked", "Revoked."), shot("unrevoked", "Restored.")],
      dimension: "D1",
      destructive: { destructive: true, demoUsername: "smoketest" },
    },
  ),
  iosTotal(
    "ios-oct-share-owner",
    "D3: the owner's Shared with card (-smoke-shares): Alex's code to compare, Sam active; the share sheet offers Can view / Can manage.",
    O + "test_shareServerOwnerSeesSharesAndConfirmsCode",
    {
      steps: [
        { kind: "assert", describe: "Shared with card.", handle: "share-server-card" },
        { kind: "tap", describe: "Share this server.", handle: "share-server-open" },
      ],
      assertions: [{ describe: "Share sheet", handle: "share-create", expect: "present" }],
      screenshots: [shot("share-owner", "The card."), shot("share-sheet", "The sheet.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-oct-share-accept-admin",
    "Only an admin device accepts a co-manage share (docs/share-a-server.md §5.1): an admin device's Accept signs flagship/server-share-accept-admin/v1 with the admin root and seals it with .com's attestation; the mock .com (ShareAcceptMockWorld) takes it only when #12 verifies under the attested root, then the code shows.",
    O + "test_shareAcceptAdminDeviceSignsWithTheAdminRoot",
    {
      steps: [
        { kind: "launch", describe: "A share link on an admin device (-smoke-admin-root)." },
        { kind: "tap", describe: "Accept.", handle: "share-accept" },
      ],
      assertions: [{ describe: "The code to read to the owner", handle: "share-accept-sas", expect: "present" }],
      screenshots: [shot("share-accept-admin-offer", "Accept offered."), shot("share-accept-admin-code", "Accepted.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-oct-share-accept-non-admin",
    "A device without the admin root opening a share link reads 'Only an admin device of your account can accept a co-manage invitation.' and gets no Accept button.",
    O + "test_shareAcceptNonAdminDeviceSeesWhy",
    {
      steps: [{ kind: "launch", describe: "A share link on a non-admin device." }],
      assertions: [
        { describe: "Why", handle: "add-server-admin-only", expect: "text", text: "Only an admin device of your account can accept a co-manage invitation." },
        { describe: "No Accept", handle: "share-accept", expect: "absent" },
      ],
      screenshots: [shot("share-accept-non-admin", "The refusal.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-oct-share-owner-refused",
    "The owner confirms an acceptance an older app sent with no admin proof: the box refuses it (accept-not-admin) and the Shared with card shows the box's own sentence.",
    O + "test_shareOwnerConfirmShowsTheBoxRefusal",
    {
      steps: [{ kind: "tap", describe: "Confirm Riley's code.", handle: "share-confirm-c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3" }],
      assertions: [
        {
          describe: "The box's sentence",
          handle: "share-error",
          expect: "text",
          text: "Only an admin device of their account can accept a co-manage invitation.",
        },
      ],
      screenshots: [shot("share-owner-refused", "The refusal on the card.")],
      dimension: "D4",
    },
  ),
  iosTotal(
    "ios-oct-share-co-manager",
    "D3: a co-manager sees 'Shared with me' on Home and the shared server's page: approve start-up, leave, never delete or revoke.",
    O + "test_sharedServerCoManagerView",
    {
      steps: [
        { kind: "assert", describe: "Shared with me.", handle: "home-shared-with-me" },
        { kind: "assert", describe: "Approve start-up.", handle: "shared-approve-startup" },
      ],
      assertions: [
        { describe: "Approve start-up", handle: "shared-approve-startup", expect: "present" },
        { describe: "No delete", handle: "sd-delete-server", expect: "absent" },
      ],
      screenshots: [shot("shared-with-me", "Home."), shot("shared-server-member", "Shared server.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-oct-share-co-manager-invites",
    "Co-manager invites (docs/service-access-gating.md \"Co-manager invites\"): at Can manage, Plants on the shared server offers Invite people; add a person at Member, the link names the shared server, Your invites lists them, Withdraw asks first and empties the list.",
    O + "test_coManagerInvitesAPersonAndWithdraws",
    {
      steps: [
        { kind: "tap", describe: "Open Plants on the shared server.", handle: "shared-app-bright-maple--plants" },
        { kind: "tap", describe: "Invite people.", handle: "co-invite-open" },
        { kind: "tap", describe: "+ Add person, name them, Create invite link.", handle: "co-invite-create" },
        { kind: "tap", describe: "Withdraw, confirm.", handle: "co-invite-withdraw-confirm" },
      ],
      assertions: [
        { describe: "Member-only line", handle: "co-invite-line", expect: "text", text: "People you invite join as Member. You can withdraw your own invites." },
        { describe: "Link on the shared server", handle: "co-invite-share-url", expect: "present" },
        { describe: "Empty after withdraw", handle: "co-invite-none", expect: "present" },
      ],
      screenshots: [shot("co-invite-created", "The new invite and its link.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-oct-share-co-manager-demoted",
    "Co-manager invites: in Wiki an admin made the co-manager a Member, so the panel shows the box's sentence and their invite (Jo · 1 person joined) without Withdraw or add.",
    O + "test_coManagerDemotedSeesWhyAndNoWithdraw",
    {
      steps: [
        { kind: "tap", describe: "Open Wiki on the shared server.", handle: "shared-app-bright-maple--wiki" },
        { kind: "tap", describe: "Invite people.", handle: "co-invite-open" },
      ],
      assertions: [
        { describe: "The box's sentence", handle: "co-invite-why", expect: "text", text: "An admin made you a Member of this app, so you can't invite people to it." },
        { describe: "No add", handle: "co-invite-add-person", expect: "absent" },
      ],
      screenshots: [shot("co-invite-demoted", "Demoted panel.")],
      dimension: "D3",
    },
  ),
  iosTotal(
    "ios-oct-share-co-manager-view-only",
    "Co-manager invites: a server shared at Can view says why there's no Invite people, and its apps offer none.",
    O + "test_coManagerViewOnlyCantInvite",
    {
      steps: [{ kind: "assert", describe: "View-only line on the Apps card.", handle: "co-invite-view-only" }],
      assertions: [
        { describe: "View-only line", handle: "co-invite-view-only", expect: "text", text: "You can view this server but not manage it, so you can't invite people to its apps." },
        { describe: "No Invite people", handle: "co-invite-open", expect: "absent" },
      ],
      screenshots: [shot("co-invite-view-only", "The view-only line.")],
      dimension: "D3",
    },
  ),
];

/** The iOS/iPad lane of the gym registry (every-merge subset + total tranche). */
export const IOS_GYM_SCENARIOS: readonly Scenario[] = [
  ...EVERY_MERGE,
  ...TOTAL,
  ...IPAD,
  ...TOTAL_DETAIL,
  ...FEATURE_MIRRORS,
  ...OCTOBER,
  ...IOS_SWEEP_SCENARIOS,
  ...IOS_NOTICES,
  ...IOS_GONE,
];
