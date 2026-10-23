/**
 * Strict quantum-resistant vs Compatibility, per scope (IMPLEMENTATION-PLAN.md 3.1, 6.5; package C01).
 *
 * Two things are tracked per installation/service/data/connector scope:
 *
 *   rollout   legacy → capable → prepared → enforced → retired. It only moves forward. A
 *             capability advertisement never changes trust; `prepared` needs bound new keys,
 *             verified recipients and a recovery check; `enforced` happens only through a signed
 *             policy change to strict.
 *   profile   strict or compatibility. Changed only by an owner-signed policy change, each one a
 *             new generation chained to the previous change's digest, so an opt-out is a new
 *             epoch and never a reset of anti-rollback state.
 *
 * Who can change a profile: an admin device or the admin root, never a server, app, relay, the
 * cloud or an old client. Leaving an enforced strict scope needs a signer that itself meets strict
 * (a hybrid signature); a classical-only signature cannot weaken it. Going back to strict after a
 * compatibility period needs the re-entry evidence: verifier checks, fresh enrollment, a rekey
 * receipt and a tested recovery credential.
 */
import { sha256 } from "@noble/hashes/sha256";
import { assertCanonicalField, hex } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_ASSURANCE_POLICY = "flagship/assurance-policy/v1";

export type AssuranceProfile = "strict" | "compatibility";
export const POLICY_SCOPE_KINDS = ["installation", "service", "data", "connector", "device"] as const;
export type PolicyScopeKind = (typeof POLICY_SCOPE_KINDS)[number];
export const ROLLOUT_STATES = ["legacy", "capable", "prepared", "enforced", "retired"] as const;
export type RolloutState = (typeof ROLLOUT_STATES)[number];
export const SIGNATURE_SUITES = ["ed25519/v1", "hybrid-ed25519-mldsa65/v1"] as const;
export type SignatureSuite = (typeof SIGNATURE_SUITES)[number];
export type PolicySignerKind = "admin-device" | "admin-root" | "box" | "app" | "relay" | "cloud" | "legacy-client";

/** What the owner is told they give up, as fixed codes so every client shows the same sentence. */
export const PROTECTION_LOSS_CODES = [
  "classical-signatures-accepted",
  "classical-key-exchange-accepted",
  "browser-without-pq-authentication",
  "connector-classical-last-leg",
  "firmware-root-classical",
  "legacy-recovery-path",
] as const;
export type ProtectionLossCode = (typeof PROTECTION_LOSS_CODES)[number];

export const MAX_POLICY_GENERATION = 2 ** 31 - 1;
export const GENESIS_DIGEST = "0".repeat(64);

export interface PolicyScope {
  kind: PolicyScopeKind;
  id: string;
}

export interface StrictReentryEvidence {
  verifierChecksDigest: string;
  enrollmentDigest: string;
  rekeyReceiptDigest: string;
  recoveryTestDigest: string;
}

export interface AssurancePolicyChange {
  account: string;
  scope: PolicyScope;
  prior: AssuranceProfile;
  next: AssuranceProfile;
  generation: number;
  prevDigest: string;
  /** Digest of the sorted peer set whose protection changes with this scope. */
  affectedPeersDigest: string;
  acknowledgedLoss: ProtectionLossCode[];
  reentry?: StrictReentryEvidence;
  signerKind: PolicySignerKind;
  signerKeyId: string;
  suite: SignatureSuite;
  issuedAt: number;
}

const HEX64 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[0-9a-f]{16,128}$/;

export function canonicalAssurancePolicyChange(c: AssurancePolicyChange): Bytes {
  assertCanonicalField(c.account, "assurance-policy", "account");
  assertCanonicalField(c.scope.id, "assurance-policy", "scope.id");
  if (!(POLICY_SCOPE_KINDS as readonly string[]).includes(c.scope.kind)) throw new Error("assurance-policy: bad scope kind");
  for (const p of [c.prior, c.next]) if (p !== "strict" && p !== "compatibility") throw new Error("assurance-policy: bad profile");
  if (!Number.isSafeInteger(c.generation) || c.generation < 1 || c.generation > MAX_POLICY_GENERATION) throw new Error("assurance-policy: bad generation");
  if (!Number.isSafeInteger(c.issuedAt) || c.issuedAt < 0) throw new Error("assurance-policy: bad issuedAt");
  for (const [n, v] of [["prevDigest", c.prevDigest], ["affectedPeersDigest", c.affectedPeersDigest]] as const) {
    if (!HEX64.test(v)) throw new Error(`assurance-policy: ${n} must be 32-byte hex`);
  }
  if (!KEY_ID.test(c.signerKeyId)) throw new Error("assurance-policy: bad signerKeyId");
  if (!(SIGNATURE_SUITES as readonly string[]).includes(c.suite)) throw new Error("assurance-policy: bad suite");
  const loss = [...new Set(c.acknowledgedLoss)].sort();
  if (loss.length !== c.acknowledgedLoss.length) throw new Error("assurance-policy: repeated loss code");
  for (const l of loss) if (!(PROTECTION_LOSS_CODES as readonly string[]).includes(l)) throw new Error("assurance-policy: unknown loss code");
  const r = c.reentry;
  if (r) for (const v of Object.values(r)) if (!HEX64.test(v)) throw new Error("assurance-policy: reentry digests must be 32-byte hex");
  const reentry = r ? [r.verifierChecksDigest, r.enrollmentDigest, r.rekeyReceiptDigest, r.recoveryTestDigest].join(",") : "-";
  const text = [
    TAG_ASSURANCE_POLICY,
    c.account,
    c.scope.kind,
    c.scope.id,
    c.prior,
    c.next,
    String(c.generation),
    c.prevDigest,
    c.affectedPeersDigest,
    loss.length ? loss.join(",") : "-",
    reentry,
    c.signerKind,
    c.signerKeyId,
    c.suite,
    String(c.issuedAt),
  ].join("|");
  return new TextEncoder().encode(text);
}

export function assurancePolicyDigest(c: AssurancePolicyChange): string {
  return hex(sha256(canonicalAssurancePolicyChange(c)));
}

export interface PolicyState {
  scope: PolicyScope;
  profile: AssuranceProfile;
  rollout: RolloutState;
  generation: number;
  headDigest: string;
  /** Once a scope has been enforced, coming back to strict needs the re-entry evidence. */
  enforcedEver: boolean;
}

/** An existing installation before any migration: classical accepted, nothing enforced. */
export function legacyPolicyState(scope: PolicyScope): PolicyState {
  return { scope, profile: "compatibility", rollout: "legacy", generation: 0, headDigest: GENESIS_DIGEST, enforcedEver: false };
}

export type PolicyErrorCode =
  | "wrong-scope"
  | "stale-generation"
  | "broken-chain"
  | "wrong-prior"
  | "no-change"
  | "not-owner-authority"
  | "bad-signature"
  | "signer-not-active"
  | "classical-signer-refused"
  | "loss-not-acknowledged"
  | "not-prepared"
  | "reentry-incomplete"
  | "rollback-refused"
  | "needs-policy-change"
  | "missing-evidence"
  | "upgrade-required";

export class PolicyError extends Error {
  constructor(
    readonly code: PolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

/** True when this scope's strict profile is in force: classical-only messages are refused. */
export function strictInForce(s: PolicyState): boolean {
  return s.profile === "strict" && (s.rollout === "enforced" || s.rollout === "retired");
}

export function acceptsClassicalOnly(s: PolicyState): boolean {
  return !strictInForce(s);
}

/**
 * Verifies the change's signature with the suite it names, and whether the signer is a currently
 * active, unrevoked native authority of the account. Supplied by the caller so this module stays
 * independent of key storage; it must return `suiteVerified` only for the suite named.
 */
export type PolicySignatureCheck = (msg: Bytes, change: AssurancePolicyChange) => { suiteVerified: boolean; signerActive: boolean };

const OWNER_SIGNERS: readonly PolicySignerKind[] = ["admin-device", "admin-root"];

export function applyPolicyChange(state: PolicyState, change: AssurancePolicyChange, check: PolicySignatureCheck): PolicyState {
  if (change.scope.kind !== state.scope.kind || change.scope.id !== state.scope.id) throw new PolicyError("wrong-scope", "the change is for another scope");
  if (change.generation <= state.generation) throw new PolicyError("stale-generation", "the change is older than the policy in force");
  if (change.generation !== state.generation + 1) throw new PolicyError("stale-generation", "the change skips a generation");
  if (change.prevDigest !== state.headDigest) throw new PolicyError("broken-chain", "the change does not follow the policy in force");
  if (change.prior !== state.profile) throw new PolicyError("wrong-prior", "the change starts from another profile");
  if (change.next === change.prior) throw new PolicyError("no-change", "the change does not change the profile");
  if (!OWNER_SIGNERS.includes(change.signerKind)) throw new PolicyError("not-owner-authority", "only the owner's admin device or admin root can change protection");

  const msg = canonicalAssurancePolicyChange(change);
  const verdict = check(msg, change);
  if (!verdict.suiteVerified) throw new PolicyError("bad-signature", "the signature does not verify");
  if (!verdict.signerActive) throw new PolicyError("signer-not-active", "the signer is not an active device of the account");
  if (strictInForce(state) && change.suite !== "hybrid-ed25519-mldsa65/v1") {
    throw new PolicyError("classical-signer-refused", "a strict scope can only be changed by a signer that meets strict");
  }

  if (change.next === "compatibility") {
    if (change.acknowledgedLoss.length === 0) throw new PolicyError("loss-not-acknowledged", "the owner must be told what protection is lost");
  } else {
    if (change.suite !== "hybrid-ed25519-mldsa65/v1") throw new PolicyError("classical-signer-refused", "turning on strict needs a strict signer");
    if (state.rollout === "legacy" || state.rollout === "capable") throw new PolicyError("not-prepared", "new keys, recipients and recovery are not ready");
    const r = change.reentry;
    if (state.enforcedEver && !(r && r.verifierChecksDigest && r.enrollmentDigest && r.rekeyReceiptDigest && r.recoveryTestDigest)) {
      throw new PolicyError("reentry-incomplete", "returning to strict needs fresh checks, enrollment, rekeying and a tested recovery");
    }
  }

  const rollout: RolloutState = change.next === "strict" && state.rollout === "prepared" ? "enforced" : state.rollout;
  return {
    scope: state.scope,
    profile: change.next,
    rollout,
    generation: change.generation,
    headDigest: assurancePolicyDigest(change),
    enforcedEver: state.enforcedEver || rollout === "enforced" || rollout === "retired",
  };
}

export interface RolloutEvidence {
  capabilityAdvertised?: boolean;
  boundPublicKeys?: boolean;
  recipientsVerified?: boolean;
  recoveryChecked?: boolean;
  compatibilityGatePassed?: boolean;
}

/** Moves a scope's rollout forward by evidence. Enforcement itself only comes from a policy change. */
export function advanceRollout(state: PolicyState, to: RolloutState, ev: RolloutEvidence): PolicyState {
  const from = ROLLOUT_STATES.indexOf(state.rollout);
  const target = ROLLOUT_STATES.indexOf(to);
  if (target <= from) throw new PolicyError("rollback-refused", `rollout cannot go from ${state.rollout} to ${to}`);
  if (target !== from + 1) throw new PolicyError("missing-evidence", "rollout moves one step at a time");
  switch (to) {
    case "capable":
      if (!ev.capabilityAdvertised) throw new PolicyError("missing-evidence", "no capability advertisement");
      break;
    case "prepared":
      if (!(ev.boundPublicKeys && ev.recipientsVerified && ev.recoveryChecked)) {
        throw new PolicyError("missing-evidence", "prepared needs bound keys, verified recipients and a recovery check");
      }
      break;
    case "enforced":
      throw new PolicyError("needs-policy-change", "enforcement needs the owner's signed change to strict");
    case "retired":
      if (state.profile !== "strict" || !ev.compatibilityGatePassed) throw new PolicyError("missing-evidence", "retiring old readers needs strict in force and the compatibility gate passed");
      break;
    case "legacy":
      break;
  }
  return { ...state, rollout: to };
}

/** Taking a stored state (restore, reboot, a copy from another device) never moves backwards. */
export function adoptStoredState(current: PolicyState | undefined, stored: PolicyState): PolicyState {
  if (!current) return stored;
  if (stored.scope.kind !== current.scope.kind || stored.scope.id !== current.scope.id) throw new PolicyError("wrong-scope", "stored state is for another scope");
  const older =
    stored.generation < current.generation ||
    ROLLOUT_STATES.indexOf(stored.rollout) < ROLLOUT_STATES.indexOf(current.rollout) ||
    (stored.generation === current.generation && stored.headDigest !== current.headDigest) ||
    (current.enforcedEver && !stored.enforcedEver);
  if (older) throw new PolicyError("rollback-refused", "the stored policy is older than the one in force");
  return stored;
}

/** Picks the signature suite for a message in this scope. Stripping the hybrid suite from an offer cannot downgrade a strict scope. */
export function selectSignatureSuite(state: PolicyState, offered: readonly SignatureSuite[]): SignatureSuite {
  if (offered.includes("hybrid-ed25519-mldsa65/v1")) return "hybrid-ed25519-mldsa65/v1";
  if (strictInForce(state)) throw new PolicyError("upgrade-required", "this scope needs a quantum-resistant signature; update the app on that device");
  if (offered.includes("ed25519/v1")) return "ed25519/v1";
  throw new PolicyError("upgrade-required", "no signature suite in common");
}

export interface ExportAuthorization {
  /** Digest of the exact data or workflow the owner allowed into compatibility. */
  subjectDigest: string;
  generation: number;
}

/**
 * Two scopes exchanging data over a classical-only channel: the stricter side decides. A strict
 * scope refuses unless the owner authorized exporting that exact subject.
 */
export function classicalExchangeAllowed(a: PolicyState, b: PolicyState, subjectDigest: string, auth?: ExportAuthorization): boolean {
  if (!strictInForce(a) && !strictInForce(b)) return true;
  return auth !== undefined && auth.subjectDigest === subjectDigest && HEX64.test(subjectDigest);
}
