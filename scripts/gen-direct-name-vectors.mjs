#!/usr/bin/env node
// Writes packages/protocol/test-vectors/direct-name/vectors.json from the TS reference
// (docs/direct-access-and-domains.md §7; packages/protocol/src/directName.ts).
//   npx tsc -b packages/protocol && node scripts/gen-direct-name-vectors.mjs
// `--check` exits 1 when the file on disk differs.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../packages/protocol/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "packages/protocol/test-vectors/direct-name/vectors.json");
const hex = (b) => Buffer.from(b).toString("hex");
const fill = (n, v) => new Uint8Array(n).fill(v);
const text = (b) => new TextDecoder().decode(b);
const kp = (seed) => ({ privateKey: seed, publicKey: P.ed.getPublicKey(seed) });

const admin = kp(fill(32, 0x5a));
const irk = P.deriveIRK({ seed: fill(32, 0x2a) });
const SERVER = "home.plucky-avocet.flagship.services";
const NOW = 1_790_000_000_000;

const order = { name: "game--plucky-avocet.fshp.app", serverDomain: SERVER, enabled: true, addresses: [], caa: "pin", issuedAt: NOW };
const owned = { ...order, addresses: ["81.2.69.142", "2a02:8010:6400:1::10"], caa: "off", issuedAt: NOW + 1 };
const off = { ...order, enabled: false, issuedAt: NOW + 60_000 };

const refuse = (name, patch) => {
  const fields = { ...order, ...patch };
  return { name, fields, problem: P.directNameOrderProblem(fields) };
};
const refused = [
  refuse("another apex", { name: "game--plucky-avocet.flagship.services" }),
  refuse("two labels deep", { name: "a.game--plucky-avocet.fshp.app" }),
  refuse("uppercase", { name: "Game--plucky-avocet.fshp.app" }),
  refuse("reserved word", { name: "www.fshp.app" }),
  refuse("punycode", { name: "xn--80ak6aa92e.fshp.app" }),
  refuse("two double dashes", { name: "a--b--c.fshp.app" }),
  refuse("private address", { addresses: ["192.168.1.20"] }),
  refuse("non-canonical address", { addresses: ["2A02:8010:6400:1::10"] }),
  refuse("off with addresses", { enabled: false, addresses: ["81.2.69.142"] }),
  refuse("bad caa", { caa: "maybe" }),
  refuse("duplicate", { addresses: ["81.2.69.142", "81.2.69.142"] }),
];
for (const r of refused) if (!r.problem) throw new Error(`expected a problem for ${r.name}`);

const kinds = ["game--plucky-avocet", "johngame", "a--b--c", "www", "xn--80ak6aa92e", "game--x"].map((label) => {
  const k = P.directNameKind(label);
  return { label, kind: k ? k.kind : null };
});

const signed = (o) => ({ fields: o, canonical: text(P.canonicalDirectNameOrder(o)), signatureHex: hex(P.signDirectNameOrder(o, admin)) });
const vectors = {
  about:
    "Direct names (docs/direct-access-and-domains.md §7). Build `canonical` from `fields` byte for byte; each pinned signature verifies under `keys.adminRootPubHex` and NOT under `keys.irkPubHex`. `refused` entries carry the reason code `problem` and never verify. `kinds` pins what a label is (derived `<slug>--<creator>`, vanity, or null = not allowed).",
  keys: { adminRootSeedHex: hex(admin.privateKey), adminRootPubHex: hex(admin.publicKey), irkPubHex: hex(irk.publicKey) },
  follow: signed(order),
  owned: signed(owned),
  off: signed(off),
  refused,
  kinds,
};

const json = `${JSON.stringify(vectors, null, 2)}\n`;
if (process.argv.includes("--check")) {
  let disk = "";
  try {
    disk = readFileSync(out, "utf8");
  } catch {}
  if (disk !== json) {
    console.error(`${out} is stale: run node scripts/gen-direct-name-vectors.mjs`);
    process.exit(1);
  }
  console.log("direct-name vectors are current");
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, json);
  console.log(`wrote ${out}`);
}
