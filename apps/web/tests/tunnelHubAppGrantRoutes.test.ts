/**
 * #6 regression — when an AppGrant is presented (and validated) on the
 * HELLO, the hub MUST union its route URLs' hostnames into the SNI
 * allowlist alongside the legacy entitlement canonicals.
 *
 * Earlier shape: the hub validated AppGrants in `authenticateHello`,
 * returned them as `validatedGrants`, and then never used the result —
 * AppGrants were effectively no-ops at runtime. This test pins the
 * fix in place.
 *
 * We exercise the pure helper `appGrantHosts` directly. The wider
 * integration (a daemon that actually populates AppGrants in its HELLO
 * bundle) is a separate task — `EntitlementBundle` doesn't carry an
 * `appGrants` field yet, so today's daemons can't send any.
 */
import { describe, expect, it } from "vitest";
import type { AppGrant } from "@flagship/protocol";
import { appGrantHosts } from "../src/tunnel/tunnelHub.js";

function grant(routes: { url: string; scope: "canonical" | "non-canonical" | "subpath" }[]): AppGrant {
  return {
    grantId: "00000000-0000-4000-8000-000000000000",
    username: "alice",
    appCanonical: "notes@abcdef012345",
    serverDomains: ["home.alice.flagship.services"],
    serverIdentities: [new Uint8Array(32)],
    routes,
    issuedAt: 0,
    expiresAt: 0,
  };
}

describe("appGrantHosts — SNI-allowlist host extraction (#6)", () => {
  it("returns hosts as-is for canonical + non-canonical scopes", () => {
    const g = grant([
      { url: "home.alice.flagship.services", scope: "canonical" },
      { url: "notes.alice.flagship.services", scope: "non-canonical" },
    ]);
    const hosts = appGrantHosts([g]);
    expect(hosts.sort()).toEqual([
      "home.alice.flagship.services",
      "notes.alice.flagship.services",
    ]);
  });

  it("strips the path off subpath-scoped routes (TLS doesn't see paths)", () => {
    const g = grant([
      { url: "home.alice.flagship.services/notes", scope: "subpath" },
      { url: "home.alice.flagship.services/dashboard/inner", scope: "subpath" },
    ]);
    const hosts = appGrantHosts([g]);
    expect(hosts).toEqual(["home.alice.flagship.services"]);
  });

  it("lower-cases every host so the allowlist is case-insensitive", () => {
    const g = grant([
      { url: "Notes.Alice.Flagship.Services", scope: "non-canonical" },
    ]);
    expect(appGrantHosts([g])).toEqual(["notes.alice.flagship.services"]);
  });

  it("deduplicates hosts across grants + routes", () => {
    const g1 = grant([
      { url: "home.alice.flagship.services", scope: "canonical" },
      { url: "notes.alice.flagship.services", scope: "non-canonical" },
    ]);
    const g2 = grant([
      { url: "notes.alice.flagship.services/inbox", scope: "subpath" },
      { url: "office.alice.flagship.services", scope: "canonical" },
    ]);
    const hosts = appGrantHosts([g1, g2]).sort();
    expect(hosts).toEqual([
      "home.alice.flagship.services",
      "notes.alice.flagship.services",
      "office.alice.flagship.services",
    ]);
  });

  it("returns an empty array for zero grants", () => {
    expect(appGrantHosts([])).toEqual([]);
  });

  it("skips routes whose host portion is empty (defensive)", () => {
    // Shouldn't happen post-validation, but cheap to guard.
    const g = grant([{ url: "/just-a-path", scope: "subpath" }]);
    expect(appGrantHosts([g])).toEqual([]);
  });
});
