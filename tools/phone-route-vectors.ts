#!/usr/bin/env -S npx tsx
/**
 * Writes packages/protocol/test-vectors/phone-route/vectors.json from packages/protocol/src/phoneRoute.ts: bare-name
 * parsing, a route claim and its refusals, the phone's certificate order, the CSR bytes for a fixed key, the ledger's
 * compare-and-set steps, certificate reuse and the phone endpoint's request policy. Swift and Kotlin read the file.
 *
 *   npx tsx tools/phone-route-vectors.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { p256 } from "@noble/curves/nist.js";
import {
  barePhoneAccount,
  canonicalCertificateOrder,
  canonicalPhonePresence,
  canonicalRouteClaim,
  canonicalRouteRelease,
  checkPhonePresence,
  checkRouteRelease,
  checkRouteClaim,
  csrSha256Hex,
  ed,
  emptyPhoneRouteEntry,
  ledgerAcquire,
  ledgerRelease,
  ledgerRenew,
  phoneCertNeedsOrder,
  phoneCsr,
  phoneCsrInfo,
  phoneEndpointCheck,
  phoneBeginGrants,
  phoneBeginMessage,
  phoneHostname,
  phoneRouteEligibility,
  signDeviceCapabilityGrant,
  signServingRecord,
  type DeviceCapabilityGrant,
  type DeviceScope,
  type PhoneEndpointRequest,
  type PhoneRouteEntry,
  type RouteClaim,
} from "../packages/protocol/src/index.js";

const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");
const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const dec = new TextDecoder();
const seed = new Uint8Array(32).fill(6);
const phonePub = hexOf(ed.getPublicKey(seed));
const sign = (m: Uint8Array) => ed.sign(m, seed);

const bare = [
  ["alice.flagship.services", "flagship.services", "alice"],
  ["ALICE.flagship.services", "flagship.services", "alice"],
  ["home.alice.flagship.services", "flagship.services", null],
  ["notes.alice.flagship.services", "flagship.services", null],
  ["flagship.services", "flagship.services", null],
  ["alice.gym.flagship.services", "gym.flagship.services", "alice"],
  ["alice.flagship.services.evil.com", "flagship.services", null],
  ["-alice.flagship.services", "flagship.services", null],
].map(([sni, apex, account]) => ({ sni, apex, account }));
for (const b of bare) if (barePhoneAccount(b.sni!, b.apex!) !== b.account) throw new Error(`bare ${b.sni}`);

const claim: RouteClaim = {
  account: "alice",
  phoneRoutePub: phonePub,
  hostname: phoneHostname("alice", "flagship.services"),
  generation: 4,
  sessionNonce: "5a".repeat(16),
  issuedAt: T0,
};
const claimSig = hexOf(signServingRecord("route-claim", claim, sign));
const session = { apex: "flagship.services", account: "alice", sessionNonce: claim.sessionNonce, generation: 4, now: T0 + 1_000 };
const claimCases = [
  { name: "accepted", claim, signature: claimSig, session, expected: "ok" },
  { name: "another session's nonce", claim, signature: claimSig, session: { ...session, sessionNonce: "5b".repeat(16) }, expected: "wrong-session" },
  { name: "generation not the offered one", claim, signature: claimSig, session: { ...session, generation: 5 }, expected: "wrong-generation" },
  { name: "more than 60 s old", claim, signature: claimSig, session: { ...session, now: T0 + 60_001 }, expected: "stale" },
  { name: "a name under another apex", claim: { ...claim, hostname: "alice.gym.flagship.services" }, signature: claimSig, session, expected: "wrong-hostname" },
  { name: "another account", claim, signature: claimSig, session: { ...session, account: "bob" }, expected: "wrong-account" },
  { name: "signature over another generation", claim: { ...claim, generation: 5 }, signature: claimSig, session: { ...session, generation: 5 }, expected: "bad-signature" },
].map((c) => {
  const r = checkRouteClaim({ claim: c.claim, signature: c.signature, ...c.session });
  const got = r.ok ? "ok" : r.code;
  if (got !== c.expected) throw new Error(`claim case ${c.name}: ${got}`);
  return c;
});

const csrKey = new Uint8Array(32).fill(7);
const csrPub = p256.getPublicKey(csrKey, false);
const info = phoneCsrInfo(csrPub, "alice.flagship.services");
const sigDer = p256.sign(info, csrKey, { format: "der", lowS: true });
const csr = phoneCsr(info, sigDer);
if (!p256.verify(sigDer, info, p256.getPublicKey(csrKey, true), { format: "der" })) throw new Error("csr signature");
const order = { class: "phone" as const, device: phonePub, regGen: 0, csrSha256: csrSha256Hex(csr), requestId: "6c".repeat(16), issuedAt: T0 };
const orderSig = hexOf(signServingRecord("certificate-order", order, sign));

const h = (relayId: string, sessionId: string) => ({ relayId, sessionId, phoneRoutePub: phonePub });
type Step = { op: "acquire" | "renew" | "release"; generation: number; relayId?: string; sessionId: string; now: number };
const steps: Step[] = [
  { op: "acquire", generation: 1, relayId: "relay-a", sessionId: "s1", now: T0 },
  { op: "acquire", generation: 2, relayId: "relay-b", sessionId: "s2", now: T0 + 1 },
  { op: "renew", generation: 1, sessionId: "s1", now: T0 + 15_000 },
  { op: "release", generation: 1, sessionId: "s2", now: T0 + 16_000 },
  { op: "release", generation: 1, sessionId: "s1", now: T0 + 20_000 },
  { op: "acquire", generation: 1, relayId: "relay-b", sessionId: "s2", now: T0 + 20_001 },
  { op: "acquire", generation: 2, relayId: "relay-b", sessionId: "s2", now: T0 + 20_002 },
  { op: "renew", generation: 2, sessionId: "s2", now: T0 + 90_000 },
  { op: "acquire", generation: 3, relayId: "relay-a", sessionId: "s3", now: T0 + 91_000 },
  { op: "renew", generation: 2, sessionId: "s2", now: T0 + 92_000 },
  { op: "acquire", generation: 4, relayId: "relay-b", sessionId: "s2", now: T0 + 93_000 },
];
let entry: PhoneRouteEntry = emptyPhoneRouteEntry();
const ledger = steps.map((s) => {
  const r =
    s.op === "acquire"
      ? ledgerAcquire(entry, s.generation, h(s.relayId!, s.sessionId), s.now)
      : s.op === "renew"
        ? ledgerRenew(entry, s.generation, s.sessionId, s.now)
        : ledgerRelease(entry, s.generation, s.sessionId);
  entry = r.entry;
  return { step: s, result: r.ok ? "ok" : r.code, entry: r.entry };
});

const release = { ...claim };
const releaseSig = hexOf(ed.sign(canonicalRouteRelease(release), seed));
const held = { account: "alice", hostname: claim.hostname, generation: 4, phoneRoutePub: phonePub, sessionNonce: claim.sessionNonce };
if (!checkRouteRelease({ release, signature: releaseSig, held, now: T0 }).ok) throw new Error("release");
const presence = { account: "alice", devicePub: phonePub, hostname: claim.hostname, issuedAt: T0 };
const presenceSig = hexOf(ed.sign(canonicalPhonePresence(presence), seed));
if (!checkPhonePresence(presence, presenceSig, claim.hostname, T0 + 1_000)) throw new Error("presence");

const certReuse = [
  { notAfter: null, lastFailureAt: null, now: T0, order: true },
  { notAfter: T0 + 60 * DAY, lastFailureAt: null, now: T0, order: false },
  { notAfter: T0 + 30 * DAY, lastFailureAt: null, now: T0, order: true },
  { notAfter: T0 + 31 * DAY, lastFailureAt: null, now: T0, order: false },
  { notAfter: null, lastFailureAt: T0 - 3_600_000, now: T0, order: false },
  { notAfter: null, lastFailureAt: T0 - 6 * 3_600_000, now: T0, order: true },
].map((c) => {
  if (phoneCertNeedsOrder(c) !== c.order) throw new Error(`cert reuse ${JSON.stringify(c)}`);
  return c;
});

const host = "alice.flagship.services";
const ctx = { hostname: host, sessionToken: "t".repeat(43), csrfToken: "c".repeat(43) };
const base: PhoneEndpointRequest = { method: "POST", host, origin: `https://${host}`, sessionCookie: ctx.sessionToken, csrf: ctx.csrfToken, upgrade: false };
const endpoint = [
  { name: "same-origin POST with session and token", request: base, verdict: "allow" },
  { name: "GET needs nothing", request: { ...base, method: "GET", origin: null, sessionCookie: null, csrf: null }, verdict: "allow" },
  { name: "Host of a sibling app", request: { ...base, host: `notes.${host}` }, verdict: "wrong-host" },
  { name: "sibling app's origin (same-site)", request: { ...base, origin: `https://notes.${host}` }, verdict: "cross-origin" },
  { name: "no Origin on a POST", request: { ...base, origin: null }, verdict: "cross-origin" },
  { name: "http origin", request: { ...base, origin: `http://${host}` }, verdict: "cross-origin" },
  { name: "cookie injected by a sibling (not the session)", request: { ...base, sessionCookie: "x".repeat(43) }, verdict: "no-session" },
  { name: "no CSRF header (form post)", request: { ...base, csrf: null }, verdict: "csrf" },
  { name: "WebSocket from a sibling origin", request: { ...base, method: "GET", upgrade: true, origin: `https://notes.${host}` }, verdict: "cross-origin" },
  { name: "WebSocket same-origin with session and token", request: { ...base, method: "GET", upgrade: true }, verdict: "allow" },
  { name: "opening a session from the phone's own origin", request: { ...base, sessionCookie: null, csrf: null, establish: true }, verdict: "allow" },
  { name: "opening a session from a sibling", request: { ...base, sessionCookie: null, csrf: null, establish: true, origin: `https://notes.${host}` }, verdict: "cross-origin" },
].map((c) => {
  const got = phoneEndpointCheck(c.request, ctx);
  if (got !== c.verdict) throw new Error(`endpoint ${c.name}: ${got}`);
  return { ...c, context: ctx };
});

// The begin's grant chain (relay-mesh.md §8.2): the phone picks its own admin-root-signed admin grants out of
// `/api/users/:u/device-grants`; a mesh relay checks them under the log's admin root.
const adminSeed = new Uint8Array(32).fill(9);
const adminRoot = { privateKey: adminSeed, publicKey: ed.getPublicKey(adminSeed) };
const otherSeed = new Uint8Array(32).fill(10);
const otherPub = hexOf(ed.getPublicKey(otherSeed));
const beginNow = T0 + DAY;
const listed = (
  [
    ["mine, admin, 90 days", "11", "alice", phonePub, ["browse", "admin"], T0, T0 + 90 * DAY, "admin-root"],
    ["mine, admin, 180 days", "12", "alice", phonePub, ["admin"], T0, T0 + 180 * DAY, "admin-root"],
    ["mine, signed by the membership key", "13", "alice", phonePub, ["admin"], T0, T0 + 90 * DAY, "membership"],
    ["another device", "14", "alice", otherPub, ["admin"], T0, T0 + 90 * DAY, "admin-root"],
    ["mine, expired", "15", "alice", phonePub, ["admin"], T0 - 90 * DAY, T0, "admin-root"],
    ["mine, no admin scope", "16", "alice", phonePub, ["browse"], T0, T0 + 90 * DAY, "admin-root"],
    ["mine, another account", "17", "bob", phonePub, ["admin"], T0, T0 + 90 * DAY, "admin-root"],
    ["mine, upper-case key", "18", "alice", phonePub.toUpperCase(), ["admin"], T0, T0 + 90 * DAY, "admin-root"],
  ] as const
).map(([note, id, username, pub, scopes, issuedAt, expiresAt, signerRoot]) => {
  const grant: DeviceCapabilityGrant = {
    grantId: `${id}`.repeat(4) + "-0000-4000-8000-" + `${id}`.repeat(6),
    username,
    deviceId: "d1".repeat(16),
    devicePubKey: new Uint8Array(Buffer.from(pub.toLowerCase(), "hex")),
    scopes: [...scopes] as DeviceScope[],
    issuedAt,
    expiresAt,
  };
  const signer = signerRoot === "admin-root" ? adminRoot : { privateKey: otherSeed, publicKey: ed.getPublicKey(otherSeed) };
  return {
    note,
    grantId: grant.grantId,
    username,
    deviceId: grant.deviceId,
    devicePubHex: pub,
    scopes: [...scopes],
    issuedAt,
    expiresAt,
    signatureHex: hexOf(signDeviceCapabilityGrant(grant, signer)),
    signerRoot,
  };
});
const beginGrants = phoneBeginGrants({ username: "alice", grants: listed }, "alice", phonePub, beginNow);
const beginMessage = phoneBeginMessage("alice", beginGrants);
if (beginGrants.map((g) => g.grant.grantId.slice(0, 2)).join() !== "12,11,18") throw new Error(`begin grants ${beginGrants.map((g) => g.grant.grantId).join()}`);
const beginViews = beginGrants.map((g) => ({
  grant: { ...g.grant, devicePubKey: new Uint8Array(Buffer.from(g.grant.devicePubHex, "hex")), scopes: g.grant.scopes as DeviceScope[] },
  signatureHex: g.signatureHex,
  signerRoot: g.signerRoot,
}));
if (!phoneRouteEligibility(phonePub, "alice", hexOf(adminRoot.publicKey), beginViews, beginNow).ok) throw new Error("begin grants not eligible");

const out = {
  about:
    "Phone route (plan H2/H3, docs/architecture-v2/issuance-and-lease-records.md §4 'Phone routing', phone-route.md): written by tools/phone-route-vectors.ts from packages/protocol/src/phoneRoute.ts. Claims and orders are Ed25519 under signerSeed (deterministic); the CSR signature is RFC 6979 low-S DER (Swift and Kotlin sign randomly, so they must reproduce infoHex exactly and csrHex from the given signature).",
  signerSeed: hexOf(seed),
  signerPub: phonePub,
  bare,
  claim: { record: claim, canonical: dec.decode(canonicalRouteClaim(claim)), signature: claimSig, cases: claimCases },
  certificateOrder: { record: order, canonical: dec.decode(canonicalCertificateOrder(order)), signature: orderSig },
  csr: {
    privateKey: hexOf(csrKey),
    publicKeyUncompressed: hexOf(csrPub),
    hostname: "alice.flagship.services",
    infoHex: hexOf(info),
    signatureDerHex: hexOf(sigDer),
    csrHex: hexOf(csr),
    csrSha256: csrSha256Hex(csr),
  },
  ledger,
  release: { record: release, canonical: dec.decode(canonicalRouteRelease(release)), signature: releaseSig, held },
  presence: { record: presence, canonical: dec.decode(canonicalPhonePresence(presence)), signature: presenceSig },
  certReuse,
  endpoint,
  begin: {
    about: "The phone's begin (relay-mesh.md §8.2): its own admin grants out of the device-grants body, admin-root-signed with the admin scope and unexpired, latest expiry first (then the smaller grantId), at most 8, keys and signatures lower-case. Compare as JSON values (key order is free).",
    account: "alice",
    devicePub: phonePub,
    now: beginNow,
    adminRootPub: hexOf(adminRoot.publicKey),
    deviceGrants: { username: "alice", grants: listed },
    message: beginMessage,
  },
};
const dir = "packages/protocol/test-vectors/phone-route";
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/vectors.json`, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${dir}/vectors.json`);
