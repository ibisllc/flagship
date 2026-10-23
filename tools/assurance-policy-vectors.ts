// Regenerates packages/protocol/test-vectors/assurance-policy/vectors.json: npx tsx tools/assurance-policy-vectors.ts
import { writeFileSync } from "node:fs";
import { assurancePolicyDigest, canonicalAssurancePolicyChange, type AssurancePolicyChange } from "../packages/protocol/src/assurancePolicy.ts";
const D = (c: string) => c.repeat(64);
const base: AssurancePolicyChange = {
  account: "plucky-avocet", scope: { kind: "installation", id: "home.plucky-avocet" }, prior: "compatibility", next: "strict",
  generation: 1, prevDigest: D("0"), affectedPeersDigest: D("a"), acknowledgedLoss: [], signerKind: "admin-device",
  signerKeyId: "00112233445566778899aabbccddeeff", suite: "hybrid-ed25519-mldsa65/v1", issuedAt: 1793000000000,
};
const cases = [
  { name: "enforce strict", change: base },
  { name: "opt out of a service", change: { ...base, scope: { kind: "service", id: "notes" }, prior: "strict", next: "compatibility", generation: 2, prevDigest: D("b"), acknowledgedLoss: ["legacy-recovery-path", "classical-signatures-accepted"] } },
  { name: "return to strict", change: { ...base, generation: 3, prevDigest: D("c"), reentry: { verifierChecksDigest: D("1"), enrollmentDigest: D("2"), rekeyReceiptDigest: D("3"), recoveryTestDigest: D("4") } } },
].map((c) => ({ ...c, canonical: new TextDecoder().decode(canonicalAssurancePolicyChange(c.change as AssurancePolicyChange)), digest: assurancePolicyDigest(c.change as AssurancePolicyChange) }));
writeFileSync(new URL("../packages/protocol/test-vectors/assurance-policy/vectors.json", import.meta.url), JSON.stringify({ tag: "flagship/assurance-policy/v1", note: "Canonical bytes are UTF-8; loss codes are sorted before joining.", cases }, null, 2) + "\n");
