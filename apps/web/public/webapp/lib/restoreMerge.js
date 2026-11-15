// Restore a backup into a running server (docs/restore-into-server.md §4): the canonical bytes of
// the stage, plan and undo orders, and the plan's digest. Mirrors packages/protocol/src/serverRestoreMerge.ts;
// test-vectors/server-restore-merge/ is the shared reference.

import { sha256 } from "../vendor/noble-hashes/sha2.js";
import { bytesToHex } from "../keystore.js";
import { tr } from "./i18n.js";

export const TAG_SERVER_RESTORE_STAGE = "flagship/server-restore-stage/v1";
export const TAG_SERVER_RESTORE_MERGE = "flagship/server-restore-merge/v1";
export const TAG_APP_RESTORE_UNDO = "flagship/app-restore-undo/v1";
export const RESTORE_MERGE_PLAN_MAX_TTL_MS = 24 * 60 * 60_000;

const SOURCES = ["upload", "saved", "pull", "peers"];
const ACTIONS = ["install", "skip", "keep", "replace", "replace-data", "copy"];
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const LABEL = "[a-z0-9](?:-?[a-z0-9]){0,31}";
const SERVICE_ID = new RegExp(`^${LABEL}--${LABEL}$`);
const CODE_DIGEST = /^(?:tree|sha256|wasi|manifest):[0-9a-f]{64}$/;
const enc = (s) => new TextEncoder().encode(s);

function domain(tag, d) {
  if (typeof d !== "string" || d.length === 0 || d.includes("|")) throw new Error(`${tag}: bad serverDomain`);
}
function time(tag, t) {
  if (!Number.isSafeInteger(t) || t < 0) throw new Error(`${tag}: bad time`);
}

export function serverRestoreStageBytes(o) {
  domain(TAG_SERVER_RESTORE_STAGE, o.serverDomain);
  if (!HEX32.test(o.archiveId) || !Number.isSafeInteger(o.bytes) || o.bytes < 1 || !HEX64.test(o.sha256) || !SOURCES.includes(o.source)) throw new Error(`${TAG_SERVER_RESTORE_STAGE}: bad order`);
  time(TAG_SERVER_RESTORE_STAGE, o.issuedAt);
  return enc([TAG_SERVER_RESTORE_STAGE, o.serverDomain, o.archiveId, String(o.bytes), o.sha256, o.source, String(o.issuedAt)].join("|"));
}

export function restoreMergePlanLine(l) {
  if (!SERVICE_ID.test(l.archivedServiceId) || !ACTIONS.includes(l.action)) throw new Error("restore plan: bad line");
  if (l.action === "copy" ? !(typeof l.targetServiceId === "string" && SERVICE_ID.test(l.targetServiceId)) : l.targetServiceId !== undefined) throw new Error("restore plan: bad target");
  if (l.sameApp && l.action !== "replace") throw new Error("restore plan: bad sameApp");
  const guarded = l.action === "replace" || l.action === "replace-data";
  if (guarded) {
    if (!CODE_DIGEST.test(l.guardCode ?? "") || !HEX64.test(l.guardSchema ?? "") || !Number.isSafeInteger(l.guardGen) || l.guardGen < 0 || l.guardGen > 999_999) throw new Error("restore plan: bad guards");
  } else if (l.guardCode !== undefined || l.guardSchema !== undefined || l.guardGen !== undefined) {
    throw new Error("restore plan: guards on an unguarded line");
  }
  return [l.archivedServiceId, l.action, l.targetServiceId ?? "-", l.sameApp ? "1" : "0", l.guardCode ?? "-", l.guardSchema ?? "-", l.guardGen === undefined ? "-" : String(l.guardGen)].join("|");
}

export function restoreMergePlanSha256(lines) {
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 500) throw new Error("restore plan: bad number of lines");
  const sorted = [...lines].sort((a, b) => (a.archivedServiceId < b.archivedServiceId ? -1 : a.archivedServiceId > b.archivedServiceId ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) if (sorted[i].archivedServiceId === sorted[i - 1].archivedServiceId) throw new Error("restore plan: an app named twice");
  return bytesToHex(sha256(enc(sorted.map(restoreMergePlanLine).join("\n"))));
}

export function serverRestoreMergeBytes(o) {
  domain(TAG_SERVER_RESTORE_MERGE, o.serverDomain);
  for (const k of ["restoreId", "archiveId"]) if (!HEX32.test(o[k])) throw new Error(`${TAG_SERVER_RESTORE_MERGE}: bad ${k}`);
  for (const k of ["sha256", "planSha256"]) if (!HEX64.test(o[k])) throw new Error(`${TAG_SERVER_RESTORE_MERGE}: bad ${k}`);
  time(TAG_SERVER_RESTORE_MERGE, o.issuedAt);
  time(TAG_SERVER_RESTORE_MERGE, o.expiresAt);
  if (o.expiresAt <= o.issuedAt || o.expiresAt - o.issuedAt > RESTORE_MERGE_PLAN_MAX_TTL_MS) throw new Error(`${TAG_SERVER_RESTORE_MERGE}: bad expiry`);
  return enc([TAG_SERVER_RESTORE_MERGE, o.serverDomain, o.restoreId, o.archiveId, o.sha256, o.planSha256, String(o.issuedAt), String(o.expiresAt)].join("|"));
}

export function appRestoreUndoBytes(o) {
  domain(TAG_APP_RESTORE_UNDO, o.serverDomain);
  if (!HEX32.test(o.restoreId) || !SERVICE_ID.test(o.serviceId) || (o.action !== "undo" && o.action !== "discard")) throw new Error(`${TAG_APP_RESTORE_UNDO}: bad order`);
  time(TAG_APP_RESTORE_UNDO, o.issuedAt);
  return enc([TAG_APP_RESTORE_UNDO, o.serverDomain, o.restoreId, o.serviceId, o.action, String(o.issuedAt)].join("|"));
}

// ---------------------------------------------------------------------------
// The client side (docs/restore-into-server.md §6.2, §7): the box's lane, the plan the owner picks,
// and what the screen says. Mirrors the iOS RestoreMergeViewModel.
// ---------------------------------------------------------------------------

export const MERGE_PATH = "/api/screens/server-restore-merge";
export const MERGE_CHUNK_BYTES = 4 * 1024 * 1024;
export const PLAN_TTL_MS = 6 * 60 * 60_000;
export const ACTION_ORDER = ["install", "keep", "replace", "replace-data", "copy", "skip"];
export const RESTORE_ADMIN_ONLY = tr("Only an admin device of this account can restore a backup.");
const COPY_SLUG = /^[a-z0-9](-?[a-z0-9]){0,29}$/;

export async function mergeStatus({ client }) {
  const v = await client.fetch(MERGE_PATH);
  return { stage: v?.stage ?? null, preview: v?.preview ?? null, run: v?.run ?? null, undo: Array.isArray(v?.undo) ? v.undo : [] };
}

/** Sign and send the stage order: the box may take and open this backup (it changes no app). */
export async function stageRestore({ client, serverDomain, archiveId, bytes, sha256: hash, source, sign, now = Date.now }) {
  const order = { serverDomain, archiveId, bytes, sha256: hash, source, issuedAt: now() };
  const signature = await sign(serverRestoreStageBytes(order));
  const r = await client.fetch(`${MERGE_PATH}/stage`, { method: "POST", body: JSON.stringify({ order, signatureHex: bytesToHex(signature) }) });
  return { restoreId: r?.restoreId, received: Number(r?.received) || 0, order };
}

/** Send the data part from where the box has got to (a 409 names the offset it wants). */
export async function sendMergeData({ client, blob, from = 0, onBytes, fetchImpl = fetch, isCancelled = () => false, chunkBytes = MERGE_CHUNK_BYTES }) {
  let offset = from;
  onBytes?.(offset, blob.size);
  while (offset < blob.size) {
    if (isCancelled()) throw Object.assign(new Error("cancelled"), { code: "cancelled" });
    let chunk;
    try {
      chunk = new Uint8Array(await blob.slice(offset, offset + chunkBytes).arrayBuffer());
    } catch {
      throw Object.assign(new Error("unreadable"), { userMessage: tr("The backup file can't be read any more (was its drive removed?). Pick it again.") });
    }
    const res = await fetchImpl(`${client.baseUrl.replace(/\/+$/, "")}${MERGE_PATH}/chunk?offset=${offset}`, {
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
    if (!res.ok) throw Object.assign(new Error(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`), { status: res.status, body });
    offset = Number(body?.received) || offset + chunk.length;
    onBytes?.(offset, blob.size);
  }
}

export async function commitMerge({ client, contentKey }) {
  await client.fetch(`${MERGE_PATH}/commit`, { method: "POST", body: JSON.stringify({ key: bytesToHex(contentKey) }) });
}

/** Poll until the box has built the preview (or says why it couldn't). */
export async function waitForPreview({ client, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 1500, isCancelled = () => false }) {
  for (;;) {
    if (isCancelled()) throw Object.assign(new Error("cancelled"), { code: "cancelled" });
    const v = await mergeStatus({ client });
    if (v.preview && v.stage?.state === "previewed") return v;
    if (v.stage?.state === "failed") throw Object.assign(new Error("failed"), { userMessage: v.stage.reason || tr("The backup couldn't be opened.") });
    await sleep(pollMs);
  }
}

export async function cancelMerge({ client }) {
  await client.fetch(`${MERGE_PATH}/cancel`, { method: "POST", body: "{}" });
}

/** The account a server belongs to: `<server>.<account>.<apex>`. */
export function accountOf(serverDomain) {
  return String(serverDomain).toLowerCase().split(".")[1] ?? "";
}

export function copySlug(serviceId) {
  return String(serviceId ?? "").split("--").pop() ?? "";
}

export function validCopySlug(s) {
  return COPY_SLUG.test(String(s ?? ""));
}

/** The defaults the owner accepted: the box's recommendation for every app. */
export function defaultChoices(preview) {
  const out = {};
  for (const a of preview?.apps ?? []) out[a.archivedServiceId] = { action: a.recommended, copyName: copySlug(a.copyServiceId), sameApp: false };
  return out;
}

/** Choose an action for one app; only what the box allows for it. Returns the new choices. */
export function choose(choices, app, action) {
  if (!app.allowed?.includes(action)) return choices;
  const c = choices[app.archivedServiceId] ?? { action: app.recommended, copyName: copySlug(app.copyServiceId), sameApp: false };
  return { ...choices, [app.archivedServiceId]: { ...c, action, sameApp: action === "replace" && app.verdict === "clash-maybe" } };
}

export function groupOf(app) {
  if (app.verdict === "new" || app.verdict === "runs-elsewhere") return "new";
  if (app.verdict === "same") return "already";
  return "different";
}

/** Something besides keep and skip is chosen and every copy has a valid name. */
export function canRestore(choices) {
  const all = Object.values(choices ?? {});
  return all.some((c) => c.action !== "keep" && c.action !== "skip") && all.filter((c) => c.action === "copy").every((c) => validCopySlug(c.copyName));
}

/** The signed plan's lines: exactly what is shown, with the guards the preview gave for each replace. */
export function planLines(preview, choices, serverDomain) {
  const account = accountOf(serverDomain);
  return (preview?.apps ?? []).map((a) => {
    const c = choices[a.archivedServiceId] ?? { action: a.recommended, copyName: "", sameApp: false };
    const guarded = c.action === "replace" || c.action === "replace-data";
    const line = { archivedServiceId: a.archivedServiceId, action: c.action, sameApp: !!c.sameApp };
    if (c.action === "copy") line.targetServiceId = `${account}--${c.copyName}`;
    if (guarded && a.guards) {
      line.guardCode = a.guards.guardCode;
      line.guardSchema = a.guards.guardSchema;
      line.guardGen = a.guards.guardGen;
    }
    return line;
  });
}

/** Sign the plan and start the run. */
export async function sendPlan({ client, serverDomain, restoreId, archiveId, sha256: hash, lines, sign, now = Date.now }) {
  const issuedAt = now();
  const order = { serverDomain, restoreId, archiveId, sha256: hash, planSha256: restoreMergePlanSha256(lines), issuedAt, expiresAt: issuedAt + PLAN_TTL_MS };
  const signature = await sign(serverRestoreMergeBytes(order));
  await client.fetch(`${MERGE_PATH}/plan`, { method: "POST", body: JSON.stringify({ order, signatureHex: bytesToHex(signature), lines }) });
  return order;
}

/** Undo a replaced app (put its earlier copy back) or delete the earlier copy now; both signed. */
export async function sendUndo({ client, serverDomain, point, discard, sign, now = Date.now }) {
  const order = { serverDomain, restoreId: point.restoreId, serviceId: point.serviceId, action: discard ? "discard" : "undo", issuedAt: now() };
  const signature = await sign(appRestoreUndoBytes(order));
  await client.fetch(`${MERGE_PATH}/undo`, { method: "POST", body: JSON.stringify({ order, signatureHex: bytesToHex(signature) }) });
}

// ---- what the screen says ----

export function comparisonText(a) {
  const box = a.box;
  if (!box) return a.verdict === "runs-elsewhere" ? tr("Runs on {0} (its data is likely newer)", (a.alsoOn ?? []).join(", ")) : tr("Not on this server");
  const b = a.backup?.version ?? "";
  const x = box.version ?? "";
  switch (a.code) {
    case "same":
      return tr("Same version as this server's: {0}", x);
    case "backup-older":
      return a.codeByVersion ? tr("The backup is probably older: {0} vs {1}", b, x) : tr("The backup is older: {0} vs {1}", b, x);
    case "backup-newer":
      return a.codeByVersion ? tr("The backup is probably newer: {0} vs {1}", b, x) : tr("The backup is newer: {0} vs {1}", b, x);
    case "diverged":
      return tr("Changed separately here and in the backup: {0} vs {1}", b, x);
    default:
      return tr("Backup {0}, this server {1}", b, x);
  }
}

export function actionName(action) {
  switch (action) {
    case "install":
      return tr("Restore it");
    case "skip":
      return tr("Leave it out");
    case "keep":
      return tr("Keep this server's");
    case "replace":
      return tr("Restore the backup's version");
    case "replace-data":
      return tr("Use the backup's data with this server's version");
    case "copy":
      return tr("Add as a separate app");
    default:
      return action;
  }
}

export function consequenceText(action, a) {
  switch (action) {
    case "install":
      return a.verdict === "runs-elsewhere"
        ? tr("Comes back here too. Who can use it follows its list on your other servers.")
        : tr("Comes back with its data. Nobody from the backup's list can use it until you approve.");
    case "skip":
      return tr("Nothing changes on this server.");
    case "keep":
      return tr("Nothing changes. This server's version and data stay.");
    case "replace":
      return tr("This server's copy is kept for 7 days, so you can undo. Who can use it: unchanged.");
    case "replace-data":
      return tr("This server's version runs on the backup's data. This server's copy is kept for 7 days. Who can use it: unchanged.");
    case "copy":
      return tr("A new app with its own address. Nobody can use it until you invite them.");
    default:
      return "";
  }
}

export function refusalText(code) {
  switch (code) {
    case "not-on-server":
      return tr("It isn't on this server.");
    case "already-on-server":
      return tr("It is already on this server.");
    case "different-app":
      return tr("It is a different app with the same name.");
    case "schema-newer":
      return tr("The backup's data is newer than this server's version can read.");
    case "schema-diverged":
      return tr("The backup's data and this server's changed separately.");
    case "stores-differ":
      return tr("The backup keeps its data differently from this server's version.");
    case "no-copy-name":
      return tr("There is no free name for a copy.");
    case "busy":
      return tr("It is being changed right now. Try again when that is done.");
    default:
      return tr("Not possible for this app.");
  }
}

export function notesFor(a, action) {
  const out = [];
  if ((a.alsoOn ?? []).length && a.box) out.push(tr("Also runs on {0}: not changed.", a.alsoOn.join(", ")));
  if (a.addressMoves && action === "install") out.push(tr("Its address will move to this server (it is first in your server order)."));
  if ((action === "replace" || action === "replace-data" || action === "install") && a.backup?.hasDatabase === true) out.push(tr("Jobs saved in the backup may run again."));
  if ((action === "replace" || action === "replace-data") && a.backup?.hasFiles === true) out.push(tr("Files the app keeps are read as the backup left them."));
  return out;
}

export function stepText(step) {
  switch (step) {
    case "done":
      return tr("Restored");
    case "kept":
      return tr("Kept");
    case "skipped":
      return tr("Left out");
    case "failed":
      return tr("Couldn't restore. It is back as it was.");
    case "refused-changed":
      return tr("Changed since you chose. Kept as it is.");
    case "waiting":
      return tr("Waiting");
    default:
      return tr("Restoring…");
  }
}
