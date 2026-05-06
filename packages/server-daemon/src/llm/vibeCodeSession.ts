/**
 * Vibe-coding session orchestrator.
 *
 * Sits on top of the existing `LlmHarness` (which speaks the BYOK
 * provider-call protocol). A session represents one back-and-forth
 * with the user: the user describes an app, the LLM streams a
 * structured response, the harness parses out the manifest + files +
 * migrations, builds the container, and deploys it.
 *
 * This module is the orchestration + parsing layer; provider calls
 * delegate to LlmHarness. The daemon's /api/llm/sessions HTTP + WS
 * surface (next module) drives this from the phone.
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
 * The parser emits incremental `chunk` events as content streams in,
 * a `file-complete` event when a `=== ... ===` boundary is crossed,
 * and a `done` event on `=== END ===`. Phone clients can render a
 * file-tree as it grows.
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
  | { kind: "done"; manifestJson?: string; files: Record<string, string> };

export interface VibeCodeSessionMeta {
  sessionId: string;
  username: string;
  serverFqdn: string;
  startedAt: number;
  status: "streaming" | "ready-to-deploy" | "deploying" | "deployed" | "failed" | "cancelled";
  appId?: string;
  url?: string;
}

const FILE_BOUNDARY = /^===\s+(.+?)\s+===\s*$/;
const END_BOUNDARY = /^===\s+END\s+===\s*$/;

/**
 * Parses the LLM's structured output into events. Stateful: feed
 * chunks in via `feed(text)`; subscribe with `on("event", handler)`.
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

/**
 * One end-to-end session. Holds the parser, the conversation history,
 * and the deploy phase emitter.
 */
export class VibeCodeSession extends EventEmitter {
  readonly meta: VibeCodeSessionMeta;
  readonly parser = new VibeCodeStreamParser();
  private readonly history: Array<{ role: "user" | "assistant"; content: string }> = [];
  private cancelled = false;

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

  endAssistant(): void {
    this.parser.end();
    if (!this.cancelled && this.meta.status === "streaming") {
      this.meta.status = "ready-to-deploy";
      this.emit("event", { kind: "phase", phase: "build", detail: "ready to deploy" } as VibeCodeEvent);
    }
  }

  cancel(): void {
    this.cancelled = true;
    this.meta.status = "cancelled";
  }

  /** Mark the session as deployed — caller invokes after AppPlatform.install succeeds. */
  markDeployed(args: { appId: string; url: string }): void {
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
