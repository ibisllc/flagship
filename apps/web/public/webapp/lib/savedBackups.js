// The server's saved and scheduled backups (docs/server-backup-and-clone.md,
// "Scheduled backups"): the same two files as Back up now, made by the box on
// a schedule, kept on the server, listed, downloaded and deleted here.
//
// The box can't make a backup's account slot by itself, so an admin device
// hands it a signed batch of archive ids with their slot keys:
//
//   flagship/server-archive-keys/v1|<serverDomain>|<count>|<digest>|<issuedAt>
//   digest = SHA-256 hex of the lines "<archiveId>:<kekHex>" joined with "\n"
//
// Must pass packages/protocol/test-vectors/server-archive-keys/vectors.json.

import { deriveServerArchiveKeyFromSeed } from "../keystore.js";
import { approveArchiveDownload, newArchiveId, startBrowserDownload } from "./serverArchive.js";

import { tr, trn } from "./i18n.js";
export const SAVED_PATH = "/api/screens/server-archive/backups";
export const TAG_SERVER_ARCHIVE_KEYS = "flagship/server-archive-keys/v1";
export const MAX_KEYS_PER_DEPOSIT = 400;
export const SAVED_FILES_NOTE =
  tr("Each backup is one .flagship file. Import a backup on Home restores it. It opens on your own devices without a passcode.");
export const DELETE_CONFIRM = tr("Delete this backup from the server?");

const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export async function archiveKeysDigest(keys) {
  for (const k of keys) {
    if (!/^[0-9a-f]{32}$/.test(k.archiveId) || !/^[0-9a-f]{64}$/.test(k.kekHex)) throw new Error("archive-keys: bad key");
  }
  const text = keys.map((k) => `${k.archiveId}:${k.kekHex}`).join("\n");
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

export function archiveKeysCanonicalBytes({ serverDomain, count, digest, issuedAt }) {
  if (!serverDomain || /[|\r\n]/.test(serverDomain)) throw new Error("archive-keys: bad serverDomain");
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_KEYS_PER_DEPOSIT) throw new Error("archive-keys: bad count");
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("archive-keys: bad digest");
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error("archive-keys: bad issuedAt");
  return new TextEncoder().encode([TAG_SERVER_ARCHIVE_KEYS, serverDomain, String(count), digest, String(issuedAt)].join("|"));
}

/** `count` fresh archive ids with their account-slot keys. */
export async function mintArchiveKeys(umk, count, rng) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const archiveId = newArchiveId(rng);
    out.push({ archiveId, kekHex: toHex(await deriveServerArchiveKeyFromSeed(umk, archiveId)) });
  }
  return out;
}

/** The deposit body for `keys`, signed with the sensitive-order key. */
export async function keysDeposit({ serverDomain, keys, sign, issuedAt = Date.now() }) {
  const deposit = { serverDomain: String(serverDomain).toLowerCase(), count: keys.length, digest: await archiveKeysDigest(keys), issuedAt };
  return { deposit, signature: toHex(await sign(archiveKeysCanonicalBytes(deposit))), keys };
}

/** Whether this device should send keys now: an admin device, and the box asks for some. */
export function shouldDepositKeys(view, canSignAdmin) {
  return !!canSignAdmin && Number(view?.keysWanted) > 0;
}

export async function depositKeys({ client, serverDomain, umk, count, sign, rng }) {
  const keys = await mintArchiveKeys(umk, Math.min(MAX_KEYS_PER_DEPOSIT, Math.max(1, count)), rng);
  const body = await keysDeposit({ serverDomain, keys, sign });
  return client.fetch(`${SAVED_PATH}/keys`, { method: "POST", body: JSON.stringify(body) });
}

export async function savedView({ client }) {
  return client.fetch(SAVED_PATH);
}

export async function runNow({ client }) {
  return client.fetch(`${SAVED_PATH}/run`, { method: "POST" });
}

export async function putSchedule({ client, schedule }) {
  return client.fetch(`${SAVED_PATH}/schedule`, { method: "PUT", body: JSON.stringify(schedule) });
}

export async function deleteSaved({ client, archiveId }) {
  return client.fetch(`${SAVED_PATH}/${archiveId}`, { method: "DELETE" });
}

/** Download a saved backup in this browser: approve a fresh request with this device's key, then the one file. */
export async function downloadSaved({ client, serverDomain, archiveId, umk, signWithIrk, rng, doc }) {
  const r = await client.fetch(`${SAVED_PATH}/${archiveId}/link`, { method: "POST" });
  const url = `${client.baseUrl.replace(/\/+$/, "")}${r.path}`;
  const requestId = newArchiveId(rng);
  await approveArchiveDownload({ client, serverDomain, archiveId, requestId, umk, signWithIrk });
  startBrowserDownload(`${url}/bundle?r=${requestId}`, r.bundleFileName, doc);
  return r;
}

// ---------------------------------------------------------------------------
// Schedule: the box keeps UTC; the page shows and sets local time.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60_000;

/** Local "HH:MM" (and local weekday 0..6 for weekly) → { minuteOfDayUtc, weekdayUtc }. */
export function localToUtc({ hour, minute, weekday = 0, frequency }, ref = new Date()) {
  const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), hour, minute, 0, 0);
  if (frequency === "weekly") {
    const delta = (weekday - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + delta);
  }
  return { minuteOfDayUtc: d.getUTCHours() * 60 + d.getUTCMinutes(), weekdayUtc: d.getUTCDay() };
}

/** { minuteOfDayUtc, weekdayUtc } → local { hour, minute, weekday }. */
export function utcToLocal({ minuteOfDayUtc, weekdayUtc = 0, frequency }, ref = new Date()) {
  const base = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()) + minuteOfDayUtc * 60_000;
  let t = base;
  if (frequency === "weekly") {
    const delta = (weekdayUtc - new Date(t).getUTCDay() + 7) % 7;
    t += delta * DAY;
  }
  const d = new Date(t);
  return { hour: d.getHours(), minute: d.getMinutes(), weekday: d.getDay() };
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function timeText(hour, minute) {
  return new Date(2000, 0, 1, hour, minute).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "Daily at 3:00 AM · keeps 7 daily and 4 weekly" */
export function scheduleLine(s, ref = new Date()) {
  if (!s || s.frequency === "off") return tr("Scheduled backups are off.");
  const l = utcToLocal(s, ref);
  const when = s.frequency === "weekly" ? tr("Weekly on {0} at {1}", WEEKDAYS[l.weekday], timeText(l.hour, l.minute)) : tr("Daily at {0}", timeText(l.hour, l.minute));
  return `${when} · keeps ${s.keepDaily} daily and ${s.keepWeekly} weekly`;
}

const trimStop = (s) => String(s ?? "").trim().replace(/[.\s]+$/, "");

/** The status line and, when the last run failed, the box's sentence. */
export function statusLines(view, { formatBytes, formatTime = (t) => new Date(t).toLocaleString() }) {
  const out = { status: "", failed: "", next: "" };
  if (view?.running) {
    const p = view.running.progress ?? {};
    out.status = `Backing up… ${p.app || ""}${p.total ? ` (${p.done}/${p.total})` : ""}`.trim();
  } else if (view?.backups?.[0]) {
    const b = view.backups[0];
    out.status = tr("Last backup: {0} · {1}", formatTime(b.createdAt), formatBytes(b.bundleBytes ?? b.bytes + b.backupBytes));
  } else {
    out.status = tr("No backups yet.");
  }
  if (view?.lastRun && view.lastRun.ok === false) out.failed = tr("The last backup failed: {0}.", trimStop(view.lastRun.reason) || "the backup couldn't be made");
  if (view?.scheduleActive === false || view?.schedule?.frequency === "off") out.next = tr("Scheduled backups are off.");
  else if (view?.nextRunAt) out.next = tr("Next backup: {0}", formatTime(view.nextRunAt));
  else if (view?.waitingReason) out.next = `${trimStop(view.waitingReason).replace(/^./, (c) => c.toUpperCase())}.`;
  return out;
}

/** One row of the list: "Oct 16, 3:00 AM · 1.2 GB · Scheduled · 3 apps" and a left-out line. */
export function rowText(b, { formatBytes, formatTime = (t) => new Date(t).toLocaleString() }) {
  const n = b.apps?.length ?? 0;
  const main = trn(n, "{1} · {2} · {3} · {0} app", "{1} · {2} · {3} · {0} apps", formatTime(b.createdAt), formatBytes(b.bundleBytes ?? b.bytes + b.backupBytes), b.trigger === "schedule" ? "Scheduled" : tr("Back up now"));
  const left = b.left?.length ? tr("Left out: {0}", b.left.map((x) => x.name).join(", ")) : "";
  return { main, left };
}
