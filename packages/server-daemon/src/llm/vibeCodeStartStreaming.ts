/**
 * Produces a `startStreaming` thunk for the `VibeCodeRuntime` injection
 * point on the screens BFF (`/api/screens/vibe-code/start`).
 *
 * This is the live wiring of `buildUserContext` into the production
 * vibecode call:
 *
 *   1. Resolve the session's BYOK credential from the transient
 *      credential store. NO credential ⇒ the session is left idle (the
 *      caller already surfaced `needsCredential` to the client) — we
 *      never invent a provider/key.
 *   2. Compute the env-var NAMES list via `appEnvStore.names(serviceId)` —
 *      `.get()` is NEVER called from this path.
 *   3. Assemble the system message via `buildUserContext()` with those
 *      names + the existing context fields.
 *   4. Issue the chat-stream call through `LlmHarness.chatStream` (which
 *      opens the credential in memory ONLY for the call + applies the
 *      SSRF baseUrl guard) with `tools: VIBE_CODE_TOOLS` attached so the
 *      model can invoke `requestEnvVar` / `talkToUser`.
 *   5. Feed deltas + tool_use events into the session.
 *
 * ── flagshipserver.com is NEVER in this path ──────────────────────────
 * The credential never leaves the box; the daemon calls the provider
 * directly. The function returns a function-shaped value the daemon
 * drops straight onto `VibeCodeRuntime.startStreaming`.
 */

import type {
  Attachment,
  ChatRequest,
  ChatStreamEvent,
} from "@flagship/llm-providers";
import type { LlmHarness } from "../llmHarness.js";
import type { BuildCredentialStore } from "./buildCredentialStore.js";
import type { AppEnvStore } from "../serviceEnvStore.js";
import type { VibeCodeSessionRegistry } from "./vibeCodeSession.js";
import {
  buildUserContext,
  type ExistingAppSummary,
  type UserContextInput,
} from "./systemPrompt.js";
import { TOOL_USE_PROMPT_SUPPLEMENT, VIBE_CODE_TOOLS } from "./vibeCodeTools.js";

/**
 * Owner choices from the Describe form, rendered as a prompt supplement so the
 * generated manifest honors them. `manifest.name` becomes the deployed
 * service's slug + web-address label (see deploySession), so steering the model
 * to the owner's name is how the form's "Name" field reaches the address. The
 * visibility line steers the access posture the build assumes. Empty when the
 * owner made no explicit choice (legacy clients) — adds nothing to the prompt.
 */
export function ownerChoiceSupplement(
  preferredName?: string,
  visibility?: "just-me" | "link",
): string {
  const lines: string[] = [];
  if (preferredName && preferredName.length > 0) {
    lines.push(
      `The owner named this service "${preferredName}". Use exactly this as the manifest \`name\` (the service's slug and web address) unless it is technically impossible.`,
    );
  }
  if (visibility === "just-me") {
    lines.push(
      "The owner wants this service PRIVATE (visible to just them) — build it to assume only the authenticated owner reaches it; do not add public sign-up or open endpoints.",
    );
  } else if (visibility === "link") {
    lines.push(
      "The owner wants this service reachable by anyone with the link — build it to be safe for unauthenticated visitors.",
    );
  }
  return lines.length > 0 ? "\n\n" + lines.join("\n") : "";
}

export interface BuildVibeCodeStartStreamingArgs {
  registry: VibeCodeSessionRegistry;
  /** The harness holds no key — it opens the credential per-call. */
  harness: LlmHarness;
  /** Transient, sealed-at-rest BYOK credential store keyed by sessionId. */
  credentials: BuildCredentialStore;
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
  /**
   * Owner-chosen service name/slug from the Describe form. Threaded into the
   * system prompt so the generated `manifest.name` — which becomes the
   * deployed service's slug + web-address label (deploySession) — honors the
   * owner's choice instead of one the model invents. Already sanitized
   * (`[a-z0-9-]`) by the caller. Absent ⇒ the model names it.
   */
  preferredName?: string;
  /**
   * Owner-chosen reach: "just-me" (private to the owner) or "link" (anyone
   * with the link). Surfaced to the model so the build reflects the intended
   * access posture. Absent ⇒ owner-only default.
   */
  visibility?: "just-me" | "link";
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

    // Resolve the BYOK credential just-in-time. Absence here should be
    // rare (the BFF already short-circuits + signals `needsCredential`),
    // but if a session is driven with no key we fail the session cleanly
    // rather than inventing one.
    const credential = await args.credentials.get(s.sessionId);
    if (!credential) {
      session.fail("no AI credential set for this session", true);
      return;
    }

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
      ownerChoiceSupplement(s.preferredName, s.visibility) +
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

    await args.harness.chatStream(credential, request, (e: ChatStreamEvent) => {
      if (e.kind === "delta") {
        session.feedAssistant(e.text);
        return;
      }
      if (e.kind === "tool_use") {
        session.receiveToolUse({ id: e.id, name: e.name, input: e.input });
        return;
      }
      if (e.kind === "end") {
        session.endAssistant();
        return;
      }
      if (e.kind === "error") {
        session.fail(e.message, true);
      }
    });
  };
}

/**
 * Produces a `resumeStreaming` thunk: re-invokes the model after the owner
 * answered a `talkToUser` question (or acked a `requestEnvVar`).
 *
 * WHY THIS EXISTS: the `/reply` (+ legacy `/user-reply`) handlers append the
 * owner's reply to the session and flip its status back to `streaming`, but on
 * their own they do NOT re-invoke the LLM — so a chat-guided build stalled
 * forever after the FIRST clarifying question (the model never continued).
 * This resumes the conversation: it rebuilds the `ChatRequest` from the FULL
 * accumulated history (`session.conversation()`) — the original prompt, the
 * model's partial reply, and the owner's answer — so the model picks up where
 * it left off and emits the files.
 *
 * Same secret contract as `startStreaming`: the BYOK credential is opened
 * just-in-time, env-var NAMES only (never values) enter the prompt, and
 * flagshipserver.com is never in the path.
 */
export function buildVibeCodeResumeStreaming(
  args: BuildVibeCodeStartStreamingArgs,
): (sessionId: string, model?: string) => Promise<void> {
  return async function resumeStreaming(
    sessionId: string,
    model?: string,
  ): Promise<void> {
    const session = args.registry.get(sessionId);
    if (!session) return;

    const credential = await args.credentials.get(sessionId);
    if (!credential) {
      session.fail("no AI credential set for this session", true);
      return;
    }

    // The prior turn marked the parser `done` (endAssistant → parser.end);
    // reset it so the resumed file output is actually parsed (otherwise the
    // session reaches ready-to-deploy with no files → deploy 502).
    session.prepareForResume();

    const serviceId = args.resolveAppId(sessionId);
    const appEnvNames = serviceId ? await args.appEnvStore.names(serviceId) : [];
    const systemMessage =
      buildUserContext({
        ...args.context,
        existingApps: args.existingAppsSnapshot(),
        appEnvNames,
      }) +
      "\n\n" +
      TOOL_USE_PROMPT_SUPPLEMENT;

    // Rebuild the running conversation. The model sees its own earlier output
    // (incl. the question it asked, narrated as assistant text) followed by the
    // owner's answer, and continues. Synthetic `[tool_result:…]` env-var-ack
    // entries are value-free by construction (see vibeCodeSession).
    const history = session.conversation();
    const messages: ChatRequest["messages"] = [
      { role: "system", content: systemMessage },
      ...history.map((h) => ({
        role: h.role,
        content: h.content,
        ...(h.attachments && h.attachments.length > 0
          ? { attachments: h.attachments }
          : {}),
      })),
    ];
    const request: ChatRequest = {
      model: model ?? args.defaultModel,
      messages,
      tools: VIBE_CODE_TOOLS.map((t) => ({ ...t })),
    };

    await args.harness.chatStream(credential, request, (e: ChatStreamEvent) => {
      if (e.kind === "delta") {
        session.feedAssistant(e.text);
        return;
      }
      if (e.kind === "tool_use") {
        session.receiveToolUse({ id: e.id, name: e.name, input: e.input });
        return;
      }
      if (e.kind === "end") {
        session.endAssistant();
        return;
      }
      if (e.kind === "error") {
        session.fail(e.message, true);
      }
    });
  };
}
