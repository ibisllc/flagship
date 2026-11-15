/**
 * Enterprise accounts (docs/enterprise-accounts.md, phase E1): the org authority record (OAR) and
 * its chain, collected k-of-n approvals, seat grants with scopes, freezes, the founder's removal
 * with notice and veto, bylaws and their overturn ceremony, and the one authority predicate boxes
 * and `.com` run for org orders. Vectors: test-vectors/org-authority/ (tools/org-authority-vectors.ts).
 *
 * Orgs are strict from creation: every signature here is the hybrid Ed25519 + ML-DSA-65 suite over
 * a key with a verified `pq-key-binding`, checked through `verifyCriticalSignature`; a classical
 * signature is refused everywhere.
 *
 * Canonical forms (all `|`-joined, lowercase hex, Unix ms):
 *
 *   flagship/org-authority/v1|<orgId>|<version>|<prevHash>|<adminsHash>|<bylawsHash>|<founderSeatId>|<kGov>|<kGrant>|<kDestroy>|<kSite>|<issuedAt>
 *   flagship/org-admins/v1|<seatId>:<kind>:<ed25519Hex>:<mldsaHex>,...           (sorted; hash domain)
 *   flagship/org-bylaws/v1|<overturnK>|<overturnSeats sorted "," or *>|<vetoK>     (hash domain)
 *   flagship/org-approval/v1|<orgId>|<oarVersion>|<purposeTag>|<orderSha256>|<seatId>|<adminKeyId>|<notAfter>|<issuedAt>
 *   flagship/org-delayed-change/v1|<orgId>|<oarVersion>|<kind>|<nextRecordSha256>|<effectiveAt>|<issuedAt>
 *   flagship/org-veto/v1|<orgId>|<noticeSha256>|<issuedAt>
 *   flagship/org-seat-invite/v1|<orgId>|<seatId>|<labelSha256>|<rolesHash>|<oarVersion>|<issuedAt>|<expiresAt>
 *   flagship/org-seat-accept/v1|<orgId>|<seatId>|<inviteSha256>|<memberKeyId>|<adminKeyIdOrEmpty>|<issuedAt>
 *   flagship/org-seat-grant/v1|<orgId>|<seatId>|<labelSha256>|<memberKeyId>|<adminKeyIdOrEmpty>|<rolesHash>|<oarVersion>|<issuedAt>|<expiresAt>
 *   flagship/org-seat-roles/v1|<role line>;...                                    (sorted; hash domain)
 *   flagship/org-seat-revoke/v1|<orgId>|<seatId>|<reason>|<oarVersion>|<issuedAt>
 *   flagship/org-seat-freeze/v1|<orgId>|<seatId>|<untilMs>|<oarVersion>|<issuedAt>
 *   flagship/org-overturn/v1|<orgId>|<freezeSha256>|<oarVersion>|<issuedAt>
 *   flagship/org-seat-sas/v1|<inviteSha256>|<memberKeyId>|<adminKeyIdOrEmpty>       (hash domain)
 */
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { hex } from "./canonicalBase.js";
import type { PolicyState } from "./assurancePolicy.js";
import { SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, hybridSigKeygen, hybridSign, pqKeyId } from "./pqHybrid.js";
import {
  PqTrustError,
  messagePurpose,
  pqBindingPublicKey,
  pqKeyBindingFromWire,
  verifyCriticalSignature,
  verifyPqKeyBinding,
  type PqKeyBindingWire,
  type VerifiedPqKeyBinding,
} from "./pqTrust.js";
import type { Bytes } from "./types.js";

export const TAG_ORG_AUTHORITY = "flagship/org-authority/v1";
export const TAG_ORG_ADMINS = "flagship/org-admins/v1";
export const TAG_ORG_BYLAWS = "flagship/org-bylaws/v1";
export const TAG_ORG_APPROVAL = "flagship/org-approval/v1";
export const TAG_ORG_DELAYED_CHANGE = "flagship/org-delayed-change/v1";
export const TAG_ORG_VETO = "flagship/org-veto/v1";
export const TAG_ORG_SEAT_INVITE = "flagship/org-seat-invite/v1";
export const TAG_ORG_SEAT_ACCEPT = "flagship/org-seat-accept/v1";
export const TAG_ORG_SEAT_GRANT = "flagship/org-seat-grant/v1";
export const TAG_ORG_SEAT_ROLES = "flagship/org-seat-roles/v1";
export const TAG_ORG_SEAT_REVOKE = "flagship/org-seat-revoke/v1";
export const TAG_ORG_SEAT_FREEZE = "flagship/org-seat-freeze/v1";
export const TAG_ORG_OVERTURN = "flagship/org-overturn/v1";
export const TAG_ORG_SEAT_SAS = "flagship/org-seat-sas/v1";
export const TAG_ORG_SEAT_MEMBER_KDF = "flagship/org-seat-member/v1";
export const TAG_ORG_SEAT_MEMBER_PQ_KDF = "flagship/org-seat-member-pq/v1";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const ORG_FREEZE_MAX_MS = 72 * HOUR;
export const ORG_FREEZE_COOLDOWN_MS = 7 * DAY;
export const ORG_FOUNDER_NOTICE_MS = 7 * DAY;
export const ORG_RECOVERY_NOTICE_MS = 14 * DAY;
export const ORG_PREVIOUS_OAR_GRACE_MS = 24 * HOUR;
export const ORG_APPROVAL_MAX_LIFETIME_MS = 7 * DAY;
export const ORG_GRANT_MAX_LIFETIME_MS = 400 * DAY;
export const ORG_INVITE_MAX_LIFETIME_MS = 14 * DAY;
export const ORG_MAX_SKEW_MS = 5 * 60 * 1000;
export const ORG_K_MAX = 7;
export const ORG_MAX_ADMINS = 32;
export const ORG_MAX_ROLE_TARGETS = 256;
export const ORG_GENESIS_PREV = "0".repeat(64);

const HYBRID = "hybrid-ed25519-mldsa65/v1" as const;
const STRICT: PolicyState = {
  scope: { kind: "installation", id: "org" },
  profile: "strict",
  rollout: "enforced",
  generation: 1,
  headDigest: "0".repeat(128),
  enforcedEver: true,
};

export type OrgErrorCode =
  | "malformed"
  | "wrong-org"
  | "version-gap"
  | "prev-hash"
  | "not-after-previous"
  | "future"
  | "expired"
  | "thresholds"
  | "founder"
  | "bylaws"
  | "binding"
  | "bad-signature"
  | "order-mismatch"
  | "stale-oar"
  | "unknown-signer"
  | "not-an-admin"
  | "frozen-signer"
  | "duplicate-signer"
  | "threshold"
  | "custody"
  | "scope"
  | "consent-missing"
  | "removed-signer"
  | "notice-early"
  | "notice-vetoed"
  | "notice-invalid"
  | "overturn-invalid"
  | "freeze-too-long"
  | "freeze-cooldown"
  | "freeze-self"
  | "seat-revoked"
  | "seat-is-org-admin"
  | "seat-unknown"
  | "label-missing";

export class OrgAuthorityError extends Error {
  readonly code: OrgErrorCode;
  constructor(code: OrgErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "OrgAuthorityError";
    this.code = code;
  }
}

const fail = (code: OrgErrorCode, detail?: string): never => {
  throw new OrgAuthorityError(code, detail);
};

const enc = (s: string): Bytes => new TextEncoder().encode(s);
export const orgSha256Hex = (b: Bytes): string => hex(sha256(b));

const HEX16 = /^[0-9a-f]{32}$/;
const HEX32 = /^[0-9a-f]{64}$/;
const SERVER = /^[a-z0-9][a-z0-9.-]{0,252}$/;
const SERVICE_REF = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const REASON = /^[a-z0-9][a-z0-9-]{0,47}$/;

const isUint = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
function uint(name: string, n: unknown): number {
  if (!isUint(n)) fail("malformed", name);
  return n as number;
}
function match(name: string, re: RegExp, v: unknown): string {
  if (typeof v !== "string" || !re.test(v)) fail("malformed", name);
  return v as string;
}

// ── the record ───────────────────────────────────────────────────────────

/** `admin` holds authority; `board` counts only for overturns and vetoes; `recovery` only for delayed OAR changes. */
export type OrgAdminKind = "admin" | "board" | "recovery";

/**
 * Where a seat's admin key lives (docs/webapp-key-custody.md items 1 and 3). `hardware`: a phone's
 * hardware-wrapped key (the default, and what every record before custody labels means). `browser`:
 * "Browser: software key, unlocked with a passkey". Signed into the record, grant and accept, so
 * every box and admin sees it; encoded only when `browser`, so older records keep their bytes.
 */
export type OrgCustody = "hardware" | "browser";

export interface OrgAdminEntry {
  seatId: string;
  kind: OrgAdminKind;
  custody?: OrgCustody;
  /** The seat admin key's binding: role `org-seat-admin`, subject `<orgId>:<seatId>`. */
  binding: PqKeyBindingWire;
}

export interface OrgBylaws {
  /** Who signs to overturn a freeze or a founder's removal: named seats of the record, or `*` = every `admin`. */
  overturnSeats: string[] | "*";
  /** How many of them; 0 = a majority of the set at the time. */
  overturnK: number;
  /** How many other admins veto a founder's removal notice. */
  vetoK: number;
  /** `hardware`: admin keys must be hardware custody (no browser admins). Default `any`. */
  adminCustody?: "any" | "hardware";
  /** Default true: a quorum of two or more needs at least one hardware-custody approval. */
  quorumHardware?: boolean;
}

const custodyOf = (c: unknown): OrgCustody => {
  if (c === undefined || c === "hardware") return "hardware";
  if (c === "browser") return "browser";
  return fail("malformed", "custody");
};
const custodySuffix = (c: unknown): string => (custodyOf(c) === "browser" ? "|browser" : "");

export interface OrgAuthorityRecord {
  orgId: string;
  version: number;
  prevHash: string;
  admins: OrgAdminEntry[];
  bylaws: OrgBylaws;
  founderSeatId: string;
  kGov: number;
  kGrant: number;
  kDestroy: number;
  kSite: number;
  issuedAt: number;
}

export function orgSeatSubject(orgId: string, seatId: string): string {
  return `${orgId}:${seatId}`;
}

export function canonicalOrgAdmins(admins: readonly OrgAdminEntry[]): Bytes {
  const lines = admins.map((a) => {
    match("seatId", HEX16, a.seatId);
    if (a.kind !== "admin" && a.kind !== "board" && a.kind !== "recovery") fail("malformed", "kind");
    match("ed25519PubHex", HEX32, a.binding?.ed25519PubHex);
    match("mldsaPubHex", /^[0-9a-f]{3904}$/, a.binding?.mldsaPubHex);
    return `${a.seatId}:${a.kind}:${a.binding.ed25519PubHex}:${a.binding.mldsaPubHex}${custodyOf(a.custody) === "browser" ? ":browser" : ""}`;
  });
  return enc(`${TAG_ORG_ADMINS}|${[...lines].sort().join(",")}`);
}

export function canonicalOrgBylaws(b: OrgBylaws): Bytes {
  uint("overturnK", b.overturnK);
  uint("vetoK", b.vetoK);
  let seats: string;
  if (b.overturnSeats === "*") seats = "*";
  else {
    if (!Array.isArray(b.overturnSeats) || b.overturnSeats.length === 0) fail("bylaws", "overturnSeats");
    for (const s of b.overturnSeats) match("overturnSeats", HEX16, s);
    seats = [...b.overturnSeats].sort().join(",");
  }
  if (b.adminCustody !== undefined && b.adminCustody !== "any" && b.adminCustody !== "hardware") fail("bylaws", "adminCustody");
  if (b.quorumHardware !== undefined && typeof b.quorumHardware !== "boolean") fail("bylaws", "quorumHardware");
  const extra = (b.adminCustody === "hardware" ? "|hardware-admins" : "") + (b.quorumHardware === false ? "|browser-quorums" : "");
  return enc(`${TAG_ORG_BYLAWS}|${b.overturnK}|${seats}|${b.vetoK}${extra}`);
}

export function canonicalOrgAuthority(r: OrgAuthorityRecord): Bytes {
  match("orgId", HEX16, r.orgId);
  match("prevHash", HEX32, r.prevHash);
  match("founderSeatId", HEX16, r.founderSeatId);
  for (const [k, v] of Object.entries({ version: r.version, kGov: r.kGov, kGrant: r.kGrant, kDestroy: r.kDestroy, kSite: r.kSite, issuedAt: r.issuedAt })) uint(k, v);
  return enc(
    [
      TAG_ORG_AUTHORITY,
      r.orgId,
      r.version,
      r.prevHash,
      orgSha256Hex(canonicalOrgAdmins(r.admins)),
      orgSha256Hex(canonicalOrgBylaws(r.bylaws)),
      r.founderSeatId,
      r.kGov,
      r.kGrant,
      r.kDestroy,
      r.kSite,
      r.issuedAt,
    ].join("|"),
  );
}

export function orgAuthorityHash(r: OrgAuthorityRecord): string {
  return orgSha256Hex(canonicalOrgAuthority(r));
}

const authorityAdmins = (r: OrgAuthorityRecord) => r.admins.filter((a) => a.kind === "admin");

/** The seats of the overturn set, as of this record. */
export function orgOverturnSet(r: OrgAuthorityRecord): string[] {
  if (r.bylaws.overturnSeats === "*") return authorityAdmins(r).map((a) => a.seatId);
  return [...r.bylaws.overturnSeats];
}

/** How many of the overturn set must sign. */
export function orgOverturnThreshold(r: OrgAuthorityRecord): number {
  const n = orgOverturnSet(r).length;
  return r.bylaws.overturnK === 0 ? Math.floor(n / 2) + 1 : r.bylaws.overturnK;
}

/** The strictest ceremony: changing the bylaws or moving the founder role. */
export function orgBylawsThreshold(r: OrgAuthorityRecord): number {
  const n = authorityAdmins(r).length;
  return Math.min(n, Math.max(r.kGov, r.kDestroy, r.kSite, orgOverturnThreshold(r), Math.ceil((2 * n) / 3)));
}

/** Structural rules every record meets (no signatures checked here). */
export function checkOrgAuthorityShape(r: OrgAuthorityRecord): void {
  canonicalOrgAuthority(r);
  if (!Array.isArray(r.admins) || r.admins.length === 0 || r.admins.length > ORG_MAX_ADMINS) fail("malformed", "admins");
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const a of r.admins) {
    if (ids.has(a.seatId)) fail("malformed", "duplicate seat");
    ids.add(a.seatId);
    if (keys.has(a.binding.ed25519PubHex)) fail("malformed", "duplicate key");
    keys.add(a.binding.ed25519PubHex);
  }
  const n = authorityAdmins(r).length;
  if (n === 0) fail("thresholds", "no admin");
  const founder = r.admins.find((a) => a.seatId === r.founderSeatId);
  if (!founder || founder.kind !== "admin") fail("founder");
  const floor = Math.min(2, n);
  for (const [name, k] of [["kGov", r.kGov], ["kGrant", r.kGrant], ["kDestroy", r.kDestroy], ["kSite", r.kSite]] as const) {
    if (k < 1 || k > n || k > ORG_K_MAX) fail("thresholds", name);
  }
  if (r.kGov < floor || r.kDestroy < floor) fail("thresholds", "floor");
  if (r.bylaws.overturnSeats !== "*") {
    if (new Set(r.bylaws.overturnSeats).size !== r.bylaws.overturnSeats.length) fail("bylaws", "duplicate seat");
    for (const s of r.bylaws.overturnSeats) {
      const a = r.admins.find((x) => x.seatId === s);
      if (!a || a.kind === "recovery") fail("bylaws", "overturn seat");
    }
  }
  const setSize = orgOverturnSet(r).length;
  if (setSize === 0 || orgOverturnThreshold(r) > setSize || orgOverturnThreshold(r) > ORG_K_MAX) fail("bylaws", "overturnK");
  if (r.bylaws.vetoK < 1 || r.bylaws.vetoK > ORG_K_MAX) fail("bylaws", "vetoK");
  if (r.bylaws.adminCustody === "hardware") {
    for (const a of r.admins) if (custodyOf(a.custody) === "browser") fail("custody", `${a.seatId}: the bylaws need hardware custody for admins`);
  }
}

/**
 * The bylaws' quorum rule: a quorum of two or more needs at least one approval by a hardware-custody
 * key, unless the bylaws turned it off. `custodyOfSigner` answers for each counted signer.
 */
export function checkOrgQuorumCustody(r: OrgAuthorityRecord, k: number, signers: readonly string[], custodyOfSigner: (seatId: string) => OrgCustody): void {
  if (r.bylaws.quorumHardware === false || k < 2 || signers.length === 0) return;
  if (!signers.some((s) => custodyOfSigner(s) === "hardware")) fail("custody", "a quorum of two or more needs a hardware approval");
}

const adminCustody = (r: OrgAuthorityRecord) => (s: string): OrgCustody => custodyOf(r.admins.find((a) => a.seatId === s)?.custody);

// ── approvals ────────────────────────────────────────────────────────────

export interface OrgApproval {
  orgId: string;
  oarVersion: number;
  purposeTag: string;
  orderSha256: string;
  seatId: string;
  adminKeyId: string;
  notAfter: number;
  issuedAt: number;
  /** Hybrid signature, lowercase hex. */
  signature: string;
}

export type OrgApprovalStatement = Omit<OrgApproval, "signature">;

export function canonicalOrgApproval(a: OrgApprovalStatement): Bytes {
  match("orgId", HEX16, a.orgId);
  match("orderSha256", HEX32, a.orderSha256);
  match("seatId", HEX16, a.seatId);
  match("adminKeyId", HEX32, a.adminKeyId);
  if (typeof a.purposeTag !== "string" || !/^flagship\/[a-z0-9/-]+\/v[1-9][0-9]*$/.test(a.purposeTag)) fail("malformed", "purposeTag");
  for (const [k, v] of Object.entries({ oarVersion: a.oarVersion, notAfter: a.notAfter, issuedAt: a.issuedAt })) uint(k, v);
  return enc([TAG_ORG_APPROVAL, a.orgId, a.oarVersion, a.purposeTag, a.orderSha256, a.seatId, a.adminKeyId, a.notAfter, a.issuedAt].join("|"));
}

/** The hybrid key id of a binding's two keys. */
export function orgKeyIdHex(b: Pick<PqKeyBindingWire, "ed25519PubHex" | "mldsaPubHex">): string {
  return hex(pqKeyId(SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, pqBindingPublicKey(b)));
}

/** Signs one admin's approval of `order` (its canonical bytes) with the seat admin key's hybrid secret. */
export function signOrgApproval(
  args: { orgId: string; oarVersion: number; order: Bytes; seatId: string; adminKeyId: string; issuedAt: number; notAfter: number },
  hybridSecret: Bytes,
  opts: { deterministic?: boolean } = {},
): OrgApproval {
  const st: OrgApprovalStatement = {
    orgId: args.orgId,
    oarVersion: args.oarVersion,
    purposeTag: messagePurpose(args.order),
    orderSha256: orgSha256Hex(args.order),
    seatId: args.seatId,
    adminKeyId: args.adminKeyId,
    notAfter: args.notAfter,
    issuedAt: args.issuedAt,
  };
  const sig = hybridSign(hybridSecret, TAG_ORG_APPROVAL, canonicalOrgApproval(st), opts);
  return { ...st, signature: hex(sig) };
}

export function orgApprovalFromWire(w: unknown): OrgApproval {
  if (typeof w !== "object" || w === null || Array.isArray(w)) return fail("malformed", "approval");
  const o = w as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (keys !== "adminKeyId,issuedAt,notAfter,oarVersion,orderSha256,orgId,purposeTag,seatId,signature") fail("malformed", "approval keys");
  if (typeof o.signature !== "string" || !/^[0-9a-f]{6746}$/.test(o.signature)) fail("malformed", "approval signature");
  const a = o as unknown as OrgApproval;
  canonicalOrgApproval(a);
  return a;
}

/** Checks one approval's signature under a verified binding; `order` must hash to its orderSha256. */
function verifyApprovalSignature(a: OrgApproval, binding: VerifiedPqKeyBinding): void {
  if (binding.keyIdHex !== a.adminKeyId) fail("unknown-signer", "key id");
  try {
    verifyCriticalSignature({
      message: canonicalOrgApproval(a),
      expectedPurpose: TAG_ORG_APPROVAL,
      envelope: { suite: HYBRID, signature: a.signature },
      signerEd25519PubHex: binding.ed25519PubHex,
      binding,
      policy: STRICT,
    });
  } catch (e) {
    if (e instanceof PqTrustError) fail("bad-signature", e.code);
    throw e;
  }
}

// ── delayed changes, vetoes, freezes, overturns ─────────────────────────

export type OrgDelayedKind = "founder-removal" | "recovery";

export interface OrgDelayedChange {
  orgId: string;
  oarVersion: number;
  kind: OrgDelayedKind;
  nextRecordSha256: string;
  effectiveAt: number;
  issuedAt: number;
}

export function canonicalOrgDelayedChange(c: OrgDelayedChange): Bytes {
  match("orgId", HEX16, c.orgId);
  match("nextRecordSha256", HEX32, c.nextRecordSha256);
  if (c.kind !== "founder-removal" && c.kind !== "recovery") fail("malformed", "kind");
  for (const [k, v] of Object.entries({ oarVersion: c.oarVersion, effectiveAt: c.effectiveAt, issuedAt: c.issuedAt })) uint(k, v);
  return enc([TAG_ORG_DELAYED_CHANGE, c.orgId, c.oarVersion, c.kind, c.nextRecordSha256, c.effectiveAt, c.issuedAt].join("|"));
}

export interface OrgVeto {
  orgId: string;
  noticeSha256: string;
  issuedAt: number;
}

export function canonicalOrgVeto(v: OrgVeto): Bytes {
  match("orgId", HEX16, v.orgId);
  match("noticeSha256", HEX32, v.noticeSha256);
  uint("issuedAt", v.issuedAt);
  return enc([TAG_ORG_VETO, v.orgId, v.noticeSha256, v.issuedAt].join("|"));
}

export interface OrgSeatFreeze {
  orgId: string;
  seatId: string;
  untilMs: number;
  oarVersion: number;
  issuedAt: number;
}

export function canonicalOrgSeatFreeze(f: OrgSeatFreeze): Bytes {
  match("orgId", HEX16, f.orgId);
  match("seatId", HEX16, f.seatId);
  for (const [k, v] of Object.entries({ untilMs: f.untilMs, oarVersion: f.oarVersion, issuedAt: f.issuedAt })) uint(k, v);
  return enc([TAG_ORG_SEAT_FREEZE, f.orgId, f.seatId, f.untilMs, f.oarVersion, f.issuedAt].join("|"));
}

export interface OrgOverturn {
  orgId: string;
  freezeSha256: string;
  oarVersion: number;
  issuedAt: number;
}

export function canonicalOrgOverturn(o: OrgOverturn): Bytes {
  match("orgId", HEX16, o.orgId);
  match("freezeSha256", HEX32, o.freezeSha256);
  for (const [k, v] of Object.entries({ oarVersion: o.oarVersion, issuedAt: o.issuedAt })) uint(k, v);
  return enc([TAG_ORG_OVERTURN, o.orgId, o.freezeSha256, o.oarVersion, o.issuedAt].join("|"));
}

/** A signed object and the approvals collected for it. */
export interface OrgSigned<T> {
  body: T;
  approvals: OrgApproval[];
}

// ── the chain ───────────────────────────────────────────────────────────

/**
 * One step of the chain. `via`:
 *   genesis          version 0, approved by every seat it lists
 *   direct           k_gov of the previous record's admins (the strictest threshold for bylaws or founder)
 *   founder-removal  the founder's notice, 7 days, no veto; removes exactly one admin
 *   recovery         a notice approved by k_gov counting recovery seats, 14 days, no veto
 *   overturn         the bylaws' overturn set restores the admins a founder-removal took out
 * `approvals` approve the record (and carry each new or re-keyed seat's consent); `notice` carries the
 * delayed change and its approvals.
 */
export interface OrgAuthorityEntry {
  record: OrgAuthorityRecord;
  via: "genesis" | "direct" | "founder-removal" | "recovery" | "overturn";
  approvals: OrgApproval[];
  notice?: OrgSigned<OrgDelayedChange>;
  /** For `overturn`: the version a founder-removal produced. */
  overturnOf?: number;
}

export interface OrgVerifiedFreeze {
  seatId: string;
  bySeatId: string;
  issuedAt: number;
  untilMs: number;
  sha256: string;
}

export interface OrgAuthorityState {
  orgId: string;
  genesisHash: string;
  records: OrgAuthorityRecord[];
  bindings: Map<string, VerifiedPqKeyBinding>;
  current: OrgAuthorityRecord;
  currentHash: string;
}

function bindingKey(version: number, seatId: string): string {
  return `${version}:${seatId}`;
}

function verifyRecordBindings(r: OrgAuthorityRecord, now: number): Map<string, VerifiedPqKeyBinding> {
  const out = new Map<string, VerifiedPqKeyBinding>();
  for (const a of r.admins) {
    try {
      const b = verifyPqKeyBinding(pqKeyBindingFromWire(a.binding), {
        role: "org-seat-admin",
        subjectId: orgSeatSubject(r.orgId, a.seatId),
        ed25519PubHex: a.binding.ed25519PubHex,
        now,
      });
      out.set(a.seatId, b);
    } catch (e) {
      if (e instanceof PqTrustError) fail("binding", `${a.seatId}: ${e.code}`);
      throw e;
    }
  }
  return out;
}

interface ApprovalCheck {
  orgId: string;
  oarVersion: number;
  order: Bytes;
  now: number;
}

/** Checks each approval's fields and signature; returns signer seat ids. Refuses duplicates. */
function checkApprovals(
  approvals: readonly OrgApproval[],
  c: ApprovalCheck,
  keyOf: (seatId: string) => VerifiedPqKeyBinding | undefined,
  frozenAt: (seatId: string, t: number) => boolean,
): string[] {
  const purpose = messagePurpose(c.order);
  const digest = orgSha256Hex(c.order);
  const seen = new Set<string>();
  for (const raw of approvals) {
    const a = orgApprovalFromWire(raw);
    if (a.orgId !== c.orgId) fail("wrong-org");
    if (a.oarVersion !== c.oarVersion) fail("stale-oar");
    if (a.purposeTag !== purpose || a.orderSha256 !== digest) fail("order-mismatch");
    if (a.issuedAt > c.now + ORG_MAX_SKEW_MS) fail("future");
    if (a.notAfter < a.issuedAt || a.notAfter - a.issuedAt > ORG_APPROVAL_MAX_LIFETIME_MS) fail("malformed", "notAfter");
    if (seen.has(a.seatId)) fail("duplicate-signer");
    seen.add(a.seatId);
    const b = keyOf(a.seatId);
    if (!b) fail("unknown-signer", a.seatId);
    verifyApprovalSignature(a, b!);
    if (frozenAt(a.seatId, a.issuedAt)) fail("frozen-signer", a.seatId);
  }
  return [...seen];
}

const sameAdmin = (a: OrgAdminEntry, b: OrgAdminEntry) =>
  a.kind === b.kind && a.binding.ed25519PubHex === b.binding.ed25519PubHex && a.binding.mldsaPubHex === b.binding.mldsaPubHex;

/** The record a founder's removal of `target` produces from `p` (thresholds clamped to what remains). */
export function orgFounderRemovalOf(p: OrgAuthorityRecord, target: string, issuedAt: number): OrgAuthorityRecord {
  if (target === p.founderSeatId) fail("founder", "the founder cannot remove itself this way");
  const t = p.admins.find((a) => a.seatId === target);
  if (!t || t.kind !== "admin") fail("seat-unknown", "target is not an admin");
  const admins = p.admins.filter((a) => a.seatId !== target);
  const n = admins.filter((a) => a.kind === "admin").length;
  const clamp = (k: number) => Math.max(1, Math.min(k, n));
  let bylaws = p.bylaws;
  if (bylaws.overturnSeats !== "*" && bylaws.overturnSeats.includes(target)) {
    const seats = bylaws.overturnSeats.filter((s) => s !== target);
    bylaws = {
      overturnSeats: seats.length > 0 ? seats : "*",
      overturnK: bylaws.overturnK === 0 ? 0 : Math.min(bylaws.overturnK, seats.length > 0 ? seats.length : n),
      vetoK: bylaws.vetoK,
    };
  }
  return {
    orgId: p.orgId,
    version: p.version + 1,
    prevHash: orgAuthorityHash(p),
    admins,
    bylaws,
    founderSeatId: p.founderSeatId,
    kGov: clamp(p.kGov),
    kGrant: clamp(p.kGrant),
    kDestroy: clamp(p.kDestroy),
    kSite: clamp(p.kSite),
    issuedAt,
  };
}

/** The record an overturn produces: `p` plus the admins the removal at `removed` took out, as they were. */
export function orgOverturnOf(p: OrgAuthorityRecord, before: OrgAuthorityRecord, after: OrgAuthorityRecord, issuedAt: number): OrgAuthorityRecord {
  const back = before.admins.filter((a) => !after.admins.some((x) => x.seatId === a.seatId));
  const admins = [...p.admins];
  for (const a of back) if (!admins.some((x) => x.seatId === a.seatId)) admins.push(a);
  return { ...p, version: p.version + 1, prevHash: orgAuthorityHash(p), admins, issuedAt };
}

export interface OrgChainOptions {
  /** The genesis hash the verifier pinned (install blob, `.com` row). */
  genesisHash: string;
  now: number;
  /** Signed freezes and overturns known to the verifier; invalid ones are ignored. */
  freezes?: readonly OrgSigned<OrgSeatFreeze>[];
  overturns?: readonly OrgSigned<OrgOverturn>[];
  /** Signed vetoes known to the verifier. */
  vetoes?: readonly OrgSigned<OrgVeto>[];
}

/** Verifies the chain from genesis. Throws `OrgAuthorityError`. */
export function verifyOrgAuthorityChain(entries: readonly OrgAuthorityEntry[], opts: OrgChainOptions): OrgAuthorityState {
  if (!Array.isArray(entries) || entries.length === 0) fail("malformed", "empty chain");
  const records: OrgAuthorityRecord[] = [];
  const bindings = new Map<string, VerifiedPqKeyBinding>();
  const state = (): OrgAuthorityState => ({
    orgId: records[0]!.orgId,
    genesisHash: orgAuthorityHash(records[0]!),
    records: [...records],
    bindings,
    current: records[records.length - 1]!,
    currentHash: orgAuthorityHash(records[records.length - 1]!),
  });
  for (const e of entries) {
    const r = e.record;
    checkOrgAuthorityShape(r);
    if (r.issuedAt > opts.now + ORG_MAX_SKEW_MS) fail("future", `v${r.version}`);
    const verified = verifyRecordBindings(r, opts.now);
    const order = canonicalOrgAuthority(r);
    if (records.length === 0) {
      if (e.via !== "genesis" || r.version !== 0 || r.prevHash !== ORG_GENESIS_PREV) fail("version-gap", "genesis");
      if (orgAuthorityHash(r) !== opts.genesisHash) fail("prev-hash", "genesis hash");
      const signers = checkApprovals(e.approvals, { orgId: r.orgId, oarVersion: 0, order, now: opts.now }, (s) => verified.get(s), () => false);
      for (const a of r.admins) if (!signers.includes(a.seatId)) fail("consent-missing", a.seatId);
    } else {
      const p = records[records.length - 1]!;
      if (r.orgId !== p.orgId) fail("wrong-org");
      if (r.version !== p.version + 1) fail("version-gap");
      if (r.prevHash !== orgAuthorityHash(p)) fail("prev-hash");
      if (r.issuedAt <= p.issuedAt) fail("not-after-previous");
      const st = state();
      const frozen = frozenPredicate(st, opts);
      verifyTransition(e, p, r, st, verified, frozen, opts);
    }
    records.push(r);
    for (const [seat, b] of verified) bindings.set(bindingKey(r.version, seat), b);
  }
  return state();
}

function verifyTransition(
  e: OrgAuthorityEntry,
  p: OrgAuthorityRecord,
  r: OrgAuthorityRecord,
  st: OrgAuthorityState,
  verified: Map<string, VerifiedPqKeyBinding>,
  frozen: (seatId: string, t: number) => boolean,
  opts: OrgChainOptions,
): void {
  const order = canonicalOrgAuthority(r);
  const prevKey = (s: string) => st.bindings.get(bindingKey(p.version, s));
  const kindOf = (s: string) => p.admins.find((a) => a.seatId === s)?.kind;
  const removed = p.admins.filter((a) => !r.admins.some((x) => x.seatId === a.seatId)).map((a) => a.seatId);
  const newcomers = r.admins.filter((a) => {
    const old = p.admins.find((x) => x.seatId === a.seatId);
    return !old || old.binding.ed25519PubHex !== a.binding.ed25519PubHex || old.binding.mldsaPubHex !== a.binding.mldsaPubHex;
  });
  const bylawsChanged = orgSha256Hex(canonicalOrgBylaws(p.bylaws)) !== orgSha256Hex(canonicalOrgBylaws(r.bylaws));
  const founderMoved = p.founderSeatId !== r.founderSeatId;

  // Consent: each new or re-keyed seat approves the record with its new key, under the new version.
  const consent = e.approvals.filter((a) => newcomers.some((n) => n.seatId === a.seatId) && a.oarVersion === r.version);
  const ordinary = e.approvals.filter((a) => !consent.includes(a));
  const consenting = checkApprovals(consent, { orgId: r.orgId, oarVersion: r.version, order, now: opts.now }, (s) => verified.get(s), () => false);
  for (const n of newcomers) if (!consenting.includes(n.seatId)) fail("consent-missing", n.seatId);
  if (founderMoved && !newcomers.some((n) => n.seatId === r.founderSeatId)) {
    if (!ordinary.some((a) => a.seatId === r.founderSeatId)) fail("consent-missing", "new founder");
  }

  switch (e.via) {
    case "direct": {
      const signers = checkApprovals(ordinary, { orgId: r.orgId, oarVersion: p.version, order, now: opts.now }, prevKey, frozen);
      for (const s of signers) {
        if (kindOf(s) !== "admin") fail("not-an-admin", s);
        if (removed.includes(s)) fail("removed-signer", s);
      }
      const k = bylawsChanged || founderMoved ? orgBylawsThreshold(p) : p.kGov;
      if (signers.length < k) fail("threshold", `${signers.length} of ${k}`);
      checkOrgQuorumCustody(p, k, signers, adminCustody(p));
      return;
    }
    case "founder-removal": {
      const n = e.notice;
      if (!n || n.body.kind !== "founder-removal") fail("notice-invalid");
      if (removed.length !== 1) fail("notice-invalid", "exactly one admin");
      const expected = orgFounderRemovalOf(p, removed[0]!, r.issuedAt);
      if (orgAuthorityHash(expected) !== orgAuthorityHash(r)) fail("notice-invalid", "record is not the removal");
      checkNotice(n!, p, r, ORG_FOUNDER_NOTICE_MS, opts);
      const signers = checkApprovals(n!.approvals, { orgId: p.orgId, oarVersion: p.version, order: canonicalOrgDelayedChange(n!.body), now: opts.now }, prevKey, frozen);
      if (signers.length !== 1 || signers[0] !== p.founderSeatId) fail("notice-invalid", "only the founder");
      const noticeHash = orgSha256Hex(canonicalOrgDelayedChange(n!.body));
      const eligible = new Set(p.admins.filter((a) => a.kind === "admin" && a.seatId !== p.founderSeatId && a.seatId !== removed[0]).map((a) => a.seatId));
      const set = new Set(orgOverturnSet(p).filter((s) => s !== removed[0]));
      for (const v of opts.vetoes ?? []) {
        const count = vetoSigners(v, noticeHash, n!.body, p, prevKey, frozen, opts);
        if (count === null) continue;
        if (count.filter((s) => eligible.has(s)).length >= p.bylaws.vetoK) fail("notice-vetoed");
        if (count.filter((s) => set.has(s)).length >= orgOverturnThreshold(p)) fail("notice-vetoed");
      }
      if (e.approvals.length !== consent.length) fail("malformed", "stray approvals");
      return;
    }
    case "recovery": {
      const n = e.notice;
      if (!n || n.body.kind !== "recovery") fail("notice-invalid");
      checkNotice(n!, p, r, ORG_RECOVERY_NOTICE_MS, opts);
      const signers = checkApprovals(n!.approvals, { orgId: p.orgId, oarVersion: p.version, order: canonicalOrgDelayedChange(n!.body), now: opts.now }, prevKey, frozen);
      for (const s of signers) if (kindOf(s) !== "admin" && kindOf(s) !== "recovery") fail("not-an-admin", s);
      if (!signers.some((s) => kindOf(s) === "recovery")) fail("notice-invalid", "no recovery seat");
      const k = bylawsChanged || founderMoved ? orgBylawsThreshold(p) : p.kGov;
      if (signers.length < k) fail("threshold", `${signers.length} of ${k}`);
      checkOrgQuorumCustody(p, k, signers, adminCustody(p));
      const noticeHash = orgSha256Hex(canonicalOrgDelayedChange(n!.body));
      const eligible = new Set(p.admins.filter((a) => a.kind === "admin" && !signers.includes(a.seatId)).map((a) => a.seatId));
      for (const v of opts.vetoes ?? []) {
        const count = vetoSigners(v, noticeHash, n!.body, p, prevKey, frozen, opts);
        if (count !== null && count.some((s) => eligible.has(s))) fail("notice-vetoed");
      }
      if (e.approvals.length !== consent.length) fail("malformed", "stray approvals");
      return;
    }
    case "overturn": {
      const at = e.overturnOf;
      if (!isUint(at) || at < 1 || at > p.version) fail("overturn-invalid");
      const idx = st.records.findIndex((x) => x.version === at);
      const after = st.records[idx]!;
      const before = st.records[idx - 1]!;
      if (!before || before.founderSeatId !== after.founderSeatId) fail("overturn-invalid");
      const removedThen = before.admins.filter((a) => !after.admins.some((x) => x.seatId === a.seatId));
      if (removedThen.length !== 1 || orgAuthorityHash(orgFounderRemovalOf(before, removedThen[0]!.seatId, after.issuedAt)) !== orgAuthorityHash(after)) {
        fail("overturn-invalid", "not a founder removal");
      }
      if (p.admins.some((a) => a.seatId === removedThen[0]!.seatId)) fail("overturn-invalid", "already back");
      if (orgAuthorityHash(orgOverturnOf(p, before, after, r.issuedAt)) !== orgAuthorityHash(r)) fail("overturn-invalid", "record is not the restore");
      const restoredSeat = removedThen[0]!.seatId;
      const restoredConsent = e.approvals.filter((a) => a.seatId === restoredSeat && a.oarVersion === r.version);
      const others = e.approvals.filter((a) => !restoredConsent.includes(a));
      const restoredKey = (s: string) => (s === restoredSeat ? verified.get(s) : undefined);
      const back = checkApprovals(restoredConsent, { orgId: r.orgId, oarVersion: r.version, order, now: opts.now }, restoredKey, () => false);
      if (!back.includes(restoredSeat)) fail("consent-missing", restoredSeat);
      const signers = checkApprovals(others, { orgId: r.orgId, oarVersion: p.version, order, now: opts.now }, prevKey, frozen);
      const set = new Set(orgOverturnSet(p));
      const counted = signers.filter((s) => set.has(s));
      if (counted.length !== signers.length) fail("not-an-admin", "outside the overturn set");
      if (counted.length < orgOverturnThreshold(p)) fail("threshold", `${counted.length} of ${orgOverturnThreshold(p)}`);
      checkOrgQuorumCustody(p, orgOverturnThreshold(p), counted, adminCustody(p));
      return;
    }
    default:
      fail("malformed", "via");
  }
}

function checkNotice(n: OrgSigned<OrgDelayedChange>, p: OrgAuthorityRecord, r: OrgAuthorityRecord, wait: number, opts: OrgChainOptions): void {
  const b = n.body;
  canonicalOrgDelayedChange(b);
  if (b.orgId !== p.orgId || b.oarVersion !== p.version) fail("notice-invalid", "version");
  if (r.issuedAt !== b.effectiveAt) fail("notice-invalid", "record must be dated at effectiveAt");
  if (b.nextRecordSha256 !== orgAuthorityHash(r)) fail("notice-invalid", "names another record");
  if (b.effectiveAt !== b.issuedAt + wait) fail("notice-invalid", "notice period");
  if (b.issuedAt < p.issuedAt) fail("notice-invalid", "older than the record it changes");
  if (opts.now < b.effectiveAt) fail("notice-early");
}

function vetoSigners(
  v: OrgSigned<OrgVeto>,
  noticeHash: string,
  notice: OrgDelayedChange,
  p: OrgAuthorityRecord,
  keyOf: (s: string) => VerifiedPqKeyBinding | undefined,
  frozen: (seatId: string, t: number) => boolean,
  opts: OrgChainOptions,
): string[] | null {
  try {
    if (v.body.orgId !== p.orgId || v.body.noticeSha256 !== noticeHash) return null;
    if (v.body.issuedAt >= notice.effectiveAt || v.body.issuedAt < notice.issuedAt) return null;
    return checkApprovals(v.approvals, { orgId: p.orgId, oarVersion: p.version, order: canonicalOrgVeto(v.body), now: opts.now }, keyOf, frozen);
  } catch {
    return null;
  }
}

// ── freezes ──────────────────────────────────────────────────────────────

/**
 * The freezes that hold: each signed by one `admin` of the record it names (not frozen itself, not
 * its own seat), at most 72 h long, at most one per signer per 7 days (a later one inside the
 * cool-down is void), and not overturned by the bylaws' set.
 */
export function verifiedOrgFreezes(st: Pick<OrgAuthorityState, "records" | "bindings" | "orgId">, opts: Pick<OrgChainOptions, "freezes" | "overturns" | "now">): OrgVerifiedFreeze[] {
  const raw = [...(opts.freezes ?? [])].sort((a, b) => a.body.issuedAt - b.body.issuedAt);
  const out: OrgVerifiedFreeze[] = [];
  const lastBy = new Map<string, number>();
  for (const f of raw) {
    try {
      const v = checkFreeze(f, st, opts.now, out);
      const last = lastBy.get(v.bySeatId);
      if (last !== undefined && v.issuedAt - last < ORG_FREEZE_COOLDOWN_MS) continue;
      lastBy.set(v.bySeatId, v.issuedAt);
      if (overturned(v, st, opts)) continue;
      out.push(v);
    } catch {
      continue;
    }
  }
  return out;
}

function recordAt(st: Pick<OrgAuthorityState, "records">, version: number): OrgAuthorityRecord | undefined {
  return st.records.find((r) => r.version === version);
}

function checkFreeze(f: OrgSigned<OrgSeatFreeze>, st: Pick<OrgAuthorityState, "records" | "bindings" | "orgId">, now: number, earlier: readonly OrgVerifiedFreeze[]): OrgVerifiedFreeze {
  const b = f.body;
  const order = canonicalOrgSeatFreeze(b);
  if (b.orgId !== st.orgId) fail("wrong-org");
  const r = recordAt(st, b.oarVersion);
  if (!r) fail("stale-oar");
  if (b.untilMs <= b.issuedAt) fail("malformed", "untilMs");
  if (b.untilMs - b.issuedAt > ORG_FREEZE_MAX_MS) fail("freeze-too-long");
  const frozen = (s: string, t: number) => earlier.some((x) => x.seatId === s && x.issuedAt <= t && t < x.untilMs);
  const signers = checkApprovals(f.approvals, { orgId: st.orgId, oarVersion: b.oarVersion, order, now }, (s) => st.bindings.get(bindingKey(b.oarVersion, s)), frozen);
  if (signers.length !== 1) fail("threshold", "a freeze has one signer");
  const by = signers[0]!;
  if (r!.admins.find((a) => a.seatId === by)?.kind !== "admin") fail("not-an-admin", by);
  if (by === b.seatId) fail("freeze-self");
  return { seatId: b.seatId, bySeatId: by, issuedAt: b.issuedAt, untilMs: b.untilMs, sha256: orgSha256Hex(order) };
}

function overturned(v: OrgVerifiedFreeze, st: Pick<OrgAuthorityState, "records" | "bindings" | "orgId">, opts: Pick<OrgChainOptions, "overturns" | "now">): boolean {
  for (const o of opts.overturns ?? []) {
    try {
      if (o.body.orgId !== st.orgId || o.body.freezeSha256 !== v.sha256) continue;
      const r = recordAt(st, o.body.oarVersion);
      if (!r) continue;
      const signers = checkApprovals(
        o.approvals,
        { orgId: st.orgId, oarVersion: r.version, order: canonicalOrgOverturn(o.body), now: opts.now },
        (s) => st.bindings.get(bindingKey(r.version, s)),
        () => false,
      );
      const set = new Set(orgOverturnSet(r).filter((s) => s !== v.seatId));
      if (signers.filter((s) => set.has(s)).length >= orgOverturnThreshold(r)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function frozenPredicate(st: Pick<OrgAuthorityState, "records" | "bindings" | "orgId">, opts: Pick<OrgChainOptions, "freezes" | "overturns" | "now">) {
  const fs = verifiedOrgFreezes(st, opts);
  return (seatId: string, t: number) => fs.some((f) => f.seatId === seatId && f.issuedAt <= t && t < f.untilMs);
}

/** Overturns a freeze, as the "Restore my access" ceremony collects it. */
export function orgOverturnFor(freeze: OrgSeatFreeze, oarVersion: number, issuedAt: number): OrgOverturn {
  return { orgId: freeze.orgId, freezeSha256: orgSha256Hex(canonicalOrgSeatFreeze(freeze)), oarVersion, issuedAt };
}

// ── seats ────────────────────────────────────────────────────────────────

export type OrgSeatRole =
  | { role: "member" }
  | { role: "server-admin"; servers: string[] | "*" }
  | { role: "service-admin"; apps: string[] }
  | { role: "servers-add" }
  | { role: "unlock"; servers: string[] };

export function canonicalOrgSeatRoles(roles: readonly OrgSeatRole[]): Bytes {
  if (!Array.isArray(roles) || roles.length === 0 || roles.length > 8) fail("malformed", "roles");
  const list = (name: string, xs: unknown, re: RegExp): string => {
    if (!Array.isArray(xs) || xs.length === 0 || xs.length > ORG_MAX_ROLE_TARGETS) fail("malformed", name);
    for (const x of xs as unknown[]) match(name, re, x);
    if (new Set(xs as string[]).size !== (xs as string[]).length) fail("malformed", `${name} duplicate`);
    return [...(xs as string[])].sort().join(",");
  };
  const lines = roles.map((r) => {
    switch (r.role) {
      case "member":
      case "servers-add":
        return r.role;
      case "server-admin":
        return `server-admin:${r.servers === "*" ? "*" : list("servers", r.servers, SERVER)}`;
      case "service-admin":
        return `service-admin:${list("apps", r.apps, SERVICE_REF)}`;
      case "unlock":
        return `unlock:${list("unlock", r.servers, SERVER)}`;
      default:
        return fail("malformed", "role");
    }
  });
  if (new Set(lines.map((l) => l.split(":")[0])).size !== lines.length) fail("malformed", "role twice");
  return enc(`${TAG_ORG_SEAT_ROLES}|${[...lines].sort().join(";")}`);
}

export const orgSeatRolesHash = (roles: readonly OrgSeatRole[]): string => orgSha256Hex(canonicalOrgSeatRoles(roles));

/** True when the roles give admin authority (raising a seat to it needs two org admins). */
export function orgRolesRaiseAdmin(roles: readonly OrgSeatRole[]): boolean {
  return roles.some((r) => r.role === "server-admin" || r.role === "service-admin" || r.role === "servers-add");
}

export interface OrgSeatInvite {
  orgId: string;
  seatId: string;
  /** sha256 of the sealed pseudonym; the inviter must set one before the link exists. */
  labelSha256: string;
  rolesHash: string;
  oarVersion: number;
  issuedAt: number;
  expiresAt: number;
}

export function canonicalOrgSeatInvite(i: OrgSeatInvite): Bytes {
  match("orgId", HEX16, i.orgId);
  match("seatId", HEX16, i.seatId);
  if (typeof i.labelSha256 !== "string" || !HEX32.test(i.labelSha256)) fail("label-missing");
  match("rolesHash", HEX32, i.rolesHash);
  for (const [k, v] of Object.entries({ oarVersion: i.oarVersion, issuedAt: i.issuedAt, expiresAt: i.expiresAt })) uint(k, v);
  if (i.expiresAt <= i.issuedAt || i.expiresAt - i.issuedAt > ORG_INVITE_MAX_LIFETIME_MS) fail("malformed", "expiresAt");
  return enc([TAG_ORG_SEAT_INVITE, i.orgId, i.seatId, i.labelSha256, i.rolesHash, i.oarVersion, i.issuedAt, i.expiresAt].join("|"));
}

export interface OrgSeatAccept {
  orgId: string;
  seatId: string;
  inviteSha256: string;
  memberKeyId: string;
  adminKeyId: string;
  issuedAt: number;
  /** Where the seat's admin key lives (`browser` only with an admin key). */
  custody?: OrgCustody;
}

export function canonicalOrgSeatAccept(a: OrgSeatAccept): Bytes {
  match("orgId", HEX16, a.orgId);
  match("seatId", HEX16, a.seatId);
  match("inviteSha256", HEX32, a.inviteSha256);
  match("memberKeyId", HEX32, a.memberKeyId);
  if (a.adminKeyId !== "") match("adminKeyId", HEX32, a.adminKeyId);
  uint("issuedAt", a.issuedAt);
  if (custodyOf(a.custody) === "browser" && a.adminKeyId === "") fail("malformed", "custody without an admin key");
  return enc([TAG_ORG_SEAT_ACCEPT, a.orgId, a.seatId, a.inviteSha256, a.memberKeyId, a.adminKeyId, a.issuedAt].join("|") + custodySuffix(a.custody));
}

/** The 6-digit code both phones show before the admin approves a seat (defeats a leaked link). */
export function orgSeatSas(inviteSha256: string, memberKeyId: string, adminKeyId: string): string {
  match("inviteSha256", HEX32, inviteSha256);
  match("memberKeyId", HEX32, memberKeyId);
  if (adminKeyId !== "") match("adminKeyId", HEX32, adminKeyId);
  const d = sha256(enc([TAG_ORG_SEAT_SAS, inviteSha256, memberKeyId, adminKeyId].join("|")));
  const n = ((d[0]! << 24) | (d[1]! << 16) | (d[2]! << 8) | d[3]!) >>> 0;
  return String(n % 1_000_000).padStart(6, "0");
}

export interface OrgSeatGrant {
  orgId: string;
  seatId: string;
  labelSha256: string;
  memberKeyId: string;
  adminKeyId: string;
  rolesHash: string;
  oarVersion: number;
  issuedAt: number;
  expiresAt: number;
  /** The custody the seat's accept signed for its admin key; admins see it before they approve. */
  custody?: OrgCustody;
}

export function canonicalOrgSeatGrant(g: OrgSeatGrant): Bytes {
  match("orgId", HEX16, g.orgId);
  match("seatId", HEX16, g.seatId);
  if (typeof g.labelSha256 !== "string" || !HEX32.test(g.labelSha256)) fail("label-missing");
  match("memberKeyId", HEX32, g.memberKeyId);
  if (g.adminKeyId !== "") match("adminKeyId", HEX32, g.adminKeyId);
  match("rolesHash", HEX32, g.rolesHash);
  for (const [k, v] of Object.entries({ oarVersion: g.oarVersion, issuedAt: g.issuedAt, expiresAt: g.expiresAt })) uint(k, v);
  if (g.expiresAt <= g.issuedAt || g.expiresAt - g.issuedAt > ORG_GRANT_MAX_LIFETIME_MS) fail("malformed", "expiresAt");
  return enc(
    [TAG_ORG_SEAT_GRANT, g.orgId, g.seatId, g.labelSha256, g.memberKeyId, g.adminKeyId, g.rolesHash, g.oarVersion, g.issuedAt, g.expiresAt].join("|") + custodySuffix(g.custody),
  );
}

export interface OrgSeatRevoke {
  orgId: string;
  seatId: string;
  /** `left` when the seat signs its own leave; otherwise a short code such as `offboarded`. */
  reason: string;
  oarVersion: number;
  issuedAt: number;
}

export function canonicalOrgSeatRevoke(v: OrgSeatRevoke): Bytes {
  match("orgId", HEX16, v.orgId);
  match("seatId", HEX16, v.seatId);
  match("reason", REASON, v.reason);
  for (const [k, x] of Object.entries({ oarVersion: v.oarVersion, issuedAt: v.issuedAt })) uint(k, x);
  return enc([TAG_ORG_SEAT_REVOKE, v.orgId, v.seatId, v.reason, v.oarVersion, v.issuedAt].join("|"));
}

/** A grant as it travels: the grant, its roles, the seat's bindings and the approvals. */
export interface OrgSeatGrantBundle {
  grant: OrgSeatGrant;
  roles: OrgSeatRole[];
  memberBinding: PqKeyBindingWire;
  adminBinding: PqKeyBindingWire | null;
  approvals: OrgApproval[];
}

/** A revoke: approved by one org admin, or signed by the seat itself (`leave`, member key). */
export interface OrgSeatRevokeBundle {
  revoke: OrgSeatRevoke;
  approvals: OrgApproval[];
  /** The seat's own hybrid signature over the revoke (leave), hex. */
  selfSignature?: string;
}

export interface OrgSeat {
  seatId: string;
  roles: OrgSeatRole[];
  member: VerifiedPqKeyBinding;
  admin: VerifiedPqKeyBinding | null;
  grant: OrgSeatGrant;
}

export interface OrgSeatBook {
  seats: Map<string, OrgSeat>;
  revoked: Set<string>;
  freezes: OrgVerifiedFreeze[];
}

function verifySeatBinding(w: PqKeyBindingWire, role: "org-seat-admin" | "org-seat-member", orgId: string, seatId: string, now: number): VerifiedPqKeyBinding {
  try {
    const wire = pqKeyBindingFromWire(w);
    return verifyPqKeyBinding(wire, { role, subjectId: orgSeatSubject(orgId, seatId), ed25519PubHex: wire.ed25519PubHex, now });
  } catch (e) {
    if (e instanceof PqTrustError) fail("binding", e.code);
    throw e;
  }
}

/** The threshold a seat grant needs under record `r`. */
export function orgGrantThreshold(r: OrgAuthorityRecord, roles: readonly OrgSeatRole[]): number {
  const n = authorityAdmins(r).length;
  return orgRolesRaiseAdmin(roles) ? Math.max(r.kGrant, Math.min(2, n)) : r.kGrant;
}

/**
 * Builds the seat book: every grant, revoke and freeze checked against the verified chain. A grant
 * that fails is skipped (and named in `refused`); the newest valid grant per seat wins; a revoke ends
 * the seat for good. Grants for seats that are org admins in the current record are kept (their
 * scoped roles are moot: org admins hold every scope).
 */
export function buildOrgSeatBook(
  st: OrgAuthorityState,
  input: {
    grants: readonly OrgSeatGrantBundle[];
    revokes: readonly OrgSeatRevokeBundle[];
    freezes?: readonly OrgSigned<OrgSeatFreeze>[];
    overturns?: readonly OrgSigned<OrgOverturn>[];
    now: number;
  },
): OrgSeatBook & { refused: Array<{ seatId: string; code: OrgErrorCode }> } {
  const freezes = verifiedOrgFreezes(st, { freezes: input.freezes, overturns: input.overturns, now: input.now });
  const frozen = (s: string, t: number) => freezes.some((f) => f.seatId === s && f.issuedAt <= t && t < f.untilMs);
  const refused: Array<{ seatId: string; code: OrgErrorCode }> = [];
  const seats = new Map<string, OrgSeat>();
  const revoked = new Set<string>();
  for (const b of input.revokes) {
    try {
      verifyOrgSeatRevoke(st, b, seats, frozen, input.now, input.grants);
      revoked.add(b.revoke.seatId);
    } catch (e) {
      refused.push({ seatId: b.revoke?.seatId ?? "", code: e instanceof OrgAuthorityError ? e.code : "malformed" });
    }
  }
  const sorted = [...input.grants].sort((a, b) => a.grant.issuedAt - b.grant.issuedAt);
  for (const b of sorted) {
    try {
      if (revoked.has(b.grant.seatId)) fail("seat-revoked");
      const seat = verifyOrgSeatGrant(st, b, frozen, input.now);
      const prev = seats.get(seat.seatId);
      if (!prev || prev.grant.issuedAt < seat.grant.issuedAt) seats.set(seat.seatId, seat);
    } catch (e) {
      refused.push({ seatId: b.grant?.seatId ?? "", code: e instanceof OrgAuthorityError ? e.code : "malformed" });
    }
  }
  return { seats, revoked, freezes, refused };
}

/** Checks one grant bundle. Throws `OrgAuthorityError`. */
export function verifyOrgSeatGrant(st: OrgAuthorityState, b: OrgSeatGrantBundle, frozen: (s: string, t: number) => boolean, now: number): OrgSeat {
  const g = b.grant;
  const order = canonicalOrgSeatGrant(g);
  if (g.orgId !== st.orgId) fail("wrong-org");
  if (orgSeatRolesHash(b.roles) !== g.rolesHash) fail("order-mismatch", "roles");
  if (g.expiresAt <= now) fail("expired");
  const r = recordAt(st, g.oarVersion);
  if (!r) fail("stale-oar");
  const member = verifySeatBinding(b.memberBinding, "org-seat-member", g.orgId, g.seatId, now);
  if (member.keyIdHex !== g.memberKeyId) fail("binding", "member key id");
  let admin: VerifiedPqKeyBinding | null = null;
  if (g.adminKeyId !== "") {
    if (!b.adminBinding) fail("binding", "admin binding missing");
    admin = verifySeatBinding(b.adminBinding!, "org-seat-admin", g.orgId, g.seatId, now);
    if (admin.keyIdHex !== g.adminKeyId) fail("binding", "admin key id");
  } else if (orgRolesRaiseAdmin(b.roles)) fail("binding", "an admin role needs an admin key");
  if (custodyOf(g.custody) === "browser") {
    if (g.adminKeyId === "") fail("malformed", "custody without an admin key");
    if (r!.bylaws.adminCustody === "hardware" && orgRolesRaiseAdmin(b.roles)) fail("custody", "the bylaws need hardware custody for admins");
  }
  const signers = checkApprovals(b.approvals, { orgId: g.orgId, oarVersion: g.oarVersion, order, now }, (s) => st.bindings.get(bindingKey(g.oarVersion, s)), frozen);
  for (const s of signers) if (r!.admins.find((a) => a.seatId === s)?.kind !== "admin") fail("not-an-admin", s);
  if (signers.length < orgGrantThreshold(r!, b.roles)) fail("threshold", `${signers.length} of ${orgGrantThreshold(r!, b.roles)}`);
  checkOrgQuorumCustody(r!, orgGrantThreshold(r!, b.roles), signers, adminCustody(r!));
  return { seatId: g.seatId, roles: b.roles, member, admin, grant: g };
}

/**
 * Approvals of a stored org object, checked as of the record it names (as for seat grants): each
 * signer is an org admin of record `oarVersion` (under that record's key) or, when `scoped` is
 * given, one granted seat with an admin key whose roles cover it. Nothing here asks the approval to
 * be unexpired now: a durable record keeps verifying after its ceremony ended. Returns the signers.
 */
export function verifyOrgRecordedApprovals(
  st: OrgAuthorityState,
  book: OrgSeatBook,
  order: Bytes,
  approvals: readonly OrgApproval[],
  oarVersion: number,
  now: number,
  scoped?: OrgAction,
): { signers: string[]; scopedSeat: string | null } {
  const r = recordAt(st, oarVersion);
  if (!r) fail("stale-oar");
  if (!Array.isArray(approvals) || approvals.length === 0) fail("threshold", "no approvals");
  const frozen = (s: string, t: number) => book.freezes.some((f) => f.seatId === s && f.issuedAt <= t && t < f.untilMs);
  const keyOf = (s: string): VerifiedPqKeyBinding | undefined => {
    if (r!.admins.some((a) => a.seatId === s)) return st.bindings.get(bindingKey(oarVersion, s));
    if (!scoped || book.revoked.has(s)) return undefined;
    return book.seats.get(s)?.admin ?? undefined;
  };
  const signers = checkApprovals(approvals, { orgId: st.orgId, oarVersion, order, now }, keyOf, frozen);
  const admins = signers.filter((s) => r!.admins.find((a) => a.seatId === s)?.kind === "admin");
  if (admins.length >= 1 && admins.length === signers.length) return { signers, scopedSeat: null };
  if (!scoped || signers.length !== 1) fail("scope", "one org admin, or one scoped seat alone");
  const seat = book.seats.get(signers[0]!);
  if (!seat || seat.grant.expiresAt <= now || !covers(seat, scoped!)) fail("scope", signers[0]);
  return { signers, scopedSeat: seat!.seatId };
}

function verifyOrgSeatRevoke(
  st: OrgAuthorityState,
  b: OrgSeatRevokeBundle,
  _seats: Map<string, OrgSeat>,
  frozen: (s: string, t: number) => boolean,
  now: number,
  grants: readonly OrgSeatGrantBundle[],
): void {
  const v = b.revoke;
  const order = canonicalOrgSeatRevoke(v);
  if (v.orgId !== st.orgId) fail("wrong-org");
  if (st.current.admins.some((a) => a.seatId === v.seatId)) fail("seat-is-org-admin");
  const r = recordAt(st, v.oarVersion);
  if (!r) fail("stale-oar");
  if (b.selfSignature !== undefined) {
    if (v.reason !== "left") fail("malformed", "a leave says left");
    for (const g of grants) {
      if (g.grant.seatId !== v.seatId || g.grant.orgId !== v.orgId) continue;
      try {
        const member = verifySeatBinding(g.memberBinding, "org-seat-member", v.orgId, v.seatId, now);
        if (member.keyIdHex !== g.grant.memberKeyId) continue;
        verifyCriticalSignature({
          message: order,
          expectedPurpose: TAG_ORG_SEAT_REVOKE,
          envelope: { suite: HYBRID, signature: b.selfSignature },
          signerEd25519PubHex: member.ed25519PubHex,
          binding: member,
          policy: STRICT,
        });
        return;
      } catch {
        continue;
      }
    }
    fail("bad-signature", "leave");
  }
  const signers = checkApprovals(b.approvals, { orgId: v.orgId, oarVersion: v.oarVersion, order, now }, (s) => st.bindings.get(bindingKey(v.oarVersion, s)), frozen);
  if (signers.length < 1) fail("threshold");
  for (const s of signers) if (r!.admins.find((a) => a.seatId === s)?.kind !== "admin") fail("not-an-admin", s);
}

/** Signs a leave with the seat member key's hybrid secret. */
export function signOrgSeatLeave(v: OrgSeatRevoke, memberHybridSecret: Bytes, opts: { deterministic?: boolean } = {}): OrgSeatRevokeBundle {
  if (v.reason !== "left") fail("malformed", "a leave says left");
  return { revoke: v, approvals: [], selfSignature: hex(hybridSign(memberHybridSecret, TAG_ORG_SEAT_REVOKE, canonicalOrgSeatRevoke(v), opts)) };
}

/** The seat member key's two seeds, derived from the person's UMK for this org only. */
export function deriveOrgSeatMemberSeeds(umk: Bytes, orgId: string): { edSeed: Bytes; mldsaSeed: Bytes; hybridSecret: Bytes; publicKey: Bytes } {
  match("orgId", HEX16, orgId);
  if (umk.length !== 32) fail("malformed", "umk");
  const edSeed = hkdf(sha256, umk, new Uint8Array(0), enc(`${TAG_ORG_SEAT_MEMBER_KDF}|${orgId}`), 32);
  const mldsaSeed = hkdf(sha256, umk, new Uint8Array(0), enc(`${TAG_ORG_SEAT_MEMBER_PQ_KDF}|${orgId}`), 32);
  const { publicKey, secretKey } = hybridSigKeygen(edSeed, mldsaSeed);
  return { edSeed, mldsaSeed, hybridSecret: secretKey, publicKey };
}

// ── the authority predicate ─────────────────────────────────────────────

export type OrgAction =
  | { kind: "seat-invite" }
  | { kind: "seat-grant"; roles: OrgSeatRole[] }
  | { kind: "seat-revoke" }
  | { kind: "freeze" }
  | { kind: "add-server" }
  | { kind: "destroy" }
  | { kind: "operate"; server: string }
  | { kind: "app-admin"; server: string; serviceRef: string }
  | { kind: "site" };

export interface OrgAuthorizeInput {
  state: OrgAuthorityState;
  book: OrgSeatBook;
  action: OrgAction;
  /** The inner order's canonical bytes (its own tag and fields, unchanged). */
  order: Bytes;
  approvals: readonly OrgApproval[];
  now: number;
}

export interface OrgAuthorizeResult {
  signers: string[];
  /** The scoped seat that authorized it alone, when not an org admin. */
  scopedSeat: string | null;
}

function covers(seat: OrgSeat, action: OrgAction): boolean {
  for (const r of seat.roles) {
    if (action.kind === "add-server" && r.role === "servers-add") return true;
    if (action.kind === "operate" || action.kind === "app-admin") {
      if (r.role === "server-admin" && (r.servers === "*" || r.servers.includes(action.server))) return true;
    }
    if (action.kind === "app-admin" && r.role === "service-admin" && r.apps.includes(action.serviceRef)) return true;
  }
  return false;
}

/** Decides whether `approvals` authorize `order` for `action` (docs/enterprise-accounts.md §4.2). */
export function authorizeOrgOrder(input: OrgAuthorizeInput): OrgAuthorizeResult {
  const { state, book, action, order, now } = input;
  const cur = state.current;
  if (!Array.isArray(input.approvals) || input.approvals.length === 0) fail("threshold", "no approvals");
  const prev = state.records.find((r) => r.version === cur.version - 1);
  const version = input.approvals[0]!.oarVersion;
  if (version !== cur.version && !(prev && version === prev.version && now - cur.issuedAt <= ORG_PREVIOUS_OAR_GRACE_MS)) fail("stale-oar");
  const at = version === cur.version ? cur : prev!;
  const frozen = (s: string, t: number) =>
    book.freezes.some((f) => f.seatId === s && ((f.issuedAt <= t && t < f.untilMs) || (f.issuedAt <= now && now < f.untilMs)));
  const keyOf = (s: string): VerifiedPqKeyBinding | undefined => {
    const adminHere = at.admins.find((a) => a.seatId === s);
    if (adminHere) {
      const stillAdmin = cur.admins.find((a) => a.seatId === s && sameAdmin(a, adminHere));
      return stillAdmin ? state.bindings.get(bindingKey(at.version, s)) : undefined;
    }
    if (book.revoked.has(s)) return undefined;
    return book.seats.get(s)?.admin ?? undefined;
  };
  for (const a of input.approvals) if (a.notAfter < now) fail("expired", a.seatId);
  const signers = checkApprovals(input.approvals, { orgId: state.orgId, oarVersion: version, order, now }, keyOf, frozen);
  const orgAdmins = signers.filter((s) => at.admins.find((a) => a.seatId === s)?.kind === "admin");
  const others = signers.filter((s) => !orgAdmins.includes(s));
  for (const s of others) {
    if (at.admins.some((a) => a.seatId === s)) fail("not-an-admin", s);
    if (book.revoked.has(s)) fail("seat-revoked", s);
  }
  const need = (k: number): OrgAuthorizeResult => {
    if (others.length > 0) fail("scope", "a seat outside the org admins");
    if (orgAdmins.length < k) fail("threshold", `${orgAdmins.length} of ${k}`);
    checkOrgQuorumCustody(at, k, orgAdmins, adminCustody(at));
    return { signers, scopedSeat: null };
  };
  switch (action.kind) {
    case "seat-grant":
      return need(orgGrantThreshold(at, action.roles));
    case "seat-invite":
    case "seat-revoke":
    case "freeze":
      return need(1);
    case "destroy":
      return need(at.kDestroy);
    case "site":
      return need(at.kSite);
    case "add-server":
    case "operate":
    case "app-admin": {
      if (orgAdmins.length >= 1 && others.length === 0) return { signers, scopedSeat: null };
      if (signers.length !== 1) fail("scope", "one scoped seat signs alone");
      const seat = book.seats.get(others[0]!);
      if (!seat || seat.grant.expiresAt <= now) fail("seat-unknown", others[0]);
      if (!covers(seat!, action)) fail("scope", others[0]);
      return { signers, scopedSeat: seat!.seatId };
    }
    default:
      return fail("malformed", "action");
  }
}

/**
 * The seats whose approvals of `order` verify: anyone in the current record (any kind) or a seat with
 * an admin key, not frozen now, under the current record (or the previous one within 24 h). Counts
 * nothing: for collecting a ceremony and for vetoes, whose weight the chain decides.
 */
export function verifyOrgApprovers(
  state: OrgAuthorityState,
  book: OrgSeatBook,
  order: Bytes,
  approvals: readonly OrgApproval[],
  now: number,
  opts: { allowFrozenSeat?: string } = {},
): string[] {
  const cur = state.current;
  if (approvals.length === 0) fail("threshold", "no approvals");
  const prev = state.records.find((r) => r.version === cur.version - 1);
  const version = approvals[0]!.oarVersion;
  if (version !== cur.version && !(prev && version === prev.version && now - cur.issuedAt <= ORG_PREVIOUS_OAR_GRACE_MS)) fail("stale-oar");
  const at = version === cur.version ? cur : prev!;
  for (const a of approvals) if (a.notAfter < now) fail("expired", a.seatId);
  const keyOf = (s: string) => {
    const here = at.admins.find((a) => a.seatId === s);
    if (here) return cur.admins.some((a) => a.seatId === s && sameAdmin(a, here)) ? state.bindings.get(bindingKey(at.version, s)) : undefined;
    if (book.revoked.has(s)) return undefined;
    return book.seats.get(s)?.admin ?? undefined;
  };
  const frozenNow = (s: string) => s !== opts.allowFrozenSeat && book.freezes.some((f) => f.seatId === s && f.issuedAt <= now && now < f.untilMs);
  return checkApprovals(approvals, { orgId: state.orgId, oarVersion: version, order, now }, keyOf, (s) => frozenNow(s));
}

/** The seat a sign-in key belongs to (member or admin key), for the box's sign-in classes. */
export function orgSeatForKey(book: OrgSeatBook, ed25519PubHex: string, now: number): OrgSeat | null {
  const k = ed25519PubHex.toLowerCase();
  for (const s of book.seats.values()) {
    if (book.revoked.has(s.seatId) || s.grant.expiresAt <= now) continue;
    if (s.member.ed25519PubHex === k || s.admin?.ed25519PubHex === k) return s;
  }
  return null;
}

/** The default app rank of a seat on `server` for app `serviceRef`, from its roles (or org admin). */
export function orgSeatRank(
  state: OrgAuthorityState,
  seat: OrgSeat,
  server: string,
  serviceRef: string,
  memberDefault: "member" | "manager" = "member",
): "member" | "manager" | "master" {
  if (state.current.admins.some((a) => a.seatId === seat.seatId && a.kind === "admin")) return "master";
  for (const r of seat.roles) {
    if (r.role === "server-admin" && (r.servers === "*" || r.servers.includes(server))) return "master";
    if (r.role === "service-admin" && r.apps.includes(serviceRef)) return "master";
  }
  return memberDefault;
}
