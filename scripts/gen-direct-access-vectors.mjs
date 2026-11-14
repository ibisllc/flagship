#!/usr/bin/env node
// Writes packages/protocol/test-vectors/direct-access/vectors.json from the TS reference
// (docs/direct-access-and-domains.md; packages/protocol/src/directAccess.ts).
//   npx tsc -b packages/protocol && node scripts/gen-direct-access-vectors.mjs
// `--check` exits 1 when the file on disk differs.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../packages/protocol/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "packages/protocol/test-vectors/direct-access/vectors.json");
const hex = (b) => Buffer.from(b).toString("hex");
const fill = (n, v) => new Uint8Array(n).fill(v);
const text = (b) => new TextDecoder().decode(b);
const kp = (seed) => ({ privateKey: seed, publicKey: P.ed.getPublicKey(seed) });

const admin = kp(fill(32, 0x5a));
const irk = P.deriveIRK({ seed: fill(32, 0x2a) });
const stk = kp(fill(32, 0x31));
const otherStk = kp(fill(32, 0x32));
const SERVER = "home.plucky-avocet.flagship.services";
const NOW = 1_790_000_000_000;
const CERT = "ab".repeat(32);

const order = {
  serverDomain: SERVER,
  enabled: true,
  addresses: ["81.2.69.142", "2a02:8010:6400:1::10"],
  prefixes: ["2a02:8010:6400::/48"],
  port: 443,
  issuedAt: NOW,
};
const off = { serverDomain: SERVER, enabled: false, addresses: [], prefixes: [], port: 443, issuedAt: NOW + 60_000 };
const orderSha = P.directAccessOrderSha256(order);

const refuse = (name, patch) => {
  const fields = { ...order, ...patch };
  return { name, fields, problem: P.directAccessOrderProblem(fields) };
};
const refused = [
  refuse("private IPv4", { addresses: ["192.168.1.20"] }),
  refuse("CGNAT", { addresses: ["100.64.0.9"] }),
  refuse("loopback", { addresses: ["127.0.0.1"] }),
  refuse("ULA", { addresses: ["fd12:3456::7"] }),
  refuse("link-local", { addresses: ["fe80::1"] }),
  refuse("documentation v6", { addresses: ["2001:db8::1"] }),
  refuse("documentation v4", { addresses: ["203.0.113.5"] }),
  refuse("IPv4-mapped", { addresses: ["::ffff:81.2.69.142"] }),
  refuse("non-canonical v6", { addresses: ["2A02:8010:6400:0001:0000:0000:0000:0010"] }),
  refuse("private prefix", { prefixes: ["fd00::/48"] }),
  refuse("prefix too wide", { prefixes: ["2a02::/16"] }),
  refuse("host bits in prefix", { prefixes: ["2a02:8010:6400::1/48"] }),
  refuse("off with addresses", { enabled: false }),
  refuse("on with nothing", { addresses: [], prefixes: [] }),
  refuse("bad port", { port: 0 }),
  refuse("duplicate", { addresses: ["81.2.69.142", "81.2.69.142"] }),
];
for (const r of refused) if (!r.problem) throw new Error(`expected a problem for ${r.name}`);

const sign = (u, key) => hex(P.signDirectAddressUpdate(u, key));
const update = { serverDomain: SERVER, orderSha256: orderSha, addresses: ["2a02:8010:6400:7::1", "81.2.69.142"], port: 443, issuedAt: NOW + 120_000 };
const updateCase = (name, patch, key = stk, ord = order) => {
  const fields = { ...update, ...patch };
  const signatureHex = sign(fields, key);
  const r = P.checkDirectAddressUpdate(fields, Buffer.from(signatureHex, "hex"), stk.publicKey, ord, { serverDomain: SERVER, now: NOW + 180_000 });
  return { name, fields, signatureHex, ...(ord === order ? {} : { order: ord }), reason: r.ok ? null : r.reason };
};
const updateCases = [
  updateCase("inside the grant", {}),
  updateCase("signed by another box", {}, otherStk),
  updateCase("for another server", { serverDomain: "home.other-user.flagship.services" }),
  updateCase("outside the grant", { addresses: ["2a02:8010:6401::1"] }),
  updateCase("private address", { addresses: ["192.168.1.20"] }),
  updateCase("names another order", { orderSha256: "cd".repeat(32) }),
  updateCase("wrong port", { port: 8443 }),
  updateCase("order turned off", { orderSha256: P.directAccessOrderSha256(off) }, stk, off),
  updateCase("dated in the future", { issuedAt: NOW + 3_600_000 }),
];

const hint = {
  serverDomain: SERVER,
  certSha256: CERT,
  lan: [{ address: "192.168.1.20", port: 443 }],
  direct: [
    { address: "2a02:8010:6400:7::1", port: 443 },
    { address: "81.2.69.142", port: 443 },
  ],
  orderSha256: orderSha,
  issuedAt: NOW,
  expiresAt: NOW + 6 * 3_600_000,
};
const hintCase = (name, patch, { key = stk, withOrder = true, ord = order } = {}) => {
  const fields = { ...hint, ...patch };
  const signatureHex = hex(P.signLanHintV2(fields, key));
  const r = P.checkLanHintV2(fields, Buffer.from(signatureHex, "hex"), stk.publicKey, { serverDomain: SERVER, certSha256: CERT, now: NOW + 60_000 }, withOrder ? ord : null);
  return { name, fields, signatureHex, withOrder, ...(withOrder && ord !== order ? { order: ord } : {}), ...(r.ok ? { useDirect: r.useDirect } : { reason: r.reason }) };
};
const forgedOrder = { ...order, addresses: ["81.2.69.143"] };
const hintCases = [
  hintCase("direct inside the order", {}),
  hintCase("no verified order: LAN only", {}, { withOrder: false }),
  hintCase("direct only, no verified order", { lan: [] }, { withOrder: false }),
  hintCase("order the hint doesn't name", {}, { ord: forgedOrder }),
  hintCase("direct outside the order", { direct: [{ address: "2a02:8010:6401::1", port: 443 }] }),
  hintCase("private address as direct", { direct: [{ address: "10.0.0.5", port: 443 }] }),
  hintCase("public address as LAN", { lan: [{ address: "81.2.69.142", port: 443 }] }),
  hintCase("direct on another port", { direct: [{ address: "81.2.69.142", port: 8443 }] }),
  hintCase("signed by another box", {}, { key: otherStk }),
  hintCase("another certificate", { certSha256: "cd".repeat(32) }),
  hintCase("LAN only, no order named", { direct: [], orderSha256: "" }, { withOrder: false }),
];

const vectors = {
  about:
    "Direct access (docs/direct-access-and-domains.md). Addresses: `canonical` maps input to canonical text (null = not an address); `public`/`notPublic` classify canonical text. Prefixes: `valid` maps input to canonical, `invalid` must not parse, `contains` pins membership. Order: build `order.canonical` byte for byte, its SHA-256 is `order.sha256`; the pinned signature verifies under `keys.adminRootPubHex` and NOT under `keys.irkPubHex`; each `order.refused` entry has the reason code `problem` and must never verify. Address update and hint v2: build `canonical` from `fields`; each case verifies under `keys.stkPubHex` with the box's check against the order (`order` in the case, else the main order; `withOrder: false` = no verified order) and gives `reason` (null = accepted) or `useDirect`. Check time: address cases at `addressUpdate.now`, hint cases at `hintV2.now`, hint expectations `serverDomain` and `certSha256` of the main hint.",
  keys: {
    adminRootSeedHex: hex(admin.privateKey),
    adminRootPubHex: hex(admin.publicKey),
    irkPubHex: hex(irk.publicKey),
    stkPubHex: hex(stk.publicKey),
    otherStkPubHex: hex(otherStk.publicKey),
  },
  addresses: {
    canonical: [
      ["81.2.69.142", "81.2.69.142"],
      ["2A02:8010:6400:0001:0000:0000:0000:0010", "2a02:8010:6400:1::10"],
      ["2a02:8010:0:0:1:0:0:1", "2a02:8010::1:0:0:1"],
      ["2a02:0:0:1:0:0:0:1", "2a02:0:0:1::1"],
      ["2a02:8010:6400:1:2:3:4:0", "2a02:8010:6400:1:2:3:4:0"],
      ["::", "::"],
      ["::1", "::1"],
      ["1::", "1::"],
      ["081.2.69.142", null],
      ["256.1.1.1", null],
      ["1.2.3", null],
      ["::ffff:1.2.3.4", null],
      ["fe80::1%eth0", null],
      ["1:2:3:4:5:6:7:8:9", null],
      ["1::2::3", null],
      ["12345::", null],
      ["", null],
    ].map(([input, canonical]) => {
      if (P.canonicalIp(input) !== canonical) throw new Error(`canonical ${input}`);
      return { input, canonical };
    }),
    public: ["81.2.69.142", "2a02:8010:6400:1::10", "8.8.8.8", "2606:4700:4700::1111"],
    notPublic: [
      "10.0.0.1", "172.16.0.1", "192.168.1.20", "100.64.0.9", "127.0.0.1", "169.254.1.1", "0.0.0.0", "224.0.0.1",
      "255.255.255.255", "192.0.2.1", "198.51.100.1", "203.0.113.5", "198.18.0.1", "::", "::1", "fd12:3456::7",
      "fe80::1", "ff02::1", "2001:db8::1", "2002:c000:204::1", "2001::1", "3fff::1", "64:ff9b::1:2", "fec0::1",
    ],
  },
  prefixes: {
    valid: [
      ["2a02:8010:6400::/48", "2a02:8010:6400::/48"],
      ["2A02:8010:6400:0000::/56", "2a02:8010:6400::/56"],
      ["81.2.69.0/24", "81.2.69.0/24"],
    ].map(([input, canonical]) => {
      const p = P.parsePrefix(input);
      if (!p || P.formatPrefix(p) !== canonical) throw new Error(`prefix ${input}`);
      return { input, canonical };
    }),
    invalid: ["2a02:8010:6400::1/48", "81.2.69.1/24", "81.2.69.0/33", "2a02::/129", "81.2.69.0", "81.2.69.0/024", "/24"],
    contains: [
      ["2a02:8010:6400::/48", "2a02:8010:6400:7::1", true],
      ["2a02:8010:6400::/48", "2a02:8010:6401::1", false],
      ["81.2.69.0/24", "81.2.69.142", true],
      ["81.2.69.0/24", "81.2.70.1", false],
      ["81.2.69.0/24", "2a02:8010:6400:7::1", false],
    ].map(([prefix, address, inside]) => {
      if (P.prefixContains(P.parsePrefix(prefix), address) !== inside) throw new Error(`contains ${prefix} ${address}`);
      return { prefix, address, inside };
    }),
  },
  order: {
    fields: order,
    canonical: text(P.canonicalDirectAccessOrder(order)),
    sha256: orderSha,
    signatureHex: hex(P.signDirectAccessOrder(order, admin)),
    off: { fields: off, canonical: text(P.canonicalDirectAccessOrder(off)), signatureHex: hex(P.signDirectAccessOrder(off, admin)) },
    refused,
  },
  addressUpdate: {
    now: NOW + 180_000,
    fields: update,
    canonical: text(P.canonicalDirectAddressUpdate(update)),
    cases: updateCases,
  },
  hintV2: {
    now: NOW + 60_000,
    fields: hint,
    canonical: text(P.canonicalLanHintV2(hint)),
    cases: hintCases,
  },
};

const json = `${JSON.stringify(vectors, null, 2)}\n`;
if (process.argv.includes("--check")) {
  let disk = "";
  try {
    disk = readFileSync(out, "utf8");
  } catch {}
  if (disk !== json) {
    console.error(`${out} is stale: run node scripts/gen-direct-access-vectors.mjs`);
    process.exit(1);
  }
  console.log("direct-access vectors are current");
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, json);
  console.log(`wrote ${out}`);
}
