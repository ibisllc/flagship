/**
 * Restore a backup into a running server (docs/restore-into-server.md) on fake
 * docker: back a server up, change it, then stage, preview, plan and run a
 * restore into the same server; undo and discard; the refusals that keep a
 * restore to exactly what the owner signed.
 */
import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveIRK,
  deriveServerArchiveKey,
  ed,
  wrapAccountSlot,
  wrapPasscodeSlot,
  restoreMergePlanSha256,
  signAppRestoreUndo,
  signInstallService,
  signServerRestoreMerge,
  signServerRestoreStage,
  signUninstallService,
  verifyInstallService,
  verifyUninstallService,
  type RestoreMergePlanLine,
} from "@flagship/protocol";
import { createHash } from "node:crypto";
import type { AppCopyOps } from "../../src/appCopy/ops.js";
import { DataProvisioner, InMemoryFilesAdmin, InMemoryPostgresAdmin } from "../../src/dataLayer/index.js";
import { ServicePlatform } from "../../src/servicePlatform.js";
import { AppRunner, type CommandRunner } from "../../src/serviceRunner.js";
import { InMemoryAppEnvStore } from "../../src/serviceEnvStore.js";
import { buildServerArchiveService, ARCHIVE_PATH } from "../../src/serverArchive/service.js";
import type { HttpRequest } from "../../src/runtime.js";
import { swkOps, testCustodian } from "../helpers/keyCustody.js";
import { writeSourceTree } from "../../src/llm/serviceSource.js";
import { miniTar, miniTarText } from "../helpers/miniTar.js";
import { buildRestoreMergeService, MERGE_PATH } from "../../src/serverArchive/merge/service.js";
import { guardsOf, lineFor, type PreviewApp } from "../../src/serverArchive/merge/preview.js";
import { loadRun, runPlan, saveRun, type MergeRun } from "../../src/serverArchive/merge/run.js";

const owner = deriveIRK({ seed: new Uint8Array(32).fill(42) });
const stranger = deriveIRK({ seed: new Uint8Array(32).fill(43) });
const box = testCustodian({ identityPriv: new Uint8Array(32).fill(3), swk: new Uint8Array(32).fill(4), cgk: new Uint8Array(32).fill(5) });
const HOST = "home.harry.flagship.services";
const ARCHIVE_ID = "00112233445566778899aabbccddeeff";
const CONTENT_KEY = Buffer.alloc(32, 0x5a);
const slots = () => [
  wrapPasscodeSlot(ARCHIVE_ID, CONTENT_KEY, "k7qm-2xhd-9twp-4frn-6cyb", new Uint8Array(16).fill(1), new Uint8Array(12).fill(2), { m: 64, t: 1, p: 1 }),
  wrapAccountSlot(ARCHIVE_ID, CONTENT_KEY, deriveServerArchiveKey({ seed: new Uint8Array(32).fill(9) }, ARCHIVE_ID), new Uint8Array(12).fill(3)),
];

const manifest = (name: string, version: string, image = `flagship-vibe-harry--${name}:1`) => ({
  schema_version: 1,
  name,
  version,
  runtime: { image, port: 8080 },
  data: { stores: { postgres: true, files: true } },
  network: { subdomain: name },
  access: { enabled: true, default_role: "viewer" },
  migration: { portable: true, verification: "standard" },
});

const req = (method: string, path: string, body?: unknown | Buffer): HttpRequest => ({
  method,
  path,
  headers: {},
  body: body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)),
});

function fakeOps() {
  const images = new Set<string>();
  const restoredDbs: Array<{ into: string; rows: string }> = [];
  const restoredFiles: Array<{ into: string; text: string }> = [];
  const ops: AppCopyOps = {
    saveImage: async () => {
      throw new Error("never");
    },
    loadImage: async () => {},
    imageExists: async (i) => images.has(i),
    removeImage: async (i) => void images.delete(i),
    dumpDatabase: async (s, out) => writeFile(out, `rows-of-${s.database}`),
    listDump: async () => "; Archive created\n",
    restoreDatabase: async (s, p) => void restoredDbs.push({ into: s.database, rows: await readFile(p, "utf8") }),
    archiveFiles: async (v, _c, out) => writeFile(out, miniTar(`files-of-${v}`)),
    restoreFiles: async (v, p) => void restoredFiles.push({ into: v, text: miniTarText(await readFile(p)) }),
  };
  return { ops, images, restoredDbs, restoredFiles };
}

async function world() {
  const dir = mkdtempSync(join(tmpdir(), "restore-merge-"));
  const files = new InMemoryFilesAdmin();
  const pg = new InMemoryPostgresAdmin();
  const provisioner = new DataProvisioner({ postgres: pg, files, nameKey: "s".repeat(40) });
  let failStart = (_image: string) => false;
  const cmd: CommandRunner = { run: async () => {}, capture: async () => ({ stdout: "", stderr: "" }) };
  const platform = new ServicePlatform({
    host: { username: "harry", irkPub: owner.publicKey },
    hostIdentityPub: box.boxPublicKey(),
    swk: swkOps(new Uint8Array(32).fill(1)),
    appRunner: new AppRunner(cmd),
    dataProvisioner: provisioner,
    startCheck: async (spec) => (failStart(spec.image) ? { ok: false, reason: "it never answered" } : { ok: true }),
  });
  const f = fakeOps();
  const env = new InMemoryAppEnvStore();
  const clones = join(dir, "clones");
  const events: Array<{ kind: string; detail: string }> = [];
  const builds: string[] = [];
  const restore = {
    serverFqdn: HOST,
    platform,
    dataProvisioner: provisioner,
    ops: f.ops,
    signInstall: (r: Parameters<typeof box.signInstallService>[0]) => box.signInstallService(r),
    envStore: env,
    access: null,
    egress: null,
    sourceDir: clones,
    buildImage: async (a: { contextDir: string; files: Record<string, string>; binaries: Record<string, Buffer>; image: string }) => {
      await writeSourceTree(a.contextDir, a.files, { binaries: a.binaries });
      builds.push(a.image);
      f.images.add(a.image);
      return { ok: true as const };
    },
    pullImage: async (image: string) => void f.images.add(image),
  };
  const install = async (name: string, version: string, codeDigest: string, image?: string) => {
    const m = manifest(name, version, image);
    f.images.add(m.runtime.image);
    const request = { serverId: HOST, creator: "harry", slug: name, manifestJson: JSON.stringify(m), addOwnerToMembership: true, issuedAt: Date.now() };
    await writeSourceTree(join(clones, `harry--${name}`), { "flagship.app.json": JSON.stringify(m), "server.js": `v${version}` });
    const r = await platform.install({ request, signature: signInstallService(request, owner), verify: verifyInstallService, codeDigest });
    if (!r.ok) throw new Error(r.reason);
  };
  const redeploy = async (name: string, version: string, codeDigest: string) => {
    const m = manifest(name, version, `flagship-vibe-harry--${name}:${version}`);
    f.images.add(m.runtime.image);
    const request = { serverId: HOST, creator: "harry", slug: name, manifestJson: JSON.stringify(m), addOwnerToMembership: false, issuedAt: Date.now() };
    await writeSourceTree(join(clones, `harry--${name}`), { "flagship.app.json": JSON.stringify(m), "server.js": `v${version}` });
    const r = await platform.redeploy({ request, signature: signInstallService(request, owner), verify: verifyInstallService, codeDigest });
    if (!r.ok) throw new Error(r.reason);
  };
  const archive = buildServerArchiveService({
    dir: join(dir, "archives"),
    build: { serverFqdn: HOST, apps: () => platform.list(), containerName: (id) => `flagship-${id}`, ops: f.ops, envStore: env, access: null, accessList: null, sourceDir: clones },
    restore,
    note: () => {},
    freeBytes: async () => 1e12,
  });
  const merge = buildRestoreMergeService({
    serverFqdn: HOST,
    restore,
    platform,
    runsDir: join(dir, "restore-merge"),
    undoDir: join(dir, "restore-undo"),
    clearUninstalled: async () => {},
    authorize: (canonical, sig) => ed.verify(sig, canonical, owner.publicKey),
    busy: () => null,
    apps: async () =>
      platform.list().map((a) => ({
        serviceId: a.serviceId,
        name: a.manifest.name,
        version: a.manifest.version,
        manifestJson: a.manifestSource ?? JSON.stringify(a.manifest),
        origin: a.origin!,
        codeHistory: a.codeHistory ?? [],
        appliedMigrations: a.appliedMigrations ?? [],
        dataGeneration: a.dataGeneration ?? 0,
        installedAt: a.installedAt,
        postgresStores: Object.keys(a.data?.postgres ?? {}),
        files: !!a.data?.files,
        bytes: 10,
        busy: null,
      })),
    accountApps: async () => new Map(),
    addressMoves: () => false,
    savedDataFile: async () => null,
    freeBytes: async () => 1e12,
    note: (kind, detail) => void events.push({ kind, detail }),
  });
  return { dir, platform, provisioner, files, pg, f, env, clones, archive, merge, install, redeploy, events, builds, setFailStart: (fn: (image: string) => boolean) => (failStart = fn) };
}
type World = Awaited<ReturnType<typeof world>>;

const D = (c: string) => `tree:${c.repeat(64)}`;
const asJson = (r: { body: string | Buffer | undefined }) => JSON.parse(String(r.body)) as Record<string, any>;
const callMerge = async (w: World, method: string, path: string, body?: unknown) => {
  const r = (await w.merge.handle(req(method, path, body)))!;
  return { status: r.status, json: asJson(r) };
};

async function backUp(w: World): Promise<Buffer> {
  const a = await w.archive.handle(ARCHIVE_PATH + "/start", "POST", req("POST", `${ARCHIVE_PATH}/start`, { archiveId: ARCHIVE_ID, key: CONTENT_KEY.toString("hex"), slots: slots() }), { companion: false });
  expect(a!.status).toBe(202);
  await w.archive.settle();
  const status = asJson((await w.archive.handle(ARCHIVE_PATH, "GET", req("GET", ARCHIVE_PATH), { companion: false }))!).archive;
  expect(status.state, JSON.stringify(status)).toBe("ready");
  const parts: Buffer[] = [];
  for (let o = 0; o < status.bytes; ) {
    const c = (await w.archive.handle(`${ARCHIVE_PATH}/chunk`, "GET", req("GET", `${ARCHIVE_PATH}/chunk?offset=${o}`), { companion: false }))!.body as Buffer;
    parts.push(c);
    o += c.length;
  }
  return Buffer.concat(parts);
}

async function stageAndPreview(w: World, file: Buffer, signer = owner): Promise<{ restoreId: string; apps: PreviewApp[] }> {
  const order = { serverDomain: HOST, archiveId: ARCHIVE_ID, bytes: file.length, sha256: createHash("sha256").update(file).digest("hex"), source: "upload" as const, issuedAt: Date.now() };
  const s = await callMerge(w, "POST", `${MERGE_PATH}/stage`, { order, signatureHex: Buffer.from(signServerRestoreStage(order, signer)).toString("hex") });
  expect(s.status, JSON.stringify(s.json)).toBe(202);
  for (let o = 0; o < file.length; o += 700) {
    const c = (await w.merge.handle(req("POST", `${MERGE_PATH}/chunk?offset=${o}`, file.subarray(o, o + 700))))!;
    expect(c.status).toBe(200);
  }
  expect((await callMerge(w, "POST", `${MERGE_PATH}/commit`, { key: CONTENT_KEY.toString("hex") })).status).toBe(202);
  await w.merge.settle();
  const v = (await callMerge(w, "GET", MERGE_PATH)).json;
  expect(v.stage.state, JSON.stringify(v.stage)).toBe("previewed");
  return { restoreId: v.preview.restoreId, apps: v.preview.apps };
}

function planOrder(restoreId: string, file: Buffer, lines: RestoreMergePlanLine[], over: Record<string, unknown> = {}, signer = owner) {
  const order = {
    serverDomain: HOST,
    restoreId,
    archiveId: ARCHIVE_ID,
    sha256: createHash("sha256").update(file).digest("hex"),
    planSha256: restoreMergePlanSha256(lines),
    issuedAt: Date.now(),
    expiresAt: Date.now() + 3600_000,
    ...over,
  };
  return { order, signatureHex: Buffer.from(signServerRestoreMerge(order, signer)).toString("hex"), lines };
}

const app = (apps: PreviewApp[], id: string) => apps.find((a) => a.archivedServiceId === id)!;

async function setUp() {
  const w = await world();
  await w.install("notes", "1.2.0", D("a"));
  await w.install("todo", "1.0.0", D("e"));
  const file = await backUp(w);
  // Since the backup: notes moved on, todo was removed, a different app took the name "blog"…
  await w.redeploy("notes", "1.4.0", D("b"));
  const un = { serverId: HOST, creator: "harry", slug: "todo", issuedAt: Date.now() };
  expect((await w.platform.uninstall({ request: un, signature: signUninstallService(un, owner), verify: verifyUninstallService })).ok).toBe(true);
  return { w, file };
}

describe("restore into a running server", () => {
  it("previews each app against the server: same app and older, or new here, with safe defaults", async () => {
    const { w, file } = await setUp();
    const { apps } = await stageAndPreview(w, file);
    const notes = app(apps, "harry--notes");
    expect(notes).toMatchObject({ verdict: "same", code: "backup-older", schema: "same", recommended: "keep" });
    expect(notes.allowed.sort()).toEqual(["copy", "keep", "replace", "replace-data"]);
    expect(notes.disallowed).toMatchObject({ install: "already-on-server", skip: "already-on-server" });
    expect(notes.copyServiceId).toBe("harry--notes-restored");
    expect(notes.guards).toEqual(guardsOf({ ...w.platform.byServiceId("harry--notes")!, codeHistory: w.platform.byServiceId("harry--notes")!.codeHistory!, manifestJson: JSON.stringify(w.platform.byServiceId("harry--notes")!.manifest), appliedMigrations: [], dataGeneration: 0 }));
    expect(app(apps, "harry--todo")).toMatchObject({ verdict: "new", recommended: "install", box: null });
  });

  it("replaces one app beside the live one, installs another, keeps the old copy, and undoes", async () => {
    const { w, file } = await setUp();
    const before = w.platform.byServiceId("harry--notes")!;
    await w.env.put("harry--notes", { ROTATED: "new-value" });
    const { restoreId, apps } = await stageAndPreview(w, file);
    const lines = [lineFor(app(apps, "harry--notes"), "replace"), lineFor(app(apps, "harry--todo"), "install")];
    const p = await callMerge(w, "POST", `${MERGE_PATH}/plan`, planOrder(restoreId, file, lines));
    expect(p.status, JSON.stringify(p.json)).toBe(202);
    await w.merge.settle();

    const run = (await callMerge(w, "GET", MERGE_PATH)).json.run;
    expect(run.state).toBe("done");
    expect(run.apps.map((a: { targetServiceId: string; step: string }) => [a.targetServiceId, a.step])).toEqual([
      ["harry--notes", "done"],
      ["harry--todo", "done"],
    ]);
    const notes = w.platform.byServiceId("harry--notes")!;
    expect(notes.dataGeneration).toBe(1);
    expect(notes.manifest.version).toBe("1.2.0");
    expect(notes.origin).toBe(before.origin);
    expect(notes.data!.files!.volume).toBe("flagship-files-harry--notes--g1");
    expect(notes.retainedData![0]).toMatchObject({ ref: restoreId, generation: 0, data: before.data });
    // The backup's rows went into the new generation, never into the live stores.
    expect(w.f.restoredFiles.map((r) => r.into)).toContain("flagship-files-harry--notes--g1");
    expect(w.f.restoredFiles.map((r) => r.into)).not.toContain("flagship-files-harry--notes");
    // This server's env values win; the old working tree is the undo point's.
    expect((await w.env.get("harry--notes"))?.ROTATED).toBe("new-value");
    expect(await readFile(join(w.clones, "harry--notes", "server.js"), "utf8")).toBe("v1.2.0");
    expect(w.platform.byServiceId("harry--todo")).toBeDefined();
    expect((await callMerge(w, "GET", MERGE_PATH)).json.undo).toEqual([expect.objectContaining({ serviceId: "harry--notes", restoreId })]);
    expect(w.events.map((e) => e.kind)).toEqual(expect.arrayContaining(["server.restore-merge.started", "app.restore.replaced", "app.restore.installed", "server.restore-merge.finished"]));

    // Undo: signed, and the server's copy is back exactly as it was.
    const u = { serverDomain: HOST, restoreId, serviceId: "harry--notes", action: "undo" as const, issuedAt: Date.now() };
    const bad = await callMerge(w, "POST", `${MERGE_PATH}/undo`, { order: u, signatureHex: Buffer.from(signAppRestoreUndo(u, stranger)).toString("hex") });
    expect(bad).toMatchObject({ status: 403, json: { code: "not-admin" } });
    const ok = await callMerge(w, "POST", `${MERGE_PATH}/undo`, { order: u, signatureHex: Buffer.from(signAppRestoreUndo(u, owner)).toString("hex") });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const back = w.platform.byServiceId("harry--notes")!;
    expect(back.data).toEqual(before.data);
    expect(back.manifest.version).toBe("1.4.0");
    expect(back.dataGeneration).toBeUndefined();
    expect(await readFile(join(w.clones, "harry--notes", "server.js"), "utf8")).toBe("v1.4.0");
    expect(w.files.volumes.has("flagship-files-harry--notes--g1")).toBe(false);
  });

  it("replace-data keeps the server's code and runs its newer migrations on the backup's data", async () => {
    const { w, file } = await setUp();
    const { restoreId, apps } = await stageAndPreview(w, file);
    const p = await callMerge(w, "POST", `${MERGE_PATH}/plan`, planOrder(restoreId, file, [lineFor(app(apps, "harry--notes"), "replace-data"), lineFor(app(apps, "harry--todo"), "skip")]));
    expect(p.status, JSON.stringify(p.json)).toBe(202);
    await w.merge.settle();
    const notes = w.platform.byServiceId("harry--notes")!;
    expect(notes.manifest.version).toBe("1.4.0");
    expect(notes.dataGeneration).toBe(1);
    expect(w.platform.byServiceId("harry--todo")).toBeUndefined();
  });

  it("a copy is a new app with a new origin and nobody invited", async () => {
    const { w, file } = await setUp();
    const { restoreId, apps } = await stageAndPreview(w, file);
    const notes = app(apps, "harry--notes");
    const p = await callMerge(w, "POST", `${MERGE_PATH}/plan`, planOrder(restoreId, file, [lineFor(notes, "copy"), lineFor(app(apps, "harry--todo"), "skip")]));
    expect(p.status, JSON.stringify(p.json)).toBe(202);
    await w.merge.settle();
    const copy = w.platform.byServiceId("harry--notes-restored")!;
    expect(copy).toBeDefined();
    expect(copy.origin).not.toBe(w.platform.byServiceId("harry--notes")!.origin);
    expect(copy.forkedFrom).toBe(notes.backup.origin);
  });

  it("refuses a plan the owner didn't sign, for another server, stale, or changed since it was signed", async () => {
    const { w, file } = await setUp();
    const { restoreId, apps } = await stageAndPreview(w, file);
    const lines = [lineFor(app(apps, "harry--notes"), "replace"), lineFor(app(apps, "harry--todo"), "install")];
    expect((await callMerge(w, "POST", `${MERGE_PATH}/plan`, planOrder(restoreId, file, lines, {}, stranger))).json.code).toBe("not-admin");
    expect((await callMerge(w, "POST", `${MERGE_PATH}/plan`, planOrder(restoreId, file, lines, { serverDomain: "other.harry.flagship.services" }))).json.code).toBe("other-server");
    expect((await callMerge(w, "POST", `${MERGE_PATH}/plan`, planOrder(restoreId, file, lines, { issuedAt: Date.now() - 11 * 60_000, expiresAt: Date.now() + 1000 }))).json.code).toBe("stale");
    const signed = planOrder(restoreId, file, lines);
    expect((await callMerge(w, "POST", `${MERGE_PATH}/plan`, { ...signed, lines: [lines[0], lineFor(app(apps, "harry--todo"), "skip")] })).json.code).toBe("plan-mismatch");
    // Not one line per app, or an action the preview didn't allow.
    expect((await callMerge(w, "POST", `${MERGE_PATH}/plan`, planOrder(restoreId, file, [lines[0]!]))).json.code).toBe("plan-app-missing");
    expect((await callMerge(w, "POST", `${MERGE_PATH}/plan`, planOrder(restoreId, file, [lineFor(app(apps, "harry--notes"), "install"), lines[1]!]))).json.code).toBe("plan-action-not-allowed");
    expect((await callMerge(w, "POST", `${MERGE_PATH}/plan`, planOrder(restoreId, file, [lineFor(app(apps, "harry--notes"), "keep"), lineFor(app(apps, "harry--todo"), "skip")]))).json.code).toBe("plan-nothing-to-do");
    // The app moved on after the owner chose: the guard no longer matches, nothing runs.
    await w.redeploy("notes", "1.5.0", D("c"));
    const r = await callMerge(w, "POST", `${MERGE_PATH}/plan`, signed);
    expect(r.json.code).toBe("plan-guard-mismatch");
    expect(w.platform.byServiceId("harry--notes")!.dataGeneration).toBeUndefined();
  });

  it("refuses a stage order the owner didn't sign, and a second restore while one is staged", async () => {
    const { w, file } = await setUp();
    const order = { serverDomain: HOST, archiveId: ARCHIVE_ID, bytes: file.length, sha256: "ab".repeat(32), source: "upload" as const, issuedAt: Date.now() };
    expect((await callMerge(w, "POST", `${MERGE_PATH}/stage`, { order, signatureHex: Buffer.from(signServerRestoreStage(order, stranger)).toString("hex") })).json.code).toBe("not-admin");
    const pull = { ...order, source: "pull" as const };
    expect((await callMerge(w, "POST", `${MERGE_PATH}/stage`, { order: pull, signatureHex: Buffer.from(signServerRestoreStage(pull, owner)).toString("hex") })).json.code).toBe("source-unavailable");
    expect((await callMerge(w, "POST", `${MERGE_PATH}/stage`, { order, signatureHex: Buffer.from(signServerRestoreStage(order, owner)).toString("hex") })).status).toBe(202);
    const again = { ...order, issuedAt: Date.now() + 1 };
    expect((await callMerge(w, "POST", `${MERGE_PATH}/stage`, { order: again, signatureHex: Buffer.from(signServerRestoreStage(again, owner)).toString("hex") })).json.code).toBe("staged");
    // A file that isn't the one signed for is refused when it is checked; no app changes.
    for (let o = 0; o < file.length; o += 4096) await w.merge.handle(req("POST", `${MERGE_PATH}/chunk?offset=${o}`, file.subarray(o, o + 4096)));
    await callMerge(w, "POST", `${MERGE_PATH}/commit`, { key: CONTENT_KEY.toString("hex") });
    await w.merge.settle();
    expect((await callMerge(w, "GET", MERGE_PATH)).json.stage.state).toBe("failed");
    expect((await callMerge(w, "POST", `${MERGE_PATH}/cancel`)).status).toBe(200);
  });

  it("a restored copy that won't start puts the app back as it was and keeps nothing", async () => {
    const { w, file } = await setUp();
    const before = w.platform.byServiceId("harry--notes")!;
    const { restoreId, apps } = await stageAndPreview(w, file);
    w.setFailStart((image) => /^flagship-vibe-harry--notes:\d{6,}$/.test(image));
    const p = await callMerge(w, "POST", `${MERGE_PATH}/plan`, planOrder(restoreId, file, [lineFor(app(apps, "harry--notes"), "replace"), lineFor(app(apps, "harry--todo"), "skip")]));
    expect(p.status).toBe(202);
    await w.merge.settle();
    const run = (await callMerge(w, "GET", MERGE_PATH)).json.run;
    expect(run.apps[0]).toMatchObject({ step: "failed" });
    const now = w.platform.byServiceId("harry--notes")!;
    expect(now.data).toEqual(before.data);
    expect(now.retainedData).toBeUndefined();
    expect(w.files.volumes.has("flagship-files-harry--notes--g1")).toBe(false);
    expect(w.events.find((e) => e.kind === "app.restore.failed")?.detail).toMatch(/back as it was/);
  });

  it("a run cut short after the swap is put back and tried once more; a second cut fails it as it was", async () => {
    const { w, file } = await setUp();
    const { restoreId, apps } = await stageAndPreview(w, file);
    const lines = [lineFor(app(apps, "harry--notes"), "replace"), lineFor(app(apps, "harry--todo"), "skip")];
    await callMerge(w, "POST", `${MERGE_PATH}/plan`, planOrder(restoreId, file, lines));
    await w.merge.settle();
    const deps = { restore: { serverFqdn: HOST, platform: w.platform, dataProvisioner: w.provisioner, ops: w.f.ops, signInstall: (r: Parameters<typeof box.signInstallService>[0]) => box.signInstallService(r), envStore: w.env, access: null, egress: null, sourceDir: w.clones, workDir: w.dir, buildImage: async () => ({ ok: true as const }), pullImage: async () => {} }, platform: w.platform, runsDir: join(w.dir, "restore-merge"), undoDir: join(w.dir, "restore-undo"), note: () => {} };
    const done = (await loadRun(deps, restoreId))!;
    // Pretend the daemon died right after the swap.
    const cut: MergeRun = { ...done, state: "running", apps: done.apps.map((a) => (a.action === "replace" ? { ...a, step: "swapped", attempts: 2 } : a)) };
    await saveRun(deps, cut);
    const after = await runPlan(deps, cut, []);
    expect(after.apps[0]).toMatchObject({ step: "failed", reason: expect.stringMatching(/interrupted twice/) });
    // Put back: generation 0, nothing kept.
    expect(w.platform.byServiceId("harry--notes")!.dataGeneration).toBeUndefined();
    expect(w.platform.byServiceId("harry--notes")!.retainedData).toBeUndefined();
  });
});
