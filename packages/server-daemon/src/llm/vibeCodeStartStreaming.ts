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
import type { LlmCredential, LlmHarness } from "../llmHarness.js";
import { alternateTurns, compactIfNeeded } from "./contextCompaction.js";
import type { ModelRedactor } from "./modelPrivacy.js";
import { HIDDEN_NOTE_PREFIX, type VibeCodeSession } from "./vibeCodeSession.js";
import type { BuildCredentialStore } from "./buildCredentialStore.js";
import type { AppEnvStore } from "../serviceEnvStore.js";
import type { VibeCodeSessionRegistry } from "./vibeCodeSession.js";
import {
  buildUserContext,
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
      `The owner named this service "${preferredName}". Use exactly this as the manifest \`name\` and \`network.subdomain\`: the box deploys it under this name whatever the manifest says.`,
    );
  }
  if (visibility === "just-me") {
    lines.push(
      "The owner chose INVITE ONLY: the box itself lets in only the owner and the people they invite on Flagship, so every visitor outside `access.public_routes` arrives signed in with Flagship (`X-Flagship-User` is a real member). Do not add sign-up or any login of your own; use the identity headers for who is who. Strangers reach only the paths in `access.public_routes`: list there only what must work for them (a webhook another service calls, a landing page if the owner wants one), and they arrive anonymous.",
    );
  } else if (visibility === "link") {
    lines.push(
      "The owner chose OPEN: anyone with the link can reach it, and visitors who haven't signed in reach EVERY route as anonymous (`X-Flagship-Visitor: anonymous`), so make every route handle them on purpose (read-only public content by default). Also list the pages and webhooks strangers must reach in `access.public_routes`, so they keep working if the owner later makes the app members-only. Wherever the app needs to know who the visitor is (their own data, posting, settings), rely on Flagship sign-in: keep those routes out of `public_routes` and read the identity headers, instead of building accounts, passwords or a third-party login. Flagship sign-in shares nothing about the visitor beyond who they are on Flagship, which keeps them private.",
    );
  }
  return lines.length > 0 ? "\n\n" + lines.join("\n") : "";
}

/** Over this, the AI chat can't hold the whole app; the IDE route can. */
export const EDIT_SOURCE_MAX_BYTES = 300 * 1024;

/**
 * For a session that changes an installed service: its current files and how
 * to change them. Empty for a new build.
 */
export function editSupplement(slug: string | undefined, files: Record<string, string> | null): string {
  if (!slug || !files) return "";
  const dump = Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, c]) => `=== ${p} ===\n${c.endsWith("\n") ? c : c + "\n"}`)
    .join("") + "=== END ===";
  return `

# You are changing an app that is already running

The owner is changing "${slug}", which is installed and in use on this server. Its current files are below. Make the change the owner asks for, and nothing else.

- Write ONLY the files you change or add, each one complete, in the usual \`=== path ===\` format. Every file you don't write stays exactly as it is.
- Keep \`flagship.app.json\`'s \`name\` as "${slug}". Bump its \`version\`.
- Its data is kept across this change. A schema change is a NEW numbered file such as \`migrations/0002_add_due_date.sql\` that upgrades the existing data; the box runs each new migration once, in order, before starting the new version. Never edit or delete a migration that already exists, and never drop data the owner didn't ask to remove.
- Adding a data store to the manifest is fine; removing one doesn't delete its data.

Current files:

${dump}`;
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
  context?: Omit<UserContextInput, "appEnvNames">;
  /** Per-provider fallback models (defaultModelsFromEnv). */
  defaultModels: Readonly<Record<string, string>>;
  /** The active model's context window (for compaction), when known. */
  contextTokens?: (provider: string, model: string) => Promise<number | undefined>;
  /**
   * Applied to what the compaction summariser reads and writes, and to the
   * box's own hidden notes in the conversation (a failure's reason can name
   * the server or the account).
   */
  redact?: ModelRedactor;
  /**
   * The effort levels a model takes ([] none, null can't tell). After a
   * switch of model or provider an effort the new model doesn't take is
   * dropped.
   */
  modelEfforts?: (provider: string, model: string) => Promise<string[] | null>;
}

/** Options for resuming: the message switched the model or provider. */
export interface ResumeOptions {
  switched?: boolean;
}

export interface StartStreamingArgs {
  sessionId: string;
  prompt: string;
  model?: string;
  /** Reasoning effort in the provider's own words; absent ⇒ its default. */
  effort?: string;
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
 * The model used when the owner didn't choose one, per provider. One global
 * default used to apply to every provider, so an OpenAI key was asked for
 * "claude-3-5-sonnet-latest". Each entry is a long-lived ID that takes tool
 * calls over the API our adapter speaks (OpenAI: Chat Completions). Ollama
 * has no default: whatever we guessed might not be pulled on the user's host.
 * Override per provider with FLAGSHIP_LLM_DEFAULT_MODEL_<PROVIDER>.
 */
export const DEFAULT_MODEL_BY_PROVIDER: Readonly<Record<string, string>> = {
  anthropic: "claude-sonnet-5-5",
  openai: "gpt-5",
  google: "gemini-3.5-flash",
  openrouter: "openrouter/auto",
  // Free AI credits: the shim swaps in its upstream's real model id.
  flagship: "flagship-free",
};

export function defaultModelsFromEnv(
  env: Record<string, string | undefined>,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = { ...DEFAULT_MODEL_BY_PROVIDER };
  for (const [key, value] of Object.entries(env)) {
    const m = /^FLAGSHIP_LLM_DEFAULT_MODEL_([A-Z0-9_]+)$/.exec(key);
    if (m && value && value.trim()) out[m[1]!.toLowerCase()] = value.trim();
  }
  return out;
}

export class NoDefaultModelError extends Error {}

export function modelForProvider(
  provider: string,
  requested: string | undefined,
  defaults: Readonly<Record<string, string>>,
): string {
  if (requested) return requested;
  const model = defaults[provider];
  if (!model) {
    throw new NoDefaultModelError(
      `Choose a model for ${provider}: there's no default for it.`,
    );
  }
  return model;
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
    if (s.model || s.effort) session.setModel(s.model, s.effort);
    let model: string;
    try {
      model = modelForProvider(credential.provider, session.meta.model, args.defaultModels);
    } catch (e) {
      session.fail((e as Error).message, true);
      return;
    }

    const serviceId = args.resolveAppId(s.sessionId);
    // CRITICAL: only .names(). `.get()` is never called on this path —
    // values must never reach the prompt or the request body.
    const appEnvNames = serviceId ? await args.appEnvStore.names(serviceId) : [];
    const systemMessage =
      buildUserContext({
        ...args.context,
        appEnvNames,
      }) +
      ownerChoiceSupplement(s.preferredName, s.visibility) +
      editSupplement(session.meta.editsServiceId ? session.meta.name : undefined, session.meta.editsServiceId ? session.files() : null) +
      "\n\n" +
      TOOL_USE_PROMPT_SUPPLEMENT;
    const request: ChatRequest = {
      model,
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
      ...(session.meta.effort ? { reasoningEffort: session.meta.effort } : {}),
    };

    await streamTurn(args.harness, credential, request, session);
    if (session.takeNudge()) await buildVibeCodeResumeStreaming(args)(s.sessionId);
  };
}

/** Stream one model turn into the session, charging its credits to the reply. */
async function streamTurn(
  harness: LlmHarness,
  credential: LlmCredential,
  request: ChatRequest,
  session: VibeCodeSession,
): Promise<void> {
  await harness.chatStream(credential, request, (e: ChatStreamEvent) => {
    if (e.kind === "delta") {
      session.feedAssistant(e.text);
      return;
    }
    if (e.kind === "tool_use") {
      session.receiveToolUse({ id: e.id, name: e.name, input: e.input });
      return;
    }
    if (e.kind === "end") {
      if (e.credits) session.recordCredits(e.credits);
      if (e.stopReason === "length" || e.stopReason === "max_tokens") session.markCutOff();
      session.endAssistant();
      return;
    }
    if (e.kind === "error") {
      session.fail(e.message, true);
    }
  });
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
): (sessionId: string, model?: string, opts?: ResumeOptions) => Promise<void> {
  return async function resumeStreaming(
    sessionId: string,
    model?: string,
    opts: ResumeOptions = {},
  ): Promise<void> {
    const session = args.registry.get(sessionId);
    if (!session) return;

    const credential = await args.credentials.get(sessionId);
    if (!credential) {
      session.fail("no AI credential set for this session", true);
      return;
    }
    if (model) session.setModel(model);
    let resolvedModel: string;
    try {
      resolvedModel = modelForProvider(credential.provider, session.meta.model, args.defaultModels);
    } catch (e) {
      session.fail((e as Error).message, true);
      return;
    }
    if ((opts.switched || model) && session.meta.effort && args.modelEfforts) {
      const efforts = await args.modelEfforts(credential.provider, resolvedModel).catch(() => null);
      if (efforts && !efforts.includes(session.meta.effort)) session.setModel(undefined, null);
    }
    const redact = args.redact ?? ((t: string) => t);

    // The prior turn marked the parser `done` (endAssistant → parser.end);
    // reset it so the resumed file output is actually parsed (otherwise the
    // session reaches ready-to-deploy with no files → deploy 502).
    session.prepareForResume();

    const serviceId = args.resolveAppId(sessionId);
    const appEnvNames = serviceId ? await args.appEnvStore.names(serviceId) : [];
    const systemMessage =
      buildUserContext({
        ...args.context,
        appEnvNames,
      }) +
      ownerChoiceSupplement(session.meta.editsServiceId ? undefined : session.meta.name, session.meta.visibility) +
      editSupplement(session.meta.editsServiceId ? session.meta.name : undefined, session.meta.editsServiceId ? session.files() : null) +
      "\n\n" +
      TOOL_USE_PROMPT_SUPPLEMENT;

    // Rebuild the running conversation. The model sees its own earlier output
    // (incl. the question it asked, narrated as assistant text) followed by the
    // owner's answer, and continues. Synthetic `[tool_result:…]` env-var-ack
    // entries are value-free by construction (see vibeCodeSession).
    const history = session.modelConversation();
    const acks = new Set<object>();
    const messages: ChatRequest["messages"] = [
      { role: "system", content: systemMessage },
      ...alternateTurns(
        history.map((h) => ({
          role: h.role,
          content: h.content.startsWith(HIDDEN_NOTE_PREFIX) ? redact(h.content) : h.content,
          ...(h.attachments && h.attachments.length > 0
            ? { attachments: h.attachments }
            : {}),
        })),
        () => {
          const ack = { role: "assistant" as const, content: "Noted." };
          acks.add(ack);
          return ack;
        },
      ),
    ];
    const tools = VIBE_CODE_TOOLS.map((t) => ({ ...t }));

    // A long conversation is summarised before it outgrows the model's context.
    const contextTokens = await args.contextTokens?.(credential.provider, resolvedModel).catch(() => undefined);
    const compacted = await compactIfNeeded({
      messages,
      tools,
      ...(contextTokens ? { contextTokens } : {}),
      model: resolvedModel,
      ...(args.redact ? { redact: args.redact } : {}),
      summarise: async (req) => {
        const r = await args.harness.chatWithCredential(credential, req);
        if (r.credits) session.recordCredits(r.credits);
        return r.content;
      },
    });
    if (compacted.replaced > 0 && compacted.summary) {
      const keptHistory = messages.slice(messages.length - compacted.kept).filter((m) => !acks.has(m)).length;
      session.setCompaction(session.historyLength() - keptHistory, compacted.summary);
    }

    const request: ChatRequest = {
      model: resolvedModel,
      messages: compacted.messages,
      tools,
      ...(session.meta.effort ? { reasoningEffort: session.meta.effort } : {}),
    };

    await streamTurn(args.harness, credential, request, session);
    if (session.takeNudge()) await resumeStreaming(sessionId);
  };
}
