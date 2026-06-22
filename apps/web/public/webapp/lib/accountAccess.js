// Unified account-access options — the "this name is taken; how do you want to
// get in?" decision surface (docs/login-and-account-redesign.md).
//
// The cover is username-first: enter a name → resolve → if FREE you sign up, if
// TAKEN we show ALL the ways to access the account, with the ones this account
// doesn't support shown DISABLED + explained (rather than hidden) so the model
// is discoverable. This module is the PURE core: given an AccountResolution it
// returns the option list; the view renders it and routes the pick to the
// existing per-pathway flow. No DOM, no network — unit-testable in isolation.

/** @typedef {import("./accountResolve.js").AccountResolution} AccountResolution */

/** One access pathway, ready to render as a card.
 *  @typedef {Object} AccessOption
 *  @property {"recover"|"scan"|"keyfile"|"grace"} id
 *  @property {string} label
 *  @property {string} sublabel
 *  @property {boolean} enabled
 *  @property {string|null} disabledReason   why it's greyed out (null when enabled)
 */

/**
 * Build the access-options list for a resolved (existing) account. These are all
 * SELF-CUSTODY paths — you get back in by proving you hold a credential (a
 * recovery passkey, another signed-in device, or a key file). There is NO
 * no-credential "claim after a wait": a flagship.services name is yours for as
 * long as you hold a key for it, and is never taken from you or handed to anyone
 * else (docs/login-and-account-redesign.md — naming is self-custody). Lose every
 * credential with no backup and the name stays reserved to you, unusable — which
 * is why we push enrolling a recovery factor at sign-up.
 *
 * ALL options are always returned; `enabled`/`disabledReason` say which apply,
 * so an account with no cloud recovery still SHOWS "Recover with your passkey"
 * (disabled, with a reason) instead of silently dropping it.
 *
 * @param {AccountResolution} resolution
 * @returns {AccessOption[]}
 */
export function accessOptions(resolution) {
  const recoveryEnrolled = !!(resolution && resolution.recovery && resolution.recovery.present);
  return [
    {
      id: "recover",
      label: "Recover with your passkey",
      sublabel: "Unlock with the recovery passkey + passphrase you set up.",
      enabled: recoveryEnrolled,
      disabledReason: recoveryEnrolled ? null : "No cloud recovery is set up on this account.",
    },
    {
      id: "scan",
      label: "Scan a pairing code",
      sublabel: "From a device that's already signed in — its Settings → Add device.",
      enabled: true,
      disabledReason: null,
    },
    {
      id: "keyfile",
      label: "Import a key file",
      sublabel: "Restore from a key file you exported and saved.",
      enabled: true,
      disabledReason: null,
    },
  ];
}

/** Whether anything actionable exists — true unless every option is disabled
 *  (e.g. a locked-down account with no recovery, no grace). The view uses this
 *  to decide whether to show a "you can't get in from here" backstop. */
export function hasAnyAccess(resolution) {
  return accessOptions(resolution).some((o) => o.enabled);
}
