// Post-recovery device-disposition choice — the webapp parity of iOS
// PostRecoveryChoiceScreen (L4).
//
// Shown right after a cloud-passkey recovery succeeds, BEFORE we decide
// whether to rotate the account identity. The user picks keep-both
// (default, no rotation), replace-lost (rotate + re-pair takeover), or
// wipe-restart (dimmed "Coming soon" in v1). `enterPostRecoveryChoice`
// returns a Promise that resolves with the chosen id (or null if the
// user backs out), so loginTakeover's injected `chooseDisposition` can
// await it.
//
// All copy/enabled-state lives in lib/postRecoveryChoice.js (pure +
// tested); this module is the DOM shell.

import { $, registerView, show } from "../lib/router.js";
import { escapeHtml } from "../lib/util.js";
import {
  RECOVERY_CHOICES,
  DEFAULT_RECOVERY_CHOICE,
  choiceTitle,
  choiceSubtitle,
  choiceWarning,
  continueLabel,
  isChoiceEnabled,
} from "../lib/postRecoveryChoice.js";

registerView("view-post-recovery-choice");

let selection = DEFAULT_RECOVERY_CHOICE;
let wipeEnabled = false;
let resolveChoice = null;

function warningGlyph(level) {
  if (level === "warn") return '<span class="warn-glyph" aria-hidden="true">⚠️</span>';
  if (level === "danger") return '<span class="warn-glyph" aria-hidden="true">⛔</span>';
  return "";
}

function renderOptions() {
  const root = $("post-recovery-choice-options");
  if (!root) return;
  root.innerHTML = RECOVERY_CHOICES.map((choice) => {
    const enabled = isChoiceEnabled(choice, { wipeAndRestartEnabled: wipeEnabled });
    const dimmed = !enabled;
    const selected = selection === choice;
    const comingSoon = dimmed
      ? '<span class="pill" style="margin-left:auto">Coming soon</span>'
      : "";
    return `
      <button
        class="card choice-row${selected ? " choice-selected" : ""}${dimmed ? " choice-dimmed" : ""}"
        id="post-recovery-choice-${choice}"
        data-choice="${choice}"
        ${dimmed ? "disabled" : ""}
        aria-pressed="${selected ? "true" : "false"}"
      >
        <div class="row">
          <span class="radio-glyph" aria-hidden="true">${selected ? "◉" : "○"}</span>
          <strong>${escapeHtml(choiceTitle(choice))}</strong>
          ${warningGlyph(choiceWarning(choice))}
          ${comingSoon}
        </div>
        <p class="note">${escapeHtml(choiceSubtitle(choice))}</p>
      </button>
    `;
  }).join("");

  root.querySelectorAll("[data-choice]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const choice = btn.getAttribute("data-choice");
      if (!isChoiceEnabled(choice, { wipeAndRestartEnabled: wipeEnabled })) return;
      selection = choice;
      renderOptions();
      paintContinue();
    });
  });
}

function paintContinue() {
  const btn = $("post-recovery-choice-continue");
  if (!btn) return;
  btn.textContent = continueLabel(selection);
  btn.disabled = !isChoiceEnabled(selection, { wipeAndRestartEnabled: wipeEnabled });
}

function finish(choice) {
  const r = resolveChoice;
  resolveChoice = null;
  if (r) r(choice);
}

export function initPostRecoveryChoiceView() {
  $("post-recovery-choice-continue")?.addEventListener("click", () => {
    if (!isChoiceEnabled(selection, { wipeAndRestartEnabled: wipeEnabled })) return;
    finish(selection);
  });
  $("post-recovery-choice-back")?.addEventListener("click", () => finish(null));
}

/** Present the choice screen and resolve with the picked disposition id
 *  ("keep-both" | "replace-lost"), or null if the user backs out. */
export function enterPostRecoveryChoice({ wipeAndRestartEnabled = false } = {}) {
  wipeEnabled = !!wipeAndRestartEnabled;
  selection = DEFAULT_RECOVERY_CHOICE;
  show("view-post-recovery-choice");
  renderOptions();
  paintContinue();
  return new Promise((resolve) => {
    resolveChoice = resolve;
  });
}
