// Writes packages/protocol/test-vectors/browser-grant/vectors.json.
// Run: node --import tsx tools/browser-grant-vectors.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { ed } from "../packages/protocol/src/edSync.ts";
import {
  browserGrantDurationChoices, browserGrantWithin, canonicalBrowserGrantAnswer, canonicalBrowserGrantRevoke,
  signBrowserGrantAnswer, signBrowserGrantRevoke, verifyBrowserGrantAnswer, verifyBrowserGrantRevoke,
} from "../packages/protocol/src/browserGrant.ts";

const hex = (b) => Buffer.from(b).toString("hex");
const seed = new Uint8Array(32).fill(0x99);
const pub = ed.getPublicKey(seed);
const base = {
  serverDomain: "Home.Alice.flagship.services", requestId: "7c1e2a90-1b3d-4f5e-8a6b-0c9d8e7f6a5b", serviceId: "alice--shop",
  decision: "allow", duration: "session", capabilities: ["read-dom", "navigate"], origins: ["https://b.example.com", "https://a.example.com"],
  localNetwork: { kind: "exact", hosts: ["printer.local", "192.168.1.20"] }, issuedAt: 1760000000000,
};
// The last three are the owner's narrowed answers to `base` (a session ask): once, fewer capabilities, one site, one host.
const answers = [
  base,
  { ...base, decision: "deny", duration: "once", localNetwork: null },
  { ...base, duration: "service", localNetwork: { kind: "whole-lan" }, origins: [] },
  { ...base, duration: "once", capabilities: ["navigate"], origins: ["https://a.example.com"], localNetwork: { kind: "exact", hosts: ["printer.local"] } },
  { ...base, duration: "once", localNetwork: null },
  // What every client sends for "Allow once" on `base`: only the duration changes.
  { ...base, duration: "once" },
].map((a) => {
  const sig = signBrowserGrantAnswer(a, (m) => ed.sign(m, seed));
  if (!verifyBrowserGrantAnswer(a, sig, pub)) throw new Error("self-check");
  return { answer: a, canonical: new TextDecoder().decode(canonicalBrowserGrantAnswer(a)), signatureHex: hex(sig) };
});
const refused = [
  ["an unknown duration", { ...base, duration: "forever" }],
  ["a separator in the request id", { ...base, requestId: "a|b" }],
  ["an unknown decision", { ...base, decision: "maybe" }],
].map(([name, a]) => { let t = false; try { canonicalBrowserGrantAnswer(a); } catch { t = true; } if (!t) throw new Error(name); return { name, answer: a }; });
const scope = (a) => ({ duration: a.duration, capabilities: a.capabilities, origins: a.origins, localNetwork: a.localNetwork });
const ask = scope(base);
const wide = { ...ask, duration: "service", localNetwork: { kind: "whole-lan" } };
const narrowing = [
  ["the ask itself", ask, ask, true],
  ["a shorter duration", ask, { ...ask, duration: "once" }, true],
  ["fewer capabilities, one site, no local network", ask, { ...ask, capabilities: ["navigate"], origins: ["https://a.example.com"], localNetwork: null }, true],
  ["fewer local hosts", ask, { ...ask, localNetwork: { kind: "exact", hosts: ["printer.local"] } }, true],
  ["always for a session ask", ask, { ...ask, duration: "service" }, false],
  ["a capability it did not ask for", ask, { ...ask, capabilities: ["navigate", "download"] }, false],
  ["a site it did not ask for", ask, { ...ask, origins: ["https://a.example.com", "https://c.example.com"] }, false],
  ["a local host it did not ask for", ask, { ...ask, localNetwork: { kind: "exact", hosts: ["nas.local"] } }, false],
  ["the whole network for named hosts", ask, { ...ask, localNetwork: { kind: "whole-lan" } }, false],
  ["no capability left", ask, { ...ask, capabilities: [] }, false],
  ["nothing left to reach", ask, { ...ask, origins: [], localNetwork: null }, false],
  ["named hosts out of a whole-network ask", wide, { ...wide, localNetwork: { kind: "exact", hosts: ["printer.local"] } }, false],
  ["the whole network kept, for this session", wide, { ...wide, duration: "session" }, true],
].map(([name, a, b, within]) => {
  if (browserGrantWithin(a, b) !== within) throw new Error(name);
  return { name, ask: a, answer: b, within };
});
const choices = ["once", "session", "service"].map((d) => ({ asked: d, choices: browserGrantDurationChoices(d) }));
mkdirSync("packages/protocol/test-vectors/browser-grant", { recursive: true });
writeFileSync("packages/protocol/test-vectors/browser-grant/vectors.json", JSON.stringify({
  about: "The owner's answer to an app's browser grant request: flagship/browser-grant/v1|serverDomain (lowercase)|requestId|serviceId|decision|duration|capabilities sorted, comma-joined|SHA-256 hex of the origins sorted, newline-joined|localNetwork (none, whole-lan or exact:<hosts sorted, comma-joined>)|issuedAt; Ed25519, seed 0x99 repeated. Each refused answer must fail to produce canonical bytes. The owner may answer with the same or a narrower scope (narrowing: is the answer within the ask; choices: the durations offered for each asked duration, shortest first); the last three answers are narrowed answers to the first, the very last one only shorter (Allow once on a session ask).",
  seedHex: hex(seed), pubHex: hex(pub), answers, refused, narrowing, choices,
}, null, 2) + "\n");
const rbase = { serverDomain: "Home.Alice.flagship.services", serviceId: "alice--shop", grantId: "bg-0f4c9a1e-2d3b-4c5d-8e6f-7a8b9c0d1e2f", issuedAt: 1760000000000 };
const revokes = [rbase, { ...rbase, serviceId: "bob--maps", grantId: "bg-11111111-2222-4333-8444-555555555555", issuedAt: 1760000123456 }].map((r) => {
  const sig = signBrowserGrantRevoke(r, (m) => ed.sign(m, seed));
  if (!verifyBrowserGrantRevoke(r, sig, pub)) throw new Error("self-check");
  return { revoke: r, canonical: new TextDecoder().decode(canonicalBrowserGrantRevoke(r)), signatureHex: hex(sig) };
});
const revokeRefused = [
  ["a separator in the grant id", { ...rbase, grantId: "bg|1" }],
  ["an empty service id", { ...rbase, serviceId: "" }],
  ["a negative time", { ...rbase, issuedAt: -1 }],
].map(([name, r]) => { let t = false; try { canonicalBrowserGrantRevoke(r); } catch { t = true; } if (!t) throw new Error(name); return { name, revoke: r }; });
mkdirSync("packages/protocol/test-vectors/browser-grant-revoke", { recursive: true });
writeFileSync("packages/protocol/test-vectors/browser-grant-revoke/vectors.json", JSON.stringify({
  about: "The owner withdraws a browser grant: flagship/browser-grant-revoke/v1|serverDomain (lowercase)|serviceId|grantId|issuedAt; Ed25519, seed 0x99 repeated. Each refused revoke must fail to produce canonical bytes.",
  seedHex: hex(seed), pubHex: hex(pub), revokes, refused: revokeRefused,
}, null, 2) + "\n");
console.log("wrote");
