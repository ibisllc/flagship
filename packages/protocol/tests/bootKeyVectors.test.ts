import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bootKeyBindingFromWire,
  canonicalBootKeyBinding,
  ed,
  signBootKeyBinding,
  verifiedBootKey,
  verifyAutoUnlockLeaseV2,
} from "../src/index.js";

const v = JSON.parse(readFileSync(new URL("../test-vectors/boot-key/vectors.json", import.meta.url), "utf8"));
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("boot key binding vectors", () => {
  it("signs the canonical bytes deterministically", () => {
    const parsed = bootKeyBindingFromWire(v.binding.wire)!;
    expect(new TextDecoder().decode(canonicalBootKeyBinding(parsed.binding))).toBe(v.binding.canonical);
    // The same format as the box-key-pin vectors (one binding format for every client).
    const pin = JSON.parse(readFileSync(new URL("../test-vectors/box-key-pin/vectors.json", import.meta.url), "utf8"));
    expect(verifiedBootKey({ binding: pin.bootKeyBinding.binding, signature: pin.bootKeyBinding.signatureHex }, { serverDomain: pin.serverDomain, stkPubHex: pin.stkPubHex })).toBe(pin.bootKeyBinding.binding.bootPubHex);
    const seed = unhex(v.stkSeedHex);
    expect(hex(signBootKeyBinding(parsed.binding, { publicKey: ed.getPublicKey(seed), privateKey: seed }))).toBe(v.binding.wire.signature);
  });

  for (const c of v.binding.cases) {
    it(c.name, () => {
      expect(verifiedBootKey(c.wire, c.expect)).toBe(c.bootKeyPubHex);
    });
  }

  it("refuses malformed wire shapes", () => {
    expect(bootKeyBindingFromWire(null)).toBeNull();
    expect(bootKeyBindingFromWire({ binding: { ...v.binding.wire.binding, issuedAt: "1" }, signature: v.binding.wire.signature })).toBeNull();
    expect(bootKeyBindingFromWire({ binding: { ...v.binding.wire.binding, bootPubHex: "zz" }, signature: v.binding.wire.signature })).toBeNull();
  });
});

describe("box-side lease vectors (the signature part)", () => {
  for (const c of v.lease.cases) {
    if (c.error === "lease is malformed") continue;
    it(c.name, () => {
      const b = c.lease;
      const lease = {
        serverDomain: b.serverDomain,
        stkPub: unhex(b.stkPub),
        leaseId: b.leaseId,
        sealedKey: unhex(b.sealedKey),
        issuedAt: b.issuedAt,
        expiresAt: b.expiresAt,
        ...(b.maxUses !== null ? { maxUses: b.maxUses } : {}),
      };
      const sigOk = verifyAutoUnlockLeaseV2(lease, unhex(b.signature), unhex(v.ownerPubHex));
      expect(sigOk).toBe(c.error !== "lease signature does not verify under the owner key");
    });
  }
});
