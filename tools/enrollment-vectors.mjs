// Writes packages/protocol/test-vectors/enrollment/vectors.json.
// Run: node --import tsx tools/enrollment-vectors.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { canonicalEnrollmentProof, enrollmentProofHex, serverCode, verifyEnrollmentProof } from "../packages/protocol/src/enrollment.ts";

const hex = (b) => Buffer.from(b).toString("hex");
const secret = new Uint8Array(32).fill(0x77);
const base = { serverDomain: "Home.Alice.flagship.services", stkPubHex: "ab".repeat(32), authCodeSerial: "AC-7Q2M-91XZ" };
const proofs = [base, { ...base, stkPubHex: "cd".repeat(32) }].map((s) => {
  const proofHex = enrollmentProofHex(secret, s);
  if (!verifyEnrollmentProof(secret, s, proofHex)) throw new Error("self-check");
  return { statement: s, canonical: new TextDecoder().decode(canonicalEnrollmentProof(s)), proofHex };
});
const invalid = [
  ["another server", { ...base, serverDomain: "home2.alice.flagship.services" }],
  ["another key", { ...base, stkPubHex: "ef".repeat(32) }],
  ["another install code", { ...base, authCodeSerial: "AC-0000-0000" }],
].map(([name, s]) => { if (verifyEnrollmentProof(secret, s, proofs[0].proofHex)) throw new Error(name); return { name, statement: s }; });
const codes = ["ab".repeat(32), "cd".repeat(32), "00".repeat(32), "ff".repeat(32)].map((k) => ({ stkPubHex: k, code: serverCode(k) }));
mkdirSync("packages/protocol/test-vectors/enrollment", { recursive: true });
writeFileSync("packages/protocol/test-vectors/enrollment/vectors.json", JSON.stringify({
  about: "First contact. proofHex = HMAC-SHA256(secret, flagship/enrollment-proof/v1|serverDomain (lowercase)|stkPubHex|authCodeSerial), lowercase hex; the secret is 0x77 repeated (32 bytes). Each invalid statement must fail the first proof. code = first 4 bytes of SHA-256(flagship/server-code/v1|stkPubHex), big-endian unsigned, mod 1000000, zero-padded to 6 digits.",
  secretHex: hex(secret), proofs, invalid, codes,
}, null, 2) + "\n");
console.log("wrote");
