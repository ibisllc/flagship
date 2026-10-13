/**
 * The owner's Deploy of an AI chat goes through staging too
 * (docs/ai-privacy-and-staging.md §2): the chat's files run as a private
 * copy first; a copy that won't start goes to the same staged agent loop
 * (the session's own AI fixes it there); then the session is sealed and the
 * tested image goes live with no rebuild.
 */

import { describe, expect, it } from "vitest";
import type { ChatRequest, ChatResponse, ToolUseBlock } from "@flagship/llm-providers";
import { TokenSetSessionGate } from "../../src/alertInboxHttp.js";
import { buildStagedChatDeploy, type DeploySessionOverride } from "../../src/llm/deploySession.js";
import { buildVibeCodeHttpHandlers } from "../../src/llm/vibeCodeHttp.js";
import { VibeCodeSession, VibeCodeSessionRegistry } from "../../src/llm/vibeCodeSession.js";
import { InMemoryBuildCredentialStore } from "../../src/llm/buildCredentialStore.js";
import { InMemoryBuildJournal } from "../../src/buildmodes/buildJournal.js";
import { buildModelRedactor } from "../../src/llm/modelPrivacy.js";
import type { HttpRequest } from "../../src/runtime.js";
import { FakeStaging } from "../helpers/fakeStaging.js";
import { environmentFailure } from "../../src/buildmodes/environmentFailure.js";

const SERVER = "home.alice.flagship.services";
const MANIFEST = JSON.stringify({
  schema_version: 1,
  name: "habits",
  version: "0.1.0",
  runtime: { base: "static", image: "x", port: 8080 },
  access: { enabled: true, default_role: "owner" },
});

function fill(session: VibeCodeSession, files: Record<string, string>): VibeCodeSession {
  session.pushUserMessage("a habit tracker");
  let stream = "";
  for (const [p, c] of Object.entries(files)) stream += `=== ${p} ===\n${c}\n`;
  session.feedAssistant(`${stream}=== END ===\n`);
  session.endAssistant();
  return session;
}

function tu(id: string, name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { id, name, input };
}

function setup(script: ChatResponse[] = []) {
  const staging = new FakeStaging();
  const credentials = new InMemoryBuildCredentialStore();
  const journal = new InMemoryBuildJournal();
  const events = staging.events;
  const installs: Array<{ override: DeploySessionOverride }> = [];
  const requests: ChatRequest[] = [];
  const phases: string[] = [];
  const deploy = buildStagedChatDeploy({
    deploy: async (session, override) => {
      events.push(`install:${override.image ?? "rebuild"}`);
      installs.push({ override });
      return { ok: true, serviceId: "alice--habits", url: `https://habits.${SERVER}`, image: override.image ?? "x" };
    },
    staging,
    journal,
    agentRunner: async (_id, req) => {
      requests.push(JSON.parse(JSON.stringify(req)) as ChatRequest);
      return script.shift() ?? { content: "done", model: "m" };
    },
    hasCredential: (id) => credentials.has(id),
    forgetCredential: async (id) => {
      events.push(`forget:${id}`);
      await credentials.forget(id);
    },
    redact: buildModelRedactor(() => ({ username: "alice", serverFqdn: SERVER })),
    envNames: async () => ["OPENAI_KEY"],
    hostUsername: "alice",
  });
  return { deploy, staging, credentials, journal, events, installs, requests, phases, script };
}

const FILES = { "flagship.app.json": MANIFEST, Dockerfile: "FROM node:20\nCMD node server.js", "server.js": "listen(3000)" };

describe("a chat's Deploy", () => {
  it("stages first and, when the copy starts, seals and installs that image without asking the AI", async () => {
    const s = setup();
    const session = fill(new VibeCodeSession({ username: "alice", serverFqdn: SERVER }), FILES);
    const id = session.meta.sessionId;
    await s.credentials.put(id, { provider: "openai", apiKey: "sk-test-key-123456789" });
    const r = await s.deploy(session, { onPhase: (p) => s.phases.push(p) });
    expect(r).toMatchObject({ ok: true, url: `https://habits.${SERVER}` });
    expect(s.phases).toEqual(["staging", "going-live"]);
    expect(s.requests).toHaveLength(0);
    expect(s.staging.stages[0]).toMatchObject({ buildId: id, slug: "habits", envNames: ["OPENAI_KEY"] });
    const image = s.staging.lastImage(id);
    expect(s.events).toEqual([`stage:${id}`, `forget:${id}`, `teardown:${id}`, `install:${image}`, `forget-copy:${id}`]);
    expect(s.installs[0]!.override.files).toEqual(session.files());
    expect(s.credentials.has(id)).toBe(false);
  });

  it("runs the staged agent loop when the copy won't start: the AI fixes it there, then the fixed, tested image goes live", async () => {
    const s = setup([
      { content: "", model: "m", toolUses: [tu("1", "read_file", { path: "server.js" }), tu("2", "get_logs")] },
      { content: "", model: "m", toolUses: [tu("3", "write_file", { path: "server.js", content: "listen(process.env.PORT)" }), tu("4", "deploy")] },
      { content: "", model: "m", toolUses: [tu("5", "check_app", { path: "/" }), tu("6", "finish")] },
    ]);
    s.staging.results = [{ ok: false, reason: `the app didn't start: it stopped (exit code 1). Its last output:\nEADDRINUSE on habits.${SERVER}` }];
    const session = fill(new VibeCodeSession({ username: "alice", serverFqdn: SERVER }), FILES);
    const id = session.meta.sessionId;
    await s.credentials.put(id, { provider: "openai", apiKey: "sk-test-key-123456789" });

    const r = await s.deploy(session, { onPhase: (p) => s.phases.push(p) });
    expect(r.ok).toBe(true);
    expect(s.phases).toEqual(["staging", "fixing", "going-live"]);
    expect(s.requests).toHaveLength(3);
    // The AI was told why, with the box's address taken out, and nothing after finish.
    const first = String(s.requests[0]!.messages[1]!.content);
    expect(first).toMatch(/EADDRINUSE on app\.example/);
    expect(JSON.stringify(s.requests)).not.toMatch(/alice/);
    // Two stagings (the box's, then the AI's), sealed, then the tested image with the fix.
    const image = s.staging.lastImage(id);
    expect(s.staging.stages).toHaveLength(2);
    expect(s.events.slice(-4)).toEqual([`forget:${id}`, `teardown:${id}`, `install:${image}`, `forget-copy:${id}`]);
    expect(s.installs[0]!.override).toMatchObject({ image, files: { "server.js": "listen(process.env.PORT)" } });
    expect(session.files()["server.js"]).toBe("listen(process.env.PORT)");
  });

  it("hands a manifest that names no runtime to the AI to fix, instead of failing the owner's Deploy", async () => {
    const fixed = JSON.stringify({ ...JSON.parse(MANIFEST), runtime: { base: "static", port: 8080 } });
    const s = setup([
      { content: "", model: "m", toolUses: [tu("1", "write_file", { path: "flagship.app.json", content: fixed }), tu("2", "deploy")] },
      { content: "", model: "m", toolUses: [tu("3", "finish")] },
    ]);
    const noBase = JSON.stringify({ ...JSON.parse(MANIFEST), runtime: { image: "x", port: 8080 } });
    const session = fill(new VibeCodeSession({ username: "alice", serverFqdn: SERVER }), { ...FILES, "flagship.app.json": noBase });
    await s.credentials.put(session.meta.sessionId, { provider: "openai", apiKey: "sk-test-key-123456789" });
    const r = await s.deploy(session, { onPhase: (p) => s.phases.push(p) });
    expect(r.ok).toBe(true);
    expect(s.phases).toEqual(["staging", "fixing", "going-live"]);
    expect(String(s.requests[0]!.messages[1]!.content)).toMatch(/set runtime\.base in flagship\.app\.json to one of node-24, python-3\.13, static/);
    // Only the AI's fixed copy was ever staged.
    expect(s.staging.stages).toHaveLength(1);
    expect(JSON.parse(session.files()["flagship.app.json"]!).runtime.base).toBe("static");
  });

  it("without an AI key, a copy that won't start is just the failure: nothing goes live", async () => {
    const s = setup();
    s.staging.results = [{ ok: false, reason: "docker build failed: npm ERR!" }];
    const session = fill(new VibeCodeSession({ username: "alice", serverFqdn: SERVER }), FILES);
    expect(await s.deploy(session)).toEqual({ ok: false, reason: "docker build failed: npm ERR!" });
    expect(s.installs).toHaveLength(0);
    expect(s.staging.teardowns).toEqual([session.meta.sessionId]);
  });

  it("over HTTP: older apps still get {ok, serviceId, url}; `background` answers at once and the session carries the phase", async () => {
    const registry = new VibeCodeSessionRegistry();
    const gate = new TokenSetSessionGate(new Set(["t"]));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const seenPhases: Array<string | undefined> = [];
    const handle = buildVibeCodeHttpHandlers({
      registry,
      gate,
      username: "alice",
      serverFqdn: SERVER,
      deploySession: async (session, opts) => {
        opts?.onPhase?.("going-live");
        seenPhases.push(session.meta.deployPhase);
        await held;
        return { ok: true, serviceId: "alice--habits", url: `https://habits.${SERVER}` };
      },
    });
    const call = (path: string, body?: object): HttpRequest => ({
      method: "POST",
      path,
      headers: { authorization: "Flagship-Session t" },
      body: body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0),
    });
    const created = await handle(call("/api/llm/sessions", { prompt: "x" }));
    const sid = JSON.parse(String(created!.body)).sessionId as string;
    const started = await handle(call(`/api/llm/sessions/${sid}/deploy`, { background: true }));
    expect(started!.status).toBe(202);
    expect(JSON.parse(String(started!.body))).toEqual({ ok: true, started: true });
    expect(registry.get(sid)!.meta).toMatchObject({ status: "deploying", deployPhase: "going-live" });
    expect((await handle(call(`/api/llm/sessions/${sid}/deploy`)))!.status).toBe(409);
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(registry.get(sid)!.meta).toMatchObject({ status: "deployed", url: `https://habits.${SERVER}` });
    expect(registry.get(sid)!.meta.deployPhase).toBeUndefined();
    expect(seenPhases).toEqual(["going-live"]);

    const other = await handle(call("/api/llm/sessions", { prompt: "y" }));
    const sid2 = JSON.parse(String(other!.body)).sessionId as string;
    const sync = await handle(call(`/api/llm/sessions/${sid2}/deploy`));
    expect(sync!.status).toBe(200);
    expect(JSON.parse(String(sync!.body))).toEqual({ ok: true, serviceId: "alice--habits", url: `https://habits.${SERVER}` });
  });
});

describe("a chat's Deploy when the server itself is broken", () => {
  const DOWN = {
    ok: false as const,
    reason: "data provisioning failed: connect ECONNREFUSED 127.0.0.1:5432",
    environment: environmentFailure("data-layer"),
  };

  it("fails at once with the owner's reason and never starts the AI", async () => {
    const s = setup([{ content: "", model: "m", toolUses: [tu("1", "delete_file", { path: "migrations/0001.sql" })] }]);
    s.staging.results = [DOWN];
    const session = fill(new VibeCodeSession({ username: "alice", serverFqdn: SERVER }), { ...FILES, "migrations/0001.sql": "CREATE TABLE t (id int);" });
    const id = session.meta.sessionId;
    await s.credentials.put(id, { provider: "openai", apiKey: "sk-test-key-123456789" });
    const r = await s.deploy(session);
    expect(r).toEqual({ ok: false, reason: environmentFailure("data-layer").ownerReason });
    expect(s.requests).toHaveLength(0);
    expect(s.installs).toHaveLength(0);
    expect(session.files()["migrations/0001.sql"]).toMatch(/^CREATE TABLE t/);
  });

  it("stops the fixing loop the moment the server breaks, before the AI sees it or changes another file", async () => {
    const s = setup([
      { content: "", model: "m", toolUses: [tu("1", "write_file", { path: "server.js", content: "listen(process.env.PORT)" }), tu("2", "deploy")] },
      { content: "", model: "m", toolUses: [tu("3", "delete_file", { path: "migrations/0001.sql" })] },
    ]);
    s.staging.results = [{ ok: false, reason: "the app didn't start: it stopped (exit code 1)." }, DOWN];
    const session = fill(new VibeCodeSession({ username: "alice", serverFqdn: SERVER }), { ...FILES, "migrations/0001.sql": "CREATE TABLE t (id int);" });
    const id = session.meta.sessionId;
    await s.credentials.put(id, { provider: "openai", apiKey: "sk-test-key-123456789" });
    const r = await s.deploy(session);
    expect(r).toEqual({ ok: false, reason: environmentFailure("data-layer").ownerReason });
    // One model turn: the deploy's failure never went back to it.
    expect(s.requests).toHaveLength(1);
    expect(s.installs).toHaveLength(0);
    expect(session.files()["migrations/0001.sql"]).toMatch(/^CREATE TABLE t/);
    expect(s.staging.teardowns).toContain(id);
  });
});
