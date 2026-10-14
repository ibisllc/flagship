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
import { openAiTokenField, sendAdapting } from "../requestShape.js";

const DEFAULT_BASE = "https://api.openai.com";

/**
 * Map our provider-agnostic messages onto OpenAI's chat wire shape,
 * including the tool-call round-trip an agentic loop needs:
 *   - an ASSISTANT turn that emitted tool calls → `tool_calls: [...]`
 *     (content may be null when the turn was tool-only).
 *   - a TOOL turn (the driver's results) → one `role:"tool"` message per
 *     result, each with the matching `tool_call_id`.
 *   - a turn with attachments → content parts: the text, an `image_url`
 *     part (a data URL) per image, a labelled text part per text file.
 * Plain text turns pass through as-is.
 */
export function toOpenAiMessages(messages: ChatRequest["messages"]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.toolUses && m.toolUses.length > 0) {
      out.push({
        role: "assistant",
        content: m.content.length > 0 ? m.content : null,
        tool_calls: m.toolUses.map((t) => ({
          id: t.id,
          type: "function",
          function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
        })),
      });
      continue;
    }
    if (m.role === "tool" && m.toolResults && m.toolResults.length > 0) {
      for (const r of m.toolResults) {
        out.push({ role: "tool", tool_call_id: r.toolUseId, content: r.content });
      }
      continue;
    }
    if (m.attachments && m.attachments.length > 0) {
      const parts: unknown[] = [];
      if (m.content.length > 0) parts.push({ type: "text", text: m.content });
      for (const a of m.attachments) {
        if (a.kind === "image") {
          parts.push({ type: "image_url", image_url: { url: `data:${a.mediaType};base64,${a.dataBase64}` } });
        } else {
          parts.push({ type: "text", text: `${a.name ? `${a.name}:\n` : ""}${a.text}` });
        }
      }
      out.push({ role: m.role, content: parts });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

/** How an OpenAI-compatible endpoint takes a reasoning effort. */
export type EffortStyle = "reasoning_effort" | "openrouter";

/** The chat-completions body every OpenAI-compatible adapter sends. */
export function openAiChatBody(
  req: ChatRequest,
  tokenField: string,
  opts: { stream?: boolean; effortStyle?: EffortStyle } = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: toOpenAiMessages(req.messages),
    [tokenField]: req.maxTokens,
    temperature: req.temperature,
  };
  if (opts.stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
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
  if (req.reasoningEffort) {
    if (opts.effortStyle === "openrouter") body.reasoning = { effort: req.reasoningEffort };
    else body.reasoning_effort = req.reasoningEffort;
  }
  return body;
}

/**
 * The shim's last chunk on a Flagship Inference stream:
 * `{"object":"flagship.usage","credits":N}`. Null for any other chunk.
 */
export function flagshipCreditsOf(chunk: unknown): number | null {
  const c = chunk as { object?: unknown; credits?: unknown } | null;
  if (!c || c.object !== "flagship.usage" || typeof c.credits !== "number" || !Number.isFinite(c.credits)) return null;
  return Math.max(0, c.credits);
}

export const openai: LLMProvider = {
  name: "openai",
  async chat(req: ChatRequest, cfg: ProviderConfig, fetchImpl?: FetchLike): Promise<ChatResponse> {
    const f = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    const base = cfg.baseUrl ?? DEFAULT_BASE;
    const body = openAiChatBody(req, openAiTokenField(base));
    const { res, errorText } = await sendAdapting(`${base}|${req.model}`, body, (b) =>
      f(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(b),
      }),
    );
    if (!res.ok) throw new ProviderError("openai", res.status, errorText ?? "");
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
      flagship?: { credits?: unknown };
    };
    const choice = data.choices[0];
    if (!choice) throw new ProviderError("openai", 200, "no choices in response");
    const credits = flagshipCreditsOf({ object: "flagship.usage", credits: data.flagship?.credits });
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
      ...(credits !== null ? { credits } : {}),
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
  chatStream(req, cfg, onEvent, fetchImpl) {
    return streamOpenAiCompatible(req, cfg, onEvent, fetchImpl);
  },
};

/** The OpenAI chat-completions stream, shared by every compatible adapter. */
export async function streamOpenAiCompatible(
  req: ChatRequest,
  cfg: ProviderConfig,
  onEvent: (e: ChatStreamEvent) => void,
  fetchImpl?: StreamingFetchLike,
  effortStyle: EffortStyle = "reasoning_effort",
): Promise<void> {
  const f = fetchImpl;
  if (!f) {
    onEvent({ kind: "error", message: "no streaming fetch wired" });
    return;
  }
  const base = cfg.baseUrl ?? DEFAULT_BASE;
  const body = openAiChatBody(req, openAiTokenField(base), { stream: true, effortStyle });
  let res: Awaited<ReturnType<StreamingFetchLike>>;
  let errorText: string | undefined;
  try {
    ({ res, errorText } = await sendAdapting(`${base}|${req.model}`, body, (b) =>
      f(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(b),
      }),
    ));
  } catch (e) {
    onEvent({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    return;
  }
  if (!res.ok) {
    onEvent({ kind: "error", message: (errorText || "<no body>").slice(0, 512), status: res.status });
    return;
  }
  let stopReason: string | undefined;
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  let credits: number | null = null;
  // Per-index tool-call accumulator. OpenAI streams tool-call argument
  // shards one delta at a time keyed by `index` (0, 1, ...); we flush
  // each on the terminal `finish_reason: "tool_calls"` event.
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  try {
    for await (const line of res.lines()) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice("data:".length).trim();
      if (!payload) continue;
      // Keep reading after [DONE]: the Flagship shim appends its credits chunk.
      if (payload === "[DONE]") continue;
      let parsed: {
        error?: { message?: string; code?: string | number };
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
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
      if (parsed.error) {
        onEvent({
          kind: "error",
          message: parsed.error.message ?? "provider stream failed",
        });
        return;
      }
      const charged = flagshipCreditsOf(parsed);
      if (charged !== null) credits = charged;
      if (parsed.usage && (parsed.usage.prompt_tokens || parsed.usage.completion_tokens)) {
        usage = { inputTokens: parsed.usage.prompt_tokens, outputTokens: parsed.usage.completion_tokens };
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
  onEvent({
    kind: "end",
    stopReason,
    ...(usage ? { usage } : {}),
    ...(credits !== null ? { credits } : {}),
  });
}

