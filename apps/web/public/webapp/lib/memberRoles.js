// Members' roles in an app (docs/service-access-gating.md, "Open mode +
// members"). Roles are Flagship's three ordered ranks (the box owner is always
// owner). Every invite is a grant with a role; a person
// holding several has the highest. The owner changes a role with a signed
// order the box verifies under its sensitive-order key:
//
//   flagship/app-member-role/v1|<serverDomain>|<serviceId>|<target>|<role>|<issuedAt ms>
//
// target = `invite:<inviteId>` (an invite: everyone who joins through it),
// `grant:<inviteId>/<aid>` (one person's join: every redemption is its own
// grant) or `aid:<hex>` (a member who joined before grants were tracked).
// The wire names are the three ranks; their display names live in ROLE_LABELS
// only, so a rename is one line here.
//
// Must pass packages/protocol/test-vectors/app-member-role/vectors.json.

export const TAG_APP_MEMBER_ROLE = "flagship/app-member-role/v1";
export const MEMBER_ROLES = ["viewer", "editor", "admin"];

const ROLE_LABELS = { viewer: "Viewer", editor: "Editor", admin: "Admin", owner: "Owner" };

/** "Viewer" / "Editor" / "Admin" (anything else as given). */
export function roleLabel(role) {
  return ROLE_LABELS[role] ?? String(role ?? "");
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

/** `{mode, roles, defaultRole, members:[{aid, role, grants:[{inviteId, role}], direct}], invites:[{inviteId, role, set}]}`. */
export async function fetchMembers(serviceId, { fetchJson }) {
  return fetchJson(membersPath(serviceId));
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
