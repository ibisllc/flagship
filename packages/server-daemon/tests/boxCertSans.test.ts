import { describe, expect, it } from "vitest";
import { boxCertSans, tunnelDomainsFor, userZoneOf } from "../src/runtime.js";

describe("boxCertSans (per-box wildcard cert, model A′)", () => {
  it("emits the box apex plus its own wildcard `[<server>.<user>, *.<server>.<user>]`", () => {
    expect(boxCertSans("home-box.demo1234.flagship.services", true)).toEqual([
      "home-box.demo1234.flagship.services",
      "*.home-box.demo1234.flagship.services",
    ]);
  });

  it("two boxes under one user produce DISTINCT SAN sets (no duplicate-cert collision)", () => {
    const a = boxCertSans("home.harry.flagship.services", true);
    const b = boxCertSans("chillout.harry.flagship.services", true);
    expect(a).not.toEqual(b);
    expect(a).toEqual(["home.harry.flagship.services", "*.home.harry.flagship.services"]);
    expect(b).toEqual(["chillout.harry.flagship.services", "*.chillout.harry.flagship.services"]);
  });

  it("never emits the retired per-user SANs `<user>` / `*.<user>`", () => {
    const sans = boxCertSans("home-box.demo1234.flagship.services", true);
    expect(sans).not.toContain("demo1234.flagship.services");
    expect(sans).not.toContain("*.demo1234.flagship.services");
  });

  it("wantWildcard=false yields just the apex (e.g. ACME unavailable)", () => {
    expect(boxCertSans("home-box.demo1234.flagship.services", false)).toEqual([
      "home-box.demo1234.flagship.services",
    ]);
  });

  it("a degenerate FQDN still gets its own wildcard (the SAN set is FQDN-shaped, not zone-parsed)", () => {
    expect(userZoneOf("localhost")).toBeNull();
    expect(boxCertSans("localhost", true)).toEqual(["localhost", "*.localhost"]);
  });
});

describe("tunnelDomainsFor (per-box routing claim, model A′)", () => {
  it("claims the box apex PLUS the box's own wildcard", () => {
    expect(tunnelDomainsFor("home-box.demo1234.flagship.services", true)).toEqual([
      "home-box.demo1234.flagship.services",
      "*.home-box.demo1234.flagship.services",
    ]);
  });

  it("the wildcard claim is the BOX zone, not the user zone", () => {
    const domains = tunnelDomainsFor("home-box.demo1234.flagship.services", true);
    expect(domains).toContain("*.home-box.demo1234.flagship.services");
    expect(domains).not.toContain("*.demo1234.flagship.services");
  });

  it("cert SANs and tunnel claims cover the same name space", () => {
    const fqdn = "home-box.demo1234.flagship.services";
    expect(tunnelDomainsFor(fqdn, true)).toEqual(boxCertSans(fqdn, true));
  });

  it("wantWildcard=false claims only the box apex", () => {
    expect(tunnelDomainsFor("home-box.demo1234.flagship.services", false)).toEqual([
      "home-box.demo1234.flagship.services",
    ]);
  });
});
