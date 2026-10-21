// Never push anyone to destroy the key they sign in to their servers with
// (docs/account-gone.md "The admin key is the way out"). The account's admin
// key on this device is how they sign in to their servers. So anything that
// removes it (Remove it from this browser and Create a new account on the
// "account was removed" screen, Sign out and Remove this device in Settings)
// first says so, in plain words, and offers to save a backup of the account
// key first.
//
// Pure copy and decisions here; the dialogs call them (lib/accountGoneUi.js,
// views/settings.js). Mirror the strings exactly on iOS and Android.

import { isAdminDevice } from "./memberRoles.js";

import { tr } from "./i18n.js";
export const ADMIN_KEY_COPY = Object.freeze({
  /** Removing the account's keys from this browser (account-gone screen, Remove this device). */
  removeTitle: tr("Remove this account from this browser?"),
  removeMessage:
    tr("This also removes this device's admin key, which you need to sign in to your servers. Save a backup of your account key first, or remove anyway."),
  saveFirst: tr("Save my account key first"),
  removeAnyway: tr("Remove anyway"),
  /** Settings, Sign out, on an admin device. */
  signOutTitle: tr("Sign out?"),
  signOutMessage:
    tr("Signing out removes this device's admin key. Save a backup of your account key first, or sign out anyway."),
  signOutAnyway: tr("Sign out anyway"),
  /** The same, once this device has written an account-key file. */
  signOutBackedUpMessage:
    tr("Signing out removes this device's admin key. You backed up your account key, so keep that file and its passphrase safe."),
  signOutBackedUpOk: tr("Sign out"),
  cancel: "Cancel",
  /** Shown when a save-first path needs the key unlocked. */
  unlockFirst: tr("Unlock first to save your key."),
});

/**
 * Does this device hold a key that signs in to a server: the
 * account's admin root (in memory this session, or the sealed record on
 * disk) or a session for any server? Every input is injectable for tests.
 *
 * @param {{ session?: object, hasAdminRootRecord?: () => Promise<boolean>, serverTokenCount?: () => number }} deps
 */
export async function holdsAdminKey({ session, hasAdminRootRecord, serverTokenCount } = {}) {
  if (isAdminDevice(session)) return true;
  try {
    if (hasAdminRootRecord && (await hasAdminRootRecord())) return true;
  } catch { /* unreadable: fall through to the next signal */ }
  try {
    return (serverTokenCount?.() ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Sign out's confirm: what to say and which buttons, given whether this device backed its key up. */
export function signOutWarning(backedUp) {
  if (backedUp) {
    return {
      title: ADMIN_KEY_COPY.signOutTitle,
      message: ADMIN_KEY_COPY.signOutBackedUpMessage,
      choices: [
        { id: "cancel", label: ADMIN_KEY_COPY.cancel, secondary: true },
        { id: "go", label: ADMIN_KEY_COPY.signOutBackedUpOk, danger: true },
      ],
    };
  }
  return {
    title: ADMIN_KEY_COPY.signOutTitle,
    message: ADMIN_KEY_COPY.signOutMessage,
    choices: [
      { id: "save", label: ADMIN_KEY_COPY.saveFirst, secondary: true },
      { id: "go", label: ADMIN_KEY_COPY.signOutAnyway, danger: true },
    ],
  };
}

/** The remove confirm: always the same words, save first or remove anyway. */
export function removeWarning() {
  return {
    title: ADMIN_KEY_COPY.removeTitle,
    message: ADMIN_KEY_COPY.removeMessage,
    choices: [
      { id: "save", label: ADMIN_KEY_COPY.saveFirst, secondary: true },
      { id: "go", label: ADMIN_KEY_COPY.removeAnyway, danger: true },
    ],
  };
}

/**
 * Save a backup of the account key before anything is removed: opens the
 * account-key export (the .flagshipkey ceremony), or says to unlock first
 * when the key is locked. Returns true when a file was written.
 *
 * @param {{ session?: object, backupKey?: () => Promise<boolean>, notify?: (text: string) => void }} deps
 */
export async function saveKeyFirst({ session, backupKey, notify } = {}) {
  if (!(session?.umk instanceof Uint8Array)) {
    notify?.(ADMIN_KEY_COPY.unlockFirst);
    return false;
  }
  return backupKey ? !!(await backupKey()) : false;
}
