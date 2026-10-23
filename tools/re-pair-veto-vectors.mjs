// Writes packages/protocol/test-vectors/re-pair-veto/vectors.json.
// Run: node --import tsx tools/re-pair-veto-vectors.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { ed } from "../packages/protocol/src/edSync.ts";
import { canonicalRePairVeto, verifyRePairVeto } from "../packages/protocol/src/recovery.ts";

const hex = (b) => Buffer.from(b).toString("hex");
const fromHex = (h) => Uint8Array.from(Buffer.from(h, "hex"));
const adminSeed = new Uint8Array(32).fill(0x2a);
const adminPub = ed.getPublicKey(adminSeed);
const newPub = ed.getPublicKey(new Uint8Array(32).fill(0x33));
const base = { username: "alice", newIrkPub: newPub, initiatedAt: 1760000000000, completesAt: 1760259200000, vetoerPub: adminPub, issuedAt: 1760001000000 };
const cases = [
  ["a veto of the exact attempt", base, true],
  ["another attempt's start time", { ...base, initiatedAt: base.initiatedAt + 1 }, false],
  ["another deadline", { ...base, completesAt: base.completesAt + 1 }, false],
  ["another pending device", { ...base, newIrkPub: ed.getPublicKey(new Uint8Array(32).fill(0x34)) }, false],
  ["another username", { ...base, username: "bob" }, false],
  ["another issue time", { ...base, issuedAt: base.issuedAt + 1 }, false],
];
const sig = hex(ed.sign(canonicalRePairVeto(base), adminSeed));
const out = cases.map(([name, r, valid]) => {
  const ok = verifyRePairVeto(r, fromHex(sig));
  if (ok !== valid) throw new Error(`${name}: expected ${valid}`);
  return { name, request: { ...r, newIrkPub: hex(r.newIrkPub), vetoerPub: hex(r.vetoerPub) }, canonical: new TextDecoder().decode(canonicalRePairVeto(r)), signatureHex: sig, valid };
});
mkdirSync("packages/protocol/test-vectors/re-pair-veto", { recursive: true });
writeFileSync("packages/protocol/test-vectors/re-pair-veto/vectors.json", JSON.stringify({
  about: "Admin veto of a pending recovery. Canonical bytes: flagship/re-pair-veto/v1|username(lowercase)|newIrkPubHex|initiatedAt|completesAt|vetoerPubHex|issuedAt, signed with Ed25519 by the vetoer. One signature is checked against each request; only the first is valid. Admin seed is 32 bytes of 0x2a.",
  adminSeedHex: hex(adminSeed), adminPubHex: hex(adminPub), cases: out,
}, null, 2) + "\n");
console.log("wrote", out.length);
