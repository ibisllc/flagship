import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveServerArchiveKey } from "../src/keys.js";
import { hex } from "../src/canonicalBase.js";

const V = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/server-archive/vectors.json"), "utf8"),
) as {
  cases: Array<{ umkSeedHex: string; archiveIdHex: string; keyHex: string }>;
  invalidArchiveIds: string[];
};
const seed = (h: string) => ({ seed: Uint8Array.from(Buffer.from(h, "hex")) });

describe("server archive key (test-vectors/server-archive)", () => {
  it.each(V.cases.map((c) => [c.archiveIdHex, c] as const))("%s", (_id, c) => {
    expect(hex(deriveServerArchiveKey(seed(c.umkSeedHex), c.archiveIdHex))).toBe(c.keyHex);
  });
  it("a different archive id gives a different key", () => {
    expect(new Set(V.cases.map((c) => c.keyHex)).size).toBe(V.cases.length);
  });
  it.each(V.invalidArchiveIds.map((r) => [JSON.stringify(r), r] as const))("refuses archive id %s", (_l, r) => {
    expect(() => deriveServerArchiveKey(seed(V.cases[0]!.umkSeedHex), r)).toThrow();
  });
});
