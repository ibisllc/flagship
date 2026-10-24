#!/usr/bin/env -S npx tsx
/**
 * Vectors for keyd's master check (identityAssertion.ts checkMasterEvidence, pq-suites.md §16.6):
 * TS keyd, Rust keyd and the protocol test read them.
 *
 * Run:          npx tsx tools/master-evidence-vectors.ts
 * CI freshness: npx tsx tools/master-evidence-vectors.ts --check
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { checkMasterEvidence, deriveServiceMemberStableId, deriveServiceSecret } from "../packages/protocol/src/index.js";

const OUT = resolve(import.meta.dirname, "..", "packages/protocol/test-vectors/identity-assertion/master-evidence.json");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fill = (v: number) => new Uint8Array(32).fill(v);
const NOW = 1_790_000_000_000;
const swk = fill(0x5e);
const irk = fill(0x01);
const root = fill(0x02);
const other = fill(0x03);
const device = fill(0x04);
const devicePub = hex(ed25519.getPublicKey(device));
const otherDevPub = hex(ed25519.getPublicKey(fill(0x05)));
const APP = "john--chess";
const stable = (app: string, pubHex: string) => deriveServiceMemberStableId(deriveServiceSecret(swk, app), Buffer.from(pubHex, "hex"));
const sign = (k: Uint8Array, s: string) => hex(ed25519.sign(new TextEncoder().encode(s), k));
const grant = (pub: string, scopes: string, exp: number) => `flagship/device-capability-grant/v2|0b6f2d3e-0000-4000-8000-000000000001|john|dev-1|${pub}|${scopes}|${NOW - 1000}|${exp}`;
const rank = (target: string, r: string, app = APP) => `flagship/app-rank/v1|${app}|${target}|${r}|${NOW - 10}`;
const inject = (user: string, role: string, app = APP) => `flagship/inject/v1|${app}|${user}|${role}|${NOW}`;
const anchors = { irkPubHex: hex(ed25519.getPublicKey(irk)), adminRootPubHex: hex(ed25519.getPublicKey(root)) };
const irkOnly = { irkPubHex: anchors.irkPubHex };
const me = stable(APP, devicePub);
const g = grant(devicePub, "admin,apps", NOW + 86_400_000);
type C = { name: string; msg: string; ev: { appId: string; identityPubHex: string; statement: string; signatureHex: string }; anchors: { irkPubHex: string; adminRootPubHex?: string }; expect: string };
const ev = (statement: string, key: Uint8Array, over: Partial<C["ev"]> = {}) => ({ appId: APP, identityPubHex: devicePub, statement, signatureHex: sign(key, statement), ...over });
const cases: C[] = [
  { name: "admin device grant under the admin root", msg: inject(me, "master"), ev: ev(g, root), anchors, expect: "ok" },
  { name: "identity header with the app named in the evidence", msg: `flagship/identity-header/v1|${me}|master|${NOW}`, ev: ev(g, root), anchors, expect: "ok" },
  { name: "admin order raising the device", msg: inject(me, "master"), ev: ev(rank(`device:${devicePub}`, "master"), root), anchors, expect: "ok" },
  { name: "no admin root: the IRK's grant", msg: inject(me, "master"), ev: ev(grant(devicePub, "apps", NOW + 1000), irk), anchors: irkOnly, expect: "ok" },
  { name: "manager is not for sign.identity", msg: inject(me, "manager"), ev: ev(g, root), anchors, expect: "not-master" },
  { name: "another member's id", msg: inject(stable(APP, otherDevPub), "master"), ev: ev(g, root), anchors, expect: "wrong-member" },
  { name: "the evidence is for another app", msg: inject(me, "master"), ev: ev(g, root, { appId: "john--notes" }), anchors, expect: "wrong-app" },
  { name: "the grant names another key", msg: inject(stable(APP, otherDevPub), "master"), ev: ev(g, root, { identityPubHex: otherDevPub }), anchors, expect: "wrong-key" },
  { name: "a non-admin grant under the admin root", msg: inject(me, "master"), ev: ev(grant(devicePub, "apps", NOW + 1000), root), anchors, expect: "not-admin" },
  { name: "an expired grant", msg: inject(me, "master"), ev: ev(grant(devicePub, "admin,apps", NOW), root), anchors, expect: "expired" },
  { name: "signed by the IRK where an admin root is pinned", msg: inject(me, "master"), ev: ev(g, irk), anchors, expect: "bad-signature" },
  { name: "signed by a stranger", msg: inject(me, "master"), ev: ev(g, other), anchors, expect: "bad-signature" },
  { name: "an order raising to manager only", msg: inject(me, "master"), ev: ev(rank(`device:${devicePub}`, "manager"), root), anchors, expect: "not-admin" },
  { name: "an order for another app", msg: inject(me, "master"), ev: ev(rank(`device:${devicePub}`, "master", "john--notes"), root), anchors, expect: "wrong-app" },
  { name: "an unknown statement", msg: inject(me, "master"), ev: ev("flagship/other/v1|x", root), anchors, expect: "bad-evidence" },
  { name: "a malformed key", msg: inject(me, "master"), ev: ev(g, root, { identityPubHex: "zz" }), anchors, expect: "bad-evidence" },
];
for (const c of cases) {
  const got = checkMasterEvidence(c.msg, c.ev, c.anchors, NOW, (a, p) => deriveServiceMemberStableId(deriveServiceSecret(swk, a), p), (s, m, p) => ed25519.verify(Buffer.from(s, "hex"), m, Buffer.from(p, "hex"))) ?? "ok";
  if (got !== c.expect) throw new Error(`${c.name}: ${got}`);
}
const doc = { about: "keyd signs a master identity assertion only with this evidence (identityAssertion.ts checkMasterEvidence).", now: NOW, swk: hex(swk), stableIds: [{ app: APP, identityPubHex: devicePub, stableId: me }], cases };
const text = JSON.stringify(doc, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error(`${OUT} is stale`);
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${cases.length} cases`);
}
