/**
 * Tells the security sliver when the CA lease this box checks against is about to end or has ended
 * (SECURITY-HARDENING-PLAN.md 18.14, N14). A lapsed lease makes every CA-checked feature (a share
 * accepted, the relay's blessing, an authenticated time) fail closed, so the owner needs the notice
 * while there is still time to update, not after.
 */
import type { CaTrustChain } from "@flagship/protocol";
import type { SecuritySliver, Severity } from "./securitySliver.js";

const DAY = 86_400_000;
export const CA_WARN_DAYS = 14;
export const CA_ISSUE_KEY = "ca-expiry:lease";

export type CaLeaseState = { state: "ok" } | { state: "soon"; daysLeft: number } | { state: "lapsed" };

/** Whole days until the chain authorizes no CA key, looking up to `CA_WARN_DAYS` ahead. */
export function caLeaseState(chain: CaTrustChain | null, now: number): CaLeaseState {
  const has = (t: number): boolean => {
    try {
      return (chain?.authorizedCaKeys(t) ?? []).length > 0;
    } catch {
      return false;
    }
  };
  if (!has(now)) return { state: "lapsed" };
  if (has(now + CA_WARN_DAYS * DAY)) return { state: "ok" };
  let lo = 0;
  let hi = CA_WARN_DAYS;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (has(now + mid * DAY)) lo = mid;
    else hi = mid;
  }
  return { state: "soon", daysLeft: lo };
}

export async function reportCaLease(sliver: Pick<SecuritySliver, "raise" | "resolve">, chain: CaTrustChain | null, now: number): Promise<CaLeaseState> {
  const s = caLeaseState(chain, now);
  if (s.state === "ok") {
    await sliver.resolve(CA_ISSUE_KEY);
    return s;
  }
  const severity: Severity = s.state === "lapsed" || s.daysLeft <= 3 ? "critical" : "high";
  await sliver.raise({
    issueKey: CA_ISSUE_KEY,
    kind: "ca-expiry",
    severity,
    target: "this server",
    summary:
      s.state === "lapsed"
        ? "This server's trust in Flagship's certificate authority has ended. Sharing a server, relay checks and signed time are paused until it updates."
        : `This server's trust in Flagship's certificate authority ends in ${s.daysLeft} day${s.daysLeft === 1 ? "" : "s"}. Update it before then.`,
    ...(s.state === "soon" ? { deadline: now + s.daysLeft * DAY } : {}),
    action: "Update this server",
  });
  return s;
}
