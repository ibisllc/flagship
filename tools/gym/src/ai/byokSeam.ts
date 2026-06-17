/**
 * BYOK adapter seam for the short-AI judge/navigator (§2.1, §9, §12-G3).
 *
 * The gym's deterministic gate never needs a model. This file documents how a
 * real, short, BOUNDED LLM call plugs in WITHOUT becoming the pass/fail oracle.
 * It runs only on the owner's Mac on the total-gym cadence, under the owner's
 * own provider key (the same BYOK posture the build paths use). The
 * every-merge gym (Layer 1 only) carries zero AI cost.
 *
 * To wire a real judge:
 *   1. Read the owner's key from the environment (BYOK — never committed),
 *      e.g. GYM_AI_API_KEY + GYM_AI_PROVIDER + optional GYM_AI_BASE_URL.
 *   2. Implement `judge(ctx)`: send ONE short multimodal message with the
 *      screenshot at `ctx.screenshotPath` + a rubric prompt grounded on
 *      `ctx.goal` + docs/design-system.md; map the reply to `AiFinding[]`.
 *   3. Implement `navigate(ctx)`: send ONE short message with the missing
 *      handle + `ctx.currentTree`; parse a suggested handle.
 *   4. SWALLOW all provider/network errors → return `[]` / no suggestion, so
 *      an AI outage can never redden a deterministic-green run.
 *   5. Pass the hooks to the runner (`buildAiHooks(...)` in cli.ts is the
 *      single switch point).
 *
 * This module ships ONLY the contract + an explicit "not configured" stub, so
 * the seam is real and typed but no provider code (or key handling) is baked
 * into the deterministic harness. Reach for a provider adapter from
 * packages/llm-providers when lighting this up (G5 / §10 Phase-6).
 */

import {
  type AiHooks,
  type AiJudge,
  type AiNavigator,
  type JudgeContext,
  type NavigateContext,
  type NavigateSuggestion,
  type AiFinding,
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

/**
 * The BYOK judge stub. Implementing the body is the drop-in (see the header).
 * Until then it returns a single advisory `info` finding noting the seam is
 * present-but-unimplemented — it NEVER throws into the gate.
 */
export class ByokJudge implements AiJudge {
  readonly name: string;
  constructor(private readonly config: ByokConfig) {
    this.name = `byok-judge(${config.provider})`;
  }
  async judge(ctx: JudgeContext): Promise<readonly AiFinding[]> {
    // BYOK drop-in point: one short multimodal call over ctx.screenshotPath.
    return [
      {
        role: "judge",
        severity: "info",
        scenarioId: ctx.scenarioId,
        point: ctx.point,
        message: `BYOK judge (${this.config.provider}) seam present but not implemented; no review emitted`,
      },
    ];
  }
}

/** The BYOK navigator stub — same contract, same no-throw guarantee. */
export class ByokNavigator implements AiNavigator {
  readonly name: string;
  constructor(private readonly config: ByokConfig) {
    this.name = `byok-navigator(${config.provider})`;
  }
  async navigate(ctx: NavigateContext): Promise<NavigateSuggestion> {
    // BYOK drop-in point: one short call over ctx.missingHandle + currentTree.
    return {
      findings: [
        {
          role: "navigate",
          severity: "warn",
          scenarioId: ctx.scenarioId,
          message: `BYOK navigator (${this.config.provider}) seam present but not implemented; no self-heal`,
        },
      ],
    };
  }
}

/**
 * Resolve the AI hooks: BYOK adapters when a key is present, the deterministic
 * no-op hooks otherwise. This is the ONE switch — everything downstream treats
 * the hooks uniformly and advisorily.
 */
export function resolveAiHooks(env: NodeJS.ProcessEnv = process.env): AiHooks {
  const cfg = byokConfigFromEnv(env);
  if (!cfg) return defaultAiHooks();
  return { judge: new ByokJudge(cfg), navigator: new ByokNavigator(cfg) };
}
