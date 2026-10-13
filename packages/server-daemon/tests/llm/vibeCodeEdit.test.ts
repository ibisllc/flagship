/**
 * "Edit this service": a build can start from an installed service's code and
 * replace it in place, through the AI chat or an IDE. Covers the pieces the box
 * owns: the session keeps earlier files across turns, the AI is shown the
 * current code, the start route guards edits, both deployers redeploy instead
 * of installing, a clashing new build never touches another app's files, and
 * SQL migrations run once each, in order.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ed, signInstallService, verifyInstallService, type Keypair } from "@flagship/protocol";
import { swkOps } from "../helpers/keyCustody.js";
import { VibeCodeSession, VibeCodeSessionRegistry } from "../../src/llm/vibeCodeSession.js";
import { editSupplement } from "../../src/llm/vibeCodeStartStreaming.js";
import { readServiceSource } from "../../src/llm/serviceSource.js";
import { buildDeploySession } from "../../src/llm/deploySession.js";
import { buildArtifactDeployer } from "../../src/buildmodes/deployArtifact.js";
import { BuildOrchestrator, type EditableService } from "../../src/buildmodes/buildOrchestrator.js";
import { InMemoryBuildJournal } from "../../src/buildmodes/buildJournal.js";
import { InMemoryMcpKeyStore } from "../../src/buildmodes/mcpKeyStore.js";
import { GitImporter } from "../../src/buildmodes/gitImport.js";
import { buildScreensHttp } from "../../src/screens/screensHttp.js";
import { ServicePlatform } from "../../src/servicePlatform.js";
import { AppRunner, type CommandRunner } from "../../src/serviceRunner.js";
import { DataProvisioner, InMemoryFilesAdmin, InMemoryPostgresAdmin } from "../../src/dataLayer/index.js";
import { InMemoryInstalledServicesStore } from "../../src/installedServicesStore.js";
import type { HttpRequest } from "../../src/runtime.js";

const HOST = "alice";
const SERVER = `home.${HOST}.flagship.services`;
const manifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema_version: 1,
    name: "notes",
    version: "0.1.0",
    runtime: { base: "static", image: "x:0", port: 8080 },
    data: { stores: { postgres: true } },
    network: {},
    access: { enabled: true, default_role: "owner" },
    migration: { verification: "standard" },
    ...over,
  });

function key(): Keypair {
  const p = crypto.getRandomValues(new Uint8Array(32));
  return { privateKey: p, publicKey: ed.getPublicKey(p) };
}

describe("a session keeps its files across turns", () => {
  it("a resumed turn that rewrites one file keeps the others", () => {
    const s = new VibeCodeSession({ username: HOST, serverFqdn: SERVER });
    s.feedAssistant("=== a.js ===\nA1\n=== b.js ===\nB1\n=== END ===\n");
    s.endAssistant();
    s.prepareForResume();
    s.feedAssistant("=== b.js ===\nB2\n=== END ===\n");
    s.endAssistant();
    expect(s.files()).toEqual({ "a.js": "A1\n", "b.js": "B2\n" });
  });

  it("an edit session starts from the service's files, and edits don't hold names", () => {
    const reg = new VibeCodeSessionRegistry();
    const s = reg.create({ username: HOST, serverFqdn: SERVER, name: "notes", editsServiceId: "alice--notes", files: { "a.js": "A1" } });
    s.feedAssistant("=== c.js ===\nC1\n=== END ===\n");
    s.endAssistant();
    expect(s.files()).toEqual({ "a.js": "A1", "c.js": "C1\n" });
    expect(reg.holderOf("notes")).toBeUndefined();
  });
});

describe("what the AI is shown for an edit", () => {
  it("lists the current files and the rules for changing a live app", () => {
    const text = editSupplement("notes", { "src/app.js": "x", "flagship.app.json": "{}" });
    expect(text).toContain('"notes"');
    expect(text).toContain("=== flagship.app.json ===\n{}\n=== src/app.js ===\nx\n=== END ===");
    expect(text).toMatch(/Write ONLY the files you change/);
    expect(text).toMatch(/NEW numbered file such as `migrations\/0002/);
    expect(editSupplement(undefined, { a: "b" })).toBe("");
  });
});

describe("reading a service's source", () => {
  it("returns its text files, skipping dependency folders and binaries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "src-"));
    try {
      await mkdir(join(dir, "alice--notes", "src"), { recursive: true });
      await mkdir(join(dir, "alice--notes", "node_modules", "x"), { recursive: true });
      await writeFile(join(dir, "alice--notes", "flagship.app.json"), "{}");
      await writeFile(join(dir, "alice--notes", "src", "app.js"), "hi");
      await writeFile(join(dir, "alice--notes", "node_modules", "x", "i.js"), "dep");
      await writeFile(join(dir, "alice--notes", "logo.png"), Buffer.from([0x89, 0x50, 0, 1]));
      const r = await readServiceSource(dir, "alice--notes");
      expect(r).toMatchObject({ ok: true, files: { "flagship.app.json": "{}", "src/app.js": "hi" } });
      if (r.ok) expect(Object.keys(r.files).sort()).toEqual(["flagship.app.json", "src/app.js"]);
      expect(await readServiceSource(dir, "alice--other")).toMatchObject({ ok: false });
      expect(await readServiceSource(dir, "../etc")).toMatchObject({ ok: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the start route for edits", () => {
  function build(editable: EditableService) {
    const reg = new VibeCodeSessionRegistry();
    const handle = buildScreensHttp({
      gate: { has: () => true, check: () => null } as never,
      serverFqdn: SERVER,
      username: HOST,
      daemonVersion: "t",
      startedAt: 0,
      vibeCode: { registry: reg, username: HOST, serverFqdn: SERVER, editableService: async () => editable },
    });
    const start = (body: unknown): HttpRequest => ({
      method: "POST", path: "/api/screens/vibe-code/start", headers: { "x-flagship-session": "t", "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)),
    });
    return { reg, handle, start };
  }

  it("starts from the service's code under its name, and refuses a second open edit", async () => {
    const { reg, handle, start } = build({ ok: true, serviceId: "alice--notes", slug: "notes", files: { "flagship.app.json": manifest() }, bytes: 300 });
    const r = await handle(start({ prompt: "add due dates", editServiceId: "alice--notes", name: "ignored", visibility: "link" }));
    expect(r?.status).toBe(200);
    const s = reg.get(JSON.parse(r!.body as string).sessionId)!;
    expect(s.meta).toMatchObject({ name: "notes", editsServiceId: "alice--notes" });
    expect(s.meta.visibility).toBeUndefined();
    expect(Object.keys(s.files())).toEqual(["flagship.app.json"]);

    const again = await handle(start({ prompt: "and colours", editServiceId: "alice--notes" }));
    expect(again?.status).toBe(409);
    expect(JSON.parse(again!.body as string)).toMatchObject({ kind: "session", sessionId: s.meta.sessionId });
  });

  it("sends a service too big for the chat to the IDE, and passes on the box's refusal", async () => {
    const big = build({ ok: true, serviceId: "alice--notes", slug: "notes", files: {}, bytes: 400 * 1024 });
    const r = await big.handle(big.start({ prompt: "x", editServiceId: "alice--notes" }));
    expect(r?.status).toBe(413);
    expect(JSON.parse(r!.body as string).error).toMatch(/Connect your IDE/);
    const gone = build({ ok: false, status: 404, reason: "That service isn't installed." });
    expect((await gone.handle(gone.start({ prompt: "x", editServiceId: "alice--gone" })))?.status).toBe(404);
  });
});

function platformWorld() {
  const calls: string[] = [];
  const sql: string[] = [];
  const cmd: CommandRunner = {
    run: async (c, a) => { calls.push(`${c} ${a.join(" ")}`); },
    capture: async (c, a) => { calls.push(`${c} ${a.join(" ")}`); return { stdout: "", stderr: "" }; },
  };
  const irk = key();
  const platform = new ServicePlatform({
    host: { username: HOST, irkPub: irk.publicKey, },
    hostIdentityPub: irk.publicKey,
    swk: swkOps(crypto.getRandomValues(new Uint8Array(32))),
    appRunner: new AppRunner(cmd),
    dataProvisioner: new DataProvisioner({ postgres: new InMemoryPostgresAdmin(), files: new InMemoryFilesAdmin(), nameKey: "n".repeat(40) }),
    registry: new InMemoryInstalledServicesStore(),
    runSql: async ({ sql: s }) => {
      if (s.includes("BROKEN")) throw new Error("syntax error at or near BROKEN");
      sql.push(s);
    },
  });
  return { platform, calls, sql, irk };
}

describe("migrations", () => {
  it("run once each, in order, at install and on each redeploy", async () => {
    const { platform, sql, irk } = platformWorld();
    const req = (m: string) => ({ serverId: SERVER, creator: HOST, slug: "notes", manifestJson: m, addOwnerToMembership: true, issuedAt: Date.now() });
    const r1 = req(manifest());
    const ok = await platform.install({
      request: r1, signature: signInstallService(r1, irk), verify: verifyInstallService,
      migrations: [{ filename: "0002_b.sql", sql: "B" }, { filename: "0001_a.sql", sql: "A" }, { filename: "seed.ts", sql: "no" }],
    });
    expect(ok.ok).toBe(true);
    expect(sql).toEqual(["A", "B"]);

    const r2 = req(manifest({ version: "0.2.0" }));
    const re = await platform.redeploy({
      request: r2, signature: signInstallService(r2, irk), verify: verifyInstallService,
      migrations: [{ filename: "0001_a.sql", sql: "A" }, { filename: "0002_b.sql", sql: "B" }, { filename: "0003_c.sql", sql: "C" }],
    });
    expect(re.ok).toBe(true);
    expect(sql).toEqual(["A", "B", "C"]);
    expect(platform.byServiceId("alice--notes")!.appliedMigrations).toEqual(["0001_a.sql", "0002_b.sql", "0003_c.sql"]);
  });

  it("a failing migration keeps the running version and records the ones before it", async () => {
    const { platform, sql, irk, calls } = platformWorld();
    const req = (m: string) => ({ serverId: SERVER, creator: HOST, slug: "notes", manifestJson: m, addOwnerToMembership: true, issuedAt: Date.now() });
    const r1 = req(manifest());
    await platform.install({ request: r1, signature: signInstallService(r1, irk), verify: verifyInstallService });
    calls.length = 0;
    const r2 = req(manifest({ version: "0.2.0" }));
    const re = await platform.redeploy({
      request: r2, signature: signInstallService(r2, irk), verify: verifyInstallService,
      migrations: [{ filename: "0002_ok.sql", sql: "OK" }, { filename: "0003_bad.sql", sql: "BROKEN" }],
    });
    expect(re).toEqual({ ok: false, reason: "migration 0003_bad.sql failed: syntax error at or near BROKEN" });
    expect(sql).toEqual(["OK"]);
    expect(calls.some((c) => c.startsWith("docker run"))).toBe(false);
    const app = platform.byServiceId("alice--notes")!;
    expect(app.manifest.version).toBe("0.1.0");
    expect(app.appliedMigrations).toEqual(["0002_ok.sql"]);
  });

  it("an install whose migration fails leaves nothing installed", async () => {
    const { platform, irk } = platformWorld();
    const r1 = { serverId: SERVER, creator: HOST, slug: "notes", manifestJson: manifest(), addOwnerToMembership: true, issuedAt: Date.now() };
    const r = await platform.install({ request: r1, signature: signInstallService(r1, irk), verify: verifyInstallService, migrations: [{ filename: "0001.sql", sql: "BROKEN" }] });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/migration 0001.sql failed/) });
    expect(platform.byServiceId("alice--notes")).toBeUndefined();
  });
});

describe("deploying an edit", () => {
  async function withDir(run: (dir: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "edit-deploy-"));
    try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
  }

  async function installNotes(w: ReturnType<typeof platformWorld>) {
    const r = { serverId: SERVER, creator: HOST, slug: "notes", manifestJson: manifest(), addOwnerToMembership: true, issuedAt: Date.now() };
    const ok = await w.platform.install({ request: r, signature: signInstallService(r, w.irk), verify: verifyInstallService });
    if (!ok.ok) throw new Error(ok.reason);
  }

  it("an AI-chat edit replaces the service in place, at its current address", async () => {
    await withDir(async (dir) => {
      const w = platformWorld();
      await installNotes(w);
      w.platform.setAlias("alice--notes", "jottings");
      const before = w.platform.byServiceId("alice--notes")!;
      const deploy = buildDeploySession({
        servicePlatform: w.platform,
        signer: { signInstallService: (r) => signInstallService(r, w.irk) },
        hostUsername: HOST,
        workingDir: dir,
        cmd: { run: async () => {}, capture: async () => ({ stdout: "", stderr: "" }) },
      });
      const reg = new VibeCodeSessionRegistry();
      const s = reg.create({ username: HOST, serverFqdn: SERVER, name: "notes", editsServiceId: "alice--notes", files: { Dockerfile: "FROM busybox" } });
      s.feedAssistant(`=== flagship.app.json ===\n${manifest({ name: "renamed-by-ai", version: "0.2.0" })}\n=== migrations/0002_due.sql ===\nALTER TABLE t ADD due date;\n=== END ===\n`);
      s.endAssistant();
      const r = await deploy(s);
      expect(r).toMatchObject({ ok: true, serviceId: "alice--notes", url: `https://jottings.${SERVER}` });
      const after = w.platform.byServiceId("alice--notes")!;
      expect(after.manifest.version).toBe("0.2.0");
      expect(after.manifest.name).toBe("notes");
      expect(after.containerPort).toBe(before.containerPort);
      expect(after.data).toEqual(before.data);
      expect(w.sql).toEqual(["ALTER TABLE t ADD due date;\n"]);
    });
  });

  it("a new build named like an installed app stops before writing anything", async () => {
    await withDir(async (dir) => {
      const w = platformWorld();
      await installNotes(w);
      await mkdir(join(dir, "alice--notes"), { recursive: true });
      await writeFile(join(dir, "alice--notes", "keep.js"), "the running app's code");
      const deploy = buildArtifactDeployer({
        servicePlatform: w.platform,
        signer: { signInstallService: (r) => signInstallService(r, w.irk) },
        hostUsername: HOST,
        workingDir: dir,
        cmd: { run: async () => {}, capture: async () => ({ stdout: "", stderr: "" }) },
      });
      const r = await deploy({ files: { "flagship.app.json": manifest() }, serverFqdn: SERVER, mode: "mcp" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/already have a service called "notes"/);
      expect(await readdir(join(dir, "alice--notes"))).toEqual(["keep.js"]);

      const edit = await deploy({ files: { "flagship.app.json": manifest({ version: "0.5.0" }) }, serverFqdn: SERVER, mode: "mcp", editsServiceId: "alice--notes" });
      expect(edit).toMatchObject({ ok: true, serviceId: "alice--notes" });
      expect(w.platform.byServiceId("alice--notes")!.manifest.version).toBe("0.5.0");
    });
  });

  it("an IDE edit starts from the service's code and deploys over it", async () => {
    const journal = new InMemoryBuildJournal();
    const deployed: unknown[] = [];
    const o = new BuildOrchestrator({
      journal,
      gitImporter: new GitImporter({ cmd: { run: async () => {} }, workingDir: tmpdir(), journal, cloneInto: async () => {} }),
      mcpKeys: new InMemoryMcpKeyStore(),
      serverFqdn: SERVER,
      mcpBaseUrl: `https://${SERVER}`,
      deployArtifact: async (a) => { deployed.push(a); return { ok: true, serviceId: "alice--notes", url: "https://notes", image: "i" }; },
      editableService: async (id) =>
        id === "alice--notes"
          ? { ok: true, serviceId: id, slug: "notes", files: { "flagship.app.json": manifest(), "src/app.js": "v1" }, bytes: 10 }
          : { ok: false, status: 404, reason: "That service isn't installed." },
    });
    const made = await o.createMcp({ editServiceId: "alice--notes" });
    if ("error" in made) throw new Error(made.error);
    expect(o.workspace(made.buildId)!.snapshot()["src/app.js"]).toBe("v1");
    expect((await journal.list())[0]).toMatchObject({ name: "notes", serviceId: "alice--notes", mode: "mcp" });
    await o.deploy(made.buildId);
    expect(deployed[0]).toMatchObject({ editsServiceId: "alice--notes" });
    expect(await o.createMcp({ editServiceId: "alice--gone" })).toEqual({ error: "That service isn't installed.", status: 404 });
  });
});
