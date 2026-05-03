import type { ChatRequest, ChatResponse, FetchLike, LLMProvider, ProviderConfig } from "../types.js";
import { ProviderError } from "../types.js";

const DEFAULT_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

function splitSystem(messages: ChatRequest["messages"]) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const conv = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
  return { system, conv };
}

export const anthropic: LLMProvider = {
  name: "anthropic",
  async chat(req: ChatRequest, cfg: ProviderConfig, fetchImpl?: FetchLike): Promise<ChatResponse> {
    const f = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const base = cfg.baseUrl ?? DEFAULT_BASE;
    const { system, conv } = splitSystem(req.messages);
    const body = {
      model: req.model,
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature,
      system: system.length > 0 ? system : undefined,
      messages: conv,
    };
    const res = await f(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ProviderError("anthropic", res.status, await res.text());
    const data = (await res.json()) as {
      content: { type: string; text: string }[];
      model: string;
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: string;
    };
    const text = data.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    return {
      content: text,
      model: data.model,
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
      stopReason: data.stop_reason,
      raw: data,
    };
  },
};
