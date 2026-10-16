/**
 * Flagship Inference's model definitions: each model the shim can call, which
 * id each upstream knows it by, what it costs us there, and its thinking
 * switch. Adding a model here needs a probe (tool calling on every listed
 * upstream, a working `thinkingOff`), so it is reviewed like code.
 *
 * What the owner offers from these (which are on, the default, multipliers,
 * descriptions, the allowance) is server-side settings in
 * `inferenceSettings.ts`, changed without a deploy
 * (docs/runbooks/inference-settings.md). Computed multipliers come from the
 * prices below by one tested function; a setting can override one.
 * docs/ai-inference-costs.md §15–16 record the lineup and the measurements.
 */

/** Top-level chat-completions fields, as an upstream takes them. */
export type RequestFields = Readonly<Record<string, unknown>>;

/** One upstream's id for a model and what it charges us there (USD per million tokens). */
export interface UpstreamPrice {
  id: string;
  inUsd: number;
  outUsd: number;
  /**
   * The request fields that turn the model's thinking off on this upstream;
   * the shim sends them on every call, whatever the box asked. Flagship
   * Inference never pays for thinking (owner, 2026-10-15): reasoning tokens
   * are billed as output and share the reply's cap. Each host and model takes
   * a different switch, so each is probed (docs/ai-inference-costs.md §17).
   * A host where thinking can't be turned off gets its lowest effort.
   */
  thinkingOff: RequestFields;
}

export interface CatalogEntry {
  id: string;
  tier: string;
  model: string;
  descriptor: string;
  contextTokens: number;
  modalities: Array<"text" | "image">;
  /**
   * The most output tokens one call may produce (the shim's `max_tokens`).
   * Sized to fit a whole first build of a large app with thinking off; it
   * only stops a runaway reply and costs nothing unless used.
   */
  maxOutputTokens: number;
  /** For a text-only model: the catalog id to switch to for an image. */
  visionAlternative?: string;
  /**
   * Keyed by the shim's upstream name. On OpenRouter the price is the ceiling
   * the shim sends as `provider.max_price`, so a fallback call never costs
   * more than budgeted here.
   */
  upstream: Record<string, UpstreamPrice>;
}

/**
 * How multipliers are set. A model's cost is its price on a typical build's
 * token mix (mostly input: an app build is roughly 424k input and 13k output
 * tokens, docs/ai-inference-costs.md §13), at its dearest upstream. Its
 * multiplier is that cost over the base model's, times the margin, rounded UP
 * to the step so a model never costs us more than its credits bring in; the
 * base model is 1× by definition. It is only the price reference: it need
 * not be offered (Low isn't, since 2026-10-15).
 */
export const INFERENCE_PRICING = {
  baseModel: "low",
  marginFactor: 1.25,
  step: 0.5,
  buildMix: { inputTokens: 424_000, outputTokens: 13_000 },
  /** 1 credit = this many weighted tokens. */
  creditTokens: 1000,
} as const;

/**
 * The lineup, checked 2026-10-14 against DeepInfra's model API and
 * OpenRouter's catalog (tool calling on both, US hosts). Prices: DeepInfra's
 * list price; OpenRouter's is the ceiling we let it route under.
 */
export const INFERENCE_MODELS: readonly CatalogEntry[] = [
  {
    id: "low",
    tier: "Low",
    model: "Qwen3.6-35B-A3B",
    descriptor: "Quick and thrifty. Handles most apps and reads screenshots.",
    contextTokens: 262_144,
    modalities: ["text", "image"],
    maxOutputTokens: 32_768,
    upstream: {
      // Thinks by default. Probed 2026-10-15: no reasoning_content, 4 output tokens.
      deepinfra: {
        id: "Qwen/Qwen3.6-35B-A3B",
        inUsd: 0.1,
        outUsd: 0.95,
        thinkingOff: { chat_template_kwargs: { enable_thinking: false } },
      },
      // OpenRouter's documented switch; not probed (no key).
      openrouter: { id: "qwen/qwen3.6-35b-a3b", inUsd: 0.1, outUsd: 0.95, thinkingOff: { reasoning: { effort: "none" } } },
    },
  },
  {
    id: "medium",
    tier: "Medium",
    model: "DeepSeek-V4-Flash",
    descriptor: "A larger model with a 1M-token memory, for big apps. Text only.",
    contextTokens: 1_000_000,
    modalities: ["text"],
    maxOutputTokens: 32_768,
    visionAlternative: "medium-vision",
    upstream: {
      // DeepInfra serves it without thinking unless asked; "none" keeps it so. Probed 2026-10-15.
      deepinfra: { id: "deepseek-ai/DeepSeek-V4-Flash", inUsd: 0.09, outUsd: 0.18, thinkingOff: { reasoning_effort: "none" } },
      // OpenRouter defaults it to "high" and lists "none"; not probed (no key).
      openrouter: { id: "deepseek/deepseek-v4-flash", inUsd: 0.09, outUsd: 0.18, thinkingOff: { reasoning: { effort: "none" } } },
    },
  },
  {
    id: "medium-vision",
    tier: "Medium multimodal",
    model: "GLM-5.3-Flash",
    descriptor: "Sees screenshots and sketches well, with a 1M-token memory.",
    contextTokens: 1_000_000,
    modalities: ["text", "image"],
    maxOutputTokens: 24_576,
    upstream: {
      // Sent as DeepInfra serves it. enable_thinking: false zeroed reasoning_tokens,
      // but GLM then reasoned as visible reply text and never wrote flagship.app.json
      // (0/9 builds, 2026-10-15); untouched it built 4/4 with replies of ~1.5k tokens.
      deepinfra: { id: "zai-org/GLM-5.3-Flash", inUsd: 0.15, outUsd: 0.5, thinkingOff: {} },
      // OpenRouter marks its reasoning mandatory (efforts max, high, low): the lowest. Not probed (no key).
      openrouter: { id: "z-ai/glm-5.3-flash", inUsd: 0.15, outUsd: 0.5, thinkingOff: { reasoning: { effort: "low" } } },
    },
  },
  {
    id: "high",
    tier: "High",
    model: "MiniMax-M3",
    descriptor: "The strongest at long, many-step builds. Reads images.",
    contextTokens: 262_144,
    modalities: ["text", "image"],
    maxOutputTokens: 24_576,
    upstream: {
      // Probed 2026-10-15: no reasoning_content, 2 output tokens.
      deepinfra: { id: "MiniMaxAI/MiniMax-M3", inUsd: 0.28, outUsd: 1.1, thinkingOff: { reasoning_effort: "none" } },
      // OpenRouter's documented switch; not probed (no key).
      openrouter: { id: "minimax/minimax-m3", inUsd: 0.28, outUsd: 1.1, thinkingOff: { reasoning: { effort: "none" } } },
    },
  },
];

/** A model's price on the build mix at its dearest upstream (USD per build). */
export function buildCost(e: Pick<CatalogEntry, "upstream">, mix = INFERENCE_PRICING.buildMix): number {
  const costs = Object.values(e.upstream).map((u) => (u.inUsd * mix.inputTokens + u.outUsd * mix.outputTokens) / 1e6);
  return costs.length > 0 ? Math.max(...costs) : 0;
}

/** The credit multiplier for `e` against the base model. */
export function multiplierFor(
  e: CatalogEntry,
  base: CatalogEntry,
  pricing: { marginFactor: number; step: number; baseModel: string } = INFERENCE_PRICING,
): number {
  if (e.id === base.id) return 1;
  const baseCost = buildCost(base);
  if (!(baseCost > 0)) return 1;
  const raw = (buildCost(e) / baseCost) * pricing.marginFactor;
  // Round up to the step, guarding against float dust (1.5000000001 → 1.5).
  const stepped = Math.ceil(raw / pricing.step - 1e-9) * pricing.step;
  return Math.max(1, stepped);
}

export function formatMultiplier(m: number): string {
  return Number.isInteger(m) ? `${m}×` : `${m.toFixed(1).replace(/\.0$/, "")}×`;
}
