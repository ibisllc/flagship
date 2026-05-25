// `.flagshipkey` backup orchestration for the webapp recovery surface.
//
// This is the PRIMARY backup / recovery / cross-device path on the web:
// the browser has no Keychain or iCloud, so a downloadable encrypted
// key-file is the iCloud stand-in. Export reads the in-session UMK seed
// and writes <username>.flagshipkey; import unwraps the file and installs
// the seed into the keystore + session so the account is fully restored.
//
// The crypto lives in lib/keyfile.js (byte-compatible with the protocol +
// iOS). This module owns the UI ceremony (heavy warnings, the 3 required
// acknowledgments, strong-passphrase enforcement) and the keystore/state
// wiring. The download + modal helpers are injectable so the flow is
// unit-testable in a DOM-less environment.

import { wrapUmkToKeyfile, unwrapUmkFromKeyfile, KeyfileError } from "./keyfile.js";

/** Approved verbatim copy — keep in sync with the iOS strings. */
export const KEYFILE_COPY = {
  exportTitle: "Back up your account key",
  intro:
    "This saves your whole Flagship identity into one encrypted file. It's how you recover if you lose all your devices, and how you add this account to another device.",
  danger:
    "Anyone with both this file and its passphrase can take over your account and lock you out.",
  passphrase:
    "Set a passphrase to encrypt the file. You'll need the file and this passphrase to restore your account. We can't reset it.",
  acks: [
    "I understand anyone with this file and passphrase controls my entire account.",
    "I'll keep it offline and out of any cloud, shared folder, email, or chat.",
    "I understand no one can recover it for me — losing it can mean losing the account forever.",
  ],
  createButton: "Create backup file",
  afterSave: "Backup saved. Keep it somewhere safe and offline.",
  importBadPassphrase: "That passphrase didn't open the file.",
  importBadFile: "This isn't a Flagship key file.",
};

/**
 * Strong-passphrase gate for the export. Returns null when acceptable, or a
 * human-readable reason string when too weak. Deliberately self-contained
 * (no library): requires length 12+ and at least three of four character
 * classes — enough to keep an offline argon2id brute-force expensive.
 *
 * @param {string} pass
 * @returns {string|null}
 */
export function passphraseStrengthError(pass) {
  if (typeof pass !== "string" || pass.length < 12) {
    return "Use at least 12 characters.";
  }
  let classes = 0;
  if (/[a-z]/.test(pass)) classes++;
  if (/[A-Z]/.test(pass)) classes++;
  if (/[0-9]/.test(pass)) classes++;
  if (/[^a-zA-Z0-9]/.test(pass)) classes++;
  if (classes < 3) {
    return "Mix upper- and lower-case letters, numbers, and symbols.";
  }
  return null;
}

/**
 * Default browser download. Triggers a <a download> click for the given
 * filename + text. Injectable so callers/tests can substitute.
 *
 * @param {string} filename
 * @param {string} text
 */
export function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Sanitize a username into a safe filename stem. Falls back to "account". */
function fileStem(username) {
  const v = String(username ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
  return v || "account";
}

/**
 * Produce a `.flagshipkey` file for the given seed and download it.
 *
 * @param {object} opts
 * @param {Uint8Array} opts.seed         the 32-byte UMK seed (from session)
 * @param {string} opts.username
 * @param {string} [opts.accountId]
 * @param {string} opts.passphrase       already strength-checked
 * @param {(name:string,text:string)=>void} [opts.download]  injectable
 * @param {{m:number,t:number,p:number}} [opts.argonParams]  injectable (tests)
 * @returns {Promise<{ filename: string }>}
 */
export async function createBackupFile({
  seed,
  username,
  accountId,
  passphrase,
  download = downloadTextFile,
  argonParams,
}) {
  const meta = { username, ...(accountId ? { accountId } : {}) };
  const text = await wrapUmkToKeyfile(seed, passphrase, meta, argonParams);
  const filename = `${fileStem(username)}.flagshipkey`;
  download(filename, text);
  return { filename };
}

/**
 * Restore an account from a `.flagshipkey` file: unwrap the seed, install it
 * into the keystore under a fresh local passphrase, and populate the session.
 *
 * Throws KeyfileError (mapped to the approved copy by the caller) on a bad
 * file / wrong passphrase. Generic errors propagate as-is.
 *
 * @param {object} opts
 * @param {string} opts.fileText
 * @param {string} opts.passphrase            unlocks the file
 * @param {string} opts.localPassphrase       new at-rest passphrase for this device
 * @param {object} opts.keystore              { bootstrapFromExistingSeed, hasWrappedUmk, resetDevice }
 * @param {(seed:Uint8Array, username?:string)=>Promise<void>} opts.unlockSession
 * @returns {Promise<{ username: string, accountId?: string }>}
 */
export async function restoreFromBackupFile({
  fileText,
  passphrase,
  localPassphrase,
  keystore,
  unlockSession,
}) {
  const { seed, meta } = await unwrapUmkFromKeyfile(fileText, passphrase);
  // Installing on a device that already holds an identity would throw from
  // bootstrapFromExistingSeed; clear first so import is a clean restore.
  if (await keystore.hasWrappedUmk()) {
    await keystore.resetDevice();
  }
  await keystore.bootstrapFromExistingSeed(localPassphrase, seed);
  if (typeof globalThis.localStorage !== "undefined" && meta.username) {
    globalThis.localStorage.setItem("flagship.username", meta.username);
  }
  await unlockSession(seed, meta.username);
  return { username: meta.username, ...(meta.accountId ? { accountId: meta.accountId } : {}) };
}

/** Map a thrown error to the approved user-facing import message. */
export function importErrorMessage(err) {
  if (err instanceof KeyfileError) {
    if (err.code === "bad-passphrase") return KEYFILE_COPY.importBadPassphrase;
    return KEYFILE_COPY.importBadFile; // malformed / version
  }
  return err?.message ? String(err.message) : "Import failed.";
}
