import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileJournalStore,
  startJournalPruner,
} from "../src/postRecovery/fileJournalStore.js";
import type { EncryptedJournalRow } from "../src/postRecovery/stableIdReissuer.js";

function row(appId: string, rewrittenAt: number): EncryptedJournalRow {
  return {
    appId,
    ivHex: "00".repeat(12),
    ciphertextHex: "ab".repeat(32),
    tagHex: "00".repeat(16),
    rewrittenAt,
  };
}

function mkPath(): string {
  return join(mkdtempSync(join(tmpdir(), "filejournal-")), "j.jsonl");
}

describe("FileJournalStore", () => {
  it("round-trips a few rows", async () => {
    const store = new FileJournalStore(mkPath());
    await store.append(row("a", 1));
    await store.append(row("b", 2));
    await store.append(row("c", 3));
    const all = await store.listAll();
    expect(all.map((r) => r.appId)).toEqual(["a", "b", "c"]);
    expect(all.map((r) => r.rewrittenAt)).toEqual([1, 2, 3]);
  });

  it("listAll returns [] when the file does not exist", async () => {
    const store = new FileJournalStore(mkPath());
    expect(await store.listAll()).toEqual([]);
  });

  it("deleteOlderThan drops rows below cutoff and keeps the rest", async () => {
    const path = mkPath();
    const store = new FileJournalStore(path);
    await store.append(row("a", 10));
    await store.append(row("b", 20));
    await store.append(row("c", 30));
    const removed = await store.deleteOlderThan(20);
    expect(removed).toBe(1);
    const remaining = await store.listAll();
    expect(remaining.map((r) => r.appId).sort()).toEqual(["b", "c"]);
  });

  it("deleteOlderThan returns 0 + no rewrite when nothing matches", async () => {
    const path = mkPath();
    const store = new FileJournalStore(path);
    await store.append(row("a", 100));
    const before = readFileSync(path, "utf8");
    expect(await store.deleteOlderThan(50)).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("tolerates malformed lines (skips them, keeps rest)", async () => {
    const path = mkPath();
    const store = new FileJournalStore(path);
    await store.append(row("a", 1));
    writeFileSync(path, readFileSync(path, "utf8") + "{not json\n", { flag: "w" });
    await store.append(row("b", 2));
    const all = await store.listAll();
    expect(all.map((r) => r.appId).sort()).toEqual(["a", "b"]);
  });

  it("survives a half-written tmp file (rename atomicity sanity)", async () => {
    const path = mkPath();
    const store = new FileJournalStore(path);
    await store.append(row("a", 1));
    // Simulate a crashed prune by dropping a junk tmp file in place.
    writeFileSync(`${path}.tmp`, "garbage", { mode: 0o600 });
    expect(existsSync(`${path}.tmp`)).toBe(true);
    // Real append should still succeed (it writes to the canonical
    // path, not the tmp), and the journal stays readable.
    await store.append(row("b", 2));
    const all = await store.listAll();
    expect(all).toHaveLength(2);
  });

  it("file mode is 0600 (sensitive state)", async () => {
    const path = mkPath();
    const store = new FileJournalStore(path);
    await store.append(row("a", 1));
    const { statSync } = await import("node:fs");
    const mode = statSync(path).mode & 0o777;
    // On some FS / OS combinations the umask intercepts; we accept
    // any mode where group + world have at most read access stripped.
    expect((mode & 0o077) === 0).toBe(true);
  });
});

describe("startJournalPruner", () => {
  it("prunes once on start + reports the count", async () => {
    const path = mkPath();
    const store = new FileJournalStore(path);
    await store.append(row("a", 100));
    await store.append(row("b", 200));
    let now = 1_000_000;
    const ttlMs = 100;       // anything older than now-100 is pruned
    let reported = -1;
    const handle = startJournalPruner({
      store,
      ttlMs,
      intervalMs: 60 * 60_000,
      now: () => now,
      onPrune: (n) => { reported = n; },
    });
    // Pruner fires the first tick asynchronously; give it a beat.
    await new Promise((r) => setTimeout(r, 25));
    handle.stop();
    // cutoff = now - ttl = 999_900; rows at 100 + 200 are both < cutoff
    expect(reported).toBe(2);
    expect(await store.listAll()).toEqual([]);
  });
});
