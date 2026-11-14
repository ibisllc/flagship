/**
 * How many people an account may share its servers with, per plan (owner
 * decision 2026-11-14, docs/enterprise-accounts.md "Owner decisions"): Free 5,
 * Pro 10, Pro Max 25, Enterprise unlimited. App visitors are never capped.
 *
 * The unit is one active share (one person on one server): a share's keys are
 * per share by design (docs/share-a-server.md §3), so no server, and nobody
 * else, can tell that two shares on two servers are the same person.
 *
 * The box enforces the cap when a share goes live; `.com` refuses a new share
 * link once the account's open links and live shares reach it. An account
 * already over its cap keeps every share it has and adds none until it is
 * under. Both answer 403 `{ error, code: "co-manager-cap", count, cap, plan }`;
 * each app words the refusal itself from `plan` and `cap`.
 */

export const CO_MANAGER_CAP_CODE = "co-manager-cap";

/** The plan names `.com` uses (`hobby` = Pro, `maker` = Pro Max) plus Enterprise. */
export type CoManagerPlan = "free" | "hobby" | "maker" | "enterprise";

/** `null` is unlimited. */
export const CO_MANAGER_CAPS: Readonly<Record<CoManagerPlan, number | null>> = Object.freeze({
  free: 5,
  hobby: 10,
  maker: 25,
  enterprise: null,
});

/** A plan this table doesn't know (or no plan at all) counts as Free. */
export function coManagerPlanOf(tier: string | null | undefined): CoManagerPlan {
  return tier === "hobby" || tier === "maker" || tier === "enterprise" ? tier : "free";
}

export function coManagerCapFor(tier: string | null | undefined): number | null {
  return CO_MANAGER_CAPS[coManagerPlanOf(tier)];
}

export interface CoManagerCount {
  count: number;
  /** `null` is unlimited. */
  cap: number | null;
  plan: CoManagerPlan;
}

/** Whether one more share may go live (an account at or over its cap adds none). */
export function coManagerRoomFor(c: CoManagerCount): boolean {
  return c.cap === null || c.count < c.cap;
}

export interface CoManagerCapRefusal {
  error: typeof CO_MANAGER_CAP_CODE;
  code: typeof CO_MANAGER_CAP_CODE;
  count: number;
  cap: number;
  plan: CoManagerPlan;
}

export function coManagerCapRefusal(c: CoManagerCount & { cap: number }): CoManagerCapRefusal {
  return { error: CO_MANAGER_CAP_CODE, code: CO_MANAGER_CAP_CODE, count: c.count, cap: c.cap, plan: c.plan };
}
