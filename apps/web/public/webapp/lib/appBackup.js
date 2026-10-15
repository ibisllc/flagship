// An app's "Back up now" (iOS AppBackupController, Android AppBackupViewModel):
// the box packs the app's code and, if asked, its data (encrypted under an
// optional password), then hands the archive out ONCE at /api/backups/<id> to
// a paired session and deletes it. A plain <a href> can't send the session
// header, so this device fetches the archive itself and saves the Blob. The
// bytes go box → this device only.

import { ScreensError } from "./api.js";

export const APP_BACKUP_START_PATH = "/api/screens/app-backup/start";
const FETCH_PREFIX = "/api/backups/";

/** `<slug>-backup-<yyyy-MM-dd-HHmm>.tar.gz` (UTC), `.enc` added when encrypted. */
export function appBackupFileName(serviceId, encrypted, date = new Date()) {
  const id = String(serviceId ?? "");
  const slug = id.split("--").pop() || id || "app";
  const iso = date.toISOString();
  const stamp = `${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
  return `${slug}-backup-${stamp}.tar.gz${encrypted ? ".enc" : ""}`;
}

/** "12 KB", "3.4 MB" for the ready line. */
export function formatBackupSize(n) {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Ask the box to pack the app. Resolves to its start answer. */
export async function startAppBackup({ client, serviceId, includeUserData, password }) {
  const body = await client.fetch(APP_BACKUP_START_PATH, {
    method: "POST",
    body: JSON.stringify({
      serviceId,
      includeUserData: !!includeUserData,
      ...(password ? { password } : {}),
    }),
  });
  // The service worker queues this POST when offline and answers 202.
  if (body?.queued) throw new ScreensError("offline", 0);
  if (typeof body?.fetchPath !== "string" || !/^\/api\/backups\/[0-9a-f]+$/.test(body.fetchPath)) {
    throw new ScreensError("the server didn't say where to fetch the backup", 502);
  }
  return body;
}

/**
 * Fetch the packed archive once, with this device's session for that box.
 * Resolves to a Blob: the browser holds the bytes, never a JS string.
 */
export async function fetchAppBackup({ client, fetchPath, fetchImpl = fetch }) {
  if (!String(fetchPath).startsWith(FETCH_PREFIX)) throw new ScreensError("invalid backup path", 0);
  const token = client.token();
  if (!client.baseUrl) throw new ScreensError("not paired to a server yet", 0);
  if (!token) throw new ScreensError("no session token; re-pair", 0);
  const res = await fetchImpl(`${client.baseUrl.replace(/\/+$/, "")}${fetchPath}`, {
    headers: { "x-flagship-session": token },
  });
  if (!res.ok) {
    const reason = await res.json().catch(() => null);
    throw new ScreensError(reason?.error || `HTTP ${res.status}`, res.status, reason);
  }
  return res.blob();
}

/**
 * The whole "Back up now": pack, then fetch. `onPhase("creating" |
 * "downloading")` drives the button label.
 */
export async function backUpApp({ client, serviceId, includeUserData, password, onPhase, fetchImpl, now = () => new Date() }) {
  onPhase?.("creating");
  const started = await startAppBackup({ client, serviceId, includeUserData, password });
  onPhase?.("downloading");
  const blob = await fetchAppBackup({ client, fetchPath: started.fetchPath, ...(fetchImpl ? { fetchImpl } : {}) });
  const encrypted = !!started.encrypted;
  return { blob, bytes: blob.size, encrypted, fileName: appBackupFileName(serviceId, encrypted, now()) };
}
