import { describe, expect, it } from "vitest";
import {
  buildSwkDelivery,
  carrierHexToSwkDelivery,
  openAndVerifySwkDelivery,
  signSwkDelivery,
  swkDeliveryToCarrierHex,
  verifySwkDelivery,
  type SwkDelivery,
} from "../src/swkDelivery.js";
import { deriveIRK, deriveSWK } from "../src/keys.js";
import { ed } from "../src/edSync.js";
import { hex } from "../src/canonicalBase.js";

// Fixed seeds → cross-platform vector. The owner IRK is derived from a pinned
// UMK; the box identity is a pinned Ed25519 seed; the SWK is deriveSWK over the
// same pinned UMK + a fixed serverId. Swift/Kotlin twins reproduce these.
const UMK = { seed: new Uint8Array(32).fill(7) };
const BOX_IDENTITY_SEED = new Uint8Array(32).fill(9);
const SERVER_DOMAIN = "kitchen.alice.flagship.services";
const SERVER_ID = "srv-vector-1";
const ISSUED_AT = 1_750_000_000_000;

const irk = deriveIRK(UMK);
const swk = deriveSWK(UMK, SERVER_ID);
const boxIdentityPub = ed.getPublicKey(BOX_IDENTITY_SEED);

describe("SWK-delivery envelope", () => {
  it("round-trips: phone seals + signs, box verifies + unseals the exact SWK", () => {
    const { delivery, signature } = buildSwkDelivery({
      serverDomain: SERVER_DOMAIN,
      swk,
      boxIdentityPub,
      irk,
      issuedAt: ISSUED_AT,
    });
    const carrier = swkDeliveryToCarrierHex(delivery, signature);
    const parsed = carrierHexToSwkDelivery(carrier);
    expect(parsed).not.toBeNull();
    const opened = openAndVerifySwkDelivery({
      delivery: parsed!.delivery,
      signature: parsed!.signature,
      ownerIrkPub: irk.publicKey,
      boxIdentityPriv: BOX_IDENTITY_SEED,
      serverDomain: SERVER_DOMAIN,
    });
    expect(opened).not.toBeNull();
    expect(hex(opened!)).toEqual(hex(swk));
  });

  it("PINNED VECTOR: canonical bytes + signature over a fixed sealed blob", () => {
    // A FIXED sealed-blob constant (NOT the random-ephemeral seal output) so the
    // signing + canonical layer is byte-reproducible across platforms. The seal
    // itself uses a random ephemeral key (tested in the round-trip above); this
    // vector pins the IRK signature contract the native twins must match.
    const fixedSealed = new Uint8Array(44 + 32).map((_, i) => (i * 7 + 3) & 0xff);
    const delivery: SwkDelivery = {
      serverDomain: SERVER_DOMAIN,
      sealed: fixedSealed,
      issuedAt: ISSUED_AT,
    };
    const sig = signSwkDelivery(delivery, irk);

    // Pinned IRK pubkey (derived from UMK fill(7)).
    expect(hex(irk.publicKey)).toEqual(PINNED_IRK_PUB);
    // Pinned box identity pubkey (Ed25519 of seed fill(9)).
    expect(hex(boxIdentityPub)).toEqual(PINNED_BOX_IDENTITY_PUB);
    // Pinned signature over the canonical bytes of the fixed-sealed delivery.
    expect(hex(sig)).toEqual(PINNED_SIGNATURE);
    expect(verifySwkDelivery(delivery, sig, irk.publicKey)).toBe(true);
  });

  it("rejects a forged signature (wrong owner IRK)", () => {
    const { delivery, signature } = buildSwkDelivery({
      serverDomain: SERVER_DOMAIN,
      swk,
      boxIdentityPub,
      irk,
      issuedAt: ISSUED_AT,
    });
    const wrongIrk = deriveIRK({ seed: new Uint8Array(32).fill(42) });
    const opened = openAndVerifySwkDelivery({
      delivery,
      signature,
      ownerIrkPub: wrongIrk.publicKey,
      boxIdentityPriv: BOX_IDENTITY_SEED,
      serverDomain: SERVER_DOMAIN,
    });
    expect(opened).toBeNull();
  });

  it("rejects unseal by the wrong box identity", () => {
    const { delivery, signature } = buildSwkDelivery({
      serverDomain: SERVER_DOMAIN,
      swk,
      boxIdentityPub,
      irk,
      issuedAt: ISSUED_AT,
    });
    const wrongBoxSeed = new Uint8Array(32).fill(13);
    const opened = openAndVerifySwkDelivery({
      delivery,
      signature,
      ownerIrkPub: irk.publicKey,
      boxIdentityPriv: wrongBoxSeed,
      serverDomain: SERVER_DOMAIN,
    });
    expect(opened).toBeNull();
  });

  it("rejects a delivery naming a different box (substitution)", () => {
    const { delivery, signature } = buildSwkDelivery({
      serverDomain: SERVER_DOMAIN,
      swk,
      boxIdentityPub,
      irk,
      issuedAt: ISSUED_AT,
    });
    const opened = openAndVerifySwkDelivery({
      delivery,
      signature,
      ownerIrkPub: irk.publicKey,
      boxIdentityPriv: BOX_IDENTITY_SEED,
      serverDomain: "evil.bob.flagship.services",
    });
    expect(opened).toBeNull();
  });

  it("rejects a tampered sealed blob (signature no longer verifies)", () => {
    const { delivery, signature } = buildSwkDelivery({
      serverDomain: SERVER_DOMAIN,
      swk,
      boxIdentityPub,
      irk,
      issuedAt: ISSUED_AT,
    });
    const tampered: SwkDelivery = { ...delivery, sealed: delivery.sealed.slice() };
    tampered.sealed[0] ^= 0xff;
    expect(
      openAndVerifySwkDelivery({
        delivery: tampered,
        signature,
        ownerIrkPub: irk.publicKey,
        boxIdentityPriv: BOX_IDENTITY_SEED,
        serverDomain: SERVER_DOMAIN,
      }),
    ).toBeNull();
  });

  it("carrier parse returns null on junk (never throws)", () => {
    expect(carrierHexToSwkDelivery("")).toBeNull();
    expect(carrierHexToSwkDelivery("zz")).toBeNull();
    expect(carrierHexToSwkDelivery("abc")).toBeNull(); // odd length
    expect(carrierHexToSwkDelivery(hex(new TextEncoder().encode("not json")))).toBeNull();
    expect(
      carrierHexToSwkDelivery(hex(new TextEncoder().encode(JSON.stringify({ serverDomain: 1 })))),
    ).toBeNull();
  });
});

// Pinned cross-platform vector constants (captured from this implementation;
// the Swift/Kotlin twins must reproduce these byte-for-byte).
//   UMK seed = 32×0x07 → deriveIRK
//   box identity seed = 32×0x09 → Ed25519 pub
//   fixed sealed blob = (i*7+3)&0xff over 76 bytes
//   serverDomain = "kitchen.alice.flagship.services", issuedAt = 1750000000000
const PINNED_IRK_PUB =
  "3e4a50e7afdfae54c86e1ccd70a8691d48155e9613cbdbf4d17bad5b6ba68045";
const PINNED_BOX_IDENTITY_PUB =
  "fd1724385aa0c75b64fb78cd602fa1d991fdebf76b13c58ed702eac835e9f618";
const PINNED_SIGNATURE =
  "660cf5eb0be65b17d5e57208b0d130ab3d9dd074f6623cf8c45c6d4055c6e06f" +
  "27403cd87a5247b3476b8985d2a99dafb1dd2aea4feed8732e4bf7e7a8867a0f";
