import {
  OrgAuthorityError,
  buildOrgKeyRings,
  canonicalOrgKeyRing,
  canonicalOrgServerCode,
  newestOrgKems,
  orgApprovalFromWire,
  orgKeyChainId,
  orgPendingRotations,
  orgServerCodeSha256,
  orgSha256Hex,
  verifyOrgBoxKem,
  verifyOrgBoxLogHead,
  canonicalOrgBoxLogHead,
  verifyOrgKeyRing,
  verifyOrgSeatKem,
  verifyOrgServerCode,
  verifyOrgServerRegister,
  verifyOrgServerEnrolment,
  orgConnectorsToReapprove,
  type OrgConnectorBundle,
  type OrgApproval,
  type OrgAuditObjects,
  type OrgBoxKemBundle,
  type OrgBoxLogHeadBundle,
  type OrgKemKey,
  type OrgKeyRingBundle,
  type OrgKeyRings,
  type OrgSeatKemBundle,
  type OrgServerCode,
  type OrgServerRegister,
} from "@flagship/protocol";
import type { AuthCodeStorage, ServerStorage } from "@flagship/storage";
import { validateServerLabel } from "./labels.js";
import { DEFAULT_PAYMENTS_CONFIG } from "@flagship/protocol";
import { orgPlanGate } from "./orgPlan.js";
import { loadOrg, type OrgDeps, type OrgView } from "./orgs.js";
import { conflict, forbidden, malformed, notFound, ok, type HandlerResponseWithHeaders } from "./types.js";

/**
 * Org servers, the org key ring and the audit export on `.com` (docs/enterprise-accounts.md
 * "Org servers", §5.4, §8, §11). Routes:
 *
 *   POST /api/orgs/:orgId/servers/code      { code, approvals }     issue a server code (the org's AuthCode)
 *   POST /api/orgs/:orgId/servers/register  { request, signature, enrolmentSignature }
 *                                                                   the box registers with it (its STK, and the
 *                                                                   enrolment key from its recipe, which the code names)
 *   GET  /api/orgs/:orgId/servers                                   the org's servers
 *   POST /api/orgs/:orgId/seat-kems         seat KEM bundle         a seat's X-Wing key (signed by the seat)
 *   POST /api/orgs/:orgId/box-kems          box KEM bundle          a box's X-Wing key (signed by its STK)
 *   GET  /api/orgs/:orgId/keys                                      key-ring versions, KEM keys, pending rotations
 *   POST /api/orgs/:orgId/keys              { ring, recipients, approvals }   a new version
 *   POST /api/orgs/:orgId/box-log-heads     { head, signature }     a box's signed Activity log head
 *   GET  /api/orgs/:orgId/export                                    everything an audit export holds, unsigned
 *
 * Adding a server is admin-only (owner rule, 2026-10-16) and, in an org, "an org admin's or a
 * servers-add seat's approval": `.com` runs the same predicate the box runs over the chain it
 * re-verifies here, and keeps only the code it admitted, so a box can register only with that code.
 */
export interface OrgServerDeps extends OrgDeps {
  servers: ServerStorage;
  /** Serials share one space with personal AuthCodes. */
  authCodes?: AuthCodeStorage;
  /** `flagship.services` in prod, the gym's apex in the gym. */
  apex?: string;
  maxRegisterAgeMs?: number;
}

/** The sentence every app shows (from its own catalog) when a seat without the right adds a server. */
export const ORG_ADD_SERVER_REFUSED_CODE = "org-add-server-refused";

const nowOf = (d: OrgDeps) => (d.now ?? (() => Date.now()))();
const pad = (v: number) => String(v).padStart(10, "0");
const parse = <T>(json: string): T => JSON.parse(json) as T;
const refuse = (e: unknown): HandlerResponseWithHeaders => {
  if (e instanceof OrgAuthorityError) return { status: 403, body: { error: e.message, code: `org-${e.code}` } };
  return malformed(e instanceof Error ? e.message : "malformed");
};
const refused = (code: string, error: string): HandlerResponseWithHeaders => ({ status: 403, body: { error, code } });

interface StoredCode {
  code: OrgServerCode;
  approvals: OrgApproval[];
  signers: string[];
}

interface StoredServer {
  serverDomain: string;
  serial: string;
  identityPubKeyHex: string;
  registeredAt: number;
}

async function listParsed<T>(deps: OrgDeps, orgId: string, kind: Parameters<OrgDeps["orgs"]["listObjects"]>[1]): Promise<T[]> {
  return (await deps.orgs.listObjects(orgId, kind)).map((o) => parse<T>(o.bodyJson));
}

async function orgServers(deps: OrgDeps, orgId: string): Promise<StoredServer[]> {
  return listParsed<StoredServer>(deps, orgId, "server");
}

/** Verified KEM keys of live recipients (a departed seat's statement stops verifying). */
async function orgKems(deps: OrgDeps, v: OrgView, servers: StoredServer[], now: number): Promise<{ kems: Map<string, OrgKemKey>; seat: OrgSeatKemBundle[]; box: OrgBoxKemBundle[] }> {
  const [seat, box] = await Promise.all([listParsed<OrgSeatKemBundle>(deps, v.org.orgId, "seat-kem"), listParsed<OrgBoxKemBundle>(deps, v.org.orgId, "box-kem")]);
  const keys: OrgKemKey[] = [];
  for (const s of seat) {
    try {
      keys.push(verifyOrgSeatKem(v.state, v.book, s, now));
    } catch {
      /* a departed or unknown seat */
    }
  }
  const stk = new Map(servers.map((s) => [s.serverDomain, s.identityPubKeyHex]));
  for (const b of box) {
    const pub = stk.get(b.statement?.serverDomain);
    if (!pub) continue;
    try {
      keys.push(verifyOrgBoxKem(b, v.org.orgId, pub, now));
    } catch {
      /* a statement under an older identity */
    }
  }
  return { kems: newestOrgKems(keys), seat, box };
}

async function orgRings(deps: OrgDeps, v: OrgView, servers: StoredServer[], kems: Map<string, OrgKemKey>, now: number): Promise<{ bundles: OrgKeyRingBundle[]; rings: OrgKeyRings }> {
  const bundles = await listParsed<OrgKeyRingBundle>(deps, v.org.orgId, "key-ring");
  const rings = buildOrgKeyRings({ state: v.state, book: v.book, kems, servers: new Set(servers.map((s) => s.serverDomain)), now }, bundles);
  return { bundles, rings };
}

export async function handleOrgServerCode(deps: OrgServerDeps, orgId: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const b = body as { code?: OrgServerCode; approvals?: unknown[] } | undefined;
  if (!b?.code || !Array.isArray(b.approvals)) return malformed("code and approvals required");
  try {
    canonicalOrgServerCode(b.code);
    const v = await loadOrg(deps, orgId, now);
    if (!v) return notFound("org not found");
    const label = validateServerLabel(b.code.serverName);
    if (!label.ok) return malformed(label.reason);
    const apex = deps.apex ?? "flagship.services";
    if (b.code.serverDomain !== `${label.label}.${v.org.name}.${apex}`) return malformed(`serverDomain must equal ${label.label}.${v.org.name}.${apex}`);
    if (Math.abs(now - b.code.issuedAt) > 5 * 60_000) return malformed("stale request");
    if (orgPlanGate(deps.payments ?? DEFAULT_PAYMENTS_CONFIG, v.org, now, "add-server")) return refused("org-plan-lapsed", "the org's plan has lapsed: no new servers");
    if (await deps.usernames.get(v.org.name)) return conflict("the org's name is held by a personal account");
    const existing = await deps.servers.get(b.code.serverDomain);
    if (existing && !existing.revokedAt) return conflict("server name taken");
    if (deps.authCodes && (await deps.authCodes.get(b.code.serial))) return conflict("serial taken");
    let signers: string[];
    try {
      signers = verifyOrgServerCode(v.state, v.book, b.code, b.approvals.map(orgApprovalFromWire), now).signers;
    } catch (e) {
      if (e instanceof OrgAuthorityError && (e.code === "scope" || e.code === "unknown-signer" || e.code === "not-an-admin" || e.code === "seat-unknown")) {
        return refused(ORG_ADD_SERVER_REFUSED_CODE, "only an org admin, or a seat allowed to add servers, can add a server");
      }
      throw e;
    }
    const stored: StoredCode = { code: b.code, approvals: b.approvals as OrgApproval[], signers };
    const put = await deps.orgs.putObject(orgId, { kind: "server-code", key: b.code.serial, bodyJson: JSON.stringify(stored), issuedAt: b.code.issuedAt, storedAt: now });
    if (!put) return conflict("serial taken");
    await deps.orgs.appendLog(orgId, "server-code", orgServerCodeSha256(b.code), now);
    return ok({ serial: b.code.serial, serverDomain: b.code.serverDomain, expiresAt: b.code.expiresAt, codeSha256: orgServerCodeSha256(b.code) });
  } catch (e) {
    return refuse(e);
  }
}

export async function handleOrgServerRegister(deps: OrgServerDeps, orgId: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const b = body as { request?: OrgServerRegister; signature?: unknown; enrolmentSignature?: unknown } | undefined;
  if (!b?.request || typeof b.signature !== "string") return malformed("request and signature required");
  const r = b.request;
  try {
    if (r.orgId !== orgId) return malformed("orgId");
    if (!verifyOrgServerRegister(r, b.signature)) return forbidden("invalid server-identity signature");
    const age = now - r.issuedAt;
    if (age > (deps.maxRegisterAgeMs ?? 5 * 60_000) || age < -60_000) return forbidden("stale registration");
    const o = await deps.orgs.getObject(orgId, "server-code", r.serial);
    if (!o) return notFound("unknown serial");
    const c = parse<StoredCode>(o.bodyJson);
    if (orgServerCodeSha256(c.code) !== r.codeSha256 || c.code.serverDomain !== r.serverDomain) return forbidden("the code does not match the one issued");
    // Only the box holding the recipe holds the enrolment key: the code alone (or its serial) registers nothing.
    if (!verifyOrgServerEnrolment(r, c.code, b.enrolmentSignature)) {
      return { status: 403, body: { error: "the registration is not signed by the code's enrolment key", code: "org-enrolment-signature" } };
    }
    if (c.code.expiresAt < now) return conflict("expired");
    const v = await loadOrg(deps, orgId, now);
    if (!v) return notFound("org not found");
    // The approver must still be able to add servers: a seat revoked or frozen since issue cannot.
    try {
      verifyOrgServerCode(v.state, v.book, c.code, c.approvals, c.code.issuedAt + 1);
    } catch {
      return refused(ORG_ADD_SERVER_REFUSED_CODE, "the approval of this server no longer holds");
    }
    for (const s of c.signers) {
      const frozen = v.book.freezes.some((f) => f.seatId === s && f.issuedAt <= now && now < f.untilMs);
      if (frozen || v.book.revoked.has(s) || (!v.state.current.admins.some((a) => a.seatId === s) && !v.book.seats.has(s))) {
        return refused(ORG_ADD_SERVER_REFUSED_CODE, "the approval of this server no longer holds");
      }
    }
    const used = await deps.orgs.putObject(orgId, { kind: "server-code", key: `${r.serial}:used`, bodyJson: JSON.stringify({ usedAt: now }), issuedAt: now, storedAt: now });
    if (!used) return conflict("already used");
    const existing = await deps.servers.get(r.serverDomain);
    if (existing && !existing.revokedAt) return conflict("server name taken");
    const srv: StoredServer = { serverDomain: r.serverDomain, serial: r.serial, identityPubKeyHex: r.serverIdentityPubKeyHex, registeredAt: now };
    await deps.orgs.putObject(orgId, { kind: "server", key: r.serverDomain, bodyJson: JSON.stringify(srv), issuedAt: now, storedAt: now }, true);
    await deps.servers.put({ serverDomain: r.serverDomain, username: v.org.name, identityPubKeyHex: r.serverIdentityPubKeyHex, registeredAt: now });
    await deps.orgs.putObject(orgId, { kind: "server-registration", key: `${r.serverDomain}|${r.serverIdentityPubKeyHex}`, bodyJson: JSON.stringify({ serverDomain: r.serverDomain, identityPubKeyHex: r.serverIdentityPubKeyHex }), issuedAt: now, storedAt: now }, true);
    await deps.orgs.appendLog(orgId, "server-registered", orgSha256Hex(new TextEncoder().encode(`${r.serverDomain}|${r.serverIdentityPubKeyHex}`)), now);
    return ok({ ok: true, serverDomain: r.serverDomain, registeredAt: now, orgId, genesisHash: c.code.genesisHash });
  } catch (e) {
    return refuse(e);
  }
}

export async function handleOrgServersList(deps: OrgServerDeps, orgId: string): Promise<HandlerResponseWithHeaders> {
  if (!/^[0-9a-f]{32}$/.test(orgId)) return malformed("orgId");
  if (!(await deps.orgs.getOrg(orgId))) return notFound("org not found");
  const list = await orgServers(deps, orgId);
  const out = [];
  for (const s of list) {
    const rec = await deps.servers.get(s.serverDomain);
    out.push({ ...s, revoked: rec?.revokedAt ? { at: rec.revokedAt } : null });
  }
  return ok({ servers: out });
}

export async function handleOrgSeatKem(deps: OrgServerDeps, orgId: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const b = body as OrgSeatKemBundle | undefined;
  if (!b?.statement) return malformed("statement required");
  try {
    const v = await loadOrg(deps, orgId, now);
    if (!v) return notFound("org not found");
    if (Math.abs(now - b.statement.issuedAt) > 10 * 60_000) return malformed("stale statement");
    verifyOrgSeatKem(v.state, v.book, b, now);
    await deps.orgs.putObject(orgId, { kind: "seat-kem", key: b.statement.seatId, bodyJson: JSON.stringify(b), issuedAt: b.statement.issuedAt, storedAt: now }, true);
    return ok({ seatId: b.statement.seatId, kemKeyId: b.statement.kemKeyId });
  } catch (e) {
    return refuse(e);
  }
}

export async function handleOrgBoxKem(deps: OrgServerDeps, orgId: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const b = body as OrgBoxKemBundle | undefined;
  if (!b?.statement) return malformed("statement required");
  try {
    if (!(await deps.orgs.getOrg(orgId))) return notFound("org not found");
    const srv = await deps.orgs.getObject(orgId, "server", String(b.statement.serverDomain));
    if (!srv) return notFound("not an org server");
    const pub = parse<StoredServer>(srv.bodyJson).identityPubKeyHex;
    if (Math.abs(now - b.statement.issuedAt) > 10 * 60_000) return malformed("stale statement");
    verifyOrgBoxKem(b, orgId, pub, now);
    await deps.orgs.putObject(orgId, { kind: "box-kem", key: b.statement.serverDomain, bodyJson: JSON.stringify(b), issuedAt: b.statement.issuedAt, storedAt: now }, true);
    return ok({ serverDomain: b.statement.serverDomain, kemKeyId: b.statement.kemKeyId });
  } catch (e) {
    return refuse(e);
  }
}

/**
 * A box's own signed log head (`flagship/org-box-log-head/v1`, its STK): kept newest per server and
 * named in the org log, so the audit export pins each box's record of what it did. A head at the
 * same sequence with another hash, or an older one, is refused (a box never rewrites its log).
 */
export async function handleOrgBoxLogHead(deps: OrgServerDeps, orgId: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const b = body as OrgBoxLogHeadBundle | undefined;
  if (!b?.head || typeof b.signature !== "string") return malformed("head and signature required");
  try {
    if (b.head.orgId !== orgId) return malformed("orgId");
    if (!(await deps.orgs.getOrg(orgId))) return notFound("org not found");
    const srv = await deps.orgs.getObject(orgId, "server", String(b.head.serverDomain));
    if (!srv) return notFound("not an org server");
    const rec = await deps.servers.get(b.head.serverDomain);
    if (rec?.revokedAt) return forbidden("server revoked");
    if (Math.abs(now - b.head.issuedAt) > 10 * 60_000) return malformed("stale head");
    verifyOrgBoxLogHead(b, parse<StoredServer>(srv.bodyJson).identityPubKeyHex);
    const prev = await deps.orgs.getObject(orgId, "box-log-head", b.head.serverDomain);
    if (prev) {
      const p = parse<OrgBoxLogHeadBundle>(prev.bodyJson).head;
      if (b.head.seq < p.seq || b.head.issuedAt <= p.issuedAt) return conflict("older than the head kept");
      if (b.head.seq === p.seq && b.head.headHash !== p.headHash) return conflict("a different log at the same sequence");
      if (b.head.seq === p.seq) return ok({ serverDomain: b.head.serverDomain, seq: b.head.seq, unchanged: true });
    }
    await deps.orgs.putObject(orgId, { kind: "box-log-head", key: b.head.serverDomain, bodyJson: JSON.stringify(b), issuedAt: b.head.issuedAt, storedAt: now }, true);
    // Every logged head stays, so the audit export can show the served head is the last one logged (05c review F5).
    await deps.orgs.putObject(orgId, { kind: "box-log-head-seen", key: `${b.head.serverDomain}|${String(b.head.seq).padStart(16, "0")}|${b.head.headHash}`, bodyJson: JSON.stringify(b), issuedAt: b.head.issuedAt, storedAt: now }, true);
    await deps.orgs.appendLog(orgId, "box-log-head", orgSha256Hex(canonicalOrgBoxLogHead(b.head)), now);
    return ok({ serverDomain: b.head.serverDomain, seq: b.head.seq });
  } catch (e) {
    return refuse(e);
  }
}

export async function handleOrgKeysGet(deps: OrgServerDeps, orgId: string): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  if (!/^[0-9a-f]{32}$/.test(orgId)) return malformed("orgId");
  try {
    const v = await loadOrg(deps, orgId, now);
    if (!v) return notFound("org not found");
    const servers = await orgServers(deps, orgId);
    const { kems, seat, box } = await orgKems(deps, v, servers, now);
    const { bundles, rings } = await orgRings(deps, v, servers, kems, now);
    const pending = orgPendingRotations(v.state, v.book, rings, { revokes: v.revokes, grants: v.grants });
    // A departed admin also leaves the connectors it approved to re-approve (docs/org-directory.md).
    const connectors = (await deps.orgs.listObjects(orgId, "connector")).map((o) => parse<OrgConnectorBundle>(o.bodyJson));
    const pendingConnectors = orgConnectorsToReapprove(v.state, v.book, connectors, now);
    return ok({ rings: bundles, seatKems: seat, boxKems: box, pending, pendingConnectors, refused: rings.refused });
  } catch (e) {
    return refuse(e);
  }
}

export async function handleOrgKeyRingPost(deps: OrgServerDeps, orgId: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const b = body as OrgKeyRingBundle | undefined;
  if (!b?.ring || !Array.isArray(b.recipients) || !Array.isArray(b.approvals)) return malformed("ring, recipients and approvals required");
  try {
    const order = canonicalOrgKeyRing(b.ring);
    if (Math.abs(now - b.ring.issuedAt) > 10 * 60_000) return malformed("stale ring");
    const v = await loadOrg(deps, orgId, now);
    if (!v) return notFound("org not found");
    const servers = await orgServers(deps, orgId);
    const { kems } = await orgKems(deps, v, servers, now);
    const { rings } = await orgRings(deps, v, servers, kems, now);
    const chain = rings.chains.get(orgKeyChainId(b.ring.kind, b.ring.scope)) ?? [];
    const prev = chain[chain.length - 1]?.ring ?? null;
    const bundle: OrgKeyRingBundle = { ring: b.ring, recipients: b.recipients, approvals: b.approvals.map(orgApprovalFromWire) };
    verifyOrgKeyRing({ state: v.state, book: v.book, kems, servers: new Set(servers.map((s) => s.serverDomain)), now }, bundle, prev, { fresh: true });
    const key = `${b.ring.kind}|${b.ring.scope}|${pad(b.ring.version)}`;
    const put = await deps.orgs.putObject(orgId, { kind: "key-ring", key, bodyJson: JSON.stringify(bundle), issuedAt: b.ring.issuedAt, storedAt: now });
    if (!put) return conflict("version already recorded");
    await deps.orgs.appendLog(orgId, "key-ring", orgSha256Hex(order), now);
    return ok({ kind: b.ring.kind, scope: b.ring.scope, version: b.ring.version });
  } catch (e) {
    return refuse(e);
  }
}

/**
 * Each server's signed head as the log last names it: a head stored while the export was read (or whose log
 * entry failed to append) is not served ahead of its log entry, so the export stays consistent (05c review F5).
 */
function lastLoggedHeads(log: ReadonlyArray<{ kind: string; refSha256: string }>, newest: OrgBoxLogHeadBundle[], seen: OrgBoxLogHeadBundle[]): OrgBoxLogHeadBundle[] {
  const byRef = new Map<string, OrgBoxLogHeadBundle>();
  for (const b of [...seen, ...newest]) byRef.set(orgSha256Hex(canonicalOrgBoxLogHead(b.head)), b);
  const last = new Map<string, OrgBoxLogHeadBundle>();
  for (const e of log) {
    if (e.kind !== "box-log-head") continue;
    const b = byRef.get(e.refSha256);
    if (b) last.set(b.head.serverDomain, b);
  }
  return [...last.values()];
}

/** Everything an audit export holds; an org admin signs its statement on a phone, an auditor verifies it offline. */
export async function handleOrgExport(deps: OrgServerDeps, orgId: string): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  if (!/^[0-9a-f]{32}$/.test(orgId)) return malformed("orgId");
  try {
    const v = await loadOrg(deps, orgId, now);
    if (!v) return notFound("org not found");
    const [rings, codes, log, servers, heads, seen, registrations] = await Promise.all([
      listParsed<OrgKeyRingBundle>(deps, orgId, "key-ring"),
      deps.orgs.listObjects(orgId, "server-code"),
      deps.orgs.listLog(orgId, 0),
      orgServers(deps, orgId),
      listParsed<OrgBoxLogHeadBundle>(deps, orgId, "box-log-head"),
      listParsed<OrgBoxLogHeadBundle>(deps, orgId, "box-log-head-seen"),
      listParsed<{ serverDomain: string; identityPubKeyHex: string }>(deps, orgId, "server-registration"),
    ]);
    const objects: OrgAuditObjects = {
      orgId,
      genesisHash: v.org.genesisHash,
      entries: v.entries,
      freezes: v.freezes,
      overturns: v.overturns,
      vetoes: v.vetoes,
      grants: v.grants,
      revokes: v.revokes,
      keyRings: rings,
      // Only codes already used: a registered server's code is what the audit checks against, and it can never
      // register again. An unused code is a secret until its box redeems it, so the export never carries one.
      serverCodes: codes
        .filter((o) => !o.key.endsWith(":used") && codes.some((u) => u.key === `${o.key}:used`))
        .map((o) => {
          const c = parse<StoredCode>(o.bodyJson);
          return { code: c.code, approvals: c.approvals };
        }),
      log: log.map((e) => ({ seq: e.seq, prevHash: e.prevHash, entryHash: e.entryHash, kind: e.kind, refSha256: e.refSha256, at: e.at })),
      servers: servers.map((s) => ({ serverDomain: s.serverDomain, serial: s.serial, identityPubKeyHex: s.identityPubKeyHex })),
      boxLogHeads: lastLoggedHeads(log, heads, seen),
      boxLogHeadHistory: seen.map((b) => b.head),
      registrations,
    };
    return ok({ ...objects, currentVersion: v.state.current.version, currentHash: v.state.currentHash });
  } catch (e) {
    return refuse(e);
  }
}
