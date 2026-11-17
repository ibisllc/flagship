/**
 * The org's signed audit export (docs/enterprise-accounts.md §11; phase E7).
 *
 *   flagship/org-log/v1|<orgId>|<seq>|<prevHash>|<kind>|<refSha256>|<at>          one log entry's hash (as `.com` chains it)
 *   flagship/org-audit-export/v1|<orgId>|<oarVersion>|<oarHash>|<logSeq>|<logHeadHash>|<issuedAt>
 *   flagship/org-box-log/v1|<seq>|<prevHash>|<entrySha256>                           one box Activity entry's chained hash
 *   flagship/org-box-log-head/v1|<orgId>|<serverDomain>|<seq>|<headHash>|<issuedAt>    a box's own log head, signed by its STK
 *
 * `.com` keeps the org log as a hash chain over every stored object's hash. An export is that chain
 * plus every object, and one org admin's approval (`flagship/org-approval/v1`) over the export
 * statement, which pins the chain's head and the authority record the admin saw. An auditor
 * verifies it offline (`tools/org-audit-verify.ts`): the authority chain from the genesis hash they
 * were given, the log chain link by link up to the signed head, every grant, revoke, freeze,
 * overturn, key-ring version and server code named in the log, and the admin's approval as of the
 * record it names. Labels stay sealed: an export shows structure and who approved, never names.
 *
 * Each org box also chains its own Activity log and signs the head with its STK; `.com` keeps the
 * newest head per server and logs it, and the export carries the org's registered servers and
 * those heads. The auditor checks each head under the key the server registered with (named in
 * the org log), so a box's own record of what it did is pinned too: a later copy of that box's
 * log either extends the signed head or shows it was rewritten.
 */
import {
  OrgAuthorityError,
  buildOrgSeatBook,
  canonicalOrgOverturn,
  canonicalOrgSeatFreeze,
  canonicalOrgSeatGrant,
  canonicalOrgSeatRevoke,
  orgAuthorityHash,
  orgSha256Hex,
  signOrgApproval,
  verifyOrgAuthorityChain,
  verifyOrgRecordedApprovals,
  type OrgApproval,
  type OrgAuthorityEntry,
  type OrgAuthorityState,
  type OrgOverturn,
  type OrgSeatBook,
  type OrgSeatFreeze,
  type OrgSeatGrantBundle,
  type OrgSeatRevokeBundle,
  type OrgSigned,
  type OrgVeto,
} from "./orgAuthority.js";
import { buildOrgKeyRings, canonicalOrgKeyRing, newestOrgKems, type OrgKeyRingBundle } from "./orgKeyRing.js";
import { canonicalOrgServerCode, type OrgServerCode } from "./orgServers.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { ed25519VerifyStrict } from "./pqHybrid.js";
import type { Bytes } from "./types.js";

export const TAG_ORG_LOG = "flagship/org-log/v1";
export const TAG_ORG_AUDIT_EXPORT = "flagship/org-audit-export/v1";
export const ORG_LOG_GENESIS = "0".repeat(64);
export const TAG_ORG_BOX_LOG = "flagship/org-box-log/v1";
export const TAG_ORG_BOX_LOG_HEAD = "flagship/org-box-log-head/v1";
const DOMAIN = /^[a-z0-9][a-z0-9.-]{0,252}$/;
const hexOf = (b: Bytes): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytesOf = (h: string): Bytes => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

const HEX16 = /^[0-9a-f]{32}$/;
const HEX32 = /^[0-9a-f]{64}$/;
const enc = (s: string): Bytes => new TextEncoder().encode(s);
const fail = (code: ConstructorParameters<typeof OrgAuthorityError>[0], detail?: string): never => {
  throw new OrgAuthorityError(code, detail);
};
function uint(name: string, v: unknown): void {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) fail("malformed", name);
}

const LOG_KIND = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * `sha256("flagship/org-log/v1|<orgId>|<seq>|<prevHash>|<kind>|<refSha256>|<at>")`. No field may hold
 * the "|" separator, so `.com` cannot move one between `kind` and `refSha256` and keep a chained hash
 * while naming another object (AT-ENV-09). Throws `malformed` on anything else.
 */
export function orgLogEntryHash(orgId: string, seq: number, prevHash: string, kind: string, refSha256: string, at: number): string {
  if (typeof orgId !== "string" || !HEX16.test(orgId)) fail("malformed", "log orgId");
  if (typeof prevHash !== "string" || !HEX32.test(prevHash)) fail("malformed", "log prevHash");
  if (typeof kind !== "string" || !LOG_KIND.test(kind)) fail("malformed", "log kind");
  if (typeof refSha256 !== "string" || !HEX32.test(refSha256)) fail("malformed", "log refSha256");
  uint("log seq", seq);
  uint("log at", at);
  return orgSha256Hex(enc([TAG_ORG_LOG, orgId, seq, prevHash, kind, refSha256, at].join("|")));
}

/** One box Activity entry chained: `sha256("flagship/org-box-log/v1|<seq>|<prevHash>|<entrySha256>")`. */
export function orgBoxLogEntryHash(seq: number, prevHash: string, entrySha256: string): string {
  uint("box log seq", seq);
  if (typeof prevHash !== "string" || !HEX32.test(prevHash)) fail("malformed", "box log prevHash");
  if (typeof entrySha256 !== "string" || !HEX32.test(entrySha256)) fail("malformed", "box log entry");
  return orgSha256Hex(enc([TAG_ORG_BOX_LOG, seq, prevHash, entrySha256].join("|")));
}

/** A box's own log head: its Activity chain up to `seq`, as of `issuedAt`. */
export interface OrgBoxLogHead {
  orgId: string;
  serverDomain: string;
  seq: number;
  headHash: string;
  issuedAt: number;
}

export interface OrgBoxLogHeadBundle {
  head: OrgBoxLogHead;
  /** Ed25519 by the box's STK, lowercase hex. */
  signature: string;
}

export function canonicalOrgBoxLogHead(h: OrgBoxLogHead): Bytes {
  if (typeof h.orgId !== "string" || !HEX16.test(h.orgId)) fail("malformed", "orgId");
  if (typeof h.serverDomain !== "string" || !DOMAIN.test(h.serverDomain)) fail("malformed", "serverDomain");
  if (typeof h.headHash !== "string" || !HEX32.test(h.headHash)) fail("malformed", "headHash");
  uint("seq", h.seq);
  uint("issuedAt", h.issuedAt);
  return enc([TAG_ORG_BOX_LOG_HEAD, h.orgId, h.serverDomain, h.seq, h.headHash, h.issuedAt].join("|"));
}

export function signOrgBoxLogHead(h: OrgBoxLogHead, stkSeed: Bytes): string {
  return hexOf(ed25519.sign(canonicalOrgBoxLogHead(h), stkSeed));
}

/** Checks a head under the box's STK. Throws `bad-signature` (or `malformed`). */
export function verifyOrgBoxLogHead(b: OrgBoxLogHeadBundle, stkPubHex: string): void {
  const msg = canonicalOrgBoxLogHead(b.head);
  if (typeof b.signature !== "string" || !/^[0-9a-f]{128}$/.test(b.signature) || !HEX32.test(stkPubHex)) fail("bad-signature");
  if (!ed25519VerifyStrict(bytesOf(b.signature), msg, bytesOf(stkPubHex))) fail("bad-signature");
}

/** What the org log names for a registered server: `sha256("<serverDomain>|<identityPubKeyHex>")`. */
export const orgServerRegisteredRef = (serverDomain: string, identityPubKeyHex: string): string => orgSha256Hex(enc(`${serverDomain}|${identityPubKeyHex}`));

export interface OrgAuditServer {
  serverDomain: string;
  serial: string;
  identityPubKeyHex: string;
}

export interface OrgLogEntryWire {
  seq: number;
  prevHash: string;
  entryHash: string;
  kind: string;
  refSha256: string;
  at: number;
}

export interface OrgAuditExportStatement {
  orgId: string;
  oarVersion: number;
  oarHash: string;
  logSeq: number;
  logHeadHash: string;
  issuedAt: number;
}

export function canonicalOrgAuditExport(s: OrgAuditExportStatement): Bytes {
  if (typeof s.orgId !== "string" || !HEX16.test(s.orgId)) fail("malformed", "orgId");
  if (typeof s.oarHash !== "string" || !HEX32.test(s.oarHash)) fail("malformed", "oarHash");
  if (typeof s.logHeadHash !== "string" || !HEX32.test(s.logHeadHash)) fail("malformed", "logHeadHash");
  for (const [k, v] of Object.entries({ oarVersion: s.oarVersion, logSeq: s.logSeq, issuedAt: s.issuedAt })) uint(k, v);
  return enc([TAG_ORG_AUDIT_EXPORT, s.orgId, s.oarVersion, s.oarHash, s.logSeq, s.logHeadHash, s.issuedAt].join("|"));
}

/** What `.com` serves at `GET /api/orgs/<id>/export`: everything but the admin's approval. */
export interface OrgAuditObjects {
  orgId: string;
  genesisHash: string;
  entries: OrgAuthorityEntry[];
  freezes: OrgSigned<OrgSeatFreeze>[];
  overturns: OrgSigned<OrgOverturn>[];
  vetoes: OrgSigned<OrgVeto>[];
  grants: OrgSeatGrantBundle[];
  revokes: OrgSeatRevokeBundle[];
  keyRings: OrgKeyRingBundle[];
  serverCodes: Array<{ code: OrgServerCode; approvals: OrgApproval[] }>;
  log: OrgLogEntryWire[];
  /** The org's registered servers and the key each registered with (exports before box heads have none). */
  servers?: OrgAuditServer[];
  /** Each server's newest signed log head. */
  boxLogHeads?: OrgBoxLogHeadBundle[];
  /**
   * Every box log head the org log names (unsigned: the admin-approved log holds each one's hash), so the
   * verifier can tell which server and sequence each `box-log-head` entry was, and that the signed head served
   * for a server is the last one the log names for it (05c review F5).
   */
  boxLogHeadHistory?: OrgBoxLogHead[];
  /** Every registration the org log names (`server-registered`), a re-registered server's earlier keys included. */
  registrations?: Array<{ serverDomain: string; identityPubKeyHex: string }>;
}

/** What an auditor knew from an export it verified before: a later export must extend it, never go back. */
export interface OrgAuditPrevious {
  logSeq: number;
  logHeadHash: string;
  boxLogHeads?: ReadonlyArray<Pick<OrgBoxLogHead, "serverDomain" | "seq" | "headHash">>;
}

export interface OrgAuditExport extends OrgAuditObjects {
  statement: OrgAuditExportStatement;
  approval: OrgApproval;
}

/** The statement an admin signs for `objects`, as of record `state` (the current one, normally). */
export function orgAuditStatementFor(objects: OrgAuditObjects, state: OrgAuthorityState, issuedAt: number): OrgAuditExportStatement {
  const head = objects.log[objects.log.length - 1];
  if (!head) fail("malformed", "empty log");
  return { orgId: objects.orgId, oarVersion: state.current.version, oarHash: state.currentHash, logSeq: head!.seq, logHeadHash: head!.entryHash, issuedAt };
}

/** Signs an export with one org admin's seat admin key. */
export function signOrgAuditExport(
  objects: OrgAuditObjects,
  state: OrgAuthorityState,
  signer: { seatId: string; adminKeyId: string; hybridSecret: Bytes },
  issuedAt: number,
  opts: { deterministic?: boolean } = {},
): OrgAuditExport {
  const statement = orgAuditStatementFor(objects, state, issuedAt);
  const approval = signOrgApproval(
    { orgId: objects.orgId, oarVersion: statement.oarVersion, order: canonicalOrgAuditExport(statement), seatId: signer.seatId, adminKeyId: signer.adminKeyId, issuedAt, notAfter: issuedAt + 86_400_000 },
    signer.hybridSecret,
    opts,
  );
  return { ...objects, statement, approval };
}

export interface OrgAuditVerdict {
  state: OrgAuthorityState;
  book: OrgSeatBook;
  signedBy: string;
  logEntries: number;
  /** Objects present in the export whose hash the log does not name (served but never logged). */
  unlogged: string[];
  /** Each server's signed log head, verified under the key it registered with. */
  boxLogHeads: OrgBoxLogHead[];
}

/**
 * Every server registration and box log head the signed log names must be in the export, and each server's served
 * head must be the last one the log names for it (05c review F5): `.com` cannot drop a server, its head, or serve an
 * older head. With `previous`, the export must also extend what the auditor verified before.
 */
function checkLoggedObjectsPresent(x: OrgAuditExport, servers: Map<string, string>, heads: OrgBoxLogHead[], previous?: OrgAuditPrevious): void {
  const headByRef = new Map<string, OrgBoxLogHead>();
  for (const h of x.boxLogHeadHistory ?? []) {
    if (h?.orgId !== x.orgId) fail("wrong-org", "box log head");
    headByRef.set(orgSha256Hex(canonicalOrgBoxLogHead(h)), h);
  }
  for (const h of heads) headByRef.set(orgSha256Hex(canonicalOrgBoxLogHead(h)), h);
  const regByRef = new Map<string, { serverDomain: string; identityPubKeyHex: string }>();
  for (const r of x.registrations ?? []) {
    if (typeof r?.serverDomain !== "string" || !DOMAIN.test(r.serverDomain) || typeof r.identityPubKeyHex !== "string" || !HEX32.test(r.identityPubKeyHex)) fail("malformed", "registration");
    regByRef.set(orgServerRegisteredRef(r.serverDomain, r.identityPubKeyHex), r);
  }
  for (const [serverDomain, identityPubKeyHex] of servers) regByRef.set(orgServerRegisteredRef(serverDomain, identityPubKeyHex), { serverDomain, identityPubKeyHex });

  const lastHead = new Map<string, OrgBoxLogHead>();
  const lastReg = new Map<string, string>();
  for (const e of x.log) {
    if (e.kind === "box-log-head") {
      const h = headByRef.get(e.refSha256);
      if (!h) fail("order-mismatch", `log seq ${e.seq} names a box log head the export lacks`);
      const before = lastHead.get(h!.serverDomain);
      if (before && h!.seq < before.seq) fail("order-mismatch", `the log of ${h!.serverDomain} went back from ${before.seq} to ${h!.seq}`);
      if (before && h!.seq === before.seq && h!.headHash !== before.headHash) fail("order-mismatch", `two logs of ${h!.serverDomain} at ${h!.seq}`);
      lastHead.set(h!.serverDomain, h!);
    } else if (e.kind === "server-registered") {
      const r = regByRef.get(e.refSha256);
      if (!r) fail("order-mismatch", `log seq ${e.seq} names a server registration the export lacks`);
      // A server registered again is a new box with a new Activity chain: its heads start over.
      if (lastReg.has(r!.serverDomain) && lastReg.get(r!.serverDomain) !== r!.identityPubKeyHex) lastHead.delete(r!.serverDomain);
      lastReg.set(r!.serverDomain, r!.identityPubKeyHex);
    }
  }
  for (const [d, stk] of lastReg) if (servers.get(d) !== stk) fail("order-mismatch", `server ${d} is registered in the log but missing or changed in the export`);
  for (const [d, h] of lastHead) {
    const served = heads.find((s) => s.serverDomain === d);
    if (!served || orgSha256Hex(canonicalOrgBoxLogHead(served)) !== orgSha256Hex(canonicalOrgBoxLogHead(h))) fail("order-mismatch", `the newest box log head of ${d} the log names (entry ${h.seq}) is not the one served`);
  }
  if (previous) {
    const at = x.log[previous.logSeq - 1];
    if (previous.logSeq > x.log.length || (previous.logSeq > 0 && at?.entryHash !== previous.logHeadHash)) fail("order-mismatch", "the log does not extend the one verified before");
    for (const k of previous.boxLogHeads ?? []) {
      const now = heads.find((s) => s.serverDomain === k.serverDomain);
      if (!now) fail("order-mismatch", `server ${k.serverDomain} had a box log head before and has none now`);
      if (now!.seq < k.seq || (now!.seq === k.seq && now!.headHash !== k.headHash)) fail("order-mismatch", `the box log head of ${k.serverDomain} is older than, or differs from, the one verified before`);
    }
  }
}

/**
 * Verifies an export offline from the org's genesis hash. Throws `OrgAuthorityError` on anything
 * that does not hold; `unlogged` lists objects the log does not account for (an auditor flags them).
 */
export function verifyOrgAuditExport(x: OrgAuditExport, opts: { genesisHash: string; now: number; previous?: OrgAuditPrevious }): OrgAuditVerdict {
  if (x.genesisHash !== opts.genesisHash) fail("wrong-org", "genesis");
  const state = verifyOrgAuthorityChain(x.entries, { genesisHash: opts.genesisHash, now: opts.now, freezes: x.freezes, overturns: x.overturns, vetoes: x.vetoes });
  if (state.orgId !== x.orgId || x.statement.orgId !== x.orgId) fail("wrong-org");
  const book = buildOrgSeatBook(state, { grants: x.grants, revokes: x.revokes, freezes: x.freezes, overturns: x.overturns, now: opts.now });

  let prev = ORG_LOG_GENESIS;
  x.log.forEach((e, i) => {
    if (e.seq !== i + 1) fail("version-gap", `log seq ${e.seq}`);
    if (e.prevHash !== prev) fail("prev-hash", `log seq ${e.seq}`);
    if (orgLogEntryHash(x.orgId, e.seq, e.prevHash, e.kind, e.refSha256, e.at) !== e.entryHash) fail("order-mismatch", `log seq ${e.seq}`);
    prev = e.entryHash;
  });
  const head = x.log[x.log.length - 1];
  if (!head || head.seq !== x.statement.logSeq || head.entryHash !== x.statement.logHeadHash) fail("order-mismatch", "log head");

  const rec = state.records.find((r) => r.version === x.statement.oarVersion);
  if (!rec) fail("stale-oar");
  if (orgAuthorityHash(rec!) !== x.statement.oarHash) fail("order-mismatch", "oar hash");
  const { signers } = verifyOrgRecordedApprovals(state, book, canonicalOrgAuditExport(x.statement), [x.approval], x.statement.oarVersion, opts.now);

  const refs = new Set(x.log.map((e) => e.refSha256));
  const unlogged: string[] = [];
  const need = (what: string, sha: string) => {
    if (!refs.has(sha)) unlogged.push(`${what} ${sha}`);
  };
  for (const g of x.grants) need("grant", orgSha256Hex(canonicalOrgSeatGrant(g.grant)));
  for (const r of x.revokes) need("revoke", orgSha256Hex(canonicalOrgSeatRevoke(r.revoke)));
  for (const f of x.freezes) need("freeze", orgSha256Hex(canonicalOrgSeatFreeze(f.body)));
  for (const o of x.overturns) need("overturn", orgSha256Hex(canonicalOrgOverturn(o.body)));
  for (const k of x.keyRings) need("key-ring", orgSha256Hex(canonicalOrgKeyRing(k.ring)));
  for (const c of x.serverCodes) need("server-code", orgSha256Hex(canonicalOrgServerCode(c.code)));
  const servers = new Map<string, string>();
  for (const s of x.servers ?? []) {
    if (typeof s.serverDomain !== "string" || !DOMAIN.test(s.serverDomain) || typeof s.identityPubKeyHex !== "string" || !HEX32.test(s.identityPubKeyHex)) fail("malformed", "server");
    if (servers.has(s.serverDomain)) fail("malformed", `server ${s.serverDomain} twice`);
    servers.set(s.serverDomain, s.identityPubKeyHex);
    need("server", orgServerRegisteredRef(s.serverDomain, s.identityPubKeyHex));
    if (!x.serverCodes.some((c) => c.code.serial === s.serial && c.code.serverDomain === s.serverDomain)) unlogged.push(`server ${s.serverDomain} without its server code`);
  }
  const heads: OrgBoxLogHead[] = [];
  for (const b of x.boxLogHeads ?? []) {
    if (b?.head?.orgId !== x.orgId) fail("wrong-org", "box log head");
    const stk = servers.get(b.head.serverDomain);
    if (!stk) fail("unknown-signer", `box log head of ${b.head.serverDomain}`);
    if (heads.some((h) => h.serverDomain === b.head.serverDomain)) fail("malformed", `two heads for ${b.head.serverDomain}`);
    verifyOrgBoxLogHead(b, stk!);
    need("box-log-head", orgSha256Hex(canonicalOrgBoxLogHead(b.head)));
    heads.push(b.head);
  }
  checkLoggedObjectsPresent(x, servers, heads, opts.previous);
  // Key rings verify as of the record each names; recipients' KEM keys are not part of an export.
  const rings = buildOrgKeyRings({ state, book, kems: newestOrgKems([]), servers: new Set(), now: opts.now }, x.keyRings);
  if (rings.refused.length > 0) fail("bad-signature", `key ring ${rings.refused[0]!.kind} v${rings.refused[0]!.version}`);
  return { state, book, signedBy: signers[0]!, logEntries: x.log.length, unlogged, boxLogHeads: heads };
}
