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
    "android-oct-access-list-scope-locked",
    "D3 (feat/marketplace): on an admin device without Pro, 'Separate list on each server' is off and locked with 'Comes with Pro.' (no purchase link) and no server picker.",
    O + "listScopeLockedWithoutPro",
    {
      steps: [
        { kind: "launch", describe: "Plants → Access control as an admin device, plan free (smokeAdminRoot, smokePlan=free)." },
        { kind: "assert", describe: "The locked switch and its Pro line.", handle: "service-access-list-scope-pro" },
      ],
      assertions: [
        { describe: "Separate-lists switch", handle: "service-access-list-scope-toggle", expect: "present" },
        { describe: "Comes with Pro.", handle: "service-access-list-scope-pro", expect: "present" },
        { describe: "No server picker", handle: "service-access-server-picker", expect: "absent" },
      ],
      screenshots: [shot("access-list-scope-locked", "Locked without Pro.")],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-oct-access-list-scope-server-picker",
    "D3 (feat/marketplace): with Pro, turning on 'Separate list on each server' (confirmed, admin-root signed) shows the server picker; picking Office loads Office's own list.",
    O + "listScopeOnShowsTheServerPicker",
    {
      steps: [
        { kind: "launch", describe: "Plants → Access control as an admin device, plan Pro (smokeAdminRoot, smokePlan=pro)." },
        { kind: "tap", describe: "Separate list on each server → confirm.", handle: "service-access-list-scope-toggle" },
        { kind: "tap", describe: "Server picker → Office.", handle: "service-access-server-picker-office" },
      ],
      assertions: [
        { describe: "Separate-lists switch", handle: "service-access-list-scope-toggle", expect: "present" },
        { describe: "Server picker", handle: "service-access-server-picker", expect: "present" },
        { describe: "No Pro line", handle: "service-access-list-scope-pro", expect: "absent" },
      ],
      screenshots: [
        shot("access-list-scope-confirm", "Confirm."),
        shot("access-list-scope-on", "Picker."),
        shot("access-list-scope-office", "Office's list."),
      ],
      dimension: "D3",
    },
  ),
  androidTotal(
    "android-oct-tier-status-separate-lists-warning",
    "D3 (feat/marketplace): Tier & usage warns, while on Pro, that an app with a separate list on each server will use its lead server's list when Pro ends.",
    O + "tierStatusWarnsAboutSeparateLists",
    {
      steps: [
        { kind: "launch", describe: "Settings → Plan / Subscription, plan Pro, Plants with separate lists (smokePlan=pro, smokeSeparateLists)." },
        { kind: "assert", describe: "The warning card.", handle: "tier-status-separate-lists-warning" },
      ],
      assertions: [{ describe: "Separate-lists warning", handle: "tier-status-separate-lists-warning", expect: "present" }],
      screenshots: [shot("tier-status-separate-lists-warning", "Warning.")],
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
];

export const ANDROID_GYM_SCENARIOS: readonly Scenario[] = [
  ...EVERY_MERGE,
  ...TOTAL,
  ...FEATURE_MIRRORS,
  ...OCTOBER,
];
