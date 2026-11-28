// The org directory on the webapp (docs/org-directory.md "Webapp hooks"; the phones' OrgViewModel
// directory and connector sections). An org admin seat opens the directory key sealed to its seat
// X-Wing key, reads the people, decides the connectors' proposals, keeps the connectors (add SCIM or
// LDAP, re-approve, pause, resume, retire, a new SCIM token, the group → role mapping) and seals each
// member's slice. A member seat opens its own slice ("Shared with"). Every admin write is one
// approval by the seat admin key (lib/orgSeat.js, one passkey prompt each); the protocol is the
// bundled packages/protocol code.

import * as org from "../vendor/flagship-org/org.js";
import { controlApex } from "./apex.js";
import { approvalBy, keyContext, orgApi, withSeatAdminKey } from "./orgSeat.js";

const enc = new TextEncoder();
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const randomId = () => hex(crypto.getRandomValues(new Uint8Array(16)));
const DAY = 86_400_000;

function fail(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function token() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(s) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
}

/** The seat's X-Wing key pair (derived from the account key per org; the caller wipes `kemSecret`). */
export function seatKem(umk, orgId) {
  return org.orgKemKeyPair(org.deriveOrgSeatKemSeed(umk, orgId));
}

/** Every directory-key version sealed to this seat, by version. */
export function directoryKeys(rings, seatId, kemSecret) {
  const out = new Map();
  for (const b of rings.chains.get(org.orgKeyChainId("directory-key", "*")) ?? []) {
    try {
      out.set(b.ring.version, org.openOrgKeyRing(b, `seat:${seatId}`, kemSecret));
    } catch {
      /* a version not sealed to this seat */
    }
  }
  return out;
}

const newest = (keys) => {
  let v = -1;
  for (const k of keys.keys()) if (k > v) v = k;
  return v < 0 ? null : { version: v, key: keys.get(v) };
};

/* ---------- loading ---------- */

/**
 * Everything the admin console shows: names, connectors (with standing and the opened mapping) and the
 * open proposals addressed to this seat (each checked against its connector). `umk` opens the seat's
 * X-Wing key; nothing here signs.
 */
export async function loadConsole(seat, snap, { umk, now = Date.now(), deps = {} } = {}) {
  const call = orgApi(deps);
  const plan = await keyContext(call, snap, now);
  const kem = seatKem(umk, seat.orgId);
  try {
    const keys = directoryKeys(plan.rings, seat.seatId, kem.kemSecret);
    const dir = await call("GET", `/api/orgs/${seat.orgId}/directory`);
    const view = keys.size ? org.openOrgDirectory(seat.orgId, dir.entries ?? [], keys) : { bySeat: new Map(), byPending: new Map(), unopened: [] };
    const rawConnectors = (await call("GET", `/api/orgs/${seat.orgId}/connectors`)).connectors ?? [];
    const connectors = [];
    for (const cb of rawConnectors) {
      const c = cb.connector;
      if (!c?.connectorId) continue;
      let standing = null;
      try {
        standing = org.orgConnectorStanding(snap.state, snap.book, cb, now);
      } catch {
        standing = null;
      }
      let mapping = null;
      const ms = cb.mappingSealed;
      if (ms && keys.has(ms.keyVersion)) {
        try {
          mapping = org.openOrgConnectorMapping(seat.orgId, c.connectorId, keys.get(ms.keyVersion), ms);
        } catch {
          mapping = null;
        }
      }
      connectors.push({ bundle: cb, connector: c, standing, mapping });
    }
    connectors.sort((a, b) => a.connector.issuedAt - b.connector.issuedAt);
    const proposals = [];
    for (const p of (await call("GET", `/api/orgs/${seat.orgId}/proposals`)).proposals ?? []) {
      if (p.decision) continue;
      const b = p.bundle;
      const cb = rawConnectors.find((x) => x.connector?.connectorId === b?.proposal?.connectorId);
      if (!b || !cb) continue;
      try {
        const roles = Array.isArray(b.roles) ? b.roles : [];
        org.verifyOrgProposal(cb, b, { rolesHash: roles.length ? org.orgSeatRolesHash(roles) : "", now });
        const entry = org.parseOrgDirectoryEntryBody(org.openOrgProposal(b, `seat:${seat.seatId}`, kem.kemSecret));
        proposals.push({ id: b.proposal.proposalId, kind: b.proposal.kind, subject: b.proposal.subject, entry, roles, connectorKind: cb.connector.kind });
      } catch {
        /* not addressed to this seat, or not verified */
      }
    }
    return { plan, keys, view, connectors, proposals };
  } finally {
    kem.kemSecret.fill(0);
  }
}

/** A member seat's own slice: the people it shares something with and their servers (null when none). */
export async function loadSlice(seat, snap, { umk, now = Date.now(), deps = {} } = {}) {
  const call = orgApi(deps);
  const all = (await call("GET", `/api/orgs/${seat.orgId}/directory/slices`)).slices ?? [];
  const mine = all.find((o) => o.slice?.seatId === seat.seatId);
  if (!mine) return null;
  org.verifyOrgDirectorySliceApproval(snap.state, snap.book, mine.slice, mine.approvals ?? [], now);
  const kem = seatKem(umk, seat.orgId);
  try {
    return org.openOrgDirectorySlice(mine.slice, kem.kemSecret);
  } finally {
    kem.kemSecret.fill(0);
  }
}

/* ---------- admin writes (each one passkey prompt) ---------- */

/** Writes one person's entry under the newest directory key; returns the write's digest. */
async function recordEntry(seat, snap, c, entry, secret, call, now) {
  const dk = newest(c.keys);
  if (!dk) throw fail("locked");
  const entryId = [...c.view.bySeat.values(), ...c.view.byPending.values()].find((e) => e.seatId && e.seatId === entry.seatId)?.entryId ?? randomId();
  const sealed = org.sealOrgDirectoryEntry({ orgId: seat.orgId, entryId, keyVersion: dk.version, directoryKey: dk.key, entry: { ...entry, updatedAt: now }, issuedAt: now });
  const order = org.canonicalOrgDirectoryWrite(sealed);
  await call("POST", `/api/orgs/${seat.orgId}/directory`, { entry: sealed, approvals: [approvalBy(seat, secret, order, snap.state.current.version, now)] });
  return org.orgSha256Hex(order);
}

/** Posts an invitation for `roles` and the person's entry; returns `{ link, ref }`. */
async function makeInvite(seat, snap, c, name, roles, entry, secret, call, now) {
  const seatId = randomId();
  const linkKey = crypto.getRandomValues(new Uint8Array(32));
  // The link key derives the offer key (seals the offer and the pseudonym) and the invite key, whose public
  // half the invite names: reading the offer and accepting both need it (docs/enterprise-accounts.md §7).
  const ik = org.deriveOrgInviteKeys(linkKey);
  ik.hybridSecret.fill(0);
  const k = await crypto.subtle.importKey("raw", ik.offerKey, "AES-GCM", false, ["encrypt"]);
  ik.offerKey.fill(0);
  const sealGcm = async (bytes) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    return new Uint8Array([...iv, ...new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, bytes))]);
  };
  const sealedLabel = await sealGcm(enc.encode(name));
  const offer = await sealGcm(enc.encode(JSON.stringify({ orgId: seat.orgId, orgName: seat.orgName, genesisHash: seat.genesisHash, seatId, roles, pseudonym: name })));
  const v = snap.state.current.version;
  const invite = { orgId: seat.orgId, seatId, labelSha256: org.orgSha256Hex(sealedLabel), rolesHash: org.orgSeatRolesHash(roles), oarVersion: v, issuedAt: now, expiresAt: now + 7 * DAY, inviteKeyPub: ik.inviteKeyPub };
  const order = org.canonicalOrgSeatInvite(invite);
  await call("POST", `/api/orgs/${seat.orgId}/invites`, { invite, roles, approvals: [approvalBy(seat, secret, order, v, now)], sealedLabelHex: hex(sealedLabel), offerHex: hex(offer) });
  try {
    await recordEntry(seat, snap, c, { ...(entry ?? { pseudonym: name }), seatId, pendingId: "" }, secret, call, now);
  } catch {
    /* the invitation stands; the entry is written next time */
  }
  const link = `${controlApex()}/org-join#o=${seat.orgId}&s=${seatId}&k=${hex(linkKey)}`;
  linkKey.fill(0);
  return { link, ref: org.orgSha256Hex(order) };
}

/** Invites a person by the name the org will know them by. Returns the link to share. */
export async function invite(seat, snap, c, { name, roles, umk, now = Date.now(), deps = {} }) {
  const n = String(name ?? "").trim();
  if (!n) throw fail("name-missing");
  const call = orgApi(deps);
  return withSeatAdminKey(seat, umk, (secret) => makeInvite(seat, snap, c, n, roles, null, secret, call, now));
}

async function decide(seat, snap, p, ref, secret, call, now) {
  const decision = ref ? "done" : "declined";
  const st = { orgId: seat.orgId, proposalId: p.id, decision, refSha256: ref ?? "0".repeat(64), issuedAt: now };
  await call("POST", `/api/orgs/${seat.orgId}/proposals/decisions`, { decision: st, approvals: [approvalBy(seat, secret, org.canonicalOrgProposalDecision(st), snap.state.current.version, now)] });
}

export async function declineProposal(seat, snap, p, { umk, now = Date.now(), deps = {} }) {
  const call = orgApi(deps);
  await withSeatAdminKey(seat, umk, (secret) => decide(seat, snap, p, null, secret, call, now));
}

/**
 * Carries a proposal out with the usual order, then records it: an invitation (returns its link), a
 * removal, an updated entry or a role change. Returns `{ kind, link? , ceremony? }`.
 */
export async function approveProposal(seat, snap, c, p, { umk, now = Date.now(), deps = {} }) {
  const call = orgApi(deps);
  const v = snap.state.current.version;
  return withSeatAdminKey(seat, umk, async (secret) => {
    if (p.kind === "invite") {
      const r = await makeInvite(seat, snap, c, p.entry.pseudonym, p.roles.length ? p.roles : [{ role: "member" }], p.entry, secret, call, now);
      await decide(seat, snap, p, r.ref, secret, call, now);
      return { kind: "invite", link: r.link };
    }
    if (p.kind === "offboard") {
      const revoke = { orgId: seat.orgId, seatId: p.subject, reason: "offboarded", oarVersion: v, issuedAt: now };
      const order = org.canonicalOrgSeatRevoke(revoke);
      await call("POST", `/api/orgs/${seat.orgId}/revokes`, { revoke, approvals: [approvalBy(seat, secret, order, v, now)] });
      await decide(seat, snap, p, org.orgSha256Hex(order), secret, call, now);
      return { kind: "offboard" };
    }
    if (p.kind === "entry-update") {
      const ref = await recordEntry(seat, snap, c, { ...p.entry, seatId: p.subject, pendingId: "" }, secret, call, now);
      await decide(seat, snap, p, ref, secret, call, now);
      return { kind: "entry-update" };
    }
    if (p.kind === "role-change") {
      const g = [...snap.grants].reverse().find((x) => x.grant.seatId === p.subject);
      if (!g || snap.book.revoked.has(p.subject)) throw fail("seat-unknown");
      if (org.orgRolesRaiseAdmin(p.roles) && !g.grant.adminKeyId) throw fail("needs-new-invite");
      const t = Math.max(now, g.grant.issuedAt + 1);
      const grant = { ...g.grant, rolesHash: org.orgSeatRolesHash(p.roles), oarVersion: v, issuedAt: t, expiresAt: t + 365 * DAY };
      const order = org.canonicalOrgSeatGrant(grant);
      const body = { grant, roles: p.roles, memberBinding: g.memberBinding, adminBinding: g.adminBinding ?? null };
      const a = approvalBy(seat, secret, order, v, now);
      let ceremony = false;
      if (org.orgGrantThreshold(snap.state.current, p.roles) <= 1) await call("POST", `/api/orgs/${seat.orgId}/seats`, { ...body, approvals: [a] });
      else {
        await call("POST", `/api/orgs/${seat.orgId}/ceremonies`, { order: new TextDecoder().decode(order), payload: { ...body, kind: "grant" }, approvals: [a] });
        ceremony = true;
      }
      await decide(seat, snap, p, org.orgSha256Hex(order), secret, call, now);
      return { kind: "role-change", ceremony };
    }
    throw fail("malformed", "proposal kind");
  });
}

/* ---------- connectors ---------- */

export function defaultMapping(kind) {
  const attributes =
    kind === "ldap"
      ? { email: "userPrincipalName", displayName: "displayName", externalId: "objectGUID", disabled: "userAccountControl" }
      : { email: "userName", displayName: "displayName", externalId: "externalId" };
  return { attributes, groups: {}, defaultRoles: [{ role: "member" }] };
}

function boxKem(c, serverDomain) {
  const k = c.plan.ctx.kems.get(`box:${serverDomain}`);
  if (!k) throw fail("box-key-missing");
  return k;
}

/** A new connector record, its key pair and the seeds the box will hold. */
function newConnector(orgId, kind, serverDomain, mapping, now) {
  const seeds = crypto.getRandomValues(new Uint8Array(64));
  const { publicKey } = org.hybridSigKeygen(seeds.subarray(0, 32), seeds.subarray(32));
  const connector = {
    orgId,
    connectorId: randomId(),
    kind,
    serverDomain,
    connectorKeyId: org.orgConnectorKeyId(publicKey),
    scopes: [...org.ORG_CONNECTOR_SCOPES].sort(),
    mappingSha256: org.orgConnectorMappingSha256(mapping),
    status: "active",
    issuedAt: now,
  };
  org.canonicalOrgConnector(connector);
  return { connector, pubHex: hex(publicKey), seedsHex: hex(seeds), wipe: () => seeds.fill(0) };
}

async function postNew(seat, snap, c, kind, serverDomain, mapping, extra, { umk, now, deps }) {
  const call = orgApi(deps);
  const kem = boxKem(c, serverDomain);
  const made = newConnector(seat.orgId, kind, serverDomain, mapping, now);
  try {
    const setup = org.sealOrgConnectorSetup(made.connector, kem, { connectorSeedsHex: made.seedsHex, mapping, ...extra }, now);
    const dk = newest(c.keys);
    const mappingSealed = dk ? org.sealOrgConnectorMapping(seat.orgId, made.connector.connectorId, dk.key, dk.version, mapping) : undefined;
    await withSeatAdminKey(seat, umk, async (secret) => {
      const a = approvalBy(seat, secret, org.canonicalOrgConnector(made.connector), snap.state.current.version, now);
      await call("POST", `/api/orgs/${seat.orgId}/connectors`, { connector: made.connector, connectorPubHex: made.pubHex, approvals: [a], setup, ...(mappingSealed ? { mappingSealed } : {}) });
    });
    return made.connector;
  } finally {
    made.wipe();
  }
}

/** Adds a SCIM connector on one of the org's servers; returns the URL and the token, shown once. */
export async function addScimConnector(seat, snap, c, { serverDomain, umk, now = Date.now(), deps = {} }) {
  const t = token();
  await postNew(seat, snap, c, "scim", serverDomain, defaultMapping("scim"), { scimTokenSha256: await sha256Hex(t), scimTokenIssuedAt: now }, { umk, now, deps });
  return { url: `https://${serverDomain}/scim/v2`, token: t };
}

/** The LDAP form's settings; only `ldaps://` is accepted. */
export function ldapSettings(form) {
  const url = String(form.url ?? "").trim();
  if (!url.toLowerCase().startsWith("ldaps://") || url.length <= 8 || !form.bindDn || !form.password || !form.baseDn) throw fail("ldap-form");
  return { url, bindDn: form.bindDn, bindPassword: form.password, baseDn: form.baseDn, userFilter: form.userFilter ?? "", flavor: form.openLdap ? "openldap" : "ad", intervalMinutes: 15 };
}

/** Adds an LDAP connector (the password goes to the box only, sealed). */
export async function addLdapConnector(seat, snap, c, { serverDomain, form, umk, now = Date.now(), deps = {} }) {
  const ldap = ldapSettings(form);
  const mapping = defaultMapping("ldap");
  if (form.openLdap) mapping.attributes = { email: "mail", displayName: "cn", externalId: "entryUUID", disabled: "pwdAccountLockedTime" };
  return postNew(seat, snap, c, "ldap", serverDomain, mapping, { ldap }, { umk, now, deps });
}

/** A later version of a connector record (same key), with this admin's approval; setup and mapping only when given. */
export async function updateConnector(seat, snap, c, connectorId, { status, mapping, setup, umk, now = Date.now(), deps = {} }) {
  const call = orgApi(deps);
  const cur = c.connectors.find((x) => x.connector.connectorId === connectorId);
  if (!cur) throw fail("seat-unknown");
  const next = { ...cur.connector, issuedAt: Math.max(now, cur.connector.issuedAt + 1) };
  if (status) next.status = status;
  if (mapping) next.mappingSha256 = org.orgConnectorMappingSha256(mapping);
  const body = { connector: next, connectorPubHex: cur.bundle.connectorPubHex };
  const sealedSetup = { ...(setup ?? {}), ...(mapping ? { mapping } : {}) };
  if (Object.keys(sealedSetup).length) body.setup = org.sealOrgConnectorSetup(next, boxKem(c, next.serverDomain), sealedSetup, next.issuedAt);
  const dk = newest(c.keys);
  if (mapping && dk) body.mappingSealed = org.sealOrgConnectorMapping(seat.orgId, connectorId, dk.key, dk.version, mapping);
  await withSeatAdminKey(seat, umk, async (secret) => {
    body.approvals = [approvalBy(seat, secret, org.canonicalOrgConnector(next), snap.state.current.version, now)];
    await call("POST", `/api/orgs/${seat.orgId}/connectors`, body);
  });
}

/** A new SCIM token, shown once; the box takes it at its next refresh. */
export async function rotateScimToken(seat, snap, c, connectorId, opts) {
  const t = token();
  const now = opts.now ?? Date.now();
  await updateConnector(seat, snap, c, connectorId, { ...opts, now, setup: { scimTokenSha256: await sha256Hex(t), scimTokenIssuedAt: now } });
  const cur = c.connectors.find((x) => x.connector.connectorId === connectorId);
  return { url: `https://${cur.connector.serverDomain}/scim/v2`, token: t };
}

/**
 * The mapping editor's text: one line per directory group, `group = member`, `group = server-admin
 * <server>` or `group = app-admin <app>`; `defaultMember` proposes people in no mapped group as members.
 */
export function mappingFromLines(base, lines, defaultMember) {
  const groups = {};
  for (const raw of String(lines).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.lastIndexOf("=");
    if (eq <= 0) throw fail("mapping-line", line);
    const group = line.slice(0, eq).trim();
    const [role, target] = line.slice(eq + 1).trim().split(/\s+/);
    if (role === "member") groups[group] = [{ role: "member" }];
    else if (role === "server-admin" && target) groups[group] = [{ role: "member" }, { role: "server-admin", servers: [target.toLowerCase()] }];
    else if (role === "app-admin" && target) groups[group] = [{ role: "member" }, { role: "service-admin", apps: [target.toLowerCase()] }];
    else throw fail("mapping-line", line);
  }
  return { ...base, groups, defaultRoles: defaultMember ? [{ role: "member" }] : [] };
}

export function mappingToLines(m) {
  return Object.keys(m?.groups ?? {})
    .sort()
    .map((g) => {
      const roles = m.groups[g] ?? [];
      const sa = roles.find((r) => r.role === "server-admin");
      const aa = roles.find((r) => r.role === "service-admin");
      return sa ? `${g} = server-admin ${sa.servers?.[0] ?? ""}` : aa ? `${g} = app-admin ${aa.apps?.[0] ?? ""}` : `${g} = member`;
    })
    .join("\n");
}

/* ---------- members' slices (an admin seals them) ---------- */

/** Seals a fresh slice to every live member seat whose stored one is missing or stale. Returns how many. */
export async function publishSlices(seat, snap, c, { umk, now = Date.now(), deps = {} }) {
  const call = orgApi(deps);
  const dk = newest(c.keys);
  if (!dk) return 0;
  const stored = (await call("GET", `/api/orgs/${seat.orgId}/directory/slices`)).slices ?? [];
  const byId = new Map(stored.map((o) => [o.slice?.seatId, o.slice]));
  const servers = [...c.plan.ctx.servers].sort();
  const admins = new Set(snap.state.current.admins.filter((a) => a.kind === "admin").map((a) => a.seatId));
  const bySeat = new Map([...c.view.bySeat].map(([k, v]) => [k, v]));
  const todo = [];
  for (const id of snap.book.seats.keys()) {
    if (snap.book.revoked.has(id) || admins.has(id)) continue;
    const kem = c.plan.ctx.kems.get(`seat:${id}`);
    if (!kem) continue;
    const content = org.orgDirectorySliceContent(snap.state, snap.book, id, bySeat, servers, now);
    const tag = org.orgDirectorySliceTag(dk.key, org.canonicalOrgDirectorySlicePayload(seat.orgId, id, content));
    const have = byId.get(id);
    if (have && have.contentTag === tag && have.tagKeyVersion === dk.version && have.kemKeyId === kem.kemKeyId) continue;
    todo.push(org.sealOrgDirectorySlice({ orgId: seat.orgId, seatId: id, kemPub: kem.kemPub, kemKeyId: kem.kemKeyId, content, directoryKey: dk.key, tagKeyVersion: dk.version, issuedAt: now }));
  }
  if (!todo.length) return 0;
  await withSeatAdminKey(seat, umk, async (secret) => {
    for (const slice of todo) {
      const a = approvalBy(seat, secret, org.canonicalOrgDirectorySliceWrite(slice), snap.state.current.version, now);
      await call("POST", `/api/orgs/${seat.orgId}/directory/slices`, { slice, approvals: [a] });
    }
  });
  return todo.length;
}
