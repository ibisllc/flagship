// Members' roles in an app (docs/service-access-gating.md, "Open mode +
// members"). Ranks are Flagship's member < manager < master, ordered and
// cumulative (the box owner is always owner); apps enforce them. Every invite is a grant with a role; a person
// holding several has the highest. The owner changes a role with a signed
// order the box verifies under its sensitive-order key:
//
//   flagship/app-member-role/v1|<serverDomain>|<serviceId>|<target>|<role>|<issuedAt ms>
//
// target = `invite:<inviteId>` (an invite: everyone who joins through it),
// `grant:<inviteId>/<aid>` (one person's join: every redemption is its own
// grant) or `aid:<hex>` (a member who joined before grants were tracked).
// The display names live in ROLE_LABELS only.
//
// Must pass packages/protocol/test-vectors/app-member-role/vectors.json.

export const TAG_APP_MEMBER_ROLE = "flagship/app-member-role/v1";
export const MEMBER_ROLES = ["member", "manager", "master"];

// The ONE place the webapp names the ranks. Master is shown with a crown.
const ROLE_LABELS = { member: "Member", manager: "Manager", master: "Master", owner: "Owner" };
export const CROWNED_ROLE = "master";

/** "Member" / "Manager" / "Master" (anything else as given). */
export function roleLabel(role) {
  return ROLE_LABELS[role] ?? String(role ?? "");
}

/** The app's one line for a rank (its manifest's role_descriptions), or "". */
export function roleDescription(role, members) {
  return members?.descriptions?.[role] ?? "";
}

const AID_TARGET_RE = /^aid:[0-9a-f]{64}$/;
const INVITE_TARGET_RE = /^invite:[A-Za-z0-9._-]{1,128}$/;
const GRANT_TARGET_RE = /^grant:[A-Za-z0-9._-]{1,128}\/[0-9a-f]{64}$/;

function toHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function fieldGuard(name, v) {
  if (typeof v !== "string" || v.length === 0) throw new Error(`app-member-role: empty ${name}`);
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c === 0x7c || c <= 0x1f || c === 0x7f) throw new Error(`app-member-role: bad character in ${name}`);
  }
}

export function canonicalAppMemberRoleBytes({ serverDomain, serviceId, target, role, issuedAt }) {
  fieldGuard("serverDomain", serverDomain);
  fieldGuard("serviceId", serviceId);
  const t = String(target ?? "");
  if (!AID_TARGET_RE.test(t) && !INVITE_TARGET_RE.test(t) && !GRANT_TARGET_RE.test(t)) {
    throw new Error("app-member-role: bad target");
  }
  if (!MEMBER_ROLES.includes(role)) throw new Error("app-member-role: bad role");
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error("app-member-role: bad issuedAt");
  return new TextEncoder().encode(
    [TAG_APP_MEMBER_ROLE, serverDomain, serviceId, target, role, String(issuedAt)].join("|"),
  );
}

export const inviteTarget = (inviteId) => `invite:${inviteId}`;
export const grantTarget = (inviteId, aidHex) => `grant:${inviteId}/${String(aidHex).toLowerCase()}`;
export const aidTarget = (aidHex) => `aid:${String(aidHex).toLowerCase()}`;

/** Resolves to the POST body `{order, signature}`. */
export async function signAppMemberRole({ serverDomain, serviceId, target, role, issuedAt, umk, signWithIrk, bytesToHex = toHex }) {
  const order = { serverDomain, serviceId, target, role, issuedAt };
  const sig = await signWithIrk(umk, canonicalAppMemberRoleBytes(order));
  return { order, signature: bytesToHex(sig) };
}

const membersPath = (serviceId) => `/api/screens/services/${encodeURIComponent(serviceId)}/members`;

/**
 * `{mode, roles, defaultRole, descriptions, members:[{aid, role, grants:[{inviteId, role, tier}], direct}],
 * invites:[{inviteId, role, set, tier}]}`. `tier` is who signed the invite: "admin", "member" (its joins
 * stay Member unless an admin raises them) or null (invites from before tiers were recorded).
 */
export async function fetchMembers(serviceId, { fetchJson }) {
  return normalizeMembers(await fetchJson(membersPath(serviceId)));
}

const tierOf = (v) => (v === "admin" || v === "member" ? v : null);

export function normalizeMembers(body) {
  if (!body || typeof body !== "object") return body;
  return {
    ...body,
    members: Array.isArray(body.members)
      ? body.members.map((m) => ({
          ...m,
          grants: Array.isArray(m?.grants) ? m.grants.map((g) => ({ ...g, tier: tierOf(g?.tier) })) : [],
        }))
      : [],
    invites: Array.isArray(body.invites) ? body.invites.map((i) => ({ ...i, tier: tierOf(i?.tier) })) : [],
  };
}

/** The box's tier for one invite ("admin" | "member" | null). */
export function inviteTier(inviteId, members) {
  return members?.invites?.find((i) => i.inviteId === inviteId)?.tier ?? null;
}

// Who can invite (owner rule 2026-10-15): any device of the account may invite
// at Member; only a device holding the admin root grants higher ranks, changes
// ranks or withdraws someone else's invite.

export const ADMIN_ONLY_RANK_NOTE = "Only an admin device can give a higher rank";

/** Whether this unlocked session holds the account's admin root. */
export function isAdminDevice(session) {
  return session?.adminRootSeed instanceof Uint8Array;
}

/** The ranks this device may give a new invite. */
export function addableRoles(isAdmin) {
  return isAdmin ? MEMBER_ROLES : ["member"];
}

/** Whether this device may revoke a `.com` invite row: an admin any, others only their own member invites. */
export function canRevokeInvite(invite, { isAdmin, deviceId }) {
  if (isAdmin) return true;
  return invite?.creatorTier === "member" && typeof deviceId === "string" && deviceId !== "" && invite.creatorDeviceId === deviceId;
}

/**
 * "Invited by …" for a row, or "" for rows from before creators were recorded.
 * `deviceNames` maps device id → the name decrypted from the account directory
 * (null when this device can't read it).
 */
export function invitedByText(invite, { deviceId, deviceNames }) {
  const by = invite?.creatorDeviceId ?? null;
  if (by === null && (invite?.creatorTier ?? null) === null) return "";
  if (by !== null && by === deviceId) return "Invited by this device";
  const name = by !== null ? deviceNames?.get(by) : null;
  return name ? `Invited by ${name}` : "Invited by another device";
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

/** Sign and send one role change. Resolves to the box's `{ok, target, role}`. */
export async function setMemberRole({ serverDomain, serviceId, target, role, umk, signWithIrk, fetchJson, now = Date.now }) {
  if (!umk || typeof signWithIrk !== "function") throw new Error("Unlock the webapp first");
  const body = await signAppMemberRole({ serverDomain, serviceId, target, role, issuedAt: now(), umk, signWithIrk });
  return fetchJson(`${membersPath(serviceId)}/role`, { method: "POST", body: JSON.stringify(body) });
}

/**
 * Where a role change for one row of the members list goes. A person's
 * personal invite is their grant, so its role is the invite's; a member who
 * joined before grants were tracked is addressed by their AID.
 */
export function roleTargetFor({ inviteId, boundAID }, members) {
  const m = boundAID ? members?.members?.find((x) => x.aid === boundAID.toLowerCase()) : null;
  if (m && !m.grants.some((g) => g.inviteId === inviteId)) return aidTarget(m.aid);
  return inviteTarget(inviteId);
}

/** The role one row shows: its grant's role (or, for an untracked member, theirs). */
export function rowRole({ inviteId, boundAID }, members) {
  const m = boundAID ? members?.members?.find((x) => x.aid === boundAID.toLowerCase()) : null;
  if (m && !m.grants.some((g) => g.inviteId === inviteId)) return m.role;
  return members?.invites?.find((i) => i.inviteId === inviteId)?.role ?? members?.defaultRole ?? "viewer";
}

/**
 * The person's other grants, for "Sam: Editor (also in Family: Viewer)".
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

/** "also in Family: Viewer, Chess club: Editor" (empty when none). */
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
