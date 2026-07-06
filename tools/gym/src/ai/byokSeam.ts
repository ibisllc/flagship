/**
 * BYOK adapter for the short-AI judge/navigator (§2.1, §9, §12-G3).
 *
 * The gym's deterministic gate (Layer 1) never needs a model. This module wires
 * a real, short, BOUNDED LLM call as a Layer-2 ADVISORY aid WITHOUT ever
 * becoming the pass/fail oracle. It runs only on the owner's Mac on the
 * total-gym cadence, under the owner's own provider key (the same BYOK posture
 * the build paths use). The every-merge gym (Layer 1 only) carries zero AI cost.
 *
 * Two bounded roles, each ONE short call:
 *   - judge(ctx):   one short MULTIMODAL call — the screenshot at
 *                   ctx.screenshotPath (base64) + a concise rubric grounded on
 *                   ctx.goal + the design-system palette/voice. Reply → a short
 *                   {severity, message} findings list mapped to AiFinding[].
 *   - navigate(ctx): one short TEXT call over the missing handle (+ the current
 *                   a11y tree if present) → a suggested handle + a warning.
 *
 * IRON RULE (the whole point of the split): both roles SWALLOW every provider /
 * network / parse error and return `[]` (judge) / `{findings:[]}` (navigator).
 * An AI outage, a 500, a refusal, or a malformed reply must NEVER throw into the
 * gate or redden a deterministic-green run. The API key is NEVER logged.
 *
 * PROVIDERS (BYOK — pick yours with `GYM_AI_PROVIDER`):
 *   - "anthropic" (default) — POST <base>/v1/messages, `x-api-key` +
 *     `anthropic-version`, content-block messages with base64 image blocks;
 *     default base https://api.anthropic.com, default model claude-sonnet-4-6.
 *   - "openai" — POST <base>/v1/chat/completions, `Authorization: Bearer`,
 *     chat messages with an `image_url` data-URI for vision; default base
 *     https://api.openai.com, default model gpt-4o. Any OpenAI-compatible
 *     endpoint (vLLM / Ollama / a gateway) works via `GYM_AI_BASE_URL`.
 * Both are called via the injected fetch — kept independent of the provider
 * registry's types so the fetch can be mocked in a no-network test (see the
 * `fetchImpl` constructor seam). `GYM_AI_BASE_URL` / `GYM_AI_MODEL` override the
 * per-provider defaults.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import {
  type AiHooks,
  type AiJudge,
  type AiNavigator,
  type JudgeContext,
  type NavigateContext,
  type NavigateSuggestion,
  type AiFinding,
  type AiSeverity,
  defaultAiHooks,
} from "./hooks.js";

/** BYOK configuration resolved from the environment. */
export interface ByokConfig {
  readonly provider: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** Model id; provider default if omitted. */
  readonly model?: string;
}

/** Anthropic Messages API defaults. */
const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-6";

/** OpenAI Chat Completions API defaults (a current vision-capable model). */
const OPENAI_DEFAULT_BASE = "https://api.openai.com";
const OPENAI_DEFAULT_MODEL = "gpt-4o";

/** Keep the calls SHORT (low $, this is a review aid, not an agent). */
const JUDGE_MAX_TOKENS = 512;
const NAVIGATE_MAX_TOKENS = 256;
const JUDGE_TIMEOUT_MS = 30_000;
const NAVIGATE_TIMEOUT_MS = 20_000;

/** A minimal fetch seam — assignable a mock in tests (no real network/key). */
export type GymFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** The default fetch = the platform `globalThis.fetch`, adapted to GymFetch. */
const defaultGymFetch: GymFetch = (url, init) =>
  (
    globalThis.fetch as unknown as (
      u: string,
      i: unknown,
    ) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>
  )(url, init);

/** Read BYOK config from the env, or null when no key is present. */
export function byokConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ByokConfig | null {
  const apiKey = env.GYM_AI_API_KEY;
  if (!apiKey) return null;
  return {
    provider: env.GYM_AI_PROVIDER ?? "anthropic",
    apiKey,
    ...(env.GYM_AI_BASE_URL ? { baseUrl: env.GYM_AI_BASE_URL } : {}),
    ...(env.GYM_AI_MODEL ? { model: env.GYM_AI_MODEL } : {}),
  };
}

/** True for the OpenAI (Chat Completions) wire shape; everything else → Anthropic. */
function isOpenAiProvider(provider: string): boolean {
  const p = provider.trim().toLowerCase();
  return p === "openai" || p === "azure-openai" || p === "openai-compatible";
}

/** Map a file extension to an image media type; null if not an image. */
function imageMediaType(path: string): string | null {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return null;
  }
}

/** Coerce an arbitrary parsed severity to the AiSeverity enum (default "warn"). */
function coerceSeverity(v: unknown): AiSeverity {
  return v === "info" ? "info" : "warn";
}

/**
 * Extract the first JSON array/object embedded in a text reply. Models often
 * wrap JSON in prose or a ```json fence; we try a fenced block, the bare text,
 * then the substring from the first bracket to its last match. Returns null when
 * nothing parses — the caller then yields nothing.
 */
function extractJson(text: string): unknown {
  if (!text) return null;
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  candidates.push(text.trim());
  for (const open of ["[", "{"] as const) {
    const start = text.indexOf(open);
    if (start >= 0) {
      const close = open === "[" ? text.lastIndexOf("]") : text.lastIndexOf("}");
      if (close > start) candidates.push(text.slice(start, close + 1));
    }
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c) as unknown;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** A provider-neutral one-turn request: a prompt + an optional inline image. */
interface UserTurn {
  readonly text: string;
  readonly image?: { readonly mediaType: string; readonly base64: string };
}

const JUDGE_SYSTEM_PROMPT =
  "You are a terse UI review aid for the Flagship app. Flagship's design system: a single brand accent of TEAL (#14B8A6 / bright #2DD4BF) over a warm neutral canvas; pure #000/#FFF and the LEGACY blue #3B5BFF are banned; only status colors may be saturated. Voice: calm, plain, no jargon, sentence case, never shouty. " +
  "Review the screenshot for: clarity, ergonomics, contrast, spacing, off-palette color, and confusing copy. " +
  'Reply with ONLY a compact JSON array of at most 5 findings, each {"severity":"info"|"warn","message":"..."}. ' +
  'Use "warn" for a likely defect, "info" for a minor note. If the screen looks good, reply []. No prose, no markdown.';

/**
 * The BYOK JUDGE — one short multimodal call per screenshot. Maps the reply to
 * advisory `judge` findings. NEVER throws: every failure path returns [].
 */
export class ByokJudge implements AiJudge {
  readonly name: string;
  constructor(
    private readonly config: ByokConfig,
    private readonly fetchImpl: GymFetch = defaultGymFetch,
  ) {
    this.name = `byok-judge(${config.provider})`;
  }

  async judge(ctx: JudgeContext): Promise<readonly AiFinding[]> {
    try {
      const media = imageMediaType(ctx.screenshotPath);
      // Only images are sent as image blocks; a non-image capture → no review.
      if (!media) return [];
      let dataBase64: string;
      try {
        dataBase64 = (await readFile(ctx.screenshotPath)).toString("base64");
      } catch {
        // Missing/unreadable screenshot → advisory, swallow.
        return [];
      }

      const turn: UserTurn = {
        text:
          `Scenario goal: ${ctx.goal}\nScreenshot point: ${ctx.point}\n` +
          "Review this captured screen against the rubric and reply with the JSON findings array only.",
        image: { mediaType: media, base64: dataBase64 },
      };

      const text = await callModel(
        this.config,
        this.fetchImpl,
        JUDGE_SYSTEM_PROMPT,
        turn,
        JUDGE_MAX_TOKENS,
        JUDGE_TIMEOUT_MS,
      );
      const parsed = extractJson(text);
      if (!Array.isArray(parsed)) return [];

      const findings: AiFinding[] = [];
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        const message = (item as { message?: unknown }).message;
        if (typeof message !== "string" || message.trim().length === 0) continue;
        findings.push({
          role: "judge",
          severity: coerceSeverity((item as { severity?: unknown }).severity),
          scenarioId: ctx.scenarioId,
          point: ctx.point,
          message: message.trim().slice(0, 500),
        });
        if (findings.length >= 5) break;
      }
      return findings;
    } catch {
      // IRON RULE: an AI outage never reddens the gate.
      return [];
    }
  }
}

const NAVIGATE_SYSTEM_PROMPT =
  "You are a UI self-heal aid for the Flagship app's deterministic test gym. A scripted test could not find a stable element handle because the UI may have shifted (a control was moved, renamed, or re-nested). " +
  "Given the missing handle and (optionally) a serialization of the current accessibility tree / DOM, propose the single most likely current handle for the SAME control. " +
  'Reply with ONLY a compact JSON object {"suggestedHandle":"..."|null,"message":"one short sentence"}. If you cannot infer one, use null. No prose, no markdown.';

/**
 * The BYOK NAVIGATOR — one short text call over the missing handle. Returns a
 * suggested handle + a warning. NEVER throws: every failure path returns
 * `{findings:[]}` (no suggestion).
 */
export class ByokNavigator implements AiNavigator {
  readonly name: string;
  constructor(
    private readonly config: ByokConfig,
    private readonly fetchImpl: GymFetch = defaultGymFetch,
  ) {
    this.name = `byok-navigator(${config.provider})`;
  }

  async navigate(ctx: NavigateContext): Promise<NavigateSuggestion> {
    try {
      const treeBlurb = ctx.currentTree
        ? `\nCurrent a11y tree / DOM (truncated):\n${ctx.currentTree.slice(0, 6000)}`
        : "\n(No current tree available.)";
      const turn: UserTurn = {
        text:
          `Scenario goal: ${ctx.goal}\nMissing handle: ${ctx.missingHandle}${treeBlurb}\n` +
          "Reply with the JSON suggestion object only.",
      };

      const text = await callModel(
        this.config,
        this.fetchImpl,
        NAVIGATE_SYSTEM_PROMPT,
        turn,
        NAVIGATE_MAX_TOKENS,
        NAVIGATE_TIMEOUT_MS,
      );
      const parsed = extractJson(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { findings: [] };

      const rawHandle = (parsed as { suggestedHandle?: unknown }).suggestedHandle;
      const suggestedHandle =
        typeof rawHandle === "string" && rawHandle.trim().length > 0 ? rawHandle.trim().slice(0, 200) : undefined;
      const rawMsg = (parsed as { message?: unknown }).message;
      const baseMsg = typeof rawMsg === "string" && rawMsg.trim().length > 0 ? rawMsg.trim().slice(0, 300) : "";
      const message = suggestedHandle
        ? `handle "${ctx.missingHandle}" not found; suggested "${suggestedHandle}"${baseMsg ? ` — ${baseMsg}` : ""} [advisory; goal stays deterministic]`
        : `handle "${ctx.missingHandle}" not found; no confident self-heal${baseMsg ? ` — ${baseMsg}` : ""}`;

      const findings: readonly AiFinding[] = [
        {
          role: "navigate",
          severity: "warn",
          scenarioId: ctx.scenarioId,
          message,
        },
      ];
      return suggestedHandle ? { findings, suggestedHandle } : { findings };
    } catch {
      // IRON RULE: an AI outage never reddens the gate.
      return { findings: [] };
    }
  }
}

/**
 * Dispatch ONE bounded call to the configured provider and return the assistant
 * text. Returns "" on ANY failure — callers map "" to no findings, never throw.
 */
async function callModel(
  config: ByokConfig,
  fetchImpl: GymFetch,
  system: string,
  turn: UserTurn,
  maxTokens: number,
  timeoutMs: number,
): Promise<string> {
  return isOpenAiProvider(config.provider)
    ? callOpenAiChat(config, fetchImpl, system, turn, maxTokens, timeoutMs)
    : callAnthropicMessages(config, fetchImpl, system, turn, maxTokens, timeoutMs);
}

/** Pull the assistant TEXT out of an Anthropic Messages response body ("" if unrecognised). */
function extractAnthropicText(parsedBody: unknown): string {
  if (!parsedBody || typeof parsedBody !== "object") return "";
  const content = (parsedBody as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: string; text: string } =>
        !!b &&
        typeof b === "object" &&
        (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => b.text)
    .join("");
}

/** Pull the assistant TEXT out of an OpenAI Chat Completions body ("" if unrecognised). */
function extractOpenAiText(parsedBody: unknown): string {
  if (!parsedBody || typeof parsedBody !== "object") return "";
  const choices = (parsedBody as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const msg = (choices[0] as { message?: unknown } | undefined)?.message;
  const content = (msg as { content?: unknown } | undefined)?.content;
  return typeof content === "string" ? content : "";
}

/**
 * One bounded fetch with a timeout. Returns the raw response text, or "" on any
 * transport failure / non-2xx / timeout. The caller parses + tolerates.
 */
async function fetchText(
  fetchImpl: GymFetch,
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      signal: controller.signal,
    });
    if (!res.ok) return "";
    return await res.text();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Anthropic Messages call. The API key rides only in `x-api-key` and is never
 * logged. Returns "" on any failure.
 */
async function callAnthropicMessages(
  config: ByokConfig,
  fetchImpl: GymFetch,
  system: string,
  turn: UserTurn,
  maxTokens: number,
  timeoutMs: number,
): Promise<string> {
  const base = (config.baseUrl ?? ANTHROPIC_DEFAULT_BASE).replace(/\/+$/, "");
  const content: unknown[] = [{ type: "text", text: turn.text }];
  if (turn.image) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: turn.image.mediaType, data: turn.image.base64 },
    });
  }
  const body = JSON.stringify({
    model: config.model ?? ANTHROPIC_DEFAULT_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content }],
  });
  const raw = await fetchText(
    fetchImpl,
    `${base}/v1/messages`,
    { "x-api-key": config.apiKey, "anthropic-version": ANTHROPIC_VERSION },
    body,
    timeoutMs,
  );
  if (!raw) return "";
  try {
    return extractAnthropicText(JSON.parse(raw) as unknown);
  } catch {
    return "";
  }
}

/**
 * OpenAI Chat Completions call (works against any OpenAI-compatible endpoint via
 * `baseUrl`). The key rides only in `Authorization: Bearer` and is never logged.
 * Vision is the standard `image_url` data-URI content part. Returns "" on any
 * failure.
 */
async function callOpenAiChat(
  config: ByokConfig,
  fetchImpl: GymFetch,
  system: string,
  turn: UserTurn,
  maxTokens: number,
  timeoutMs: number,
): Promise<string> {
  const base = (config.baseUrl ?? OPENAI_DEFAULT_BASE).replace(/\/+$/, "");
  const userContent: unknown[] = [{ type: "text", text: turn.text }];
  if (turn.image) {
    userContent.push({
      type: "image_url",
      image_url: { url: `data:${turn.image.mediaType};base64,${turn.image.base64}` },
    });
  }
  const body = JSON.stringify({
    model: config.model ?? OPENAI_DEFAULT_MODEL,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userContent },
    ],
  });
  const raw = await fetchText(
    fetchImpl,
    `${base}/v1/chat/completions`,
    { authorization: `Bearer ${config.apiKey}` },
    body,
    timeoutMs,
  );
  if (!raw) return "";
  try {
    return extractOpenAiText(JSON.parse(raw) as unknown);
  } catch {
    return "";
  }
}

/**
 * Resolve the AI hooks: BYOK adapters when a key is present, the deterministic
 * no-op hooks otherwise. This is the ONE switch — everything downstream treats
 * the hooks uniformly and advisorily. An optional `fetchImpl` is threaded into
 * the BYOK adapters for tests (no real network/key); production omits it and the
 * adapters use `globalThis.fetch`.
 */
export function resolveAiHooks(env: NodeJS.ProcessEnv = process.env, fetchImpl?: GymFetch): AiHooks {
  const cfg = byokConfigFromEnv(env);
  if (!cfg) return defaultAiHooks();
  return {
    judge: new ByokJudge(cfg, fetchImpl ?? defaultGymFetch),
    navigator: new ByokNavigator(cfg, fetchImpl ?? defaultGymFetch),
  };
}
