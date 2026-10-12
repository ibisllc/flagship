import { describe, expect, it } from "vitest";
import { EGRESS_HOSTS_MAX, isEgressHost, MANIFEST_SCHEMA_VERSION, parseManifest } from "../src/manifest.js";

const base = (network: unknown) => ({
  schema_version: MANIFEST_SCHEMA_VERSION,
  name: "weather",
  version: "1.0.0",
  runtime: { image: "ghcr.io/x/weather:1", port: 8080 },
  network,
});

describe("manifest network.egress", () => {
  it("is absent unless declared", () => {
    const r = parseManifest(base({ subdomain: "weather" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.network.egress).toBeUndefined();
  });

  it("keeps declared hosts in order, with or without a subdomain", () => {
    const a = parseManifest(base({ subdomain: "weather", egress: ["api.open-meteo.com", "*.tile.openstreetmap.org"] }));
    expect(a.ok && a.manifest.network.egress).toEqual(["api.open-meteo.com", "*.tile.openstreetmap.org"]);
    const b = parseManifest(base({ egress: ["api.open-meteo.com"] }));
    expect(b.ok && b.manifest.network.egress).toEqual(["api.open-meteo.com"]);
    expect(b.ok && b.manifest.network.subdomain).toBeUndefined();
  });

  it("accepts an empty list", () => {
    const r = parseManifest(base({ egress: [] }));
    expect(r.ok && r.manifest.network.egress).toEqual([]);
  });

  it.each([
    "https://api.example.com",
    "api.example.com:443",
    "api.example.com/path",
    "API.example.com",
    "localhost",
    "example.com.",
    "*.com",
    "*example.com",
    "a.*.example.com",
    "10.0.0.1",
    "*.10.0.0.1",
    "a,b.example.com",
    "a|b.example.com",
    "",
  ])("rejects %j", (h) => {
    const r = parseManifest(base({ egress: [h] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join("\n")).toMatch(/network\.egress entry/);
  });

  it("rejects duplicates, non-arrays and too many hosts", () => {
    const dup = parseManifest(base({ egress: ["a.example.com", "a.example.com"] }));
    expect(!dup.ok && dup.errors.join()).toMatch(/duplicate/);
    const str = parseManifest(base({ egress: "a.example.com" }));
    expect(!str.ok && str.errors.join()).toMatch(/must be an array/);
    const many = Array.from({ length: EGRESS_HOSTS_MAX + 1 }, (_, i) => `h${i}.example.com`);
    const big = parseManifest(base({ egress: many }));
    expect(!big.ok && big.errors.join()).toMatch(/at most/);
  });

  it("isEgressHost matches the parser", () => {
    expect(isEgressHost("api.example.com")).toBe(true);
    expect(isEgressHost("*.example.co.uk")).toBe(true);
    expect(isEgressHost("1.2.3.4")).toBe(false);
    expect(isEgressHost(`${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.com`)).toBe(false);
  });
});
