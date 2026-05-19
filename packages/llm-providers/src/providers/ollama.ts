import type { ChatRequest, ChatResponse, FetchLike, LLMProvider, ProviderConfig } from "../types.js";
import { ProviderError } from "../types.js";

const DEFAULT_BASE = "http://localhost:11434";

/**
 * Ollama support for native tool-calling varies by underlying model and
 * shell version. The adapter intentionally does NOT forward `req.tools`
 * to the wire — the model would have to inline JSON in the response
 * body, which would defeat the structured-tool contract the
 * orchestrator depends on. Callers that care about tool-use must select
 * a different provider; this adapter degrades to plain text.
 */
export const ollama: LLMProvider = {
  name: "ollama",
  async chat(req: ChatRequest, cfg: ProviderConfig, fetchImpl?: FetchLike): Promise<ChatResponse> {
    const f = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const base = cfg.baseUrl ?? DEFAULT_BASE;
    const body = {
      model: req.model,
      messages: req.messages,
      stream: false,
      options: {
        temperature: req.temperature,
        num_predict: req.maxTokens,
      },
    };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    const res = await f(`${base}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ProviderError("ollama", res.status, await res.text());
    const data = (await res.json()) as {
      message?: { content: string };
      model: string;
      done_reason?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };
    return {
      content: data.message?.content ?? "",
      model: data.model,
      inputTokens: data.prompt_eval_count,
      outputTokens: data.eval_count,
      stopReason: data.done_reason,
      raw: data,
    };
  },
};
