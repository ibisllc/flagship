import { describe, expect, it } from "vitest";
import {
  EGRESS_HOSTS_MAX,
  EGRESS_WHY_MAX,
  egressSuggestions,
  isEgressHost,
  MANIFEST_SCHEMA_VERSION,
  parseManifest,
} from "../src/manifest.js";

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
    const dupMixed = parseManifest(base({ egress: ["a.example.com", { host: "a.example.com", why: "x" }] }));
    expect(!dupMixed.ok && dupMixed.errors.join()).toMatch(/duplicate/);
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

  it("takes {host, why} entries next to plain hosts, keeping the hosts and their reasons", () => {
    const r = parseManifest(
      base({
        subdomain: "weather",
        egress: [{ host: "api.open-meteo.com", why: "  weather forecasts " }, "*.tile.openstreetmap.org", { host: "cdn.example.com" }, { host: "x.example.com", why: "" }],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.network.egress).toEqual(["api.open-meteo.com", "*.tile.openstreetmap.org", "cdn.example.com", "x.example.com"]);
    expect(r.manifest.network.egressWhy).toEqual({ "api.open-meteo.com": "weather forecasts" });
    expect(egressSuggestions(r.manifest.network)).toEqual([
      { host: "api.open-meteo.com", why: "weather forecasts" },
      { host: "*.tile.openstreetmap.org" },
      { host: "cdn.example.com" },
      { host: "x.example.com" },
    ]);
  });

  it("has no egressWhy when no entry gave a reason", () => {
    const r = parseManifest(base({ egress: ["a.example.com", { host: "b.example.com" }] }));
    expect(r.ok && r.manifest.network.egressWhy).toBeUndefined();
    expect(egressSuggestions(undefined)).toEqual([]);
  });

  it.each([
    [{ host: "a.example.com", why: "x".repeat(EGRESS_WHY_MAX + 1) }, /at most 120 characters/],
    [{ host: "a.example.com", why: "two\nlines" }, /one line/],
    [{ host: "a.example.com", why: 5 }, /why must be a string/],
    [{ host: "https://a.example.com", why: "x" }, /network\.egress entry/],
    [{ why: "no host" }, /network\.egress entry/],
    [["a.example.com"], /network\.egress entry/],
  ])("rejects %j", (entry, msg) => {
    const r = parseManifest(base({ egress: [entry] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join("\n")).toMatch(msg);
  });

  it("accepts a why of exactly the limit", () => {
    const r = parseManifest(base({ egress: [{ host: "a.example.com", why: "x".repeat(EGRESS_WHY_MAX) }] }));
    expect(r.ok).toBe(true);
  });
});
