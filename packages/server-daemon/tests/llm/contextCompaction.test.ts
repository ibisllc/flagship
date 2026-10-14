import { describe, expect, it } from "vitest";
import {
  ProviderRegistry,
  StreamingProviderRegistry,
  type ChatMessage,
  type ChatRequest,
  type ChatStreamEvent,
  type LLMProvider,
  type StreamingLLMProvider,
} from "@flagship/llm-providers";
import { deriveSWK } from "@flagship/protocol";
import {
  SUMMARY_PREFIX,
  alternateTurns,
  compactIfNeeded,
  estimateTokens,
  needsCompaction,
} from "../../src/llm/contextCompaction.js";
import { buildModelRedactor } from "../../src/llm/modelPrivacy.js";
import { runBuildAgent } from "../../src/buildmodes/buildAgent.js";
import { LlmHarness } from "../../src/llmHarness.js";
import { InMemoryBuildCredentialStore } from "../../src/llm/buildCredentialStore.js";
import { InMemoryAppEnvStore } from "../../src/serviceEnvStore.js";
import { VibeCodeSession, VibeCodeSessionRegistry } from "../../src/llm/vibeCodeSession.js";
import { buildVibeCodeResumeStreaming } from "../../src/llm/vibeCodeStartStreaming.js";

const big = (n: number, ch = "x") => ch.repeat(n);

function longConversation(turns: number, perTurnChars: number): ChatMessage[] {
  const msgs: ChatMessage[] = [
    { role: "system", content: "You build apps." },
    { role: "user", content: "Build me a recipe app." },
  ];
  for (let i = 0; i < turns; i++) {
    msgs.push({
      role: "assistant",
      content: `step ${i}`,
      toolUses: [{ id: `t${i}`, name: "read_file", input: { path: `src/f${i}.ts` } }],
    });
    msgs.push({ role: "tool", content: "", toolResults: [{ toolUseId: `t${i}`, name: "read_file", content: big(perTurnChars) }] });
  }
  return msgs;
}

describe("context compaction", () => {
  it("leaves a conversation that fits alone", async () => {
    const msgs = longConversation(3, 1000);
    let called = 0;
    const r = await compactIfNeeded({
      messages: msgs,
      contextTokens: 200_000,
      model: "m",
      summarise: async () => {
        called++;
        return "s";
      },
    });
    expect(called).toBe(0);
    expect(r.replaced).toBe(0);
    expect(r.messages).toEqual(msgs);
  });

  it("summarises the middle, keeps the opening and the recent turns", async () => {
    const msgs = longConversation(40, 4000); // ~40k tokens
    expect(needsCompaction({ messages: msgs }, 32_000)).toBe(true);
    const seen: ChatRequest[] = [];
    const r = await compactIfNeeded({
      messages: msgs,
      contextTokens: 32_000,
      model: "qwen",
      summarise: async (req) => {
        seen.push(req);
        return "Owner wants a recipe app. Files read: src/f0.ts … ";
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.model).toBe("qwen");
    expect(seen[0]!.tools).toBeUndefined();
    expect(r.replaced).toBeGreaterThan(0);
    expect(r.messages[0]).toEqual(msgs[0]);
    expect(r.messages[1]).toEqual(msgs[1]);
    const note = r.messages.find((m) => m.content.startsWith(SUMMARY_PREFIX));
    expect(note?.role).toBe("user");
    // The kept tail is the original's end, and never starts on a tool result.
    const tail = msgs.slice(msgs.length - r.kept);
    expect(tail[0]!.role).not.toBe("tool");
    expect(r.messages.slice(r.messages.length - r.kept)).toEqual(tail);
    // Every tool result still follows the call it answers.
    for (let i = 0; i < r.messages.length; i++) {
      if (r.messages[i]!.role === "tool") expect(r.messages[i - 1]!.toolUses?.length).toBeGreaterThan(0);
    }
    expect(estimateTokens(r.messages)).toBeLessThan(32_000 * 0.75);
  });

  it("puts what the summariser reads, and its summary, through the redactor", async () => {
    const msgs = longConversation(40, 4000);
    msgs[3] = {
      role: "tool",
      content: "",
      toolResults: [{ toolUseId: "t0", name: "check_app", content: "GET https://todo.home3.alice.flagship.services/ from 81.2.69.160 by alice" }],
    };
    const real = buildModelRedactor(() => ({ username: "alice", serverFqdn: "home3.alice.flagship.services" }));
    const redacted: string[] = [];
    const redact = (t: string) => {
      const out = real(t);
      redacted.push(out);
      return out;
    };
    let transcript = "";
    const r = await compactIfNeeded({
      messages: msgs,
      contextTokens: 32_000,
      model: "m",
      redact,
      summarise: async (req) => {
        transcript = req.messages.map((m) => m.content).join("\n");
        return "The app answered at home3.alice.flagship.services for alice.";
      },
    });
    expect(transcript).not.toContain("alice");
    expect(transcript).not.toContain("81.2.69.160");
    expect(redacted[0]).toBe(transcript.slice(transcript.indexOf("\n\n") + 2, transcript.lastIndexOf("\n\nWrite the summary now.")));
    expect(r.summary).toBe("The app answered at app.example for owner.");
  });

  it("keeps the conversation when the summariser fails", async () => {
    const msgs = longConversation(40, 4000);
    const r = await compactIfNeeded({
      messages: msgs,
      contextTokens: 32_000,
      model: "m",
      summarise: async () => {
        throw new Error("upstream down");
      },
    });
    expect(r.replaced).toBe(0);
    expect(r.messages).toEqual(msgs);
  });

  it("separates two user turns in a row", () => {
    const out = alternateTurns(
      [
        { role: "user", content: "a" },
        { role: "user", content: "b" },
        { role: "assistant", content: "c" },
      ],
      () => ({ role: "assistant", content: "Noted." }),
    );
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });
});

describe("the agentic build loop compacts before the context fills", () => {
  it("summarises once the turns outgrow the model and journals it", async () => {
    const requests: ChatRequest[] = [];
    let turn = 0;
    const runner = async (req: ChatRequest) => {
      requests.push(req);
      if (!req.tools) return { content: "Summary: read many files.", model: "m" };
      turn++;
      if (turn > 30) return { content: "done", model: "m" };
      return { content: "", model: "m", toolUses: [{ id: `c${turn}`, name: "read_file", input: { path: "a" } }] };
    };
    const journal: Array<{ summary: string }> = [];
    const result = await runBuildAgent({
      buildId: "b1",
      runner,
      tools: { call: async () => ({ text: big(4000) }) } as never,
      journal: { append: async (_id: string, e: { summary: string }) => void journal.push(e) } as never,
      repoFiles: ["index.js"],
      contextTokens: 32_000,
      options: { maxTurns: 40 },
    });
    expect(result.stopReason).toBe("model-stopped");
    const summaryCalls = requests.filter((r) => !r.tools);
    expect(summaryCalls.length).toBeGreaterThan(0);
    expect(journal.some((e) => /summarised/.test(e.summary))).toBe(true);
    for (const r of requests.filter((x) => x.tools)) expect(estimateTokens(r.messages, r.tools)).toBeLessThan(32_000);
  });
});

describe("a chat session compacts on resume and remembers it", () => {
  const swk = deriveSWK({ seed: new Uint8Array(32).fill(5) }, "srv-compact");

  it("summarises older turns once, then resends the summary, not the history", async () => {
    const streamed: ChatRequest[] = [];
    const summarised: ChatRequest[] = [];
    const streaming: StreamingLLMProvider = {
      name: "anthropic",
      async chatStream(req: ChatRequest, _cfg, onEvent: (e: ChatStreamEvent) => void) {
        streamed.push(req);
        onEvent({ kind: "delta", text: "ok\n" });
        onEvent({ kind: "end" });
      },
    };
    const blocking: LLMProvider = {
      name: "anthropic",
      async chat(req: ChatRequest) {
        summarised.push(req);
        return { content: "The owner wants a recipe app with tags.", model: "m" };
      },
    };
    const harness = new LlmHarness({
      swk,
      registry: new ProviderRegistry([blocking]),
      streamingRegistry: new StreamingProviderRegistry([streaming]),
    });
    const registry = new VibeCodeSessionRegistry();
    const session = registry.create({ username: "alice", serverFqdn: "home.alice.flagship.services" });
    session.pushUserMessage("Build me a recipe app");
    for (let i = 0; i < 30; i++) {
      session.feedAssistant(`Question ${i}? ${big(4000)}`);
      session.receiveToolUse({ id: `q${i}`, name: "talkToUser", input: { message: `q${i}` } });
      session.pushUserReply({ toolUseId: `q${i}`, text: `answer ${i}` });
    }
    const credentials = new InMemoryBuildCredentialStore();
    await credentials.put(session.meta.sessionId, { provider: "anthropic", apiKey: "k" });
    const resume = buildVibeCodeResumeStreaming({
      registry,
      harness,
      credentials,
      resolveAppId: () => null,
      appEnvStore: new InMemoryAppEnvStore(),
      defaultModels: { anthropic: "claude-sonnet-5-5" },
      contextTokens: async () => 40_000,
    });
    await resume(session.meta.sessionId);
    expect(summarised).toHaveLength(1);
    expect(session.isCompacted()).toBe(true);
    const sent = streamed[0]!.messages;
    expect(sent.some((m) => m.content.startsWith(SUMMARY_PREFIX))).toBe(true);
    expect(sent[1]!.content).toBe("Build me a recipe app");
    expect(estimateTokens(sent)).toBeLessThan(40_000);

    // Next turn: the saved summary stands in for the older turns.
    session.receiveToolUse({ id: "q-last", name: "talkToUser", input: { message: "more?" } });
    session.pushUserReply({ toolUseId: "q-last", text: "that's all" });
    await resume(session.meta.sessionId);
    expect(summarised).toHaveLength(1);
    expect(streamed[1]!.messages.some((m) => m.content.startsWith(SUMMARY_PREFIX))).toBe(true);
    expect(streamed[1]!.messages.length).toBeLessThan(2 + 31 * 3);

    // And it survives a restart.
    const back = VibeCodeSession.fromSnapshot(session.toSnapshot());
    expect(back.isCompacted()).toBe(true);
    expect(back.modelConversation()[1]!.content.startsWith(SUMMARY_PREFIX)).toBe(true);
  });
});
