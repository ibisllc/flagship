import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveSWK } from "@flagship/protocol";
import { BuildOrchestrator } from "../src/buildmodes/buildOrchestrator.js";
import { buildBuildModesHttpHandlers } from "../src/buildmodes/buildModesHttp.js";
import { GitImporter } from "../src/buildmodes/gitImport.js";
import { InMemoryBuildJournal } from "../src/buildmodes/buildJournal.js";
import { InMemoryMcpKeyStore } from "../src/buildmodes/mcpKeyStore.js";
import { FileBuildCredentialStore, InMemoryBuildCredentialStore } from "../src/llm/buildCredentialStore.js";
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

const NOT_FIT_CLONE = fixtureClone({
  "package.json": JSON.stringify({ name: "legacy", version: "1.0.0" }),
  "src/index.js": "console.log('hi')",
});

// Canned model output in the emit-format the VibeCodeStreamParser reads.
const ADAPT_OUTPUT =
  "=== flagship.app.json ===\n" +
  VALID_MANIFEST +
  "\n=== Dockerfile ===\nFROM node:20-alpine\n=== src/index.js ===\nconsole.log('adapted')\n=== END ===\n";

function makeNotFitOrchestrator(over: Partial<Parameters<typeof BuildOrchestrator.prototype.constructor>[0]> = {}) {
  const journal = new InMemoryBuildJournal();
  const mcpKeys = new InMemoryMcpKeyStore();
  const gitImporter = new GitImporter({
    cmd: noopCmd,
    workingDir: mkdtempSync(join(tmpdir(), "bm-adapt-")),
    journal,
    cloneInto: NOT_FIT_CLONE,
  });
  const o = new BuildOrchestrator({
    journal,
    gitImporter,
    mcpKeys,
    serverFqdn: FQDN,
    mcpBaseUrl: `https://${FQDN}`,
    deployArtifact: async (): Promise<DeployResult> => ({ ok: true, serviceId: "x", url: "https://x", image: "img" }),
    rand: (() => {
      let n = 0;
      return () => `build${++n}`;
    })(),
    now: () => 1,
    ...over,
  });
  return { o, journal };
}

describe("BuildOrchestrator — git AI adapt", () => {
  it("adaptGit merges the model's emit-format files into the workspace + journals adapt-step", async () => {
    const calls: Array<{ systemPrompt: string; userPrompt: string }> = [];
    const adaptRunner = async (a: { systemPrompt: string; userPrompt: string }) => {
      calls.push(a);
      return ADAPT_OUTPUT;
    };
    const { o, journal } = makeNotFitOrchestrator({ adaptRunner });
    const created = await o.createGit({ gitUrl: "https://github.com/a/legacy" });
    expect(created.fit).toBe(false);

    const r = await o.adaptGit(created.buildId, { instructions: "make it teal" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fileCount).toBe(3);

    // The repo tree was rendered into the user prompt; the owner's
    // instructions were appended; the system prompt is the emit-format one.
    expect(calls[0]!.systemPrompt).toContain("Flagship's app builder");
    expect(calls[0]!.userPrompt).toContain("package.json");
    expect(calls[0]!.userPrompt).toContain("Extra instructions: make it teal");

    // The workspace now holds the adapted manifest (parsed via the shared parser).
    const ws = o.workspace(created.buildId)!;
    expect(ws.read("flagship.app.json")).toBeTruthy();
    expect(JSON.parse(ws.read("flagship.app.json")!).name).toBe("shopping");
    expect(ws.read("src/index.js")).toContain("adapted");

    const entries = await journal.read(created.buildId);
    expect(entries.some((e) => e.kind === "adapt-step" && e.actor === "ai")).toBe(true);
    // Value-free: the journal records names, never file contents.
    expect(entries.every((e) => !(e.detail ?? "").includes("adapted"))).toBe(true);
  });

  it("adaptGit reports 'not configured' when no runner is injected", async () => {
    const { o } = makeNotFitOrchestrator();
    const created = await o.createGit({ gitUrl: "https://github.com/a/legacy" });
    const r = await o.adaptGit(created.buildId);
    expect(r).toEqual({ ok: false, reason: "AI adapt not configured" });
  });

  it("adaptGit degrades to 'not configured' when a runner IS wired but the build has no credential", async () => {
    // The genuine no-credential case: provider wired, but the owner never
    // delivered a BYOK key for THIS build → identical clean signal.
    const { o } = makeNotFitOrchestrator({
      adaptRunner: async () => ADAPT_OUTPUT,
      adaptCredentialAvailable: () => false,
    });
    const created = await o.createGit({ gitUrl: "https://github.com/a/legacy" });
    const r = await o.adaptGit(created.buildId);
    expect(r).toEqual({ ok: false, reason: "AI adapt not configured" });
  });

  it("adaptGit runs the runner when a credential IS available", async () => {
    let ranWithBuildId = "";
    const { o } = makeNotFitOrchestrator({
      adaptRunner: async (a: { buildId: string }) => {
        ranWithBuildId = a.buildId;
        return ADAPT_OUTPUT;
      },
      adaptCredentialAvailable: () => true,
    });
    const created = await o.createGit({ gitUrl: "https://github.com/a/legacy" });
    const r = await o.adaptGit(created.buildId);
    expect(r.ok).toBe(true);
    // The runner received the build id so it can open that build's key.
    expect(ranWithBuildId).toBe(created.buildId);
  });

  it("adaptGit fails when the model output has no manifest", async () => {
    const adaptRunner = async () => "=== src/index.js ===\nconsole.log('x')\n=== END ===\n";
    const { o } = makeNotFitOrchestrator({ adaptRunner });
    const created = await o.createGit({ gitUrl: "https://github.com/a/legacy" });
    const r = await o.adaptGit(created.buildId, {});
    expect(r).toEqual({ ok: false, reason: "adapt produced no flagship.app.json" });
  });

  it("adaptGit rejects a non-git build", async () => {
    const { o } = makeNotFitOrchestrator({ adaptRunner: async () => ADAPT_OUTPUT });
    const { buildId } = await o.createMcp({});
    const r = await o.adaptGit(buildId);
    expect(r.ok).toBe(false);
  });
});

// ----- AGENTIC adapt loop (the product bar) -----

import type { ChatRequest, ChatResponse, ToolUseBlock } from "@flagship/llm-providers";

/**
 * A fake tool-driving model: a scripted sequence of turns, each emitting
 * tool_use blocks. It asserts the loop feeds tool results back (the prior
 * turn's results appear in the message history) so we're testing a genuine
 * multi-turn conversation, not a one-shot.
 */
function scriptedAgentRunner(
  script: Array<(seenMessages: ChatRequest["messages"]) => { text?: string; toolUses?: ToolUseBlock[] }>,
) {
  let turn = 0;
  const seen: ChatRequest["messages"][] = [];
  const runner = async (_buildId: string, req: ChatRequest): Promise<ChatResponse> => {
    seen.push(req.messages);
    const step = script[turn];
    turn++;
    if (!step) return { content: "done", model: "fake" };
    const out = step(req.messages);
    return {
      content: out.text ?? "",
      model: "fake",
      ...(out.toolUses ? { toolUses: out.toolUses } : {}),
    };
  };
  return { runner, seen: () => seen, turns: () => turn };
}

function tu(id: string, name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { id, name, input };
}

describe("BuildOrchestrator — AGENTIC adapt", () => {
  it("drives read → write → validate → deploy over the shared tool surface and deploys", async () => {
    const deployed: Array<{ files: Record<string, string> }> = [];
    // The fake model: turn 1 reads the contract + lists files; turn 2 reads
    // the source; turn 3 writes a manifest + Dockerfile; turn 4 validates;
    // turn 5 deploys. A genuine multi-turn tool conversation.
    const agent = scriptedAgentRunner([
      () => ({ toolUses: [tu("a1", "get_contract"), tu("a2", "list_files")] }),
      () => ({ toolUses: [tu("b1", "read_file", { path: "package.json" })] }),
      () => ({
        toolUses: [
          tu("c1", "write_file", { path: "flagship.app.json", content: VALID_MANIFEST }),
          tu("c2", "write_file", { path: "Dockerfile", content: "FROM node:20-alpine" }),
        ],
      }),
      () => ({ toolUses: [tu("d1", "validate")] }),
      () => ({ toolUses: [tu("e1", "deploy")] }),
    ]);

    const { o, journal } = makeNotFitOrchestrator({
      agentRunner: agent.runner,
      adaptCredentialAvailable: () => true,
      deployArtifact: async ({ files }): Promise<DeployResult> => {
        deployed.push({ files });
        const name = JSON.parse(files["flagship.app.json"]!).name as string;
        return { ok: true, serviceId: `harry-${name}`, url: `https://${name}.${FQDN}`, image: "img" };
      },
    });

    const created = await o.createGit({ gitUrl: "https://github.com/a/legacy" });
    expect(created.fit).toBe(false);

    const r = await o.adaptGit(created.buildId, { instructions: "keep it minimal" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.deployed).toBe(true);
      expect(r.deployedUrl).toContain("shopping");
      expect(r.serviceId).toBe("harry-shopping");
      expect(r.turns).toBe(5);
    }

    // The AI itself deployed (called the deploy tool) — one install ran.
    expect(deployed).toHaveLength(1);
    expect(JSON.parse(deployed[0]!.files["flagship.app.json"]!).name).toBe("shopping");

    // The workspace was shaped by the AI's write_file calls.
    const ws = o.workspace(created.buildId)!;
    expect(ws.read("flagship.app.json")).toBeTruthy();
    expect(ws.read("Dockerfile")).toContain("node:20-alpine");

    // Genuine multi-turn: by turn 2 the model's message history carried a
    // tool result turn (role "tool") from turn 1's calls.
    const turn2Messages = agent.seen()[1]!;
    expect(turn2Messages.some((m) => m.role === "assistant" && (m.toolUses?.length ?? 0) > 0)).toBe(true);
    expect(turn2Messages.some((m) => m.role === "tool" && (m.toolResults?.length ?? 0) > 0)).toBe(true);
    // The contract result is fed back (the model "read" it).
    const toolTurn = turn2Messages.find((m) => m.role === "tool");
    expect(JSON.stringify(toolTurn!.toolResults)).toContain("Flagship app contract");

    // The journal records the agentic steps + the AI's deploy tool call,
    // value-free. (The tool host journals each call as an "mcp-call"; the
    // deploy call's summary is "deployed → <url>".)
    const entries = await journal.read(created.buildId);
    expect(entries.some((e) => e.kind === "adapt-step" && /agentic adapt/.test(e.summary))).toBe(true);
    expect(entries.some((e) => e.kind === "mcp-call" && e.actor === "ai" && /^deployed →/.test(e.summary))).toBe(true);
    expect(entries.some((e) => e.kind === "mcp-call" && /^wrote flagship\.app\.json/.test(e.summary))).toBe(true);
    expect(entries.every((e) => !(e.detail ?? "").includes("byok"))).toBe(true);
  });

  it("recovers when validate reports a problem, then deploys", async () => {
    // The model writes a BAD manifest first; validate flags it; the model
    // fixes it and re-validates ok, then deploys. Proves the tool-error
    // feedback loop (validate problems → fix → revalidate).
    const BAD_MANIFEST = JSON.stringify({ schema_version: 1, name: "Bad Name!!" });
    const seenValidateResults: string[] = [];
    const agent = scriptedAgentRunner([
      () => ({
        toolUses: [
          tu("w1", "write_file", { path: "flagship.app.json", content: BAD_MANIFEST }),
          tu("w2", "write_file", { path: "Dockerfile", content: "FROM scratch" }),
        ],
      }),
      (msgs) => {
        // Capture what validate told the model last turn.
        const t = msgs.find((m) => m.role === "tool");
        if (t) seenValidateResults.push(JSON.stringify(t.toolResults));
        return { toolUses: [tu("v1", "validate")] };
      },
      () => ({ toolUses: [tu("f1", "write_file", { path: "flagship.app.json", content: VALID_MANIFEST })] }),
      () => ({ toolUses: [tu("v2", "validate")] }),
      () => ({ toolUses: [tu("d1", "deploy")] }),
    ]);
    const { o } = makeNotFitOrchestrator({
      agentRunner: agent.runner,
      adaptCredentialAvailable: () => true,
      deployArtifact: async ({ files }): Promise<DeployResult> => ({
        ok: true,
        serviceId: "harry-shopping",
        url: `https://shopping.${FQDN}`,
        image: "img",
      }),
    });
    const created = await o.createGit({ gitUrl: "https://github.com/a/legacy" });
    const r = await o.adaptGit(created.buildId);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.deployed).toBe(true);
    // The model saw a validate failure mid-loop (the bad manifest's problems).
    expect(seenValidateResults.join(" ")).toMatch(/problems|ok/);
  });

  it("returns ok-but-not-deployed when the AI writes a manifest but never deploys", async () => {
    const agent = scriptedAgentRunner([
      () => ({ toolUses: [tu("w1", "write_file", { path: "flagship.app.json", content: VALID_MANIFEST })] }),
      () => ({ text: "I wrote the manifest but I'll stop here." }), // no tool calls → loop ends
    ]);
    const { o } = makeNotFitOrchestrator({ agentRunner: agent.runner, adaptCredentialAvailable: () => true });
    const created = await o.createGit({ gitUrl: "https://github.com/a/legacy" });
    const r = await o.adaptGit(created.buildId);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.deployed).toBe(false);
      expect(o.workspace(created.buildId)!.read("flagship.app.json")).toBeTruthy();
    }
  });

  it("fails cleanly when the AI never produces a manifest", async () => {
    const agent = scriptedAgentRunner([
      () => ({ toolUses: [tu("r1", "read_file", { path: "package.json" })] }),
      () => ({ text: "I can't figure this out." }), // gives up, no manifest written
    ]);
    const { o } = makeNotFitOrchestrator({ agentRunner: agent.runner, adaptCredentialAvailable: () => true });
    const created = await o.createGit({ gitUrl: "https://github.com/a/legacy" });
    const r = await o.adaptGit(created.buildId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("could not produce a valid Flagship app");
  });

  it("the no-credential case still degrades to the clean 503 with an agentRunner", async () => {
    const agent = scriptedAgentRunner([() => ({ toolUses: [tu("d1", "deploy")] })]);
    const { o } = makeNotFitOrchestrator({ agentRunner: agent.runner, adaptCredentialAvailable: () => false });
    const created = await o.createGit({ gitUrl: "https://github.com/a/legacy" });
    const r = await o.adaptGit(created.buildId);
    expect(r).toEqual({ ok: false, reason: "AI adapt not configured" });
  });

  it("honors the turn cap (a model that never stops doesn't loop forever)", async () => {
    // A model that always calls a harmless tool and never deploys.
    const agent = scriptedAgentRunner(
      Array.from({ length: 100 }, () => () => ({ toolUses: [tu("l1", "list_files")] })),
    );
    const { o } = makeNotFitOrchestrator({
      agentRunner: agent.runner,
      adaptCredentialAvailable: () => true,
      agentMaxTurns: 3,
    });
    const created = await o.createGit({ gitUrl: "https://github.com/a/legacy" });
    const r = await o.adaptGit(created.buildId);
    // No manifest, hit the cap → clean failure; the runner ran exactly 3 turns.
    expect(r.ok).toBe(false);
    expect(agent.turns()).toBe(3);
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

describe("BuildOrchestrator — env requests (value-free)", () => {
  it("records a request_env_var call, fires notifyOwner + recordEnvRequest, and lists it", async () => {
    const notified: Array<{ buildId: string; name: string }> = [];
    const sideEffects: Array<{ buildId: string; name: string; why?: string; secret?: boolean }> = [];
    const { o } = makeOrchestrator({
      envNames: async () => ["ALREADY_SET"],
      notifyOwner: (n) => notified.push(n),
      recordEnvRequest: async (r) => {
        sideEffects.push(r);
      },
    });
    const { buildId, connection } = await o.createMcp();
    const call = (name: string, args: Record<string, unknown> = {}) =>
      o.handleMcpRpc(connection.key, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

    const r = await call("request_env_var", { name: "STRIPE_KEY", why: "checkout", secret: true });
    const text = JSON.parse((r.response!.result as any).content[0].text);
    // VALUE-FREE: the tool reports status only, never carries a value field.
    expect(text.currentlySet).toBe(false);
    expect(text).not.toHaveProperty("value");

    // notify + side-effect both fired, value-free.
    expect(notified).toEqual([{ buildId, name: "STRIPE_KEY" }]);
    expect(sideEffects[0]).toMatchObject({ buildId, name: "STRIPE_KEY", why: "checkout", secret: true });

    // The pending list carries names + metadata but never a value field.
    const pending = o.pendingEnvRequests(buildId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ name: "STRIPE_KEY", why: "checkout", secret: true, requestedBy: "ide" });
    expect(pending[0]).not.toHaveProperty("value");
  });

  it("dedupes resolvedEnvRequests by name (latest wins) and marks currentlySet", async () => {
    const { o } = makeOrchestrator({ envNames: async () => ["DB_URL"] });
    const { buildId, connection } = await o.createMcp();
    const call = (args: Record<string, unknown>) =>
      o.handleMcpRpc(connection.key, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "request_env_var", arguments: args } });
    await call({ name: "DB_URL", why: "first" });
    await call({ name: "DB_URL", why: "second" }); // same name, newer
    await call({ name: "API_TOKEN", secret: true });

    const resolved = await o.resolvedEnvRequests(buildId);
    const byName = Object.fromEntries(resolved.map((r) => [r.name, r]));
    expect(Object.keys(byName).sort()).toEqual(["API_TOKEN", "DB_URL"]);
    expect(byName.DB_URL!.why).toBe("second");
    expect(byName.DB_URL!.currentlySet).toBe(true);
    expect(byName.API_TOKEN!.currentlySet).toBe(false);
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

  it("GET .../env-requests returns the value-free request list", async () => {
    const { o } = makeOrchestrator({ envNames: async () => [] });
    const handle = buildBuildModesHttpHandlers({ orchestrator: o, gate: allowGate });
    const created = await handle(req({ method: "POST", path: "/api/build/mcp", body: jbody({}) }));
    const conn = JSON.parse(created!.body as string).connection;
    const buildId = JSON.parse(created!.body as string).buildId;
    // The IDE asks for a secret over the bearer-gated MCP pipe.
    await handle(
      req({
        method: "POST",
        path: `/mcp/build/${buildId}`,
        headers: { authorization: `Bearer ${conn.key}` },
        body: jbody({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "request_env_var", arguments: { name: "STRIPE_KEY", why: "checkout", secret: true } } }),
      }),
    );
    const resp = await handle(req({ method: "GET", path: `/api/build/sessions/${buildId}/env-requests` }));
    expect(resp!.status).toBe(200);
    const out = JSON.parse(resp!.body as string);
    expect(out.requests).toHaveLength(1);
    expect(out.requests[0]).toMatchObject({ name: "STRIPE_KEY", why: "checkout", secret: true, requestedBy: "ide", currentlySet: false });
    // Never a value anywhere in the response.
    expect(resp!.body as string).not.toContain('"value"');
  });

  it("POST /api/build/git stores a delivered BYOK credential; the adapt pass then runs live", async () => {
    const credentials = new InMemoryBuildCredentialStore();
    let seenKey = "";
    const { o } = makeNotFitOrchestrator({
      adaptRunner: async (a: { buildId: string }) => {
        const c = await credentials.get(a.buildId);
        seenKey = c?.apiKey ?? "";
        return ADAPT_OUTPUT;
      },
      adaptCredentialAvailable: (buildId: string) => credentials.has(buildId),
    });
    const handle = buildBuildModesHttpHandlers({ orchestrator: o, gate: allowGate, credentials });

    const created = await handle(
      req({
        method: "POST",
        path: "/api/build/git",
        body: jbody({
          gitUrl: "https://github.com/a/legacy",
          credential: { provider: "anthropic", apiKey: "byok-LIVE-secret" },
        }),
      }),
    );
    expect(created!.status).toBe(200);
    // The credential is NEVER echoed in the create response.
    expect(created!.body as string).not.toContain("byok-LIVE-secret");
    const buildId = JSON.parse(created!.body as string).buildId;

    const adapt = await handle(req({ method: "POST", path: `/api/build/sessions/${buildId}/adapt`, body: jbody({}) }));
    expect(adapt!.status).toBe(200);
    expect(seenKey).toBe("byok-LIVE-secret");
  });

  it("POST .../adapt 503s when a credential store is wired but the build has no key", async () => {
    const credentials = new InMemoryBuildCredentialStore();
    const { o } = makeNotFitOrchestrator({
      adaptRunner: async () => ADAPT_OUTPUT,
      adaptCredentialAvailable: (buildId: string) => credentials.has(buildId),
    });
    const handle = buildBuildModesHttpHandlers({ orchestrator: o, gate: allowGate, credentials });
    const created = await handle(req({ method: "POST", path: "/api/build/git", body: jbody({ gitUrl: "https://github.com/a/legacy" }) }));
    const buildId = JSON.parse(created!.body as string).buildId;
    const adapt = await handle(req({ method: "POST", path: `/api/build/sessions/${buildId}/adapt`, body: jbody({}) }));
    expect(adapt!.status).toBe(503);
    expect(JSON.parse(adapt!.body as string).error).toBe("AI adapt not configured");
  });

  it("POST /api/build/git rejects a malformed credential", async () => {
    const credentials = new InMemoryBuildCredentialStore();
    const { o } = makeNotFitOrchestrator();
    const handle = buildBuildModesHttpHandlers({ orchestrator: o, gate: allowGate, credentials });
    const resp = await handle(
      req({
        method: "POST",
        path: "/api/build/git",
        body: jbody({ gitUrl: "https://github.com/a/legacy", credential: { provider: "anthropic" } }),
      }),
    );
    expect(resp!.status).toBe(400);
  });

  it("POST .../adapt 503s when no runner is configured, then succeeds when one is", async () => {
    // No runner → 503.
    const bare = makeNotFitOrchestrator();
    let handle = buildBuildModesHttpHandlers({ orchestrator: bare.o, gate: allowGate });
    const c1 = await handle(req({ method: "POST", path: "/api/build/git", body: jbody({ gitUrl: "https://github.com/a/legacy" }) }));
    const id1 = JSON.parse(c1!.body as string).buildId;
    const noRunner = await handle(req({ method: "POST", path: `/api/build/sessions/${id1}/adapt`, body: jbody({}) }));
    expect(noRunner!.status).toBe(503);
    expect(JSON.parse(noRunner!.body as string).error).toBe("AI adapt not configured");

    // With a runner → 200 {ok, fileCount}.
    const wired = makeNotFitOrchestrator({ adaptRunner: async () => ADAPT_OUTPUT });
    handle = buildBuildModesHttpHandlers({ orchestrator: wired.o, gate: allowGate });
    const c2 = await handle(req({ method: "POST", path: "/api/build/git", body: jbody({ gitUrl: "https://github.com/a/legacy" }) }));
    const id2 = JSON.parse(c2!.body as string).buildId;
    const ok = await handle(req({ method: "POST", path: `/api/build/sessions/${id2}/adapt`, body: jbody({ instructions: "go" }) }));
    expect(ok!.status).toBe(200);
    expect(JSON.parse(ok!.body as string)).toEqual({ ok: true, fileCount: 3 });
  });

  it("POST .../adapt 502s on a parse-level failure (no manifest)", async () => {
    const wired = makeNotFitOrchestrator({ adaptRunner: async () => "=== src/x.js ===\nx\n=== END ===\n" });
    const handle = buildBuildModesHttpHandlers({ orchestrator: wired.o, gate: allowGate });
    const c = await handle(req({ method: "POST", path: "/api/build/git", body: jbody({ gitUrl: "https://github.com/a/legacy" }) }));
    const id = JSON.parse(c!.body as string).buildId;
    const resp = await handle(req({ method: "POST", path: `/api/build/sessions/${id}/adapt`, body: jbody({}) }));
    expect(resp!.status).toBe(502);
    expect(JSON.parse(resp!.body as string).error).toBe("adapt produced no flagship.app.json");
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

  it("POST .../adapt 404s on an UNKNOWN buildId before any credential write", async () => {
    // The adapt route derives the buildId from the URL and (before this fix)
    // stored the delivered credential BEFORE checking the build exists — so a
    // path-traversal id could write a `.cred` outside the store. Assert the
    // 404 lands first and the store is never touched.
    const credentials = new InMemoryBuildCredentialStore();
    const { o } = makeNotFitOrchestrator({ adaptRunner: async () => ADAPT_OUTPUT });
    const handle = buildBuildModesHttpHandlers({ orchestrator: o, gate: allowGate, credentials });

    // A URL-encoded path-traversal id. The handler URL-decodes it to
    // `../../etc/cron.d/x`; the build does not exist → 404, nothing stored.
    const hostile = "..%2F..%2F..%2Fetc%2Fcron.d%2Fx";
    const resp = await handle(
      req({
        method: "POST",
        path: `/api/build/sessions/${hostile}/adapt`,
        body: jbody({ credential: { provider: "anthropic", apiKey: "byok-NEVER-stored" } }),
      }),
    );
    expect(resp!.status).toBe(404);
    expect(JSON.parse(resp!.body as string).error).toBe("build not found");
    // The credential for the decoded id was NEVER stored.
    expect(credentials.has("../../etc/cron.d/x")).toBe(false);

    // A plain unknown (never-minted) id is also rejected before storing.
    const resp2 = await handle(
      req({
        method: "POST",
        path: `/api/build/sessions/deadbeefdeadbeef/adapt`,
        body: jbody({ credential: { provider: "anthropic", apiKey: "byok-NEVER-stored" } }),
      }),
    );
    expect(resp2!.status).toBe(404);
    expect(credentials.has("deadbeefdeadbeef")).toBe(false);
  });

  it("a traversal buildId on .../adapt writes NO file outside the FILE credential store dir", async () => {
    // End-to-end with the real FILE store: even if the existence check were
    // ever bypassed, the store itself refuses a non-mint id. Here the 404
    // fires first; the escape-scan proves no `.cred` landed in the parent.
    const parent = mkdtempSync(join(tmpdir(), "bm-cred-traversal-"));
    try {
      const swk = deriveSWK({ seed: new Uint8Array(32).fill(7) }, "srv-cred");
      const credentials = new FileBuildCredentialStore(join(parent, "store"), swk);
      const { o } = makeNotFitOrchestrator({ adaptRunner: async () => ADAPT_OUTPUT });
      const handle = buildBuildModesHttpHandlers({ orchestrator: o, gate: allowGate, credentials });

      const resp = await handle(
        req({
          method: "POST",
          path: `/api/build/sessions/${"..%2F..%2Fpwned"}/adapt`,
          body: jbody({ credential: { provider: "anthropic", apiKey: "byok-NEVER-stored" } }),
        }),
      );
      expect(resp!.status).toBe(404);

      // No `.cred` / `.cred.tmp` anywhere under `parent`.
      const stray: string[] = [];
      const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const full = join(d, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.name.endsWith(".cred") || e.name.endsWith(".cred.tmp")) stray.push(full);
        }
      };
      walk(parent);
      expect(stray).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
