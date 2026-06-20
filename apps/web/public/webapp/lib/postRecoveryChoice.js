// Pure model for the post-recovery device-disposition choice — the
// webapp parity of iOS PostRecoveryChoiceScreen.
//
// After a successful cloud-passkey recovery unwraps the account key on
// THIS device, the user picks how it should relate to their other
// trusted devices. Each choice carries a different cryptographic blast
// radius; the titles/subtitles are verbatim from the iOS screen (which
// in turn quotes docs/revocation-ui.md) so the wording lives in one
// reviewable place.
//
// This module is pure (no DOM, no crypto) so the copy + enabled-state
// rules are unit-testable in isolation; views/post-recovery-choice.js
// renders it.

/** The three dispositions, in display order. The view renders a radio
 *  row per entry; the orchestrator (loginTakeover.loginRealAccount)
 *  branches on the returned id. */
export const RECOVERY_CHOICES = ["keep-both", "replace-lost", "wipe-restart"];

/** The default selection — least destructive, no rotation. */
export const DEFAULT_RECOVERY_CHOICE = "keep-both";

export function choiceTitle(choice) {
  switch (choice) {
    case "keep-both":
      return "Keep my other devices working";
    case "replace-lost":
      return "Replace a device I lost";
    case "wipe-restart":
      return "Wipe & restart";
    default:
      return "";
  }
}

export function choiceSubtitle(choice) {
  switch (choice) {
    case "keep-both":
      return "Default. Both this device and any other devices you've already paired stay logged in.";
    case "replace-lost":
      return "Rotates your account's identity. Your servers will treat the lost device as expired within ~5 minutes. Cannot be undone.";
    case "wipe-restart":
      return "Replaces your account key and recovery passkey. Even an attacker holding your old device AND your old passkey is locked out. Cannot be undone.";
    default:
      return "";
  }
}

/** The danger level of a choice — drives the warning glyph. iOS uses a
 *  triangle for replace-lost and an octagon for wipe-restart. */
export function choiceWarning(choice) {
  switch (choice) {
    case "replace-lost":
      return "warn";
    case "wipe-restart":
      return "danger";
    default:
      return null;
  }
}

/** The Continue button label reflects what the selection will DO. */
export function continueLabel(choice) {
  switch (choice) {
    case "replace-lost":
      return "Replace device";
    case "wipe-restart":
      return "Wipe & restart";
    default:
      return "Continue";
  }
}

/** Wipe & restart is a v1.1 code path; in v1 it renders dimmed +
 *  "Coming soon" and Continue is disabled while it's selected. Mirrors
 *  iOS `wipeAndRestartEnabled` (false in v1). */
export function isChoiceEnabled(choice, { wipeAndRestartEnabled = false } = {}) {
  if (choice === "wipe-restart") return !!wipeAndRestartEnabled;
  return true;
}
