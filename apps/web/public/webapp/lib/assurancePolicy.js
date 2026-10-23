// Strict quantum-resistant vs Compatibility per scope: the browser's port of
// packages/protocol/src/assurancePolicy.ts (vectors in packages/protocol/test-vectors/assurance-policy/;
// spec docs/architecture-v2/pq-suites.md §11). The browser only VERIFIES: it replays the owner's
// signed chain that .com serves and never signs a change (the keyless-web rule).

import { sha256 } from "../vendor/noble-post-quantum/pq-verify.js";

export const TAG_ASSURANCE_POLICY = "flagship/assurance-policy/v1";
export const GENESIS_DIGEST = "0".repeat(64);
export const MAX_POLICY_GENERATION = 2 ** 31 - 1;
export const POLICY_SCOPE_KINDS = ["installation", "service", "data", "connector", "device"];
export const ROLLOUT_STATES = ["legacy", "capable", "prepared", "enforced", "retired"];
export const SIGNATURE_SUITES = ["ed25519/v1", "hybrid-ed25519-mldsa65/v1"];
export const PROTECTION_LOSS_CODES = [
  "classical-signatures-accepted",
  "classical-key-exchange-accepted",
  "browser-without-pq-authentication",
  "connector-classical-last-leg",
  "firmware-root-classical",
  "legacy-recovery-path",
];
const OWNER_SIGNERS = ["admin-device", "admin-root"];
const HEX64 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[0-9a-f]{16,128}$/;

export class PolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
  }
}
const refuse = (code, message) => {
  throw new PolicyError(code, message);
};

function canonicalField(v, field) {
  if (typeof v !== "string" || v.length === 0) throw new Error(`assurance-policy: empty "${field}"`);
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c === 0x7c || c <= 0x1f || c === 0x7f) throw new Error(`assurance-policy field "${field}" is not canonical`);
  }
}

export function canonicalAssurancePolicyChange(c) {
  canonicalField(c.account, "account");
  canonicalField(c.scope?.id, "scope.id");
  if (!POLICY_SCOPE_KINDS.includes(c.scope.kind)) throw new Error("assurance-policy: bad scope kind");
  for (const p of [c.prior, c.next]) if (p !== "strict" && p !== "compatibility") throw new Error("assurance-policy: bad profile");
  if (!Number.isSafeInteger(c.generation) || c.generation < 1 || c.generation > MAX_POLICY_GENERATION) throw new Error("assurance-policy: bad generation");
  if (!Number.isSafeInteger(c.issuedAt) || c.issuedAt < 0) throw new Error("assurance-policy: bad issuedAt");
  for (const v of [c.prevDigest, c.affectedPeersDigest]) if (!HEX64.test(v)) throw new Error("assurance-policy: digests must be 32-byte hex");
  if (!KEY_ID.test(c.signerKeyId)) throw new Error("assurance-policy: bad signerKeyId");
  if (!SIGNATURE_SUITES.includes(c.suite)) throw new Error("assurance-policy: bad suite");
  const loss = [...new Set(c.acknowledgedLoss)].sort();
  if (loss.length !== c.acknowledgedLoss.length) throw new Error("assurance-policy: repeated loss code");
  for (const l of loss) if (!PROTECTION_LOSS_CODES.includes(l)) throw new Error("assurance-policy: unknown loss code");
  const r = c.reentry;
  if (r) for (const v of Object.values(r)) if (!HEX64.test(v)) throw new Error("assurance-policy: reentry digests must be 32-byte hex");
  const reentry = r ? [r.verifierChecksDigest, r.enrollmentDigest, r.rekeyReceiptDigest, r.recoveryTestDigest].join(",") : "-";
  return new TextEncoder().encode(
    [TAG_ASSURANCE_POLICY, c.account, c.scope.kind, c.scope.id, c.prior, c.next, String(c.generation), c.prevDigest, c.affectedPeersDigest,
      loss.length ? loss.join(",") : "-", reentry, c.signerKind, c.signerKeyId, c.suite, String(c.issuedAt)].join("|"),
  );
}

export function assurancePolicyDigest(c) {
  return Array.from(sha256(canonicalAssurancePolicyChange(c)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function legacyPolicyState(scope) {
  return { scope, profile: "compatibility", rollout: "legacy", generation: 0, headDigest: GENESIS_DIGEST, enforcedEver: false };
}

/** True when the scope's strict profile is in force (classical-only messages refused). */
export function strictInForce(s) {
  return s?.profile === "strict" && (s.rollout === "enforced" || s.rollout === "retired");
}

/** `check(msg, change)` → { suiteVerified, signerActive }, as in the TS original. */
export function applyPolicyChange(state, change, check) {
  if (change.scope.kind !== state.scope.kind || change.scope.id !== state.scope.id) refuse("wrong-scope", "the change is for another scope");
  if (change.generation <= state.generation) refuse("stale-generation", "the change is older than the policy in force");
  if (change.generation !== state.generation + 1) refuse("stale-generation", "the change skips a generation");
  if (change.prevDigest !== state.headDigest) refuse("broken-chain", "the change does not follow the policy in force");
  if (change.prior !== state.profile) refuse("wrong-prior", "the change starts from another profile");
  if (change.next === change.prior) refuse("no-change", "the change does not change the profile");
  if (!OWNER_SIGNERS.includes(change.signerKind)) refuse("not-owner-authority", "only the owner's admin device or admin root can change protection");
  const verdict = check(canonicalAssurancePolicyChange(change), change);
  if (!verdict.suiteVerified) refuse("bad-signature", "the signature does not verify");
  if (!verdict.signerActive) refuse("signer-not-active", "the signer is not an active device of the account");
  if (strictInForce(state) && change.suite !== "hybrid-ed25519-mldsa65/v1") refuse("classical-signer-refused", "a strict scope can only be changed by a signer that meets strict");
  if (change.next === "compatibility") {
    if (change.acknowledgedLoss.length === 0) refuse("loss-not-acknowledged", "the owner must be told what protection is lost");
  } else {
    if (change.suite !== "hybrid-ed25519-mldsa65/v1") refuse("classical-signer-refused", "turning on strict needs a strict signer");
    if (state.rollout === "legacy" || state.rollout === "capable") refuse("not-prepared", "new keys, recipients and recovery are not ready");
    const r = change.reentry;
    if (state.enforcedEver && !(r && r.verifierChecksDigest && r.enrollmentDigest && r.rekeyReceiptDigest && r.recoveryTestDigest)) {
      refuse("reentry-incomplete", "returning to strict needs fresh checks, enrollment, rekeying and a tested recovery");
    }
  }
  const rollout = change.next === "strict" && state.rollout === "prepared" ? "enforced" : state.rollout;
  return {
    scope: state.scope,
    profile: change.next,
    rollout,
    generation: change.generation,
    headDigest: assurancePolicyDigest(change),
    enforcedEver: state.enforcedEver || rollout === "enforced" || rollout === "retired",
  };
}

/** Taking a stored state never moves backwards. */
export function adoptStoredState(current, stored) {
  if (!current) return stored;
  if (stored.scope.kind !== current.scope.kind || stored.scope.id !== current.scope.id) refuse("wrong-scope", "stored state is for another scope");
  const older =
    stored.generation < current.generation ||
    ROLLOUT_STATES.indexOf(stored.rollout) < ROLLOUT_STATES.indexOf(current.rollout) ||
    (stored.generation === current.generation && stored.headDigest !== current.headDigest) ||
    (current.enforcedEver && !stored.enforcedEver);
  if (older) refuse("rollback-refused", "the stored policy is older than the one in force");
  return stored;
}

/**
 * Replays a chain .com served, from legacy, stopping at the first change that fails.
 * `prepared(state, change)` is consulted before a change to strict (the reader's own evidence),
 * `check(msg, change, signature, state)` verifies the signature and the signer.
 */
export function replayPolicyChain(scope, chain, { prepared, check }) {
  let s = legacyPolicyState(scope);
  for (const e of chain ?? []) {
    if (!e?.change || !e.signature) break;
    try {
      if (e.change.next === "strict" && (s.rollout === "legacy" || s.rollout === "capable") && prepared(s, e.change)) {
        s = { ...s, rollout: "prepared" };
      }
      const before = s;
      s = applyPolicyChange(s, e.change, (msg, c) => check(msg, c, e.signature, before));
    } catch {
      break;
    }
  }
  return s;
}
