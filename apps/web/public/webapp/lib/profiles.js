// W3 — multi-profile (multi-cloud) state for the webapp PWA. Mirrors
// the iOS/Android `Profile` shape:
//
//     { cloudName, cloudRootPubHex, deviceLabel, deviceCapability,
//       demoServer, createdAt }
//
// A "cloud" is what we've been calling a "username" — each cloud has
// one root key (today's IRK). One browser profile can hold multiple
// clouds (personal + family + work); the active one drives the rest
// of the UI. Storage = localStorage under a single versioned key so a
// future migration is easy to spot.
//
// W8 NOTE: this module deliberately stores ONLY public identifiers
// (cloud-root pubkey hex, capability blocks) — never private key
// material. Private keys live in the browser keystore (IndexedDB-
// backed) and never get serialized here. The webapp has no analog of
// iOS's iCloud Keychain auto-sync; cross-device profile portability is
// the user's choice via cloud recovery.
//
// Multi-profile keying: this module is the SOURCE OF TRUTH for which
// cloud is active (`activeCloudName`). The keystore (../keystore.js)
// keys each profile's wrapped UMK by that cloudName, so switching the
// active profile here MUST re-point keystore reads at that profile —
// {@link setActiveProfile} / {@link addProfile} do this by calling
// `setActiveKeystoreProfile`. Importing keystore.js is load-safe: it
// has no top-level IndexedDB/crypto side effects.

import { setActiveKeystoreProfile } from "../keystore.js";

/** @typedef {Object} Profile
 *  @property {string} cloudName
 *  @property {string} [cloudRootPubHex]
 *  @property {string|null} [deviceLabel]
 *  @property {object|null} [deviceCapability]
 *  @property {object|null} [demoServer]
 *  @property {number} createdAt
 */

/** @typedef {Object} ProfilesState
 *  @property {Profile[]} profiles
 *  @property {string|null} activeCloudName
 */

export const KEY = "flagship.profiles.v1";

/** Return the current `{profiles, activeCloudName}`. Defaults to an
 *  empty list when nothing is stored or the stored blob fails to
 *  parse (corrupt LS → degrade gracefully, the user can re-onboard).
 *  @param {Storage} [storage]
 *  @returns {ProfilesState}
 */
export function loadProfiles(storage = globalThis.localStorage) {
  if (!storage) return { profiles: [], activeCloudName: null };
  const raw = storage.getItem(KEY);
  if (!raw) return { profiles: [], activeCloudName: null };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { profiles: [], activeCloudName: null };
    }
    const profiles = Array.isArray(parsed.profiles) ? parsed.profiles : [];
    const activeCloudName = typeof parsed.activeCloudName === "string"
      ? parsed.activeCloudName
      : null;
    return { profiles, activeCloudName };
  } catch {
    return { profiles: [], activeCloudName: null };
  }
}

/** Persist `state` under {@link KEY}. Throws if `state` is malformed.
 *  @param {ProfilesState} state
 *  @param {Storage} [storage]
 */
export function saveProfiles(state, storage = globalThis.localStorage) {
  if (!storage) return;
  if (!state || !Array.isArray(state.profiles)) {
    throw new Error("saveProfiles: state.profiles must be an array");
  }
  storage.setItem(KEY, JSON.stringify({
    profiles: state.profiles,
    activeCloudName: state.activeCloudName ?? null,
  }));
}

/** Append (or replace by `cloudName`) a profile and persist. When
 *  `setActive` is true (the default), the new entry becomes active.
 *  @param {Profile} profile
 *  @param {{ setActive?: boolean, storage?: Storage }} [opts]
 *  @returns {ProfilesState}
 */
export function addProfile(profile, opts = {}) {
  const storage = opts.storage ?? globalThis.localStorage;
  const setActive = opts.setActive ?? true;
  if (!profile || typeof profile.cloudName !== "string") {
    throw new Error("addProfile: profile.cloudName required");
  }
  const state = loadProfiles(storage);
  const idx = state.profiles.findIndex((p) => p.cloudName === profile.cloudName);
  const next = { ...profile, createdAt: profile.createdAt ?? Date.now() };
  if (idx >= 0) {
    state.profiles[idx] = next;
  } else {
    state.profiles.push(next);
  }
  if (setActive) {
    state.activeCloudName = profile.cloudName;
    setActiveKeystoreProfile(profile.cloudName);
  }
  saveProfiles(state, storage);
  return state;
}

/** Switch the active profile. No-op if `cloudName` isn't in storage.
 *  @param {string} cloudName
 *  @param {Storage} [storage]
 *  @returns {ProfilesState}
 */
export function setActiveProfile(cloudName, storage = globalThis.localStorage) {
  const state = loadProfiles(storage);
  if (!state.profiles.some((p) => p.cloudName === cloudName)) {
    return state;
  }
  state.activeCloudName = cloudName;
  setActiveKeystoreProfile(cloudName);
  saveProfiles(state, storage);
  return state;
}

/** The active Profile descriptor, or null when none is active.
 *  @param {Storage} [storage]
 *  @returns {Profile|null}
 */
export function getActiveProfile(storage = globalThis.localStorage) {
  const state = loadProfiles(storage);
  if (!state.activeCloudName) return null;
  return state.profiles.find((p) => p.cloudName === state.activeCloudName) ?? null;
}

/** Render the header dropdown markup into `container`. Mounting is
 *  caller's responsibility (the views layer plugs this into the chrome
 *  next to the avatar). Returns the root element so callers can wire
 *  CSS classes / event listeners.
 *
 *  The dropdown lists every profile, with the active one rendered with
 *  an `aria-current="true"` marker. Clicking a non-active row calls
 *  `setActiveProfile` and invokes `opts.onChange` so the host can
 *  refresh whatever's downstream of the active cloud.
 *
 *  @param {HTMLElement} container
 *  @param {{ onChange?: (state: ProfilesState) => void, storage?: Storage }} [opts]
 *  @returns {HTMLElement}
 */
export function renderProfilesDropdown(container, opts = {}) {
  const storage = opts.storage ?? globalThis.localStorage;
  const root = (container.ownerDocument ?? document).createElement("div");
  root.className = "flagship-profiles-dropdown";

  const refresh = () => {
    const state = loadProfiles(storage);
    root.innerHTML = "";
    const active = state.activeCloudName
      ? state.profiles.find((p) => p.cloudName === state.activeCloudName)
      : null;
    const label = (root.ownerDocument ?? document).createElement("button");
    label.type = "button";
    label.className = "flagship-profiles-trigger";
    label.textContent = active ? active.cloudName : "No profile";
    label.setAttribute("aria-haspopup", "listbox");
    root.appendChild(label);

    const list = (root.ownerDocument ?? document).createElement("ul");
    list.className = "flagship-profiles-list";
    list.setAttribute("role", "listbox");
    for (const p of state.profiles) {
      const item = (root.ownerDocument ?? document).createElement("li");
      item.setAttribute("role", "option");
      item.dataset.cloudName = p.cloudName;
      item.textContent = p.cloudName;
      if (p.cloudName === state.activeCloudName) {
        item.setAttribute("aria-current", "true");
      } else {
        item.addEventListener("click", () => {
          const next = setActiveProfile(p.cloudName, storage);
          refresh();
          if (typeof opts.onChange === "function") opts.onChange(next);
        });
      }
      list.appendChild(item);
    }
    root.appendChild(list);
  };

  refresh();
  container.appendChild(root);
  return root;
}
