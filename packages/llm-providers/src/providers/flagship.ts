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
import { openai, openaiStreaming } from "./openai.js";

/**
 * The `"flagship"` provider — Flagship's in-house inference posture. It is
 * an OpenAI-compatible endpoint (RunPod/vLLM serves `/v1/chat/completions`
 * with `tool_calls`), so both the blocking and streaming adapters simply
 * delegate to the OpenAI wire mapping under a distinct provider name.
 *
 * Keeping it a SEPARATE registry entry (rather than reusing `"openai"`)
 * lets the daemon key security posture off the provider/`source` — a
 * promo-minted credential is pinned to the blessed RunPod host, while a
 * BYOK OpenAI key keeps the strict default guard. The `baseUrl` is always
 * supplied by the credential (the blessed endpoint from
 * `FLAGSHIP_INFERENCE_ENDPOINT`); there is no hardcoded default here on
 * purpose — a flagship credential with no baseUrl is a misconfiguration,
 * not a silent fallback to api.openai.com.
 */
export const flagship: LLMProvider = {
  name: "flagship",
  chat(req: ChatRequest, cfg: ProviderConfig, fetchImpl?: FetchLike): Promise<ChatResponse> {
    return openai.chat(req, cfg, fetchImpl);
  },
};

export const flagshipStreaming: StreamingLLMProvider = {
  name: "flagship",
  chatStream(
    req: ChatRequest,
    cfg: ProviderConfig,
    onEvent: (e: ChatStreamEvent) => void,
    fetchImpl?: StreamingFetchLike,
  ): Promise<void> {
    return openaiStreaming.chatStream(req, cfg, onEvent, fetchImpl);
  },
};
