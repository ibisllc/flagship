/**
 * Short-AI hooks (§2.1 Layer 2) — PLUGGABLE, ADVISORY, never the pass/fail
 * oracle. Two bounded roles:
 *
 *   (a) JUDGE      — reviews captured screenshots for clarity / ergonomics /
 *                    contrast / "does this look right" (the D7-beautiful aid).
 *                    Emits findings a human triages. Run-to-run variance is
 *                    expected and acceptable BECAUSE it never gates.
 *   (b) NAVIGATE   — when a scripted handle misses because the UI shifted, an
 *      / SELF-HEAL   AI call reasons over the current a11y tree to steer toward
 *                    the SAME deterministic goal and/or proposes the handle
 *                    delta (surfaced as a warning + suggested patch).
 *
 * The deterministic gate (Layer 1) MUST work with these absent. The default
 * implementation below is a record-only no-op, so the gym runs fully
 * deterministically with no API key. A real short-LLM adapter is a BYOK
 * drop-in: implement `AiJudge` / `AiNavigator` against the owner's provider
 * (the same BYOK posture the build paths use — see docs/build-modes.md) and
 * pass it to the runner. See `byokSeam.ts` for the contract + a stub.
 */

export type AiRole = "judge" | "navigate";
export type AiSeverity = "info" | "warn";

/** One advisory finding. Recorded in the artifact, never gates. */
export interface AiFinding {
  readonly role: AiRole;
  readonly severity: AiSeverity;
  readonly message: string;
  /** The scenario the finding pertains to. */
  readonly scenarioId: string;
  /** The screenshot/point the finding pertains to, if any. */
  readonly point?: string;
}

/** Context handed to the judge for one screenshot. */
export interface JudgeContext {
  readonly scenarioId: string;
  readonly point: string;
  /** Absolute path to the captured screenshot. */
  readonly screenshotPath: string;
  /** The scenario goal, for grounding the review. */
  readonly goal: string;
}

/** Context handed to the navigator when a handle misses. */
export interface NavigateContext {
  readonly scenarioId: string;
  /** The deterministic goal being steered toward (stays authoritative). */
  readonly goal: string;
  /** The handle the script expected but did not find. */
  readonly missingHandle: string;
  /** A serialization of the current a11y tree / DOM, if the adapter has one. */
  readonly currentTree?: string;
}

/**
 * The judge reviews a screenshot and returns advisory findings. MUST NOT throw
 * into the gate — implementations should swallow provider errors and return
 * `[]` so an AI outage never reddens a deterministic-green run.
 */
export interface AiJudge {
  readonly name: string;
  judge(ctx: JudgeContext): Promise<readonly AiFinding[]>;
}

/**
 * A navigator suggestion. `action` is advisory guidance for the human/script;
 * the runner records it but the goal + final assertion stay deterministic.
 */
export interface NavigateSuggestion {
  readonly findings: readonly AiFinding[];
  /** A suggested handle to use instead of the missing one, if inferred. */
  readonly suggestedHandle?: string;
}

export interface AiNavigator {
  readonly name: string;
  navigate(ctx: NavigateContext): Promise<NavigateSuggestion>;
}

/** Both hooks bundled; either may be the no-op default. */
export interface AiHooks {
  readonly judge: AiJudge;
  readonly navigator: AiNavigator;
}

/**
 * The default JUDGE — records that a screen WAS captured and is available for
 * (future / BYOK) review, as a single `info` finding. No model call, no key,
 * no variance. This keeps the "judge ran, advisory-only" contract visible in
 * the artifact even when no LLM is wired.
 */
export class NoOpJudge implements AiJudge {
  readonly name = "noop-judge";
  async judge(ctx: JudgeContext): Promise<readonly AiFinding[]> {
    return [
      {
        role: "judge",
        severity: "info",
        scenarioId: ctx.scenarioId,
        point: ctx.point,
        message: `screenshot captured (${ctx.point}); no AI judge configured — review aid skipped`,
      },
    ];
  }
}

/** The default NAVIGATOR — records the miss; suggests nothing (no self-heal). */
export class NoOpNavigator implements AiNavigator {
  readonly name = "noop-navigator";
  async navigate(ctx: NavigateContext): Promise<NavigateSuggestion> {
    return {
      findings: [
        {
          role: "navigate",
          severity: "warn",
          scenarioId: ctx.scenarioId,
          message: `handle "${ctx.missingHandle}" not found; no AI navigator configured — no self-heal attempted`,
        },
      ],
    };
  }
}

/** The default advisory hooks — fully deterministic, no provider key required. */
export function defaultAiHooks(): AiHooks {
  return { judge: new NoOpJudge(), navigator: new NoOpNavigator() };
}
