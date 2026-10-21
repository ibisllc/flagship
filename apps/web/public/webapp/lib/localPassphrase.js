// The passphrase that locks an account's key in this browser.
//
// Every flow that brings a key into this browser (creating an account, joining
// one from another device, taking one over, restoring a backup file) wraps it
// under a passphrase the owner chose, since the lock screen asks for exactly
// that one on the next load. A generated passphrase nobody kept would lock the
// owner out of the account here after a reload.
import { tr } from "./i18n.js";

export const LOCAL_PASSPHRASE_MIN = 8;

/** True when `p` can lock a key in this browser. */
export function isLocalPassphrase(p) {
  return typeof p === "string" && p.length >= LOCAL_PASSPHRASE_MIN;
}

/** Ask the owner to choose this browser's passphrase, typed twice. Resolves to
 *  the passphrase, or null when they cancel.
 *
 *  @param {(opts: object) => Promise<string|null>} prompt  lib/modal.js inlinePrompt
 *  @returns {Promise<string|null>}
 */
export async function askLocalPassphrase(prompt) {
  const pass = await prompt({
    title: tr("Lock this browser"),
    message:
      tr("Choose a passphrase (8+ characters). You'll type it to unlock this account on this browser. flagshipserver.com never sees it."),
    placeholder: "passphrase",
    type: "password",
    okLabel: tr("Continue"),
    validate: (v) => (isLocalPassphrase(v) ? null : tr("Use at least 8 characters")),
  });
  if (!pass) return null;
  const again = await prompt({
    title: tr("Confirm passphrase"),
    message: tr("Type it again."),
    placeholder: "passphrase",
    type: "password",
    validate: (v) => (v !== pass ? tr("passphrases don't match") : null),
  });
  return again == null ? null : pass;
}
