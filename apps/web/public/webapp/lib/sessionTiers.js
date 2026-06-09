// Three-tier session model (task #46 — webapp parity with iOS 725be0f).
//
// The native apps split the one thing the UI used to conflate ("leave the
// app") into three concepts ordered by increasing severity. This module
// adapts that model to the browser, where there is no Secure Enclave /
// Face ID — so the gates that biometry provides on a phone are remapped to
// what a browser actually has (a passphrase re-prompt, and WebAuthn-PRF
// cloud recovery).
//
//   Tier 1 — LOCK. Re-gate the app WITHOUT removing anything. Drop the
//     in-memory unlocked session (the UMK seed + IRK live only in
//     lib/state.js's closure) and route back to the unlock screen, where
//     re-entry is the local passphrase. Key material stays in IndexedDB.
//     The cheapest "someone picked up my unlocked tab" action.
//
//     IMPERFECT MAPPING: on iOS the lock gate is Face ID; the browser has
//     no equivalent, so the re-auth is the wrap passphrase (the same one
//     bootstrap/unlock already uses). It is a genuine re-gate — the unlocked
//     closure is cleared — but the "factor" is knowledge, not biometric.
//
//   Tier 2 — SIGN OUT. Erase THIS device's local key material (the wrapped
//     UMK/IRK record in IndexedDB) WITHOUT any server-side revoke. The
//     account stays valid; the device is still a member. Sign back in via
//     WebAuthn-PRF cloud recovery, which re-fetches the SAME seed → the
//     recovered IRK matches the registered identity → instant re-pair, no
//     rotation. Hardens against an at-rest snoop of IndexedDB while signed
//     out. GATED on cloud-recovery enrollment: enrolled ⇒ routine confirm;
//     not enrolled ⇒ destructive warning (clearing the only copy of the key
//     is permanent account-access loss on this device).
//
//   Tier 3 — REMOVE THIS DEVICE. Cryptographic eviction: server-side
//     revoke + rotate. This is the existing paired-sessions / trusted-
//     devices revoke flow — unchanged, and deliberately NOT re-implemented
//     here. The contract this module pins is that Tier 2 must NOT touch it.
//
// Everything here is dependency-injected + side-effect-free w.r.t. module
// state so it can be unit-tested in Node without a DOM.

/**
 * Tier 1 — LOCK. Clear the in-memory unlocked session and re-gate the app.
 * Removes NOTHING from storage: the wrapped UMK record is untouched, so
 * re-entry is a passphrase unlock (no recovery round-trip).
 *
 * @param {object} deps
 * @param {() => void} deps.lockSession   clears lib/state.js's closure (umk/irk/username → null)
 * @param {(viewId: string) => void} deps.show  router.show — route to the lock/unlock gate
 * @param {(text: string) => void} [deps.setSubtitle]  router.setSubtitle
 * @param {() => void} [deps.stopRenewals]  stop background lease renewals while locked
 * @param {string} [deps.unlockViewId]  the view to gate behind (default "view-unlock")
 */
export function lock(deps) {
  const {
    lockSession,
    show,
    setSubtitle,
    stopRenewals,
    unlockViewId = "view-unlock",
  } = deps;
  // Stop any background work that assumes an unlocked session first, so a
  // renewer can't repopulate state after we've dropped it.
  stopRenewals?.();
  lockSession();
  setSubtitle?.("locked");
  show(unlockViewId);
}

/**
 * Tier 2 — SIGN OUT. Erase this device's local key material WITHOUT a
 * server-side revoke, then drop the in-memory session and route to the
 * first-run / sign-in screen. The account is untouched; coming back is a
 * WebAuthn-PRF recovery that restores the same key (instant re-pair).
 *
 * The contract (pinned by tests): this calls resetDevice() (key wipe) and
 * lockSession() but NEVER a revoke endpoint — server state is not mutated.
 *
 * @param {object} deps
 * @param {() => Promise<void>} deps.resetDevice  keystore.resetDevice — deletes the wrapped UMK record
 * @param {() => void} deps.lockSession           clears the in-memory session
 * @param {(slot: string) => void} [deps.profileRemove]  profilesStore.remove — drop per-profile session slots
 * @param {() => void} [deps.stopRenewals]        stop background lease renewals
 * @param {(viewId: string) => void} deps.show    router.show — route to bootstrap/sign-in
 * @param {(text: string) => void} [deps.setSubtitle]
 * @param {string} [deps.bootstrapViewId]  the post-sign-out landing view (default "view-bootstrap")
 */
export async function signOut(deps) {
  const {
    resetDevice,
    lockSession,
    profileRemove,
    stopRenewals,
    show,
    setSubtitle,
    bootstrapViewId = "view-bootstrap",
  } = deps;
  stopRenewals?.();
  // Local key-material wipe. NO revoke call — that's Tier 3.
  await resetDevice();
  // Drop the per-profile session slots so a half-authenticated state can't
  // linger. `username` is device-wide-or-pre-profile, so removing it also
  // clears the legacy flat key keystore.js reads at boot.
  if (profileRemove) {
    for (const slot of ["sessionId", "sessionToken", "podBaseUrl", "username"]) {
      profileRemove(slot);
    }
  }
  lockSession();
  setSubtitle?.("signed out");
  show(bootstrapViewId);
}

/**
 * Build the cloud-recovery-aware confirm copy for a Tier-2 sign-out. Mirrors
 * the iOS SettingsScreen confirmation: enrolled ⇒ routine; not enrolled ⇒
 * danger-grade warning that the key wipe is permanent.
 *
 * @param {boolean} hasCloudRecovery
 * @returns {{ title: string, message: string, okLabel: string, danger: boolean }}
 */
export function signOutConfirmCopy(hasCloudRecovery) {
  if (hasCloudRecovery) {
    return {
      title: "Sign out of this device?",
      message:
        "This erases this device's account key so nothing sensitive is left at rest while you're signed out. Your account and your servers are untouched — sign back in with your recovery passkey and the same key is restored, no re-pair.",
      okLabel: "Sign out",
      danger: true,
    };
  }
  return {
    title: "Sign out without recovery?",
    message:
      "⚠️ You have NO cloud recovery enrolled. Erasing this device's key with no backup means there's no way to sign back in — your account access on this device is lost for good. Set up recovery first if you might want to come back.",
    okLabel: "Sign out anyway",
    danger: true,
  };
}
