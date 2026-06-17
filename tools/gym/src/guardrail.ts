/**
 * DEMO-only destructive-op guardrail (§7-G, HARD). Every destructive scenario
 * (wipe / decommission / revoke / uninstall) must target a demo-classified
 * username; the runner fail-closes (skips the scenario, never runs the
 * framework) if not. No real account is ever a destructive target.
 *
 * At Tier-1 the demo identity is a fixed fixture username; this check enforces
 * that a destructive scenario can only ever be pointed at one of those known
 * demo usernames. (Tier-2 layers the live demo_users classification on top when
 * the live slice lands — G5.)
 */

import { isDestructive, type Scenario } from "./scenario.js";

/**
 * The set of usernames a destructive scenario is permitted to target at
 * Tier-1. These are the fixed demo-fixture identities (§7-G). A destructive
 * scenario whose `demoUsername` is outside this set is refused.
 */
export const ALLOWED_DEMO_USERNAMES: ReadonlySet<string> = new Set([
  "smoketest",
  "smoketest-demo",
  "demouser734759",
  // The live `gym.` test-env demo user the Tier-2 vertical slice creates +
  // installs against (tools/gym/src/live.ts, §12-G6). Demo-classified by
  // construction (a `gym.flagship.services` box; `gym` is a banned real
  // username), so its destructive create/install ops are permitted here.
  "gymdemo",
]);

export interface GuardVerdict {
  readonly allowed: boolean;
  readonly reason?: string;
}

/** Decide whether a scenario may run under the demo-only guardrail. */
export function guardScenario(s: Scenario): GuardVerdict {
  if (!isDestructive(s)) return { allowed: true };
  const target = s.destructive.demoUsername;
  if (!ALLOWED_DEMO_USERNAMES.has(target)) {
    return {
      allowed: false,
      reason:
        `destructive scenario "${s.id}" targets "${target}", which is not a ` +
        `demo-classified username — refusing (§7-G demo-only guardrail)`,
    };
  }
  return { allowed: true };
}
