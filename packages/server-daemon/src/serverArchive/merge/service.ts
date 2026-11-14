/**
 * Restore a backup into a running server (docs/restore-into-server.md §6):
 *
 *   POST {MERGE_PATH}/stage   {order, signatureHex, pqSignature?}  the signed stage order
 *   POST {MERGE_PATH}/chunk?offset=n                               the data file, for source "upload"
 *   POST {MERGE_PATH}/commit  {key}                                check it, open it, build the preview
 *   GET  {MERGE_PATH}                                              {stage, preview, run, undo}
 *   POST {MERGE_PATH}/plan    {order, signatureHex, lines, pqSignature?}  the signed plan: the run starts
 *   POST {MERGE_PATH}/cancel                                       drop what was staged (no app changes)
 *   POST {MERGE_PATH}/undo    {order, signatureHex, pqSignature?}  put a kept copy back, or delete it now
 *
 * Owner sessions only (the caller mounts it behind the owner gate; shares and
 * companions never reach it). Every order is checked under the box's
 * sensitive-order authority. Refusals carry a `code`; sentences go through
 * the box's i18n. One staged restore at a time, never beside a backup, a
 * whole-server restore or Migrate.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  RESTORE_MERGE_ORDER_MAX_AGE_MS,
  appRestoreUndoCanonicalBytes,
  parseAppRestoreUndo,
  parseRestoreMergePlanLine,
  parseServerRestoreMerge,
  parseServerRestoreStage,
  restoreMergePlanSha256,
  serverRestoreMergeCanonicalBytes,
  serverRestoreStageCanonicalBytes,
  type RestoreMergePlanLine,
  type ServerRestoreStageOrder,
} from "@flagship/protocol";
import { readStateFile, writeFileDurable } from "../../durableFile.js";
import { t, languageFor } from "../../i18n/index.js";
import type { HttpRequest, HttpResponse } from "../../runtime.js";
import type { ArchiveKeyCustody } from "../archiveKeys.js";
import { daemonCustody } from "../archiveKeys.js";
import { ArchiveError } from "../format.js";
import { checkArchiveContents, localServiceId, unpackArchive, type ArchiveContents } from "../restore.js";
import { buildPreview, checkPlan, type BoxAppView, type PreviewApp } from "./preview.js";
import { dropUndoFiles, finishUndoFiles, loadRun, markRunsElsewhere, runDir, runPlan, saveRun, undoPath, type MergeRun, type MergeRunDeps } from "./run.js";

export const MERGE_PATH = "/api/screens/server-restore-merge";
const CHUNK_BYTES = 4 * 1024 * 1024;
const HEADROOM_BYTES = 1024 * 1024 * 1024;

export function isRestoreMergePath(path: string): boolean {
  const p = path.split("?")[0]!;
  return p === MERGE_PATH || p.startsWith(`${MERGE_PATH}/`);
}

type Signed = { order: unknown; signatureHex: unknown; pqSignature?: unknown };

export interface RestoreMergeServiceOptions extends Omit<MergeRunDeps, "note"> {
  serverFqdn: string;
  /** The box's sensitive-order check (admin root on a pinned box, else the IRK; hybrid when strict). */
  authorize: (canonical: Uint8Array, signature: Uint8Array, pqSignature: unknown) => boolean;
  /** Null, or why a restore can't start now (a backup, a whole-server restore or Migrate running; waiting for a backup). */
  busy: () => string | null;
  /** The server's apps as the preview needs them. */
  apps: () => Promise<BoxAppView[]>;
  /** Which of these app ids the account's other servers run, with those servers (accessPeers asks each box; never .com). */
  accountApps: (serviceIds: readonly string[]) => Promise<ReadonlyMap<string, readonly string[]>>;
  /** Whether installing an app the given servers run would move its address here (this server leads the order). */
  addressMoves: (runners: readonly string[]) => boolean;
  /** A saved backup's data file on this server, or null. */
  savedDataFile: (archiveId: string) => Promise<string | null>;
  freeBytes: (dir: string) => Promise<number>;
  /** Whether `bytes` more app data may come onto this server (the backup policy's limit): null, or why not. */
  admitIncoming?: (bytes: number) => string | null;
  keys?: ArchiveKeyCustody;
  note: (kind: string, detail: string, ok?: boolean) => void;
}

interface StageState {
  v: 1;
  restoreId: string;
  order: ServerRestoreStageOrder;
  state: "receiving" | "ready" | "checking" | "previewed" | "failed" | "running";
  received: number;
  createdAt: number;
  reason?: string;
  /** The backup's own date (its manifest). */
  backupCreatedAt?: number;
  sourceServer?: string;
}

export function buildRestoreMergeService(opts: RestoreMergeServiceOptions) {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const custody = opts.keys ?? daemonCustody;
  let stage: StageState | null = null;
  let contents: ArchiveContents | null = null;
  let preview: PreviewApp[] | null = null;
  let run: MergeRun | null = null;
  let checking = false;
  let running: Promise<void> | null = null;

  const json = (status: number, body: unknown): HttpResponse => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const refuse = (req: HttpRequest, status: number, code: string, text: string, ...args: Array<string | number>): HttpResponse =>
    json(status, { error: t(languageFor(req.headers), text, ...args), code });

  const dataFile = (id: string) => join(runDir(opts, id), "data");
  const stagePath = (id: string) => join(runDir(opts, id), "stage.json");
  const saveStage = async () => {
    if (!stage) return;
    await mkdir(runDir(opts, stage.restoreId), { recursive: true, mode: 0o700 });
    await writeFileDurable(stagePath(stage.restoreId), JSON.stringify(stage), 0o600);
  };

  async function parseBody<T>(req: HttpRequest): Promise<T | null> {
    try {
      return JSON.parse(req.body.toString("utf8")) as T;
    } catch {
      return null;
    }
  }

  function signatureOf(hex: unknown): Uint8Array | null {
    return typeof hex === "string" && /^[0-9a-f]{128}$/.test(hex) ? Buffer.from(hex, "hex") : null;
  }

  function fresh(issuedAt: number): boolean {
    return Math.abs(now() - issuedAt) <= RESTORE_MERGE_ORDER_MAX_AGE_MS;
  }

  async function dropStage(): Promise<void> {
    if (!stage) return;
    await rm(runDir(opts, stage.restoreId), { recursive: true, force: true }).catch(() => {});
    stage = null;
    contents = null;
    preview = null;
  }

  async function postStage(req: HttpRequest): Promise<HttpResponse> {
    const b = await parseBody<Signed>(req);
    const order = parseServerRestoreStage(b?.order);
    const sig = signatureOf(b?.signatureHex);
    if (!order || !sig) return refuse(req, 400, "bad-order", "That restore order can't be read.");
    if (order.serverDomain.toLowerCase() !== opts.serverFqdn.toLowerCase()) return refuse(req, 403, "other-server", "That restore order is for another server.");
    if (!fresh(order.issuedAt)) return refuse(req, 409, "stale", "That restore order is too old. Try again.");
    if (!opts.authorize(serverRestoreStageCanonicalBytes(order), sig, b?.pqSignature)) return refuse(req, 403, "not-admin", "Only an admin device of this account can restore a backup.");
    if (order.source === "pull" || order.source === "peers") return refuse(req, 409, "source-unavailable", "This server can't restore from that place yet. Send the backup file instead.");
    const busy = opts.busy();
    if (busy) return json(409, { error: busy, code: "busy" });
    if (run?.state === "running") return refuse(req, 409, "running", "A restore is already running on this server.");
    if (stage && stage.state !== "failed" && stage.state !== "previewed") return refuse(req, 409, "staged", "Another restore is being checked on this server. Cancel it first.");
    await dropStage();
    let received = 0;
    if (order.source === "saved") {
      const file = await opts.savedDataFile(order.archiveId);
      if (!file) return refuse(req, 404, "no-saved-backup", "That backup isn't saved on this server.");
      received = order.bytes;
    }
    if ((await opts.freeBytes(opts.runsDir)) < (order.source === "saved" ? order.bytes * 1.2 : order.bytes * 2.2) + HEADROOM_BYTES / 4) {
      return refuse(req, 507, "disk", "This server doesn't have enough free disk space for that backup.");
    }
    stage = { v: 1, restoreId: randomBytes(16).toString("hex"), order, state: received === order.bytes ? "ready" : "receiving", received, createdAt: now() };
    await saveStage();
    opts.note("server.restore-merge.staged", "A backup is being checked before restoring its apps here.");
    return json(202, { restoreId: stage.restoreId, received });
  }

  async function postChunk(req: HttpRequest): Promise<HttpResponse> {
    if (!stage || stage.state !== "receiving") return refuse(req, 409, "not-receiving", "This server isn't waiting for backup data.");
    const q = new URLSearchParams(req.path.includes("?") ? req.path.slice(req.path.indexOf("?") + 1) : "");
    const offset = Number(q.get("offset") ?? "");
    if (!Number.isSafeInteger(offset) || offset !== stage.received) return json(409, { error: "chunk out of order", code: "offset", received: stage.received });
    if (req.body.length === 0 || req.body.length > CHUNK_BYTES || offset + req.body.length > stage.order.bytes) return refuse(req, 400, "chunk-size", "That part of the backup has the wrong size.");
    const fh = await open(dataFile(stage.restoreId), offset === 0 ? "w" : "r+", 0o600);
    try {
      await fh.write(req.body, 0, req.body.length, offset);
      await fh.sync();
    } finally {
      await fh.close();
    }
    stage.received += req.body.length;
    if (stage.received === stage.order.bytes) stage.state = "ready";
    await saveStage();
    return json(200, { received: stage.received, ready: stage.state === "ready" });
  }

  async function sha256Of(path: string): Promise<string> {
    const h = createHash("sha256");
    await pipeline(createReadStream(path), async function* (src: AsyncIterable<Buffer>) {
      for await (const d of src) h.update(d);
    });
    return h.digest("hex");
  }

  async function sourceFile(): Promise<string | null> {
    if (!stage) return null;
    return stage.order.source === "saved" ? opts.savedDataFile(stage.order.archiveId) : dataFile(stage.restoreId);
  }

  async function postCommit(req: HttpRequest): Promise<HttpResponse> {
    if (!stage || stage.state !== "ready") return refuse(req, 409, "not-ready", "Send the whole backup file first.");
    const b = await parseBody<{ key?: unknown }>(req);
    if (typeof b?.key !== "string" || !/^[0-9a-f]{64}$/.test(b.key)) return refuse(req, 400, "bad-key", "That backup key can't be read.");
    if (checking) return refuse(req, 409, "checking", "The backup is already being checked.");
    const s = stage;
    let key;
    try {
      key = await custody.importKey(s.order.archiveId, Buffer.from(b.key, "hex"));
    } catch (e) {
      return json(503, { error: (e as Error).message, code: "keys" });
    }
    checking = true;
    s.state = "checking";
    await saveStage();
    void (async () => {
      try {
        const file = await sourceFile();
        if (!file || (await stat(file)).size !== s.order.bytes || (await sha256Of(file)) !== s.order.sha256) {
          throw new ArchiveError("the backup file isn't the one you chose (its size or SHA-256 differs)");
        }
        const inside = await checkArchiveContents(file, key, s.order.archiveId);
        const need = inside.expandedBytes + HEADROOM_BYTES;
        if ((await opts.freeBytes(opts.runsDir)) < need) throw new ArchiveError(`opening this backup needs about ${Math.ceil(need / 1e9)} GB free`);
        contents = await unpackArchive({ ...opts.restore, workDir: runDir(opts, s.restoreId) }, file, key, s.order.archiveId, join(runDir(opts, s.restoreId), "unpacked"));
        if (s.order.source === "upload") await rm(dataFile(s.restoreId), { force: true }).catch(() => {});
        s.backupCreatedAt = contents.manifest.createdAt;
        s.sourceServer = contents.manifest.sourceServer;
        preview = await makePreview(contents);
        s.state = "previewed";
      } catch (e) {
        s.state = "failed";
        s.reason = e instanceof ArchiveError ? e.message : `the backup couldn't be opened: ${(e as Error).message}`;
        await rm(join(runDir(opts, s.restoreId), "unpacked"), { recursive: true, force: true }).catch(() => {});
        opts.note("server.restore-merge.failed", `The backup couldn't be opened: ${s.reason}.`, false);
      } finally {
        await key.close();
        checking = false;
        await saveStage().catch(() => {});
      }
    })();
    return json(202, { restoreId: s.restoreId });
  }

  /** The ids a preview may ask about: each app's id here and the copy names it could take. */
  function candidateIds(c: ArchiveContents, extra: readonly string[] = []): string[] {
    const ids = new Set(extra);
    for (const m of c.metas) {
      const sid = localServiceId(opts.serverFqdn, m.serviceId);
      ids.add(sid);
      for (const n of ["-restored", "-restored-2", "-restored-3"]) ids.add(`${sid}${n}`);
    }
    return [...ids];
  }

  async function makePreview(c: ArchiveContents): Promise<PreviewApp[]> {
    const box = new Map((await opts.apps()).map((a) => [a.serviceId, a]));
    const elsewhere = await opts.accountApps(candidateIds(c)).catch(() => new Map<string, readonly string[]>());
    return buildPreview({
      serverFqdn: opts.serverFqdn,
      metas: c.metas,
      box,
      alsoOn: (id) => elsewhere.get(id) ?? [],
      taken: (id) => box.has(id) || (elsewhere.get(id)?.length ?? 0) > 0,
      addressMoves: (id) => opts.addressMoves(elsewhere.get(id) ?? []),
    });
  }

  async function takenIds(extra: readonly string[]): Promise<(id: string) => boolean> {
    const here = new Set((await opts.apps()).map((a) => a.serviceId));
    const elsewhere = await opts.accountApps(candidateIds(contents!, extra)).catch(() => new Map<string, readonly string[]>());
    return (id) => here.has(id) || (elsewhere.get(id)?.length ?? 0) > 0;
  }

  /** Disk and backup-limit room for a plan (§6.3): refuse before anything is made. */
  async function roomFor(lines: readonly RestoreMergePlanLine[]): Promise<{ code: string; needBytes: number } | null> {
    let need = HEADROOM_BYTES;
    let grows = 0;
    for (const l of lines) {
      const p = preview!.find((x) => x.archivedServiceId === l.archivedServiceId)!;
      if (l.action === "install" || l.action === "copy") {
        need += p.backup.bytes;
        grows += p.backup.bytes;
      } else if (l.action === "replace" || l.action === "replace-data") {
        need += p.backup.bytes;
        grows += p.backup.bytes - (p.box?.bytes ?? 0);
      }
    }
    if ((await opts.freeBytes(opts.runsDir)) < need) return { code: "disk", needBytes: need };
    if (grows > 0 && opts.admitIncoming?.(grows)) return { code: "over-backup-limit", needBytes: grows };
    return null;
  }

  async function postPlan(req: HttpRequest): Promise<HttpResponse> {
    const b = await parseBody<Signed & { lines?: unknown }>(req);
    const order = parseServerRestoreMerge(b?.order);
    const sig = signatureOf(b?.signatureHex);
    const lines = Array.isArray(b?.lines) ? b!.lines.map(parseRestoreMergePlanLine) : null;
    if (!order || !sig || !lines || lines.some((l) => !l)) return refuse(req, 400, "bad-order", "That restore order can't be read.");
    const plan = lines as RestoreMergePlanLine[];
    if (order.serverDomain.toLowerCase() !== opts.serverFqdn.toLowerCase()) return refuse(req, 403, "other-server", "That restore order is for another server.");
    if (!fresh(order.issuedAt) || order.expiresAt <= now()) return refuse(req, 409, "stale", "That restore order is too old. Try again.");
    if (!opts.authorize(serverRestoreMergeCanonicalBytes(order), sig, b?.pqSignature)) return refuse(req, 403, "not-admin", "Only an admin device of this account can restore a backup.");
    if (!stage || !preview || stage.state !== "previewed" || order.restoreId !== stage.restoreId) return refuse(req, 409, "no-preview", "This restore isn't ready to choose from any more. Start again.");
    if (order.archiveId !== stage.order.archiveId || order.sha256 !== stage.order.sha256) return refuse(req, 409, "other-backup", "That restore order names a different backup.");
    let planSha: string;
    try {
      planSha = restoreMergePlanSha256(plan);
    } catch {
      return refuse(req, 400, "bad-plan", "That restore plan can't be read.");
    }
    if (planSha !== order.planSha256) return refuse(req, 409, "plan-mismatch", "That restore plan isn't the one you signed.");
    const busy = opts.busy();
    if (busy) return json(409, { error: busy, code: "busy" });
    // The server may have changed since the preview: decide again on what is here now.
    preview = await makePreview(contents!);
    const refused = checkPlan(preview, plan, { serverFqdn: opts.serverFqdn, taken: await takenIds(plan.flatMap((l) => (l.targetServiceId ? [l.targetServiceId] : []))) });
    if (refused) {
      const text =
        refused.code === "plan-guard-mismatch"
          ? "An app changed since you chose. Look at the choices again."
          : refused.code === "plan-nothing-to-do"
            ? "Choose at least one app to restore."
            : "That restore plan doesn't fit this backup or this server any more. Look at the choices again.";
      return json(409, { ...refused, error: t(languageFor(req.headers), text) });
    }
    const room = await roomFor(plan);
    if (room) return json(507, { ...room, error: t(languageFor(req.headers), room.code === "disk" ? "This server doesn't have enough free disk space for that restore." : "That restore would go over this server's backup limit.") });
    stage.state = "running";
    await saveStage();
    run = {
      v: 1,
      restoreId: stage.restoreId,
      archiveId: stage.order.archiveId,
      createdAt: now(),
      backupCreatedAt: stage.backupCreatedAt ?? 0,
      state: "running",
      lines: plan,
      apps: plan.map((l) => {
        const p = preview!.find((x) => x.archivedServiceId === l.archivedServiceId)!;
        return { archivedServiceId: l.archivedServiceId, action: l.action, targetServiceId: l.action === "copy" ? l.targetServiceId! : p.targetServiceId, step: "waiting" as const, attempts: 0 };
      }),
    };
    await saveRun(opts, run);
    const elsewhereIds = preview.filter((p) => p.verdict === "runs-elsewhere").map((p) => p.archivedServiceId);
    markRunsElsewhere(run, elsewhereIds);
    await writeFileDurable(join(runDir(opts, run.restoreId), "elsewhere.json"), JSON.stringify(elsewhereIds), 0o600);
    const n = plan.filter((l) => l.action !== "keep" && l.action !== "skip").length;
    opts.note("server.restore-merge.started", `Restoring ${n} app${n === 1 ? "" : "s"} from the backup of ${new Date(run.backupCreatedAt).toISOString().slice(0, 10)}.`);
    start(run, contents!);
    return json(202, { restoreId: run.restoreId });
  }

  function start(r: MergeRun, c: ArchiveContents): void {
    running = (async () => {
      try {
        run = await runPlan({ ...opts, note: opts.note }, r, c.metas);
      } catch (e) {
        log(`[restore-merge] the run stopped: ${(e as Error).message}`);
      } finally {
        await rm(join(runDir(opts, r.restoreId), "unpacked"), { recursive: true, force: true }).catch(() => {});
        if (stage?.restoreId === r.restoreId) stage = null;
        contents = null;
        preview = null;
        running = null;
      }
    })();
  }

  async function postCancel(req: HttpRequest): Promise<HttpResponse> {
    if (!stage) return json(200, { ok: true });
    if (stage.state === "running" || checking) return refuse(req, 409, "running", "A restore is already running on this server.");
    await dropStage();
    return json(200, { ok: true });
  }

  async function postUndo(req: HttpRequest): Promise<HttpResponse> {
    const b = await parseBody<Signed>(req);
    const order = parseAppRestoreUndo(b?.order);
    const sig = signatureOf(b?.signatureHex);
    if (!order || !sig) return refuse(req, 400, "bad-order", "That restore order can't be read.");
    if (order.serverDomain.toLowerCase() !== opts.serverFqdn.toLowerCase()) return refuse(req, 403, "other-server", "That restore order is for another server.");
    if (!fresh(order.issuedAt)) return refuse(req, 409, "stale", "That restore order is too old. Try again.");
    if (!opts.authorize(appRestoreUndoCanonicalBytes(order), sig, b?.pqSignature)) return refuse(req, 403, "not-admin", "Only an admin device of this account can restore a backup.");
    if (run?.state === "running") return refuse(req, 409, "running", "A restore is already running on this server.");
    const app = opts.platform.byServiceId(order.serviceId);
    if (!app?.retainedData?.some((r) => r.ref === order.restoreId)) return refuse(req, 404, "no-undo", "There is no earlier copy of that app to put back.");
    if (order.action === "undo") {
      const r = await opts.platform.revertDataGeneration(order.serviceId, order.restoreId);
      if (!r.ok) return json(409, { error: r.reason, code: "undo-failed" });
      await finishUndoFiles(opts, order.restoreId, order.serviceId).catch((e: Error) => log(`[restore-merge] ${order.serviceId}: undo files: ${e.message}`));
      opts.note("app.restore.undone", `${app.manifest.name} is back as it was before the restore.`);
    } else {
      const r = await opts.platform.discardRetainedGeneration(order.serviceId, order.restoreId);
      if (!r.ok) return json(409, { error: r.reason, code: "discard-failed" });
      await dropUndoFiles(opts, order.restoreId, order.serviceId);
      opts.note("app.restore.discarded", `The earlier copy of ${app.manifest.name} was deleted.`);
    }
    return json(200, { ok: true });
  }

  function undoView() {
    return (opts.platform as { list?: () => Array<{ serviceId: string; manifest: { name: string }; retainedData?: Array<{ ref: string; keptAt: number; expiresAt: number; data: { files?: unknown } | null }> }> }).list?.()
      .flatMap((a) => (a.retainedData ?? []).map((r) => ({ serviceId: a.serviceId, name: a.manifest.name, restoreId: r.ref, keptAt: r.keptAt, expiresAt: r.expiresAt }))) ?? [];
  }

  function view(): unknown {
    return {
      stage: stage ? { restoreId: stage.restoreId, archiveId: stage.order.archiveId, source: stage.order.source, bytes: stage.order.bytes, received: stage.received, state: stage.state, ...(stage.reason ? { reason: stage.reason } : {}) } : null,
      preview: preview && stage ? { restoreId: stage.restoreId, backup: { createdAt: stage.backupCreatedAt ?? null, sourceServer: stage.sourceServer ?? null }, apps: preview } : null,
      run: run ? { restoreId: run.restoreId, state: run.state, apps: run.apps } : null,
      undo: undoView(),
    };
  }

  /** Kept copies whose 7 days are up: deleted, with an Activity line (never earlier on their own). */
  async function expireUndo(): Promise<number> {
    const list = (opts.platform as { expiredRetained?: (n?: number) => Array<{ serviceId: string; ref: string }> }).expiredRetained?.(now()) ?? [];
    let n = 0;
    for (const e of list) {
      const app = opts.platform.byServiceId(e.serviceId);
      const r = await opts.platform.discardRetainedGeneration(e.serviceId, e.ref);
      if (!r.ok) continue;
      await dropUndoFiles(opts, e.ref, e.serviceId).catch(() => {});
      opts.note("app.restore.undo-expired", `The earlier copy of ${app?.manifest.name ?? e.serviceId} kept by a restore was deleted after 7 days.`);
      n++;
    }
    return n;
  }

  /** At start: pick up a run a restart cut short, and the stage of one being checked. */
  async function resume(): Promise<void> {
    await mkdir(opts.runsDir, { recursive: true, mode: 0o700 });
    for (const id of await readdir(opts.runsDir).catch(() => [] as string[])) {
      if (!/^[0-9a-f]{32}$/.test(id)) continue;
      const r = await loadRun(opts, id);
      if (r?.state === "running") {
        const unpacked = join(runDir(opts, id), "unpacked");
        try {
          const c = await reopenUnpacked(unpacked, r.archiveId);
          const elsewhere = await readStateFile(join(runDir(opts, id), "elsewhere.json"));
          if (elsewhere.kind === "ok") markRunsElsewhere(r, JSON.parse(elsewhere.text) as string[]);
          run = r;
          start(r, c);
        } catch (e) {
          for (const a of r.apps) if (!["done", "failed", "kept", "skipped", "refused-changed"].includes(a.step) && a.step === "waiting") Object.assign(a, { step: "failed", reason: "the backup was gone after a restart, so it was kept as it was" });
          r.state = "done";
          await saveRun(opts, r);
          run = r;
          log(`[restore-merge] couldn't resume ${id}: ${(e as Error).message}`);
        }
        continue;
      }
      if (r) {
        run = run ?? r;
        continue;
      }
      const s = await readStateFile(stagePath(id));
      if (s.kind === "ok") {
        const st = JSON.parse(s.text) as StageState;
        if (st.state === "receiving" || st.state === "ready") {
          stage = st;
          continue;
        }
      }
      // A stage that was being checked or previewed needs the key again: start over.
      await rm(runDir(opts, id), { recursive: true, force: true }).catch(() => {});
    }
  }

  async function reopenUnpacked(dir: string, archiveId: string): Promise<ArchiveContents> {
    const { readFile } = await import("node:fs/promises");
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as ArchiveContents["manifest"];
    if (manifest.archiveId !== archiveId) throw new Error("the unpacked backup is another one");
    const metas = [];
    for (const a of manifest.apps) metas.push(JSON.parse(await readFile(join(dir, "apps", a.serviceId, "meta.json"), "utf8")) as ArchiveContents["metas"][number]);
    return { manifest, metas };
  }

  async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    const path = req.path.split("?")[0]!;
    const method = req.method.toUpperCase();
    if (!isRestoreMergePath(path)) return null;
    switch (`${method} ${path}`) {
      case `GET ${MERGE_PATH}`:
        return json(200, view());
      case `POST ${MERGE_PATH}/stage`:
        return postStage(req);
      case `POST ${MERGE_PATH}/chunk`:
        return postChunk(req);
      case `POST ${MERGE_PATH}/commit`:
        return postCommit(req);
      case `POST ${MERGE_PATH}/plan`:
        return postPlan(req);
      case `POST ${MERGE_PATH}/cancel`:
        return postCancel(req);
      case `POST ${MERGE_PATH}/undo`:
        return postUndo(req);
      default:
        return json(404, { error: "not found" });
    }
  }

  return {
    handle,
    resume,
    expireUndo,
    view,
    /** Whether a restore is checking or running (a backup or Migrate waits for it). */
    active: (): boolean => checking || run?.state === "running" || !!running,
    /** Tests: wait for the check or the run in progress. */
    settle: async (): Promise<void> => {
      for (let i = 0; i < 2000 && (checking || running); i++) await (running ?? new Promise((r) => setTimeout(r, 5)));
    },
    undoDirOf: (restoreId: string, serviceId: string) => undoPath(opts, restoreId, serviceId),
  };
}

export type RestoreMergeService = ReturnType<typeof buildRestoreMergeService>;
