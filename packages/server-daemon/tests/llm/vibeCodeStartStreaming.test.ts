/**
 * Live-wiring of buildUserContext + the BYOK credential into the
 * startStreaming path.
 *
 * Verifies:
 *  (C) `appEnvStore.names()` is the only accessor — `.get()` is never
 *      called from the prompt-assembly path; even with values present,
 *      no value reaches the system message or the wire body.
 *  (D) the tools array on the request body carries schemas only, no
 *      values.
 *  - the session streams a reply via the harness when a credential is
 *    stored, and the stored credential's key reaches the provider.
 *  - a session with NO stored credential fails cleanly (the BFF already
 *    surfaces needsCredential; this is the defensive backstop).
 *
 * Plus a defensive check: the system prompt the model receives includes
 * the tool-use supplement and the supplement explicitly forbids
 * soliciting secrets via chat — supports invariant B (chat is not a
 * secret channel).
 */

import { describe, expect, it } from "vitest";
import {
  StreamingProviderRegistry,
  type ChatRequest,
  type ChatStreamEvent,
  type ProviderConfig,
  type StreamingLLMProvider,
} from "@flagship/llm-providers";
import { deriveSWK } from "@flagship/protocol";
import { InMemoryAppEnvStore, type AppEnvStore } from "../../src/serviceEnvStore.js";
import { LlmHarness } from "../../src/llmHarness.js";
import { InMemoryBuildCredentialStore } from "../../src/llm/buildCredentialStore.js";
import { buildVibeCodeStartStreaming } from "../../src/llm/vibeCodeStartStreaming.js";
import {
  VibeCodeSessionRegistry,
} from "../../src/llm/vibeCodeSession.js";
import {
  TOOL_USE_PROMPT_SUPPLEMENT,
  VIBE_CODE_TOOLS,
} from "../../src/llm/vibeCodeTools.js";

const SENTINEL = "DO-NOT-LEAK-VALUE-sk-9b2c";
const swk = deriveSWK({ seed: new Uint8Array(32).fill(3) }, "srv-vibe");

/** A capturing fake StreamingLLMProvider. */
function capturingProvider(opts: { deltas?: string[] } = {}): {
  provider: StreamingLLMProvider;
  capture: { request?: ChatRequest; config?: ProviderConfig };
} {
  const capture: { request?: ChatRequest; config?: ProviderConfig } = {};
  const provider: StreamingLLMProvider = {
    name: "fake",
    async chatStream(req: ChatRequest, cfg: ProviderConfig, onEvent: (e: ChatStreamEvent) => void) {
      capture.request = req;
      capture.config = cfg;
      for (const d of opts.deltas ?? []) onEvent({ kind: "delta", text: d });
      onEvent({ kind: "end" });
    },
  };
  return { provider, capture };
}

/** Build a harness whose streaming registry is just the capturing fake. */
function harnessWith(provider: StreamingLLMProvider): LlmHarness {
  return new LlmHarness({ swk, streamingRegistry: new StreamingProviderRegistry([provider]) });
}

/** A spy-store that throws if `.get()` is ever called on the prompt-assembly path. */
class NamesOnlyStore implements AppEnvStore {
  public getCalls = 0;
  constructor(private readonly inner: AppEnvStore) {}
  put(serviceId: string, env: Record<string, string>): Promise<void> {
    return this.inner.put(serviceId, env);
  }
  get(serviceId: string): Promise<Record<string, string> | null> {
    this.getCalls++;
    return this.inner.get(serviceId);
  }
  names(serviceId: string): Promise<string[]> {
    return this.inner.names(serviceId);
  }
  forget(serviceId: string): Promise<void> {
    return this.inner.forget(serviceId);
  }
}

const ctx = {
  username: "alice",
  hostname: "home",
  tier: "free" as const,
  availableProviders: ["fake"],
};

describe("buildVibeCodeStartStreaming — live BYOK wiring", () => {
  it("INVARIANT C: assembles system prompt from names() only; values never reach the wire", async () => {
    const inner = new InMemoryAppEnvStore();
    await inner.put("alice-stripe", { STRIPE_KEY: SENTINEL, OTHER: "another-secret-value" });
    const store = new NamesOnlyStore(inner);
    const registry = new VibeCodeSessionRegistry();
    const { provider, capture } = capturingProvider();
    const credentials = new InMemoryBuildCredentialStore();
    const startStreaming = buildVibeCodeStartStreaming({
      registry,
      harness: harnessWith(provider),
      credentials,
      resolveAppId: () => "alice-stripe",
      appEnvStore: store,
      context: ctx,
      existingAppsSnapshot: () => [],
      defaultModel: "claude-haiku",
    });

    const session = registry.create({ username: "alice", serverFqdn: "home.alice.flagship.services" });
    await credentials.put(session.meta.sessionId, { provider: "fake", apiKey: "k" });
    await startStreaming({ sessionId: session.meta.sessionId, prompt: "build me a thing" });

    expect(capture.request).toBeDefined();
    const req = capture.request!;
    const systemMsg = req.messages.find((m) => m.role === "system")?.content ?? "";
    expect(systemMsg).toContain("STRIPE_KEY");
    expect(systemMsg).toContain("OTHER");
    expect(systemMsg).not.toContain(SENTINEL);
    expect(systemMsg).not.toContain("another-secret-value");
    expect(store.getCalls).toBe(0);
    expect(JSON.stringify(req)).not.toContain(SENTINEL);
    expect(JSON.stringify(req)).not.toContain("another-secret-value");
  });

  it("INVARIANT D: the tools array on the wire carries schemas only, no values", async () => {
    const inner = new InMemoryAppEnvStore();
    await inner.put("alice-x", { K: SENTINEL });
    const store = new NamesOnlyStore(inner);
    const registry = new VibeCodeSessionRegistry();
    const { provider, capture } = capturingProvider();
    const credentials = new InMemoryBuildCredentialStore();
    const startStreaming = buildVibeCodeStartStreaming({
      registry,
      harness: harnessWith(provider),
      credentials,
      resolveAppId: () => "alice-x",
      appEnvStore: store,
      context: ctx,
      existingAppsSnapshot: () => [],
      defaultModel: "claude-haiku",
    });
    const session = registry.create({ username: "alice", serverFqdn: "home.alice.flagship.services" });
    await credentials.put(session.meta.sessionId, { provider: "fake", apiKey: "k" });
    await startStreaming({ sessionId: session.meta.sessionId, prompt: "x" });

    expect(capture.request?.tools).toBeDefined();
    expect(capture.request!.tools).toHaveLength(VIBE_CODE_TOOLS.length);
    expect(JSON.stringify(capture.request!.tools)).not.toContain(SENTINEL);
    for (const t of capture.request!.tools!) {
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(typeof t.inputSchema).toBe("object");
    }
  });

  it("streams a reply into the session using the STORED credential's key", async () => {
    const registry = new VibeCodeSessionRegistry();
    const { provider, capture } = capturingProvider({ deltas: ["hel", "lo"] });
    const credentials = new InMemoryBuildCredentialStore();
    const startStreaming = buildVibeCodeStartStreaming({
      registry,
      harness: harnessWith(provider),
      credentials,
      resolveAppId: () => null,
      appEnvStore: new InMemoryAppEnvStore(),
      context: ctx,
      existingAppsSnapshot: () => [],
      defaultModel: "m",
    });
    const session = registry.create({ username: "alice", serverFqdn: "home.alice.flagship.services" });
    await credentials.put(session.meta.sessionId, { provider: "fake", apiKey: "stored-key" });
    await startStreaming({ sessionId: session.meta.sessionId, prompt: "hi" });

    // The provider saw the stored key.
    expect(capture.config?.apiKey).toBe("stored-key");
    // The deltas landed in the session transcript.
    const assistant = session.conversation().filter((m) => m.role === "assistant");
    expect(assistant.map((m) => m.content).join("")).toContain("hello");
  });

  it("fails the session cleanly when NO credential is stored (defensive backstop)", async () => {
    const registry = new VibeCodeSessionRegistry();
    const { provider, capture } = capturingProvider();
    const credentials = new InMemoryBuildCredentialStore();
    const startStreaming = buildVibeCodeStartStreaming({
      registry,
      harness: harnessWith(provider),
      credentials,
      resolveAppId: () => null,
      appEnvStore: new InMemoryAppEnvStore(),
      context: ctx,
      existingAppsSnapshot: () => [],
      defaultModel: "m",
    });
    const session = registry.create({ username: "alice", serverFqdn: "home.alice.flagship.services" });
    await startStreaming({ sessionId: session.meta.sessionId, prompt: "hi" });

    // The provider was never called.
    expect(capture.request).toBeUndefined();
    expect(session.meta.status).toBe("failed");
  });

  it("the system prompt includes the tool-use supplement (model gets the contract)", async () => {
    const store = new InMemoryAppEnvStore();
    const registry = new VibeCodeSessionRegistry();
    const { provider, capture } = capturingProvider();
    const credentials = new InMemoryBuildCredentialStore();
    const startStreaming = buildVibeCodeStartStreaming({
      registry,
      harness: harnessWith(provider),
      credentials,
      resolveAppId: () => null,
      appEnvStore: store,
      context: ctx,
      existingAppsSnapshot: () => [],
      defaultModel: "m",
    });
    const session = registry.create({ username: "alice", serverFqdn: "home.alice.flagship.services" });
    await credentials.put(session.meta.sessionId, { provider: "fake", apiKey: "k" });
    await startStreaming({ sessionId: session.meta.sessionId, prompt: "x" });
    const sys = capture.request!.messages.find((m) => m.role === "system")!.content;
    expect(sys).toContain("requestEnvVar");
    expect(sys).toContain("talkToUser");
    expect(sys).toContain(TOOL_USE_PROMPT_SUPPLEMENT);
  });

  it("INVARIANT B (prompt side): supplement forbids soliciting secret VALUES via chat", () => {
    expect(TOOL_USE_PROMPT_SUPPLEMENT).toMatch(/NEVER ask the owner to paste a secret VALUE into chat/);
    expect(TOOL_USE_PROMPT_SUPPLEMENT).toMatch(/talkToUser.*NOT a secret channel/s);
    expect(TOOL_USE_PROMPT_SUPPLEMENT).toMatch(/requestEnvVar.*set-app-env order/s);
  });
});
