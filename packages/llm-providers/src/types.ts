export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface ChatResponse {
  content: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  stopReason?: string;
  raw?: unknown;
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
