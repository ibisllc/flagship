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

export type VibeCodeEvent =
  | { kind: "thinking"; text: string }
  | { kind: "file-start"; filename: string }
  | { kind: "chunk"; filename: string; text: string }
  | { kind: "file-complete"; filename: string; content: string }
  | { kind: "phase"; phase: "build" | "migrate" | "deploy" | "ready"; detail?: string }
  | { kind: "deployed"; appId: string; url: string }
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
  /** Whether `appEnvStore.names(appId)` now includes the name. */
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
  appId?: string;
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
 * One end-to-end session. Holds the parser, the conversation history,
 * the deploy phase emitter, and the pending tool-use slot.
 */
export class VibeCodeSession extends EventEmitter {
  readonly meta: VibeCodeSessionMeta;
  readonly parser = new VibeCodeStreamParser();
  private readonly history: Array<{ role: "user" | "assistant"; content: string }> = [];
  private cancelled = false;
  /** Active tool-uses indexed by id. At most one is meaningful in V1 but
   *  multi-tool turns are tolerated; the orchestrator clears each on ack. */
  private readonly pendingTools = new Map<string, PendingToolUse>();

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

  pushUserMessage(text: string): void {
    this.history.push({ role: "user", content: text });
  }

  /** Feed a chunk of streamed assistant output. */
  feedAssistant(chunk: string): void {
    if (this.cancelled) return;
    const last = this.history[this.history.length - 1];
    if (last?.role === "assistant") {
      last.content += chunk;
    } else {
      this.history.push({ role: "assistant", content: chunk });
    }
    this.parser.feed(chunk);
  }

  /**
   * Mirror a tool_use event from the provider adapter into the session.
   * Emits the corresponding view-shaped event and pauses the session.
   */
  receiveToolUse(args: { id: string; name: string; input: Record<string, unknown> }): void {
    if (this.cancelled) return;
    this.pendingTools.set(args.id, {
      id: args.id,
      name: args.name,
      input: args.input,
      createdAt: Date.now(),
    });
    this.meta.status = "awaiting-tool-response";
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
    this.pendingTools.delete(args.toolUseId);
    if (this.pendingTools.size === 0 && this.meta.status === "awaiting-tool-response") {
      this.meta.status = "streaming";
    }
    return { ok: true };
  }

  /** Resolve a pending talkToUser tool_use with the owner's free-form reply. */
  pushUserReply(args: { toolUseId: string; text: string }): { ok: boolean; reason?: string } {
    const entry = this.pendingTools.get(args.toolUseId);
    if (!entry) return { ok: false, reason: "no pending tool with that id" };
    if (entry.name !== "talkToUser") {
      return { ok: false, reason: `tool id is not talkToUser (got '${entry.name}')` };
    }
    this.history.push({ role: "user", content: args.text });
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

  cancel(): void {
    this.cancelled = true;
    this.meta.status = "cancelled";
    // Drop any pending tool-uses — callers waiting on a tool-ack will
    // get a "no pending tool" reason if they race the cancel.
    this.pendingTools.clear();
  }

  /**
   * Mark the session as deployed — caller invokes after AppPlatform.install
   * succeeds. The state-machine constraint that matters here is: you may
   * NOT deploy while a tool_use is pending (`awaiting-tool-response`),
   * because the model hasn't been given the chance to incorporate the
   * tool result yet. All other prior states (streaming, ready-to-deploy,
   * deploying) flow through — markDeployed is idempotent.
   */
  markDeployed(args: { appId: string; url: string }): void {
    if (this.meta.status === "awaiting-tool-response") {
      this.emit("event", {
        kind: "error",
        message: "cannot deploy from status 'awaiting-tool-response'",
        recoverable: true,
      } as VibeCodeEvent);
      return;
    }
    this.meta.status = "deployed";
    this.meta.appId = args.appId;
    this.meta.url = args.url;
    this.emit("event", { kind: "deployed", appId: args.appId, url: args.url } as VibeCodeEvent);
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
  conversation(): ReadonlyArray<{ role: "user" | "assistant"; content: string }> {
    return [...this.history];
  }
}

function generateSessionId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * In-memory session registry. Production daemon-startup builds this
 * once; HTTP handlers look up sessions by ID.
 */
export class VibeCodeSessionRegistry {
  private byId = new Map<string, VibeCodeSession>();

  create(args: { username: string; serverFqdn: string }): VibeCodeSession {
    const session = new VibeCodeSession(args);
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
