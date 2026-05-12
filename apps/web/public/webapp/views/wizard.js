/**
 * First-run wizard (#25) + peer-backup opt-in step (#95).
 *
 * Gates on "no servers yet" — once a user has at least one paired
 * server, the wizard never re-enters. The 6 steps (and the peer-backup
 * prompt sandwiched at step 6.5) tie together existing webapp screens
 * via small handoff helpers, so this module stays focused on the
 * orchestration: which step the user is on, where to navigate next,
 * and the persistent warning banner for skipped recovery setup.
 *
 * Steps:
 *   1. Generate device key   (delegates to bootstrap.js when no IRK)
 *   2. Pick username          (claim flow — pre-existing in state.js)
 *   3. Recovery passphrase    (skippable, but pins a warning banner)
 *   4. WebAuthn-PRF cloud rec (skippable, same warning)
 *   5. Create first server    (jumps to create-server.js)
 *   6. Peer-backup opt-in     (#95 — yes/no/maybe-later, persisted)
 *   7. Demo app install       (optional marketplace jump)
 *
 * The wizard module is dynamic-imported from home.js's empty-state
 * CTA so it doesn't bloat first paint.
 */

import { registerView, show } from "../lib/router.js";

registerView("view-wizard");

const WIZARD_STATE_KEY = "flagship.wizard.state.v1";
const RECOVERY_WARN_KEY = "flagship.recovery.warn.v1";
const PEER_BACKUP_CHOICE_KEY = "flagship.peerBackup.choice.v1";

const STEPS = [
  { id: "device-key", label: "Generate device key" },
  { id: "username", label: "Pick a username" },
  { id: "passphrase", label: "Set recovery passphrase", skippable: true },
  { id: "webauthn-recovery", label: "Cloud recovery (WebAuthn)", skippable: true },
  { id: "create-server", label: "Create your first server" },
  { id: "peer-backup", label: "Help others (peer-backup)", skippable: true },
  { id: "demo-app", label: "Try a demo app", skippable: true },
];

function loadState() {
  try {
    const raw = localStorage.getItem(WIZARD_STATE_KEY);
    if (!raw) return { stepIdx: 0, completed: [] };
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { stepIdx: 0, completed: [] };
    return { stepIdx: Number(parsed.stepIdx) || 0, completed: Array.isArray(parsed.completed) ? parsed.completed : [] };
  } catch {
    return { stepIdx: 0, completed: [] };
  }
}

function saveState(state) {
  try {
    localStorage.setItem(WIZARD_STATE_KEY, JSON.stringify(state));
  } catch { /* localStorage full / disabled */ }
}

/**
 * Public entry point. Caller passes an initial step hint (e.g.
 * "create-server" when the user hits "Create a server" from the
 * empty state). The wizard advances to that step or to the user's
 * resume point, whichever is later.
 */
export async function enterWizard(opts = {}) {
  const state = loadState();
  if (opts.step) {
    const idx = STEPS.findIndex((s) => s.id === opts.step);
    if (idx >= 0 && idx > state.stepIdx) state.stepIdx = idx;
  }
  saveState(state);
  await renderStep(state);
}

async function renderStep(state) {
  const step = STEPS[state.stepIdx];
  if (!step) {
    // Wizard complete.
    show("view-home");
    return;
  }
  const root = document.getElementById("view-wizard");
  if (!root) return;
  root.innerHTML = wizardChrome(state, step) + (await renderStepBody(state, step));
  show("view-wizard");
  wireStepHandlers(state, step);
}

function wizardChrome(state, currentStep) {
  const dots = STEPS.map((s, i) => {
    let cls = "wizard-dot";
    if (i < state.stepIdx) cls += " done";
    if (i === state.stepIdx) cls += " current";
    if (state.completed.includes(s.id)) cls += " done";
    return `<span class="${cls}" title="${s.label}"></span>`;
  }).join("");
  return `
    <div class="card wizard-shell">
      <div class="wizard-progress">
        <div class="wizard-step-count muted-sm">step ${state.stepIdx + 1} of ${STEPS.length}</div>
        <div class="wizard-dots">${dots}</div>
      </div>
      <h2 class="card-title">${currentStep.label}</h2>
      <div id="wizard-body" class="stack-md"></div>
    </div>
  `;
}

async function renderStepBody(state, step) {
  // Each step's body delegates to the existing view that owns the
  // logic. The wizard just provides the chrome + "next" handoff.
  switch (step.id) {
    case "device-key":
      return `
        <p class="note">Your device key never leaves this browser. We use it to sign every
        message your server trusts.</p>
        <div class="btn-row-sm">
          <button id="wizard-go-bootstrap" class="pill primary">Generate</button>
        </div>
      `;
    case "username":
      return `
        <p class="note">Pick a handle. It's a routing label, not a profile — you can be
        as pseudonymous as you want. The server never stores any real-world identity
        attribute (<a href="https://flagshipserver.com/security.html#no-kyc">why</a>).</p>
        <div class="btn-row-sm">
          <button id="wizard-go-username" class="pill primary">Continue</button>
        </div>
      `;
    case "passphrase":
    case "webauthn-recovery":
      return `
        <p class="note">If you lose this device, the only way back to your account is a
        recovery flow on a fresh browser. We recommend setting it up now (one minute),
        but you can skip and a banner will remind you on the home screen.</p>
        <div class="btn-row-sm">
          <button id="wizard-go-recovery" class="pill primary">Set up recovery</button>
          <button id="wizard-skip-recovery" class="pill">Skip for now</button>
        </div>
      `;
    case "create-server":
      return `
        <p class="note">Compose your first server here. When you tap Continue, the webapp
        opens <code>flagshipserver.com/build/</code> on this machine — scan the QR there
        from this browser to deliver the disk image.</p>
        <div class="btn-row-sm">
          <button id="wizard-go-create-server" class="pill primary">Continue</button>
        </div>
      `;
    case "peer-backup":
      return renderPeerBackupStep();
    case "demo-app":
      return `
        <p class="note">Optional — install one demo app from the marketplace so you can
        see the round-trip working. You can skip and explore later.</p>
        <div class="btn-row-sm">
          <button id="wizard-go-demo" class="pill primary">Browse marketplace</button>
          <button id="wizard-skip-demo" class="pill">Finish later</button>
        </div>
      `;
    default:
      return "<p class=\"note\">Unknown step — finishing wizard.</p>";
  }
}

/** #95 — peer-backup opt-in step. Three buttons: enable, decline,
 *  "maybe later" (defers the choice without writing a "no" record). */
function renderPeerBackupStep() {
  return `
    <p class="note">
      Help others (and let them help you). Your encrypted shards travel to other
      Flagship users' pods; theirs travel to yours. Nobody can read each other's
      data — the bytes are sealed against keys only you hold.
    </p>
    <p class="note muted-sm">
      You can change this anytime in Settings → Peer-backup.
    </p>
    <div class="btn-row-sm">
      <button id="wizard-pb-enable" class="pill primary">Enable peer-backup</button>
      <button id="wizard-pb-decline" class="pill">No thanks</button>
      <button id="wizard-pb-later" class="pill ghost">Maybe later</button>
    </div>
  `;
}

function wireStepHandlers(state, step) {
  switch (step.id) {
    case "device-key":
      document.getElementById("wizard-go-bootstrap")?.addEventListener("click", async () => {
        markCompleteAndAdvance(state, "device-key");
        const { enterBootstrap } = await import("./bootstrap.js");
        await enterBootstrap();
      });
      break;
    case "username":
      document.getElementById("wizard-go-username")?.addEventListener("click", () => {
        markCompleteAndAdvance(state, "username");
      });
      break;
    case "passphrase":
    case "webauthn-recovery":
      document.getElementById("wizard-go-recovery")?.addEventListener("click", async () => {
        markCompleteAndAdvance(state, step.id);
        const { enterRecovery } = await import("./recovery.js");
        if (typeof enterRecovery === "function") await enterRecovery();
      });
      document.getElementById("wizard-skip-recovery")?.addEventListener("click", () => {
        try {
          localStorage.setItem(RECOVERY_WARN_KEY, "true");
        } catch { /* swallow */ }
        markCompleteAndAdvance(state, step.id);
      });
      break;
    case "create-server":
      document.getElementById("wizard-go-create-server")?.addEventListener("click", async () => {
        markCompleteAndAdvance(state, "create-server");
        const { enterCreateServer } = await import("./create-server.js");
        await enterCreateServer();
      });
      break;
    case "peer-backup":
      document.getElementById("wizard-pb-enable")?.addEventListener("click", async () => {
        try { localStorage.setItem(PEER_BACKUP_CHOICE_KEY, "enabled"); } catch { /* swallow */ }
        // The actual enable is a signed BackupToggle envelope; the
        // peer-backup view (#27) handles that. From the wizard we
        // just record the user's choice + jump to the view.
        markCompleteAndAdvance(state, "peer-backup");
        try {
          const { enterPeerBackup } = await import("./peer-backup.js");
          if (typeof enterPeerBackup === "function") await enterPeerBackup();
        } catch { /* not present yet */ }
      });
      document.getElementById("wizard-pb-decline")?.addEventListener("click", () => {
        try { localStorage.setItem(PEER_BACKUP_CHOICE_KEY, "declined"); } catch { /* swallow */ }
        markCompleteAndAdvance(state, "peer-backup");
      });
      document.getElementById("wizard-pb-later")?.addEventListener("click", () => {
        try { localStorage.setItem(PEER_BACKUP_CHOICE_KEY, "deferred"); } catch { /* swallow */ }
        markCompleteAndAdvance(state, "peer-backup");
      });
      break;
    case "demo-app":
      document.getElementById("wizard-go-demo")?.addEventListener("click", async () => {
        markCompleteAndAdvance(state, "demo-app");
        try {
          const { enterMarketplace } = await import("./marketplace.js");
          if (typeof enterMarketplace === "function") await enterMarketplace();
        } catch { /* not present */ }
      });
      document.getElementById("wizard-skip-demo")?.addEventListener("click", () => {
        markCompleteAndAdvance(state, "demo-app");
      });
      break;
  }
}

function markCompleteAndAdvance(state, stepId) {
  if (!state.completed.includes(stepId)) state.completed.push(stepId);
  state.stepIdx++;
  saveState(state);
  void renderStep(state);
}

/** Helper for home.js: returns true iff the user explicitly skipped
 *  recovery setup and should see a persistent warning banner. */
export function shouldShowRecoveryWarning() {
  try {
    return localStorage.getItem(RECOVERY_WARN_KEY) === "true";
  } catch {
    return false;
  }
}

/** Helper for home.js / settings: returns the user's peer-backup
 *  wizard choice. One of "enabled" | "declined" | "deferred" | null. */
export function getPeerBackupChoice() {
  try {
    return localStorage.getItem(PEER_BACKUP_CHOICE_KEY);
  } catch {
    return null;
  }
}
