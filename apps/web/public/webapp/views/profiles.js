// P12 — Profiles screen. Mirrors apps/mobile/ios/Sources/FlagshipUI/Screens/
// ProfilesScreen.swift: one row per cloud this browser is bound to, ACTIVE
// badge on the selected one, tap to switch. Empty state routes back into
// the onboarding wizard.
//
// State source: lib/profiles.js (existing W3 profile list) + lib/profilesStore.js
// (per-profile slot the rest of the webapp now reads from). Switching the
// active profile flips BOTH so the keystore / state.js / home banner /
// recovery wiring all re-render against the new cloud.
//
// Pods don't carry across profiles — each cloud is a separate identity.

import { $, registerView, show } from "../lib/router.js";
import { humanError } from "../lib/humanError.js";
import { toast } from "../lib/toast.js";
import { escapeHtml } from "../lib/util.js";
import { loadProfiles, setActiveProfile } from "../lib/profiles.js";
import {
  ensureProfile,
  getActiveCloudName,
  setActiveCloudName,
} from "../lib/profilesStore.js";

registerView("view-profiles");

/** Refresh hook the host can override (app.js wires this to a re-render of
 *  the surfaces that read per-profile state — home + settings). Default is a
 *  no-op so test imports don't crash before app.js boot. */
let onProfileSwitch = () => {};

export function setProfileSwitchHandler(fn) {
  onProfileSwitch = typeof fn === "function" ? fn : (() => {});
}

function renderEmpty(root) {
  root.innerHTML = `
    <div class="card">
      <h3>No profiles yet</h3>
      <p class="note">Set one up to bind this browser to a cloud.</p>
      <button id="profiles-set-up" class="full-width">Set one up</button>
    </div>
  `;
  $("profiles-set-up")?.addEventListener("click", () => show("view-bootstrap"));
}

function rowMarkup(profile, active) {
  const isActive = profile.cloudName === active;
  return `
    <div class="card profiles-row${isActive ? " profiles-row-active" : ""}" data-cloud="${escapeHtml(profile.cloudName)}">
      <div class="row row-top">
        <div>
          <div class="weight-600">${escapeHtml(profile.cloudName)}</div>
          ${profile.deviceLabel ? `<div class="muted-sm">Device: ${escapeHtml(profile.deviceLabel)}</div>` : ""}
        </div>
        ${isActive
          ? '<span class="pill ok">ACTIVE</span>'
          : `<button class="secondary" data-action="switch" data-cloud="${escapeHtml(profile.cloudName)}">Switch</button>`}
      </div>
    </div>
  `;
}

export function renderProfiles() {
  const root = $("profiles-content");
  if (!root) return;
  const { profiles } = loadProfiles();
  // The store's active pointer is the source of truth; lib/profiles.js mirrors.
  const active = getActiveCloudName() ?? null;

  if (!profiles || profiles.length === 0) {
    renderEmpty(root);
    return;
  }

  root.innerHTML = `
    <p class="note">
      One browser, multiple clouds. Each profile is a separate cloud (personal, family, work) with its own root key. Pods don't carry across profiles.
    </p>
    ${profiles.map((p) => rowMarkup(p, active)).join("")}
  `;

  for (const btn of root.querySelectorAll('[data-action="switch"]')) {
    btn.addEventListener("click", (e) => {
      const target = (e.currentTarget instanceof HTMLElement)
        ? e.currentTarget.getAttribute("data-cloud")
        : null;
      if (!target) return;
      void switchTo(target);
    });
  }
}

async function switchTo(cloudName) {
  try {
    ensureProfile(cloudName);
    setActiveProfile(cloudName);
    setActiveCloudName(cloudName);
    toast(`switched to ${cloudName}`);
    renderProfiles();
    try { onProfileSwitch(cloudName); } catch { /* swallow */ }
  } catch (e) {
    console.error(e);
    toast(humanError(e), "err");
  }
}

export function initProfilesView() {
  $("profiles-back")?.addEventListener("click", () => show("view-settings-tab"));
  $("profiles-refresh")?.addEventListener("click", () => {
    try { renderProfiles(); } catch (e) { console.error(e); toast(humanError(e), "err"); }
  });
}

export async function enterProfiles() {
  show("view-profiles");
  renderProfiles();
}
