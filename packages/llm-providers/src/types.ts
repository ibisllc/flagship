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
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

export interface LLMProvider {
  readonly name: string;
  chat(req: ChatRequest, cfg: ProviderConfig, fetchImpl?: FetchLike): Promise<ChatResponse>;
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
