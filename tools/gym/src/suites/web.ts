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
    "D2-B2: scratch routes through the AI-key step; Flagship Inference is the built-in first row (never deletable), disabled with its reason when unreadable, and no username prompt pops over it.",
    "gym total webapp scratch routes through the AI-key step",
    {
      steps: [
        { kind: "launch", describe: "Reach the chooser." },
        { kind: "tap", describe: "Scratch → AI-key step.", handle: "#build-src-scratch" },
        { kind: "assert", describe: "Built-in Flagship Inference row, disabled with the reason.", handle: "#build-key-free-ai" },
      ],
      assertions: [
        { describe: "AI-key view present", handle: "#view-build-key", expect: "present" },
        { describe: "Built-in Flagship Inference row", handle: "#build-key-free-ai", expect: "text", text: "Flagship Inference" },
        { describe: "Unavailable reason", handle: "#build-key-free-ai-status", expect: "text", text: "isn't available right now" },
        { describe: "No use button while unavailable", handle: "#build-key-free-ai-use", expect: "absent" },
        { describe: "Add-key form opens", handle: "#build-key-form", expect: "present" },
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
    "web-total-greyed-action-ceremony",
    "D3-C1: with no cloud recovery, tapping the greyed Lock-with-passkey routes into the last-device deletion ceremony (typed username gate); backing out sends nothing and keeps the key.",
    "gym total webapp a greyed session action opens the last-device deletion ceremony",
    {
      steps: [
        { kind: "launch", describe: "Reach Settings." },
        { kind: "tap", describe: "Tap the greyed tier-2 action.", handle: "#settings-signout" },
        { kind: "assert", describe: "Deletion ceremony opens, gated on the typed username.", handle: "#view-account-delete" },
        { kind: "type", describe: "Type the username to arm Delete.", handle: "#account-delete-confirm-input" },
        { kind: "tap", describe: "Back out.", handle: "#account-delete-back" },
      ],
      assertions: [
        { describe: "Deletion ceremony", handle: "#view-account-delete", expect: "present" },
        { describe: "Username shown", handle: "#account-delete-username", expect: "text", text: "smoketest" },
        { describe: "Delete armed only by the typed username", handle: "#account-delete-go", expect: "enabled" },
        { describe: "Back on settings (no wipe)", handle: "#view-settings", expect: "present" },
      ],
      screenshots: [shot("deletion-ceremony", "The last-device deletion ceremony, armed but not run.")],
      dimension: "D3",
    },
  ),
  // D3 — AI-keys manager + recovery screen.
  webTotal(
    "web-total-ai-keys-manager",
    "D3-C2: the AI-keys manager lists Flagship Inference first as the built-in provider (no remove), then saved keys masked with their own remove.",
    "gym total webapp settings renders the AI-keys manager",
    {
      steps: [
        { kind: "launch", describe: "Reach Settings." },
        { kind: "assert", describe: "Built-in Flagship Inference card.", handle: "#free-ai-card" },
        { kind: "tap", describe: "Add a provider.", handle: "#add-provider-go" },
        { kind: "type", describe: "Fill label + key.", handle: "#np-key" },
        { kind: "tap", describe: "Save.", handle: "#np-save" },
        { kind: "assert", describe: "Saved key listed after the built-in, masked.", handle: "#providers-list" },
      ],
      assertions: [
        { describe: "Flagship Inference built-in card", handle: "#free-ai-card", expect: "text", text: "Flagship Inference" },
        { describe: "Own-key offer while unavailable", handle: "#free-ai-add-key", expect: "present" },
        { describe: "Add-provider affordance present", handle: "#add-provider-go", expect: "present" },
        { describe: "Saved key listed (masked)", handle: "#providers-list", expect: "text", text: "My OpenAI" },
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
    "D1-A11 / D6-G11: tapping Revoke opens the reversible-revoke confirm (reason radios, un-revoke + name-reserved copy); Cancel sends nothing.",
    "gym total webapp server-detail revoke opens the confirm ceremony",
    {
      steps: [
        { kind: "launch", describe: "Reach server-detail (routed BFF)." },
        { kind: "tap", describe: "Tap Revoke this server.", handle: "#revoke-server-btn" },
        { kind: "assert", describe: "Confirm dialog opens.", handle: 'dialog[aria-label="Revoke server"]' },
        { kind: "tap", describe: "Cancel — no revoke.", handle: "[data-revoke-cancel]" },
      ],
      assertions: [
        { describe: "Revoke confirm dialog opens", handle: 'dialog[aria-label="Revoke server"]', expect: "present" },
        { describe: "Says it can be un-revoked", handle: 'dialog[aria-label="Revoke server"] .modal-message', expect: "text", text: "un-revoke it" },
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
    "D2-B7: a NOT-fit repo states why in plain words and offers 'Use AI to adapt and deploy' + the anonymous-share switch; no Install.",
    "gym total webapp git build offers AI-adapt for a non-fit repo",
    {
      steps: [
        { kind: "launch", describe: "Reach build-git; route /api/build/git → not-fit (no manifest)." },
        { kind: "type", describe: "Paste a repo URL.", handle: "#build-git-url" },
        { kind: "tap", describe: "Check repo.", handle: "#build-git-check" },
        { kind: "assert", describe: "Not-fit verdict + adapt.", handle: "#build-git-adapt" },
      ],
      assertions: [
        { describe: "Plain not-adapted sentence", handle: "#build-git-verdict", expect: "text", text: "not yet adapted for Flagship" },
        { describe: "Adapt button", handle: "#build-git-adapt", expect: "text", text: "Use AI to adapt and deploy" },
        { describe: "Share switch", handle: "#build-git-share", expect: "present" },
        { describe: "No Install for a non-fit repo", handle: "#build-git-deploy", expect: "absent" },
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
    "D2-B3 (edge): a named scratch first turn that gets 200 {needsCredential:true} routes into the AI-key step instead of streaming.",
    "gym total webapp scratch chat needsCredential routes to the AI-key step",
    {
      steps: [
        { kind: "launch", describe: "Reach vibe-code; route name-check → free, /vibe-code/start → needsCredential." },
        { kind: "type", describe: "Type a prompt.", handle: "#vc-prompt" },
        { kind: "type", describe: "Name the app (Build it stays disabled until named).", handle: "#vc-name" },
        { kind: "tap", describe: "Build it.", handle: "#vc-send" },
        { kind: "assert", describe: "Routes to the AI-key step.", handle: "#view-build-key" },
      ],
      assertions: [
        { describe: "Name available", handle: "#vc-name-status", expect: "text", text: "Available" },
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
    "D3-C7: the trusted-devices list renders rows from the signed account directory, decrypting device names client-side (platform + support code when unnamed).",
    "gym total webapp trusted-devices lists the account's devices",
    {
      steps: [
        { kind: "launch", describe: "Reach Home; seed account + device ids; route the signed /api/accounts/<id>/directory." },
        { kind: "assert", describe: "Device rows render.", handle: "#trusted-devices-list" },
      ],
      assertions: [
        { describe: "This device's decrypted name", handle: "#trusted-devices-list", expect: "text", text: "Gym laptop" },
        { describe: "Unnamed phone falls back to platform + code", handle: "#trusted-devices-list", expect: "text", text: "iPhone / iPad · Device K7Q2-9XPM" },
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

  // ── Feature-coverage tranche (gym-features.spec.ts) — transfer-a-box,
  // box-request inbox, multi-pod switcher, create-server Advanced toggles,
  // Slice-D admin-tier client surfaces. All fixture-tier; crypto is REAL
  // (in-page Ed25519) so the client verify paths pass honestly.
  webTotal(
    "web-total-transfer-offer",
    "D1 (transfer-a-box, giver): server-detail's 'Transfer to another account' opens the irreversible-warning ceremony; Create is gated on typing the FQDN; the signed offer (stubbed broker POST) renders the universal transfer link.",
    "gym total webapp transfer offer opens the giver ceremony and renders the code",
    {
      steps: [
        { kind: "launch", describe: "Reach server-detail (routed BFF); stub the .com transfer/offer POST." },
        { kind: "tap", describe: "Transfer to another account.", handle: "#transfer-start-btn" },
        { kind: "assert", describe: "Ceremony opens; Create disabled.", handle: "[data-transfer-go]" },
        { kind: "type", describe: "Type the server's full name.", handle: "[data-transfer-confirm]" },
        { kind: "tap", describe: "Create transfer code (IRK-signed; POST stubbed).", handle: "[data-transfer-go]" },
        { kind: "assert", describe: "The /transfer?o= link renders.", handle: "[data-transfer-qr]" },
      ],
      assertions: [
        { describe: "Transfer ceremony dialog opens", handle: 'dialog[aria-label="Transfer this server"]', expect: "present" },
        { describe: "Create gated until the FQDN is typed", handle: "[data-transfer-go]", expect: "disabled" },
        { describe: "The universal transfer link renders", handle: "[data-transfer-qr]", expect: "present" },
      ],
      screenshots: [
        shot("transfer-confirm-gate", "The type-to-confirm gate."),
        shot("transfer-offer-code", "The rendered transfer link."),
      ],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-transfer-claim",
    "D1 (transfer-a-box, acquirer): Home's Take-over entry opens the paste/scan claim; a pasted offer is signature-verified (real in-page IRK signing) BEFORE the severe type-to-confirm; Cancel — no claim fires.",
    "gym total webapp take-over claim verifies an offer into the severe confirm",
    {
      steps: [
        { kind: "launch", describe: "Reach Home (account open, no servers)." },
        { kind: "tap", describe: "Someone handing you a box? Take over.", handle: "#empty-take-over" },
        { kind: "type", describe: "Paste a REAL signed offer (session-IRK-signed in-page).", handle: "[data-claim-input]" },
        { kind: "tap", describe: "Continue → verify.", handle: "[data-claim-continue]" },
        { kind: "assert", describe: "Severe confirm names the box; Take over gated.", handle: "[data-confirm-go]" },
        { kind: "tap", describe: "Cancel — nothing claimed.", handle: "[data-confirm-cancel]" },
      ],
      assertions: [
        { describe: "Take-over dialog opens", handle: 'dialog[aria-label="Take over a box"]', expect: "present" },
        { describe: "Confirm stage names the box", handle: "[data-confirm-domain]", expect: "text", text: "hali.giver.flagship.services" },
        { describe: "Take over gated until the FQDN is typed", handle: "[data-confirm-go]", expect: "disabled" },
      ],
      screenshots: [
        shot("take-over-input", "The paste/scan input stage."),
        shot("take-over-confirm", "The severe type-to-confirm stage."),
      ],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-box-inbox",
    "D5 (box-request-inbox): a pod's pendingRequests digest renders the Home card as 'waiting for approval' with the one-tap Approve affordance; tapping opens the inbox whose card is STK-re-verified (a real in-page-minted STK signs the request).",
    "gym total webapp box inbox surfaces a pending request and its approve card",
    {
      steps: [
        { kind: "launch", describe: "Reach paired Home; mint a box STK + sign a secret-request in-page; route /pods + /api/secret-requests." },
        { kind: "assert", describe: "The card reads waiting-for-approval + Approve unlock.", handle: "#servers-list" },
        { kind: "tap", describe: "Approve unlock (the one-tap affordance)." },
        { kind: "assert", describe: "The verified request card renders with the approve button.", handle: "#view-boot-approval" },
      ],
      assertions: [
        { describe: "Home card reads waiting for approval", handle: "#servers-list", expect: "text", text: "waiting for approval" },
        { describe: "Box Request Inbox opens", handle: "#view-boot-approval", expect: "present" },
        { describe: "Verified request card with approve affordance", handle: "[data-boot-request-id]", expect: "present" },
      ],
      screenshots: [
        shot("inbox-home-card", "The waiting-for-approval one-tap card."),
        shot("inbox-approve-card", "The STK-verified approve card."),
      ],
      dimension: "D5",
    },
  ),
  webTotal(
    "web-total-pod-switcher",
    "D5 (multi-pod): two seeded pods (one live, one unreachable) render HONEST liveness on Home; the Services PodSwitcher lists All servers + both pods and tapping a chip switches the active pod context (base-URL slot).",
    "gym total webapp pod switcher lists both pods with honest liveness and switches",
    {
      steps: [
        { kind: "launch", describe: "Reach paired Home; route two pods (live + unreachable)." },
        { kind: "assert", describe: "Home cards: online vs offline (last seen …).", handle: "#servers-list" },
        { kind: "tap", describe: "Services tab.", handle: '[data-tab-target="apps"]' },
        { kind: "assert", describe: "Switcher shows All servers + both pods." },
        { kind: "tap", describe: "Tap the unreachable pod's chip → context switches." },
      ],
      assertions: [
        { describe: "Live pod reads online", handle: "#servers-list", expect: "text", text: "online" },
        { describe: "Unreachable pod reads offline (last seen …)", handle: "#servers-list", expect: "text", text: "offline (last seen" },
        { describe: "Pod switcher renders", handle: ".pod-switcher", expect: "present" },
        { describe: "Switching selects the tapped pod's chip", handle: ".pod-switcher-chip.is-selected", expect: "present" },
      ],
      screenshots: [
        shot("multi-pod-home-liveness", "Honest per-pod liveness on Home."),
        shot("pod-switcher-all", "The switcher with All servers selected."),
        shot("pod-switcher-switched", "The switched pod context."),
      ],
      dimension: "D5",
    },
  ),
  webTotal(
    "web-total-cs-advanced-toggles",
    "D4 (one-shot pairing security choices): create-server's Advanced section gates embed-secrets + debug-friendly — hidden + default OFF, each with warning copy; closing Advanced RESETS both so a debug/secret choice can never stay silently armed.",
    "gym total webapp create-server advanced toggles default off with the debug warning",
    {
      steps: [
        { kind: "launch", describe: "Reach the create-server form." },
        { kind: "assert", describe: "Advanced unchecked; options hidden.", handle: "#cs-advanced" },
        { kind: "tap", describe: "Open Advanced.", handle: "#cs-advanced" },
        { kind: "assert", describe: "Both toggles OFF + the debug warning copy.", handle: "#cs-debug-friendly" },
        { kind: "tap", describe: "Arm debug-friendly, then close + reopen Advanced.", handle: "#cs-debug-friendly" },
        { kind: "assert", describe: "The reset rule cleared it.", handle: "#cs-debug-friendly" },
      ],
      assertions: [
        { describe: "Advanced toggle present + default OFF", handle: "#cs-advanced", expect: "present" },
        { describe: "Embed-secrets toggle present", handle: "#cs-embed-secrets", expect: "present" },
        { describe: "Debug-friendly toggle present", handle: "#cs-debug-friendly", expect: "present" },
        { describe: "Debug warning copy renders", handle: "#cs-debug-friendly-hint", expect: "text", text: "physical access" },
      ],
      screenshots: [
        shot("cs-advanced-open", "The opened Advanced section."),
        shot("cs-advanced-reset", "The reset-on-close rule."),
      ],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-admin-root-state",
    "D3 (Slice D §5): account-security's Admin key card reports THIS device's admin standing honestly — non-admin shows the can't-rotate note (no button); an admin device (session.adminRootSeed) shows the warning + the Rotate control.",
    "gym total webapp account-security shows the admin-root state",
    {
      steps: [
        { kind: "launch", describe: "Reach Settings → Account security (routed account-type)." },
        { kind: "assert", describe: "Non-admin: the unavailable card, no rotate.", handle: '[data-account-security-rotate="unavailable"]' },
        { kind: "tap", describe: "Seed session.adminRootSeed; re-render." },
        { kind: "assert", describe: "Admin: the available card + Rotate.", handle: "#account-security-rotate-admin" },
      ],
      assertions: [
        { describe: "Non-admin state card", handle: '[data-account-security-rotate="unavailable"]', expect: "present" },
        { describe: "Admin state card after seeding", handle: '[data-account-security-rotate="available"]', expect: "present" },
        { describe: "Rotate control on an admin device", handle: "#account-security-rotate-admin", expect: "present" },
      ],
      screenshots: [
        shot("admin-root-non-admin", "The non-admin Admin-key card."),
        shot("admin-root-admin", "The admin Admin-key card with Rotate."),
      ],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-rotate-admin-ceremony",
    "D4 (Slice D §5): Rotate admin key opens its ceremony first screen — the revoke-semantic warning + a danger Continue; Cancel signs/rotates nothing (the typed-ROTATE stage + real rotation are the live slice).",
    "gym total webapp rotate admin key opens its warning ceremony",
    {
      steps: [
        { kind: "launch", describe: "Reach Account security as an admin device (seeded adminRootSeed)." },
        { kind: "tap", describe: "Rotate admin key.", handle: "#account-security-rotate-admin" },
        { kind: "assert", describe: "The warning ceremony opens.", handle: ".modal-title" },
        { kind: "tap", describe: "Cancel — nothing rotated.", handle: "[data-modal-cancel]" },
      ],
      assertions: [
        { describe: "Ceremony title", handle: ".modal-title", expect: "text", text: "Rotate admin key?" },
        { describe: "Revoke-semantic warning", handle: ".modal-message", expect: "text", text: "REVOKES admin" },
        { describe: "Admin card intact after Cancel", handle: '[data-account-security-rotate="available"]', expect: "present" },
      ],
      screenshots: [shot("rotate-admin-ceremony", "The rotate warning ceremony (not executed).")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-promote-admin-toggle",
    "D3 (Slice D D-4): the promote-to-admin toggle appears ONLY on an admin device's synchronous add-device SAS ceremony — default OFF with the full-admin-authority warning; a non-admin device omits the section entirely.",
    "gym total webapp add-device offers promote-to-admin only on an admin device",
    {
      steps: [
        { kind: "launch", describe: "Reach add-device as a NON-admin device." },
        { kind: "assert", describe: "No promote section.", handle: '[data-section="promote-admin"]' },
        { kind: "tap", describe: "Seed session.adminRootSeed; re-render." },
        { kind: "assert", describe: "Promote toggle present, default OFF, hard warning.", handle: "#add-device-promote-admin" },
      ],
      assertions: [
        { describe: "Promote section absent on a non-admin device", handle: '[data-section="promote-admin"]', expect: "absent" },
        { describe: "Promote toggle present on an admin device", handle: "#add-device-promote-admin", expect: "present" },
        { describe: "Full-admin-authority warning", handle: '[data-section="promote-admin-warning"]', expect: "text", text: "full admin authority" },
      ],
      screenshots: [
        shot("promote-absent-non-admin", "No promote section on a non-admin device."),
        shot("promote-toggle-admin", "The default-OFF promote toggle + warning."),
      ],
      dimension: "D3",
    },
  ),

  // ── Share this server (docs/share-a-server.md §8) — gym-share.spec.ts ──
  webTotal(
    "web-total-share-owner",
    "Share a server (owner): the server page's Shared with card shows each co-manager's confirm code and activity, sits between Leader and Transfer, and the Share sheet arms only once named, unlock + app-data default off, then shows the https link + QR.",
    "gym share owner card and share sheet",
    {
      steps: [
        { kind: "launch", describe: "Reach the owner's server page (stubbed .com + box)." },
        { kind: "assert", describe: "Shared with card + code + activity.", handle: "#shared-with-card" },
        { kind: "tap", describe: "Share this server.", handle: "#share-server-btn" },
        { kind: "type", describe: "Name who it's for.", handle: "[data-share-label]" },
        { kind: "tap", describe: "Create the link.", handle: "[data-share-create]" },
        { kind: "assert", describe: "https share link + QR.", handle: "[data-share-link]" },
      ],
      assertions: [
        { describe: "Shared with card", handle: "#shared-with-card", expect: "text", text: "Sam" },
        { describe: "Six-digit confirm code", handle: "#shared-with-card [data-share-sas]", expect: "present" },
        { describe: "Share sheet", handle: 'dialog[aria-label="Share this server"]', expect: "present" },
        { describe: "Unlock-at-boot defaults off", handle: "[data-share-unlock]", expect: "present" },
        { describe: "Link QR", handle: "[data-share-qr] svg", expect: "present" },
      ],
      screenshots: [
        shot("owner-shared-with", "The owner's Shared with card."),
        shot("share-sheet-form", "The Share sheet before creating."),
        shot("share-sheet-link", "The Share sheet with the link + QR."),
      ],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-share-member-accept",
    "Share a server (co-manager): opening a share link shows the offer, accepting shows the six-digit code and waits for the owner to confirm.",
    "gym share member accepts a link and reads the code",
    {
      steps: [
        { kind: "launch", describe: "Open the share link's accept view (stubbed offer)." },
        { kind: "assert", describe: "Offer shown.", handle: "#share-accept-content" },
        { kind: "tap", describe: "Accept." },
        { kind: "assert", describe: "Code + waiting for the owner.", handle: "[data-share-waiting]" },
      ],
      assertions: [
        { describe: "Offer names the server", handle: "#share-accept-content", expect: "text", text: "home is shared with you" },
        { describe: "Six-digit code", handle: "[data-share-sas]", expect: "present" },
        { describe: "Waiting for the owner", handle: "[data-share-waiting]", expect: "text", text: "Waiting for the owner to confirm" },
      ],
      screenshots: [shot("member-offer", "The share offer."), shot("member-code", "The code, waiting for the owner.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-share-member-server",
    "Share a server (co-manager): Home lists Shared with me with honest status; the shared server page offers the start-up unlock and app access editing but none of the owner-only cards (transfer, danger zone, power, sharing, update).",
    "gym share member home and shared server page",
    {
      steps: [
        { kind: "launch", describe: "Reach Home as the co-manager (sealed inbox entries)." },
        { kind: "assert", describe: "Shared with me section.", handle: "#shared-with-me" },
        { kind: "tap", describe: "Open the shared server.", handle: "[data-open-share]" },
        { kind: "assert", describe: "Shared server page without owner-only cards.", handle: "#view-shared-server" },
        { kind: "type", describe: "Edit an app's access list.", handle: '[data-access-editor="notes"] textarea' },
      ],
      assertions: [
        { describe: "Shared with me", handle: "#shared-with-me", expect: "text", text: "Shared with me" },
        { describe: "Start-up unlock card", handle: "#shared-startup-card", expect: "text", text: "Unlock it?" },
        { describe: "Level shown", handle: "#shared-server-sub", expect: "text", text: "Can manage" },
        { describe: "No transfer card", handle: "#view-shared-server #transfer-card", expect: "absent" },
        { describe: "No danger zone", handle: "#view-shared-server #danger-zone-card", expect: "absent" },
      ],
      screenshots: [shot("member-home", "Shared with me on Home."), shot("member-server-page", "The shared server page.")],
      dimension: "D1",
    },
  ),
  // ── Servers: order + Leader badge, update card, un-revoke / delete — gym-servers.spec.ts ──
  webTotal(
    "web-total-server-order-drag",
    "Server order (docs/server-order.md): dragging a server by its handle reorders Home at once (badge gray mid-drag), signs a flagship/server-order/v1 with the IRK and posts it to .com; the new leader's badge stays gray ('Leader, waiting for the server to confirm') until the box answers the hand-delivered order. Add/connect a server sits above the list. Mirrors iOS home-add-server / sd-leader-pending, Android home-add-server / leader-badge / leader-badge-pending.",
    "gym servers home drag reorders and the leader badge stays gray until the leader confirms",
    {
      steps: [
        { kind: "launch", describe: "Reach Home with three servers (stubbed /api/me/servers + /pods with a saved order the leader holds)." },
        { kind: "assert", describe: "Green Leader badge on the first online server.", handle: "[data-order-leader]" },
        { kind: "tap", describe: "Drag office's handle above home.", handle: ".js-order-handle" },
        { kind: "assert", describe: "Signed order posted; office leads with a gray badge.", handle: "[data-order-leader-pending]" },
        { kind: "assert", describe: "Office box answers heldIssuedAt; badge turns green.", handle: "[data-order-leader]" },
      ],
      assertions: [
        { describe: "Add/connect a server above the list", handle: "#home-add-server", expect: "text", text: "Add/connect a server" },
        { describe: "List is reorderable", handle: "#servers-list [data-server-cards][data-reorderable]", expect: "present" },
        { describe: "Leader badge", handle: "#servers-list [data-order-leader]", expect: "text", text: "Leader" },
        { describe: "Gray until confirmed", handle: "#servers-list [data-order-leader-pending]", expect: "present" },
      ],
      screenshots: [
        shot("order-confirmed", "The saved order, leader confirmed."),
        shot("order-dragging", "Mid-drag: draft order, badge gray."),
        shot("order-leader-pending", "New leader waiting for the box to confirm."),
        shot("order-leader-confirmed", "The box confirmed the order."),
      ],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-server-order-revert",
    "Server order: a down first server leaves the next online one leading ('standing in for media'); the keyboard step 'Move office up' saves at once, and when .com answers 409 (a newer order from another device) the toast says so and the previous order comes back.",
    "gym servers home keyboard reorder reverts when another device saved a newer order",
    {
      steps: [
        { kind: "launch", describe: "Reach Home; saved order media(offline), home, office; .com answers the save 409." },
        { kind: "assert", describe: "Home leads, standing in for media.", handle: "[data-order-leader]" },
        { kind: "tap", describe: "Focus 'Move office up' and press Enter.", handle: ".js-order-up" },
        { kind: "assert", describe: "409 toast; order reverts.", handle: "#toast" },
      ],
      assertions: [
        { describe: "Standing-in subtitle", handle: "#servers-list", expect: "text", text: "standing in for media" },
        { describe: "Newer-order toast", handle: "#toast", expect: "text", text: "Your server order changed on another device" },
        { describe: "Leader back on home", handle: "#servers-list [data-order-leader]", expect: "text", text: "Leader" },
      ],
      screenshots: [shot("order-standing-in", "Leader standing in for a down server."), shot("order-reverted", "The order put back after a 409.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-server-update-card",
    "Update card: shows the running commit and the box's last-update verdict (a rollback in plain words), the release note from the box's own release list, and 'Update to latest' signs an UpdateOrder (from/target commits) to .com's update lane; the card then shows the pending order instead of the button. Mirrors iOS sd-update-last-outcome / sd-update-available / sd-update-server / update-latest-btn / sd-update-pending.",
    "gym servers update card shows the last update and orders the latest release",
    {
      steps: [
        { kind: "launch", describe: "Reach server-detail; box reports currentCommit + lastUpdate (rolled-back) + a newer release." },
        { kind: "assert", describe: "Last update verdict + release note.", handle: "#update-last-outcome" },
        { kind: "tap", describe: "Update to latest.", handle: "#update-server-btn" },
        { kind: "tap", describe: "Order the latest release.", handle: "#update-latest-btn" },
        { kind: "tap", describe: "Done.", handle: "[data-update-cancel]" },
        { kind: "assert", describe: "Pending order replaces the button.", handle: "#update-pending" },
      ],
      assertions: [
        { describe: "Rollback verdict", handle: "#update-last-outcome", expect: "text", text: "didn't start cleanly" },
        { describe: "Release note", handle: "#update-available", expect: "text", text: "New release available: v1.4.0" },
        { describe: "Pending order shown", handle: "#update-pending", expect: "text", text: "Update to v1.4.0 sent" },
        { describe: "Button hidden while pending", handle: "#update-server-btn", expect: "absent" },
      ],
      screenshots: [
        shot("update-card", "The update card with the last update + release note."),
        shot("update-dialog", "The update dialog."),
        shot("update-pending", "The pending order on the card."),
      ],
      dimension: "D6",
    },
  ),
  webTotal(
    "web-total-server-unrevoke",
    "Reversible revoke: a revoked server's page says it can't connect until un-revoked and offers Un-revoke in place of Revoke; Un-revoke posts an IRK-signed flagship/server-unrevoke request, toasts the restore, and the page flips back to 'Revoke server (reversible)'. Mirrors iOS sd-unrevoke-server / server-detail-revoked.",
    "gym servers un-revoke restores a revoked server",
    {
      steps: [
        { kind: "launch", describe: "Reach server-detail for a server /pods reports revoked (lost)." },
        { kind: "assert", describe: "Revoked note + Un-revoke.", handle: "#unrevoke-server-btn" },
        { kind: "tap", describe: "Un-revoke.", handle: "#unrevoke-server-btn" },
        { kind: "assert", describe: "Restored; Revoke is back.", handle: "#revoke-server-btn" },
      ],
      assertions: [
        { describe: "Revoked note", handle: "[data-detail-unreachable]", expect: "text", text: "This server is revoked" },
        { describe: "Restore toast", handle: "#toast", expect: "text", text: "Server restored" },
        { describe: "Reversible Revoke back", handle: "#revoke-server-btn", expect: "text", text: "Revoke server (reversible)" },
      ],
      screenshots: [shot("revoked-server", "A revoked server's page."), shot("unrevoked-server", "After Un-revoke.")],
      dimension: "D1",
    },
  ),
  webTotal(
    "web-total-server-delete",
    "Delete a server: 'Delete and wipe this server' opens a typed-name gate (Delete stays disabled until the server's name is typed); confirming deposits a wipe-now decommission order for the box key, then releases the name, toasts, and Home no longer lists it. All .com calls are stubbed. Mirrors iOS sd-delete-server / delete-server-name-field / delete-server-confirm, Android delete-server-dialog / delete-server-confirm.",
    "gym servers delete a revoked server behind the typed-name gate",
    {
      steps: [
        { kind: "launch", describe: "Reach server-detail for a revoked (stolen) server; stub decommission + release." },
        { kind: "tap", describe: "Delete and wipe this server.", handle: "#delete-server-btn" },
        { kind: "type", describe: "Type a wrong name, then the server's name.", handle: "[data-delete-input]" },
        { kind: "tap", describe: "Delete server.", handle: "[data-delete-go]" },
        { kind: "assert", describe: "Deleted toast; Home without it.", handle: "#servers-list" },
      ],
      assertions: [
        { describe: "Delete dialog", handle: 'dialog[aria-label="Delete server"]', expect: "present" },
        { describe: "Deleted toast", handle: "#toast", expect: "text", text: "Deleted media" },
        { describe: "Gone from Home", handle: '#servers-list [data-open-fqdn="media.smoketest.flagship.services"]', expect: "absent" },
      ],
      screenshots: [shot("delete-confirm", "The typed-name gate, armed."), shot("deleted-home", "Home after the delete.")],
      dimension: "D1",
      destructive: { destructive: true, demoUsername: "smoketest" },
    },
  ),
  // ── The app page: access control + ranks, internet access, API keys, Database, Runs on — gym-apps.spec.ts ──
  webTotal(
    "web-total-apps-access-control",
    "App access control (docs/service-access-gating.md 'Open mode + members'): Members (n) lists each person/group with its rank; Members only asks once and sends an IRK-signed flagship/service-access-mode/v1; raising a member to Master signs flagship/app-member-role/v1 (target invite:<id>) and shows the crown; the list never changes with the mode. iOS: service-access-restrict-toggle, service-access-mode-status, service-access-members-title.",
    "gym apps access control goes members-only and sets a rank with signed orders",
    {
      steps: [
        { kind: "launch", describe: "Reach the app page (stubbed box + sealed .com invites), open Access control.", handle: "#sd-access" },
        { kind: "assert", describe: "Members (2) with each rank; open mode note.", handle: "#sa-members-title" },
        { kind: "tap", describe: "Members only, confirm.", handle: '#sa-mode [data-mode="restricted"]' },
        { kind: "tap", describe: "Raise Sam to Master.", handle: 'select[data-action="sa-role"]' },
        { kind: "assert", describe: "Signed mode + role orders verified against this browser's keys.", handle: "#sa-mode-status" },
      ],
      assertions: [
        { describe: "Members count", handle: "#sa-members-title", expect: "text", text: "Members (2)" },
        { describe: "Members-only note", handle: "#sa-mode-status", expect: "text", text: "Only members and you can open it" },
        { describe: "Master wears the crown", handle: ".sa-crown", expect: "present" },
      ],
      screenshots: [shot("access-control-open", "Access control, open to all."), shot("access-control-ranks", "Members only, Sam as Master.")],
      dimension: "D6",
    },
  ),
  webTotal(
    "web-total-apps-access-requests",
    "App internet access (§3a): pending hosts show why (tried N times / asked at install); Allow and Deny each put the rule on top of the list and send it signed (flagship/app-access/v1 over the list's sha256); the rule count follows. iOS: service-detail-access-allow / -deny / -pending / -rules.",
    "gym apps internet access requests are allowed and denied with a signed access list",
    {
      steps: [
        { kind: "launch", describe: "Reach the app page with two pending hosts." },
        { kind: "tap", describe: "Allow api.openai.com.", handle: '[data-access-act="allow"]' },
        { kind: "tap", describe: "Deny tracker.example.com.", handle: '[data-access-act="deny"]' },
        { kind: "assert", describe: "Signed lists verified; requests gone; 3 rules.", handle: "#sd-access-count" },
      ],
      assertions: [
        { describe: "Rule count after both answers", handle: "#sd-access-count", expect: "text", text: "3 rules" },
        { describe: "No pending requests left", handle: "[data-access-host]", expect: "absent" },
      ],
      screenshots: [shot("access-requests", "Two hosts waiting."), shot("access-answered", "Both answered.")],
      dimension: "D6",
    },
  ),
  webTotal(
    "web-total-apps-access-list-editor",
    "App access list editor: a suggested list (host + why) opens in Review with the draft note; a bad line is flagged by number and Save goes off; Save signs the NORMALIZED list (flagship/app-access/v1) and clears the draft. iOS: access-list-editor, access-list-errors, access-list-save, service-detail-access-draft-review.",
    "gym apps access list editor reviews a suggested list, flags bad lines and saves it signed",
    {
      steps: [
        { kind: "launch", describe: "Reach the app page with a suggested list." },
        { kind: "tap", describe: "Review the suggestion.", handle: '[data-access-draft-act="review"]' },
        { kind: "type", describe: "Add a line with a scheme (invalid).", handle: "#app-access-text" },
        { kind: "type", describe: "Fix it (trailing spaces, blank line).", handle: "#app-access-text" },
        { kind: "tap", describe: "Save.", handle: "#app-access-save" },
      ],
      assertions: [
        { describe: "Draft card", handle: "[data-access-draft]", expect: "text", text: "This app suggests letting it reach these hosts" },
        { describe: "Line error while invalid", handle: "#app-access-errors", expect: "text", text: "Line 3" },
        { describe: "Save off after saving", handle: "#app-access-save", expect: "disabled" },
      ],
      screenshots: [
        shot("access-draft-card", "The suggested-list card."),
        shot("access-editor-error", "A bad line flagged."),
        shot("access-editor-saved", "Saved."),
      ],
      dimension: "D6",
    },
  ),
  webTotal(
    "web-total-apps-api-keys",
    "App API keys (docs/app-apis.md §3): an unnamed key is refused before signing; Create signs flagship/app-api-key/v1 (random 16-hex keyId, scope read, expiresAt 0); the secret shows once with the copy warning and is gone after Done; Revoke confirms then DELETEs. iOS: api-key-label, api-key-scope, api-key-secret, api-key-shown-once-warning, service-detail-api-key-revoke.",
    "gym apps API key is created signed, its secret shown once, and a key revoked",
    {
      steps: [
        { kind: "launch", describe: "Reach the app page with one existing key." },
        { kind: "tap", describe: "Create key with no name (refused).", handle: "#sd-api-key-go" },
        { kind: "type", describe: "Name it.", handle: "#sd-api-key-label" },
        { kind: "tap", describe: "Create key.", handle: "#sd-api-key-go" },
        { kind: "tap", describe: "Done.", handle: "#sd-api-key-done" },
        { kind: "tap", describe: "Revoke the old key, confirm.", handle: "[data-api-key-revoke]" },
      ],
      assertions: [
        { describe: "Name required", handle: "#sd-api-key-error", expect: "text", text: "Give the key a name" },
        { describe: "Secret gone after Done", handle: "#sd-api-key-secret", expect: "absent" },
        { describe: "Revoked key gone", handle: '[data-api-key="0123456789abcdef"]', expect: "absent" },
      ],
      screenshots: [shot("api-key-revealed", "The new key, shown once."), shot("api-key-revoked", "After revoking the old key.")],
      dimension: "D6",
    },
  ),
  webTotal(
    "web-total-apps-database",
    "App Database (docs/app-apis.md §6): the entry counts tables; tables list rows/size and views; a table pages read-only (NULL shown); a writing statement first runs unsigned, gets needsGrant, and runs only after Confirm and run signs flagship/app-db-write/v1 over the SQL's sha256. iOS: service-detail-open-database, database-confirm-write, database-confirm-run, database-query-summary.",
    "gym apps database browses read-only and a write runs only after a signed confirm",
    {
      steps: [
        { kind: "launch", describe: "Reach the app page; open the database.", handle: "#sd-db-open" },
        { kind: "tap", describe: "Open the items table.", handle: '[data-db-table="items"]' },
        { kind: "type", describe: "Run SQL: an UPDATE.", handle: "#app-db-sql-text" },
        { kind: "tap", describe: "Run (read-only attempt).", handle: "#app-db-run" },
        { kind: "tap", describe: "Confirm and run (signed).", handle: "#app-db-confirm" },
      ],
      assertions: [
        { describe: "Page range", handle: "#app-db-range", expect: "text", text: "Rows 1–2 of 2" },
        { describe: "Needs-grant prompt", handle: "[data-db-needs-grant]", expect: "text", text: "This changes data" },
        { describe: "Signed write ran", handle: "[data-db-result]", expect: "text", text: "UPDATE · 1 row" },
      ],
      screenshots: [
        shot("db-table", "A table page."),
        shot("db-needs-grant", "The write asks to confirm."),
        shot("db-write-ran", "The signed write ran."),
      ],
      dimension: "D6",
    },
  ),
  webTotal(
    "web-total-apps-runs-on",
    "Runs on (docs/app-placement.md §4-§5): the only copy is ticked and locked, a server without a session here is unknown and never ticked; ticking signs flagship/app-copy/v1 and POSTs it to the TARGET box with its own session, shows Copying… until the target lists the app; unticking confirms and sends the signed uninstall (flagship/uninstall-service/v1) to that box only. iOS: runs-on-<fqdn>, runs-on-state-<fqdn>, runs-on-message.",
    "gym apps runs-on ticks a copy to another server and unticks it with a signed uninstall",
    {
      steps: [
        { kind: "launch", describe: "Reach the app page; three servers in /pods (one without a session)." },
        { kind: "tap", describe: "Tick media.", handle: '[data-runs-on-toggle="media.smoketest.flagship.services"]' },
        { kind: "assert", describe: "Copying… then ticked once media lists the app." },
        { kind: "tap", describe: "Untick media, confirm.", handle: '[data-runs-on-toggle="media.smoketest.flagship.services"]' },
      ],
      assertions: [
        { describe: "Only copy locked", handle: '[data-runs-on-toggle="home.smoketest.flagship.services"]', expect: "disabled" },
        { describe: "Unknown server never ticked", handle: '[data-runs-on-toggle="attic.smoketest.flagship.services"]', expect: "disabled" },
      ],
      screenshots: [
        shot("runs-on", "Runs on before."),
        shot("runs-on-copying", "Copying to media."),
        shot("runs-on-removed", "Removed from media."),
      ],
      dimension: "D6",
    },
  ),
  webTotal(
    "web-total-apps-backup",
    "App Back up now (as iOS/Android since f1322d18): the start POST carries the data toggle and the password (left out when empty); the archive is fetched ONCE from /api/backups/<id> on the same box with the x-flagship-session header, held as a Blob, and Save hands over a <slug>-backup-<date>.tar.gz.enc with the exact bytes without asking the box again; an archive the box no longer holds says so and leaves nothing to save. iOS: service-detail-backup-data, service-detail-backup-now, service-detail-backup-save.",
    "gym apps backup packs the app and saves the archive fetched once with the session",
    {
      steps: [
        { kind: "launch", describe: "Reach the app page." },
        { kind: "tap", describe: "Include the app's data.", handle: "#sd-include-data" },
        { kind: "type", describe: "Password to encrypt it.", handle: "#sd-password" },
        { kind: "tap", describe: "Back up now.", handle: "#sd-backup-go" },
        { kind: "tap", describe: "Save backup (download).", handle: "#sd-backup-save" },
        { kind: "tap", describe: "Back up now again; the box no longer has it.", handle: "#sd-backup-go" },
      ],
      assertions: [
        { describe: "Ready line", handle: "[data-backup-ready]", expect: "text", text: "Ready: 2 KB, encrypted" },
        { describe: "Gone backup explained", handle: "[data-backup-error]", expect: "text", text: "The server no longer has that backup" },
        { describe: "Nothing to save after a failure", handle: "#sd-backup-save", expect: "absent" },
      ],
      screenshots: [shot("app-backup-ready", "The archive fetched, ready to save."), shot("app-backup-gone", "A backup the box no longer holds.")],
      dimension: "D6",
    },
  ),

  // ── Flagship Inference in Settings + the build chat (gym-inference.spec.ts) ──
  webTotal(
    "web-total-inference-settings-card",
    "Flagship Inference in Settings (iOS/Android free-ai-card, free-ai-status): with a readable status the built-in card is listed first and active with no key saved, shows '1,840 free credits left · 500 added each week', has no remove, mounts its default-model menu from the catalog, and every status read is IRK-signed with the account's username.",
    "gym inference settings lists Flagship Inference first with the credits line",
    {
      steps: [
        { kind: "launch", describe: "Reach Home with a seeded username; route /api/free-ai/status + /api/inference/models." },
        { kind: "tap", describe: "Settings → AI keys.", handle: "#settings-tab-providers" },
        { kind: "assert", describe: "Built-in card with the credits line.", handle: "#free-ai-card" },
      ],
      assertions: [
        { describe: "Credits line", handle: "#free-ai-line", expect: "text", text: "1,840 free credits left · 500 added each week" },
        { describe: "Active with no key saved", handle: "#free-ai-use", expect: "text", text: "active" },
        { describe: "Default-model menu on the catalog default", handle: "#free-ai-default-model .mm-trigger-text", expect: "text", text: "Low 1×" },
        { describe: "No remove on the built-in entry", handle: '#free-ai-card [data-action="remove"]', expect: "absent" },
      ],
      screenshots: [shot("settings-free-ai", "The Flagship Inference card with credits.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-inference-refusals",
    "Flagship Inference refusals (iOS/Android free-ai-status, free-ai-add-key / free-ai-add-own-key): used up, no running server, busy today and ended each show their exact sentence, stay listed but can't be chosen, and offer the own-key route except for no-server.",
    "gym inference settings shows each refusal in its own words",
    {
      steps: [
        { kind: "launch", describe: "Reach Settings → AI keys; route the status per case." },
        { kind: "assert", describe: "Each refusal's sentence, re-rendered per status.", handle: "#free-ai-line" },
      ],
      assertions: [
        { describe: "Used up", handle: "#free-ai-line", expect: "text", text: "You've used this week's Flagship Inference credits." },
        { describe: "No server: no own-key offer", handle: "#free-ai-line", expect: "text", text: "starts once one of your servers is running" },
        { describe: "Ended", handle: "#free-ai-line", expect: "text", text: "The free building period has ended" },
        { describe: "Not choosable while refused", handle: "#free-ai-use", expect: "absent" },
      ],
      screenshots: [
        shot("refusal-used-up", "Used up."),
        shot("refusal-no-server", "No running server."),
        shot("refusal-busy-today", "Busy today."),
        shot("refusal-ended", "Ended."),
      ],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-inference-auto-use",
    "AI-key step with no saved key and credits left skips straight to the chat on Flagship Inference ('Using Flagship Inference', iOS build-key-use-free-ai); the model menu (iOS model-menu-<id>) starts on the catalog default, a picked model rides the start with a pass freshly minted for THIS box, and a reply shows 'used 2.8 credits' (iOS vibecode-credits, Android message-credits).",
    "gym inference AI-key step builds on Flagship Inference straight away with no saved key",
    {
      steps: [
        { kind: "launch", describe: "Reach Home; route status, token, catalog and the box's name-check/start/session." },
        { kind: "tap", describe: "Services → Build → Start from scratch.", handle: "#build-src-scratch" },
        { kind: "assert", describe: "Chat opens on Flagship Inference, menu on Low 1×.", handle: "#vc-model-bar" },
        { kind: "tap", describe: "Pick High 3.5× from the menu.", handle: '#vc-model-bar [data-mm-model="high"]' },
        { kind: "type", describe: "Prompt + name.", handle: "#vc-name" },
        { kind: "tap", describe: "Build it.", handle: "#vc-send" },
        { kind: "assert", describe: "Start body carries model + pass; reply credits line.", handle: ".vc-msg-credits" },
      ],
      assertions: [
        { describe: "Auto-use toast", handle: "#toast", expect: "text", text: "Using Flagship Inference" },
        { describe: "Chosen model on the trigger", handle: "#vc-model-bar .mm-trigger-text", expect: "text", text: "High 3.5×" },
        { describe: "Credits under the reply", handle: "#vc-messages .vc-msg-credits", expect: "text", text: "used 2.8 credits" },
      ],
      screenshots: [
        shot("chat-on-flagship", "The chat on Flagship Inference."),
        shot("model-menu-open", "The Flagship Inference model menu."),
        shot("reply-credits", "A reply with its credits line."),
      ],
      dimension: "D2",
    },
  ),
  webTotal(
    "web-total-inference-reply-choice",
    "The model choice is per message: after the AI asks a question the owner switches to Medium and turns on Think harder (iOS model-menu-think-harder); the reply carries model 'medium' + effort 'high' and a fresh pass, and each reply shows its own credits line.",
    "gym inference each reply carries the model choice made for it",
    {
      steps: [
        { kind: "launch", describe: "Start a Flagship Inference build that pauses on a talkToUser question." },
        { kind: "tap", describe: "Switch to Medium 1×.", handle: '#vc-model-bar [data-mm-model="medium"]' },
        { kind: "tap", describe: "Think harder.", handle: "#vc-model-bar [data-mm-think]" },
        { kind: "type", describe: "Answer.", handle: "#vc-prompt" },
        { kind: "tap", describe: "Send.", handle: "#vc-send" },
      ],
      assertions: [
        { describe: "AI asked a question", handle: "#vc-status", expect: "text", text: "The AI has a question" },
        { describe: "Medium on the trigger", handle: "#vc-model-bar .mm-trigger-text", expect: "text", text: "Medium 1×" },
        { describe: "Ready after the reply", handle: "#vc-status", expect: "text", text: "Ready to deploy" },
      ],
      screenshots: [shot("reply-think-harder", "Medium + Think harder before replying."), shot("reply-sent", "After the reply, with credits per message.")],
      dimension: "D2",
    },
  ),
  webTotal(
    "web-total-inference-beside-saved-key",
    "AI-key step with a saved key (Android build-key-free-ai, iOS build-key-use-free-ai): Flagship Inference is the first row with the credits line and no delete, the saved key follows masked with its own delete, nothing is minted until the owner chooses, and choosing it mints a pass, opens the chat and marks it last used.",
    "gym inference AI-key step offers Flagship Inference beside a saved key",
    {
      steps: [
        { kind: "launch", describe: "Reach Home; save an OpenAI key on this device; route status/token/catalog." },
        { kind: "tap", describe: "Start from scratch.", handle: "#build-src-scratch" },
        { kind: "assert", describe: "Free row first, saved key second.", handle: "#build-key-saved" },
        { kind: "tap", describe: "Use Flagship Inference.", handle: "#build-key-free-ai-use" },
      ],
      assertions: [
        { describe: "Free row credits line", handle: "#build-key-free-ai-status", expect: "text", text: "1,840 free credits left · 500 added each week" },
        { describe: "Saved key masked", handle: "#build-key-saved", expect: "text", text: "sk-g••••cdef" },
        { describe: "Chat on the catalog default", handle: "#vc-model-bar .mm-trigger-text", expect: "text", text: "Low 1×" },
      ],
      screenshots: [shot("build-key-with-saved", "The AI-key step with a saved key.")],
      dimension: "D2",
    },
  ),
  webTotal(
    "web-total-inference-attachments",
    "Build chat attachments (iOS chat-attach / chat-attach-error / chat-attach-notice, Android attachment-notice / attachment-remove): CSV, PDF and an image stage as chips; invalid JSON and an .exe are refused in the box's words; sample data adds the test-copy notice; a chip can be removed; a text-only model offers the multimodal switch for the image; start carries exactly the staged attachments and the switched model.",
    "gym inference attachments stage, refuse what the box would, and ride the start",
    {
      steps: [
        { kind: "launch", describe: "Open the chat on Flagship Inference; pick text-only Medium." },
        { kind: "type", describe: "Attach plants.csv, broken.json, care.pdf, setup.exe, mockup.png.", handle: "#vc-attach-input" },
        { kind: "tap", describe: "Remove then re-add care.pdf.", handle: ".vc-chip-x" },
        { kind: "tap", describe: "Build it → accept the switch to the multimodal model.", handle: "[data-modal-ok]" },
      ],
      assertions: [
        { describe: "Refusals", handle: "#vc-attach-error", expect: "text", text: "isn't valid JSON" },
        { describe: "Sample-data notice", handle: "#vc-attach-notice", expect: "text", text: "Sample data goes only to the private test copy." },
        { describe: "Switched to the multimodal model", handle: "#vc-model-bar .mm-trigger-text", expect: "text", text: "Medium multimodal 2×" },
      ],
      screenshots: [shot("attachments-staged", "Staged chips + refusals + notice."), shot("vision-switch", "The switch-model offer for an image.")],
      dimension: "D2",
    },
  ),
  webTotal(
    "web-total-inference-notification-chat",
    "An AI-needs-you notification (?view=vibecode-chat&sessionId=…&server=…) opens the build chat on the server holding the session, not the current one: the env-var card asks for the value, /env/set goes to that box signed with its serverId, and the ack carries a fresh Flagship Inference pass minted for that box plus the session's model on the menu (iOS VibeCodeSessionScreen, Android vibecode chat).",
    "gym inference a notification opens the build chat on the session's server",
    {
      steps: [
        { kind: "launch", describe: "Reach Home on Home; pair Office too; this device started gym-sess-9 on free AI." },
        { kind: "assert", describe: "The link opens the build chat at the env-var request.", handle: "#vc-envvar" },
        { kind: "type", describe: "Paste the value.", handle: "#vc-envvar-value" },
        { kind: "tap", describe: "Send value.", handle: "#vc-envvar-send" },
      ],
      assertions: [
        { describe: "AI waiting", handle: "#vc-status", expect: "text", text: "The AI has a question" },
        { describe: "The session's model on the menu", handle: "#vc-model-bar .mm-trigger-text", expect: "text", text: "Medium 1×" },
      ],
      screenshots: [shot("notification-chat", "The build chat opened from a notification.")],
      dimension: "D2",
    },
  ),
  webTotal(
    "web-total-inference-notification-find-server",
    "A chat link with only a session id asks the current server first, then the account's other servers, and opens the chat on the one that holds the session.",
    "gym inference a link without a server finds the one holding the session",
    {
      steps: [
        { kind: "launch", describe: "Reach Home on Home; pair Office, which holds gym-sess-9." },
        { kind: "assert", describe: "The chat opens on Office at the env-var request.", handle: "#vc-envvar" },
      ],
      assertions: [{ describe: "Env-var card", handle: "#vc-envvar", expect: "text", text: "WEATHER_API_KEY" }],
      screenshots: [shot("notification-chat-found", "The chat found on the other server.")],
      dimension: "D2",
    },
  ),

  // ── Browser remote, QR-first (remote.<apex>) — gym-remote.spec.ts ──
  webTotal(
    "web-total-remote-qr-first",
    "Remote: remote.<apex> shows the QR at once — https://<apex>/remote?s=<relay sid>&k=<browser X25519> on the same /qr-pipe session it joined as the browser — with nothing to type, no account named and no /pods read; every entry path is the ceremony.",
    "gym remote shows the QR at once and asks for no account",
    {
      steps: [
        { kind: "launch", describe: "Open https://remote.flagshipserver.com/ (webapp tree routed onto the remote origin; /qr-pipe is a routed WebSocket)." },
        { kind: "assert", describe: "QR rendered immediately.", handle: "#dock-qr svg" },
        { kind: "tap", describe: "Copy link for the phone (the link the QR encodes).", handle: "#dock-copy" },
        { kind: "assert", describe: "No code yet, no input, no /pods request.", handle: "#dock-code-step" },
        { kind: "launch", describe: "Open /?view=settings on the remote origin — still the ceremony." },
      ],
      assertions: [
        { describe: "Remote view", handle: "#view-dock-start", expect: "present" },
        { describe: "QR", handle: "#dock-qr svg", expect: "present" },
        { describe: "No code before a phone joins", handle: "#dock-code-step", expect: "absent" },
        { describe: "Nothing to type", handle: "#view-dock-start input", expect: "absent" },
      ],
      screenshots: [shot("remote-qr", "The remote page's QR, before a phone joins.")],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-remote-code-and-redeem",
    "Remote: when the phone joins, the page shows the same 6-digit code (iOS companion-dock-match-code ↔ #dock-code); the phone's sealed flagship/remote-ticket/v1 is opened and redeemed only on the server it names, leaving a keyless companion profile.",
    "gym remote shows the phone's code and redeems the sealed ticket on the named server",
    {
      steps: [
        { kind: "launch", describe: "Open the remote page; read the approval link." },
        { kind: "tap", describe: "Simulated phone (real X25519/HKDF/AES-GCM) sends peer-hello through the relay." },
        { kind: "assert", describe: "Matching 6-digit code + waiting status.", handle: "#dock-code" },
        { kind: "tap", describe: "Phone delivers the sealed ticket." },
        { kind: "assert", describe: "POST /api/companion/redeem on that server; lands on Home as a companion.", handle: "#view-home" },
      ],
      assertions: [
        { describe: "Code shown", handle: "#dock-code-step", expect: "present" },
        { describe: "Waiting for the phone", handle: "#dock-status", expect: "text", text: "Waiting for approval on your phone" },
        { describe: "Connected to Home", handle: "#view-home", expect: "present" },
      ],
      screenshots: [
        shot("remote-code", "The matching code while the phone approves."),
        shot("remote-connected", "Home after the ticket was redeemed."),
      ],
      dimension: "D3",
    },
  ),
  webTotal(
    "web-total-remote-refuses-foreign-server",
    "Remote (security): a ticket naming a server outside the data apex is refused with a plain message and Start again; nothing is redeemed anywhere.",
    "gym remote refuses a ticket naming a server off the data apex",
    {
      steps: [
        { kind: "launch", describe: "Open the remote page; phone joins." },
        { kind: "tap", describe: "Phone delivers a ticket for https://home.smoketest.example.com." },
        { kind: "assert", describe: "Refusal + Start again; no redeem request.", handle: "#dock-status" },
      ],
      assertions: [
        { describe: "Refusal", handle: "#dock-status", expect: "text", text: "won't connect to" },
        { describe: "Start again", handle: "#dock-restart", expect: "present" },
      ],
      screenshots: [shot("remote-refused", "The refused ticket.")],
      dimension: "D4",
    },
  ),
  webTotal(
    "web-total-remote-expired-fresh-qr",
    "Remote: when the relay session expires the page quietly opens a new one — new session id and browser key in a fresh QR, no error.",
    "gym remote replaces an expired code with a fresh QR",
    {
      steps: [
        { kind: "launch", describe: "Open the remote page; read the approval link." },
        { kind: "tap", describe: "Relay sends {kind:\"expired\"}." },
        { kind: "assert", describe: "A second relay session + a different link; no error.", handle: "#dock-qr svg" },
      ],
      assertions: [
        { describe: "Fresh QR", handle: "#dock-qr svg", expect: "present" },
        { describe: "No Start again", handle: "#dock-restart", expect: "absent" },
      ],
      screenshots: [shot("remote-fresh-qr", "The replacement QR.")],
      dimension: "D3",
    },
  ),
];

/** The webapp lane of the gym registry (every-merge subset + total tranche). */
export const WEB_GYM_SCENARIOS: readonly Scenario[] = [...EVERY_MERGE, ...TOTAL];
