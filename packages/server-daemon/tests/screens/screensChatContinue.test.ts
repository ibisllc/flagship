/**
 * Continuing a build chat and switching model or provider in it
 * (docs/build-modes.md "Continuing a chat"): a ready-to-deploy or failed chat
 * takes a new owner message; a running, deploying, deployed or stopped one
 * doesn't; a message from another provider replaces the session's key, picks
 * that provider's model and drops an effort the new model doesn't take; a
 * smaller context compacts; and no key reaches a response, the journal or a
 * log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatRequest, ChatStreamEvent } from "@flagship/llm-providers";
import { buildScreensHttp } from "../../src/screens/screensHttp.js";
import {
  HIDDEN_NOTE_PREFIX,
  VibeCodeSessionRegistry,
  fileVibeCodeSessionStore,
  type VibeCodeSession,
} from "../../src/llm/vibeCodeSession.js";
import { InMemoryBuildCredentialStore } from "../../src/llm/buildCredentialStore.js";
import { buildVibeCodeResumeStreaming } from "../../src/llm/vibeCodeStartStreaming.js";
import { InMemoryAppEnvStore } from "../../src/serviceEnvStore.js";
import type { HttpRequest } from "../../src/runtime.js";
import type { LlmCredential, LlmHarness } from "../../src/llmHarness.js";

const SERVER_FQDN = "home.alice.flagship.services";
const OLD_KEY = "sk-old-DO-NOT-LEAK-1111111111";
const NEW_KEY = "sk-new-DO-NOT-LEAK-2222222222";

function post(path: string, body: unknown): HttpRequest {
  return {
    method: "POST",
    path,
    headers: { "x-flagship-session": "tok", "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)),
  };
}
const get = (path: string): HttpRequest => ({ method: "GET", path, headers: { "x-flagship-session": "tok" }, body: Buffer.alloc(0) });

interface Resumed {
  sessionId: string;
  switched: boolean;
}

function build(opts: { registry?: VibeCodeSessionRegistry } = {}) {
  const reg = opts.registry ?? new VibeCodeSessionRegistry();
  const credentials = new InMemoryBuildCredentialStore();
  const resumed: Resumed[] = [];
  const journal: unknown[] = [];
  const handle = buildScreensHttp({
    gate: {
      has: () => true,
      check: (r: HttpRequest) => (r.headers["x-flagship-session"] === "tok" ? null : { status: 401, headers: {}, body: "{}" }),
    },
    serverFqdn: SERVER_FQDN,
    username: "alice",
    daemonVersion: "test",
    startedAt: 0,
    vibeCode: {
      registry: reg,
      username: "alice",
      serverFqdn: SERVER_FQDN,
      credentials,
      startStreaming: async () => {},
      resumeStreaming: async (sessionId, _model, o) => void resumed.push({ sessionId, switched: o?.switched === true }),
      recordScratchTurn: (a) => void journal.push(a),
      onProviderSwitched: (a) => void journal.push(a),
    },
  });
  return { reg, credentials, handle, resumed, journal };
}

/** A chat that wrote an app and is ready to deploy. */
async function readyChat(h: ReturnType<typeof build>, cred: LlmCredential = { provider: "openai", apiKey: OLD_KEY }): Promise<VibeCodeSession> {
  const s = h.reg.create({ username: "alice", serverFqdn: SERVER_FQDN, name: "habits" });
  s.pushUserMessage("a habit tracker");
  await h.credentials.put(s.meta.sessionId, cred);
  s.setProvider(cred.provider);
  s.feedAssistant("=== flagship.app.json ===\n{\"name\":\"habits\"}\n=== server.js ===\nconsole.log(1)\n=== END ===\n");
  s.endAssistant();
  expect(s.meta.status).toBe("ready-to-deploy");
  return s;
}

const reply = (h: ReturnType<typeof build>, id: string, body: unknown) =>
  h.handle(post(`/api/screens/llm/sessions/${id}/reply`, body));

describe("continuing a build chat", () => {
  it("reopens a ready-to-deploy chat with a new message, keeping its files", async () => {
    const h = build();
    const s = await readyChat(h);
    const before = (JSON.parse((await h.handle(get(`/api/screens/llm/sessions/${s.meta.sessionId}`)))!.body as string));
    expect(before.canContinue).toBe(true);
    expect(before.provider).toBe("openai");
    expect(before.conversationTokens).toBeGreaterThan(0);

    const r = await reply(h, s.meta.sessionId, { text: "make the buttons bigger" });
    expect(r?.status).toBe(200);
    expect(s.meta.status).toBe("streaming");
    expect(Object.keys(s.files())).toEqual(["flagship.app.json", "server.js"]);
    expect(h.resumed).toEqual([{ sessionId: s.meta.sessionId, switched: false }]);
    // The owner sees their message; the box's note to the model stays hidden.
    expect(s.messages().map((m) => m.text)).toEqual([
      "a habit tracker",
      expect.stringContaining("=== END ==="),
      "make the buttons bigger",
    ]);
    const note = s.conversation().find((m) => m.content.startsWith(`${HIDDEN_NOTE_PREFIX}continue]`));
    expect(note?.content).toContain("hasn't deployed this yet");
  });

  it("continues a failed chat and tells the model why it stopped", async () => {
    const h = build();
    const s = await readyChat(h);
    s.fail("the app didn't start: port 3000 is already in use", true);
    const r = await reply(h, s.meta.sessionId, { text: "try another port" });
    expect(r?.status).toBe(200);
    expect(s.meta.status).toBe("streaming");
    expect(s.meta.failureReason).toBeUndefined();
    const note = s.conversation().find((m) => m.content.startsWith(`${HIDDEN_NOTE_PREFIX}continue]`));
    expect(note?.content).toContain("port 3000 is already in use");
  });

  it("continues a chat that a restart stopped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vibe-continue-"));
    try {
      const store = fileVibeCodeSessionStore(dir);
      const first = new VibeCodeSessionRegistry(store, { saveDelayMs: 0 });
      const s = first.create({ username: "alice", serverFqdn: SERVER_FQDN });
      s.pushUserMessage("a notes app");
      s.feedAssistant("=== flagship.app.json ===\n{}\n");
      first.flush();
      // The daemon restarts mid-stream.
      const h = build({ registry: new VibeCodeSessionRegistry(store, { saveDelayMs: 0 }) });
      await h.credentials.put(s.meta.sessionId, { provider: "openai", apiKey: OLD_KEY });
      const r = await reply(h, s.meta.sessionId, { text: "carry on" });
      expect(r?.status).toBe(200);
      expect(h.reg.get(s.meta.sessionId)!.meta.status).toBe("streaming");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a message while the chat runs, deploys, once deployed, and when stopped", async () => {
    const h = build();
    const running = h.reg.create({ username: "alice", serverFqdn: SERVER_FQDN });
    running.pushUserMessage("x");
    const deploying = await readyChat(h);
    deploying.markDeploying("staging");
    const deployed = await readyChat(h);
    deployed.markDeployed({ serviceId: "alice--habits", url: "https://habits.example" });
    const stopped = await readyChat(h);
    stopped.cancel();
    for (const [s, words] of [
      [running, "still working"],
      [deploying, "deploying"],
      [deployed, "Change this app"],
      [stopped, "stopped"],
    ] as const) {
      const r = await reply(h, s.meta.sessionId, { text: "more", credential: { provider: "anthropic", apiKey: NEW_KEY } });
      expect(r?.status).toBe(409);
      expect(JSON.parse(r!.body as string).error).toContain(words);
      // A refused message stores no key.
      expect((await h.credentials.get(s.meta.sessionId))?.apiKey).not.toBe(NEW_KEY);
    }
    expect(h.resumed).toEqual([]);
    const state = JSON.parse((await h.handle(get(`/api/screens/llm/sessions/${stopped.meta.sessionId}`)))!.body as string);
    expect(state.canContinue).toBe(false);
  });

  it("asks for a key when a continuable chat has none (a deploy forgot it)", async () => {
    const h = build();
    const s = await readyChat(h);
    await h.credentials.forget(s.meta.sessionId);
    s.fail("couldn't go live", true);
    const state = JSON.parse((await h.handle(get(`/api/screens/llm/sessions/${s.meta.sessionId}`)))!.body as string);
    expect(state.needsCredential).toBe(true);
    const r = await reply(h, s.meta.sessionId, { text: "again", credential: { provider: "openai", apiKey: NEW_KEY } });
    expect(r?.status).toBe(200);
    expect((await h.credentials.get(s.meta.sessionId))?.apiKey).toBe(NEW_KEY);
  });
});

describe("switching model and provider in a chat", () => {
  it("replaces the stored key, takes the new provider's model, and journals the provider name only", async () => {
    const h = build();
    const s = await readyChat(h, { provider: "flagship", apiKey: OLD_KEY, source: "promo" });
    s.setModel("medium", "high");
    const r = await reply(h, s.meta.sessionId, {
      text: "use my own key now",
      model: "gpt-5.4",
      effort: null,
      credential: { provider: "openai", apiKey: NEW_KEY },
    });
    expect(r?.status).toBe(200);
    expect(await h.credentials.get(s.meta.sessionId)).toEqual({ provider: "openai", apiKey: NEW_KEY });
    expect(s.meta).toMatchObject({ provider: "openai", model: "gpt-5.4" });
    expect(s.meta.effort).toBeUndefined();
    expect(h.resumed).toEqual([{ sessionId: s.meta.sessionId, switched: true }]);
    expect(h.journal).toContainEqual({ sessionId: s.meta.sessionId, provider: "openai" });
  });

  it("drops the old provider's model when the switch names none", async () => {
    const h = build();
    const s = await readyChat(h, { provider: "flagship", apiKey: OLD_KEY, source: "promo" });
    s.setModel("medium", "high");
    await reply(h, s.meta.sessionId, { text: "go on", credential: { provider: "anthropic", apiKey: NEW_KEY } });
    expect(s.meta.provider).toBe("anthropic");
    expect(s.meta.model).toBeUndefined();
    expect(s.meta.effort).toBeUndefined();
  });

  it("also switches while answering the AI's question", async () => {
    const h = build();
    const s = h.reg.create({ username: "alice", serverFqdn: SERVER_FQDN });
    s.pushUserMessage("an orders app");
    await h.credentials.put(s.meta.sessionId, { provider: "openai", apiKey: OLD_KEY });
    s.setProvider("openai");
    s.receiveToolUse({ id: "q1", name: "talkToUser", input: { message: "Which currency?" } });
    const r = await reply(h, s.meta.sessionId, { text: "euros", model: "claude-sonnet-5-5", credential: { provider: "anthropic", apiKey: NEW_KEY } });
    expect(r?.status).toBe(200);
    expect(s.meta).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5", status: "streaming" });
    expect(h.resumed[0]?.switched).toBe(true);
  });

  it("never puts a key in a response, the session state, the saved session, the journal or a log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vibe-switch-"));
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" "))),
    );
    try {
      const reg = new VibeCodeSessionRegistry(fileVibeCodeSessionStore(dir), { saveDelayMs: 0 });
      const h = build({ registry: reg });
      const s = await readyChat(h, { provider: "openai", apiKey: OLD_KEY });
      const bodies: string[] = [];
      const r1 = await reply(h, s.meta.sessionId, { text: "switch", model: "claude-sonnet-5-5", credential: { provider: "anthropic", apiKey: NEW_KEY } });
      bodies.push(String(r1!.body));
      s.feedAssistant("ok\n=== END ===\n");
      s.endAssistant();
      bodies.push(String((await h.handle(get(`/api/screens/llm/sessions/${s.meta.sessionId}`)))!.body));
      bodies.push(String((await h.handle(get(`/api/screens/vibe-code/${s.meta.sessionId}`)))!.body));
      // A malformed or refused message doesn't echo the key either.
      bodies.push(String((await reply(h, s.meta.sessionId, { text: "x", credential: { provider: "", apiKey: NEW_KEY } }))!.body));
      s.cancel();
      bodies.push(String((await reply(h, s.meta.sessionId, { text: "x", credential: { provider: "openai", apiKey: NEW_KEY } }))!.body));
      reg.flush();
      const saved = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8"));
      for (const text of [...bodies, ...saved, JSON.stringify(h.journal), JSON.stringify(reg.list()), ...logged]) {
        expect(text).not.toContain(NEW_KEY);
        expect(text).not.toContain(OLD_KEY);
      }
    } finally {
      for (const s of spies) s.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A harness that records each streamed request and answers with `reply`. */
function fakeHarness(reply = "done\n=== END ===\n") {
  const streamed: ChatRequest[] = [];
  const summarised: ChatRequest[] = [];
  const keys: string[] = [];
  const harness = {
    async chatStream(cred: LlmCredential, req: ChatRequest, onEvent: (e: ChatStreamEvent) => void) {
      keys.push(cred.apiKey);
      streamed.push(req);
      onEvent({ kind: "delta", text: reply });
      onEvent({ kind: "end" });
    },
    async chatWithCredential(_cred: LlmCredential, req: ChatRequest) {
      summarised.push(req);
      return { content: "The owner wants a habit tracker; server.js serves it." };
    },
  } as unknown as LlmHarness;
  return { harness, streamed, summarised, keys };
}

describe("resuming after a switch", () => {
  function driver(opts: { efforts?: Record<string, string[] | null>; context?: Record<string, number>; redact?: (t: string) => string } = {}) {
    const reg = new VibeCodeSessionRegistry();
    const credentials = new InMemoryBuildCredentialStore();
    const fake = fakeHarness();
    const resume = buildVibeCodeResumeStreaming({
      registry: reg,
      harness: fake.harness,
      credentials,
      resolveAppId: () => null,
      appEnvStore: new InMemoryAppEnvStore(),
      defaultModels: { openai: "gpt-5", anthropic: "claude-sonnet-5-5" },
      contextTokens: async (_p, m) => opts.context?.[m],
      modelEfforts: async (_p, m) => (opts.efforts && m in opts.efforts ? opts.efforts[m]! : []),
      ...(opts.redact ? { redact: opts.redact } : {}),
    });
    return { reg, credentials, resume, ...fake };
  }

  it("drops an effort the new model doesn't take, and keeps one it does", async () => {
    const d = driver({ efforts: { "gpt-5.4": ["low", "medium", "high"], "small-model": [] } });
    const s = d.reg.create({ username: "alice", serverFqdn: SERVER_FQDN });
    s.pushUserMessage("an app");
    await d.credentials.put(s.meta.sessionId, { provider: "openai", apiKey: NEW_KEY });
    s.setModel("gpt-5.4", "high");
    await d.resume(s.meta.sessionId, undefined, { switched: true });
    expect(d.streamed[0]?.reasoningEffort).toBe("high");
    expect(s.meta.effort).toBe("high");

    s.pushContinuation({ text: "smaller please" });
    s.setModel("small-model");
    await d.resume(s.meta.sessionId, undefined, { switched: true });
    expect(s.meta.effort).toBeUndefined();
    expect(d.streamed[1]?.reasoningEffort).toBeUndefined();
    expect(d.streamed[1]?.model).toBe("small-model");
  });

  it("keeps the effort when the model's levels can't be read", async () => {
    const d = driver({ efforts: { "gpt-5.4": null } });
    const s = d.reg.create({ username: "alice", serverFqdn: SERVER_FQDN });
    s.pushUserMessage("an app");
    await d.credentials.put(s.meta.sessionId, { provider: "openai", apiKey: NEW_KEY });
    s.setModel("gpt-5.4", "high");
    await d.resume(s.meta.sessionId, undefined, { switched: true });
    expect(s.meta.effort).toBe("high");
  });

  it("uses the new key and summarises older turns for a model with a smaller context", async () => {
    const d = driver({ context: { "big-model": 1_000_000, "small-model": 8_000 } });
    const s = d.reg.create({ username: "alice", serverFqdn: SERVER_FQDN });
    s.pushUserMessage("a habit tracker");
    for (let i = 0; i < 8; i++) {
      s.feedAssistant(`=== file${i}.js ===\n${"x".repeat(3_000)}\n=== END ===\n`);
      s.endAssistant();
      s.pushContinuation({ text: `change ${i}` });
    }
    await d.credentials.put(s.meta.sessionId, { provider: "openai", apiKey: OLD_KEY });
    s.setModel("big-model");
    await d.resume(s.meta.sessionId);
    expect(d.summarised).toHaveLength(0);
    expect(s.isCompacted()).toBe(false);

    s.pushContinuation({ text: "now on the small one" });
    await d.credentials.put(s.meta.sessionId, { provider: "anthropic", apiKey: NEW_KEY });
    s.setProvider("anthropic", { keepModel: true });
    s.setModel("small-model");
    await d.resume(s.meta.sessionId, undefined, { switched: true });
    expect(d.keys).toEqual([OLD_KEY, NEW_KEY]);
    expect(d.summarised).toHaveLength(1);
    expect(s.isCompacted()).toBe(true);
  });

  it("redacts the box's note before a model reads it", async () => {
    const d = driver({ redact: (t) => t.replaceAll(SERVER_FQDN, "[server]").replaceAll("alice", "[account]") });
    const s = d.reg.create({ username: "alice", serverFqdn: SERVER_FQDN });
    s.pushUserMessage("an app");
    s.feedAssistant("=== a.js ===\n1\n=== END ===\n");
    s.endAssistant();
    s.fail(`install of alice--app on ${SERVER_FQDN} failed`, true);
    s.pushContinuation({ text: "try again" });
    await d.credentials.put(s.meta.sessionId, { provider: "openai", apiKey: NEW_KEY });
    await d.resume(s.meta.sessionId);
    const sent = JSON.stringify(d.streamed[0]?.messages);
    expect(sent).toContain("[account]--app on [server] failed");
    expect(sent).not.toContain(SERVER_FQDN);
  });
});

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.restoreAllMocks());
