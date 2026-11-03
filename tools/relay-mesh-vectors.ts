#!/usr/bin/env -S npx tsx
/**
 * Writes packages/protocol/test-vectors/relay-mesh/vectors.json from the TypeScript implementation
 * (packages/protocol/src/relayMesh.ts, docs/architecture-v2/relay-mesh.md): every record's canonical bytes and
 * signature, records every port must refuse, the relay log applied in order and with gaps, forgeries and malformed
 * rows, and every check with an accepting case and one case per refusal. The Rust twin
 * (rust/crates/flagship-crypto/tests/relay_mesh_vectors.rs) must agree byte for byte.
 *
 *   npx tsx tools/relay-mesh-vectors.ts          write
 *   npx tsx tools/relay-mesh-vectors.ts --check  fail when the file is stale
 *
 * Every negative case names the refusal it is meant to hit (`want`); the generator stops if the TypeScript answer
 * differs, so a vector can never silently turn into an accepting one.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sha256 } from "@noble/hashes/sha256";
import * as P from "../packages/protocol/src/index.js";
import * as M from "../packages/protocol/src/relayMesh.js";
import type {
  AccountMove,
  AttachmentItem,
  BoxAttachment,
  MeshAuth,
  MeshCheckContext,
  MoveHint,
  MoveHintRateState,
  PhoneItem,
  PhoneRouteGrant,
  RelayBlessing,
  RelayBlessingBody,
  RelayDirectory,
  RelayDirectoryEntry,
  RelayLogBody,
  RelayLogEntry,
  RelayLogHead,
  RelayLogState,
  RelayWithdraw,
  SignedRelayLogEntry,
} from "../packages/protocol/src/index.js";

const out = resolve(import.meta.dirname, "../packages/protocol/test-vectors/relay-mesh/vectors.json");
const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");
const td = new TextDecoder();

type Key = { name: string; seed: string; pub: string; sign: (m: Uint8Array) => Uint8Array; kp: { publicKey: Uint8Array; privateKey: Uint8Array } };
const keys: Record<string, Key> = {};
const key = (name: string, n: number): Key => {
  const seed = new Uint8Array(32).fill(n);
  const pub = P.ed.getPublicKey(seed);
  const k = { name, seed: hexOf(seed), pub: hexOf(pub), sign: (m: Uint8Array) => P.ed.sign(m, seed), kp: { publicKey: pub, privateKey: seed } };
  keys[name] = k;
  return k;
};

const APEX = "flagship.services";
const T0 = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const ca = key("ca", 1);
const ca2 = key("ca2", 2);
const logKey = key("log", 3);
const otherLog = key("otherLog", 4);
const iad1 = key("iad1", 11);
const ams1 = key("ams1", 12);
const ent1 = key("ent1", 13);
const old1 = key("old1", 14);
const rog1 = key("rog1", 15);
const fra1 = key("fra1", 16);
const sin1 = key("sin1", 17);
const boxHome = key("boxHome", 21);
const boxCabin = key("boxCabin", 22);
const boxOld = key("boxOld", 23);
const boxLab = key("boxLab", 24);
const boxLab2 = key("boxLab2", 25);
const phone = key("phone", 31);
const admin = key("admin", 41);
const irk = key("irk", 42);
const admin2 = key("admin2", 43);
const relayKeys: Record<string, Key> = { iad1, ams1, ent1, old1, rog1, fra1, sin1 };
const CA_KEYS = [ca.pub];

/** Assert the TS answer is the intended one, then return it. */
function want<T>(name: string, got: T, expected: unknown): T {
  const reason = (got as { reason?: unknown })?.reason;
  const asText = typeof got === "object" && got !== null && "ok" in got ? ((got as { ok: boolean }).ok ? "ok" : reason) : got;
  if (JSON.stringify(asText) !== JSON.stringify(expected)) throw new Error(`${name}: TS answered ${JSON.stringify(got)}, the vector wants ${JSON.stringify(expected)}`);
  return got;
}

// ── hashes ────────────────────────────────────────────────────────────────

const hashCase = (fn: (s: string) => string, input: string) => {
  try {
    return { input, output: fn(input) };
  } catch {
    return { input, throws: true };
  }
};
const hashes = {
  nameHash: ["home.alice.flagship.services", "HOME.Alice.Flagship.Services", "alice.flagship.services", "", "a|b.flagship.services", "a b.flagship.services", "é.flagship.services", "x".repeat(253), "x".repeat(254)].map((s) => hashCase(P.nameHash, s)),
  accountHash: ["alice", "bob", "a1-b2", "Alice", "-bad", "", "a.b"].map((s) => hashCase(P.accountHash, s)),
};

// ── blessings and the directory ───────────────────────────────────────────

const blessingBody = (relayId: string, relayKind: "full" | "entry", over: Partial<RelayBlessingBody> = {}): RelayBlessingBody => ({
  relayId,
  relayKey: relayKeys[relayId]!.pub,
  servicesApex: APEX,
  tunnelHost: P.relayTunnelHost(relayId, APEX),
  relayKind,
  nonce: hexOf(sha256(new TextEncoder().encode(relayId))).slice(0, 32),
  issuedAt: T0 - HOUR,
  expiresAt: T0 + 25 * HOUR,
  ...over,
});
const B: Record<string, RelayBlessing> = {
  iad1: P.signRelayBlessing(blessingBody("iad1", "full"), ca.kp),
  ams1: P.signRelayBlessing(blessingBody("ams1", "full"), ca.kp),
  ent1: P.signRelayBlessing(blessingBody("ent1", "entry"), ca.kp),
  old1: P.signRelayBlessing(blessingBody("old1", "full"), ca.kp),
  rog1: P.signRelayBlessing(blessingBody("rog1", "full"), ca.kp),
};
const amsExpired = P.signRelayBlessing(blessingBody("ams1", "full", { issuedAt: T0 - 27 * HOUR, expiresAt: T0 - HOUR }), ca.kp);
const amsByCa2 = P.signRelayBlessing(blessingBody("ams1", "full"), ca2.kp);

const entry = (relayId: string, relayKind: "full" | "entry", region: string, ipv4: string[], ipv6: string[]): RelayDirectoryEntry => ({
  relayId,
  relayKey: relayKeys[relayId]!.pub,
  tunnelHost: P.relayTunnelHost(relayId, APEX),
  relayKind,
  region,
  ipv4,
  ipv6,
});
const relays: RelayDirectoryEntry[] = [
  entry("iad1", "full", "iad", ["149.248.216.86"], ["2a09:8280:1::110:d2b6:0"]),
  entry("ams1", "full", "ams", [], ["2a09:8280:1::2"]),
  entry("ent1", "entry", "fra", ["203.0.113.7", "198.51.100.2"], []),
  entry("old1", "full", "iad", ["192.0.2.1"], []),
  entry("fra1", "full", "fra", ["192.0.2.16"], []),
  entry("sin1", "full", "sin", ["192.0.2.17"], []),
];
const dirBody = { servicesApex: APEX, directoryVersion: 3, issuedAt: T0 - HOUR, expiresAt: T0 - HOUR + P.DIRECTORY_TTL_MS, relays };
const D: RelayDirectory = P.signRelayDirectory(dirBody, ca.kp);

// ── the log ───────────────────────────────────────────────────────────────

const name = (s: string, u = "alice") => `${s}.${u}.${APEX}`;
const policy7 = { account: "alice", box: boxHome.pub, regGen: 1, policyGen: 1, grace: "7d", onLapse: "stop-apps", scopeSha256: "11".repeat(32), issuedAt: T0 - DAY } as const;
const policySha = hexOf(sha256(P.canonicalServingPolicy(policy7)));
const renewalPub = "02" + "ab".repeat(32);
const grantId = "cd".repeat(32);
const certId = "ef".repeat(32);
const bodies: RelayLogBody[] = [
  { kind: "account-authority", accountHash: P.accountHash("alice"), adminRootPub: admin.pub, irkPub: irk.pub, authorityGen: 1 },
  { kind: "box-register", nameHash: P.nameHash(name("home")), boxPub: boxHome.pub, regGen: 1 },
  { kind: "box-register", nameHash: P.nameHash(name("cabin")), boxPub: boxCabin.pub, regGen: 1 },
  { kind: "policy-head", boxPub: boxHome.pub, regGen: 1, policyGen: 1, policySha256: policySha },
  { kind: "box-register", nameHash: P.nameHash(name("old")), boxPub: boxOld.pub, regGen: 1 },
  { kind: "box-revoke", boxPub: boxOld.pub, regGen: 1 },
  { kind: "relay-revoke", relayId: "old1", relayKey: old1.pub },
  { kind: "renewal-key-revoke", renewalPub },
  { kind: "device-grant-revoke", grantId, devicePub: phone.pub },
  { kind: "cert-revoke", accountHash: P.accountHash("alice"), certId },
  { kind: "box-register", nameHash: P.nameHash(name("lab")), boxPub: boxLab.pub, regGen: 1 },
  { kind: "box-register", nameHash: P.nameHash(name("lab")), boxPub: boxLab2.pub, regGen: 2 },
  { kind: "account-authority", accountHash: P.accountHash("alice"), adminRootPub: admin2.pub, irkPub: irk.pub, authorityGen: 2 },
  { kind: "account-authority", accountHash: P.accountHash("alice"), adminRootPub: admin.pub, irkPub: irk.pub, authorityGen: 1 },
  { kind: "account-authority", accountHash: P.accountHash("bob"), adminRootPub: null, irkPub: irk.pub, authorityGen: 1 },
  { kind: "policy-head", boxPub: boxCabin.pub, regGen: 1, policyGen: 2, policySha256: "22".repeat(32) },
  { kind: "policy-head", boxPub: boxCabin.pub, regGen: 1, policyGen: 1, policySha256: "33".repeat(32) },
];
const signEntry = (e: RelayLogEntry, k = logKey, apex = APEX): SignedRelayLogEntry => ({ entry: e, signature: P.signRelayLogEntry(apex, e, k.sign) });
const entries: SignedRelayLogEntry[] = bodies.map((b, i) => signEntry(P.makeRelayLogEntry(i + 1, T0 - DAY + i * MIN, b)));
const at = (i: number) => entries[i - 1]!;

const summary = (s: RelayLogState) => ({
  sequence: s.sequence,
  tipSha256: s.tipSha256,
  boxesByName: Object.fromEntries([...s.boxesByName].sort()),
  boxNames: Object.fromEntries([...s.boxNames].sort()),
  revokedBoxes: Object.fromEntries([...s.revokedBoxes].sort()),
  authorities: Object.fromEntries([...s.authorities].sort()),
  policyHeads: Object.fromEntries([...s.policyHeads].sort()),
  revokedRenewalKeys: [...s.revokedRenewalKeys].sort(),
  revokedGrants: Object.fromEntries([...s.revokedGrants].sort()),
  revokedCerts: [...s.revokedCerts].sort(),
  revokedRelays: Object.fromEntries([...s.revokedRelays].sort()),
});
const applyOut = (r: P.RelayLogApply) => (r.ok ? { ok: true, applied: r.applied, state: summary(r.state) } : { ok: false, reason: r.reason, at: r.at, applied: r.applied, state: summary(r.state) });

const empty = P.emptyRelayLogState(APEX);
const full = P.applyRelayLog(empty, entries, logKey.pub);
if (!full.ok) throw new Error("the full log must apply");
const LOG = full.state;
const forged = { entry: at(3).entry, signature: P.signRelayLogEntry(APEX, at(3).entry, otherLog.sign) };
const otherApex = signEntry(at(3).entry, logKey, "gym.flagship.services");
const malformedKind = { entry: { ...at(3).entry, kind: "box-explode" as never }, signature: at(3).signature };
const malformedF4 = { entry: { ...at(6).entry, f4: "1" }, signature: at(6).signature };
const leadingZero = { entry: { ...at(2).entry, f3: "01" }, signature: at(2).signature };
const five = P.applyRelayLog(empty, entries.slice(0, 5), logKey.pub);
if (!five.ok) throw new Error("five");
const logCases = [
  ["all in order", empty, entries, "ok"],
  ["shuffled", empty, [...entries].reverse(), "ok"],
  ["duplicates skipped", empty, [...entries, at(1), at(2)], "ok"],
  ["from sequence 5", five.state, entries.slice(3), "ok"],
  ["gap", empty, [at(1), at(2), at(4)], "gap"],
  ["forged entry", empty, [at(1), at(2), forged], "bad-signature"],
  ["signed for another apex", empty, [at(1), at(2), otherApex], "bad-signature"],
  ["unknown kind", empty, [at(1), at(2), malformedKind], "malformed"],
  ["box-revoke with f4", empty, [at(1), at(2), at(3), at(4), at(5), malformedF4], "malformed"],
  ["leading zero regGen", empty, [at(1), leadingZero], "malformed"],
  ["sequence 0", empty, [{ entry: { ...at(1).entry, sequence: 0 }, signature: at(1).signature }], "malformed"],
  ["wrong log key", empty, [at(1)], "bad-signature", otherLog.pub],
] as const;
const log = {
  entries: entries.map((e) => ({ ...e, canonical: td.decode(P.canonicalRelayLogEntry(APEX, e.entry)), hash: P.relayLogEntryHash(APEX, e.entry) })),
  cases: logCases.map(([n, from, list, w, k]) => ({
    name: n,
    from: from === empty ? 0 : 5,
    /** A number n stands for `log.entries[n - 1]`. */
    entries: list.map((e) => {
      const i = entries.indexOf(e as SignedRelayLogEntry);
      return i >= 0 ? i + 1 : e;
    }),
    logKey: k ?? logKey.pub,
    expected: applyOut(want(n, P.applyRelayLog(from, list, k ?? logKey.pub), w)),
  })),
  makeErrors: [
    { kind: "box-register", nameHash: "zz", boxPub: boxHome.pub, regGen: 1 },
    { kind: "box-revoke", boxPub: boxHome.pub, regGen: 0 },
    { kind: "renewal-key-revoke", renewalPub: "04" + "ab".repeat(32) },
    { kind: "relay-revoke", relayId: "1bad", relayKey: old1.pub },
  ].map((b) => {
    try {
      P.makeRelayLogEntry(1, T0, b as RelayLogBody);
      throw new Error("must throw");
    } catch (e) {
      if ((e as Error).message === "must throw") throw e;
      return { sequence: 1, at: T0, body: b };
    }
  }),
  finalState: summary(LOG),
  adminKeys: { alice: P.relayLogAdminKey(LOG, "alice"), bob: P.relayLogAdminKey(LOG, "bob"), carol: P.relayLogAdminKey(LOG, "carol") },
};

// heads
const headOf = (h: Partial<RelayLogHead>): RelayLogHead => ({ servicesApex: APEX, sequence: LOG.sequence, tipSha256: LOG.tipSha256, directoryVersion: 3, issuedAt: T0 - 10_000, ...h });
const signHead = (h: RelayLogHead, k = logKey) => ({ head: h, signature: P.signRelayMeshRecord("relay-log-head", h, k.sign) });
const goodHead = signHead(headOf({}));
const heads = {
  verify: [
    ["ok", goodHead, APEX, "ok"],
    ["wrong apex", signHead(headOf({ servicesApex: "gym.flagship.services" })), APEX, "wrong-apex"],
    ["other key", signHead(headOf({}), otherLog), APEX, "bad-signature"],
    ["zero sequence needs zero tip", { head: headOf({ sequence: 0 }), signature: goodHead.signature }, APEX, "malformed"],
    ["tampered", { head: headOf({ directoryVersion: 4 }), signature: goodHead.signature }, APEX, "bad-signature"],
  ].map(([n, h, apex, w]) => ({ name: n, signed: h, apex, expected: want(n as string, P.verifyRelayLogHead(h as never, logKey.pub, apex as string), w) })),
  status: [
    ["applied at tip", headOf({}), "applied"],
    ["applied behind tip", headOf({ sequence: 5, tipSha256: at(5).entry ? P.relayLogEntryHash(APEX, at(5).entry) : "" }), "applied"],
    ["behind", headOf({ sequence: LOG.sequence + 1, tipSha256: "44".repeat(32) }), "behind"],
    ["fork", headOf({ sequence: 5, tipSha256: "44".repeat(32) }), "fork"],
    ["zero", headOf({ sequence: 0, tipSha256: P.RELAY_LOG_ZERO_TIP }), "applied"],
  ].map(([n, h, w]) => ({ name: n, head: h, expected: want(n as string, P.relayLogHeadStatus(LOG, h as RelayLogHead), w) })),
  unknownWithShortHistory: (() => {
    // a state that forgot old tips: build one 1,030 entries long is costly; drop the history instead.
    const s = { ...LOG, recentTips: new Map([[LOG.sequence, LOG.tipSha256]]) };
    return { head: headOf({ sequence: 2, tipSha256: P.relayLogEntryHash(APEX, at(2).entry) }), expected: want("unknown", P.relayLogHeadStatus(s, headOf({ sequence: 2, tipSha256: P.relayLogEntryHash(APEX, at(2).entry) })), "unknown") };
  })(),
  fresh: [
    ["fresh", headOf({ issuedAt: T0 - 60_000 }), T0, true],
    ["too old", headOf({ issuedAt: T0 - 60_001 }), T0, false],
    ["fork is not fresh", headOf({ sequence: 5, tipSha256: "44".repeat(32) }), T0, false],
    ["no head", null, T0, false],
  ].map(([n, h, now, w]) => ({ name: n, head: h, now, expected: want(n as string, P.relayLogFresh(LOG, h as RelayLogHead | null, now as number), w) })),
  newer: [
    ["later issuedAt", headOf({ issuedAt: 1 }), headOf({ issuedAt: 2, sequence: 1, tipSha256: "55".repeat(32) }), true],
    ["same time higher sequence", headOf({ issuedAt: 2, sequence: 1, tipSha256: "55".repeat(32) }), headOf({ issuedAt: 2 }), true],
    ["older", headOf({ issuedAt: 3 }), headOf({ issuedAt: 2 }), false],
    ["none held", null, headOf({}), true],
  ].map(([n, a, b, w]) => ({ name: n, current: a, candidate: b, expected: want(n as string, P.newerRelayLogHead(a as RelayLogHead | null, b as RelayLogHead), w) })),
};

// ── records: canonical bytes and signatures ───────────────────────────────

const homeAtt: BoxAttachment = { serverFqdn: name("home"), boxPub: boxHome.pub, regGen: 1, relayId: "iad1", attachedAt: T0 - 5 * MIN, issuedAt: T0 - MIN, notAfter: T0 + 29 * MIN };
const legacyAtt: BoxAttachment = { serverFqdn: name("cabin"), boxPub: boxCabin.pub, regGen: 1, relayId: "iad1", attachedAt: T0 - 5 * MIN, issuedAt: T0 - MIN, notAfter: T0 + 2 * MIN };
const withdrawBox: RelayWithdraw = { subjectKind: "box", subject: name("home"), relayId: "iad1", withdrawnIssuedAt: T0 - MIN, at: T0 };
const NS = "aa".repeat(32);
const NC = "bb".repeat(32);
const bridge = { role: "client" as const, signerRelayId: "ams1", peerRelayId: "iad1", serverNonce: NS, clientNonce: NC, at: T0 };
const hint: MoveHint = { serverFqdn: name("home"), boxPub: boxHome.pub, fromRelayId: "iad1", toRelayId: "ams1", reason: "co-locate", issuedAt: T0 - MIN, notAfter: T0 + 9 * MIN };
const move: AccountMove = { accountHash: P.accountHash("alice"), fromRelayId: "iad1", toRelayId: "ams1", issuedAt: T0 - MIN, notAfter: T0 + 9 * MIN };
const grant: PhoneRouteGrant = { hostname: `alice.${APEX}`, phoneRoutePub: phone.pub, generation: 4, holderRelayId: "ams1", ledgerRelayId: "iad1", issuedAt: T0 - 10_000, notAfter: T0 + 50_000 };
const request = { relayId: "ams1", relayKey: ams1.pub, servicesApex: APEX, issuedAt: T0 };

const rec = (kind: P.RelayMeshRecordKind, record: unknown, signer: Key) => {
  const canonical = td.decode((P as unknown as Record<string, (r: unknown) => Uint8Array>)[CANON[kind]]!(record));
  const signature = P.signRelayMeshRecord(kind, record as never, signer.sign);
  if (!P.verifyRelayMeshRecord(kind, record as never, signature, signer.pub)) throw new Error(`${kind} does not verify`);
  return { kind, record, canonical, signer: signer.name, signature };
};
const CANON: Record<P.RelayMeshRecordKind, string> = {
  "relay-blessing-request": "canonicalRelayBlessingRequest",
  "relay-log-head": "canonicalRelayLogHead",
  "relay-attachment": "canonicalBoxAttachment",
  "relay-legacy-attachment": "canonicalLegacyAttachment",
  "relay-withdraw": "canonicalRelayWithdraw",
  "relay-bridge-auth": "canonicalBridgeAuth",
  "relay-move-hint": "canonicalMoveHint",
  "relay-account-move": "canonicalAccountMove",
  "phone-route-grant": "canonicalPhoneRouteGrant",
};
const records = [
  rec("relay-blessing-request", request, ams1),
  rec("relay-log-head", goodHead.head, logKey),
  rec("relay-attachment", homeAtt, boxHome),
  rec("relay-legacy-attachment", legacyAtt, iad1),
  rec("relay-withdraw", withdrawBox, iad1),
  rec("relay-withdraw", { subjectKind: "phone", subject: `alice.${APEX}`, relayId: "ams1", withdrawnIssuedAt: grant.issuedAt, at: T0 }, ams1),
  rec("relay-bridge-auth", bridge, ams1),
  rec("relay-bridge-auth", { ...bridge, role: "server", signerRelayId: "iad1", peerRelayId: "ams1" }, iad1),
  rec("relay-move-hint", hint, iad1),
  rec("relay-account-move", move, iad1),
  rec("phone-route-grant", grant, iad1),
];
const caRecords = {
  blessings: Object.entries(B).map(([id, b]) => ({ relayId: id, blessing: b, canonical: td.decode(P.canonicalRelayBlessing(b)) })),
  directory: {
    directory: D,
    lines: relays.map((r) => P.relayDirectoryEntryLine(r, APEX)),
    entriesSha256: P.relayDirectoryEntriesSha256(relays, APEX),
    canonical: td.decode(P.canonicalRelayDirectory(D)),
  },
};

/** Records every port must refuse to canonicalize. */
const canonicalErrors: Array<{ kind: string; name: string; record: unknown; apex?: string }> = [];
const refuse = (kind: string, n: string, record: unknown, apex?: string) => {
  const fns: Record<string, (r: never) => unknown> = {
    "relay-blessing": P.canonicalRelayBlessing,
    "relay-blessing-request": P.canonicalRelayBlessingRequest,
    "relay-directory": P.canonicalRelayDirectory,
    "relay-log": (r: never) => P.canonicalRelayLogEntry(apex ?? APEX, r),
    "relay-log-head": P.canonicalRelayLogHead,
    "relay-attachment": P.canonicalBoxAttachment,
    "relay-legacy-attachment": P.canonicalLegacyAttachment,
    "relay-withdraw": P.canonicalRelayWithdraw,
    "relay-bridge-auth": P.canonicalBridgeAuth,
    "relay-move-hint": P.canonicalMoveHint,
    "relay-account-move": P.canonicalAccountMove,
    "phone-route-grant": P.canonicalPhoneRouteGrant,
  };
  let threw = false;
  try {
    fns[kind]!(record as never);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(`${kind}/${n} must be refused`);
  canonicalErrors.push({ kind, name: n, record, ...(apex ? { apex } : {}) });
};
const bb = blessingBody("iad1", "full");
refuse("relay-blessing", "tunnel host not the relay's", { ...bb, tunnelHost: `iad2.tunnel.${APEX}` });
refuse("relay-blessing", "relay id starts with a digit", { ...bb, relayId: "1ad", tunnelHost: `1ad.tunnel.${APEX}` });
refuse("relay-blessing", "kind", { ...bb, relayKind: "half" });
refuse("relay-blessing", "short nonce", { ...bb, nonce: "ab" });
refuse("relay-blessing", "expires before issue", { ...bb, expiresAt: bb.issuedAt });
refuse("relay-blessing", "uppercase key", { ...bb, relayKey: bb.relayKey.toUpperCase() });
refuse("relay-blessing", "apex with a pipe", { ...bb, servicesApex: "a|b.services", tunnelHost: "iad1.tunnel.a|b.services" });
refuse("relay-blessing-request", "bad key", { ...request, relayKey: "00" });
refuse("relay-blessing-request", "apex one label", { ...request, servicesApex: "services" });
refuse("relay-directory", "version 0", { ...dirBody, directoryVersion: 0 });
refuse("relay-directory", "duplicate relay id", { ...dirBody, relays: [relays[0], relays[0]] });
refuse("relay-directory", "duplicate relay key", { ...dirBody, relays: [relays[0], { ...relays[1]!, relayKey: relays[0]!.relayKey }] });
refuse("relay-directory", "bad region", { ...dirBody, relays: [{ ...relays[0]!, region: "US East" }] });
refuse("relay-directory", "bad ipv4", { ...dirBody, relays: [{ ...relays[0]!, ipv4: ["010.0.0.1"] }] });
refuse("relay-directory", "ipv4 in ipv6 list", { ...dirBody, relays: [{ ...relays[0]!, ipv6: ["10.0.0.1"] }] });
refuse("relay-directory", "duplicate address", { ...dirBody, relays: [{ ...relays[0]!, ipv4: ["10.0.0.1", "10.0.0.1"] }] });
refuse("relay-directory", "tunnel host", { ...dirBody, relays: [{ ...relays[0]!, tunnelHost: `iad1.${APEX}` }] });
refuse("relay-log", "renewal key not P-256", { ...at(8).entry, f1: "04" + "ab".repeat(32) });
refuse("relay-log", "authority without irk", { ...at(1).entry, f3: "" });
refuse("relay-log", "decimal with sign", { ...at(2).entry, f3: "+1" });
refuse("relay-log", "decimal past safe", { ...at(2).entry, f3: "9007199254740992" });
refuse("relay-log", "bad apex", at(1).entry, "Flagship.Services");
refuse("relay-log-head", "zero sequence with a tip", { ...goodHead.head, sequence: 0 });
refuse("relay-log-head", "short tip", { ...goodHead.head, tipSha256: "00" });
refuse("relay-attachment", "attachedAt after issuedAt", { ...homeAtt, attachedAt: homeAtt.issuedAt + 1 });
refuse("relay-attachment", "notAfter not after issuedAt", { ...homeAtt, notAfter: homeAtt.issuedAt });
refuse("relay-attachment", "regGen 0", { ...homeAtt, regGen: 0 });
refuse("relay-attachment", "uppercase name", { ...homeAtt, serverFqdn: homeAtt.serverFqdn.toUpperCase() });
refuse("relay-attachment", "wildcard name", { ...homeAtt, serverFqdn: `*.${homeAtt.serverFqdn}` });
refuse("relay-attachment", "pipe in name", { ...homeAtt, serverFqdn: "a|b.alice.flagship.services" });
refuse("relay-legacy-attachment", "bad relay id", { ...legacyAtt, relayId: "I" });
refuse("relay-withdraw", "subject kind", { ...withdrawBox, subjectKind: "app" });
refuse("relay-withdraw", "empty subject", { ...withdrawBox, subject: "" });
refuse("relay-bridge-auth", "role", { ...bridge, role: "peer" });
refuse("relay-bridge-auth", "self as peer", { ...bridge, peerRelayId: "ams1" });
refuse("relay-bridge-auth", "16-byte nonce", { ...bridge, clientNonce: "bb".repeat(16) });
refuse("relay-move-hint", "reason", { ...hint, reason: "whim" });
refuse("relay-move-hint", "to itself", { ...hint, toRelayId: "iad1" });
refuse("relay-account-move", "account not hashed", { ...move, accountHash: "alice" });
refuse("relay-account-move", "to itself", { ...move, toRelayId: "iad1" });
refuse("phone-route-grant", "generation 0", { ...grant, generation: 0 });
refuse("phone-route-grant", "two-label host", { ...grant, hostname: "alice.services" });

// ── checks ────────────────────────────────────────────────────────────────

const ctx = (over: Partial<MeshCheckContext> = {}): MeshCheckContext => ({ servicesApex: APEX, log: LOG, directory: D, now: T0, ...over });

const blessingChecks = [
  ["ok", B.iad1, T0, APEX, CA_KEYS, "ok"],
  ["entry relay ok", B.ent1, T0, APEX, CA_KEYS, "ok"],
  ["issued within the skew", P.signRelayBlessing(blessingBody("ams1", "full", { issuedAt: T0 + 30_000 }), ca.kp), T0, APEX, CA_KEYS, "ok"],
  ["issued past the skew", P.signRelayBlessing(blessingBody("ams1", "full", { issuedAt: T0 + 61_000 }), ca.kp), T0, APEX, CA_KEYS, "artifact-expired"],
  ["expired", amsExpired, T0, APEX, CA_KEYS, "artifact-expired"],
  ["other apex", B.iad1, T0, "gym.flagship.services", CA_KEYS, "wrong-apex"],
  ["no CA keys", B.iad1, T0, APEX, [], "no-authorized-ca-keys"],
  ["unauthorized CA", amsByCa2, T0, APEX, CA_KEYS, "signature-unverified"],
  ["signedBy not among signatures", { ...amsByCa2, signedBy: ca.pub }, T0, APEX, [ca.pub, ca2.pub], "signature-unverified"],
  ["tampered kind", { ...B.ent1, relayKind: "full" }, T0, APEX, CA_KEYS, "signature-unverified"],
  ["malformed", { ...B.iad1, tunnelHost: `x.tunnel.${APEX}` }, T0, APEX, CA_KEYS, "malformed"],
].map(([n, b, now, apex, ks, w]) => ({ name: n, blessing: b, now, apex, caKeys: ks, expected: want(n as string, P.verifyRelayBlessing(b as RelayBlessing, ks as string[], now as number, apex as string), w) }));

const reqSig = P.signRelayMeshRecord("relay-blessing-request", request, ams1.sign);
const requestChecks = [
  ["ok", request, reqSig, T0 + 59_000, "ok"],
  ["stale", request, reqSig, T0 + 61_000, "stale"],
  ["other apex", request, reqSig, T0, "wrong-apex", "gym.flagship.services"],
  ["signed by another relay", request, P.signRelayMeshRecord("relay-blessing-request", request, iad1.sign), T0, "bad-signature"],
  ["malformed", { ...request, relayId: "A" }, reqSig, T0, "malformed"],
].map(([n, r, sig, now, w, apex]) => ({ name: n, request: r, signature: sig, now, apex: apex ?? APEX, expected: want(n as string, P.checkRelayBlessingRequest(r as never, sig as string, (apex as string) ?? APEX, now as number), w) }));

const dirV4 = P.signRelayDirectory({ ...dirBody, directoryVersion: 4, relays: relays.slice(0, 2) }, ca.kp);
const directoryChecks = [
  ["ok", D, T0, APEX, CA_KEYS, { ok: true, expired: false }],
  ["expired still verifies", D, D.expiresAt + 1, APEX, CA_KEYS, { ok: true, expired: true }],
  ["future", D, D.issuedAt - 61_000, APEX, CA_KEYS, "future"],
  ["other apex", D, T0, "gym.flagship.services", CA_KEYS, "wrong-apex"],
  ["no CA keys", D, T0, APEX, [], "no-authorized-ca-keys"],
  ["relay list tampered", { ...D, relays: relays.slice(0, 3) }, T0, APEX, CA_KEYS, "signature-unverified"],
  ["address tampered", { ...D, relays: [{ ...relays[0]!, ipv4: ["192.0.2.66"] }, ...relays.slice(1)] }, T0, APEX, CA_KEYS, "signature-unverified"],
  ["address order is not signed", { ...D, relays: [{ ...relays[2]!, ipv4: [...relays[2]!.ipv4].reverse() }, relays[0], relays[1], ...relays.slice(3)] }, T0, APEX, CA_KEYS, { ok: true, expired: false }],
  ["by another CA", P.signRelayDirectory(dirBody, ca2.kp), T0, APEX, CA_KEYS, "signature-unverified"],
  ["malformed", { ...D, directoryVersion: 0 }, T0, APEX, CA_KEYS, "malformed"],
].map(([n, d, now, apex, ks, w]) => {
  const got = P.verifyRelayDirectory(d as RelayDirectory, ks as string[], now as number, apex as string);
  const shape = typeof w === "string" ? w : w;
  if (typeof w !== "string") {
    if (JSON.stringify(got) !== JSON.stringify(w)) throw new Error(`${n}: ${JSON.stringify(got)}`);
  } else want(n as string, got, shape);
  return { name: n, directory: d, now, apex, caKeys: ks, expected: got };
});
const newerDirectory = [
  ["higher version", D, dirV4, true],
  ["lower version", dirV4, D, false],
  ["same version re-minted", D, { ...D, issuedAt: D.issuedAt + DAY }, true],
  ["same version older", { ...D, issuedAt: D.issuedAt + DAY }, D, false],
  ["none held", null, D, true],
].map(([n, a, b, w]) => ({ name: n, current: a, candidate: b, expected: want(n as string, P.newerRelayDirectory(a as never, b as never), w) }));

const sigBy = (k: Key, kind: P.RelayMeshRecordKind, r: unknown) => P.signRelayMeshRecord(kind, r as never, k.sign);
const attSig = (a: BoxAttachment, k = boxHome) => sigBy(k, "relay-attachment", a);
const attachmentCases: Array<{ name: string; attachment: BoxAttachment; signature: string; now: number; holder?: P.AttachmentHolder; expected: unknown }> = [];
const att = (n: string, a: BoxAttachment, w: string, o: { k?: Key; now?: number; holder?: P.AttachmentHolder; sig?: string } = {}) => {
  const signature = o.sig ?? attSig(a, o.k ?? keys[a.boxPub === boxHome.pub ? "boxHome" : a.boxPub === boxCabin.pub ? "boxCabin" : a.boxPub === boxOld.pub ? "boxOld" : a.boxPub === boxLab.pub ? "boxLab" : "boxLab2"]!);
  const now = o.now ?? T0;
  const got = want(n, P.checkBoxAttachment(a, signature, ctx({ now }), o.holder), w);
  attachmentCases.push({ name: n, attachment: a, signature, now, ...(o.holder ? { holder: o.holder } : {}), expected: got });
};
const holderIad = { relayId: "iad1", boxPub: boxHome.pub, serverFqdn: name("home") };
att("ok", homeAtt, "ok");
att("ok as holder", homeAtt, "ok", { holder: holderIad });
att("ok on ams1", { ...homeAtt, relayId: "ams1" }, "ok");
att("ok at the full TTL", { ...homeAtt, notAfter: homeAtt.issuedAt + P.ATTACH_TTL_MS }, "ok");
att("ok issued within the skew", { ...homeAtt, attachedAt: T0 + 30_000, issuedAt: T0 + 30_000, notAfter: T0 + 20 * MIN }, "ok");
att("malformed", { ...homeAtt, attachedAt: homeAtt.issuedAt + 1 }, "malformed", { sig: attSig(homeAtt) });
att("bare name", { ...homeAtt, serverFqdn: `alice.${APEX}` }, "not-pod-name");
att("other apex", { ...homeAtt, serverFqdn: "home.alice.gym.flagship.services" }, "not-pod-name");
att("ttl too long", { ...homeAtt, notAfter: homeAtt.issuedAt + P.ATTACH_TTL_MS + 1 }, "ttl-too-long");
att("future", { ...homeAtt, attachedAt: T0 + 61_000, issuedAt: T0 + 61_000, notAfter: T0 + 10 * MIN }, "future");
att("expired", { ...homeAtt, attachedAt: T0 - 30 * MIN, issuedAt: T0 - 20 * MIN, notAfter: T0 }, "expired");
att("not registered", { ...homeAtt, serverFqdn: name("nope") }, "not-registered");
att("wrong regGen", { ...homeAtt, regGen: 2 }, "mismatch");
att("evicted key", { ...homeAtt, serverFqdn: name("lab"), boxPub: boxLab.pub }, "mismatch", { k: boxLab });
att("another box's name", { ...homeAtt, serverFqdn: name("cabin") }, "mismatch");
att("revoked", { ...homeAtt, serverFqdn: name("old"), boxPub: boxOld.pub }, "revoked", { k: boxOld });
att("revoked relay", { ...homeAtt, relayId: "old1" }, "relay-revoked");
att("relay not in directory", { ...homeAtt, relayId: "rog1" }, "unknown-relay");
att("holder: another tunnel", { ...homeAtt, serverFqdn: name("cabin"), boxPub: boxCabin.pub }, "not-this-tunnel", { k: boxCabin, holder: holderIad });
att("holder: another relay", { ...homeAtt, relayId: "ams1" }, "not-this-relay", { holder: holderIad });
att("signed by another box", homeAtt, "bad-signature", { k: boxCabin });
att("legacy signature on a box item", homeAtt, "bad-signature", { sig: sigBy(iad1, "relay-legacy-attachment", homeAtt) });
att("re-registered key ok", { ...homeAtt, serverFqdn: name("lab"), boxPub: boxLab2.pub, regGen: 2 }, "ok", { k: boxLab2 });

const legacyCases = [
  ["ok", legacyAtt, iad1, "ok"],
  ["ok on ams1", { ...legacyAtt, relayId: "ams1" }, ams1, "ok"],
  ["entry relay", { ...legacyAtt, relayId: "ent1" }, ent1, "not-full"],
  ["box TTL is too long for legacy", { ...legacyAtt, notAfter: legacyAtt.issuedAt + P.LEGACY_TTL_MS + 1 }, iad1, "ttl-too-long"],
  ["signed by another relay", legacyAtt, ams1, "bad-signature"],
  ["box-signed bytes", legacyAtt, boxCabin, "bad-signature"],
  ["revoked relay", { ...legacyAtt, relayId: "old1" }, old1, "relay-revoked"],
].map(([n, a, k, w]) => {
  const sig = (k as Key) === boxCabin ? attSig(a as BoxAttachment, boxCabin) : sigBy(k as Key, "relay-legacy-attachment", a);
  return { name: n, attachment: a, signature: sig, now: T0, expected: want(n as string, P.checkLegacyAttachment(a as BoxAttachment, sig, ctx()), w) };
});

const item = (kind: "box" | "legacy", a: BoxAttachment): AttachmentItem => ({ kind, attachment: a, signature: "00".repeat(64) });
const compare = [
  ["higher regGen wins", item("legacy", { ...homeAtt, regGen: 2, issuedAt: T0 - 2 * MIN }), item("box", homeAtt), 1],
  ["box beats legacy", item("box", homeAtt), item("legacy", { ...homeAtt, issuedAt: T0 }), 1],
  ["later issuedAt wins", item("box", { ...homeAtt, relayId: "ams1", issuedAt: T0 - MIN + 1 }), item("box", homeAtt), 1],
  ["smaller relay id wins", item("box", { ...homeAtt, relayId: "ams1" }), item("box", homeAtt), 1],
  ["loses to larger regGen", item("box", homeAtt), item("box", { ...homeAtt, regGen: 2 }), -1],
  ["same", item("box", homeAtt), item("box", homeAtt), 0],
].map(([n, a, b, w]) => ({ name: n, a, b, expected: want(n as string, Math.sign(P.compareAttachments(a as AttachmentItem, b as AttachmentItem)), w) }));

const phoneWithdraw = records[5]!.record as RelayWithdraw;
const withdrawCases = [
  ["box ok", withdrawBox, iad1, "ok"],
  ["phone ok", phoneWithdraw, ams1, "ok"],
  ["box kind on a bare name", { ...withdrawBox, subject: `alice.${APEX}` }, iad1, "not-subject"],
  ["phone kind on a pod name", { ...phoneWithdraw, subject: name("home") }, ams1, "not-subject"],
  ["future", { ...withdrawBox, at: T0 + 61_000 }, iad1, "future"],
  ["unknown relay", { ...withdrawBox, relayId: "rog1" }, rog1, "unknown-relay"],
  ["by another relay", withdrawBox, ams1, "bad-signature"],
  ["malformed", { ...withdrawBox, subjectKind: "app" }, iad1, "malformed"],
].map(([n, w0, k, w]) => {
  const sig = (() => {
    try {
      return sigBy(k as Key, "relay-withdraw", w0);
    } catch {
      return "00".repeat(64);
    }
  })();
  return { name: n, withdraw: w0, signature: sig, now: T0, expected: want(n as string, P.checkWithdraw(w0 as RelayWithdraw, sig, ctx()), w) };
});
const claimOf = (g: PhoneRouteGrant, over: Partial<P.RouteClaim> = {}): P.RouteClaim => ({
  account: g.hostname.split(".")[0]!,
  phoneRoutePub: g.phoneRoutePub,
  hostname: g.hostname,
  generation: g.generation,
  sessionNonce: "5e".repeat(16),
  issuedAt: g.issuedAt - 1_000,
  ...over,
});
const claimSig = (c: P.RouteClaim, k: Key = phone): string => {
  try {
    return hexOf(P.signServingRecord("route-claim", c, k.sign));
  } catch {
    return "00".repeat(64);
  }
};
const phoneItemOf = (g: PhoneRouteGrant, k: Key = iad1, c: P.RouteClaim = claimOf(g), ck: Key = phone): PhoneItem => ({
  kind: "phone",
  grant: g,
  signature: sigBy(k, "phone-route-grant", g),
  claim: c,
  claimSignature: claimSig(c, ck),
});
const covers = [
  ["same attachment", withdrawBox, item("box", homeAtt), true],
  ["older attachment", withdrawBox, item("box", { ...homeAtt, issuedAt: T0 - 2 * MIN }), true],
  ["newer attachment stays", withdrawBox, item("box", { ...homeAtt, issuedAt: T0 }), false],
  ["another relay's attachment stays", withdrawBox, item("box", { ...homeAtt, relayId: "ams1" }), false],
  ["legacy attachment", withdrawBox, item("legacy", homeAtt), true],
  ["another name", withdrawBox, item("box", { ...homeAtt, serverFqdn: name("cabin") }), false],
  ["phone item", phoneWithdraw, phoneItemOf(grant), true],
  ["phone item from another holder", phoneWithdraw, phoneItemOf({ ...grant, holderRelayId: "iad1" }), false],
  ["box withdrawal on a phone item", { ...withdrawBox, subject: `alice.${APEX}` }, phoneItemOf(grant), false],
].map(([n, w0, it, w]) => ({ name: n, withdraw: w0, item: it, expected: want(n as string, P.withdrawCovers(w0 as RelayWithdraw, it as never), w) }));

// bridge auth: iad1 accepted (server, nonce NS) and checks ams1 (client, nonce NC); and the reverse
const authOf = (o: Partial<MeshAuth> & { signer?: Key; role?: "client" | "server"; signed?: Partial<P.BridgeAuth> }): MeshAuth => {
  const role = o.role ?? "client";
  const relayId = o.relayId ?? "ams1";
  const peer = o.peer ?? "iad1";
  const at0 = o.at ?? T0;
  const signed = { role, signerRelayId: relayId, peerRelayId: peer, serverNonce: NS, clientNonce: NC, at: at0, ...o.signed };
  let sig = "00".repeat(64);
  try {
    sig = sigBy(o.signer ?? relayKeys[relayId] ?? ams1, "relay-bridge-auth", signed);
  } catch {
    /* malformed on purpose */
  }
  return { type: "mesh-auth", v: 1, relayId, peer, nonce: role === "client" ? NC : NS, at: at0, blessing: o.blessing === undefined ? (B[relayId] ?? null) : o.blessing, sig };
};
const bridgeCases = [
  ["ok", authOf({}), "client", "iad1", NS, null, "ok"],
  ["dialer checks the acceptor", authOf({ relayId: "iad1", peer: "ams1", role: "server" }), "server", "ams1", NC, null, "ok"],
  ["no blessing, held copy", authOf({ blessing: null }), "client", "iad1", NS, B.ams1, "ok"],
  ["no blessing, nothing held", authOf({ blessing: null }), "client", "iad1", NS, null, "bad-blessing"],
  ["no blessing, held copy of another relay", authOf({ blessing: null }), "client", "iad1", NS, B.ent1, "bad-blessing"],
  ["proof meant for another relay", authOf({ peer: "ent1" }), "client", "iad1", NS, null, "wrong-peer"],
  ["claims to be me", authOf({ relayId: "iad1", signer: iad1 }), "client", "iad1", NS, null, "wrong-peer"],
  ["stale", authOf({ at: T0 - 61_000 }), "client", "iad1", NS, null, "stale"],
  ["blessing of another relay", authOf({ blessing: B.ent1 }), "client", "iad1", NS, null, "bad-blessing"],
  ["expired blessing", authOf({ blessing: amsExpired }), "client", "iad1", NS, null, "bad-blessing"],
  ["unauthorized CA", authOf({ blessing: amsByCa2 }), "client", "iad1", NS, null, "bad-blessing"],
  ["revoked relay", authOf({ relayId: "old1" }), "client", "iad1", NS, null, "revoked"],
  ["blessed but not in the directory", authOf({ relayId: "rog1" }), "client", "iad1", NS, null, "not-in-directory"],
  ["signed by another key", authOf({ signer: ent1 }), "client", "iad1", NS, null, "bad-signature"],
  ["replayed against another session", authOf({}), "client", "iad1", "cc".repeat(32), null, "bad-signature"],
  ["role swapped", authOf({ signed: { role: "server", serverNonce: NS, clientNonce: NC } }), "client", "iad1", NS, null, "bad-signature"],
  ["proof made for another peer", authOf({ signed: { peerRelayId: "ent1" } }), "client", "iad1", NS, null, "bad-signature"],
].map(([n, a, role, self, selfNonce, held, w]) => ({
  name: n,
  auth: a,
  role,
  selfRelayId: self,
  selfNonce,
  heldBlessing: held,
  now: T0,
  expected: (() => {
    const r = want(n as string, P.checkBridgeAuth({ auth: a as MeshAuth, role: role as "client", selfRelayId: self as string, selfNonce: selfNonce as string, heldBlessing: held as RelayBlessing | null, caKeys: CA_KEYS, ctx: ctx() }), w);
    return r.ok ? { ok: true, blessingRelayId: r.blessing.relayId } : r;
  })(),
}));

// move hints (box side)
const rate0: MoveHintRateState = P.emptyMoveHintRateState();
const hintCase = (n: string, h: MoveHint, w: string, o: { k?: Key; target?: RelayBlessing; rate?: MoveHintRateState; fetchedAt?: number | null; now?: number } = {}) => {
  let signature = "00".repeat(64);
  try {
    signature = sigBy(o.k ?? iad1, "relay-move-hint", h);
  } catch {
    /* malformed on purpose */
  }
  const target = o.target ?? B[h.toRelayId] ?? B.ams1!;
  const input = { hint: h, signature, target, rate: o.rate ?? rate0, directoryFetchedAt: o.fetchedAt === undefined ? T0 - HOUR : o.fetchedAt, now: o.now ?? T0 };
  const got = want(n, P.checkMoveHint({ ...input, box: { serverFqdn: name("home"), boxPub: boxHome.pub, servicesApex: APEX }, current: { relayId: "iad1", relayKey: iad1.pub }, directory: D, caKeys: CA_KEYS }), w);
  return { name: n, ...input, expected: got };
};
const moveHintCases = [
  hintCase("co-locate ok", hint, "ok"),
  hintCase("retire ok despite recent moves", { ...hint, reason: "retire" }, "ok", { rate: { lastLocalityAt: T0 - MIN, coLocateAt: [T0 - MIN], failedTargets: {} } }),
  hintCase("locality ok after 6 h", { ...hint, reason: "locality" }, "ok", { rate: { lastLocalityAt: T0 - P.MOVE_LOCALITY_MIN_MS, coLocateAt: [], failedTargets: {} } }),
  hintCase("locality too soon", { ...hint, reason: "locality" }, "rate-limited", { rate: { lastLocalityAt: T0 - P.MOVE_LOCALITY_MIN_MS + 1, coLocateAt: [], failedTargets: {} } }),
  hintCase("co-locate within 10 min", hint, "rate-limited", { rate: { lastLocalityAt: null, coLocateAt: [T0 - 9 * MIN], failedTargets: {} } }),
  hintCase("co-locate 6 a day", hint, "rate-limited", { rate: { lastLocalityAt: null, coLocateAt: [1, 2, 3, 4, 5, 6].map((i) => T0 - i * HOUR), failedTargets: {} } }),
  hintCase("co-locate 5 a day ok", hint, "ok", { rate: { lastLocalityAt: null, coLocateAt: [1, 2, 3, 4, 5, 25].map((i) => T0 - i * HOUR), failedTargets: {} } }),
  hintCase("target failed within the hour", hint, "target-failed", { rate: { lastLocalityAt: null, coLocateAt: [], failedTargets: { ams1: T0 - 59 * MIN } } }),
  hintCase("target failed over an hour ago", hint, "ok", { rate: { lastLocalityAt: null, coLocateAt: [], failedTargets: { ams1: T0 - HOUR } } }),
  hintCase("another box", { ...hint, serverFqdn: name("cabin") }, "not-this-box"),
  hintCase("another key", { ...hint, boxPub: boxCabin.pub }, "not-this-box"),
  hintCase("not from my relay", { ...hint, fromRelayId: "ent1" }, "wrong-from", { k: ent1 }),
  hintCase("signed by the target", hint, "bad-signature", { k: ams1 }),
  hintCase("ttl too long", { ...hint, notAfter: hint.issuedAt + P.MOVE_HINT_TTL_MS + 1 }, "ttl-too-long"),
  hintCase("future", { ...hint, issuedAt: T0 + 61_000, notAfter: T0 + 5 * MIN }, "future"),
  hintCase("expired", { ...hint, issuedAt: T0 - 10 * MIN, notAfter: T0 }, "expired"),
  hintCase("expired target blessing", hint, "bad-target", { target: amsExpired }),
  hintCase("target blessed by an unauthorized CA", hint, "bad-target", { target: amsByCa2 }),
  hintCase("entry target", { ...hint, toRelayId: "ent1" }, "target-not-full"),
  hintCase("target blessing of another relay", { ...hint, toRelayId: "old1" }, "target-mismatch", { target: B.ams1 }),
  hintCase("directory a day old", hint, "directory-stale", { fetchedAt: T0 - P.BOX_DIRECTORY_MAX_AGE_MS - 1 }),
  hintCase("never fetched", hint, "directory-stale", { fetchedAt: null }),
  hintCase("target not in the directory", { ...hint, toRelayId: "rog1" }, "not-in-directory"),
  hintCase("malformed", { ...hint, toRelayId: "iad1" }, "malformed"),
];
const recordHint = [
  ["co-locate", { lastLocalityAt: 5, coLocateAt: [T0 - 2 * DAY, T0 - HOUR], failedTargets: { ams1: T0 - 2 * HOUR, ent1: T0 - MIN } }, "co-locate"],
  ["locality", rate0, "locality"],
  ["retire", { lastLocalityAt: null, coLocateAt: [T0 - HOUR], failedTargets: {} }, "retire"],
].map(([n, r, reason]) => ({ name: n, rate: r, reason, now: T0, expected: P.recordMoveHint(r as MoveHintRateState, reason as never, T0) }));
const recordFailed = [{ name: "fail", rate: { lastLocalityAt: null, coLocateAt: [T0 - HOUR], failedTargets: { ams1: T0 - 2 * HOUR, ent1: T0 - MIN } }, relayId: "old1", now: T0 }].map((c) => ({ ...c, expected: P.recordMoveTargetFailed(c.rate, c.relayId, c.now) }));

// account moves
const moveCase = (n: string, m: AccountMove, w: string, o: { k?: Key; home?: string | null; last?: number | null } = {}) => {
  let signature = "00".repeat(64);
  try {
    signature = sigBy(o.k ?? iad1, "relay-account-move", m);
  } catch {
    /* malformed */
  }
  const input = { move: m, signature, expectedHome: o.home === undefined ? "iad1" : o.home, lastAcceptedAt: o.last ?? null, now: T0 };
  return { name: n, ...input, expected: want(n, P.checkAccountMove({ ...input, ctx: ctx() }), w) };
};
const accountMoveCases = [
  moveCase("ok", move, "ok"),
  moveCase("ok 6 h after the last", move, "ok", { last: T0 - P.ACCOUNT_MOVE_MIN_INTERVAL_MS }),
  moveCase("too soon", move, "too-soon", { last: T0 - P.ACCOUNT_MOVE_MIN_INTERVAL_MS + 1 }),
  moveCase("not from the home", move, "not-home", { home: "ams1" }),
  moveCase("no home known", move, "not-home", { home: null }),
  moveCase("ttl too long", { ...move, notAfter: move.issuedAt + P.ACCOUNT_MOVE_TTL_MS + 1 }, "ttl-too-long"),
  moveCase("future", { ...move, issuedAt: T0 + 61_000, notAfter: T0 + 5 * MIN }, "future"),
  moveCase("expired", { ...move, issuedAt: T0 - 10 * MIN, notAfter: T0 }, "expired"),
  moveCase("to a revoked relay", { ...move, toRelayId: "old1" }, "relay-revoked"),
  moveCase("to an unknown relay", { ...move, toRelayId: "rog1" }, "unknown-relay"),
  moveCase("to an entry relay", { ...move, toRelayId: "ent1" }, "target-not-full"),
  moveCase("signed by the target", move, "bad-signature", { k: ams1 }),
  moveCase("malformed", { ...move, toRelayId: "iad1" }, "malformed"),
];

// phone items
const aliceRank = P.phoneLedgerRanking("alice", D, LOG);
if (aliceRank.length <= P.PHONE_LEDGER_TOP_K || aliceRank.indexOf("iad1") >= P.PHONE_LEDGER_TOP_K) throw new Error(`alice's ledger ranking ${aliceRank} does not fit the phone vectors`);
const outsider = aliceRank[P.PHONE_LEDGER_TOP_K]!;
const phoneCase = (n: string, g: PhoneRouteGrant, w: string, o: { k?: Key; announcer?: string; highestLive?: number; claim?: Partial<P.RouteClaim>; ck?: Key; drop?: "claim" } = {}) => {
  let it: PhoneItem;
  try {
    it = phoneItemOf(g, o.k ?? iad1, claimOf(g, o.claim), o.ck ?? phone);
  } catch {
    it = { kind: "phone", grant: g, signature: "00".repeat(64), claim: claimOf(g, o.claim), claimSignature: claimSig(claimOf(g, o.claim), o.ck ?? phone) };
  }
  if (o.drop === "claim") delete (it as Partial<PhoneItem>).claim;
  const announcer = o.announcer ?? g.holderRelayId;
  const highestLive = o.highestLive ?? 0;
  return { name: n, item: it, announcer, highestLive, now: T0, expected: want(n, P.checkPhoneItem(it, announcer, ctx(), highestLive), w) };
};
const otherPhone = key("otherPhone", 32);
const phoneItemCases = [
  phoneCase("ok", grant, "ok"),
  phoneCase("ok, holder is the ledger", { ...grant, holderRelayId: "iad1" }, "ok"),
  phoneCase("ok, within the jump", { ...grant, generation: 20 }, "ok", { highestLive: 20 - P.PHONE_GENERATION_MAX_JUMP }),
  phoneCase("ok, below the highest live", grant, "ok", { highestLive: 9 }),
  phoneCase("pod name", { ...grant, hostname: name("home") }, "not-bare-name"),
  phoneCase("ttl too long", { ...grant, notAfter: grant.issuedAt + P.PHONE_ROUTE_GRANT_TTL_MS + 1 }, "ttl-too-long"),
  phoneCase("future", { ...grant, issuedAt: T0 + 61_000, notAfter: T0 + 100_000 }, "future"),
  phoneCase("expired", { ...grant, issuedAt: T0 - 60_000, notAfter: T0 }, "expired"),
  phoneCase("jump above the highest live", { ...grant, generation: 20 }, "generation-jump", { highestLive: 20 - P.PHONE_GENERATION_MAX_JUMP - 1 }),
  phoneCase("generation above the cap", { ...grant, generation: P.PHONE_GENERATION_MAX + 1 }, "generation-jump"),
  phoneCase("announced by another relay", grant, "wrong-holder", { announcer: "iad1" }),
  phoneCase("revoked ledger", { ...grant, ledgerRelayId: "old1" }, "relay-revoked", { k: old1 }),
  phoneCase("unknown holder", { ...grant, holderRelayId: "rog1" }, "unknown-relay"),
  phoneCase("entry holder", { ...grant, holderRelayId: "ent1" }, "not-full"),
  phoneCase("entry ledger", { ...grant, ledgerRelayId: "ent1" }, "not-full", { k: ent1 }),
  phoneCase("ledger outside the account's top k", { ...grant, ledgerRelayId: outsider }, "not-ledger", { k: relayKeys[outsider] }),
  phoneCase("claim for another generation", grant, "claim-mismatch", { claim: { generation: grant.generation + 1 } }),
  phoneCase("claim for another key", grant, "claim-mismatch", { claim: { phoneRoutePub: otherPhone.pub }, ck: otherPhone }),
  phoneCase("claim for another account", grant, "claim-mismatch", { claim: { account: "bob", hostname: `bob.${APEX}` } }),
  phoneCase("claim issued after the grant", grant, "claim-mismatch", { claim: { issuedAt: grant.issuedAt + P.MESH_CLOCK_SKEW_MS + 1 } }),
  phoneCase("signed by the holder", grant, "bad-signature", { k: ams1 }),
  phoneCase("claim signed by another key", grant, "bad-claim", { ck: otherPhone }),
  phoneCase("no claim", grant, "malformed", { drop: "claim" }),
  phoneCase("malformed", { ...grant, generation: 0 }, "malformed"),
];
const pi = (g: Partial<PhoneRouteGrant>): PhoneItem => ({ kind: "phone", grant: { ...grant, ...g }, signature: "00".repeat(64), claim: claimOf(grant), claimSignature: "00".repeat(64) });
const comparePhone = [
  ["higher generation", pi({ generation: 5, issuedAt: 1 }), pi({}), 1],
  ["later issuedAt", pi({ issuedAt: grant.issuedAt + 1 }), pi({}), 1],
  ["smaller holder", pi({ holderRelayId: "aaa1" }), pi({}), 1],
  ["lower generation", pi({ generation: 3 }), pi({}), -1],
  ["same", pi({}), pi({}), 0],
].map(([n, a, b, w]) => ({ name: n, a, b, expected: want(n as string, Math.sign(P.comparePhoneItems(a as PhoneItem, b as PhoneItem)), w) }));

// routing
const homeCases = [
  ["move wins", [{ relayId: "iad1", attachedAt: 1 }, { relayId: "iad1", attachedAt: 2 }, { relayId: "ams1", attachedAt: 3 }], { toRelayId: "ams1", notAfter: T0 + 1 }, "ams1"],
  ["expired move", [{ relayId: "iad1", attachedAt: 1 }, { relayId: "iad1", attachedAt: 2 }, { relayId: "ams1", attachedAt: 3 }], { toRelayId: "ams1", notAfter: T0 }, "iad1"],
  ["move to a relay holding none", [{ relayId: "iad1", attachedAt: 1 }], { toRelayId: "ams1", notAfter: T0 + 1 }, "iad1"],
  ["most attachments", [{ relayId: "ams1", attachedAt: 1 }, { relayId: "iad1", attachedAt: 5 }, { relayId: "iad1", attachedAt: 6 }], null, "iad1"],
  ["earliest attachedAt", [{ relayId: "iad1", attachedAt: 5 }, { relayId: "ams1", attachedAt: 4 }], null, "ams1"],
  ["smaller relay id", [{ relayId: "iad1", attachedAt: 4 }, { relayId: "ams1", attachedAt: 4 }], null, "ams1"],
  ["entry relays never home", [{ relayId: "ent1", attachedAt: 1 }, { relayId: "ent1", attachedAt: 2 }, { relayId: "iad1", attachedAt: 9 }], null, "iad1"],
  ["only an entry relay", [{ relayId: "ent1", attachedAt: 1 }], null, null],
  ["unknown relay ignored", [{ relayId: "rog1", attachedAt: 1 }], null, null],
  ["none", [], null, null],
].map(([n, a, m, w]) => ({ name: n, attachments: a, move: m, now: T0, expected: want(n as string, P.accountHome({ attachments: a as never, directory: D, move: m as never, now: T0 }), w) }));
const ledgerCases = ["alice", "bob", "carol", "dave"].flatMap((u) => [
  { account: u, withLog: true, expected: P.phoneLedgerRanking(u, D, LOG) },
  { account: u, withLog: false, expected: P.phoneLedgerRanking(u, D, null) },
]);
const MiB = 1024 * 1024;
const load = (o: Partial<P.RebalanceRelay> = {}): P.RebalanceRelay => ({ relayId: "ams1", relayKind: "full", lastLoadAt: T0 - 10_000, draining: false, tunnels: 10, capacity: 100, ...o });
const rebalanceCases = [
  ["moves", [{ relayId: "iad1", bytes: 10 * MiB, streams: 10 }, { relayId: "ams1", bytes: 70 * MiB, streams: 100 }], [load()], null, false, { move: true, to: "ams1" }],
  ["streams alone reach the threshold", [{ relayId: "iad1", bytes: 1, streams: 100 }, { relayId: "ams1", bytes: 9, streams: 400 }], [load()], null, false, { move: true, to: "ams1" }],
  ["exactly 0.6 and 0.3", [{ relayId: "iad1", bytes: 30 * MiB, streams: 0 }, { relayId: "ams1", bytes: 60 * MiB, streams: 0 }, { relayId: "ent1", bytes: 10 * MiB, streams: 0 }], [load()], null, false, { move: true, to: "ams1" }],
  ["legacy box", [{ relayId: "ams1", bytes: 100 * MiB, streams: 0 }], [load()], null, true, "legacy-box"],
  ["moved recently", [{ relayId: "ams1", bytes: 100 * MiB, streams: 0 }], [load()], T0 - P.ACCOUNT_MOVE_MIN_INTERVAL_MS + 1, false, "recent-move"],
  ["below threshold", [{ relayId: "ams1", bytes: 63 * MiB, streams: 499 }], [load()], null, false, "below-threshold"],
  ["only home traffic", [{ relayId: "iad1", bytes: 100 * MiB, streams: 0 }], [load()], null, false, "no-candidate"],
  ["share under 0.6", [{ relayId: "iad1", bytes: 41 * MiB, streams: 0 }, { relayId: "ams1", bytes: 59 * MiB, streams: 0 }], [load()], null, false, "share"],
  ["lead under 0.3", [{ relayId: "iad1", bytes: 31 * MiB, streams: 0 }, { relayId: "ams1", bytes: 60 * MiB, streams: 0 }, { relayId: "ent1", bytes: 9 * MiB, streams: 0 }], [load()], null, false, "lead"],
  ["ties go to the smaller id", [{ relayId: "iad1", bytes: 0, streams: 0 }, { relayId: "ent1", bytes: 50 * MiB, streams: 0 }, { relayId: "ams1", bytes: 50 * MiB, streams: 0 }], [load()], null, false, "share"],
  ["unknown target", [{ relayId: "rog1", bytes: 100 * MiB, streams: 0 }], [load()], null, false, "unknown-relay"],
  ["entry target", [{ relayId: "ent1", bytes: 100 * MiB, streams: 0 }], [load({ relayId: "ent1", relayKind: "entry" })], null, false, "not-full"],
  ["no load message", [{ relayId: "ams1", bytes: 100 * MiB, streams: 0 }], [load({ lastLoadAt: null })], null, false, "load-stale"],
  ["load message a minute old", [{ relayId: "ams1", bytes: 100 * MiB, streams: 0 }], [load({ lastLoadAt: T0 - 60_000 })], null, false, "load-stale"],
  ["draining", [{ relayId: "ams1", bytes: 100 * MiB, streams: 0 }], [load({ draining: true })], null, false, "draining"],
  ["at 0.8 load", [{ relayId: "ams1", bytes: 100 * MiB, streams: 0 }], [load({ tunnels: 80 })], null, false, "load-high"],
  ["no capacity", [{ relayId: "ams1", bytes: 100 * MiB, streams: 0 }], [load({ tunnels: 0, capacity: 0 })], null, false, "load-high"],
].map(([n, w0, rs, last, legacy, w]) => {
  const got = P.rebalanceDecision({ home: "iad1", window: w0 as never, relays: rs as never, lastMoveAt: last as number | null, hasLegacyBox: legacy as boolean, now: T0 });
  if (typeof w === "string") want(n as string, got.move ? "ok" : got.reason, w);
  else if (JSON.stringify(got) !== JSON.stringify(w)) throw new Error(`${n}: ${JSON.stringify(got)}`);
  return { name: n, home: "iad1", window: w0, relays: rs, lastMoveAt: last, hasLegacyBox: legacy, now: T0, expected: got };
});

// serving decision at a policy head (relay-mesh.md §4.4)
const signedPolicy = { record: policy7, signature: hexOf(P.signServingRecord("serving-policy", policy7 as never, admin.sign)) };
const policyOther = { ...policy7, policyGen: 2, issuedAt: T0 - HOUR };
const signedOther = { record: policyOther, signature: hexOf(P.signServingRecord("serving-policy", policyOther as never, admin.sign)) };
const forgedPolicy = { record: policy7, signature: hexOf(P.signServingRecord("serving-policy", policy7 as never, irk.sign)) };
const lease = { account: "alice", box: boxHome.pub, regGen: 1, policyGen: 1, leaseId: "ab".repeat(16), issuedAt: T0 - HOUR, notAfter: T0 + DAY };
const signedLease = { record: lease, signature: hexOf(P.signServingRecord("serving-lease", lease as never, admin.sign)) };
const servingInput = { account: "alice", box: boxHome.pub, regGen: 1, adminKeyFromCom: admin.pub, adminKeyFromBox: admin.pub, now: T0 };
const servingAtHead = [
  ["head matches", [signedPolicy, signedOther], [signedLease], { policySha256: policySha }, "apps"],
  ["no head: the newest policy counts", [signedPolicy, signedOther], [signedLease], null, "no-lease"],
  ["head names another policy", [signedOther], [signedLease], { policySha256: policySha }, "policy-stale"],
  ["head but no policy", [], [signedLease], { policySha256: policySha }, "policy-stale"],
  ["head matches a forged policy", [forgedPolicy], [signedLease], { policySha256: policySha }, "policy-signature"],
  ["revoked first", [signedPolicy], [signedLease], { policySha256: "00".repeat(32) }, "revoked", true],
].map(([n, policies, leases, head, w, revoked]) => {
  const revocations = revoked ? { boxes: new Map([[boxHome.pub, 1]]), renewalKeys: new Set<string>() } : P.relayLogRevocations(LOG);
  const got = P.servingDecision({ ...servingInput, policies: policies as never, leases: leases as never, revocations, policyHead: head as never });
  want(n as string, got.apps ? "apps" : got.reason, w);
  return { name: n, input: { ...servingInput, policies, leases, policyHead: head, revokedBoxes: revoked ? { [boxHome.pub]: 1 } : summary(LOG).revokedBoxes }, expected: got };
});

const doc = {
  description:
    "Relay mesh vectors (docs/architecture-v2/relay-mesh.md), produced by packages/protocol/src/relayMesh.ts. Generated by tools/relay-mesh-vectors.ts; do not edit. Seeds are test-only (32 bytes of one value). The log is applied from `log.entries`; check contexts use the state after all of them (`log.finalState`), the directory `directory.directory`, apex `servicesApex`, and the CA keys `caKeys`.",
  servicesApex: APEX,
  t0: T0,
  keys: Object.fromEntries(Object.values(keys).map((k) => [k.name, { seed: k.seed, pub: k.pub }])),
  caKeys: CA_KEYS,
  logKey: logKey.pub,
  constants: Object.fromEntries(
    Object.entries(M)
      .filter(([, v]) => typeof v === "number")
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  ),
  hashes,
  records,
  blessings: caRecords.blessings,
  directory: caRecords.directory,
  canonicalErrors,
  log,
  heads,
  checks: {
    blessing: blessingChecks,
    blessingRequest: requestChecks,
    directory: directoryChecks,
    newerDirectory,
    boxAttachment: attachmentCases,
    legacyAttachment: legacyCases,
    compareAttachments: compare,
    withdraw: withdrawCases,
    withdrawCovers: covers,
    bridgeAuth: bridgeCases,
    moveHint: moveHintCases,
    recordMoveHint: recordHint,
    recordMoveTargetFailed: recordFailed,
    accountMove: accountMoveCases,
    phoneItem: phoneItemCases,
    comparePhoneItems: comparePhone,
    accountHome: homeCases,
    phoneLedgerRanking: ledgerCases,
    rebalance: rebalanceCases,
    servingAtHead,
  },
};

const text = JSON.stringify(doc, null, 2) + "\n";
if (process.argv.includes("--check")) {
  let cur = "";
  try {
    cur = readFileSync(out, "utf8");
  } catch {
    /* missing */
  }
  if (cur !== text) {
    console.error(`${out} is stale; run npx tsx tools/relay-mesh-vectors.ts`);
    process.exit(1);
  }
  console.log("relay-mesh vectors up to date");
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(`wrote ${out}`);
}
