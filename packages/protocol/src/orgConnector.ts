/**
 * Directory connectors and their proposals (docs/org-directory.md §2, §3, §4).
 *
 *   flagship/org-connector/v1|<orgId>|<connectorId>|<kind>|<serverDomain>|<connectorKeyId>|<scopes>|<mappingSha256>|<status>|<issuedAt>
 *   flagship/org-proposal/v1|<orgId>|<proposalId>|<connectorId>|<kind>|<subject>|<rolesHash>|<sealedSha256>|<issuedAt>
 *   flagship/org-proposal/v1|recipients|<recipient>:<kemKeyId>:<sealedSha256>;...        (hash domain, sorted)
 *   flagship/org-proposal/v1|decision|<orgId>|<proposalId>|<decision>|<refSha256>|<issuedAt>
 *   seal purpose flagship/org-proposal/v1, context [orgId, proposalId, recipient]
 *
 * A connector is an org authority record: one org admin approves it (an org-approval over its
 * canonical bytes, the weight of an invite), and it names the box that runs it and the hybrid key
 * that box holds for it. It never holds an org key and can't admit, raise or remove anyone: it only
 * signs proposals. A proposal carries the person's directory entry (names, email, groups) sealed to
 * each org admin's seat KEM key, so `.com` sees only who proposed what kind of change about which
 * opaque subject. It executes only through the existing approvals: an admin acts with the usual
 * invite / revoke / grant (its own org-approvals), then records the decision, approved by one org
 * admin, naming the digest of what it did (`refSha256`, zeros for a decline).
 *
 * Scopes: `propose-invite` (invite, role-change), `propose-offboard` (offboard), `update-entry`
 * (entry-update). `status` is `active`, `paused` or `retired`; a newer record for the same id
 * replaces the older, and a retired id never comes back.
 */
import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { hex } from "./canonicalBase.js";
import {
  OrgAuthorityError,
  authorizeOrgOrder,
  orgKeyIdHex,
  orgSha256Hex,
  verifyOrgRecordedApprovals,
  type OrgApproval,
  type OrgAuthorityState,
  type OrgSeatBook,
} from "./orgAuthority.js";
import { hybridOpen, hybridSeal, hybridSealWithRandomness, hybridSign, hybridVerify, HYBRID_SIG_PUBLIC_KEY_LEN } from "./pqHybrid.js";
import type { OrgKemKey } from "./orgKeyRing.js";
import type { Bytes } from "./types.js";

export const TAG_ORG_CONNECTOR = "flagship/org-connector/v1";
export const TAG_ORG_PROPOSAL = "flagship/org-proposal/v1";

export type OrgConnectorKind = "scim" | "ldap" | "custom";
export type OrgConnectorScope = "propose-invite" | "propose-offboard" | "update-entry";
export type OrgConnectorStatus = "active" | "paused" | "retired";
export type OrgProposalKind = "invite" | "offboard" | "role-change" | "entry-update";
export type OrgProposalDecision = "done" | "declined";

export const ORG_CONNECTOR_SCOPES: readonly OrgConnectorScope[] = ["propose-invite", "propose-offboard", "update-entry"];
const KINDS: readonly OrgConnectorKind[] = ["scim", "ldap", "custom"];
const STATUSES: readonly OrgConnectorStatus[] = ["active", "paused", "retired"];
const PROPOSAL_KINDS: readonly OrgProposalKind[] = ["invite", "offboard", "role-change", "entry-update"];
export const ORG_PROPOSAL_MAX_RECIPIENTS = 64;
export const ORG_PROPOSAL_MAX_SEALED_HEX = 2 * 16_384;
const MAX_SKEW_MS = 5 * 60 * 1000;
const ZERO64 = "0".repeat(64);

const HEX16 = /^[0-9a-f]{32}$/;
const HEX32 = /^[0-9a-f]{64}$/;
const DOMAIN = /^[a-z0-9][a-z0-9.-]{0,252}$/;
const SEAT_RECIPIENT = /^seat:[0-9a-f]{32}$/;

const enc = (s: string): Bytes => new TextEncoder().encode(s);
const fail = (code: ConstructorParameters<typeof OrgAuthorityError>[0], detail?: string): never => {
  throw new OrgAuthorityError(code, detail);
};
function match(name: string, re: RegExp, v: unknown): void {
  if (typeof v !== "string" || !re.test(v)) fail("malformed", name);
}
function uint(name: string, v: unknown): void {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) fail("malformed", name);
}
function oneOf<T extends string>(name: string, list: readonly T[], v: unknown): void {
  if (typeof v !== "string" || !list.includes(v as T)) fail("malformed", name);
}
function fromHex(s: string): Bytes {
  if (!/^(?:[0-9a-f]{2})*$/.test(s)) fail("malformed", "hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ── the connector record ────────────────────────────────────────────────

export interface OrgConnector {
  orgId: string;
  connectorId: string;
  kind: OrgConnectorKind;
  /** The org box that runs it (its registered server domain). */
  serverDomain: string;
  /** orgKeyIdHex of the connector's hybrid signing key (the box holds the secret). */
  connectorKeyId: string;
  /** Sorted, unique, from ORG_CONNECTOR_SCOPES. */
  scopes: OrgConnectorScope[];
  /** SHA-256 of the admin-edited mapping (groups → roles, attribute names), so the audit names it. */
  mappingSha256: string;
  status: OrgConnectorStatus;
  issuedAt: number;
}

export interface OrgConnectorBundle {
  connector: OrgConnector;
  /** The connector's hybrid public key (Ed25519 || ML-DSA-65), hex. */
  connectorPubHex: string;
  approvals: OrgApproval[];
  /** The setup sealed to the connector box (sealOrgConnectorSetup); `.com` stores it as ciphertext. */
  setup?: { kemKeyId: string; sealedHex: string };
  /** The mapping sealed under the org directory key, for the admins' editor (sealOrgConnectorMapping). */
  mappingSealed?: OrgConnectorMappingSealed;
}

export function canonicalOrgConnector(c: OrgConnector): Bytes {
  match("orgId", HEX16, c.orgId);
  match("connectorId", HEX16, c.connectorId);
  oneOf("kind", KINDS, c.kind);
  match("serverDomain", DOMAIN, c.serverDomain);
  match("connectorKeyId", HEX32, c.connectorKeyId);
  if (!Array.isArray(c.scopes) || c.scopes.length === 0) fail("malformed", "scopes");
  for (const s of c.scopes) oneOf("scope", ORG_CONNECTOR_SCOPES, s);
  const sorted = [...c.scopes].sort();
  if (new Set(sorted).size !== sorted.length || sorted.some((s, i) => s !== c.scopes[i])) fail("malformed", "scopes not sorted and unique");
  match("mappingSha256", HEX32, c.mappingSha256);
  oneOf("status", STATUSES, c.status);
  uint("issuedAt", c.issuedAt);
  return enc(
    [TAG_ORG_CONNECTOR, c.orgId, c.connectorId, c.kind, c.serverDomain, c.connectorKeyId, c.scopes.join(","), c.mappingSha256, c.status, c.issuedAt].join("|"),
  );
}

/** The key id a connector's hybrid public key goes by (the same derivation as a seat admin key). */
export function orgConnectorKeyId(connectorPub: Bytes): string {
  if (connectorPub.length !== HYBRID_SIG_PUBLIC_KEY_LEN) fail("malformed", "connector key");
  return orgKeyIdHex({ ed25519PubHex: hex(connectorPub.subarray(0, 32)), mldsaPubHex: hex(connectorPub.subarray(32)) });
}

/**
 * Checks a connector record against the org's chain and seat book: well formed, its key matches the
 * named id, one org admin approved it, and the box is one of the org's servers. Throws.
 * Fresh (`.com` at submission): the approval must be current. `stored` (the connector box, later):
 * the approval is checked as of the record it names (it may have expired since) and the result is
 * the connector's standing: when every approver has since stopped being an org admin it needs
 * re-approval, keeps working for 7 days, and is then suspended until any org admin approves it
 * again (owner decision, 2026-11-15). A suspended connector throws `connector-suspended`.
 */
export function verifyOrgConnector(
  ctx: { state: OrgAuthorityState; book: OrgSeatBook; servers: ReadonlySet<string>; now: number },
  b: OrgConnectorBundle,
  prev: OrgConnector | null,
  opts: { stored?: boolean } = {},
): OrgConnectorStanding | null {
  const c = b.connector;
  const order = canonicalOrgConnector(c);
  if (c.orgId !== ctx.state.orgId) fail("wrong-org");
  if (c.issuedAt > ctx.now + MAX_SKEW_MS) fail("future");
  if (orgConnectorKeyId(fromHex(String(b.connectorPubHex ?? ""))) !== c.connectorKeyId) fail("binding", "connector key id");
  if (!ctx.servers.has(c.serverDomain)) fail("scope", "not an org server");
  if (prev) {
    if (prev.connectorId !== c.connectorId) fail("malformed", "another connector");
    if (prev.status === "retired") fail("seat-revoked", "connector retired");
    if (c.issuedAt <= prev.issuedAt) fail("not-after-previous");
  }
  if (opts.stored) {
    const standing = orgConnectorStanding(ctx.state, ctx.book, b, ctx.now);
    if (standing.state === "suspended") fail("seat-revoked", "connector-suspended: its approver left more than 7 days ago");
    return standing;
  }
  authorizeOrgOrder({ state: ctx.state, book: ctx.book, action: { kind: "seat-invite" }, order, approvals: b.approvals, now: ctx.now });
  return null;
}

export const ORG_CONNECTOR_REAPPROVAL_GRACE_MS = 7 * 24 * 3_600_000;

export interface OrgConnectorStanding {
  state: "ok" | "needs-reapproval" | "suspended";
  /** Seats whose approval the stored record carries. */
  approvers: string[];
  /** Approvers no longer org admins, with when each left (the first record that dropped them). */
  departed: Array<{ seatId: string; leftAt: number }>;
  /** When the last approver left (null while one is still an org admin). */
  leftAt: number | null;
  /** leftAt + 7 days. */
  suspendAt: number | null;
}

/**
 * The standing of a stored connector record: its approval checked as of the record it names, then
 * whether any approver is still an org admin now. Throws when the approval itself does not verify.
 */
export function orgConnectorStanding(st: OrgAuthorityState, book: OrgSeatBook, b: OrgConnectorBundle, now: number): OrgConnectorStanding {
  const order = canonicalOrgConnector(b.connector);
  const at = b.approvals[0]?.oarVersion ?? -1;
  const { signers } = verifyOrgRecordedApprovals(st, book, order, b.approvals, at, now);
  const isAdmin = (s: string) => st.current.admins.some((a) => a.seatId === s && a.kind === "admin");
  const departed = signers
    .filter((s) => !isAdmin(s))
    .map((s) => {
      const drop = st.records.find((r) => r.version > at && !r.admins.some((a) => a.seatId === s && a.kind === "admin"));
      return { seatId: s, leftAt: drop?.issuedAt ?? st.current.issuedAt };
    });
  if (departed.length < signers.length) return { state: "ok", approvers: signers, departed, leftAt: null, suspendAt: null };
  const leftAt = Math.max(...departed.map((d) => d.leftAt));
  const suspendAt = leftAt + ORG_CONNECTOR_REAPPROVAL_GRACE_MS;
  return { state: now < suspendAt ? "needs-reapproval" : "suspended", approvers: signers, departed, leftAt, suspendAt };
}

/** Every connector whose approvers have all left: what the org page lists beside the pending rotations. */
export function orgConnectorsToReapprove(st: OrgAuthorityState, book: OrgSeatBook, bundles: readonly OrgConnectorBundle[], now: number): Array<{ connectorId: string; standing: OrgConnectorStanding }> {
  const out: Array<{ connectorId: string; standing: OrgConnectorStanding }> = [];
  for (const b of bundles) {
    if (b.connector?.status === "retired") continue;
    try {
      const standing = orgConnectorStanding(st, book, b, now);
      if (standing.state !== "ok") out.push({ connectorId: b.connector.connectorId, standing });
    } catch {
      /* a record that does not verify is not offered for re-approval */
    }
  }
  return out;
}

// ── proposals ───────────────────────────────────────────────────────────

export interface OrgProposal {
  orgId: string;
  proposalId: string;
  connectorId: string;
  kind: OrgProposalKind;
  /** The person: a seat id (offboard, role-change, entry-update of a seat) or a pending id (invite). */
  subject: string;
  /** orgSeatRolesHash of the proposed roles (invite, role-change), "" otherwise. */
  rolesHash: string;
  sealedSha256: string;
  issuedAt: number;
}

export interface OrgProposalRecipient {
  recipient: string;
  kemKeyId: string;
  sealedHex: string;
}

export interface OrgProposalBundle {
  proposal: OrgProposal;
  /** The proposed roles, beside the statement (no names in them). */
  roles: unknown[];
  recipients: OrgProposalRecipient[];
  /** The connector's hybrid signature over the canonical proposal, hex. */
  signature: string;
}

export const orgProposalScope = (k: OrgProposalKind): OrgConnectorScope =>
  k === "offboard" ? "propose-offboard" : k === "entry-update" ? "update-entry" : "propose-invite";

export function canonicalOrgProposal(p: OrgProposal): Bytes {
  match("orgId", HEX16, p.orgId);
  match("proposalId", HEX16, p.proposalId);
  match("connectorId", HEX16, p.connectorId);
  oneOf("kind", PROPOSAL_KINDS, p.kind);
  match("subject", HEX16, p.subject);
  const needsRoles = p.kind === "invite" || p.kind === "role-change";
  if (needsRoles) match("rolesHash", HEX32, p.rolesHash);
  else if (p.rolesHash !== "") fail("malformed", "rolesHash");
  match("sealedSha256", HEX32, p.sealedSha256);
  uint("issuedAt", p.issuedAt);
  return enc([TAG_ORG_PROPOSAL, p.orgId, p.proposalId, p.connectorId, p.kind, p.subject, p.rolesHash, p.sealedSha256, p.issuedAt].join("|"));
}

export function orgProposalRecipientsHash(recipients: readonly OrgProposalRecipient[]): string {
  if (!Array.isArray(recipients) || recipients.length === 0 || recipients.length > ORG_PROPOSAL_MAX_RECIPIENTS) fail("malformed", "recipients");
  const lines = recipients.map((x) => {
    match("recipient", SEAT_RECIPIENT, x.recipient);
    match("kemKeyId", HEX32, x.kemKeyId);
    if (typeof x.sealedHex !== "string" || x.sealedHex.length === 0 || x.sealedHex.length > ORG_PROPOSAL_MAX_SEALED_HEX) fail("malformed", "sealedHex");
    return `${x.recipient}:${x.kemKeyId}:${orgSha256Hex(fromHex(x.sealedHex))}`;
  });
  if (new Set(recipients.map((x) => x.recipient)).size !== recipients.length) fail("malformed", "recipient twice");
  return orgSha256Hex(enc(`${TAG_ORG_PROPOSAL}|recipients|${lines.sort().join(";")}`));
}

const proposalContext = (orgId: string, proposalId: string, recipient: string): Bytes[] => [orgId, proposalId, recipient].map(enc);

/**
 * Builds and signs a proposal on the connector box: `payload` (a canonical directory entry body) is
 * sealed to each org admin's verified seat KEM key; the box never learns any org key.
 */
export function buildOrgProposal(args: {
  orgId: string;
  proposalId: string;
  connectorId: string;
  kind: OrgProposalKind;
  subject: string;
  roles: unknown[];
  rolesHash: string;
  payload: Bytes;
  admins: readonly OrgKemKey[];
  issuedAt: number;
  connectorSecret: Bytes;
  /** Vectors only: fixed encapsulation randomness (64 bytes per recipient) and a deterministic signature. */
  randomness?: (i: number) => Bytes;
}): OrgProposalBundle {
  const recipients = args.admins.map((k, i) => {
    const opts = { purpose: TAG_ORG_PROPOSAL, senderKeyId: new Uint8Array(32), issuedAt: args.issuedAt };
    const ctx = proposalContext(args.orgId, args.proposalId, k.recipient);
    const sealed = args.randomness ? hybridSealWithRandomness(k.kemPub, opts, ctx, args.payload, args.randomness(i)) : hybridSeal(k.kemPub, opts, ctx, args.payload);
    return { recipient: k.recipient, kemKeyId: k.kemKeyId, sealedHex: hex(sealed) };
  });
  const proposal: OrgProposal = {
    orgId: args.orgId,
    proposalId: args.proposalId,
    connectorId: args.connectorId,
    kind: args.kind,
    subject: args.subject,
    rolesHash: args.rolesHash,
    sealedSha256: orgProposalRecipientsHash(recipients),
    issuedAt: args.issuedAt,
  };
  const sig = hybridSign(args.connectorSecret, TAG_ORG_PROPOSAL, canonicalOrgProposal(proposal), { deterministic: !!args.randomness });
  return { proposal, roles: args.roles, recipients, signature: hex(sig) };
}

/**
 * Checks a proposal against the connector record it names: the connector is active, has the scope
 * for this kind, its key signed exactly these bytes, and the sealed copies are the ones signed.
 * `rolesHash` is the caller's orgSeatRolesHash(bundle.roles) (or "" when no roles). Throws.
 */
export function verifyOrgProposal(
  connector: OrgConnectorBundle,
  b: OrgProposalBundle,
  opts: { rolesHash: string; now: number },
): void {
  const p = b.proposal;
  const msg = canonicalOrgProposal(p);
  const c = connector.connector;
  if (p.orgId !== c.orgId || p.connectorId !== c.connectorId) fail("wrong-org", "another connector");
  if (c.status !== "active") fail("seat-revoked", `connector ${c.status}`);
  if (!c.scopes.includes(orgProposalScope(p.kind))) fail("scope", p.kind);
  if (p.issuedAt > opts.now + MAX_SKEW_MS) fail("future");
  if (p.rolesHash !== opts.rolesHash) fail("order-mismatch", "roles");
  if (orgProposalRecipientsHash(b.recipients) !== p.sealedSha256) fail("order-mismatch", "sealed copies");
  try {
    hybridVerify(fromHex(connector.connectorPubHex), TAG_ORG_PROPOSAL, msg, fromHex(String(b.signature ?? "")));
  } catch {
    fail("bad-signature");
  }
}

/** Opens an admin's copy of a proposal's sealed payload with the admin's seat KEM secret. */
export function openOrgProposal(b: Pick<OrgProposalBundle, "proposal" | "recipients">, recipient: string, kemSecret: Bytes): Bytes {
  const mine = b.recipients.find((x) => x.recipient === recipient);
  if (!mine) fail("seat-unknown", "not a recipient");
  return hybridOpen(kemSecret, TAG_ORG_PROPOSAL, proposalContext(b.proposal.orgId, b.proposal.proposalId, recipient), fromHex(mine!.sealedHex)).plaintext;
}

export interface OrgProposalDecisionStatement {
  orgId: string;
  proposalId: string;
  decision: OrgProposalDecision;
  /** The digest of the order the admin carried out (the invite, revoke or grant), zeros for a decline. */
  refSha256: string;
  issuedAt: number;
}

export function canonicalOrgProposalDecision(d: OrgProposalDecisionStatement): Bytes {
  match("orgId", HEX16, d.orgId);
  match("proposalId", HEX16, d.proposalId);
  oneOf("decision", ["done", "declined"] as const, d.decision);
  match("refSha256", HEX32, d.refSha256);
  if ((d.decision === "declined") !== (d.refSha256 === ZERO64)) fail("malformed", "refSha256");
  uint("issuedAt", d.issuedAt);
  return enc([TAG_ORG_PROPOSAL, "decision", d.orgId, d.proposalId, d.decision, d.refSha256, d.issuedAt].join("|"));
}

/** SHA-256 of a connector's mapping as its canonical JSON (sorted keys), for `mappingSha256`. */
export function orgConnectorMappingSha256(mapping: unknown): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
  return hex(sha256(enc(JSON.stringify(canon(mapping)))));
}

// ── the connector's setup, sealed to its box ────────────────────────────

/**
 * What the admin's phone hands the connector box, hybrid-sealed (X-Wing) to the box's org KEM key
 * (purpose flagship/org-connector/v1, context [orgId, connectorId, serverDomain]) and stored on
 * `.com` beside the record as ciphertext. The phone makes the connector's hybrid seeds, so the box
 * key's id is in the record the admin approved; the box checks the seeds against it and the mapping
 * against `mappingSha256`, so a setup from any other record does not open into this one. The SCIM
 * token is shown once on the phone; only its SHA-256 travels. LDAP bind passwords travel only here.
 */
export interface OrgConnectorSetup {
  /** Left out of a later setup that keeps the mapping (a token rotation, new LDAP settings): the box keeps its own. */
  /**
   * Ed25519 seed (32 bytes) then ML-DSA-65 seed (32 bytes), hex. Present in the first setup; a later
   * one (a mapping edit, a token rotation, new LDAP settings) leaves it out and the box keeps the
   * seeds it already opened (the record's key never changes).
   */
  connectorSeedsHex?: string;
  mapping?: OrgConnectorMapping;
  /** SCIM: SHA-256 of the bearer token, hex. */
  scimTokenSha256?: string;
  /** When the token was made (the console warns after 365 days). */
  scimTokenIssuedAt?: number;
  /** LDAP pull settings. */
  ldap?: {
    url: string;
    bindDn: string;
    bindPassword: string;
    baseDn: string;
    userFilter: string;
    groupFilter?: string;
    intervalMinutes?: number;
    /** `ad` (default) or `openldap`: picks the attribute defaults. */
    flavor?: "ad" | "openldap";
    attributes?: { externalId?: string; userName?: string; displayName?: string; memberOf?: string; disabled?: string };
  };
}

/** The admin-edited mapping: attribute names and groups → org roles (no names of people). */
export interface OrgConnectorMapping {
  attributes: { email: string; displayName: string; externalId: string; disabled?: string };
  /** Directory group (name or DN) → the roles a member of it is proposed. */
  groups: Record<string, unknown[]>;
  /** Roles for a user in no mapped group; empty = no invitation is proposed. */
  defaultRoles?: unknown[];
}

const setupContext = (c: Pick<OrgConnector, "orgId" | "connectorId" | "serverDomain">): Bytes[] => [c.orgId, c.connectorId, c.serverDomain].map(enc);

export function sealOrgConnectorSetup(c: OrgConnector, boxKem: OrgKemKey, setup: OrgConnectorSetup, issuedAt: number): { kemKeyId: string; sealedHex: string } {
  if (boxKem.recipient !== `box:${c.serverDomain}`) fail("scope", "not the connector's box");
  const sealed = hybridSeal(boxKem.kemPub, { purpose: TAG_ORG_CONNECTOR, senderKeyId: new Uint8Array(32), issuedAt }, setupContext(c), enc(JSON.stringify(setup)));
  return { kemKeyId: boxKem.kemKeyId, sealedHex: hex(sealed) };
}

/**
 * The box opens its connector's setup and checks it against the approved record. A setup without
 * seeds takes `knownSeedsHex` (what the box kept from the first one). Throws.
 */
export function openOrgConnectorSetup(
  c: OrgConnector,
  sealed: { sealedHex: string },
  boxKemSecret: Bytes,
  keygen: (ed: Bytes, ml: Bytes) => { publicKey: Bytes },
  knownSeedsHex?: string,
  known?: Pick<OrgConnectorSetup, "mapping" | "scimTokenSha256" | "scimTokenIssuedAt" | "ldap">,
): OrgConnectorSetup & { connectorSeedsHex: string; mapping: OrgConnectorMapping } {
  let setup: OrgConnectorSetup;
  try {
    setup = JSON.parse(new TextDecoder().decode(hybridOpen(boxKemSecret, TAG_ORG_CONNECTOR, setupContext(c), fromHex(String(sealed?.sealedHex ?? ""))).plaintext));
  } catch {
    return fail("malformed", "setup does not open");
  }
  if (setup.connectorSeedsHex === undefined && knownSeedsHex !== undefined) setup.connectorSeedsHex = knownSeedsHex;
  // A partial setup changes only what it carries; the rest is what the box opened before.
  if (known) {
    if (setup.mapping === undefined) setup.mapping = known.mapping;
    if (setup.scimTokenSha256 === undefined && known.scimTokenSha256 !== undefined) {
      setup.scimTokenSha256 = known.scimTokenSha256;
      setup.scimTokenIssuedAt = known.scimTokenIssuedAt;
    }
    if (setup.ldap === undefined && known.ldap !== undefined) setup.ldap = known.ldap;
  }
  if (typeof setup.connectorSeedsHex !== "string" || !/^[0-9a-f]{128}$/.test(setup.connectorSeedsHex)) fail("malformed", "seeds");
  const seeds = fromHex(setup.connectorSeedsHex as string);
  if (orgConnectorKeyId(keygen(seeds.subarray(0, 32), seeds.subarray(32)).publicKey) !== c.connectorKeyId) fail("binding", "setup seeds");
  if (orgConnectorMappingSha256(setup.mapping) !== c.mappingSha256) fail("order-mismatch", "mapping");
  if (setup.scimTokenSha256 !== undefined) match("scimTokenSha256", HEX32, setup.scimTokenSha256);
  return setup as OrgConnectorSetup & { connectorSeedsHex: string; mapping: OrgConnectorMapping };
}

// ── the mapping, readable by org admins ─────────────────────────────────

/**
 * The connector's mapping sealed under the org directory key (AES-256-GCM; key HKDF(directoryKey,
 * info = flagship/org-connector/v1|mapping|<orgId>|<connectorId>|<keyVersion>), the same text as AAD),
 * carried beside the record so any org admin's phone can show and edit it. Group names are the org's
 * structure, not people, but `.com` still never reads them.
 */
export interface OrgConnectorMappingSealed {
  keyVersion: number;
  sealedHex: string;
}

function mappingInfo(orgId: string, connectorId: string, keyVersion: number): Bytes {
  match("orgId", HEX16, orgId);
  match("connectorId", HEX16, connectorId);
  uint("keyVersion", keyVersion);
  return enc([TAG_ORG_CONNECTOR, "mapping", orgId, connectorId, keyVersion].join("|"));
}

export function sealOrgConnectorMapping(orgId: string, connectorId: string, directoryKey: Bytes, keyVersion: number, mapping: OrgConnectorMapping, nonce?: Bytes): OrgConnectorMappingSealed {
  if (directoryKey.length !== 32) fail("malformed", "directory key");
  const info = mappingInfo(orgId, connectorId, keyVersion);
  const key = hkdf(sha256, directoryKey, new Uint8Array(0), info, 32);
  const n = nonce ?? crypto.getRandomValues(new Uint8Array(12));
  const ct = gcm(key, n, info).encrypt(enc(canonicalMappingJson(mapping)));
  const out = new Uint8Array(12 + ct.length);
  out.set(n, 0);
  out.set(ct, 12);
  return { keyVersion, sealedHex: hex(out) };
}

export function openOrgConnectorMapping(orgId: string, connectorId: string, directoryKey: Bytes, sealed: OrgConnectorMappingSealed): OrgConnectorMapping {
  const info = mappingInfo(orgId, connectorId, sealed.keyVersion);
  const key = hkdf(sha256, directoryKey, new Uint8Array(0), info, 32);
  const b = fromHex(String(sealed.sealedHex ?? ""));
  try {
    return JSON.parse(new TextDecoder().decode(gcm(key, b.subarray(0, 12), info).decrypt(b.subarray(12)))) as OrgConnectorMapping;
  } catch {
    return fail("malformed", "mapping does not open");
  }
}

function canonicalMappingJson(mapping: unknown): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(canon(mapping));
}
