/**
 * Every place box code hands text to a model, and how that text is kept free of the owner's
 * identity (AI01, docs/ai-privacy-and-staging.md §1). tests/llm/redactionCoverage.test.ts scans the
 * daemon's sources for the shapes that reach a model (`MODEL_SINK_PATTERNS`) and fails when a file
 * that has one is missing here, or is listed as `redacted` but never calls a redactor. Adding a
 * model-facing path therefore means adding a line here, which means deciding how it is redacted.
 *
 *  - `redacted`: box-written text passes `buildModelRedactor` in this file;
 *  - `via-broker`: the file only carries text produced by a `redacted` path (tool results from the
 *    tool broker, prompts built by a listed path) to the provider;
 *  - `repo-content`: the repo's own bytes, passed unchanged on purpose (rewriting them corrupts the
 *    code); never box-written text;
 *  - `owner-authored`: the owner's own words and attachments, which they chose to send; box notes
 *    in the same file are marked (`HIDDEN_NOTE_PREFIX`) and redacted where they are sent;
 *  - `fixed-text`: constant text in the source, naming nobody.
 */

export type BoundaryCoverage = "redacted" | "via-broker" | "repo-content" | "owner-authored" | "fixed-text";

export interface ModelBoundaryEntry {
  /** The source file, relative to packages/server-daemon/src. */
  file: string;
  coverage: BoundaryCoverage;
  what: string;
}

/** Shapes that put text in front of a model. */
export const MODEL_SINK_PATTERNS: readonly RegExp[] = [
  /role:\s*"(?:tool|user|system|assistant)"\s*,\s*content:/,
  /toolResults\s*:/,
  /HIDDEN_NOTE_PREFIX/,
  /\.chatWithCredential\(/,
  /\.chatStream\(/,
  /initialMessage\s*:/,
  /\btools\.call\(/,
  /type:\s*"text",\s*text:/,
  /\badaptRunner\(\{/,
  /summarise\s*:/,
  /-32603/,
];

export const MODEL_BOUNDARY: readonly ModelBoundaryEntry[] = [
  { file: "buildmodes/toolBroker.ts", coverage: "redacted", what: "every build tool result, refusal and error, for the box's loop and for MCP" },
  { file: "buildmodes/buildToolHost.ts", coverage: "via-broker", what: "the tools' dispatch; its results leave only through the broker" },
  { file: "buildmodes/buildAgent.ts", coverage: "redacted", what: "the agent loop: fixed system prompt, the repo's file list and the owner's instructions, broker results, compaction" },
  { file: "buildmodes/mcpServer.ts", coverage: "redacted", what: "MCP tool results (broker), resources and internal errors an IDE's model reads" },
  { file: "buildmodes/buildOrchestrator.ts", coverage: "repo-content", what: "the one-shot adapt prompt: a fixed system prompt and the repo's own files" },
  { file: "llm/contextCompaction.ts", coverage: "redacted", what: "what a summariser reads and the summary it writes" },
  { file: "llm/deploySession.ts", coverage: "redacted", what: "the chat's staged fix loop: the deploy failure it starts from, broker results" },
  { file: "llm/vibeCodeStartStreaming.ts", coverage: "redacted", what: "the chat sent to the provider: box notes are redacted, owner turns pass" },
  { file: "llm/vibeCodeSession.ts", coverage: "owner-authored", what: "the chat history: the owner's turns, and box notes marked for redaction on send" },
  { file: "llm/streamIntoSession.ts", coverage: "via-broker", what: "streams a request built by vibeCodeStartStreaming" },
  { file: "llmHarness.ts", coverage: "via-broker", what: "transport to the provider (or the box-local model); adds no text" },
  { file: "llmServiceContext.ts", coverage: "redacted", what: "the legacy app-context system prompt" },
  { file: "index.ts", coverage: "via-broker", what: "the runner closures forward prompts built by the listed paths" },
  { file: "localAi/service.ts", coverage: "fixed-text", what: "the local model's speed probe: a constant prompt" },
];

export function boundaryEntry(file: string): ModelBoundaryEntry | null {
  return MODEL_BOUNDARY.find((e) => e.file === file) ?? null;
}
