import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  openSealedFromEd25519Recipient,
  openSealedSecretResponse,
  verifyRootEntitlement,
} from "@flagship/protocol";
// The boot router's own request signer — the source of truth for the
// Flagship-Boot-v1 canonical bytes the webapp must reproduce. Lives in
// @flagship/boot-core (shared by apps/com's in-process boot host AND the
// optional standalone apps/boot worker).
import { signBootRequest } from "@flagship/boot-core";
// The browser-shipping boot-approval module's crypto internals. Importing
// the SAME file we serve to clients means the test guards the exact bytes
// the webapp produces.
import { _internal } from "../public/webapp/lib/bootApproval.js";
import { ed25519PubToX25519 } from "../public/webapp/lib/edToMont.js";

const { sealForBoxStk, buildSealedResponse, canonicalBootAuth } = _internal as {
  sealForBoxStk: (pt: Uint8Array, stkEdPub: Uint8Array) => Promise<Uint8Array>;
  buildSealedResponse: (
    secret: Uint8Array,
    a: { stkEdPub: Uint8Array; nonceHex: string; purpose: string },
  ) => Promise<Uint8Array>;
  canonicalBootAuth: (e: Record<string, unknown>) => Uint8Array;
};

function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

describe("webapp boot-approval crypto matches @flagship/protocol byte-for-byte", () => {
  it("ed25519PubToX25519 equals noble's toMontgomery (the box opens what we seal)", () => {
    for (let i = 0; i < 20; i++) {
      const sk = ed25519.utils.randomSecretKey();
      const pk = ed25519.getPublicKey(sk);
      const expected = ed25519.utils.toMontgomery(pk);
      const got = ed25519PubToX25519(pk);
      expect(toHex(got)).toBe(toHex(expected));
    }
  });

  it("sealForBoxStk produces a blob the box opens with its STK seed", async () => {
    const stkSeed = ed25519.utils.randomSecretKey();
    const stkPub = ed25519.getPublicKey(stkSeed);
    const secret = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
    const sealed = await sealForBoxStk(secret, stkPub);
    const opened = openSealedFromEd25519Recipient(sealed, stkSeed);
    expect(toHex(opened)).toBe(toHex(secret));
  });

  it("buildSealedResponse round-trips through openSealedSecretResponse + binds (nonce,purpose)", async () => {
    const stkSeed = ed25519.utils.randomSecretKey();
    const stkPub = ed25519.getPublicKey(stkSeed);
    const secret = new Uint8Array(48).map((_, i) => (i * 11 + 5) & 0xff);
    const nonce = ed25519.utils.randomSecretKey(); // 32-byte nonce stand-in
    const nonceHex = toHex(nonce);
    const sealed = await buildSealedResponse(secret, {
      stkEdPub: stkPub,
      nonceHex,
      purpose: "unlock-key",
    });
    const request = {
      serverDomain: "kitchen.alice.flagship.services",
      stkPub,
      purpose: "unlock-key" as const,
      nonce,
      issuedAt: Date.now(),
    };
    const recovered = openSealedSecretResponse(
      { sealed } as never,
      request,
      stkSeed,
    );
    expect(toHex(recovered)).toBe(toHex(secret));

    // A DIFFERENT nonce must be rejected by the embedded context binding.
    expect(() =>
      openSealedSecretResponse(
        { sealed } as never,
        { ...request, nonce: ed25519.utils.randomSecretKey() },
        stkSeed,
      ),
    ).toThrow();
  });

  it("canonicalBootAuth matches the boot worker's gate (the owner header verifies)", () => {
    const seed = ed25519.utils.randomSecretKey();
    const pubKeyHex = toHex(ed25519.getPublicKey(seed));
    const args = {
      role: "owner",
      serverDomain: "kitchen.alice.flagship.services",
      method: "POST",
      path: "/api/boot/response",
      pubKeyHex,
      nonceHex: toHex(ed25519.utils.randomSecretKey()),
      issuedAt: 1_700_000_000_000,
    };
    // The gate's own signer produces an envelope; its signature must
    // verify against the WEBAPP's canonical bytes (proves byte-match).
    const header = signBootRequest(args as never, seed);
    const envelope = JSON.parse(
      Buffer.from(header.split(" ")[1] as string, "base64url").toString(),
    ) as { signatureHex: string };
    const ok = ed25519.verify(
      Buffer.from(envelope.signatureHex, "hex"),
      canonicalBootAuth(args),
      Buffer.from(pubKeyHex, "hex"),
    );
    expect(ok).toBe(true);
  });

  // Create-time pairing: the webapp mints a fresh WebCrypto Ed25519 pairing key,
  // seals the order to its raw pub, and embeds the pkcs8-extracted 32-byte seed
  // in the recipe as `pairingKeyPrivHex`. The daemon opens the deposit with that
  // seed via openSealedFromEd25519Recipient — so the seed extraction MUST be the
  // inverse of the raw pub. This pins exactly that (the one genuinely-new crypto
  // step in depositCreateTimePairing).
  it("pkcs8-extracted pairing seed opens what was sealed to its raw pub (daemon's move)", async () => {
    const kp = (await crypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const pairingPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
    const pairingSeed = pkcs8.slice(pkcs8.length - 32); // RFC 8410: prefix(16) || seed(32)

    // The webapp seals to the raw pub; the daemon opens with the seed.
    const order = new TextEncoder().encode(JSON.stringify({ request: { type: "add-paired-session" } }));
    const sealed = await sealForBoxStk(order, pairingPub);
    const opened = openSealedFromEd25519Recipient(sealed, pairingSeed);
    expect(toHex(opened)).toBe(toHex(order));

    // The seed's noble-derived pub must equal the WebCrypto raw pub (sanity).
    expect(toHex(ed25519.getPublicKey(pairingSeed))).toBe(toHex(pairingPub));
  });
});

describe("webapp entitlement carrier verifies under the protocol's own RootEntitlement check", () => {
  function hexToBytes(h: string): Uint8Array {
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  const buildEntitlementCarrier = (_internal as unknown as {
    buildEntitlementCarrier: (a: {
      username: string;
      podPubKeyHex: string;
      podCanonical: string;
      issuedAt: number;
      signWithIrk: (umk: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>;
      umk: Uint8Array;
    }) => Promise<string>;
  }).buildEntitlementCarrier;

  it("the deposited carrier is accepted by @flagship/protocol verifyRootEntitlement (byte-identical canonical)", async () => {
    const irkSeed = new Uint8Array(32).fill(0x11);
    const irkPub = ed25519.getPublicKey(irkSeed);
    const stkPub = ed25519.getPublicKey(new Uint8Array(32).fill(0x22));
    const username = "harry";
    const podCanonical = "hali.harry.flagship.services";
    const issuedAt = 1_782_000_000_000;

    // The webapp signs the entitlement with the owner IRK (injected here).
    const signWithIrk = async (_umk: Uint8Array, bytes: Uint8Array) =>
      ed25519.sign(bytes, irkSeed);
    const carrierHex = await buildEntitlementCarrier({
      username,
      podPubKeyHex: toHex(stkPub),
      podCanonical,
      issuedAt,
      signWithIrk,
      umk: new Uint8Array(0),
    });

    // Decode the carrier exactly as the daemon does (hex → UTF-8 JSON).
    const json = JSON.parse(new TextDecoder().decode(hexToBytes(carrierHex)));
    expect(json.serviceEntitlement).toBeNull();
    expect(json.rootEntitlement.podCanonical).toBe(podCanonical);
    const rootEntitlement = {
      username: json.rootEntitlement.username,
      podPubKey: hexToBytes(json.rootEntitlement.podPubKey),
      podCanonical: json.rootEntitlement.podCanonical,
      issuedAt: json.rootEntitlement.issuedAt,
    };
    const sig = hexToBytes(json.rootEntitlementSig);
    // The protocol's own verifier (the source of truth the hub + daemon use).
    expect(verifyRootEntitlement(rootEntitlement, sig, irkPub)).toBe(true);
    // Negative control: a different IRK must NOT verify.
    const otherPub = ed25519.getPublicKey(new Uint8Array(32).fill(0x33));
    expect(verifyRootEntitlement(rootEntitlement, sig, otherPub)).toBe(false);
  });
});
