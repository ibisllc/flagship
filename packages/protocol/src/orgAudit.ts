/**
 * The org's signed audit export (docs/enterprise-accounts.md §11; phase E7).
 *
 *   flagship/org-log/v1|<orgId>|<seq>|<prevHash>|<kind>|<refSha256>|<at>          one log entry's hash (as `.com` chains it)
 *   flagship/org-audit-export/v1|<orgId>|<oarVersion>|<oarHash>|<logSeq>|<logHeadHash>|<issuedAt>
 *
 * `.com` keeps the org log as a hash chain over every stored object's hash. An export is that chain
 * plus every object, and one org admin's approval (`flagship/org-approval/v1`) over the export
 * statement, which pins the chain's head and the authority record the admin saw. An auditor
 * verifies it offline (`tools/org-audit-verify.ts`): the authority chain from the genesis hash they
 * were given, the log chain link by link up to the signed head, every grant, revoke, freeze,
 * overturn, key-ring version and server code named in the log, and the admin's approval as of the
 * record it names. Labels stay sealed: an export shows structure and who approved, never names.
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
import type { Bytes } from "./types.js";

export const TAG_ORG_LOG = "flagship/org-log/v1";
export const TAG_ORG_AUDIT_EXPORT = "flagship/org-audit-export/v1";
export const ORG_LOG_GENESIS = "0".repeat(64);

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
}

/**
 * Verifies an export offline from the org's genesis hash. Throws `OrgAuthorityError` on anything
 * that does not hold; `unlogged` lists objects the log does not account for (an auditor flags them).
 */
export function verifyOrgAuditExport(x: OrgAuditExport, opts: { genesisHash: string; now: number }): OrgAuditVerdict {
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
  // Key rings verify as of the record each names; recipients' KEM keys are not part of an export.
  const rings = buildOrgKeyRings({ state, book, kems: newestOrgKems([]), servers: new Set(), now: opts.now }, x.keyRings);
  if (rings.refused.length > 0) fail("bad-signature", `key ring ${rings.refused[0]!.kind} v${rings.refused[0]!.version}`);
  return { state, book, signedBy: signers[0]!, logEntries: x.log.length, unlogged };
}
