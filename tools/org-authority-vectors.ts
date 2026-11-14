#!/usr/bin/env -S npx tsx
/**
 * Shared vectors for enterprise org authority (packages/protocol/src/orgAuthority.ts,
 * docs/enterprise-accounts.md §5-§9 and the owner's decisions). TypeScript generates them;
 * packages/protocol/tests/orgAuthorityVectors.test.ts, the Swift OrgAuthorityVectorTests and the
 * Kotlin OrgAuthorityVectorsTest check them.
 *
 * Run:          npx tsx tools/org-authority-vectors.ts
 * CI freshness: npx tsx tools/org-authority-vectors.ts --check
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hybridSigKeygen, hybridSign } from "../packages/protocol/src/pqHybrid.js";
import { canonicalPqKeyBinding, type PqKeyBindingStatement, type PqKeyBindingWire } from "../packages/protocol/src/pqTrust.js";
import {
  ORG_FOUNDER_NOTICE_MS,
  ORG_GENESIS_PREV,
  canonicalOrgAdmins,
  canonicalOrgApproval,
  canonicalOrgAuthority,
  canonicalOrgBylaws,
  canonicalOrgDelayedChange,
  canonicalOrgOverturn,
  canonicalOrgSeatAccept,
  canonicalOrgSeatFreeze,
  canonicalOrgSeatGrant,
  canonicalOrgSeatInvite,
  canonicalOrgSeatRevoke,
  canonicalOrgSeatRoles,
  canonicalOrgVeto,
  deriveOrgSeatMemberSeeds,
  orgAuthorityHash,
  orgBylawsThreshold,
  orgFounderRemovalOf,
  orgGrantThreshold,
  orgKeyIdHex,
  orgOverturnFor,
  orgOverturnOf,
  orgOverturnThreshold,
  orgSeatRolesHash,
  orgSeatSas,
  orgSeatSubject,
  orgSha256Hex,
  signOrgApproval,
  signOrgSeatLeave,
  type OrgAdminEntry,
  type OrgApproval,
  type OrgAuthorityEntry,
  type OrgAuthorityRecord,
  type OrgDelayedChange,
  type OrgSeatFreeze,
  type OrgSeatGrant,
  type OrgSeatGrantBundle,
  type OrgSeatRole,
  type OrgSigned,
  type OrgVeto,
} from "../packages/protocol/src/orgAuthority.js";

const OUT = resolve(import.meta.dirname, "..", "packages/protocol/test-vectors/org-authority/vectors.json");
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const utf8 = (b: Uint8Array): string => new TextDecoder().decode(b);
const fill = (n: number, v: number): Uint8Array => new Uint8Array(n).fill(v);

const ORG = "0a".repeat(16);
const T0 = 1_795_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

interface Key {
  name: string;
  seatId: string;
  edSeedHex: string;
  mldsaSeedHex: string;
  secret: Uint8Array;
  binding: PqKeyBindingWire;
  keyId: string;
}

function key(name: string, seatByte: number, a: number, b: number, role: "org-seat-admin" | "org-seat-member" = "org-seat-admin"): Key {
  const seatId = seatByte.toString(16).padStart(2, "0").repeat(16);
  const { publicKey, secretKey } = hybridSigKeygen(fill(32, a), fill(32, b));
  const st: PqKeyBindingStatement = {
    role,
    subjectId: orgSeatSubject(ORG, seatId),
    ed25519PubHex: hex(publicKey.subarray(0, 32)),
    mldsaPubHex: hex(publicKey.subarray(32)),
    issuedAt: T0 - DAY,
  };
  const binding: PqKeyBindingWire = { v: 1, ...st, signature: hex(hybridSign(secretKey, "flagship/pq-key-binding/v1", canonicalPqKeyBinding(st), { deterministic: true })) };
  return { name, seatId, edSeedHex: hex(fill(32, a)), mldsaSeedHex: hex(fill(32, b)), secret: secretKey, binding, keyId: orgKeyIdHex(binding) };
}

const A = key("A founder", 0xa1, 0x11, 0x12);
const B = key("B admin", 0xb1, 0x13, 0x14);
const C = key("C admin", 0xc1, 0x15, 0x16);
const D = key("D board", 0xd1, 0x17, 0x18);
const R = key("R recovery", 0xe1, 0x19, 0x1a);
const S = key("S scoped admin", 0x51, 0x1b, 0x1c);
const SM = key("S member", 0x51, 0x1d, 0x1e, "org-seat-member");
const MM = key("M member", 0x61, 0x1f, 0x20, "org-seat-member");
const X = key("X outsider", 0x71, 0x21, 0x22);

const entry = (k: Key, kind: OrgAdminEntry["kind"]): OrgAdminEntry => ({ seatId: k.seatId, kind, binding: k.binding });

function approve(k: Key, order: Uint8Array, oarVersion: number, issuedAt: number, notAfter = issuedAt + 3 * DAY): OrgApproval {
  return signOrgApproval({ orgId: ORG, oarVersion, order, seatId: k.seatId, adminKeyId: k.keyId, issuedAt, notAfter }, k.secret, { deterministic: true });
}

// ── chain ───────────────────────────────────────────────────────────────
const v0: OrgAuthorityRecord = {
  orgId: ORG,
  version: 0,
  prevHash: ORG_GENESIS_PREV,
  admins: [entry(A, "admin"), entry(B, "admin"), entry(C, "admin"), entry(D, "board")],
  bylaws: { overturnSeats: [B.seatId, C.seatId, D.seatId], overturnK: 2, vetoK: 1 },
  founderSeatId: A.seatId,
  kGov: 2,
  kGrant: 1,
  kDestroy: 2,
  kSite: 3,
  issuedAt: T0,
};
const genesisHash = orgAuthorityHash(v0);
const e0: OrgAuthorityEntry = { record: v0, via: "genesis", approvals: [A, B, C, D].map((k) => approve(k, canonicalOrgAuthority(v0), 0, T0 + MIN)) };

const v1: OrgAuthorityRecord = { ...v0, version: 1, prevHash: genesisHash, admins: [...v0.admins, entry(R, "recovery")], issuedAt: T0 + HOUR };
const v1Order = canonicalOrgAuthority(v1);
const e1: OrgAuthorityEntry = { record: v1, via: "direct", approvals: [approve(A, v1Order, 0, T0 + HOUR + MIN), approve(B, v1Order, 0, T0 + HOUR + MIN), approve(R, v1Order, 1, T0 + HOUR + MIN)] };

const noticeAt = T0 + DAY;
const v2 = orgFounderRemovalOf(v1, C.seatId, noticeAt + ORG_FOUNDER_NOTICE_MS);
const notice: OrgDelayedChange = { orgId: ORG, oarVersion: 1, kind: "founder-removal", nextRecordSha256: orgAuthorityHash(v2), effectiveAt: v2.issuedAt, issuedAt: noticeAt };
const noticeOrder = canonicalOrgDelayedChange(notice);
const e2: OrgAuthorityEntry = { record: v2, via: "founder-removal", approvals: [], notice: { body: notice, approvals: [approve(A, noticeOrder, 1, noticeAt)] } };

const v3 = orgOverturnOf(v2, v1, v2, v2.issuedAt + HOUR);
const v3Order = canonicalOrgAuthority(v3);
const e3: OrgAuthorityEntry = {
  record: v3,
  via: "overturn",
  overturnOf: 2,
  approvals: [approve(B, v3Order, 2, v3.issuedAt + MIN), approve(D, v3Order, 2, v3.issuedAt + MIN), approve(C, v3Order, 3, v3.issuedAt + MIN)],
};

const NOW = v3.issuedAt + HOUR;

const veto: OrgSigned<OrgVeto> = (() => {
  const body: OrgVeto = { orgId: ORG, noticeSha256: orgSha256Hex(noticeOrder), issuedAt: noticeAt + DAY };
  return { body, approvals: [approve(B, canonicalOrgVeto(body), 1, noticeAt + DAY)] };
})();
const vetoByBoard: OrgSigned<OrgVeto> = (() => {
  const body: OrgVeto = { orgId: ORG, noticeSha256: orgSha256Hex(noticeOrder), issuedAt: noticeAt + DAY };
  return { body, approvals: [approve(D, canonicalOrgVeto(body), 1, noticeAt + DAY)] };
})();
const lateVeto: OrgSigned<OrgVeto> = (() => {
  const body: OrgVeto = { orgId: ORG, noticeSha256: orgSha256Hex(noticeOrder), issuedAt: v2.issuedAt + MIN };
  return { body, approvals: [approve(B, canonicalOrgVeto(body), 1, v2.issuedAt + MIN)] };
})();

// Freeze of B by C before v1's approvals; overturned by C and D.
const freezeB: OrgSigned<OrgSeatFreeze> = (() => {
  const body: OrgSeatFreeze = { orgId: ORG, seatId: B.seatId, untilMs: T0 + 30 * MIN + 72 * HOUR, oarVersion: 0, issuedAt: T0 + 30 * MIN };
  return { body, approvals: [approve(C, canonicalOrgSeatFreeze(body), 0, body.issuedAt)] };
})();
const freezeTooLong: OrgSigned<OrgSeatFreeze> = (() => {
  const body: OrgSeatFreeze = { orgId: ORG, seatId: B.seatId, untilMs: T0 + 30 * MIN + 73 * HOUR, oarVersion: 0, issuedAt: T0 + 30 * MIN };
  return { body, approvals: [approve(C, canonicalOrgSeatFreeze(body), 0, body.issuedAt)] };
})();
const freezeByBoard: OrgSigned<OrgSeatFreeze> = (() => {
  const body: OrgSeatFreeze = { orgId: ORG, seatId: B.seatId, untilMs: T0 + 30 * MIN + 72 * HOUR, oarVersion: 0, issuedAt: T0 + 30 * MIN };
  return { body, approvals: [approve(D, canonicalOrgSeatFreeze(body), 0, body.issuedAt)] };
})();
const freezeAInCooldown: OrgSigned<OrgSeatFreeze> = (() => {
  const body: OrgSeatFreeze = { orgId: ORG, seatId: A.seatId, untilMs: T0 + 40 * MIN + 72 * HOUR, oarVersion: 0, issuedAt: T0 + 40 * MIN };
  return { body, approvals: [approve(C, canonicalOrgSeatFreeze(body), 0, body.issuedAt)] };
})();
const overturnB = (() => {
  const body = orgOverturnFor(freezeB.body, 0, T0 + 50 * MIN);
  return { body, approvals: [C, D].map((k) => approve(k, canonicalOrgOverturn(body), 0, body.issuedAt)) };
})();
const overturnBOnlyD = (() => {
  const body = orgOverturnFor(freezeB.body, 0, T0 + 50 * MIN);
  return { body, approvals: [approve(D, canonicalOrgOverturn(body), 0, body.issuedAt)] };
})();

// Bylaws change: needs the strictest threshold (kSite 3 here).
const v1b: OrgAuthorityRecord = { ...v0, version: 1, prevHash: genesisHash, bylaws: { overturnSeats: "*", overturnK: 0, vetoK: 2 }, issuedAt: T0 + HOUR };
const v1bOrder = canonicalOrgAuthority(v1b);
const e1bTwo: OrgAuthorityEntry = { record: v1b, via: "direct", approvals: [A, B].map((k) => approve(k, v1bOrder, 0, T0 + HOUR + MIN)) };
const e1bThree: OrgAuthorityEntry = { record: v1b, via: "direct", approvals: [A, B, C].map((k) => approve(k, v1bOrder, 0, T0 + HOUR + MIN)) };

const flip = (a: OrgApproval): OrgApproval => ({ ...a, signature: a.signature.slice(0, 10) + (a.signature[10] === "0" ? "1" : "0") + a.signature.slice(11) });
const ok = { ok: true };
const no = (code: string) => ({ ok: false, code });

const chains = [
  { name: "genesis, recovery seat added, founder removes C after 7 days, the bylaws' set restores C", entries: [e0, e1, e2, e3], now: NOW, expect: ok, currentVersion: 3 },
  { name: "genesis alone", entries: [e0], now: NOW, expect: ok, currentVersion: 0 },
  { name: "genesis hash pinned is another", entries: [e0], now: NOW, genesisHash: "11".repeat(32), expect: no("prev-hash") },
  { name: "genesis without the board seat's consent", entries: [{ ...e0, approvals: e0.approvals.slice(0, 3) }], now: NOW, expect: no("consent-missing") },
  { name: "v1 approved by the founder alone", entries: [e0, { ...e1, approvals: [e1.approvals[0]!, e1.approvals[2]!] }], now: NOW, expect: no("threshold") },
  { name: "v1 counts a board seat", entries: [e0, { ...e1, approvals: [e1.approvals[0]!, approve(D, v1Order, 0, T0 + HOUR + MIN), e1.approvals[2]!] }], now: NOW, expect: no("not-an-admin") },
  { name: "v1 without the new recovery seat's consent", entries: [e0, { ...e1, approvals: e1.approvals.slice(0, 2) }], now: NOW, expect: no("consent-missing") },
  { name: "v1 with the founder's approval twice", entries: [e0, { ...e1, approvals: [e1.approvals[0]!, e1.approvals[0]!, e1.approvals[2]!] }], now: NOW, expect: no("duplicate-signer") },
  { name: "v1 approval with one bit flipped", entries: [e0, { ...e1, approvals: [flip(e1.approvals[0]!), e1.approvals[1]!, e1.approvals[2]!] }], now: NOW, expect: no("bad-signature") },
  { name: "v1 pointing at another previous record", entries: [e0, { ...e1, record: { ...v1, prevHash: "22".repeat(32) } }], now: NOW, expect: no("prev-hash") },
  { name: "v1 while B was frozen by C", entries: [e0, e1], now: NOW, freezes: [freezeB], expect: no("frozen-signer") },
  { name: "v1 after the bylaws' set overturned B's freeze", entries: [e0, e1], now: NOW, freezes: [freezeB], overturns: [overturnB], expect: ok, currentVersion: 1 },
  { name: "an overturn signed by one of the set does not hold", entries: [e0, e1], now: NOW, freezes: [freezeB], overturns: [overturnBOnlyD], expect: no("frozen-signer") },
  { name: "a second freeze by the same admin within 7 days is void", entries: [e0, e1], now: NOW, freezes: [freezeB, freezeAInCooldown], overturns: [overturnB], expect: ok, currentVersion: 1 },
  { name: "a freeze longer than 72 h is void", entries: [e0, e1], now: NOW, freezes: [freezeTooLong], expect: ok, currentVersion: 1 },
  { name: "a board seat cannot freeze", entries: [e0, e1], now: NOW, freezes: [freezeByBoard], expect: ok, currentVersion: 1 },
  { name: "the founder's removal applied before its 7 days", entries: [e0, e1, e2], now: v2.issuedAt - MIN, expect: no("notice-early") },
  { name: "the founder's removal vetoed by another admin", entries: [e0, e1, e2], now: NOW, vetoes: [veto], expect: no("notice-vetoed") },
  { name: "a board seat alone is not the overturn set's two", entries: [e0, e1, e2], now: NOW, vetoes: [vetoByBoard], expect: ok, currentVersion: 2 },
  { name: "a veto after the notice ran out is late", entries: [e0, e1, e2], now: NOW, vetoes: [lateVeto], expect: ok, currentVersion: 2 },
  {
    name: "a removal notice signed by an admin who is not the founder",
    entries: [e0, e1, { ...e2, notice: { body: notice, approvals: [approve(B, noticeOrder, 1, noticeAt)] } }],
    now: NOW,
    expect: no("notice-invalid"),
  },
  { name: "the restore approved by one of the overturn set", entries: [e0, e1, e2, { ...e3, approvals: [e3.approvals[0]!, e3.approvals[2]!] }], now: NOW, expect: no("threshold") },
  { name: "the restore without the restored seat's consent", entries: [e0, e1, e2, { ...e3, approvals: e3.approvals.slice(0, 2) }], now: NOW, expect: no("consent-missing") },
  { name: "changing the bylaws with k_gov only", entries: [e0, e1bTwo], now: NOW, expect: no("threshold") },
  { name: "changing the bylaws with the strictest ceremony", entries: [e0, e1bThree], now: NOW, expect: ok, currentVersion: 1 },
];

// ── seats ───────────────────────────────────────────────────────────────
const SERVER = "home.acme.flagship.services";
const memberRoles: OrgSeatRole[] = [{ role: "member" }];
const scopedRoles: OrgSeatRole[] = [{ role: "server-admin", servers: [SERVER] }, { role: "service-admin", apps: ["acme--wiki"] }];
const label = orgSha256Hex(new TextEncoder().encode("sealed pseudonym bytes"));

function grant(seat: string, member: Key, admin: Key | null, roles: OrgSeatRole[], signers: Key[], oarVersion = 1, issuedAt = T0 + 2 * HOUR): OrgSeatGrantBundle {
  const g: OrgSeatGrant = {
    orgId: ORG,
    seatId: seat,
    labelSha256: label,
    memberKeyId: member.keyId,
    adminKeyId: admin ? admin.keyId : "",
    rolesHash: orgSeatRolesHash(roles),
    oarVersion,
    issuedAt,
    expiresAt: issuedAt + 365 * DAY,
  };
  const order = canonicalOrgSeatGrant(g);
  return { grant: g, roles, memberBinding: member.binding, adminBinding: admin ? admin.binding : null, approvals: signers.map((k) => approve(k, order, oarVersion, issuedAt + MIN)) };
}

const grantM = grant(MM.seatId, MM, null, memberRoles, [A]);
const grantSOne = grant(S.seatId, SM, S, scopedRoles, [A]);
const grantSTwo = grant(S.seatId, SM, S, scopedRoles, [A, B]);
const grantByBoard = grant(MM.seatId, MM, null, memberRoles, [D]);
const leaveM = signOrgSeatLeave({ orgId: ORG, seatId: MM.seatId, reason: "left", oarVersion: 1, issuedAt: T0 + 3 * HOUR }, (() => {
  return new Uint8Array([...Buffer.from(MM.edSeedHex, "hex"), ...Buffer.from(MM.mldsaSeedHex, "hex")]);
})(), { deterministic: true });
const revokeSByA = (() => {
  const revoke = { orgId: ORG, seatId: S.seatId, reason: "offboarded", oarVersion: 1, issuedAt: T0 + 3 * HOUR };
  return { revoke, approvals: [approve(A, canonicalOrgSeatRevoke(revoke), 1, revoke.issuedAt)] };
})();
const revokeBByA = (() => {
  const revoke = { orgId: ORG, seatId: B.seatId, reason: "offboarded", oarVersion: 1, issuedAt: T0 + 3 * HOUR };
  return { revoke, approvals: [approve(A, canonicalOrgSeatRevoke(revoke), 1, revoke.issuedAt)] };
})();

const seatBooks = [
  { name: "a member seat by one admin, a scoped admin by two", grants: [grantM, grantSTwo], revokes: [], expectSeats: [MM.seatId, S.seatId], expectRefused: [] },
  { name: "a scoped admin approved by one admin is refused", grants: [grantM, grantSOne], revokes: [], expectSeats: [MM.seatId], expectRefused: [{ seatId: S.seatId, code: "threshold" }] },
  { name: "a board seat cannot admit", grants: [grantByBoard], revokes: [], expectSeats: [], expectRefused: [{ seatId: MM.seatId, code: "not-an-admin" }] },
  { name: "a member leaves; an admin offboards the scoped admin", grants: [grantM, grantSTwo], revokes: [leaveM, revokeSByA], expectSeats: [], expectRefused: [{ seatId: MM.seatId, code: "seat-revoked" }, { seatId: S.seatId, code: "seat-revoked" }] },
  { name: "an org admin's seat is not revoked by a seat revoke", grants: [grantM], revokes: [revokeBByA], expectSeats: [MM.seatId], expectRefused: [{ seatId: B.seatId, code: "seat-is-org-admin" }] },
];

// ── the predicate (state after v1, seats M and S) ────────────────────────
const order = (tag: string) => new TextEncoder().encode(`${tag}|${SERVER}|${T0}`);
const UPDATE = order("flagship/server-update/v1");
const RANK = order("flagship/app-rank/v1");
const DELETE = order("flagship/servers-self-delete/v1");
const ADD = order("flagship/auth-code-admin/v1");
const AT = T0 + 4 * HOUR;
const ap = (k: Key, o: Uint8Array, v = 1, t = AT) => approve(k, o, v, t);

const authorize = [
  { name: "the server's admin updates it alone", action: { kind: "operate", server: SERVER }, order: utf8(UPDATE), approvals: [ap(S, UPDATE)], now: AT + MIN, expect: { ok: true, scopedSeat: S.seatId } },
  { name: "the server's admin on another server", action: { kind: "operate", server: "other.acme.flagship.services" }, order: utf8(UPDATE), approvals: [ap(S, UPDATE)], now: AT + MIN, expect: no("scope") },
  { name: "the app's admin changes a rank in it on any server", action: { kind: "app-admin", server: "other.acme.flagship.services", serviceRef: "acme--wiki" }, order: utf8(RANK), approvals: [ap(S, RANK)], now: AT + MIN, expect: { ok: true, scopedSeat: S.seatId } },
  { name: "the app's admin in another app", action: { kind: "app-admin", server: "other.acme.flagship.services", serviceRef: "acme--crm" }, order: utf8(RANK), approvals: [ap(S, RANK)], now: AT + MIN, expect: no("scope") },
  { name: "an org admin operates any server", action: { kind: "operate", server: "other.acme.flagship.services" }, order: utf8(UPDATE), approvals: [ap(B, UPDATE)], now: AT + MIN, expect: { ok: true, scopedSeat: null } },
  { name: "deleting a server with one org admin", action: { kind: "destroy" }, order: utf8(DELETE), approvals: [ap(A, DELETE)], now: AT + MIN, expect: no("threshold") },
  { name: "deleting a server with two org admins", action: { kind: "destroy" }, order: utf8(DELETE), approvals: [ap(A, DELETE), ap(B, DELETE)], now: AT + MIN, expect: { ok: true, scopedSeat: null } },
  { name: "a scoped admin does not count toward k_destroy", action: { kind: "destroy" }, order: utf8(DELETE), approvals: [ap(A, DELETE), ap(S, DELETE)], now: AT + MIN, expect: no("scope") },
  { name: "a board seat cannot operate", action: { kind: "operate", server: SERVER }, order: utf8(UPDATE), approvals: [ap(D, UPDATE)], now: AT + MIN, expect: no("not-an-admin") },
  { name: "an outsider's key", action: { kind: "operate", server: SERVER }, order: utf8(UPDATE), approvals: [ap(X, UPDATE)], now: AT + MIN, expect: no("unknown-signer") },
  { name: "an approval of another order", action: { kind: "operate", server: SERVER }, order: utf8(UPDATE), approvals: [ap(B, RANK)], now: AT + MIN, expect: no("order-mismatch") },
  { name: "an approval past its notAfter", action: { kind: "operate", server: SERVER }, order: utf8(UPDATE), approvals: [ap(B, UPDATE)], now: AT + 4 * DAY, expect: no("expired") },
  { name: "the scoped seat cannot add a server", action: { kind: "add-server" }, order: utf8(ADD), approvals: [ap(S, ADD)], now: AT + MIN, expect: no("scope") },
  { name: "approvals under v0 more than 24 h after v1", action: { kind: "operate", server: SERVER }, order: utf8(UPDATE), approvals: [ap(B, UPDATE, 0, T0 + 2 * DAY)], now: T0 + 2 * DAY, expect: no("stale-oar") },
  { name: "approvals under v0 within 24 h of v1", action: { kind: "operate", server: SERVER }, order: utf8(UPDATE), approvals: [ap(B, UPDATE, 0, T0 + 2 * HOUR)], now: T0 + 2 * HOUR, expect: { ok: true, scopedSeat: null } },
];

// ── canonical forms ──────────────────────────────────────────────────────
const invite = { orgId: ORG, seatId: MM.seatId, labelSha256: label, rolesHash: orgSeatRolesHash(memberRoles), oarVersion: 1, issuedAt: T0, expiresAt: T0 + 7 * DAY };
const inviteSha = orgSha256Hex(canonicalOrgSeatInvite(invite));
const accept = { orgId: ORG, seatId: MM.seatId, inviteSha256: inviteSha, memberKeyId: MM.keyId, adminKeyId: "", issuedAt: T0 + MIN };
const approvalStatement = { orgId: ORG, oarVersion: 1, purposeTag: "flagship/server-update/v1", orderSha256: orgSha256Hex(UPDATE), seatId: B.seatId, adminKeyId: B.keyId, notAfter: AT + DAY, issuedAt: AT };
const canonical = [
  { name: "admins", bytes: utf8(canonicalOrgAdmins(v1.admins)) },
  { name: "bylaws named", bytes: utf8(canonicalOrgBylaws(v0.bylaws)) },
  { name: "bylaws all admins, majority", bytes: utf8(canonicalOrgBylaws(v1b.bylaws)) },
  { name: "authority v1", bytes: utf8(canonicalOrgAuthority(v1)) },
  { name: "approval", bytes: utf8(canonicalOrgApproval(approvalStatement)) },
  { name: "delayed change", bytes: utf8(noticeOrder) },
  { name: "veto", bytes: utf8(canonicalOrgVeto(veto.body)) },
  { name: "freeze", bytes: utf8(canonicalOrgSeatFreeze(freezeB.body)) },
  { name: "overturn", bytes: utf8(canonicalOrgOverturn(overturnB.body)) },
  { name: "roles member", bytes: utf8(canonicalOrgSeatRoles(memberRoles)) },
  { name: "roles scoped", bytes: utf8(canonicalOrgSeatRoles(scopedRoles)) },
  { name: "roles every server, unlock, add", bytes: utf8(canonicalOrgSeatRoles([{ role: "unlock", servers: [SERVER] }, { role: "servers-add" }, { role: "server-admin", servers: "*" }])) },
  { name: "invite", bytes: utf8(canonicalOrgSeatInvite(invite)) },
  { name: "accept", bytes: utf8(canonicalOrgSeatAccept(accept)) },
  { name: "grant", bytes: utf8(canonicalOrgSeatGrant(grantSTwo.grant)) },
  { name: "revoke", bytes: utf8(canonicalOrgSeatRevoke(revokeSByA.revoke)) },
].map((c) => ({ ...c, sha256: orgSha256Hex(new TextEncoder().encode(c.bytes)) }));

const umk = fill(32, 0x42);
const seeds = deriveOrgSeatMemberSeeds(umk, ORG);

const doc = {
  description:
    "Enterprise org authority (docs/enterprise-accounts.md). Keys are hybrid Ed25519 + ML-DSA-65 from fixed seeds; signatures deterministic. chains: verifyOrgAuthorityChain(entries, {genesisHash ?? top-level genesisHash, now, freezes, overturns, vetoes}). seatBooks and authorize run on the state of chains[0].entries[0..1] (v0, v1) with no freezes. authorize uses seatBooks[0]'s book.",
  orgId: ORG,
  keys: Object.fromEntries(
    [A, B, C, D, R, S, SM, MM, X].map((k) => [k.name, { seatId: k.seatId, edSeedHex: k.edSeedHex, mldsaSeedHex: k.mldsaSeedHex, keyId: k.keyId, binding: k.binding }]),
  ),
  genesisHash,
  records: { v0: orgAuthorityHash(v0), v1: orgAuthorityHash(v1), v2: orgAuthorityHash(v2), v3: orgAuthorityHash(v3) },
  thresholds: {
    v0: { overturn: orgOverturnThreshold(v0), bylaws: orgBylawsThreshold(v0), grantMember: orgGrantThreshold(v0, memberRoles), grantScoped: orgGrantThreshold(v0, scopedRoles) },
    v1b: { overturn: orgOverturnThreshold(v1b), bylaws: orgBylawsThreshold(v1b) },
  },
  canonical,
  sas: { inviteSha256: inviteSha, memberKeyId: MM.keyId, adminKeyId: "", code: orgSeatSas(inviteSha, MM.keyId, "") },
  memberSeeds: { umkHex: hex(umk), orgId: ORG, edSeedHex: hex(seeds.edSeed), mldsaSeedHex: hex(seeds.mldsaSeed), ed25519PubHex: hex(seeds.publicKey.subarray(0, 32)) },
  chains,
  seatBooks,
  authorize,
};

// Bindings become {"$key": name} (see `keys`) and approvals {"$approval": i} (see `approvals`), so the
// file stays small; readers resolve both before use.
const KEYS = [A, B, C, D, R, S, SM, MM, X];
const approvalPool: OrgApproval[] = [];
const approvalIndex = new Map<string, number>();
function compact(v: unknown, top = false): unknown {
  if (Array.isArray(v)) return v.map((x) => compact(x));
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (!top && typeof o.mldsaPubHex === "string" && typeof o.signature === "string" && typeof o.role === "string") {
    const k = KEYS.find((x) => x.binding.signature === o.signature);
    if (!k) throw new Error("binding without a key");
    return { $key: k.name };
  }
  if (typeof o.purposeTag === "string" && typeof o.adminKeyId === "string" && typeof o.signature === "string") {
    const sig = o.signature as string;
    let i = approvalIndex.get(sig + JSON.stringify(o));
    if (i === undefined) {
      i = approvalPool.length;
      approvalPool.push(o as unknown as OrgApproval);
      approvalIndex.set(sig + JSON.stringify(o), i);
    }
    return { $approval: i };
  }
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, k === "keys" ? x : compact(x)]));
}
const body = compact(doc) as Record<string, unknown>;
const json = JSON.stringify({ ...body, approvals: approvalPool }, null, 1) + "\n";
if (process.argv.includes("--check")) {
  const disk = readFileSync(OUT, "utf8");
  if (disk !== json) {
    console.error(`${OUT} is stale; rerun without --check`);
    process.exit(1);
  }
  console.log("org-authority vectors are fresh");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
  console.log(`wrote ${OUT}`);
}
