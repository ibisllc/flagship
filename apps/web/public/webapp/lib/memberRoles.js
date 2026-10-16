// Ranks in an app (docs/service-access-gating.md, "Account members, ranks and
// who may change them"). Exactly three ranks, member < manager < master,
// ordered and cumulative; apps enforce them. There is no owner rank: a legacy
// "owner" from a server reads as master.
//
// Everyone gets a rank by default: the account's admin devices master, its
// other devices and co-managing accounts manager, invited people member (or
// what an admin chose). An admin changes any of them for one app with an order
// the box verifies under the admin root:
//
//   flagship/app-rank/v1|<serviceRef>|<target>|<rank>|<issuedAt ms>
//
// target = `device:<64 hex device key>`, `share:<32 hex shareId>`,
// `invite:<inviteId>` (everyone who joins through it), `grant:<inviteId>/<aid>`
// (one person's join) or `aid:<hex>` (a member who joined before grants were
// tracked); rank = member | manager | master, or `refused` (device and share
// targets only). The display names live in ROLE_LABELS only.
//
// Must pass packages/protocol/test-vectors/app-access-orders/vectors.json.

export const TAG_APP_RANK = "flagship/app-rank/v1";
export const MEMBER_ROLES = ["member", "manager", "master"];
export const RANK_REFUSED = "refused";

// The ONE place the webapp names the ranks. Master is shown with a crown.
const ROLE_LABELS = { member: "Member", manager: "Manager", master: "Master", refused: "Refused" };
export const CROWNED_ROLE = "master";

/** "Member" / "Manager" / "Master" / "Refused" (anything else as given). */
export function roleLabel(role) {
  return ROLE_LABELS[role] ?? String(role ?? "");
}

/** A rank from a server: one of MEMBER_ROLES, a legacy "owner" as master, else null. */
export function normalizeRank(v) {
  if (v === "owner") return "master";
  return MEMBER_ROLES.includes(v) ? v : null;
}

/** Whether a rank is manager-class (manager or master). */
export function isManagerClass(rank) {
  return rank === "manager" || rank === "master";
}

/** The app's one line for a rank (its manifest's role_descriptions), or "". */
export function roleDescription(role, members) {
  return members?.descriptions?.[role] ?? "";
}

const SERVICE_REF_RE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const DEVICE_TARGET_RE = /^device:[0-9a-f]{64}$/;
const SHARE_TARGET_RE = /^share:[0-9a-f]{32}$/;
const AID_TARGET_RE = /^aid:[0-9a-f]{64}$/;
const INVITE_TARGET_RE = /^invite:[A-Za-z0-9._-]{1,128}$/;
const GRANT_TARGET_RE = /^grant:[A-Za-z0-9._-]{1,128}\/[0-9a-f]{64}$/;

function toHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function canonicalAppRankBytes({ serviceRef, target, rank, issuedAt }) {
  if (typeof serviceRef !== "string" || !SERVICE_REF_RE.test(serviceRef)) throw new Error("app-rank: bad serviceRef");
  const t = String(target ?? "");
  const accountTarget = DEVICE_TARGET_RE.test(t) || SHARE_TARGET_RE.test(t);
  if (!accountTarget && !AID_TARGET_RE.test(t) && !INVITE_TARGET_RE.test(t) && !GRANT_TARGET_RE.test(t)) {
    throw new Error("app-rank: bad target");
  }
  if (!MEMBER_ROLES.includes(rank) && rank !== RANK_REFUSED) throw new Error("app-rank: bad rank");
  if (rank === RANK_REFUSED && !accountTarget) throw new Error("app-rank: only a device or a co-manager can be refused");
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error("app-rank: bad issuedAt");
  return new TextEncoder().encode([TAG_APP_RANK, serviceRef, t, rank, String(issuedAt)].join("|"));
}

export const deviceTarget = (pubHex) => `device:${String(pubHex).toLowerCase()}`;
export const shareTarget = (shareId) => `share:${String(shareId).toLowerCase()}`;
export const inviteTarget = (inviteId) => `invite:${inviteId}`;
export const grantTarget = (inviteId, aidHex) => `grant:${inviteId}/${String(aidHex).toLowerCase()}`;
export const aidTarget = (aidHex) => `aid:${String(aidHex).toLowerCase()}`;

/** The rank target of one Account members row. */
export function accountMemberTarget(row) {
  return row?.kind === "co-manager" ? shareTarget(row.shareId) : deviceTarget(row?.devicePub ?? "");
}

/** Resolves to the POST body `{order, signature}`. */
export async function signAppRank({ serviceRef, target, rank, issuedAt, umk, signWithIrk, bytesToHex = toHex }) {
  const order = { serviceRef, target, rank, issuedAt };
  const sig = await signWithIrk(umk, canonicalAppRankBytes(order));
  return { order, signature: bytesToHex(sig) };
}

const membersPath = (serviceId) => `/api/screens/services/${encodeURIComponent(serviceId)}/members`;

/**
 * Sign (pass the sensitive-order signer: the admin root) and send one rank
 * order. Resolves to the box's `{ok, target, rank}`; a 409 means a newer
 * order already landed (sign again), a 403 that this device isn't an admin.
 */
export async function setAppRank({ serviceId, target, rank, umk, signWithIrk, fetchJson, now = Date.now }) {
  if (!umk || typeof signWithIrk !== "function") throw new Error("Unlock the webapp first");
  const body = await signAppRank({ serviceRef: serviceId, target, rank, issuedAt: now(), umk, signWithIrk });
  return fetchJson(`${membersPath(serviceId)}/rank`, { method: "POST", body: JSON.stringify(body) });
}

/**
 * `{mode, roles, defaultRole, descriptions,
 *   accountMembers:[{kind:"device", deviceId, devicePub, tier, rank, set, refused}
 *                  |{kind:"co-manager", shareId, label, rank, set, refused}],
 *   members:[{aid, role, grants:[{inviteId, role, tier}], direct}],
 *   invites:[{inviteId, role, set, tier, creatorPub, creatorDeviceId,
 *             creatorShareId, creatorLabel}]}`.
 * `tier` is who signed an invite: "admin", "member" (another device; its
 * joins stay Member unless an admin raises them), "co-manager" (someone the
 * server is shared with, named by `creatorLabel`; Member too) or null
 * (invites from before tiers were recorded). An account member's `rank` is
 * null when refused.
 */
export async function fetchMembers(serviceId, { fetchJson }) {
  return normalizeMembers(await fetchJson(membersPath(serviceId)));
}

const tierOf = (v) => (v === "admin" || v === "member" || v === "co-manager" ? v : null);
const hexOrNull = (v, len) => (typeof v === "string" && new RegExp(`^[0-9a-f]{${len}}$`).test(v.toLowerCase()) ? v.toLowerCase() : null);

function normalizeAccountMember(m) {
  if (!m || typeof m !== "object") return null;
  const refused = m.refused === true || m.rank === RANK_REFUSED;
  const common = { rank: refused ? null : normalizeRank(m.rank), set: m.set === true, refused };
  if (m.kind === "device") {
    const devicePub = hexOrNull(m.devicePub, 64);
    if (!devicePub) return null;
    return { kind: "device", deviceId: hexOrNull(m.deviceId, 32), devicePub, tier: tierOf(m.tier), ...common };
  }
  if (m.kind === "co-manager") {
    const shareId = hexOrNull(m.shareId, 32);
    if (!shareId) return null;
    return { kind: "co-manager", shareId, label: typeof m.label === "string" ? m.label : "", ...common };
  }
  return null;
}

export function normalizeMembers(body) {
  if (!body || typeof body !== "object") return body;
  return {
    ...body,
    roles: MEMBER_ROLES,
    defaultRole: normalizeRank(body.defaultRole) ?? "member",
    accountMembers: Array.isArray(body.accountMembers) ? body.accountMembers.map(normalizeAccountMember).filter(Boolean) : [],
    members: Array.isArray(body.members)
      ? body.members.map((m) => ({
          ...m,
          role: normalizeRank(m?.role) ?? "member",
          grants: Array.isArray(m?.grants)
            ? m.grants.map((g) => ({ ...g, role: normalizeRank(g?.role) ?? "member", tier: tierOf(g?.tier) }))
            : [],
        }))
      : [],
    invites: Array.isArray(body.invites)
      ? body.invites.map((i) => ({
          ...i,
          role: normalizeRank(i?.role) ?? "member",
          tier: tierOf(i?.tier),
          creatorPub: hexOrNull(i?.creatorPub, 64),
          creatorDeviceId: hexOrNull(i?.creatorDeviceId, 32),
          creatorShareId: hexOrNull(i?.creatorShareId, 32),
          creatorLabel: typeof i?.creatorLabel === "string" && i.creatorLabel ? i.creatorLabel : null,
        }))
      : [],
  };
}

/** The box's tier for one invite ("admin" | "member" | null). */
export function inviteTier(inviteId, members) {
  return members?.invites?.find((i) => i.inviteId === inviteId)?.tier ?? null;
}

// Who may do what (docs "What each class may do"): an admin device (it holds
// the admin root) everything; any other device of the account invites at
// Member and withdraws its own invites while it is manager-class in the app.

export const ADMIN_ONLY_RANK_NOTE = "Only an admin device can give a higher rank";
export const INVITE_NEEDS_MANAGER_NOTE = "Only an admin can let you invite people to this app.";
export const DEVICE_NOT_LISTED_NOTE = "Your server doesn't list this device yet. Refresh in a minute.";
export const RANKS_UNKNOWN_NOTE = "Couldn't read your rank in this app from your server.";
export const ADMIN_ONLY_MODE_NOTE = "Only an admin device can change who can open it.";

/** Whether this unlocked session holds the account's admin root. */
export function isAdminDevice(session) {
  return session?.adminRootSeed instanceof Uint8Array;
}

/** The ranks this device may give a new invite. */
export function addableRoles(isAdmin) {
  return isAdmin ? MEMBER_ROLES : ["member"];
}

/** This device's row in Account members (by its account device key, else its device id), or null. */
export function myAccountMember(members, { devicePub, deviceId } = {}) {
  const rows = (members?.accountMembers ?? []).filter((m) => m.kind === "device");
  const pub = typeof devicePub === "string" ? devicePub.toLowerCase() : "";
  return (pub && rows.find((m) => m.devicePub === pub)) || (deviceId ? rows.find((m) => m.deviceId === deviceId) : null) || null;
}

/**
 * Whether this device may add people to the app, at which ranks, and the one
 * line saying why not. `members` is the box's list (null when it couldn't be
 * read), `me` this device's Account members row.
 */
export function inviteAbility({ isAdmin, members, me }) {
  if (isAdmin) return { canInvite: true, roles: MEMBER_ROLES, why: "" };
  if (!members) return { canInvite: false, roles: [], why: RANKS_UNKNOWN_NOTE };
  if (!me) return { canInvite: false, roles: [], why: DEVICE_NOT_LISTED_NOTE };
  if (me.refused || !isManagerClass(me.rank)) return { canInvite: false, roles: [], why: INVITE_NEEDS_MANAGER_NOTE };
  return { canInvite: true, roles: ["member"], why: "" };
}

/**
 * Whether this device may withdraw an invite: an admin any; another device
 * only a member invite it created, while it is manager-class in the app. The
 * creator is matched on `.com`'s row (its device id) or the box's (its key).
 */
export function canRevokeInvite(invite, { isAdmin, deviceId, devicePub = "", managerClass = false, members = null }) {
  if (isAdmin) return true;
  if (!managerClass || invite?.creatorTier !== "member") return false;
  const id = typeof deviceId === "string" && deviceId !== "" ? deviceId : null;
  if (id && invite.creatorDeviceId === id) return true;
  const box = members?.invites?.find((i) => i.inviteId === invite?.inviteId);
  if (!box) return false;
  return (!!devicePub && box.creatorPub === devicePub.toLowerCase()) || (!!id && box.creatorDeviceId === id);
}

/**
 * "Invited by …" for a row, or "" for rows from before creators were recorded.
 * `deviceNames` maps device id → the name decrypted from the account directory
 * (null when this device can't read it). A co-manager's invite is named by
 * the owner's label for the share, from the box's list (`members`).
 */
export function invitedByText(invite, { deviceId, deviceNames, members = null }) {
  if (invite?.creatorTier === "co-manager") {
    const label = members?.invites?.find((i) => i.inviteId === invite.inviteId)?.creatorLabel ?? null;
    return label ? `Invited by ${label} (co-manager)` : "Invited by a co-manager";
  }
  const by = invite?.creatorDeviceId ?? null;
  if (by === null && (invite?.creatorTier ?? null) === null) return "";
  if (by !== null && by === deviceId) return "Invited by this device";
  const name = by !== null ? deviceNames?.get(by) : null;
  return name ? `Invited by ${name}` : "Invited by another device";
}

/** An Account members row's name: the decrypted device name, the owner's label for a co-manager, or a generic one. */
export function accountMemberName(row, { deviceNames } = {}) {
  if (row?.kind === "co-manager") return row.label || "Co-manager";
  const name = row?.deviceId ? deviceNames?.get(row.deviceId) : null;
  if (name) return name;
  return row?.deviceId ? `Device ${row.deviceId.slice(0, 8)}` : `Device ${String(row?.devicePub ?? "").slice(0, 8)}`;
}

/** The line under an Account members row's name. */
export function accountMemberLine(row, { devicePub } = {}) {
  if (row?.kind === "co-manager") return "Co-manages this server";
  const parts = [];
  if (devicePub && row?.devicePub === devicePub.toLowerCase()) parts.push("This device");
  parts.push(row?.tier === "admin" ? "Admin device" : "Device on your account");
  return parts.join(" · ");
}

/**
 * A memoized device id → name lookup over the signed, encrypted account
 * directory. A failed read (no directory access, offline) resolves to null
 * and is not retried until a new resolver is made.
 */
export function deviceNameResolver(fetchDirectory) {
  let pending = null;
  return () => {
    pending ??= Promise.resolve()
      .then(fetchDirectory)
      .then(
        (dir) => new Map((dir?.devices ?? []).filter((d) => d?.deviceId && d.displayName).map((d) => [d.deviceId, d.displayName])),
        () => null,
      );
    return pending;
  };
}

/**
 * Where a rank change for one row of the members list goes. A person's
 * personal invite is their grant, so its rank is the invite's; a member who
 * joined before grants were tracked is addressed by their AID.
 */
export function roleTargetFor({ inviteId, boundAID }, members) {
  const m = boundAID ? members?.members?.find((x) => x.aid === boundAID.toLowerCase()) : null;
  if (m && !m.grants.some((g) => g.inviteId === inviteId)) return aidTarget(m.aid);
  return inviteTarget(inviteId);
}

/** The rank one row shows: its grant's rank (or, for an untracked member, theirs). */
export function rowRole({ inviteId, boundAID }, members) {
  const m = boundAID ? members?.members?.find((x) => x.aid === boundAID.toLowerCase()) : null;
  if (m && !m.grants.some((g) => g.inviteId === inviteId)) return m.role;
  return members?.invites?.find((i) => i.inviteId === inviteId)?.role ?? members?.defaultRole ?? "member";
}

/**
 * The person's other grants, for "Sam: Manager (also in Family: Member)".
 * `labelOf(inviteId)` names a grant (a group's label); unnamed ones are skipped.
 */
export function otherGrants({ inviteId, boundAID }, members, labelOf) {
  const m = boundAID ? members?.members?.find((x) => x.aid === boundAID.toLowerCase()) : null;
  if (!m) return [];
  return m.grants
    .filter((g) => g.inviteId !== inviteId)
    .map((g) => ({ label: labelOf(g.inviteId), role: g.role }))
    .filter((g) => g.label);
}

/** "also in Family: Member, Chess club: Manager" (empty when none). */
export function alsoInText(others) {
  if (!others.length) return "";
  return `also in ${others.map((o) => `${o.label}: ${roleLabel(o.role)}`).join(", ")}`;
}

/**
 * Whether removing this grant should also prune these AIDs on the box: only
 * the ones for whom it was their last grant (the box drops a grant itself when
 * it sees the revoke; pruning an AID that holds another grant would end that
 * one too). AIDs the box doesn't list are pruned (nothing to keep).
 */
export function aidsToPrune(inviteId, aids, members) {
  return aids.filter((aid) => {
    const m = members?.members?.find((x) => x.aid === String(aid).toLowerCase());
    if (!m) return true;
    return m.grants.every((g) => g.inviteId === inviteId);
  });
}
