import { describe, expect, it } from "vitest";
import { capabilitiesOf, capabilityDigest, diffCapabilities, type AppManifest } from "../src/index.js";

const base = (over: Partial<AppManifest> = {}): AppManifest => ({
  schema_version: 1, name: "n", version: "1.0.0",
  runtime: { image: "i", port: 8080, env: { A: "1" } },
  data: { stores: { postgres: true, files: true } },
  network: { subdomain: "notes", egress: ["api.example.com"] },
  access: { enabled: true, default_role: "member", public_routes: ["/"] },
  migration: { verification: "standard" },
  ...over,
});

describe("manifest capabilities", () => {
  it("a code-only change (version, image, description) asks for no new authority", () => {
    const a = capabilitiesOf(base());
    const b = capabilitiesOf(base({ version: "2.0.0", description: "new", runtime: { image: "other", port: 8080, env: { A: "9" } } }));
    expect(diffCapabilities(a, b).needsApproval).toBe(false);
    expect(capabilityDigest(a)).toBe(capabilityDigest(b));
  });

  it("each kind of added authority is named and needs approval", () => {
    const a = capabilitiesOf(base());
    const cases: Array<[Partial<AppManifest>, string]> = [
      [{ network: { subdomain: "notes", egress: ["api.example.com", "evil.example.org"] } }, "egress"],
      [{ data: { stores: { postgres: ["default", "analytics"], files: true } } }, "postgres"],
      [{ browser: { domains: ["accounts.google.com"] } }, "browserDomains"],
      [{ access: { enabled: true, default_role: "member", public_routes: ["/", "/*"] } }, "publicRoutes"],
      [{ access: { enabled: true, default_role: "member", queryable_by: ["other-app"] } }, "queryableBy"],
      [{ runtime: { image: "i", port: 8080, env: { A: "1", NEW_SECRET: "x" } } }, "envKeys"],
      [{ network: { subdomain: "elsewhere", egress: ["api.example.com"] } }, "subdomain"],
      [{ runtime: { image: "i", port: 9090 } }, "port"],
    ];
    for (const [over, expected] of cases) {
      const d = diffCapabilities(a, capabilitiesOf(base(over)));
      expect(d.needsApproval, expected).toBe(true);
      expect(d.expanded.map((c) => c.capability), expected).toContain(expected);
    }
    const files = diffCapabilities(capabilitiesOf(base({ data: { stores: { postgres: true } } })), a);
    expect(files.expanded.map((c) => c.capability)).toEqual(["files"]);
  });

  it("giving authority up does not need approval and is reported as narrowed", () => {
    const d = diffCapabilities(capabilitiesOf(base()), capabilitiesOf(base({ network: { subdomain: "notes", egress: [] } })));
    expect(d.needsApproval).toBe(false);
    expect(d.narrowed).toEqual([{ capability: "egress", added: [], removed: ["api.example.com"] }]);
  });

  it("the digest changes with authority and ignores ordering and case", () => {
    const a = capabilityDigest(capabilitiesOf(base({ network: { subdomain: "Notes", egress: ["b.example.com", "A.example.com"] } })));
    const b = capabilityDigest(capabilitiesOf(base({ network: { subdomain: "notes", egress: ["a.example.com", "b.example.com"] } })));
    expect(a).toBe(b);
    expect(a).not.toBe(capabilityDigest(capabilitiesOf(base())));
  });
});
