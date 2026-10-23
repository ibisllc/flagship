// Writes packages/protocol/test-vectors/ai-repair-consent/vectors.json.
// Run: node --import tsx tools/ai-repair-consent-vectors.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { ed } from "../packages/protocol/src/edSync.ts";
import { canonicalAiRepairConsent, signAiRepairConsent, verifyAiRepairConsent } from "../packages/protocol/src/aiRepairConsent.ts";

const hex = (b) => Buffer.from(b).toString("hex");
const seed = new Uint8Array(32).fill(0x44);
const pub = ed.getPublicKey(seed);
const sign = (m) => ed.sign(m, seed);
const text = (o) => new TextDecoder().decode(canonicalAiRepairConsent(o));
const base = { serverDomain: "Kitchen.Alice.flagship.services", buildId: "0123456789abcdef", operation: "adapt", provider: "anthropic", source: "byok", highTokens: 312000, issuedAt: 1760000000000 };
const orders = [base, { ...base, operation: "repair", source: "promo", provider: "flagship-inference", highTokens: 90000 }, { ...base, operation: "sync" }].map((o) => {
  const sig = signAiRepairConsent(o, sign);
  if (!verifyAiRepairConsent(o, sig, pub)) throw new Error("self-check");
  return { order: o, canonical: text(o), signatureHex: hex(sig) };
});
const refused = [
  ["a build id that is not 16 hex", { ...base, buildId: "xyz" }],
  ["a separator in the provider", { ...base, provider: "a|b" }],
  ["an unknown operation", { ...base, operation: "delete" }],
  ["an unknown cost source", { ...base, source: "free" }],
  ["no tokens", { ...base, highTokens: 0 }],
].map(([name, o]) => { let threw = false; try { text(o); } catch { threw = true; } if (!threw) throw new Error(`should refuse: ${name}`); return { name, order: o }; });
mkdirSync("packages/protocol/test-vectors/ai-repair-consent", { recursive: true });
writeFileSync("packages/protocol/test-vectors/ai-repair-consent/vectors.json", JSON.stringify({
  about: "The owner's consent to one AI run that spends their key or Flagship Inference credits: flagship/ai-repair-consent/v1|serverDomain (lowercase)|buildId (16 hex)|operation (adapt|repair|sync)|provider|source (byok|promo)|highTokens|issuedAt, Ed25519, seed 0x44 repeated. Each refused order must fail to produce canonical bytes.",
  seedHex: hex(seed), pubHex: hex(pub), orders, refused,
}, null, 2) + "\n");
console.log("wrote");
