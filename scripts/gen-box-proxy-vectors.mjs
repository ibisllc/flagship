#!/usr/bin/env node
// Writes packages/protocol/test-vectors/box-proxy/vectors.json from the TS
// reference (docs/outbound-proxy.md). Build the protocol package first:
//   npx tsc -b packages/protocol && node scripts/gen-box-proxy-vectors.mjs
// `--check` exits 1 when the file on disk differs.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../packages/protocol/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "packages/protocol/test-vectors/box-proxy/vectors.json");
const hex = (b) => Buffer.from(b).toString("hex");
const fill = (n, v) => new Uint8Array(n).fill(v);
const text = (b) => new TextDecoder().decode(b);
const flip = (sigHex) => (sigHex[0] === "0" ? "1" : "0") + sigHex.slice(1);

const umk = { seed: fill(32, 0x2a) };
const irk = P.deriveIRK(umk);
const nonce = hex(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff));
const mk = (kind, host, port, auth, fallbackDirect, extra = {}) => ({
  serverDomain: "home.plucky-avocet.flagship.services",
  kind,
  host,
  port,
  auth,
  fallbackDirect,
  issuedAt: 1_760_000_000_000,
  nonce,
  ...extra,
});

const cases = [
  { name: "socks5 with a password, may fall back", fields: mk("socks5", "proxy.example.net", 1080, true, true) },
  { name: "http on a LAN address", fields: mk("http", "192.168.1.20", 3128, false, false) },
  { name: "socks5 on IPv6", fields: mk("socks5", "2001:db8::7", 9050, false, false) },
  { name: "no proxy", fields: mk("none", "", 0, false, false) },
].map((c) => {
  const signatureHex = P.signBoxProxy(c.fields, irk);
  if (!P.verifyBoxProxy(c.fields, signatureHex, irk.publicKey)) throw new Error(`${c.name} doesn't verify`);
  return {
    ...c,
    canonical: text(P.canonicalBoxProxy(c.fields)),
    signatureHex,
    wire: { proxy: c.fields, signature: signatureHex },
    rejectSignatureHex: flip(signatureHex),
  };
});

const ok = cases[0].fields;
const refuse = [
  { why: "uppercase host", fields: { ...ok, host: "Proxy.example.net" } },
  { why: "host with a scheme", fields: { ...ok, host: "socks5://proxy.example.net" } },
  { why: "host with a port", fields: { ...ok, host: "proxy.example.net:1080" } },
  { why: "bracketed IPv6", fields: { ...ok, host: "[2001:db8::7]" } },
  { why: "bad IPv4", fields: { ...ok, host: "192.168.1.300" } },
  { why: "port 0", fields: { ...ok, port: 0 } },
  { why: "port too high", fields: { ...ok, port: 65536 } },
  { why: "unknown kind", fields: { ...ok, kind: "https" } },
  { why: "none with a host", fields: mk("none", "proxy.example.net", 0, false, false) },
  { why: "none with fallback", fields: mk("none", "", 0, false, true) },
  { why: "uppercase serverDomain", fields: { ...ok, serverDomain: "Home.plucky-avocet.flagship.services" } },
  { why: "short nonce", fields: { ...ok, nonce: "ab" } },
];
for (const r of refuse) {
  let threw = false;
  try { P.canonicalBoxProxy(r.fields); } catch { threw = true; }
  if (!threw) throw new Error(`refuse case accepted: ${r.why}`);
}

const normalize = [
  { input: "  Proxy.Example.NET  ", host: "proxy.example.net" },
  { input: "[2001:DB8::7]", host: "2001:db8::7" },
  { input: "proxy.example.net.", host: "proxy.example.net" },
];
for (const n of normalize) {
  if (P.normalizeBoxProxyHost(n.input) !== n.host) throw new Error(`normalize ${n.input}`);
}

const hostErrors = [
  "proxy.example.net",
  "192.168.1.20",
  "2001:db8::7",
  "",
  "proxy.example.net:1080",
  "192.168.1.20:3128",
  "192.168.1.300",
  "bad_host.example",
  "socks5://proxy.example.net",
].map((host) => ({ host, error: P.boxProxyHostError(host) }));

const credentials = {
  accept: [
    { username: "alice", password: "s3cret pass" },
    { username: "u", password: "é".repeat(127) },
  ],
  refuse: [
    { why: "empty username", username: "", password: "x" },
    { why: "empty password", username: "alice", password: "" },
    { why: "colon in username", username: "al:ice", password: "x" },
    { why: "password over 255 bytes", username: "alice", password: "é".repeat(128) },
    { why: "control character", username: "alice", password: "a\nb" },
  ],
};
for (const c of credentials.accept) if (P.boxProxyCredentialsError(c)) throw new Error("credentials refused");
for (const c of credentials.refuse) if (!P.boxProxyCredentialsError(c)) throw new Error(`credentials accepted: ${c.why}`);

const vectors = {
  about: "A box's outbound proxy order (docs/outbound-proxy.md). Every platform must derive `keys.irkPubHex` from `keys.umkSeedHex`, build each case's `canonical` from its `fields` byte for byte (booleans as 1/0), and reproduce `signatureHex` with the IRK; `rejectSignatureHex` must fail to verify; every `refuse` case must be refused before signing; `normalize` maps typed input to the host that is signed; `hostErrors` gives the exact message (or null) every app shows for a typed host; `credentials` are checked by the same rules everywhere (never signed).",
  keys: {
    umkSeedHex: hex(umk.seed),
    irkPubHex: hex(irk.publicKey),
  },
  cases,
  refuse,
  normalize,
  hostErrors,
  credentials,
};

const json = `${JSON.stringify(vectors, null, 2)}\n`;
if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(out, "utf8"); } catch { /* missing */ }
  if (current !== json) {
    console.error(`${out} is stale; rerun scripts/gen-box-proxy-vectors.mjs`);
    process.exit(1);
  }
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, json);
  console.log(`wrote ${out}`);
}
