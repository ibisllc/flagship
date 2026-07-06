export type Role = "system" | "user" | "assistant" | "tool";

/**
 * An attachment carried by a user message (the vibe-code chat lets the
 * owner attach a screenshot/mockup or a text file). Adapters that support
 * multimodal input translate these into the provider's native content
 * blocks; adapters that don't (Ollama) ignore image attachments and may
 * inline text attachments. Carries NO secret values by contract — the
 * chat is not a secret channel.
 */
export type Attachment =
  | { kind: "image"; mediaType: string; dataBase64: string; name?: string }
  | { kind: "text"; text: string; name?: string };

export interface ChatMessage {
  role: Role;
  content: string;
  /** Optional multimodal attachments (user messages only). */
  attachments?: Attachment[];
  /**
   * Tool-use blocks an ASSISTANT turn emitted, carried back into the
   * conversation so the model has memory of what it called when the loop
   * resumes. Adapters serialize these into the provider's native
   * assistant-tool-call shape (Anthropic `tool_use` content blocks, OpenAI
   * `tool_calls`). Set ONLY on `role: "assistant"` messages an agentic
   * driver records mid-loop. Carries NO secret values — tool inputs are
   * the model's own arguments (file paths, manifest JSON), never owner env
   * values, which never reach the model by contract.
   */
  toolUses?: ToolUseBlock[];
  /**
   * Results of the tools an assistant turn invoked, fed back so the model
   * can continue. Each entry echoes a `ToolUseBlock.id` and carries the
   * tool's textual output. Adapters serialize these into the provider's
   * native tool-result shape (Anthropic `tool_result` blocks on a USER
   * turn; OpenAI `role: "tool"` messages). Set ONLY on a `role: "tool"`
   * message the driver appends after dispatching the calls. Tool output is
   * value-free by construction (workspace ops report names/sizes/validation
   * problems, never secret values).
   */
  toolResults?: ToolResultBlock[];
}

/**
 * One tool result fed back to the model after the driver ran the
 * corresponding `ToolUseBlock`. `toolUseId` MUST match the id the model
 * assigned to the call. `isError` lets the model recover (e.g. fix an
 * invalid manifest) rather than the loop aborting.
 */
export interface ToolResultBlock {
  toolUseId: string;
  /** The tool's name (some providers want it echoed; harmless otherwise). */
  name?: string;
  content: string;
  isError?: boolean;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /**
   * Provider-agnostic tool specs. Each adapter translates these into the
   * provider's native function/tool shape on the wire. Adapters that
   * cannot forward tools (notably Ollama) ignore this field and surface
   * a text-only stream — callers must handle that fallback themselves.
   *
   * The shape carries SCHEMAS ONLY — never any actual env / secret
   * values. The orchestrator enforces this at construction time.
   */
  tools?: ToolSpec[];
}

/**
 * Provider-agnostic tool specification. Adapters map this onto their
 * native function-calling envelope (Anthropic `tools`, OpenAI `tools`
 * with `function`, Google `function_declarations`). `inputSchema` is a
 * JSONSchema-shaped object — the same shape Anthropic + Google accept
 * directly; OpenAI wants it under `parameters` (the adapter handles
 * the rename).
 */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatResponse {
  /**
   * Text content. Empty string when the model returned ONLY tool-use
   * blocks for this turn (callers should inspect `toolUses`).
   */
  content: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string;
  raw?: unknown;
  /**
   * Tool-use blocks the model emitted on this turn. The orchestrator
   * inspects this to drive multi-turn flow (env var requests, talk-to-
   * user messages). Empty / omitted ⇒ pure-text response.
   */
  toolUses?: ToolUseBlock[];
}

/**
 * One tool invocation emitted by the model. `id` is the
 * provider-assigned identifier the response (tool_result) must echo
 * back; `name` matches a `ToolSpec.name` from the request; `input` is
 * the parsed argument object the model produced. The orchestrator
 * NEVER mutates `input` before reading it.
 */
export interface ToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    /**
     * Body may be a string (JSON / form payloads) OR raw bytes —
     * the latter is needed for binary surfaces like RFC 8291
     * encrypted Web Push (Content-Encoding: aes128gcm).
     */
    body?: string | Uint8Array | ArrayBuffer;
  }
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

export interface LLMProvider {
  readonly name: string;
  chat(req: ChatRequest, cfg: ProviderConfig, fetchImpl?: FetchLike): Promise<ChatResponse>;
}

/**
 * Streaming variant of FetchLike. Production wraps Node's native fetch
 * and exposes the response body as an async iterable of UTF-8 lines
 * (SSE-friendly). Tests inject a fake that yields pre-baked lines.
 */
export type StreamingFetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  lines(): AsyncIterable<string>;
}>;

/**
 * Events emitted while a streaming chat response is in progress. Apps
 * consume these to feed VibeCodeSession.feedAssistant or to render
 * partial output in a UI.
 */
export type ChatStreamEvent =
  | { kind: "delta"; text: string }
  | {
      /**
       * The model invoked one of the declared tools. The orchestrator
       * pauses, processes the call (out-of-band of the streamed text),
       * and pushes back a tool result before resuming. Adapters emit
       * one event per fully-assembled tool-use block — partial-input
       * deltas (Anthropic `input_json_delta`, OpenAI argument tokens,
       * Google function-call parts) are buffered internally.
       */
      kind: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      kind: "end";
      stopReason?: string;
      usage?: { inputTokens?: number; outputTokens?: number };
    }
  | { kind: "error"; message: string; status?: number };

export interface StreamingLLMProvider {
  readonly name: string;
  chatStream(
    req: ChatRequest,
    cfg: ProviderConfig,
    onEvent: (e: ChatStreamEvent) => void,
    fetchImpl?: StreamingFetchLike,
  ): Promise<void>;
}

export class ProviderError extends Error {
  constructor(
    public provider: string,
    public status: number,
    public bodyText: string
  ) {
    super(`${provider} request failed (${status}): ${bodyText.slice(0, 256)}`);
    this.name = "ProviderError";
  }
}
