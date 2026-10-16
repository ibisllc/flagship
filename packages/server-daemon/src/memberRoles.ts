/**
 * Members' ranks in an app (docs/service-access-gating.md, "Open mode +
 * members" and "Account members, ranks and who may change them"), over the
 * owner's paired session only:
 *
 *   GET  /api/screens/services/:id/members
 *        → { mode, roles, defaultRole, descriptions,
 *            accountMembers:[{kind:"device", deviceId, devicePub, tier, rank, set, refused}
 *                           |{kind:"co-manager", shareId, label, rank, set, refused}],
 *            members:[{aid, role, grants:[{inviteId, role, tier}], direct}],
 *            invites:[{inviteId, role, set, tier, creatorPub, creatorDeviceId}] }
 *   POST /api/screens/services/:id/members/rank   { order, signature }   (flagship/app-rank/v1)
 *
 * Account members are the devices of the account that owns the box (from the
 * device book: admin devices are Master, the others Manager) and the accounts
 * co-managing it (Manager), unless an admin order set another rank or refused
 * them in this app. Members are the app's allow-list (people who joined
 * through an invite link), in either mode. Every redemption of an invite is
 * its own grant with a role (its own, else the invite's, else the app's
 * default); a person may hold several and has the highest, unless an admin
 * order on them (`aid:`) replaces it. Ranks are member < manager < master,
 * ordered and cumulative; there is no owner rank. Apps enforce them: the box
 * never blocks a request by rank.
 *
 * Every order is admin-only: verified under the box's sensitive-order key
 * (the admin root or an admin device on a box with a pinned admin root; the
 * IRK every device holds can't change anyone's rank), at most 10 minutes old
 * and newer than the last order for the same target. Companions get 403 (they
 * could read who the members are).
 */
import {
  parseAppRankOrder,
  parseAppRankTarget,
  verifyAppRank,
  type AdminGrantView,
  type AppManifest,
  type AppMemberRoleTarget,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "./adminAuthorityLocal.js";
import type { SensitiveAuthority } from "./egress/approvals.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";
import {
  MEMBER_ROLE_LADDER,
  ladderRole,
  rankKey,
  type AccountRank,
  type EntryResult,
  type ServiceAccessStore,
} from "./serviceAccess.js";
import type { AccessEntry } from "./accessJournal.js";

export const MEMBER_ROLE_MAX_SKEW_MS = 10 * 60_000;

const J = { "content-type": "application/json" } as const;
const LIST_RE = /^\/api\/screens\/services\/([^/]+)\/members$/;
const RANK_RE = /^\/api\/screens\/services\/([^/]+)\/members\/rank$/;

export function isMemberRolesPath(path: string): boolean {
  return LIST_RE.test(path) || RANK_RE.test(path);
}

/**
 * The ranks an admin can give (lowest first), the rank of a member they gave
 * none, and the app's one-line description of each rank (from its manifest).
 */
export function offeredRoles(manifest: Pick<AppManifest, "access"> | null): {
  roles: string[];
  defaultRole: string;
  descriptions: Record<string, string>;
} {
  const descriptions: Record<string, string> = {};
  for (const r of MEMBER_ROLE_LADDER) {
    const d = manifest?.access?.role_descriptions?.[r];
    if (typeof d === "string") descriptions[r] = d;
  }
  return {
    roles: [...MEMBER_ROLE_LADDER],
    defaultRole: ladderRole(manifest?.access?.default_role) ?? "member",
    descriptions,
  };
}

export interface MemberRolesHttpOptions extends SensitiveAuthority {
  /** The box FQDN every v1 order must name. */
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
    | "setAccountRank"
    | "grants"
    | "grantRole"
    | "inviteRole"
    | "inviteTier"
    | "inviteCreator"
    | "principal"
    | "accountPeople"
    | "accountRank"
    | "rankOverride"
  >;
  /** The admin devices' grants from the device book (admin-only orders). */
  adminGrants?: () => readonly AdminGrantView[];
  /** An installed app's manifest; null when not installed here. */
  app: (serviceId: string) => { manifest: Pick<AppManifest, "access"> } | null;
  /** Every rank order this box accepted (docs/service-access-gating.md "One list per app"). */
  onEntry?: (serviceRef: string, entry: AccessEntry) => void;
  now?: () => number;
  log?: (m: string) => void;
}

/**
 * Apply a `flagship/app-rank/v1` order another of the account's servers
 * handed over: verified here under this box's admin-only key, latest order
 * wins per target, no freshness window.
 */
export function buildRankEntryApplier(
  opts: Omit<MemberRolesHttpOptions, "serverDomain" | "onEntry">,
): (serviceRef: string, entry: AccessEntry) => Promise<EntryResult> {
  const core = rankCore(opts);
  return async (serviceRef, entry) => {
    if (entry.kind !== "rank") return "skipped";
    const order = parseAppRankOrder(entry.order);
    if (!order || order.serviceRef !== serviceRef || !opts.app(serviceRef)) return "refused";
    let sig: Uint8Array;
    try {
      sig = Uint8Array.from(Buffer.from(entry.signature, "hex"));
    } catch {
      return "refused";
    }
    if (!core.adminSigned(order, sig, verifyAppRank)) return "refused";
    const r = await core.applyRank(serviceRef, order);
    if (r === null) return "applied";
    return r.status === 409 ? "stale" : "refused";
  };
}

function rankCore(opts: Omit<MemberRolesHttpOptions, "serverDomain" | "onEntry">) {
  const now = opts.now ?? (() => Date.now());
  function adminSigned<T>(order: T, sig: Uint8Array, verify: (o: T, s: Uint8Array, p: Uint8Array) => boolean): boolean {
    return authorizeSensitiveOrder({
      order,
      signature: sig,
      verify,
      ownerIrkPub: opts.ownerIrkPub,
      ...(opts.adminRootPub ? { adminRootPub: opts.adminRootPub } : {}),
      username: opts.username,
      activeGrants: [...(opts.activeGrants ?? []), ...(opts.adminGrants?.() ?? [])],
      now: now(),
    });
  }

  async function applyInvitedTarget(
    serviceId: string,
    target: AppMemberRoleTarget,
    targetKey: string,
    role: string,
    issuedAt: number,
  ): Promise<HttpResponse | null> {
    const rank = ladderRole(role);
    if (!rank || !(MEMBER_ROLE_LADDER as readonly string[]).includes(role)) {
      return err(422, `"${role}" isn't a rank: use member, manager or master`);
    }
    if (target.kind !== "invite") {
      if (opts.store.isOwner(target.aid) || opts.store.principal(target.aid)) {
        return err(422, "that's one of the account's own devices: change it in Account members");
      }
      if (!opts.store.isAllowed(serviceId, target.aid)) return err(422, "not a member of this app");
    }
    if (target.kind === "grant" && !opts.store.grants(serviceId, target.aid).includes(target.inviteId)) {
      return err(422, "they didn't join through that invite");
    }
    const r = await opts.store.setRole(serviceId, target, targetKey, rank, issuedAt);
    if (r === "stale") return err(409, "a newer change was already made: sign it again");
    return null;
  }

  /** Apply a verified app-rank order; null when applied. */
  async function applyRank(serviceId: string, order: { target: string; rank: string; issuedAt: number }): Promise<HttpResponse | null> {
    const target = parseAppRankTarget(order.target)!;
    if (target.kind === "device" || target.kind === "share") {
      const p = target.kind === "device" ? opts.store.principal(target.pub) : null;
      if (target.kind === "device" && p?.kind !== "device") return err(422, "not a device of this account");
      if (target.kind === "share" && !opts.store.accountPeople().some((x) => x.kind === "co-manager" && x.shareId === target.shareId)) {
        return err(422, "not an account that co-manages this server");
      }
      const key = target.kind === "device" ? rankKey(p!) : order.target;
      const r = await opts.store.setAccountRank(serviceId, key, order.rank as AccountRank, order.issuedAt);
      if (r === "stale") return err(409, "a newer change was already made: sign it again");
      return null;
    }
    return applyInvitedTarget(serviceId, target, order.target, order.rank, order.issuedAt);
  }

  return { adminSigned, applyInvitedTarget, applyRank };
}

export function buildMemberRolesHttp(
  opts: MemberRolesHttpOptions,
): (path: string, method: string, req: HttpRequest) => Promise<HttpResponse | null> {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const { adminSigned, applyRank } = rankCore(opts);

  function list(serviceId: string, manifest: Pick<AppManifest, "access">): HttpResponse {
    const { roles, defaultRole, descriptions } = offeredRoles(manifest);
    const set = opts.store.roles(serviceId);
    const known = new Set([...Object.keys(set.invites), ...Object.keys(set.creators)]);
    const accountMembers = opts.store.accountPeople().map((p) => {
      const override = opts.store.rankOverride(serviceId, p);
      const common = {
        rank: opts.store.accountRank(serviceId, p),
        set: override !== null,
        refused: override === "refused",
      };
      return p.kind === "device"
        ? { kind: "device" as const, deviceId: p.deviceId, devicePub: p.pub, tier: p.tier, ...common }
        : { kind: "co-manager" as const, shareId: p.shareId, label: p.label, ...common };
    });
    const members = opts.store
      .allowList(serviceId)
      .filter((aid) => !opts.store.isOwner(aid) && !opts.store.principal(aid))
      .map((aid) => {
        const grants = opts.store.grants(serviceId, aid).map((inviteId) => {
          known.add(inviteId);
          return {
            inviteId,
            role: opts.store.grantRole(serviceId, inviteId, aid, defaultRole),
            tier: opts.store.inviteTier(serviceId, inviteId),
          };
        });
        return {
          aid,
          role: opts.store.roleOf(serviceId, aid, defaultRole) ?? defaultRole,
          grants,
          direct: ladderRole(set.aids[aid]),
        };
      });
    const invites = [...known].map((inviteId) => {
      const creatorPub = opts.store.inviteCreator(serviceId, inviteId);
      const creator = creatorPub ? opts.store.principal(creatorPub) : null;
      return {
        inviteId,
        role: opts.store.inviteRole(serviceId, inviteId, defaultRole),
        set: inviteId in set.invites,
        tier: opts.store.inviteTier(serviceId, inviteId),
        creatorPub,
        creatorDeviceId: creator?.kind === "device" ? creator.deviceId : null,
      };
    });
    return json(200, {
      serviceId,
      mode: opts.store.mode(serviceId),
      roles,
      defaultRole,
      descriptions,
      accountMembers,
      members,
      invites,
    });
  }

  function readBody(req: HttpRequest): { order: unknown; sig: Uint8Array } | HttpResponse {
    let body: { order?: unknown; signature?: unknown };
    try {
      body = JSON.parse(req.body.toString("utf8")) as typeof body;
    } catch {
      return err(400, "invalid json");
    }
    if (typeof body?.signature !== "string" || !/^[0-9a-f]{128}$/i.test(body.signature)) {
      return err(400, "invalid signature hex");
    }
    return { order: body.order, sig: Uint8Array.from(Buffer.from(body.signature, "hex")) };
  }

  async function setRank(serviceId: string, req: HttpRequest): Promise<HttpResponse> {
    const b = readBody(req);
    if ("status" in b) return b;
    const order = parseAppRankOrder(b.order);
    if (!order) return err(400, "malformed order");
    if (order.serviceRef !== serviceId) return err(400, "the order is for a different app");
    if (Math.abs(now() - order.issuedAt) > MEMBER_ROLE_MAX_SKEW_MS) return err(403, "the order is stale: sign it again");
    if (!adminSigned(order, b.sig, verifyAppRank)) return err(403, "only an admin device can change a rank");
    const refused = await applyRank(serviceId, order);
    if (refused) return refused;
    opts.onEntry?.(serviceId, { kind: "rank", order, signature: Buffer.from(b.sig).toString("hex") });
    log(`[members] ${serviceId}: ${order.target.split(":")[0]} rank set to ${order.rank}`);
    return json(200, { ok: true, target: order.target, rank: order.rank });
  }

  return async function handle(path, method, req) {
    const m = RANK_RE.exec(path) ?? LIST_RE.exec(path);
    if (!m) return null;
    let serviceId: string;
    try {
      serviceId = decodeURIComponent(m[1]!);
    } catch {
      return err(400, "bad service id");
    }
    const app = opts.app(serviceId);
    if (!app) return err(404, "no such service");
    if (RANK_RE.test(path)) {
      if (method !== "POST") return err(405, "method not allowed");
      return setRank(serviceId, req);
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
