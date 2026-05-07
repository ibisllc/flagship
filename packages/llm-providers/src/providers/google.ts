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

const DEFAULT_BASE = "https://generativelanguage.googleapis.com";

function toGeminiContents(messages: ChatRequest["messages"]) {
  const systemInstruction = messages
    .filter((m) => m.role === "system")
    .map((m) => ({ parts: [{ text: m.content }] }))
    .pop();
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
  return { contents, systemInstruction };
}

export const google: LLMProvider = {
  name: "google",
  async chat(req: ChatRequest, cfg: ProviderConfig, fetchImpl?: FetchLike): Promise<ChatResponse> {
    const f = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const base = cfg.baseUrl ?? DEFAULT_BASE;
    const { contents, systemInstruction } = toGeminiContents(req.messages);
    const body = {
      contents,
      systemInstruction,
      generationConfig: {
        maxOutputTokens: req.maxTokens,
        temperature: req.temperature,
      },
    };
    const url = `${base}/v1beta/models/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
    const res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ProviderError("google", res.status, await res.text());
    const data = (await res.json()) as {
      candidates?: { content: { parts: { text?: string }[] }; finishReason?: string }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const cand = data.candidates?.[0];
    const text = cand?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    return {
      content: text,
      model: req.model,
      inputTokens: data.usageMetadata?.promptTokenCount,
      outputTokens: data.usageMetadata?.candidatesTokenCount,
      stopReason: cand?.finishReason,
      raw: data,
    };
  },
};

/**
 * Streaming variant. Uses Gemini's `streamGenerateContent` endpoint
 * with `alt=sse`. Each SSE event is a JSON candidates payload like
 * the non-streaming response, with incremental `content.parts[i].text`.
 */
export const googleStreaming: StreamingLLMProvider = {
  name: "google",
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
    const { contents, systemInstruction } = toGeminiContents(req.messages);
    const body = {
      contents,
      systemInstruction,
      generationConfig: {
        maxOutputTokens: req.maxTokens,
        temperature: req.temperature,
      },
    };
    const url = `${base}/v1beta/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(cfg.apiKey)}`;
    let res: Awaited<ReturnType<StreamingFetchLike>>;
    try {
      res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let stopReason: string | undefined;
    try {
      for await (const line of res.lines()) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice("data:".length).trim();
        if (!payload) continue;
        let parsed: {
          candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
          usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
        };
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        const cand = parsed.candidates?.[0];
        if (cand?.content?.parts) {
          for (const part of cand.content.parts) {
            if (typeof part.text === "string" && part.text.length > 0) {
              onEvent({ kind: "delta", text: part.text });
            }
          }
        }
        if (cand?.finishReason) stopReason = cand.finishReason;
        if (parsed.usageMetadata) {
          inputTokens = parsed.usageMetadata.promptTokenCount ?? inputTokens;
          outputTokens = parsed.usageMetadata.candidatesTokenCount ?? outputTokens;
        }
      }
    } catch (e) {
      onEvent({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      return;
    }
    onEvent({ kind: "end", stopReason, usage: { inputTokens, outputTokens } });
  },
};
