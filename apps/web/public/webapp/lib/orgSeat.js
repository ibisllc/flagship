// The webapp as an org seat (docs/webapp-key-custody.md item 1; docs/enterprise-accounts.md §7).
//
// Join: the member key is derived from the account key per org (as on the phones), an admin role
// also gets a fresh random seat admin key sealed under this browser's passkey (lib/keyCustody.js,
// custody "browser", signed into the accept), and the seat's X-Wing key rides with the accept. Both
// sides then compare the 6-digit code. As an admin seat the browser approves ceremonies, admits
// people, rotates keys and reads the directory; every admin signature opens the seat admin key for
// that one action. The protocol itself is the bundled packages/protocol code (vendor/flagship-org).

import * as org from "../vendor/flagship-org/org.js";
import { controlApex } from "./apex.js";
import { activeProfileId } from "../keystore.js";
import { openUnderPasskey, sealUnderPasskey } from "./keyCustody.js";
import { getSession } from "./state.js";
import { orgReadPathOrg, orgReadToken } from "./orgReadToken.js";

const enc = new TextEncoder();
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h) => Uint8Array.from(String(h).match(/../g) ?? [], (x) => parseInt(x, 16));
const STORE = "flagship.orgSeats.v1";
const DAY = 86_400_000;

function fail(code, message = code) {
  return Object.assign(new Error(message), { code });
}

/* ---------- the seats this browser holds ---------- */

function storeKey(profileId = activeProfileId()) {
  return `${STORE}.${profileId}`;
}

export function listSeats(storage = globalThis.localStorage) {
  try {
    const v = JSON.parse(storage?.getItem(storeKey()) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function rememberSeat(seat, storage = globalThis.localStorage) {
  const rest = listSeats(storage).filter((s) => !(s.orgId === seat.orgId && s.seatId === seat.seatId));
  storage?.setItem(storeKey(), JSON.stringify([...rest, seat]));
}

export function forgetSeat(orgId, seatId, storage = globalThis.localStorage) {
  storage?.setItem(storeKey(), JSON.stringify(listSeats(storage).filter((s) => !(s.orgId === orgId && s.seatId === seatId))));
}

const adminRecordKey = (orgId, seatId) => `flagship.orgSeatAdmin.v1.${activeProfileId()}.${orgId}.${seatId}`;

/* ---------- talking to .com ---------- */

/**
 * The org API on `.com`. Every org GET but the plan and the invite offer carries the org read token
 * (lib/orgReadToken.js), minted as this browser's seat in that org (`deps.seat`, else the seat it
 * holds there) with the account key (`deps.umk`, else the unlocked session's); a 401 mints again once.
 */
export function orgApi(deps = {}) {
  const f = deps.fetch ?? fetch;
  const base = (deps.apex ?? controlApex()).replace(/\/+$/, "");
  const send = (method, path, body, headers) =>
    f(`${base}${path}`, {
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(body || headers ? { headers: { ...(body ? { "content-type": "application/json" } : {}), ...(headers ?? {}) } } : {}),
      cache: "no-store",
    });
  const tokenFor = async (orgId, fresh) => {
    const seat = deps.seat?.orgId === orgId ? deps.seat : listSeats(deps.storage).find((s) => s.orgId === orgId);
    if (!seat) return null;
    const umk = deps.umk ?? getSession()?.umk;
    try {
      return await orgReadToken({ base, fetch: f, umk, orgId, seatId: seat.seatId, now: deps.now?.() ?? Date.now(), fresh });
    } catch {
      return null;
    }
  };
  return async (method, path, body, headers) => {
    const orgId = method === "GET" ? orgReadPathOrg(path) : null;
    let token = orgId ? await tokenFor(orgId, false) : null;
    const withToken = (t) => (t ? { ...(headers ?? {}), authorization: `Bearer ${t}` } : headers);
    let res = await send(method, path, body, withToken(token));
    if (orgId && token && res.status === 401) {
      token = await tokenFor(orgId, true);
      if (token) res = await send(method, path, body, withToken(token));
    }
    let json = {};
    try {
      json = await res.json();
    } catch {
      json = {};
    }
    if (!res.ok) throw Object.assign(new Error(json.error ?? `HTTP ${res.status}`), { status: res.status, code: json.code ?? json.error ?? "" });
    return json;
  };
}

/** The org's chain as `GET /authority` (or the invite offer's `authority`) serves it, verified from `genesisHash`. */
export function verifyServedChain(a, genesisHash, now = Date.now()) {
  return org.verifyOrgAuthorityChain(a?.entries ?? [], { genesisHash, now, freezes: a?.freezes ?? [], overturns: a?.overturns ?? [], vetoes: a?.vetoes ?? [] });
}

/** Fetches the org and verifies it from the pinned genesis: chain, seat book, ceremonies. */
export async function orgSnapshot(call, orgId, genesisHash, now = Date.now()) {
  const a = await call("GET", `/api/orgs/${orgId}/authority`);
  const s = await call("GET", `/api/orgs/${orgId}/seats`);
  const c = await call("GET", `/api/orgs/${orgId}/ceremonies`);
  const freezes = a.freezes ?? [];
  const overturns = a.overturns ?? [];
  const state = verifyServedChain(a, genesisHash, now);
  const grants = s.grants ?? [];
  const revokes = s.revokes ?? [];
  const book = org.buildOrgSeatBook(state, { grants, revokes, freezes, overturns, now });
  return { name: a.org?.name ?? "", state, book, freezes, grants, revokes, seats: s, ceremonies: c.ceremonies ?? [] };
}

/* ---------- joining ---------- */

/**
 * Accepts an invitation on this browser. `umk` is the unlocked account key; an admin role asks for
 * the passkey once (the seat admin key is sealed under it). Returns `{ seat, code }`: the 6-digit
 * code the admin compares before admitting.
 */
export async function acceptOrgInvite(link, { umk, now = Date.now(), userName = "Flagship", deps = {} } = {}) {
  if (!(umk instanceof Uint8Array) || umk.length !== 32) throw fail("custody-locked");
  const call = orgApi(deps);
  const { orgId, seatId } = link;
  const { openOrgOffer, inviteReadHeaders, inviteKeys } = await import("./orgJoin.js");
  const r = await call("GET", `/api/orgs/${orgId}/invites/${seatId}`, undefined, inviteReadHeaders(link, now));
  if (r.accepted === true) throw fail("org-invite-accepted");
  const offer = await openOrgOffer(r.offerHex, link.keyHex);
  if (offer.orgId !== orgId || offer.seatId !== seatId || typeof offer.genesisHash !== "string") throw fail("org-offer");
  const ik = inviteKeys(link.keyHex);
  ik.offerKey.fill(0);
  // The org's chain must verify from the genesis the inviter sealed into the offer (it rides with the
  // offer: a joiner holds no seat to mint a read token with yet).
  verifyServedChain(r.authority, offer.genesisHash, now);
  const inv = r.invite;
  const roles = r.roles ?? [];
  if (org.orgSeatRolesHash(roles) !== inv.rolesHash || inv.inviteKeyPub !== ik.inviteKeyPub) {
    ik.hybridSecret.fill(0);
    throw fail("org-offer");
  }
  const inviteSha256 = org.orgSha256Hex(org.canonicalOrgSeatInvite(inv));
  const subject = org.orgSeatSubject(orgId, seatId);

  const member = org.deriveOrgSeatMemberSeeds(umk, orgId);
  const memberSign = (m) => org.hybridSign(member.hybridSecret, org.messagePurpose(m), m);
  const memberBinding = org.signPqKeyBinding(
    { role: "org-seat-member", subjectId: subject, ed25519PubHex: hex(member.publicKey.subarray(0, 32)), mldsaPubHex: hex(member.publicKey.subarray(32)), issuedAt: now },
    memberSign,
  );
  const memberKeyId = org.orgKeyIdHex(memberBinding);

  let adminBinding = null;
  let adminKeyId = "";
  if (org.orgRolesRaiseAdmin(roles)) {
    const seeds = crypto.getRandomValues(new Uint8Array(64));
    try {
      const { publicKey, secretKey } = org.hybridSigKeygen(seeds.subarray(0, 32), seeds.subarray(32));
      adminBinding = org.signPqKeyBinding(
        { role: "org-seat-admin", subjectId: subject, ed25519PubHex: hex(publicKey.subarray(0, 32)), mldsaPubHex: hex(publicKey.subarray(32)), issuedAt: now },
        (m) => org.hybridSign(secretKey, org.messagePurpose(m), m),
      );
      adminKeyId = org.orgKeyIdHex(adminBinding);
      await sealUnderPasskey({ recordKey: adminRecordKey(orgId, seatId), label: `org-seat-admin|${orgId}|${seatId}|${adminKeyId}`, plain: seeds, umk, userName });
      secretKey.fill(0);
    } finally {
      seeds.fill(0);
    }
  }

  const accept = { orgId, seatId, inviteSha256, memberKeyId, adminKeyId, issuedAt: now, ...(adminKeyId ? { custody: "browser" } : {}) };
  const signature = hex(memberSign(org.canonicalOrgSeatAccept(accept)));
  // The invite key signs the accept too: `.com` takes it only from someone holding the link.
  const inviteSignature = org.orgInviteAcceptSignature(ik.hybridSecret, accept);
  ik.hybridSecret.fill(0);
  const kem = org.orgKemKeyPair(org.deriveOrgSeatKemSeed(umk, orgId));
  const kemStatement = { orgId, seatId, kemKeyId: kem.kemKeyId, issuedAt: now };
  const seatKem = { statement: kemStatement, kemPubHex: hex(kem.kemPub), signature: hex(memberSign(org.canonicalOrgSeatKem(kemStatement))) };
  kem.kemSecret.fill(0);
  await call("POST", `/api/orgs/${orgId}/invites/${seatId}/accept`, { accept, memberBinding, adminBinding, signature, inviteSignature, seatKem });

  const code = org.orgSeatSas(inviteSha256, memberKeyId, adminKeyId);
  const seat = { orgId, seatId, orgName: String(offer.orgName ?? ""), pseudonym: String(offer.pseudonym ?? ""), genesisHash: offer.genesisHash, memberBinding, adminBinding, custody: adminKeyId ? "browser" : null, joinedAt: now, code };
  rememberSeat(seat, deps.storage);
  member.hybridSecret.fill(0);
  return { seat, code };
}

/* ---------- an admin seat's signatures ---------- */

/** Opens this seat's admin key (one passkey prompt), runs `fn(hybridSecret)`, wipes it. */
export async function withSeatAdminKey(seat, umk, fn) {
  if (!seat.adminBinding) throw fail("not-admin");
  const seeds = await openUnderPasskey({ recordKey: adminRecordKey(seat.orgId, seat.seatId), umk });
  try {
    const { publicKey, secretKey } = org.hybridSigKeygen(seeds.subarray(0, 32), seeds.subarray(32));
    if (hex(publicKey.subarray(0, 32)) !== seat.adminBinding.ed25519PubHex) throw fail("custody-key-changed");
    try {
      return await fn(secretKey);
    } finally {
      secretKey.fill(0);
    }
  } finally {
    seeds.fill(0);
  }
}

/** One approval of `order` (canonical bytes) by this seat under record `oarVersion`. */
export function approvalBy(seat, secret, order, oarVersion, now = Date.now()) {
  return org.signOrgApproval({ orgId: seat.orgId, oarVersion, order, seatId: seat.seatId, adminKeyId: org.orgKeyIdHex(seat.adminBinding), issuedAt: now, notAfter: now + 3 * DAY }, secret);
}

/**
 * Approves an open ceremony; when the approvals now meet the threshold for a grant or an overturn,
 * posts the result too (as the phones do). Returns "approved" or "done".
 */
export async function approveCeremony(seat, snap, ceremony, { umk, now = Date.now(), deps = {} } = {}) {
  const call = orgApi(deps);
  const order = enc.encode(ceremony.order);
  const version = snap.state.current.version;
  const a = await withSeatAdminKey(seat, umk, async (secret) => approvalBy(seat, secret, order, version, now));
  await call("POST", `/api/orgs/${seat.orgId}/ceremonies/${ceremony.sha256}/approvals`, { approval: a });
  const all = [...(ceremony.approvals ?? []).filter((x) => x.seatId !== seat.seatId), a];
  const p = ceremony.payload ?? {};
  if (p.kind === "grant" && p.grant) {
    const need = org.orgGrantThreshold(snap.state.current, p.roles ?? []);
    if (all.length >= need) {
      const { kind: _k, ...body } = p;
      await call("POST", `/api/orgs/${seat.orgId}/seats`, { ...body, approvals: all });
      return "done";
    }
  }
  return "approved";
}

/**
 * Accepts and admissions waiting for an admin (compare the code, then admit). Only accepts the invite
 * key signed are offered: whoever accepted held the invitation link.
 */
export function pendingJoins(snap) {
  const granted = new Set((snap.seats.grants ?? []).map((g) => g.grant?.seatId));
  const invites = new Map((snap.seats.invites ?? []).map((i) => [i.invite?.seatId, i]));
  const out = [];
  for (const a of snap.seats.accepts ?? []) {
    const acc = a.accept;
    if (!acc || granted.has(acc.seatId)) continue;
    const inv = invites.get(acc.seatId);
    if (!inv || !org.verifyOrgInviteAccept(inv.invite, acc, a.inviteSignature)) continue;
    out.push({ seatId: acc.seatId, invite: inv.invite, roles: inv.roles ?? [], accept: acc, memberBinding: a.memberBinding, adminBinding: a.adminBinding ?? null, custody: acc.custody === "browser" ? "browser" : "hardware" });
  }
  return out;
}

/** Invitations nobody has accepted yet (an admin may withdraw them). */
export function pendingInvites(snap) {
  const granted = new Set((snap.seats.grants ?? []).map((g) => g.grant?.seatId));
  const accepted = new Set((snap.seats.accepts ?? []).map((a) => a.accept?.seatId));
  return (snap.seats.invites ?? []).filter((i) => i.invite?.seatId && !granted.has(i.invite.seatId) && !accepted.has(i.invite.seatId)).map((i) => ({ seatId: i.invite.seatId, invite: i.invite }));
}

/**
 * Withdraws an invitation not yet admitted (one org admin): `.com` deletes it and any accept, so the link
 * stops working. Used when the codes did not match, too.
 */
export async function withdrawInvite(seat, snap, seatId, { umk, now = Date.now(), deps = {} } = {}) {
  const call = orgApi(deps);
  const version = snap.state.current.version;
  const withdraw = { orgId: seat.orgId, seatId, oarVersion: version, issuedAt: now };
  const order = org.canonicalOrgInviteWithdraw(withdraw);
  const a = await withSeatAdminKey(seat, umk, async (secret) => approvalBy(seat, secret, order, version, now));
  await call("POST", `/api/orgs/${seat.orgId}/invites/${seatId}/withdraw`, { withdraw, approvals: [a] });
  return "withdrawn";
}

/** The code the joining person's screen shows, for the admin to compare. */
export function joinCode(j) {
  return org.orgSeatSas(j.accept.inviteSha256, j.accept.memberKeyId, j.accept.adminKeyId ?? "");
}

/** Admits a person whose code matched: one admin for a member; two for an admin role (opens a ceremony). */
export async function admit(seat, snap, j, { umk, now = Date.now(), deps = {} } = {}) {
  const call = orgApi(deps);
  const version = snap.state.current.version;
  const grant = {
    orgId: seat.orgId,
    seatId: j.seatId,
    labelSha256: j.invite.labelSha256,
    memberKeyId: j.accept.memberKeyId,
    adminKeyId: j.accept.adminKeyId ?? "",
    rolesHash: j.invite.rolesHash,
    oarVersion: version,
    issuedAt: now,
    expiresAt: now + 365 * DAY,
    ...(j.custody === "browser" ? { custody: "browser" } : {}),
  };
  const order = org.canonicalOrgSeatGrant(grant);
  const body = { grant, roles: j.roles, memberBinding: j.memberBinding, adminBinding: j.adminBinding };
  const a = await withSeatAdminKey(seat, umk, async (secret) => approvalBy(seat, secret, order, version, now));
  if (org.orgGrantThreshold(snap.state.current, j.roles) <= 1) {
    await call("POST", `/api/orgs/${seat.orgId}/seats`, { ...body, approvals: [a] });
    return "admitted";
  }
  await call("POST", `/api/orgs/${seat.orgId}/ceremonies`, { order: new TextDecoder().decode(order), payload: { ...body, kind: "grant" }, approvals: [a] });
  return "ceremony";
}

/* ---------- keys and the directory ---------- */

/** The verified key-ring context, rings and pending rotations (`GET /keys`, `GET /servers`). */
export async function keyContext(call, snap, now = Date.now()) {
  const k = await call("GET", `/api/orgs/${snap.state.orgId}/keys`);
  const s = await call("GET", `/api/orgs/${snap.state.orgId}/servers`);
  return org.orgKeyContextFromServed({
    state: snap.state,
    book: snap.book,
    seatKems: k.seatKems ?? [],
    boxKems: k.boxKems ?? [],
    servers: s.servers ?? [],
    rings: k.rings ?? [],
    history: { revokes: snap.revokes, grants: snap.grants },
    now,
  });
}

/** Rotates every key a departed seat still holds: one passkey prompt for all the rings. Returns how many were posted. */
export async function rotatePending(seat, snap, { umk, now = Date.now(), deps = {} } = {}) {
  const call = orgApi(deps);
  const { ctx, rings, pending } = await keyContext(call, snap, now);
  const todo = new Map();
  for (const p of pending) for (const k of p.keys) if (k.kind !== "disk-key") todo.set(`${k.kind}|${k.scope}`, k);
  if (todo.size === 0) return 0;
  const bundles = await withSeatAdminKey(seat, umk, async (secret) =>
    [...todo.values()].map((k) =>
      org.rotateOrgKey({ ctx, rings, kind: k.kind, scope: k.scope, pending, issuedAt: now, approve: (order, v) => approvalBy(seat, secret, order, v, now) }),
    ),
  );
  for (const b of bundles) await call("POST", `/api/orgs/${seat.orgId}/keys`, b);
  return bundles.length;
}

/** The directory as this seat may read it (names by seat), or null when no directory key was sealed to it. */
export async function readDirectory(seat, snap, { umk, now = Date.now(), deps = {} } = {}) {
  const call = orgApi(deps);
  const { rings } = await keyContext(call, snap, now);
  const chain = rings.chains.get(org.orgKeyChainId ? org.orgKeyChainId("directory-key", "*") : "directory-key|*") ?? [];
  const kem = org.orgKemKeyPair(org.deriveOrgSeatKemSeed(umk, seat.orgId));
  const keys = new Map();
  try {
    for (const b of chain) {
      try {
        keys.set(b.ring.version, org.openOrgKeyRing(b, `seat:${seat.seatId}`, kem.kemSecret));
      } catch {
        /* a version not sealed to this seat */
      }
    }
  } finally {
    kem.kemSecret.fill(0);
  }
  if (keys.size === 0) return null;
  const d = await call("GET", `/api/orgs/${seat.orgId}/directory`);
  try {
    return org.openOrgDirectory(seat.orgId, d.entries ?? [], keys);
  } finally {
    for (const k of keys.values()) k.fill(0);
  }
}

/** The label each admin's custody shows ("hardware" or "browser"). */
export function adminsWithCustody(snap) {
  return snap.state.current.admins.map((a) => ({ seatId: a.seatId, kind: a.kind, custody: a.custody === "browser" ? "browser" : "hardware" }));
}

export const _test = { unhex };
