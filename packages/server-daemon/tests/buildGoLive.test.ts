/**
 * An AI build's two phases (docs/ai-privacy-and-staging.md §2): the AI
 * deploys to and tests a private staging copy, then on finish the box SEALS
 * the build (AI key forgotten, IDE key revoked, every tool refusing) before
 * it puts the tested image live. The AI never learns the live address or how
 * going live went, and a live service is never attached to an AI session.
 */

import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatRequest, ChatResponse, ToolUseBlock } from "@flagship/llm-providers";
import { BuildOrchestrator } from "../src/buildmodes/buildOrchestrator.js";
import { GitImporter } from "../src/buildmodes/gitImport.js";
import { InMemoryBuildJournal } from "../src/buildmodes/buildJournal.js";
import { InMemoryMcpKeyStore } from "../src/buildmodes/mcpKeyStore.js";
import { InMemoryBuildCredentialStore } from "../src/llm/buildCredentialStore.js";
import { buildModelRedactor } from "../src/llm/modelPrivacy.js";
import type { DeployResult } from "../src/buildmodes/deployArtifact.js";
import { FakeStaging } from "./helpers/fakeStaging.js";
import { environmentFailure } from "../src/buildmodes/environmentFailure.js";

const FQDN = "home3.plucky-avocet.flagship.services";
const MANIFEST = JSON.stringify({
  schema_version: 1,
  name: "notes",
  version: "0.1.0",
  description: "Notes",
  runtime: { image: "flagship/notes:0.1.0", port: 8080 },
  network: { subdomain: "notes" },
  access: { enabled: true, default_role: "member", public_routes: ["/"] },
  migration: { verification: "standard" },
});
const NOT_FIT = { "package.json": JSON.stringify({ name: "notes" }), "index.js": "require('http').createServer().listen(3000)" };

function tu(id: string, name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { id, name, input };
}

function clone(files: Record<string, string>) {
  return async ({ dest }: { dest: string }) => {
    for (const [path, content] of Object.entries(files)) {
      const full = join(dest, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
    }
  };
}

function setup(opts: { files?: Record<string, string>; script?: ChatResponse[]; installFails?: string } = {}) {
  const journal = new InMemoryBuildJournal();
  const mcpKeys = new InMemoryMcpKeyStore();
  const credentials = new InMemoryBuildCredentialStore();
  const staging = new FakeStaging();
  // The copy answers with the box's own address in its page and logs: the
  // model must still never see it.
  staging.check = () => ({ ok: true, status: 200, contentType: "text/html", body: `<a href="https://notes.${FQDN}">home</a>`, truncated: false });
  staging.logText = `listening; FLAGSHIP_HOST=${FQDN}`;
  const events: string[] = staging.events;
  const installs: Array<{ image: string; editsServiceId?: string; files: Record<string, string> }> = [];
  const direct: Array<{ files: Record<string, string> }> = [];
  const requests: ChatRequest[] = [];
  const script = [...(opts.script ?? [])];
  const o = new BuildOrchestrator({
    journal,
    gitImporter: new GitImporter({
      cmd: { run: async () => {} },
      workingDir: mkdtempSync(join(tmpdir(), "golive-")),
      journal,
      cloneInto: clone(opts.files ?? NOT_FIT),
    }),
    mcpKeys,
    serverFqdn: FQDN,
    mcpBaseUrl: `https://${FQDN}`,
    modelRedactor: buildModelRedactor(() => ({ username: "plucky-avocet", serverFqdn: FQDN })),
    staging,
    names: () => ({ registry: { holderOf: () => undefined }, hostUsername: "plucky-avocet", installed: null }),
    ownerEnvNames: async (id) => (id === "plucky-avocet--notes" ? ["STRIPE_KEY"] : []),
    editableService: async (serviceId) => ({ ok: true, serviceId, slug: "notes", files: { "flagship.app.json": MANIFEST, Dockerfile: "FROM node:20" }, bytes: 1 }),
    forgetCredential: async (id) => {
      events.push(`forget:${id}`);
      await credentials.forget(id);
    },
    adaptCredentialAvailable: (id) => credentials.has(id),
    deployArtifact: async (a): Promise<DeployResult> => {
      events.push("direct-install");
      direct.push({ files: a.files });
      return { ok: true, serviceId: "plucky-avocet--notes", url: `https://notes.${FQDN}`, image: "rebuilt" };
    },
    installArtifact: async (a): Promise<DeployResult> => {
      events.push(`install:${a.image}`);
      installs.push({ image: a.image, files: a.files, ...(a.editsServiceId ? { editsServiceId: a.editsServiceId } : {}) });
      if (opts.installFails) return { ok: false, reason: opts.installFails };
      return { ok: true, serviceId: "plucky-avocet--notes", url: `https://notes.${FQDN}`, image: a.image };
    },
    agentRunner: async (_id, req) => {
      requests.push(JSON.parse(JSON.stringify(req)) as ChatRequest);
      return script.shift() ?? { content: "done", model: "m" };
    },
  });
  return { o, journal, mcpKeys, credentials, staging, events, installs, direct, requests, script };
}

const ADAPT_AND_TEST: ChatResponse[] = [
  { content: "", model: "m", toolUses: [tu("1", "write_file", { path: "flagship.app.json", content: MANIFEST }), tu("2", "write_file", { path: "Dockerfile", content: "FROM node:20" })] },
  { content: "", model: "m", toolUses: [tu("3", "validate"), tu("4", "deploy")] },
  { content: "", model: "m", toolUses: [tu("5", "check_app", { path: "/" }), tu("6", "get_logs")] },
  { content: "", model: "m", toolUses: [tu("7", "finish")] },
];

async function gitBuild(s: ReturnType<typeof setup>) {
  const r = await s.o.createGit({ gitUrl: "https://github.com/me/notes" });
  if ("error" in r) throw new Error(r.error);
  await s.credentials.put(r.buildId, { provider: "openai", apiKey: "sk-test-key-123456789" });
  return r.buildId;
}

describe("staging, then live", () => {
  it("finish seals the build (AI key forgotten) before the tested image goes live, and the AI learns nothing of it", async () => {
    const s = setup({ script: [...ADAPT_AND_TEST] });
    const id = await gitBuild(s);
    const r = await s.o.adaptGit(id);
    expect(r).toMatchObject({ ok: true, deployed: true, deployedUrl: `https://notes.${FQDN}`, serviceId: "plucky-avocet--notes" });

    // Sealed first, the copy removed, then the SAME staged image installed.
    const image = s.staging.lastImage(id);
    expect(s.events.filter((e) => !e.startsWith("stage:"))).toEqual([`forget:${id}`, `teardown:${id}`, `install:${image}`, `forget-copy:${id}`]);
    expect(s.staging.staged(id)).toBeNull();
    expect(s.direct).toEqual([]);
    expect(s.credentials.has(id)).toBe(false);
    expect(s.o.state(id)!.sealed).toBe(true);
    expect((await s.journal.read(id)).some((e) => e.kind === "sealed")).toBe(true);

    // The staging copy got placeholder env for the owner's set names.
    expect(s.staging.stages[0]).toMatchObject({ slug: "notes", envNames: ["STRIPE_KEY"] });
    // check_app / get_logs only reached this build's copy, and came back redacted.
    expect(s.staging.checks.map((c) => c.buildId)).toEqual([id]);
    const seen = JSON.stringify(s.requests);
    expect(seen).toContain("app.example");
    expect(seen).not.toMatch(/plucky|avocet|home3|[a-z0-9-]\.flagship\.services/);
    expect(seen).not.toMatch(/live at|updated at/);
    // No model call after finish: the loop ended there.
    expect(s.requests).toHaveLength(4);
    expect(s.script).toHaveLength(0);

    // A sealed (and live) build never takes an AI again.
    expect(await s.o.adaptGit(id)).toEqual({ ok: false, reason: expect.stringMatching(/closed to the AI/) });
    expect(s.o.startAdaptGit(id)).toMatchObject({ ok: false, status: 409 });
  });

  it("a failed go-live is the owner's to see, never the AI's", async () => {
    const s = setup({ script: [...ADAPT_AND_TEST], installFails: "migration 0001_init.sql failed: boom" });
    const id = await gitBuild(s);
    const r = await s.o.adaptGit(id);
    expect(r).toMatchObject({ ok: true, deployed: false, reason: "migration 0001_init.sql failed: boom" });
    expect(s.requests).toHaveLength(4);
    expect(JSON.stringify(s.requests)).not.toContain("boom");
    expect(s.o.state(id)!.sealed).toBe(true);
  });

  it("a loop that stops on a tested copy of its files still goes live; one that changed them after doesn't", async () => {
    const stops = setup({ script: ADAPT_AND_TEST.slice(0, 3) });
    const id = await gitBuild(stops);
    expect(await stops.o.adaptGit(id)).toMatchObject({ deployed: true });
    expect(stops.installs).toHaveLength(1);

    const changed = setup({
      script: [...ADAPT_AND_TEST.slice(0, 2), { content: "", model: "m", toolUses: [tu("x", "write_file", { path: "index.js", content: "changed" })] }],
    });
    const id2 = await gitBuild(changed);
    expect(await changed.o.adaptGit(id2)).toMatchObject({ ok: true, deployed: false });
    expect(changed.installs).toHaveLength(0);
    expect(changed.direct).toHaveLength(0);
    expect(changed.staging.teardowns).toContain(id2);
    expect(changed.o.state(id2)!.sealed).toBeUndefined();
  });

  it("finish is refused until the current files are deployed", async () => {
    const s = setup({
      script: [
        { content: "", model: "m", toolUses: [tu("1", "write_file", { path: "flagship.app.json", content: MANIFEST }), tu("2", "finish")] },
        { content: "", model: "m", toolUses: [tu("3", "deploy"), tu("4", "write_file", { path: "x.txt", content: "y" }), tu("5", "finish")] },
        { content: "", model: "m", toolUses: [tu("6", "deploy"), tu("7", "finish")] },
      ],
    });
    const id = await gitBuild(s);
    await s.o.adaptGit(id);
    const results = s.requests.slice(1).flatMap((q) => q.messages.at(-1)?.toolResults ?? []);
    const finishes = results.filter((t) => t.name === "finish");
    expect(finishes.map((f) => f.isError === true)).toEqual([true, true]);
    expect(finishes[0]!.content).toMatch(/deploy first/);
    expect(finishes[1]!.content).toMatch(/files changed since the last deploy/);
    expect(s.installs).toHaveLength(1);
    expect(s.installs[0]!.files["x.txt"]).toBe("y");
  });

  it("the owner's own Install of a Flagship-ready repo stays a direct install, with no staging and no seal", async () => {
    const s = setup({ files: { "flagship.app.json": MANIFEST, Dockerfile: "FROM node:20" } });
    const id = await gitBuild(s);
    const d = await s.o.deploy(id);
    expect(d.ok).toBe(true);
    expect(s.direct).toHaveLength(1);
    expect(s.staging.stages).toHaveLength(0);
    expect(s.installs).toHaveLength(0);
    expect(s.credentials.has(id)).toBe(true);
    expect(s.o.state(id)!.sealed).toBeUndefined();
  });
});

describe("IDE builds and edits", () => {
  async function ideCall(o: BuildOrchestrator, key: string, name: string, args: Record<string, unknown> = {}) {
    const r = await o.handleMcpRpc(key, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    if (!r.authed) return { authed: false as const };
    const result = r.response!.result as { content: Array<{ text: string }>; isError?: boolean };
    return { authed: true as const, text: result.content[0]!.text, isError: result.isError === true };
  }

  const settle = async (cond: () => boolean) => {
    for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
  };

  it("an edit stages a copy (never the live service) and, on finish, redeploys the live one with the tested image", async () => {
    const s = setup();
    const created = await s.o.createMcp({ editServiceId: "plucky-avocet--notes" });
    if ("error" in created) throw new Error(created.error);
    const { buildId, connection } = created;
    await ideCall(s.o, connection.key, "write_file", { path: "index.js", content: "v2" });
    expect((await ideCall(s.o, connection.key, "deploy")).text).toBe(JSON.stringify({ ok: true }));
    expect(s.staging.stages[0]).toMatchObject({ buildId, slug: "notes", carryBinariesFrom: "plucky-avocet--notes", envNames: ["STRIPE_KEY"] });
    // Nothing touched the live service while the IDE worked.
    expect(s.installs).toEqual([]);
    expect(s.direct).toEqual([]);

    const logs = await ideCall(s.o, connection.key, "get_logs");
    expect(logs.text).toBe("listening; FLAGSHIP_HOST=app.example");
    const f = await ideCall(s.o, connection.key, "finish");
    expect(f.isError).toBe(false);

    // Sealed before going live: the IDE key no longer opens anything.
    expect(await s.mcpKeys.get(buildId)).toBeNull();
    for (const name of ["deploy", "check_app", "get_logs", "read_file"]) {
      expect((await ideCall(s.o, connection.key, name, { path: "/" })).authed).toBe(false);
    }
    await settle(() => s.installs.length > 0);
    expect(s.installs).toEqual([
      expect.objectContaining({ image: s.staging.lastImage(buildId), editsServiceId: "plucky-avocet--notes" }),
    ]);
    const forgot = s.events.indexOf(`forget:${buildId}`);
    expect(forgot).toBeGreaterThanOrEqual(0);
    expect(forgot).toBeLessThan(s.events.indexOf(`install:${s.staging.lastImage(buildId)}`));
    expect(s.o.state(buildId)!.adapt).toMatchObject({ status: "done", deployed: true, serviceId: "plucky-avocet--notes" });
  });

  it("a sealed IDE build stays closed after a restart, even if its key survived", async () => {
    const s = setup();
    const created = await s.o.createMcp();
    if ("error" in created) throw new Error(created.error);
    await ideCall(s.o, created.connection.key, "write_file", { path: "flagship.app.json", content: MANIFEST });
    await ideCall(s.o, created.connection.key, "deploy");
    await ideCall(s.o, created.connection.key, "finish");
    await settle(() => s.installs.length > 0);

    // A new daemon over the same journal; the key was somehow not revoked.
    const leaked = await s.mcpKeys.mint(created.buildId);
    const restarted = new BuildOrchestrator({
      journal: s.journal,
      gitImporter: new GitImporter({ cmd: { run: async () => {} }, workingDir: mkdtempSync(join(tmpdir(), "golive-")) }),
      mcpKeys: s.mcpKeys,
      serverFqdn: FQDN,
      staging: s.staging,
      deployArtifact: async () => ({ ok: false, reason: "unused" }),
    });
    expect((await ideCall(restarted, leaked.key, "deploy")).authed).toBe(false);
    expect(await s.mcpKeys.get(created.buildId)).toBeNull();
    expect(restarted.isSealed(created.buildId)).toBe(true);
  });
});

describe("the server's own failures (docs/ai-privacy-and-staging.md §2)", () => {
  const DOWN = {
    ok: false as const,
    reason: "data provisioning failed: connect ECONNREFUSED 127.0.0.1:5432",
    environment: environmentFailure("data-layer"),
  };

  it("a git adapt stops at the first one: no more model turns, nothing live, the owner's reason", async () => {
    const s = setup({
      script: [
        ...ADAPT_AND_TEST.slice(0, 2),
        { content: "", model: "m", toolUses: [tu("9", "delete_file", { path: "flagship.app.json" })] },
      ],
    });
    s.staging.results = [DOWN];
    const id = await gitBuild(s);
    const r = await s.o.adaptGit(id);
    expect(r).toEqual({ ok: false, reason: environmentFailure("data-layer").ownerReason });
    expect(s.requests).toHaveLength(2);
    expect(s.installs).toEqual([]);
    expect(s.o.workspace(id)!.read("flagship.app.json")).toBe(MANIFEST);
    expect(s.staging.teardowns).toContain(id);
    const journal = await s.journal.read(id);
    expect(journal.some((e) => e.kind === "error" && /database isn't running/.test(e.summary))).toBe(true);
  });

  it("an IDE is told it's the server's problem and to stop, and the owner sees it on the build", async () => {
    const s = setup();
    const created = await s.o.createMcp();
    if ("error" in created) throw new Error(created.error);
    const { buildId, connection } = created;
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await s.o.handleMcpRpc(connection.key, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      return r.response!.result as { content: Array<{ text: string }>; isError?: boolean };
    };
    await call("write_file", { path: "flagship.app.json", content: MANIFEST });
    s.staging.results = [DOWN];
    const r = await call("deploy");
    expect(r.isError).toBe(true);
    const text = r.content[0]!.text;
    expect(text).toMatch(/nothing in the app's files caused it/);
    expect(text).toMatch(/Don't change or delete any files/);
    expect(text).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
    expect(s.o.state(buildId)!.adapt).toEqual({ status: "failed", reason: environmentFailure("data-layer").ownerReason });
    // Once the server works again, a good deploy clears it.
    expect((await call("deploy")).isError).toBeFalsy();
    expect(s.o.state(buildId)!.adapt).toBeUndefined();
  });
});
