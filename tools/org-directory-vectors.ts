#!/usr/bin/env -S npx tsx
/**
 * Shared vectors for the org directory (packages/protocol/src/orgDirectory.ts; docs/org-directory.md §2):
 * sealed directory entries under the org directory key. TypeScript generates them; the TypeScript,
 * Swift and Kotlin tests check them.
 *
 * Run:          npx tsx tools/org-directory-vectors.ts
 * CI freshness: npx tsx tools/org-directory-vectors.ts --check
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  canonicalOrgDirectorySlicePayload,
  canonicalOrgDirectorySliceWrite,
  orgDirectoryShares,
  orgDirectorySliceContent,
  orgDirectorySliceTag,
  sealOrgDirectorySlice,
  canonicalOrgDirectoryEntryBody,
  canonicalOrgDirectoryWrite,
  orgDirectoryEntryKey,
  sealOrgDirectoryEntry,
  type OrgDirectoryEntry,
} from "../packages/protocol/src/orgDirectory.js";
import { buildOrgSeatBook, orgSha256Hex, orgSeatRolesHash, signOrgApproval, verifyOrgAuthorityChain, type OrgApproval } from "../packages/protocol/src/orgAuthority.js";
import {
  buildOrgProposal,
  canonicalOrgConnector,
  canonicalOrgProposal,
  canonicalOrgProposalDecision,
  orgConnectorKeyId,
  orgConnectorMappingSha256,
  sealOrgConnectorMapping,
  type OrgConnector,
} from "../packages/protocol/src/orgConnector.js";
import { orgKemKeyPair } from "../packages/protocol/src/orgKeyRing.js";
import { hybridSigKeygen } from "../packages/protocol/src/pqHybrid.js";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(ROOT, "packages/protocol/test-vectors/org-directory/vectors.json");
const A = JSON.parse(readFileSync(resolve(ROOT, "packages/protocol/test-vectors/org-authority/vectors.json"), "utf8"));
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const utf8 = (b: Uint8Array): string => new TextDecoder().decode(b);
const fill = (n: number, v: number): Uint8Array => new Uint8Array(n).fill(v);

const ORG: string = A.orgId;
const T = 1_790_000_000_000;
const KEY1 = fill(32, 0x44);
const KEY2 = fill(32, 0x45);
const seatM: string = A.keys["M member"].seatId;
const seatS: string = A.keys["S scoped admin"].seatId;

const ana: OrgDirectoryEntry = {
  seatId: seatM,
  pendingId: "",
  pseudonym: "Ana Pérez",
  displayName: "Ana | Finance, EU",
  email: "",
  externalId: "",
  source: "manual",
  groups: [],
  updatedAt: T,
};
const ben: OrgDirectoryEntry = {
  seatId: "",
  pendingId: "a1".repeat(16),
  pseudonym: "Ben Okafor",
  displayName: "Ben Okafor",
  email: "ben@acme.example",
  externalId: "2819c223-7f76-453a-919d-413861904646",
  source: "scim",
  groups: ["Engineering", "On-call, EU"].sort(),
  updatedAt: T + 1000,
};
const big: OrgDirectoryEntry = {
  ...ana,
  seatId: seatS,
  pseudonym: "林美和",
  displayName: "Lin Meihe",
  source: "ldap",
  externalId: "CN=Lin Meihe,OU=Staff,DC=acme,DC=example",
  groups: Array.from({ length: 12 }, (_, i) => `CN=Group ${String(i).padStart(2, "0")},OU=Groups,DC=acme,DC=example`),
  updatedAt: T + 2000,
};

const sealCase = (name: string, entry: OrgDirectoryEntry, entryId: string, keyVersion: number, key: Uint8Array, nonce: number, issuedAt: number) => {
  const s = sealOrgDirectoryEntry({ orgId: ORG, entryId, keyVersion, directoryKey: key, entry, issuedAt, nonce: fill(12, nonce) });
  return {
    name,
    entry,
    entryId,
    keyVersion,
    directoryKeyHex: hex(key),
    entryKeyHex: hex(orgDirectoryEntryKey(key, ORG, entryId, keyVersion)),
    body: utf8(canonicalOrgDirectoryEntryBody(entry)),
    sealed: s,
    write: utf8(canonicalOrgDirectoryWrite(s)),
  };
};

const entries = [
  sealCase("a seat named by hand (a pipe and a comma in the display name)", ana, "e1".repeat(16), 1, KEY1, 0x01, T),
  sealCase("a pending person from SCIM", ben, "e2".repeat(16), 1, KEY1, 0x02, T + 1000),
  sealCase("an LDAP seat with many groups (a larger bucket), key version 2", big, "e3".repeat(16), 2, KEY2, 0x03, T + 2000),
];

const flip = (h: string, i: number) => h.slice(0, i) + (h[i] === "0" ? "1" : "0") + h.slice(i + 1);
const e0 = entries[0]!.sealed;
const opens = [
  { name: "tampered ciphertext", sealed: { ...e0, sealedHex: flip(e0.sealedHex, 40) }, directoryKeyHex: hex(KEY1), error: "malformed" },
  { name: "the header names another entry", sealed: { ...e0, entryId: "e9".repeat(16) }, directoryKeyHex: hex(KEY1), error: "malformed" },
  { name: "the header names another key version", sealed: { ...e0, keyVersion: 2 }, directoryKeyHex: hex(KEY1), error: "malformed" },
  { name: "another directory key", sealed: e0, directoryKeyHex: hex(KEY2), error: "malformed" },
];

// Bodies a parser must refuse (each is the canonical body with one thing wrong).
const good = entries[0]!.body;
const p = good.split("|");
const withField = (i: number, v: string) => p.map((x, j) => (j === i ? v : x)).join("|");
const badBodies = [
  { name: "padded base64", body: withField(4, `${p[4]}=`) },
  { name: "both seat and pending", body: withField(3, "a1".repeat(16)) },
  { name: "neither seat nor pending", body: withField(2, "") },
  { name: "one field short", body: p.slice(0, 10).join("|") },
  { name: "a leading zero in updatedAt", body: withField(10, `0${p[10]}`) },
  { name: "a control character in the pseudonym", body: withField(4, Buffer.from("Ana\nP").toString("base64url")) },
  { name: "an empty pseudonym", body: withField(4, "") },
  { name: "groups out of order", body: withField(9, ["b", "a"].map((g) => Buffer.from(g).toString("base64url")).join(",")) },
  { name: "an upper-case source", body: withField(8, "Manual") },
  { name: "another tag", body: withField(0, "flagship/org-directory-entry/v2") },
];

const newest = {
  name: "two entries for one seat: the newer updatedAt wins, whatever order they arrive in",
  sealed: [
    sealOrgDirectoryEntry({ orgId: ORG, entryId: "e4".repeat(16), keyVersion: 1, directoryKey: KEY1, entry: { ...ana, pseudonym: "Ana P.", updatedAt: T + 5000 }, issuedAt: T + 5000, nonce: fill(12, 0x04) }),
    entries[0]!.sealed,
  ],
  keys: { "1": hex(KEY1) },
  expect: { seat: seatM, pseudonym: "Ana P." },
};

// ── connectors and proposals ──────────────────────────────────────────
const resolveRefs = (v: unknown): any => {
  if (Array.isArray(v)) return v.map(resolveRefs);
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (typeof o.$key === "string") return A.keys[o.$key].binding;
  if (typeof o.$approval === "number") return A.approvals[o.$approval];
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolveRefs(x)]));
};
const chain = resolveRefs(A.chains[0]);
const T1: number = chain.entries[1].record.issuedAt;
const AT = T1 + 4 * 3_600_000;
const key = (name: string) => {
  const k = A.keys[name];
  return { seatId: k.seatId as string, keyId: k.keyId as string, secret: Uint8Array.from(Buffer.from(k.edSeedHex + k.mldsaSeedHex, "hex")) };
};
const B = key("B admin");
const approve = (k: ReturnType<typeof key>, order: Uint8Array, at: number): OrgApproval =>
  signOrgApproval({ orgId: ORG, oarVersion: 1, order, seatId: k.seatId, adminKeyId: k.keyId, issuedAt: at, notAfter: at + 86_400_000 }, k.secret, { deterministic: true });
const SERVER = "home.acme.flagship.services";
const conn = hybridSigKeygen(fill(32, 0x61), fill(32, 0x62));
const mapping = { attributes: { email: "userName", displayName: "displayName", externalId: "externalId" }, groups: { Engineering: [{ role: "member" }] } };
const connector: OrgConnector = {
  orgId: ORG,
  connectorId: "c1".repeat(16),
  kind: "scim",
  serverDomain: SERVER,
  connectorKeyId: orgConnectorKeyId(conn.publicKey),
  scopes: ["propose-invite", "propose-offboard", "update-entry"],
  mappingSha256: orgConnectorMappingSha256(mapping),
  status: "active",
  issuedAt: AT,
};
const connectorBundle = { connector, connectorPubHex: hex(conn.publicKey), approvals: [approve(B, canonicalOrgConnector(connector), AT)] };
const adminKems = [
  { recipient: `seat:${A.keys["A founder"].seatId}`, seed: fill(32, 0x71) },
  { recipient: `seat:${B.seatId}`, seed: fill(32, 0x72) },
].map((x) => {
  const kp = orgKemKeyPair(x.seed);
  return { recipient: x.recipient, kemPub: kp.kemPub, kemKeyId: kp.kemKeyId, issuedAt: AT, seedHex: hex(x.seed) };
});
const roles = [{ role: "member" as const }];
const invitePayload = canonicalOrgDirectoryEntryBody({ ...ben, updatedAt: AT });
const inviteProposal = buildOrgProposal({
  orgId: ORG,
  proposalId: "d1".repeat(16),
  connectorId: connector.connectorId,
  kind: "invite",
  subject: ben.pendingId,
  roles,
  rolesHash: orgSeatRolesHash(roles),
  payload: invitePayload,
  admins: adminKems,
  issuedAt: AT + 60_000,
  connectorSecret: conn.secretKey,
  randomness: (i) => fill(64, 0x80 + i),
});
const offboardProposal = buildOrgProposal({
  orgId: ORG,
  proposalId: "d2".repeat(16),
  connectorId: connector.connectorId,
  kind: "offboard",
  subject: seatM,
  roles: [],
  rolesHash: "",
  payload: canonicalOrgDirectoryEntryBody({ ...ana, source: "scim", updatedAt: AT }),
  admins: adminKems,
  issuedAt: AT + 120_000,
  connectorSecret: conn.secretKey,
  randomness: (i) => fill(64, 0x90 + i),
});
const decision = { orgId: ORG, proposalId: "d2".repeat(16), decision: "done" as const, refSha256: "ab".repeat(32), issuedAt: AT + 180_000 };
const connectors = {
  connector: connectorBundle,
  connectorBytes: utf8(canonicalOrgConnector(connector)),
  connectorSeedsHex: [hex(fill(32, 0x61)), hex(fill(32, 0x62))],
  mapping,
  admins: adminKems.map((k) => ({ recipient: k.recipient, kemSeedHex: k.seedHex, kemKeyId: k.kemKeyId })),
  proposals: [
    { name: "invite a person SCIM pushed", bundle: inviteProposal, bytes: utf8(canonicalOrgProposal(inviteProposal.proposal)), rolesHash: orgSeatRolesHash(roles), payload: utf8(invitePayload) },
    {
      name: "offboard a seat SCIM disabled",
      bundle: offboardProposal,
      bytes: utf8(canonicalOrgProposal(offboardProposal.proposal)),
      rolesHash: "",
      payload: utf8(canonicalOrgDirectoryEntryBody({ ...ana, source: "scim", updatedAt: AT })),
    },
  ],
  decision: { statement: decision, bytes: utf8(canonicalOrgProposalDecision(decision)) },
  mappingSealed: { directoryKeyHex: hex(KEY1), sealed: sealOrgConnectorMapping(ORG, connector.connectorId, KEY1, 1, mapping, fill(12, 0x0b)) },
  now: AT + 200_000,
};

// ── connector standing: its approver left (chain 0 v2, the founder's removal of C) ──
const Ckey = key("C admin");
const v2At: number = chain.entries[2].record.issuedAt;
const cAt = T1 + 3_600_000;
const byC: OrgConnector = { ...connector, connectorId: "c5".repeat(16), issuedAt: cAt };
const byCBundle = {
  connector: byC,
  connectorPubHex: hex(conn.publicKey),
  approvals: [signOrgApproval({ orgId: ORG, oarVersion: 1, order: canonicalOrgConnector(byC), seatId: Ckey.seatId, adminKeyId: Ckey.keyId, issuedAt: cAt, notAfter: cAt + 86_400_000 }, Ckey.secret, { deterministic: true })],
};
const reAt = v2At + 2 * 86_400_000;
const reapproved: OrgConnector = { ...byC, issuedAt: reAt };
const reBundle = {
  connector: reapproved,
  connectorPubHex: hex(conn.publicKey),
  approvals: [signOrgApproval({ orgId: ORG, oarVersion: 2, order: canonicalOrgConnector(reapproved), seatId: B.seatId, adminKeyId: B.keyId, issuedAt: reAt, notAfter: reAt + 86_400_000 }, B.secret, { deterministic: true })],
};
const standing = {
  description: "orgConnectorStanding over org-authority chains[0].entries[0..2] (C removed at v2; the chain verified with chains[0].noticeOpenedAt) and seatBooks[0] grants",
  entries: 3,
  cases: [
    { name: "approved by C, C still an admin (v1 only)", entries: 2, bundle: byCBundle, now: cAt + 60_000, expect: { state: "ok", leftAt: null } },
    { name: "C left: needs re-approval for 7 days", entries: 3, bundle: byCBundle, now: v2At + 3_600_000, expect: { state: "needs-reapproval", leftAt: v2At, suspendAt: v2At + 7 * 86_400_000 } },
    { name: "C left 8 days ago: suspended", entries: 3, bundle: byCBundle, now: v2At + 8 * 86_400_000, expect: { state: "suspended", leftAt: v2At, suspendAt: v2At + 7 * 86_400_000 } },
    { name: "re-approved by B under v2", entries: 3, bundle: reBundle, now: v2At + 8 * 86_400_000, expect: { state: "ok", leftAt: null } },
  ],
};

// ── a member's slice ─────────────────────────────────────────────────
const sliceNow = T1 + 5 * 3_600_000;
const st01 = verifyOrgAuthorityChain(chain.entries.slice(0, 2), { genesisHash: A.genesisHash, now: sliceNow });
const book01 = buildOrgSeatBook(st01, { grants: resolveRefs(A.seatBooks[0]).grants, revokes: [], now: sliceNow });
const orgServers = [SERVER, "other.acme.flagship.services"];
const named = (k: string, name: string, groups: string[] = []): [string, OrgDirectoryEntry] => [
  A.keys[k].seatId,
  { seatId: A.keys[k].seatId, pendingId: "", pseudonym: name, displayName: name, email: `${name.toLowerCase()}@acme.example`, externalId: `ext-${name}`, source: "manual", groups, updatedAt: T },
];
const dirMap = new Map<string, OrgDirectoryEntry>([named("A founder", "Alma"), named("B admin", "Bo", ["Finance"]), named("C admin", "Cy"), named("M member", "Mia"), named("S scoped admin", "Sam")]);
const sliceSeats = ["S scoped admin", "M member"].map((k) => {
  const seatId = A.keys[k].seatId as string;
  const kp = orgKemKeyPair(fill(32, k.startsWith("S") ? 0x73 : 0x74));
  const content = orgDirectorySliceContent(st01, book01, seatId, dirMap, orgServers, sliceNow);
  const payload = canonicalOrgDirectorySlicePayload(ORG, seatId, content);
  const slice = sealOrgDirectorySlice({ orgId: ORG, seatId, kemPub: kp.kemPub, kemKeyId: kp.kemKeyId, content, directoryKey: KEY1, tagKeyVersion: 1, issuedAt: sliceNow, randomness: fill(64, 0xa0) });
  return {
    name: k,
    seatId,
    kemSeedHex: hex(fill(32, k.startsWith("S") ? 0x73 : 0x74)),
    shares: orgDirectoryShares(st01, book01, seatId, orgServers, sliceNow),
    content,
    payload: utf8(payload),
    contentTag: orgDirectorySliceTag(KEY1, payload),
    slice,
    write: utf8(canonicalOrgDirectorySliceWrite(slice)),
  };
});
const slices = {
  description: "Members' slices over org-authority chains[0].entries[0..1] and seatBooks[0] grants at now; directory entries `directory`; servers `servers`; directory key directoryKeyHex (version 1). orgDirectoryShares, orgDirectorySliceContent (email and externalId emptied, updatedAt 0), canonicalOrgDirectorySlicePayload, orgDirectorySliceTag, canonicalOrgDirectorySliceWrite; openOrgDirectorySlice with the X-Wing seed kemSeedHex returns content.",
  now: sliceNow,
  servers: orgServers,
  directoryKeyHex: hex(KEY1),
  directory: [...dirMap.values()],
  seats: sliceSeats,
};

const doc = {
  description:
    "Org directory entries (docs/org-directory.md §2). entries: canonicalOrgDirectoryEntryBody(entry) == body; orgDirectoryEntryKey(directoryKey, orgId, entryId, keyVersion) == entryKeyHex; sealOrgDirectoryEntry with the 12-byte nonce in sealedHex[0..24) == sealed; canonicalOrgDirectoryWrite(sealed) == write; openOrgDirectoryEntry(sealed, directoryKey) == entry. opens: must throw. badBodies: parseOrgDirectoryEntryBody must throw. newest: openOrgDirectory keeps the newer updatedAt per seat. connectors: canonicalOrgConnector == connectorBytes, verifyOrgConnector with org-authority chain v0..v1 and server home at connector.issuedAt; proposals: canonicalOrgProposal == bytes, verifyOrgProposal(connector, bundle, {rolesHash, now}); openOrgProposal for each admin (X-Wing seed kemSeedHex) == payload; decision bytes.",
  orgId: ORG,
  entries,
  opens,
  badBodies,
  newest,
  connectors,
  standing,
  slices,
  writeSha256: entries.map((e) => orgSha256Hex(new TextEncoder().encode(e.write))),
};

const json = JSON.stringify(doc, null, 1) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== json) {
    console.error("org-directory vectors are stale: run npx tsx tools/org-directory-vectors.ts");
    process.exit(1);
  }
  console.log("org-directory vectors are fresh");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
  console.log(`wrote ${OUT}`);
}
