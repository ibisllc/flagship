import { describe, expect, it } from "vitest";
import { capabilityChanges, proposeSync } from "../src/buildmodes/syncProposal.js";

const manifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "notes", runtime: { base: "node-24" }, network: { egress: [{ host: "api.example.com", why: "x" }] }, data: { stores: { postgres: true } }, ...over });

describe("sync proposal", () => {
  const base = { "src/a.js": "a1", "src/b.js": "b1", "src/c.js": "c1", "flagship.app.json": manifest() };

  it("takes what only upstream changed, keeps what only the owner changed, and flags both", () => {
    const local = { ...base, "src/b.js": "b-mine", "src/c.js": "c-mine" };
    const upstream = { ...base, "src/a.js": "a2", "src/c.js": "c-theirs", "src/d.js": "d1" };
    const p = proposeSync({ base, local, upstream });
    expect(p.takeUpstream).toEqual(["src/a.js", "src/d.js"]);
    expect(p.conflicts).toEqual(["src/c.js"]);
    expect(p.merged["src/a.js"]).toBe("a2");
    expect(p.merged["src/b.js"]).toBe("b-mine");
    expect(p.merged["src/c.js"]).toBe("c-mine"); // never half-merged
    expect(p.merged["src/d.js"]).toBe("d1");
    expect(p.clean).toBe(false);
  });

  it("applies an upstream removal only where the owner did not touch the file", () => {
    const upstream = { ...base };
    delete (upstream as Record<string, string>)["src/a.js"];
    delete (upstream as Record<string, string>)["src/b.js"];
    const p = proposeSync({ base, local: { ...base, "src/b.js": "b-mine" }, upstream });
    expect(p.merged["src/a.js"]).toBeUndefined();
    expect(p.conflicts).toEqual(["src/b.js"]);
  });

  it("an identical change on both sides needs no action", () => {
    const local = { ...base, "src/a.js": "a2" };
    const p = proposeSync({ base, local, upstream: { ...base, "src/a.js": "a2" } });
    expect(p.alreadyApplied).toEqual(["src/a.js"]);
    expect(p.conflicts).toEqual([]);
    expect(p.clean).toBe(true);
  });

  it("shows a new host, data store or route as a capability change, never as a code change", () => {
    const upstream = {
      ...base,
      "flagship.app.json": manifest({
        network: { egress: [{ host: "api.example.com", why: "x" }, { host: "evil.example.net", why: "y" }] },
        data: { stores: { postgres: true, files: true } },
        access: { public_routes: ["/hook"] },
      }),
    };
    const p = proposeSync({ base, local: base, upstream });
    expect(p.takeUpstream).toEqual(["flagship.app.json"]);
    const sections = Object.fromEntries(p.capabilityChanges.map((c) => [c.section, c.added]));
    expect(sections["network.egress"]).toHaveLength(1);
    expect(sections["data.stores"]).toEqual(['files=true']);
    expect(sections["access"]).toEqual(["public route /hook"]);
    expect(p.clean).toBe(false);
  });

  it("a candidate that narrows capabilities is clean", () => {
    const upstream = { ...base, "flagship.app.json": manifest({ network: { egress: [] } }) };
    const p = proposeSync({ base, local: base, upstream });
    expect(p.capabilityChanges).toEqual([{ section: "network.egress", added: [], removed: [expect.stringContaining("api.example.com")] }]);
    expect(p.clean).toBe(true);
  });

  it("reads a broken manifest as having no capabilities rather than throwing", () => {
    expect(capabilityChanges("{not json", manifest())).toEqual(expect.arrayContaining([expect.objectContaining({ section: "network.egress" })]));
  });
});
