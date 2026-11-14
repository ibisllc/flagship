/**
 * Restore a backup into a running server, app by app (docs/restore-into-server.md
 * §4). Three owner-signed orders, each under the sensitive-order key (the
 * admin root on a box that pins one):
 *
 *   flagship/server-restore-stage/v1|<serverDomain>|<archiveId>|<bytes>|<sha256>|<source>|<issuedAt>
 *     the box may take and open this one backup; it changes no app.
 *   flagship/server-restore-merge/v1|<serverDomain>|<restoreId>|<archiveId>|<sha256>|<planSha256>|<issuedAt>|<expiresAt>
 *     the box may do exactly the plan whose lines hash to planSha256.
 *   flagship/app-restore-undo/v1|<serverDomain>|<restoreId>|<serviceId>|<undo|discard>|<issuedAt>
 *     put an app's kept copy back, or delete it now.
 *
 * A plan line is
 *   <archivedServiceId>|<action>|<targetServiceId or ->|<sameApp 0|1>|<guardCode or ->|<guardSchema or ->|<guardGen or ->
 * and planSha256 is the SHA-256 (lowercase hex) of the lines sorted by archived
 * id and joined with "\n". The guards pin the state of the app on the server
 * the owner decided on; keep and skip lines carry none.
 */
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { ed } from "./edSync.js";
import { legacyFieldGuard, resolveMsgSigner, type MsgSigner } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_SERVER_RESTORE_STAGE = "flagship/server-restore-stage/v1";
export const TAG_SERVER_RESTORE_MERGE = "flagship/server-restore-merge/v1";
export const TAG_APP_RESTORE_UNDO = "flagship/app-restore-undo/v1";

/** How old a stage, plan or undo order may be when it reaches the box. */
export const RESTORE_MERGE_ORDER_MAX_AGE_MS = 10 * 60_000;
/** The furthest a plan's expiry may be after its issue time. */
export const RESTORE_MERGE_PLAN_MAX_TTL_MS = 24 * 60 * 60_000;
/** The most lines a plan may hold (a backup holds at most this many apps). */
export const RESTORE_MERGE_MAX_LINES = 500;

export const RESTORE_MERGE_SOURCES = ["upload", "saved", "pull", "peers"] as const;
export type RestoreMergeSource = (typeof RESTORE_MERGE_SOURCES)[number];

export const RESTORE_MERGE_ACTIONS = ["install", "skip", "keep", "replace", "replace-data", "copy"] as const;
export type RestoreMergeAction = (typeof RESTORE_MERGE_ACTIONS)[number];

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const LABEL = "[a-z0-9](?:-?[a-z0-9]){0,31}";
const SERVICE_ID = new RegExp(`^${LABEL}--${LABEL}$`);
const CODE_DIGEST = /^(?:tree|sha256|wasi|manifest):[0-9a-f]{64}$/;
const enc = (s: string): Bytes => new TextEncoder().encode(s);

function checkTime(what: string, t: number): void {
  if (!Number.isSafeInteger(t) || t < 0) throw new Error(`${what}: bad time`);
}

function checkDomain(what: string, d: string): void {
  if (d.length === 0) throw new Error(`${what}: empty serverDomain`);
  legacyFieldGuard("serverDomain", d);
}

export function isServiceIdForRestore(s: string): boolean {
  return SERVICE_ID.test(s);
}

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

export interface ServerRestoreStageOrder {
  serverDomain: string;
  archiveId: string;
  /** The data file's exact size and SHA-256 (lowercase hex). */
  bytes: number;
  sha256: string;
  source: RestoreMergeSource;
  issuedAt: number;
}

export function serverRestoreStageCanonicalBytes(o: ServerRestoreStageOrder): Bytes {
  checkDomain("server-restore-stage", o.serverDomain);
  if (!HEX32.test(o.archiveId)) throw new Error("server-restore-stage: bad archiveId");
  if (!Number.isSafeInteger(o.bytes) || o.bytes < 1) throw new Error("server-restore-stage: bad bytes");
  if (!HEX64.test(o.sha256)) throw new Error("server-restore-stage: bad sha256");
  if (!(RESTORE_MERGE_SOURCES as readonly string[]).includes(o.source)) throw new Error("server-restore-stage: bad source");
  checkTime("server-restore-stage", o.issuedAt);
  return enc([TAG_SERVER_RESTORE_STAGE, o.serverDomain, o.archiveId, String(o.bytes), o.sha256, o.source, String(o.issuedAt)].join("|"));
}

export function signServerRestoreStage(o: ServerRestoreStageOrder, signer: MsgSigner): Bytes {
  return resolveMsgSigner(signer)(serverRestoreStageCanonicalBytes(o));
}

/** Never throws. */
export function verifyServerRestoreStage(o: ServerRestoreStageOrder, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, serverRestoreStageCanonicalBytes(o), pub);
  } catch {
    return false;
  }
}

export function parseServerRestoreStage(v: unknown): ServerRestoreStageOrder | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.serverDomain !== "string" || typeof r.archiveId !== "string" || typeof r.sha256 !== "string" || typeof r.source !== "string") return null;
  if (typeof r.bytes !== "number" || typeof r.issuedAt !== "number") return null;
  const o: ServerRestoreStageOrder = { serverDomain: r.serverDomain, archiveId: r.archiveId, bytes: r.bytes, sha256: r.sha256, source: r.source as RestoreMergeSource, issuedAt: r.issuedAt };
  try {
    serverRestoreStageCanonicalBytes(o);
  } catch {
    return null;
  }
  return o;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface RestoreMergePlanLine {
  archivedServiceId: string;
  action: RestoreMergeAction;
  /** The new app's id, for `copy` only. */
  targetServiceId?: string;
  /** 1 only when the owner said a clash is the same app (a `replace` over it). */
  sameApp: boolean;
  /** The server app's state the owner chose on: replace and replace-data only. */
  guardCode?: string;
  guardSchema?: string;
  guardGen?: number;
}

function guarded(a: RestoreMergeAction): boolean {
  return a === "replace" || a === "replace-data";
}

/** One line's canonical form; throws on a line that can't be signed. */
export function restoreMergePlanLineString(l: RestoreMergePlanLine): string {
  if (!SERVICE_ID.test(l.archivedServiceId)) throw new Error("restore plan: bad archived id");
  if (!(RESTORE_MERGE_ACTIONS as readonly string[]).includes(l.action)) throw new Error("restore plan: bad action");
  if (l.action === "copy") {
    if (!l.targetServiceId || !SERVICE_ID.test(l.targetServiceId)) throw new Error("restore plan: a copy names its new app");
  } else if (l.targetServiceId !== undefined) {
    throw new Error("restore plan: only a copy names a new app");
  }
  if (l.sameApp && l.action !== "replace") throw new Error("restore plan: only a replace says a clash is the same app");
  if (guarded(l.action)) {
    if (!l.guardCode || !CODE_DIGEST.test(l.guardCode)) throw new Error("restore plan: bad code guard");
    if (!l.guardSchema || !HEX64.test(l.guardSchema)) throw new Error("restore plan: bad schema guard");
    if (l.guardGen === undefined || !Number.isSafeInteger(l.guardGen) || l.guardGen < 0 || l.guardGen > 999_999) throw new Error("restore plan: bad generation guard");
  } else if (l.guardCode !== undefined || l.guardSchema !== undefined || l.guardGen !== undefined) {
    throw new Error("restore plan: only replace and replace-data carry guards");
  }
  return [
    l.archivedServiceId,
    l.action,
    l.targetServiceId ?? "-",
    l.sameApp ? "1" : "0",
    l.guardCode ?? "-",
    l.guardSchema ?? "-",
    l.guardGen === undefined ? "-" : String(l.guardGen),
  ].join("|");
}

/** SHA-256 hex of the plan lines sorted by archived id; refuses an empty plan or one naming an app twice. */
export function restoreMergePlanSha256(lines: readonly RestoreMergePlanLine[]): string {
  if (lines.length === 0 || lines.length > RESTORE_MERGE_MAX_LINES) throw new Error("restore plan: bad number of lines");
  const sorted = [...lines].sort((a, b) => (a.archivedServiceId < b.archivedServiceId ? -1 : a.archivedServiceId > b.archivedServiceId ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.archivedServiceId === sorted[i - 1]!.archivedServiceId) throw new Error("restore plan: an app named twice");
  }
  return bytesToHex(sha256(enc(sorted.map(restoreMergePlanLineString).join("\n"))));
}

export function parseRestoreMergePlanLine(v: unknown): RestoreMergePlanLine | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.archivedServiceId !== "string" || typeof r.action !== "string" || typeof r.sameApp !== "boolean") return null;
  for (const k of ["targetServiceId", "guardCode", "guardSchema"]) if (r[k] !== undefined && typeof r[k] !== "string") return null;
  if (r.guardGen !== undefined && typeof r.guardGen !== "number") return null;
  const l: RestoreMergePlanLine = {
    archivedServiceId: r.archivedServiceId,
    action: r.action as RestoreMergeAction,
    sameApp: r.sameApp,
    ...(r.targetServiceId !== undefined ? { targetServiceId: r.targetServiceId as string } : {}),
    ...(r.guardCode !== undefined ? { guardCode: r.guardCode as string } : {}),
    ...(r.guardSchema !== undefined ? { guardSchema: r.guardSchema as string } : {}),
    ...(r.guardGen !== undefined ? { guardGen: r.guardGen as number } : {}),
  };
  try {
    restoreMergePlanLineString(l);
  } catch {
    return null;
  }
  return l;
}

export interface ServerRestoreMergeOrder {
  serverDomain: string;
  restoreId: string;
  archiveId: string;
  sha256: string;
  planSha256: string;
  issuedAt: number;
  expiresAt: number;
}

export function serverRestoreMergeCanonicalBytes(o: ServerRestoreMergeOrder): Bytes {
  checkDomain("server-restore-merge", o.serverDomain);
  if (!HEX32.test(o.restoreId)) throw new Error("server-restore-merge: bad restoreId");
  if (!HEX32.test(o.archiveId)) throw new Error("server-restore-merge: bad archiveId");
  if (!HEX64.test(o.sha256)) throw new Error("server-restore-merge: bad sha256");
  if (!HEX64.test(o.planSha256)) throw new Error("server-restore-merge: bad planSha256");
  checkTime("server-restore-merge", o.issuedAt);
  checkTime("server-restore-merge", o.expiresAt);
  if (o.expiresAt <= o.issuedAt || o.expiresAt - o.issuedAt > RESTORE_MERGE_PLAN_MAX_TTL_MS) throw new Error("server-restore-merge: bad expiry");
  return enc([TAG_SERVER_RESTORE_MERGE, o.serverDomain, o.restoreId, o.archiveId, o.sha256, o.planSha256, String(o.issuedAt), String(o.expiresAt)].join("|"));
}

export function signServerRestoreMerge(o: ServerRestoreMergeOrder, signer: MsgSigner): Bytes {
  return resolveMsgSigner(signer)(serverRestoreMergeCanonicalBytes(o));
}

/** Never throws. */
export function verifyServerRestoreMerge(o: ServerRestoreMergeOrder, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, serverRestoreMergeCanonicalBytes(o), pub);
  } catch {
    return false;
  }
}

export function parseServerRestoreMerge(v: unknown): ServerRestoreMergeOrder | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  for (const k of ["serverDomain", "restoreId", "archiveId", "sha256", "planSha256"]) if (typeof r[k] !== "string") return null;
  if (typeof r.issuedAt !== "number" || typeof r.expiresAt !== "number") return null;
  const o: ServerRestoreMergeOrder = {
    serverDomain: r.serverDomain as string,
    restoreId: r.restoreId as string,
    archiveId: r.archiveId as string,
    sha256: r.sha256 as string,
    planSha256: r.planSha256 as string,
    issuedAt: r.issuedAt,
    expiresAt: r.expiresAt,
  };
  try {
    serverRestoreMergeCanonicalBytes(o);
  } catch {
    return null;
  }
  return o;
}

// ---------------------------------------------------------------------------
// Undo and discard
// ---------------------------------------------------------------------------

export type AppRestoreUndoAction = "undo" | "discard";

export interface AppRestoreUndoOrder {
  serverDomain: string;
  restoreId: string;
  serviceId: string;
  action: AppRestoreUndoAction;
  issuedAt: number;
}

export function appRestoreUndoCanonicalBytes(o: AppRestoreUndoOrder): Bytes {
  checkDomain("app-restore-undo", o.serverDomain);
  if (!HEX32.test(o.restoreId)) throw new Error("app-restore-undo: bad restoreId");
  if (!SERVICE_ID.test(o.serviceId)) throw new Error("app-restore-undo: bad serviceId");
  if (o.action !== "undo" && o.action !== "discard") throw new Error("app-restore-undo: bad action");
  checkTime("app-restore-undo", o.issuedAt);
  return enc([TAG_APP_RESTORE_UNDO, o.serverDomain, o.restoreId, o.serviceId, o.action, String(o.issuedAt)].join("|"));
}

export function signAppRestoreUndo(o: AppRestoreUndoOrder, signer: MsgSigner): Bytes {
  return resolveMsgSigner(signer)(appRestoreUndoCanonicalBytes(o));
}

/** Never throws. */
export function verifyAppRestoreUndo(o: AppRestoreUndoOrder, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, appRestoreUndoCanonicalBytes(o), pub);
  } catch {
    return false;
  }
}

export function parseAppRestoreUndo(v: unknown): AppRestoreUndoOrder | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.serverDomain !== "string" || typeof r.restoreId !== "string" || typeof r.serviceId !== "string" || typeof r.action !== "string" || typeof r.issuedAt !== "number") return null;
  const o: AppRestoreUndoOrder = { serverDomain: r.serverDomain, restoreId: r.restoreId, serviceId: r.serviceId, action: r.action as AppRestoreUndoAction, issuedAt: r.issuedAt };
  try {
    appRestoreUndoCanonicalBytes(o);
  } catch {
    return null;
  }
  return o;
}
