/**
 * Per-service election + claim/yield decision.
 *
 * Each round builds the member list (self + live siblings) and, for every
 * service THIS box runs, elects the leader via `electLeadForService`
 * (@flagship/protocol — highest clout among the live runners). Then applies the
 * claim/yield rule against the injected `RouteClaimer`.
 *
 * This is the pure DECISION layer: it takes a snapshot of members + the local
 * holdings and returns the actions to apply, then applies them. It is fully unit-
 * testable with a mock RouteClaimer and a synthetic member list — independent of
 * any transport, timers, or the live UrlController.
 */
import { type CloutMember, electLeadForService } from "@flagship/protocol";
import type { RouteClaimer } from "./routeClaimer.js";
import type { ViewMember } from "./siblingView.js";

export interface SelfMember {
  id: string;
  domain: string;
  birthDate: number;
  voteIssuedAt: number | null;
  /** The slugs THIS box runs (drives both eligibility and which services to elect). */
  services: string[];
}

export type ClaimAction =
  | { kind: "claim"; service: string }
  | { kind: "release"; service: string };

/**
 * Compute the claim/yield actions for one round WITHOUT applying them. Pure.
 *
 * For each service this box runs:
 *   - elect the leader among {self-as-live} ∪ {live siblings};
 *   - if self is the elected lead and doesn't hold the route → claim;
 *   - if self is NOT the lead and currently holds it → release.
 *
 * `claimer.holds` is consulted to make claim/release idempotent (a steady leader
 * that already holds its route emits no action).
 */
export function decideClaimActions(deps: {
  self: SelfMember;
  liveSiblings: ViewMember[];
  claimer: Pick<RouteClaimer, "holds">;
}): ClaimAction[] {
  const { self, liveSiblings, claimer } = deps;

  // Self is always LIVE in its own election round (it is the one running it).
  const selfClout: CloutMember = {
    id: self.id,
    domain: self.domain,
    birthDate: self.birthDate,
    voteIssuedAt: self.voteIssuedAt,
    liveness: "live",
    services: self.services,
  };
  const siblingClout: CloutMember[] = liveSiblings.map((s) => ({
    id: s.id,
    domain: s.domain,
    birthDate: s.birthDate,
    voteIssuedAt: s.voteIssuedAt,
    liveness: s.liveness,
    services: s.services,
  }));
  const members: CloutMember[] = [selfClout, ...siblingClout];

  const actions: ClaimAction[] = [];
  for (const service of self.services) {
    const lead = electLeadForService(members, service);
    const selfIsLead = lead !== null && lead.id === self.id;
    const held = claimer.holds(service);
    if (selfIsLead && !held) {
      actions.push({ kind: "claim", service });
    } else if (!selfIsLead && held) {
      actions.push({ kind: "release", service });
    }
  }
  return actions;
}

/**
 * Run one election round and APPLY the resulting claim/yield actions through the
 * RouteClaimer. Returns the actions taken (for logging/tests). Each apply is
 * best-effort: a claim/release that throws is swallowed so one bad route can't
 * stall the round (the next round re-derives + retries).
 */
export async function runElectionRound(deps: {
  self: SelfMember;
  liveSiblings: ViewMember[];
  claimer: RouteClaimer;
  onLog?: (m: string) => void;
}): Promise<ClaimAction[]> {
  const actions = decideClaimActions({
    self: deps.self,
    liveSiblings: deps.liveSiblings,
    claimer: deps.claimer,
  });
  for (const a of actions) {
    try {
      if (a.kind === "claim") await deps.claimer.claim(a.service);
      else await deps.claimer.release(a.service);
      deps.onLog?.(`[gossip] ${a.kind} route for service "${a.service}"`);
    } catch (e) {
      deps.onLog?.(
        `[gossip] ${a.kind} route for "${a.service}" failed: ${(e as Error).message}`,
      );
    }
  }
  return actions;
}
