/**
 * Run a streaming LLM provider and feed the deltas into a
 * VibeCodeSession. Returns when the stream ends (success or error).
 *
 * On error: marks the session as failed via session.fail and returns
 * the error event (recoverable=true so the phone can retry).
 *
 * The system prompt + user prompt are assembled by the caller — this
 * function is the simple bridge between provider streaming and the
 * session's stateful parser.
 */

import type {
  ChatRequest,
  ChatStreamEvent,
  ProviderConfig,
  StreamingFetchLike,
  StreamingLLMProvider,
} from "@flagship/llm-providers";
import type { VibeCodeSession } from "./vibeCodeSession.js";

export interface StreamIntoSessionArgs {
  session: VibeCodeSession;
  provider: StreamingLLMProvider;
  request: ChatRequest;
  config: ProviderConfig;
  /** Inject for tests; production lets the provider use Node's fetch. */
  fetchImpl?: StreamingFetchLike;
}

export type StreamIntoSessionResult =
  | {
      ok: true;
      stopReason?: string;
      usage?: { inputTokens?: number; outputTokens?: number };
    }
  | { ok: false; reason: string };

export async function streamIntoSession(
  args: StreamIntoSessionArgs,
): Promise<StreamIntoSessionResult> {
  let stopReason: string | undefined;
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  let firstError: { kind: "error"; message: string; status?: number } | null = null;

  await args.provider.chatStream(
    args.request,
    args.config,
    (e: ChatStreamEvent) => {
      if (e.kind === "delta") {
        args.session.feedAssistant(e.text);
        return;
      }
      if (e.kind === "tool_use") {
        args.session.receiveToolUse({ id: e.id, name: e.name, input: e.input });
        return;
      }
      if (e.kind === "end") {
        stopReason = e.stopReason;
        usage = e.usage;
        args.session.endAssistant();
        return;
      }
      if (e.kind === "error") {
        if (!firstError) firstError = e;
        args.session.fail(e.message, true);
      }
    },
    args.fetchImpl,
  );

  if (firstError) {
    return { ok: false, reason: (firstError as { message: string }).message };
  }
  return { ok: true, stopReason, usage };
}
