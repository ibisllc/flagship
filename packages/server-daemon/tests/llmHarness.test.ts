import { describe, expect, it } from "vitest";
import { swkOps } from "./helpers/keyCustody.js";
import {
  deriveIRK,
  deriveSWK,
  openLlmPayload,
  sealLlmPayload,
} from "@flagship/protocol";
import {
  anthropicStreaming,
  ProviderRegistry,
  StreamingProviderRegistry,
  type ChatRequest,
  type ChatStreamEvent,
  type FetchLike,
  type LLMProvider,
  type ProviderConfig,
  type StreamingFetchLike,
  type StreamingLLMProvider,
} from "@flagship/llm-providers";
import { LlmHarness, type SealedRequest } from "../src/llmHarness.js";
import { AppMembership } from "../src/membership.js";
import { IdentityInjector } from "../src/identityInjector.js";
import { buildDaemonHttp, type DaemonContext } from "../src/httpApi.js";

const umk = { seed: new Uint8Array(32).fill(7) };
const phoneIrk = deriveIRK(umk);
const swk = deriveSWK(umk, "srv-llm");

function makeProvider(handler: (req: ChatRequest, key: string) => Promise<unknown>): LLMProvider {
  return {
    name: "stub",
    async chat(req, cfg) {
      const out = await handler(req, cfg.apiKey);
      return out as { content: string; model: string };
    },
  };
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function buildSealedRequest(req: SealedRequest) {
  return sealLlmPayload(new TextEncoder().encode(JSON.stringify(req)), swk);
}

describe("LlmHarness — seal/open and provider dispatch", () => {
  it("dispatches to the named provider with the user-supplied key, never to a default", async () => {
    let observedKey = "";
    let observedProvider = "";
    const stub = makeProvider(async (req, key) => {
      observedKey = key;
      observedProvider = "stub";
      return { content: `echo:${req.messages.at(-1)!.content}`, model: req.model };
    });
    const registry = new ProviderRegistry([stub]);
    const harness = new LlmHarness({ swk: swkOps(swk), registry });

    const sealed = buildSealedRequest({
      provider: "stub",
      apiKey: "user-supplied-secret",
      request: { model: "x", messages: [{ role: "user", content: "ping" }] },
    });
    const out = await harness.chat(sealed);
    const opened = openLlmPayload(out, swk);
    const parsed = JSON.parse(new TextDecoder().decode(opened));
    expect(parsed.ok).toBe(true);
    expect(parsed.response.content).toBe("echo:ping");
    expect(observedKey).toBe("user-supplied-secret");
    expect(observedProvider).toBe("stub");
  });

  it("seals errors when the provider name is unknown (no plaintext leak on the wire)", async () => {
    const harness = new LlmHarness({ swk: swkOps(swk), registry: new ProviderRegistry([]) });
    const sealed = buildSealedRequest({
      provider: "made-up",
      apiKey: "x",
      request: { model: "m", messages: [{ role: "user", content: "hi" }] },
    });
    const out = await harness.chat(sealed);
    const opened = openLlmPayload(out, swk);
    const parsed = JSON.parse(new TextDecoder().decode(opened));
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toMatch(/unknown provider/);
  });

  it("seals decrypt-failure messages without leaking which step failed", async () => {
    const harness = new LlmHarness({ swk: swkOps(swk), registry: new ProviderRegistry([]) });
    const out = await harness.chat({ ciphertext: new Uint8Array([1, 2, 3]), nonce: new Uint8Array(12) });
    const opened = openLlmPayload(out, swk);
    expect(JSON.parse(new TextDecoder().decode(opened)).message).toMatch(/decrypt failed/);
  });

  it("forwards baseUrl to the provider so users can use proxies", async () => {
    let observedBase: string | undefined;
    const stub: LLMProvider = {
      name: "withbase",
      async chat(_req, cfg) {
        observedBase = cfg.baseUrl;
        return { content: "ok", model: "m" };
      },
    };
    const harness = new LlmHarness({ swk: swkOps(swk), registry: new ProviderRegistry([stub]) });
    const sealed = buildSealedRequest({
      provider: "withbase",
      apiKey: "x",
      baseUrl: "https://my-proxy.example",
      request: { model: "m", messages: [{ role: "user", content: "hi" }] },
    });
    await harness.chat(sealed);
    expect(observedBase).toBe("https://my-proxy.example");
  });

  it("blocks an SSRF baseUrl (loopback) before it reaches the provider", async () => {
    let reached = false;
    const stub: LLMProvider = {
      name: "withbase",
      async chat() {
        reached = true;
        return { content: "ok", model: "m" };
      },
    };
    const harness = new LlmHarness({ swk: swkOps(swk), registry: new ProviderRegistry([stub]) });
    const sealed = buildSealedRequest({
      provider: "withbase",
      apiKey: "x",
      baseUrl: "https://127.0.0.1:9090",
      request: { model: "m", messages: [{ role: "user", content: "hi" }] },
    });
    const out = await harness.chat(sealed);
    const parsed = JSON.parse(new TextDecoder().decode(openLlmPayload(out, swk)));
    expect(reached).toBe(false);
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toMatch(/unsafe baseUrl/);
  });

  it("blocks the cloud metadata IP baseUrl", async () => {
    const stub: LLMProvider = {
      name: "withbase",
      async chat() {
        return { content: "ok", model: "m" };
      },
    };
    const harness = new LlmHarness({ swk: swkOps(swk), registry: new ProviderRegistry([stub]) });
    const sealed = buildSealedRequest({
      provider: "withbase",
      apiKey: "x",
      baseUrl: "https://169.254.169.254/latest/meta-data",
      request: { model: "m", messages: [{ role: "user", content: "hi" }] },
    });
    const out = await harness.chat(sealed);
    const parsed = JSON.parse(new TextDecoder().decode(openLlmPayload(out, swk)));
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toMatch(/metadata/);
  });

  it("honors a baseUrlGuard allowlist so a LAN model server still works", async () => {
    let observedBase: string | undefined;
    const stub: LLMProvider = {
      name: "withbase",
      async chat(_req, cfg) {
        observedBase = cfg.baseUrl;
        return { content: "ok", model: "m" };
      },
    };
    const harness = new LlmHarness({
      swk: swkOps(swk),
      registry: new ProviderRegistry([stub]),
      baseUrlGuard: { allowHttp: true, hostAllowlist: ["ollama.lan"] },
    });
    const sealed = buildSealedRequest({
      provider: "withbase",
      apiKey: "x",
      baseUrl: "http://ollama.lan:11434",
      request: { model: "m", messages: [{ role: "user", content: "hi" }] },
    });
    await harness.chat(sealed);
    expect(observedBase).toBe("http://ollama.lan:11434");
  });

  it("listProviders reflects the registry exactly", () => {
    const stub: LLMProvider = { name: "a", async chat() { return { content: "", model: "" }; } };
    const harness = new LlmHarness({ swk: swkOps(swk), registry: new ProviderRegistry([stub]) });
    expect(harness.listProviders()).toEqual(["a"]);
  });
});

describe("LlmHarness.chatStream — live BYOK streaming", () => {
  /** A fake streaming provider that echoes its config + emits deltas. */
  function streamStub(opts: { deltas?: string[]; emitError?: boolean } = {}): {
    provider: StreamingLLMProvider;
    seen: { config?: ProviderConfig; request?: ChatRequest };
  } {
    const seen: { config?: ProviderConfig; request?: ChatRequest } = {};
    const provider: StreamingLLMProvider = {
      name: "stream-stub",
      async chatStream(req, cfg, onEvent) {
        seen.config = cfg;
        seen.request = req;
        if (opts.emitError) {
          onEvent({ kind: "error", message: "boom", status: 500 });
          return;
        }
        for (const d of opts.deltas ?? ["a", "b"]) onEvent({ kind: "delta", text: d });
        onEvent({ kind: "end", stopReason: "stop" });
      },
    };
    return { provider, seen };
  }

  it("streams deltas to onEvent using the supplied credential key", async () => {
    const { provider, seen } = streamStub({ deltas: ["hel", "lo"] });
    const harness = new LlmHarness({
      swk: swkOps(swk),
      streamingRegistry: new StreamingProviderRegistry([provider]),
    });
    const events: ChatStreamEvent[] = [];
    const out = await harness.chatStream(
      { provider: "stream-stub", apiKey: "byok-secret" },
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      (e) => events.push(e),
    );
    expect(out.ok).toBe(true);
    expect(seen.config?.apiKey).toBe("byok-secret");
    const text = events.filter((e) => e.kind === "delta").map((e) => (e as { text: string }).text).join("");
    expect(text).toBe("hello");
    expect(events.at(-1)?.kind).toBe("end");
  });

  it("returns no-streaming (and emits an error event) for a provider with no streaming adapter", async () => {
    const harness = new LlmHarness({
      swk: swkOps(swk),
      streamingRegistry: new StreamingProviderRegistry([]),
    });
    const events: ChatStreamEvent[] = [];
    const out = await harness.chatStream(
      { provider: "nope", apiKey: "k" },
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      (e) => events.push(e),
    );
    expect(out).toEqual({ ok: false, reason: "no-streaming", message: expect.any(String) });
    expect(events[0]?.kind).toBe("error");
  });

  it("blocks an SSRF baseUrl before the provider stream is reached", async () => {
    const { provider, seen } = streamStub();
    const harness = new LlmHarness({
      swk: swkOps(swk),
      streamingRegistry: new StreamingProviderRegistry([provider]),
    });
    const events: ChatStreamEvent[] = [];
    const out = await harness.chatStream(
      { provider: "stream-stub", apiKey: "k", baseUrl: "https://127.0.0.1:9090" },
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      (e) => events.push(e),
    );
    expect(out.ok).toBe(false);
    expect(seen.request).toBeUndefined(); // never reached the provider
    expect((events[0] as { kind: string }).kind).toBe("error");
  });

  it("surfaces a provider-side error as a failed outcome", async () => {
    const { provider } = streamStub({ emitError: true });
    const harness = new LlmHarness({
      swk: swkOps(swk),
      streamingRegistry: new StreamingProviderRegistry([provider]),
    });
    const out = await harness.chatStream(
      { provider: "stream-stub", apiKey: "k" },
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      () => {},
    );
    expect(out).toEqual({ ok: false, reason: "provider-error", message: "boom" });
  });

  it("wires the streamingFetchImpl through to a real adapter (fake SSE lines)", async () => {
    // Anthropic SSE: text delta then message stop. The harness must hand
    // its streamingFetchImpl to the adapter so production uses Node fetch
    // and tests inject canned lines.
    const lines = [
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      'event: message_stop',
      'data: {"type":"message_stop"}',
    ];
    const fakeFetch: StreamingFetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      lines: async function* () {
        for (const l of lines) yield l;
      },
    });
    const harness = new LlmHarness({
      swk: swkOps(swk),
      streamingRegistry: new StreamingProviderRegistry([anthropicStreaming]),
      streamingFetchImpl: fakeFetch,
    });
    const events: ChatStreamEvent[] = [];
    const out = await harness.chatStream(
      { provider: "anthropic", apiKey: "k" },
      { model: "claude-x", messages: [{ role: "user", content: "hi" }] },
      (e) => events.push(e),
    );
    expect(out.ok).toBe(true);
    const text = events.filter((e) => e.kind === "delta").map((e) => (e as { text: string }).text).join("");
    expect(text).toBe("Hi");
  });
});

describe("LlmHarness.chatWithCredential — non-streaming BYOK (adapt path)", () => {
  it("dispatches with the credential key and returns the text", async () => {
    let seenKey = "";
    const stub: LLMProvider = {
      name: "p",
      async chat(req, cfg) {
        seenKey = cfg.apiKey;
        return { content: `text:${req.messages.at(-1)!.content}`, model: req.model };
      },
    };
    const harness = new LlmHarness({ swk: swkOps(swk), registry: new ProviderRegistry([stub]) });
    const resp = await harness.chatWithCredential(
      { provider: "p", apiKey: "adapt-key" },
      { model: "m", messages: [{ role: "user", content: "rewrite" }] },
    );
    expect(seenKey).toBe("adapt-key");
    expect(resp.content).toBe("text:rewrite");
  });

  it("throws on an SSRF baseUrl", async () => {
    const stub: LLMProvider = { name: "p", async chat() { return { content: "", model: "" }; } };
    const harness = new LlmHarness({ swk: swkOps(swk), registry: new ProviderRegistry([stub]) });
    await expect(
      harness.chatWithCredential(
        { provider: "p", apiKey: "k", baseUrl: "http://169.254.169.254/" },
        { model: "m", messages: [{ role: "user", content: "x" }] },
      ),
    ).rejects.toThrow();
  });
});

describe("daemon HTTP /llm/chat", () => {
  function makeCtx(harness?: LlmHarness): DaemonContext {
    const apps = new Map<string, AppMembership>();
    apps.set("habit-tracker", new AppMembership("habit-tracker", "harry", phoneIrk.publicKey, swkOps(swk)));
    const sessions = new Map<string, Uint8Array>([["phone-token", phoneIrk.publicKey]]);
    const injectors = new Map<string, IdentityInjector>();
    return {
      serverId: "srv-llm",
      userId: "harry",
      apps,
      resolveSession: (t) => (t ? sessions.get(t) ?? null : null),
      injectors,
      llm: harness,
    };
  }

  it("returns 503 when no harness is provisioned", async () => {
    const app = buildDaemonHttp(makeCtx());
    const r = await app.inject({ method: "GET", url: "/llm/providers" });
    expect(r.statusCode).toBe(503);
  });

  it("rejects unauthenticated callers", async () => {
    const harness = new LlmHarness({ swk: swkOps(swk), registry: new ProviderRegistry([]) });
    const app = buildDaemonHttp(makeCtx(harness));
    const r = await app.inject({
      method: "POST",
      url: "/llm/chat",
      payload: { sealed: { ciphertext: "00", nonce: "00" } },
    });
    expect(r.statusCode).toBe(401);
  });

  it("end-to-end seal → call → seal back, key never appears in a response field", async () => {
    let leakedKey = "";
    const stub: LLMProvider = {
      name: "stub",
      async chat(req, cfg) {
        leakedKey = cfg.apiKey;
        return { content: "pong", model: req.model };
      },
    };
    const harness = new LlmHarness({ swk: swkOps(swk), registry: new ProviderRegistry([stub]) });
    const app = buildDaemonHttp(makeCtx(harness));

    const sealed = buildSealedRequest({
      provider: "stub",
      apiKey: "secret-key-do-not-leak",
      request: { model: "m", messages: [{ role: "user", content: "ping" }] },
    });

    const r = await app.inject({
      method: "POST",
      url: "/llm/chat",
      payload: {
        sessionToken: "phone-token",
        sealed: { ciphertext: bytesToHex(sealed.ciphertext), nonce: bytesToHex(sealed.nonce) },
      },
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain("secret-key-do-not-leak");
    expect(r.body).not.toContain("pong");
    const body = JSON.parse(r.body) as { sealed: { ciphertext: string; nonce: string } };
    function fromHex(hex: string): Uint8Array {
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      return out;
    }
    const opened = openLlmPayload(
      { ciphertext: fromHex(body.sealed.ciphertext), nonce: fromHex(body.sealed.nonce) },
      swk,
    );
    const parsed = JSON.parse(new TextDecoder().decode(opened));
    expect(parsed.ok).toBe(true);
    expect(parsed.response.content).toBe("pong");
    expect(leakedKey).toBe("secret-key-do-not-leak");
  });

  it("rejects malformed bodies", async () => {
    const harness = new LlmHarness({ swk: swkOps(swk) });
    const app = buildDaemonHttp(makeCtx(harness));
    const r = await app.inject({
      method: "POST",
      url: "/llm/chat",
      payload: { sessionToken: "phone-token", sealed: { ciphertext: 12, nonce: "00" } },
    });
    expect(r.statusCode).toBe(400);
  });

  it("rejects non-hex sealed payloads", async () => {
    const harness = new LlmHarness({ swk: swkOps(swk) });
    const app = buildDaemonHttp(makeCtx(harness));
    const r = await app.inject({
      method: "POST",
      url: "/llm/chat",
      payload: { sessionToken: "phone-token", sealed: { ciphertext: "zz", nonce: "00" } },
    });
    expect(r.statusCode).toBe(400);
  });
});

// Avoid unused-import lint failures where the FetchLike type is exported but
// not exercised in this file.
const _t: FetchLike | undefined = undefined;
void _t;
