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
import { checkMasterEvidence, deriveServiceMemberStableId, deriveServiceSecret, noteRevocation, type RevocationNote } from "../packages/protocol/src/index.js";

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
const GRANT_ID = "0b6f2d3e-0000-4000-8000-000000000001";
const grant = (pub: string, scopes: string, exp: number, issued = NOW - 1000) => `flagship/device-capability-grant/v2|${GRANT_ID}|john|dev-1|${pub}|${scopes}|${issued}|${exp}`;
const rank = (target: string, r: string, app = APP, at: number | string = NOW - 10) => `flagship/app-rank/v1|${app}|${target}|${r}|${at}`;
const inject = (user: string, role: string, app = APP) => `flagship/inject/v1|${app}|${user}|${role}|${NOW}`;
const anchors = { irkPubHex: hex(ed25519.getPublicKey(irk)), adminRootPubHex: hex(ed25519.getPublicKey(root)) };
const irkOnly = { irkPubHex: anchors.irkPubHex };
const me = stable(APP, devicePub);
const g = grant(devicePub, "admin,apps", NOW + 86_400_000);
type Held = { grants?: string[]; keys?: string[]; ranks?: Record<string, { issuedAt: number; rank: string }> };
type C = { name: string; msg: string; ev: { appId: string; identityPubHex: string; statement: string; signatureHex: string }; anchors: { irkPubHex: string; adminRootPubHex?: string }; held?: Held; expect: string };
const devTarget = `device:${devicePub}`;
const heldRank = (r: string, at: number, app = APP, target = devTarget): Held => ({ ranks: { [`${app}|${target}`]: { issuedAt: at, rank: r } } });
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
  { name: "a grant issued in the future", msg: inject(me, "master"), ev: ev(grant(devicePub, "admin,apps", NOW + 86_400_000, NOW + 600_000), root), anchors, expect: "future" },
  { name: "a grant issued within the clock skew", msg: inject(me, "master"), ev: ev(grant(devicePub, "admin,apps", NOW + 86_400_000, NOW + 60_000), root), anchors, expect: "ok" },
  { name: "a revoked grant", msg: inject(me, "master"), ev: ev(g, root), anchors, held: { grants: [GRANT_ID] }, expect: "revoked" },
  { name: "a grant of a revoked device key", msg: inject(me, "master"), ev: ev(g, root), anchors, held: { keys: [devicePub] }, expect: "revoked" },
  { name: "another grant's revocation does not matter", msg: inject(me, "master"), ev: ev(g, root), anchors, held: { grants: ["0b6f2d3e-0000-4000-8000-000000000002"], keys: [otherDevPub] }, expect: "ok" },
  { name: "an admin later demoted the device in this app", msg: inject(me, "master"), ev: ev(g, root), anchors, held: heldRank("member", NOW - 5), expect: "superseded" },
  { name: "an admin refused the device in this app", msg: inject(me, "master"), ev: ev(g, root), anchors, held: heldRank("refused", NOW - 5), expect: "superseded" },
  { name: "an admin order to master leaves the grant standing", msg: inject(me, "master"), ev: ev(g, root), anchors, held: heldRank("master", NOW - 5), expect: "ok" },
  { name: "a demotion in another app does not matter", msg: inject(me, "master"), ev: ev(g, root), anchors, held: heldRank("member", NOW - 5, "john--notes"), expect: "ok" },
  { name: "a master order later demoted", msg: inject(me, "master"), ev: ev(rank(devTarget, "master"), root), anchors, held: heldRank("manager", NOW - 5), expect: "superseded" },
  { name: "a master order later refused", msg: inject(me, "master"), ev: ev(rank(devTarget, "master"), root), anchors, held: heldRank("refused", NOW - 5), expect: "superseded" },
  { name: "the master order keyd holds as the latest", msg: inject(me, "master"), ev: ev(rank(devTarget, "master"), root), anchors, held: heldRank("master", NOW - 10), expect: "ok" },
  { name: "an older demotion does not void a newer master order", msg: inject(me, "master"), ev: ev(rank(devTarget, "master"), root), anchors, held: heldRank("member", NOW - 20), expect: "ok" },
  { name: "a demotion at the same time wins", msg: inject(me, "master"), ev: ev(rank(devTarget, "master"), root), anchors, held: heldRank("member", NOW - 10), expect: "superseded" },
  { name: "a newer master order replaced this one", msg: inject(me, "master"), ev: ev(rank(devTarget, "master"), root), anchors, held: heldRank("master", NOW - 5), expect: "superseded" },
  { name: "a master order for a revoked device", msg: inject(me, "master"), ev: ev(rank(devTarget, "master"), root), anchors, held: { keys: [devicePub] }, expect: "revoked" },
  { name: "a master order for an AID later demoted", msg: inject(me, "master"), ev: ev(rank(`aid:${devicePub}`, "master"), root), anchors, held: heldRank("member", NOW - 5, APP, `aid:${devicePub}`), expect: "superseded" },
  { name: "a master order dated in the future", msg: inject(me, "master"), ev: ev(rank(devTarget, "master", APP, NOW + 600_000), root), anchors, expect: "future" },
  { name: "a master order with a padded time", msg: inject(me, "master"), ev: ev(rank(devTarget, "master", APP, `0${NOW - 10}`), root), anchors, expect: "bad-evidence" },
];
for (const c of cases) {
  const got = checkMasterEvidence(c.msg, c.ev, c.anchors, NOW, (a, p) => deriveServiceMemberStableId(deriveServiceSecret(swk, a), p), (s, m, p) => ed25519.verify(Buffer.from(s, "hex"), m, Buffer.from(p, "hex")), c.held) ?? "ok";
  if (got !== c.expect) throw new Error(`${c.name}: ${got}`);
}
const verifyHex = (s: string, m: Uint8Array, p: string) => ed25519.verify(Buffer.from(s, "hex"), m, Buffer.from(p, "hex"));
const revoke = (id = GRANT_ID, reason = "lost", at: number = NOW - 1) => `flagship/revoke-device-capability-grant/v1|${id}|john|${reason}|${at}`;
const memberGrant = grant(devicePub, "apps", NOW + 1000);
type N = { name: string; anchors: C["anchors"]; held: Held; note: RevocationNote; expect: string; changed?: boolean; heldAfter?: Held };
const note = (st: string, key: Uint8Array, g?: { st: string; key: Uint8Array }): RevocationNote => ({
  statement: st,
  signatureHex: sign(key, st),
  ...(g ? { grantStatement: g.st, grantSignatureHex: sign(g.key, g.st) } : {}),
});
const rankAt = (r: string, at: number, target = devTarget) => rank(target, r, APP, at);
const notes: Omit<N, "changed" | "heldAfter">[] = [
  { name: "a revocation by the admin root", anchors, held: {}, note: note(revoke(), root), expect: "ok" },
  { name: "a revocation with the revoked admin grant", anchors, held: {}, note: note(revoke(), root, { st: g, key: root }), expect: "ok" },
  { name: "a revocation with an IRK-signed member grant", anchors, held: {}, note: note(revoke(), root, { st: memberGrant, key: irk }), expect: "ok" },
  { name: "a revocation already held", anchors, held: { grants: [GRANT_ID] }, note: note(revoke(), root), expect: "ok" },
  { name: "a revocation signed by the IRK where an admin root is pinned", anchors, held: {}, note: note(revoke(), irk), expect: "bad-signature" },
  { name: "a revocation where no admin root is pinned", anchors: irkOnly, held: {}, note: note(revoke(), irk), expect: "no-admin-root" },
  { name: "a revocation with another grant", anchors, held: {}, note: note(revoke("0b6f2d3e-0000-4000-8000-000000000002"), root, { st: g, key: root }), expect: "wrong-grant" },
  { name: "a revocation with a stranger's grant", anchors, held: {}, note: note(revoke(), root, { st: g, key: other }), expect: "bad-signature" },
  { name: "a revocation dated in the future", anchors, held: {}, note: note(revoke(GRANT_ID, "lost", NOW + 600_000), root), expect: "future" },
  { name: "a revocation with an unknown reason", anchors, held: {}, note: note(revoke(GRANT_ID, "bored"), root), expect: "bad-statement" },
  { name: "a demotion by the admin root", anchors, held: {}, note: note(rankAt("member", NOW - 5), root), expect: "ok" },
  { name: "a demotion signed by the IRK where an admin root is pinned", anchors, held: {}, note: note(rankAt("member", NOW - 5), irk), expect: "bad-signature" },
  { name: "a demotion by the IRK where no admin root is pinned", anchors: irkOnly, held: {}, note: note(rankAt("refused", NOW - 5), irk), expect: "ok" },
  { name: "an order older than the one held changes nothing", anchors, held: heldRank("member", NOW - 5), note: note(rankAt("master", NOW - 10), root), expect: "ok" },
  { name: "a newer order replaces the one held", anchors, held: heldRank("master", NOW - 10), note: note(rankAt("manager", NOW - 5), root), expect: "ok" },
  { name: "at the same time a demotion replaces master", anchors, held: heldRank("master", NOW - 10), note: note(rankAt("member", NOW - 10), root), expect: "ok" },
  { name: "at the same time master does not replace a demotion", anchors, held: heldRank("member", NOW - 10), note: note(rankAt("master", NOW - 10), root), expect: "ok" },
  { name: "an order dated in the future", anchors, held: {}, note: note(rankAt("member", NOW + 600_000), root), expect: "future" },
  { name: "an order with a bad target", anchors, held: {}, note: note(rankAt("member", NOW - 5, "device:zz"), root), expect: "bad-statement" },
  { name: "an unknown statement", anchors, held: {}, note: note("flagship/other/v1|x", root), expect: "bad-statement" },
  { name: "a malformed signature", anchors, held: {}, note: { statement: revoke(), signatureHex: "zz" }, expect: "bad-statement" },
];
const noteCases: N[] = notes.map((n) => {
  const r = noteRevocation(n.held, n.note, n.anchors, NOW, verifyHex);
  const got = typeof r === "string" ? r : "ok";
  if (got !== n.expect) throw new Error(`${n.name}: ${got}`);
  return typeof r === "string" ? n : { ...n, changed: r.changed, heldAfter: r.held };
});
const doc = { about: "keyd signs a master identity assertion only with this evidence (identityAssertion.ts checkMasterEvidence); `held` is what keyd keeps of the owner's revocations and rank orders (revocations.json).", now: NOW, swk: hex(swk), stableIds: [{ app: APP, identityPubHex: devicePub, stableId: me }], cases, notes: noteCases };
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
