import { describe, expect, it } from "vitest";
import { userCertSans, tunnelDomainsFor, userZoneOf } from "../src/runtime.js";

describe("userCertSans (per-user cert, task #23)", () => {
  it("collapses to the user zone `[<user>, *.<user>]` — NO two-label-deep wildcard", () => {
    expect(userCertSans("home-box.demo1234.flagship.services", true)).toEqual([
      "demo1234.flagship.services",
      "*.demo1234.flagship.services",
    ]);
  });

  it("two boxes under one user produce the SAME cert SAN set", () => {
    const a = userCertSans("home.harry.flagship.services", true);
    const b = userCertSans("chillout.harry.flagship.services", true);
    expect(a).toEqual(b);
    expect(a).toEqual(["harry.flagship.services", "*.harry.flagship.services"]);
  });

  it("never emits the deprecated `*.<server>.<user>` SAN", () => {
    const sans = userCertSans("home-box.demo1234.flagship.services", true);
    expect(sans).not.toContain("*.home-box.demo1234.flagship.services");
  });

  it("wantWildcard=false yields just the apex (e.g. ACME unavailable)", () => {
    expect(userCertSans("home-box.demo1234.flagship.services", false)).toEqual([
      "home-box.demo1234.flagship.services",
    ]);
  });

  it("falls back to the per-pod wildcard for a degenerate FQDN that doesn't parse", () => {
    // No `<server>.<user>` shape ⇒ userZoneOf returns null ⇒ pod-local wildcard.
    expect(userZoneOf("localhost")).toBeNull();
    expect(userCertSans("localhost", true)).toEqual(["localhost", "*.localhost"]);
  });
});

describe("tunnelDomainsFor (per-user routing claim, task #23)", () => {
  it("claims the box apex PLUS the user-zone wildcard", () => {
    expect(tunnelDomainsFor("home-box.demo1234.flagship.services", true)).toEqual([
      "home-box.demo1234.flagship.services",
      "*.demo1234.flagship.services",
    ]);
  });

  it("the wildcard claim is the USER zone, not the per-server zone", () => {
    const domains = tunnelDomainsFor("home-box.demo1234.flagship.services", true);
    expect(domains).toContain("*.demo1234.flagship.services");
    expect(domains).not.toContain("*.home-box.demo1234.flagship.services");
  });

  it("wantWildcard=false claims only the box apex", () => {
    expect(tunnelDomainsFor("home-box.demo1234.flagship.services", false)).toEqual([
      "home-box.demo1234.flagship.services",
    ]);
  });
});
