import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CaEndorsement } from "@ibisllc/maintainers";
import { describe, expect, it } from "vitest";
import { CA_LEASE_PQ_PIN, caLeasePqPinConfigured, gateCaLeasesPq, type CaLeasePqPin } from "../src/caLeasePq.js";

const V = JSON.parse(readFileSync(join(__dirname, "../test-vectors/ca-lease-pq/vectors.json"), "utf8")) as {
  now: number;
  leases: CaEndorsement[];
  cases: { name: string; pin: CaLeasePqPin; bindings: unknown[]; endorsements: unknown[]; accepted: string[] }[];
};

describe("the CA lease's PQ companion", () => {
  it.each(V.cases)("$name", (c) => {
    const r = gateCaLeasesPq(V.leases, { bindings: c.bindings, endorsements: c.endorsements }, { pin: c.pin, now: V.now });
    expect(r.accepted.map((e) => e.endorsementId)).toEqual(c.accepted);
    expect(r.accepted.length + r.refused.length).toBe(V.leases.length);
  });

  it("ships with the release key pinned (the 2026-10-26 ceremony); the committed leases count as signed before the cut-over", () => {
    expect(caLeasePqPinConfigured(CA_LEASE_PQ_PIN)).toBe(true);
    expect([...CA_LEASE_PQ_PIN.keyIds]).toEqual(["1c07f1ffe8e6e8b89d8b8c8c14544d6f065decfa67ea76ec50c30fadaadb9434"]);
    expect(CA_LEASE_PQ_PIN.legacyLeases.length).toBeGreaterThan(0);
  });
});
