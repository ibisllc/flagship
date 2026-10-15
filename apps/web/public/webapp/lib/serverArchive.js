// "Backup/clone server" (docs/server-backup-and-clone.md): the owner's device
// asks a server to seal a backup of all its apps, downloads it in chunks as
// one file, and later imports that file onto any server of the account under
// whatever name that server has.
//
// The file is sealed on the box with a key only the account's devices can
// derive (keystore.deriveServerArchiveKeyFromSeed, server-id independent);
// this device derives it, hands it over the pinned session for the minutes the
// box needs it, and never writes it anywhere. The file's first line is a
// readable header (id, source server, app names); the rest is ciphertext.

import { deriveServerArchiveKeyFromSeed } from "../keystore.js";

export const ARCHIVE_PATH = "/api/screens/server-archive";
export const RESTORE_PATH = "/api/screens/server-restore";
export const ARCHIVE_FILE_EXTENSION = ".flagship-backup";
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const HEADER_MAX_BYTES = 64 * 1024;

export const BACKUP_TITLE = "Backup/clone server";
export const BACKUP_NOTE =
  "Makes one file with all of this server's apps and their data. Keep it safe: only your own devices can open it. " +
  "To clone this server, add the new server first, then choose Add/Import a server → Import a backup.";
export const BACKUP_EXCLUDES_NOTE =
  "Holds your apps' source, data and settings, never system images: the server you import onto rebuilds each app, so any Flagship server can open it. Not included: API keys, the server's name and certificate, peer backups, and the Git host.";

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function newArchiveId(rng = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  return toHex(rng(16));
}

async function archiveKeyHex(umk, archiveId) {
  return toHex(await deriveServerArchiveKeyFromSeed(umk, archiveId));
}

/** Names a size the way people read it. */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** The file name a backup is offered under. */
export function backupFileName(sourceServer, createdAt) {
  const label = String(sourceServer || "server").split(".")[0].replace(/[^a-z0-9-]/gi, "") || "server";
  const day = new Date(createdAt || Date.now()).toISOString().slice(0, 10);
  return `${label}-${day}${ARCHIVE_FILE_EXTENSION}`;
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

/** Ask the server to make a backup. Resolves to the archive id. */
export async function startServerBackup({ client, umk, rng }) {
  if (!umk) throw new Error("unlock the webapp first");
  // One already being made (this dialog was closed and reopened): follow it.
  const current = await backupStatus({ client }).catch(() => null);
  if (current?.state === "building") return current.archiveId;
  const archiveId = newArchiveId(rng);
  await client.fetch(`${ARCHIVE_PATH}/start`, {
    method: "POST",
    body: JSON.stringify({ archiveId, key: await archiveKeyHex(umk, archiveId) }),
  });
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
    if (!a) throw new Error("the backup disappeared");
    if (a.state === "failed") throw new Error(a.reason || "the backup couldn't be made");
    if (a.state === "ready") return a;
    onProgress?.(a);
    if (now() > deadline) throw new Error("the backup is taking too long");
    await sleep(pollMs);
  }
}

/**
 * A link that downloads the ready backup straight from the server: the browser
 * saves it to disk as it arrives (nothing is held in this page), and the
 * server answers byte ranges, so the browser or a download manager can resume
 * it or fetch parts of it at once. The link carries its own token and works
 * until the backup expires (or a newer backup replaces it).
 */
export async function backupDownloadLink({ client }) {
  const r = await client.fetch(`${ARCHIVE_PATH}/link`, { method: "POST" });
  return {
    url: `${client.baseUrl.replace(/\/+$/, "")}${r.path}`,
    fileName: r.fileName,
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
 * the server, which checks it before serving the file to that request.
 */
export async function approveArchiveDownload({ client, serverDomain, archiveId, requestId, umk, signWithIrk, now = Date.now }) {
  if (!umk) throw new Error("unlock the webapp first");
  const approval = { serverDomain: serverDomain.toLowerCase(), archiveId, requestId, issuedAt: now() };
  const sig = await signWithIrk(umk, archiveDownloadCanonicalBytes(approval));
  await client.fetch(`${ARCHIVE_PATH}/approve`, {
    method: "POST",
    body: JSON.stringify({ approval, signature: toHex(sig) }),
  });
}

/**
 * Download the ready backup in THIS browser: approve a fresh request with this
 * device's own key, then let the browser fetch the file straight to disk
 * (resumable). The plain link (for another device) opens the server's page,
 * which asks the Flagship app to approve instead.
 */
export async function downloadHere({ client, serverDomain, archiveId, umk, signWithIrk, rng, doc }) {
  const link = await backupDownloadLink({ client });
  const requestId = newArchiveId(rng);
  await approveArchiveDownload({ client, serverDomain, archiveId, requestId, umk, signWithIrk });
  startBrowserDownload(`${link.url}/file?r=${requestId}`, link.fileName, doc);
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
// Import
// ---------------------------------------------------------------------------

/**
 * Read a picked file's header. Throws a readable error for anything that
 * isn't a Flagship backup.
 */
export async function readArchiveHeader(file) {
  const head = new Uint8Array(await file.slice(0, HEADER_MAX_BYTES).arrayBuffer());
  const nl = head.indexOf(0x0a);
  let h;
  try {
    if (nl < 0) throw new Error("no header");
    h = JSON.parse(new TextDecoder().decode(head.subarray(0, nl)));
  } catch {
    throw new Error("That isn't a Flagship backup.");
  }
  if (h?.magic !== "flagship-archive") throw new Error("That isn't a Flagship backup.");
  if (h.v !== 1) throw new Error("This backup is from a newer version of Flagship. Update the app and try again.");
  if (!/^[0-9a-f]{32}$/.test(String(h.archiveId))) throw new Error("This backup's header is damaged.");
  return {
    archiveId: h.archiveId,
    createdAt: Number(h.createdAt) || 0,
    sourceServer: String(h.sourceServer || ""),
    apps: Array.isArray(h.apps) ? h.apps.map((a) => ({ serviceId: String(a.serviceId), name: String(a.name) })) : [],
  };
}

/** Upload the file in order, then open it with the derived key. */
export async function importBackup({ client, file, umk, onBytes, fetchImpl = fetch }) {
  if (!umk) throw new Error("unlock the webapp first");
  const header = await readArchiveHeader(file);
  await client.fetch(`${RESTORE_PATH}/start`, {
    method: "POST",
    body: JSON.stringify({ archiveId: header.archiveId, bytes: file.size }),
  });
  for (let offset = 0; offset < file.size; offset += UPLOAD_CHUNK_BYTES) {
    const chunk = file.slice(offset, offset + UPLOAD_CHUNK_BYTES);
    const res = await fetchImpl(`${client.baseUrl.replace(/\/+$/, "")}${RESTORE_PATH}/chunk?offset=${offset}`, {
      method: "POST",
      headers: { "x-flagship-session": client.token(), "content-type": "application/octet-stream" },
      body: chunk,
    });
    if (!res.ok) {
      let why = `the server answered ${res.status}`;
      try {
        const b = await res.json();
        if (b?.error) why = b.error;
      } catch {
        /* not JSON */
      }
      throw new Error(why);
    }
    onBytes?.(Math.min(offset + chunk.size, file.size), file.size);
  }
  await client.fetch(`${RESTORE_PATH}/commit`, {
    method: "POST",
    body: JSON.stringify({ key: await archiveKeyHex(umk, header.archiveId) }),
  });
  return header;
}

export async function restoreStatus({ client }) {
  const r = await client.fetch(RESTORE_PATH);
  return r?.restore ?? null;
}

const RESTORE_DONE = new Set(["done", "failed"]);

/** Poll the import until it ends. Resolves to the final status; throws if it failed. */
export async function waitForRestore({ client, onProgress, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 2000, timeoutMs = 6 * 60 * 60_000, now = Date.now }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const s = await restoreStatus({ client });
    if (!s) throw new Error("the import disappeared");
    if (s.state === "failed") throw new Error(s.reason || "the import failed");
    if (RESTORE_DONE.has(s.state)) return s;
    onProgress?.(s);
    if (now() > deadline) throw new Error("the import is taking too long");
    await sleep(pollMs);
  }
}

/** One readable line per app of a finished import. */
export function describeRestoreApp(a) {
  if (a.state === "done") return `${a.name}: restored`;
  if (a.state === "skipped") return `${a.name}: skipped (${a.reason || "already here"})`;
  if (a.state === "failed") return `${a.name}: couldn't be restored (${a.reason || "unknown reason"})`;
  if (a.state === "restoring") return `${a.name}: restoring…`;
  return `${a.name}: waiting`;
}
