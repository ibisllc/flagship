import type {
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  FetchLike,
  LLMProvider,
  ProviderConfig,
  StreamingFetchLike,
  StreamingLLMProvider,
} from "../types.js";
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

/**
 * Streaming variant. Sets `stream: true` on the request and parses the
 * SSE event stream into ChatStreamEvent. OpenAI's stream emits chunks
 * shaped `{choices: [{delta: {content: "..."}, finish_reason: ...}]}`.
 */
export const openaiStreaming: StreamingLLMProvider = {
  name: "openai",
  async chatStream(
    req: ChatRequest,
    cfg: ProviderConfig,
    onEvent: (e: ChatStreamEvent) => void,
    fetchImpl?: StreamingFetchLike,
  ): Promise<void> {
    const f = fetchImpl;
    if (!f) {
      onEvent({ kind: "error", message: "no streaming fetch wired" });
      return;
    }
    const base = cfg.baseUrl ?? DEFAULT_BASE;
    const body = {
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      stream: true,
    };
    let res: Awaited<ReturnType<StreamingFetchLike>>;
    try {
      res = await f(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      onEvent({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      onEvent({ kind: "error", message: text.slice(0, 512), status: res.status });
      return;
    }
    let stopReason: string | undefined;
    try {
      for await (const line of res.lines()) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice("data:".length).trim();
        if (!payload) continue;
        if (payload === "[DONE]") break;
        let parsed: {
          choices?: { delta?: { content?: string }; finish_reason?: string }[];
        };
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        if (typeof choice.delta?.content === "string" && choice.delta.content.length > 0) {
          onEvent({ kind: "delta", text: choice.delta.content });
        }
        if (choice.finish_reason) stopReason = choice.finish_reason;
      }
    } catch (e) {
      onEvent({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      return;
    }
    onEvent({ kind: "end", stopReason });
  },
};
