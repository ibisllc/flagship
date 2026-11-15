#!/usr/bin/env -S npx tsx
/**
 * Shared vectors for org servers, the org key ring and its rotations, and the signed audit export
 * (packages/protocol/src/orgServers.ts, orgKeyRing.ts, orgAudit.ts; docs/enterprise-accounts.md
 * "Org servers", §8, §11). Built on the org-authority vectors' keys and chain (v0, v1) and their
 * seat book "a member leaves; an admin offboards the scoped admin". TypeScript generates them;
 * packages/protocol/tests/orgServersVectors.test.ts checks them.
 *
 * Run:          npx tsx tools/org-servers-vectors.ts
 * CI freshness: npx tsx tools/org-servers-vectors.ts --check
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  buildOrgSeatBook,
  canonicalOrgSeatGrant,
  canonicalOrgSeatRevoke,
  orgAuthorityHash,
  orgSha256Hex,
  signOrgApproval,
  verifyOrgAuthorityChain,
  type OrgApproval,
  type OrgSeatGrantBundle,
  type OrgSeatRevokeBundle,
} from "../packages/protocol/src/orgAuthority.js";
import {
  canonicalOrgServerCode,
  canonicalOrgServerRegister,
  orgServerCodeSha256,
  signOrgServerRegister,
  type OrgServerCode,
} from "../packages/protocol/src/orgServers.js";
import {
  buildOrgKeyRing,
  canonicalOrgBoxKem,
  canonicalOrgKeyRing,
  canonicalOrgSeatKem,
  deriveOrgSeatKemSeed,
  orgKemKeyPair,
  orgKeyCommitment,
  signOrgBoxKem,
  signOrgSeatKem,
  type OrgKemKey,
  type OrgKeyRingBundle,
} from "../packages/protocol/src/orgKeyRing.js";
import { canonicalOrgAuditExport, orgLogEntryHash, signOrgAuditExport, ORG_LOG_GENESIS, type OrgAuditObjects, type OrgLogEntryWire } from "../packages/protocol/src/orgAudit.js";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, "packages/protocol/test-vectors/org-servers/vectors.json");
const V = JSON.parse(readFileSync(resolve(ROOT, "packages/protocol/test-vectors/org-authority/vectors.json"), "utf8"));
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const utf8 = (b: Uint8Array): string => new TextDecoder().decode(b);
const fill = (n: number, v: number): Uint8Array => new Uint8Array(n).fill(v);

const resolveRefs = (v: unknown): any => {
  if (Array.isArray(v)) return v.map(resolveRefs);
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (typeof o.$key === "string") return V.keys[o.$key].binding;
  if (typeof o.$approval === "number") return V.approvals[o.$approval];
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolveRefs(x)]));
};

const ORG: string = V.orgId;
const GENESIS: string = V.genesisHash;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const chain = resolveRefs(V.chains[0]);
const entries = chain.entries.slice(0, 2);
const T1: number = entries[1].record.issuedAt;
const SERVER = "home.acme.flagship.services";
const OTHER = "other.acme.flagship.services";

interface Key {
  seatId: string;
  keyId: string;
  secret: Uint8Array;
}
const key = (name: string): Key => {
  const k = V.keys[name];
  return { seatId: k.seatId, keyId: k.keyId, secret: Uint8Array.from(Buffer.from(k.edSeedHex + k.mldsaSeedHex, "hex")) };
};
const A = key("A founder");
const B = key("B admin");
const S = key("S scoped admin");
const SM = key("S member");
const MM = key("M member");
const X = key("X outsider");

const approve = (k: Key, order: Uint8Array, oarVersion: number, issuedAt: number): OrgApproval =>
  signOrgApproval({ orgId: ORG, oarVersion, order, seatId: k.seatId, adminKeyId: k.keyId, issuedAt, notAfter: issuedAt + DAY }, k.secret, { deterministic: true });
const no = (code: string) => ({ ok: false, code });

// ── seats: M (member) and S (server admin of SERVER, app admin of acme--wiki), S later offboarded ──
const book3 = resolveRefs(V.seatBooks[0]);
const grants: OrgSeatGrantBundle[] = book3.grants;
const grantS = grants.find((g) => g.grant.seatId === S.seatId)!;
const grantM = grants.find((g) => g.grant.seatId === MM.seatId)!;
const AT = T1 + 4 * HOUR;
const revokeS: OrgSeatRevokeBundle = (() => {
  const revoke = { orgId: ORG, seatId: S.seatId, reason: "offboarded", oarVersion: 1, issuedAt: AT + 2 * HOUR };
  return { revoke, approvals: [approve(A, canonicalOrgSeatRevoke(revoke), 1, revoke.issuedAt)] };
})();
void canonicalOrgSeatGrant;

// ── server codes ─────────────────────────────────────────────────────────
const code: OrgServerCode = {
  orgId: ORG,
  genesisHash: GENESIS,
  serial: "orgsrv-0001-abcd",
  serverName: "home",
  serverDomain: SERVER,
  delegatedPubKeyHex: "d1".repeat(32),
  issuedAt: AT,
  expiresAt: AT + 12 * HOUR,
};
const codeOrder = canonicalOrgServerCode(code);
const otherGenesis = { ...code, genesisHash: "ee".repeat(32) };
const grantAddRoles = [{ role: "servers-add" }];
const serverCodes = [
  { name: "one org admin adds a server", code, approvals: [approve(B, codeOrder, 1, AT)], now: AT + MIN, expect: { ok: true, scopedSeat: null } },
  { name: "a server admin without servers-add", code, approvals: [approve(S, codeOrder, 1, AT)], now: AT + MIN, expect: no("scope") },
  { name: "an outsider", code, approvals: [approve(X, codeOrder, 1, AT)], now: AT + MIN, expect: no("unknown-signer") },
  { name: "a code naming another genesis", code: otherGenesis, approvals: [approve(B, canonicalOrgServerCode(otherGenesis), 1, AT)], now: AT + MIN, expect: no("wrong-org") },
  { name: "a code past its end", code, approvals: [approve(B, codeOrder, 1, AT)], now: code.expiresAt + 1, expect: no("expired") },
  { name: "an approval of another code", code, approvals: [approve(B, canonicalOrgServerCode({ ...code, serial: "orgsrv-0002-abcd" }), 1, AT)], now: AT + MIN, expect: no("order-mismatch") },
];
void grantAddRoles;

const stkSeed = fill(32, 0x5e);
const stkPub = hex(ed25519.getPublicKey(stkSeed));
const register = { orgId: ORG, serial: code.serial, serverDomain: SERVER, codeSha256: orgServerCodeSha256(code), serverIdentityPubKeyHex: stkPub, issuedAt: AT + 30 * MIN, nonceHex: "ab".repeat(16) };
const registerSig = signOrgServerRegister(register, stkSeed);

// ── KEM keys ─────────────────────────────────────────────────────────────
const umk = fill(32, 0x42);
const seatKemSeed = deriveOrgSeatKemSeed(umk, ORG);
const kemA = orgKemKeyPair(fill(32, 0x31));
const kemB = orgKemKeyPair(fill(32, 0x32));
const kemS = orgKemKeyPair(fill(32, 0x33));
const kemM = orgKemKeyPair(fill(32, 0x34));
const kemBox = orgKemKeyPair(fill(32, 0x35));
const seatKem = (k: Key, signer: Key, kp: ReturnType<typeof orgKemKeyPair>) => {
  const statement = { orgId: ORG, seatId: k.seatId, kemKeyId: kp.kemKeyId, issuedAt: AT };
  return { statement, kemPubHex: hex(kp.kemPub), signature: signOrgSeatKem(statement, signer.secret, { deterministic: true }) };
};
const seatKems = [seatKem(A, A, kemA), seatKem(B, B, kemB), seatKem(S, SM, kemS), seatKem(MM, MM, kemM)];
const boxKemStatement = { orgId: ORG, serverDomain: SERVER, kemKeyId: kemBox.kemKeyId, issuedAt: AT };
const boxKems = [{ statement: boxKemStatement, kemPubHex: hex(kemBox.kemPub), signature: signOrgBoxKem(boxKemStatement, stkSeed) }];
const kk = (recipient: string, kp: ReturnType<typeof orgKemKeyPair>): OrgKemKey => ({ recipient, kemPub: kp.kemPub, kemKeyId: kp.kemKeyId, issuedAt: AT });

// ── key ring: archive keys of SERVER, rotated after S left ───────────────
const rnd = (base: number) => (i: number) => fill(64, base + i);
const archiveKey1 = fill(32, 0x71);
const archiveKey2 = fill(32, 0x72);
const r1 = buildOrgKeyRing({
  orgId: ORG, kind: "archive-keys", scope: SERVER, prev: null, key: archiveKey1,
  recipients: [kk(`seat:${A.seatId}`, kemA), kk(`seat:${S.seatId}`, kemS), kk(`box:${SERVER}`, kemBox)],
  retired: [], oarVersion: 1, issuedAt: AT + HOUR, randomness: rnd(0x10),
});
const ring1: OrgKeyRingBundle = { ...r1, approvals: [approve(A, canonicalOrgKeyRing(r1.ring), 1, AT + HOUR)] };
const LEFT = revokeS.revoke.issuedAt;
const r2 = buildOrgKeyRing({
  orgId: ORG, kind: "archive-keys", scope: SERVER, prev: r1.ring, key: archiveKey2,
  recipients: [kk(`seat:${A.seatId}`, kemA), kk(`box:${SERVER}`, kemBox)],
  retired: [S.seatId], oarVersion: 1, issuedAt: LEFT + HOUR, randomness: rnd(0x20),
});
const ring2: OrgKeyRingBundle = { ...r2, approvals: [approve(B, canonicalOrgKeyRing(r2.ring), 1, LEFT + HOUR)] };
const r2bad = buildOrgKeyRing({
  orgId: ORG, kind: "archive-keys", scope: SERVER, prev: r1.ring, key: archiveKey2,
  recipients: [kk(`seat:${A.seatId}`, kemA), kk(`seat:${S.seatId}`, kemS)],
  retired: [S.seatId], oarVersion: 1, issuedAt: LEFT + HOUR, randomness: rnd(0x30),
});
const ring2RetiredRecipient: OrgKeyRingBundle = { ...r2bad, approvals: [approve(B, canonicalOrgKeyRing(r2bad.ring), 1, LEFT + HOUR)] };
const rCgkMember = buildOrgKeyRing({
  orgId: ORG, kind: "cgk", scope: "*", prev: null, key: fill(32, 0x73),
  recipients: [kk(`seat:${A.seatId}`, kemA), kk(`seat:${MM.seatId}`, kemM)],
  retired: [], oarVersion: 1, issuedAt: AT + HOUR, randomness: rnd(0x40),
});
const ringCgkMember: OrgKeyRingBundle = { ...rCgkMember, approvals: [approve(A, canonicalOrgKeyRing(rCgkMember.ring), 1, AT + HOUR)] };
const rOtherScope = buildOrgKeyRing({
  orgId: ORG, kind: "archive-keys", scope: OTHER, prev: null, key: fill(32, 0x74),
  recipients: [kk(`seat:${A.seatId}`, kemA)],
  retired: [], oarVersion: 1, issuedAt: AT + HOUR, randomness: rnd(0x50),
});
const ringOtherByS: OrgKeyRingBundle = { ...rOtherScope, approvals: [approve(S, canonicalOrgKeyRing(rOtherScope.ring), 1, AT + HOUR)] };
const ringServerByS: OrgKeyRingBundle = { ...r1, approvals: [approve(S, canonicalOrgKeyRing(r1.ring), 1, AT + HOUR)] };

/**
 * keyRings cases: each runs verifyOrgKeyRing(ctx, bundle, prev, {fresh}) where ctx is the state of
 * v0..v1, the seat book of grants [M, S] plus `revokes`, the KEM keys above (seatKems, boxKems),
 * servers [SERVER, OTHER], at `now`.
 */
const keyRings = [
  { name: "archive keys v1 for an org admin, the server's admin and the box", bundle: ring1, prev: null, revokes: [], fresh: true, now: AT + HOUR + MIN, expect: { ok: true } },
  { name: "the server's admin approves its server's ring alone", bundle: ringServerByS, prev: null, revokes: [], fresh: true, now: AT + HOUR + MIN, expect: { ok: true } },
  { name: "the server's admin on another server's ring", bundle: ringOtherByS, prev: null, revokes: [], fresh: true, now: AT + HOUR + MIN, expect: no("scope") },
  { name: "v2 after S left leaves S out", bundle: ring2, prev: ring1.ring, revokes: [revokeS], fresh: true, now: LEFT + HOUR + MIN, expect: { ok: true } },
  { name: "v2 that still seals to the retired seat", bundle: ring2RetiredRecipient, prev: ring1.ring, revokes: [revokeS], fresh: true, now: LEFT + HOUR + MIN, expect: no("scope") },
  { name: "v2 retiring a seat that has not left", bundle: ring2, prev: ring1.ring, revokes: [], fresh: true, now: LEFT + HOUR + MIN, expect: no("scope") },
  { name: "v2 against another previous version", bundle: ring2, prev: { ...ring1.ring, keyCommitment: "00".repeat(32) }, revokes: [revokeS], fresh: true, now: LEFT + HOUR + MIN, expect: no("prev-hash") },
  { name: "a member seat may not hold the CGK", bundle: ringCgkMember, prev: null, revokes: [], fresh: true, now: AT + HOUR + MIN, expect: no("scope") },
  { name: "stored v1 still verifies after S left and its approval ran out", bundle: ring1, prev: null, revokes: [revokeS], fresh: false, now: AT + 30 * DAY, expect: { ok: true } },
];

/** orgRotationDone(rings of [ring1, ring2] or [ring1], kind, scope, seat, leftAt). */
const rotations = [
  { name: "after v2, S's departure is answered for the server's archive keys", rings: [ring1, ring2], kind: "archive-keys", scope: SERVER, seatId: S.seatId, leftAt: LEFT, now: LEFT + 2 * HOUR, expect: true },
  { name: "before v2, it is not", rings: [ring1], kind: "archive-keys", scope: SERVER, seatId: S.seatId, leftAt: LEFT, now: LEFT + 2 * HOUR, expect: false },
  { name: "another server's archive keys are not this one's", rings: [ring1, ring2], kind: "archive-keys", scope: OTHER, seatId: S.seatId, leftAt: LEFT, now: LEFT + 2 * HOUR, expect: false },
];

// ── audit export ─────────────────────────────────────────────────────────
const logRefs: Array<[string, string, number]> = [
  ["authority", orgAuthorityHash(entries[0].record), entries[0].record.issuedAt],
  ["authority-direct", orgAuthorityHash(entries[1].record), T1],
  ["grant", orgSha256Hex(canonicalOrgSeatGrant(grantM.grant)), grantM.grant.issuedAt],
  ["grant", orgSha256Hex(canonicalOrgSeatGrant(grantS.grant)), grantS.grant.issuedAt],
  ["server-code", orgServerCodeSha256(code), AT],
  ["key-ring", orgSha256Hex(canonicalOrgKeyRing(ring1.ring)), AT + HOUR],
  ["revoke", orgSha256Hex(canonicalOrgSeatRevoke(revokeS.revoke)), LEFT],
  ["key-ring", orgSha256Hex(canonicalOrgKeyRing(ring2.ring)), LEFT + HOUR],
];
const log: OrgLogEntryWire[] = [];
let prev = ORG_LOG_GENESIS;
logRefs.forEach(([kind, ref, at], i) => {
  const entryHash = orgLogEntryHash(ORG, i + 1, prev, kind, ref, at);
  log.push({ seq: i + 1, prevHash: prev, entryHash, kind, refSha256: ref, at });
  prev = entryHash;
});
const objects: OrgAuditObjects = {
  orgId: ORG,
  genesisHash: GENESIS,
  entries,
  freezes: [],
  overturns: [],
  vetoes: [],
  grants: [grantM, grantS],
  revokes: [revokeS],
  keyRings: [ring1, ring2],
  serverCodes: [{ code, approvals: serverCodes[0]!.approvals }],
  log,
};
const EXPORT_AT = LEFT + 2 * HOUR;
const state = verifyOrgAuthorityChain(entries, { genesisHash: GENESIS, now: EXPORT_AT });
void buildOrgSeatBook;
const exported = signOrgAuditExport(objects, state, { seatId: A.seatId, adminKeyId: A.keyId, hybridSecret: A.secret }, EXPORT_AT, { deterministic: true });
/** audit.cases apply `patch` to audit.export: log[index].at += atDelta; a copy of grants[from] with issuedAt += delta appended; or another approval. */
const audit = {
  export: exported,
  cases: [
    { name: "the export verifies offline", patch: null, now: EXPORT_AT + DAY * 90, expect: { ok: true, signedBy: A.seatId, logEntries: log.length, unlogged: 0 } },
    { name: "a log entry changed after signing", patch: { log: { index: 3, atDelta: 1 } }, now: EXPORT_AT + MIN, expect: no("order-mismatch") },
    { name: "an object the log never named", patch: { extraGrant: { from: 0, issuedAtDelta: 1 } }, now: EXPORT_AT + MIN, expect: { ok: true, signedBy: A.seatId, logEntries: log.length, unlogged: 1 } },
    { name: "signed by an outsider", patch: { approval: approve(X, canonicalOrgAuditExport(exported.statement), 1, EXPORT_AT) }, now: EXPORT_AT + MIN, expect: no("unknown-signer") },
  ],
};

const canonical = [
  { name: "server code", bytes: utf8(codeOrder) },
  { name: "server register", bytes: utf8(canonicalOrgServerRegister(register)) },
  { name: "seat kem", bytes: utf8(canonicalOrgSeatKem(seatKems[0]!.statement)) },
  { name: "box kem", bytes: utf8(canonicalOrgBoxKem(boxKemStatement)) },
  { name: "key ring v2", bytes: utf8(canonicalOrgKeyRing(ring2.ring)) },
  { name: "audit export", bytes: utf8(canonicalOrgAuditExport(exported.statement)) },
].map((c) => ({ ...c, sha256: orgSha256Hex(new TextEncoder().encode(c.bytes)) }));

const doc = {
  description:
    "Org servers, the org key ring and the audit export (docs/enterprise-accounts.md). Uses org-authority/vectors.json: its keys, chains[0].entries[0..1] (v0, v1) and seatBooks[0]'s grants [M, S]. serverCodes: verifyOrgServerCode(state, book, code, approvals, now). register: verifyOrgServerRegister(request, signature) with an Ed25519 STK from seed 5e*32. kems: verifyOrgSeatKem / verifyOrgBoxKem (STK above). keyRings: verifyOrgKeyRing(ctx, bundle, prev, {fresh}) with ctx = state, seat book (grants [M, S] + revokes), newest KEM keys, servers [home, other] at now. rotations: orgRotationDone over buildOrgKeyRings(ctx with revokes [revokeS]). opens: openOrgKeyRing(ring, recipient, X-Wing secret from kemSeedHex) returns keyHex. audit: verifyOrgAuditExport(export, {genesisHash, now}).",
  orgId: ORG,
  genesisHash: GENESIS,
  servers: [SERVER, OTHER],
  revokeS,
  canonical,
  serverCodes,
  register: { request: register, signature: registerSig, stkSeedHex: hex(stkSeed), flipped: registerSig.slice(0, 127) + (registerSig[127] === "0" ? "1" : "0") },
  seatKemSeed: { umkHex: hex(umk), seedHex: hex(seatKemSeed), kemKeyId: orgKemKeyPair(seatKemSeed).kemKeyId },
  kems: { seat: seatKems, box: boxKems },
  keyRings,
  rotations,
  opens: [
    { name: "the box opens archive keys v2", ring: ring2, recipient: `box:${SERVER}`, kemSeedHex: hex(fill(32, 0x35)), keyHex: hex(archiveKey2), commitment: orgKeyCommitment(ORG, "archive-keys", SERVER, 2, archiveKey2) },
    { name: "S cannot open v2", ring: ring2, recipient: `seat:${S.seatId}`, kemSeedHex: hex(fill(32, 0x33)), error: "seat-unknown" },
    { name: "S opens v1", ring: ring1, recipient: `seat:${S.seatId}`, kemSeedHex: hex(fill(32, 0x33)), keyHex: hex(archiveKey1) },
  ],
  audit,
};

const json = JSON.stringify(doc, null, 1) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== json) {
    console.error("org-servers vectors are stale: run npx tsx tools/org-servers-vectors.ts");
    process.exit(1);
  }
  console.log("org-servers vectors are fresh");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
  console.log(`wrote ${OUT}`);
}
