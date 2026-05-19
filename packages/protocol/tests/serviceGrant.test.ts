/**
 * ServiceGrant envelope tests.
 *
 * The grant is the cornerstone of the ServiceGrant-based authorization
 * model (Thread C of the design pass). It subsumes RootEntitlement,
 * ServiceEntitlement, and ClaimUrlCapability into a single 7-day
 * IRK-signed envelope.
 */
import { describe, expect, it } from "vitest";
import {
  type ServiceGrant,
  serviceGrantActiveAt,
  serviceGrantAuthorizesPod,
  serviceGrantAuthorizesUrl,
  serviceGrantId,
  authorStableId,
  signServiceGrant,
  verifyServiceGrant,
} from "../src/auth.js";
import { deriveIRK, deriveSTK, deriveSWK } from "../src/keys.js";

const umk = { seed: new Uint8Array(32).fill(7) };
const otherUmk = { seed: new Uint8Array(32).fill(8) };

function baseGrant(overrides: Partial<ServiceGrant> = {}): ServiceGrant {
  const stkA = deriveSTK(deriveSWK(umk, "home"));
  return {
    grantId: "550e8400-e29b-41d4-a716-446655440000",
    username: "trent",
    serviceCanonical: "notes@abc123def456",
    serverDomains: ["home.trent.flagship.services"],
    serverIdentities: [stkA.publicKey],
    routes: [
      { url: "home.trent.flagship.services", scope: "canonical" },
      { url: "notes.trent.flagship.services", scope: "non-canonical" },
    ],
    issuedAt: 1_780_000_000_000,
    expiresAt: 1_780_604_800_000, // +7 days
    ...overrides,
  };
}

describe("ServiceGrant — sign + verify", () => {
  it("a valid grant verifies under the issuing IRK", () => {
    const irk = deriveIRK(umk);
    const g = baseGrant();
    const sig = signServiceGrant(g, irk);
    expect(verifyServiceGrant(g, sig, irk.publicKey)).toBe(true);
  });

  it("verification fails with a different IRK pubkey", () => {
    const irk = deriveIRK(umk);
    const other = deriveIRK(otherUmk);
    const g = baseGrant();
    const sig = signServiceGrant(g, irk);
    expect(verifyServiceGrant(g, sig, other.publicKey)).toBe(false);
  });

  it("verification fails on any field tamper", () => {
    const irk = deriveIRK(umk);
    const g = baseGrant();
    const sig = signServiceGrant(g, irk);
    const tampered: ServiceGrant = { ...g, username: "wendy" };
    expect(verifyServiceGrant(tampered, sig, irk.publicKey)).toBe(false);
  });

  it("verification fails when a route is silently added", () => {
    const irk = deriveIRK(umk);
    const g = baseGrant();
    const sig = signServiceGrant(g, irk);
    const tampered: ServiceGrant = {
      ...g,
      routes: [...g.routes, { url: "evil.trent.flagship.services", scope: "non-canonical" }],
    };
    expect(verifyServiceGrant(tampered, sig, irk.publicKey)).toBe(false);
  });

  it("verification fails when a sibling pod identity is silently added", () => {
    const irk = deriveIRK(umk);
    const evilStk = deriveSTK(deriveSWK(otherUmk, "evil"));
    const g = baseGrant();
    const sig = signServiceGrant(g, irk);
    const tampered: ServiceGrant = {
      ...g,
      serverIdentities: [...g.serverIdentities, evilStk.publicKey],
    };
    expect(verifyServiceGrant(tampered, sig, irk.publicKey)).toBe(false);
  });

  it("identical grants produce identical canonical bytes (deterministic)", async () => {
    const a = await serviceGrantId(baseGrant());
    const b = await serviceGrantId(baseGrant());
    expect(a).toBe(b);
  });

  it("canonical bytes are order-independent on serverDomains, serverIdentities, and routes", async () => {
    const stkA = deriveSTK(deriveSWK(umk, "home"));
    const stkB = deriveSTK(deriveSWK(umk, "work"));
    const a = await serviceGrantId(
      baseGrant({
        serverDomains: ["home.trent.flagship.services", "work.trent.flagship.services"],
        serverIdentities: [stkA.publicKey, stkB.publicKey],
        routes: [
          { url: "notes.trent.flagship.services", scope: "non-canonical" },
          { url: "home.trent.flagship.services", scope: "canonical" },
        ],
      }),
    );
    const b = await serviceGrantId(
      baseGrant({
        serverDomains: ["work.trent.flagship.services", "home.trent.flagship.services"],
        serverIdentities: [stkB.publicKey, stkA.publicKey],
        routes: [
          { url: "home.trent.flagship.services", scope: "canonical" },
          { url: "notes.trent.flagship.services", scope: "non-canonical" },
        ],
      }),
    );
    expect(a).toBe(b);
  });
});

describe("ServiceGrant — separator + control-char rejection (H1 hardening)", () => {
  it("rejects '|' in username at sign time", () => {
    const irk = deriveIRK(umk);
    expect(() => signServiceGrant(baseGrant({ username: "ha|rry" }), irk)).toThrow(/separator/);
  });

  it("rejects '|' in serviceCanonical at sign time", () => {
    const irk = deriveIRK(umk);
    expect(() => signServiceGrant(baseGrant({ serviceCanonical: "no|tes@abc" }), irk)).toThrow(
      /separator/,
    );
  });

  it("rejects newline in serverDomains at sign time", () => {
    const irk = deriveIRK(umk);
    expect(() =>
      signServiceGrant(baseGrant({ serverDomains: ["home.trent.flagship.services\n"] }), irk),
    ).toThrow(/control char/);
  });

  it("rejects '|' in route url at sign time", () => {
    const irk = deriveIRK(umk);
    expect(() =>
      signServiceGrant(
        baseGrant({ routes: [{ url: "bad|url.trent.flagship.services", scope: "non-canonical" }] }),
        irk,
      ),
    ).toThrow(/separator/);
  });
});

describe("ServiceGrant — well-formedness", () => {
  it("rejects expiresAt <= issuedAt", () => {
    const irk = deriveIRK(umk);
    expect(() =>
      signServiceGrant(
        baseGrant({ issuedAt: 2_000_000_000_000, expiresAt: 2_000_000_000_000 }),
        irk,
      ),
    ).toThrow(/expiresAt/);
  });

  it("rejects empty serverIdentities", () => {
    const irk = deriveIRK(umk);
    expect(() => signServiceGrant(baseGrant({ serverIdentities: [] }), irk)).toThrow(
      /serverIdentities/,
    );
  });

  it("rejects empty routes", () => {
    const irk = deriveIRK(umk);
    expect(() => signServiceGrant(baseGrant({ routes: [] }), irk)).toThrow(/routes/);
  });
});

describe("ServiceGrant — query helpers", () => {
  it("serviceGrantAuthorizesPod returns true for a pod identity in the list", () => {
    const stkA = deriveSTK(deriveSWK(umk, "home"));
    const g = baseGrant({ serverIdentities: [stkA.publicKey] });
    expect(serviceGrantAuthorizesPod(g, stkA.publicKey)).toBe(true);
  });

  it("serviceGrantAuthorizesPod returns false for a pod identity NOT in the list", () => {
    const stkA = deriveSTK(deriveSWK(umk, "home"));
    const stkOther = deriveSTK(deriveSWK(otherUmk, "evil"));
    const g = baseGrant({ serverIdentities: [stkA.publicKey] });
    expect(serviceGrantAuthorizesPod(g, stkOther.publicKey)).toBe(false);
  });

  it("serviceGrantAuthorizesUrl matches exact (case-insensitive) URL", () => {
    const g = baseGrant({
      routes: [{ url: "Notes.Trent.Flagship.Services", scope: "non-canonical" }],
    });
    expect(serviceGrantAuthorizesUrl(g, "notes.trent.flagship.services")).toBe(true);
    expect(serviceGrantAuthorizesUrl(g, "NOTES.TRENT.FLAGSHIP.SERVICES")).toBe(true);
  });

  it("serviceGrantAuthorizesUrl rejects an unlisted URL", () => {
    const g = baseGrant();
    expect(serviceGrantAuthorizesUrl(g, "other.trent.flagship.services")).toBe(false);
  });

  it("serviceGrantAuthorizesUrl matches subpath scope", () => {
    const g = baseGrant({
      routes: [{ url: "home.trent.flagship.services/notes", scope: "subpath" }],
    });
    expect(serviceGrantAuthorizesUrl(g, "home.trent.flagship.services/notes/page-1")).toBe(true);
    expect(serviceGrantAuthorizesUrl(g, "home.trent.flagship.services/other")).toBe(false);
  });

  it("serviceGrantActiveAt is true inside the window, false outside", () => {
    const g = baseGrant({ issuedAt: 1000, expiresAt: 2000 });
    expect(serviceGrantActiveAt(g, 999)).toBe(false);
    expect(serviceGrantActiveAt(g, 1000)).toBe(true);
    expect(serviceGrantActiveAt(g, 1999)).toBe(true);
    expect(serviceGrantActiveAt(g, 2000)).toBe(false); // half-open
    expect(serviceGrantActiveAt(g, 2001)).toBe(false);
  });
});

describe("authorStableId", () => {
  it("returns a 12-char hex string", async () => {
    const irk = deriveIRK(umk);
    const id = await authorStableId(irk.publicKey);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is deterministic for the same pubkey", async () => {
    const irk = deriveIRK(umk);
    const a = await authorStableId(irk.publicKey);
    const b = await authorStableId(irk.publicKey);
    expect(a).toBe(b);
  });

  it("differs across pubkeys", async () => {
    const a = await authorStableId(deriveIRK(umk).publicKey);
    const b = await authorStableId(deriveIRK(otherUmk).publicKey);
    expect(a).not.toBe(b);
  });
});
