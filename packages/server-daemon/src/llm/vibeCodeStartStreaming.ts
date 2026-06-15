/**
 * Produces a `startStreaming` thunk for the `VibeCodeRuntime` injection
 * point on the screens BFF (`/api/screens/vibe-code/start`).
 *
 * This is the Stage 1 live wiring of `buildUserContext` into the
 * production vibecode call:
 *
 *   1. Compute the env-var NAMES list via `appEnvStore.names(serviceId)` —
 *      `.get()` is NEVER called from this path.
 *   2. Assemble the system message via `buildUserContext()` with those
 *      names + the existing context fields.
 *   3. Issue the chat-stream call with `tools: VIBE_CODE_TOOLS` attached
 *      so the model can invoke `requestEnvVar` / `talkToUser`.
 *   4. Feed deltas + tool_use events into the session via
 *      `streamIntoSession`.
 *
 * The function returns a function-shaped value, so the daemon can drop
 * it straight onto `VibeCodeRuntime.startStreaming`.
 */

import type {
  Attachment,
  ChatRequest,
  ProviderConfig,
  StreamingFetchLike,
  StreamingLLMProvider,
} from "@flagship/llm-providers";
import type { AppEnvStore } from "../serviceEnvStore.js";
import type { VibeCodeSessionRegistry } from "./vibeCodeSession.js";
import { streamIntoSession } from "./streamIntoSession.js";
import {
  buildUserContext,
  type ExistingAppSummary,
  type UserContextInput,
} from "./systemPrompt.js";
import { TOOL_USE_PROMPT_SUPPLEMENT, VIBE_CODE_TOOLS } from "./vibeCodeTools.js";

export interface BuildVibeCodeStartStreamingArgs {
  registry: VibeCodeSessionRegistry;
  provider: StreamingLLMProvider;
  config: ProviderConfig;
  /** Streaming-fetch implementation; tests inject. Production omits. */
  fetchImpl?: StreamingFetchLike;
  /** Resolves the serviceId an in-flight session is editing. */
  resolveAppId: (sessionId: string) => string | null;
  /** Read-only env-var-name accessor. NEVER values. */
  appEnvStore: AppEnvStore;
  /** Static fields the BFF would otherwise have to thread per-call. */
  context: Omit<UserContextInput, "appEnvNames" | "existingApps">;
  /** Existing-apps snapshot at the moment startStreaming is called. */
  existingAppsSnapshot: () => ExistingAppSummary[];
  /** Default model when the caller didn't specify one. */
  defaultModel: string;
}

export interface StartStreamingArgs {
  sessionId: string;
  prompt: string;
  model?: string;
  /**
   * Multimodal attachments on the user turn (image / text). Already
   * validated by the caller (caps/kinds/sizes). They ride on the
   * `ChatRequest`'s user message so a multimodal-capable adapter
   * (Anthropic) translates them into native content blocks. Value-free
   * w.r.t. secrets by contract.
   */
  attachments?: Attachment[];
}

/**
 * The function the screens BFF calls when the phone POSTs
 * /api/screens/vibe-code/start. Fire-and-forget — caller does not await.
 */
export function buildVibeCodeStartStreaming(
  args: BuildVibeCodeStartStreamingArgs,
): (s: StartStreamingArgs) => Promise<void> {
  return async function startStreaming(s: StartStreamingArgs): Promise<void> {
    const session = args.registry.get(s.sessionId);
    if (!session) return;
    const serviceId = args.resolveAppId(s.sessionId);
    // CRITICAL: only .names(). `.get()` is never called on this path —
    // values must never reach the prompt or the request body.
    const appEnvNames = serviceId ? await args.appEnvStore.names(serviceId) : [];
    const systemMessage =
      buildUserContext({
        ...args.context,
        existingApps: args.existingAppsSnapshot(),
        appEnvNames,
      }) +
      "\n\n" +
      TOOL_USE_PROMPT_SUPPLEMENT;
    const request: ChatRequest = {
      model: s.model ?? args.defaultModel,
      messages: [
        { role: "system", content: systemMessage },
        {
          role: "user",
          content: s.prompt,
          ...(s.attachments && s.attachments.length > 0
            ? { attachments: s.attachments }
            : {}),
        },
      ],
      tools: VIBE_CODE_TOOLS.map((t) => ({ ...t })),
    };
    await streamIntoSession({
      session,
      provider: args.provider,
      request,
      config: args.config,
      fetchImpl: args.fetchImpl,
    });
  };
}
