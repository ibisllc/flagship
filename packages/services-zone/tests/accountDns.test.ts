import { describe, expect, it } from "vitest";
import {
  challengeHostOf,
  shieldNames,
  userZoneOf,
} from "../src/accountDns.js";

describe("userZoneOf", () => {
  it("returns the account zone of a box or a tier-2 service name", () => {
    expect(userZoneOf("home.alice.flagship.services")).toBe("alice.flagship.services");
    expect(userZoneOf("blog.alice.flagship.services")).toBe("alice.flagship.services");
    expect(userZoneOf("HOME.Alice.flagship.services.")).toBe("alice.flagship.services");
  });

  it("is apex-relative, so the gym's deeper apex yields the right account", () => {
    expect(userZoneOf("home.alice.gym.flagship.services", "gym.flagship.services")).toBe(
      "alice.gym.flagship.services",
    );
  });

  it("refuses names with no label ahead of the user, other apexes and bad users", () => {
    expect(userZoneOf("alice.flagship.services")).toBeNull();
    expect(userZoneOf("home.alice.example.com")).toBeNull();
    expect(userZoneOf("home.a.flagship.services")).toBeNull();
    expect(userZoneOf("home._x.flagship.services")).toBeNull();
  });
});

describe("challenge and shield names", () => {
  it("maps a challenge record back to the host it protects", () => {
    expect(challengeHostOf("_acme-challenge.home.alice.flagship.services")).toBe("home.alice.flagship.services");
    expect(challengeHostOf("home.alice.flagship.services")).toBeNull();
    expect(challengeHostOf("_acme-challenge.*.alice.flagship.services")).toBeNull();
    expect(challengeHostOf("_acme-challenge.")).toBeNull();
  });

  it("shields a box at its apex and wildcard, a service at its own name only", () => {
    expect(shieldNames("home.alice.flagship.services", true)).toEqual([
      "home.alice.flagship.services",
      "*.home.alice.flagship.services",
    ]);
    expect(shieldNames("blog.alice.flagship.services", false)).toEqual(["blog.alice.flagship.services"]);
  });
});
