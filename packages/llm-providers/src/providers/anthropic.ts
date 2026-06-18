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
import { defaultStreamingFetch } from "../streamingFetch.js";

const DEFAULT_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Map a message's content to Anthropic's wire shape. With no attachments
 * this is the bare string (unchanged from before). With attachments it
 * becomes a content-block array: the text first, then one `image` block
 * per image attachment (base64 source) and a text block per text
 * attachment.
 */
function toAnthropicContent(m: ChatRequest["messages"][number]): unknown {
  // An assistant turn that emitted tool calls: serialize as a content-block
  // array — its text (if any) then one `tool_use` block per call — so the
  // model has memory of what it invoked when the agentic loop resumes.
  if (m.role === "assistant" && m.toolUses && m.toolUses.length > 0) {
    const blocks: unknown[] = [];
    if (m.content.length > 0) blocks.push({ type: "text", text: m.content });
    for (const t of m.toolUses) {
      blocks.push({ type: "tool_use", id: t.id, name: t.name, input: t.input });
    }
    return blocks;
  }
  if (!m.attachments || m.attachments.length === 0) return m.content;
  const blocks: unknown[] = [];
  if (m.content.length > 0) blocks.push({ type: "text", text: m.content });
  for (const a of m.attachments) {
    if (a.kind === "image") {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: a.mediaType, data: a.dataBase64 },
      });
    } else {
      const label = a.name ? `${a.name}:\n` : "";
      blocks.push({ type: "text", text: `${label}${a.text}` });
    }
  }
  return blocks;
}

function splitSystem(messages: ChatRequest["messages"]) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const conv = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      // A tool-result turn (the driver's reply after running the calls)
      // becomes a USER message whose content is `tool_result` blocks, per
      // Anthropic's tool protocol.
      if (m.role === "tool" && m.toolResults && m.toolResults.length > 0) {
        return {
          role: "user" as const,
          content: m.toolResults.map((r) => ({
            type: "tool_result",
            tool_use_id: r.toolUseId,
            content: r.content,
            ...(r.isError ? { is_error: true } : {}),
          })),
        };
      }
      return { role: m.role, content: toAnthropicContent(m) };
    });
  return { system, conv };
}

export const anthropic: LLMProvider = {
  name: "anthropic",
  async chat(req: ChatRequest, cfg: ProviderConfig, fetchImpl?: FetchLike): Promise<ChatResponse> {
    const f = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const base = cfg.baseUrl ?? DEFAULT_BASE;
    const { system, conv } = splitSystem(req.messages);
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature,
      system: system.length > 0 ? system : undefined,
      messages: conv,
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }
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
      content: Array<
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
      >;
      model: string;
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: string;
    };
    const text = data.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");
    const toolUses = data.content
      .filter(
        (b): b is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
          b.type === "tool_use",
      )
      .map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} }));
    return {
      content: text,
      model: data.model,
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
      stopReason: data.stop_reason,
      raw: data,
      toolUses: toolUses.length > 0 ? toolUses : undefined,
    };
  },
};

/**
 * Streaming variant. Sets `stream: true` on the request and parses
 * Anthropic's SSE event stream into ChatStreamEvent. The handler
 * never throws on provider errors — it routes them through `onEvent`
 * so callers can surface them to the user without unwinding.
 *
 * Anthropic SSE event types we handle:
 *   - `content_block_delta` with `delta.text` → emit "delta"
 *   - `message_delta` with `usage` → record usage for the end event
 *   - `message_stop` → emit "end" with the captured usage + stop_reason
 *   - `error` → emit "error" and stop
 *
 * Other event types (message_start, content_block_start, ping, etc.)
 * are ignored.
 */
export const anthropicStreaming: StreamingLLMProvider = {
  name: "anthropic",
  async chatStream(
    req: ChatRequest,
    cfg: ProviderConfig,
    onEvent: (e: ChatStreamEvent) => void,
    fetchImpl?: StreamingFetchLike,
  ): Promise<void> {
    const f = fetchImpl ?? defaultStreamingFetch;
    const base = cfg.baseUrl ?? DEFAULT_BASE;
    const { system, conv } = splitSystem(req.messages);
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature,
      system: system.length > 0 ? system : undefined,
      messages: conv,
      stream: true,
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }
    let res: Awaited<ReturnType<StreamingFetchLike>>;
    try {
      res = await f(`${base}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      onEvent({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      onEvent({
        kind: "error",
        message: text.slice(0, 512),
        status: res.status,
      });
      return;
    }
    let stopReason: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    // Active content-block bookkeeping. Anthropic numbers tool-use blocks
    // by `index`; partial_json deltas accumulate per-index until the
    // matching content_block_stop. Text blocks bypass this — they stream
    // straight through as "delta" events.
    const toolUseByIndex = new Map<number, { id: string; name: string; partial: string }>();
    try {
      for await (const line of res.lines()) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice("data:".length).trim();
        if (!payload || payload === "[DONE]") continue;
        let parsed: {
          type?: string;
          index?: number;
          content_block?: {
            type?: string;
            id?: string;
            name?: string;
            input?: Record<string, unknown>;
          };
          delta?: {
            type?: string;
            text?: string;
            partial_json?: string;
            stop_reason?: string;
          };
          usage?: { input_tokens?: number; output_tokens?: number };
          message?: { stop_reason?: string };
          error?: { message?: string };
        };
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        switch (parsed.type) {
          case "content_block_start":
            if (
              parsed.content_block?.type === "tool_use" &&
              typeof parsed.index === "number" &&
              typeof parsed.content_block.id === "string" &&
              typeof parsed.content_block.name === "string"
            ) {
              toolUseByIndex.set(parsed.index, {
                id: parsed.content_block.id,
                name: parsed.content_block.name,
                partial: "",
              });
            }
            break;
          case "content_block_delta":
            if (typeof parsed.delta?.text === "string") {
              onEvent({ kind: "delta", text: parsed.delta.text });
            } else if (
              parsed.delta?.type === "input_json_delta" &&
              typeof parsed.delta.partial_json === "string" &&
              typeof parsed.index === "number"
            ) {
              const entry = toolUseByIndex.get(parsed.index);
              if (entry) entry.partial += parsed.delta.partial_json;
            }
            break;
          case "content_block_stop":
            if (typeof parsed.index === "number") {
              const entry = toolUseByIndex.get(parsed.index);
              if (entry) {
                // Empty partial = no arguments; the model can legitimately
                // call a zero-arg tool, treat as {}.
                let input: Record<string, unknown> = {};
                if (entry.partial.length > 0) {
                  try {
                    const obj = JSON.parse(entry.partial);
                    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
                      input = obj as Record<string, unknown>;
                    }
                  } catch {
                    // Malformed partial — surface a zero-arg call rather
                    // than swallowing the event. The orchestrator will
                    // either reject the call or pass {} to the handler.
                  }
                }
                onEvent({ kind: "tool_use", id: entry.id, name: entry.name, input });
                toolUseByIndex.delete(parsed.index);
              }
            }
            break;
          case "message_delta":
            if (parsed.usage) {
              inputTokens = parsed.usage.input_tokens ?? inputTokens;
              outputTokens = parsed.usage.output_tokens ?? outputTokens;
            }
            if (parsed.delta?.stop_reason) {
              stopReason = parsed.delta.stop_reason;
            }
            break;
          case "message_stop":
            // The SSE-level signal that the stream is finished.
            // We emit "end" once on stream-close; defer to after-loop.
            break;
          case "error":
            onEvent({
              kind: "error",
              message: parsed.error?.message ?? "anthropic stream error",
            });
            return;
        }
      }
    } catch (e) {
      onEvent({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    onEvent({
      kind: "end",
      stopReason,
      usage: { inputTokens, outputTokens },
    });
  },
};

