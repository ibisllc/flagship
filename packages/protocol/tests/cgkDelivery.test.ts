import { describe, expect, it } from "vitest";
import {
  buildCgkDelivery,
  carrierHexToCgkDelivery,
  openAndVerifyCgkDelivery,
  signCgkDelivery,
  cgkDeliveryToCarrierHex,
  verifyCgkDelivery,
  type CgkDelivery,
} from "../src/cgkDelivery.js";
import { deriveIRK } from "../src/keys.js";
import { deriveCGK } from "../src/cloudGossip.js";
import { ed } from "../src/edSync.js";
import { hex } from "../src/canonicalBase.js";

// Fixed seeds → cross-platform vector. The owner IRK is derived from a pinned
// UMK; the box identity is a pinned Ed25519 seed; the CGK is deriveCGK over the
// same pinned UMK seed. Swift/Kotlin/webapp twins reproduce these.
const UMK = { seed: new Uint8Array(32).fill(7) };
const BOX_IDENTITY_SEED = new Uint8Array(32).fill(9);
const SERVER_DOMAIN = "kitchen.alice.flagship.services";
const ISSUED_AT = 1_750_000_000_000;

const irk = deriveIRK(UMK);
const cgk = deriveCGK(UMK.seed);
const boxIdentityPub = ed.getPublicKey(BOX_IDENTITY_SEED);

describe("CGK-delivery envelope", () => {
  it("round-trips: phone seals + signs, box verifies + unseals the exact CGK", () => {
    const { delivery, signature } = buildCgkDelivery({
      serverDomain: SERVER_DOMAIN,
      cgk,
      boxIdentityPub,
      irk,
      issuedAt: ISSUED_AT,
    });
    const carrier = cgkDeliveryToCarrierHex(delivery, signature);
    const parsed = carrierHexToCgkDelivery(carrier);
    expect(parsed).not.toBeNull();
    const opened = openAndVerifyCgkDelivery({
      delivery: parsed!.delivery,
      signature: parsed!.signature,
      ownerIrkPub: irk.publicKey,
      boxIdentityPriv: BOX_IDENTITY_SEED,
      serverDomain: SERVER_DOMAIN,
    });
    expect(opened).not.toBeNull();
    expect(hex(opened!)).toEqual(hex(cgk));
  });

  it("PINNED VECTOR: canonical bytes + signature over a fixed sealed blob", () => {
    // A FIXED sealed-blob constant (NOT the random-ephemeral seal output) so the
    // signing + canonical layer is byte-reproducible across platforms. The seal
    // itself uses a random ephemeral key (tested in the round-trip above); this
    // vector pins the IRK signature contract the native twins must match.
    const fixedSealed = new Uint8Array(44 + 32).map((_, i) => (i * 7 + 3) & 0xff);
    const delivery: CgkDelivery = {
      serverDomain: SERVER_DOMAIN,
      sealed: fixedSealed,
      issuedAt: ISSUED_AT,
    };
    const sig = signCgkDelivery(delivery, irk);

    expect(hex(irk.publicKey)).toEqual(PINNED_IRK_PUB);
    expect(hex(boxIdentityPub)).toEqual(PINNED_BOX_IDENTITY_PUB);
    expect(hex(cgk)).toEqual(PINNED_CGK);
    expect(hex(sig)).toEqual(PINNED_SIGNATURE);
    expect(verifyCgkDelivery(delivery, sig, irk.publicKey)).toBe(true);
  });

  it("rejects a forged signature (wrong owner IRK)", () => {
    const { delivery, signature } = buildCgkDelivery({
      serverDomain: SERVER_DOMAIN,
      cgk,
      boxIdentityPub,
      irk,
      issuedAt: ISSUED_AT,
    });
    const wrongIrk = deriveIRK({ seed: new Uint8Array(32).fill(42) });
    expect(
      openAndVerifyCgkDelivery({
        delivery,
        signature,
        ownerIrkPub: wrongIrk.publicKey,
        boxIdentityPriv: BOX_IDENTITY_SEED,
        serverDomain: SERVER_DOMAIN,
      }),
    ).toBeNull();
  });

  it("rejects unseal by the WRONG box identity", () => {
    const { delivery, signature } = buildCgkDelivery({
      serverDomain: SERVER_DOMAIN,
      cgk,
      boxIdentityPub,
      irk,
      issuedAt: ISSUED_AT,
    });
    const wrongBoxSeed = new Uint8Array(32).fill(13);
    expect(
      openAndVerifyCgkDelivery({
        delivery,
        signature,
        ownerIrkPub: irk.publicKey,
        boxIdentityPriv: wrongBoxSeed,
        serverDomain: SERVER_DOMAIN,
      }),
    ).toBeNull();
  });

  it("rejects a delivery naming a DIFFERENT box (substitution)", () => {
    const { delivery, signature } = buildCgkDelivery({
      serverDomain: SERVER_DOMAIN,
      cgk,
      boxIdentityPub,
      irk,
      issuedAt: ISSUED_AT,
    });
    expect(
      openAndVerifyCgkDelivery({
        delivery,
        signature,
        ownerIrkPub: irk.publicKey,
        boxIdentityPriv: BOX_IDENTITY_SEED,
        serverDomain: "evil.bob.flagship.services",
      }),
    ).toBeNull();
  });

  it("rejects a tampered sealed blob (signature no longer verifies)", () => {
    const { delivery, signature } = buildCgkDelivery({
      serverDomain: SERVER_DOMAIN,
      cgk,
      boxIdentityPub,
      irk,
      issuedAt: ISSUED_AT,
    });
    const tampered: CgkDelivery = { ...delivery, sealed: delivery.sealed.slice() };
    tampered.sealed[0] ^= 0xff;
    expect(
      openAndVerifyCgkDelivery({
        delivery: tampered,
        signature,
        ownerIrkPub: irk.publicKey,
        boxIdentityPriv: BOX_IDENTITY_SEED,
        serverDomain: SERVER_DOMAIN,
      }),
    ).toBeNull();
  });

  it("carrier parse returns null on junk (never throws)", () => {
    expect(carrierHexToCgkDelivery("")).toBeNull();
    expect(carrierHexToCgkDelivery("zz")).toBeNull();
    expect(carrierHexToCgkDelivery("abc")).toBeNull(); // odd length
    expect(carrierHexToCgkDelivery(hex(new TextEncoder().encode("not json")))).toBeNull();
    expect(
      carrierHexToCgkDelivery(hex(new TextEncoder().encode(JSON.stringify({ serverDomain: 1 })))),
    ).toBeNull();
  });
});

// Pinned cross-platform vector constants (captured from this implementation; the
// Swift/Kotlin/webapp twins must reproduce these byte-for-byte).
//   UMK seed = 32×0x07 → deriveIRK + deriveCGK
//   box identity seed = 32×0x09 → Ed25519 pub
//   fixed sealed blob = (i*7+3)&0xff over 76 bytes
//   serverDomain = "kitchen.alice.flagship.services", issuedAt = 1750000000000
const PINNED_IRK_PUB =
  "3e4a50e7afdfae54c86e1ccd70a8691d48155e9613cbdbf4d17bad5b6ba68045";
const PINNED_BOX_IDENTITY_PUB =
  "fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618";
const PINNED_CGK =
  "1d8e3bc393a91de22edec0b862a0539856bdc73b42ab60a26d7d51fbb091badd";
const PINNED_SIGNATURE =
  "147205c68400bbce5ac3f92d853ca6745715d7d7d092991eaad7cb769ee6b037" +
  "7f39497865292f667b3d5e3b94454d3517dd81f6d622e3cbcf375c1d44417a0f";
