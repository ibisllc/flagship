/**
 * Members' roles in an app (docs/service-access-gating.md, "Open mode +
 * members"), over the owner's paired session only:
 *
 *   GET  /api/screens/services/:id/members
 *        → { mode, roles, defaultRole, members:[{aid, role, grants:[{inviteId, role}], direct}], invites:[{inviteId, role, set}] }
 *          (a member's grants are their joins, one per invite redeemed; an invite's role is the one new joins get)
 *   POST /api/screens/services/:id/members/role   { order, signature } → { ok, target, role }
 *
 * The members are the app's allow-list (people who joined through an invite
 * link), in either mode: on an open app a member who signs in gets their
 * role, on a members-only app only members get in. Every redemption of an
 * invite is its own grant with a role (its own, else the invite's, else the
 * app's default); a person may hold several (a personal invite and group
 * links) and has the highest. Roles are Flagship's three ordered ranks;
 * `owner` is the box owner only.
 *
 * A role change is the owner's signed `flagship/app-member-role/v1` order,
 * checked under the box's sensitive-order authority, at most 10 minutes old
 * and newer than the last order for the same target. Companions get 403
 * (they could read who the members are).
 */
import {
  parseAppMemberRoleOrder,
  parseAppMemberRoleTarget,
  verifyAppMemberRole,
  type AppManifest,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "./adminAuthorityLocal.js";
import type { SensitiveAuthority } from "./egress/approvals.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";
import { MEMBER_ROLE_LADDER, ladderRole, type ServiceAccessStore } from "./serviceAccess.js";

export const MEMBER_ROLE_MAX_SKEW_MS = 10 * 60_000;

const J = { "content-type": "application/json" } as const;
const LIST_RE = /^\/api\/screens\/services\/([^/]+)\/members$/;
const ROLE_RE = /^\/api\/screens\/services\/([^/]+)\/members\/role$/;

export function isMemberRolesPath(path: string): boolean {
  return LIST_RE.test(path) || ROLE_RE.test(path);
}

/** The roles an owner can give (lowest first), and the role of a member they gave none. */
export function offeredRoles(manifest: Pick<AppManifest, "access"> | null): { roles: string[]; defaultRole: string } {
  return { roles: [...MEMBER_ROLE_LADDER], defaultRole: ladderRole(manifest?.access?.default_role) ?? "viewer" };
}

export interface MemberRolesHttpOptions extends SensitiveAuthority {
  /** The box FQDN every order must name. */
  serverDomain: string;
  store: Pick<
    ServiceAccessStore,
    | "mode"
    | "allowList"
    | "isAllowed"
    | "isOwner"
    | "roleOf"
    | "roles"
    | "setRole"
    | "grants"
    | "grantRole"
    | "inviteRole"
  >;
  /** An installed app's manifest; null when not installed here. */
  app: (serviceId: string) => { manifest: Pick<AppManifest, "access"> } | null;
  now?: () => number;
  log?: (m: string) => void;
}

export function buildMemberRolesHttp(
  opts: MemberRolesHttpOptions,
): (path: string, method: string, req: HttpRequest) => Promise<HttpResponse | null> {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const authority = {
    ownerIrkPub: opts.ownerIrkPub,
    ...(opts.adminRootPub ? { adminRootPub: opts.adminRootPub } : {}),
    username: opts.username,
    ...(opts.activeGrants ? { activeGrants: opts.activeGrants } : {}),
  };

  function list(serviceId: string, manifest: Pick<AppManifest, "access">): HttpResponse {
    const { roles, defaultRole } = offeredRoles(manifest);
    const set = opts.store.roles(serviceId);
    const known = new Set(Object.keys(set.invites));
    const members = opts.store
      .allowList(serviceId)
      .filter((aid) => !opts.store.isOwner(aid))
      .map((aid) => {
        const grants = opts.store.grants(serviceId, aid).map((inviteId) => {
          known.add(inviteId);
          return { inviteId, role: opts.store.grantRole(serviceId, inviteId, aid, defaultRole) };
        });
        return {
          aid,
          role: opts.store.roleOf(serviceId, aid, defaultRole) ?? defaultRole,
          grants,
          direct: ladderRole(set.aids[aid]),
        };
      });
    const invites = [...known].map((inviteId) => ({
      inviteId,
      role: opts.store.inviteRole(serviceId, inviteId, defaultRole),
      set: inviteId in set.invites,
    }));
    return json(200, { serviceId, mode: opts.store.mode(serviceId), roles, defaultRole, members, invites });
  }

  async function setRole(serviceId: string, req: HttpRequest): Promise<HttpResponse> {
    let body: { order?: unknown; signature?: unknown };
    try {
      body = JSON.parse(req.body.toString("utf8")) as typeof body;
    } catch {
      return err(400, "invalid json");
    }
    const order = parseAppMemberRoleOrder(body?.order);
    if (!order) return err(400, "malformed order");
    if (typeof body.signature !== "string" || !/^[0-9a-f]{128}$/i.test(body.signature)) {
      return err(400, "invalid signature hex");
    }
    if (order.serviceId !== serviceId) return err(400, "the order is for a different app");
    if (order.serverDomain !== opts.serverDomain) return err(403, "the order is for a different server");
    if (Math.abs(now() - order.issuedAt) > MEMBER_ROLE_MAX_SKEW_MS) return err(403, "the order is stale: sign it again");
    const sig = Uint8Array.from(Buffer.from(body.signature, "hex"));
    if (!authorizeSensitiveOrder({ ...authority, order, signature: sig, verify: verifyAppMemberRole })) {
      return err(403, "invalid signature");
    }
    const role = (MEMBER_ROLE_LADDER as readonly string[]).includes(order.role) ? ladderRole(order.role) : null;
    if (!role) return err(422, `"${order.role}" isn't a role: use viewer, editor or admin`);
    const target = parseAppMemberRoleTarget(order.target)!;
    if (target.kind !== "invite") {
      if (opts.store.isOwner(target.aid)) return err(422, "the owner is always the owner");
      if (!opts.store.isAllowed(serviceId, target.aid)) return err(422, "not a member of this app");
    }
    if (target.kind === "grant" && !opts.store.grants(serviceId, target.aid).includes(target.inviteId)) {
      return err(422, "they didn't join through that invite");
    }
    const r = await opts.store.setRole(serviceId, target, order.target, role, order.issuedAt);
    if (r === "stale") return err(409, "a newer change was already made: sign it again");
    log(`[members] ${serviceId}: ${target.kind} role set to ${order.role}`);
    return json(200, { ok: true, target: order.target, role: order.role });
  }

  return async function handle(path, method, req) {
    const m = ROLE_RE.exec(path) ?? LIST_RE.exec(path);
    if (!m) return null;
    let serviceId: string;
    try {
      serviceId = decodeURIComponent(m[1]!);
    } catch {
      return err(400, "bad service id");
    }
    const app = opts.app(serviceId);
    if (!app) return err(404, "no such service");
    if (ROLE_RE.test(path)) {
      if (method !== "POST") return err(405, "method not allowed");
      return setRole(serviceId, req);
    }
    if (method !== "GET") return err(405, "method not allowed");
    return list(serviceId, app.manifest);
  };
}

function json(status: number, body: unknown): HttpResponse {
  return { status, headers: J, body: JSON.stringify(body) };
}

function err(status: number, error: string): HttpResponse {
  return json(status, { error });
}
