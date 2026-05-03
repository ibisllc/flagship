import type { ChatRequest, ChatResponse, FetchLike, LLMProvider, ProviderConfig } from "../types.js";
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
