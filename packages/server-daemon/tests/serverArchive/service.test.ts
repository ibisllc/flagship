/**
 * Backup/clone server end to end on fake docker: make a backup (two files) on
 * one server, download it, and restore it onto a DIFFERENT server (a different
 * name) that was created to wait for exactly that backup. Plus the refusals:
 * a server that isn't waiting, another backup, a changed data file, a wrong
 * key, an app that is already there, a companion session.
 */
import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  archiveDownloadCode,
  ed,
  deriveIRK,
  deriveServerArchiveKey,
  openBackupWithAccountKey,
  openBackupWithPasscode,
  parseBackupBundleHeader,
  parseBackupFile,
  signArchiveDownloadApproval,
  signInstallService,
  signServerRestoreOrder,
  verifyArchiveDownloadApproval,
  verifyInstallService,
  wrapAccountSlot,
  wrapPasscodeSlot,
  type ServerRestoreOrder,
} from "@flagship/protocol";
import { createHash } from "node:crypto";
import { buildRestoreWait, type RestoreWait } from "../../src/serverArchive/restoreWait.js";
import { AppCopyOps } from "../../src/appCopy/ops.js";
import { DataProvisioner, InMemoryFilesAdmin, InMemoryPostgresAdmin } from "../../src/dataLayer/index.js";
import { ServicePlatform } from "../../src/servicePlatform.js";
import { AppRunner, type CommandRunner } from "../../src/serviceRunner.js";
import { InMemoryAppEnvStore } from "../../src/serviceEnvStore.js";
import { buildServerArchiveService, parseRange, ARCHIVE_PATH, DOWNLOAD_PATH, RESTORE_PATH } from "../../src/serverArchive/service.js";
import { _handleHttpConnectionForTest, type HttpResponse } from "../../src/runtime.js";
import { Duplex } from "node:stream";
import type { HttpRequest } from "../../src/runtime.js";
import { swkOps, testCustodian } from "../helpers/keyCustody.js";
import { writeSourceTree } from "../../src/llm/serviceSource.js";

const owner = deriveIRK({ seed: new Uint8Array(32).fill(42) });
const srcBox = testCustodian({ identityPriv: new Uint8Array(32).fill(3), swk: new Uint8Array(32).fill(4), cgk: new Uint8Array(32).fill(5) });
const dstBox = testCustodian({ identityPriv: new Uint8Array(32).fill(6), swk: new Uint8Array(32).fill(8), cgk: new Uint8Array(32).fill(5) });
const SRC = "home.harry.flagship.services";
const DST = "clone.harry.flagship.services";
const SERVICE = "harry--notes";
const UMK = { seed: new Uint8Array(32).fill(9) };
const ARCHIVE_ID = "00112233445566778899aabbccddeeff";
const CONTENT_KEY = Buffer.alloc(32, 0x5a);
const PASSCODE = "k7qm-2xhd-9twp-4frn-6cyb";
const slots = () => [
  wrapPasscodeSlot(ARCHIVE_ID, CONTENT_KEY, PASSCODE, new Uint8Array(16).fill(1), new Uint8Array(12).fill(2), { m: 64, t: 1, p: 1 }),
  wrapAccountSlot(ARCHIVE_ID, CONTENT_KEY, deriveServerArchiveKey(UMK, ARCHIVE_ID), new Uint8Array(12).fill(3)),
];

/** A RestoreWait set later (once the test has the data file to sign for). */
function lateWait(ref: { current: RestoreWait | null }): RestoreWait {
  return {
    load: async () => {},
    current: () => ref.current?.current() ?? null,
    adoptFromPairingJson: async () => false,
    setRestoring: (on) => ref.current?.setRestoring(on),
    finish: async (id) => ref.current?.finish(id),
    heartbeatView: () => ref.current?.heartbeatView() ?? null,
    adoptOrder: async (o, s) => (ref.current ? ref.current.adoptOrder(o, s) : "not waiting"),
    restoredAny: () => ref.current?.restoredAny() ?? false,
  };
}

/** A restore-wait that has adopted the owner's order for `file` on `domain`. */
async function waitingFor(dir: string, domain: string, file: Buffer, over: Partial<ServerRestoreOrder> = {}): Promise<RestoreWait> {
  const wait = buildRestoreWait({ path: join(dir, `wait-${domain}.json`), donePath: join(dir, `done-${domain}.json`), serverDomain: domain, ownerIrkPub: owner.publicKey, username: "harry" });
  await wait.load();
  const order: ServerRestoreOrder = {
    serverDomain: domain,
    archiveId: ARCHIVE_ID,
    bytes: file.length,
    sha256: createHash("sha256").update(file).digest("hex"),
    issuedAt: Date.now(),
    ...over,
  };
  const signatureHex = Buffer.from(signServerRestoreOrder(order, owner)).toString("hex");
  expect(await wait.adoptFromPairingJson(JSON.stringify({ request: {}, signature: "", restore: { order, signatureHex } }))).toBe(true);
  return wait;
}

const MANIFEST = {
  schema_version: 1,
  name: "notes",
  version: "0.1.0",
  runtime: { image: "flagship-vibe-harry--notes:1", port: 8080 },
  data: { stores: { postgres: true, files: true } },
  network: { subdomain: "notes" },
  access: { enabled: true, default_role: "viewer" },
  migration: { portable: true, verification: "standard" },
};

const req = (method: string, path: string, body?: unknown | Buffer): HttpRequest => ({
  method,
  path,
  headers: {},
  body: body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)),
});

function fakeOps() {
  const images = new Set<string>();
  const restoredDbs: string[] = [];
  const restoredFiles: string[] = [];
  const ops: AppCopyOps = {
    saveImage: async () => {
      throw new Error("a backup must never carry an image");
    },
    loadImage: async (p) => void images.add((await readFile(p, "utf8")).slice("image:".length)),
    imageExists: async (i) => images.has(i),
    removeImage: async (i) => void images.delete(i),
    dumpDatabase: async (s, out) => writeFile(out, `rows-of-${s.database}`),
    restoreDatabase: async (_s, p) => void restoredDbs.push(await readFile(p, "utf8")),
    archiveFiles: async (v, _c, out) => writeFile(out, `files-of-${v}`),
    restoreFiles: async (_v, p) => void restoredFiles.push(await readFile(p, "utf8")),
  };
  return { ops, images, restoredDbs, restoredFiles };
}

function platformFor(box: typeof srcBox, nameKey: string) {
  const provisioner = new DataProvisioner({ postgres: new InMemoryPostgresAdmin(), files: new InMemoryFilesAdmin(), nameKey });
  const cmd: CommandRunner = { run: async () => {}, capture: async () => ({ stdout: "", stderr: "" }) };
  const platform = new ServicePlatform({
    host: { username: "harry", irkPub: owner.publicKey },
    hostIdentityPub: box.boxPublicKey(),
    swk: swkOps(new Uint8Array(32).fill(1)),
    appRunner: new AppRunner(cmd),
    dataProvisioner: provisioner,
    startCheck: async () => ({ ok: true }),
  });
  return { platform, provisioner };
}

async function world() {
  const dir = mkdtempSync(join(tmpdir(), "server-archive-"));
  const src = platformFor(srcBox, "s".repeat(40));
  const request = { serverId: SRC, creator: "harry", slug: "notes", manifestJson: JSON.stringify(MANIFEST), addOwnerToMembership: true, issuedAt: Date.now() };
  const installed = await src.platform.install({ request, signature: signInstallService(request, owner), verify: verifyInstallService });
  if (!installed.ok) throw new Error(installed.reason);
  const srcEnv = new InMemoryAppEnvStore();
  await srcEnv.put(SERVICE, { OPENAI_KEY: "sk-secret", MODE: "prod" });
  const sOps = fakeOps();
  const dst = platformFor(dstBox, "t".repeat(40));
  const dstEnv = new InMemoryAppEnvStore();
  const tOps = fakeOps();
  const events: string[] = [];
  // The app's working tree on the source server (what an import rebuilds from).
  const srcClones = join(dir, "src-clones");
  await writeSourceTree(join(srcClones, SERVICE), { "flagship.app.json": JSON.stringify(MANIFEST), "server.js": "listen()" }, {
    binaries: { "logo.png": Buffer.from([0, 1, 2, 3]) },
  });
  const dstClones = join(dir, "dst-clones");
  const builds: Array<{ contextDir: string; files: Record<string, string>; image: string }> = [];
  const pulls: string[] = [];
  const rebuilder = (ops: ReturnType<typeof fakeOps>) => ({
    buildImage: async (a: { contextDir: string; files: Record<string, string>; binaries: Record<string, Buffer>; image: string }) => {
      await writeSourceTree(a.contextDir, a.files, { binaries: a.binaries });
      builds.push({ contextDir: a.contextDir, files: a.files, image: a.image });
      ops.images.add(a.image);
      return { ok: true as const };
    },
    pullImage: async (image: string) => {
      pulls.push(image);
      ops.images.add(image);
    },
  });
  const sourceWait: { current: RestoreWait | null } = { current: null };
  const sourceService = buildServerArchiveService({
    dir: join(dir, "src-archives"),
    wait: lateWait(sourceWait),
    build: {
      serverFqdn: SRC,
      apps: () => [src.platform.byServiceId(SERVICE)!],
      containerName: (id) => `flagship-${id}`,
      ops: sOps.ops,
      envStore: srcEnv,
      access: null,
      accessList: null,
      sourceDir: srcClones,
    },
    restore: {
      serverFqdn: SRC,
      platform: src.platform,
      dataProvisioner: src.provisioner,
      ops: sOps.ops,
      signInstall: (r) => srcBox.signInstallService(r),
      envStore: srcEnv,
      access: null,
      egress: null,
      sourceDir: srcClones,
      ...rebuilder(sOps),
    },
    note: (k) => void events.push(k),
    freeBytes: async () => 1e12,
  });
  const targetWait: { current: RestoreWait | null } = { current: null };
  const targetService = buildServerArchiveService({
    dir: join(dir, "dst-archives"),
    uploadDir: join(dir, "dst-upload"),
    wait: lateWait(targetWait),
    serverSettings: async () => ({ bootUnlockMode: "approve", diskEncryption: "luks" }),
    build: { serverFqdn: DST, apps: () => [], containerName: () => "", ops: tOps.ops, envStore: dstEnv, access: null, accessList: null },
    restore: {
      serverFqdn: DST,
      platform: dst.platform,
      dataProvisioner: dst.provisioner,
      ops: tOps.ops,
      signInstall: (r) => dstBox.signInstallService(r),
      envStore: dstEnv,
      access: null,
      egress: null,
      sourceDir: dstClones,
      ...rebuilder(tOps),
    },
    note: (k) => void events.push(k),
    freeBytes: async () => 1e12,
  });
  return { dir, src, dst, srcEnv, dstEnv, sOps, tOps, sourceService, targetService, targetWait, sourceWait, events, builds, pulls, srcClones, dstClones };
}
type World = Awaited<ReturnType<typeof world>>;

const keyHex = () => CONTENT_KEY.toString("hex");
const startBody = () => ({ archiveId: ARCHIVE_ID, key: keyHex(), slots: slots() });

async function call(svc: World["sourceService"], method: string, path: string, body?: unknown | Buffer, companion = false) {
  const r = await svc.handle(path.split("?")[0]!, method, req(method, path, body), { companion });
  return { status: r!.status, headers: r!.headers ?? {}, body: r!.body };
}
const asJson = (r: { body: string | Buffer }) => JSON.parse(String(r.body)) as Record<string, any>;

async function backUp(w: World): Promise<Buffer> {
  const start = await call(w.sourceService, "POST", `${ARCHIVE_PATH}/start`, startBody());
  expect(start.status).toBe(202);
  await w.sourceService.settle();
  const status = asJson(await call(w.sourceService, "GET", ARCHIVE_PATH));
  expect(status.archive).toMatchObject({ archiveId: ARCHIVE_ID, state: "ready", apps: [{ serviceId: SERVICE, name: "notes" }] });
  const parts: Buffer[] = [];
  for (let offset = 0; offset < status.archive.bytes; ) {
    const c = await call(w.sourceService, "GET", `${ARCHIVE_PATH}/chunk?offset=${offset}`);
    expect(c.status).toBe(200);
    const b = c.body as Buffer;
    parts.push(b);
    offset += b.length;
  }
  return Buffer.concat(parts);
}

async function download(svc: World["sourceService"]): Promise<Buffer> {
  const a = asJson(await call(svc, "GET", ARCHIVE_PATH)).archive;
  const parts: Buffer[] = [];
  for (let o = 0; o < a.bytes; ) {
    const c = (await call(svc, "GET", `${ARCHIVE_PATH}/chunk?offset=${o}`)).body as Buffer;
    parts.push(c);
    o += c.length;
  }
  return Buffer.concat(parts);
}

async function upload(svc: World["targetService"], file: Buffer, chunk = 600) {
  const start = await call(svc, "POST", `${RESTORE_PATH}/start`, { archiveId: ARCHIVE_ID, bytes: file.length });
  expect(start.status).toBe(202);
  for (let offset = asJson(start).received as number; offset < file.length; offset += chunk) {
    const r = await call(svc, "POST", `${RESTORE_PATH}/chunk?offset=${offset}`, file.subarray(offset, offset + chunk));
    expect(r.status).toBe(200);
  }
}

describe("Backup/clone server", () => {
  it("backs a server up as two files and restores it onto a new server created to wait for it", async () => {
    const w = await world();
    const file = await backUp(w);
    expect(w.events).toEqual(["server.backup.started", "server.backup.created", "server.backup.downloaded"]);

    w.targetWait.current = await waitingFor(w.dir, DST, file);
    expect(asJson(await call(w.targetService, "GET", RESTORE_PATH)).waiting).toEqual({
      archiveId: ARCHIVE_ID,
      bytes: file.length,
      sha256: createHash("sha256").update(file).digest("hex"),
    });
    await upload(w.targetService, file);
    expect((await call(w.targetService, "POST", `${RESTORE_PATH}/commit`, { key: keyHex() })).status).toBe(202);
    await w.targetService.settle();

    const view = asJson(await call(w.targetService, "GET", RESTORE_PATH));
    expect(view.restore).toMatchObject({ state: "done", apps: [{ serviceId: SERVICE, name: "notes", state: "done" }] });
    // Restored: it stops waiting, for good.
    expect(view.waiting).toBeNull();
    expect(w.targetWait.current.heartbeatView()).toBeNull();
    const app = w.dst.platform.byServiceId(SERVICE);
    expect(app).toBeDefined();
    // Rebuilt here from its working tree, under a fresh local tag; never loaded from the backup.
    expect(w.builds).toHaveLength(1);
    expect(w.builds[0]!.contextDir).toBe(join(w.dstClones, SERVICE));
    expect(w.builds[0]!.files["server.js"]).toBe("listen()");
    expect(w.builds[0]!.image).toMatch(/^flagship-vibe-harry--notes:\d+$/);
    expect(JSON.parse(JSON.stringify(app!.manifest)).runtime.image).toBe(w.builds[0]!.image);
    expect(w.tOps.restoredDbs.length).toBe(1);
    expect(w.tOps.restoredFiles.length).toBe(1);
    expect(await w.dstEnv.get(SERVICE)).toEqual({ OPENAI_KEY: "sk-secret", MODE: "prod" });
    expect(w.events).toContain("server.restore.finished");
    // A second upload is refused: the server no longer waits.
    expect(asJson(await call(w.targetService, "POST", `${RESTORE_PATH}/start`, { archiveId: ARCHIVE_ID, bytes: file.length })).code).toBe("not-waiting");
  });

  it("the backup file opens with the passcode or the account key, and names the data file exactly", async () => {
    const w = await world();
    const file = await backUp(w);
    const r = await call(w.sourceService, "GET", `${ARCHIVE_PATH}/backup-file`);
    expect(r.status).toBe(200);
    expect(r.headers["content-disposition"]).toMatch(/home-\d{4}-\d{2}-\d{2}\.flagship-backup/);
    const text = String(r.body);
    expect(text).not.toContain("notes");
    const f = parseBackupFile(text);
    const viaPass = openBackupWithPasscode(f, PASSCODE);
    const viaAccount = openBackupWithAccountKey(f, deriveServerArchiveKey(UMK, ARCHIVE_ID))!;
    expect(Buffer.from(viaPass.contentKey)).toEqual(CONTENT_KEY);
    expect(viaAccount.body).toEqual(viaPass.body);
    expect(viaPass.body).toMatchObject({
      server: { name: "home", domain: SRC, bootUnlockMode: "auto", diskEncryption: "luks" },
      apps: [{ serviceId: SERVICE, name: "notes" }],
      data: { bytes: file.length, sha256: createHash("sha256").update(file).digest("hex"), frameBytes: 1024 * 1024 },
    });
    expect(viaPass.body.data.fileName).toMatch(/^home-\d{4}-\d{2}-\d{2}\.flagship-data$/);
    expect(() => openBackupWithPasscode(f, "k7qm-2xhd-9twp-4frn-6cyc")).toThrow();
  });

  it("carries no image, OS or Flagship: only the app's source, data and settings", async () => {
    const w = await world();
    const file = await backUp(w);
    const { openDataFile } = await import("../../src/serverArchive/format.js");
    const tarStream = (await import("tar-stream")).default;
    const path = join(w.dir, "check.flagship-data");
    await writeFile(path, file);
    const names: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const ex = tarStream.extract();
      ex.on("entry", (h, st, next) => {
        names.push(h.name);
        st.resume();
        st.on("end", next);
      });
      ex.on("finish", resolve);
      ex.on("error", reject);
      openDataFile(path, CONTENT_KEY, ARCHIVE_ID).pipe(ex);
    });
    expect(names.sort()).toEqual([
      "apps/harry--notes/db-0.dump",
      "apps/harry--notes/files.tar",
      "apps/harry--notes/meta.json",
      "apps/harry--notes/source.json",
      "manifest.json",
    ]);
    expect(names.some((n) => /image|\.tar\.gz|rootfs|docker/i.test(n))).toBe(false);
  });

  it("an app with neither source nor a public image is left out, and named", async () => {
    const w = await world();
    const svc = buildServerArchiveService({
      dir: join(w.dir, "nosrc"),
      build: { serverFqdn: SRC, apps: () => [w.src.platform.byServiceId(SERVICE)!], containerName: () => "c", ops: w.sOps.ops, envStore: null, access: null, accessList: null },
      restore: { serverFqdn: SRC, platform: w.src.platform, dataProvisioner: null, ops: w.sOps.ops, signInstall: (r) => srcBox.signInstallService(r), envStore: null, access: null, egress: null, buildImage: async () => ({ ok: true as const }), pullImage: async () => {} },
      freeBytes: async () => 1e12,
    });
    await call(svc, "POST", `${ARCHIVE_PATH}/start`, startBody());
    await svc.settle();
    const a = asJson(await call(svc, "GET", ARCHIVE_PATH)).archive;
    expect(a.state).toBe("ready");
    expect(a.apps).toEqual([]);
    expect(a.left).toEqual([{ serviceId: SERVICE, name: "notes", reason: expect.stringContaining("source") }]);
  });

  it("an app installed from a public image is pulled on restore, not carried", async () => {
    const w = await world();
    const app = w.src.platform.byServiceId(SERVICE)!;
    const pulled = { ...app, manifest: { ...app.manifest, runtime: { ...app.manifest.runtime, image: "ghcr.io/acme/notes@sha256:" + "a".repeat(64) } } } as typeof app;
    const svc = buildServerArchiveService({
      dir: join(w.dir, "pull"),
      build: { serverFqdn: SRC, apps: () => [pulled], containerName: () => "c", ops: w.sOps.ops, envStore: null, access: null, accessList: null },
      restore: { serverFqdn: SRC, platform: w.src.platform, dataProvisioner: null, ops: w.sOps.ops, signInstall: (r) => srcBox.signInstallService(r), envStore: null, access: null, egress: null, buildImage: async () => ({ ok: true as const }), pullImage: async () => {} },
      freeBytes: async () => 1e12,
    });
    await call(svc, "POST", `${ARCHIVE_PATH}/start`, startBody());
    await svc.settle();
    const file = await download(svc);
    w.targetWait.current = await waitingFor(w.dir, DST, file);
    await upload(w.targetService, file);
    await call(w.targetService, "POST", `${RESTORE_PATH}/commit`, { key: keyHex() });
    await w.targetService.settle();
    expect(asJson(await call(w.targetService, "GET", RESTORE_PATH)).restore.apps[0]).toMatchObject({ state: "done" });
    expect(w.pulls).toEqual(["ghcr.io/acme/notes@sha256:" + "a".repeat(64)]);
    expect(w.builds).toEqual([]);
  });

  it("carries the app's API keys and the front page onto the new server", async () => {
    const w = await world();
    const exported = [{ grant: { serverDomain: SRC, serviceId: SERVICE, keyId: "0123456789abcdef", scope: "read", expiresAt: 0, issuedAt: 1 }, signature: "ab".repeat(64), secretSha256: "cd".repeat(32), label: "cron", createdAt: 1 }];
    const imported: Array<{ id: string; keys: unknown }> = [];
    let front: string | null = null;
    const svc = buildServerArchiveService({
      dir: join(w.dir, "cfg-src"),
      build: {
        serverFqdn: SRC, apps: () => [w.src.platform.byServiceId(SERVICE)!], containerName: () => "c", ops: w.sOps.ops, envStore: null, access: null, accessList: null,
        sourceDir: w.srcClones,
        apiKeys: { exportService: () => exported as never },
        frontPage: () => "notes",
      },
      restore: { serverFqdn: SRC, platform: w.src.platform, dataProvisioner: null, ops: w.sOps.ops, signInstall: (r) => srcBox.signInstallService(r), envStore: null, access: null, egress: null, buildImage: async () => ({ ok: true as const }), pullImage: async () => {} },
      freeBytes: async () => 1e12,
    });
    await call(svc, "POST", `${ARCHIVE_PATH}/start`, startBody());
    await svc.settle();
    const file = await download(svc);
    const target = buildServerArchiveService({
      dir: join(w.dir, "cfg-dst"),
      uploadDir: join(w.dir, "cfg-upload"),
      wait: await waitingFor(w.dir, DST, file),
      build: { serverFqdn: DST, apps: () => [], containerName: () => "", ops: w.tOps.ops, envStore: null, access: null, accessList: null },
      restore: {
        serverFqdn: DST, platform: w.dst.platform, dataProvisioner: w.dst.provisioner, ops: w.tOps.ops, signInstall: (r) => dstBox.signInstallService(r),
        envStore: null, access: null, egress: null, sourceDir: w.dstClones,
        buildImage: async (a) => {
          w.tOps.images.add(a.image);
          return { ok: true as const };
        },
        pullImage: async () => {},
        apiKeys: { importService: async (id, keys) => (imported.push({ id, keys }), { imported: 1, dropped: 0 }) },
        frontPage: { get: () => front, set: async (l) => void (front = l), installed: (l) => l === "notes" },
      },
      freeBytes: async () => 1e12,
    });
    await upload(target, file);
    await call(target, "POST", `${RESTORE_PATH}/commit`, { key: keyHex() });
    await target.settle();
    expect(asJson(await call(target, "GET", RESTORE_PATH)).restore.apps[0]).toMatchObject({ state: "done" });
    expect(imported).toEqual([{ id: SERVICE, keys: exported }]);
    expect(front).toBe("notes");
  });

  it("the data file holds none of the plain content", async () => {
    const w = await world();
    const file = await backUp(w);
    const text = file.toString("latin1");
    expect(text.startsWith("flagship-backup-data/v2\n")).toBe(true);
    expect(text).not.toContain("sk-secret");
    expect(text).not.toContain("rows-of-");
    expect(text).not.toContain("flagship-vibe-harry--notes");
    expect(text).not.toContain(ARCHIVE_ID);
  });

  it("a server that isn't waiting, or waits for another backup, refuses the upload", async () => {
    const w = await world();
    const file = await backUp(w);
    const notWaiting = await call(w.targetService, "POST", `${RESTORE_PATH}/start`, { archiveId: ARCHIVE_ID, bytes: file.length });
    expect(notWaiting.status).toBe(409);
    expect(asJson(notWaiting).code).toBe("not-waiting");
    expect(asJson(await call(w.targetService, "GET", RESTORE_PATH))).toEqual({ waiting: null, restore: null });
    w.targetWait.current = await waitingFor(w.dir, DST, file, { archiveId: "ff".repeat(16) });
    const other = await call(w.targetService, "POST", `${RESTORE_PATH}/start`, { archiveId: ARCHIVE_ID, bytes: file.length });
    expect(asJson(other).code).toBe("other-backup");
  });

  it("only the owner's signed order for THIS server puts it in the waiting state", async () => {
    const w = await world();
    const file = await backUp(w);
    const paths = { path: join(w.dir, "w.json"), donePath: join(w.dir, "d.json"), serverDomain: DST, ownerIrkPub: owner.publicKey, username: "harry" };
    const wait = buildRestoreWait(paths);
    await wait.load();
    const order: ServerRestoreOrder = { serverDomain: DST, archiveId: ARCHIVE_ID, bytes: file.length, sha256: "ab".repeat(32), issuedAt: 1 };
    const sig = (o: ServerRestoreOrder, k = owner) => Buffer.from(signServerRestoreOrder(o, k)).toString("hex");
    const json = (o: ServerRestoreOrder, s: string) => JSON.stringify({ request: {}, signature: "", restore: { order: o, signatureHex: s } });
    expect(await wait.adoptFromPairingJson(json(order, sig(order, deriveIRK({ seed: new Uint8Array(32).fill(7) }))))).toBe(false);
    expect(await wait.adoptFromPairingJson(json({ ...order, serverDomain: SRC }, sig({ ...order, serverDomain: SRC })))).toBe(false);
    expect(await wait.adoptFromPairingJson(json(order, sig({ ...order, bytes: 2 })))).toBe(false);
    expect(wait.current()).toBeNull();
    expect(await wait.adoptFromPairingJson(json(order, sig(order)))).toBe(true);
    // It survives a restart, and a finished backup never re-arms it.
    const again = buildRestoreWait(paths);
    await again.load();
    expect(again.current()?.order).toEqual(order);
    await again.finish(ARCHIVE_ID);
    expect(await again.adoptFromPairingJson(json(order, sig(order)))).toBe(false);
    const third = buildRestoreWait(paths);
    await third.load();
    expect(third.current()).toBeNull();
  });

  it("an admin-pinned box takes a restore order only from the admin root (adding a server is admin-only)", async () => {
    const w = await world();
    const file = await backUp(w);
    const adminSeed = new Uint8Array(32).fill(0x22);
    const admin = { privateKey: adminSeed, publicKey: ed.getPublicKey(adminSeed) };
    const deviceSeed = new Uint8Array(32).fill(0x44);
    const device = { privateKey: deviceSeed, publicKey: ed.getPublicKey(deviceSeed) };
    const legacy = { path: join(w.dir, "w2.json"), donePath: join(w.dir, "d2.json"), serverDomain: DST, ownerIrkPub: owner.publicKey, username: "harry" };
    const paths = { ...legacy, adminRootPub: admin.publicKey };
    const order: ServerRestoreOrder = { serverDomain: DST, archiveId: ARCHIVE_ID, bytes: file.length, sha256: "ab".repeat(32), issuedAt: 1 };
    const json = (k: { privateKey: Uint8Array; publicKey: Uint8Array }) =>
      JSON.stringify({ request: {}, signature: "", restore: { order, signatureHex: Buffer.from(signServerRestoreOrder(order, k)).toString("hex") } });

    // An IRK-signed order a box with no admin root took is dropped once one is pinned.
    const before = buildRestoreWait(legacy);
    await before.load();
    expect(await before.adoptFromPairingJson(json(owner))).toBe(true);
    const wait = buildRestoreWait(paths);
    await wait.load();
    expect(wait.current()).toBeNull();

    expect(await wait.adoptFromPairingJson(json(owner))).toBe(false);
    expect(await wait.adoptFromPairingJson(json(device))).toBe(false);
    expect(wait.current()).toBeNull();
    expect(await wait.adoptFromPairingJson(json(admin))).toBe(true);
    const again = buildRestoreWait(paths);
    await again.load();
    expect(again.current()?.order).toEqual(order);
  });

  it("a wrong key fails the restore, installs nothing, and leaves the server waiting", async () => {
    const w = await world();
    const file = await backUp(w);
    w.targetWait.current = await waitingFor(w.dir, DST, file);
    await upload(w.targetService, file);
    await call(w.targetService, "POST", `${RESTORE_PATH}/commit`, { key: "11".repeat(32) });
    await w.targetService.settle();
    const view = asJson(await call(w.targetService, "GET", RESTORE_PATH));
    expect(view.restore.state).toBe("failed");
    expect(view.restore.reason).toMatch(/wrong key|changed or cut short/);
    expect(view.waiting).toMatchObject({ archiveId: ARCHIVE_ID });
    expect(w.targetWait.current.heartbeatView()).toEqual({ archiveId: ARCHIVE_ID, state: "waiting" });
    expect(w.dst.platform.byServiceId(SERVICE)).toBeUndefined();
    // Sending it again with the right key works.
    await upload(w.targetService, file);
    await call(w.targetService, "POST", `${RESTORE_PATH}/commit`, { key: keyHex() });
    await w.targetService.settle();
    expect(asJson(await call(w.targetService, "GET", RESTORE_PATH)).restore.state).toBe("done");
  });

  it("a changed data file is refused before it is opened, and the server keeps waiting", async () => {
    const w = await world();
    const file = await backUp(w);
    w.targetWait.current = await waitingFor(w.dir, DST, file);
    const damaged = Buffer.from(file);
    damaged[damaged.length - 30] ^= 1;
    await upload(w.targetService, damaged);
    await call(w.targetService, "POST", `${RESTORE_PATH}/commit`, { key: keyHex() });
    await w.targetService.settle();
    const view = asJson(await call(w.targetService, "GET", RESTORE_PATH));
    expect(view.restore.state).toBe("failed");
    expect(view.restore.reason).toMatch(/isn't the one this server is waiting for/);
    expect(view.waiting).not.toBeNull();
    expect(w.dst.platform.byServiceId(SERVICE)).toBeUndefined();
  });

  it("an upload resumes where it stopped, even after a restart", async () => {
    const w = await world();
    const file = await backUp(w);
    w.targetWait.current = await waitingFor(w.dir, DST, file);
    expect((await call(w.targetService, "POST", `${RESTORE_PATH}/start`, { archiveId: ARCHIVE_ID, bytes: file.length })).status).toBe(202);
    await call(w.targetService, "POST", `${RESTORE_PATH}/chunk?offset=0`, file.subarray(0, 500));
    // The app comes back: same service.
    expect(asJson(await call(w.targetService, "POST", `${RESTORE_PATH}/start`, { archiveId: ARCHIVE_ID, bytes: file.length })).received).toBe(500);
    // The daemon restarts: a new service over the same folders.
    const restarted = buildServerArchiveService({
      dir: join(w.dir, "dst-archives"),
      uploadDir: join(w.dir, "dst-upload"),
      wait: w.targetWait.current,
      build: { serverFqdn: DST, apps: () => [], containerName: () => "", ops: w.tOps.ops, envStore: w.dstEnv, access: null, accessList: null },
      restore: {
        serverFqdn: DST, platform: w.dst.platform, dataProvisioner: w.dst.provisioner, ops: w.tOps.ops, signInstall: (r) => dstBox.signInstallService(r),
        envStore: w.dstEnv, access: null, egress: null, sourceDir: w.dstClones,
        buildImage: async (a) => (w.tOps.images.add(a.image), { ok: true as const }),
        pullImage: async () => {},
      },
      freeBytes: async () => 1e12,
    });
    await restarted.init();
    const resumed = await call(restarted, "POST", `${RESTORE_PATH}/start`, { archiveId: ARCHIVE_ID, bytes: file.length });
    expect(asJson(resumed).received).toBe(500);
    for (let o = 500; o < file.length; o += 700) {
      expect((await call(restarted, "POST", `${RESTORE_PATH}/chunk?offset=${o}`, file.subarray(o, o + 700))).status).toBe(200);
    }
    await call(restarted, "POST", `${RESTORE_PATH}/commit`, { key: keyHex() });
    await restarted.settle();
    expect(asJson(await call(restarted, "GET", RESTORE_PATH)).restore.state).toBe("done");
  });

  it("Back up now needs a passcode slot: the account slot alone is refused", async () => {
    const w = await world();
    const r = await call(w.sourceService, "POST", `${ARCHIVE_PATH}/start`, { archiveId: ARCHIVE_ID, key: keyHex(), slots: [slots()[1]] });
    expect(r.status).toBe(400);
    expect(asJson(r)).toMatchObject({ code: "passcode-required" });
  });

  it("an app that fails to restore is named with its reason, and the server stops waiting anyway", async () => {
    const w = await world();
    const file = await backUp(w);
    w.targetWait.current = await waitingFor(w.dir, DST, file);
    w.dst.platform.setAdmitNewApp(() => "This server holds 6.0 GB of app data, over its backup limit of 5.0 GB");
    await upload(w.targetService, file);
    expect((await call(w.targetService, "POST", `${RESTORE_PATH}/commit`, { key: keyHex() })).status).toBe(202);
    await w.targetService.settle();
    const view = asJson(await call(w.targetService, "GET", RESTORE_PATH));
    expect(view.restore).toMatchObject({ state: "done", apps: [{ serviceId: SERVICE, name: "notes", state: "failed", reason: expect.stringMatching(/over its backup limit/) }] });
    // Every app was tried: the server is a normal server now, not "Waiting for its backup".
    expect(view.waiting).toBeNull();
    expect(w.targetWait.current.heartbeatView()).toBeNull();
    expect(w.dst.platform.byServiceId(SERVICE)).toBeUndefined();
  });

  it("an app that is already on the server is skipped, not overwritten", async () => {
    const w = await world();
    const file = await backUp(w);
    w.sourceWait.current = await waitingFor(w.dir, SRC, file);
    await upload(w.sourceService, file);
    await call(w.sourceService, "POST", `${RESTORE_PATH}/commit`, { key: keyHex() });
    await w.sourceService.settle();
    const status = asJson(await call(w.sourceService, "GET", RESTORE_PATH)).restore;
    expect(status.state).toBe("done");
    expect(status.apps[0]).toMatchObject({ state: "skipped", reason: "already on this server" });
  });

  it("refuses out-of-order chunks, bad slots, and companion sessions", async () => {
    const w = await world();
    const file = await backUp(w);
    w.targetWait.current = await waitingFor(w.dir, DST, file);
    expect((await call(w.targetService, "POST", `${RESTORE_PATH}/start`, { archiveId: ARCHIVE_ID, bytes: file.length })).status).toBe(202);
    const r = await call(w.targetService, "POST", `${RESTORE_PATH}/chunk?offset=100`, file.subarray(0, 50));
    expect(r.status).toBe(409);
    expect((await call(w.targetService, "GET", ARCHIVE_PATH, undefined, true)).status).toBe(403);
    expect((await call(w.targetService, "POST", `${RESTORE_PATH}/start`, { archiveId: ARCHIVE_ID, bytes: file.length }, true)).status).toBe(403);
    expect((await call(w.sourceService, "POST", `${ARCHIVE_PATH}/start`, { archiveId: "zz", key: "00", slots: slots() })).status).toBe(400);
    expect((await call(w.sourceService, "POST", `${ARCHIVE_PATH}/start`, { archiveId: ARCHIVE_ID, key: keyHex() })).status).toBe(400);
    expect((await call(w.sourceService, "POST", `${ARCHIVE_PATH}/start`, { archiveId: ARCHIVE_ID, key: keyHex(), slots: [slots()[1], slots()[1]] })).status).toBe(400);
  });

  it("sizes the backup first and refuses one that wouldn't fit, saying how much it needs", async () => {
    const w = await world();
    const GB = 1024 ** 3;
    const sized = {
      ...w.sOps.ops,
      databaseBytes: async () => 2 * GB,
      filesBytes: async () => GB,
    };
    const svc = buildServerArchiveService({
      dir: join(w.dir, "sized"),
      build: { serverFqdn: SRC, apps: () => [w.src.platform.byServiceId(SERVICE)!], containerName: () => "c", ops: sized, envStore: null, access: null, accessList: null },
      restore: { serverFqdn: SRC, platform: w.src.platform, dataProvisioner: null, ops: sized, signInstall: (r) => srcBox.signInstallService(r), envStore: null, access: null, egress: null, buildImage: async () => ({ ok: true as const }), pullImage: async () => {} },
      freeBytes: async () => 6 * GB,
    });
    expect((await call(svc, "POST", `${ARCHIVE_PATH}/start`, startBody())).status).toBe(202);
    await svc.settle();
    const a = asJson(await call(svc, "GET", ARCHIVE_PATH)).archive;
    // 3 GB of parts (no image travels): the file (~3 GB) + one app's scratch (~3 GB) + 1 GB headroom > 6 GB.
    expect(a).toMatchObject({ state: "failed", estimatedBytes: expect.any(Number) });
    expect(a.estimatedBytes).toBeGreaterThan(3 * GB);
    expect(a.reason).toMatch(/needs about 7\.\d GB free .* has 6\.0 GB/);
  });

  it("goes ahead when the sized backup fits", async () => {
    const w = await world();
    const sized = { ...w.sOps.ops, databaseBytes: async () => 1000, filesBytes: async () => 1000 };
    const svc = buildServerArchiveService({
      dir: join(w.dir, "fits"),
      build: { serverFqdn: SRC, apps: () => [w.src.platform.byServiceId(SERVICE)!], containerName: () => "c", ops: sized, envStore: null, access: null, accessList: null },
      restore: { serverFqdn: SRC, platform: w.src.platform, dataProvisioner: null, ops: sized, signInstall: (r) => srcBox.signInstallService(r), envStore: null, access: null, egress: null, buildImage: async () => ({ ok: true as const }), pullImage: async () => {} },
      freeBytes: async () => 5 * 1024 ** 3,
    });
    await call(svc, "POST", `${ARCHIVE_PATH}/start`, startBody());
    await svc.settle();
    expect(asJson(await call(svc, "GET", ARCHIVE_PATH)).archive.state).toBe("ready");
  });

  it("refuses a restore when the disk is too full", async () => {
    const w = await world();
    const file = await backUp(w);
    const full = buildServerArchiveService({
      dir: join(w.dir, "full"),
      uploadDir: join(w.dir, "full-upload"),
      wait: await waitingFor(w.dir, DST, file),
      build: { serverFqdn: DST, apps: () => [], containerName: () => "", ops: w.tOps.ops, envStore: null, access: null, accessList: null },
      restore: { serverFqdn: DST, platform: w.dst.platform, dataProvisioner: null, ops: w.tOps.ops, signInstall: (r) => dstBox.signInstallService(r), envStore: null, access: null, egress: null, buildImage: async () => ({ ok: true as const }), pullImage: async () => {} },
      freeBytes: async () => 10,
    });
    const r = await call(full, "POST", `${RESTORE_PATH}/start`, { archiveId: ARCHIVE_ID, bytes: file.length });
    expect(r.status).toBe(507);
  });
});

async function body(r: HttpResponse): Promise<Buffer> {
  if (!r.stream) return Buffer.from(r.body);
  const parts: Buffer[] = [];
  for await (const c of r.stream.open() as AsyncIterable<Buffer>) parts.push(c);
  return Buffer.concat(parts);
}

describe("the backup's download link (browser, approved with the app)", () => {
  async function ready() {
    const w = await world();
    const svc = buildServerArchiveService({
      dir: join(w.dir, "dl"),
      build: { serverFqdn: SRC, apps: () => [w.src.platform.byServiceId(SERVICE)!], containerName: () => "c", ops: w.sOps.ops, envStore: null, access: null, accessList: null, sourceDir: w.srcClones },
      restore: { serverFqdn: SRC, platform: w.src.platform, dataProvisioner: null, ops: w.sOps.ops, signInstall: (r) => srcBox.signInstallService(r), envStore: null, access: null, egress: null, buildImage: async () => ({ ok: true as const }), pullImage: async () => {} },
      freeBytes: async () => 1e12,
      authorizeDownload: (a, sig) => verifyArchiveDownloadApproval(a, sig, owner.publicKey),
      appLinkBase: "https://flagshipserver.com",
    });
    await call(svc, "POST", `${ARCHIVE_PATH}/start`, startBody());
    await svc.settle();
    const status = asJson(await call(svc, "GET", ARCHIVE_PATH)).archive;
    const parts: Buffer[] = [];
    for (let o = 0; o < status.bytes; ) {
      const c = (await call(svc, "GET", `${ARCHIVE_PATH}/chunk?offset=${o}`)).body as Buffer;
      parts.push(c);
      o += c.length;
    }
    const file = Buffer.concat(parts);
    const link = asJson(await call(svc, "POST", `${ARCHIVE_PATH}/link`));
    const get = async (path: string, headers: Record<string, string> = {}, method = "GET") =>
      (await svc.handleDownload({ method, path, headers, body: Buffer.alloc(0) }))!;
    const R = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
    const approve = async (over: Partial<{ serverDomain: string; archiveId: string; requestId: string; issuedAt: number }> = {}, signer = owner) => {
      const approval = { serverDomain: SRC, archiveId: ARCHIVE_ID, requestId: R, issuedAt: Date.now(), ...over };
      const signature = Buffer.from(signArchiveDownloadApproval(approval, signer)).toString("hex");
      return call(svc, "POST", `${ARCHIVE_PATH}/approve`, { approval, signature });
    };
    return { w, svc, file, link, get, R, approve };
  }

  it("the link alone gives a page, never the file", async () => {
    const { link, get, R } = await ready();
    const first = await get(link.path);
    expect(first.status).toBe(303);
    expect(first.headers!.location).toMatch(new RegExp(`^${link.path}\\?r=[0-9a-f]{32}$`));
    const page = await get(`${link.path}?r=${R}`);
    expect(page.status).toBe(200);
    expect(page.headers!["content-type"]).toContain("text/html");
    expect(page.headers!["x-frame-options"]).toBe("DENY");
    const htmlText = String(page.body);
    expect(htmlText).toContain(archiveDownloadCode(R));
    expect(htmlText).toContain("<svg");
    expect(htmlText).not.toContain("flagship-archive\",");
    expect(asJson(await get(`${link.path}/status?r=${R}`))).toEqual({ approved: false });
    expect((await get(`${link.path}/bundle?r=${R}`)).status).toBe(403);
  });

  it("an approval signed by the owner opens the one .flagship file to that browser only, with ranges", async () => {
    const { file, link, get, R, approve } = await ready();
    expect((await approve()).status).toBe(200);
    expect(asJson(await get(`${link.path}/status?r=${R}`))).toEqual({ approved: true });
    const r = await get(`${link.path}/bundle?r=${R}`);
    expect(r.status).toBe(200);
    expect(r.headers).toMatchObject({ "accept-ranges": "bytes", "content-type": "application/octet-stream" });
    expect(r.headers!["content-disposition"]).toMatch(/home-\d{4}-\d{2}-\d{2}\.flagship"/);
    const whole = await body(r);
    expect(whole.length).toBe(link.bundleBytes);
    expect(createHash("sha256").update(whole).digest("hex")).toBe(link.bundleSha256);
    expect(r.headers!.etag).toBe(`"${link.bundleSha256}"`);
    // Header, then the backup file, then the data file: nothing else.
    const h = parseBackupBundleHeader(whole.subarray(0, 16), whole.length);
    expect(parseBackupFile(whole.subarray(h.metaOffset, h.metaOffset + h.metaLength).toString("utf8")).archiveId).toBe(ARCHIVE_ID);
    expect(whole.subarray(h.dataOffset)).toEqual(file);
    expect(link).toMatchObject({ bundleFileName: expect.stringMatching(/\.flagship$/) });
    // Ranges across the seams (header | backup file | data file) and resume.
    for (const [a, b] of [[0, 15], [10, 40], [h.dataOffset - 5, h.dataOffset + 5], [100, 299], [whole.length - 7, whole.length - 1]] as const) {
      const part = await get(`${link.path}/bundle?r=${R}`, { range: `bytes=${a}-${b}` });
      expect(part.status).toBe(206);
      expect(await body(part)).toEqual(whole.subarray(a, b + 1));
    }
    expect((await get(`${link.path}/bundle?r=${R}`, { range: `bytes=${whole.length}-` })).status).toBe(416);
    const resumeOther = await get(`${link.path}/bundle?r=${R}`, { range: "bytes=10-20", "if-range": '"not-this-file"' });
    expect(resumeOther.status).toBe(200);
    expect((await get(`${link.path}/bundle?r=${R}`, {}, "HEAD")).status).toBe(200);
    // The two parts are not served on their own any more.
    expect((await get(`${link.path}/file?r=${R}`)).status).toBe(404);
    expect((await get(`${link.path}/backup?r=${R}`)).status).toBe(404);
    // Another browser (another request id) is still locked out.
    expect((await get(`${link.path}/bundle?r=${"11".repeat(16)}`)).status).toBe(403);
  });

  it("the phones' resumable downloader reads the same one file in 4 MiB pieces", async () => {
    const { w, svc, link } = await ready();
    void w;
    const parts: Buffer[] = [];
    let total = 0;
    let sha = "";
    for (let o = 0; ; ) {
      const c = await call(svc, "GET", `${ARCHIVE_PATH}/bundle?offset=${o}`);
      expect(c.status).toBe(200);
      total = Number(c.headers["x-flagship-bundle-bytes"]);
      sha = String(c.headers["x-flagship-bundle-sha256"]);
      parts.push(c.body as Buffer);
      o += (c.body as Buffer).length;
      if (o >= total) break;
    }
    const whole = Buffer.concat(parts);
    expect(total).toBe(link.bundleBytes);
    expect(createHash("sha256").update(whole).digest("hex")).toBe(sha);
    expect(asJson(await call(svc, "GET", ARCHIVE_PATH)).archive).toMatchObject({ bundleBytes: total, bundleSha256: sha });
  });

  it("refuses approvals that aren't the owner's, are stale, or name another server or backup", async () => {
    const { link, get, R, approve } = await ready();
    expect((await approve({}, deriveIRK({ seed: new Uint8Array(32).fill(1) }))).status).toBe(403);
    expect((await approve({ issuedAt: Date.now() - 10 * 60_000 })).status).toBe(403);
    expect((await approve({ serverDomain: DST })).status).toBe(403);
    expect((await approve({ archiveId: "ff".repeat(16) })).status).toBe(404);
    expect(asJson(await get(`${link.path}/status?r=${R}`))).toEqual({ approved: false });
  });

  it("a wrong or old token, and other methods, get nothing", async () => {
    const { svc, link, get, R, approve } = await ready();
    await approve();
    expect((await get(`${DOWNLOAD_PATH}${"0".repeat(64)}/bundle?r=${R}`)).status).toBe(404);
    expect((await get(`${DOWNLOAD_PATH}short`)).status).toBe(404);
    expect((await get(`${link.path}/bundle?r=${R}`, {}, "POST")).status).toBe(405);
    await call(svc, "DELETE", ARCHIVE_PATH);
    expect((await get(`${link.path}/bundle?r=${R}`)).status).toBe(404);
  });

  it("parses Range headers", () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=5-1", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
  });
});

describe("the daemon's HTTP writer", () => {
  function fakeSocket() {
    const out: Buffer[] = [];
    let ended!: () => void;
    const done = new Promise<void>((r) => (ended = r));
    const sock = new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        out.push(Buffer.from(chunk));
        cb();
      },
      final(cb) {
        ended();
        cb();
      },
    });
    return { sock, out, done };
  }

  it("pipes a streamed body after a head that names its length", async () => {
    const { sock, out, done } = fakeSocket();
    const payload = Buffer.alloc(300_000, 7);
    _handleHttpConnectionForTest(sock, async () => ({
      status: 206,
      headers: { "content-type": "application/octet-stream" },
      body: "",
      stream: { length: payload.length, open: () => Duplex.from(payload) },
    }));
    sock.push(Buffer.from("GET /x HTTP/1.1\r\nHost: a\r\n\r\n"));
    await done;
    const raw = Buffer.concat(out);
    const sep = raw.indexOf("\r\n\r\n");
    const head = raw.subarray(0, sep).toString();
    expect(head).toContain("HTTP/1.1 206 Partial Content");
    expect(head).toContain(`Content-Length: ${payload.length}`);
    expect(raw.subarray(sep + 4)).toEqual(payload);
  });

  it("sends no body for HEAD", async () => {
    const { sock, out, done } = fakeSocket();
    _handleHttpConnectionForTest(sock, async () => ({
      status: 200,
      body: "",
      stream: { length: 5, open: () => Duplex.from(Buffer.from("hello")) },
    }));
    sock.push(Buffer.from("HEAD /x HTTP/1.1\r\n\r\n"));
    await done;
    const raw = Buffer.concat(out).toString();
    expect(raw).toContain("Content-Length: 5");
    expect(raw.endsWith("\r\n\r\n")).toBe(true);
  });
});
