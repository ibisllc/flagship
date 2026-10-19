/**
 * Saved and scheduled backups (docs/server-backup-and-clone.md, "Scheduled
 * backups"): the same two files as Back up now, sealed with an account slot
 * from the keys an admin device deposited, kept on the server by the
 * schedule's retention, and restorable onto a new server like any backup.
 */
import { mkdtempSync as makeTempDir, rmSync } from "node:fs";
import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveKeysDigest,
  deriveIRK,
  deriveServerArchiveKey,
  mintArchiveKeys,
  openBackupWithAccountKey,
  parseBackupFile,
  signArchiveDownloadApproval,
  signArchiveKeysDeposit,
  signInstallService,
  signServerRestoreOrder,
  verifyArchiveDownloadApproval,
  verifyArchiveKeysDeposit,
  verifyInstallService,
  type ArchiveKey,
} from "@flagship/protocol";
import { buildRestoreWait } from "../../src/serverArchive/restoreWait.js";
import { buildMigratePause, movingPage, type MigratePause } from "../../src/serverArchive/migratePause.js";
import { AppCopyOps } from "../../src/appCopy/ops.js";
import { DataProvisioner, InMemoryFilesAdmin, InMemoryPostgresAdmin } from "../../src/dataLayer/index.js";
import { ServicePlatform } from "../../src/servicePlatform.js";
import { AppRunner, type CommandRunner } from "../../src/serviceRunner.js";
import { InMemoryAppEnvStore } from "../../src/serviceEnvStore.js";
import { buildServerArchiveService, RESTORE_PATH, SAVED_PATH } from "../../src/serverArchive/service.js";
import type { HttpRequest } from "../../src/runtime.js";
import { swkOps, testCustodian } from "../helpers/keyCustody.js";
import { writeSourceTree } from "../../src/llm/serviceSource.js";

// Every temp dir a test makes is removed afterwards: the 5 GiB sparse-file test left real 5 GiB
// files behind on NTFS, which filled a disk.
const tempDirs: string[] = [];
const mkdtempSync = (prefix: string): string => {
  const d = makeTempDir(prefix);
  tempDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const owner = deriveIRK({ seed: new Uint8Array(32).fill(42) });
const stranger = deriveIRK({ seed: new Uint8Array(32).fill(43) });
const srcBox = testCustodian({ identityPriv: new Uint8Array(32).fill(3), swk: new Uint8Array(32).fill(4), cgk: new Uint8Array(32).fill(5) });
const dstBox = testCustodian({ identityPriv: new Uint8Array(32).fill(6), swk: new Uint8Array(32).fill(8), cgk: new Uint8Array(32).fill(5) });
const SRC = "home.harry.flagship.services";
const DST = "clone.harry.flagship.services";
const SERVICE = "harry--notes";
const UMK = { seed: new Uint8Array(32).fill(9) };
const GB = 1024 ** 3;
const DAY = 24 * 60 * 60_000;
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
  const ops: AppCopyOps = {
    saveImage: async () => {
      throw new Error("a backup must never carry an image");
    },
    loadImage: async () => {},
    imageExists: async (i) => images.has(i),
    removeImage: async (i) => void images.delete(i),
    dumpDatabase: async (s, out) => writeFile(out, `rows-of-${s.database}`),
    restoreDatabase: async (_s, p) => void restoredDbs.push(await readFile(p, "utf8")),
    archiveFiles: async (v, _c, out) => writeFile(out, `files-of-${v}`),
    restoreFiles: async () => {},
  };
  return { ops, images, restoredDbs };
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

let rngN = 0;
const rng = (n: number) => {
  rngN += 1;
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (rngN * 31 + i * 7) & 0xff;
  return b;
};

async function world(over: { free?: () => number; disk?: number; sized?: number; scheduleActive?: () => boolean; migrate?: { pause: MigratePause } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "saved-backups-"));
  const clock = { t: Date.UTC(2026, 9, 14, 12) };
  const src = platformFor(srcBox, "s".repeat(40));
  const request = { serverId: SRC, creator: "harry", slug: "notes", manifestJson: JSON.stringify(MANIFEST), addOwnerToMembership: true, issuedAt: Date.now() };
  const installed = await src.platform.install({ request, signature: signInstallService(request, owner), verify: verifyInstallService });
  if (!installed.ok) throw new Error(installed.reason);
  const sOps = fakeOps();
  const ops: AppCopyOps =
    over.sized !== undefined ? { ...sOps.ops, databaseBytes: async () => over.sized!, filesBytes: async () => 0 } : sOps.ops;
  const srcClones = join(dir, "src-clones");
  await writeSourceTree(join(srcClones, SERVICE), { "flagship.app.json": JSON.stringify(MANIFEST), "server.js": "listen()" });
  const events: Array<{ kind: string; detail: string; ok: boolean }> = [];
  const make = () =>
    buildServerArchiveService({
      dir: join(dir, "archives"),
      build: { serverFqdn: SRC, apps: () => [src.platform.byServiceId(SERVICE)!], containerName: (id) => `flagship-${id}`, ops, envStore: null, access: null, accessList: null, sourceDir: srcClones },
      restore: { serverFqdn: SRC, platform: src.platform, dataProvisioner: null, ops, signInstall: (r) => srcBox.signInstallService(r), envStore: null, access: null, egress: null, buildImage: async () => ({ ok: true as const }), pullImage: async () => {} },
      note: (kind, detail, ok) => void events.push({ kind, detail, ok: ok ?? true }),
      freeBytes: async () => (over.free ? over.free() : 1e12),
      authorizeDownload: (a, sig) => verifyArchiveDownloadApproval(a, sig, owner.publicKey),
      saved: {
        dir: join(dir, "server-backups"),
        authorizeKeys: (d, sig) => verifyArchiveKeysDeposit(d, sig, owner.publicKey),
        diskBytes: async () => over.disk ?? 1e13,
        ...(over.scheduleActive ? { scheduleActive: over.scheduleActive } : {}),
      },
      ...(over.migrate ? { migrate: over.migrate } : {}),
      now: () => clock.t,
    });
  const svc = make();
  await svc.init();
  return { dir, clock, src, svc, make, events, sOps };
}
type World = Awaited<ReturnType<typeof world>>;
type Svc = World["svc"];

async function call(svc: Svc, method: string, path: string, body?: unknown | Buffer) {
  const r = await svc.handle(path.split("?")[0]!, method, req(method, path, body), { companion: false });
  return { status: r!.status, headers: r!.headers ?? {}, body: r!.body, json: () => JSON.parse(String(r!.body)) as Record<string, any> };
}

function deposit(keys: ArchiveKey[], at: number, signer = owner, over: Partial<{ serverDomain: string; count: number }> = {}) {
  const d = { serverDomain: SRC, count: keys.length, digest: archiveKeysDigest(keys), issuedAt: at, ...over };
  return { deposit: d, signature: Buffer.from(signArchiveKeysDeposit(d, signer)).toString("hex"), keys };
}

async function giveKeys(w: World, n = 5): Promise<ArchiveKey[]> {
  const keys = mintArchiveKeys(UMK, n, rng);
  const r = await call(w.svc, "POST", `${SAVED_PATH}/keys`, deposit(keys, w.clock.t));
  expect(r.status).toBe(200);
  return keys;
}

async function fetchAll(svc: Svc, id: string, bytes: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  for (let o = 0; o < bytes; ) {
    const c = await call(svc, "GET", `${SAVED_PATH}/${id}/chunk?offset=${o}`);
    expect(c.status).toBe(200);
    parts.push(c.body as Buffer);
    o += (c.body as Buffer).length;
  }
  return Buffer.concat(parts);
}

async function runNow(w: World): Promise<string> {
  const r = await call(w.svc, "POST", `${SAVED_PATH}/run`);
  expect(r.status).toBe(202);
  await w.svc.settle();
  return r.json().archiveId as string;
}

describe("saved backups", () => {
  it("waits for an admin device's keys, and says so in its own words", async () => {
    const w = await world();
    const v = (await call(w.svc, "GET", SAVED_PATH)).json();
    expect(v).toMatchObject({ keysLeft: 0, keysWanted: 400, nextRunAt: null, backups: [], lastRun: null, running: null });
    expect(v.schedule).toMatchObject({ frequency: "daily", keepDaily: 7, keepWeekly: 4 });
    expect(v.waitingReason).toMatch(/admin device of your account hasn't approved backups/);
    const run = await call(w.svc, "POST", `${SAVED_PATH}/run`);
    expect(run.status).toBe(409);
    expect(run.json()).toMatchObject({ code: "no-keys" });
    await w.svc.tick();
    expect((await call(w.svc, "GET", SAVED_PATH)).json().lastRun).toBeNull();
  });

  it("takes keys only signed by the owner's authority, for this server, fresh and matching", async () => {
    const w = await world();
    const keys = mintArchiveKeys(UMK, 3, rng);
    expect((await call(w.svc, "POST", `${SAVED_PATH}/keys`, deposit(keys, w.clock.t, stranger))).status).toBe(403);
    expect((await call(w.svc, "POST", `${SAVED_PATH}/keys`, deposit(keys, w.clock.t, owner, { serverDomain: DST }))).status).toBe(403);
    expect((await call(w.svc, "POST", `${SAVED_PATH}/keys`, deposit(keys, w.clock.t - 11 * 60_000))).status).toBe(403);
    const bad = deposit(keys, w.clock.t);
    expect((await call(w.svc, "POST", `${SAVED_PATH}/keys`, { ...bad, keys: keys.slice(1) })).status).toBe(400);
    const ok = await call(w.svc, "POST", `${SAVED_PATH}/keys`, bad);
    expect(ok.status).toBe(200);
    expect(ok.json()).toMatchObject({ keysLeft: 3, keysWanted: 400 });
    // The same deposit again adds nothing.
    expect((await call(w.svc, "POST", `${SAVED_PATH}/keys`, deposit(keys, w.clock.t))).json().keysLeft).toBe(3);
  });

  it("Back up now saves the same two files, opened by the account key, and spends one key", async () => {
    const w = await world();
    const keys = await giveKeys(w, 2);
    const id = await runNow(w);
    expect(id).toBe(keys[0]!.archiveId);
    const v = (await call(w.svc, "GET", SAVED_PATH)).json();
    expect(v.keysLeft).toBe(1);
    expect(v.lastRun).toMatchObject({ ok: true, trigger: "now", archiveId: id });
    expect(v.backups).toHaveLength(1);
    const b = v.backups[0];
    expect(b).toMatchObject({ archiveId: id, trigger: "now", apps: [{ serviceId: SERVICE, name: "notes" }], left: [] });
    expect(b.backupFileName).toBe("home-2026-10-14-1200.flagship-backup");
    expect(b.dataFileName).toBe("home-2026-10-14-1200.flagship-data");
    const backupFile = await call(w.svc, "GET", `${SAVED_PATH}/${id}/backup-file`);
    expect(backupFile.headers["content-disposition"]).toContain(b.backupFileName);
    const file = parseBackupFile(String(backupFile.body));
    expect(file.slots.map((s) => s.kind)).toEqual(["account"]);
    const opened = openBackupWithAccountKey(file, deriveServerArchiveKey(UMK, id))!;
    expect(opened.body.data).toMatchObject({ fileName: b.dataFileName, bytes: b.bytes, sha256: b.sha256 });
    const data = await fetchAll(w.svc, id, b.bytes);
    expect(createHash("sha256").update(data).digest("hex")).toBe(b.sha256);
    // The box kept no copy of the key it used.
    const onDisk = await readFile(join(w.dir, "server-backups", "keys.json"), "utf8");
    expect(onDisk).not.toContain(keys[0]!.kekHex);
    expect(w.events.map((e) => e.kind)).toContain("server.backup.created");
  });

  it("a saved backup restores onto a new server like any backup", async () => {
    const w = await world();
    await giveKeys(w, 1);
    const id = await runNow(w);
    const b = (await call(w.svc, "GET", SAVED_PATH)).json().backups[0];
    const data = await fetchAll(w.svc, id, b.bytes);
    const opened = openBackupWithAccountKey(parseBackupFile(String((await call(w.svc, "GET", `${SAVED_PATH}/${id}/backup-file`)).body)), deriveServerArchiveKey(UMK, id))!;

    const dst = platformFor(dstBox, "t".repeat(40));
    const tOps = fakeOps();
    const wait = buildRestoreWait({ path: join(w.dir, "wait.json"), donePath: join(w.dir, "done.json"), serverDomain: DST, ownerIrkPub: owner.publicKey, username: "harry" });
    await wait.load();
    const order = { serverDomain: DST, archiveId: id, bytes: data.length, sha256: b.sha256, issuedAt: Date.now() };
    const signatureHex = Buffer.from(signServerRestoreOrder(order, owner)).toString("hex");
    expect(await wait.adoptFromPairingJson(JSON.stringify({ request: {}, signature: "", restore: { order, signatureHex } }))).toBe(true);
    const target = buildServerArchiveService({
      dir: join(w.dir, "dst-archives"),
      uploadDir: join(w.dir, "dst-upload"),
      wait,
      build: { serverFqdn: DST, apps: () => [], containerName: () => "", ops: tOps.ops, envStore: null, access: null, accessList: null },
      restore: {
        serverFqdn: DST,
        platform: dst.platform,
        dataProvisioner: dst.provisioner,
        ops: tOps.ops,
        signInstall: (r) => dstBox.signInstallService(r),
        envStore: new InMemoryAppEnvStore(),
        access: null,
        egress: null,
        sourceDir: join(w.dir, "dst-clones"),
        buildImage: async (a) => {
          await writeSourceTree(a.contextDir, a.files, { binaries: a.binaries });
          tOps.images.add(a.image);
          return { ok: true as const };
        },
        pullImage: async () => {},
      },
      freeBytes: async () => 1e12,
    });
    expect((await target.handle(`${RESTORE_PATH}/start`, "POST", req("POST", `${RESTORE_PATH}/start`, { archiveId: id, bytes: data.length }), { companion: false }))!.status).toBe(202);
    expect((await target.handle(`${RESTORE_PATH}/chunk`, "POST", req("POST", `${RESTORE_PATH}/chunk?offset=0`, data), { companion: false }))!.status).toBe(200);
    const key = Buffer.from(opened.contentKey).toString("hex");
    expect((await target.handle(`${RESTORE_PATH}/commit`, "POST", req("POST", `${RESTORE_PATH}/commit`, { key }), { companion: false }))!.status).toBe(202);
    await target.settle();
    const view = JSON.parse(String((await target.handle(RESTORE_PATH, "GET", req("GET", RESTORE_PATH), { companion: false }))!.body));
    expect(view.restore).toMatchObject({ state: "done", apps: [{ serviceId: SERVICE, state: "done" }] });
    expect(dst.platform.byServiceId(SERVICE)).toBeDefined();
    expect(tOps.restoredDbs).toHaveLength(1);
  });

  it("runs on the schedule by itself, once per day, and keeps 7 daily + 4 weekly", async () => {
    const w = await world();
    await giveKeys(w, 60);
    for (let day = 0; day < 40; day++) {
      await w.svc.tick();
      await w.svc.settle();
      // A second look the same day starts nothing.
      await w.svc.tick();
      await w.svc.settle();
      w.clock.t += DAY;
    }
    const v = (await call(w.svc, "GET", SAVED_PATH)).json();
    expect(v.keysLeft).toBe(20);
    expect(v.lastRun).toMatchObject({ ok: true, trigger: "schedule" });
    expect(v.backups.length).toBeGreaterThanOrEqual(9);
    expect(v.backups.length).toBeLessThanOrEqual(11);
    const ages = v.backups.map((b: { createdAt: number }) => Math.round((w.clock.t - DAY - b.createdAt) / DAY));
    expect(ages.slice(0, 7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(Math.max(...ages)).toBeLessThan(35);
    const dirs = (await readdir(join(w.dir, "server-backups"))).filter((n) => /^[0-9a-f]{32}$/.test(n));
    expect(dirs).toHaveLength(v.backups.length);
    expect(v.nextRunAt).toBeGreaterThan(w.clock.t - DAY);
  });

  it("the owner changes the schedule; off stops it, and fewer kept drops the rest", async () => {
    const w = await world();
    await giveKeys(w, 10);
    for (let i = 0; i < 3; i++) {
      await runNow(w);
      w.clock.t += DAY;
    }
    expect((await call(w.svc, "PUT", `${SAVED_PATH}/schedule`, { frequency: "daily", minuteOfDayUtc: 60, keepDaily: 0, keepWeekly: 1 })).status).toBe(200);
    expect((await call(w.svc, "GET", SAVED_PATH)).json().backups).toHaveLength(1);
    const bad = await call(w.svc, "PUT", `${SAVED_PATH}/schedule`, { frequency: "hourly", minuteOfDayUtc: 60, keepDaily: 1, keepWeekly: 1 });
    expect(bad.status).toBe(400);
    expect(bad.json().error).toMatch(/daily, weekly or off/);
    await call(w.svc, "PUT", `${SAVED_PATH}/schedule`, { frequency: "off", minuteOfDayUtc: 60, keepDaily: 1, keepWeekly: 1 });
    const before = (await call(w.svc, "GET", SAVED_PATH)).json();
    expect(before.nextRunAt).toBeNull();
    w.clock.t += 3 * DAY;
    await w.svc.tick();
    await w.svc.settle();
    expect((await call(w.svc, "GET", SAVED_PATH)).json().keysLeft).toBe(before.keysLeft);
    expect(w.events.some((e) => e.kind === "server.backup.schedule" && /turned off/.test(e.detail))).toBe(true);
  });

  it("keeps its backups, schedule and keys across a restart", async () => {
    const w = await world();
    await giveKeys(w, 4);
    const id = await runNow(w);
    await call(w.svc, "PUT", `${SAVED_PATH}/schedule`, { frequency: "weekly", minuteOfDayUtc: 120, weekdayUtc: 3, keepDaily: 2, keepWeekly: 2 });
    const again = w.make();
    await again.init();
    const v = (await call(again, "GET", SAVED_PATH)).json();
    expect(v.backups.map((b: { archiveId: string }) => b.archiveId)).toEqual([id]);
    expect(v.schedule).toMatchObject({ frequency: "weekly", weekdayUtc: 3 });
    expect(v.keysLeft).toBe(3);
  });

  it("makes room by dropping the oldest saved backups, never the newest, then refuses with how much it needs", async () => {
    let freeNow = 100 * GB;
    const w = await world({ sized: 2 * GB, free: () => freeNow });
    await giveKeys(w, 5);
    const first = await runNow(w);
    w.clock.t += DAY;
    const second = await runNow(w);
    w.clock.t += DAY;
    // Short of space: the oldest goes, the newer one stays.
    const svc = w.make();
    await svc.init();
    freeNow = 3 * GB;
    const r = await call(svc, "POST", `${SAVED_PATH}/run`);
    expect(r.status).toBe(202);
    await svc.settle();
    const v = (await call(svc, "GET", SAVED_PATH)).json();
    expect(v.lastRun.ok).toBe(false);
    expect(v.lastRun.reason).toMatch(/needs about \d+\.\d GB free .* has 3\.0 GB/);
    expect(v.backups.map((b: { archiveId: string }) => b.archiveId)).toEqual([second]);
    expect(v.backups.map((b: { archiveId: string }) => b.archiveId)).not.toContain(first);
    expect(w.events.some((e) => e.kind === "server.backup.removed")).toBe(true);
    expect(w.events.some((e) => e.kind === "server.backup.failed" && !e.ok)).toBe(true);
    // A failed scheduled run is retried an hour later, not straight away.
    expect(v.nextRunAt).not.toBeNull();
  });

  it("keeps saved backups under their share of the disk", async () => {
    // Sized at 3 GB each on a 5 GB disk: half of it can't hold even one more,
    // so each new backup replaces all but the newest older one.
    const w = await world({ sized: 3 * GB, disk: 5 * GB });
    await giveKeys(w, 5);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(await runNow(w));
      w.clock.t += DAY;
    }
    const v = (await call(w.svc, "GET", SAVED_PATH)).json();
    expect(v.backups.map((b: { archiveId: string }) => b.archiveId)).toEqual([ids[3], ids[2]]);
  });

  it("deletes a saved backup, and serves it to a browser only with the owner's approval", async () => {
    const w = await world();
    await giveKeys(w, 2);
    const id = await runNow(w);
    const link = (await call(w.svc, "POST", `${SAVED_PATH}/${id}/link`)).json();
    expect(link).toMatchObject({ expiresAt: null, dataFileName: expect.stringMatching(/\.flagship-data$/) });
    const R = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
    const get = async (path: string) => (await w.svc.handleDownload({ method: "GET", path, headers: {}, body: Buffer.alloc(0) }))!;
    expect((await get(`${link.path}/bundle?r=${R}`)).status).toBe(403);
    const approval = { serverDomain: SRC, archiveId: id, requestId: R, issuedAt: w.clock.t };
    const signature = Buffer.from(signArchiveDownloadApproval(approval, owner)).toString("hex");
    expect((await call(w.svc, "POST", "/api/screens/server-archive/approve", { approval, signature })).status).toBe(200);
    const one = await get(`${link.path}/bundle?r=${R}`);
    expect(one.status).toBe(200);
    expect(one.headers!["content-disposition"]).toContain(link.bundleFileName);
    expect(link.bundleFileName).toBe("home-2026-10-14-1200.flagship");
    const parts: Buffer[] = [];
    for await (const c of one.stream!.open() as AsyncIterable<Buffer>) parts.push(c);
    const whole = Buffer.concat(parts);
    expect(createHash("sha256").update(whole).digest("hex")).toBe(link.bundleSha256);
    // The saved list carries the same one file's name, size and checksum.
    const listed = (await call(w.svc, "GET", SAVED_PATH)).json().backups[0];
    expect(listed).toMatchObject({ bundleFileName: link.bundleFileName, bundleBytes: whole.length, bundleSha256: link.bundleSha256 });
    // The phones' 4 MiB pieces of the same file.
    const piece = await call(w.svc, "GET", `${SAVED_PATH}/${id}/bundle?offset=0`);
    expect(Buffer.from(piece.body as Buffer)).toEqual(whole);
    const del = await call(w.svc, "DELETE", `${SAVED_PATH}/${id}`);
    expect(del.status).toBe(200);
    expect(del.json().backups).toEqual([]);
    expect((await get(`${link.path}/bundle?r=${R}`)).status).toBe(404);
    expect((await call(w.svc, "DELETE", `${SAVED_PATH}/${id}`)).status).toBe(404);
  });

  it("the schedule runs only while the backup policy is phone-side; Back up now always works", async () => {
    let phone = false;
    const w = await world({ scheduleActive: () => phone });
    await giveKeys(w, 3);
    await w.svc.tick();
    await w.svc.settle();
    let v = (await call(w.svc, "GET", SAVED_PATH)).json();
    expect(v).toMatchObject({ scheduleActive: false, nextRunAt: null, backups: [] });
    await runNow(w);
    phone = true;
    w.clock.t += 24 * 60 * 60_000;
    await w.svc.tick();
    await w.svc.settle();
    v = (await call(w.svc, "GET", SAVED_PATH)).json();
    expect(v.scheduleActive).toBe(true);
    expect(v.backups.map((b: { trigger: string }) => b.trigger)).toEqual(["schedule", "now"]);
  });

  it("tells the peer engine about each saved backup, and never drops one it pins", async () => {
    const w = await world();
    await giveKeys(w, 10);
    const saved: Array<{ id: string; dataPath: string }> = [];
    let pin = new Set<string>();
    w.svc.setSavedHooks({ onArchiveSaved: (m, f) => void saved.push({ id: m.archiveId, dataPath: f.dataPath }), pinnedArchiveIds: () => pin });
    const first = await runNow(w);
    expect(saved).toEqual([{ id: first, dataPath: join(w.dir, "server-backups", first, "data.flagship-data") }]);
    pin = new Set([first]);
    await call(w.svc, "PUT", `${SAVED_PATH}/schedule`, { frequency: "daily", minuteOfDayUtc: 180, keepDaily: 1, keepWeekly: 0 });
    for (let i = 0; i < 3; i++) {
      w.clock.t += DAY;
      await runNow(w);
    }
    const ids = (await call(w.svc, "GET", SAVED_PATH)).json().backups.map((b: { archiveId: string }) => b.archiveId);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(first);
    const del = await call(w.svc, "DELETE", `${SAVED_PATH}/${first}`);
    expect(del.status).toBe(409);
    expect(del.json().error).toMatch(/kept on other servers/);
  });

  it("an import past the backup policy's limit is refused before any upload", async () => {
    const svc = buildServerArchiveService({
      dir: join(mkdtempSync(join(tmpdir(), "cap-import-")), "a"),
      wait: {
        load: async () => {},
        current: () => ({ order: { serverDomain: DST, archiveId: "00".repeat(16), bytes: 9 * GB, sha256: "00".repeat(32), issuedAt: 1 }, signatureHex: "" }) as never,
        adoptFromPairingJson: async () => false,
        setRestoring: () => {},
        finish: async () => {},
        heartbeatView: () => null,
        adoptOrder: async () => null,
        restoredAny: () => false,
      },
      build: { serverFqdn: DST, apps: () => [], containerName: () => "", ops: fakeOps().ops, envStore: null, access: null, accessList: null },
      restore: { serverFqdn: DST, platform: platformFor(dstBox, "t".repeat(40)).platform, dataProvisioner: null, ops: fakeOps().ops, signInstall: (r) => dstBox.signInstallService(r), envStore: null, access: null, egress: null, buildImage: async () => ({ ok: true as const }), pullImage: async () => {} },
      freeBytes: async () => 1e12,
      admitIncoming: (bytes) => (bytes > 5 * GB ? "That needs about 9.0 GB and this server has 5.0 GB left under its backup limit" : null),
    });
    const r = await svc.handle(`${RESTORE_PATH}/start`, "POST", req("POST", `${RESTORE_PATH}/start`, { archiveId: "00".repeat(16), bytes: 9 * GB }), { companion: false });
    expect(r!.status).toBe(507);
    expect(JSON.parse(String(r!.body))).toMatchObject({ code: "over-backup-limit", error: expect.stringMatching(/backup limit/) });
  });

  it("a server over its backup limit refuses a new app with the limit's sentence", async () => {
    const { platform } = platformFor(dstBox, "u".repeat(40));
    platform.setAdmitNewApp(() => "This server holds 6.0 GB of app data, over its backup limit of 5.0 GB");
    const request = { serverId: DST, creator: "harry", slug: "notes", manifestJson: JSON.stringify(MANIFEST), addOwnerToMembership: true, issuedAt: Date.now() };
    const r = await platform.install({ request, signature: signInstallService(request, owner), verify: verifyInstallService });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/over its backup limit/) });
    platform.setAdmitNewApp(() => null);
    const again = { ...request, issuedAt: Date.now() + 1 };
    expect((await platform.install({ request: again, signature: signInstallService(again, owner), verify: verifyInstallService })).ok).toBe(true);
  });

  it("serves a multi-GB one file from disk, piece by piece, past 4 GB offsets, without holding it", async () => {
    const w = await world();
    const id = "ab".repeat(16);
    const dir = join(w.dir, "server-backups", id);
    await mkdir(dir, { recursive: true });
    const backupText = Buffer.from('{"magic":"flagship-backup","v":2}');
    await writeFile(join(dir, "backup.flagship-backup"), backupText);
    const DATA = 5 * GB + 123;
    const fh = await open(join(dir, "data.flagship-data"), "w");
    await fh.truncate(DATA);
    await fh.write(Buffer.from("TAIL"), 0, 4, DATA - 4);
    await fh.close();
    const total = 16 + backupText.length + DATA;
    await writeFile(
      join(dir, "meta.json"),
      JSON.stringify({ archiveId: id, createdAt: w.clock.t, trigger: "now", bytes: DATA, sha256: "00".repeat(32), backupBytes: backupText.length, backupFileName: "big.flagship-backup", dataFileName: "big.flagship-data", bundleFileName: "big.flagship", bundleBytes: total, bundleSha256: "11".repeat(32), apps: [], left: [] }),
    );
    const head = await call(w.svc, "GET", `${SAVED_PATH}/${id}/bundle?offset=0`);
    expect(head.headers["x-flagship-bundle-bytes"]).toBe(String(total));
    expect((head.body as Buffer).subarray(0, 8).toString()).toBe("FLGSHBK1");
    expect((head.body as Buffer).length).toBe(4 * 1024 * 1024);
    const before = process.memoryUsage().rss;
    const tail = await call(w.svc, "GET", `${SAVED_PATH}/${id}/bundle?offset=${total - 1000}`);
    expect((tail.body as Buffer).length).toBe(1000);
    expect((tail.body as Buffer).subarray(996).toString()).toBe("TAIL");
    expect(process.memoryUsage().rss - before).toBeLessThan(256 * 1024 * 1024);
  });

  it("companion sessions can't see or change saved backups", async () => {
    const w = await world();
    const r = await w.svc.handle(SAVED_PATH, "GET", req("GET", SAVED_PATH), { companion: true });
    expect(r!.status).toBe(403);
  });
});

// ───────────────────────────── Migrate on the archive path ─────────────────────────────

/** A fetch that reaches `svc`'s public download/probe routes, as the new box reaches the old one. */
function fetchVia(svc: Svc): typeof fetch {
  return (async (input: string | URL, init?: { headers?: Record<string, string> }) => {
    const u = new URL(String(input));
    const r = (await svc.handleDownload({ method: "GET", path: `${u.pathname}${u.search}`, headers: init?.headers ?? {}, body: Buffer.alloc(0) }))!;
    const body = r.stream ? (Readable.toWeb(Readable.from(r.stream.open() as AsyncIterable<Buffer>)) as unknown as ReadableStream) : Buffer.from(r.body as string | Buffer);
    return new Response(body as BodyInit, { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
}

function pauseFor(dir: string, calls: string[][], containers = ["flagship-harry--notes"]) {
  return buildMigratePause({ path: join(dir, "migrate-pause.json"), containers: () => containers, run: async (a) => void calls.push(a) });
}

describe("Migrate on the archive path", () => {
  it("pauses the old server's apps, backs it up, and the new one pulls, restores and is done", async () => {
    const calls: string[][] = [];
    const dirP = mkdtempSync(join(tmpdir(), "migrate-pause-"));
    const pause = pauseFor(dirP, calls);
    await pause.load();
    const w = await world({ migrate: { pause } });
    await giveKeys(w, 3);
    // 1. The old server: pause + the backup for the move.
    const run = await call(w.svc, "POST", `${SAVED_PATH}/run`, { purpose: "migrate" });
    expect(run.status).toBe(202);
    await w.svc.settle();
    const id = run.json().archiveId as string;
    expect(calls).toEqual([["pause", "flagship-harry--notes"]]);
    const v = (await call(w.svc, "GET", SAVED_PATH)).json();
    expect(v.migratePause).toMatchObject({ archiveId: id, containers: ["flagship-harry--notes"] });
    expect(movingPage().status).toBe(503);
    expect(String(movingPage().body)).toContain("This app is moving to a new server");
    // The move's backup is pinned: a keep-1 schedule doesn't drop it, nor Delete.
    expect((await call(w.svc, "DELETE", `${SAVED_PATH}/${id}`)).status).toBe(409);
    // 2. The phone opens the backup file with the account key.
    const b = v.backups[0];
    const opened = openBackupWithAccountKey(parseBackupFile(String((await call(w.svc, "GET", `${SAVED_PATH}/${id}/backup-file`)).body)), deriveServerArchiveKey(UMK, id))!;
    // 3. The new server: a late restore order, then a box-to-box pull from an approved link.
    const dst = platformFor(dstBox, "t".repeat(40));
    const tOps = fakeOps();
    const wait = buildRestoreWait({ path: join(w.dir, "wait.json"), donePath: join(w.dir, "done.json"), serverDomain: DST, ownerIrkPub: owner.publicKey, username: "harry" });
    await wait.load();
    const target = buildServerArchiveService({
      dir: join(w.dir, "dst-archives"),
      uploadDir: join(w.dir, "dst-upload"),
      wait,
      build: { serverFqdn: DST, apps: () => dst.platform.list(), containerName: () => "", ops: tOps.ops, envStore: null, access: null, accessList: null },
      restore: {
        serverFqdn: DST,
        platform: dst.platform,
        dataProvisioner: dst.provisioner,
        ops: tOps.ops,
        signInstall: (r) => dstBox.signInstallService(r),
        envStore: new InMemoryAppEnvStore(),
        access: null,
        egress: null,
        sourceDir: join(w.dir, "dst-clones"),
        buildImage: async (a) => {
          await writeSourceTree(a.contextDir, a.files, { binaries: a.binaries });
          tOps.images.add(a.image);
          return { ok: true as const };
        },
        pullImage: async () => {},
      },
      freeBytes: async () => 1e12,
      fetchImpl: fetchVia(w.svc),
    });
    const tcall = async (method: string, path: string, body?: unknown) => {
      const r = await target.handle(path.split("?")[0]!, method, req(method, path, body), { companion: false });
      return { status: r!.status, json: () => JSON.parse(String(r!.body)) as Record<string, any> };
    };
    const order = { serverDomain: DST, archiveId: id, bytes: b.bytes, sha256: b.sha256, issuedAt: Date.now() };
    const bad = await tcall("POST", `${RESTORE_PATH}/order`, { order, signatureHex: Buffer.from(signServerRestoreOrder(order, stranger)).toString("hex") });
    expect(bad.status).toBe(403);
    const ok = await tcall("POST", `${RESTORE_PATH}/order`, { order, signatureHex: Buffer.from(signServerRestoreOrder(order, owner)).toString("hex") });
    expect(ok.status).toBe(200);
    expect(ok.json().waiting).toMatchObject({ archiveId: id, bytes: b.bytes });
    // The speed check: the new server times a probe link of the old one.
    const probeLink = (await call(w.svc, "POST", "/api/screens/server-archive/probe-link")).json();
    const sp = await tcall("POST", `${RESTORE_PATH}/probe`, { url: `https://${SRC}${probeLink.path}` });
    expect(sp.status).toBe(200);
    expect(sp.json()).toMatchObject({ bytes: 8 * 1024 * 1024, bytesPerSecond: expect.any(Number) });
    // An approved link on the old server, pulled by the new one.
    const link = (await call(w.svc, "POST", `${SAVED_PATH}/${id}/link`)).json();
    const requestId = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
    const approval = { serverDomain: SRC, archiveId: id, requestId, issuedAt: w.clock.t };
    expect((await call(w.svc, "POST", "/api/screens/server-archive/approve", { approval, signature: Buffer.from(signArchiveDownloadApproval(approval, owner)).toString("hex") })).status).toBe(200);
    const pulled = await tcall("POST", `${RESTORE_PATH}/pull`, { url: `https://${SRC}${link.path}`, requestId });
    expect(pulled.status).toBe(202);
    await expect.poll(async () => (await tcall("GET", RESTORE_PATH)).json().restore.state, { timeout: 10_000 }).toBe("ready");
    expect((await tcall("GET", RESTORE_PATH)).json().restore).toMatchObject({ received: b.bytes, pulling: false });
    // 4. The phone commits the content key: the apps are restored, the server stops waiting.
    expect((await tcall("POST", `${RESTORE_PATH}/commit`, { key: Buffer.from(opened.contentKey).toString("hex") })).status).toBe(202);
    await target.settle();
    expect((await tcall("GET", RESTORE_PATH)).json()).toMatchObject({ waiting: null, restore: { state: "done", apps: [{ serviceId: SERVICE, state: "done" }] } });
    expect(wait.restoredAny()).toBe(true);
    expect(dst.platform.byServiceId(SERVICE)).toBeDefined();
    // A second whole-server backup is refused now that the new server has apps.
    const again = await tcall("POST", `${RESTORE_PATH}/order`, { order: { ...order, archiveId: "99".repeat(16) }, signatureHex: Buffer.from(signServerRestoreOrder({ ...order, archiveId: "99".repeat(16) }, owner)).toString("hex") });
    expect(again.status).toBe(409);
    expect(again.json().code).toBe("has-apps");
  });

  it("an aborted move resumes the old server's apps; a failed backup for the move resumes them too", async () => {
    const calls: string[][] = [];
    const pause = pauseFor(mkdtempSync(join(tmpdir(), "migrate-pause-")), calls);
    await pause.load();
    const w = await world({ migrate: { pause } });
    await giveKeys(w, 3);
    await call(w.svc, "POST", `${SAVED_PATH}/run`, { purpose: "migrate" });
    await w.svc.settle();
    const resumed = await call(w.svc, "POST", `${SAVED_PATH}/resume`);
    expect(resumed.json().migratePause).toBeNull();
    expect(calls).toEqual([["pause", "flagship-harry--notes"], ["unpause", "flagship-harry--notes"]]);
    // A pause outlives a daemon restart (the marker), and lifts after a day without a freeze.
    const calls2: string[][] = [];
    const dir2 = mkdtempSync(join(tmpdir(), "migrate-pause-"));
    let t = 1_000;
    const p2 = buildMigratePause({ path: join(dir2, "m.json"), containers: () => ["c1"], run: async (a) => void calls2.push(a), now: () => t });
    await p2.pause();
    const p3 = buildMigratePause({ path: join(dir2, "m.json"), containers: () => ["c1"], run: async (a) => void calls2.push(a), now: () => t });
    await p3.load();
    expect(p3.paused()).toBe(true);
    t += 25 * 60 * 60_000;
    await p3.sweep();
    expect(p3.paused()).toBe(false);
    expect(calls2).toEqual([["pause", "c1"], ["unpause", "c1"]]);
    // The backup for a move fails (too little room): the apps run again.
    const calls3: string[][] = [];
    const p4 = pauseFor(mkdtempSync(join(tmpdir(), "migrate-pause-")), calls3);
    const w2 = await world({ migrate: { pause: p4 }, sized: 50 * GB, free: () => GB });
    await giveKeys(w2, 2);
    await call(w2.svc, "POST", `${SAVED_PATH}/run`, { purpose: "migrate" });
    await w2.svc.settle();
    expect(p4.paused()).toBe(false);
    expect(calls3.map((c) => c[0])).toEqual(["pause", "unpause"]);
    expect((await call(w2.svc, "GET", SAVED_PATH)).json().lastRun.reason).toMatch(/needs about/);
  });
});

describe("restore from peer backups", () => {
  it("a waiting server takes its backup from the peer engine, then restores it like an upload", async () => {
    const w = await world();
    await giveKeys(w, 1);
    const id = await runNow(w);
    const b = (await call(w.svc, "GET", SAVED_PATH)).json().backups[0];
    const data = await readFile(join(w.dir, "server-backups", id, "data.flagship-data"));
    const opened = openBackupWithAccountKey(parseBackupFile(String((await call(w.svc, "GET", `${SAVED_PATH}/${id}/backup-file`)).body)), deriveServerArchiveKey(UMK, id))!;
    const dst = platformFor(dstBox, "t".repeat(40));
    const tOps = fakeOps();
    const wait = buildRestoreWait({ path: join(w.dir, "pw.json"), donePath: join(w.dir, "pd.json"), serverDomain: DST, ownerIrkPub: owner.publicKey, username: "harry" });
    await wait.load();
    const target = buildServerArchiveService({
      dir: join(w.dir, "p-archives"),
      uploadDir: join(w.dir, "p-upload"),
      wait,
      build: { serverFqdn: DST, apps: () => dst.platform.list(), containerName: () => "", ops: tOps.ops, envStore: null, access: null, accessList: null },
      restore: {
        serverFqdn: DST,
        platform: dst.platform,
        dataProvisioner: dst.provisioner,
        ops: tOps.ops,
        signInstall: (r) => dstBox.signInstallService(r),
        envStore: new InMemoryAppEnvStore(),
        access: null,
        egress: null,
        sourceDir: join(w.dir, "p-clones"),
        buildImage: async (a) => {
          await writeSourceTree(a.contextDir, a.files, { binaries: a.binaries });
          tOps.images.add(a.image);
          return { ok: true as const };
        },
        pullImage: async () => {},
      },
      freeBytes: async () => 1e12,
    });
    const tcall = async (method: string, path: string, body?: unknown) => {
      const r = await target.handle(path.split("?")[0]!, method, req(method, path, body), { companion: false });
      return { status: r!.status, json: () => JSON.parse(String(r!.body)) as Record<string, any> };
    };
    const body = { serverId: SRC, pbkHex: "ee".repeat(32) };
    expect((await tcall("POST", `${RESTORE_PATH}/from-peers`, body)).status).toBe(404);
    const asked: Array<{ serverId: string; archiveId: string; bytes: number; sha256: string }> = [];
    target.setPeerFetcher(async (a) => {
      asked.push({ serverId: a.serverId, archiveId: a.archiveId, bytes: a.bytes, sha256: a.sha256 });
      expect(Buffer.from(a.pbk).toString("hex")).toBe("ee".repeat(32));
      const out = join(w.dir, "from-peers.bin");
      await writeFile(out, data);
      a.onProgress?.(data.length);
      return { dataPath: out };
    });
    expect((await tcall("POST", `${RESTORE_PATH}/from-peers`, body)).json().code).toBe("not-waiting");
    const order = { serverDomain: DST, archiveId: id, bytes: b.bytes, sha256: b.sha256, issuedAt: Date.now() };
    expect((await tcall("POST", `${RESTORE_PATH}/order`, { order, signatureHex: Buffer.from(signServerRestoreOrder(order, owner)).toString("hex") })).status).toBe(200);
    expect((await tcall("POST", `${RESTORE_PATH}/from-peers`, body)).status).toBe(202);
    await expect.poll(async () => (await tcall("GET", RESTORE_PATH)).json().restore.state).toBe("ready");
    expect(asked).toEqual([{ serverId: SRC, archiveId: id, bytes: b.bytes, sha256: b.sha256 }]);
    expect((await tcall("POST", `${RESTORE_PATH}/commit`, { key: Buffer.from(opened.contentKey).toString("hex") })).status).toBe(202);
    await target.settle();
    expect((await tcall("GET", RESTORE_PATH)).json().restore).toMatchObject({ state: "done", apps: [{ serviceId: SERVICE, state: "done" }] });
  });
});
