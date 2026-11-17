import {
  OrgAuthorityError,
  PqTrustError,
  authorizeOrgOrder,
  buildOrgSeatBook,
  canonicalOrgAuthority,
  canonicalOrgSeatAccept,
  canonicalOrgSeatGrant,
  canonicalOrgSeatInvite,
  canonicalOrgSeatFreeze,
  canonicalOrgOverturn,
  canonicalOrgSeatRevoke,
  canonicalOrgVeto,
  canonicalOrgDirectoryWrite,
  canonicalOrgDirectorySliceWrite,
  type OrgDirectorySlice,
  canonicalOrgSeatKem,
  orgKemKeyIdHex,
  verifyOrgSeatKem,
  type OrgDirectorySealed,
  type OrgSeatKemBundle,
  orgApprovalFromWire,
  orgAuthorityHash,
  orgKeyIdHex,
  orgSeatRolesHash,
  orgSha256Hex,
  orgSeatSubject,
  orgRolesRaiseAdmin,
  pqKeyBindingFromWire,
  verifiedOrgFreezes,
  verifyCriticalSignature,
  verifyOrgApprovers,
  verifyOrgAuthorityChain,
  verifyOrgSeatGrant,
  verifyPqKeyBinding,
  type OrgAction,
  type OrgApproval,
  type OrgAuthorityEntry,
  type OrgAuthorityState,
  type OrgOverturn,
  type OrgSeatBook,
  type OrgSeatFreeze,
  type OrgSeatGrantBundle,
  type OrgSeatInvite,
  type OrgSeatRevokeBundle,
  type OrgSeatRole,
  type OrgSigned,
  type OrgVeto,
  type PolicyState,
} from "@flagship/protocol";
import type { OrgObjectKind, OrgRecord, OrgStorage, UsernameStorage } from "@flagship/storage";
import { DEFAULT_PAYMENTS_CONFIG, orgTrialTerms, type PaymentsConfig } from "@flagship/protocol";
import { isReservedName, validateUserLabel } from "./labels.js";
import { orgPlanGate } from "./orgPlan.js";
import { conflict, forbidden, malformed, notFound, ok, type HandlerResponseWithHeaders } from "./types.js";

/**
 * Enterprise org accounts on `.com` (docs/enterprise-accounts.md §6, §7, §11, §15; phase E2).
 *
 * `.com` is never trusted for org authority: it stores only objects that verify against the org's
 * chain (from the genesis hash it recorded at creation), and boxes and phones verify them again.
 * Routes (all JSON):
 *
 *   POST /api/orgs                                  { name, entry }            create (genesis)
 *   GET  /api/orgs/:orgId/authority                                            chain + freezes/overturns/vetoes
 *   POST /api/orgs/:orgId/authority                 { entry }                  append a version
 *   POST /api/orgs/:orgId/invites                   { invite, roles, approvals, sealedLabelHex, offerHex }
 *   GET  /api/orgs/:orgId/invites/:seatId                                      the sealed offer (link fragment opens it)
 *   POST /api/orgs/:orgId/invites/:seatId/accept    { accept, memberBinding, adminBinding, signature }
 *   GET  /api/orgs/:orgId/seats                                                grants, revokes, freezes, overturns, accepts
 *   POST /api/orgs/:orgId/seats                     grant bundle               admit or change a seat
 *   POST /api/orgs/:orgId/revokes | freezes | overturns | vetoes
 *   GET/POST /api/orgs/:orgId/ceremonies            { order, payload, approvals }   the approvals inbox
 *   POST /api/orgs/:orgId/ceremonies/:sha/approvals { approval }
 *   GET  /api/orgs/:orgId/log                                                  the org's audit hash chain
 *   GET  /api/orgs/:orgId/directory                                            sealed directory entries
 *   POST /api/orgs/:orgId/directory              { entry, approvals }          store or replace one (one org admin)
 *   GET  /api/orgs/:orgId/directory/slices                                     members' sealed slices
 *   POST /api/orgs/:orgId/directory/slices       { slice, approvals }          store a seat's slice (one org admin)
 *
 * An accept may carry the joining seat's KEM statement (`seatKem`, signed by the member key it
 * accepts with); `.com` keeps it with the accept and records it as the seat's KEM key when the grant
 * lands, so a member receives key-ring versions without opening the org page first.
 *
 * The orgId (128 random bits) is the read capability for the GET routes; nothing they return is
 * secret (labels are sealed, keys are public), but it does show the org's structure.
 */
export interface OrgDeps {
  orgs: OrgStorage;
  usernames: UsernameStorage;
  now?: () => number;
  /** The seat limit for a new org's trial (null = none); default `business.trialSeats`. */
  trialSeatLimit?: number | null;
  /** The payment numbers (`PAYMENTS_CONFIG`); the Business plan's trial, seats and prices come from here. */
  payments?: PaymentsConfig;
}

const ORG_ID = /^[0-9a-f]{32}$/;
const SEAT_ID = /^[0-9a-f]{32}$/;
const SHA = /^[0-9a-f]{64}$/;
const MAX_SEALED_HEX = 2 * 4096;
const MAX_OFFER_HEX = 2 * 65536;
const MAX_CEREMONY_JSON = 256 * 1024;
const STRICT: PolicyState = {
  scope: { kind: "installation", id: "org" },
  profile: "strict",
  rollout: "enforced",
  generation: 1,
  headDigest: "0".repeat(128),
  enforcedEver: true,
};

const nowOf = (d: OrgDeps) => (d.now ?? (() => Date.now()))();
const refuse = (e: unknown): HandlerResponseWithHeaders => {
  if (e instanceof OrgAuthorityError) return { status: 403, body: { error: e.message, code: `org-${e.code}` } };
  return malformed(e instanceof Error ? e.message : "malformed");
};
const pad = (v: number) => String(v).padStart(10, "0");
const parse = <T>(json: string): T => JSON.parse(json) as T;

export interface OrgView {
  org: OrgRecord;
  entries: OrgAuthorityEntry[];
  freezes: OrgSigned<OrgSeatFreeze>[];
  overturns: OrgSigned<OrgOverturn>[];
  vetoes: OrgSigned<OrgVeto>[];
  grants: OrgSeatGrantBundle[];
  revokes: OrgSeatRevokeBundle[];
  state: OrgAuthorityState;
  book: OrgSeatBook;
}

async function list<T>(deps: OrgDeps, orgId: string, kind: OrgObjectKind): Promise<T[]> {
  return (await deps.orgs.listObjects(orgId, kind)).map((o) => parse<T>(o.bodyJson));
}

/** The org as `.com` holds it, every object re-verified from the recorded genesis. */
export async function loadOrg(deps: OrgDeps, orgId: string, now: number): Promise<OrgView | null> {
  const org = await deps.orgs.getOrg(orgId);
  if (!org) return null;
  const entries = (await deps.orgs.listObjects(orgId, "authority")).sort((a, b) => (a.key < b.key ? -1 : 1)).map((o) => parse<OrgAuthorityEntry>(o.bodyJson));
  const [freezes, overturns, vetoes, grants, revokes] = await Promise.all([
    list<OrgSigned<OrgSeatFreeze>>(deps, orgId, "freeze"),
    list<OrgSigned<OrgOverturn>>(deps, orgId, "overturn"),
    list<OrgSigned<OrgVeto>>(deps, orgId, "veto"),
    list<OrgSeatGrantBundle>(deps, orgId, "grant"),
    list<OrgSeatRevokeBundle>(deps, orgId, "revoke"),
  ]);
  const state = verifyOrgAuthorityChain(entries, { genesisHash: org.genesisHash, now, freezes, overturns, vetoes });
  const book = buildOrgSeatBook(state, { grants, revokes, freezes, overturns, now });
  return { org, entries, freezes, overturns, vetoes, grants, revokes, state, book };
}

async function logged(deps: OrgDeps, orgId: string, kind: string, ref: string, now: number) {
  return deps.orgs.appendLog(orgId, kind, ref, now);
}

/**
 * Authorizes an org order on `.com` (the gate for routes it serves on the org's behalf, e.g. adding
 * a server): the same predicate the boxes run, over the chain `.com` re-verifies here.
 */
export async function authorizeOrgComOp(
  deps: OrgDeps,
  orgId: string,
  action: OrgAction,
  order: Uint8Array,
  approvals: unknown,
): Promise<{ ok: true; signers: string[]; scopedSeat: string | null } | { ok: false; code: string }> {
  const now = nowOf(deps);
  try {
    const v = await loadOrg(deps, orgId, now);
    if (!v) return { ok: false, code: "org-not-found" };
    if (!Array.isArray(approvals)) return { ok: false, code: "org-malformed" };
    const r = authorizeOrgOrder({ state: v.state, book: v.book, action, order, approvals: approvals.map(orgApprovalFromWire), now });
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, code: e instanceof OrgAuthorityError ? `org-${e.code}` : "org-malformed" };
  }
}

export async function handleOrgCreate(deps: OrgDeps, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const b = body as { name?: unknown; entry?: OrgAuthorityEntry } | undefined;
  if (typeof b?.name !== "string" || !b.entry) return malformed("name and entry required");
  const v = validateUserLabel(b.name);
  if (!v.ok) return malformed(v.reason);
  if (isReservedName(v.label) || (await deps.usernames.get(v.label)) || (await deps.orgs.getOrgByName(v.label))) {
    // One namespace with usernames (`<server>.<name>.<apex>`): the apps write the sentence from the code.
    return { status: 409, body: { error: "taken or too similar to an existing name", code: "taken" } };
  }
  let genesisHash: string;
  try {
    genesisHash = orgAuthorityHash(b.entry.record);
    verifyOrgAuthorityChain([b.entry], { genesisHash, now });
  } catch (e) {
    return refuse(e);
  }
  const orgId = b.entry.record.orgId;
  const trial = orgTrialTerms(deps.payments ?? DEFAULT_PAYMENTS_CONFIG, now);
  const created = await deps.orgs.createOrg({
    orgId,
    name: v.label,
    genesisHash,
    planTier: "business",
    seatLimit: deps.trialSeatLimit === undefined ? trial.trialSeats : deps.trialSeatLimit,
    paidUntil: null,
    createdAt: now,
    trialEndsAt: trial.trialEndsAt,
    paidSeats: 0,
  });
  if (!created) return conflict("org id or name taken");
  await deps.orgs.putObject(orgId, { kind: "authority", key: pad(0), bodyJson: JSON.stringify(b.entry), issuedAt: b.entry.record.issuedAt, storedAt: now });
  await logged(deps, orgId, "authority", genesisHash, now);
  return ok({ orgId, name: v.label, genesisHash });
}

export async function handleOrgAuthorityGet(deps: OrgDeps, orgId: string): Promise<HandlerResponseWithHeaders> {
  if (!ORG_ID.test(orgId)) return malformed("orgId");
  try {
    const v = await loadOrg(deps, orgId, nowOf(deps));
    if (!v) return notFound("org not found");
    return ok({
      org: { orgId, name: v.org.name, genesisHash: v.org.genesisHash, planTier: v.org.planTier, seatLimit: v.org.seatLimit, paidUntil: v.org.paidUntil },
      entries: v.entries,
      freezes: v.freezes,
      overturns: v.overturns,
      vetoes: v.vetoes,
      currentVersion: v.state.current.version,
      currentHash: v.state.currentHash,
    });
  } catch (e) {
    return refuse(e);
  }
}

export async function handleOrgAuthorityAppend(deps: OrgDeps, orgId: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const entry = (body as { entry?: OrgAuthorityEntry } | undefined)?.entry;
  if (!entry?.record) return malformed("entry required");
  try {
    const v = await loadOrg(deps, orgId, now);
    if (!v) return notFound("org not found");
    const st = verifyOrgAuthorityChain([...v.entries, entry], { genesisHash: v.org.genesisHash, now, freezes: v.freezes, overturns: v.overturns, vetoes: v.vetoes });
    // A lapsed org may remove, freeze, recover and overturn, but adds no new admin (docs/plans-and-backup-offer.md §3.4).
    if (entry.via === "direct" && st.current.admins.some((a) => !v.state.records.some((r) => r.admins.some((x) => x.seatId === a.seatId)))) {
      const gate = orgPlanGate(deps.payments ?? DEFAULT_PAYMENTS_CONFIG, v.org, now, "add-admin");
      if (gate) return { status: 403, body: { error: gate, code: gate } };
    }
    const version = st.current.version;
    const stored = await deps.orgs.putObject(orgId, { kind: "authority", key: pad(version), bodyJson: JSON.stringify(entry), issuedAt: entry.record.issuedAt, storedAt: now });
    if (!stored) return conflict("version already recorded");
    await logged(deps, orgId, `authority-${entry.via}`, st.currentHash, now);
    await deps.orgs.deleteObject(orgId, "ceremony", orgSha256Hex(canonicalOrgAuthority(entry.record)));
    return ok({ version, hash: st.currentHash });
  } catch (e) {
    return refuse(e);
  }
}

/** Seats that count toward the plan's limit: live grants not revoked. */
function liveSeats(v: OrgView): number {
  return [...v.book.seats.keys()].filter((s) => !v.book.revoked.has(s)).length;
}

/** The Business plan's gate for a seat change (orgPlan.ts orgPlanGate): new seats and role raises need a live plan. */
function planGate(deps: OrgDeps, v: OrgView, now: number, seatId: string, roles: readonly OrgSeatRole[]): string | null {
  const cfg = deps.payments ?? DEFAULT_PAYMENTS_CONFIG;
  const isNew = !v.book.seats.has(seatId);
  if (isNew) return orgPlanGate(cfg, v.org, now, "new-seat", liveSeats(v));
  if (orgRolesRaiseAdmin(roles)) return orgPlanGate(cfg, v.org, now, "raise-role");
  return null;
}

export async function handleOrgInviteCreate(deps: OrgDeps, orgId: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const b = body as { invite?: OrgSeatInvite; roles?: OrgSeatRole[]; approvals?: unknown[]; sealedLabelHex?: unknown; offerHex?: unknown } | undefined;
  if (!b?.invite || !Array.isArray(b.roles) || !Array.isArray(b.approvals)) return malformed("invite, roles and approvals required");
  if (typeof b.sealedLabelHex !== "string" || !/^(?:[0-9a-f]{2})+$/.test(b.sealedLabelHex) || b.sealedLabelHex.length > MAX_SEALED_HEX) {
    return { status: 400, body: { error: "a pseudonym is required before the invitation exists", code: "org-label-missing" } };
  }
  if (typeof b.offerHex !== "string" || !/^(?:[0-9a-f]{2})+$/.test(b.offerHex) || b.offerHex.length > MAX_OFFER_HEX) return malformed("offerHex");
  try {
    const order = canonicalOrgSeatInvite(b.invite);
    if (orgSha256Hex(hexBytes(b.sealedLabelHex)) !== b.invite.labelSha256) return malformed("labelSha256 does not match the sealed label");
    if (orgSeatRolesHash(b.roles) !== b.invite.rolesHash) return malformed("rolesHash");
    if (b.invite.orgId !== orgId || b.invite.expiresAt <= now) return malformed("invite");
    const v = await loadOrg(deps, orgId, now);
    if (!v) return notFound("org not found");
    if (v.book.revoked.has(b.invite.seatId) || v.book.seats.has(b.invite.seatId)) return conflict("seat exists");
    const gate = planGate(deps, v, now, b.invite.seatId, b.roles);
    if (gate) return { status: 403, body: { error: gate, code: gate } };
    authorizeOrgOrder({ state: v.state, book: v.book, action: { kind: "seat-invite" }, order, approvals: b.approvals.map(orgApprovalFromWire), now });
    const stored = await deps.orgs.putObject(orgId, {
      kind: "invite",
      key: b.invite.seatId,
      bodyJson: JSON.stringify({ invite: b.invite, roles: b.roles, approvals: b.approvals, sealedLabelHex: b.sealedLabelHex, offerHex: b.offerHex }),
      issuedAt: b.invite.issuedAt,
      storedAt: now,
    });
    if (!stored) return conflict("invite exists");
    await logged(deps, orgId, "invite", orgSha256Hex(order), now);
    return ok({ seatId: b.invite.seatId, inviteSha256: orgSha256Hex(order) });
  } catch (e) {
    return refuse(e);
  }
}

export async function handleOrgInviteGet(deps: OrgDeps, orgId: string, seatId: string): Promise<HandlerResponseWithHeaders> {
  if (!ORG_ID.test(orgId) || !SEAT_ID.test(seatId)) return malformed("ids");
  const o = await deps.orgs.getObject(orgId, "invite", seatId);
  if (!o) return notFound("invite not found");
  const inv = parse<{ invite: OrgSeatInvite; offerHex: string; roles: OrgSeatRole[] }>(o.bodyJson);
  if (inv.invite.expiresAt <= nowOf(deps)) return { status: 410, body: { error: "invite expired", code: "org-invite-expired" } };
  const accepted = await deps.orgs.getObject(orgId, "accept", seatId);
  return ok({ invite: inv.invite, roles: inv.roles, offerHex: inv.offerHex, accepted: accepted !== null });
}

export async function handleOrgInviteAccept(deps: OrgDeps, orgId: string, seatId: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const b = body as {
    accept?: { orgId: string; seatId: string; inviteSha256: string; memberKeyId: string; adminKeyId: string; issuedAt: number; custody?: "hardware" | "browser" };
    memberBinding?: unknown;
    adminBinding?: unknown;
    signature?: unknown;
    seatKem?: OrgSeatKemBundle;
  } | undefined;
  if (!b?.accept || typeof b.signature !== "string") return malformed("accept and signature required");
  const o = await deps.orgs.getObject(orgId, "invite", seatId);
  if (!o) return notFound("invite not found");
  const inv = parse<{ invite: OrgSeatInvite }>(o.bodyJson);
  if (inv.invite.expiresAt <= now) return { status: 410, body: { error: "invite expired", code: "org-invite-expired" } };
  try {
    const a = b.accept;
    const msg = canonicalOrgSeatAccept(a);
    if (a.orgId !== orgId || a.seatId !== seatId || a.inviteSha256 !== orgSha256Hex(canonicalOrgSeatInvite(inv.invite))) return malformed("accept does not name this invite");
    if (Math.abs(now - a.issuedAt) > 10 * 60_000) return malformed("stale accept");
    const subject = orgSeatSubject(orgId, seatId);
    const mw = pqKeyBindingFromWire(b.memberBinding);
    const member = verifyPqKeyBinding(mw, { role: "org-seat-member", subjectId: subject, ed25519PubHex: mw.ed25519PubHex, now });
    if (orgKeyIdHex(mw) !== a.memberKeyId) return malformed("memberKeyId");
    if (a.adminKeyId !== "") {
      const aw = pqKeyBindingFromWire(b.adminBinding);
      verifyPqKeyBinding(aw, { role: "org-seat-admin", subjectId: subject, ed25519PubHex: aw.ed25519PubHex, now });
      if (orgKeyIdHex(aw) !== a.adminKeyId) return malformed("adminKeyId");
    }
    verifyCriticalSignature({
      message: msg,
      expectedPurpose: "flagship/org-seat-accept/v1",
      envelope: { suite: "hybrid-ed25519-mldsa65/v1", signature: b.signature },
      signerEd25519PubHex: member.ed25519PubHex,
      binding: member,
      policy: STRICT,
    });
    if (b.seatKem !== undefined) checkJoinSeatKem(b.seatKem, member, orgId, seatId, now);
    const stored = await deps.orgs.putObject(orgId, {
      kind: "accept",
      key: seatId,
      bodyJson: JSON.stringify({ accept: a, memberBinding: b.memberBinding, adminBinding: b.adminBinding ?? null, signature: b.signature, seatKem: b.seatKem ?? null }),
      issuedAt: a.issuedAt,
      storedAt: now,
    });
    if (!stored) return conflict("already accepted");
    await logged(deps, orgId, "accept", orgSha256Hex(msg), now);
    return ok({ accepted: true });
  } catch (e) {
    if (e instanceof PqTrustError) return { status: 403, body: { error: e.message, code: "org-binding" } };
    return refuse(e);
  }
}

export async function handleOrgSeatsGet(deps: OrgDeps, orgId: string): Promise<HandlerResponseWithHeaders> {
  if (!ORG_ID.test(orgId)) return malformed("orgId");
  const org = await deps.orgs.getOrg(orgId);
  if (!org) return notFound("org not found");
  const [grants, revokes, freezes, overturns, accepts, invites] = await Promise.all([
    list(deps, orgId, "grant"),
    list(deps, orgId, "revoke"),
    list(deps, orgId, "freeze"),
    list(deps, orgId, "overturn"),
    list(deps, orgId, "accept"),
    list<{ invite: OrgSeatInvite; roles: OrgSeatRole[]; approvals?: unknown[]; sealedLabelHex: string }>(deps, orgId, "invite"),
  ]);
  // The approvals travel with each invite: a connector box links a directory person to a seat only on an invite
  // it verified itself (05c review F3).
  return ok({ grants, revokes, freezes, overturns, accepts, invites: invites.map((i) => ({ invite: i.invite, roles: i.roles, approvals: i.approvals ?? [], sealedLabelHex: i.sealedLabelHex })) });
}

export async function handleOrgSeatGrant(deps: OrgDeps, orgId: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const g = body as OrgSeatGrantBundle | undefined;
  if (!g?.grant || !Array.isArray(g.roles) || !Array.isArray(g.approvals)) return malformed("grant bundle required");
  try {
    const v = await loadOrg(deps, orgId, now);
    if (!v) return notFound("org not found");
    if (v.book.revoked.has(g.grant.seatId)) return { status: 403, body: { error: "seat revoked", code: "org-seat-revoked" } };
    const gate = planGate(deps, v, now, g.grant.seatId, g.roles);
    if (gate) return { status: 403, body: { error: gate, code: gate } };
    const invite = await deps.orgs.getObject(orgId, "invite", g.grant.seatId);
    if (!v.book.seats.has(g.grant.seatId)) {
      if (!invite) return { status: 403, body: { error: "a new seat starts with an invite", code: "org-no-invite" } };
      const inv = parse<{ invite: OrgSeatInvite }>(invite.bodyJson);
      if (inv.invite.labelSha256 !== g.grant.labelSha256) return malformed("the grant's pseudonym differs from the invite's");
      const acc = await deps.orgs.getObject(orgId, "accept", g.grant.seatId);
      if (!acc) return { status: 403, body: { error: "the person has not accepted yet", code: "org-not-accepted" } };
      const a = parse<{ accept: { memberKeyId: string; adminKeyId: string; custody?: string } }>(acc.bodyJson).accept;
      if (a.memberKeyId !== g.grant.memberKeyId || a.adminKeyId !== g.grant.adminKeyId) return malformed("the grant's keys differ from the accepted ones");
      // The custody the person's accept signed is the custody the grant shows (docs/webapp-key-custody.md item 1).
      if ((a.custody ?? "hardware") !== (g.grant.custody ?? "hardware")) return malformed("the grant's custody differs from the accepted one");
    }
    const frozen = (s: string, t: number) => v.book.freezes.some((f) => f.seatId === s && f.issuedAt <= t && t < f.untilMs);
    verifyOrgSeatGrant(v.state, g, frozen, now);
    const order = canonicalOrgSeatGrant(g.grant);
    await deps.orgs.putObject(orgId, { kind: "grant", key: `${g.grant.seatId}:${pad(g.grant.issuedAt)}`, bodyJson: JSON.stringify(g), issuedAt: g.grant.issuedAt, storedAt: now });
    await logged(deps, orgId, "grant", orgSha256Hex(order), now);
    await deps.orgs.deleteObject(orgId, "ceremony", orgSha256Hex(order));
    await recordJoinSeatKem(deps, v, g, now);
    return ok({ seatId: g.grant.seatId });
  } catch (e) {
    return refuse(e);
  }
}

export async function handleOrgRevoke(deps: OrgDeps, orgId: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const r = body as OrgSeatRevokeBundle | undefined;
  if (!r?.revoke) return malformed("revoke required");
  try {
    const v = await loadOrg(deps, orgId, now);
    if (!v) return notFound("org not found");
    const book = buildOrgSeatBook(v.state, { grants: v.grants, revokes: [r], now });
    if (!book.revoked.has(r.revoke.seatId)) return { status: 403, body: { error: "revoke refused", code: `org-${book.refused.find((x) => x.seatId === r.revoke.seatId)?.code ?? "malformed"}` } };
    const order = canonicalOrgSeatRevoke(r.revoke);
    await deps.orgs.putObject(orgId, { kind: "revoke", key: r.revoke.seatId, bodyJson: JSON.stringify(r), issuedAt: r.revoke.issuedAt, storedAt: now });
    await logged(deps, orgId, r.selfSignature ? "leave" : "revoke", orgSha256Hex(order), now);
    return ok({ revoked: r.revoke.seatId });
  } catch (e) {
    return refuse(e);
  }
}

export async function handleOrgFreeze(deps: OrgDeps, orgId: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const f = body as OrgSigned<OrgSeatFreeze> | undefined;
  if (!f?.body || !Array.isArray(f.approvals)) return malformed("freeze required");
  try {
    const order = canonicalOrgSeatFreeze(f.body);
    const sha = orgSha256Hex(order);
    const v = await loadOrg(deps, orgId, now);
    if (!v) return notFound("org not found");
    const all = verifiedOrgFreezes(v.state, { freezes: [...v.freezes, f], overturns: v.overturns, now });
    if (!all.some((x) => x.sha256 === sha)) {
      return { status: 403, body: { error: "freeze refused: one admin, at most 72 hours, once a week", code: "org-freeze-refused" } };
    }
    await deps.orgs.putObject(orgId, { kind: "freeze", key: sha, bodyJson: JSON.stringify(f), issuedAt: f.body.issuedAt, storedAt: now });
    await logged(deps, orgId, "freeze", sha, now);
    return ok({ frozen: f.body.seatId, untilMs: f.body.untilMs });
  } catch (e) {
    return refuse(e);
  }
}

export async function handleOrgOverturn(deps: OrgDeps, orgId: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const o = body as OrgSigned<OrgOverturn> | undefined;
  if (!o?.body || !Array.isArray(o.approvals)) return malformed("overturn required");
  try {
    const sha = orgSha256Hex(canonicalOrgOverturn(o.body));
    const v = await loadOrg(deps, orgId, now);
    if (!v) return notFound("org not found");
    const before = verifiedOrgFreezes(v.state, { freezes: v.freezes, overturns: v.overturns, now });
    const after = verifiedOrgFreezes(v.state, { freezes: v.freezes, overturns: [...v.overturns, o], now });
    if (!before.some((x) => x.sha256 === o.body.freezeSha256) || after.some((x) => x.sha256 === o.body.freezeSha256)) {
      return { status: 403, body: { error: "the bylaws' signers have not all approved yet", code: "org-overturn-refused" } };
    }
    await deps.orgs.putObject(orgId, { kind: "overturn", key: sha, bodyJson: JSON.stringify(o), issuedAt: o.body.issuedAt, storedAt: now });
    await logged(deps, orgId, "overturn", sha, now);
    await deps.orgs.deleteObject(orgId, "ceremony", sha);
    return ok({ overturned: o.body.freezeSha256 });
  } catch (e) {
    return refuse(e);
  }
}

export async function handleOrgVeto(deps: OrgDeps, orgId: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const x = body as OrgSigned<OrgVeto> | undefined;
  if (!x?.body || !Array.isArray(x.approvals)) return malformed("veto required");
  try {
    const order = canonicalOrgVeto(x.body);
    const v = await loadOrg(deps, orgId, now);
    if (!v) return notFound("org not found");
    verifyOrgApprovers(v.state, v.book, order, x.approvals.map(orgApprovalFromWire), now);
    const sha = orgSha256Hex(order);
    await deps.orgs.putObject(orgId, { kind: "veto", key: `${sha}:${x.approvals.map((a) => (a as OrgApproval).seatId).sort().join(",")}`, bodyJson: JSON.stringify(x), issuedAt: x.body.issuedAt, storedAt: now });
    await logged(deps, orgId, "veto", sha, now);
    return ok({ vetoed: x.body.noticeSha256 });
  } catch (e) {
    return refuse(e);
  }
}

interface Ceremony {
  sha256: string;
  order: string;
  payload: unknown;
  approvals: OrgApproval[];
  openedAt: number;
}

/** Opens a ceremony: the order's text, what it is about (`payload`) and the proposer's approval. */
export async function handleOrgCeremonyOpen(deps: OrgDeps, orgId: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const b = body as { order?: unknown; payload?: unknown; approvals?: unknown[] } | undefined;
  if (typeof b?.order !== "string" || !Array.isArray(b.approvals) || b.approvals.length !== 1) return malformed("order and one approval required");
  const json = JSON.stringify(b.payload ?? null);
  if (json.length > MAX_CEREMONY_JSON || b.order.length > MAX_CEREMONY_JSON) return malformed("ceremony too large");
  try {
    const order = new TextEncoder().encode(b.order);
    const v = await loadOrg(deps, orgId, now);
    if (!v) return notFound("org not found");
    const approvals = b.approvals.map(orgApprovalFromWire);
    // "Restore my access": the frozen seat itself may open the overturn of its own freeze (§ owner decisions).
    const parts = b.order.split("|");
    const own = parts[0] === "flagship/org-overturn/v1" ? v.book.freezes.find((f) => f.sha256 === parts[2])?.seatId : undefined;
    verifyOrgApprovers(v.state, v.book, order, approvals, now, own ? { allowFrozenSeat: own } : {});
    const sha = orgSha256Hex(order);
    const c: Ceremony = { sha256: sha, order: b.order, payload: b.payload ?? null, approvals, openedAt: now };
    const stored = await deps.orgs.putObject(orgId, { kind: "ceremony", key: sha, bodyJson: JSON.stringify(c), issuedAt: now, storedAt: now });
    if (!stored) return conflict("ceremony open");
    await logged(deps, orgId, "ceremony-open", sha, now);
    return ok({ sha256: sha });
  } catch (e) {
    return refuse(e);
  }
}

export async function handleOrgCeremonyApprove(deps: OrgDeps, orgId: string, sha: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  if (!SHA.test(sha)) return malformed("sha");
  const raw = (body as { approval?: unknown } | undefined)?.approval;
  try {
    const o = await deps.orgs.getObject(orgId, "ceremony", sha);
    if (!o) return notFound("no such ceremony");
    const c = parse<Ceremony>(o.bodyJson);
    const a = orgApprovalFromWire(raw);
    const v = await loadOrg(deps, orgId, now);
    if (!v) return notFound("org not found");
    if (c.approvals.some((x) => x.seatId === a.seatId)) return conflict("already approved");
    verifyOrgApprovers(v.state, v.book, new TextEncoder().encode(c.order), [a], now);
    c.approvals.push(a);
    await deps.orgs.putObject(orgId, { kind: "ceremony", key: sha, bodyJson: JSON.stringify(c), issuedAt: o.issuedAt, storedAt: now }, true);
    await logged(deps, orgId, "ceremony-approve", sha, now);
    return ok({ sha256: sha, approvals: c.approvals.length });
  } catch (e) {
    return refuse(e);
  }
}

export async function handleOrgCeremonies(deps: OrgDeps, orgId: string): Promise<HandlerResponseWithHeaders> {
  if (!ORG_ID.test(orgId)) return malformed("orgId");
  return ok({ ceremonies: await list<Ceremony>(deps, orgId, "ceremony") });
}

export async function handleOrgLog(deps: OrgDeps, orgId: string, after: number): Promise<HandlerResponseWithHeaders> {
  if (!ORG_ID.test(orgId)) return malformed("orgId");
  if (!(await deps.orgs.getOrg(orgId))) return notFound("org not found");
  return ok({ entries: await deps.orgs.listLog(orgId, Number.isSafeInteger(after) && after > 0 ? after : 0) });
}

/** The KEM statement a joining seat sends with its accept: signed by the member key it accepts with. */
function checkJoinSeatKem(k: OrgSeatKemBundle, member: ReturnType<typeof verifyPqKeyBinding>, orgId: string, seatId: string, now: number): void {
  if (!k?.statement || k.statement.orgId !== orgId || k.statement.seatId !== seatId) throw new OrgAuthorityError("malformed", "seatKem");
  if (Math.abs(now - k.statement.issuedAt) > 10 * 60_000) throw new OrgAuthorityError("malformed", "stale seatKem");
  if (typeof k.kemPubHex !== "string" || !/^(?:[0-9a-f]{2})+$/.test(k.kemPubHex) || orgKemKeyIdHex(hexBytes(k.kemPubHex)) !== k.statement.kemKeyId) {
    throw new OrgAuthorityError("binding", "kem key id");
  }
  verifyCriticalSignature({
    message: canonicalOrgSeatKem(k.statement),
    expectedPurpose: "flagship/org-seat-kem/v1",
    envelope: { suite: "hybrid-ed25519-mldsa65/v1", signature: String(k.signature ?? "") },
    signerEd25519PubHex: member.ed25519PubHex,
    binding: member,
    policy: STRICT,
  });
}

/**
 * When a new seat's grant lands, its join-time KEM statement (kept with the accept) becomes its KEM
 * key, verified against the book with the grant in it. A newer statement the seat posted itself wins.
 */
async function recordJoinSeatKem(deps: OrgDeps, v: OrgView, g: OrgSeatGrantBundle, now: number): Promise<void> {
  const seatId = g.grant.seatId;
  const acc = await deps.orgs.getObject(v.org.orgId, "accept", seatId);
  const k = acc ? parse<{ seatKem?: OrgSeatKemBundle | null }>(acc.bodyJson).seatKem : null;
  if (!k) return;
  const have = await deps.orgs.getObject(v.org.orgId, "seat-kem", seatId);
  if (have && have.issuedAt >= k.statement.issuedAt) return;
  try {
    const book = buildOrgSeatBook(v.state, { grants: [...v.grants, g], revokes: v.revokes, freezes: v.freezes, overturns: v.overturns, now });
    verifyOrgSeatKem(v.state, book, k, now);
  } catch {
    return;
  }
  await deps.orgs.putObject(v.org.orgId, { kind: "seat-kem", key: seatId, bodyJson: JSON.stringify(k), issuedAt: k.statement.issuedAt, storedAt: now }, true);
}

const MAX_DIRECTORY_ENTRIES = 20_000;

export async function handleOrgDirectoryGet(deps: OrgDeps, orgId: string): Promise<HandlerResponseWithHeaders> {
  if (!ORG_ID.test(orgId)) return malformed("orgId");
  if (!(await deps.orgs.getOrg(orgId))) return notFound("org not found");
  const entries = await list<{ entry: OrgDirectorySealed }>(deps, orgId, "directory");
  return ok({ entries: entries.map((e) => e.entry) });
}

/**
 * Stores or replaces one sealed directory entry, approved by one org admin over its write form.
 * `.com` sees the org, an opaque entry id, the key version and the size bucket, never a name.
 */
export async function handleOrgDirectoryPut(deps: OrgDeps, orgId: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const b = body as { entry?: OrgDirectorySealed; approvals?: unknown[] } | undefined;
  if (!b?.entry || !Array.isArray(b.approvals)) return malformed("entry and approvals required");
  try {
    const e = b.entry;
    const order = canonicalOrgDirectoryWrite(e);
    if (e.orgId !== orgId) return malformed("orgId");
    if (Math.abs(now - e.issuedAt) > 10 * 60_000) return malformed("stale entry");
    const v = await loadOrg(deps, orgId, now);
    if (!v) return notFound("org not found");
    authorizeOrgOrder({ state: v.state, book: v.book, action: { kind: "seat-invite" }, order, approvals: b.approvals.map(orgApprovalFromWire), now });
    const prev = await deps.orgs.getObject(orgId, "directory", e.entryId);
    if (prev && prev.issuedAt >= e.issuedAt) return conflict("older than the entry kept");
    if (!prev && (await deps.orgs.listObjects(orgId, "directory")).length >= MAX_DIRECTORY_ENTRIES) return forbidden("directory full");
    const clean: OrgDirectorySealed = { orgId, entryId: e.entryId, keyVersion: e.keyVersion, sizeBucket: e.sizeBucket, sealedHex: e.sealedHex, issuedAt: e.issuedAt };
    await deps.orgs.putObject(orgId, { kind: "directory", key: e.entryId, bodyJson: JSON.stringify({ entry: clean, approvals: b.approvals }), issuedAt: e.issuedAt, storedAt: now }, true);
    await logged(deps, orgId, "directory", orgSha256Hex(order), now);
    return ok({ entryId: e.entryId });
  } catch (e) {
    if (e instanceof PqTrustError) return { status: 403, body: { error: e.message, code: "org-binding" } };
    return refuse(e);
  }
}

export async function handleOrgDirectorySlicesGet(deps: OrgDeps, orgId: string): Promise<HandlerResponseWithHeaders> {
  if (!ORG_ID.test(orgId)) return malformed("orgId");
  if (!(await deps.orgs.getOrg(orgId))) return notFound("org not found");
  // The approvals travel too: a member checks that an org admin sealed its slice (anyone can seal to a public key).
  return ok({ slices: await list<{ slice: OrgDirectorySlice; approvals: unknown[] }>(deps, orgId, "directory-slice") });
}

/**
 * Stores a member's slice of the directory (sealed to the seat's KEM key), approved by one org admin.
 * The seat must be live and the slice sealed to the KEM key it announced.
 */
export async function handleOrgDirectorySlicePut(deps: OrgDeps, orgId: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const b = body as { slice?: OrgDirectorySlice; approvals?: unknown[] } | undefined;
  if (!b?.slice || !Array.isArray(b.approvals)) return malformed("slice and approvals required");
  try {
    const s = b.slice;
    const order = canonicalOrgDirectorySliceWrite(s);
    if (s.orgId !== orgId) return malformed("orgId");
    if (Math.abs(now - s.issuedAt) > 10 * 60_000) return malformed("stale slice");
    const v = await loadOrg(deps, orgId, now);
    if (!v) return notFound("org not found");
    const seat = v.book.seats.get(s.seatId);
    if (!seat || v.book.revoked.has(s.seatId) || seat.grant.expiresAt <= now) return { status: 403, body: { error: "not a live seat", code: "org-seat-unknown" } };
    const kem = await deps.orgs.getObject(orgId, "seat-kem", s.seatId);
    if (!kem || parse<OrgSeatKemBundle>(kem.bodyJson).statement.kemKeyId !== s.kemKeyId) return { status: 403, body: { error: "not the seat's KEM key", code: "org-binding" } };
    authorizeOrgOrder({ state: v.state, book: v.book, action: { kind: "seat-invite" }, order, approvals: b.approvals.map(orgApprovalFromWire), now });
    const prev = await deps.orgs.getObject(orgId, "directory-slice", s.seatId);
    if (prev && prev.issuedAt >= s.issuedAt) return conflict("older than the slice kept");
    const clean: OrgDirectorySlice = { orgId, seatId: s.seatId, kemKeyId: s.kemKeyId, tagKeyVersion: s.tagKeyVersion, contentTag: s.contentTag, sealedHex: s.sealedHex, issuedAt: s.issuedAt };
    await deps.orgs.putObject(orgId, { kind: "directory-slice", key: s.seatId, bodyJson: JSON.stringify({ slice: clean, approvals: b.approvals }), issuedAt: s.issuedAt, storedAt: now }, true);
    await logged(deps, orgId, "directory-slice", orgSha256Hex(order), now);
    return ok({ seatId: s.seatId });
  } catch (e) {
    if (e instanceof PqTrustError) return { status: 403, body: { error: e.message, code: "org-binding" } };
    return refuse(e);
  }
}

function hexBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
