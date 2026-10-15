/**
 * Backup/clone server end to end on fake docker: make a backup on one server,
 * download it in chunks, upload it to a DIFFERENT server (a different name),
 * and import it. Plus the refusals: wrong key, a damaged upload, an app that
 * is already there, a companion session.
 */
import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveIRK, deriveServerArchiveKey, signInstallService, verifyInstallService } from "@flagship/protocol";
import { AppCopyOps } from "../../src/appCopy/ops.js";
import { DataProvisioner, InMemoryFilesAdmin, InMemoryPostgresAdmin } from "../../src/dataLayer/index.js";
import { ServicePlatform } from "../../src/servicePlatform.js";
import { AppRunner, type CommandRunner } from "../../src/serviceRunner.js";
import { InMemoryAppEnvStore } from "../../src/serviceEnvStore.js";
import { buildServerArchiveService, ARCHIVE_PATH, RESTORE_PATH } from "../../src/serverArchive/service.js";
import type { HttpRequest } from "../../src/runtime.js";
import { swkOps, testCustodian } from "../helpers/keyCustody.js";

const owner = deriveIRK({ seed: new Uint8Array(32).fill(42) });
const srcBox = testCustodian({ identityPriv: new Uint8Array(32).fill(3), swk: new Uint8Array(32).fill(4), cgk: new Uint8Array(32).fill(5) });
const dstBox = testCustodian({ identityPriv: new Uint8Array(32).fill(6), swk: new Uint8Array(32).fill(8), cgk: new Uint8Array(32).fill(5) });
const SRC = "home.harry.flagship.services";
const DST = "clone.harry.flagship.services";
const SERVICE = "harry--notes";
const UMK = { seed: new Uint8Array(32).fill(9) };
const ARCHIVE_ID = "00112233445566778899aabbccddeeff";

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
    saveImage: async (image, out) => writeFile(out, `image:${image}`),
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
  const sourceService = buildServerArchiveService({
    dir: join(dir, "src-archives"),
    build: {
      serverFqdn: SRC,
      apps: () => [src.platform.byServiceId(SERVICE)!],
      containerName: (id) => `flagship-${id}`,
      ops: sOps.ops,
      envStore: srcEnv,
      access: null,
      accessList: null,
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
    },
    note: (k) => void events.push(k),
    freeBytes: async () => 1e12,
  });
  const targetService = buildServerArchiveService({
    dir: join(dir, "dst-archives"),
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
    },
    note: (k) => void events.push(k),
    freeBytes: async () => 1e12,
  });
  return { dir, src, dst, srcEnv, dstEnv, sOps, tOps, sourceService, targetService, events };
}
type World = Awaited<ReturnType<typeof world>>;

const keyHex = () => Buffer.from(deriveServerArchiveKey(UMK, ARCHIVE_ID)).toString("hex");

async function call(svc: World["sourceService"], method: string, path: string, body?: unknown | Buffer, companion = false) {
  const r = await svc.handle(path.split("?")[0]!, method, req(method, path, body), { companion });
  return { status: r!.status, headers: r!.headers ?? {}, body: r!.body };
}
const asJson = (r: { body: string | Buffer }) => JSON.parse(String(r.body)) as Record<string, any>;

async function backUp(w: World): Promise<Buffer> {
  const start = await call(w.sourceService, "POST", `${ARCHIVE_PATH}/start`, { archiveId: ARCHIVE_ID, key: keyHex() });
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

async function upload(svc: World["targetService"], file: Buffer, chunk = 600) {
  expect((await call(svc, "POST", `${RESTORE_PATH}/start`, { archiveId: ARCHIVE_ID, bytes: file.length })).status).toBe(202);
  for (let offset = 0; offset < file.length; offset += chunk) {
    const r = await call(svc, "POST", `${RESTORE_PATH}/chunk?offset=${offset}`, file.subarray(offset, offset + chunk));
    expect(r.status).toBe(200);
  }
}

describe("Backup/clone server", () => {
  it("backs a server up, downloads it, and imports it onto a server with a different name", async () => {
    const w = await world();
    const file = await backUp(w);
    expect(w.events).toEqual(["server.backup.started", "server.backup.created", "server.backup.downloaded"]);

    await upload(w.targetService, file);
    expect((await call(w.targetService, "POST", `${RESTORE_PATH}/commit`, { key: keyHex() })).status).toBe(202);
    await w.targetService.settle();

    const status = asJson(await call(w.targetService, "GET", RESTORE_PATH)).restore;
    expect(status).toMatchObject({ state: "done", apps: [{ serviceId: SERVICE, name: "notes", state: "done" }] });
    const app = w.dst.platform.byServiceId(SERVICE);
    expect(app).toBeDefined();
    expect(w.tOps.images.has("flagship-vibe-harry--notes:1")).toBe(true);
    expect(w.tOps.restoredDbs.length).toBe(1);
    expect(w.tOps.restoredFiles.length).toBe(1);
    expect(await w.dstEnv.get(SERVICE)).toEqual({ OPENAI_KEY: "sk-secret", MODE: "prod" });
    expect(w.events).toContain("server.restore.finished");
  });

  it("the archive file holds none of the plain content", async () => {
    const w = await world();
    const file = await backUp(w);
    const text = file.toString("latin1");
    expect(text).not.toContain("sk-secret");
    expect(text).not.toContain("rows-of-");
    expect(text).not.toContain("flagship-vibe-harry--notes");
    // ...but the header is readable: the importer needs the id and shows the names.
    expect(text.split("\n")[0]).toContain(ARCHIVE_ID);
  });

  it("a wrong key fails the import and installs nothing", async () => {
    const w = await world();
    const file = await backUp(w);
    await upload(w.targetService, file);
    const wrong = Buffer.from(deriveServerArchiveKey({ seed: new Uint8Array(32).fill(1) }, ARCHIVE_ID)).toString("hex");
    await call(w.targetService, "POST", `${RESTORE_PATH}/commit`, { key: wrong });
    await w.targetService.settle();
    const status = asJson(await call(w.targetService, "GET", RESTORE_PATH)).restore;
    expect(status.state).toBe("failed");
    expect(status.reason).toMatch(/wrong key|changed or cut short/);
    expect(w.dst.platform.byServiceId(SERVICE)).toBeUndefined();
  });

  it("a damaged upload fails and installs nothing", async () => {
    const w = await world();
    const file = await backUp(w);
    file[file.length - 30] ^= 1;
    await upload(w.targetService, file);
    await call(w.targetService, "POST", `${RESTORE_PATH}/commit`, { key: keyHex() });
    await w.targetService.settle();
    expect(asJson(await call(w.targetService, "GET", RESTORE_PATH)).restore.state).toBe("failed");
    expect(w.dst.platform.byServiceId(SERVICE)).toBeUndefined();
  });

  it("an app that is already on the server is skipped, not overwritten", async () => {
    const w = await world();
    const file = await backUp(w);
    await upload(w.sourceService, file);
    await call(w.sourceService, "POST", `${RESTORE_PATH}/commit`, { key: keyHex() });
    await w.sourceService.settle();
    const status = asJson(await call(w.sourceService, "GET", RESTORE_PATH)).restore;
    expect(status.state).toBe("done");
    expect(status.apps[0]).toMatchObject({ state: "skipped", reason: "already on this server" });
  });

  it("refuses out-of-order chunks, a second job at once, and companion sessions", async () => {
    const w = await world();
    const file = await backUp(w);
    expect((await call(w.targetService, "POST", `${RESTORE_PATH}/start`, { archiveId: ARCHIVE_ID, bytes: file.length })).status).toBe(202);
    const r = await call(w.targetService, "POST", `${RESTORE_PATH}/chunk?offset=100`, file.subarray(0, 50));
    expect(r.status).toBe(409);
    expect((await call(w.targetService, "GET", ARCHIVE_PATH, undefined, true)).status).toBe(403);
    expect((await call(w.sourceService, "POST", `${ARCHIVE_PATH}/start`, { archiveId: "zz", key: "00" })).status).toBe(400);
  });

  it("refuses an import when the disk is too full", async () => {
    const w = await world();
    const file = await backUp(w);
    const full = buildServerArchiveService({
      dir: join(w.dir, "full"),
      build: { serverFqdn: DST, apps: () => [], containerName: () => "", ops: w.tOps.ops, envStore: null, access: null, accessList: null },
      restore: { serverFqdn: DST, platform: w.dst.platform, dataProvisioner: null, ops: w.tOps.ops, signInstall: (r) => dstBox.signInstallService(r), envStore: null, access: null, egress: null },
      freeBytes: async () => 10,
    });
    const r = await call(full, "POST", `${RESTORE_PATH}/start`, { archiveId: ARCHIVE_ID, bytes: file.length });
    expect(r.status).toBe(507);
  });
});
