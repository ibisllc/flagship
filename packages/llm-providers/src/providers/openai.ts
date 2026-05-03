import type { ChatRequest, ChatResponse, FetchLike, LLMProvider, ProviderConfig } from "../types.js";
import { ProviderError } from "../types.js";

const DEFAULT_BASE = "https://api.openai.com";

export const openai: LLMProvider = {
  name: "openai",
  async chat(req: ChatRequest, cfg: ProviderConfig, fetchImpl?: FetchLike): Promise<ChatResponse> {
    const f = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const base = cfg.baseUrl ?? DEFAULT_BASE;
    const body = {
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
    };
    const res = await f(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ProviderError("openai", res.status, await res.text());
    const data = (await res.json()) as {
      choices: { message: { content: string }; finish_reason?: string }[];
      model: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = data.choices[0];
    if (!choice) throw new ProviderError("openai", 200, "no choices in response");
    return {
      content: choice.message.content ?? "",
      model: data.model,
      inputTokens: data.usage?.prompt_tokens,
      outputTokens: data.usage?.completion_tokens,
      stopReason: choice.finish_reason,
      raw: data,
    };
  },
};
