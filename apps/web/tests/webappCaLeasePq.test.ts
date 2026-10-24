// The browser's CA lease PQ gate (lib/maintainerTrust.js gateCaLeasesPq) against the shared
// vectors packages/protocol/test-vectors/ca-lease-pq, and its pin against caLeasePq.ts.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CA_LEASE_PQ_PIN, gateCaLeasesPq } from "../public/webapp/lib/maintainerTrust.js";

const root = join(__dirname, "../../..");
const V = JSON.parse(readFileSync(join(root, "packages/protocol/test-vectors/ca-lease-pq/vectors.json"), "utf8"));

describe("webapp CA lease PQ gate", () => {
  it("accepts exactly the leases each case names", async () => {
    for (const c of V.cases) {
      const got = await gateCaLeasesPq(V.leases, { bindings: c.bindings, endorsements: c.endorsements }, c.pin, V.now);
      expect(got.map((e: { endorsementId: string }) => e.endorsementId), c.name).toEqual(c.accepted);
    }
  });

  it("bakes the same pin as the protocol package", () => {
    const src = readFileSync(join(root, "packages/protocol/src/caLeasePq.ts"), "utf8");
    const ids = (f: string) => [...(new RegExp(`${f}: Object\\.freeze\\(\\[([^\\]]*)\\]\\)`).exec(src)![1]!.matchAll(/"([^"]+)"/g))].map((m) => m[1]);
    expect([...CA_LEASE_PQ_PIN.keyIds]).toEqual(ids("keyIds"));
    expect([...CA_LEASE_PQ_PIN.legacyLeases]).toEqual(ids("legacyLeases"));
  });
});
