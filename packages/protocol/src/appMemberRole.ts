/**
 * Flagship's ranks and the targets of a rank order (docs/service-access-gating.md,
 * "Account members"). The order itself is `flagship/app-rank/v1`
 * (appAccessOrders.ts); its server-named predecessor `flagship/app-member-role/v1`
 * is retired (pre-release: no box accepts it any more).
 *
 * `target` (as `flagship/app-rank/v1` uses it for invited people) is
 * `invite:<inviteId>` (everyone who joins through it and has no rank of their
 * own), `grant:<inviteId>/<64 lowercase hex>` (one person's join through that
 * invite) or `aid:<64 lowercase hex>` (the person, replacing their grants'
 * ranks). Ranks are `member` < `manager` < `master`, ordered and cumulative;
 * apps enforce what a rank may do and the box never blocks a request by rank.
 */
/** The ranks an owner can give, lowest first. */
export const APP_MEMBER_ROLES = ["member", "manager", "master"] as const;
export type AppMemberRank = (typeof APP_MEMBER_ROLES)[number];
const AID_TARGET_RE = /^aid:[0-9a-f]{64}$/;
const INVITE_TARGET_RE = /^invite:[A-Za-z0-9._-]{1,128}$/;
const GRANT_TARGET_RE = /^grant:([A-Za-z0-9._-]{1,128})\/([0-9a-f]{64})$/;

export function appMemberRoleTargetAid(aidHex: string): string {
  return `aid:${aidHex.toLowerCase()}`;
}

export function appMemberRoleTargetInvite(inviteId: string): string {
  return `invite:${inviteId}`;
}

export function appMemberRoleTargetGrant(inviteId: string, aidHex: string): string {
  return `grant:${inviteId}/${aidHex.toLowerCase()}`;
}

export type AppMemberRoleTarget =
  | { kind: "aid"; aid: string }
  | { kind: "invite"; inviteId: string }
  | { kind: "grant"; inviteId: string; aid: string };

/** The parsed target, or null when malformed. */
export function parseAppMemberRoleTarget(t: string): AppMemberRoleTarget | null {
  if (AID_TARGET_RE.test(t)) return { kind: "aid", aid: t.slice(4) };
  if (INVITE_TARGET_RE.test(t)) return { kind: "invite", inviteId: t.slice(7) };
  const g = GRANT_TARGET_RE.exec(t);
  if (g) return { kind: "grant", inviteId: g[1]!, aid: g[2]! };
  return null;
}
