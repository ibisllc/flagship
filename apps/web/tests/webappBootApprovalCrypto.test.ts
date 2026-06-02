import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  openSealedFromEd25519Recipient,
  openSealedSecretResponse,
} from "@flagship/protocol";
// The boot worker's own request signer — the source of truth for the
// Flagship-Boot-v1 canonical bytes the webapp must reproduce.
import { signBootRequest } from "../../boot/src/gate.js";
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
});
