// Never push anyone to destroy the key that can still save their data
// (docs/account-gone.md "The admin key is the way out"). The account's admin
// key on this device is the user's only reliable way to save their servers'
// data: a hostile or vanished `.com` can cut the passkey recovery route, and
// it can say the account does not exist, but it cannot take the key from the
// device. So anything that removes it (Remove it from this browser and Create a
// new account on the "account was removed" screen, Sign out and Remove this
// device in Settings) first says so, in plain words, and offers to save first.
//
// Pure copy and decisions here; the dialogs call them (lib/accountGoneUi.js,
// views/settings.js). Mirror the strings exactly on iOS and Android.

import { isAdminDevice } from "./memberRoles.js";

export const ADMIN_KEY_COPY = Object.freeze({
  /** The account-gone screen's primary action. */
  saveData: "Save my servers' data",
  comingSoon: "Coming soon",
  /** Removing the account's keys from this browser (account-gone screen, Remove this device). */
  removeTitle: "Remove this account from this browser?",
  removeMessage:
    "This also removes this browser's admin key. Without it you can no longer save your servers' data. Save it first, or remove anyway.",
  saveFirst: "Save my data first",
  removeAnyway: "Remove anyway",
  /** Settings, Sign out, on an admin device. */
  signOutTitle: "Sign out?",
  signOutMessage:
    "Signing out removes this device's admin key. Without it you can no longer save your servers' data. Save it first, or sign out anyway.",
  signOutAnyway: "Sign out anyway",
  /** The same, once this device has written an account-key file. */
  signOutBackedUpMessage:
    "Signing out removes this device's admin key. You backed up your account key, so keep that file and its passphrase safe: with them you can still save your servers' data.",
  signOutBackedUpOk: "Sign out",
  cancel: "Cancel",
  /** Shown when a save-first path needs the key unlocked. */
  unlockFirst: "Unlock first to save your key.",
});

/**
 * Does this device hold a key that can still save a server's data: the
 * account's admin root (in memory this session, or the sealed record on
 * disk) or a session for any server? Every input is injectable for tests.
 *
 * @param {{ session?: object, hasAdminRootRecord?: () => Promise<boolean>, serverTokenCount?: () => number }} deps
 */
export async function holdsRescueKey({ session, hasAdminRootRecord, serverTokenCount } = {}) {
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
 * Save the data before anything is removed. The rescue flow (docs/
 * data-sovereignty.md) is not on this build yet, so until it lands this opens
 * the account-key backup, the one artifact that still opens the servers.
 * Returns true when something was saved.
 *
 * @param {{ rescue?: (() => Promise<boolean>) | null, session?: object, backupKey?: () => Promise<boolean>, notify?: (text: string) => void }} deps
 */
export async function saveDataFirst({ rescue = null, session, backupKey, notify } = {}) {
  if (rescue) return !!(await rescue());
  if (!(session?.umk instanceof Uint8Array)) {
    notify?.(ADMIN_KEY_COPY.unlockFirst);
    return false;
  }
  return backupKey ? !!(await backupKey()) : false;
}
