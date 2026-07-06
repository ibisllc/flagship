import { describe, expect, it } from "vitest";
import {
  ed,
  isSensitiveScope,
  requireMasterAdmin,
  signDeviceCapabilityGrant,
  verifyDeviceCapabilityGrant,
  SENSITIVE_SCOPES,
  type AdminGrantView,
  type DeviceCapabilityGrant,
  type Keypair,
} from "../src/index.js";

function seedKeypair(fill: number): Keypair {
  const seed = new Uint8Array(fill === 0 ? 32 : 32).fill(fill);
  return { privateKey: seed, publicKey: ed.getPublicKey(seed) };
}
function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const adminRoot = seedKeypair(0x77);
const membershipIrk = seedKeypair(0x11);
const device = seedKeypair(0x22);

const NOW = 1_735_689_600_000;

function grant(overrides: Partial<DeviceCapabilityGrant> = {}): DeviceCapabilityGrant {
  return {
    grantId: "550e8400-e29b-41d4-a716-446655440000",
    username: "harry",
    deviceLabel: "ipad",
    devicePubKey: device.publicKey,
    scopes: ["admin"],
    issuedAt: NOW - 1000,
    expiresAt: NOW + 90 * 24 * 60 * 60_000,
    ...overrides,
  };
}

/** Build an AdminGrantView with the grant signed by `signer`, tagged `signerRoot`. */
function view(
  signer: Keypair,
  signerRoot: AdminGrantView["signerRoot"],
  g: DeviceCapabilityGrant = grant(),
  revokedAt: number | null = null,
): AdminGrantView {
  return {
    grant: g,
    signatureHex: hex(signDeviceCapabilityGrant(g, signer)),
    signerRoot,
    revokedAt,
  };
}

describe("SENSITIVE_SCOPES / isSensitiveScope (Slice D §3.2)", () => {
  it("marks `admin` sensitive and non-authority scopes non-sensitive", () => {
    expect(SENSITIVE_SCOPES.has("admin")).toBe(true);
    expect(isSensitiveScope("admin")).toBe(true);
    expect(isSensitiveScope("browse")).toBe(false);
    expect(isSensitiveScope("install-service")).toBe(false);
    expect(isSensitiveScope("revoke-others")).toBe(false);
  });
});

describe("an admin-root-signed grant verifies under the admin root, not the IRK", () => {
  it("verifies under the admin master root and FAILS under the membership IRK", () => {
    const g = grant();
    const sig = signDeviceCapabilityGrant(g, adminRoot);
    expect(verifyDeviceCapabilityGrant(g, sig, adminRoot.publicKey)).toBe(true);
    expect(verifyDeviceCapabilityGrant(g, sig, membershipIrk.publicKey)).toBe(false);
  });
});

describe("requireMasterAdmin (Slice D §3.1)", () => {
  const adminRootHex = hex(adminRoot.publicKey);

  it("allows the bare admin master root signing directly", () => {
    const r = requireMasterAdmin(adminRootHex, "harry", adminRootHex, [], NOW);
    expect(r).toEqual({ ok: true });
  });

  it("DENIES the membership IRK for a sensitive scope (never a master admin)", () => {
    // The membership IRK is not a device holding an admin grant → no match.
    const r = requireMasterAdmin(hex(membershipIrk.publicKey), "harry", adminRootHex, [], NOW);
    expect(r.ok).toBe(false);
  });

  it("DENIES the membership IRK even when an admin grant exists (IRK != device)", () => {
    const grants = [view(adminRoot, "admin-root")];
    const r = requireMasterAdmin(hex(membershipIrk.publicKey), "harry", adminRootHex, grants, NOW);
    expect(r.ok).toBe(false);
  });

  it("allows a device holding a valid admin-root-signed `admin` grant", () => {
    const grants = [view(adminRoot, "admin-root")];
    const r = requireMasterAdmin(hex(device.publicKey), "harry", adminRootHex, grants, NOW);
    expect(r).toEqual({ ok: true });
  });

  it("DENIES a membership-IRK-signed grant even if tagged `admin-root` (sig fails under root)", () => {
    // A UMK holder forges a grant with the admin scope + lies about signerRoot;
    // the cryptographic verify UNDER THE ADMIN ROOT is what catches it.
    const grants = [view(membershipIrk, "admin-root")];
    const r = requireMasterAdmin(hex(device.publicKey), "harry", adminRootHex, grants, NOW);
    expect(r).toEqual({ ok: false, reason: "grant signature failed verification" });
  });

  it("DENIES a grant tagged `membership` (the signer discriminator gate)", () => {
    const grants = [view(adminRoot, "membership")];
    const r = requireMasterAdmin(hex(device.publicKey), "harry", adminRootHex, grants, NOW);
    expect(r).toEqual({ ok: false, reason: "grant not admin-root-signed" });
  });

  it("DENIES a revoked admin grant", () => {
    const grants = [view(adminRoot, "admin-root", grant(), NOW - 10)];
    const r = requireMasterAdmin(hex(device.publicKey), "harry", adminRootHex, grants, NOW);
    expect(r).toEqual({ ok: false, reason: "no active admin grant" });
  });

  it("DENIES an expired admin grant", () => {
    const g = grant({ issuedAt: NOW - 2000, expiresAt: NOW - 1000 });
    const grants = [view(adminRoot, "admin-root", g)];
    const r = requireMasterAdmin(hex(device.publicKey), "harry", adminRootHex, grants, NOW);
    expect(r).toEqual({ ok: false, reason: "grant expired" });
  });

  it("DENIES a grant missing the `admin` scope", () => {
    const g = grant({ scopes: ["browse"] });
    const grants = [view(adminRoot, "admin-root", g)];
    const r = requireMasterAdmin(hex(device.publicKey), "harry", adminRootHex, grants, NOW);
    expect(r).toEqual({ ok: false, reason: "missing admin scope" });
  });

  it("DENIES on username mismatch", () => {
    const grants = [view(adminRoot, "admin-root")];
    const r = requireMasterAdmin(hex(device.publicKey), "bob", adminRootHex, grants, NOW);
    expect(r).toEqual({ ok: false, reason: "username mismatch" });
  });

  it("DENIES when the account has no admin root pinned", () => {
    const r = requireMasterAdmin(adminRootHex, "harry", undefined, [], NOW);
    expect(r).toEqual({ ok: false, reason: "no admin root" });
  });
});
