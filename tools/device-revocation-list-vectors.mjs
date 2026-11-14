// Writes packages/protocol/test-vectors/device-revocation-list/vectors.json: `.com`'s CA-signed
// list of an account's revoked device grants (deviceRevocationList.ts), as TS keyd and the Rust
// keyd (rust/crates/flagship-keyd/src/revocations.rs) take it, with the verdict for each case.
//
// Run: node --import tsx tools/device-revocation-list-vectors.mjs
//
// Seeds are 32 repeated bytes: the CA operational key 0x0c, another key 0x0d, the owner IRK 0x07.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ed } from "../packages/protocol/src/edSync.ts";
import {
  canonicalDeviceRevocationList,
  signDeviceRevocationList,
  verifyDeviceRevocationList,
} from "../packages/protocol/src/deviceRevocationList.ts";

const OUT = fileURLToPath(new URL("../packages/protocol/test-vectors/device-revocation-list/vectors.json", import.meta.url));
const hex = (b) => Buffer.from(b).toString("hex");
const fill = (n) => new Uint8Array(32).fill(n);

const ca = fill(0x0c);
const other = fill(0x0d);
const irk = hex(ed.getPublicKey(fill(0x07)));
const NOW = 1_800_000_000_000;
const caKeys = { v: 1, keys: [hex(ed.getPublicKey(ca))], validFrom: NOW - 86_400_000, validUntil: NOW + 3 * 86_400_000 };
const good = signDeviceRevocationList({ irkPubHex: irk, issuedAt: NOW - 60_000, grantIds: ["grant-bbbb-0002", "grant-aaaa-0001"] }, ca);

const cases = [
  { name: "a list .com's CA signed for this account", list: good, expect: "ok" },
  { name: "an empty list", list: signDeviceRevocationList({ irkPubHex: irk, issuedAt: NOW - 1, grantIds: [] }, ca), expect: "ok" },
  { name: "a grant id added after signing", list: { ...good, grantIds: [...good.grantIds, "grant-cccc-0003"] }, expect: "signature" },
  { name: "a grant id dropped after signing", list: { ...good, grantIds: ["grant-aaaa-0001"] }, expect: "signature" },
  { name: "another account's list", list: signDeviceRevocationList({ irkPubHex: hex(ed.getPublicKey(fill(0x08))), issuedAt: NOW - 1, grantIds: [] }, ca), expect: "wrong-account" },
  { name: "signed by a key root did not write", list: signDeviceRevocationList({ irkPubHex: irk, issuedAt: NOW - 1, grantIds: [] }, other), expect: "key-not-authorized" },
  { name: "issued before root's window", list: signDeviceRevocationList({ irkPubHex: irk, issuedAt: NOW - 2 * 86_400_000, grantIds: [] }, ca), expect: "outside-window" },
  { name: "dated ahead of keyd's clock", list: signDeviceRevocationList({ irkPubHex: irk, issuedAt: NOW + 10 * 60_000, grantIds: [] }, ca), expect: "future" },
  { name: "grant ids out of order", list: { ...good, grantIds: [...good.grantIds].reverse() }, expect: "malformed" },
  { name: "an unknown field", list: { ...good, extra: 1 }, expect: "malformed" },
];
for (const c of cases) {
  const r = verifyDeviceRevocationList(c.list, { irkPubHex: irk, caKeys, now: NOW });
  const got = r.ok ? "ok" : r.code;
  if (got !== c.expect) throw new Error(`${c.name}: ${got}, wanted ${c.expect}`);
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `${JSON.stringify({ now: NOW, irkPubHex: irk, caKeys, canonical: Buffer.from(canonicalDeviceRevocationList(good)).toString("utf8"), cases }, null, 2)}\n`,
);
console.log(`wrote ${cases.length} cases to ${OUT}`);
