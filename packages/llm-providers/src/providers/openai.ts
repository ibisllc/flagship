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
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }
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
      choices: {
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
        finish_reason?: string;
      }[];
      model: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = data.choices[0];
    if (!choice) throw new ProviderError("openai", 200, "no choices in response");
    const toolUses = (choice.message.tool_calls ?? [])
      .filter((c) => c.function?.name)
      .map((c) => ({
        id: c.id,
        name: c.function!.name!,
        input: parseArgsJson(c.function!.arguments ?? ""),
      }));
    return {
      content: choice.message.content ?? "",
      model: data.model,
      inputTokens: data.usage?.prompt_tokens,
      outputTokens: data.usage?.completion_tokens,
      stopReason: choice.finish_reason,
      raw: data,
      toolUses: toolUses.length > 0 ? toolUses : undefined,
    };
  },
};

function parseArgsJson(s: string): Record<string, unknown> {
  if (!s) return {};
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return obj as Record<string, unknown>;
    }
  } catch {
    // Bad arguments — fall through to {} so the orchestrator can decide
    // whether to reject the call rather than crashing the stream.
  }
  return {};
}

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
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      stream: true,
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }
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
    // Per-index tool-call accumulator. OpenAI streams tool-call argument
    // shards one delta at a time keyed by `index` (0, 1, ...); we flush
    // each on the terminal `finish_reason: "tool_calls"` event.
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
    try {
      for await (const line of res.lines()) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice("data:".length).trim();
        if (!payload) continue;
        if (payload === "[DONE]") break;
        let parsed: {
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string;
          }>;
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
        if (Array.isArray(choice.delta?.tool_calls)) {
          for (const tc of choice.delta.tool_calls) {
            if (typeof tc.index !== "number") continue;
            let entry = toolCalls.get(tc.index);
            if (!entry) {
              entry = { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" };
              toolCalls.set(tc.index, entry);
            }
            if (tc.id && !entry.id) entry.id = tc.id;
            if (tc.function?.name && !entry.name) entry.name = tc.function.name;
            if (typeof tc.function?.arguments === "string") entry.args += tc.function.arguments;
          }
        }
        if (choice.finish_reason) {
          stopReason = choice.finish_reason;
          if (choice.finish_reason === "tool_calls") {
            for (const [, entry] of [...toolCalls].sort((a, b) => a[0] - b[0])) {
              if (!entry.name) continue;
              onEvent({
                kind: "tool_use",
                id: entry.id,
                name: entry.name,
                input: parseArgsJson(entry.args),
              });
            }
            toolCalls.clear();
          }
        }
      }
    } catch (e) {
      onEvent({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      return;
    }
    onEvent({ kind: "end", stopReason });
  },
};
