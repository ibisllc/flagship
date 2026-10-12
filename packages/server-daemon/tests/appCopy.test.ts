/**
 * Copying an app between two of the owner's servers (appCopy/,
 * docs/app-placement.md §5): the owner's order on the target, the target's
 * signed fetches against the source's export endpoint, the install with the
 * data restored before first start, and that a failure or a restart leaves
 * nothing behind.
 */
import { mkdtempSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveIRK,
  ed,
  signAppCopyGrant,
  signInstallService,
  verifyInstallService,
  type AppCopyGrant,
  type Bytes,
} from "@flagship/protocol";
import { buildAppCopySource } from "../src/appCopy/source.js";
import { AppCopyStore, INTERRUPTED_REASON } from "../src/appCopy/store.js";
import { buildAppCopyTarget, COPIES_PATH, COPY_PATH } from "../src/appCopy/target.js";
import type { AppCopyOps } from "../src/appCopy/ops.js";
import { APP_COPY_EXPORT_PATH, copyEnvKeyFromCgk, fetchEnvelopeBytes } from "../src/appCopy/wire.js";
import { DbWriteLedger } from "../src/dataLayer/ownerDb.js";
import { DataProvisioner, InMemoryFilesAdmin, InMemoryPostgresAdmin } from "../src/dataLayer/index.js";
import { AppAccessStore } from "../src/egress/accessStore.js";
import { ServicePlatform } from "../src/servicePlatform.js";
import { AppRunner, type CommandRunner } from "../src/serviceRunner.js";
import { InMemoryAppEnvStore } from "../src/serviceEnvStore.js";
import { ServiceAccessStore } from "../src/serviceAccess.js";
import { buildScreensHttp } from "../src/screens/screensHttp.js";
import type { HttpRequest } from "../src/runtime.js";
import { readServiceSource, writeSourceTree } from "../src/llm/serviceSource.js";
import { swkOps, testCustodian } from "./helpers/keyCustody.js";

const SRC = "home3.harry.flagship.services";
const DST = "leticia.harry.flagship.services";
const SERVICE = "harry--notes";
const owner = deriveIRK({ seed: new Uint8Array(32).fill(42) });
const adminRoot = deriveIRK({ seed: new Uint8Array(32).fill(7) });
const stranger = deriveIRK({ seed: new Uint8Array(32).fill(9) });
const srcBox = testCustodian({ identityPriv: new Uint8Array(32).fill(3), swk: new Uint8Array(32).fill(4), cgk: new Uint8Array(32).fill(5) });
const dstBox = testCustodian({ identityPriv: new Uint8Array(32).fill(6), swk: new Uint8Array(32).fill(8), cgk: new Uint8Array(32).fill(5) });
const otherBox = testCustodian({ identityPriv: new Uint8Array(32).fill(11) });
const AID = "ab".repeat(32);

const MANIFEST = {
  schema_version: 1,
  name: "notes",
  version: "0.1.0",
  runtime: { image: "flagship-vibe-harry--notes:1", port: 8080 },
  data: { stores: { postgres: true, files: true } },
  network: { subdomain: "notes", egress: ["api.example.com"] },
  access: { enabled: true, default_role: "viewer" },
  migration: { portable: true, verification: "standard" },
};

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const req = (method: string, path: string, body?: unknown): HttpRequest => ({
  method,
  path,
  headers: {},
  body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)),
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Docker and Postgres as files with recognizable contents. */
function fakeOps(over: Partial<AppCopyOps> = {}) {
  const images = new Set<string>();
  const removed: string[] = [];
  const restoredDbs: Array<{ database: string; role: string; content: string }> = [];
  const restoredFiles: Array<{ volume: string; content: string }> = [];
  const paused: string[] = [];
  let gate: Promise<void> | null = null;
  const ops: AppCopyOps = {
    saveImage: async (image, out) => {
      if (gate) await gate;
      await writeFile(out, `image:${image}`);
    },
    loadImage: async (p) => {
      const c = await readFile(p, "utf8");
      images.add(c.slice("image:".length));
    },
    imageExists: async (i) => images.has(i),
    removeImage: async (i) => {
      images.delete(i);
      removed.push(i);
    },
    dumpDatabase: async (s, out) => writeFile(out, `rows-of-${s.database}`),
    restoreDatabase: async (s, p) => {
      restoredDbs.push({ database: s.database, role: s.role, content: await readFile(p, "utf8") });
    },
    archiveFiles: async (v, c, out) => {
      paused.push(c);
      await writeFile(out, `files-of-${v}`);
    },
    restoreFiles: async (v, p) => {
      restoredFiles.push({ volume: v, content: await readFile(p, "utf8") });
    },
    ...over,
  };
  return { ops, images, removed, restoredDbs, restoredFiles, paused, hold: (p: Promise<void>) => (gate = p) };
}

function platformFor(box: typeof srcBox, nameKey: string, startOk = true) {
  const pg = new InMemoryPostgresAdmin();
  const files = new InMemoryFilesAdmin();
  const provisioner = new DataProvisioner({ postgres: pg, files, nameKey });
  const calls: string[] = [];
  const cmd: CommandRunner = {
    run: async (c, args) => {
      calls.push(`${c} ${args.join(" ")}`);
    },
    capture: async () => ({ stdout: "", stderr: "" }),
  };
  const platform = new ServicePlatform({
    host: { username: "harry", irkPub: owner.publicKey },
    hostIdentityPub: box.boxPublicKey(),
    swk: swkOps(new Uint8Array(32).fill(1)),
    appRunner: new AppRunner(cmd),
    dataProvisioner: provisioner,
    startCheck: async () => (startOk ? { ok: true } : { ok: false, reason: "the app never answered" }),
  });
  return { platform, provisioner, pg, files, calls };
}

interface WorldOpts {
  adminRootPub?: Uint8Array;
  targetCgk?: Uint8Array | null;
  sourceOps?: Partial<AppCopyOps>;
  targetOps?: Partial<AppCopyOps>;
  targetStartOk?: boolean;
  now?: () => number;
}

async function world(o: WorldOpts = {}) {
  const now = o.now ?? (() => Date.now());
  const dir = mkdtempSync(join(tmpdir(), "app-copy-"));
  const authority = { ownerIrkPub: owner.publicKey, username: "harry", ...(o.adminRootPub ? { adminRootPub: o.adminRootPub } : {}) };

  // ── source: the app, its data, members, env, signed list and an API key ──
  const src = platformFor(srcBox, "s".repeat(40));
  const request = {
    serverId: SRC,
    creator: "harry",
    slug: "notes",
    manifestJson: JSON.stringify(MANIFEST),
    addOwnerToMembership: true,
    issuedAt: Date.now(),
  };
  const installed = await src.platform.install({ request, signature: signInstallService(request, owner), verify: verifyInstallService });
  if (!installed.ok) throw new Error(installed.reason);
  src.platform.addHostAsOwner({ serviceId: SERVICE, hostIrk: owner });
  const srcEnv = new InMemoryAppEnvStore();
  await srcEnv.put(SERVICE, { OPENAI_KEY: "sk-secret", MODE: "prod" });
  const srcAccess = new ServiceAccessStore(join(dir, "src-access.json"));
  await srcAccess.setMode(SERVICE, "restricted");
  await srcAccess.addAllowed(SERVICE, AID, "invite1");
  const srcLists = new AppAccessStore(null, null);
  const srcList = "allow api.example.com\nallow cdn.example.org\ndeny all\n";
  await srcLists.putSigned(SERVICE, srcList, {
    v: 2,
    grant: { serverDomain: SRC, serviceId: SERVICE, listSha256: "0".repeat(64), issuedAt: 1 },
    signature: "00".repeat(64),
  });
  await writeSourceTree(join(dir, "src-clones", SERVICE), { "flagship.app.json": JSON.stringify(MANIFEST), "server.js": "listen()" }, {
    binaries: { "logo.png": Buffer.from([0, 1, 2, 3]) },
  });
  const sOps = fakeOps(o.sourceOps);
  const keys: Record<string, Bytes> = { [DST]: dstBox.boxPublicKey(), "media.harry.flagship.services": otherBox.boxPublicKey(), "box.mallory.flagship.services": otherBox.boxPublicKey() };
  const source = buildAppCopySource({
    ...authority,
    serverFqdn: SRC,
    app: (id) => src.platform.byServiceId(id),
    containerName: (id) => `flagship-${id}`,
    ops: sOps.ops,
    resolveCallerKey: async (id) => keys[id] ?? null,
    workDir: join(dir, "out"),
    sourceDir: join(dir, "src-clones"),
    envKey: (info) => srcBox.deriveAppCopyEnvKey(info),
    envStore: srcEnv,
    access: srcAccess,
    accessList: (id) => (srcLists.held(id) ? srcLists.list(id) : null),
    ledger: new DbWriteLedger(join(dir, "src-ledger.json"), now, 60 * 60_000),
    now,
  });
  await source.init();

  // ── target ──
  const dst = platformFor(dstBox, "t".repeat(40), o.targetStartOk ?? true);
  const tOps = fakeOps(o.targetOps);
  const dstEnv = new InMemoryAppEnvStore();
  const dstAccess = new ServiceAccessStore(join(dir, "dst-access.json"));
  const dstLists = new AppAccessStore(null, null);
  const store = new AppCopyStore(join(dir, "copies.json"), now);
  const fetchLog: Array<{ part: string; status: number }> = [];
  const targetCgk = o.targetCgk === undefined ? new Uint8Array(32).fill(5) : o.targetCgk;
  const target = buildAppCopyTarget({
    ...authority,
    serverFqdn: DST,
    platform: dst.platform,
    dataProvisioner: dst.provisioner,
    store,
    ops: tOps.ops,
    signAsBox: (m) => dstBox.signAsBox(m),
    signInstall: (r) => dstBox.signInstallService(r),
    workDir: join(dir, "in"),
    sourceDir: join(dir, "dst-clones"),
    envKey: targetCgk ? copyEnvKeyFromCgk(targetCgk) : null,
    envStore: dstEnv,
    access: dstAccess,
    egress: {
      noteCopied: async (id, list, declared) => {
        await dstLists.draftFromCopy(id, list, declared);
      },
    },
    ledger: new DbWriteLedger(join(dir, "dst-ledger.json"), now, 60 * 60_000),
    fetch: async (url, init) => {
      expect(url).toBe(`https://${SRC}${APP_COPY_EXPORT_PATH}`);
      const r = await source.handle({ method: init.method, path: new URL(url).pathname, headers: init.headers, body: Buffer.from(init.body) });
      fetchLog.push({ part: (JSON.parse(init.body) as { part: string }).part, status: r!.status });
      return new Response(r!.status === 204 ? null : r!.body, { status: r!.status, headers: r!.headers ?? {} });
    },
    pollMs: 1,
    sleep: () => new Promise((r) => setTimeout(r, 1)),
    now,
  });
  const screens = (companion = false) =>
    buildScreensHttp({
      gate: { check: () => null },
      serverFqdn: DST,
      username: "harry",
      daemonVersion: "t",
      startedAt: 0,
      servicePlatform: dst.platform,
      appCopy: target,
      pairedSessions: { isCompanionRequest: () => companion } as never,
    });
  return { dir, src, dst, source, target, store, sOps, tOps, srcEnv, dstEnv, dstAccess, dstLists, srcList, fetchLog, screens };
}

function grant(over: Partial<AppCopyGrant> = {}, signer: { privateKey: Uint8Array; publicKey: Uint8Array } = owner) {
  const g: AppCopyGrant = { sourceServer: SRC, targetServer: DST, serviceId: SERVICE, issuedAt: Date.now(), ...over };
  return { grant: g, signature: hex(signAppCopyGrant(g, signer)) };
}

async function call(w: Awaited<ReturnType<typeof world>>, method: string, path: string, body?: unknown, companion = false) {
  const r = await w.screens(companion)(req(method, path, body));
  return { status: r!.status, json: JSON.parse(String(r!.body)) as Record<string, any> };
}

describe("the owner's order on the target (POST /api/screens/services/copy)", () => {
  it("copies the app: 202, copying → installing → done, data restored before first start", async () => {
    const w = await world();
    const held = deferred();
    w.sOps.hold(held.promise);
    const r = await call(w, "POST", COPY_PATH, grant());
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ copyId: expect.stringMatching(/^[0-9a-f]{24}$/) });

    // While the source makes the bundle the app is a greyed row in the apps list.
    await new Promise((res) => setTimeout(res, 5));
    const during = await call(w, "GET", "/api/screens/apps-list");
    expect(during.json.apps).toEqual([
      {
        serviceId: SERVICE,
        creator: "harry",
        slug: "notes",
        name: "notes",
        urlLabel: "notes",
        url: `https://notes.${DST}`,
        status: "unknown",
        installedAt: expect.any(Number),
        copying: { state: "copying", progress: 0.02 },
      },
    ]);
    const copying = await call(w, "GET", COPIES_PATH);
    expect(copying.json.copies[0]).toMatchObject({ copyId: r.json.copyId, state: "copying", sourceServer: SRC, appName: "notes" });

    held.resolve();
    await w.target.settle();
    const done = await call(w, "GET", COPIES_PATH);
    expect(done.json).toEqual({
      copies: [{ copyId: r.json.copyId, serviceId: SERVICE, appName: "notes", sourceServer: SRC, state: "done", startedAt: expect.any(Number) }],
    });

    const app = w.dst.platform.byServiceId(SERVICE)!;
    expect(app).toBeTruthy();
    const srcApp = w.src.platform.byServiceId(SERVICE)!;
    // Fresh stores under this box's own names, filled from the source's dumps.
    expect(app.data!.postgres!.default!.database).not.toBe(srcApp.data!.postgres!.default!.database);
    expect(w.tOps.restoredDbs).toEqual([
      { database: app.data!.postgres!.default!.database, role: app.data!.postgres!.default!.role, content: `rows-of-${srcApp.data!.postgres!.default!.database}` },
    ]);
    expect(w.tOps.restoredFiles).toEqual([{ volume: app.data!.files!.volume, content: `files-of-${srcApp.data!.files!.volume}` }]);
    expect(w.sOps.paused).toEqual([`flagship-${SERVICE}`]);
    expect(w.tOps.images.has(MANIFEST.runtime.image)).toBe(true);
    // The container was started from the copied image.
    expect(w.dst.calls.some((c) => c.startsWith("docker run") && c.includes(MANIFEST.runtime.image))).toBe(true);
    // Members, the allow-list and env came along; the source is untouched.
    expect(app.membership.members.list().map((m) => m.irkPubHex)).toEqual([hex(owner.publicKey)]);
    expect(w.dstAccess.mode(SERVICE)).toBe("restricted");
    expect(w.dstAccess.allowList(SERVICE)).toEqual([AID]);
    expect(await w.dstEnv.get(SERVICE)).toEqual({ OPENAI_KEY: "sk-secret", MODE: "prod" });
    expect(w.src.platform.byServiceId(SERVICE)).toBeTruthy();
    // Its working tree came along, so it can be edited here too.
    const tree = await readServiceSource(join(w.dir, "dst-clones"), SERVICE);
    expect(tree.ok && tree.files["server.js"]).toBe("listen()");
    expect([...(await readFile(join(w.dir, "dst-clones", SERVICE, "logo.png")))]).toEqual([0, 1, 2, 3]);
    expect(w.source.openExports()).toBe(0);
    expect(readdirSync(join(w.dir, "in"))).toEqual([]);
    expect(w.fetchLog.at(-1)).toEqual({ part: "done", status: 200 });
    // The row is now the installed app (no `copying`).
    const after = await call(w, "GET", "/api/screens/apps-list");
    expect(after.json.apps).toHaveLength(1);
    expect(after.json.apps[0].copying).toBeUndefined();
  });

  it("turns the source's access list into a draft here (it opens nothing until signed)", async () => {
    const w = await world();
    await call(w, "POST", COPY_PATH, grant());
    await w.target.settle();
    expect(w.dstLists.held(SERVICE)).toBeNull();
    expect(w.dstLists.rules(SERVICE)).toEqual([]);
    const draft = w.dstLists.draft(SERVICE)!;
    expect(draft.list).toBe(w.srcList);
    expect(draft.hosts.map((h) => h.host).sort()).toEqual(["api.example.com", "cdn.example.org"]);
  });

  it("doesn't copy API keys: nothing about them is in the bundle", async () => {
    const w = await world();
    const metas: unknown[] = [];
    const orig = w.source.handle;
    const peek = async (r: HttpRequest) => {
      const res = await orig(r);
      if ((JSON.parse(r.body.toString()) as { part: string }).part === "meta" && res?.status === 200) metas.push(JSON.parse(String(res.body)));
      return res;
    };
    (w.source as { handle: typeof orig }).handle = peek;
    // The world's fetch closes over `source.handle` at call time.
    await call(w, "POST", COPY_PATH, grant());
    await w.target.settle();
    expect(metas).toHaveLength(1);
    expect(Object.keys(metas[0] as object).sort()).toEqual(
      ["v", "serviceId", "creator", "slug", "manifestJson", "appliedMigrations", "parts", "access", "membership", "env", "accessList"].sort(),
    );
    expect(JSON.stringify(metas[0])).not.toMatch(/api-?key|fsk_/i);
    expect(JSON.stringify(metas[0])).not.toContain("sk-secret");
  });

  it("without the account's shared key on the target, env names wait as pendingEnv", async () => {
    const w = await world({ targetCgk: new Uint8Array(32).fill(0x77) });
    await call(w, "POST", COPY_PATH, grant());
    await w.target.settle();
    expect(await w.dstEnv.get(SERVICE)).toBeNull();
    const copies = await call(w, "GET", COPIES_PATH);
    expect(copies.json.copies[0]).toMatchObject({ state: "done", pendingEnv: ["MODE", "OPENAI_KEY"] });
  });

  it("400 for a malformed order; 403 bad signature, not this box, another account, stale", async () => {
    const w = await world();
    expect((await call(w, "POST", COPY_PATH, { grant: { sourceServer: SRC } , signature: "00" })).status).toBe(400);
    expect((await call(w, "POST", COPY_PATH, { ...grant(), signature: "zz" })).status).toBe(400);
    expect((await call(w, "POST", COPY_PATH, grant({ sourceServer: DST }))).status).toBe(400);
    const badSig = await call(w, "POST", COPY_PATH, grant({}, stranger));
    expect(badSig).toMatchObject({ status: 403, json: { error: "invalid signature" } });
    const otherBox = await call(w, "POST", COPY_PATH, grant({ targetServer: "media.harry.flagship.services" }));
    expect(otherBox).toMatchObject({ status: 403, json: { error: "the order is for a different server" } });
    const otherAccount = await call(w, "POST", COPY_PATH, grant({ sourceServer: "box.mallory.flagship.services" }));
    expect(otherAccount.status).toBe(403);
    const stale = await call(w, "POST", COPY_PATH, grant({ issuedAt: Date.now() - 11 * 60_000 }));
    expect(stale).toMatchObject({ status: 403, json: { error: "the order is stale: sign it again" } });
    expect(w.store.list()).toEqual([]);
  });

  it("with an admin root pinned, only the admin root's order works", async () => {
    const w = await world({ adminRootPub: adminRoot.publicKey });
    expect((await call(w, "POST", COPY_PATH, grant())).status).toBe(403);
    expect((await call(w, "POST", COPY_PATH, grant({}, adminRoot))).status).toBe(202);
    await w.target.settle();
    expect(w.dst.platform.byServiceId(SERVICE)).toBeTruthy();
  });

  it("409 when the app is already here, already being copied, or the order was used", async () => {
    const w = await world();
    const held = deferred();
    w.sOps.hold(held.promise);
    const first = grant();
    expect((await call(w, "POST", COPY_PATH, first)).status).toBe(202);
    const replay = await call(w, "POST", COPY_PATH, first);
    expect(replay).toMatchObject({ status: 409, json: { error: "the app is already being copied here" } });
    const second = await call(w, "POST", COPY_PATH, grant({ issuedAt: Date.now() + 1 }));
    expect(second.json.error).toBe("the app is already being copied here");
    held.resolve();
    await w.target.settle();
    const again = await call(w, "POST", COPY_PATH, grant({ issuedAt: Date.now() + 2 }));
    expect(again).toMatchObject({ status: 409, json: { error: "the app is already on this server" } });
  });

  it("a used order can't start a second copy (replay after a failure)", async () => {
    const w = await world({ targetOps: { restoreDatabase: async () => Promise.reject(new Error("pg_restore: boom")) } });
    const g = grant();
    expect((await call(w, "POST", COPY_PATH, g)).status).toBe(202);
    await w.target.settle();
    const replay = await call(w, "POST", COPY_PATH, g);
    expect(replay).toMatchObject({ status: 409, json: { error: "this signed order was already used: sign it again" } });
  });

  it("companion sessions get 403 on both endpoints", async () => {
    const w = await world();
    const post = await call(w, "POST", COPY_PATH, grant(), true);
    expect(post.status).toBe(403);
    const list = await call(w, "GET", COPIES_PATH, undefined, true);
    expect(list.status).toBe(403);
    expect(w.store.list()).toEqual([]);
  });
});

describe("a failed copy leaves nothing half-installed", () => {
  it("restore failure: stores dropped, image and env removed, downloads gone, source untouched", async () => {
    const w = await world({ targetOps: { restoreDatabase: async () => Promise.reject(new Error("pg_restore: boom")) } });
    await call(w, "POST", COPY_PATH, grant());
    await w.target.settle();
    const c = (await call(w, "GET", COPIES_PATH)).json.copies[0];
    expect(c).toMatchObject({ state: "failed", reason: expect.stringMatching(/restoring the copied data failed: pg_restore: boom/) });
    expect(c.progress).toBeUndefined();
    expect(w.dst.platform.byServiceId(SERVICE)).toBeUndefined();
    expect(w.dst.pg.databases.size).toBe(0);
    expect(w.dst.files.volumes.size).toBe(0);
    expect(w.tOps.removed).toEqual([MANIFEST.runtime.image]);
    expect(await w.dstEnv.get(SERVICE)).toBeNull();
    expect(readdirSync(join(w.dir, "in"))).toEqual([]);
    expect(readdirSync(join(w.dir)).includes("dst-clones")).toBe(false);
    expect(w.dstAccess.mode(SERVICE)).toBe("open");
    expect(w.src.platform.byServiceId(SERVICE)).toBeTruthy();
    expect((await call(w, "GET", "/api/screens/apps-list")).json.apps).toEqual([]);
  });

  it("start check failure: the same clean-up", async () => {
    const w = await world({ targetStartOk: false });
    await call(w, "POST", COPY_PATH, grant());
    await w.target.settle();
    expect(w.store.list()[0]).toMatchObject({ state: "failed", reason: expect.stringMatching(/never answered/) });
    expect(w.dst.platform.byServiceId(SERVICE)).toBeUndefined();
    expect(w.dst.pg.databases.size).toBe(0);
    expect(w.tOps.removed).toEqual([MANIFEST.runtime.image]);
  });

  it("an image already on the box is left there", async () => {
    const w = await world({ targetStartOk: false });
    w.tOps.images.add(MANIFEST.runtime.image);
    await call(w, "POST", COPY_PATH, grant());
    await w.target.settle();
    expect(w.tOps.removed).toEqual([]);
  });

  it("the source failing to make the bundle fails the copy with its reason", async () => {
    const w = await world({ sourceOps: { saveImage: async () => Promise.reject(new Error("no such image")) } });
    await call(w, "POST", COPY_PATH, grant());
    await w.target.settle();
    expect(w.store.list()[0]).toMatchObject({ state: "failed", reason: "the source server said: no such image" });
    expect(w.dst.platform.byServiceId(SERVICE)).toBeUndefined();
    expect(readdirSync(join(w.dir, "out"))).toEqual([]);
  });
});

describe("a restart during a copy", () => {
  it("reports it interrupted and removes what it held", async () => {
    const dir = mkdtempSync(join(tmpdir(), "app-copy-restart-"));
    const path = join(dir, "copies.json");
    const before = new AppCopyStore(path);
    await before.create({ copyId: "c1", serviceId: SERVICE, appName: "notes", sourceServer: SRC, state: "copying", progress: 0.4, startedAt: 1 });
    await before.update("c1", { state: "installing", held: { postgres: { default: { database: "app_x", role: "app_x" } }, filesVolume: "flagship-files-harry-notes", image: "img:1", env: true } });
    await before.create({ copyId: "c0", serviceId: "harry--old", appName: "old", sourceServer: SRC, state: "done", startedAt: 0 });

    const after = new AppCopyStore(path);
    const interrupted = await after.load();
    expect(interrupted.map((r) => r.copyId)).toEqual(["c1"]);
    expect(after.get("c1")).toMatchObject({ state: "failed", reason: INTERRUPTED_REASON });
    expect(after.get("c0")!.state).toBe("done");
    expect(JSON.parse(await readFile(path, "utf8")).copies.find((c: { copyId: string }) => c.copyId === "c1").state).toBe("failed");

    const d = platformFor(dstBox, "t".repeat(40));
    await d.pg.createRoleAndDb({ db: "app_x", role: "app_x", password: "p" });
    await d.files.createVolume({ volume: "flagship-files-harry-notes" });
    const ops = fakeOps();
    ops.images.add("img:1");
    const env = new InMemoryAppEnvStore();
    await env.put(SERVICE, { A: "1" });
    await writeFile(join(dir, "leftover"), "x");
    const target = buildAppCopyTarget({
      ownerIrkPub: owner.publicKey,
      username: "harry",
      serverFqdn: DST,
      platform: d.platform,
      dataProvisioner: d.provisioner,
      store: after,
      ops: ops.ops,
      signAsBox: (m) => dstBox.signAsBox(m),
      signInstall: (r) => dstBox.signInstallService(r),
      workDir: join(dir, "in"),
      envKey: null,
      envStore: env,
      access: null,
      egress: null,
      ledger: new DbWriteLedger(null),
    });
    await target.recover(interrupted);
    expect(d.pg.databases.size).toBe(0);
    expect(d.files.volumes.size).toBe(0);
    expect(ops.removed).toEqual(["img:1"]);
    expect(await env.get(SERVICE)).toBeNull();
    expect(after.get("c1")!.held).toBeUndefined();
    expect(target.inProgress("harry")).toEqual([]);
  });

  it("marks it done when the install had finished", async () => {
    const dir = mkdtempSync(join(tmpdir(), "app-copy-restart-"));
    const store = new AppCopyStore(join(dir, "copies.json"));
    await store.create({ copyId: "c1", serviceId: SERVICE, appName: "notes", sourceServer: SRC, state: "installing", startedAt: 1 });
    const reloaded = new AppCopyStore(join(dir, "copies.json"));
    const interrupted = await reloaded.load();
    const d = platformFor(dstBox, "t".repeat(40));
    const r = { serverId: DST, creator: "harry", slug: "notes", manifestJson: JSON.stringify(MANIFEST), addOwnerToMembership: false, issuedAt: Date.now() };
    expect((await d.platform.install({ request: r, signature: dstBox.signInstallService(r), verify: verifyInstallService })).ok).toBe(true);
    const target = buildAppCopyTarget({
      ownerIrkPub: owner.publicKey,
      username: "harry",
      serverFqdn: DST,
      platform: d.platform,
      dataProvisioner: d.provisioner,
      store: reloaded,
      ops: fakeOps().ops,
      signAsBox: (m) => dstBox.signAsBox(m),
      signInstall: (x) => dstBox.signInstallService(x),
      workDir: join(dir, "in"),
      envKey: null,
      envStore: null,
      access: null,
      egress: null,
      ledger: new DbWriteLedger(null),
    });
    await target.recover(interrupted);
    expect(reloaded.get("c1")).toMatchObject({ state: "done" });
    expect(reloaded.get("c1")!.reason).toBeUndefined();
    expect(d.pg.databases.size).toBe(1);
  });
});

describe("the source's export endpoint (POST /api/app-copy/export)", () => {
  async function exportCall(
    w: Awaited<ReturnType<typeof world>>,
    o: { from?: string; box?: typeof dstBox; g?: ReturnType<typeof grant>; part?: string; issuedAt?: number } = {},
  ) {
    const g = o.g ?? grant();
    const from = o.from ?? DST;
    const issuedAt = o.issuedAt ?? Date.now();
    const part = o.part ?? "meta";
    const auth = (o.box ?? dstBox).signAsBox(
      fetchEnvelopeBytes({ from, to: SRC, serviceId: g.grant.serviceId, grantIssuedAt: g.grant.issuedAt, grantSignature: g.signature, part, offset: 0, issuedAt }),
    );
    const r = await w.source.handle(req("POST", APP_COPY_EXPORT_PATH, { from, grant: g.grant, signature: g.signature, part, offset: 0, issuedAt, auth: hex(auth) }));
    return { status: r!.status, json: r!.headers?.["content-type"] === "application/json" ? (JSON.parse(String(r!.body)) as Record<string, any>) : null };
  }

  it("serves the order's target box (202 while it prepares, then the description)", async () => {
    const w = await world();
    const g = grant();
    expect((await exportCall(w, { g })).status).toBe(202);
    for (let i = 0; i < 50; i++) {
      const r = await exportCall(w, { g });
      if (r.status === 200) {
        expect(r.json!.parts.map((p: { name: string }) => p.name)).toEqual(["image", "db:default", "files", "source"]);
        expect(r.json!.env.names).toEqual(["MODE", "OPENAI_KEY"]);
        expect(r.json!.env.sealed).toBeTruthy();
        return;
      }
      await new Promise((res) => setTimeout(res, 2));
    }
    throw new Error("never ready");
  });

  it("refuses a caller that isn't the order's target, even a box of the account", async () => {
    const w = await world();
    const r = await exportCall(w, { from: "media.harry.flagship.services", box: otherBox });
    expect(r).toMatchObject({ status: 403, json: { error: "the caller isn't the server the order names as target" } });
    expect(w.source.openExports()).toBe(0);
  });

  it("refuses an unknown caller, a forged caller signature, a stale request", async () => {
    const w = await world();
    expect((await exportCall(w, { from: "ghost.harry.flagship.services" })).json!.error).toBe("unknown caller");
    expect((await exportCall(w, { box: otherBox })).json!.error).toBe("invalid caller signature");
    expect((await exportCall(w, { issuedAt: Date.now() - 6 * 60_000 })).json!.error).toBe("stale request");
  });

  it("refuses an order naming another source, another account's target, a bad owner signature, a stale order", async () => {
    const w = await world();
    const wrongSource = await exportCall(w, { g: grant({ sourceServer: "media.harry.flagship.services" }) });
    expect(wrongSource).toMatchObject({ status: 403, json: { error: "the order is for a different source server" } });
    const otherAccount = await exportCall(w, { from: "box.mallory.flagship.services", box: otherBox, g: grant({ targetServer: "box.mallory.flagship.services" }) });
    expect(otherAccount).toMatchObject({ status: 403, json: { error: "the caller isn't one of this account's servers" } });
    expect((await exportCall(w, { g: grant({}, stranger) })).json!.error).toBe("invalid signature");
    expect((await exportCall(w, { g: grant({ issuedAt: Date.now() - 16 * 60_000 }) })).json!.error).toBe("the order is stale: sign it again");
    expect(w.source.openExports()).toBe(0);
  });

  it("an order opens one export: after `done` it is used up (409)", async () => {
    const w = await world();
    const g = grant();
    expect((await exportCall(w, { g })).status).toBe(202);
    expect((await exportCall(w, { g, part: "done" })).status).toBe(200);
    expect(await exportCall(w, { g })).toMatchObject({ status: 409, json: { error: "this signed order was already used: sign it again" } });
  });

  it("ignores everything but POST on its path", async () => {
    const w = await world();
    expect(await w.source.handle(req("GET", "/api/other"))).toBeNull();
    expect((await w.source.handle(req("GET", APP_COPY_EXPORT_PATH)))!.status).toBe(405);
    expect((await w.source.handle(req("POST", APP_COPY_EXPORT_PATH, { from: DST })))!.status).toBe(400);
  });
});

describe("the env key", () => {
  it("both boxes of the account derive the same key through their custodian", () => {
    const info = new TextEncoder().encode("flagship/app-copy-env/v1|a|b|c|1");
    expect(hex(srcBox.deriveAppCopyEnvKey(info))).toBe(hex(dstBox.deriveAppCopyEnvKey(info)));
    expect(hex(copyEnvKeyFromCgk(new Uint8Array(32).fill(5))(info))).toBe(hex(srcBox.deriveAppCopyEnvKey(info)));
    expect(() => srcBox.deriveAppCopyEnvKey(new TextEncoder().encode("flagship/other|x"))).toThrow(/purpose/);
    expect(() => otherBox.deriveAppCopyEnvKey(info)).toThrow(/CGK/);
    void ed;
  });
});
