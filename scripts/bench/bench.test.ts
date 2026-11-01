/**
 * The benchmark helpers (scripts/bench, release plan G10): percentiles, process usage, the JSON-lines contract, and
 * the shell drivers parse and print their usage without touching a VM.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pct, procUsage, Recorder } from "./common.js";

describe("bench helpers", () => {
  it("takes nearest-rank percentiles", () => {
    const s = Array.from({ length: 100 }, (_, i) => 100 - i);
    expect(pct(s, 50)).toBe(50);
    expect(pct(s, 95)).toBe(95);
    expect(pct(s, 99)).toBe(99);
    expect(pct([7], 99)).toBe(7);
    expect(Number.isNaN(pct([], 50))).toBe(true);
  });

  it("reads this process's CPU and memory", () => {
    const u = procUsage(process.pid);
    expect(u).not.toBeNull();
    expect(u!.rssKiB).toBeGreaterThan(1024);
    expect(u!.cpuSec).toBeGreaterThanOrEqual(0);
  });

  it("writes one JSON line per result with the host", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-"));
    try {
      const out = join(dir, "r.jsonl");
      const r = new Recorder("unit", out);
      r.latency("rust", "op", [1, 2, 3, 4]);
      r.add("ts", "rate", 12.34567, "op/s", 4);
      const lines = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines).toHaveLength(4);
      expect(lines[0]).toMatchObject({ bench: "unit", impl: "rust", metric: "op_p50", value: 2, unit: "ms", n: 4 });
      expect(lines[3]).toMatchObject({ impl: "ts", metric: "rate", value: 12.346 });
      expect(String(lines[3]!.host)).toMatch(/^[a-z]+\/[a-z0-9]+\/\d+cpu\//);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const script of ["run-vm.sh", "arm64-local.sh"]) {
    it(`${script} parses and prints its usage`, () => {
      const p = join(import.meta.dirname, script);
      expect(spawnSync("bash", ["-n", p]).status).toBe(0);
      const help = spawnSync("bash", [p, "--help"], { encoding: "utf8" });
      if (script === "arm64-local.sh" && !(process.platform === "darwin" && process.arch === "arm64")) return;
      expect(help.status).toBe(0);
      expect(help.stdout).toContain(script.replace(".sh", ""));
      expect(spawnSync("bash", [p, "--nope"], { encoding: "utf8" }).status).toBe(2);
    });
  }
});
