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
 * `"flagship-local"`: the model server on the owner's own box (llama.cpp's OpenAI-compatible
 * server, docs/architecture-v2/local-ai.md). The OpenAI wire under its own name, so the daemon can
 * key posture off it: its endpoint and key come from the box itself, never from a request; it is
 * reached over loopback only and never through the relay. There is no default base URL on purpose:
 * without the box's endpoint there is no call, and never a fallback to anything else.
 */
export const LOCAL_PROVIDER_NAME = "flagship-local";

export const flagshipLocal: LLMProvider = {
  name: LOCAL_PROVIDER_NAME,
  chat(req: ChatRequest, cfg: ProviderConfig, fetchImpl?: FetchLike): Promise<ChatResponse> {
    if (!cfg.baseUrl) throw new Error("the local model server has no address");
    return openai.chat(req, cfg, fetchImpl);
  },
};

export const flagshipLocalStreaming: StreamingLLMProvider = {
  name: LOCAL_PROVIDER_NAME,
  chatStream(req: ChatRequest, cfg: ProviderConfig, onEvent: (e: ChatStreamEvent) => void, fetchImpl?: StreamingFetchLike): Promise<void> {
    if (!cfg.baseUrl) {
      onEvent({ kind: "error", message: "the local model server has no address" } as ChatStreamEvent);
      return Promise.resolve();
    }
    return openaiStreaming.chatStream(req, cfg, onEvent, fetchImpl);
  },
};
