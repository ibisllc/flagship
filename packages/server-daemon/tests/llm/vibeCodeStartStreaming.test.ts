/**
 * Stage 1 live-wiring of buildUserContext into the startStreaming path.
 *
 * Verifies:
 *  (C) `appEnvStore.names()` is the only accessor — `.get()` is never
 *      called from the prompt-assembly path; even with values present,
 *      no value reaches the system message or the wire body.
 *  (D) the tools array on the request body carries schemas only, no
 *      values.
 *
 * Plus a defensive check: the system prompt the model receives includes
 * the tool-use supplement and the supplement explicitly forbids
 * soliciting secrets via chat — supports invariant B (chat is not a
 * secret channel).
 */

import { describe, expect, it } from "vitest";
import type {
  ChatRequest,
  ChatStreamEvent,
  ProviderConfig,
  StreamingLLMProvider,
} from "@flagship/llm-providers";
import { InMemoryAppEnvStore, type AppEnvStore } from "../../src/serviceEnvStore.js";
import { buildVibeCodeStartStreaming } from "../../src/llm/vibeCodeStartStreaming.js";
import {
  VibeCodeSessionRegistry,
} from "../../src/llm/vibeCodeSession.js";
import {
  TOOL_USE_PROMPT_SUPPLEMENT,
  VIBE_CODE_TOOLS,
} from "../../src/llm/vibeCodeTools.js";

const SENTINEL = "DO-NOT-LEAK-VALUE-sk-9b2c";

/** A capturing fake StreamingLLMProvider. */
function capturingProvider(): {
  provider: StreamingLLMProvider;
  capture: { request?: ChatRequest; config?: ProviderConfig };
} {
  const capture: { request?: ChatRequest; config?: ProviderConfig } = {};
  const provider: StreamingLLMProvider = {
    name: "fake",
    async chatStream(req: ChatRequest, cfg: ProviderConfig, onEvent: (e: ChatStreamEvent) => void) {
      capture.request = req;
      capture.config = cfg;
      onEvent({ kind: "end" });
    },
  };
  return { provider, capture };
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

describe("buildVibeCodeStartStreaming — Stage 1 live wiring", () => {
  it("INVARIANT C: assembles system prompt from names() only; values never reach the wire", async () => {
    const inner = new InMemoryAppEnvStore();
    await inner.put("alice-stripe", { STRIPE_KEY: SENTINEL, OTHER: "another-secret-value" });
    const store = new NamesOnlyStore(inner);
    const registry = new VibeCodeSessionRegistry();
    const { provider, capture } = capturingProvider();
    const startStreaming = buildVibeCodeStartStreaming({
      registry,
      provider,
      config: { apiKey: "k" },
      resolveAppId: () => "alice-stripe",
      appEnvStore: store,
      context: {
        username: "alice",
        hostname: "home",
        tier: "free",
        availableProviders: ["anthropic"],
      },
      existingAppsSnapshot: () => [],
      defaultModel: "claude-haiku",
    });

    const session = registry.create({ username: "alice", serverFqdn: "home.alice.flagship.services" });
    await startStreaming({ sessionId: session.meta.sessionId, prompt: "build me a thing" });

    expect(capture.request).toBeDefined();
    const req = capture.request!;
    const systemMsg = req.messages.find((m) => m.role === "system")?.content ?? "";
    // Names appear.
    expect(systemMsg).toContain("STRIPE_KEY");
    expect(systemMsg).toContain("OTHER");
    // Values do NOT.
    expect(systemMsg).not.toContain(SENTINEL);
    expect(systemMsg).not.toContain("another-secret-value");
    // No call to .get() on the prompt-assembly path.
    expect(store.getCalls).toBe(0);
    // And the full request body, end-to-end, has no value.
    expect(JSON.stringify(req)).not.toContain(SENTINEL);
    expect(JSON.stringify(req)).not.toContain("another-secret-value");
  });

  it("INVARIANT D: the tools array on the wire carries schemas only, no values", async () => {
    const inner = new InMemoryAppEnvStore();
    await inner.put("alice-x", { K: SENTINEL });
    const store = new NamesOnlyStore(inner);
    const registry = new VibeCodeSessionRegistry();
    const { provider, capture } = capturingProvider();
    const startStreaming = buildVibeCodeStartStreaming({
      registry,
      provider,
      config: { apiKey: "k" },
      resolveAppId: () => "alice-x",
      appEnvStore: store,
      context: {
        username: "alice",
        hostname: "home",
        tier: "free",
        availableProviders: ["anthropic"],
      },
      existingAppsSnapshot: () => [],
      defaultModel: "claude-haiku",
    });
    const session = registry.create({ username: "alice", serverFqdn: "home.alice.flagship.services" });
    await startStreaming({ sessionId: session.meta.sessionId, prompt: "x" });

    expect(capture.request?.tools).toBeDefined();
    expect(capture.request!.tools).toHaveLength(VIBE_CODE_TOOLS.length);
    // No tool spec carries a value.
    expect(JSON.stringify(capture.request!.tools)).not.toContain(SENTINEL);
    // Each tool spec has a name + description + inputSchema; nothing else.
    for (const t of capture.request!.tools!) {
      expect(typeof t.name).toBe("string");
      expect(typeof t.description).toBe("string");
      expect(typeof t.inputSchema).toBe("object");
    }
  });

  it("the system prompt includes the tool-use supplement (model gets the contract)", async () => {
    const store = new InMemoryAppEnvStore();
    const registry = new VibeCodeSessionRegistry();
    const { provider, capture } = capturingProvider();
    const startStreaming = buildVibeCodeStartStreaming({
      registry,
      provider,
      config: { apiKey: "k" },
      resolveAppId: () => null,
      appEnvStore: store,
      context: {
        username: "alice",
        hostname: "home",
        tier: "free",
        availableProviders: ["anthropic"],
      },
      existingAppsSnapshot: () => [],
      defaultModel: "m",
    });
    const session = registry.create({ username: "alice", serverFqdn: "home.alice.flagship.services" });
    await startStreaming({ sessionId: session.meta.sessionId, prompt: "x" });
    const sys = capture.request!.messages.find((m) => m.role === "system")!.content;
    // Tool-use supplement present.
    expect(sys).toContain("requestEnvVar");
    expect(sys).toContain("talkToUser");
    // The exact supplement is appended verbatim.
    expect(sys).toContain(TOOL_USE_PROMPT_SUPPLEMENT);
  });

  it("INVARIANT B (prompt side): supplement forbids soliciting secret VALUES via chat", () => {
    // The exact phrase the prompt MUST contain. If a future edit accidentally
    // removes the prohibition, this test fails before the model sees the
    // weaker prompt.
    expect(TOOL_USE_PROMPT_SUPPLEMENT).toMatch(/NEVER ask the owner to paste a secret VALUE into chat/);
    expect(TOOL_USE_PROMPT_SUPPLEMENT).toMatch(/talkToUser.*NOT a secret channel/s);
    // And the supplement explicitly tells the model that requestEnvVar
    // is the legitimate surface for secret entry, not chat.
    expect(TOOL_USE_PROMPT_SUPPLEMENT).toMatch(/requestEnvVar.*set-app-env order/s);
  });
});
