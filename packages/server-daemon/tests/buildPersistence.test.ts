/**
 * Git and IDE builds survive a daemon restart (an update causes one): the
 * orchestrator saves each build (buildStore.ts) and `restore` brings it back.
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILD_RETENTION_MS,
  BuildOrchestrator,
  INTERRUPTED_AI_REASON,
  INTERRUPTED_GO_LIVE_REASON,
  type BuildOrchestratorDeps,
} from "../src/buildmodes/buildOrchestrator.js";
import { fileBuildStore } from "../src/buildmodes/buildStore.js";
import { GitImporter } from "../src/buildmodes/gitImport.js";
import { InMemoryBuildJournal } from "../src/buildmodes/buildJournal.js";
import { InMemoryMcpKeyStore } from "../src/buildmodes/mcpKeyStore.js";
import type { CommandRunner } from "../src/serviceRunner.js";
import type { DeployResult } from "../src/buildmodes/deployArtifact.js";
import { FakeStaging } from "./helpers/fakeStaging.js";

const FQDN = "home.harry.flagship.services";
const MANIFEST = JSON.stringify({
  schema_version: 1,
  name: "shopping",
  version: "0.1.0",
  description: "List",
  runtime: { base: "static", image: "flagship/shopping:0.1.0", port: 8080 },
  data: { stores: { postgres: true } },
  network: { subdomain: "shopping" },
  access: { enabled: true, default_role: "member", public_routes: [] },
  migration: { verification: "standard" },
});
const noopCmd: CommandRunner = { run: async () => {} };

function clone(files: Record<string, string>) {
  return async ({ dest }: { dest: string }) => {
    for (const [path, content] of Object.entries(files)) {
      const full = join(dest, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
    }
  };
}

/** One "daemon process": an orchestrator over a store dir and an MCP key store that both outlive it. */
function daemon(shared: { dir: string; mcpKeys: InMemoryMcpKeyStore }, over: Partial<BuildOrchestratorDeps> = {}) {
  const journal = new InMemoryBuildJournal();
  const deployed: string[] = [];
  const deploy = async ({ buildId }: { buildId: string }): Promise<DeployResult> => {
    deployed.push(buildId);
    return { ok: true, serviceId: "harry--shopping", url: `https://shopping.${FQDN}`, image: "img" };
  };
  const o = new BuildOrchestrator({
    journal,
    gitImporter: new GitImporter({
      cmd: noopCmd,
      workingDir: mkdtempSync(join(tmpdir(), "bp-git-")),
      journal,
      cloneInto: clone({ "flagship.app.json": MANIFEST, Dockerfile: "FROM node:20-alpine" }),
    }),
    mcpKeys: shared.mcpKeys,
    serverFqdn: FQDN,
    mcpBaseUrl: `https://${FQDN}`,
    staging: new FakeStaging(),
    deployArtifact: deploy,
    installArtifact: deploy,
    store: fileBuildStore(shared.dir),
    saveDelayMs: 1,
    rand: (() => {
      let n = 0;
      return () => `build${++n}`;
    })(),
    now: () => 1_000,
    ...over,
  });
  return { o, deployed };
}

function shared() {
  return { dir: mkdtempSync(join(tmpdir(), "bp-store-")), mcpKeys: new InMemoryMcpKeyStore() };
}

describe("git and IDE builds across a restart", () => {
  it("a git build comes back with its files and sharing choice, and still deploys", async () => {
    const s = shared();
    const a = daemon(s);
    const r = await a.o.createGit({ gitUrl: "https://github.com/a/shopping" });
    if (!("buildId" in r)) throw new Error("no build");
    a.o.workspace(r.buildId)!.write("README.md", "hello");
    a.o.setShare(r.buildId, false);
    await a.o.flush();

    const b = daemon(s);
    expect(await b.o.restore()).toBe(1);
    expect(b.o.state(r.buildId)).toEqual(a.o.state(r.buildId));
    expect(b.o.state(r.buildId)).toMatchObject({ mode: "git", gitFit: true });
    expect(b.o.workspace(r.buildId)!.read("README.md")).toBe("hello");
    expect(b.o.isOpen(r.buildId)).toBe(true);
    const saved = JSON.parse(readFileSync(join(s.dir, `${r.buildId}.json`), "utf8"));
    expect(saved.gitSource.share).toBe(false);
    expect((await b.o.deploy(r.buildId)).ok).toBe(true);
    expect(b.deployed).toEqual([r.buildId]);
  });

  it("an IDE build comes back with its files, and the IDE reconnects with its key", async () => {
    const s = shared();
    const a = daemon(s);
    const created = await a.o.createMcp({ label: "notes" });
    if (!("buildId" in created)) throw new Error("no build");
    a.o.workspace(created.buildId)!.write("index.html", "<h1>hi</h1>");
    await a.o.flush();

    const b = daemon(s);
    await b.o.restore();
    expect(b.o.workspace(created.buildId)!.read("index.html")).toBe("<h1>hi</h1>");
    expect((await b.o.getMcp(created.buildId))?.key).toBe(created.connection.key);
    const rpc = await b.o.handleMcpRpc(created.connection.key, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(rpc.authed).toBe(true);
  });

  it("work a restart cut off comes back failed with a sentence", async () => {
    const s = shared();
    const a = daemon(s, {
      adaptRunner: () => new Promise<string>(() => {}),
    });
    const r = await a.o.createGit({ gitUrl: "https://github.com/a/shopping" });
    if (!("buildId" in r)) throw new Error("no build");
    expect(a.o.startAdaptGit(r.buildId)).toEqual({ ok: true });
    await a.o.flush();
    const live = await a.o.createMcp();
    if (!("buildId" in live)) throw new Error("no build");
    await a.o.flush();
    // The box was putting the IDE build live when it stopped.
    const file = join(s.dir, `${live.buildId}.json`);
    const snap = JSON.parse(readFileSync(file, "utf8"));
    snap.state.adapt = { status: "running", startedAt: 1, phase: "going-live" };
    writeFileSync(file, JSON.stringify(snap));

    const b = daemon(s);
    expect(await b.o.restore()).toBe(2);
    expect(b.o.state(r.buildId)!.adapt).toEqual({ status: "failed", reason: INTERRUPTED_AI_REASON });
    expect(b.o.state(live.buildId)!.adapt).toEqual({ status: "failed", reason: INTERRUPTED_GO_LIVE_REASON });
    // Its files are kept, so the owner can deploy it again.
    expect((await b.o.deploy(live.buildId)).ok).toBe(true);
  });

  it("a sealed build stays closed to the AI", async () => {
    const s = shared();
    const a = daemon(s);
    const created = await a.o.createMcp();
    if (!("buildId" in created)) throw new Error("no build");
    await a.o.seal(created.buildId);

    const b = daemon(s);
    await b.o.restore();
    expect(b.o.isSealed(created.buildId)).toBe(true);
    expect((await b.o.handleMcpRpc(created.connection.key, { jsonrpc: "2.0", id: 1, method: "tools/list" })).authed).toBe(false);
  });

  it("a discarded build is gone from disk, and one untouched for a month is dropped", async () => {
    const s = shared();
    const a = daemon(s);
    const r = await a.o.createGit({ gitUrl: "https://github.com/a/shopping" });
    const old = await a.o.createMcp();
    if (!("buildId" in r) || !("buildId" in old)) throw new Error("no build");
    await a.o.flush();
    expect(await a.o.discard(r.buildId)).toBe(true);
    expect(readdirSync(s.dir).filter((n) => n.startsWith(r.buildId))).toEqual([]);

    const b = daemon(s, { now: () => 1_000 + BUILD_RETENTION_MS + 1 });
    expect(await b.o.restore()).toBe(0);
    expect(b.o.state(old.buildId)).toBeNull();
    expect(readdirSync(s.dir).filter((n) => n.endsWith(".json"))).toEqual([]);
  });

  it("keeps a git import's non-text files", async () => {
    const s = shared();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    const a = daemon(s);
    // Feed a binary the way the importer reports one.
    const importer = (a.o as unknown as { deps: BuildOrchestratorDeps }).deps.gitImporter;
    const inspect = importer.inspect.bind(importer);
    importer.inspect = async (args) => ({ ...(await inspect(args)), binaries: { "logo.png": png } }) as Awaited<ReturnType<typeof inspect>>;
    const r = await a.o.createGit({ gitUrl: "https://github.com/a/shopping" });
    if (!("buildId" in r)) throw new Error("no build");
    await a.o.flush();

    let carried: Record<string, Buffer> | undefined;
    const b = daemon(s, {
      deployArtifact: async (args) => {
        carried = args.binaries;
        return { ok: true, serviceId: "harry--shopping", url: "https://x", image: "img" };
      },
    });
    await b.o.restore();
    expect((await b.o.deploy(r.buildId)).ok).toBe(true);
    expect(carried?.["logo.png"]?.equals(png)).toBe(true);
  });
});
