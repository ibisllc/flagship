/**
 * The scenario registry — the every-merge gym's curated, fast, DETERMINISTIC,
 * NO-BACKEND Tier-1 subset (§12-G4 / §0): "does the app still launch, render
 * its core screens, and navigate without a broken edge." Every scenario here
 * is `every-merge` + `fixture` (so it runs in BOTH gyms) and non-destructive.
 *
 * Each scenario is a registry entry whose `harness` binds it to a REAL
 * per-surface driver spec:
 *   - web: a Playwright `test(...)` in apps/web/e2e/gym/gym-smoke.spec.ts,
 *     selected by its (unique) grep TITLE.
 *   - iOS: an `-only-testing:` identifier (Target/Class[/method]) into the
 *     XCUITest target — GymSmokeTests (the cold-launch smoke) +
 *     GymEveryMergeTests (the breadth).
 * Android is intentionally stubbed (the adapter reports unavailable + the
 * runner SKIPS it) — the on-device instrumentation harness + the ~43-screen
 * testTag sweep are §10 Phase-5, not this run.
 *
 * The full §6 70×4 matrix fills in here incrementally — each new scenario is a
 * small additive entry pointing at a new spec.
 */

import type { Scenario, ScenarioStep, ScenarioAssertion, ScreenshotPoint } from "./scenario.js";

/** Shorthand: a fixture/every-merge web scenario bound to a Playwright grep title. */
function web(
  id: string,
  goal: string,
  grepTitle: string,
  parts: {
    steps: readonly ScenarioStep[];
    assertions: readonly ScenarioAssertion[];
    screenshots: readonly ScreenshotPoint[];
  },
): Scenario {
  return {
    id,
    surface: "web",
    tier: "every-merge",
    backend: "fixture",
    goal,
    steps: parts.steps,
    assertions: parts.assertions,
    screenshotPoints: parts.screenshots,
    harness: grepTitle,
  };
}

/** Shorthand: a fixture/every-merge iOS scenario bound to an `-only-testing:` id. */
function ios(
  id: string,
  goal: string,
  onlyTesting: string,
  parts: {
    steps: readonly ScenarioStep[];
    assertions: readonly ScenarioAssertion[];
    screenshots: readonly ScreenshotPoint[];
  },
): Scenario {
  return {
    id,
    surface: "ios",
    tier: "every-merge",
    backend: "fixture",
    goal,
    steps: parts.steps,
    assertions: parts.assertions,
    screenshotPoints: parts.screenshots,
    harness: onlyTesting,
  };
}

const shot = (id: string, describe: string): ScreenshotPoint => ({ id, describe });

// ───────────────────────────── webapp scenarios ────────────────────────────
// All NO-BACKEND (gym static server; every /api/* is a 404, SW blocked).

const WEB_SCENARIOS: readonly Scenario[] = [
  web(
    "web-cold-launch",
    "Cold launch renders the bootstrap shell with the brand title + a primary create-account action.",
    "gym webapp cold launch renders the bootstrap shell + primary action",
    {
      steps: [
        { kind: "launch", describe: "Open the webapp at / (static-served, no backend)." },
        { kind: "assert", describe: "Bootstrap view visible.", handle: "#view-bootstrap" },
        { kind: "screenshot", describe: "Cold-launch frame." },
        { kind: "assert", describe: "Brand title contains 'Flagship'.", handle: "header h1#title" },
        { kind: "assert", describe: "Primary action present + enabled.", handle: "#bootstrap-go" },
      ],
      assertions: [
        { describe: "Bootstrap view present", handle: "#view-bootstrap", expect: "present" },
        { describe: "Brand title text", handle: "header h1#title", expect: "text", text: "Flagship" },
        { describe: "Create-account action enabled", handle: "#bootstrap-go", expect: "enabled" },
      ],
      screenshots: [shot("cold-launch", "After the shell paints."), shot("bootstrap-ready", "Primary action confirmed.")],
    },
  ),
  web(
    "web-brand-dna",
    "The boot palette + type stack conform to the brand tokens (teal accent, dark canvas, Geist + Instrument Serif; no legacy blue).",
    "gym webapp boots on the brand-DNA palette + fonts",
    {
      steps: [
        { kind: "launch", describe: "Cold launch." },
        { kind: "assert", describe: "Computed --accent is brand teal, not legacy blue." },
        { kind: "screenshot", describe: "Brand-DNA frame." },
      ],
      assertions: [{ describe: "Palette + fonts conform to tokens", expect: "present" }],
      screenshots: [shot("brand-dna", "The branded bootstrap shell.")],
    },
  ),
  web(
    "web-bootstrap-passphrase-mismatch",
    "A passphrase mismatch is rejected client-side: stays on bootstrap + an error toast (no identity minted).",
    "gym webapp bootstrap rejects a passphrase mismatch",
    {
      steps: [
        { kind: "launch", describe: "Cold launch." },
        { kind: "type", describe: "Fill mismatched passphrases.", handle: "#bootstrap-passphrase-2" },
        { kind: "tap", describe: "Generate.", handle: "#bootstrap-go" },
        { kind: "assert", describe: "Stays on bootstrap.", handle: "#view-bootstrap" },
        { kind: "assert", describe: "Mismatch toast.", handle: "#toast" },
      ],
      assertions: [
        { describe: "Still on bootstrap", handle: "#view-bootstrap", expect: "present" },
        { describe: "Mismatch toast", handle: "#toast", expect: "text", text: "match" },
      ],
      screenshots: [shot("mismatch-toast", "The mismatch error.")],
    },
  ),
  web(
    "web-bootstrap-passphrase-too-short",
    "A too-short passphrase is rejected client-side: stays on bootstrap + an error toast.",
    "gym webapp bootstrap rejects a too-short passphrase",
    {
      steps: [
        { kind: "launch", describe: "Cold launch." },
        { kind: "type", describe: "Fill a 5-char passphrase twice." },
        { kind: "tap", describe: "Generate.", handle: "#bootstrap-go" },
        { kind: "assert", describe: "Stays on bootstrap + toast.", handle: "#toast" },
      ],
      assertions: [
        { describe: "Still on bootstrap", handle: "#view-bootstrap", expect: "present" },
        { describe: "Too-short toast", handle: "#toast", expect: "present" },
      ],
      screenshots: [shot("short-toast", "The too-short error.")],
    },
  ),
  web(
    "web-bootstrap-to-wizard",
    "Bootstrap mints a device identity (client-side crypto) and transitions to the first-run wizard's username step.",
    "gym webapp bootstrap mints an identity and reaches the home shell",
    {
      steps: [
        { kind: "launch", describe: "Cold launch." },
        { kind: "type", describe: "Fill a valid passphrase twice." },
        { kind: "tap", describe: "Generate.", handle: "#bootstrap-go" },
        { kind: "assert", describe: "Wizard username step renders.", handle: "#wizard-username-input" },
      ],
      assertions: [
        { describe: "Wizard view present", handle: "#view-wizard", expect: "present" },
        { describe: "Username input present", handle: "#wizard-username-input", expect: "present" },
      ],
      screenshots: [shot("wizard-username", "The wizard username step.")],
    },
  ),
  web(
    "web-wizard-username-invalid",
    "The wizard rejects an invalid username client-side (before any availability call): stays on the wizard + an error toast.",
    "gym webapp wizard rejects an invalid username client-side",
    {
      steps: [
        { kind: "launch", describe: "Cold launch → mint identity → wizard." },
        { kind: "type", describe: "Type 'AB' (uppercase, too short).", handle: "#wizard-username-input" },
        { kind: "tap", describe: "Open my account.", handle: "#wizard-go-username" },
        { kind: "assert", describe: "Stays on wizard + lowercase toast.", handle: "#toast" },
      ],
      assertions: [
        { describe: "Still on wizard", handle: "#view-wizard", expect: "present" },
        { describe: "Lowercase-rule toast", handle: "#toast", expect: "text", text: "lowercase" },
      ],
      screenshots: [shot("username-invalid", "The username validation error.")],
    },
  ),
  web(
    "web-home-empty-state",
    "Home renders the real empty no-servers state (short-circuits before any fetch) after a backendless unlock.",
    "gym webapp home renders the empty no-servers state",
    {
      steps: [
        { kind: "launch", describe: "Bootstrap → reload(?view=home) → unlock → Home." },
        { kind: "assert", describe: "Home view + empty-state card.", handle: "#view-home .empty-state" },
        { kind: "assert", describe: "Create-server CTA.", handle: "#empty-create-server" },
      ],
      assertions: [
        { describe: "Home view present", handle: "#view-home", expect: "present" },
        { describe: "Empty-state card present", handle: "#view-home .empty-state", expect: "present" },
        { describe: "Empty-state CTA present", handle: "#empty-create-server", expect: "present" },
      ],
      screenshots: [shot("home-empty", "The empty Home.")],
    },
  ),
  web(
    "web-settings-tab",
    "Home → the Settings tab renders the settings shell + its grouped account rows (account-security + recovery).",
    "gym webapp navigates Home to the Settings tab",
    {
      steps: [
        { kind: "launch", describe: "Reach Home." },
        { kind: "tap", describe: "Settings tab.", handle: '[data-tab-target="settings"]' },
        { kind: "assert", describe: "Settings tab view + rows.", handle: "#view-settings-tab" },
      ],
      assertions: [
        { describe: "Settings tab present", handle: "#view-settings-tab", expect: "present" },
        { describe: "Account-security row", handle: "#settings-tab-account-security", expect: "present" },
        { describe: "Recovery row", handle: "#settings-tab-recovery", expect: "present" },
      ],
      screenshots: [shot("settings-tab", "The Settings tab.")],
    },
  ),
  web(
    "web-activity-tab",
    "Home → the Activity tab renders its shell.",
    "gym webapp navigates Home to the Activity tab",
    {
      steps: [
        { kind: "launch", describe: "Reach Home." },
        { kind: "tap", describe: "Activity tab.", handle: '[data-tab-target="activity"]' },
        { kind: "assert", describe: "Activity view present.", handle: "#view-activity" },
      ],
      assertions: [{ describe: "Activity view present", handle: "#view-activity", expect: "present" }],
      screenshots: [shot("activity-tab", "The Activity tab.")],
    },
  ),
  web(
    "web-services-tab",
    "Home → the Services tab renders its shell + the build-a-service affordance (the list fetch fails closed without dropping the view).",
    "gym webapp navigates Home to the Services tab",
    {
      steps: [
        { kind: "launch", describe: "Reach Home." },
        { kind: "tap", describe: "Services tab.", handle: '[data-tab-target="apps"]' },
        { kind: "assert", describe: "Services view + build affordance.", handle: "#services-list-open-vibe-code" },
      ],
      assertions: [
        { describe: "Services view present", handle: "#view-services-list", expect: "present" },
        { describe: "Build-a-service affordance", handle: "#services-list-open-vibe-code", expect: "present" },
      ],
      screenshots: [shot("services-tab", "The Services tab.")],
    },
  ),
  web(
    "web-create-server-form",
    "The create-server form renders its load-bearing controls: the name field, disk-encryption toggle, and backup-policy control.",
    "gym webapp opens the create-server form with its controls",
    {
      steps: [
        { kind: "launch", describe: "Bootstrap → reload(?view=create-server) → unlock → form." },
        { kind: "assert", describe: "Name + encrypt + backup controls.", handle: "#cs-encrypt-disk" },
      ],
      assertions: [
        { describe: "Name field present", handle: "#cs-server-name", expect: "present" },
        { describe: "Disk-encryption control present", handle: "#cs-encrypt-disk", expect: "present" },
        { describe: "Backup-policy control present", handle: "#cs-backup-policy", expect: "present" },
      ],
      screenshots: [shot("create-server-form", "The create-server form.")],
    },
  ),
  web(
    "web-create-server-name-invalid",
    "The create-server name field validates client-side: an invalid name surfaces the inline error and stays on the form.",
    "gym webapp create-server rejects an invalid server name",
    {
      steps: [
        { kind: "launch", describe: "Reach the create-server form." },
        { kind: "type", describe: "Type 'Not A Valid Name'.", handle: "#cs-server-name" },
        { kind: "tap", describe: "Save draft.", handle: "#cs-save-draft" },
        { kind: "assert", describe: "Inline name error + stays on form.", handle: "#cs-server-name-error" },
      ],
      assertions: [
        { describe: "Still on create-server", handle: "#view-create-server", expect: "present" },
        { describe: "Inline name error present", handle: "#cs-server-name-error", expect: "present" },
      ],
      screenshots: [shot("create-server-name-invalid", "The name validation error.")],
    },
  ),
];

// ────────────────────────────── iOS scenarios ──────────────────────────────
// All NO-BACKEND (`-smoke-mode` → DemoFixtures + the mock client).

const IOS_SCENARIOS: readonly Scenario[] = [
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
    },
  ),
];

/** Every scenario known to the gym. */
export const ALL_SCENARIOS: readonly Scenario[] = [...WEB_SCENARIOS, ...IOS_SCENARIOS];
