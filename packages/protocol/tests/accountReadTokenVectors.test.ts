import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalBoxReadTokenRequest,
  deriveAccountDeviceKeySeed,
  deriveIRK,
  ed,
  signAccountDirectoryRequest,
  signBoxReadTokenRequest,
  signDeviceEndpointClaim,
  verifyBoxReadTokenRequest,
} from "../src/index.js";

const v = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../test-vectors/account-read-token/vectors.json"), "utf8"),
);
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("account-read-token vectors", () => {
  const umk = { seed: bytes(v.keys.umkSeedHex) };
  const deviceSeed = deriveAccountDeviceKeySeed(umk.seed, v.keys.accountId, v.keys.deviceId);
  const irk = deriveIRK(umk);

  it("derives the keys", () => {
    expect(hex(deviceSeed)).toBe(v.keys.deviceSeedHex);
    expect(hex(ed.getPublicKey(deviceSeed))).toBe(v.keys.devicePubHex);
    expect(hex(irk.publicKey)).toBe(v.keys.irkPubHex);
    expect(hex(ed.getPublicKey(bytes(v.keys.stkSeedHex)))).toBe(v.keys.stkPubHex);
  });

  it("reproduces the device request", () => {
    expect(signAccountDirectoryRequest(v.device.fields, (m) => ed.sign(m, deviceSeed))).toBe(v.device.signatureHex);
    const canonical = new TextEncoder().encode(v.device.canonical);
    expect(ed.verify(bytes(v.device.signatureHex), canonical, bytes(v.keys.devicePubHex))).toBe(true);
    expect(ed.verify(bytes(v.device.reject.signatureHex), canonical, bytes(v.keys.devicePubHex))).toBe(false);
  });

  it("reproduces the IRK claim", () => {
    const f = v.irk.fields;
    const claim = { ...f, phoneIrkPub: bytes(f.phoneIrkPub), nonce: bytes(f.nonce) };
    expect(hex(signDeviceEndpointClaim(claim, irk))).toBe(v.irk.signatureHex);
    const canonical = new TextEncoder().encode(v.irk.canonical);
    expect(ed.verify(bytes(v.irk.signatureHex), canonical, irk.publicKey)).toBe(true);
    expect(ed.verify(bytes(v.irk.reject.signatureHex), canonical, irk.publicKey)).toBe(false);
  });

  it("reproduces the server request", () => {
    expect(new TextDecoder().decode(canonicalBoxReadTokenRequest(v.box.fields))).toBe(v.box.canonical);
    expect(signBoxReadTokenRequest(v.box.fields, (m) => ed.sign(m, bytes(v.keys.stkSeedHex)))).toBe(v.box.signatureHex);
    expect(verifyBoxReadTokenRequest(v.box.fields, v.box.reject.signatureHex, bytes(v.keys.stkPubHex))).toBe(false);
  });
});
