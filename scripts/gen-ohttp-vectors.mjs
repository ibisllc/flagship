#!/usr/bin/env node
// Writes packages/protocol/test-vectors/ohttp/{vectors,spend-route}.json from the
// TS reference (packages/protocol/src/ohttp.ts, ohttpPrivacy.ts). Every OHTTP
// client (webapp, Swift, Kotlin, Go) and `.com`'s gateway test against them.
//   npx tsc -b packages/protocol && node scripts/gen-ohttp-vectors.mjs [--check]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../packages/protocol/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "packages/protocol/test-vectors/ohttp");
const hex = (b) => Buffer.from(b).toString("hex");
const fromHex = (s) => Uint8Array.from(Buffer.from(s, "hex"));
const seq = (n, start, step) => Uint8Array.from({ length: n }, (_, i) => (start + i * step) & 0xff);
const te = new TextEncoder();

// RFC 9458 Appendix A, verbatim (the key configuration offers two AEADs; clients use the first suite we support).
const rfc9458 = {
  gatewaySecretHex: "3c168975674b2fa8e465970b79c8dcf09f1c741626480bd4c6162fc5b6a98e1a",
  keyConfigHex: "01002031e1f05a740102115220e9af918f738674aec95f54db6e04eb705aae8e79815500080001000100010003",
  bhttpRequestHex: "00034745540568747470730b6578616d706c652e636f6d012f",
  ephemeralSecretHex: "bc51d5e930bda26589890ac7032f70ad12e4ecb37abb1b65b1256c9c48999c73",
  encapsulatedRequestHex:
    "010020000100014b28f881333e7c164ffc499ad9796f877f4e1051ee6d31bad19dec96c208b4726374e469135906992e1268c594d2a10c695d858c40a026e7965e7d86b83dd440b2c0185204b4d63525",
  bhttpResponseHex: "0140c8",
  responseNonceHex: "c789e7151fcba46158ca84b04464910d",
  encapsulatedResponseHex: "c789e7151fcba46158ca84b04464910d86f9013e404feea014e7be4a441f234f857fbd",
};

const gatewaySecret = seq(32, 0x11, 3);
const keyId = 7;
const gw = P.ohttpGatewayKey(keyId, gatewaySecret);
const keyConfigHex = hex(P.encodeOhttpKeyConfig(gw));

const mkCase = (name, request, response, n) => {
  const reqBody = te.encode(request.bodyText ?? "");
  const bhttpReq = P.encodeBhttpRequest({ ...request, headers: request.headers, body: reqBody });
  const eph = seq(32, 0x40 + n, 5);
  const { encapsulated, context } = P.encapsulateOhttpRequest(gw, bhttpReq, eph);
  const bhttpRes = P.encodeBhttpResponse({ status: response.status, headers: response.headers, body: te.encode(response.bodyText ?? "") });
  const nonce = seq(16, 0x90 + n, 7);
  const encRes = P.encapsulateOhttpResponse(context, bhttpRes, nonce);
  // self-check through the gateway side
  const back = P.decapsulateOhttpRequest([gw], encapsulated);
  if (hex(back.request) !== hex(bhttpReq)) throw new Error(`${name}: gateway round trip`);
  if (hex(P.decapsulateOhttpResponse(context, encRes)) !== hex(bhttpRes)) throw new Error(`${name}: response round trip`);
  const { bodyText: _b, ...reqRest } = request;
  return {
    name,
    request: { ...reqRest, bodyText: request.bodyText ?? "" },
    bhttpRequestHex: hex(bhttpReq),
    ephemeralSecretHex: hex(eph),
    encapsulatedRequestHex: hex(encapsulated),
    response: { status: response.status, headers: response.headers, bodyText: response.bodyText ?? "" },
    bhttpResponseHex: hex(bhttpRes),
    responseNonceHex: hex(nonce),
    encapsulatedResponseHex: hex(encRes),
  };
};

const J = [["content-type", "application/json"]];
const cases = [
  mkCase(
    "voucher-redeem",
    {
      method: "POST",
      scheme: "https",
      authority: "flagshipserver.com",
      path: "/api/vouchers/redeem",
      headers: J,
      bodyText: '{"v":1,"username":"plucky-avocet","for":"pro","vouchers":[]}',
    },
    { status: 200, headers: J, bodyText: '{"ok":true,"credited":1,"spent":1,"paidUntil":1760259200000}' },
    1,
  ),
  mkCase(
    "payments-config",
    { method: "GET", scheme: "https", authority: "flagshipserver.com", path: "/api/payments/config", headers: [] },
    { status: 200, headers: J, bodyText: '{"config":{}}' },
    2,
  ),
  mkCase(
    "refused-inside",
    { method: "GET", scheme: "https", authority: "flagshipserver.com", path: "/api/users/x/pods", headers: [] },
    { status: 403, headers: J, bodyText: '{"error":"not allowed through the relay"}' },
    3,
  ),
  mkCase(
    "long-body",
    {
      method: "POST",
      scheme: "https",
      authority: "flagshipserver.com",
      path: "/api/vouchers/redeem",
      headers: [["content-type", "application/json"], ["accept", "application/json"]],
      bodyText: `{"pad":"${"a".repeat(300)}"}`,
    },
    { status: 409, headers: J, bodyText: `{"code":"voucher-spent","spent":["${"b".repeat(64)}"]}` },
    4,
  ),
];

const encRes0 = fromHex(cases[0].encapsulatedResponseHex);
const tampered = Uint8Array.from(encRes0);
tampered[tampered.length - 1] ^= 0x01;
const negatives = {
  // Each must make the client's open fail (with the context of case `voucher-redeem`).
  responses: [
    { name: "tampered-tag", encapsulatedResponseHex: hex(tampered) },
    { name: "too-short", encapsulatedResponseHex: hex(encRes0.subarray(0, 20)) },
    { name: "wrong-nonce", encapsulatedResponseHex: hex(Uint8Array.from([...encRes0.subarray(0, 15), encRes0[15] ^ 0xff, ...encRes0.subarray(16)])) },
  ],
  // Key configurations a client must refuse (no suite it supports, truncated).
  keyConfigs: [
    { name: "p256-kem", hex: "07001000" + "04".padEnd(130, "a") + "000400010001" },
    { name: "chacha-only", hex: hex(Uint8Array.from([...fromHex(keyConfigHex).subarray(0, 35), 0x00, 0x04, 0x00, 0x01, 0x00, 0x03])) },
    { name: "truncated", hex: keyConfigHex.slice(0, 40) },
  ],
};
for (const k of negatives.keyConfigs) {
  if (P.parseOhttpKeyConfig(fromHex(k.hex)) !== null) throw new Error(`negative key config ${k.name} parsed`);
}

const vectors = {
  description:
    "OHTTP (RFC 9458) with Binary HTTP (RFC 9292), suite X25519/HKDF-SHA256/AES-128-GCM. Generated by scripts/gen-ohttp-vectors.mjs; docs/outbound-proxy.md.",
  rfc9458,
  gateway: { keyId, secretHex: hex(gatewaySecret), publicKeyHex: hex(gw.publicKey), keyConfigHex },
  cases,
  negatives,
};

// Spend routing after the relays fail, and the retry backoff.
const H = 3_600_000;
const D = 24 * H;
const routeCases = [];
for (const kind of ["interactive", "trickle", "overage"]) {
  for (const lapseInMs of [null, -H, 0, 23 * H, D - 1, D, 5 * D]) {
    routeCases.push({ kind, lapseInMs, mayGoDirect: P.ohttpSpendMayGoDirect(kind, lapseInMs) });
  }
}
const lapseCases = [
  { paidUntil: 0, graceMs: 72 * H, now: 1_760_000_000_000 },
  { paidUntil: 1_760_000_000_000, graceMs: 72 * H, now: 1_760_000_000_000 },
  { paidUntil: 1_760_000_000_000, graceMs: 72 * H, now: 1_760_000_000_000 + 80 * H },
].map((c) => ({ ...c, lapseInMs: P.planLapseInMs(c.paidUntil, c.graceMs, c.now) }));
const backoff = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 40].map((failures) => ({ failures, retryAfterMs: P.relayRetryAfterMs(failures) }));
const apex = "flagshipserver.com";
const hostCases = [
  "relay.example.net",
  "flagship-ohttp-relay.fly.dev",
  "ohttp.flagshipserver.com",
  "flagshipserver.com",
  "privacy-gateway.cloudflare.com",
  "x.workers.dev",
  "x.pages.dev",
  "FLAGSHIPSERVER.COM.",
  "notflagshipserver.com",
].map((host) => ({ host, forbidden: P.isForbiddenRelayHost(host, apex) }));
const configCases = [
  {
    name: "good",
    input: { v: 1, keyConfigHex, relays: [{ url: "https://relay.example.net/flagship", operator: "Example Relay Co", interim: false }] },
  },
  {
    name: "drops-cloudflare-and-http",
    input: {
      v: 1,
      keyConfigHex,
      relays: [
        { url: "https://privacy-gateway.cloudflare.com/x", operator: "CF", interim: false },
        { url: "http://relay.example.net/", operator: "Plain", interim: false },
        { url: "https://flagship-ohttp-relay.fly.dev/", operator: "Flagship (interim)", interim: true },
      ],
    },
  },
  { name: "no-key", input: { v: 1, keyConfigHex: null, relays: [{ url: "https://relay.example.net/", operator: "R", interim: false }] } },
  { name: "bad-key", input: { v: 1, keyConfigHex: "0700", relays: [{ url: "https://relay.example.net/", operator: "R", interim: false }] } },
  { name: "garbage", input: "nope" },
].map((c) => ({ ...c, controlApex: apex, expected: P.parseOhttpPublicConfig(c.input, apex) }));

const spend = {
  description:
    "After every relay failed: may a spend go directly (marked)? Retry backoff, lapse time, forbidden relay hosts, config parsing. Generated by scripts/gen-ohttp-vectors.mjs; docs/outbound-proxy.md \"Failure handling\".",
  directBeforeLapseMs: P.DIRECT_BEFORE_LAPSE_MS,
  route: routeCases,
  lapse: lapseCases,
  backoff,
  relayHosts: hostCases,
  config: configCases,
};

const files = [
  [join(dir, "vectors.json"), JSON.stringify(vectors, null, 2) + "\n"],
  [join(dir, "spend-route.json"), JSON.stringify(spend, null, 2) + "\n"],
];
if (process.argv.includes("--check")) {
  let bad = 0;
  for (const [p, s] of files) {
    let cur = "";
    try {
      cur = readFileSync(p, "utf8");
    } catch {
      /* missing */
    }
    if (cur !== s) {
      console.error(`stale: ${p}`);
      bad++;
    }
  }
  process.exit(bad ? 1 : 0);
}
mkdirSync(dir, { recursive: true });
for (const [p, s] of files) writeFileSync(p, s);
console.log(`wrote ${files.length} files to ${dir}`);
