import { describe, expect, it } from "vitest";
import {
  KV_STORE_NOTE,
  MANIFEST_SCHEMA_VERSION,
  OBJECTS_STORE_NOTE,
  parseManifest,
  wantsFiles,
  wantsPostgres,
} from "../src/manifest.js";

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

  it("accepts a manifest with NO data field (static site / no data stores) — data is optional", () => {
    const m = valid() as Record<string, unknown>;
    delete m.data;
    const r = parseManifest(m);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Absent ⇒ an empty data object downstream (no stores), not a hard reject.
    expect(r.manifest.data).toBeDefined();
    expect(r.manifest.data.stores).toBeUndefined();
  });

  it("accepts a FULLY minimal manifest (only name + version + runtime) — an AI static site", () => {
    const m = {
      schema_version: 1,
      name: "hello-gate",
      version: "0.0.1",
      runtime: { image: "nginx:alpine", port: 80 },
    };
    const r = parseManifest(m);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The mandatory platform-identity default is applied; the rest are empty/derived.
    expect(r.manifest.access.enabled).toBe(true);
    expect(r.manifest.migration.verification).toBe("standard");
  });

  it("still REJECTS a present-but-non-object data (a malformed field is an error, absence is not)", () => {
    const m = valid() as Record<string, unknown>;
    m.data = "nope";
    const r = parseManifest(m);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(" ")).toMatch(/data must be an object/);
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

  it("accepts prefix routes ending in /* (and /* for the whole app)", () => {
    const m = valid();
    m.access = { ...m.access, public_routes: ["/api/public/*", "/*", "/about"] } as typeof m.access & {
      public_routes: string[];
    };
    const r = parseManifest(m);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.access.public_routes).toEqual(["/api/public/*", "/*", "/about"]);
  });

  it.each([["/api/*/x"], ["/api*"], ["/api/pub*"], ["*"], ["/a?b=1"], ["/a#b"], ["/a b"]])(
    "rejects the public route %j",
    (route) => {
      const m = valid();
      m.access = { ...m.access, public_routes: [route] } as typeof m.access & { public_routes: string[] };
      const r = parseManifest(m);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.errors.join(" ")).toMatch(/public_routes/);
    },
  );
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
  it("a runtime app names its base and needs no image (the box builds it)", () => {
    const m = { ...valid(), runtime: { base: "node-24", port: 3000, start: ["node", "server.js"] } };
    const r = parseManifest(m);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.runtime).toEqual({ base: "node-24", start: ["node", "server.js"], image: "", port: 3000, env: undefined });
    // Once built, the box sets the image beside the base, and both survive a re-parse.
    const built = parseManifest({ ...m, runtime: { ...m.runtime, image: "flagship-vibe-harry--x:1" } });
    expect(built.ok && built.manifest.runtime).toMatchObject({ base: "node-24", image: "flagship-vibe-harry--x:1" });
  });

  it("refuses an unknown base, a shell string as start, and start or root without the right base", () => {
    const errs = (runtime: unknown) => {
      const r = parseManifest({ ...valid(), runtime });
      return r.ok ? [] : r.errors;
    };
    expect(errs({ base: "node-18", port: 3000 }).join()).toMatch(/runtime.base must be one of node-24, python-3.13, static/);
    expect(errs({ base: "node-24", port: 3000, start: "node server.js" }).join()).toMatch(/runtime.start must be a command/);
    expect(errs({ base: "node-24", port: 3000, start: ["node", "a\nb"] }).join()).toMatch(/runtime.start/);
    expect(errs({ image: "x:1", port: 3000, start: ["node"] }).join()).toMatch(/runtime.start needs runtime.base/);
    expect(errs({ base: "node-24", port: 3000, root: "public" }).join()).toMatch(/only for the static runtime/);
    expect(errs({ base: "static", port: 8080, root: "../etc" }).join()).toMatch(/runtime.root must be a folder inside the app/);
    expect(errs({ base: "static", port: 8080, root: "public" })).toEqual([]);
    expect(errs({ port: 3000 }).join()).toMatch(/runtime.image must be a non-empty string/);
  });

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
    const m = { ...valid(), data: { stores: { postgres: true, files: true } } };
    const r = parseManifest(m);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.data.stores).toEqual({ postgres: true, files: true });
    expect(r.manifest.data.path).toBeUndefined();
    expect(r.notes).toBeUndefined();
  });

  it("accepts files only as a boolean", () => {
    for (const files of ["yes", ["a"], 1]) {
      const r = parseManifest({ ...valid(), data: { stores: { files } } });
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.errors.join(" ")).toMatch(/data\.stores\.files must be true or false/);
    }
    const off = parseManifest({ ...valid(), data: { stores: { files: false } } });
    expect(off.ok && wantsFiles(off.manifest.data.stores)).toBe(false);
  });

  it("turns an older objects store into the files folder, with a note that S3 isn't available", () => {
    for (const objects of [true, ["avatars", "uploads"]]) {
      const r = parseManifest({ ...valid(), data: { stores: { postgres: true, objects } } });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.manifest.data.stores).toEqual({ postgres: true, files: true });
      expect(wantsFiles(r.manifest.data.stores)).toBe(true);
      expect(r.notes).toEqual([OBJECTS_STORE_NOTE]);
      expect(OBJECTS_STORE_NOTE).toMatch(/no S3 server/);
      expect(OBJECTS_STORE_NOTE).toMatch(/FLAGSHIP_FILES_DIR/);
    }
    const off = parseManifest({ ...valid(), data: { stores: { objects: false } } });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(off.manifest.data.stores).toEqual({});
    expect(off.notes).toBeUndefined();
  });

  it("turns an older kv store into the app's Postgres database, with a note", () => {
    const r = parseManifest({ ...valid(), data: { stores: { kv: true } } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.data.stores).toEqual({ postgres: true });
    expect(wantsPostgres(r.manifest.data.stores)).toBe(true);
    expect(r.notes).toEqual([KV_STORE_NOTE]);
    expect(KV_STORE_NOTE).toMatch(/UNLOGGED tables for caches, LISTEN\/NOTIFY for pub\/sub/);
    // Named Postgres stores stay as they are; kv adds nothing beyond them.
    const named = parseManifest({ ...valid(), data: { stores: { postgres: ["main"], kv: ["cache"] } } });
    expect(named.ok && named.manifest.data.stores).toEqual({ postgres: ["main"] });
    // A bad kv flag is still an error.
    expect(parseManifest({ ...valid(), data: { stores: { kv: "yes" } } }).ok).toBe(false);
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
