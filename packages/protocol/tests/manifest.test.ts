import { describe, expect, it } from "vitest";
import { MANIFEST_SCHEMA_VERSION, parseManifest } from "../src/manifest.js";

const valid = () => ({
  schema_version: MANIFEST_SCHEMA_VERSION,
  name: "family-habit-tracker",
  description: "Track family habits together",
  version: "0.3.1",
  runtime: {
    image: "ghcr.io/harry/family-habit-tracker:0.3.1",
    port: 8080,
    env: { NODE_ENV: "production" },
  },
  data: { path: "/data" },
  network: { subdomain: "habits" },
  access: { enabled: true, default_role: "viewer", custom_roles: ["parent", "child"] },
  migration: { verification: "standard" },
});

describe("parseManifest — happy path", () => {
  it("accepts a fully valid manifest", () => {
    const r = parseManifest(valid());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.name).toBe("family-habit-tracker");
    expect(r.manifest.runtime.image).toContain("habit-tracker");
    expect(r.manifest.access.custom_roles).toEqual(["parent", "child"]);
  });

  it("accepts a minimal valid manifest", () => {
    const m = {
      schema_version: 1,
      name: "x",
      version: "0.0.1",
      runtime: { image: "alpine:3", port: 80 },
      data: { path: "/d" },
      network: { subdomain: "x" },
      access: { enabled: true, default_role: "owner" },
      migration: { verification: "standard" },
    };
    const r = parseManifest(m);
    expect(r.ok).toBe(true);
  });

  it("accepts public_routes for opening anonymous access on specific paths", () => {
    const m = valid();
    m.access = {
      ...m.access,
      public_routes: ["/", "/about"],
    } as typeof m.access & { public_routes: string[] };
    const r = parseManifest(m);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.access.public_routes).toEqual(["/", "/about"]);
  });
});

describe("parseManifest — schema_version", () => {
  it("rejects wrong schema_version", () => {
    const m = { ...valid(), schema_version: 999 };
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
  });
});

describe("parseManifest — name and version", () => {
  it("rejects names with uppercase", () => {
    const m = { ...valid(), name: "MyApp" };
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((s) => s.includes("name"))).toBe(true);
  });

  it("rejects names starting with hyphen", () => {
    const m = { ...valid(), name: "-x" };
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
  });

  it("rejects a description longer than 30 chars", () => {
    const m = { ...valid(), description: "a".repeat(31) };
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((s) => s.includes("description"))).toBe(true);
  });

  it("accepts a description of exactly 30 chars", () => {
    const r = parseManifest({ ...valid(), description: "a".repeat(30) });
    expect(r.ok).toBe(true);
  });

  it("rejects non-semver versions", () => {
    const m = { ...valid(), version: "v1" };
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
  });

  it("accepts pre-release semver", () => {
    const m = { ...valid(), version: "1.2.3-beta.1" };
    expect(parseManifest(m).ok).toBe(true);
  });
});

describe("parseManifest — runtime", () => {
  it("rejects missing image", () => {
    const m = valid();
    delete (m.runtime as { image?: string }).image;
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
  });

  it("rejects out-of-range port", () => {
    const m = valid();
    m.runtime.port = 0;
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
  });

  it("rejects FLAGSHIP_-prefixed env vars (reserved)", () => {
    const m = valid();
    m.runtime.env = { FLAGSHIP_USER: "x" };
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((s) => s.includes("FLAGSHIP_"))).toBe(true);
  });
});

describe("parseManifest — data", () => {
  it("rejects relative data.path", () => {
    const m = valid();
    m.data.path = "relative/path";
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
  });

  it("accepts data.excludes", () => {
    const m = { ...valid(), data: { path: "/data", excludes: ["/data/cache"] } };
    expect(parseManifest(m).ok).toBe(true);
  });
});

describe("parseManifest — access (the platform-mandated piece)", () => {
  it("REJECTS access.enabled: false (no opting out)", () => {
    const m = { ...valid(), access: { enabled: false, default_role: "viewer" } };
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((s) => s.includes("enabled"))).toBe(true);
  });

  it("rejects unknown default_role", () => {
    const m = valid();
    (m.access as { default_role: string }).default_role = "godmode";
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
  });

  it("rejects malformed custom_roles entries", () => {
    const m = valid();
    m.access.custom_roles = ["BadCase"];
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
  });
});

describe("parseManifest — migration verification levels", () => {
  it("accepts standard verification", () => {
    const m = { ...valid(), migration: { verification: "standard" } };
    expect(parseManifest(m).ok).toBe(true);
  });

  it("accepts elevated verification", () => {
    const m = { ...valid(), migration: { verification: "elevated" } };
    expect(parseManifest(m).ok).toBe(true);
  });

  it("rejects unknown verification level", () => {
    const m = { ...valid(), migration: { verification: "yolo" } };
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
  });

  it("rejects missing verification field (every app is transferable; user must declare level)", () => {
    const m = { ...valid(), migration: {} };
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
  });

  it("does NOT support portable: false (every app is transferable now)", () => {
    const m = { ...valid(), migration: { portable: false } };
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
  });
});

describe("parseManifest — data.stores (unified data layer)", () => {
  it("accepts a manifest with no data.path when data.stores is declared", () => {
    const m = { ...valid(), data: { stores: { postgres: true, objects: true, kv: false } } };
    const r = parseManifest(m);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.data.stores).toEqual({ postgres: true, objects: true, kv: false });
    expect(r.manifest.data.path).toBeUndefined();
  });

  it("accepts data.path AND data.stores together (path = ephemeral scratch)", () => {
    const m = {
      ...valid(),
      data: { path: "/cache", stores: { postgres: true } },
    };
    const r = parseManifest(m);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.data.path).toBe("/cache");
    expect(r.manifest.data.stores?.postgres).toBe(true);
  });

  it("rejects non-boolean store flags (so a typo can't silently disable persistence)", () => {
    const m = { ...valid(), data: { stores: { postgres: "yes" } } };
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(" ")).toMatch(/data\.stores\.postgres must be a boolean/);
  });

  it("rejects unknown store flags (typo defense — `objevct: true` would otherwise be silently ignored)", () => {
    const m = { ...valid(), data: { stores: { objevct: true } } };
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(" ")).toMatch(/data\.stores\.objevct.*not a recognized store flag/);
  });

  it("rejects data.stores being a non-object value", () => {
    const m = { ...valid(), data: { stores: "all-of-them" } };
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
  });

  it("accepts an empty data block (pure-compute apps) — no persistence required", () => {
    const m = { ...valid(), data: {} };
    const r = parseManifest(m);
    expect(r.ok).toBe(true);
  });
});

describe("parseManifest — input shape", () => {
  it("rejects non-object input", () => {
    expect(parseManifest("string").ok).toBe(false);
    expect(parseManifest(null).ok).toBe(false);
    expect(parseManifest([]).ok).toBe(false);
  });

  it("collects multiple errors instead of failing on the first", () => {
    const m = {
      schema_version: 99,
      name: "BadName",
      version: "vX",
      runtime: { image: "", port: -1 },
      data: { path: "rel" },
      network: { subdomain: "BAD" },
      access: { enabled: false },
      migration: { verification: "yolo" },
    };
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.length).toBeGreaterThan(3);
  });
});

describe("parseManifest — browser field (pod-resident Chromium gate)", () => {
  it("manifest without `browser` parses fine; the field stays undefined", () => {
    const r = parseManifest(valid());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.browser).toBeUndefined();
  });

  it("accepts a literal-host domain list", () => {
    const m = {
      ...valid(),
      browser: { domains: ["amazon.com", "accounts.google.com"] },
    };
    const r = parseManifest(m);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.browser?.domains).toEqual(["amazon.com", "accounts.google.com"]);
  });

  it("accepts wildcard hosts (*.example.com)", () => {
    const m = { ...valid(), browser: { domains: ["*.example.com"] } };
    const r = parseManifest(m);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.browser?.domains).toEqual(["*.example.com"]);
  });

  it("accepts a mixed literal + wildcard list (apex + subdomains)", () => {
    const m = {
      ...valid(),
      browser: { domains: ["example.com", "*.example.com"] },
    };
    expect(parseManifest(m).ok).toBe(true);
  });

  it("captures the login_required UX hint", () => {
    const m = {
      ...valid(),
      browser: { domains: ["amazon.com"], login_required: true },
    };
    const r = parseManifest(m);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.browser?.login_required).toBe(true);
  });

  it.each([
    ["scheme prefix", "https://example.com"],
    ["path suffix", "example.com/login"],
    ["single-label host", "localhost"],
    ["trailing dot", "example.com."],
    ["leading dot", ".example.com"],
    ["multiple wildcards", "*.*.example.com"],
    ["uppercase", "EXAMPLE.com"],
    ["underscore", "ex_ample.com"],
    ["empty string", ""],
  ])("rejects malformed domain entry: %s (%s)", (_label, bad) => {
    const m = { ...valid(), browser: { domains: [bad] } };
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
  });

  it("rejects duplicate domain entries", () => {
    const m = { ...valid(), browser: { domains: ["x.com", "x.com"] } };
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join("|")).toContain("duplicate");
  });

  it("rejects non-array domains", () => {
    const m = { ...valid(), browser: { domains: "amazon.com" } };
    expect(parseManifest(m).ok).toBe(false);
  });

  it("rejects unknown fields under browser to surface typos", () => {
    const m = {
      ...valid(),
      browser: { domains: ["amazon.com"], domain: ["typo"] },
    };
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join("|")).toContain("not a recognized field");
  });

  it("rejects login_required of a non-boolean type", () => {
    const m = {
      ...valid(),
      browser: { domains: ["amazon.com"], login_required: "yes" },
    };
    expect(parseManifest(m).ok).toBe(false);
  });

  it("rejects browser as a non-object", () => {
    const m = { ...valid(), browser: "amazon.com" };
    expect(parseManifest(m).ok).toBe(false);
  });
});

describe("parseManifest — distribution field (update-pack policy)", () => {
  it("manifest without `distribution` parses fine; the field stays undefined", () => {
    const m = valid();
    const r = parseManifest(m);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.distribution).toBeUndefined();
  });

  it("accepts distribution.public true (open-source apps)", () => {
    const m = { ...valid(), distribution: { public: true } };
    const r = parseManifest(m);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.distribution?.public).toBe(true);
  });

  it("accepts distribution.public false explicitly", () => {
    const m = { ...valid(), distribution: { public: false } };
    const r = parseManifest(m);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.distribution?.public).toBe(false);
  });

  it("rejects distribution.public of a non-boolean type", () => {
    const m = { ...valid(), distribution: { public: "yes" } };
    expect(parseManifest(m).ok).toBe(false);
  });

  it("rejects unknown fields under distribution to surface typos", () => {
    const m = {
      ...valid(),
      distribution: { public: true, secret: false },
    };
    expect(parseManifest(m).ok).toBe(false);
  });

  it("rejects distribution as a non-object", () => {
    const m = { ...valid(), distribution: "public" };
    expect(parseManifest(m).ok).toBe(false);
  });
});

describe("matchBrowserDomain — DomainGate uses this exact matcher", () => {
  it("literal hosts match exactly, no subdomain leakage", async () => {
    const { matchBrowserDomain } = await import("../src/manifest.js");
    expect(matchBrowserDomain("amazon.com", "amazon.com")).toBe(true);
    expect(matchBrowserDomain("amazon.com", "www.amazon.com")).toBe(false);
    expect(matchBrowserDomain("amazon.com", "evilamazon.com")).toBe(false);
  });

  it("wildcard *.example.com matches any subdomain but NOT the apex", async () => {
    const { matchBrowserDomain } = await import("../src/manifest.js");
    expect(matchBrowserDomain("*.example.com", "foo.example.com")).toBe(true);
    expect(matchBrowserDomain("*.example.com", "deep.foo.example.com")).toBe(true);
    expect(matchBrowserDomain("*.example.com", "example.com")).toBe(false);
    expect(matchBrowserDomain("*.example.com", "evilexample.com")).toBe(false);
    expect(matchBrowserDomain("*.example.com", "fooexample.com")).toBe(false);
  });
});
