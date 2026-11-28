import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { appAccountZone, deriveAccountId, deriveAppAccountId, deriveContactAccountId } from "../src/keys.js";
import { hex } from "../src/canonicalBase.js";

const V = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/app-account-id/vectors.json"), "utf8"),
) as {
  info: string;
  cases: Array<{ umkSeedHex: string; accountZone: string; appRef: string; pubHex: string }>;
  sameAppAnyInviter: { umkSeedHex: string; accountZone: string; appRef: string; pubHex: string; oldContactAidHexes: string[] };
  sameAppOtherHost: { pubHexes: string[] };
  accountZones: Array<{ serverId: string; dataApex: string; zone: string | null }>;
  invalidAppRefs: string[];
  invalidAccountZones: string[];
};
const seed = (h: string) => ({ seed: Uint8Array.from(Buffer.from(h, "hex")) });

describe("per-app account id v2 (test-vectors/app-account-id)", () => {
  it("is the v2 info", () => expect(V.info).toBe("flagship/app-aid/v2"));

  it.each(V.cases.map((c) => [`${c.accountZone} ${c.appRef}`, c] as const))("%s", (_l, c) => {
    expect(hex(deriveAppAccountId(seed(c.umkSeedHex), c.accountZone, c.appRef).publicKey)).toBe(c.pubHex);
  });

  it("a different app, host account or person gives a different id", () => {
    const pubs = V.cases.map((c) => c.pubHex);
    expect(new Set(pubs).size).toBe(pubs.length);
    expect(new Set(V.sameAppOtherHost.pubHexes).size).toBe(2);
  });

  it("the same app gives the same id whoever invited them (unlike the old per-author contact id)", () => {
    const s = V.sameAppAnyInviter;
    expect(hex(deriveAppAccountId(seed(s.umkSeedHex), s.accountZone, s.appRef).publicKey)).toBe(s.pubHex);
    expect(new Set(s.oldContactAidHexes).size).toBe(2);
  });

  it("is never the account's own id or its old contact id", () => {
    const c = V.cases[0]!;
    const u = seed(c.umkSeedHex);
    const app = hex(deriveAppAccountId(u, c.accountZone, c.appRef).publicKey);
    expect(app).not.toBe(hex(deriveAccountId(u).publicKey));
    expect(app).not.toBe(hex(deriveContactAccountId(u, deriveAccountId(u).publicKey).publicKey));
  });

  it.each(V.accountZones.map((z) => [`${z.serverId} @ ${z.dataApex}`, z] as const))("zone of %s", (_l, z) => {
    expect(appAccountZone(z.serverId, z.dataApex)).toBe(z.zone);
  });

  it.each(V.invalidAppRefs.map((r) => [JSON.stringify(r), r] as const))("refuses app ref %s", (_l, r) => {
    expect(() => deriveAppAccountId(seed(V.cases[0]!.umkSeedHex), V.cases[0]!.accountZone, r)).toThrow();
  });

  it.each(V.invalidAccountZones.map((z) => [JSON.stringify(z), z] as const))("refuses account zone %s", (_l, z) => {
    expect(() => deriveAppAccountId(seed(V.cases[0]!.umkSeedHex), z, V.cases[0]!.appRef)).toThrow();
  });
});
