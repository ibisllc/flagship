// An app's disk use and limits (docs/app-runtimes.md §5.3), as the box sends
// them on app-detail and server-detail (`storage`): one line per store, and
// the sentence shown while new data is refused.

import { formatGb } from "./backupPolicy.js";

import { tr } from "./i18n.js";
export const FULL_SENTENCE = tr("Full: new data is refused until you free space or raise the limit.");
export const STOPPED_SENTENCE = tr("Its database is closed until it is under its limit again.");
export const STORAGE_FULL_ALERT = tr("An app on this server is full");

function size(n) {
  if (!Number.isFinite(n)) return "";
  if (n >= 1024 ** 3) return formatGb(n);
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(0, Math.round(n / 1024))} KB`;
}

function storeLine(label, s) {
  if (!s) return null;
  const text = s.limitBytes == null ? size(s.usedBytes) : tr("{0} of {1}", size(s.usedBytes), size(s.limitBytes));
  const full = !!(s.full || s.writesBlocked);
  return {
    label,
    text,
    full,
    note: s.stopped ? STOPPED_SENTENCE : full ? FULL_SENTENCE : "",
  };
}

/** The app page's lines: `[{ label, text, full, note }]`, files then database. */
export function appStorageLines(storage) {
  if (!storage || typeof storage !== "object") return [];
  return [storeLine("Files", storage.files), storeLine("Database", storage.postgres)].filter(Boolean);
}

/** The server page's lines about apps that are full and the disk brake. */
export function serverStorageNotes(storage, nameOf = (id) => id) {
  if (!storage || typeof storage !== "object") return [];
  const out = [];
  if (storage.brake === "hard") out.push("The server's disk is full: apps' folders are read-only until there's room.");
  else if (storage.brake === "on") out.push("The server's disk is nearly full: apps can't save more until there's room.");
  for (const a of storage.apps ?? []) {
    const full = (a.files && a.files.full) || (a.postgres && (a.postgres.full || a.postgres.writesBlocked));
    if (full) out.push(tr("{0} is full: new data is refused until you free space or raise the limit.", nameOf(a.serviceId)));
  }
  return out;
}
