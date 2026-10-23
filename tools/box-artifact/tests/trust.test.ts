import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../../", import.meta.url).pathname;

describe("release/box-artifact-trust.json", () => {
  const trust = JSON.parse(readFileSync(join(ROOT, "release/box-artifact-trust.json"), "utf8")) as { threshold: number; keys: string[] };

  it("names only keys that are current maintainer holders in .maintainers/keys", () => {
    const dir = join(ROOT, ".maintainers/keys");
    const holders = new Set(readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")).pubkey as string));
    expect(trust.keys.length).toBeGreaterThanOrEqual(1);
    for (const k of trust.keys) expect(holders.has(k), k).toBe(true);
  });

  it("is a well-formed trust set", () => {
    expect(Number.isInteger(trust.threshold) && trust.threshold >= 1).toBe(true);
    expect(trust.keys.length).toBeGreaterThanOrEqual(trust.threshold);
    expect(new Set(trust.keys).size).toBe(trust.keys.length);
    for (const k of trust.keys) expect(k).toMatch(/^[0-9a-f]{64}$/);
  });
});
