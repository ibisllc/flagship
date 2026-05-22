/**
 * DeviceAdmit envelope tests (Phase 3b — vouched cross-device pairing).
 *
 * The admit is the admin's vouch: after confirming the SAS over the
 * sealed QrRelay, the admin signs (with the account's current IRK) an
 * envelope binding the incoming device's FRESH pubkey. .com verifies it
 * under the registered IRK before admitting the device quarantined.
 */
import { describe, expect, it } from "vitest";
import {
  type DeviceAdmit,
  signDeviceAdmit,
  verifyDeviceAdmit,
} from "../src/auth.js";
import { deriveIRK } from "../src/keys.js";

const umk = { seed: new Uint8Array(32).fill(7) };
const otherUmk = { seed: new Uint8Array(32).fill(8) };

const NEW_DEVICE_PUB_HEX = "ab".repeat(32);

function baseAdmit(overrides: Partial<DeviceAdmit> = {}): DeviceAdmit {
  return {
    username: "alice",
    newDevicePubHex: NEW_DEVICE_PUB_HEX,
    issuedAt: 1_780_000_000_000,
    ...overrides,
  };
}

describe("DeviceAdmit — sign + verify", () => {
  it("a valid admit verifies under the account's IRK", () => {
    const irk = deriveIRK(umk);
    const a = baseAdmit();
    const sig = signDeviceAdmit(a, irk);
    expect(verifyDeviceAdmit(a, sig, irk.publicKey)).toBe(true);
  });

  it("rejects a tampered newDevicePubHex (admit can't be re-aimed at a different device)", () => {
    const irk = deriveIRK(umk);
    const a = baseAdmit();
    const sig = signDeviceAdmit(a, irk);
    const tampered: DeviceAdmit = { ...a, newDevicePubHex: "cd".repeat(32) };
    expect(verifyDeviceAdmit(tampered, sig, irk.publicKey)).toBe(false);
  });

  it("rejects a tampered username", () => {
    const irk = deriveIRK(umk);
    const a = baseAdmit();
    const sig = signDeviceAdmit(a, irk);
    const tampered: DeviceAdmit = { ...a, username: "mallory" };
    expect(verifyDeviceAdmit(tampered, sig, irk.publicKey)).toBe(false);
  });

  it("rejects a tampered issuedAt", () => {
    const irk = deriveIRK(umk);
    const a = baseAdmit();
    const sig = signDeviceAdmit(a, irk);
    const tampered: DeviceAdmit = { ...a, issuedAt: a.issuedAt + 1 };
    expect(verifyDeviceAdmit(tampered, sig, irk.publicKey)).toBe(false);
  });

  it("rejects a signature from the wrong key", () => {
    const irk = deriveIRK(umk);
    const wrong = deriveIRK(otherUmk);
    const a = baseAdmit();
    const sig = signDeviceAdmit(a, wrong);
    expect(verifyDeviceAdmit(a, sig, irk.publicKey)).toBe(false);
  });

  it("returns false (never throws) on a malformed signature", () => {
    const irk = deriveIRK(umk);
    const a = baseAdmit();
    expect(verifyDeviceAdmit(a, new Uint8Array(3), irk.publicKey)).toBe(false);
  });

  it("refuses to sign a username containing the canonical-bytes separator", () => {
    const irk = deriveIRK(umk);
    expect(() => signDeviceAdmit(baseAdmit({ username: "a|b" }), irk)).toThrow();
  });
});
