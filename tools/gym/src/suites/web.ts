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
        { kind: "assert", describe: "Primary action present + enabled.", handle: "#bootstrap-create" },
      ],
      assertions: [
        { describe: "Bootstrap view present", handle: "#view-bootstrap", expect: "present" },
        { describe: "Brand title text", handle: "header h1#title", expect: "text", text: "Flagship" },
        { describe: "Create-account action enabled", handle: "#bootstrap-create", expect: "enabled" },
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
    "The create-account passphrase moved into a modal; its confirm step rejects a mismatch client-side (no identity minted).",
    "gym webapp bootstrap rejects a passphrase mismatch",
    {
      steps: [
        { kind: "launch", describe: "Cold launch." },
        { kind: "tap", describe: "Create a new account.", handle: "#bootstrap-create" },
        { kind: "type", describe: "Confirm a mismatched passphrase in the modal.", handle: ".modal-input" },
        { kind: "assert", describe: "Inline mismatch error; modal stays.", handle: "[data-modal-error]" },
      ],
      assertions: [
        { describe: "Still in the create modal", handle: ".modal-title", expect: "present" },
        { describe: "Mismatch error", handle: "[data-modal-error]", expect: "text", text: "match" },
      ],
      screenshots: [shot("mismatch-toast", "The mismatch error.")],
      dimension: "D1",
    },
  ),
  web(
    "web-bootstrap-passphrase-too-short",
    "The create-account modal's passphrase step rejects a < 8-char passphrase client-side (no identity minted).",
    "gym webapp bootstrap rejects a too-short passphrase",
    {
      steps: [
        { kind: "launch", describe: "Cold launch." },
        { kind: "tap", describe: "Create a new account.", handle: "#bootstrap-create" },
        { kind: "type", describe: "Type a 5-char passphrase in the modal.", handle: ".modal-input" },
        { kind: "assert", describe: "Inline 8+ chars error; modal stays.", handle: "[data-modal-error]" },
      ],
      assertions: [
        { describe: "Still in the create modal", handle: ".modal-title", expect: "present" },
        { describe: "Too-short error", handle: "[data-modal-error]", expect: "present" },
      ],
      screenshots: [shot("short-toast", "The too-short error.")],
      dimension: "D1",
    },
  ),
  web(
    "web-bootstrap-to-wizard",
    "The create flow mints a device identity client-side (the random-handle suggestion 404s with no backend, but the wrapped UMK persists) so a reload→unlock reaches the real Home shell.",
    "gym webapp bootstrap mints an identity and reaches the home shell",
    {
      steps: [
        { kind: "launch", describe: "Cold launch → create (modal passphrase ×2) → mint." },
        { kind: "assert", describe: "Reload + unlock reaches Home.", handle: "#view-home" },
      ],
      assertions: [
        { describe: "Home shell present", handle: "#view-home", expect: "present" },
      ],
      screenshots: [shot("home-reached", "The Home shell after a backendless create + unlock.")],
      dimension: "D1",
    },
  ),
  web(
    "web-wizard-username-invalid",
    "The username-first cover's sign-in path rejects an invalid handle client-side (before any directory call): stays on the cover + an error toast.",
    "gym webapp wizard rejects an invalid username client-side",
    {
      steps: [
        { kind: "launch", describe: "Cold launch (username-first cover)." },
        { kind: "type", describe: "Type 'AB' (uppercase, too short).", handle: "#bootstrap-username" },
        { kind: "tap", describe: "Sign in.", handle: "#bootstrap-continue" },
        { kind: "assert", describe: "Stays on the cover + lowercase toast.", handle: "#toast" },
      ],
      assertions: [
        { describe: "Still on the cover", handle: "#view-bootstrap", expect: "present" },
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

  // ── D1 — server lifecycle (server-detail render + the control ceremonies) ──
  // The server-detail screen is the lifecycle CONTROL surface; these seed a
  // paired pod + route ONLY the ServerDetailResponse BFF, then assert the card
  // set renders + the destructive ceremonies OPEN (Cancel → non-destructive).
  webTotal(
    "web-total-server-detail-sections",
    "D1-A6..A11: server-detail renders its full control card set (auto-unlock / lock-power / dead-man / journal / front-page / danger-zone) from a routed BFF.",
    "gym total webapp server-detail renders its control sections",
    {
      steps: [
        { kind: "launch", describe: "Reach Home; seed a paired pod; route the server-detail BFF." },
        { kind: "tap", describe: "enterServerDetail().", handle: "#view-server-detail" },
        { kind: "assert", describe: "Control cards render.", handle: "#auto-unlock-card" },
      ],
      assertions: [
        { describe: "Server-detail view present", handle: "#view-server-detail", expect: "present" },
        { describe: "Auto-unlock card", handle: "#auto-unlock-card", expect: "present" },
        { describe: "Lock & power card", handle: "#lock-power-card", expect: "present" },
        { describe: "Dead-man card", handle: "#deadman-card", expect: "present" },
        { describe: "Journal card", handle: "#journal-card", expect: "present" },
        { describe: "Front-page card", handle: "#front-page-card", expect: "present" },
        { describe: "Danger-zone revoke button", handle: "#revoke-server-btn", expect: "present" },
      ],
      screenshots: [shot("server-detail", "The full server-detail control surface.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-server-detail-revoke-confirm",
    "D1-A11 / D6-G11: tapping Revoke opens the confirm ceremony (reason radios + Revoke/Cancel); Cancel runs no delete (non-destructive).",
    "gym total webapp server-detail revoke opens the confirm ceremony",
    {
      steps: [
        { kind: "launch", describe: "Reach server-detail (routed BFF)." },
        { kind: "tap", describe: "Tap Revoke this server.", handle: "#revoke-server-btn" },
        { kind: "assert", describe: "Confirm dialog opens.", handle: 'dialog[aria-label="Revoke this server"]' },
        { kind: "tap", describe: "Cancel — no delete.", handle: "[data-revoke-cancel]" },
      ],
      assertions: [
        { describe: "Revoke confirm dialog opens", handle: 'dialog[aria-label="Revoke this server"]', expect: "present" },
        { describe: "Reason radio present", handle: 'input[name="revoke-reason"]', expect: "present" },
        { describe: "Back on server-detail after Cancel", handle: "#view-server-detail", expect: "present" },
      ],
      screenshots: [shot("revoke-confirm", "The revoke confirm ceremony (not executed).")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-lock-power-confirm",
    "D6-G3 (confirm-UI): Lock and turn off opens its are-you-sure dialog; the power order only fires after a 3s countdown — we Cancel, so nothing is sent.",
    "gym total webapp server-detail lock-and-power opens the confirm dialog",
    {
      steps: [
        { kind: "launch", describe: "Reach server-detail (routed BFF)." },
        { kind: "tap", describe: "Tap Lock and turn off.", handle: "#power-off-btn" },
        { kind: "assert", describe: "Power confirm dialog opens.", handle: 'dialog[aria-label="Lock and turn off"]' },
        { kind: "tap", describe: "Cancel — nothing sent.", handle: "[data-power-cancel]" },
      ],
      assertions: [
        { describe: "Power confirm dialog opens", handle: 'dialog[aria-label="Lock and turn off"]', expect: "present" },
        { describe: "Power-go button present", handle: "[data-power-go]", expect: "present" },
      ],
      screenshots: [shot("power-confirm", "The lock-and-power confirm dialog (not executed).")],
      dimension: "D6",
    },
  ),

  // ── D5 — server-event seed states (server-detail cert) ──
  webTotal(
    "web-total-cert-near-expiry",
    "D5-F8: a near-expiry cert seeded on the BFF surfaces its date in the server-detail Cert card.",
    "gym total webapp server-detail surfaces a near-expiry certificate",
    {
      steps: [
        { kind: "launch", describe: "Reach server-detail; route a ~5d-out certNotAfter." },
        { kind: "assert", describe: "The seeded date renders.", handle: "#server-detail-content" },
      ],
      assertions: [
        { describe: "Server-detail content present", handle: "#server-detail-content", expect: "present" },
      ],
      screenshots: [shot("cert-near-expiry", "The near-expiry cert state.")],
      dimension: "D5",
    },
  ),
  webTotal(
    "web-total-cert-renewed",
    "D5-F7: a renewed (advanced) certNotAfter is reflected on the server-detail Cert card.",
    "gym total webapp server-detail reflects a renewed certificate date",
    {
      steps: [
        { kind: "launch", describe: "Reach server-detail; route a ~89d-out certNotAfter." },
        { kind: "assert", describe: "The renewed date renders.", handle: "#server-detail-content" },
      ],
      assertions: [
        { describe: "Server-detail content present", handle: "#server-detail-content", expect: "present" },
      ],
      screenshots: [shot("cert-renewed", "The renewed cert state.")],
      dimension: "D5",
    },
  ),

  // ── D2 — build modes IN DETAIL (route-stubbed pod BFF) ──
  webTotal(
    "web-total-git-verdict-fit",
    "D2-B5/B6: a paste→clone reporting FIT renders the Flagship-ready verdict + Install button.",
    "gym total webapp git build shows the Flagship-ready verdict and Install",
    {
      steps: [
        { kind: "launch", describe: "Reach build-git; route /api/build/git → fit." },
        { kind: "type", describe: "Paste a repo URL.", handle: "#build-git-url" },
        { kind: "tap", describe: "Check repo.", handle: "#build-git-check" },
        { kind: "assert", describe: "Fit verdict + Install.", handle: "#build-git-deploy" },
      ],
      assertions: [
        { describe: "Verdict shown", handle: "#build-git-verdict", expect: "text", text: "Flagship-ready" },
        { describe: "Install button present", handle: "#build-git-deploy", expect: "present" },
      ],
      screenshots: [shot("git-verdict-fit", "The Flagship-ready verdict.")],
      dimension: "D2",
    },
  ),
  webTotal(
    "web-total-git-verdict-nofit",
    "D2-B7: a NOT-fit repo renders the explain + 'Build with AI instead' adapt affordance.",
    "gym total webapp git build offers AI-adapt for a non-fit repo",
    {
      steps: [
        { kind: "launch", describe: "Reach build-git; route /api/build/git → not-fit." },
        { kind: "type", describe: "Paste a repo URL.", handle: "#build-git-url" },
        { kind: "tap", describe: "Check repo.", handle: "#build-git-check" },
        { kind: "assert", describe: "Not-fit verdict + adapt.", handle: "#build-git-adapt" },
      ],
      assertions: [
        { describe: "Verdict shown", handle: "#build-git-verdict", expect: "text", text: "Not Flagship-ready" },
        { describe: "Build-with-AI button present", handle: "#build-git-adapt", expect: "present" },
      ],
      screenshots: [shot("git-verdict-nofit", "The not-fit verdict with the adapt affordance.")],
      dimension: "D2",
    },
  ),
  webTotal(
    "web-total-mcp-connect",
    "D2-B8: Create-a-connection renders the MCP URL + copyable per-build key + IDE config + rotate.",
    "gym total webapp MCP connect shows the copyable key and IDE config",
    {
      steps: [
        { kind: "launch", describe: "Reach build-mcp; route /api/build/mcp + empty env-requests." },
        { kind: "tap", describe: "Create a connection.", handle: "#build-mcp-create" },
        { kind: "assert", describe: "Connection card renders.", handle: "#mcp-key" },
      ],
      assertions: [
        { describe: "Connection card present", handle: "#build-mcp-conn", expect: "present" },
        { describe: "Copyable key present", handle: "#mcp-key", expect: "present" },
        { describe: "Copy-config affordance", handle: "#mcp-copy-cfg", expect: "present" },
      ],
      screenshots: [shot("mcp-connect", "The MCP connection card.")],
      dimension: "D2",
    },
  ),
  webTotal(
    "web-total-mcp-env-value-free",
    "D2-B9 (security): the IDE's value-free env-requests show NAME + status only; a seeded secret VALUE is NEVER rendered.",
    "gym total webapp MCP env-requests never reveal a secret value",
    {
      steps: [
        { kind: "launch", describe: "Reach build-mcp; route a secret env-request carrying a sentinel value." },
        { kind: "tap", describe: "Create a connection.", handle: "#build-mcp-create" },
        { kind: "assert", describe: "Name shown, value absent.", handle: "#mcp-env-requests" },
      ],
      assertions: [
        { describe: "Env-request name shown", handle: "#mcp-env-requests", expect: "text", text: "STRIPE_API_KEY" },
        { describe: "Secret value never rendered", handle: "#view-build-mcp", expect: "present" },
      ],
      screenshots: [shot("mcp-env-value-free", "The value-free env-request row.")],
      dimension: "D2",
    },
  ),
  webTotal(
    "web-total-build-journal",
    "D2-B10: the journal viewer lists prior builds and opens a build's timeline (the resume surface).",
    "gym total webapp build journal lists prior builds and opens a timeline",
    {
      steps: [
        { kind: "launch", describe: "Reach build-journal; route /api/build/sessions + a journal." },
        { kind: "tap", describe: "Open a build tile.", handle: "#build-journal-list [data-build='gym-build-a']" },
        { kind: "assert", describe: "Timeline renders.", handle: ".build-journal-timeline" },
      ],
      assertions: [
        { describe: "Build journal view present", handle: "#view-build-journal", expect: "present" },
        { describe: "Build timeline present", handle: ".build-journal-timeline", expect: "present" },
      ],
      screenshots: [shot("build-journal", "The build journal list + timeline.")],
      dimension: "D2",
    },
  ),
  webTotal(
    "web-total-needs-credential",
    "D2-B3 (edge): a scratch first turn that gets 200 {needsCredential:true} routes into the AI-key step instead of streaming.",
    "gym total webapp scratch chat needsCredential routes to the AI-key step",
    {
      steps: [
        { kind: "launch", describe: "Reach vibe-code; route /vibe-code/start → needsCredential." },
        { kind: "type", describe: "Type a prompt.", handle: "#vc-prompt" },
        { kind: "tap", describe: "Send.", handle: "#vc-send" },
        { kind: "assert", describe: "Routes to the AI-key step.", handle: "#view-build-key" },
      ],
      assertions: [
        { describe: "AI-key step opens", handle: "#view-build-key", expect: "present" },
      ],
      screenshots: [shot("needs-credential", "The needsCredential → add-an-AI-key transition.")],
      dimension: "D2",
    },
  ),

  // ── D3 — settings EDGE CASES (add-device SAS, trusted devices, keyfile) ──
  webTotal(
    "web-total-add-device-sas",
    "D3-C6: the admin Add-device screen renders the pairing QR + SAS display + no-screenshot warning + (double-tap-safe disabled) confirm.",
    "gym total webapp add-device renders the QR and SAS pairing chrome",
    {
      steps: [
        { kind: "launch", describe: "Reach Home (with an active profile); enterAddDevice()." },
        { kind: "assert", describe: "QR + SAS + confirm render.", handle: "#add-device-sas" },
      ],
      assertions: [
        { describe: "Add-device view present", handle: "#view-add-device", expect: "present" },
        { describe: "Pairing QR box present", handle: "#add-device-qr", expect: "present" },
        { describe: "SAS display present", handle: "#add-device-sas", expect: "present" },
        { describe: "Confirm button present", handle: "#add-device-confirm", expect: "present" },
      ],
      screenshots: [shot("add-device-sas", "The QR + SAS pairing chrome.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-trusted-devices",
    "D3-C7: the trusted-devices list renders device rows from a routed /devices.",
    "gym total webapp trusted-devices lists the account's devices",
    {
      steps: [
        { kind: "launch", describe: "Reach Home (active profile); route /devices; show trusted-devices." },
        { kind: "assert", describe: "Device rows render.", handle: "#trusted-devices-list" },
      ],
      assertions: [
        { describe: "Trusted-devices view present", handle: "#view-trusted-devices", expect: "present" },
        { describe: "Device list populated", handle: "#trusted-devices-list", expect: "text", text: "iPhone" },
      ],
      screenshots: [shot("trusted-devices", "The trusted-devices list.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-keyfile-export",
    "D3-C17 / E4: the recovery keyfile export is pure client-side (argon2id+AES-GCM → Blob download); a download fires with the expected filename.",
    "gym total webapp recovery keyfile export downloads a wrapped key file",
    {
      steps: [
        { kind: "launch", describe: "Reach Home; enterRecovery()." },
        { kind: "tap", describe: "Back up account key.", handle: "#recovery-keyfile-export" },
        { kind: "assert", describe: "A download fires.", handle: "#view-recovery" },
      ],
      assertions: [
        { describe: "Recovery view present", handle: "#view-recovery", expect: "present" },
        { describe: "Keyfile-export affordance present", handle: "#recovery-keyfile-export", expect: "present" },
      ],
      screenshots: [shot("keyfile-export", "The keyfile export.")],
      dimension: "D3",
    },
  ),

  // ── D4 — security: the full PIN lifecycle + trust override ──
  webTotal(
    "web-total-pin-lockout",
    "D4-E3 (security): five wrong PINs WIPE the PIN and fall back to the passphrase screen; the passphrase still unlocks and the PIN is gone.",
    "gym total webapp PIN lockout wipes the PIN and falls back to passphrase",
    {
      steps: [
        { kind: "launch", describe: "Set a PIN; enter a wrong one 5x." },
        { kind: "assert", describe: "Bounced to the passphrase screen.", handle: "#view-unlock" },
        { kind: "tap", describe: "Unlock with the passphrase.", handle: "#unlock-go" },
      ],
      assertions: [
        { describe: "Passphrase fallback shown after lockout", handle: "#view-unlock", expect: "present" },
      ],
      screenshots: [
        shot("pin-lockout", "The lockout → passphrase fallback."),
        shot("pin-wiped-after-lockout", "The PIN wiped after lockout."),
      ],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-pin-cleared-by-passphrase",
    "D4-E3 (reset rule): unlocking via 'passphrase instead' from the PIN screen CLEARS the PIN.",
    "gym total webapp passphrase unlock from the PIN screen clears the PIN",
    {
      steps: [
        { kind: "launch", describe: "Set a PIN; choose passphrase instead; unlock." },
        { kind: "assert", describe: "Lock screen left + PIN cleared.", handle: "#view-pin-unlock" },
      ],
      assertions: [
        { describe: "PIN-unlock screen hidden after unlock", handle: "#view-pin-unlock", expect: "absent" },
      ],
      screenshots: [shot("pin-cleared-by-passphrase", "The PIN cleared by a passphrase unlock.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-pin-change-current",
    "D4-E3: once set, the PIN action surfaces CHANGE (current+new+confirm); a wrong current PIN is rejected.",
    "gym total webapp PIN change requires the current PIN",
    {
      steps: [
        { kind: "launch", describe: "Set a PIN; unlock; re-open the PIN action → change mode." },
        { kind: "type", describe: "Wrong current PIN + new/confirm.", handle: "#pin-set-current" },
        { kind: "tap", describe: "Save.", handle: "#pin-set-go" },
        { kind: "assert", describe: "Rejected; stays on the set screen.", handle: "#pin-set-error" },
      ],
      assertions: [
        { describe: "Current-PIN field shown in change mode", handle: "#pin-set-current", expect: "present" },
        { describe: "Wrong current PIN error", handle: "#pin-set-error", expect: "present" },
      ],
      screenshots: [shot("pin-change-wrong-current", "The change-PIN wrong-current rejection.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-trust-override-persists",
    "D4-E8/E9: tapping the red sliver line → typed-confirm gate → a TrustException; traffic un-halts but the red line PERSISTS (flagged 'continuing').",
    "gym total webapp trust override grants an exception but the sliver persists",
    {
      steps: [
        { kind: "launch", describe: "Reach Home; seed an untrusted verdict; render the sliver." },
        { kind: "tap", describe: "Tap the red line.", handle: "#trust-sliver .trust-bar-line" },
        { kind: "type", describe: "Type ACCEPT in the gate.", handle: ".modal-card input" },
        { kind: "assert", describe: "Line persists + accepted marker.", handle: "#trust-sliver .trust-bar-accepted" },
      ],
      assertions: [
        { describe: "Trust sliver still present after override", handle: "#trust-sliver", expect: "present" },
        { describe: "Accepted marker present", handle: "#trust-sliver .trust-bar-accepted", expect: "present" },
      ],
      screenshots: [shot("trust-override-persists", "The persisting red line after override.")],
      dimension: "D4",
    },
  ),

  // ── D6 — action→effect (SIMULATED at Tier-1) ──
  webTotal(
    "web-total-front-page-set",
    "D6-G1 (simulated): pick a label + Save → the stubbed IRK-signed POST 200s and the picker's status line reflects the new assignment.",
    "gym total webapp set front page reflects the chosen label",
    {
      steps: [
        { kind: "launch", describe: "Reach server-detail; route front-page + services." },
        { kind: "tap", describe: "Pick 'blog' + Save.", handle: "#front-page-save" },
        { kind: "assert", describe: "Status reflects the label.", handle: "#front-page-status" },
      ],
      assertions: [
        { describe: "Front-page status reflects label", handle: "#front-page-status", expect: "text", text: "blog" },
      ],
      screenshots: [shot("front-page-set", "The front-page set confirmation.")],
      dimension: "D6",
    },
  ),
  webTotal(
    "web-total-journal-output",
    "D6-G7 (simulated): View journal signs an owner envelope, POSTs /api/journal, and renders the returned lines.",
    "gym total webapp view journal renders the returned lines",
    {
      steps: [
        { kind: "launch", describe: "Reach server-detail; route /api/journal lines." },
        { kind: "tap", describe: "View journal.", handle: "#journal-fetch-btn" },
        { kind: "assert", describe: "Lines render.", handle: "#journal-output" },
      ],
      assertions: [
        { describe: "Journal output present", handle: "#journal-output", expect: "present" },
        { describe: "Returned line shown", handle: "#journal-output", expect: "text", text: "tunnel connected" },
      ],
      screenshots: [shot("journal-output", "The journal output.")],
      dimension: "D6",
    },
  ),
];

/** The webapp lane of the gym registry (every-merge subset + total tranche). */
export const WEB_GYM_SCENARIOS: readonly Scenario[] = [...EVERY_MERGE, ...TOTAL];
