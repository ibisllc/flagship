/**
 * The open-proposal limit held by the insert itself (security report F4, §6): parallel posts can't pass a stale
 * count. Run against the in-memory adapter and the D1 adapter over real SQLite with every migration.
 */
import { describe, expect, it } from "vitest";
import { D1OrgStorage, InMemoryOrgStorage, type OrgStorage } from "../src/index.js";
import { createSqliteD1 } from "./support/sqliteD1.js";

function fresh(adapter: "InMemory" | "D1"): { s: OrgStorage; done: () => void } {
  if (adapter === "InMemory") return { s: new InMemoryOrgStorage(), done: () => {} };
  const db = createSqliteD1();
  return { s: new D1OrgStorage(db), done: () => db.close() };
}

const ORG = "0a".repeat(16);
const proposal = (n: number, decision: unknown = null) => ({
  kind: "proposal" as const,
  key: n.toString(16).padStart(2, "0").repeat(16),
  bodyJson: JSON.stringify({ bundle: { n }, decision }),
  issuedAt: n,
  storedAt: n,
});

describe.each(["InMemory", "D1"] as const)("putOpenProposal (%s)", (adapter) => {
  it("lets in at most the limit of undecided proposals, in parallel too", async () => {
    const { s, done } = fresh(adapter);
    try {
      // A decided proposal doesn't count.
      expect(await s.putOpenProposal(ORG, proposal(1, { approved: true }), 2)).toBe(true);
      const out = await Promise.all(Array.from({ length: 6 }, (_, i) => s.putOpenProposal(ORG, proposal(i + 2), 2)));
      expect(out.filter((x) => x === true)).toHaveLength(2);
      expect(out.filter((x) => x === "full")).toHaveLength(4);
      expect(await s.listObjects(ORG, "proposal")).toHaveLength(3);
      // An existing key is "exists", not "full".
      expect(await s.putOpenProposal(ORG, proposal(1, { approved: true }), 2)).toBe(false);
    } finally {
      done();
    }
  });
});
