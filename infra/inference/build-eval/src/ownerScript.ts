/**
 * The owner's side of the chat, scripted: what the harness answers when the
 * model pauses a build with talkToUser (a question) or requestEnvVar (a
 * secret it wants set). Answers come from the scenario, in order, then its
 * fallback; an env var gets the scenario's one policy.
 */

import type { EnvVarAnswer, Scenario } from "./scenarios.js";

export type PendingTool =
  | { kind: "talkToUser"; toolUseId: string; input: Record<string, unknown> }
  | { kind: "requestEnvVar"; toolUseId: string; input: Record<string, unknown> };

export type OwnerAction =
  | { kind: "reply"; toolUseId: string; text: string }
  | { kind: "env"; toolUseId: string; name: string; status: EnvVarAnswer };

/** At most this many owner answers per build step; past it the run fails as stuck. */
export const MAX_OWNER_ANSWERS = 6;

/**
 * The owner's answer to `pending`. `answered` is how many talkToUser
 * questions this step has already answered.
 */
export function ownerAnswer(scenario: Scenario, pending: PendingTool, answered: number): OwnerAction {
  if (pending.kind === "requestEnvVar") {
    const name = typeof pending.input.name === "string" ? pending.input.name : "";
    return { kind: "env", toolUseId: pending.toolUseId, name, status: scenario.owner.envVars };
  }
  const text = scenario.owner.answers[answered] ?? scenario.owner.fallback;
  return { kind: "reply", toolUseId: pending.toolUseId, text };
}
