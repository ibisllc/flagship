import { describe, expect, it } from "vitest";
import { deriveSWK } from "@flagship/protocol";
import { BackupLoop } from "../src/backupLoop.js";

const umk = { seed: new Uint8Array(32).fill(21) };

describe("BackupLoop", () => {
  it("encrypts and shards each input file", () => {
    const swk = deriveSWK(umk, "srv-1");
    const loop = new BackupLoop({ swk, k: 1, n: 3 });
    const enc = new TextEncoder();
    const report = loop.runOnce([
      { path: "a.txt", content: enc.encode("hello") },
      { path: "b.txt", content: enc.encode("world!") },
    ]);
    expect(report.filesProcessed).toBe(2);
    expect(report.totalShards).toBe(6);
    expect(report.totalShardBytes).toBeGreaterThan(0);
  });

  it("zero files yields a zero report", () => {
    const swk = deriveSWK(umk, "srv-1");
    const loop = new BackupLoop({ swk, k: 1, n: 3 });
    expect(loop.runOnce([])).toEqual({
      filesProcessed: 0,
      totalShards: 0,
      totalShardBytes: 0,
    });
  });
});
