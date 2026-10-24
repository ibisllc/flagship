import {
  PolicyError,
  PqTrustError,
  TAG_ASSURANCE_POLICY,
  advanceRollout,
  applyPolicyChange,
  assurancePolicyDigest,
  canonicalAssurancePolicyChange,
  legacyPolicyState,
  pqKeyBindingFromWire,
  verifyCriticalSignature,
  verifyPqKeyBinding,
  POLICY_SCOPE_KINDS,
  type AssurancePolicyChange,
  type PolicyScope,
  type PolicyState,
  type PqBindingRole,
  type PqKeyBindingWire,
  type RolloutEvidence,
  type SignatureEnvelope,
  type VerifiedPqKeyBinding,
} from "@flagship/protocol";
import type {
  DeviceCapabilityGrantStorage,
  DeviceIdentityStorage,
  PolicyStateRecord,
  PqKeyBindingRecord,
  PqTrustStorage,
  ServerStorage,
  UsernameRecord,
  UsernameStorage,
  WebauthnRecoveryStorage,
} from "@flagship/storage";
import { authorizeSensitiveComOp } from "./adminAuthorityGate.js";
import { verifiedStoredStkBinding } from "./pqKeyBindings.js";
import { conflict, forbidden, malformed, notFound, ok, type HandlerResponseWithHeaders } from "./types.js";

/**
 * Architecture v2 milestone 2 (docs/architecture-v2/pq-suites.md §11): the phone-held
 * identities' key bindings and the owner-signed assurance policy, as `.com` stores and serves them.
 *
 * `PUT /api/accounts/:u/pq-key-bindings`  body = one binding (`account-irk`, `admin-root` or
 *     `device`). Stored only when it verifies under the key `.com` already holds for that
 *     identity: the account's CURRENT IRK, its pinned admin root, or the live device row's key.
 *     That is the existing classical authority: a re-paired IRK becomes current only when the
 *     re-pair's wait/veto completes, so its binding is refused (`binding-key-mismatch`) until then,
 *     and the first ML-DSA key per Ed25519 key wins, so a recovered (unrotated) root cannot rebind.
 * `GET /api/accounts/:u/pq-key-bindings`  (read token) the bindings whose Ed25519 key is still
 *     the identity's current key. Boxes get the same set inside the device-grant book.
 * `POST /api/accounts/:u/assurance-policy`  body = `{ change, signature: { suite, signature } }`.
 * `GET /api/accounts/:u/assurance-policy/:kind/:id`  (read token) the scope's state and chain.
 */
export interface AccountPqTrustDeps {
  usernames: UsernameStorage;
  identities: DeviceIdentityStorage;
  grants: DeviceCapabilityGrantStorage;
  servers: ServerStorage;
  pqTrust: PqTrustStorage;
  recovery?: WebauthnRecoveryStorage;
  now?: () => number;
}

const ACCOUNT_ROLES: readonly PqBindingRole[] = ["account-irk", "admin-root", "device"];

export function bindingWire(rec: PqKeyBindingRecord): PqKeyBindingWire {
  return {
    v: 1,
    role: rec.role as PqBindingRole,
    subjectId: rec.subjectId,
    ed25519PubHex: rec.ed25519PubHex,
    mldsaPubHex: rec.mldsaPubHex,
    issuedAt: rec.issuedAt,
    signature: rec.signatureHex,
  };
}

/** The Ed25519 key `.com` trusts for an account identity right now, or null. */
async function trustedKey(deps: AccountPqTrustDeps, userRec: UsernameRecord, role: PqBindingRole, subjectId: string): Promise<string | null> {
  const u = userRec.username.toLowerCase();
  if (role === "account-irk") return subjectId === u ? userRec.irkPubHex.toLowerCase() : null;
  if (role === "admin-root") return subjectId === u && userRec.adminRootPubHex ? userRec.adminRootPubHex.toLowerCase() : null;
  if (role === "device") {
    const d = await deps.identities.get(u, subjectId);
    return d && d.revokedAt === null ? d.devicePubHex.toLowerCase() : null;
  }
  return null;
}

export async function handlePutAccountPqKeyBinding(deps: AccountPqTrustDeps, username: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  const u = username.toLowerCase();
  let wire: PqKeyBindingWire;
  try {
    wire = pqKeyBindingFromWire(body);
  } catch (e) {
    return malformed(e instanceof PqTrustError ? e.code : "malformed body");
  }
  if (!ACCOUNT_ROLES.includes(wire.role)) return forbidden("binding-role");
  const userRec = await deps.usernames.get(u);
  if (!userRec) return notFound("username not registered");
  const key = await trustedKey(deps, userRec, wire.role, wire.subjectId);
  if (!key) return wire.role === "device" ? notFound("unknown device") : forbidden(wire.role === "admin-root" ? "no-admin-root" : "binding-subject");
  try {
    verifyPqKeyBinding(wire, { role: wire.role, subjectId: wire.subjectId, ed25519PubHex: key, now });
  } catch (e) {
    return forbidden(e instanceof PqTrustError ? e.code : "bad-signature");
  }
  const put = await deps.pqTrust.putBinding({
    role: wire.role,
    subjectId: wire.subjectId,
    ed25519PubHex: wire.ed25519PubHex,
    mldsaPubHex: wire.mldsaPubHex,
    issuedAt: wire.issuedAt,
    signatureHex: wire.signature,
    storedAt: now,
  });
  return put.ok ? ok({ ok: true }) : conflict(put.reason);
}

export interface AccountBindingSet {
  accountIrk: PqKeyBindingWire | null;
  adminRoot: PqKeyBindingWire | null;
  /** By deviceId. */
  devices: Map<string, PqKeyBindingWire>;
}

/**
 * The account's stored bindings whose Ed25519 key is the identity's current key (a string
 * compare: readers verify the signatures themselves). `devices` maps live deviceId → pub.
 */
export async function currentAccountBindings(
  pqTrust: PqTrustStorage,
  userRec: UsernameRecord,
  devices: ReadonlyMap<string, string>,
): Promise<AccountBindingSet> {
  return selectCurrentBindings(await pqTrust.listAccountBindings(userRec.username, [...devices.keys()]), userRec, devices);
}

/** Keeps the rows whose Ed25519 key is the identity's current key. */
export function selectCurrentBindings(rows: readonly PqKeyBindingRecord[], userRec: UsernameRecord, devices: ReadonlyMap<string, string>): AccountBindingSet {
  const out: AccountBindingSet = { accountIrk: null, adminRoot: null, devices: new Map() };
  for (const r of rows) {
    const ed = r.ed25519PubHex.toLowerCase();
    if (r.role === "account-irk" && ed === userRec.irkPubHex.toLowerCase()) out.accountIrk = bindingWire(r);
    else if (r.role === "admin-root" && userRec.adminRootPubHex && ed === userRec.adminRootPubHex.toLowerCase()) out.adminRoot = bindingWire(r);
    else if (r.role === "device" && devices.get(r.subjectId) === ed) out.devices.set(r.subjectId, bindingWire(r));
  }
  return out;
}

async function liveDevices(deps: Pick<AccountPqTrustDeps, "identities">, username: string): Promise<Map<string, string>> {
  const rows = await deps.identities.listForAccount(username.toLowerCase());
  return new Map(rows.filter((d) => d.revokedAt === null).map((d) => [d.deviceId, d.devicePubHex.toLowerCase()] as const));
}

export async function handleGetAccountPqKeyBindings(deps: AccountPqTrustDeps, username: string): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  const userRec = await deps.usernames.get(u);
  if (!userRec) return notFound("username not registered");
  const set = await currentAccountBindings(deps.pqTrust, userRec, await liveDevices(deps, u));
  return ok(
    { username: u, accountIrk: set.accountIrk, adminRoot: set.adminRoot, devices: [...set.devices.values()] },
    { "cache-control": "private, no-store" },
  );
}

// ── assurance policy ──────────────────────────────────────────────────────

const PROFILES = new Set(["strict", "compatibility"]);
const ROLLOUTS = new Set(["legacy", "capable", "prepared", "enforced", "retired"]);
const SCOPED_ID = /^([a-z0-9.-]+):[a-z0-9][a-z0-9._-]{0,127}$/;

/** A scope's PolicyState from its row; a row this code cannot read is strict and enforced. */
export function policyStateOf(rec: PolicyStateRecord | null, scope: PolicyScope): PolicyState {
  if (!rec) return legacyPolicyState(scope);
  if (!PROFILES.has(rec.profile) || !ROLLOUTS.has(rec.rollout)) {
    return { scope, profile: "strict", rollout: "enforced", generation: rec.generation, headDigest: rec.headDigest, enforcedEver: true };
  }
  return {
    scope,
    profile: rec.profile as PolicyState["profile"],
    rollout: rec.rollout as PolicyState["rollout"],
    generation: rec.generation,
    headDigest: rec.headDigest,
    enforcedEver: rec.enforcedEver,
  };
}

/**
 * Whether `scope` belongs to `username`, and the server it lives on (installation: the server
 * itself; service/data/connector: `<serverDomain>:<name>`; device: one of the account's devices).
 */
async function ownScope(deps: AccountPqTrustDeps, username: string, scope: PolicyScope): Promise<{ ok: true; server: string | null } | { ok: false; reason: string }> {
  if (!(POLICY_SCOPE_KINDS as readonly string[]).includes(scope.kind) || typeof scope.id !== "string") return { ok: false, reason: "bad scope" };
  if (scope.kind === "device") {
    const d = await deps.identities.get(username, scope.id);
    return d && d.revokedAt === null ? { ok: true, server: null } : { ok: false, reason: "unknown device" };
  }
  const domain = scope.kind === "installation" ? scope.id : SCOPED_ID.exec(scope.id)?.[1];
  if (!domain) return { ok: false, reason: "scope id must be <serverDomain>:<name>" };
  const reg = await deps.servers.get(domain);
  if (!reg || reg.revokedAt || reg.username.toLowerCase() !== username) return { ok: false, reason: "unknown server" };
  return { ok: true, server: domain };
}

async function verifiedBinding(deps: AccountPqTrustDeps, role: PqBindingRole, subjectId: string, ed: string, now: number): Promise<VerifiedPqKeyBinding | null> {
  const rec = await deps.pqTrust.getBinding(role, subjectId);
  if (!rec || rec.ed25519PubHex.toLowerCase() !== ed) return null;
  try {
    return verifyPqKeyBinding(bindingWire(rec), { role, subjectId, ed25519PubHex: ed, now: Math.max(now, rec.issuedAt) });
  } catch {
    return null;
  }
}

/** True when the admin root or at least one admin device has a verified binding. */
async function adminBound(deps: AccountPqTrustDeps, userRec: UsernameRecord, now: number): Promise<boolean> {
  const root = userRec.adminRootPubHex?.toLowerCase();
  if (!root) return false;
  if (await verifiedBinding(deps, "admin-root", userRec.username, root, now)) return true;
  for (const [deviceId, pub] of await liveDevices(deps, userRec.username)) {
    const authz = await authorizeSensitiveComOp({ grants: deps.grants, now: () => now }, { username: userRec.username, userRec, verifyWith: (p) => p === pub, now });
    if (authz.ok && (await verifiedBinding(deps, "device", deviceId, pub, now))) return true;
  }
  return false;
}

/** What `.com` can see of a scope's readiness (pq-suites.md §11.3). */
export async function rolloutEvidence(deps: AccountPqTrustDeps, userRec: UsernameRecord, scope: PolicyScope, server: string | null, now: number): Promise<RolloutEvidence> {
  let own = false;
  let recipients = false;
  if (server) {
    const reg = await deps.servers.get(server);
    const { stkBinding } = await deps.pqTrust.forServer(server);
    own = !!reg && !!verifiedStoredStkBinding(stkBinding, server, reg.identityPubKeyHex, now);
    const boot = await deps.pqTrust.getBootHybrid(server);
    recipients = own && !!boot && !!reg && boot.stkPubHex === reg.identityPubKeyHex.toLowerCase();
  } else {
    const d = await deps.identities.get(userRec.username, scope.id);
    own = !!d && !!(await verifiedBinding(deps, "device", scope.id, d.devicePubHex.toLowerCase(), now));
    recipients = own;
  }
  const rec = deps.recovery ? await deps.recovery.get(userRec.username) : undefined;
  return {
    capabilityAdvertised: own,
    boundPublicKeys: own && (await adminBound(deps, userRec, now)),
    recipientsVerified: recipients,
    // A signed (N03 v2) recovery record: the account can recover under the signed rules.
    recoveryChecked: !!rec?.signed,
  };
}

/** Moves a scope forward through capable and prepared as far as the evidence allows. */
export function advanceByEvidence(state: PolicyState, ev: RolloutEvidence): PolicyState {
  let s = state;
  for (const to of ["capable", "prepared"] as const) {
    if (s.rollout !== (to === "capable" ? "legacy" : "capable")) continue;
    try {
      s = advanceRollout(s, to, ev);
    } catch {
      break;
    }
  }
  return s;
}

function recordOf(s: PolicyState, now: number): PolicyStateRecord {
  return { scopeKind: s.scope.kind, scopeId: s.scope.id, profile: s.profile, rollout: s.rollout, generation: s.generation, headDigest: s.headDigest, enforcedEver: s.enforcedEver, updatedAt: now };
}

const CHANGE_KEYS = new Set([
  "account", "scope", "prior", "next", "generation", "prevDigest", "affectedPeersDigest", "acknowledgedLoss", "reentry", "signerKind", "signerKeyId", "suite", "issuedAt",
]);

function parseChange(raw: unknown): AssurancePolicyChange | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!CHANGE_KEYS.has(k)) return null;
  const scope = o.scope as Record<string, unknown> | undefined;
  if (!scope || typeof scope !== "object" || Object.keys(scope).sort().join(",") !== "id,kind") return null;
  if (!Array.isArray(o.acknowledgedLoss)) return null;
  const c = {
    account: o.account,
    scope: { kind: scope.kind, id: scope.id },
    prior: o.prior,
    next: o.next,
    generation: o.generation,
    prevDigest: o.prevDigest,
    affectedPeersDigest: o.affectedPeersDigest,
    acknowledgedLoss: o.acknowledgedLoss,
    ...(o.reentry !== undefined ? { reentry: o.reentry } : {}),
    signerKind: o.signerKind,
    signerKeyId: o.signerKeyId,
    suite: o.suite,
    issuedAt: o.issuedAt,
  } as AssurancePolicyChange;
  try {
    canonicalAssurancePolicyChange(c);
  } catch {
    return null;
  }
  return c;
}

/**
 * The signer's trusted Ed25519 key and verified binding for a change, or a refusal. Only the
 * pinned admin root, or a live device holding an admin-root-signed `admin` grant, may sign;
 * `signerKeyId` is that key's 64-hex Ed25519 public key.
 */
async function policySigner(deps: AccountPqTrustDeps, userRec: UsernameRecord, c: AssurancePolicyChange, now: number): Promise<{ ok: true; ed: string; binding: VerifiedPqKeyBinding | null } | { ok: false; code: string }> {
  const root = userRec.adminRootPubHex?.toLowerCase();
  if (!root) return { ok: false, code: "not-owner-authority" };
  const key = c.signerKeyId.toLowerCase();
  if (c.signerKind === "admin-root") {
    if (key !== root) return { ok: false, code: "signer-not-active" };
    return { ok: true, ed: root, binding: await verifiedBinding(deps, "admin-root", userRec.username, root, now) };
  }
  if (c.signerKind !== "admin-device") return { ok: false, code: "not-owner-authority" };
  const dev = await deps.identities.getByPub(userRec.username, key);
  if (!dev || dev.revokedAt !== null) return { ok: false, code: "signer-not-active" };
  const authz = await authorizeSensitiveComOp({ grants: deps.grants, now: () => now }, { username: userRec.username, userRec, verifyWith: (p) => p === key, now });
  if (!authz.ok || authz.signerPubHex !== key) return { ok: false, code: "signer-not-active" };
  return { ok: true, ed: key, binding: await verifiedBinding(deps, "device", dev.deviceId, key, now) };
}

export async function handlePostAssurancePolicyChange(deps: AccountPqTrustDeps, username: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  const u = username.toLowerCase();
  const b = (typeof body === "object" && body !== null ? body : {}) as { change?: unknown; signature?: unknown };
  const change = parseChange(b.change);
  if (!change) return malformed("malformed change");
  const sig = b.signature as SignatureEnvelope | undefined;
  if (!sig || typeof sig !== "object" || typeof sig.signature !== "string" || typeof sig.suite !== "string") return malformed("malformed signature");
  if (change.account !== u) return forbidden("the change is for another account");
  if (change.scope.id !== change.scope.id.toLowerCase()) return malformed("scope id must be lower case");
  const userRec = await deps.usernames.get(u);
  if (!userRec) return notFound("username not registered");
  const owned = await ownScope(deps, u, change.scope);
  if (!owned.ok) return forbidden(owned.reason);

  const stored = await deps.pqTrust.getPolicy(change.scope.kind, change.scope.id);
  const before = policyStateOf(stored, change.scope);
  const state = advanceByEvidence(before, await rolloutEvidence(deps, userRec, change.scope, owned.server, now));
  if (change.generation <= state.generation) {
    const existing = (await deps.pqTrust.listPolicyChanges(change.scope.kind, change.scope.id)).find((x) => x.generation === change.generation);
    if (existing && existing.digest !== assurancePolicyDigest(change)) return conflict("fork");
    return conflict("stale-generation");
  }

  const signer = await policySigner(deps, userRec, change, now);
  if (!signer.ok) return forbidden(signer.code);
  if (sig.suite !== change.suite) return forbidden("bad-signature");
  const msg = canonicalAssurancePolicyChange(change);
  let gateCode: string | null = null;
  try {
    verifyCriticalSignature({ message: msg, expectedPurpose: TAG_ASSURANCE_POLICY, envelope: { suite: sig.suite, signature: sig.signature.toLowerCase() }, signerEd25519PubHex: signer.ed, binding: signer.binding, policy: state });
  } catch (e) {
    gateCode = e instanceof PqTrustError ? e.code : "bad-signature";
  }
  if (gateCode) return forbidden(gateCode);
  let next: PolicyState;
  try {
    next = applyPolicyChange(state, change, () => ({ suiteVerified: true, signerActive: true }));
  } catch (e) {
    if (e instanceof PolicyError) return e.code === "stale-generation" || e.code === "broken-chain" ? conflict(e.code) : forbidden(e.code);
    throw e;
  }
  if (state !== before) await deps.pqTrust.putPolicy(recordOf(state, now));
  const put = await deps.pqTrust.appendPolicyChange(
    {
      scopeKind: change.scope.kind,
      scopeId: change.scope.id,
      generation: change.generation,
      account: u,
      changeJson: JSON.stringify(change),
      suite: sig.suite,
      signatureHex: sig.signature.toLowerCase(),
      digest: next.headDigest,
      prevDigest: change.prevDigest,
      storedAt: now,
    },
    recordOf(next, now),
    { generation: state.generation, headDigest: state.headDigest },
  );
  if (!put.ok) return conflict("fork");
  return ok({ ok: true, state: next });
}

export async function handleGetAssurancePolicy(deps: AccountPqTrustDeps, username: string, kind: string, id: string): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  const u = username.toLowerCase();
  const scope = { kind, id: id.toLowerCase() } as PolicyScope;
  const userRec = await deps.usernames.get(u);
  if (!userRec) return notFound("username not registered");
  const owned = await ownScope(deps, u, scope);
  if (!owned.ok) return notFound(owned.reason);
  const [rec, rows] = await Promise.all([deps.pqTrust.getPolicy(scope.kind, scope.id), deps.pqTrust.listPolicyChanges(scope.kind, scope.id)]);
  const chain = rows.map((r) => ({ change: JSON.parse(r.changeJson) as AssurancePolicyChange, signature: { suite: r.suite, signature: r.signatureHex } }));
  const evidence = await rolloutEvidence(deps, userRec, scope, owned.server, now);
  return ok({ scope, state: policyStateOf(rec, scope), chain, evidence: { recoveryChecked: !!evidence.recoveryChecked } }, { "cache-control": "private, no-store" });
}
