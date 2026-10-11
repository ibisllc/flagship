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
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  /**
   * The reason the session failed, captured at `fail()` time. Persisted on
   * meta so a client that re-attaches AFTER the failure (its live WS dropped,
   * the user reopened the Building screen) gets the actual cause instead of a
   * generic "session failed" — the original error event is long gone by then.
   */
  failureReason?: string;
  /** Unix-ms of the last change; drives eviction and the 30-day expiry. */
  updatedAt?: number;
  /**
   * The owner's chosen name: the deployed service's slug and web-address
   * label. Held by the session until it is deployed or discarded, so no other
   * build can take it.
   */
  name?: string;
  /** Who the owner chose can reach it: "just-me" is invite only. */
  visibility?: "just-me" | "link";
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

  /** Restore a saved parse: its files, already finished. */
  seed(files: Record<string, string>): void {
    this.files = { ...files };
    this.done = true;
  }

  /** Snapshot of files emitted so far. */
  snapshot(): Record<string, string> {
    return { ...this.files };
  }

  /**
   * The system prompt lets the model ask in text (`=== QUESTION === … === END
   * ===`) instead of calling talkToUser. That block parses like a file named
   * QUESTION, so take it out of the files and return its text; null when the
   * turn asked nothing.
   */
  takeQuestion(): string | null {
    const raw = this.files["QUESTION"];
    if (raw === undefined) return null;
    delete this.files["QUESTION"];
    const text = raw.trim();
    return text.length > 0 ? text : null;
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

export interface VibeCodeSessionSnapshot {
  v: 1;
  meta: VibeCodeSessionMeta;
  history: Array<{ role: "user" | "assistant"; content: string; attachments?: Attachment[] }>;
  historyTimestamps: number[];
  files: Record<string, string>;
  pendingTools: PendingToolUse[];
  cancelled: boolean;
}

export const INTERRUPTED_REASON = "The server restarted while this build was running. Its files are kept; deploy again, or start a new build.";

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

  constructor(args: {
    username: string;
    serverFqdn: string;
    sessionId?: string;
    name?: string;
    visibility?: "just-me" | "link";
  }) {
    super();
    this.meta = {
      sessionId: args.sessionId ?? generateSessionId(),
      username: args.username,
      serverFqdn: args.serverFqdn,
      startedAt: Date.now(),
      status: "streaming",
      ...(args.name ? { name: args.name } : {}),
      ...(args.visibility ? { visibility: args.visibility } : {}),
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
    this.emit("persist");
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
    this.emit("persist");
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
    this.emit("persist");
    return { ok: true };
  }

  /** Snapshot of currently-pending tool calls. */
  pendingToolUses(): PendingToolUse[] {
    return [...this.pendingTools.values()];
  }

  endAssistant(): void {
    this.parser.end();
    // A text-form question is a question, not a finished app: route it through
    // the same pending talkToUser slot the tool uses, so the owner gets a
    // reply box (and a push) instead of a Deploy button for a "file" holding
    // the question.
    const question = this.parser.takeQuestion();
    if (question !== null && !this.cancelled && this.meta.status === "streaming") {
      this.receiveToolUse({
        id: `question-${Date.now().toString(36)}`,
        name: "talkToUser",
        input: { message: question },
      });
      return;
    }
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
    this.emit("persist");
  }

  /** Everything needed to bring the session back after a daemon restart. */
  toSnapshot(): VibeCodeSessionSnapshot {
    return {
      v: 1,
      meta: { ...this.meta },
      history: this.history.map((h) => ({ ...h })),
      historyTimestamps: [...this.historyTimestamps],
      files: this.parser.snapshot(),
      pendingTools: [...this.pendingTools.values()],
      cancelled: this.cancelled,
    };
  }

  /**
   * Rebuild a saved session. One that was mid-stream or mid-deploy when the
   * daemon stopped can't continue that work, so it comes back failed with
   * the reason; its files and conversation are intact, so a deploy can be
   * retried.
   */
  static fromSnapshot(snap: VibeCodeSessionSnapshot): VibeCodeSession {
    const s = new VibeCodeSession({
      username: snap.meta.username,
      serverFqdn: snap.meta.serverFqdn,
      sessionId: snap.meta.sessionId,
    });
    Object.assign(s.meta, snap.meta);
    for (let i = 0; i < snap.history.length; i++) {
      s.history.push({ ...snap.history[i]! });
      s.historyTimestamps.push(snap.historyTimestamps[i] ?? snap.meta.startedAt);
    }
    s.parser.seed(snap.files);
    for (const t of snap.pendingTools) s.pendingTools.set(t.id, t);
    s.cancelled = snap.cancelled;
    if (s.meta.status === "streaming" || s.meta.status === "deploying") {
      s.meta.status = "failed";
      s.meta.failureReason = INTERRUPTED_REASON;
    }
    return s;
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
    this.meta.failureReason = message;
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
 * Session registry. Sessions live in memory while in use; with a store they
 * are also saved on every change, so a daemon restart (an update, a reboot)
 * no longer ends them: `get` reloads one from disk on demand and `list`
 * includes the saved ones. `sweep` drops finished sessions from memory after
 * a day and deletes saved sessions a month after their last change.
 *
 * W10 — accepts an optional `notifyOwner` callback that the registry
 * installs on every session so the production Web Push fan-out fires on
 * the awaiting-tool-response transition.
 */
export class VibeCodeSessionRegistry {
  private byId = new Map<string, VibeCodeSession>();
  private notifyOwner: NotifyOwnerCallback | null = null;
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly store: VibeCodeSessionStore | null = null,
    private readonly opts: {
      saveDelayMs?: number;
      now?: () => number;
      onLog?: (m: string) => void;
      /** A session's saved state is gone for good; drop what else it holds (its AI key). */
      onDelete?: (id: string) => void;
    } = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  setNotifyOwner(cb: NotifyOwnerCallback | null): void {
    this.notifyOwner = cb;
    for (const s of this.byId.values()) s.setNotifyOwner(cb);
  }

  private adopt(session: VibeCodeSession): VibeCodeSession {
    if (this.notifyOwner) session.setNotifyOwner(this.notifyOwner);
    this.byId.set(session.meta.sessionId, session);
    if (this.store) {
      const schedule = () => this.scheduleSave(session);
      session.on("event", schedule);
      session.on("persist", schedule);
    }
    return session;
  }

  private scheduleSave(session: VibeCodeSession): void {
    const id = session.meta.sessionId;
    session.meta.updatedAt = this.now();
    if (this.saveTimers.has(id)) return;
    const t = setTimeout(() => {
      this.saveTimers.delete(id);
      this.saveNow(session);
    }, this.opts.saveDelayMs ?? 1500);
    t.unref?.();
    this.saveTimers.set(id, t);
  }

  private saveNow(session: VibeCodeSession): void {
    try {
      this.store?.save(session.toSnapshot());
    } catch (e) {
      this.opts.onLog?.(`[vibe] could not save session ${session.meta.sessionId}: ${(e as Error).message}`);
    }
  }

  /** Write any pending saves now (daemon shutdown, tests). */
  flush(): void {
    for (const [id, t] of this.saveTimers) {
      clearTimeout(t);
      const s = this.byId.get(id);
      if (s) this.saveNow(s);
    }
    this.saveTimers.clear();
  }

  create(args: {
    username: string;
    serverFqdn: string;
    name?: string;
    visibility?: "just-me" | "link";
  }): VibeCodeSession {
    const session = this.adopt(new VibeCodeSession(args));
    session.meta.updatedAt = this.now();
    this.saveNow(session);
    return session;
  }

  get(id: string): VibeCodeSession | undefined {
    const live = this.byId.get(id);
    if (live || !this.store) return live;
    const snap = this.store.load(id);
    if (!snap) return undefined;
    const session = this.adopt(VibeCodeSession.fromSnapshot(snap));
    if (session.meta.status !== snap.meta.status) this.saveNow(session);
    return session;
  }

  list(): VibeCodeSessionMeta[] {
    const out = new Map<string, VibeCodeSessionMeta>();
    for (const m of this.store?.listMeta() ?? []) {
      out.set(m.sessionId, m.status === "streaming" || m.status === "deploying"
        ? { ...m, status: "failed", failureReason: INTERRUPTED_REASON }
        : m);
    }
    for (const s of this.byId.values()) out.set(s.meta.sessionId, { ...s.meta });
    return [...out.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * The open session holding `name`, if any. A deployed session's name now
   * belongs to its app and a cancelled one has let it go; any other session,
   * a failed one included, still holds it, because it can still deploy.
   */
  holderOf(name: string, exceptId?: string): VibeCodeSessionMeta | undefined {
    const wanted = name.toLowerCase();
    return this.list().find((m) =>
      m.sessionId !== exceptId &&
      m.name?.toLowerCase() === wanted &&
      m.status !== "deployed" &&
      m.status !== "cancelled");
  }

  /** Stop the session and delete it, its files and its AI key. */
  discard(id: string): boolean {
    const session = this.get(id);
    if (!session) return false;
    session.removeAllListeners();
    session.cancel();
    const t = this.saveTimers.get(id);
    if (t) clearTimeout(t);
    this.saveTimers.delete(id);
    this.remove(id);
    return true;
  }

  remove(id: string): void {
    this.byId.delete(id);
    this.store?.delete(id);
    this.opts.onDelete?.(id);
  }

  sweep(): void {
    const now = this.now();
    for (const [id, s] of this.byId) {
      const finished = ["deployed", "failed", "cancelled"].includes(s.meta.status);
      if (finished && now - (s.meta.updatedAt ?? s.meta.startedAt) > SESSION_IDLE_EVICT_MS && !this.saveTimers.has(id)) {
        this.byId.delete(id);
        s.removeAllListeners();
      }
    }
    for (const m of this.store?.listMeta() ?? []) {
      if (now - (m.updatedAt ?? m.startedAt) > SESSION_RETENTION_MS && !this.byId.has(m.sessionId)) {
        this.store?.delete(m.sessionId);
        this.opts.onDelete?.(m.sessionId);
      }
    }
  }
}

/** A finished session leaves memory after a day without changes. */
export const SESSION_IDLE_EVICT_MS = 24 * 60 * 60_000;
/** Saved sessions are deleted a month after their last change. */
export const SESSION_RETENTION_MS = 30 * 24 * 60 * 60_000;

/**
 * Where sessions are saved. The full snapshot (conversation + files) and a
 * small meta file are kept apart so listing never reads the code.
 */
export interface VibeCodeSessionStore {
  save(snap: VibeCodeSessionSnapshot): void;
  load(id: string): VibeCodeSessionSnapshot | null;
  listMeta(): VibeCodeSessionMeta[];
  delete(id: string): void;
}

const SESSION_ID_RE = /^[0-9a-f]{16}$/;

export function fileVibeCodeSessionStore(dir: string): VibeCodeSessionStore {
  const full = (id: string) => join(dir, `${id}.json`);
  const meta = (id: string) => join(dir, `${id}.meta.json`);
  const write = (path: string, body: string) => {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, path);
  };
  return {
    save(snap) {
      if (!SESSION_ID_RE.test(snap.meta.sessionId)) return;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      write(full(snap.meta.sessionId), JSON.stringify(snap));
      write(meta(snap.meta.sessionId), JSON.stringify(snap.meta));
    },
    load(id) {
      if (!SESSION_ID_RE.test(id)) return null;
      try {
        const snap = JSON.parse(readFileSync(full(id), "utf8")) as VibeCodeSessionSnapshot;
        return snap?.v === 1 && snap.meta?.sessionId === id ? snap : null;
      } catch {
        return null;
      }
    },
    listMeta() {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return [];
      }
      const out: VibeCodeSessionMeta[] = [];
      for (const n of names) {
        if (!n.endsWith(".meta.json")) continue;
        try {
          const m = JSON.parse(readFileSync(join(dir, n), "utf8")) as VibeCodeSessionMeta;
          if (SESSION_ID_RE.test(m.sessionId)) out.push(m);
        } catch {
          // A torn write leaves the previous rename in place; skip anything unreadable.
        }
      }
      return out;
    },
    delete(id) {
      if (!SESSION_ID_RE.test(id)) return;
      rmSync(full(id), { force: true });
      rmSync(meta(id), { force: true });
    },
  };
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
