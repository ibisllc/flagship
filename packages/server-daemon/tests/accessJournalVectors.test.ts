/**
 * Shared verdicts for the access journal's pure rules (entry shape, key, supersession, hash, digest): this file holds the
 * inputs, writes `test-vectors/access-journal.json` with the TypeScript verdicts when UPDATE_ACCESS_VECTORS=1, and otherwise
 * checks the file; rust/crates/flagship-core/tests/access_journal_vectors.rs must give the same verdicts.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AccessJournal, entryHash, entryKey, parseEntry, type AccessEntry } from "../src/accessJournal.js";

const FILE = new URL("../test-vectors/access-journal.json", import.meta.url);
const S = "a".repeat(128);
const S2 = "b".repeat(128);
const AID = "C".repeat(64);

const rank = (target: string, rankName: string, issuedAt: number, sig = S) => ({ kind: "rank", order: { serviceRef: "svc", target, rank: rankName, issuedAt }, signature: sig });
const mode = (m: string, issuedAt: number) => ({ kind: "mode", order: { serviceRef: "svc", mode: m, issuedAt }, signature: S });
const remove = (aid: string, issuedAt: number) => ({ kind: "remove", order: { serviceRef: "svc", aid, issuedAt }, signature: S });
const join_ = (inviteId: unknown, visitorAID: string, redeemedAt: number) => ({
  kind: "join",
  create: inviteId === undefined ? { x: 1 } : { inviteId },
  createSig: S,
  redeem: { secretHash: "h", visitorAID, redeemedAt, aidSig: S },
});
const accept = (inviteId: string, contactAID: string, acceptedAt: number) => ({
  kind: "accept",
  create: { inviteId },
  createSig: S,
  accept: { inviteId, serviceRef: "svc", contactAID, acceptedAt },
  acceptSig: S,
});
const withdraw = (inviteId: string, issuedAt: number) => ({ kind: "withdraw", revoke: { inviteId, issuedAt }, signature: S });
const share = (shareId: string, issuedAt: number, end?: unknown) => ({ kind: "share", grant: { shareId, issuedAt, level: "manage" }, signature: S, ...(end === undefined ? {} : { end }) });

const PARSE: Array<{ name: string; entry: unknown }> = [
  { name: "a rank order", entry: rank("t1", "manager", 10) },
  { name: "a rank with a number for the rank is refused", entry: { kind: "rank", order: { serviceRef: "svc", target: "t", rank: 3, issuedAt: 1 }, signature: S } },
  { name: "a rank with a short signature is refused", entry: rank("t1", "manager", 10, "abc") },
  { name: "an upper-case hex signature is fine", entry: rank("t1", "manager", 10, "A".repeat(128)) },
  { name: "a mode order", entry: mode("restricted", 5) },
  { name: "a mode that is neither open nor restricted is refused", entry: mode("sideways", 5) },
  { name: "a removal", entry: remove("ab12", 7) },
  { name: "a removal without an aid is refused", entry: { kind: "remove", order: { serviceRef: "svc", issuedAt: 1 }, signature: S } },
  { name: "a join keys on the invite and the lower-cased visitor", entry: join_("inv1", AID, 100) },
  { name: "a join without an invite id keys on 'undefined'", entry: join_(undefined, AID, 100) },
  { name: "a join with no redeem is refused", entry: { kind: "join", create: {}, createSig: S } },
  { name: "an accept shares the join key space", entry: accept("inv1", AID, 100) },
  { name: "a withdraw", entry: withdraw("inv1", 9) },
  { name: "a share", entry: share("sh1", 3) },
  { name: "a share ended by a revoke", entry: share("sh1", 3, { kind: "revoke", revoke: { shareId: "sh1" }, signature: S }) },
  { name: "a share ended by a leave", entry: share("sh1", 3, { kind: "leave", leave: { shareId: "sh1" }, signature: S }) },
  { name: "a share with a null end is refused", entry: { ...share("sh1", 3), end: null } },
  { name: "a share end of another kind is refused", entry: share("sh1", 3, { kind: "explode", revoke: {}, signature: S }) },
  { name: "an unknown kind is refused", entry: { kind: "teleport" } },
  { name: "a string is refused", entry: "rank" },
  { name: "an array is refused", entry: [] },
  { name: "null is refused", entry: null },
];

const ADD: Array<{ name: string; entries: unknown[] }> = [
  { name: "the newest order for a target wins, an older or equal one does not", entries: [rank("t1", "member", 10), rank("t1", "manager", 20), rank("t1", "master", 15), rank("t1", "master", 20), rank("t2", "member", 1)] },
  { name: "the same entry twice is not new", entries: [mode("open", 5), mode("open", 5), mode("restricted", 6), mode("open", 4)] },
  { name: "a join already held is kept as it is, a lower-case duplicate too", entries: [join_("inv1", AID, 100), join_("inv1", AID.toLowerCase(), 50), join_("inv1", AID, 200)] },
  { name: "a withdraw already held is kept", entries: [withdraw("inv1", 9), withdraw("inv1", 3), withdraw("inv1", 12)] },
  { name: "a share's end is final", entries: [share("sh1", 3), share("sh1", 5), share("sh1", 4, { kind: "revoke", revoke: { shareId: "sh1" }, signature: S }), share("sh1", 9), share("sh1", 10, { kind: "leave", leave: { shareId: "sh1" }, signature: S2 })] },
  { name: "removals and ranks for the same person are separate keys", entries: [remove("ab", 1), rank("ab", "member", 1), remove("ab", 2)] },
];

const HASH: Array<{ name: string; entry: unknown }> = [
  { name: "key order does not matter", entry: { signature: S, order: { issuedAt: 10, rank: "manager", target: "t1", serviceRef: "svc" }, kind: "rank" } },
  { name: "nested values", entry: share("sh1", 3, { kind: "revoke", revoke: { shareId: "sh1", note: "q\"uote \\ and\nnewline" }, signature: S }) },
  { name: "a join", entry: join_("inv1", AID, 100) },
];

function verdicts() {
  return {
    about: "Shared verdicts for packages/server-daemon/src/accessJournal.ts: written by tests/accessJournalVectors.test.ts (UPDATE_ACCESS_VECTORS=1), read by rust/crates/flagship-core/tests/access_journal_vectors.rs.",
    parse: PARSE.map((c) => {
      const e = parseEntry(c.entry);
      return { ...c, expect: e ? { key: entryKey(e) } : null };
    }),
    hash: HASH.map((c) => ({ ...c, expect: entryHash(parseEntry(c.entry)!) })),
  };
}

async function addVerdicts() {
  const out: Array<{ name: string; entries: unknown[]; expect: { results: boolean[]; keys: string[]; digest: string } }> = [];
  for (const c of ADD) {
    const dir = mkdtempSync(join(tmpdir(), "accjv-"));
    const j = new AccessJournal(join(dir, "j.json"));
    const results: boolean[] = [];
    for (const raw of c.entries) {
      const e = parseEntry(raw) as AccessEntry;
      results.push(await j.add("svc", e));
    }
    out.push({ name: c.name, entries: c.entries, expect: { results, keys: [...j.keys("svc")].sort(), digest: j.digest("svc") } });
  }
  return out;
}

describe("access journal vectors (shared with flagship-core)", () => {
  it("the file holds the TypeScript verdicts", async () => {
    const v = verdicts();
    const doc = { about: v.about, parse: v.parse, add: await addVerdicts(), hash: v.hash };
    if (process.env.UPDATE_ACCESS_VECTORS === "1") writeFileSync(FILE, `${JSON.stringify(doc, null, 2)}\n`);
    expect(JSON.parse(readFileSync(FILE, "utf8"))).toEqual(JSON.parse(JSON.stringify(doc)));
  });
});
