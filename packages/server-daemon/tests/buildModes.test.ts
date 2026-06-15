import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { BuildOrchestrator } from "../src/buildmodes/buildOrchestrator.js";
import { buildBuildModesHttpHandlers } from "../src/buildmodes/buildModesHttp.js";
import { GitImporter } from "../src/buildmodes/gitImport.js";
import { InMemoryBuildJournal } from "../src/buildmodes/buildJournal.js";
import { InMemoryMcpKeyStore } from "../src/buildmodes/mcpKeyStore.js";
import type { CommandRunner } from "../src/serviceRunner.js";
import type { HttpRequest } from "../src/runtime.js";
import type { DeployResult } from "../src/buildmodes/deployArtifact.js";

const FQDN = "home.harry.flagship.services";
const VALID_MANIFEST = JSON.stringify({
  schema_version: 1,
  name: "shopping",
  version: "0.1.0",
  description: "List",
  runtime: { image: "flagship/shopping:0.1.0", port: 8080 },
  data: { stores: { postgres: true } },
  network: { subdomain: "shopping" },
  access: { enabled: true, default_role: "member", public_routes: [] },
  migration: { verification: "standard" },
});

const noopCmd: CommandRunner = { run: async () => {} };

function fixtureClone(files: Record<string, string>) {
  return async ({ dest }: { dest: string }) => {
    for (const [path, content] of Object.entries(files)) {
      const full = join(dest, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
    }
  };
}

function makeOrchestrator(over: Partial<Parameters<typeof BuildOrchestrator.prototype.constructor>[0]> = {}) {
  const journal = new InMemoryBuildJournal();
  const mcpKeys = new InMemoryMcpKeyStore();
  const deployed: Array<{ buildId: string; files: Record<string, string> }> = [];
  const gitImporter = new GitImporter({
    cmd: noopCmd,
    workingDir: mkdtempSync(join(tmpdir(), "bm-git-")),
    journal,
    cloneInto: fixtureClone({ "flagship.app.json": VALID_MANIFEST, Dockerfile: "FROM node:20-alpine" }),
  });
  const o = new BuildOrchestrator({
    journal,
    gitImporter,
    mcpKeys,
    serverFqdn: FQDN,
    mcpBaseUrl: `https://${FQDN}`,
    deployArtifact: async ({ files, buildId }): Promise<DeployResult> => {
      deployed.push({ buildId, files });
      const name = JSON.parse(files["flagship.app.json"]!).name as string;
      return { ok: true, serviceId: `harry-${name}`, url: `https://${name}.${FQDN}`, image: "img" };
    },
    rand: (() => {
      let n = 0;
      return () => `build${++n}`;
    })(),
    now: () => 1,
    ...over,
  });
  return { o, journal, mcpKeys, deployed };
}

describe("BuildOrchestrator — git mode", () => {
  it("createGit returns the fitness verdict and loads the workspace", async () => {
    const { o } = makeOrchestrator();
    const r = await o.createGit({ gitUrl: "https://github.com/a/shopping" });
    expect(r.fit).toBe(true);
    expect(r.manifestName).toBe("shopping");
    expect(o.workspace(r.buildId)!.list()).toContain("Dockerfile");
  });

  it("deploys a fit git build through the artifact deployer", async () => {
    const { o, deployed, journal } = makeOrchestrator();
    const r = await o.createGit({ gitUrl: "https://github.com/a/shopping" });
    const d = await o.deploy(r.buildId);
    expect(d.ok).toBe(true);
    expect(deployed[0]!.files["flagship.app.json"]).toBeDefined();
    const entries = await journal.read(r.buildId);
    expect(entries.some((e) => e.kind === "session-started" && e.mode === "git")).toBe(true);
  });
});

describe("BuildOrchestrator — mcp mode", () => {
  it("mints a key + IDE config and routes RPC for the right key only", async () => {
    const { o } = makeOrchestrator();
    const { buildId, connection } = await o.createMcp({ label: "cursor" });
    expect(connection.key.startsWith("fmcp_")).toBe(true);
    expect(connection.url).toContain(`/mcp/build/${buildId}`);
    expect((connection.ideConfig as any).mcpServers[`flagship-${buildId}`].headers.Authorization).toContain(connection.key);

    // Right key → tools/list works.
    const good = await o.handleMcpRpc(connection.key, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(good.authed).toBe(true);
    expect((good.response!.result as any).tools.length).toBeGreaterThan(0);

    // Wrong key → not authed.
    const bad = await o.handleMcpRpc("fmcp_wrong", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(bad.authed).toBe(false);
  });

  it("an MCP agent can write files and deploy end-to-end", async () => {
    const { o, deployed } = makeOrchestrator();
    const { connection } = await o.createMcp();
    const call = (name: string, args: Record<string, unknown> = {}) =>
      o.handleMcpRpc(connection.key, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    await call("write_file", { path: "flagship.app.json", content: VALID_MANIFEST });
    await call("write_file", { path: "Dockerfile", content: "FROM node:20-alpine" });
    const d = await call("deploy");
    const text = (d.response!.result as any).content[0].text;
    expect(JSON.parse(text).url).toContain("shopping");
    expect(deployed.length).toBe(1);
  });

  it("re-displays and rotates the mcp key", async () => {
    const { o } = makeOrchestrator();
    const { buildId, connection } = await o.createMcp();
    const again = await o.getMcp(buildId);
    expect(again!.key).toBe(connection.key);
    const rotated = await o.rotateMcpKey(buildId);
    expect(rotated!.key).not.toBe(connection.key);
    // Old key no longer authenticates.
    const bad = await o.handleMcpRpc(connection.key, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(bad.authed).toBe(false);
  });
});

// ----- HTTP surface -----

const allowGate = { check: () => null };

function req(over: Partial<HttpRequest>): HttpRequest {
  return { method: "GET", path: "/", headers: {}, body: Buffer.alloc(0), ...over };
}
function jbody(o: unknown): Buffer {
  return Buffer.from(JSON.stringify(o), "utf8");
}

describe("buildModesHttp", () => {
  it("POST /api/build/git creates a build", async () => {
    const { o } = makeOrchestrator();
    const handle = buildBuildModesHttpHandlers({ orchestrator: o, gate: allowGate });
    const resp = await handle(req({ method: "POST", path: "/api/build/git", body: jbody({ gitUrl: "https://github.com/a/shopping" }) }));
    expect(resp!.status).toBe(200);
    expect(JSON.parse(resp!.body as string).fit).toBe(true);
  });

  it("POST /api/build/mcp returns connection info; the MCP transport authenticates by bearer", async () => {
    const { o } = makeOrchestrator();
    const handle = buildBuildModesHttpHandlers({ orchestrator: o, gate: allowGate });
    const created = await handle(req({ method: "POST", path: "/api/build/mcp", body: jbody({}) }));
    const conn = JSON.parse(created!.body as string).connection;

    // No bearer → 401.
    const noAuth = await handle(req({ method: "POST", path: `/mcp/build/x`, body: jbody({ jsonrpc: "2.0", id: 1, method: "ping" }) }));
    expect(noAuth!.status).toBe(401);

    // With bearer → 200, ping result.
    const ok = await handle(
      req({
        method: "POST",
        path: `/mcp/build/x`,
        headers: { authorization: `Bearer ${conn.key}` },
        body: jbody({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );
    expect(ok!.status).toBe(200);
    expect(JSON.parse(ok!.body as string).result).toEqual({});
  });

  it("GET journal + sessions list", async () => {
    const { o } = makeOrchestrator();
    const handle = buildBuildModesHttpHandlers({ orchestrator: o, gate: allowGate });
    const created = await handle(req({ method: "POST", path: "/api/build/git", body: jbody({ gitUrl: "https://github.com/a/shopping" }) }));
    const buildId = JSON.parse(created!.body as string).buildId;
    const jr = await handle(req({ method: "GET", path: `/api/build/sessions/${buildId}/journal` }));
    expect(JSON.parse(jr!.body as string).entries.length).toBeGreaterThan(0);
    const list = await handle(req({ method: "GET", path: "/api/build/sessions" }));
    expect(JSON.parse(list!.body as string).builds.length).toBe(1);
  });

  it("returns null for unrelated paths (so other handlers run)", async () => {
    const { o } = makeOrchestrator();
    const handle = buildBuildModesHttpHandlers({ orchestrator: o, gate: allowGate });
    expect(await handle(req({ path: "/api/health" }))).toBeNull();
  });

  it("a denying gate blocks /api/build but not /mcp/build", async () => {
    const { o } = makeOrchestrator();
    const denyGate = { check: () => ({ status: 401, body: "no" }) };
    const handle = buildBuildModesHttpHandlers({ orchestrator: o, gate: denyGate });
    const blocked = await handle(req({ method: "GET", path: "/api/build/sessions" }));
    expect(blocked!.status).toBe(401);
    // /mcp/build still reaches the bearer check (401 for missing bearer, not the gate).
    const mcp = await handle(req({ method: "POST", path: "/mcp/build/x", body: jbody({ jsonrpc: "2.0", id: 1, method: "ping" }) }));
    expect(mcp!.status).toBe(401);
  });
});
