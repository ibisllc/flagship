/**
 * A signed order to set a member's role in one app (docs/service-access-gating.md,
 * "Open mode + members").
 *
 * The owner picks a role for a person on the app's members list, or for an
 * invite before anyone has used it (a group invite's role applies to everyone
 * who joins through its link). The box checks the order under its
 * sensitive-order key (admin root when held, else the owner IRK) and keeps
 * the role with the app's members:
 *
 *   flagship/app-member-role/v1|<serverDomain>|<serviceId>|<target>|<role>|<issuedAt ms>
 *
 * `target` is `invite:<inviteId>` (an invite: everyone who joins through it
 * and has no role of their own), `grant:<inviteId>/<64 lowercase hex>` (one
 * person's join through that invite: every redemption is its own grant) or
 * `aid:<64 lowercase hex>` (a member who joined before grants were tracked).
 * `role` is one of Flagship's three ordered, cumulative ranks, `member` <
 * `manager` < `master`; `owner` is the box owner only and never given. Apps
 * enforce what a rank may do; the box never blocks a request by rank.
 *
 * `test-vectors/app-member-role/vectors.json` is the cross-platform reference.
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard, resolveMsgSigner, type MsgSigner } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_APP_MEMBER_ROLE = "flagship/app-member-role/v1";

export interface AppMemberRoleOrder {
  /** The box (its FQDN). */
  serverDomain: string;
  /** The installed service, `<creator>-<slug>`. */
  serviceId: string;
  /** `invite:<inviteId>`, `grant:<inviteId>/<aid hex>` or `aid:<hex>`. */
  target: string;
  role: string;
  /** Unix ms. */
  issuedAt: number;
}

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

export function appMemberRoleCanonicalBytes(o: AppMemberRoleOrder): Bytes {
  if (o.serverDomain.length === 0) throw new Error("app-member-role: empty serverDomain");
  if (o.serviceId.length === 0) throw new Error("app-member-role: empty serviceId");
  legacyFieldGuard("serverDomain", o.serverDomain);
  legacyFieldGuard("serviceId", o.serviceId);
  if (!parseAppMemberRoleTarget(o.target)) throw new Error("app-member-role: bad target");
  if (!(APP_MEMBER_ROLES as readonly string[]).includes(o.role)) throw new Error("app-member-role: bad role");
  if (!Number.isSafeInteger(o.issuedAt) || o.issuedAt < 0) throw new Error("app-member-role: bad issuedAt");
  return new TextEncoder().encode(
    [TAG_APP_MEMBER_ROLE, o.serverDomain, o.serviceId, o.target, o.role, String(o.issuedAt)].join("|"),
  );
}

export function signAppMemberRole(o: AppMemberRoleOrder, signer: MsgSigner): Bytes {
  return resolveMsgSigner(signer)(appMemberRoleCanonicalBytes(o));
}

/** Never throws: a malformed order simply fails. */
export function verifyAppMemberRole(o: AppMemberRoleOrder, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, appMemberRoleCanonicalBytes(o), pub);
  } catch {
    return false;
  }
}

/** Shape-check an untrusted JSON order (no signature check). */
export function parseAppMemberRoleOrder(v: unknown): AppMemberRoleOrder | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.serverDomain !== "string" || typeof r.serviceId !== "string") return null;
  if (typeof r.target !== "string" || typeof r.role !== "string") return null;
  if (typeof r.issuedAt !== "number" || !Number.isSafeInteger(r.issuedAt)) return null;
  const o: AppMemberRoleOrder = {
    serverDomain: r.serverDomain,
    serviceId: r.serviceId,
    target: r.target,
    role: r.role,
    issuedAt: r.issuedAt,
  };
  try {
    appMemberRoleCanonicalBytes(o);
  } catch {
    return null;
  }
  return o;
}
