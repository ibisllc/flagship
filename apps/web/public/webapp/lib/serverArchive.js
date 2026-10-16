// "Backup/clone server" (docs/server-backup-and-clone.md): the owner's device
// asks a server to make a backup of all its apps (two files: a small backup
// file and the data file), downloads both, and later restores them onto a new
// server that was created to wait for exactly that backup.
//
// This device makes the content key and the key slots (a passcode slot via
// Argon2id, and an account slot from the UMK), hands the box the key and the
// slots over the pinned session for the minutes it needs them, and never
// writes the key anywhere. The format lives in serverBackupFormat.js.

import { deriveServerArchiveKeyFromSeed } from "../keystore.js";
import { asSentence, boxErrorText, userError } from "./humanError.js";
import {
  BACKUP_DATA_EXTENSION,
  BACKUP_FILE_EXTENSION,
  wrapAccountSlot,
  wrapPasscodeSlot,
} from "./serverBackupFormat.js";

export const ARCHIVE_PATH = "/api/screens/server-archive";
export const RESTORE_PATH = "/api/screens/server-restore";
export { BACKUP_FILE_EXTENSION, BACKUP_DATA_EXTENSION };
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

export const BACKUP_TITLE = "Backup/clone server";
export const BACKUP_EXCLUDES_NOTE =
  "Holds your apps' source, data and settings, never system images: the new server rebuilds each app, so any Flagship server can restore it. Not included: the server's keys and certificate, peer backups, and the Git host.";
export const PASSCODE_NOTE =
  "Anyone with both files and this passcode can restore the backup, on any account, so keep it somewhere safe and apart from the files. It can't be reset. Your own devices open your backups without it.";

/** What a backup or restore step's failure says to the owner: this device's own
 *  sentence, the box's reason (e.g. "needs about 12 GB"), else humanError. */
export function archiveErrorText(e) {
  return boxErrorText(e);
}

const trimStop = (s) => String(s ?? "").trim().replace(/[.\s]+$/, "");

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const random = (n) => crypto.getRandomValues(new Uint8Array(n));

export function newArchiveId(rng = random) {
  return toHex(rng(16));
}

/** Names a size the way people read it. */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** The names a backup's two files are offered under. */
export function backupFileNames(sourceServer, createdAt) {
  const label = String(sourceServer || "server").split(".")[0].replace(/[^a-z0-9-]/gi, "") || "server";
  const stem = `${label}-${new Date(createdAt || Date.now()).toISOString().slice(0, 10)}`;
  return { backup: `${stem}${BACKUP_FILE_EXTENSION}`, data: `${stem}${BACKUP_DATA_EXTENSION}` };
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/**
 * Ask the server to make a backup protected by `passcode` (and openable by
 * this account's devices). Resolves to the archive id. A backup already being
 * made (the dialog was closed and reopened) is followed instead.
 */
export async function startServerBackup({ client, umk, passcode, rng = random, argonParams }) {
  if (!umk) throw userError("Unlock the webapp first.");
  const current = await backupStatus({ client }).catch(() => null);
  if (current?.state === "building") return current.archiveId;
  // Reopening the dialog on a finished backup (no new passcode) shows it again.
  if (current?.state === "ready" && !passcode) return current.archiveId;
  if (!passcode) throw userError("Choose a passcode first.");
  const archiveId = newArchiveId(rng);
  const contentKey = rng(32);
  try {
    const slots = [
      await wrapPasscodeSlot(archiveId, contentKey, passcode, rng(16), rng(12), argonParams),
      await wrapAccountSlot(archiveId, contentKey, await deriveServerArchiveKeyFromSeed(umk, archiveId), rng(12)),
    ];
    await client.fetch(`${ARCHIVE_PATH}/start`, {
      method: "POST",
      body: JSON.stringify({ archiveId, key: toHex(contentKey), slots }),
    });
  } finally {
    contentKey.fill(0);
  }
  return archiveId;
}

/** `{ archive }` as the server reports it (`null` ⇒ none). */
export async function backupStatus({ client }) {
  const r = await client.fetch(ARCHIVE_PATH);
  return r?.archive ?? null;
}

/** Wait until the backup is ready (or failed), reporting progress. */
export async function waitForBackup({ client, onProgress, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 1500, timeoutMs = 6 * 60 * 60_000, now = Date.now }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const a = await backupStatus({ client });
    if (!a) throw userError("The backup disappeared from the server.");
    if (a.state === "failed") throw userError(`The backup failed: ${trimStop(a.reason) || "the backup couldn't be made"}.`);
    if (a.state === "ready") return a;
    onProgress?.(a);
    if (now() > deadline) throw userError("The backup is taking too long.");
    await sleep(pollMs);
  }
}

/**
 * A link to the ready backup on the server: its page asks the Flagship app to
 * approve, then the browser saves both files straight to disk (the data file
 * resumably). The link works until the backup expires.
 */
export async function backupDownloadLink({ client }) {
  const r = await client.fetch(`${ARCHIVE_PATH}/link`, { method: "POST" });
  return {
    url: `${client.baseUrl.replace(/\/+$/, "")}${r.path}`,
    backupFileName: r.backupFileName,
    dataFileName: r.dataFileName,
    bytes: r.bytes,
    expiresAt: r.expiresAt,
  };
}

export const TAG_ARCHIVE_DOWNLOAD = "flagship/archive-download/v1";

/** `flagship/archive-download/v1|<serverDomain>|<archiveId>|<requestId>|<issuedAt>`.
 *  Must pass packages/protocol/test-vectors/archive-download/vectors.json. */
export function archiveDownloadCanonicalBytes({ serverDomain, archiveId, requestId, issuedAt }) {
  if (!serverDomain || /[|\r\n]/.test(serverDomain)) throw new Error("archive-download: bad serverDomain");
  if (!/^[0-9a-f]{32}$/.test(archiveId) || !/^[0-9a-f]{32}$/.test(requestId)) throw new Error("archive-download: bad id");
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error("archive-download: bad issuedAt");
  return new TextEncoder().encode([TAG_ARCHIVE_DOWNLOAD, serverDomain, archiveId, requestId, String(issuedAt)].join("|"));
}

/** The 6-digit code the download page and the approving app both show. */
export function archiveDownloadCode(requestId) {
  return String(Number.parseInt(requestId.slice(0, 8), 16) % 1_000_000).padStart(6, "0");
}

/**
 * Approve one browser request for the ready backup: sign
 * `flagship/archive-download/v1` with the sensitive-order key and hand it to
 * the server, which checks it before serving the files to that request.
 */
export async function approveArchiveDownload({ client, serverDomain, archiveId, requestId, umk, signWithIrk, now = Date.now }) {
  if (!umk) throw userError("Unlock the webapp first.");
  const approval = { serverDomain: serverDomain.toLowerCase(), archiveId, requestId, issuedAt: now() };
  const sig = await signWithIrk(umk, archiveDownloadCanonicalBytes(approval));
  await client.fetch(`${ARCHIVE_PATH}/approve`, {
    method: "POST",
    body: JSON.stringify({ approval, signature: toHex(sig) }),
  });
}

/**
 * Download the ready backup in THIS browser: approve a fresh request with this
 * device's own key, then let the browser fetch both files straight to disk.
 */
export async function downloadHere({ client, serverDomain, archiveId, umk, signWithIrk, rng, doc, gapMs = 800 }) {
  const link = await backupDownloadLink({ client });
  const requestId = newArchiveId(rng);
  await approveArchiveDownload({ client, serverDomain, archiveId, requestId, umk, signWithIrk });
  startBrowserDownload(`${link.url}/backup?r=${requestId}`, link.backupFileName, doc);
  // Some browsers drop a second download started in the same tick.
  await new Promise((r) => setTimeout(r, gapMs));
  startBrowserDownload(`${link.url}/file?r=${requestId}`, link.dataFileName, doc);
  return link;
}

/** Start the browser's own download of `url` (no in-page buffering). */
export function startBrowserDownload(url, fileName, doc = document) {
  const a = doc.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  doc.body.appendChild(a);
  a.click();
  a.remove();
}

/** Remove the server's copy (the link stops working). */
export async function forgetBackup({ client }) {
  await client.fetch(ARCHIVE_PATH, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Restore onto a server that waits for this backup
// ---------------------------------------------------------------------------

/** `{ waiting, restore }` as the server reports them. */
export async function restoreStatus({ client }) {
  const r = await client.fetch(RESTORE_PATH);
  return { waiting: r?.waiting ?? null, restore: r?.restore ?? null };
}

/**
 * Upload the data file in order, picking up where the server says it has
 * got to. Reads one slice at a time from wherever the file is.
 */
export async function uploadDataFile({ client, blob, archiveId, onBytes, fetchImpl = fetch, isCancelled = () => false, chunkBytes = UPLOAD_CHUNK_BYTES }) {
  const start = await client.fetch(`${RESTORE_PATH}/start`, {
    method: "POST",
    body: JSON.stringify({ archiveId, bytes: blob.size }),
  });
  let offset = Number(start?.received) || 0;
  onBytes?.(offset, blob.size);
  while (offset < blob.size) {
    if (isCancelled()) throw Object.assign(new Error("cancelled"), { code: "cancelled" });
    let chunk;
    try {
      chunk = new Uint8Array(await blob.slice(offset, offset + chunkBytes).arrayBuffer());
    } catch {
      throw userError("The data file can't be read any more (was its drive removed?). The server keeps waiting: pick the backup again to carry on.");
    }
    const res = await fetchImpl(`${client.baseUrl.replace(/\/+$/, "")}${RESTORE_PATH}/chunk?offset=${offset}`, {
      method: "POST",
      headers: { "x-flagship-session": client.token(), "content-type": "application/octet-stream" },
      body: chunk,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    if (res.status === 409 && Number.isSafeInteger(body?.received)) {
      offset = body.received;
      continue;
    }
    if (!res.ok) {
      if (typeof body?.error === "string" && body.error) throw userError(asSentence(body.error), { status: res.status });
      throw Object.assign(new Error(`the server answered ${res.status}`), { status: res.status });
    }
    offset = Number(body?.received) || offset + chunk.length;
    onBytes?.(offset, blob.size);
  }
}

/** Hand the server the content key: it checks the data file, opens it and restores the apps. */
export async function commitRestore({ client, contentKey }) {
  await client.fetch(`${RESTORE_PATH}/commit`, {
    method: "POST",
    body: JSON.stringify({ key: toHex(contentKey) }),
  });
}

/** Poll the restore until it ends. Resolves to the final status; throws if it failed. */
export async function waitForRestore({ client, onProgress, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 2000, timeoutMs = 6 * 60 * 60_000, now = Date.now, isCancelled = () => false }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (isCancelled()) throw Object.assign(new Error("cancelled"), { code: "cancelled" });
    const { restore } = await restoreStatus({ client });
    if (!restore) throw userError("The restore disappeared from the server.");
    if (restore.state === "failed") throw userError(`The restore failed: ${trimStop(restore.reason) || "unknown reason"}.`);
    if (restore.state === "done") return restore;
    onProgress?.(restore);
    if (now() > deadline) throw userError("The restore is taking too long.");
    await sleep(pollMs);
  }
}

/** One readable line per app of a restore. */
export function describeRestoreApp(a) {
  if (a.state === "done") return `${a.name}: restored`;
  if (a.state === "skipped") return `${a.name}: skipped (${a.reason || "already here"})`;
  if (a.state === "failed") return `${a.name}: couldn't be restored (${a.reason || "unknown reason"})`;
  if (a.state === "restoring") return `${a.name}: restoring…`;
  return `${a.name}: waiting`;
}
