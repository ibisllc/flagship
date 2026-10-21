// Peer backup between accounts (docs/peer-backup.md), the device's side.
//
//   status   GET  /api/screens/peer-backup/status        the v2 screen: holders as Server 1..n
//   root     POST /api/screens/peer-backup/root          a lost server's record, opened by a running box
//   restore  POST /api/screens/server-restore/from-peers the waiting new server fetches the pieces
//
// A device of the account makes the keys for any of its servers, a dead one
// too: SWK = deriveSWK(UMK, serverId), PBK = HKDF(SWK, "flagship/peer-backup-key/v1").
// Must pass packages/protocol/test-vectors/peer-backup/vectors.json.

import { deriveSwkFromSeed, hexToBytes, bytesToHex, hkdf32 } from "../keystore.js";
import { userError } from "./humanError.js";
import { RESTORE_PATH } from "./serverArchive.js";

import { tr, trn, dateLocale } from "./i18n.js";
export const PEER_STATUS_PATH = "/api/screens/peer-backup/status";
export const PEER_ROOT_PATH = "/api/screens/peer-backup/root";
export const FROM_PEERS_PATH = `${RESTORE_PATH}/from-peers`;
const INFO_PBK = "flagship/peer-backup-key/v1";
const INFO_ROOT = "flagship/pb-root/v1";
const DAY_MS = 24 * 60 * 60 * 1000;

/** PBK (lowercase hex) of `serverId`'s peer backups, from the account key. */
export async function derivePbkHex(umkSeed, serverId) {
  const id = String(serverId ?? "").trim().toLowerCase();
  if (!/^[a-z0-9.-]{1,253}$/.test(id)) throw userError(tr("That isn't a server address."));
  const swk = hexToBytes(await deriveSwkFromSeed(umkSeed, id));
  try {
    return bytesToHex(await hkdf32(swk, INFO_PBK));
  } finally {
    swk.fill(0);
  }
}

/** Open a sealed root ({nonceHex, ciphertextHex}) with the PBK; the same checks as the box. */
export async function openSealedRoot(sealed, pbkHex, serverId) {
  const enc = new TextEncoder();
  const rootKey = await hkdf32(hexToBytes(pbkHex), INFO_ROOT);
  const key = await crypto.subtle.importKey("raw", rootKey, "AES-GCM", false, ["decrypt"]);
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: tr("AES-GCM"), iv: hexToBytes(sealed.nonceHex), additionalData: enc.encode(`${INFO_ROOT}|${serverId}`) },
      key,
      hexToBytes(sealed.ciphertextHex),
    );
  } catch {
    throw userError(tr("The peer backup record doesn't open with this account's key."));
  }
  const root = JSON.parse(new TextDecoder().decode(plain));
  if (root?.v !== 1 || root.serverId !== serverId) throw userError(tr("That peer backup record is for another server."));
  return root;
}

/** What the box's /root answers, made from an opened record. */
export function summaryOfRoot(root) {
  const members = (root.stripes ?? []).flat();
  return {
    serverId: root.serverId,
    generation: root.generation,
    revision: root.revision,
    createdAt: root.createdAt,
    archive: root.archive,
    holders: members.length,
    needed: root.network?.k ?? 1,
    keepUntil: members.length ? Math.min(...members.map((m) => m.expiresAt)) : 0,
  };
}

/**
 * The lost server's record. A running server of the account answers it
 * (`client`); with none running, this device reads the sealed record from
 * `.com` itself and opens it (it is public and sealed under a key only the
 * account has).
 */
export async function describePeerRoot({ client = null, umkSeed, serverId, fetchImpl = null, comBase = null }) {
  const id = String(serverId).trim().toLowerCase();
  const pbkHex = await derivePbkHex(umkSeed, id);
  if (client) {
    const r = await client.fetch(PEER_ROOT_PATH, { method: "POST", body: JSON.stringify({ serverId: id, pbkHex }) });
    if (!r?.archive) throw userError(tr("No peer backup of that server was found."));
    return r;
  }
  const f = fetchImpl ?? (await import("./comFetch.js")).comFetch;
  const url = fetchImpl ? `${comBase}/api/peer-backup/root/${encodeURIComponent(id)}` : `/api/peer-backup/root/${encodeURIComponent(id)}`;
  const res = await f(url);
  if (res.status === 404) throw userError(tr("No peer backup of that server was found."));
  if (res.status === 503) throw userError(tr("Peer backup between accounts isn't set up on this server yet."));
  if (!res.ok) throw userError(tr("Couldn't reach the peer backup record. Try again in a moment."));
  return summaryOfRoot(await openSealedRoot(await res.json(), pbkHex, id));
}

/** Start the waiting server's fetch of the backup from peers. */
export async function startPeerRestore({ client, umkSeed, serverId }) {
  const pbkHex = await derivePbkHex(umkSeed, serverId);
  return client.fetch(FROM_PEERS_PATH, { method: "POST", body: JSON.stringify({ serverId: String(serverId).trim().toLowerCase(), pbkHex }) });
}

/**
 * Wait until the waiting server has the whole data file from peers
 * (restore state "ready"), reporting progress. A failed fetch (the job keeps
 * a reason and stays "uploading") throws with the box's own sentence.
 */
export async function waitForPeerData({ client, onProgress, isCancelled = () => false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 2000, timeoutMs = 6 * 60 * 60_000, now = Date.now }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (isCancelled()) throw Object.assign(new Error("cancelled"), { code: "cancelled" });
    const r = await client.fetch(RESTORE_PATH);
    const job = r?.restore ?? null;
    if (!job) throw userError(tr("The restore disappeared from the server."));
    if (job.reason && ["uploading", "failed"].includes(job.state)) {
      throw userError(`${String(job.reason).replace(/[.\s]+$/, "")}.`);
    }
    if (["ready", "checking", "restoring", "done"].includes(job.state)) return job;
    onProgress?.(job);
    if (now() > deadline) throw userError(tr("Getting the backup from other servers is taking too long."));
    await sleep(pollMs);
  }
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const STATE_TITLE = {
  "waiting-for-peers": tr("Looking for servers to keep pieces"),
  filling: tr("Getting ready"),
  placing: tr("Sending pieces to other servers"),
  protected: tr("Protected"),
  "at-risk": tr("At risk"),
  leaving: tr("Leaving peer backups"),
  off: "Off",
};
const STATE_NOTE = {
  "waiting-for-peers": tr("Peer backup starts once enough other servers can hold it."),
  filling: tr("This server is setting aside space for other servers' pieces first."),
  placing: tr("Your newest backup is being spread over other servers."),
  protected: tr("Enough of the servers holding your pieces answer to bring your backup back."),
  "at-risk": tr("Too few pieces are safe. Your server is moving them to other servers."),
  leaving: tr("This server stops taking new pieces and frees its space in two weeks."),
  off: tr("Choose Peer-distributed backups in this server's Backups to turn it on."),
};
const HOLDER_STATE = { ok: tr("Answering"), checking: tr("Checking"), failing: tr("Not answering"), offline: tr("Offline") };

export const stateTitle = (s) => STATE_TITLE[s] ?? String(s ?? "");
export const stateNote = (s) => STATE_NOTE[s] ?? "";

export function formatSize(n) {
  if (!Number.isFinite(n) || n < 0) return "";
  const GB = 1024 ** 3;
  if (n >= GB) return `${(n / GB).toFixed(n < 10 * GB ? 1 : 0)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(0, Math.round(n / 1024))} KB`;
}

/** The list for the status page: "Server 1: Answering · proof 2 hours ago · 12 pieces". */
export function holderRows(status, { formatTime = (t) => new Date(t).toLocaleString(dateLocale()) } = {}) {
  return (status?.holderList ?? []).map((h) => ({
    label: String(h.label ?? ""),
    state: h.state,
    line: [
      HOLDER_STATE[h.state] ?? String(h.state ?? ""),
      Number.isFinite(h.lastProofAt) && h.lastProofAt > 0 ? tr("last proof {0}", formatTime(h.lastProofAt)) : tr("no proof yet"),
      trn(h.bricks ?? 0, "{0} piece", "{0} pieces"),
    ].join(" · "),
  }));
}

/** The date by which a lost server's backup must be restored, or "". */
export function restoreByLine(keepUntil, { now = Date.now(), formatTime = (t) => new Date(t).toLocaleDateString(dateLocale()) } = {}) {
  if (!Number.isFinite(keepUntil) || keepUntil <= 0) return "";
  if (keepUntil <= now) return tr("The pieces of this backup are no longer kept.");
  const days = Math.ceil((keepUntil - now) / DAY_MS);
  return trn(days, "Restore by {1} ({0} day left).", "Restore by {1} ({0} days left).", formatTime(keepUntil));
}

/** What this server keeps for others. */
export function hostingLines(status) {
  const h = status?.hosting;
  if (!h || !(h.poolBytes > 0)) return [];
  const out = [
    tr("Pool: {0}, of which {1} holds other servers' pieces and {2} is proof filler.", formatSize(h.poolBytes), formatSize(h.realBytes), formatSize(h.fillerBytes)),
    tr("Proven so far: {0}.", formatSize(h.provenBytes)),
  ];
  if (h.leaving) out.push("This server is leaving peer backups.");
  return out;
}

/** The card a restore shows once a lost server's record is found. */
export function rootLines(summary, opts = {}) {
  const a = summary?.archive ?? {};
  const out = [tr("Backup of {0}, saved {1} ({2}).", summary.serverId, new Date(a.createdAt).toLocaleString(dateLocale()), formatSize(a.bytes))];
  out.push(trn(summary.holders, "{0} server holds its pieces; {1} bring it back.", "{0} servers hold its pieces; {1} bring it back.", summary.needed));
  const by = restoreByLine(summary.keepUntil, opts);
  if (by) out.push(by);
  return out;
}
