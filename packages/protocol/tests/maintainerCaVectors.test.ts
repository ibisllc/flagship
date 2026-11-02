// The maintainer ca-track vectors the Rust relay's port (flagship-relay mesh/ca.rs) replays: the TS library must still
// give the same pin hashes, accepted chain lengths and authorized CA keys at every probe time.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { authorizedCaKeys, mandatePinHash, verifyMandateChainFromPin, type CaEndorsement, type Mandate } from "@ibisllc/maintainers";

const V = JSON.parse(readFileSync(new URL("../test-vectors/maintainer-ca/vectors.json", import.meta.url), "utf8")) as {
  pinHashes: Array<{ name: string; mandate: Mandate; pinHash: string }>;
  cases: Array<{ name: string; pin: string; mandates: Mandate[]; endorsements: CaEndorsement[]; chainLength: number; at: Array<{ now: number; keys: unknown }> }>;
};

describe("maintainer-ca vectors", () => {
  it.each(V.pinHashes.map((p) => [p.name, p] as const))("pin hash: %s", (_n, p) => {
    expect(mandatePinHash(p.mandate)).toBe(p.pinHash);
  });

  it.each(V.cases.map((c) => [c.name, c] as const))("chain and CA keys: %s", (_n, c) => {
    const chain = verifyMandateChainFromPin(c.pin, c.mandates);
    expect(chain.validMandates.length).toBe(c.chainLength);
    for (const a of c.at) expect(authorizedCaKeys(c.endorsements, chain, new Date(a.now))).toEqual(a.keys);
  });
});
