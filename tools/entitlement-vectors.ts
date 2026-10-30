#!/usr/bin/env -S npx tsx
/**
 * Shared vectors for the pod entitlement domain (packages/protocol/src/entitlements.ts): RootEntitlement,
 * ServiceEntitlement, the entitlement revocation list, TunnelHello v2 and ServiceGrant. The TypeScript port GENERATES them;
 * packages/protocol/tests/entitlementVectors.test.ts and the Rust twin (flagship-crypto `entitlements`) check them.
 *
 * Run:          npx tsx tools/entitlement-vectors.ts
 * CI freshness: npx tsx tools/entitlement-vectors.ts --check
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ed } from "../packages/protocol/src/edSync.js";
import {
  canonicalEntitlementRevocationList,
  canonicalRootEntitlement,
  canonicalServiceEntitlement,
  canonicalServiceGrant,
  canonicalTunnelHelloV2,
  serviceGrantActiveAt,
  serviceGrantAuthorizesPod,
  type EntitlementRevocationList,
  type RootEntitlement,
  type ServiceEntitlement,
  type ServiceGrant,
  type TunnelHelloV2,
} from "../packages/protocol/src/entitlements.js";

const OUT = resolve(import.meta.dirname, "..", "packages/protocol/test-vectors/entitlements/vectors.json");
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const fill = (v: number): Uint8Array => new Uint8Array(32).fill(v);
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const text = (b: Uint8Array): string => Buffer.from(b).toString("utf8");

const IRK = fill(0x11);
const ADMIN = fill(0x12);
const STK = fill(0x13);
const OTHER = fill(0x14);
const pub = (seed: Uint8Array): string => hex(ed.getPublicKey(seed));
const sign = (msg: Uint8Array, seed: Uint8Array): string => hex(ed.sign(msg, seed));
const flip = (h: string): string => h.slice(0, -2) + (h.slice(-2) === "00" ? "01" : "00");
const bytes = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));

const POD = "kitchen.john.flagship.services";
const NOW = 1_760_000_000_000;
const root: RootEntitlement = { username: "john", podPubKey: ed.getPublicKey(STK), podCanonical: POD, issuedAt: NOW };
const service: ServiceEntitlement = {
  username: "john",
  podPubKey: ed.getPublicKey(STK),
  canonicals: ["Messenger-Facebook.kitchen.john.flagship.services", "chess.kitchen.john.flagship.services"],
  issuedAt: NOW,
  expiresAt: NOW + 90 * 86_400_000,
};
const rootCanon = canonicalRootEntitlement(root);
const serviceCanon = canonicalServiceEntitlement(service);
const hello: TunnelHelloV2 = {
  serverId: POD,
  rootEntitlementCertId: sha(rootCanon),
  serviceEntitlementCertId: sha(serviceCanon),
  nonce: fill(0x21),
  issuedAt: NOW + 5_000,
};
const grant: ServiceGrant = {
  grantId: "5d7b1a3e-9c1a-4f6e-8a55-0a1b2c3d4e5f",
  username: "john",
  serviceCanonical: "chess@a1b2c3d4e5f6",
  serverDomains: [POD, "woodshed.john.flagship.services"],
  serverIdentities: [ed.getPublicKey(STK), ed.getPublicKey(OTHER)],
  routes: [
    { url: "chess.john.flagship.services", scope: "canonical" },
    { url: "chess.kitchen.john.flagship.services", scope: "non-canonical" },
    { url: "chess.john.flagship.services/api", scope: "subpath" },
  ],
  issuedAt: NOW,
  expiresAt: NOW + 7 * 86_400_000,
};
const revocation: EntitlementRevocationList = { username: "john", certIds: [sha(serviceCanon), sha(rootCanon)], issuedAt: NOW + 1000 };

interface Case {
  name: string;
  kind: "root" | "service" | "hello" | "grant" | "revocation";
  input: Record<string, unknown>;
  canonical: string | null;
  certId?: string;
  signerPubHex?: string;
  signatureHex?: string;
  verifies?: boolean;
}

const rootIn = (r: RootEntitlement): Record<string, unknown> => ({ username: r.username, podPubKeyHex: hex(r.podPubKey), podCanonical: r.podCanonical, issuedAt: r.issuedAt });
const serviceIn = (s: ServiceEntitlement): Record<string, unknown> => ({ username: s.username, podPubKeyHex: hex(s.podPubKey), canonicals: s.canonicals, issuedAt: s.issuedAt, expiresAt: s.expiresAt });
const helloIn = (h: TunnelHelloV2): Record<string, unknown> => ({ serverId: h.serverId, rootEntitlementCertId: h.rootEntitlementCertId, serviceEntitlementCertId: h.serviceEntitlementCertId, nonceHex: hex(h.nonce), issuedAt: h.issuedAt });
const grantIn = (g: ServiceGrant): Record<string, unknown> => ({
  grantId: g.grantId, username: g.username, serviceCanonical: g.serviceCanonical, ...(g.serviceInstanceId !== undefined ? { serviceInstanceId: g.serviceInstanceId } : {}),
  serverDomains: g.serverDomains, serverIdentitiesHex: g.serverIdentities.map(hex), routes: g.routes, issuedAt: g.issuedAt, expiresAt: g.expiresAt,
});
const revocationIn = (r: EntitlementRevocationList): Record<string, unknown> => ({ username: r.username, certIds: r.certIds, issuedAt: r.issuedAt });

function signed(name: string, kind: Case["kind"], input: Record<string, unknown>, canon: Uint8Array, seed: Uint8Array, withId: boolean, sigOver?: Uint8Array): Case {
  return { name, kind, input, canonical: text(canon), ...(withId ? { certId: sha(canon) } : {}), signerPubHex: pub(seed), signatureHex: sign(sigOver ?? canon, seed), verifies: sigOver === undefined };
}

const cases: Case[] = [
  signed("root entitlement signed by the IRK", "root", rootIn(root), rootCanon, IRK, true),
  signed("root entitlement signed by the admin root", "root", rootIn(root), rootCanon, ADMIN, true),
  signed("root entitlement: the signature covers another podCanonical", "root", rootIn(root), rootCanon, IRK, true, canonicalRootEntitlement({ ...root, podCanonical: "cabin.john.flagship.services" })),
  signed("service entitlement signed by the IRK (canonicals lower-cased and sorted)", "service", serviceIn(service), serviceCanon, IRK, true),
  signed("service entitlement: the signature covers a longer expiry", "service", serviceIn(service), serviceCanon, IRK, true, canonicalServiceEntitlement({ ...service, expiresAt: service.expiresAt + 1 })),
  signed("tunnel hello v2 signed by the STK", "hello", helloIn(hello), canonicalTunnelHelloV2(hello), STK, false),
  signed("tunnel hello v2: the signature covers another nonce", "hello", helloIn(hello), canonicalTunnelHelloV2(hello), STK, false, canonicalTunnelHelloV2({ ...hello, nonce: fill(0x22) })),
  signed("service grant signed by the IRK (sets sorted)", "grant", grantIn(grant), canonicalServiceGrant(grant), IRK, true),
  signed("service grant: the signature covers another route", "grant", grantIn(grant), canonicalServiceGrant(grant), IRK, true, canonicalServiceGrant({ ...grant, routes: [{ url: "evil.john.flagship.services", scope: "canonical" }] })),
  signed("revocation list signed by the IRK (ids sorted)", "revocation", revocationIn(revocation), canonicalEntitlementRevocationList(revocation), IRK, false),
  { name: "root entitlement: a username with the separator is refused", kind: "root", input: rootIn({ ...root, username: "jo|hn" }), canonical: null },
  { name: "root entitlement: a control character is refused", kind: "root", input: rootIn({ ...root, podCanonical: "kit\nchen.john.flagship.services" }), canonical: null },
  { name: "service grant: expiresAt not after issuedAt is refused", kind: "grant", input: grantIn({ ...grant, expiresAt: grant.issuedAt }), canonical: null },
  { name: "service grant: no identities is refused", kind: "grant", input: grantIn({ ...grant, serverIdentities: [] }), canonical: null },
  { name: "service grant: no routes is refused", kind: "grant", input: grantIn({ ...grant, routes: [] }), canonical: null },
  { name: "service grant: a '|' in a route is refused", kind: "grant", input: grantIn({ ...grant, routes: [{ url: "a|b.example", scope: "canonical" }] }), canonical: null },
];
// The cases whose signature must NOT verify carry the verdict explicitly.
for (const c of cases) {
  if (c.signatureHex === undefined) continue;
  // A wrong-key case: the same canonical, a signature by an unrelated key.
}
cases.push({ ...signed("root entitlement: a signature by an unrelated key", "root", rootIn(root), rootCanon, OTHER, true), signerPubHex: pub(IRK), verifies: false });
cases.push({ ...signed("hello: a flipped signature bit", "hello", helloIn(hello), canonicalTunnelHelloV2(hello), STK, false), signatureHex: flip(sign(canonicalTunnelHelloV2(hello), STK)), verifies: false });

const grantWindow = [
  { at: NOW - 1, active: serviceGrantActiveAt(grant, NOW - 1) },
  { at: NOW, active: serviceGrantActiveAt(grant, NOW) },
  { at: NOW + 7 * 86_400_000 - 1, active: serviceGrantActiveAt(grant, NOW + 7 * 86_400_000 - 1) },
  { at: NOW + 7 * 86_400_000, active: serviceGrantActiveAt(grant, NOW + 7 * 86_400_000) },
];
const grantPods = [pub(STK), pub(OTHER), pub(IRK)].map((p) => ({ podPubKeyHex: p, authorized: serviceGrantAuthorizesPod(grant, bytes(p)) }));

const out = {
  schema: 1,
  about: "Generated by tools/entitlement-vectors.ts. Each case: the input fields, the canonical string the TypeScript encoder produces (null when it refuses), the SHA-256 cert id where the type has one, and one signature with the verdict a verifier must reach.",
  keys: { irk: pub(IRK), adminRoot: pub(ADMIN), stk: pub(STK), other: pub(OTHER) },
  grantWindow: { grant: grantIn(grant), checks: grantWindow, pods: grantPods },
  cases,
};
const body = JSON.stringify(out, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== body) {
    console.error("entitlement vectors are stale: run npx tsx tools/entitlement-vectors.ts");
    process.exit(1);
  }
  console.log("entitlement vectors are fresh");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, body);
  console.log(`wrote ${OUT} (${cases.length} cases)`);
}
