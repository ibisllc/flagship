// `GET /api/users/<u>/plan-attestation` (docs/service-access-gating.md,
// "Separate lists per server (Pro)"): the account's effective plan, signed with
// the CA hot key, so a box can check that the account is Pro before it honours
// a separate access list per server, and can tell verifiably when Pro ends. The
// route is gated by the account's read token like /pods; the box fetches it
// with its STK token. The tier is `effectiveTierOf` (a lapsed paid period reads
// free), the same rule metering and custom domains use.
import {
  PLAN_ATTESTATION_TTL_MS,
  isProTier,
  signPlanAttestation,
  type PlanAttestation,
} from "@flagship/protocol";
import type { TierStorage, UsernameStorage } from "@flagship/storage";
import { effectiveTierOf } from "./metering.js";
import type { CaIssuer } from "./pubkeyCert.js";
import { notFound, ok, type HandlerResponseWithHeaders } from "./types.js";

export interface PlanAttestationDeps {
  ca: CaIssuer;
  tiers: TierStorage;
  usernames: Pick<UsernameStorage, "get">;
  now?: () => number;
  ttlMs?: number;
}

export async function handlePlanAttestation(
  deps: PlanAttestationDeps,
  rawUsername: string,
): Promise<HandlerResponseWithHeaders<PlanAttestation | { error: string }>> {
  const username = rawUsername.trim().toLowerCase();
  if (!(await deps.usernames.get(username))) return notFound("unknown account") as HandlerResponseWithHeaders<{ error: string }>;
  const now = (deps.now ?? Date.now)();
  const tier = await effectiveTierOf(deps.tiers, username, now);
  const rec = isProTier(tier) ? await deps.tiers.get(username) : undefined;
  const paidUntil = isProTier(tier) ? Math.max(0, Math.floor(rec?.currentPeriodEnd ?? 0)) : 0;
  const attestation = signPlanAttestation(
    { username, tier, paidUntil, issuedAt: now, expiresAt: now + (deps.ttlMs ?? PLAN_ATTESTATION_TTL_MS) },
    deps.ca.keypair,
  );
  return ok(attestation, { "cache-control": "private, no-store" });
}
