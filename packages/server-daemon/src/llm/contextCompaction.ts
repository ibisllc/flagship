/**
 * Automatic context compaction. Every AI step resends the whole conversation,
 * so a long build eventually outgrows the model's context window. Before a
 * call that would come close, the older middle of the conversation is
 * summarised by the same model and replaced with that summary; the opening
 * (the system prompt and the owner's first request) and the recent turns,
 * with the tool results the agent is still working from, stay as they are.
 * The owner sees nothing of this; a provider's "too long" refusal stays the
 * last resort.
 *
 * What the summariser reads passes through the model redactor first, like
 * every other box-written text a model sees (docs/ai-privacy-and-staging.md).
 */

import type { ChatMessage, ChatRequest, ToolSpec } from "@flagship/llm-providers";
import { noRedaction, type ModelRedactor } from "./modelPrivacy.js";

/** Used when the active model's context size isn't known. */
export const DEFAULT_CONTEXT_TOKENS = 128_000;
/** Room kept for the reply when the request names no output cap. */
const DEFAULT_REPLY_TOKENS = 16_000;
/** Compact once the estimate passes this share of what's left for input. */
export const COMPACT_AT = 0.75;
/** After compacting, the kept recent turns take at most this share. */
const KEEP_RECENT_SHARE = 0.35;
/** Each tool result is cut to this many characters inside the summariser's transcript. */
const TRANSCRIPT_RESULT_CHARS = 2_000;
/** The summariser's transcript is cut to this share of the context (in tokens). */
const TRANSCRIPT_SHARE = 0.6;
/** An image costs roughly this many tokens. */
const IMAGE_TOKENS = 1_600;

export const SUMMARY_PREFIX = "Summary of the earlier conversation (older turns were condensed to save room):";

/** Rough tokens for a request: 4 characters a token, images at a flat cost. */
export function estimateTokens(messages: readonly ChatMessage[], tools?: readonly ToolSpec[]): number {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    chars += m.content.length + 16;
    for (const a of m.attachments ?? []) {
      if (a.kind === "image") images++;
      else chars += a.text.length;
    }
    for (const t of m.toolUses ?? []) chars += t.name.length + JSON.stringify(t.input ?? {}).length + 16;
    for (const r of m.toolResults ?? []) chars += r.content.length + 16;
  }
  for (const t of tools ?? []) chars += t.name.length + t.description.length + JSON.stringify(t.inputSchema).length;
  return Math.ceil(chars / 4) + images * IMAGE_TOKENS;
}

/** The input budget for a model: its context less the reply's room. */
export function inputBudget(contextTokens: number | undefined, maxTokens?: number): number {
  const ctx = contextTokens && contextTokens > 0 ? contextTokens : DEFAULT_CONTEXT_TOKENS;
  const reply = Math.min(maxTokens && maxTokens > 0 ? maxTokens : DEFAULT_REPLY_TOKENS, Math.floor(ctx / 4));
  return ctx - reply;
}

export function needsCompaction(req: Pick<ChatRequest, "messages" | "tools" | "maxTokens">, contextTokens?: number): boolean {
  return estimateTokens(req.messages, req.tools) > inputBudget(contextTokens, req.maxTokens) * COMPACT_AT;
}

/** How many leading messages are never summarised: system prompts and the first request. */
function headLength(messages: readonly ChatMessage[]): number {
  let i = 0;
  while (i < messages.length && messages[i]!.role === "system") i++;
  if (i < messages.length && messages[i]!.role === "user") i++;
  return i;
}

/**
 * Where the kept recent turns start: as far back as fits `budget`, but never
 * on a tool-result turn (it must follow the assistant turn that called it).
 */
function tailStart(messages: readonly ChatMessage[], head: number, budget: number): number {
  let start = messages.length;
  let used = 0;
  for (let i = messages.length - 1; i >= head; i--) {
    const cost = estimateTokens([messages[i]!]);
    if (used + cost > budget && start < messages.length) break;
    used += cost;
    start = i;
  }
  while (start < messages.length && messages[start]!.role === "tool") start++;
  // Keep at least the last turn, whatever it costs.
  if (start >= messages.length) {
    start = messages.length - 1;
    while (start > head && messages[start]!.role === "tool") start--;
  }
  return Math.max(start, head);
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)} … [${s.length - max} more characters]`;
}

/** The older turns as plain text for the summariser. */
export function transcriptOf(messages: readonly ChatMessage[], maxChars: number): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      for (const r of m.toolResults ?? []) {
        lines.push(`[result of ${r.name ?? "tool"}${r.isError ? ", error" : ""}] ${clip(r.content, TRANSCRIPT_RESULT_CHARS)}`);
      }
      continue;
    }
    const who = m.role === "assistant" ? "AI" : m.role === "user" ? "Owner" : "System";
    if (m.content.trim().length > 0) lines.push(`${who}: ${m.content.trim()}`);
    for (const a of m.attachments ?? []) {
      lines.push(a.kind === "image" ? `[${who} attached an image${a.name ? ` ${a.name}` : ""}]` : `[${who} attached ${a.name ?? "a file"}] ${clip(a.text, TRANSCRIPT_RESULT_CHARS)}`);
    }
    for (const t of m.toolUses ?? []) lines.push(`[AI called ${t.name}(${clip(JSON.stringify(t.input ?? {}), 400)})]`);
  }
  const text = lines.join("\n");
  // Keep the end: the latest of the older turns matter most.
  return text.length <= maxChars ? text : `[…earlier part cut]\n${text.slice(text.length - maxChars)}`;
}

const SUMMARISER_PROMPT = `You condense the earlier part of a conversation between an app owner and an AI that is building their app, so the AI can carry on without the full history. Write a compact summary (at most about 1,500 words) that keeps everything the AI still needs:
- what the owner asked for, their choices and constraints, in their words where it matters;
- decisions made and why;
- files written or changed and what each does (paths exactly);
- what was tested and the results, errors still open, and what is left to do.
Leave out pleasantries and anything already resolved that no longer matters. Write it as notes, not as a reply to anyone.`;

export type Summarise = (req: ChatRequest) => Promise<string>;

/**
 * Put a short assistant acknowledgement between two user turns in a row, for
 * the providers that insist on alternating turns. Tool-result turns count as
 * the tool role and are left alone.
 */
export function alternateTurns<T extends { role: string; content: string }>(messages: readonly T[], ack: () => T): T[] {
  const out: T[] = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === "user" && m.role === "user") out.push(ack());
    out.push(m);
  }
  return out;
}

export interface CompactArgs {
  messages: readonly ChatMessage[];
  tools?: readonly ToolSpec[];
  maxTokens?: number;
  contextTokens?: number;
  /** The model call, with the same credential and model as the build. */
  summarise: Summarise;
  model: string;
  redact?: ModelRedactor;
}

export interface CompactResult {
  messages: ChatMessage[];
  /** How many of the input messages the summary replaced (0: nothing compacted). */
  replaced: number;
  /** How many of the input's last messages were kept as they were. */
  kept: number;
  summary?: string;
}

/**
 * Compact `messages` when they come close to the model's context; returns
 * them unchanged otherwise. A summariser failure leaves the conversation as
 * it was (the provider's own "too long" answer is the last resort).
 */
export async function compactIfNeeded(a: CompactArgs): Promise<CompactResult> {
  const unchanged = { messages: [...a.messages], replaced: 0, kept: a.messages.length };
  if (!needsCompaction({ messages: [...a.messages], tools: a.tools ? [...a.tools] : undefined, maxTokens: a.maxTokens }, a.contextTokens)) {
    return unchanged;
  }
  const budget = inputBudget(a.contextTokens, a.maxTokens);
  const head = headLength(a.messages);
  const start = tailStart(a.messages, head, Math.floor(budget * KEEP_RECENT_SHARE));
  if (start <= head) return unchanged;
  const older = a.messages.slice(head, start);
  const redact = a.redact ?? noRedaction;
  const transcript = redact(transcriptOf(older, Math.floor(budget * TRANSCRIPT_SHARE) * 4));
  let summary: string;
  try {
    summary = (
      await a.summarise({
        model: a.model,
        messages: [
          { role: "system", content: SUMMARISER_PROMPT },
          { role: "user", content: `The earlier conversation:\n\n${transcript}\n\nWrite the summary now.` },
        ],
        maxTokens: 4_000,
      })
    ).trim();
  } catch {
    return unchanged;
  }
  if (summary.length === 0) return unchanged;
  summary = redact(summary);
  const note: ChatMessage = { role: "user", content: `${SUMMARY_PREFIX}\n\n${summary}` };
  const joined = [...a.messages.slice(0, head), note, ...a.messages.slice(start)];
  const out = alternateTurns<ChatMessage>(joined, () => ({ role: "assistant", content: "Noted." }));
  return { messages: out, replaced: older.length, kept: a.messages.length - start, summary };
}
