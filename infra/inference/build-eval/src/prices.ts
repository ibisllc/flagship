/**
 * What DeepInfra charges for each Flagship Inference model, in USD per
 * million tokens, at the standard tier. Input and output match the catalog
 * (`packages/control-plane/src/inferenceModels.ts`, a test keeps them in
 * step); cached input is DeepInfra's own price for prompt tokens it served
 * from its prefix cache, which the catalog doesn't carry.
 *
 * Checked 2026-10-14 on each model's page on deepinfra.com. GLM-5.3-Flash
 * was also shown at 50% off (0.075 / 0.25 / 0.015); the list price is used
 * here so a measurement never under-states the cost.
 */

import { INFERENCE_MODELS } from "@flagship/control-plane";

export const PRICES_CHECKED = "2026-10-14";

export interface ModelPrice {
  /** DeepInfra's model id. */
  upstreamId: string;
  inUsd: number;
  cachedInUsd: number;
  outUsd: number;
}

export const DEEPINFRA_PRICES: Readonly<Record<string, ModelPrice>> = {
  low: { upstreamId: "Qwen/Qwen3.6-35B-A3B", inUsd: 0.1, cachedInUsd: 0.1, outUsd: 0.95 },
  medium: { upstreamId: "deepseek-ai/DeepSeek-V4-Flash", inUsd: 0.09, cachedInUsd: 0.018, outUsd: 0.18 },
  "medium-vision": { upstreamId: "zai-org/GLM-5.3-Flash", inUsd: 0.15, cachedInUsd: 0.03, outUsd: 0.5 },
  high: { upstreamId: "MiniMaxAI/MiniMax-M3", inUsd: 0.28, cachedInUsd: 0.056, outUsd: 1.1 },
};

/** The catalog ids, in the catalog's order. */
export function catalogIds(): string[] {
  return INFERENCE_MODELS.map((m) => m.id);
}

export function priceFor(model: string): ModelPrice {
  const p = DEEPINFRA_PRICES[model];
  if (!p) throw new Error(`no DeepInfra price for model "${model}" (known: ${Object.keys(DEEPINFRA_PRICES).join(", ")})`);
  return p;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens the provider served from its cache (part of inputTokens). */
  cachedTokens?: number;
}

/** USD for one call's tokens. */
export function costUsd(model: string, u: TokenUsage): number {
  const p = priceFor(model);
  const cached = Math.min(Math.max(0, u.cachedTokens ?? 0), Math.max(0, u.inputTokens));
  const fresh = Math.max(0, u.inputTokens) - cached;
  return (fresh * p.inUsd + cached * p.cachedInUsd + Math.max(0, u.outputTokens) * p.outUsd) / 1e6;
}

/**
 * The most one call could cost before it is sent: every prompt token at the
 * uncached price, and the whole output allowance used.
 */
export function worstCaseCallUsd(model: string, promptTokens: number, maxOutputTokens: number): number {
  const p = priceFor(model);
  return (Math.max(0, promptTokens) * p.inUsd + Math.max(0, maxOutputTokens) * p.outUsd) / 1e6;
}

/** The catalog id for an upstream id (what the shim actually sent DeepInfra). */
export function catalogIdForUpstream(upstreamId: string): string | null {
  for (const [id, p] of Object.entries(DEEPINFRA_PRICES)) if (p.upstreamId === upstreamId) return id;
  return null;
}
