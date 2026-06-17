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
 * Wire shape = the Anthropic Messages API (POST <base>/v1/messages, `x-api-key`,
 * `anthropic-version`, content-block messages with base64 image blocks), called
 * directly via the injected fetch — kept independent of the provider registry's
 * types so the fetch can be mocked in a no-network test (see the `fetchImpl`
 * constructor seam). `baseUrl` is honored, so an Anthropic-compatible proxy or a
 * self-hosted endpoint that speaks this shape works too.
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

/** The Anthropic Messages API default base + a current vision-capable model. */
const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-4-6";

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

/** Map a file extension to an image media type Anthropic accepts; null if not an image. */
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
 * Pull the assistant TEXT out of an Anthropic Messages response body. Returns ""
 * on any shape it doesn't recognise (caller then yields no findings — never
 * throws). Tolerant on purpose: a model/proxy variance must degrade to empty.
 */
function extractText(parsedBody: unknown): string {
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

      const userContent = [
        {
          type: "text",
          text:
            `Scenario goal: ${ctx.goal}\nScreenshot point: ${ctx.point}\n` +
            "Review this captured screen against the rubric and reply with the JSON findings array only.",
        },
        { type: "image", source: { type: "base64", media_type: media, data: dataBase64 } },
      ];

      const text = await callAnthropicMessages(
        this.config,
        this.fetchImpl,
        JUDGE_SYSTEM_PROMPT,
        userContent,
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
      const userContent = [
        {
          type: "text",
          text:
            `Scenario goal: ${ctx.goal}\nMissing handle: ${ctx.missingHandle}${treeBlurb}\n` +
            "Reply with the JSON suggestion object only.",
        },
      ];

      const text = await callAnthropicMessages(
        this.config,
        this.fetchImpl,
        NAVIGATE_SYSTEM_PROMPT,
        userContent,
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
 * Issue ONE bounded Anthropic-shaped Messages call and return the assistant
 * text. Returns "" on ANY failure (network throw, non-2xx, unparseable body,
 * timeout) — callers map "" to no findings. The API key rides only in the
 * `x-api-key` header and is never logged.
 */
async function callAnthropicMessages(
  config: ByokConfig,
  fetchImpl: GymFetch,
  system: string,
  userContent: unknown,
  maxTokens: number,
  timeoutMs: number,
): Promise<string> {
  const base = (config.baseUrl ?? ANTHROPIC_DEFAULT_BASE).replace(/\/+$/, "");
  const body = JSON.stringify({
    model: config.model ?? DEFAULT_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userContent }],
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) return "";
    const raw = await res.text();
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(raw) as unknown;
    } catch {
      return "";
    }
    return extractText(parsedBody);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
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
