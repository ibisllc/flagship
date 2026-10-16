import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseServiceEnvChange,
  serviceEnvChangeCanonicalBytes,
  serviceEnvValueSha256,
  signServiceEnvChange,
  verifyServiceEnvChange,
  type ServiceEnvChange,
} from "../src/serviceEnvChange.js";
import { hex } from "../src/canonicalBase.js";
import { deriveIRK } from "../src/keys.js";

const V = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/service-env-change/vectors.json"), "utf8"),
) as {
  umkSeedHex: string;
  pub: string;
  cases: Array<{ change: ServiceEnvChange; value?: string; canonical: string; signature: string }>;
  invalid: ServiceEnvChange[];
};
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const irk = deriveIRK({ seed: fromHex(V.umkSeedHex) });

describe("service-env-change vectors (test-vectors/service-env-change/vectors.json)", () => {
  it("signs with the IRK derived from the fixture seed", () => {
    expect(hex(irk.publicKey)).toBe(V.pub);
  });

  it.each(V.cases.map((c, i) => [i, c] as const))("case #%i", (_i, c) => {
    if (c.value !== undefined) expect(serviceEnvValueSha256(c.value)).toBe(c.change.valueSha256);
    expect(new TextDecoder().decode(serviceEnvChangeCanonicalBytes(c.change))).toBe(c.canonical);
    expect(hex(signServiceEnvChange(c.change, irk))).toBe(c.signature);
    expect(verifyServiceEnvChange(c.change, fromHex(c.signature), irk.publicKey)).toBe(true);
    expect(parseServiceEnvChange(c.change)).toEqual(c.change);
  });

  it("a signature names exactly one change: another name, op, value, nonce or service fails", () => {
    const c = V.cases[0]!;
    const sig = fromHex(c.signature);
    const other: Array<Partial<ServiceEnvChange>> = [
      { name: "OTHER_KEY" },
      { op: "unset", valueSha256: "" },
      { valueSha256: serviceEnvValueSha256("sk-attacker") },
      { nonce: "ffffffffffffffffffffffffffffffff" },
      { serviceId: "alice--other" },
      { serverId: "home2.alice.flagship.services" },
      { issuedAt: c.change.issuedAt + 1 },
    ];
    for (const o of other) expect(verifyServiceEnvChange({ ...c.change, ...o }, sig, irk.publicKey)).toBe(false);
  });

  it.each(V.invalid.map((c, i) => [i, c] as const))("refuses invalid #%i", (_i, c) => {
    expect(parseServiceEnvChange(c)).toBeNull();
    expect(() => serviceEnvChangeCanonicalBytes(c)).toThrow();
  });
});
