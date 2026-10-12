import { describe, expect, it } from "vitest";
import {
  serverUnrevocationCanonicalBytes,
  signReleaseServerName,
  signRevocation,
  signServerUnrevocation,
  verifyServerUnrevocation,
  type ServerUnrevocation,
} from "../src/auth.js";
import { hex as bytesToHex } from "../src/canonicalBase.js";
import { deriveIRK } from "../src/keys.js";

// Golden vector shared with the Swift and Kotlin ports
// (ServerUnrevocationTests.swift, ServerUnrevocationCanonicalBytesTest.kt).
const UNREVOKE: ServerUnrevocation = {
  username: "harry",
  serverDomain: "home.harry.flagship.services",
  issuedAt: 1_700_000_000_000,
};
const CANONICAL = "flagship/server-unrevoke/v1|harry|home.harry.flagship.services|1700000000000";
const irk = deriveIRK({ seed: new Uint8Array(32).fill(42) });

describe("ServerUnrevocation (undo a lost/stolen/decommissioned revoke)", () => {
  it("has the pinned canonical bytes", () => {
    expect(new TextDecoder().decode(serverUnrevocationCanonicalBytes(UNREVOKE))).toBe(CANONICAL);
  });

  it("has the pinned signature under the fixture IRK", () => {
    expect(bytesToHex(irk.publicKey)).toBe(GOLDEN_PUB);
    expect(bytesToHex(signServerUnrevocation(UNREVOKE, irk))).toBe(GOLDEN_SIG);
  });

  it("verifies under the signer and nothing else", () => {
    const sig = signServerUnrevocation(UNREVOKE, irk);
    expect(verifyServerUnrevocation(UNREVOKE, sig, irk.publicKey)).toBe(true);
    const other = deriveIRK({ seed: new Uint8Array(32).fill(0xff) });
    expect(verifyServerUnrevocation(UNREVOKE, sig, other.publicKey)).toBe(false);
    expect(verifyServerUnrevocation({ ...UNREVOKE, serverDomain: "media.harry.flagship.services" }, sig, irk.publicKey)).toBe(false);
    expect(verifyServerUnrevocation({ ...UNREVOKE, issuedAt: UNREVOKE.issuedAt + 1 }, sig, irk.publicKey)).toBe(false);
  });

  it("never accepts a revocation or a name release signature", () => {
    const revoke = signRevocation(
      { userId: "harry", revokedServerId: UNREVOKE.serverDomain, reason: "lost", issuedAt: UNREVOKE.issuedAt },
      irk,
    );
    const release = signReleaseServerName(UNREVOKE, irk);
    expect(verifyServerUnrevocation(UNREVOKE, revoke, irk.publicKey)).toBe(false);
    expect(verifyServerUnrevocation(UNREVOKE, release, irk.publicKey)).toBe(false);
  });
});

const GOLDEN_PUB = "c49775473bf9dcf5ad1608c8e66823d55dc6889be27e42a029fd9de195c8d7e4";
const GOLDEN_SIG =
  "669bfc297531e634d70af2ec4c846aa0eb249bf5c00ce5e6e065a63ce5c86c175f4b930894e45b68ef858f4d397c4442a0faf12ef8c35e2b3d2c949a6b3bbe03";
