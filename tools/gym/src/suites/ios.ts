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
    "Home → add-server goes STRAIGHT to the create-server form (name step) — the provision-vs-pair chooser was removed — then advance to the disk-encryption control.",
    "FlagshipAppUITests/GymEveryMergeTests/test_createServerFormReachable",
    {
      steps: [
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab home." },
        { kind: "tap", describe: "Add a server (straight into the create flow, no chooser).", handle: "home-add-server" },
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
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab home on the iPad destination." },
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
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab home on iPad." },
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
    "ios-total-detail-decommission",
    "D1/D5: a dead box's detail offers the decommission (free-the-name) card.",
    "FlagshipAppUITests/GymTotalDetailTests/test_serverDetailDeadServerDecommissionCard",
    {
      steps: [
        { kind: "launch", describe: "Open the dead box (Attic) detail (-smoke-dead)." },
        { kind: "assert", describe: "Decommission card.", handle: "sd-decommission-dead-server" },
      ],
      assertions: [{ describe: "Decommission card present", handle: "sd-decommission-dead-server", expect: "present" }],
      screenshots: [shot("server-detail-decommission", "The decommission card.")],
      dimension: "D1",
    },
  ),
  iosTotal(
    "ios-total-create-server-full-flow",
    "D1-A4: walk the create-server wizard — name → boot-unlock + encryption → backup policy.",
    "FlagshipAppUITests/GymTotalDetailTests/test_createServerFullStepFlow",
    {
      steps: [
        { kind: "tap", describe: "Add server.", handle: "home-add-server" },
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
        { kind: "assert", describe: "The vibe-code chat composer.", handle: "vibecode-reply-field" },
      ],
      assertions: [{ describe: "Vibe-code chat composer present", handle: "vibecode-reply-field", expect: "present" }],
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
        { kind: "tap", describe: "The greyed tier-2 lock-with-passkey.", handle: "settings-sign-out-btn" },
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
        { kind: "tap", describe: "Settings → Account security (currently a no-op — see the skip).", handle: "settings-open-account-security" },
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
        { kind: "launch", describe: "Launch -smoke-mode -smoke-tab home -smoke-locked." },
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

/** The iOS/iPad lane of the gym registry (every-merge subset + total tranche). */
export const IOS_GYM_SCENARIOS: readonly Scenario[] = [
  ...EVERY_MERGE,
  ...TOTAL,
  ...IPAD,
  ...TOTAL_DETAIL,
];
