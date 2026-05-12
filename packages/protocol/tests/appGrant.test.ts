/**
 * AppGrant envelope tests.
 *
 * The grant is the cornerstone of the AppGrant-based authorization
 * model (Thread C of the design pass). It subsumes RootEntitlement,
 * AppEntitlement, and ClaimUrlCapability into a single 7-day
 * IRK-signed envelope.
 */
import { describe, expect, it } from "vitest";
import {
  type AppGrant,
  appGrantActiveAt,
  appGrantAuthorizesPod,
  appGrantAuthorizesUrl,
  appGrantId,
  authorStableId,
  signAppGrant,
  verifyAppGrant,
} from "../src/auth.js";
import { deriveIRK, deriveSTK, deriveSWK } from "../src/keys.js";

const umk = { seed: new Uint8Array(32).fill(7) };
const otherUmk = { seed: new Uint8Array(32).fill(8) };

function baseGrant(overrides: Partial<AppGrant> = {}): AppGrant {
  const stkA = deriveSTK(deriveSWK(umk, "home"));
  return {
    grantId: "550e8400-e29b-41d4-a716-446655440000",
    username: "trent",
    appCanonical: "notes@abc123def456",
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

describe("AppGrant — sign + verify", () => {
  it("a valid grant verifies under the issuing IRK", () => {
    const irk = deriveIRK(umk);
    const g = baseGrant();
    const sig = signAppGrant(g, irk);
    expect(verifyAppGrant(g, sig, irk.publicKey)).toBe(true);
  });

  it("verification fails with a different IRK pubkey", () => {
    const irk = deriveIRK(umk);
    const other = deriveIRK(otherUmk);
    const g = baseGrant();
    const sig = signAppGrant(g, irk);
    expect(verifyAppGrant(g, sig, other.publicKey)).toBe(false);
  });

  it("verification fails on any field tamper", () => {
    const irk = deriveIRK(umk);
    const g = baseGrant();
    const sig = signAppGrant(g, irk);
    const tampered: AppGrant = { ...g, username: "wendy" };
    expect(verifyAppGrant(tampered, sig, irk.publicKey)).toBe(false);
  });

  it("verification fails when a route is silently added", () => {
    const irk = deriveIRK(umk);
    const g = baseGrant();
    const sig = signAppGrant(g, irk);
    const tampered: AppGrant = {
      ...g,
      routes: [...g.routes, { url: "evil.trent.flagship.services", scope: "non-canonical" }],
    };
    expect(verifyAppGrant(tampered, sig, irk.publicKey)).toBe(false);
  });

  it("verification fails when a sibling pod identity is silently added", () => {
    const irk = deriveIRK(umk);
    const evilStk = deriveSTK(deriveSWK(otherUmk, "evil"));
    const g = baseGrant();
    const sig = signAppGrant(g, irk);
    const tampered: AppGrant = {
      ...g,
      serverIdentities: [...g.serverIdentities, evilStk.publicKey],
    };
    expect(verifyAppGrant(tampered, sig, irk.publicKey)).toBe(false);
  });

  it("identical grants produce identical canonical bytes (deterministic)", async () => {
    const a = await appGrantId(baseGrant());
    const b = await appGrantId(baseGrant());
    expect(a).toBe(b);
  });

  it("canonical bytes are order-independent on serverDomains, serverIdentities, and routes", async () => {
    const stkA = deriveSTK(deriveSWK(umk, "home"));
    const stkB = deriveSTK(deriveSWK(umk, "work"));
    const a = await appGrantId(
      baseGrant({
        serverDomains: ["home.trent.flagship.services", "work.trent.flagship.services"],
        serverIdentities: [stkA.publicKey, stkB.publicKey],
        routes: [
          { url: "notes.trent.flagship.services", scope: "non-canonical" },
          { url: "home.trent.flagship.services", scope: "canonical" },
        ],
      }),
    );
    const b = await appGrantId(
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

describe("AppGrant — separator + control-char rejection (H1 hardening)", () => {
  it("rejects '|' in username at sign time", () => {
    const irk = deriveIRK(umk);
    expect(() => signAppGrant(baseGrant({ username: "ha|rry" }), irk)).toThrow(/separator/);
  });

  it("rejects '|' in appCanonical at sign time", () => {
    const irk = deriveIRK(umk);
    expect(() => signAppGrant(baseGrant({ appCanonical: "no|tes@abc" }), irk)).toThrow(
      /separator/,
    );
  });

  it("rejects newline in serverDomains at sign time", () => {
    const irk = deriveIRK(umk);
    expect(() =>
      signAppGrant(baseGrant({ serverDomains: ["home.trent.flagship.services\n"] }), irk),
    ).toThrow(/control char/);
  });

  it("rejects '|' in route url at sign time", () => {
    const irk = deriveIRK(umk);
    expect(() =>
      signAppGrant(
        baseGrant({ routes: [{ url: "bad|url.trent.flagship.services", scope: "non-canonical" }] }),
        irk,
      ),
    ).toThrow(/separator/);
  });
});

describe("AppGrant — well-formedness", () => {
  it("rejects expiresAt <= issuedAt", () => {
    const irk = deriveIRK(umk);
    expect(() =>
      signAppGrant(
        baseGrant({ issuedAt: 2_000_000_000_000, expiresAt: 2_000_000_000_000 }),
        irk,
      ),
    ).toThrow(/expiresAt/);
  });

  it("rejects empty serverIdentities", () => {
    const irk = deriveIRK(umk);
    expect(() => signAppGrant(baseGrant({ serverIdentities: [] }), irk)).toThrow(
      /serverIdentities/,
    );
  });

  it("rejects empty routes", () => {
    const irk = deriveIRK(umk);
    expect(() => signAppGrant(baseGrant({ routes: [] }), irk)).toThrow(/routes/);
  });
});

describe("AppGrant — query helpers", () => {
  it("appGrantAuthorizesPod returns true for a pod identity in the list", () => {
    const stkA = deriveSTK(deriveSWK(umk, "home"));
    const g = baseGrant({ serverIdentities: [stkA.publicKey] });
    expect(appGrantAuthorizesPod(g, stkA.publicKey)).toBe(true);
  });

  it("appGrantAuthorizesPod returns false for a pod identity NOT in the list", () => {
    const stkA = deriveSTK(deriveSWK(umk, "home"));
    const stkOther = deriveSTK(deriveSWK(otherUmk, "evil"));
    const g = baseGrant({ serverIdentities: [stkA.publicKey] });
    expect(appGrantAuthorizesPod(g, stkOther.publicKey)).toBe(false);
  });

  it("appGrantAuthorizesUrl matches exact (case-insensitive) URL", () => {
    const g = baseGrant({
      routes: [{ url: "Notes.Trent.Flagship.Services", scope: "non-canonical" }],
    });
    expect(appGrantAuthorizesUrl(g, "notes.trent.flagship.services")).toBe(true);
    expect(appGrantAuthorizesUrl(g, "NOTES.TRENT.FLAGSHIP.SERVICES")).toBe(true);
  });

  it("appGrantAuthorizesUrl rejects an unlisted URL", () => {
    const g = baseGrant();
    expect(appGrantAuthorizesUrl(g, "other.trent.flagship.services")).toBe(false);
  });

  it("appGrantAuthorizesUrl matches subpath scope", () => {
    const g = baseGrant({
      routes: [{ url: "home.trent.flagship.services/notes", scope: "subpath" }],
    });
    expect(appGrantAuthorizesUrl(g, "home.trent.flagship.services/notes/page-1")).toBe(true);
    expect(appGrantAuthorizesUrl(g, "home.trent.flagship.services/other")).toBe(false);
  });

  it("appGrantActiveAt is true inside the window, false outside", () => {
    const g = baseGrant({ issuedAt: 1000, expiresAt: 2000 });
    expect(appGrantActiveAt(g, 999)).toBe(false);
    expect(appGrantActiveAt(g, 1000)).toBe(true);
    expect(appGrantActiveAt(g, 1999)).toBe(true);
    expect(appGrantActiveAt(g, 2000)).toBe(false); // half-open
    expect(appGrantActiveAt(g, 2001)).toBe(false);
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
