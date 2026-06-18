// One-shot generator for the GYM self-contained maintainer-trust chain.
// Deterministic: K derived from a fixed seed; all timestamps fixed. Run with
//   node scripts/gen-gym-trust-material.mjs
// It prints the K keypair, the gym pin, and the three envelopes (root Mandate,
// 100-yr CaEndorsement, expired CaEndorsement), and self-checks that the chain
// verifies (trusted with the 100-yr lease, untrusted with only the expired).
// The output is hand-copied into packages/control-plane/src/gymTrustMaterial.ts.
//
// GYM TEST ONLY — public throwaway key; never prod.

import {
  signMandate,
  signCaEndorsement,
  mandatePinHash,
  pubKeyFromPriv,
  verifyMandateChainFromPin,
  authorizedCaKeys,
} from "@ibisllc/maintainers";

// Fixed 32-byte seed → deterministic K. (Public test key — value is irrelevant
// to security; we only need it stable across regenerations.)
const K_PRIV =
  "6779796d7472757374746573746b6579676d7472757374746573746b6579303031"
    .slice(0, 64);
const K_PUB = pubKeyFromPriv(K_PRIV);

// Fixed timestamps — deterministic committed material (no Date.now()).
const ISSUED_AT = "2026-01-01T00:00:00.000Z"; // root mandate issuedAt
const EXPIRES_AT = "2125-01-01T00:00:00.000Z"; // ~99yr window (well inside maxDuration)

// CaEndorsement (live, ~100yr) — notBefore well past, notAfter ~3155760000s later.
const E_NOT_BEFORE = "2024-01-01T00:00:00.000Z";
// 2024-01-01 + 3155760000s = 2124-01-01 (100 * 365.25d * 86400s).
const E_NOT_AFTER = "2124-01-01T00:00:00.000Z";
const E_ISSUED_AT = "2024-01-01T00:00:00.000Z";

// Expired CaEndorsement — both bounds in the past (2020).
const X_NOT_BEFORE = "2020-01-01T00:00:00.000Z";
const X_NOT_AFTER = "2020-12-31T00:00:00.000Z";
const X_ISSUED_AT = "2020-01-01T00:00:00.000Z";

// Scope must match prod's CaEndorsement scope.
const SCOPE = "flagship/directory-attestation";

// ---- gym root Mandate (self-signed by K; K is its own successor/authority) ----
const rootUnsigned = {
  kind: "Mandate",
  version: 1,
  mandateId: "gym00000-0000-4000-8000-000000000001",
  track: "ca",
  holder: K_PUB,
  issuedAt: ISSUED_AT,
  expiresAt: EXPIRES_AT,
  successors: [K_PUB],
  approvalRule: { kind: "threshold", threshold: 1 },
  minSuccessors: 1,
  maxDurationSeconds: 4102444800, // ~130yr, comfortably ≥ the root window
  defaultDurationSeconds: 8640000,
  project: {
    name: "flagship-gym",
    contact: "gym@flagshipserver.com",
  },
  signedBy: K_PUB,
};
const gymMandate = signMandate(rootUnsigned, [{ privKey: K_PRIV }]);
const GYM_PIN = mandatePinHash(rootUnsigned);

// ---- 100-yr CaEndorsement (K endorses K) ----
const liveUnsigned = {
  kind: "CaEndorsement",
  version: 1,
  endorsementId: "gymca000-0000-4000-8000-000000000010",
  track: "ca",
  caPubkey: K_PUB,
  scope: SCOPE,
  notBefore: E_NOT_BEFORE,
  notAfter: E_NOT_AFTER,
  issuedAt: E_ISSUED_AT,
  signedBy: K_PUB,
};
const liveEndorsement = signCaEndorsement(liveUnsigned, [{ privKey: K_PRIV }]);

// ---- EXPIRED CaEndorsement (both bounds in the past) ----
const expiredUnsigned = {
  kind: "CaEndorsement",
  version: 1,
  endorsementId: "gymca000-0000-4000-8000-00000000001f",
  track: "ca",
  caPubkey: K_PUB,
  scope: SCOPE,
  notBefore: X_NOT_BEFORE,
  notAfter: X_NOT_AFTER,
  issuedAt: X_ISSUED_AT,
  signedBy: K_PUB,
};
const expiredEndorsement = signCaEndorsement(expiredUnsigned, [{ privKey: K_PRIV }]);

// ---- self-check: chain verifies; live ⇒ K authorized, expired ⇒ none ----
const NOW = new Date("2026-06-18T00:00:00.000Z");
const chain = verifyMandateChainFromPin(GYM_PIN, [gymMandate]);
const liveKeys = authorizedCaKeys([liveEndorsement], chain, NOW);
const expiredKeys = authorizedCaKeys([expiredEndorsement], chain, NOW);

console.log("K_PUB =", K_PUB);
console.log("K_PRIV =", K_PRIV);
console.log("GYM_PIN =", GYM_PIN);
console.log("chain.root present =", !!chain.root, "validMandates =", chain.validMandates.length, "rootError =", chain.rootError ?? "none");
console.log("authorizedCaKeys(live) =", JSON.stringify(liveKeys), "→ includes K?", liveKeys.includes(K_PUB));
console.log("authorizedCaKeys(expired) =", JSON.stringify(expiredKeys), "→ empty?", expiredKeys.length === 0);
console.log("\n--- gymMandate ---\n" + JSON.stringify(gymMandate, null, 2));
console.log("\n--- liveEndorsement ---\n" + JSON.stringify(liveEndorsement, null, 2));
console.log("\n--- expiredEndorsement ---\n" + JSON.stringify(expiredEndorsement, null, 2));

if (!chain.root || chain.validMandates.length !== 1) throw new Error("chain failed to verify from pin");
if (!liveKeys.includes(K_PUB)) throw new Error("live endorsement did NOT authorize K");
if (expiredKeys.length !== 0) throw new Error("expired endorsement WAS authorized (should be empty)");
console.log("\nALL SELF-CHECKS PASSED.");
