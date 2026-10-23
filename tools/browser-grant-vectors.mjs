// Writes packages/protocol/test-vectors/browser-grant/vectors.json.
// Run: node --import tsx tools/browser-grant-vectors.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { ed } from "../packages/protocol/src/edSync.ts";
import { canonicalBrowserGrantAnswer, signBrowserGrantAnswer, verifyBrowserGrantAnswer } from "../packages/protocol/src/browserGrant.ts";

const hex = (b) => Buffer.from(b).toString("hex");
const seed = new Uint8Array(32).fill(0x99);
const pub = ed.getPublicKey(seed);
const base = {
  serverDomain: "Home.Alice.flagship.services", requestId: "7c1e2a90-1b3d-4f5e-8a6b-0c9d8e7f6a5b", serviceId: "alice--shop",
  decision: "allow", duration: "session", capabilities: ["read-dom", "navigate"], origins: ["https://b.example.com", "https://a.example.com"],
  localNetwork: { kind: "exact", hosts: ["printer.local", "192.168.1.20"] }, issuedAt: 1760000000000,
};
const answers = [base, { ...base, decision: "deny", duration: "once", localNetwork: null }, { ...base, duration: "service", localNetwork: { kind: "whole-lan" }, origins: [] }].map((a) => {
  const sig = signBrowserGrantAnswer(a, (m) => ed.sign(m, seed));
  if (!verifyBrowserGrantAnswer(a, sig, pub)) throw new Error("self-check");
  return { answer: a, canonical: new TextDecoder().decode(canonicalBrowserGrantAnswer(a)), signatureHex: hex(sig) };
});
const refused = [
  ["an unknown duration", { ...base, duration: "forever" }],
  ["a separator in the request id", { ...base, requestId: "a|b" }],
  ["an unknown decision", { ...base, decision: "maybe" }],
].map(([name, a]) => { let t = false; try { canonicalBrowserGrantAnswer(a); } catch { t = true; } if (!t) throw new Error(name); return { name, answer: a }; });
mkdirSync("packages/protocol/test-vectors/browser-grant", { recursive: true });
writeFileSync("packages/protocol/test-vectors/browser-grant/vectors.json", JSON.stringify({
  about: "The owner's answer to an app's browser grant request: flagship/browser-grant/v1|serverDomain (lowercase)|requestId|serviceId|decision|duration|capabilities sorted, comma-joined|SHA-256 hex of the origins sorted, newline-joined|localNetwork (none, whole-lan or exact:<hosts sorted, comma-joined>)|issuedAt; Ed25519, seed 0x99 repeated. Each refused answer must fail to produce canonical bytes.",
  seedHex: hex(seed), pubHex: hex(pub), answers, refused,
}, null, 2) + "\n");
console.log("wrote");
