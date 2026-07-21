import { describe, expect, it } from "vitest";
import { swkOps } from "./helpers/keyCustody.js";
import { deriveSWK } from "@flagship/protocol";
import { BackupLoop } from "../src/backupLoop.js";

const umk = { seed: new Uint8Array(32).fill(21) };

describe("BackupLoop (legacy dry-run — no shipping wired)", () => {
  it("encrypts and shards each input file", async () => {
    const swk = deriveSWK(umk, "srv-1");
    const loop = new BackupLoop({ swk: swkOps(swk), k: 1, n: 3, initiallyEnabled: true });
    const enc = new TextEncoder();
    const report = await loop.runOnce([
      { path: "a.txt", content: enc.encode("hello") },
      { path: "b.txt", content: enc.encode("world!") },
    ]);
    expect(report.filesProcessed).toBe(2);
    expect(report.totalShards).toBe(6);
    expect(report.totalShardBytes).toBeGreaterThan(0);
  });

  it("zero files yields a zero report", async () => {
    const swk = deriveSWK(umk, "srv-1");
    const loop = new BackupLoop({ swk: swkOps(swk), k: 1, n: 3, initiallyEnabled: true });
    const r = await loop.runOnce([]);
    expect(r.filesProcessed).toBe(0);
    expect(r.totalShards).toBe(0);
    expect(r.totalShardBytes).toBe(0);
    expect(r.shardsPlaced).toBe(0);
  });
});
