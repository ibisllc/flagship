/**
 * Flagship Inference's model catalog: the models the owner can pick from in
 * the build chat, what each costs in credits, and which id each upstream
 * knows it by. `.com` serves it (`GET /api/inference/models`), the meter shim
 * learns the chosen model from the allowance check, and metering charges
 * weighted tokens × the model's multiplier.
 *
 * Config lives here, as typed data deployed with `.com` (not D1): changes are
 * rare, they should be reviewed like code, and the multipliers are computed
 * from the prices below by one tested function. To change the lineup, edit
 * INFERENCE_MODELS (ids must exist on every listed upstream with tool
 * calling), run the tests, and deploy `.com`. docs/ai-inference-costs.md §15
 * records the current lineup and how the multipliers came out.
 */

import type { InferenceCatalogResponse, InferenceModel } from "@flagship/protocol";

/** One upstream's id for a model and what it charges us there (USD per million tokens). */
export interface UpstreamPrice {
  id: string;
  inUsd: number;
  outUsd: number;
}

export interface CatalogEntry {
  id: string;
  tier: string;
  model: string;
  descriptor: string;
  contextTokens: number;
  modalities: Array<"text" | "image">;
  reasoning: boolean;
  default?: boolean;
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
 * base model is 1× by definition (the allowance is budgeted on it).
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
    reasoning: true,
    default: true,
    upstream: {
      deepinfra: { id: "Qwen/Qwen3.6-35B-A3B", inUsd: 0.1, outUsd: 0.95 },
      openrouter: { id: "qwen/qwen3.6-35b-a3b", inUsd: 0.1, outUsd: 0.95 },
    },
  },
  {
    id: "medium",
    tier: "Medium",
    model: "DeepSeek-V4-Flash",
    descriptor: "A larger model with a 1M-token memory, for big apps. Text only.",
    contextTokens: 1_000_000,
    modalities: ["text"],
    reasoning: true,
    visionAlternative: "medium-vision",
    upstream: {
      deepinfra: { id: "deepseek-ai/DeepSeek-V4-Flash", inUsd: 0.09, outUsd: 0.18 },
      openrouter: { id: "deepseek/deepseek-v4-flash", inUsd: 0.09, outUsd: 0.18 },
    },
  },
  {
    id: "medium-vision",
    tier: "Medium multimodal",
    model: "GLM-5.3-Flash",
    descriptor: "Sees screenshots and sketches well, with a 1M-token memory.",
    contextTokens: 1_000_000,
    modalities: ["text", "image"],
    reasoning: true,
    upstream: {
      deepinfra: { id: "zai-org/GLM-5.3-Flash", inUsd: 0.15, outUsd: 0.5 },
      openrouter: { id: "z-ai/glm-5.3-flash", inUsd: 0.15, outUsd: 0.5 },
    },
  },
  {
    id: "high",
    tier: "High",
    model: "MiniMax-M3",
    descriptor: "The strongest at long, many-step builds. Reads images.",
    contextTokens: 262_144,
    modalities: ["text", "image"],
    reasoning: true,
    upstream: {
      deepinfra: { id: "MiniMaxAI/MiniMax-M3", inUsd: 0.28, outUsd: 1.1 },
      openrouter: { id: "minimax/minimax-m3", inUsd: 0.28, outUsd: 1.1 },
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

function formatMultiplier(m: number): string {
  return Number.isInteger(m) ? `${m}×` : `${m.toFixed(1).replace(/\.0$/, "")}×`;
}

/** The catalog with multipliers and menu labels, as `.com` serves it. */
export function inferenceCatalog(models: readonly CatalogEntry[] = INFERENCE_MODELS): InferenceModel[] {
  const base = models.find((m) => m.id === INFERENCE_PRICING.baseModel) ?? models[0];
  if (!base) return [];
  return models.map((e) => {
    const multiplier = multiplierFor(e, base);
    return {
      id: e.id,
      tier: e.tier,
      model: e.model,
      multiplier,
      label: `${e.tier} ${formatMultiplier(multiplier)} (${e.model})`,
      descriptor: e.descriptor,
      contextTokens: e.contextTokens,
      modalities: [...e.modalities],
      reasoning: e.reasoning,
      ...(e.default ? { default: true } : {}),
      ...(e.visionAlternative ? { visionAlternative: e.visionAlternative } : {}),
      upstream: Object.fromEntries(Object.entries(e.upstream).map(([k, v]) => [k, v.id])),
    };
  });
}

export function defaultInferenceModel(models: readonly CatalogEntry[] = INFERENCE_MODELS): CatalogEntry {
  return models.find((m) => m.default) ?? models[0]!;
}

/** `GET /api/inference/models`. */
export function inferenceCatalogResponse(weights: { inputWeight: number; outputWeight: number }): InferenceCatalogResponse {
  return {
    models: inferenceCatalog(),
    defaultModel: defaultInferenceModel().id,
    creditTokens: INFERENCE_PRICING.creditTokens,
    inputWeight: weights.inputWeight,
    outputWeight: weights.outputWeight,
  };
}

/** What the shim needs about the model a call asked for (unknown ⇒ the default). */
export interface ResolvedInferenceModel {
  id: string;
  multiplier: number;
  modalities: string[];
  reasoning: boolean;
  upstream: Record<string, { id: string; maxPriceIn: number; maxPriceOut: number }>;
  /** The label of the model to switch to for images. */
  visionAlternative?: string;
}

export function resolveInferenceModel(id: string | undefined): ResolvedInferenceModel {
  const entry = INFERENCE_MODELS.find((m) => m.id === id) ?? defaultInferenceModel();
  const served = inferenceCatalog();
  const me = served.find((m) => m.id === entry.id)!;
  const alt = entry.visionAlternative ? served.find((m) => m.id === entry.visionAlternative) : undefined;
  return {
    id: entry.id,
    multiplier: me.multiplier,
    modalities: [...entry.modalities],
    reasoning: entry.reasoning,
    upstream: Object.fromEntries(
      Object.entries(entry.upstream).map(([k, v]) => [k, { id: v.id, maxPriceIn: v.inUsd, maxPriceOut: v.outUsd }]),
    ),
    ...(alt ? { visionAlternative: alt.label } : {}),
  };
}

/**
 * The multiplier to charge a usage report at. An id the catalog doesn't know
 * (a shim and `.com` out of step) is charged at the dearest model's rate.
 */
export function chargeMultiplier(id: string | undefined): number {
  const served = inferenceCatalog();
  if (id === undefined) return served.find((m) => m.id === defaultInferenceModel().id)?.multiplier ?? 1;
  const hit = served.find((m) => m.id === id);
  return hit ? hit.multiplier : Math.max(1, ...served.map((m) => m.multiplier));
}
