// Restore a backup into a running server (docs/restore-into-server.md §4): the canonical bytes of
// the stage, plan and undo orders, and the plan's digest. Mirrors packages/protocol/src/serverRestoreMerge.ts;
// test-vectors/server-restore-merge/ is the shared reference.

import { sha256 } from "../vendor/noble-hashes/sha2.js";
import { bytesToHex } from "../keystore.js";

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
