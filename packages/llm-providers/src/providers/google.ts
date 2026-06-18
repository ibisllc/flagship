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
    .map((m) => {
      // An assistant turn that emitted tool calls → a `model` turn whose
      // parts are `functionCall`s (plus any text), so Gemini has memory of
      // what it invoked when the agentic loop resumes.
      if (m.role === "assistant" && m.toolUses && m.toolUses.length > 0) {
        const parts: unknown[] = [];
        if (m.content.length > 0) parts.push({ text: m.content });
        for (const t of m.toolUses) {
          parts.push({ functionCall: { name: t.name, args: t.input ?? {} } });
        }
        return { role: "model", parts };
      }
      // A tool-result turn → a `user` turn whose parts are
      // `functionResponse`s keyed by the tool name (Gemini matches by name,
      // not id).
      if (m.role === "tool" && m.toolResults && m.toolResults.length > 0) {
        return {
          role: "user",
          parts: m.toolResults.map((r) => ({
            functionResponse: {
              name: r.name ?? r.toolUseId,
              response: { result: r.content, ...(r.isError ? { error: true } : {}) },
            },
          })),
        };
      }
      return {
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      };
    });
  return { contents, systemInstruction };
}

function toolsToGemini(tools?: ChatRequest["tools"]) {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      function_declarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      })),
    },
  ];
}

/** Synthesize a deterministic tool-use id for Gemini calls — the API
 *  doesn't include one natively; the orchestrator only needs it to be
 *  unique within a single response so it can match acks. */
function geminiToolId(name: string, seq: number): string {
  return `gemini-${name}-${seq}`;
}

export const google: LLMProvider = {
  name: "google",
  async chat(req: ChatRequest, cfg: ProviderConfig, fetchImpl?: FetchLike): Promise<ChatResponse> {
    const f = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const base = cfg.baseUrl ?? DEFAULT_BASE;
    const { contents, systemInstruction } = toGeminiContents(req.messages);
    const body: Record<string, unknown> = {
      contents,
      systemInstruction,
      generationConfig: {
        maxOutputTokens: req.maxTokens,
        temperature: req.temperature,
      },
    };
    const tools = toolsToGemini(req.tools);
    if (tools) body.tools = tools;
    const url = `${base}/v1beta/models/${encodeURIComponent(req.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
    const res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ProviderError("google", res.status, await res.text());
    const data = (await res.json()) as {
      candidates?: Array<{
        content: {
          parts: Array<{
            text?: string;
            functionCall?: { name?: string; args?: Record<string, unknown> };
          }>;
        };
        finishReason?: string;
      }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const cand = data.candidates?.[0];
    const parts = cand?.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? "").join("");
    const toolUses: { id: string; name: string; input: Record<string, unknown> }[] = [];
    let seq = 0;
    for (const p of parts) {
      if (p.functionCall?.name) {
        toolUses.push({
          id: geminiToolId(p.functionCall.name, seq++),
          name: p.functionCall.name,
          input: (p.functionCall.args ?? {}) as Record<string, unknown>,
        });
      }
    }
    return {
      content: text,
      model: req.model,
      inputTokens: data.usageMetadata?.promptTokenCount,
      outputTokens: data.usageMetadata?.candidatesTokenCount,
      stopReason: cand?.finishReason,
      raw: data,
      toolUses: toolUses.length > 0 ? toolUses : undefined,
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
    const body: Record<string, unknown> = {
      contents,
      systemInstruction,
      generationConfig: {
        maxOutputTokens: req.maxTokens,
        temperature: req.temperature,
      },
    };
    const tools = toolsToGemini(req.tools);
    if (tools) body.tools = tools;
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
    let toolSeq = 0;
    try {
      for await (const line of res.lines()) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice("data:".length).trim();
        if (!payload) continue;
        let parsed: {
          candidates?: Array<{
            content?: {
              parts?: Array<{
                text?: string;
                functionCall?: { name?: string; args?: Record<string, unknown> };
              }>;
            };
            finishReason?: string;
          }>;
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
            if (part.functionCall?.name) {
              onEvent({
                kind: "tool_use",
                id: geminiToolId(part.functionCall.name, toolSeq++),
                name: part.functionCall.name,
                input: (part.functionCall.args ?? {}) as Record<string, unknown>,
              });
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
