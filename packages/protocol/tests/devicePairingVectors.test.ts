import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import { verifyDeviceAdmit } from "../src/push.js";
import { DEVICE_SCOPES, verifyDeviceCapabilityGrant } from "../src/deviceCapability.js";
import { buildDevicePairingVectors, VECTORS_PATH } from "./genDevicePairingVectors.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as any;
const toGrant = (g: any) => ({ ...g, devicePubKey: hexToBytes(g.devicePubHex) });

describe("device-pairing vectors (adding a device is admin-only)", () => {
  it("the file is what the generator writes", () => {
    expect(V).toEqual(JSON.parse(JSON.stringify(buildDevicePairingVectors())));
  });

  it("reads the shared set at packages/protocol/test-vectors/device-pairing/vectors.json", () => {
    expect(VECTORS_PATH.replace(/\\/g, "/").endsWith("test-vectors/device-pairing/vectors.json")).toBe(true);
  });

  it("the scope order is the protocol's", () => {
    expect(V.scopeOrder).toEqual([...DEVICE_SCOPES]);
  });

  it("the admit verifies under the account key and not the admin root", () => {
    expect(verifyDeviceAdmit(V.admit.fields, hexToBytes(V.admit.signatureHex), hexToBytes(V.keys.irkPubHex))).toBe(true);
    expect(verifyDeviceAdmit(V.admit.fields, hexToBytes(V.admit.signatureHex), hexToBytes(V.keys.adminRootPubHex))).toBe(false);
  });

  it("the member grant verifies under the account key only", () => {
    const g = toGrant(V.memberGrant.grant);
    const sig = hexToBytes(V.memberGrant.signatureHex);
    expect(V.memberGrant.grant.scopes).toEqual(V.memberScopes);
    expect(V.memberGrant.grant.scopes).not.toContain("admin");
    expect(verifyDeviceCapabilityGrant(g, sig, hexToBytes(V.keys.irkPubHex))).toBe(true);
    expect(verifyDeviceCapabilityGrant(g, sig, hexToBytes(V.keys.adminRootPubHex))).toBe(false);
  });

  it("the promoted grant verifies under the admin root only", () => {
    const g = toGrant(V.adminGrant.grant);
    const sig = hexToBytes(V.adminGrant.signatureHex);
    expect(verifyDeviceCapabilityGrant(g, sig, hexToBytes(V.keys.adminRootPubHex))).toBe(true);
    expect(verifyDeviceCapabilityGrant(g, sig, hexToBytes(V.keys.irkPubHex))).toBe(false);
  });
});
