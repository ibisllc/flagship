/**
 * Carry out a signed restore plan (docs/restore-into-server.md §3.2-§3.4,
 * §6.4-§6.6), one app at a time, every step written to the run journal so a
 * restart resumes it:
 *
 *   install / copy   today's install path (restore.ts installOne), a copy
 *                    under its new id and a new origin, with nobody invited.
 *   replace          the backup's code built beside the live app, its data
 *                    restored into the app's next store generation, then
 *                    swapped in; the server's own copy is the undo point.
 *   replace-data     the same with the server's code: the backup's data,
 *                    then the server's own migrations X∖B on it, then the swap.
 *
 * Only the app being swapped stops, for the swap. A line whose app changed
 * since the owner chose is refused and the app kept as it is. Any failure
 * puts the app back as it was. Who can use an app on the server is never
 * touched by a replace.
 */
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseServiceId, type RestoreMergePlanLine } from "@flagship/protocol";
import { readStateFile, writeFileDurable } from "../../durableFile.js";
import { legacyOrigin, mintOrigin, parseLineage, type CodeHistoryEntry } from "../../appLineage.js";
import { migrationFiles } from "../../llm/serviceName.js";
import { readServiceSource } from "../../llm/serviceSource.js";
import type { AppDataCredentials } from "../../dataLayer/provisioner.js";
import type { AppMigrationFile, ServicePlatform } from "../../servicePlatform.js";
import type { ArchiveAppMeta } from "../build.js";
import { installOne, prepareArchivedCode, restoreArchivedData, type ArchiveRestoreDeps, type Held, type RestoreSummary } from "../restore.js";
import { guardsOf } from "./preview.js";

export const UNDO_KEEP_MS = 7 * 24 * 60 * 60_000;

export type MergeStep = "waiting" | "started" | "built" | "stores-ready" | "migrated" | "swapped" | "done" | "failed" | "kept" | "skipped" | "refused-changed";

export interface MergeAppRun {
  archivedServiceId: string;
  action: RestoreMergePlanLine["action"];
  targetServiceId: string;
  step: MergeStep;
  attempts: number;
  /** The store generation a replace made (a resume clears it). */
  generation?: number;
  reason?: string;
  summary?: RestoreSummary;
}

export interface MergeRun {
  v: 1;
  restoreId: string;
  archiveId: string;
  createdAt: number;
  /** The backup's date, for Activity. */
  backupCreatedAt: number;
  state: "running" | "done";
  apps: MergeAppRun[];
  lines: RestoreMergePlanLine[];
}

/** What an undo puts back besides the stores: the working tree and the env names a replace added. */
export interface UndoMeta {
  v: 1;
  restoreId: string;
  serviceId: string;
  action: "replace" | "replace-data";
  keptAt: number;
  expiresAt: number;
  /** The live working tree was moved here (`tree/`). */
  tree: boolean;
  /** Env names only the backup had (added; an undo removes them). Values are never kept here. */
  envAdded: string[];
}

export interface MergeRunDeps {
  restore: ArchiveRestoreDeps;
  platform: Pick<
    ServicePlatform,
    "byServiceId" | "prepareDataGeneration" | "dropPreparedGeneration" | "swapDataGeneration" | "revertDataGeneration" | "discardRetainedGeneration" | "migrateData"
  >;
  /** Drops what an interrupted install left under an app's own names (it was never installed). */
  clearUninstalled?: (serviceId: string, meta: ArchiveAppMeta) => Promise<void>;
  /** `<dataDir>/restore-merge`: one folder per run (journal + the unpacked backup). */
  runsDir: string;
  /** `<dataDir>/restore-undo`: the undo points' trees and notes. */
  undoDir: string;
  note: (kind: string, detail: string, ok?: boolean) => void;
  now?: () => number;
  log?: (m: string) => void;
}

export function runDir(deps: Pick<MergeRunDeps, "runsDir">, restoreId: string): string {
  return join(deps.runsDir, restoreId);
}
export function journalPath(deps: Pick<MergeRunDeps, "runsDir">, restoreId: string): string {
  return join(runDir(deps, restoreId), "run.json");
}
export function undoPath(deps: Pick<MergeRunDeps, "undoDir">, restoreId: string, serviceId: string): string {
  return join(deps.undoDir, restoreId, serviceId);
}

export async function saveRun(deps: Pick<MergeRunDeps, "runsDir">, run: MergeRun): Promise<void> {
  await mkdir(runDir(deps, run.restoreId), { recursive: true, mode: 0o700 });
  await writeFileDurable(journalPath(deps, run.restoreId), JSON.stringify(run), 0o600);
}

export async function loadRun(deps: Pick<MergeRunDeps, "runsDir">, restoreId: string): Promise<MergeRun | null> {
  const raw = await readStateFile(journalPath(deps, restoreId));
  if (raw.kind !== "ok") return null;
  try {
    const r = JSON.parse(raw.text) as MergeRun;
    return r && r.v === 1 && Array.isArray(r.apps) ? r : null;
  } catch {
    return null;
  }
}

function account(serverFqdn: string): string {
  return serverFqdn.split(".")[1] ?? "";
}

/** Stores a backed-up app's manifest asks for. */
function storesOfMeta(meta: ArchiveAppMeta): { postgres?: boolean | string[]; files?: boolean } {
  try {
    return (JSON.parse(meta.manifestJson) as { data?: { stores?: { postgres?: boolean | string[]; files?: boolean } } }).data?.stores ?? {};
  } catch {
    return {};
  }
}

/**
 * Run (or resume) every line of a plan. Lines already done, kept, skipped,
 * refused or failed are left as they are. A line a restart cut short is
 * undone to where it started and tried once more; a second cut fails it.
 */
export async function runPlan(deps: MergeRunDeps, run: MergeRun, metas: readonly ArchiveAppMeta[]): Promise<MergeRun> {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const dir = join(runDir(deps, run.restoreId), "unpacked");
  const byId = new Map(metas.map((m) => [m.serviceId, m]));
  const save = () => saveRun(deps, run);
  for (const app of run.apps) {
    if (["done", "failed", "kept", "skipped", "refused-changed"].includes(app.step)) continue;
    if (app.action === "keep" || app.action === "skip") {
      app.step = app.action === "keep" ? "kept" : "skipped";
      await save();
      continue;
    }
    const meta = byId.get(app.archivedServiceId);
    if (app.step !== "waiting") {
      // A restart cut this line short: put the app back where it started first.
      await recoverInterrupted(deps, run, app, meta).catch((e: Error) => log(`[restore-merge] ${app.targetServiceId}: couldn't clear the interrupted attempt: ${e.message}`));
      if (app.step === "done" || app.attempts >= 2) {
        if (app.step !== "done") {
          app.step = "failed";
          app.reason = "it was interrupted twice, so it was kept as it was";
          deps.note("app.restore.failed", `Couldn't restore ${meta?.name ?? app.targetServiceId}: interrupted twice. It is back as it was.`, false);
        }
        await save();
        continue;
      }
    }
    if (!meta) {
      app.step = "failed";
      app.reason = "the backup no longer holds this app";
      await save();
      continue;
    }
    app.attempts++;
    app.step = "started";
    delete app.reason;
    await save();
    const line = run.lines.find((l) => l.archivedServiceId === app.archivedServiceId)!;
    try {
      if (app.action === "install" || app.action === "copy") await installLine(deps, run, app, line, meta, dir, log);
      else await replaceLine(deps, run, app, line, meta, dir, save, now);
    } catch (e) {
      app.step = "failed";
      app.reason = (e as Error).message;
      deps.note("app.restore.failed", `Couldn't restore ${meta.name}: ${app.reason.replace(/[.\s]+$/, "")}. It is back as it was.`, false);
    }
    await save();
    log(`[restore-merge] ${app.targetServiceId}: ${app.step}${app.reason ? ` (${app.reason})` : ""}`);
  }
  run.state = "done";
  await save();
  const done = run.apps.filter((a) => a.step === "done").length;
  const failed = run.apps.filter((a) => a.step === "failed" || a.step === "refused-changed").length;
  deps.note("server.restore-merge.finished", failed === 0 ? `Restored ${done} app${done === 1 ? "" : "s"} from the backup.` : `Restored ${done} app${done === 1 ? "" : "s"} from the backup; ${failed} kept as they were.`, failed === 0);
  return run;
}

async function installLine(deps: MergeRunDeps, run: MergeRun, app: MergeAppRun, line: RestoreMergePlanLine, meta: ArchiveAppMeta, dir: string, log: (m: string) => void): Promise<void> {
  const copy = app.action === "copy";
  const carried = parseLineage(meta.lineage) ?? { origin: legacyOrigin(meta.serviceId), codeHistory: [] };
  const r = await installOne(deps.restore, dir, meta, log, {
    targetServiceId: app.targetServiceId,
    // A copy is a new app: a new origin, its history kept, nobody invited (per-app identity).
    ...(copy ? { lineage: { origin: mintOrigin(), forkedFrom: carried.origin, codeHistory: carried.codeHistory }, accessDraft: false } : {}),
    // An app the account runs elsewhere joins its one list there: no draft from the backup.
    ...(!copy && line.action === "install" && runsElsewhere(run, app) ? { accessDraft: false } : {}),
  });
  if (r.state !== "done") throw new Error(r.reason ?? "it couldn't be installed");
  app.step = "done";
  if (r.summary) app.summary = r.summary;
  deps.note(copy ? "app.restore.copied" : "app.restore.installed", copy ? `${meta.name} was added as a separate app from the backup.` : `${meta.name} was restored from the backup.`);
}

/** Set by the service from the preview: install lines of apps the account runs on other servers. */
const elsewhere = new WeakMap<MergeRun, Set<string>>();
export function markRunsElsewhere(run: MergeRun, ids: Iterable<string>): void {
  elsewhere.set(run, new Set(ids));
}
function runsElsewhere(run: MergeRun, app: MergeAppRun): boolean {
  return elsewhere.get(run)?.has(app.archivedServiceId) ?? false;
}

async function replaceLine(
  deps: MergeRunDeps,
  run: MergeRun,
  app: MergeAppRun,
  line: RestoreMergePlanLine,
  meta: ArchiveAppMeta,
  dir: string,
  save: () => Promise<void>,
  now: () => number,
): Promise<void> {
  const sid = app.targetServiceId;
  const live = deps.platform.byServiceId(sid);
  if (!live) throw new Error("it is no longer on this server");
  const summary: RestoreSummary = { code: "", awaitingApproval: [], reconnect: [], notes: [] };
  const path = (part: string): string | undefined => {
    const p = meta.parts.find((x) => x.name === part);
    return p ? join(dir, p.file) : undefined;
  };
  const changed = (a: NonNullable<ReturnType<typeof deps.platform.byServiceId>>): string | null => {
    const g = guardsOf({ codeHistory: a.codeHistory ?? [], manifestJson: a.manifestSource ?? JSON.stringify(a.manifest), appliedMigrations: a.appliedMigrations ?? [], dataGeneration: a.dataGeneration ?? 0 });
    return g.guardCode === line.guardCode && g.guardSchema === line.guardSchema && g.guardGen === line.guardGen ? null : `${meta.name} changed since you chose, so it was kept as it is`;
  };
  // Refuse before building anything when the app already changed.
  const early = changed(live);
  if (early) {
    app.step = "refused-changed";
    app.reason = early;
    deps.note("app.restore.refused-changed", `${early}.`, false);
    return;
  }
  const held: Held = {};
  const scratchTree = join(runDir(deps, run.restoreId), "trees", sid);
  let manifestJson: string | undefined;
  let codeHistory: CodeHistoryEntry[] | undefined;
  let prepared: { generation: number; data: AppDataCredentials | null } | null = null;
  try {
    if (app.action === "replace") {
      await rm(scratchTree, { recursive: true, force: true });
      const code = await prepareArchivedCode(deps.restore, meta, sid, path, held, summary, meta.rebuild === "source" ? scratchTree : null);
      manifestJson = code.manifestJson;
      const carried = parseLineage(meta.lineage);
      codeHistory = carried?.codeHistory.length ? carried.codeHistory : code.sourceDigest ? [{ digest: code.sourceDigest, version: String((JSON.parse(meta.manifestJson) as { version?: unknown }).version ?? ""), at: now() }] : undefined;
      app.step = "built";
      await save();
    }
    prepared = await deps.platform.prepareDataGeneration(sid, app.action === "replace" ? { stores: storesOfMeta(meta) } : {});
    app.generation = prepared.generation;
    await save();
    await restoreArchivedData(deps.restore, meta, prepared.data, path, summary);
    app.step = "stores-ready";
    await save();
    let applied = [...meta.appliedMigrations];
    if (app.action === "replace-data") {
      const files = await boxMigrations(deps, sid);
      const ran = await deps.platform.migrateData(sid, prepared.data, applied, files);
      if (!ran.ok) throw new Error(ran.reason);
      applied = ran.applied;
      app.step = "migrated";
      await save();
    }
    const swapped = await deps.platform.swapDataGeneration(
      sid,
      { generation: prepared.generation, data: prepared.data, appliedMigrations: applied, ...(manifestJson !== undefined ? { manifestJson } : {}), ...(codeHistory ? { codeHistory } : {}) },
      { ref: run.restoreId, expiresAt: now() + UNDO_KEEP_MS },
      changed,
    );
    if (!swapped.ok) {
      if (swapped.changed) {
        await dropPrepared(deps, sid, prepared, held);
        prepared = null;
        app.step = "refused-changed";
        app.reason = swapped.reason;
        deps.note("app.restore.refused-changed", `${swapped.reason}.`, false);
        return;
      }
      throw new Error(swapped.reason);
    }
    app.step = "swapped";
    await save();
    const undo = await afterSwap(deps, run, app, meta, scratchTree, now);
    app.step = "done";
    app.summary = summary;
    deps.note(app.action === "replace" ? "app.restore.replaced" : "app.restore.replaced-data", `${meta.name} was restored from the backup. Its earlier copy is kept until ${new Date(undo.expiresAt).toISOString().slice(0, 10)}.`);
  } catch (e) {
    if (prepared) await dropPrepared(deps, sid, prepared, held);
    else if (held.image) await deps.restore.ops.removeImage(held.image).catch(() => {});
    await rm(scratchTree, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

async function dropPrepared(deps: MergeRunDeps, sid: string, prepared: { data: AppDataCredentials | null }, held: Held): Promise<void> {
  await deps.platform.dropPreparedGeneration(sid, prepared.data).catch((e: Error) => deps.log?.(`[restore-merge] ${sid}: couldn't drop the prepared stores: ${e.message}`));
  if (held.image) await deps.restore.ops.removeImage(held.image).catch(() => {});
}

/** The server's own migrations for an app: its working tree's `migrations/*.sql`. */
async function boxMigrations(deps: MergeRunDeps, sid: string): Promise<AppMigrationFile[]> {
  const src = deps.restore.sourceDir;
  if (!src) return [];
  const tree = await readServiceSource(src, sid);
  return tree.ok ? migrationFiles(tree.files) : [];
}

/**
 * After a replace went live: the server's working tree moves to the undo
 * point and the backup's takes its place; env names only the backup had are
 * added (same account only; this server's values always win).
 */
async function afterSwap(deps: MergeRunDeps, run: MergeRun, app: MergeAppRun, meta: ArchiveAppMeta, scratchTree: string, now: () => number): Promise<UndoMeta> {
  const sid = app.targetServiceId;
  const at = undoPath(deps, run.restoreId, sid);
  await mkdir(at, { recursive: true, mode: 0o700 });
  const undo: UndoMeta = { v: 1, restoreId: run.restoreId, serviceId: sid, action: app.action as "replace" | "replace-data", keptAt: now(), expiresAt: now() + UNDO_KEEP_MS, tree: false, envAdded: [] };
  const src = deps.restore.sourceDir;
  if (app.action === "replace" && src) {
    const liveTree = join(src, sid);
    const backupTree = meta.rebuild === "source" ? scratchTree : null;
    if (backupTree || meta.parts.some((p) => p.name === "source")) {
      await rename(liveTree, join(at, "tree")).then(() => (undo.tree = true)).catch(() => {});
      if (backupTree) await rename(backupTree, liveTree).catch(() => {});
    }
  }
  const sameAccount = parseServiceId(meta.serviceId)?.creator === account(deps.restore.serverFqdn);
  if (app.action === "replace" && sameAccount && deps.restore.envStore && Object.keys(meta.env).length > 0) {
    const have = (await deps.restore.envStore.get(sid).catch(() => null)) ?? {};
    const add = Object.entries(meta.env).filter(([k, v]) => typeof v === "string" && !k.startsWith("FLAGSHIP_") && !(k in have));
    if (add.length > 0) {
      await deps.restore.envStore.put(sid, { ...have, ...Object.fromEntries(add) });
      undo.envAdded = add.map(([k]) => k).sort();
    }
  }
  await writeFileDurable(join(at, "undo.json"), JSON.stringify(undo), 0o600);
  return undo;
}

async function recoverInterrupted(deps: MergeRunDeps, run: MergeRun, app: MergeAppRun, meta: ArchiveAppMeta | undefined): Promise<void> {
  const sid = app.targetServiceId;
  if (app.action === "install" || app.action === "copy") {
    if (deps.platform.byServiceId(sid)) {
      app.step = "done";
      return;
    }
    if (meta) await deps.clearUninstalled?.(sid, meta);
    return;
  }
  const live = deps.platform.byServiceId(sid);
  if (live?.retainedData?.some((r) => r.ref === run.restoreId)) {
    // The swap went through but the line never finished: take the server's copy back first.
    const back = await deps.platform.revertDataGeneration(sid, run.restoreId);
    if (!back.ok) throw new Error(back.reason);
    await finishUndoFiles(deps, run.restoreId, sid).catch(() => {});
  }
  await rm(join(runDir(deps, run.restoreId), "trees", sid), { recursive: true, force: true }).catch(() => {});
}

/** After an undo: the server's working tree back, the env names the restore added removed, the note gone. */
export async function finishUndoFiles(deps: Pick<MergeRunDeps, "undoDir" | "restore">, restoreId: string, serviceId: string): Promise<void> {
  const at = undoPath(deps, restoreId, serviceId);
  const raw = await readFile(join(at, "undo.json"), "utf8").catch(() => null);
  const undo = raw ? (JSON.parse(raw) as UndoMeta) : null;
  const src = deps.restore.sourceDir;
  if (undo?.tree && src) {
    await rm(join(src, serviceId), { recursive: true, force: true });
    await rename(join(at, "tree"), join(src, serviceId));
  }
  if (undo && undo.envAdded.length > 0 && deps.restore.envStore) {
    const have = (await deps.restore.envStore.get(serviceId).catch(() => null)) ?? {};
    for (const k of undo.envAdded) delete have[k];
    await deps.restore.envStore.put(serviceId, have);
  }
  await rm(at, { recursive: true, force: true });
}

/** After a discard or expiry: the kept tree and note go. */
export async function dropUndoFiles(deps: Pick<MergeRunDeps, "undoDir">, restoreId: string, serviceId: string): Promise<void> {
  await rm(undoPath(deps, restoreId, serviceId), { recursive: true, force: true });
}

