import { describe, expect, it } from "vitest";
import { generateKeyPairSync, createPrivateKey } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sealForEd25519Recipient } from "@flagship/protocol";
import { unsealGrantedAccountKeyPem } from "../src/acme/grantedAccountKey.js";
import { resolveAccountKey } from "../src/runtime.js";

function freshP256Pem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

// A deterministic box STK (Ed25519). The seal converts the Ed25519 pub →
// X25519 (toMontgomery); the open converts the Ed25519 seed → X25519 scalar.
const STK_SEED = new Uint8Array(32).fill(7);
const STK_PUB = ed25519.getPublicKey(STK_SEED);

describe("unsealGrantedAccountKeyPem (#28 seal-to-box, box consumer)", () => {
  it("round-trips a P-256 account-key PEM sealed to the box STK", () => {
    const pem = freshP256Pem();
    const sealed = sealForEd25519Recipient(new TextEncoder().encode(pem), STK_PUB);
    const out = unsealGrantedAccountKeyPem(sealed, STK_SEED);
    expect(out).toBe(pem);
    // The unsealed PEM is a loadable P-256 private key.
    const key = createPrivateKey(out);
    expect(key.asymmetricKeyType).toBe("ec");
  });

  it("throws for a blob sealed to a DIFFERENT box (wrong STK)", () => {
    const pem = freshP256Pem();
    const otherPub = ed25519.getPublicKey(new Uint8Array(32).fill(9));
    const sealed = sealForEd25519Recipient(new TextEncoder().encode(pem), otherPub);
    expect(() => unsealGrantedAccountKeyPem(sealed, STK_SEED)).toThrow();
  });

  it("throws when the sealed plaintext is not a PEM private key", () => {
    const sealed = sealForEd25519Recipient(new TextEncoder().encode("not a pem"), STK_PUB);
    expect(() => unsealGrantedAccountKeyPem(sealed, STK_SEED)).toThrow(/not a PEM/);
  });

  it("rejects a non-32-byte STK seed", () => {
    const pem = freshP256Pem();
    const sealed = sealForEd25519Recipient(new TextEncoder().encode(pem), STK_PUB);
    expect(() => unsealGrantedAccountKeyPem(sealed, new Uint8Array(16))).toThrow(/32 bytes/);
  });
});

describe("resolveAccountKey — granted-key precedence (#28)", () => {
  function memStore() {
    let pem: string | null = null;
    return {
      saved: () => pem,
      loadAccountKey: async () => pem,
      saveAccountKey: async (p: string) => {
        pem = p;
      },
    };
  }

  it("adopts + persists a granted key over a self-generated one", async () => {
    const store = memStore();
    const granted = freshP256Pem();
    const out = await resolveAccountKey({
      explicitPem: undefined,
      store,
      createPrivateKey: async () => freshP256Pem(),
      resolveGrantedPem: async () => granted,
    });
    expect(out).toBe(granted);
    expect(store.saved()).toBe(granted); // persisted for offline boots
  });

  it("falls back to the on-disk key when the grant resolver throws (e.g. .com offline)", async () => {
    const store = memStore();
    const onDisk = freshP256Pem();
    await store.saveAccountKey(onDisk);
    const out = await resolveAccountKey({
      explicitPem: undefined,
      store,
      createPrivateKey: async () => freshP256Pem(),
      resolveGrantedPem: async () => {
        throw new Error("com unreachable");
      },
    });
    expect(out).toBe(onDisk);
  });

  it("falls back to self-generation when there is no grant and no disk key", async () => {
    const store = memStore();
    const fresh = freshP256Pem();
    const out = await resolveAccountKey({
      explicitPem: undefined,
      store,
      createPrivateKey: async () => fresh,
      resolveGrantedPem: async () => null,
    });
    expect(out).toBe(fresh);
    expect(store.saved()).toBe(fresh);
  });

  it("explicitPem still wins over everything (unchanged behaviour)", async () => {
    const explicit = freshP256Pem();
    const out = await resolveAccountKey({
      explicitPem: explicit,
      store: null,
      createPrivateKey: async () => freshP256Pem(),
      resolveGrantedPem: async () => freshP256Pem(),
    });
    expect(out).toBe(explicit);
  });
});
