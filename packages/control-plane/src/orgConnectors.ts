import {
  OrgAuthorityError,
  authorizeOrgOrder,
  canonicalOrgConnector,
  canonicalOrgProposal,
  canonicalOrgProposalDecision,
  orgApprovalFromWire,
  orgSeatRolesHash,
  orgSha256Hex,
  verifyOrgConnector,
  verifyOrgProposal,
  type OrgApproval,
  type OrgConnectorBundle,
  type OrgProposalBundle,
  type OrgProposalDecisionStatement,
  type OrgSeatRole,
} from "@flagship/protocol";
import { loadOrg, type OrgDeps } from "./orgs.js";
import { conflict, forbidden, malformed, notFound, ok, type HandlerResponseWithHeaders } from "./types.js";

/**
 * Directory connectors and their proposals on `.com` (docs/org-directory.md §2-§4). Routes:
 *
 *   GET  /api/orgs/:orgId/connectors                                         newest record per connector
 *   POST /api/orgs/:orgId/connectors        { connector, connectorPubHex, approvals }   add, pause or retire (one org admin)
 *   GET  /api/orgs/:orgId/proposals                                          open and decided proposals
 *   POST /api/orgs/:orgId/proposals         proposal bundle                  a connector box proposes (its own signature)
 *   POST /api/orgs/:orgId/proposals/decisions  { decision, approvals }       an org admin records what it did
 *
 * `.com` learns which connector proposed what kind of change about an opaque subject id; the names,
 * email and groups are sealed to the org admins. A proposal moves no authority: the admin carries
 * it out with the usual invite, revoke or grant (each with its own approvals) and then records the
 * decision, whose `refSha256` must already be in the org log for "done".
 */
const nowOf = (d: OrgDeps) => (d.now ?? (() => Date.now()))();
const parse = <T>(json: string): T => JSON.parse(json) as T;
const refuse = (e: unknown): HandlerResponseWithHeaders => {
  if (e instanceof OrgAuthorityError) return { status: 403, body: { error: e.message, code: `org-${e.code}` } };
  return malformed(e instanceof Error ? e.message : "malformed");
};
const ORG_ID = /^[0-9a-f]{32}$/;
const MAX_OPEN_PROPOSALS = 2_000;

interface StoredProposal {
  bundle: OrgProposalBundle;
  decision: { statement: OrgProposalDecisionStatement; approvals: OrgApproval[] } | null;
}

async function servers(deps: OrgDeps, orgId: string): Promise<Set<string>> {
  return new Set((await deps.orgs.listObjects(orgId, "server")).map((o) => parse<{ serverDomain: string }>(o.bodyJson).serverDomain));
}

export async function handleOrgConnectorsGet(deps: OrgDeps, orgId: string): Promise<HandlerResponseWithHeaders> {
  if (!ORG_ID.test(orgId)) return malformed("orgId");
  if (!(await deps.orgs.getOrg(orgId))) return notFound("org not found");
  return ok({ connectors: (await deps.orgs.listObjects(orgId, "connector")).map((o) => parse<OrgConnectorBundle>(o.bodyJson)) });
}

export async function handleOrgConnectorPut(deps: OrgDeps, orgId: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const b = body as OrgConnectorBundle | undefined;
  if (!b?.connector || typeof b.connectorPubHex !== "string" || !Array.isArray(b.approvals)) return malformed("connector, connectorPubHex and approvals required");
  try {
    const order = canonicalOrgConnector(b.connector);
    if (Math.abs(now - b.connector.issuedAt) > 10 * 60_000) return malformed("stale connector");
    const v = await loadOrg(deps, orgId, now);
    if (!v) return notFound("org not found");
    const prevObj = await deps.orgs.getObject(orgId, "connector", b.connector.connectorId);
    const prev = prevObj ? parse<OrgConnectorBundle>(prevObj.bodyJson) : null;
    if (prev && prev.connectorPubHex !== b.connectorPubHex) return malformed("a connector keeps its key; add a new one instead");
    if (b.setup !== undefined && (typeof b.setup?.sealedHex !== "string" || !/^(?:[0-9a-f]{2})+$/.test(b.setup.sealedHex) || b.setup.sealedHex.length > 2 * 16_384 || !/^[0-9a-f]{64}$/.test(String(b.setup.kemKeyId)))) {
      return malformed("setup");
    }
    // A pause or retire may leave the setup out: the box keeps the one it opened.
    const setup = b.setup ?? prev?.setup;
    const bundle: OrgConnectorBundle = { connector: b.connector, connectorPubHex: b.connectorPubHex, approvals: b.approvals.map(orgApprovalFromWire), ...(setup ? { setup } : {}) };
    verifyOrgConnector({ state: v.state, book: v.book, servers: await servers(deps, orgId), now }, bundle, prev?.connector ?? null);
    await deps.orgs.putObject(orgId, { kind: "connector", key: b.connector.connectorId, bodyJson: JSON.stringify(bundle), issuedAt: b.connector.issuedAt, storedAt: now }, true);
    await deps.orgs.appendLog(orgId, `connector-${b.connector.status}`, orgSha256Hex(order), now);
    return ok({ connectorId: b.connector.connectorId, status: b.connector.status });
  } catch (e) {
    return refuse(e);
  }
}

export async function handleOrgProposalsGet(deps: OrgDeps, orgId: string): Promise<HandlerResponseWithHeaders> {
  if (!ORG_ID.test(orgId)) return malformed("orgId");
  if (!(await deps.orgs.getOrg(orgId))) return notFound("org not found");
  return ok({ proposals: (await deps.orgs.listObjects(orgId, "proposal")).map((o) => parse<StoredProposal>(o.bodyJson)) });
}

export async function handleOrgProposalPost(deps: OrgDeps, orgId: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const b = body as OrgProposalBundle | undefined;
  if (!b?.proposal || !Array.isArray(b.recipients) || !Array.isArray(b.roles) || typeof b.signature !== "string") return malformed("proposal bundle required");
  try {
    canonicalOrgProposal(b.proposal);
    if (b.proposal.orgId !== orgId) return malformed("orgId");
    if (Math.abs(now - b.proposal.issuedAt) > 10 * 60_000) return malformed("stale proposal");
    const c = await deps.orgs.getObject(orgId, "connector", b.proposal.connectorId);
    if (!c) return notFound("no such connector");
    const rolesHash = b.roles.length > 0 ? orgSeatRolesHash(b.roles as OrgSeatRole[]) : "";
    verifyOrgProposal(parse<OrgConnectorBundle>(c.bodyJson), b, { rolesHash, now });
    const open = (await deps.orgs.listObjects(orgId, "proposal")).filter((o) => parse<StoredProposal>(o.bodyJson).decision === null).length;
    if (open >= MAX_OPEN_PROPOSALS) return forbidden("too many open proposals");
    const stored: StoredProposal = { bundle: { proposal: b.proposal, roles: b.roles, recipients: b.recipients, signature: b.signature }, decision: null };
    const put = await deps.orgs.putObject(orgId, { kind: "proposal", key: b.proposal.proposalId, bodyJson: JSON.stringify(stored), issuedAt: b.proposal.issuedAt, storedAt: now });
    if (!put) return conflict("proposal exists");
    await deps.orgs.appendLog(orgId, `proposal-${b.proposal.kind}`, orgSha256Hex(canonicalOrgProposal(b.proposal)), now);
    return ok({ proposalId: b.proposal.proposalId });
  } catch (e) {
    return refuse(e);
  }
}

export async function handleOrgProposalDecision(deps: OrgDeps, orgId: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const b = body as { decision?: OrgProposalDecisionStatement; approvals?: unknown[] } | undefined;
  if (!b?.decision || !Array.isArray(b.approvals)) return malformed("decision and approvals required");
  try {
    const order = canonicalOrgProposalDecision(b.decision);
    if (b.decision.orgId !== orgId) return malformed("orgId");
    const o = await deps.orgs.getObject(orgId, "proposal", b.decision.proposalId);
    if (!o) return notFound("no such proposal");
    const p = parse<StoredProposal>(o.bodyJson);
    if (p.decision) return conflict("already decided");
    const v = await loadOrg(deps, orgId, now);
    if (!v) return notFound("org not found");
    const approvals = b.approvals.map(orgApprovalFromWire);
    authorizeOrgOrder({ state: v.state, book: v.book, action: { kind: "seat-invite" }, order, approvals, now });
    if (b.decision.decision === "done" && !(await deps.orgs.listLog(orgId)).some((e) => e.refSha256 === b.decision!.refSha256)) {
      return { status: 403, body: { error: "the order this decision names is not in the org log", code: "org-order-mismatch" } };
    }
    p.decision = { statement: b.decision, approvals };
    await deps.orgs.putObject(orgId, { kind: "proposal", key: b.decision.proposalId, bodyJson: JSON.stringify(p), issuedAt: o.issuedAt, storedAt: now }, true);
    await deps.orgs.appendLog(orgId, `proposal-${b.decision.decision}`, orgSha256Hex(order), now);
    return ok({ proposalId: b.decision.proposalId, decision: b.decision.decision });
  } catch (e) {
    return refuse(e);
  }
}
