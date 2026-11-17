#!/usr/bin/env -S npx tsx
/**
 * Shared vectors for keyd adopting a rotated org CGK (packages/keyd/src/orgCgk.ts and
 * rust/crates/flagship-keyd/src/org_cgk.rs; docs/enterprise-accounts.md "keyd and the org CGK").
 * Built on the org-authority vectors' keys and chains. Each case is the arguments the daemon sends
 * (`cgk.orgAdopt`), the pin keyd holds, and what keyd must answer: the adopted version or the
 * refusal code. Both backends must agree on every case.
 *
 * Run:          npx tsx tools/keyd-org-cgk-vectors.ts
 * CI freshness: npx tsx tools/keyd-org-cgk-vectors.ts --check
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { orgAuthorityHash, signOrgApproval, type OrgApproval } from "../packages/protocol/src/orgAuthority.js";
import { buildOrgKeyRing, canonicalOrgKeyRing, orgKemKeyPair, orgKeyRingSha256, type OrgKemKey } from "../packages/protocol/src/orgKeyRing.js";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, "packages/protocol/test-vectors/keyd-org-cgk/vectors.json");
const V = JSON.parse(readFileSync(resolve(ROOT, "packages/protocol/test-vectors/org-authority/vectors.json"), "utf8"));
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
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
const DAY = 86_400_000;
const SERVER = "home.acme.flagship.services";
const chainNamed = (name: string): any[] => {
  const c = V.chains.find((x: { name: string }) => x.name === name);
  if (!c) throw new Error(`no chain ${name}`);
  return resolveRefs(c).entries;
};
const base = chainNamed("genesis, recovery seat added, founder removes C after 7 days, the bylaws' set restores C").slice(0, 2);
const T1: number = base[1].record.issuedAt;
const NOW: number = Math.max(T1 + 2 * DAY, V.chains[0].now);

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
const D = key("D board");
const S = key("S scoped admin");

const approve = (k: Key, order: Uint8Array, oarVersion: number, issuedAt: number): OrgApproval =>
  signOrgApproval({ orgId: ORG, oarVersion, order, seatId: k.seatId, adminKeyId: k.keyId, issuedAt, notAfter: issuedAt + DAY }, k.secret, { deterministic: true });

const kemA = orgKemKeyPair(fill(32, 0x31));
const kemBox = orgKemKeyPair(fill(32, 0x35));
const kk = (recipient: string, kp: ReturnType<typeof orgKemKeyPair>): OrgKemKey => ({ recipient, kemPub: kp.kemPub, kemKeyId: kp.kemKeyId, issuedAt: T1 });
const rnd = (b: number) => (i: number) => fill(64, b + i);
const cgk1 = fill(32, 0x61);
const cgk2 = fill(32, 0x62);
const recips = [kk(`seat:${A.seatId}`, kemA), kk(`box:${SERVER}`, kemBox)];
const v1 = buildOrgKeyRing({ orgId: ORG, kind: "cgk", scope: "*", prev: null, key: cgk1, recipients: recips, retired: [], oarVersion: 1, issuedAt: T1 + DAY, randomness: rnd(0x10) });
const v2 = buildOrgKeyRing({ orgId: ORG, kind: "cgk", scope: "*", prev: v1.ring, key: cgk2, recipients: recips, retired: [], oarVersion: 1, issuedAt: T1 + DAY + 60_000, randomness: rnd(0x20) });
const RT = v2.ring.issuedAt;
const v2a = approve(A, canonicalOrgKeyRing(v2.ring), 1, RT);
const archive = buildOrgKeyRing({ orgId: ORG, kind: "archive-keys", scope: SERVER, prev: null, key: cgk2, recipients: recips, retired: [], oarVersion: 1, issuedAt: RT, randomness: rnd(0x30) });
// Approved under v0 (superseded by v1): after v1 existed it does not count; before, it does (05c review F4).
const underV0 = buildOrgKeyRing({ orgId: ORG, kind: "cgk", scope: "*", prev: v1.ring, key: cgk2, recipients: recips, retired: [], oarVersion: 0, issuedAt: RT, randomness: rnd(0x20) });
const EARLY = T1 - 60_000;
const underV0Early = buildOrgKeyRing({ orgId: ORG, kind: "cgk", scope: "*", prev: v1.ring, key: cgk2, recipients: recips, retired: [], oarVersion: 0, issuedAt: EARLY, randomness: rnd(0x20) });
const jump = buildOrgKeyRing({ orgId: ORG, kind: "cgk", scope: "*", prev: v2.ring, key: cgk2, recipients: recips, retired: [], oarVersion: 1, issuedAt: RT + 60_000, randomness: rnd(0x40) });
const HEAD = { oarVersion: 1, oarHash: orgAuthorityHash(base[1].record) };
const far = buildOrgKeyRing({ orgId: ORG, kind: "cgk", scope: "*", prev: v1.ring, key: cgk2, recipients: recips, retired: [], oarVersion: 5, issuedAt: RT, randomness: rnd(0x20) });

const pin = { orgId: ORG, genesisHash: GENESIS, serverDomain: SERVER, cgkVersion: 1 };
const flip = (a: OrgApproval): OrgApproval => ({ ...a, signature: a.signature.slice(0, 100) + (a.signature[100] === "0" ? "1" : "0") + a.signature.slice(101) });

interface Case {
  name: string;
  chain: string;
  pin?: Partial<typeof pin & { oarVersion: number; oarHash: string; cgkRingSha256: string }>;
  args: Record<string, unknown>;
  expect: { ok: true; version: number; keyHex: string } | { ok: false; code: string };
}
const ok2 = { ok: true as const, version: 2, keyHex: hex(cgk2) };
const no = (code: string) => ({ ok: false as const, code });
const adopt = (ring = v2, approvals: OrgApproval[] = [v2a], k: Uint8Array = cgk2) => ({ ring: ring.ring, recipients: ring.recipients, approvals, key: hex(k) });

/** Chains by name: `from` names a chain in org-authority/vectors.json (its `$key` / `$approval` refs resolved), `take` its first entries. */
const FULL = "genesis, recovery seat added, founder removes C after 7 days, the bylaws' set restores C";
const named = (n: string) => ({ from: n });
const chains: Record<string, { from: string; take?: number }> = {
  base: { from: FULL, take: 2 },
  "genesis only": { from: FULL, take: 1 },
  "with a founder's removal": { from: FULL, take: 3 },
  ...Object.fromEntries(
    [
      "v1 approved by the founder alone",
      "v1 counts a board seat",
      "v1 without the new recovery seat's consent",
      "v1 with the founder's approval twice",
      "v1 approval with one bit flipped",
      "v1 pointing at another previous record",
      "changing the bylaws with k_gov only",
      "changing the bylaws with the strictest ceremony",
      "v1 while B was frozen by C",
    ].map((n) => [n, named(n)]),
  ),
};
for (const c of Object.values(chains)) chainNamed(c.from);

const cases: Case[] = [
  { name: "a rotated CGK one version up, approved by an org admin", chain: "base", args: adopt(), expect: ok2 },
  { name: "a version keyd already holds is stale", chain: "base", pin: { cgkVersion: 2 }, args: adopt(), expect: no("stale") },
  { name: "an older version is stale (no rollback)", chain: "base", args: adopt(v1, [approve(A, canonicalOrgKeyRing(v1.ring), 1, v1.ring.issuedAt)], cgk1), expect: no("stale") },
  { name: "another org's genesis", chain: "base", pin: { genesisHash: "ab".repeat(32) }, args: adopt(), expect: no("genesis") },
  { name: "a key that is not the committed one", chain: "base", args: adopt(v2, [v2a], cgk1), expect: no("commitment") },
  { name: "this box is not a recipient", chain: "base", pin: { serverDomain: "other.acme.flagship.services" }, args: adopt(), expect: no("not-recipient") },
  {
    name: "recipients that do not hash to the ring",
    chain: "base",
    args: { ...adopt(), recipients: v2.recipients.map((r, i) => (i === 0 ? { ...r, sealedHex: v1.recipients[0]!.sealedHex } : r)) },
    expect: no("recipients"),
  },
  { name: "a server's archive keys are not the CGK", chain: "base", args: adopt(archive, [approve(A, canonicalOrgKeyRing(archive.ring), 1, RT)]), expect: no("not-cgk") },
  { name: "approved by a seat outside the record", chain: "base", args: adopt(v2, [approve(S, canonicalOrgKeyRing(v2.ring), 1, RT)]), expect: no("unknown-signer") },
  { name: "approved by a board seat", chain: "base", args: adopt(v2, [approve(D, canonicalOrgKeyRing(v2.ring), 1, RT)]), expect: no("not-an-admin") },
  { name: "an approval with one bit flipped", chain: "base", args: adopt(v2, [flip(v2a)]), expect: no("bad-signature") },
  { name: "no approval", chain: "base", args: adopt(v2, []), expect: no("threshold") },
  { name: "an approval under another record than the ring names", chain: "base", args: adopt(v2, [approve(A, canonicalOrgKeyRing(v2.ring), 0, RT)]), expect: no("stale-oar") },
  { name: "a ring naming a record keyd was not shown", chain: "base", args: adopt(far, [approve(A, canonicalOrgKeyRing(far.ring), 5, RT)]), expect: no("stale-oar") },
  { name: "a chain that moved by a founder's removal", chain: "with a founder's removal", args: adopt(), expect: no("not-direct") },
  { name: "a chain whose v1 the founder approved alone", chain: "v1 approved by the founder alone", args: adopt(), expect: no("threshold") },
  { name: "a chain whose v1 counts a board seat", chain: "v1 counts a board seat", args: adopt(), expect: no("not-an-admin") },
  { name: "a chain whose v1 lacks a newcomer's consent", chain: "v1 without the new recovery seat's consent", args: adopt(), expect: no("consent-missing") },
  { name: "a chain whose v1 repeats an approval", chain: "v1 with the founder's approval twice", args: adopt(), expect: no("duplicate-signer") },
  { name: "a chain whose v1 approval has a bit flipped", chain: "v1 approval with one bit flipped", args: adopt(), expect: no("bad-signature") },
  { name: "a chain whose v1 points at another record", chain: "v1 pointing at another previous record", args: adopt(), expect: no("chain") },
  { name: "a chain that changed the bylaws with k_gov only", chain: "changing the bylaws with k_gov only", args: adopt(), expect: no("threshold") },
  { name: "a chain that changed the bylaws with the strictest ceremony", chain: "changing the bylaws with the strictest ceremony", args: adopt(), expect: ok2 },
  // 05c review F4: the newest record shown, the head keyd verified before, and the ring it holds.
  { name: "a ring approved under a record the chain has since superseded", chain: "base", args: adopt(underV0, [approve(A, canonicalOrgKeyRing(underV0.ring), 0, RT)]), expect: no("stale-oar") },
  { name: "a ring approved under the previous record before the next existed", chain: "base", args: adopt(underV0Early, [approve(A, canonicalOrgKeyRing(underV0Early.ring), 0, EARLY)]), expect: ok2 },
  { name: "a chain cut below the head keyd verified", chain: "genesis only", pin: HEAD, args: adopt(), expect: no("stale-chain") },
  { name: "a chain that forks from the head keyd verified", chain: "base", pin: { ...HEAD, oarHash: "ab".repeat(32) }, args: adopt(), expect: no("stale-chain") },
  { name: "a chain that reaches the head keyd verified", chain: "base", pin: HEAD, args: adopt(), expect: ok2 },
  { name: "the next version links to the ring keyd holds", chain: "base", pin: { cgkRingSha256: orgKeyRingSha256(v1.ring) }, args: adopt(), expect: ok2 },
  {
    name: "once keyd holds a ring, a jump past the next version",
    chain: "base",
    pin: { cgkRingSha256: orgKeyRingSha256(v1.ring) },
    args: adopt(jump, [approve(A, canonicalOrgKeyRing(jump.ring), 1, RT + 60_000)]),
    expect: no("version-gap"),
  },
  { name: "a next version that does not link to the ring keyd holds", chain: "base", pin: { cgkRingSha256: "ab".repeat(32) }, args: adopt(), expect: no("prev-hash") },
  // keyd is never handed the freezes: a frozen admin's approval still counts in its narrower rule.
  { name: "keyd does not see freezes", chain: "v1 while B was frozen by C", args: adopt(), expect: ok2 },
];

const json =
  JSON.stringify(
    {
      description:
        "keyd adopting a rotated org CGK (cgk.orgAdopt): chains by name (taken from org-authority/vectors.json, refs resolved as there), the pin keyd holds (`pin`, a case may override fields), each case's arguments and the answer. TS packages/keyd/src/orgCgk.ts and Rust flagship-keyd org_cgk.rs both read it.",
      now: NOW,
      pin,
      chains,
      cases,
    },
    null,
    2,
  ) + "\n";

if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== json) {
    console.error("keyd-org-cgk vectors are stale: run npx tsx tools/keyd-org-cgk-vectors.ts");
    process.exit(1);
  }
  console.log("keyd-org-cgk vectors are fresh");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
  console.log(`wrote ${OUT}`);
}
