import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveAccountId, deriveAppAccountId, deriveContactAccountId } from "../src/keys.js";
import { hex } from "../src/canonicalBase.js";

const V = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/app-account-id/vectors.json"), "utf8"),
) as {
  cases: Array<{ umkSeedHex: string; appRef: string; pubHex: string }>;
  sameAppAnyInviter: { umkSeedHex: string; appRef: string; pubHex: string; oldContactAidHexes: string[] };
  invalidAppRefs: string[];
};
const seed = (h: string) => ({ seed: Uint8Array.from(Buffer.from(h, "hex")) });

describe("per-app account id (test-vectors/app-account-id)", () => {
  it.each(V.cases.map((c) => [c.appRef, c] as const))("%s", (_ref, c) => {
    expect(hex(deriveAppAccountId(seed(c.umkSeedHex), c.appRef).publicKey)).toBe(c.pubHex);
  });

  it("a different app gives a different id; a different person too", () => {
    const pubs = V.cases.map((c) => c.pubHex);
    expect(new Set(pubs).size).toBe(pubs.length);
  });

  it("the same app gives the same id whoever invited them (unlike the old per-author contact id)", () => {
    const s = V.sameAppAnyInviter;
    expect(hex(deriveAppAccountId(seed(s.umkSeedHex), s.appRef).publicKey)).toBe(s.pubHex);
    expect(new Set(s.oldContactAidHexes).size).toBe(2);
  });

  it("is never the account's own id or its old contact id", () => {
    const u = seed(V.cases[0]!.umkSeedHex);
    const app = hex(deriveAppAccountId(u, V.cases[0]!.appRef).publicKey);
    expect(app).not.toBe(hex(deriveAccountId(u).publicKey));
    expect(app).not.toBe(hex(deriveContactAccountId(u, deriveAccountId(u).publicKey).publicKey));
  });

  it.each(V.invalidAppRefs.map((r) => [JSON.stringify(r), r] as const))("refuses app ref %s", (_l, r) => {
    expect(() => deriveAppAccountId(seed(V.cases[0]!.umkSeedHex), r)).toThrow();
  });
});
