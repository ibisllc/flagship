// Demo accounts in the webapp (parity with iOS AppState.isDemoAccount).
//
// A demo login attaches this browser with a fresh local device key that is
// NOT the account's identity key: the demo's real keys stay with the operator
// (scripts/sample-user.mjs). So the key-backed rows — cloud recovery, key
// backup, trusted devices — can never work for it, and the account itself is
// operator-managed: "Delete account" means remove it from this browser.
//
// Detection comes from the account (the `demoServer` block persisted on the
// profile by activateDemoAccount), never from a developer toggle.

/** @param {{ demoServer?: unknown } | null | undefined} profile */
export function isDemoProfile(profile) {
  return !!profile?.demoServer;
}

/** Settings rows hidden for a demo — the same three iOS hides. */
export const DEMO_HIDDEN_SETTINGS_IDS = Object.freeze([
  "settings-tab-recovery",
  "settings-tab-backup-key",
  "settings-tab-trusted-devices",
]);

/** Hide (or restore) the key-backed Settings rows for the active account. */
export function applyDemoSettingsRestrictions(isDemo, doc = globalThis.document) {
  for (const id of DEMO_HIDDEN_SETTINGS_IDS) {
    doc?.getElementById?.(id)?.classList.toggle("hidden", !!isDemo);
  }
}

export const DEMO_REMOVE_COPY = Object.freeze({
  title: "Demo account",
  message:
    "This demo account is managed by Flagship, so it can't be deleted from the app — you can remove it from this browser instead. Accounts you create yourself are permanently deleted from here.",
  okLabel: "Remove from this browser",
  danger: true,
});

/**
 * Confirm, then forget the demo on this browser: wipe its local key, drop its
 * profile row (so a reload doesn't silently re-attach it), and return to
 * Welcome. Nothing is sent to the server — the operator owns the account.
 *
 * @param {{
 *   username: string,
 *   confirm: (copy: typeof DEMO_REMOVE_COPY) => Promise<boolean>,
 *   resetDevice: () => Promise<void>,
 *   profileRemove?: (slot: string) => void,
 *   forgetProfile?: (cloudName: string) => void,
 *   lockSession: () => void,
 *   stopRenewals?: () => void,
 *   setSubtitle?: (text: string) => void,
 *   show: (viewId: string) => void,
 * }} deps
 * @returns {Promise<boolean>} true when the demo was removed
 */
export async function confirmAndRemoveDemo(deps) {
  if (!(await deps.confirm(DEMO_REMOVE_COPY))) return false;
  deps.stopRenewals?.();
  await deps.resetDevice();
  if (deps.profileRemove) {
    for (const slot of ["sessionId", "sessionToken", "podBaseUrl", "username"]) {
      deps.profileRemove(slot);
    }
  }
  try {
    deps.forgetProfile?.(deps.username);
  } catch { /* best-effort local cleanup */ }
  deps.lockSession();
  deps.setSubtitle?.("demo removed");
  deps.show("view-bootstrap");
  return true;
}
