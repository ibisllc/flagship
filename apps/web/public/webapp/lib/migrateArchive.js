// Migrate's data path (docs/server-migration.md, "Data path"): the old
// server's apps are paused and it makes a backup; the new server takes a
// restore order for it, pulls the one .flagship file straight from the old
// server (an approved download link), and this device hands it the content
// key. Every step uses the backup primitives; nothing goes through peers.

import { deriveServerArchiveKeyFromSeed } from "../keystore.js";
import { userError } from "./humanError.js";
import { approveArchiveDownload, commitRestore, newArchiveId, waitForRestore } from "./serverArchive.js";
import { openWithAccountKey, parseBackupFile, serverRestoreCanonicalBytes } from "./serverBackupFormat.js";
import { SAVED_PATH, depositKeys, savedView } from "./savedBackups.js";

const RESTORE_PATH = "/api/screens/server-restore";
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Rough rates for the estimate: making a backup and restoring one, on the box's own disk. */
const BACKUP_BYTES_PER_SEC = 60 * 1024 * 1024;
const RESTORE_BYTES_PER_SEC = 40 * 1024 * 1024;
const PER_APP_SEC = 30;

/** Minutes the apps will be paused, from the backup size, the measured link speed and the app count. */
export function estimateDowntimeSec({ archiveBytes, bytesPerSecond, apps }) {
  const bytes = Math.max(0, Number(archiveBytes) || 0);
  const link = Math.max(64 * 1024, Number(bytesPerSecond) || 0);
  return Math.ceil(bytes / BACKUP_BYTES_PER_SEC + bytes / link + bytes / RESTORE_BYTES_PER_SEC + (Number(apps) || 0) * PER_APP_SEC);
}

export function downtimeText(sec) {
  if (!Number.isFinite(sec)) return "";
  if (sec < 90) return "about a minute";
  const min = Math.round(sec / 60);
  if (min < 90) return `about ${min} minutes`;
  return `about ${Math.round(min / 60)} hours`;
}

/** Size the move and time the link between the two servers. */
export async function estimateMove({ oldClient, newClient, oldFqdn }) {
  const est = await oldClient.fetch(`${SAVED_PATH}/estimate`);
  const probe = await oldClient.fetch("/api/screens/server-archive/probe-link", { method: "POST" });
  const speed = await newClient.fetch(`${RESTORE_PATH}/probe`, { method: "POST", body: JSON.stringify({ url: `https://${oldFqdn}${probe.path}` }) });
  const sec = estimateDowntimeSec({ archiveBytes: est.archiveBytes, bytesPerSecond: speed.bytesPerSecond, apps: est.apps });
  return { archiveBytes: est.archiveBytes, apps: est.apps, bytesPerSecond: speed.bytesPerSecond, downtimeSec: sec };
}

/**
 * Move the data: pause + back up the old server, send the new one its
 * restore order, let it pull the file, hand it the key, wait for its apps.
 * `onProgress({ step: "backup"|"transfer"|"restore", pct, text })`.
 */
export async function moveData({ oldClient, newClient, oldFqdn, newFqdn, umk, sign, canSignAdmin, onProgress = () => {}, pollMs = 2000, rng }) {
  if (!umk) throw userError("Unlock the webapp first.");
  // 1. The old server needs a key for the move's backup (one approval for a batch).
  let view = await savedView({ client: oldClient });
  if (Number(view.keysLeft) === 0) {
    if (!canSignAdmin) throw userError("Only an admin device of this account can move a server.");
    view = await depositKeys({ client: oldClient, serverDomain: oldFqdn, umk, count: view.keysWanted || 400, sign });
  }
  // 2. Pause the apps and make the backup.
  const started = await oldClient.fetch(`${SAVED_PATH}/run`, { method: "POST", body: JSON.stringify({ purpose: "migrate" }) });
  const archiveId = started.archiveId;
  let entry = null;
  for (;;) {
    view = await savedView({ client: oldClient });
    entry = (view.backups ?? []).find((b) => b.archiveId === archiveId) ?? null;
    if (entry) break;
    if (!view.running && view.lastRun && view.lastRun.ok === false) {
      throw userError(`The backup for the move failed: ${String(view.lastRun.reason ?? "").replace(/[.\s]+$/, "")}. The old server's apps are running again.`);
    }
    const p = view.running?.progress;
    onProgress({ step: "backup", pct: p?.total ? Math.round((p.done / p.total) * 100) : 0, text: "Backing up the old server…" });
    await sleep(pollMs);
  }
  onProgress({ step: "backup", pct: 100, text: "Backed up." });
  // 3. Open the backup file with this account's key.
  const text = await oldClient.fetch(`${SAVED_PATH}/${archiveId}/backup-file`).then((r) => (typeof r === "string" ? r : JSON.stringify(r)));
  const file = parseBackupFile(text);
  const opened = await openWithAccountKey(file, await deriveServerArchiveKeyFromSeed(umk, archiveId));
  if (!opened) throw userError("This device couldn't open the move's backup.");
  const data = opened.body.data;
  // 4. The new server waits for exactly that backup.
  const order = { serverDomain: newFqdn.toLowerCase(), archiveId, bytes: data.bytes, sha256: data.sha256, issuedAt: Date.now() };
  const signatureHex = toHex(await sign(serverRestoreCanonicalBytes(order)));
  await newClient.fetch(`${RESTORE_PATH}/order`, { method: "POST", body: JSON.stringify({ order, signatureHex }) });
  // 5. An approved download link on the old server, pulled by the new one.
  const link = await oldClient.fetch(`${SAVED_PATH}/${archiveId}/link`, { method: "POST" });
  const requestId = newArchiveId(rng);
  await approveArchiveDownload({ client: oldClient, serverDomain: oldFqdn, archiveId, requestId, umk, signWithIrk: (u, b) => sign(b) });
  const pullBody = JSON.stringify({ url: `https://${oldFqdn}${link.path}`, requestId });
  await newClient.fetch(`${RESTORE_PATH}/pull`, { method: "POST", body: pullBody });
  let retries = 0;
  for (;;) {
    const st = await newClient.fetch(RESTORE_PATH);
    const r = st.restore;
    if (r?.state === "ready") break;
    if (r && !r.pulling && r.reason) {
      if (++retries > 5) throw userError(`The new server couldn't fetch the backup: ${String(r.reason).replace(/[.\s]+$/, "")}.`);
      await newClient.fetch(`${RESTORE_PATH}/pull`, { method: "POST", body: pullBody });
    }
    onProgress({ step: "transfer", pct: r?.bytes ? Math.round((r.received / r.bytes) * 100) : 0, text: "Sending the backup to the new server…" });
    await sleep(pollMs);
  }
  onProgress({ step: "transfer", pct: 100, text: "Sent." });
  // 6. The key; every app is tried, then it ends.
  await commitRestore({ client: newClient, contentKey: opened.contentKey });
  const done = await waitForRestore({
    client: newClient,
    pollMs,
    onProgress: (st) => {
      const apps = st.restore?.apps ?? [];
      const n = apps.filter((a) => a.state === "done" || a.state === "failed" || a.state === "skipped").length;
      onProgress({ step: "restore", pct: apps.length ? Math.round((n / apps.length) * 100) : 0, text: "Restoring the apps on the new server…" });
    },
  });
  onProgress({ step: "restore", pct: 100, text: "Restored." });
  return { archiveId, apps: done.apps ?? [] };
}

/** Abort: the old server's apps run again. */
export async function resumeOld({ oldClient }) {
  await oldClient.fetch(`${SAVED_PATH}/resume`, { method: "POST" });
}
