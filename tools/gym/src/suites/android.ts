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
        { kind: "launch", describe: "Launch with flagship.smokeMode + smokeTab=home + smokeAdminRoot (DemoFixtures seeded; an admin device)." },
        { kind: "assert", describe: "Home's Add/Import a server (admin devices only).", handle: "home-add-server" },
      ],
      assertions: [{ describe: "Seeded Home shell present", handle: "home-add-server", expect: "present" }],
      screenshots: [shot("cold-launch", "After launch."), shot("home-ready", "Home with seeded pods.")],
      dimension: "D1",
    },
  ),
  android(
    "android-connect-account-page",
    "Welcome offers Create your account + one Connect to an existing account; the connect page holds sign-in by account name above an 'or' and the pairing code (scan + paste) below; a name in the code field gets a sentence (flagship.smokeOnboarding).",
    `${PKG}.GymOnboardingTest#connectPageHoldsSignInAndPairing`,
    {
      steps: [
        { kind: "launch", describe: "Launch with flagship.smokeOnboarding (unpaired, mock clients)." },
        { kind: "tap", describe: "Connect to an existing account.", handle: "welcome-connect" },
        { kind: "tap", describe: "Join with an account name typed as the code.", handle: "connect-pair-continue" },
      ],
      assertions: [
        { describe: "Sign-in field", handle: "connect-name-field", expect: "present" },
        { describe: "Scan a code", handle: "connect-scan", expect: "present" },
      ],
      screenshots: [shot("welcome", "Welcome."), shot("connect-account", "The connect page.")],
      dimension: "D1",
    },
  ),
  android(
    "android-lock-footer",
    "The lock screen ends like Welcome: Unlock, Sign out right below, a gap, then Patent Pending above the navigation bar.",
    `${PKG}.GymOnboardingTest#lockScreenSharesTheWelcomeFooter`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=settings." },
        { kind: "tap", describe: "Lock.", handle: "settings-lock-btn" },
      ],
      assertions: [
        { describe: "Unlock", handle: "biometric-unlock-btn", expect: "present" },
        { describe: "Sign out", handle: "lock-sign-out-btn", expect: "present" },
        { describe: "Patent Pending", handle: "patent-pending", expect: "present" },
      ],
      screenshots: [shot("lock-screen", "The lock screen's footer.")],
      dimension: "D7",
    },
  ),
  android(
    "android-connect-link-to-join",
    "A pairing link typed into the account-name field opens the join flow (flagship.smokeOnboarding).",
    `${PKG}.GymOnboardingTest#pairingLinkTypedAsTheNameOpensJoin`,
    {
      steps: [
        { kind: "type", describe: "Paste a /join link as the name.", handle: "connect-name-field" },
        { kind: "tap", describe: "Continue.", handle: "connect-name-continue" },
      ],
      assertions: [{ describe: "Join screen", handle: "join-device", expect: "present" }],
      screenshots: [shot("connect-link-to-join", "The join flow.")],
      dimension: "D1",
    },
  ),
  android(
    "android-add-device-non-admin",
    "Adding a device is admin-only: on a non-admin device Add device is disabled and the sentence 'Only an admin device of this account can add devices.' shows.",
    `${PKG}.GymAddDeviceTest#nonAdminDeviceCannotAddADevice`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=settings (non-admin device)." },
        { kind: "tap", describe: "Trusted devices." },
      ],
      assertions: [{ describe: "Add device", handle: "trusted-devices-add", expect: "present" }],
      screenshots: [shot("add-device-non-admin", "Add device disabled with the sentence.")],
      dimension: "D1",
    },
  ),
  android(
    "android-add-device-admin",
    "An admin device opens the pairing code from Trusted devices > Add device.",
    `${PKG}.GymAddDeviceTest#adminDeviceOpensThePairingCode`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=settings with the admin root." },
        { kind: "tap", describe: "Trusted devices, then Add device.", handle: "trusted-devices-add" },
      ],
      assertions: [{ describe: "Add a device", handle: "add-device", expect: "present" }],
      screenshots: [shot("add-device-admin", "The pairing code.")],
      dimension: "D1",
    },
  ),
  android(
    "android-peer-backup-status",
    "Settings > Peer-backup shows the v2 status: the state, the servers holding the pieces as Server 1..n (never named), the restore-by date and what this server keeps for others.",
    `${PKG}.GymPeerBackupTest#theStatusPageNamesServersNotOwners`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=settings." },
        { kind: "tap", describe: "Peer-backup." },
      ],
      assertions: [
        { describe: "Protected", handle: "peer-backup-state-protected", expect: "present" },
        { describe: "Holders", handle: "peer-backup-holder", expect: "present" },
        { describe: "Restore by", handle: "peer-backup-restore-by", expect: "present" },
      ],
      screenshots: [shot("peer-backup-status", "The peer backup status.")],
      dimension: "D1",
    },
  ),
  android(
    "android-restore-from-peers-find",
    "Add/Import a server > Restore from other servers: the lost server's record is read, opened with this account's key and summarised; a missing record gets a sentence.",
    `${PKG}.GymPeerBackupTest#restoreFromOtherServersFindsAndOpensTheRecord`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=home with the admin root." },
        { kind: "tap", describe: "Add/Import a server, then Restore from other servers.", handle: "home-restore-peers" },
        { kind: "type", describe: "The lost server's address.", handle: "restore-peers-lost" },
        { kind: "tap", describe: "Find its backup.", handle: "restore-peers-find" },
      ],
      assertions: [{ describe: "Name step", handle: "import-backup-name", expect: "present" }],
      screenshots: [shot("restore-peers-found", "The record found.")],
      dimension: "D1",
    },
  ),
  android(
    "android-restore-from-peers-not-found",
    "A lost server with no peer backup record gets the box's sentence and the picker stays.",
    `${PKG}.GymPeerBackupTest#aMissingRecordSaysSo`,
    {
      steps: [{ kind: "tap", describe: "Find its backup for a server with no record.", handle: "restore-peers-find" }],
      assertions: [{ describe: "Error", handle: "import-backup-error", expect: "present" }],
      screenshots: [shot("restore-peers-not-found", "The sentence.")],
      dimension: "D1",
    },
  ),
  android(
    "android-restore-from-peers-waiting-server",
    "A server waiting for this backup fetches the pieces from other servers (nothing is uploaded from the phone), the phone commits the key and the apps restore.",
    `${PKG}.GymPeerBackupTest#aWaitingServerFetchesThePiecesAndRestores`,
    {
      steps: [
        { kind: "launch", describe: "Launch with the awaiting-backup server." },
        { kind: "tap", describe: "Send it to the waiting server.", handle: "import-backup-send-existing" },
      ],
      assertions: [{ describe: "Restored", handle: "import-backup-restored", expect: "present" }],
      screenshots: [shot("restore-peers-done", "The restore result.")],
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
    "The Settings tab renders its shell + the session-tiers cluster (account-security row + the tier-2 Sign out).",
    `${PKG}.GymEveryMergeTest#settingsTabRenders`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=settings." },
        { kind: "assert", describe: "Account-security row.", handle: "settings-open-account-security" },
        { kind: "assert", describe: "Tier-2 Sign out row.", handle: "settings-sign-out-btn" },
      ],
      assertions: [
        { describe: "Account-security row present", handle: "settings-open-account-security", expect: "present" },
        { describe: "Sign out present", handle: "settings-sign-out-btn", expect: "present" },
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
    "Home → Add/Import a server → Create a new server opens the create-server form (name field + disk-encryption control).",
    `${PKG}.GymEveryMergeTest#createServerFormReachable`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=home + smokeAdminRoot (an admin device)." },
        { kind: "tap", describe: "Add/Import a server.", handle: "home-add-server" },
        { kind: "tap", describe: "Create a new server.", handle: "home-add-new-server" },
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
    "android-home-non-admin",
    "A device without the account's admin root (not an admin device): Home lists the servers with no Add/Import a server and so no menu (docs/service-access-gating.md 'Account members').",
    `${PKG}.GymEveryMergeTest#nonAdminHomeHasNoAddServer`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=home without smokeAdminRoot." },
        { kind: "assert", describe: "The server list drew.", handle: "Search servers" },
      ],
      assertions: [
        { describe: "No Add/Import a server", handle: "home-add-server", expect: "absent" },
        { describe: "No menu", handle: "home-add-new-server", expect: "absent" },
      ],
      screenshots: [shot("home-non-admin", "Home on a non-admin device.")],
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
  androidTotal(
    "android-total-build-mcp-ide-configs",
    "Connect your IDE shows each IDE's own config: Claude Code with its claude mcp add --scope user command, Cursor, VS Code (servers) and Cline (streamableHttp), each saying where it goes, and says to keep it in the IDE's user settings.",
    `${PKG}.GymTotalTest#buildMcpIdeConfigs`,
    {
      steps: [
        { kind: "tap", describe: "Create a connection.", handle: "build-mcp-create" },
        { kind: "tap", describe: "VS Code.", handle: "build-mcp-ide-vscode" },
        { kind: "tap", describe: "Cline.", handle: "build-mcp-ide-cline" },
      ],
      assertions: [
        { describe: "IDE picker", handle: "build-mcp-ide-picker", expect: "present" },
        { describe: "User-settings warning", handle: "build-mcp-user-settings", expect: "present" },
      ],
      screenshots: [shot("build-mcp-ide-claude-code", "Claude Code."), shot("build-mcp-ide-cline", "Cline.")],
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

// ──── total-gym Tier-1: webapp feature-tranche mirrors (GymFeatureMirrorTest) ────
// Android twins of web-total-transfer-offer / -box-inbox / -pod-switcher /
// -cs-advanced-toggles / -admin-root-state / -rotate-admin-ceremony. The
// Slice-D admin surfaces ride the new `flagship.smokeAdminRoot` extra
// (GymSeams.forceAdminRoot). NOT mirrored on Android:
//   - web-total-transfer-claim — deep-link/QR-only entry on mobile; verify
//     needs a REAL signed offer (a signed-offer fixture seam is
//     disproportionate for a render assert);
//   - web-total-promote-admin-toggle — the toggle renders only at ConfirmSas,
//     which needs a scripted peer hello the in-composable
//     MockDevicePairingRelay can't provide from instrumentation (iOS mirrors
//     it — its promote card renders pre-peer).

const FEATURE_MIRRORS: readonly Scenario[] = [
  androidTotal(
    "android-total-transfer-offer-entry",
    "D1 (transfer-a-box, giver): server-detail's transfer entry opens the giver ceremony — the type-the-FQDN confirm field + the danger CTA (confirm stage only; nothing signed).",
    `${PKG}.GymFeatureMirrorTest#transferOfferEntryOpensCeremony`,
    {
      steps: [
        { kind: "launch", describe: "Open the Home pod's detail (tap its description row)." },
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
  androidTotal(
    "android-total-box-inbox-approve",
    "D5 (box-request inbox): a box awaiting boot-unlock (smokePods=awaiting-unlock) surfaces the one-tap Approve/Deny card on its detail (never fired).",
    `${PKG}.GymFeatureMirrorTest#boxInboxApproveCard`,
    {
      steps: [
        { kind: "launch", describe: "Open the waiting box (Cabin) detail (smokePods=awaiting-unlock)." },
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
  androidTotal(
    "android-total-pod-switcher",
    "D5 (multi-pod): the Services tab renders the PodSwitcher (3 seeded pods); opening it lists the per-pod items.",
    `${PKG}.GymFeatureMirrorTest#podSwitcherOpensMenu`,
    {
      steps: [
        { kind: "launch", describe: "Launch smokeTab=apps." },
        { kind: "tap", describe: "The pod switcher.", handle: "pod-switcher" },
        { kind: "assert", describe: "Per-pod items listed.", handle: "pod-switcher-item-*" },
      ],
      assertions: [
        { describe: "Switcher present", handle: "pod-switcher", expect: "present" },
        { describe: "Pod items listed", handle: "pod-switcher-item-*", expect: "present" },
      ],
      screenshots: [shot("pod-switcher", "The switcher."), shot("pod-switcher-menu", "The open menu.")],
      dimension: "D5",
    },
  ),
  androidTotal(
    "android-total-cs-advanced-toggles",
    "D4 (one-shot pairing security choices): the create-server Advanced section — default OFF, children hidden; open → embed-secrets + debug-friendly default OFF; closing RESETS an armed debug-friendly.",
    `${PKG}.GymFeatureMirrorTest#createServerAdvancedTogglesResetRule`,
    {
      steps: [
        { kind: "launch", describe: "Home → add-server (single-page form)." },
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
  androidTotal(
    "android-total-admin-root-state",
    "D3 (Slice D §5): Account security reports THIS device's admin standing — non-admin (demo default) shows NO rotate card; smokeAdminRoot renders the Admin-key card + Rotate.",
    `${PKG}.GymFeatureMirrorTest#adminRootStateGatesRotateCard`,
    {
      steps: [
        { kind: "launch", describe: "Settings → Account security (no admin seed)." },
        { kind: "assert", describe: "No rotate control.", handle: "admin-root-rotate-btn" },
        { kind: "launch", describe: "Relaunch with smokeAdminRoot." },
        { kind: "assert", describe: "Rotate control present.", handle: "admin-root-rotate-btn" },
      ],
      assertions: [
        { describe: "Rotate absent on a non-admin device", handle: "admin-root-rotate-btn", expect: "absent" },
        { describe: "Rotate present on an admin device", handle: "admin-root-rotate-btn", expect: "present" },
      ],
      screenshots: [shot("admin-root-non-admin", "The non-admin state."), shot("admin-root-admin", "The admin card with Rotate.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-total-rotate-admin-ceremony",
    "D4 (Slice D §5): Rotate admin key opens its warning dialog (revoke semantic + typed-ROTATE gate); Cancel rotates nothing.",
    `${PKG}.GymFeatureMirrorTest#rotateAdminCeremonyFirstScreen`,
    {
      steps: [
        { kind: "launch", describe: "Account security as an admin device (smokeAdminRoot)." },
        { kind: "tap", describe: "Rotate admin key.", handle: "admin-root-rotate-btn" },
        { kind: "assert", describe: "The warning dialog + typed-ROTATE field.", handle: "admin-root-rotate-confirm-field" },
        { kind: "tap", describe: "Cancel — nothing rotated." },
      ],
      assertions: [
        { describe: "Warning ceremony opens", handle: "admin-root-rotate-confirm-field", expect: "present" },
        { describe: "No rotation after Cancel", handle: "admin-root-rotate-done", expect: "absent" },
      ],
      screenshots: [shot("rotate-admin-ceremony", "The warning dialog."), shot("rotate-admin-cancelled", "Intact after Cancel.")],
      dimension: "D4",
    },
  ),
];

/** The Android lane of the gym registry (every-merge subset + total tranche). */
// ───── total-gym Tier-1: the October 2026 features (GymOctoberTest) ─────
// Twins of the iOS GymOctoberTests rows; same handles where the surfaces agree.

const O = `${PKG}.GymOctoberTest#`;

const OCTOBER: readonly Scenario[] = [
  androidTotal(
    "android-oct-service-env",
    "D6: Configure environment on Plants: a name the box can't take is refused in the dialog; saving PLANT_TOKEN keeps WEATHER_API_KEY; removing WEATHER_API_KEY leaves PLANT_TOKEN. Each is one signed service-env-change the mock box checks (app, op, value hash, nonce spent once).",
    O + "serviceEnvSetsAndRemovesOneVariable",
    {
      steps: [
        { kind: "tap", describe: "Plants → Configure environment.", handle: "service-detail-env-row" },
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
  androidTotal(
    "android-oct-access-list-service-page",
    "D6: Plants' Internet access section answers a waiting host; the request leaves the page.",
    O + "serviceAccessPendingAllow",
    {
      steps: [{ kind: "tap", describe: "Services → Plants → Allow.", handle: "service-detail-access-allow" }],
      assertions: [{ describe: "One fewer waiting host", handle: "service-detail-access-allow", expect: "present" }],
      screenshots: [shot("service-access-pending", "Waiting."), shot("service-access-allowed", "Answered.")],
      dimension: "D6",
    },
  ),
  androidTotal(
    "android-oct-access-control-members-only",
    "D3: Access control starts Open to all with Members (n); Members only (confirmed) takes effect.",
    O + "accessControlSwitchesToMembersOnly",
    {
      steps: [
        { kind: "tap", describe: "Plants → Access control.", handle: "service-detail-access-row" },
        { kind: "tap", describe: "Members only → confirm.", handle: "service-access-members-only-confirm" },
      ],
      assertions: [{ describe: "Members only status", handle: "service-access-mode-status", expect: "present" }],
      screenshots: [shot("access-control-open", "Open."), shot("access-control-members-only", "Members only.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-oct-access-rank-locked-non-admin",
    "D3: rank picker locked on a non-admin device: Add person keeps the rank at Member with 'Only an admin device can give a higher rank'.",
    O + "rankPickerLockedOnANonAdminDevice",
    {
      steps: [
        { kind: "tap", describe: "Plants → Access control → + Add person.", handle: "service-access-add-person" },
        { kind: "assert", describe: "The locked rank and its reason.", handle: "service-access-rank-locked" },
      ],
      assertions: [
        { describe: "Why the rank is locked", handle: "service-access-rank-locked", expect: "present" },
        { describe: "Rank picker (disabled, Member)", handle: "service-access-new-role", expect: "present" },
      ],
      screenshots: [shot("access-rank-locked", "Member only.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-oct-access-invited-by",
    "D3: members list shows Invited by: an invite created on this device lists the device that made it.",
    O + "membersListShowsInvitedBy",
    {
      steps: [
        { kind: "tap", describe: "Plants → Access control → + Add person.", handle: "service-access-add-person" },
        { kind: "tap", describe: "Name them → Create invite link.", handle: "service-access-create-invite" },
        { kind: "assert", describe: "The row's Invited by line.", handle: "service-access-invited-by-*" },
      ],
      assertions: [{ describe: "Invited by line", handle: "service-access-invited-by-*", expect: "present" }],
      screenshots: [shot("access-invited-by", "Invited by.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-oct-access-account-members-admin",
    "D3: Account members on an admin device: this account's devices (names from the directory) and the co-managing family, each with a rank menu that also offers Refuse; refusing a device shows it Refused.",
    O + "accountMembersAdminRanksAndRefuses",
    {
      steps: [
        { kind: "launch", describe: "Plants → Access control as an admin device (smokeAdminRoot)." },
        { kind: "assert", describe: "The Account members section.", handle: "service-access-account-members-title" },
        { kind: "tap", describe: "Kitchen iPad's rank → Refuse.", handle: "service-access-account-rank-device-*" },
      ],
      assertions: [
        { describe: "Account members section", handle: "service-access-account-members-title", expect: "present" },
        { describe: "Refuse in the rank menu", handle: "service-access-account-rank-device-*-refuse", expect: "present" },
      ],
      screenshots: [
        shot("access-account-members-admin", "Account members, admin."),
        shot("access-account-rank-menu", "Rank menu with Refuse."),
        shot("access-account-refused", "Refused."),
      ],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-oct-access-account-members-manager",
    "D3: a non-admin device at Manager sees the account members' ranks read-only and the mode as admin-only, and keeps + Add person (at Member).",
    O + "accountMembersNonAdminManagerInvitesAtMember",
    {
      steps: [
        { kind: "launch", describe: "Plants → Access control as a non-admin device (default rank Manager)." },
        { kind: "assert", describe: "Ranks read-only, + Add present.", handle: "service-access-add-person" },
      ],
      assertions: [
        { describe: "+ Add person", handle: "service-access-add-person", expect: "present" },
        { describe: "Mode is admin-only", handle: "service-access-mode-admin-only", expect: "present" },
        { describe: "No why-line", handle: "service-access-cant-invite", expect: "absent" },
      ],
      screenshots: [shot("access-account-members-manager", "Manager, non-admin.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-oct-access-account-members-member",
    "D3: a non-admin device at Member gets no + Add, only 'Only an admin can let you invite people to this app.'",
    O + "accountMembersMemberRankSeesWhy",
    {
      steps: [
        { kind: "launch", describe: "Plants → Access control as a non-admin device at Member (smokeDeviceRank=member)." },
        { kind: "assert", describe: "The why-line instead of + Add.", handle: "service-access-cant-invite" },
      ],
      assertions: [
        { describe: "Why it can't invite", handle: "service-access-cant-invite", expect: "present" },
        { describe: "+ Add person", handle: "service-access-add-person", expect: "absent" },
      ],
      screenshots: [shot("access-account-members-member", "Member rank.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-oct-api-key-create",
    "D6: Plants' API keys list its key; creating one shows the secret.",
    O + "apiKeyCreateShowsTheSecretOnce",
    {
      steps: [
        { kind: "tap", describe: "Create key.", handle: "service-detail-api-keys-create" },
        { kind: "assert", describe: "The secret.", handle: "api-key-created-value" },
      ],
      assertions: [{ describe: "Secret shown", handle: "api-key-created-value", expect: "present" }],
      screenshots: [shot("api-key-created", "The new key.")],
      dimension: "D6",
    },
  ),
  androidTotal(
    "android-oct-debug-access",
    "D1: an admin device turns debug access on with a pasted SSH key (warning shown, a biometric per grant), the banner shows until when, then turns it off.",
    O + "debugAccessOnBannerOff",
    {
      steps: [
        { kind: "tap", describe: "Turn on.", handle: "sd-debug-access-open" },
        { kind: "tap", describe: "Paste a key, Turn on.", handle: "sd-debug-access-submit" },
        { kind: "assert", describe: "The banner.", handle: "sd-debug-access-banner" },
        { kind: "tap", describe: "Turn off.", handle: "sd-debug-access-off" },
      ],
      assertions: [{ describe: "Banner gone", handle: "sd-debug-access-banner", expect: "absent" }],
      screenshots: [shot("debug-access-form", "The form."), shot("debug-access-on", "On."), shot("debug-access-off", "Off.")],
      dimension: "D1",
    },
  ),
  androidTotal(
    "android-oct-debug-access-read-only",
    "D3: a device without the admin root sees debug access read-only.",
    O + "debugAccessReadOnlyOnANonAdminDevice",
    {
      steps: [{ kind: "assert", describe: "Admin-only line.", handle: "sd-debug-access-admin-only" }],
      assertions: [{ describe: "No Turn on", handle: "sd-debug-access-open", expect: "absent" }],
      screenshots: [shot("debug-access-read-only", "Read-only.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-backups-approve",
    "D1: an admin device with no backups yet approves once and the box has its keys.",
    `${PKG}.GymBackupsTest#anAdminDeviceApprovesTheKeysOnce`,
    {
      steps: [
        { kind: "tap", describe: "Approve backups for this server.", handle: "sd-backups-approve" },
      ],
      assertions: [
        { describe: "Next backup shown", handle: "sd-backups-next", expect: "present" },
      ],
      screenshots: [shot("backups-approve", "Backups approve."), shot("backups-keys-deposited", "Backups keys deposited.")],
      dimension: "D1",
    },
  ),
  androidTotal(
    "android-backups-non-admin",
    "D3: a non-admin device sees the box's reason and every backup order disabled.",
    `${PKG}.GymBackupsTest#aNonAdminDeviceSeesTheBoxsReason`,
    {
      steps: [
        { kind: "assert", describe: "Why backups wait.", handle: "sd-backups-waiting" },
      ],
      assertions: [
        { describe: "Admin-only line", handle: "sd-backups-admin-only", expect: "present" },
      ],
      screenshots: [shot("backups-non-admin", "Backups non admin.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-backups-run",
    "D1: Back up now shows progress, then the new backup heads the list.",
    `${PKG}.GymBackupsTest#backUpNowShowsProgressThenLists`,
    {
      steps: [
        { kind: "tap", describe: "Back up now.", handle: "sd-backups-run" },
      ],
      assertions: [
        { describe: "Status line", handle: "sd-backups-status", expect: "present" },
      ],
      screenshots: [shot("backups-running", "Backups running."), shot("backups-listed", "Backups listed.")],
      dimension: "D1",
    },
  ),
  androidTotal(
    "android-backups-failed",
    "D5: a failed run says why in the box's words.",
    `${PKG}.GymBackupsTest#aFailedRunSaysWhyInTheBoxsWords`,
    {
      steps: [
        { kind: "assert", describe: "The red line.", handle: "sd-backups-failed" },
      ],
      assertions: [
        { describe: "Failed line", handle: "sd-backups-failed", expect: "present" },
      ],
      screenshots: [shot("backups-failed", "Backups failed.")],
      dimension: "D5",
    },
  ),
  androidTotal(
    "android-backups-schedule",
    "D1: a weekly schedule at a local time is sent in UTC.",
    `${PKG}.GymBackupsTest#weeklyAtALocalTimeIsSentInUtc`,
    {
      steps: [
        { kind: "tap", describe: "Change the schedule.", handle: "sd-backups-schedule-change" },
        { kind: "tap", describe: "Weekly, save.", handle: "sd-backups-schedule-save" },
      ],
      assertions: [
        { describe: "Schedule line", handle: "sd-backups-schedule", expect: "present" },
      ],
      screenshots: [shot("backups-schedule-editor", "Backups schedule editor."), shot("backups-schedule-weekly", "Backups schedule weekly.")],
      dimension: "D1",
    },
  ),
  androidTotal(
    "android-backups-download-delete",
    "D1: Download saves one file; Delete asks first.",
    `${PKG}.GymBackupsTest#downloadOneFileAndDeleteOne`,
    {
      steps: [
        { kind: "tap", describe: "Download.", handle: "sd-backups-delete-confirm" },
      ],
      assertions: [
        { describe: "Status line", handle: "sd-backups-status", expect: "present" },
      ],
      screenshots: [shot("backups-downloaded", "Backups downloaded."), shot("backups-delete-confirm", "Backups delete confirm.")],
      dimension: "D1",
    },
  ),
  androidTotal(
    "android-backups-wizard-policy",
    "D1: the create wizard offers the three policies with a reserve.",
    `${PKG}.GymBackupsTest#theWizardOffersTheThreePoliciesWithAReserve`,
    {
      steps: [
        { kind: "tap", describe: "Next.", handle: "cs-next-button" },
      ],
      assertions: [
        { describe: "Phone policy", handle: "cs-backup-policy-phone", expect: "present" },
      ],
      screenshots: [shot("wizard-backup-policy", "Wizard backup policy."), shot("wizard-backup-policy-peer", "Wizard backup policy peer.")],
      dimension: "D1",
    },
  ),
  androidTotal(
    "android-backups-policy-change",
    "D5: the policy changes to peer, and a reserve smaller than the apps' data is refused in the box's words.",
    `${PKG}.GymBackupsTest#thePolicyChangesAndRefusalsAreTheBoxs`,
    {
      steps: [
        { kind: "tap", describe: "Change policy.", handle: "sd-backups-policy-change" },
        { kind: "tap", describe: "Save.", handle: "sd-backups-policy-save" },
      ],
      assertions: [
        { describe: "Refusal sentence", handle: "sd-backups-policy-error", expect: "present" },
      ],
      screenshots: [shot("backups-policy-peer", "Backups policy peer."), shot("backups-policy-refused", "Backups policy refused.")],
      dimension: "D5",
    },
  ),
  androidTotal(
    "android-backups-over-limit",
    "D5: over the limit shows the box's reason in red.",
    `${PKG}.GymBackupsTest#overTheLimitShowsTheBoxsReasonInRed`,
    {
      steps: [
        { kind: "assert", describe: "The reason.", handle: "sd-backups-over" },
      ],
      assertions: [
        { describe: "Over-limit line", handle: "sd-backups-over", expect: "present" },
      ],
      screenshots: [shot("backups-over-limit", "Backups over limit.")],
      dimension: "D5",
    },
  ),
  androidTotal(
    "android-backups-policy-unset",
    "D1: an unchosen policy asks to choose.",
    `${PKG}.GymBackupsTest#anUnchosenPolicyAsksToChoose`,
    {
      steps: [
        { kind: "tap", describe: "Choose.", handle: "sd-backups-policy-change" },
        { kind: "tap", describe: "Save.", handle: "sd-backups-policy-save" },
      ],
      assertions: [
        { describe: "Policy line", handle: "sd-backups-policy", expect: "present" },
      ],
      screenshots: [shot("backups-policy-chosen", "Backups policy chosen.")],
      dimension: "D1",
    },
  ),
  androidTotal(
    "android-backups-app-full",
    "D5: a full app is named on the Backups section.",
    `${PKG}.GymBackupsTest#aFullAppIsNamedOnTheBackupsSection`,
    {
      steps: [
        { kind: "assert", describe: "The full app.", handle: "sd-backups-storage-0" },
      ],
      assertions: [
        { describe: "Full-app note", handle: "sd-backups-storage-0", expect: "present" },
      ],
      screenshots: [shot("backups-app-full", "Backups app full.")],
      dimension: "D5",
    },
  ),
  androidTotal(
    "android-backups-import-one-file",
    "D1: Import a backup takes one file, asks for the passcode and shows where it is from.",
    `${PKG}.GymBackupsTest#importOneFile`,
    {
      steps: [
        { kind: "tap", describe: "Choose the backup file.", handle: "import-backup-choose" },
        { kind: "tap", describe: "Open.", handle: "import-backup-unlock" },
      ],
      assertions: [
        { describe: "Name step", handle: "import-backup-name", expect: "present" },
      ],
      screenshots: [shot("import-one-file", "Import one file.")],
      dimension: "D1",
    },
  ),
  androidTotal(
    "android-backups-import-damaged",
    "D5: a cut-short or foreign file is refused with a sentence.",
    `${PKG}.GymBackupsTest#aDamagedFileIsRefusedWithASentence`,
    {
      steps: [
        { kind: "tap", describe: "Choose the backup file.", handle: "import-backup-choose" },
      ],
      assertions: [
        { describe: "Error sentence", handle: "import-backup-error", expect: "present" },
      ],
      screenshots: [shot("import-damaged", "Import damaged.")],
      dimension: "D5",
    },
  ),
  androidTotal(
    "android-backups-restore-partial",
    "D5: a restore that gives up on one app ends and names it.",
    `${PKG}.GymBackupsTest#aRestoreWithAFailedAppEndsAndNamesIt`,
    {
      steps: [
        { kind: "tap", describe: "Send the backup.", handle: "import-backup-send-existing" },
      ],
      assertions: [
        { describe: "Restored line", handle: "import-backup-restored", expect: "present" },
        { describe: "Failed app named", handle: "import-backup-failed-app", expect: "present" },
      ],
      screenshots: [shot("restore-partial", "Restore partial.")],
      dimension: "D5",
    },
  ),
  androidTotal(
    "android-oct-app-storage",
    "D6: Plants shows its files folder and database against their limits.",
    O + "appStorageShowsLimits",
    {
      steps: [
        { kind: "assert", describe: "The storage card.", handle: "service-detail-storage" },
      ],
      assertions: [
        { describe: "Files line", handle: "service-detail-storage-files", expect: "present" },
      ],
      screenshots: [shot("app-storage-limits", "App storage limits.")],
      dimension: "D6",
    },
  ),
  androidTotal(
    "android-oct-app-storage-full",
    "D5: a full app says new data is refused.",
    O + "aFullAppSaysNewDataIsRefused",
    {
      steps: [
        { kind: "assert", describe: "The full sentence.", handle: "service-detail-storage-full" },
      ],
      assertions: [
        { describe: "Full sentence", handle: "service-detail-storage-full", expect: "present" },
      ],
      screenshots: [shot("app-storage-full", "App storage full.")],
      dimension: "D5",
    },
  ),
  androidTotal(
    "android-oct-database-browse",
    "D6: Plants' Database opens a table with its row range.",
    O + "databaseBrowsesATable",
    {
      steps: [{ kind: "tap", describe: "Database → a table.", handle: "db-table-row" }],
      assertions: [{ describe: "Row range", handle: "db-range", expect: "present" }],
      screenshots: [shot("database-grid", "The table.")],
      dimension: "D6",
    },
  ),
  androidTotal(
    "android-oct-runs-on",
    "D1: Plants' page lists the servers it runs on.",
    O + "runsOnListsTheServers",
    {
      steps: [{ kind: "assert", describe: "Runs-on toggles.", handle: "runs-on-toggle-" }],
      assertions: [{ describe: "Two or more servers", handle: "runs-on-toggle-", expect: "present" }],
      screenshots: [shot("runs-on", "Runs on.")],
      dimension: "D1",
    },
  ),
  androidTotal(
    "android-oct-server-apps",
    "D1: a server's page lists its apps and offers Create app here.",
    O + "serverPageListsItsApps",
    {
      steps: [{ kind: "assert", describe: "Create app here.", handle: "server-create-app-here" }],
      assertions: [{ describe: "Create app here", handle: "server-create-app-here", expect: "present" }],
      screenshots: [shot("server-apps", "Server apps.")],
      dimension: "D1",
    },
  ),
  androidTotal(
    "android-oct-server-order-leader-pending",
    "D1: Make leader on Office's page; until the box confirms, the page and Home show the leader in gray.",
    O + "makeLeaderWaitsForTheServerToConfirm",
    {
      steps: [
        { kind: "tap", describe: "Office → Make leader.", handle: "sd-make-leader" },
        { kind: "assert", describe: "Waiting to confirm.", handle: "sd-leader-pending" },
        { kind: "assert", describe: "Gray Leader badge on Home.", handle: "leader-badge-pending" },
      ],
      assertions: [
        { describe: "Leader pending until ack", handle: "sd-leader-pending", expect: "present" },
        { describe: "Gray badge on Home", handle: "leader-badge-pending", expect: "present" },
        { describe: "No confirmed badge yet", handle: "leader-badge", expect: "absent" },
      ],
      screenshots: [
        shot("server-order-card", "The card."),
        shot("server-order-pending", "Waiting."),
        shot("server-order-home-gray", "Gray badge."),
      ],
      dimension: "D1",
    },
  ),
  androidTotal(
    "android-oct-offline-server",
    "D5: an offline server's page (Music) says it's offline, not 'Connecting…' or 'never came online'.",
    O + "offlineServerPageSaysOffline",
    {
      steps: [{ kind: "assert", describe: "Offline state.", handle: "server-detail-offline" }],
      assertions: [{ describe: "Offline copy", handle: "server-detail-offline", expect: "present" }],
      screenshots: [shot("server-offline", "The offline page.")],
      dimension: "D5",
    },
  ),
  androidTotal(
    "android-oct-update-card",
    "D1: the server page's update card names the new release and the last update.",
    O + "updateCardOffersTheNewRelease",
    {
      steps: [{ kind: "assert", describe: "Update card.", handle: "sd-update-available" }],
      assertions: [{ describe: "Last update line", handle: "sd-update-last-outcome", expect: "present" }],
      screenshots: [shot("update-card", "The card.")],
      dimension: "D1",
    },
  ),
  androidTotal(
    "android-oct-flagship-inference-credits",
    "D3: Settings → AI keys lists Flagship Inference with '1,840 free credits left · 500 added each week' (mock .com).",
    O + "flagshipInferenceListedInAiKeys",
    {
      steps: [{ kind: "assert", describe: "Flagship Inference card.", handle: "free-ai-card" }],
      assertions: [{ describe: "Credits line", handle: "free-ai-card", expect: "present" }],
      screenshots: [shot("flagship-inference-credits", "The credits line.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-oct-access-alert-answer",
    "D5: the app-wide '<App> wants to reach <host>' dialog (flagship.smokeAccessAlert): Allow then Deny sign the list and confirm; then nothing covers Home.",
    O + "appAccessAlertAllowThenDeny",
    {
      steps: [
        { kind: "assert", describe: "The dialog asks.", handle: "access-alert-title" },
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
  androidTotal(
    "android-oct-access-alert-not-now",
    "D5: 'Not now' closes the access dialog and leaves the request on the box.",
    O + "appAccessAlertNotNowCloses",
    {
      steps: [{ kind: "tap", describe: "Not now.", handle: "access-alert-not-now" }],
      assertions: [{ describe: "Dialog closed", handle: "access-alert-title", expect: "absent" }],
      screenshots: [shot("access-alert-closed", "Home after Not now.")],
      dimension: "D5",
    },
  ),
  androidTotal(
    "android-oct-share-owner",
    "D3: the owner's Shared with card (flagship.smokeShares, an in-memory share world): Alex's code to compare and confirm, Sam active; the share sheet walks to a link.",
    O + "shareServerOwnerSeesSharesAndConfirmsCode",
    {
      steps: [
        { kind: "assert", describe: "Shared with card.", handle: "share-server-card" },
        { kind: "tap", describe: "Confirm Alex's code.", handle: "share-confirm" },
        { kind: "tap", describe: "Share this server.", handle: "share-server-open" },
        { kind: "tap", describe: "Can manage → Create link.", handle: "share-create" },
      ],
      assertions: [{ describe: "Share link", handle: "share-link", expect: "present" }],
      screenshots: [shot("share-owner", "The card."), shot("share-sheet", "The sheet."), shot("share-link", "The link.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-oct-share-accept-non-admin",
    "D4: only an admin device of the account accepts a co-manage share (the shared server checks the admin root's signature): on a non-admin device a share link reads 'Only an admin device of your account can accept a co-manage invitation.' with no Accept.",
    O + "shareLinkOnANonAdminDeviceShowsTheSentence",
    {
      steps: [{ kind: "launch", describe: "Open Mina's Studio share link on a non-admin device." }],
      assertions: [
        { describe: "The sentence", handle: "add-server-admin-only", expect: "present" },
        { describe: "No Accept", handle: "share-accept-button", expect: "absent" },
      ],
      screenshots: [shot("share-accept-non-admin", "The refusal.")],
      dimension: "D4",
    },
  ),
  androidTotal(
    "android-oct-share-accept-admin",
    "D3: an admin device accepts a share link: it signs flagship/server-share-accept-admin/v1 with the admin root and seals it with .com's attestation (the mock .com refuses the acceptance otherwise), then shows the code to read to the owner.",
    O + "shareLinkOnAnAdminDeviceSignsTheAcceptance",
    {
      steps: [
        { kind: "launch", describe: "Open Mina's Studio share link on an admin device." },
        { kind: "tap", describe: "Accept.", handle: "share-accept-button" },
      ],
      assertions: [{ describe: "The code", handle: "share-accept-sas", expect: "present" }],
      screenshots: [shot("share-accept-offer", "The offer."), shot("share-accept-code", "The code.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-oct-share-co-manager",
    "D3: a co-manager sees 'Shared with me' on Home and the shared server's page: approve start-up, leave, never delete or revoke.",
    O + "sharedServerCoManagerView",
    {
      steps: [
        { kind: "assert", describe: "Shared with me.", handle: "home-shared-with-me" },
        { kind: "tap", describe: "Approve start-up.", handle: "shared-approve-startup" },
      ],
      assertions: [
        { describe: "Leave offered", handle: "shared-leave", expect: "present" },
        { describe: "No delete", handle: "sd-delete-server", expect: "absent" },
      ],
      screenshots: [shot("shared-with-me", "Home."), shot("shared-server-member", "Shared server.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-oct-watch-quick-approve",
    "D3: Settings → Account security → 'Quick approve from watch': off by default; on registers the delegate grant (its renewal date shows), off revokes it.",
    `${PKG}.GymWatchTest#quickApproveFromWatchTogglesTheDelegateGrant`,
    {
      steps: [
        { kind: "tap", describe: "Account security.", handle: "settings-open-account-security" },
        { kind: "tap", describe: "Quick approve from watch.", handle: "watch-delegate-toggle" },
        { kind: "assert", describe: "The grant is active.", handle: "watch-delegate-active" },
      ],
      assertions: [{ describe: "Delegate grant shown", handle: "watch-delegate-active", expect: "present" }],
      screenshots: [shot("watch-quick-approve-off", "Off."), shot("watch-quick-approve-on", "On.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-oct-share-co-manager-invites",
    "Co-manager invites (docs/service-access-gating.md \"Co-manager invites\"): at Can manage, Plants on the shared server offers Invite people; add a person at Member, the link names the shared server, Your invites lists them, Withdraw asks first and empties the list.",
    O + "coManagerInvitesAPersonAndWithdraws",
    {
      steps: [
        { kind: "tap", describe: "Open Plants on Garage.", handle: "shared-app-row-bright-maple--plants" },
        { kind: "tap", describe: "Invite people.", handle: "co-invite-open" },
        { kind: "tap", describe: "+ Add person, name them, Create invite link.", handle: "co-invite-create" },
        { kind: "tap", describe: "Withdraw, confirm.", handle: "co-invite-withdraw-confirm" },
      ],
      assertions: [
        { describe: "Member-only line", handle: "co-invite-line", expect: "text", text: "People you invite join as Member. You can withdraw your own invites." },
        { describe: "Link on the shared server", handle: "co-invite-link", expect: "present" },
        { describe: "Empty after withdraw", handle: "co-invite-none", expect: "present" },
      ],
      screenshots: [shot("co-invite-created", "The new invite and its link.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-oct-share-co-manager-demoted",
    "Co-manager invites: in Wiki an admin made the co-manager a Member, so the panel shows the box's sentence and their invite (Jo · 1 person joined) without Withdraw or add.",
    O + "coManagerDemotedSeesWhyAndNoWithdraw",
    {
      steps: [
        { kind: "tap", describe: "Open Wiki on Garage.", handle: "shared-app-row-bright-maple--wiki" },
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
  androidTotal(
    "android-oct-share-co-manager-view-only",
    "Co-manager invites: Cabin, shared at Can view, says why there's no Invite people, and its apps offer none.",
    O + "coManagerViewOnlyCantInvite",
    {
      steps: [{ kind: "tap", describe: "Open Cabin.", handle: "co-invite-view-only" }],
      assertions: [
        { describe: "View-only line", handle: "co-invite-view-only", expect: "text", text: "You can view this server but not manage it, so you can't invite people to its apps." },
        { describe: "No Invite people", handle: "co-invite-open", expect: "absent" },
      ],
      screenshots: [shot("co-invite-view-only", "The view-only line.")],
      dimension: "D3",
    },
  ),
];

export const ANDROID_GYM_SCENARIOS: readonly Scenario[] = [
  ...EVERY_MERGE,
  ...TOTAL,
  ...FEATURE_MIRRORS,
  ...OCTOBER,
];
