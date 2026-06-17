/**
 * webapp gym scenarios — every-merge subset + the total-gym Tier-1 tranche.
 *
 * All NO-BACKEND (gym static server; every /api/* is a 404, SW blocked). Each
 * entry's `harness` is a Playwright grep TITLE that must match a `test(...)` in
 * apps/web/e2e/gym/*.spec.ts EXACTLY.
 *
 * The full §6 matrix fills in here incrementally — each new scenario is a small
 * additive entry pointing at a new spec. This file is the web lane: parallel
 * authors add web rows here and nowhere else.
 */

import type { Scenario } from "../scenario.js";
import { web, webTotal, shot } from "./helpers.js";

// ───────────────────────── every-merge (fast gate) ─────────────────────────

const EVERY_MERGE: readonly Scenario[] = [
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
      dimension: "D1",
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
      dimension: "D7",
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
      dimension: "D1",
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
      dimension: "D1",
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
      dimension: "D1",
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
      dimension: "D1",
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
      dimension: "D1",
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
      dimension: "D3",
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
      dimension: "D8",
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
      dimension: "D8",
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
      dimension: "D1",
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
      dimension: "D1",
    },
  ),
];

// ───────────────────── total-gym Tier-1 tranche (§12-G5) ────────────────────
// Higher-value §6 rows a demo fixture can seed + assert with NO backend.
// `total` tier → these run ONLY in `gym:total`. Grep titles match
// apps/web/e2e/gym/gym-total.spec.ts (+ any new web spec files) EXACTLY.

const TOTAL: readonly Scenario[] = [
  // D2 — build modes (render client-side).
  webTotal(
    "web-total-build-chooser",
    "D2-B1: the build-a-service chooser renders the on-main source tiles (scratch/git/mcp).",
    "gym total webapp build chooser shows the on-main source tiles",
    {
      steps: [
        { kind: "launch", describe: "Reach Home → Services tab → build affordance." },
        { kind: "tap", describe: "Open the chooser.", handle: "#services-list-open-vibe-code" },
        { kind: "assert", describe: "Scratch tile.", handle: "#build-src-scratch" },
      ],
      assertions: [
        { describe: "Build-source view present", handle: "#view-build-source", expect: "present" },
        { describe: "Scratch tile present", handle: "#build-src-scratch", expect: "present" },
        { describe: "Git tile present", handle: "#build-src-git", expect: "present" },
        { describe: "MCP tile present", handle: "#build-src-mcp", expect: "present" },
      ],
      screenshots: [shot("build-chooser", "The build-a-service chooser.")],
      dimension: "D2",
    },
  ),
  webTotal(
    "web-total-ai-key-step",
    "D2-B2: scratch routes through the AI-key step (renders backendless; device-local keys).",
    "gym total webapp scratch routes through the AI-key step",
    {
      steps: [
        { kind: "launch", describe: "Reach the chooser." },
        { kind: "tap", describe: "Scratch → AI-key step.", handle: "#build-src-scratch" },
        { kind: "assert", describe: "AI-key step + no-saved-keys placeholder.", handle: "#build-key-saved" },
      ],
      assertions: [
        { describe: "AI-key view present", handle: "#view-build-key", expect: "present" },
        { describe: "No-saved-keys placeholder", handle: "#build-key-saved", expect: "text", text: "no saved keys" },
        { describe: "Use-a-different-key affordance", handle: "#build-key-different", expect: "present" },
      ],
      screenshots: [shot("build-key", "The AI-key step.")],
      dimension: "D2",
    },
  ),
  // D3 — settings: session tiers + grey-out gating.
  webTotal(
    "web-total-session-tiers-gated",
    "D3-C1: the recovery-gated session actions (passkey-lock, remove-device) are greyed until recovery is enrolled.",
    "gym total webapp settings greys the recovery-gated session actions",
    {
      steps: [
        { kind: "launch", describe: "Reach Settings." },
        { kind: "assert", describe: "Tier-1 PIN lock present.", handle: "#settings-pin-lock" },
        { kind: "assert", describe: "Tier-2 greyed.", handle: "#settings-signout" },
      ],
      assertions: [
        { describe: "PIN-lock present", handle: "#settings-pin-lock", expect: "present" },
        { describe: "Passkey-lock greyed", handle: "#settings-signout", expect: "present" },
        { describe: "Remove-device greyed", handle: "#settings-reset", expect: "present" },
      ],
      screenshots: [shot("session-tiers-gated", "The greyed session-tier cluster.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-greyed-action-toast",
    "D3-C1: tapping a greyed session action shows the set-up-recovery toast and does NOT run the destructive path.",
    "gym total webapp a greyed session action shows the set-up-recovery toast",
    {
      steps: [
        { kind: "launch", describe: "Reach Settings." },
        { kind: "tap", describe: "Tap the greyed tier-2 action.", handle: "#settings-signout" },
        { kind: "assert", describe: "Recovery toast + stays on settings.", handle: "#toast" },
      ],
      assertions: [
        { describe: "Recovery toast", handle: "#toast", expect: "text", text: "Set up account recovery" },
        { describe: "Still on settings detail (no wipe)", handle: "#view-settings", expect: "present" },
      ],
      screenshots: [shot("recovery-toast", "The set-up-recovery toast.")],
      dimension: "D3",
    },
  ),
  // D3 — AI-keys manager + recovery screen.
  webTotal(
    "web-total-ai-keys-manager",
    "D3-C2: the AI-keys manager (providers) renders the list + the add-key affordance (never the full key).",
    "gym total webapp settings renders the AI-keys manager",
    {
      steps: [
        { kind: "launch", describe: "Reach Settings." },
        { kind: "assert", describe: "Providers list + add affordance.", handle: "#providers-list" },
      ],
      assertions: [
        { describe: "Providers list present", handle: "#providers-list", expect: "present" },
        { describe: "Add-provider affordance present", handle: "#add-provider-go", expect: "present" },
      ],
      screenshots: [shot("ai-keys", "The AI-keys manager.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-recovery-screen",
    "D3-C4/C17: the recovery screen renders backendless (keyfile export + cloud setup).",
    "gym total webapp settings opens the recovery screen",
    {
      steps: [
        { kind: "launch", describe: "Reach Settings." },
        { kind: "tap", describe: "Recovery row.", handle: "#settings-tab-recovery" },
        { kind: "assert", describe: "Recovery view + keyfile export.", handle: "#recovery-keyfile-export" },
      ],
      assertions: [
        { describe: "Recovery view present", handle: "#view-recovery", expect: "present" },
        { describe: "Keyfile-export affordance present", handle: "#recovery-keyfile-export", expect: "present" },
      ],
      screenshots: [shot("recovery", "The recovery screen.")],
      dimension: "D3",
    },
  ),
  // D4 — the webapp PIN lock (E3).
  webTotal(
    "web-total-pin-set-validation",
    "D4-E3 + D7-light: PIN-set rejects a mismatch (inline error, stays on the screen) then accepts a valid PIN.",
    "gym total webapp PIN-set rejects a mismatch then accepts a valid PIN",
    {
      steps: [
        { kind: "launch", describe: "Reach Settings → PIN lock." },
        { kind: "type", describe: "Mismatched PINs.", handle: "#pin-set-confirm" },
        { kind: "tap", describe: "Save.", handle: "#pin-set-go" },
        { kind: "assert", describe: "Inline error + stays.", handle: "#pin-set-error" },
        { kind: "tap", describe: "Save a matching PIN → locks.", handle: "#pin-set-go" },
      ],
      assertions: [
        { describe: "PIN-set error present on mismatch", handle: "#pin-set-error", expect: "present" },
        { describe: "Locks to PIN-unlock on match", handle: "#view-pin-unlock", expect: "present" },
      ],
      screenshots: [shot("pin-set-mismatch", "The PIN mismatch error."), shot("pin-locked", "Locked to the PIN screen.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-pin-roundtrip",
    "D4-E3: a PIN set + unlock roundtrip returns to the shell (the PIN-unlock screen leaves).",
    "gym total webapp PIN set then unlock returns to the shell",
    {
      steps: [
        { kind: "launch", describe: "Reach Settings → PIN lock → set a valid PIN." },
        { kind: "type", describe: "Enter the PIN.", handle: "#pin-unlock-input" },
        { kind: "tap", describe: "Unlock.", handle: "#pin-unlock-go" },
        { kind: "assert", describe: "Lock screen left.", handle: "#view-pin-unlock" },
      ],
      assertions: [{ describe: "PIN-unlock screen hidden after unlock", handle: "#view-pin-unlock", expect: "absent" }],
      screenshots: [shot("pin-unlocked", "Back in the shell after PIN unlock.")],
      dimension: "D4",
    },
  ),
  // D4/D5 — the global slivers (seeded client-side).
  webTotal(
    "web-total-trust-sliver",
    "D4-E7: a seeded untrusted maintainer-trust verdict renders the red trust sliver (one failure line).",
    "gym total webapp the maintainer-trust red sliver renders an untrusted verdict",
    {
      steps: [
        { kind: "launch", describe: "Reach Home; seed an untrusted verdict on the trust store." },
        { kind: "assert", describe: "Red sliver + one line.", handle: "#trust-sliver" },
      ],
      assertions: [
        { describe: "Trust sliver present", handle: "#trust-sliver", expect: "present" },
        { describe: "One failure line", handle: "#trust-sliver .trust-bar-line", expect: "present" },
      ],
      screenshots: [shot("trust-sliver", "The red maintainer-trust sliver.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-operations-sliver",
    "D5-F12: a seeded in-flight build renders the teal active-operations sliver.",
    "gym total webapp the active-operations teal sliver shows a seeded build",
    {
      steps: [
        { kind: "launch", describe: "Reach Home; seed a build op on the operations center." },
        { kind: "assert", describe: "Teal sliver shows 'building'.", handle: "#global-operations-bar" },
      ],
      assertions: [
        { describe: "Operations sliver present", handle: "#global-operations-bar", expect: "present" },
        { describe: "Building label", handle: "#global-operations-bar", expect: "text", text: "building" },
      ],
      screenshots: [shot("operations-sliver", "The teal active-operations sliver.")],
      dimension: "D5",
    },
  ),
];

/** The webapp lane of the gym registry (every-merge subset + total tranche). */
export const WEB_GYM_SCENARIOS: readonly Scenario[] = [...EVERY_MERGE, ...TOTAL];
