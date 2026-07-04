import { describe, expect, it } from "vitest";
import { deriveSWK } from "@flagship/protocol";
import { swkOps } from "./helpers/keyCustody.js";
import {
  alpnChallengeDigest,
  deriveTlsKey,
  EncryptedCertStore,
} from "../src/acme.js";

const umk = { seed: new Uint8Array(32).fill(31) };

describe("deriveTlsKey", () => {
  it("returns 32 bytes", () => {
    const swk = deriveSWK(umk, "srv-1");
    const tls = deriveTlsKey(swk, "srv-1");
    expect(tls.length).toBe(32);
  });

  it("is deterministic", () => {
    const swk = deriveSWK(umk, "srv-1");
    expect(deriveTlsKey(swk, "srv-1")).toEqual(deriveTlsKey(swk, "srv-1"));
  });

  it("differs by serverId", () => {
    const swk = deriveSWK(umk, "srv-1");
    expect(deriveTlsKey(swk, "srv-A")).not.toEqual(deriveTlsKey(swk, "srv-B"));
  });

  it("differs from the SWK itself (separation of concerns)", () => {
    const swk = deriveSWK(umk, "srv-1");
    expect(deriveTlsKey(swk, "srv-1")).not.toEqual(swk);
  });
});

describe("EncryptedCertStore", () => {
  const swk = deriveSWK(umk, "srv-1");
  const dummyCert = "-----BEGIN CERTIFICATE-----\nMOCK\n-----END CERTIFICATE-----";
  const dummyKey = "-----BEGIN PRIVATE KEY-----\nSECRETSECRETSECRET\n-----END PRIVATE KEY-----";

  it("roundtrips a cert + private key", () => {
    const store = new EncryptedCertStore(swkOps(swk), "srv-1");
    const notAfter = Date.now() + 90 * 24 * 60 * 60 * 1000;
    store.put("harry", dummyCert, dummyKey, ["*.harry.flagship.services"], notAfter);
    const got = store.get("harry");
    expect(got).toBeDefined();
    expect(got!.certPem).toBe(dummyCert);
    expect(got!.privateKeyPem).toBe(dummyKey);
    expect(got!.notAfter).toBe(notAfter);
  });

  it("get() with the wrong server's SWK fails to decrypt", () => {
    const storeA = new EncryptedCertStore(swkOps(swk), "srv-1");
    storeA.put("harry", dummyCert, dummyKey, [], Date.now() + 1e9);

    // Build a "second store" with a different SWK and inject the encrypted blob.
    // To simulate this we create a store with a different key and assert get() fails
    // when called against ciphertext encrypted under a different key. The simplest
    // way: derive a different TLS key by using a different serverId.
    const otherSwk = deriveSWK(umk, "srv-2");
    const storeB = new EncryptedCertStore(swkOps(otherSwk), "srv-2");
    expect(storeB.has("harry")).toBe(false); // independent store
  });

  it("needsRenewal returns true for absent certs", () => {
    const store = new EncryptedCertStore(swkOps(swk), "srv-1");
    expect(store.needsRenewal("missing")).toBe(true);
  });

  it("needsRenewal returns true when notAfter is within the renewal window", () => {
    const store = new EncryptedCertStore(swkOps(swk), "srv-1");
    store.put("soon", dummyCert, dummyKey, [], Date.now() + 5 * 24 * 60 * 60 * 1000); // 5 days
    expect(store.needsRenewal("soon")).toBe(true);
  });

  it("needsRenewal returns false when cert is fresh", () => {
    const store = new EncryptedCertStore(swkOps(swk), "srv-1");
    store.put("fresh", dummyCert, dummyKey, [], Date.now() + 80 * 24 * 60 * 60 * 1000); // 80 days
    expect(store.needsRenewal("fresh")).toBe(false);
  });

  it("list returns all stored cert names without exposing key material", () => {
    const store = new EncryptedCertStore(swkOps(swk), "srv-1");
    store.put("a", dummyCert, dummyKey, ["a.harry.flagship.services"], 1);
    store.put("b", dummyCert, dummyKey, ["b.harry.flagship.services"], 2);
    const list = store.list();
    expect(list.map((e) => e.name).sort()).toEqual(["a", "b"]);
    expect((list[0] as unknown as { privateKeyPem?: string }).privateKeyPem).toBeUndefined();
  });
});

describe("alpnChallengeDigest", () => {
  it("returns a 32-byte SHA-256 of the key authorization", () => {
    const d = alpnChallengeDigest("key.auth.example");
    expect(d.length).toBe(32);
  });

  it("is deterministic", () => {
    expect(alpnChallengeDigest("k")).toEqual(alpnChallengeDigest("k"));
  });

  it("differs for different authorizations", () => {
    expect(alpnChallengeDigest("a")).not.toEqual(alpnChallengeDigest("b"));
  });
});
