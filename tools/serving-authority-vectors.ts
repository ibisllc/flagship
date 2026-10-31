#!/usr/bin/env -S npx tsx
/**
 * Writes packages/protocol/test-vectors/serving-authority/vectors.json from the TypeScript implementation
 * (packages/protocol/src/servingAuthority.ts): every record's canonical bytes and signature, canonical name lists,
 * and relay decisions with their expected outcome. The Rust twin (flagship-crypto serving.rs) must agree.
 *
 *   npx tsx tools/serving-authority-vectors.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { p256 } from "@noble/curves/nist.js";
import {
  applyRevocationEntries,
  boxNameList,
  canonicalNameList,
  ed,
  emptyRevocationState,
  leaseFor,
  nameListSha256,
  servingDecision,
  signServingLeaseP256,
  signServingRecord,
  type RevocationEntry,
  type ServingInput,
  type ServingRecordKind,
} from "../packages/protocol/src/index.js";

const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");
const key = (n: number) => {
  const seed = new Uint8Array(32).fill(n);
  return { seed: hexOf(seed), pub: hexOf(ed.getPublicKey(seed)), sign: (m: Uint8Array) => ed.sign(m, seed) };
};
const admin = key(1);
const other = key(2);
/** A device's hardware renewal key: P-256 (the Secure Enclave and StrongBox hold no Ed25519 key). */
const renewalSk = new Uint8Array(32).fill(3);
const renewal = { pub: hexOf(p256.getPublicKey(renewalSk, true)) };
const strangerSk = new Uint8Array(32).fill(9);
const revoker = key(4);
const box = key(5).pub;
const device = key(6).pub;
const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const enc = new TextDecoder();

function rec<K extends ServingRecordKind>(kind: K, record: unknown, signer = admin) {
  const signature = hexOf(signServingRecord(kind, record as never, signer.sign));
  return { kind, record, signature, signerPub: signer.pub, alg: "ed25519" };
}

const scope = nameListSha256(boxNameList("home", "alice", "flagship.services"));
const policy7 = { account: "alice", box, regGen: 1, policyGen: 1, grace: "7d", onLapse: "stop-apps", scopeSha256: scope, issuedAt: T0 };
const policyInf = { ...policy7, grace: "indefinite" };
const policyLock = { ...policy7, grace: "30d", onLapse: "lock-server" };
const delegation = { account: "alice", alg: "p256", renewalPub: renewal.pub, deviceId: device, issuedAt: T0 };
const lease = leaseFor(policy7 as never, T0, "ab".repeat(16))!;
const revBox: RevocationEntry = { sequence: 1, kind: "box", account: "alice", subject: box, generation: 1, revokedAt: T0 + DAY };
const revKey: RevocationEntry = { sequence: 1, kind: "renewal-key", account: "alice", subject: renewal.pub, generation: 0, revokedAt: T0 + DAY };
const order = { class: "apps", device: box, regGen: 1, csrSha256: "11".repeat(32), requestId: "22".repeat(16), issuedAt: T0 };
const claim = { account: "alice", phoneRoutePub: device, hostname: "alice.flagship.services", generation: 3, sessionNonce: "33".repeat(16), issuedAt: T0 };

const records = [
  rec("serving-policy", policy7),
  rec("serving-policy", policyInf),
  rec("serving-policy", policyLock),
  rec("renewal-key-delegation", delegation),
  { kind: "serving-lease" as const, record: lease, signature: signServingLeaseP256(lease as never, renewalSk), signerPub: renewal.pub, alg: "p256" },
  rec("serving-lease", lease, admin),
  rec("revocation-entry", revBox, revoker),
  rec("revocation-entry", revKey, revoker),
  rec("certificate-order", order, key(5)),
  rec("route-claim", claim, key(6)),
].map((r) => ({ ...r, canonical: enc.decode(canonicalOf(r.kind, r.record)) }));

function canonicalOf(kind: ServingRecordKind, record: unknown): Uint8Array {
  let bytes = new Uint8Array();
  signServingRecord(kind, record as never, (m) => ((bytes = m), new Uint8Array(64)));
  return bytes;
}

const sp = (r: unknown, s = admin) => ({ record: r, signature: hexOf(signServingRecord("serving-policy", r as never, s.sign)) });
const sl = (r: unknown, sk = renewalSk) => ({ record: r, signature: signServingLeaseP256(r as never, sk) });
const slAdmin = (r: unknown) => ({ record: r, signature: hexOf(signServingRecord("serving-lease", r as never, admin.sign)) });
const sd = (r: unknown, s = admin) => ({ record: r, signature: hexOf(signServingRecord("renewal-key-delegation", r as never, s.sign)) });
const se = (e: RevocationEntry) => ({ entry: e, signature: hexOf(signServingRecord("revocation-entry", e, revoker.sign)) });

type Case = { name: string; input: Omit<ServingInput, "revocations"> & { revocationEntries: ReturnType<typeof se>[] } };
const base: Case["input"] = {
  account: "alice",
  box,
  regGen: 1,
  adminKeyFromCom: admin.pub,
  adminKeyFromBox: admin.pub,
  policies: [sp(policy7)] as never,
  leases: [{ ...sl(lease), delegation: sd(delegation) }] as never,
  revocationEntries: [],
  now: T0 + DAY,
};
const cases: Case[] = [
  { name: "finite grace, delegated lease live", input: base },
  { name: "indefinite needs no lease", input: { ...base, policies: [sp(policyInf)] as never, leases: [] } },
  { name: "no policy anywhere: the default", input: { ...base, policies: [], leases: [] } },
  { name: "the stricter generation wins whichever side sent it", input: { ...base, policies: [sp({ ...policyInf, policyGen: 2 }), sp({ ...policy7, policyGen: 3 })] as never, leases: [] } },
  { name: "lease signed by the admin root itself", input: { ...base, leases: [slAdmin(lease)] as never } },
  { name: "lease ended", input: { ...base, now: T0 + 7 * DAY } },
  { name: "no lease", input: { ...base, leases: [] } },
  { name: "admin keys differ", input: { ...base, adminKeyFromBox: other.pub } },
  { name: "policy signed by another key", input: { ...base, policies: [sp(policy7, other)] as never } },
  { name: "lease longer than the grace", input: { ...base, leases: [{ ...sl({ ...lease, notAfter: T0 + 30 * DAY }), delegation: sd(delegation) }] as never } },
  { name: "older policy generation", input: { ...base, policies: [sp({ ...policy7, policyGen: 2 })] as never } },
  { name: "undelegated renewal key", input: { ...base, leases: [sl(lease, strangerSk)] as never } },
  { name: "delegation signed by another key", input: { ...base, leases: [{ ...sl(lease), delegation: sd(delegation, other) }] as never } },
  { name: "lock-server, lease live", input: { ...base, policies: [sp(policyLock)] as never } },
  { name: "lock-server, lease ended: lock", input: { ...base, policies: [sp(policyLock)] as never, now: T0 + 7 * DAY } },
  { name: "box revoked", input: { ...base, revocationEntries: [se(revBox)] } },
  { name: "renewal key revoked", input: { ...base, revocationEntries: [se(revKey)] } },
];

const decisions = cases.map((c) => {
  const r = applyRevocationEntries(emptyRevocationState(), c.input.revocationEntries, revoker.pub);
  if (!r.ok) throw new Error(`${c.name}: revocations did not apply`);
  const { revocationEntries: _e, ...rest } = c.input;
  return { name: c.name, input: c.input, expected: servingDecision({ ...(rest as never), revocations: r.state }) };
});

const nameLists = [
  boxNameList("home", "alice", "flagship.services"),
  [{ class: "phone", name: "alice.flagship.services" }, ...boxNameList("home2", "alice", "gym.flagship.services")],
].map((names) => ({ names, canonical: canonicalNameList(names as never), sha256: nameListSha256(names as never) }));

const out = {
  about:
    "Serving authority (plan H, docs/architecture-v2/issuance-and-lease-records.md): canonical bytes and signatures of every record, canonical name lists, and relay decisions (revocationEntries are applied in order with revocationKeyPub first). Written by tools/serving-authority-vectors.ts from the TypeScript implementation.",
  revocationKeyPub: revoker.pub,
  records,
  nameLists,
  decisions,
};
mkdirSync(new URL("../packages/protocol/test-vectors/serving-authority/", import.meta.url), { recursive: true });
writeFileSync(new URL("../packages/protocol/test-vectors/serving-authority/vectors.json", import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log(`${records.length} records, ${nameLists.length} name lists, ${decisions.length} decisions`);
