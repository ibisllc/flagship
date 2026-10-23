// Writes packages/protocol/test-vectors/recovery-record/vectors.json.
// Run: node --import tsx tools/recovery-record-vectors.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { ed } from "../packages/protocol/src/edSync.ts";
import { canonicalRecoveryRecord, recoveryRecordDigest, signRecoveryRecord, verifyRecoveryRecord, checkRecoveryEvolution } from "../packages/protocol/src/recoveryRecord.ts";

const hex = (b) => Buffer.from(b).toString("hex");
const seed = new Uint8Array(32).fill(0x55);
const kp = { privateKey: seed, publicKey: ed.getPublicKey(seed) };
const d = (c) => c.repeat(64);
const base = {
  op: "put", username: "Alice", irkPubHex: hex(kp.publicKey), adminRootPubHex: d("a"), credentialIdHex: "c0ffee00c0ffee00",
  wrappedUmkDigestHex: d("1"), adminRoot: { change: "replace", digestHex: d("2") }, acmeKey: { change: "none" },
  fetchTokenHashHex: d("3"), prfSaltHashHex: d("4"), kdfVersion: 1, algVersion: 1, policy: "passkey-and-passphrase",
  generation: 1, nonceHex: "0f".repeat(16), priorDigestHex: "genesis", issuedAt: 1760000000000,
};
const sig = hex(signRecoveryRecord(base, kp));
const digest = recoveryRecordDigest(base);
// Every signed field, mutated, must break the signature.
const mutations = {
  op: "delete", username: "bob", irkPubHex: d("9"), adminRootPubHex: "none", credentialIdHex: "c0ffee00c0ffee01",
  wrappedUmkDigestHex: d("5"), adminRoot: { change: "replace", digestHex: d("6") }, acmeKey: { change: "replace", digestHex: d("7") },
  fetchTokenHashHex: d("8"), prfSaltHashHex: d("9"), generation: 2, nonceHex: "10".repeat(16), priorDigestHex: "legacy", issuedAt: 1760000000001,
};
const mutated = Object.entries(mutations).map(([field, value]) => {
  const r = { ...base, [field]: value };
  let breaks;
  try { breaks = !verifyRecoveryRecord(r, hex2(sig), kp.publicKey); } catch { breaks = true; }
  if (!breaks) throw new Error(`mutating ${field} did not break the signature`);
  return { field, value };
});
function hex2(h) { return Uint8Array.from(Buffer.from(h, "hex")); }
const stored = { digestHex: digest, generation: 1, wrappedUmkDigestHex: base.wrappedUmkDigestHex, adminRootDigestHex: d("2") };
const next = (over) => ({ ...base, generation: 2, priorDigestHex: digest, adminRoot: { change: "keep", digestHex: d("2") }, ...over });
const evolution = [
  ["keep what is held", stored, next({}), "ok"],
  ["replace the admin root", stored, next({ adminRoot: { change: "replace", digestHex: d("6") } }), "ok"],
  ["remove the admin root", stored, next({ adminRoot: { change: "remove" } }), "ok"],
  ["keep names the wrong digest", stored, next({ adminRoot: { change: "keep", digestHex: d("6") } }), "keep-mismatch"],
  ["none while one is held", stored, next({ adminRoot: { change: "none" } }), "keep-mismatch"],
  ["remove something never held", stored, next({ acmeKey: { change: "remove" } }), "nothing-to-remove"],
  ["prior digest is not the stored one", stored, next({ priorDigestHex: d("e") }), "stale-prior"],
  ["generation skips", stored, next({ generation: 3 }), "bad-generation"],
  ["generation repeats", stored, next({ generation: 1 }), "bad-generation"],
  ["a first record that keeps", undefined, { ...base, adminRoot: { change: "keep", digestHex: d("2") } }, "keep-without-prior"],
  ["a first record", undefined, base, "ok"],
  ["a first record that is not genesis", undefined, { ...base, priorDigestHex: digest }, "stale-prior"],
  ["a delete with nothing stored", undefined, { ...base, op: "delete" }, "delete-needs-prior"],
  ["a v1 row replaced once", { digestHex: "legacy", generation: 0, wrappedUmkDigestHex: d("0") }, { ...base, priorDigestHex: "legacy", adminRoot: { change: "none" } }, "ok"],
].map(([name, st, nx, expect]) => {
  const v = checkRecoveryEvolution(st, nx);
  const got = v.ok ? "ok" : v.reason;
  if (got !== expect) throw new Error(`${name}: expected ${expect} got ${got}`);
  return { name, stored: st ?? null, next: nx, expect };
});
mkdirSync("packages/protocol/test-vectors/recovery-record", { recursive: true });
writeFileSync("packages/protocol/test-vectors/recovery-record/vectors.json", JSON.stringify({
  about: "Recovery record v2 (N03). Canonical bytes: flagship/recovery-record/v2|op|username(lowercase)|irkPubHex|adminRootPubHex|credentialIdHex|wrappedUmkDigestHex|adminRoot|acmeKey|fetchTokenHashHex|prfSaltHashHex|kdfVersion|algVersion|policy|generation|nonceHex|priorDigestHex|issuedAt, where adminRoot/acmeKey are keep:<digest>, replace:<digest>, remove or none. Ed25519 by the account key (seed 0x55 repeated). The digest chained into the next record is SHA-256 of the canonical bytes.",
  userSeedHex: hex(seed), userPubHex: hex(kp.publicKey),
  record: base, canonical: new TextDecoder().decode(canonicalRecoveryRecord(base)), signatureHex: sig, digestHex: digest,
  mutationsThatBreakTheSignature: mutated, evolution,
}, null, 2) + "\n");
console.log("wrote", evolution.length, mutated.length);
