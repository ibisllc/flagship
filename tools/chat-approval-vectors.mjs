// Writes packages/protocol/test-vectors/chat-approval/vectors.json.
// Run: node --import tsx tools/chat-approval-vectors.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { ed } from "../packages/protocol/src/edSync.ts";
import { canonicalChatApproval, signChatApproval, verifyChatApproval } from "../packages/protocol/src/chatWire.ts";

const hex = (b) => Buffer.from(b).toString("hex");
const seed = new Uint8Array(32).fill(0x55);
const pub = ed.getPublicKey(seed);
const sign = (m) => ed.sign(m, seed);
const text = (o) => new TextDecoder().decode(canonicalChatApproval(o));
const base = { serverDomain: "Kitchen.Alice.flagship.services", requestId: "3f2b9c1e-7a54-4d0e-9b1a-0c5d8e2f4a61", kind: "incoming", decision: "allow", issuedAt: 1760000000000 };
const orders = [
  base,
  { ...base, decision: "always" },
  { ...base, decision: "deny" },
  { ...base, kind: "outgoing" },
].map((o) => {
  const sig = signChatApproval(o, sign);
  if (!verifyChatApproval(o, sig, pub)) throw new Error("self-check");
  return { order: o, canonical: text(o), signatureHex: hex(sig) };
});
const refused = [
  ["always allow on an outgoing request", { ...base, kind: "outgoing", decision: "always" }],
  ["a separator in the request id", { ...base, requestId: "a|b" }],
  ["an unknown decision", { ...base, decision: "maybe" }],
  ["an unknown kind", { ...base, kind: "sideways" }],
].map(([name, o]) => { let threw = false; try { text(o); } catch { threw = true; } if (!threw) throw new Error(`should refuse: ${name}`); return { name, order: o }; });
mkdirSync("packages/protocol/test-vectors/chat-approval", { recursive: true });
writeFileSync("packages/protocol/test-vectors/chat-approval/vectors.json", JSON.stringify({
  about: "The owner's answer to a held app-chat request: flagship/chat-approval/v1|serverDomain (lowercase)|requestId|kind|decision|issuedAt, Ed25519, seed 0x55 repeated. kind is incoming or outgoing; decision is allow, always or deny; always is only valid for incoming. Each refused order must fail to produce canonical bytes.",
  seedHex: hex(seed), pubHex: hex(pub), orders, refused,
}, null, 2) + "\n");
console.log("wrote");
