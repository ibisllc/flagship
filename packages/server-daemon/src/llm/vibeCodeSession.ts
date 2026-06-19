/**
 * Vibe-coding session orchestrator.
 *
 * Sits on top of the existing `LlmHarness` (which speaks the BYOK
 * provider-call protocol). A session represents a back-and-forth
 * with the user: the user describes an app, the LLM streams a
 * structured response, may pause to ask the owner for an env var or to
 * chat, then resumes and emits the final file blocks. The harness
 * parses out the manifest + files + migrations, builds the container,
 * and deploys it.
 *
 * This module is the orchestration + parsing layer; provider calls
 * delegate to LlmHarness. The daemon's /api/llm/sessions HTTP + WS
 * surface drives this from the phone.
 *
 * Streaming protocol the LLM emits (see `systemPrompt.ts`):
 *
 *     === flagship.app.json ===
 *     <JSON content>
 *     === Dockerfile ===
 *     <content>
 *     === src/index.ts ===
 *     <content>
 *     === migrations/0001_init.sql ===
 *     <content>
 *     === END ===
 *
 * Tool-use events (requestEnvVar, talkToUser) arrive out-of-band from
 * the provider adapter and are surfaced as their own `VibeCodeEvent`s
 * — they do NOT flow through the line-oriented parser.
 *
 * State machine:
 *
 *     streaming  ──tool_use──▶  awaiting-tool-response
 *                                       │
 *                                       │ pushToolResult / pushUserReply
 *                                       ▼
 *                                  streaming
 *                                       │
 *                                       │  === END ===
 *                                       ▼
 *                                  ready-to-deploy
 */

import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import type { Attachment } from "@flagship/llm-providers";

export type VibeCodeEvent =
  | { kind: "thinking"; text: string }
  | { kind: "file-start"; filename: string }
  | { kind: "chunk"; filename: string; text: string }
  | { kind: "file-complete"; filename: string; content: string }
  | { kind: "phase"; phase: "build" | "migrate" | "deploy" | "ready"; detail?: string }
  | { kind: "deployed"; serviceId: string; url: string }
  | { kind: "error"; message: string; recoverable: boolean }
  | { kind: "done"; manifestJson?: string; files: Record<string, string> }
  | {
      /**
       * The model invoked the `requestEnvVar` tool. The session is now
       * paused (status = awaiting-tool-response); the orchestrator must
       * either deliver a signed `set-app-env` order out-of-band and
       * post a `tool-ack` with status "set", or post a tool-ack with
       * "declined" / "deferred". The ack payload fed back to the model
       * is VALUE-FREE by type — see `EnvVarAckPayload` below.
       */
      kind: "request-env-var";
      id: string;
      name: string;
      description: string;
      why: string;
      example?: string;
      secret?: boolean;
    }
  | {
      /**
       * The model invoked the `talkToUser` tool — a free-form mid-build
       * message. The session is paused; the owner posts a free-form
       * reply via `user-reply`, which the orchestrator feeds back as a
       * user-role message. By contract this channel is NOT for secret
       * values; the system prompt forbids the model from soliciting
       * them this way.
       */
      kind: "talk-to-user";
      id: string;
      message: string;
    };

/**
 * The VALUE-FREE acknowledgement payload that flows BACK to the model
 * after a `requestEnvVar` tool_use. The orchestrator's pushToolResult
 * for env-var requests MUST construct this shape — TypeScript prevents
 * any field from carrying a value. Sentinel-tested.
 */
export interface EnvVarAckPayload {
  readonly acknowledged: true;
  /** Mirrors the originally-requested name so the model can match it. */
  readonly name: string;
  /**
   * The owner's decision routed through the UI:
   *   - "set"      ⇒ the owner provided a value via the signed
   *                  set-app-env order; the daemon now has it. The
   *                  model gets ONLY this status — never the value.
   *   - "declined" ⇒ the owner refused; the model should adapt.
   *   - "deferred" ⇒ the owner said "later"; the model may try again
   *                  in a follow-up turn or proceed without it.
   */
  readonly status: "set" | "declined" | "deferred";
  /** Whether `appEnvStore.names(serviceId)` now includes the name. */
  readonly currentlySet: boolean;
}

/** Compile-time check: EnvVarAckPayload may never grow a value-shaped field. */
type _NoValueField<T> = T extends { value: unknown }
  ? "ERROR: EnvVarAckPayload must not include a value field"
  : T;
type _AckCheck = _NoValueField<EnvVarAckPayload>;
// Touch the type so it doesn't go unused.
const _envVarAckCompileCheck: _AckCheck = {
  acknowledged: true,
  name: "",
  status: "declined",
  currentlySet: false,
} as _AckCheck;
void _envVarAckCompileCheck;

export type ToolAckStatus = "set" | "declined" | "deferred";

export interface VibeCodeSessionMeta {
  sessionId: string;
  username: string;
  serverFqdn: string;
  startedAt: number;
  status:
    | "streaming"
    | "awaiting-tool-response"
    | "ready-to-deploy"
    | "deploying"
    | "deployed"
    | "failed"
    | "cancelled";
  serviceId?: string;
  url?: string;
}

const FILE_BOUNDARY = /^===\s+(.+?)\s+===\s*$/;
const END_BOUNDARY = /^===\s+END\s+===\s*$/;

/**
 * Parses the LLM's structured output into events. Stateful: feed
 * chunks in via `feed(text)`; subscribe with `on("event", handler)`.
 *
 * Only handles TEXT — tool-use events are surfaced by the session, not
 * the parser. The parser is reset across the awaiting-tool-response
 * boundary so a tool result that arrives mid-file can resume cleanly.
 */
export class VibeCodeStreamParser extends EventEmitter {
  private buf = "";
  private currentFile: string | null = null;
  private currentContent = "";
  private files: Record<string, string> = {};
  private done = false;

  feed(text: string): void {
    if (this.done) return;
    this.buf += text;
    // Drain complete lines.
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.handleLine(line);
    }
  }

  /** Mark the stream finished — flushes any trailing buffered content. */
  end(): void {
    if (this.buf.length > 0) {
      this.handleLine(this.buf);
      this.buf = "";
    }
    if (!this.done) {
      this.flushCurrent();
      this.completeDone();
    }
  }

  /** Whether a `=== END ===` boundary has been observed. */
  isDone(): boolean {
    return this.done;
  }

  private handleLine(line: string): void {
    if (END_BOUNDARY.test(line)) {
      this.flushCurrent();
      this.completeDone();
      return;
    }
    const m = line.match(FILE_BOUNDARY);
    if (m) {
      this.flushCurrent();
      const filename = m[1]!.trim();
      this.currentFile = filename;
      this.currentContent = "";
      this.emit("event", { kind: "file-start", filename } as VibeCodeEvent);
      return;
    }
    if (this.currentFile) {
      const piece = line + "\n";
      this.currentContent += piece;
      this.emit("event", { kind: "chunk", filename: this.currentFile, text: piece } as VibeCodeEvent);
    } else {
      // Outside a file boundary — treated as 'thinking'/preamble text.
      if (line.length > 0) {
        this.emit("event", { kind: "thinking", text: line + "\n" } as VibeCodeEvent);
      }
    }
  }

  private flushCurrent(): void {
    if (this.currentFile != null) {
      const content = this.currentContent.replace(/\n+$/, "\n");
      this.files[this.currentFile] = content;
      this.emit("event", {
        kind: "file-complete",
        filename: this.currentFile,
        content,
      } as VibeCodeEvent);
      this.currentFile = null;
      this.currentContent = "";
    }
  }

  private completeDone(): void {
    this.done = true;
    const manifestJson = this.files["flagship.app.json"];
    this.emit("event", { kind: "done", manifestJson, files: { ...this.files } } as VibeCodeEvent);
  }

  /** Snapshot of files emitted so far. */
  snapshot(): Record<string, string> {
    return { ...this.files };
  }
}

/** A pending tool_use the orchestrator is waiting on the owner to resolve. */
export interface PendingToolUse {
  id: string;
  name: string;
  /** Original arguments the model produced. The orchestrator stores them so
   *  the resulting tool_result message can echo `tool_use_id` correctly. */
  input: Record<string, unknown>;
  createdAt: number;
}

/**
 * W10 — callback fired when the session transitions into
 * `awaiting-tool-response` (i.e. the AI just emitted a `requestEnvVar`
 * or `talkToUser`). The daemon production wiring routes this to a Web
 * Push fan-out so the owner's phone wakes up; tests inject a stub and
 * assert it fires exactly once per transition.
 *
 * The callback receives ONLY the session id + the pending tool kind +
 * the tool-use id. No tool arguments, no model output, no env-var
 * value — only enough to identify the session on the phone and route
 * a deep link.
 */
export type NotifyOwnerCallback = (args: {
  sessionId: string;
  kind: "requestEnvVar" | "talkToUser";
  toolUseId: string;
}) => void;

/**
 * One end-to-end session. Holds the parser, the conversation history,
 * the deploy phase emitter, and the pending tool-use slot.
 */
export class VibeCodeSession extends EventEmitter {
  readonly meta: VibeCodeSessionMeta;
  // Not `readonly`: it is REPLACED with a fresh parser when the conversation
  // resumes after a tool reply (see `prepareForResume`). A parser that observed
  // `=== END ===` — or whose turn merely ended after a talkToUser question —
  // is `done` and silently ignores all further `feed()`, so without a reset the
  // resumed file output would never be parsed (the session would reach
  // ready-to-deploy with NO files → deploy 502).
  parser = new VibeCodeStreamParser();
  private readonly history: Array<{
    role: "user" | "assistant";
    content: string;
    /** Multimodal attachments on a user turn (image / text). */
    attachments?: Attachment[];
  }> = [];
  /** Unix-ms per history entry — parallel to `history`. */
  private readonly historyTimestamps: number[] = [];
  private cancelled = false;
  /** Active tool-uses indexed by id. At most one is meaningful in V1 but
   *  multi-tool turns are tolerated; the orchestrator clears each on ack. */
  private readonly pendingTools = new Map<string, PendingToolUse>();
  /** W10 — owner-notify hook fired on awaiting-tool-response transition. */
  private notifyOwner: NotifyOwnerCallback | null = null;

  constructor(args: { username: string; serverFqdn: string; sessionId?: string }) {
    super();
    this.meta = {
      sessionId: args.sessionId ?? generateSessionId(),
      username: args.username,
      serverFqdn: args.serverFqdn,
      startedAt: Date.now(),
      status: "streaming",
    };
    this.parser.on("event", (e: VibeCodeEvent) => this.emit("event", e));
  }

  /**
   * W10 — install the owner-notify hook. Production wires this to the
   * Web Push fan-out at session-start time; tests inject a stub.
   * Subsequent calls replace the prior callback (last-writer-wins).
   */
  setNotifyOwner(cb: NotifyOwnerCallback | null): void {
    this.notifyOwner = cb;
  }

  /**
   * Append a user turn. `attachments` (image / text) ride alongside the
   * text and are carried through to the next `ChatRequest`'s
   * corresponding user message. Attachments are VALUE-FREE w.r.t. secrets
   * by contract — the chat is not a secret channel. Empty attachment
   * arrays are normalized away.
   */
  pushUserMessage(text: string, attachments?: Attachment[]): void {
    this.history.push({
      role: "user",
      content: text,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    });
    this.historyTimestamps.push(Date.now());
  }

  /** Feed a chunk of streamed assistant output. */
  feedAssistant(chunk: string): void {
    if (this.cancelled) return;
    const last = this.history[this.history.length - 1];
    if (last?.role === "assistant") {
      last.content += chunk;
    } else {
      this.history.push({ role: "assistant", content: chunk });
      this.historyTimestamps.push(Date.now());
    }
    this.parser.feed(chunk);
  }

  /**
   * Mirror a tool_use event from the provider adapter into the session.
   * Emits the corresponding view-shaped event and pauses the session.
   */
  receiveToolUse(args: { id: string; name: string; input: Record<string, unknown> }): void {
    if (this.cancelled) return;
    const wasStreaming = this.meta.status === "streaming";
    this.pendingTools.set(args.id, {
      id: args.id,
      name: args.name,
      input: args.input,
      createdAt: Date.now(),
    });
    this.meta.status = "awaiting-tool-response";
    // W10 — fire the owner-notify hook on the streaming →
    // awaiting-tool-response transition. We only fire on the FIRST
    // pending tool so a multi-tool turn doesn't fan out a flurry of
    // pushes. Subsequent acks return to streaming; if the model emits
    // another tool, the next call re-enters this branch.
    if (
      wasStreaming &&
      this.notifyOwner &&
      (args.name === "requestEnvVar" || args.name === "talkToUser")
    ) {
      try {
        this.notifyOwner({
          sessionId: this.meta.sessionId,
          kind: args.name,
          toolUseId: args.id,
        });
      } catch {
        // The notify hook must never break the session. Swallow.
      }
    }
    if (args.name === "requestEnvVar") {
      const name = typeof args.input.name === "string" ? args.input.name : "";
      const description =
        typeof args.input.description === "string" ? args.input.description : "";
      const why = typeof args.input.why === "string" ? args.input.why : "";
      const example =
        typeof args.input.example === "string" ? args.input.example : undefined;
      const secret = typeof args.input.secret === "boolean" ? args.input.secret : undefined;
      this.emit("event", {
        kind: "request-env-var",
        id: args.id,
        name,
        description,
        why,
        example,
        secret,
      } as VibeCodeEvent);
      return;
    }
    if (args.name === "talkToUser") {
      const message =
        typeof args.input.message === "string" ? args.input.message : "";
      this.emit("event", {
        kind: "talk-to-user",
        id: args.id,
        message,
      } as VibeCodeEvent);
      return;
    }
    // Unknown tool — fail closed: surface an error so the orchestrator
    // doesn't silently dangle in awaiting-tool-response.
    this.emit("event", {
      kind: "error",
      message: `unknown tool '${args.name}' invoked by model`,
      recoverable: true,
    } as VibeCodeEvent);
  }

  /** Resolve a pending requestEnvVar ack. The payload is VALUE-FREE by type. */
  pushEnvVarAck(args: { toolUseId: string; ack: EnvVarAckPayload }): { ok: boolean; reason?: string } {
    const entry = this.pendingTools.get(args.toolUseId);
    if (!entry) return { ok: false, reason: "no pending tool with that id" };
    if (entry.name !== "requestEnvVar") {
      return { ok: false, reason: `tool id is not requestEnvVar (got '${entry.name}')` };
    }
    // The ack payload is the EnvVarAckPayload shape — by type it cannot
    // carry a value. We serialize it into the next assistant turn's
    // tool_result so the provider sees value-free metadata only.
    const json = JSON.stringify(args.ack);
    this.history.push({
      role: "user",
      content: `[tool_result:${args.toolUseId}] ${json}`,
    });
    this.historyTimestamps.push(Date.now());
    this.pendingTools.delete(args.toolUseId);
    if (this.pendingTools.size === 0 && this.meta.status === "awaiting-tool-response") {
      this.meta.status = "streaming";
    }
    return { ok: true };
  }

  /**
   * Resolve a pending talkToUser tool_use with the owner's free-form
   * reply. `attachments` (image / text) ride alongside the text into the
   * next turn's user message, same as `pushUserMessage`. Value-free
   * w.r.t. secrets by contract.
   */
  pushUserReply(args: {
    toolUseId: string;
    text: string;
    attachments?: Attachment[];
  }): { ok: boolean; reason?: string } {
    const entry = this.pendingTools.get(args.toolUseId);
    if (!entry) return { ok: false, reason: "no pending tool with that id" };
    if (entry.name !== "talkToUser") {
      return { ok: false, reason: `tool id is not talkToUser (got '${entry.name}')` };
    }
    this.history.push({
      role: "user",
      content: args.text,
      ...(args.attachments && args.attachments.length > 0
        ? { attachments: args.attachments }
        : {}),
    });
    this.historyTimestamps.push(Date.now());
    this.pendingTools.delete(args.toolUseId);
    if (this.pendingTools.size === 0 && this.meta.status === "awaiting-tool-response") {
      this.meta.status = "streaming";
    }
    return { ok: true };
  }

  /** Snapshot of currently-pending tool calls. */
  pendingToolUses(): PendingToolUse[] {
    return [...this.pendingTools.values()];
  }

  endAssistant(): void {
    this.parser.end();
    if (
      !this.cancelled &&
      (this.meta.status === "streaming" || this.meta.status === "awaiting-tool-response")
    ) {
      // The model may finish its turn while a tool is still pending —
      // we leave the session in awaiting-tool-response in that case so
      // a downstream user-reply / tool-ack can resume it. Only flip to
      // ready-to-deploy when the parser observed `=== END ===` and no
      // tool is pending.
      if (this.pendingTools.size === 0 && this.parser.isDone()) {
        this.meta.status = "ready-to-deploy";
        this.emit("event", {
          kind: "phase",
          phase: "build",
          detail: "ready to deploy",
        } as VibeCodeEvent);
      }
    }
  }

  /**
   * Reset the file parser before the conversation RESUMES (after a `talkToUser`
   * reply or a `requestEnvVar` ack). The prior turn called `endAssistant()` →
   * `parser.end()`, which marks the parser `done`; a `done` parser ignores all
   * further `feed()`, so the resumed turn's `=== file === / === END ===` output
   * would otherwise never be captured (the session would reach ready-to-deploy
   * with NO files → deploy 502). Installing a fresh parser (same event wiring)
   * lets the continued stream emit its files. The model holds the full build
   * spec across the turn, so it re-emits any blocks it may have started before
   * asking — a clean parser is the safe reset.
   */
  prepareForResume(): void {
    const next = new VibeCodeStreamParser();
    next.on("event", (e: VibeCodeEvent) => this.emit("event", e));
    this.parser = next;
  }

  cancel(): void {
    this.cancelled = true;
    this.meta.status = "cancelled";
    // Drop any pending tool-uses — callers waiting on a tool-ack will
    // get a "no pending tool" reason if they race the cancel.
    this.pendingTools.clear();
  }

  /**
   * Mark the session as deployed — caller invokes after ServicePlatform.install
   * succeeds. The state-machine constraint that matters here is: you may
   * NOT deploy while a tool_use is pending (`awaiting-tool-response`),
   * because the model hasn't been given the chance to incorporate the
   * tool result yet. All other prior states (streaming, ready-to-deploy,
   * deploying) flow through — markDeployed is idempotent.
   */
  markDeployed(args: { serviceId: string; url: string }): void {
    if (this.meta.status === "awaiting-tool-response") {
      this.emit("event", {
        kind: "error",
        message: "cannot deploy from status 'awaiting-tool-response'",
        recoverable: true,
      } as VibeCodeEvent);
      return;
    }
    this.meta.status = "deployed";
    this.meta.serviceId = args.serviceId;
    this.meta.url = args.url;
    this.emit("event", { kind: "deployed", serviceId: args.serviceId, url: args.url } as VibeCodeEvent);
  }

  fail(message: string, recoverable = false): void {
    this.meta.status = "failed";
    this.emit("event", { kind: "error", message, recoverable } as VibeCodeEvent);
  }

  files(): Record<string, string> {
    return this.parser.snapshot();
  }
  manifestJson(): string | undefined {
    return this.parser.snapshot()["flagship.app.json"];
  }
  conversation(): ReadonlyArray<{
    role: "user" | "assistant";
    content: string;
    attachments?: Attachment[];
  }> {
    return [...this.history];
  }

  /**
   * W10 — public message log shaped for the BFF chat surface. Drops
   * synthetic `[tool_result:<id>] …` entries (those are model-facing
   * metadata, not human chat) and surfaces a unix-ms timestamp per
   * message. The role mapping is the same as `conversation()`.
   */
  messages(): Array<{
    role: "user" | "assistant";
    text: string;
    timestamp: number;
    attachments?: Attachment[];
  }> {
    const out: Array<{
      role: "user" | "assistant";
      text: string;
      timestamp: number;
      attachments?: Attachment[];
    }> = [];
    for (let i = 0; i < this.history.length; i++) {
      const h = this.history[i];
      if (!h) continue;
      if (h.content.startsWith("[tool_result:")) continue;
      out.push({
        role: h.role,
        text: h.content,
        timestamp: this.historyTimestamps[i] ?? this.meta.startedAt,
        ...(h.attachments && h.attachments.length > 0 ? { attachments: h.attachments } : {}),
      });
    }
    return out;
  }

  /**
   * W10 — the single pending tool the AI is waiting on, if any. Returns
   * the FIRST pending tool when more than one is active (the chat
   * surface drives them one at a time). Value-free by construction —
   * the input map is the model's emitted arguments, never an owner
   * response.
   */
  pendingRequest():
    | { kind: "requestEnvVar"; toolUseId: string; input: Record<string, unknown> }
    | { kind: "talkToUser"; toolUseId: string; input: Record<string, unknown> }
    | null {
    const next = this.pendingTools.values().next();
    if (next.done) return null;
    const t = next.value;
    if (t.name === "requestEnvVar" || t.name === "talkToUser") {
      return { kind: t.name, toolUseId: t.id, input: { ...t.input } };
    }
    return null;
  }
}

function generateSessionId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * In-memory session registry. Production daemon-startup builds this
 * once; HTTP handlers look up sessions by ID.
 *
 * W10 — accepts an optional `notifyOwner` callback that the registry
 * installs on every freshly-`create()`'d session so the production
 * Web Push fan-out fires on the awaiting-tool-response transition.
 * Tests pass a stub here and assert it fires once per tool_use.
 */
export class VibeCodeSessionRegistry {
  private byId = new Map<string, VibeCodeSession>();
  private notifyOwner: NotifyOwnerCallback | null = null;

  setNotifyOwner(cb: NotifyOwnerCallback | null): void {
    this.notifyOwner = cb;
    // Apply to any already-created sessions so a late wiring still
    // gets coverage on the next tool_use that fires.
    for (const s of this.byId.values()) s.setNotifyOwner(cb);
  }

  create(args: { username: string; serverFqdn: string }): VibeCodeSession {
    const session = new VibeCodeSession(args);
    if (this.notifyOwner) session.setNotifyOwner(this.notifyOwner);
    this.byId.set(session.meta.sessionId, session);
    return session;
  }
  get(id: string): VibeCodeSession | undefined {
    return this.byId.get(id);
  }
  list(): VibeCodeSessionMeta[] {
    return [...this.byId.values()].map((s) => ({ ...s.meta }));
  }
  remove(id: string): void {
    this.byId.delete(id);
  }
}

/**
 * Heuristic — does this free-form chat reply look like an API key /
 * credential the user accidentally pasted? Observational only; the
 * orchestrator logs but does not block. The model's system prompt
 * already forbids soliciting secrets via chat; this is a defense-in-
 * depth signal for the daemon's operator-visible logs.
 */
export function looksLikePastedSecret(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  // OpenAI / Stripe / many keys
  if (/\bsk-[A-Za-z0-9_-]{16,}\b/.test(t)) return true;
  // AWS access key id
  if (/\bAKIA[0-9A-Z]{16}\b/.test(t)) return true;
  // GitHub personal access token
  if (/\bghp_[A-Za-z0-9]{30,}\b/.test(t)) return true;
  // Generic JWT
  if (/\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/.test(t)) return true;
  return false;
}
