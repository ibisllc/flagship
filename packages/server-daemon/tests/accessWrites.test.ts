/**
 * The access writes' client side (accessWrites.ts): in `rust` the store and the journal hand every change to the
 * Rust authority and keep its answer as their read copy (TypeScript writes nothing); in `shadow` TypeScript writes
 * and Rust is asked the same change in a dry run over the state before it. The Rust side itself is held to
 * test-vectors/access-writes.json (rust/crates/flagship-access/tests/write_vectors.rs).
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AccessJournal, type AccessEntry } from "../src/accessJournal.js";
import { AccessWrites, sameState } from "../src/accessWrites.js";
import { ServiceAccessStore } from "../src/serviceAccess.js";

const anchors = () => ({ username: "alice", ownerIrkHex: "11".repeat(32), serverDomain: "home.alice.flagship.services" });
const AID = "a1".repeat(32);
const facts = { installed: true, catchingUp: [] };

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "accesswrites-"));
  return { dir, statePath: join(dir, "service-access.json"), journalPath: join(dir, "access-journal.json") };
}

describe("access writes through Rust", () => {
  it("rust: the store's change is Rust's, its state the read copy, and TypeScript writes no file", async () => {
    const { statePath } = fresh();
    const calls: Array<[string, Record<string, unknown>]> = [];
    const w = new AccessWrites("rust", anchors, {
      call: async (op, args) => {
        calls.push([op, args]);
        return { result: true, state: { "alice--club": { mode: "restricted", allow: [AID], groups: {}, roles: {} } } };
      },
    });
    const store = new ServiceAccessStore(statePath);
    await store.load();
    store.setWrites(w);
    expect(await store.addAllowed("alice--club", AID.toUpperCase())).toBe(true);
    expect(calls[0]![0]).toBe("store-mutate");
    expect(calls[0]![1]).toMatchObject({ method: "addAllowed", args: { serviceRef: "alice--club", aid: AID.toUpperCase() }, anchors: anchors() });
    expect(store.mode("alice--club")).toBe("restricted");
    expect(store.allowList("alice--club")).toEqual([AID]);
    expect(existsSync(statePath)).toBe(false);
  });

  it("rust: an unreachable Rust side fails the change (closed), nothing changes here", async () => {
    const { statePath } = fresh();
    const w = new AccessWrites("rust", anchors, { call: async () => { throw new Error("down"); } });
    const store = new ServiceAccessStore(statePath);
    await store.load();
    store.setWrites(w);
    await expect(store.setMode("alice--club", "open")).rejects.toThrow("down");
    expect(store.allowList("alice--club")).toEqual([]);
    expect(w.stats().unavailable).toBe(1);
  });

  it("shadow: TypeScript writes, Rust is asked over the state before, and a difference is counted", async () => {
    const { statePath } = fresh();
    const seen: Array<Record<string, unknown>> = [];
    let answer: unknown = null;
    const w = new AccessWrites("shadow", anchors, {
      call: async (_op, args) => {
        seen.push(args);
        return answer;
      },
      log: () => {},
    });
    const store = new ServiceAccessStore(statePath);
    await store.load();
    store.setWrites(w);
    // Rust's state lacks the roles TypeScript wrote: a difference.
    answer = { result: true, state: { "alice--club": { mode: "open", allow: [AID], groups: {} } } };
    await store.addAllowed("alice--club", AID);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen[0]).toMatchObject({ method: "addAllowed", dryRun: true, state: "{}" });
    expect(existsSync(statePath)).toBe(true);
    expect(w.stats().disagreed).toBe(1);
    answer = { result: false, state: JSON.parse(store.snapshotText()) };
    await store.addAllowed("alice--club", AID);
    await new Promise((r) => setTimeout(r, 0));
    expect(w.stats().disagreed).toBe(1);
  });

  it("rust: the journal keeps what Rust kept, after Rust verified it", async () => {
    const { journalPath, statePath } = fresh();
    const entry = { kind: "withdraw", revoke: { inviteId: "inv", issuedAt: 5 }, signature: "ab".repeat(64) } as AccessEntry;
    const w = new AccessWrites("rust", anchors, {
      call: async (op) => {
        if (op === "journal-add") return { result: "kept", app: { entries: { "withdraw:inv": entry }, peers: ["b.alice.flagship.services"], digest: "d" } };
        return { result: "unverified", app: { entries: {}, peers: [], digest: "d" } };
      },
    });
    const store = new ServiceAccessStore(statePath);
    const j = new AccessJournal(journalPath);
    await j.load();
    j.setWrites({ writes: w, facts: () => facts, stateText: () => store.snapshotText() });
    expect(await j.add("alice--club", entry)).toBe(true);
    expect(j.keys("alice--club")).toEqual(["withdraw:inv"]);
    expect(j.peers("alice--club")).toEqual(["b.alice.flagship.services"]);
    expect(existsSync(journalPath)).toBe(false);
  });

  it("rust: a join Rust refused is asked again once after the device book is refreshed", async () => {
    const { statePath } = fresh();
    let n = 0;
    let refreshed = 0;
    const w = new AccessWrites("rust", anchors, {
      call: async () => ({ result: ++n === 1 ? "refused" : "applied", state: {} }),
    });
    const store = new ServiceAccessStore(statePath);
    const join = { kind: "join" } as AccessEntry;
    const r = await w.apply("alice--club", join, facts, store, async () => "applied", async () => void refreshed++);
    expect(r).toBe("applied");
    expect(refreshed).toBe(1);
    expect(await w.apply("alice--club", { kind: "mode" } as AccessEntry, facts, store, async () => "applied", async () => void refreshed++)).toBe("applied");
    expect(refreshed).toBe(1);
  });

  it("compares states regardless of key order", () => {
    expect(sameState({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 })).toBe(true);
    expect(sameState({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });
});
