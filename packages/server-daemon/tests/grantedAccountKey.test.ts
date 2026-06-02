import { describe, expect, it } from "vitest";
import { generateKeyPairSync, createPrivateKey } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sealForEd25519Recipient } from "@flagship/protocol";
import type { FetchLike } from "@flagship/llm-providers";
import {
  unsealGrantedAccountKeyPem,
  fetchGrantedAccountKeyPem,
} from "../src/acme/grantedAccountKey.js";
import { resolveAccountKey } from "../src/runtime.js";

function freshP256Pem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
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

describe("fetchGrantedAccountKeyPem (#28 seal-to-box, .com fetch + box-open)", () => {
  const FQDN = "home.alice.flagship.services";

  // A fetch that returns a 200 with a body we seal here in-test, so the
  // round-trip mirrors what `.com` serves: GET → { sealedAccountKeyHex, ... }.
  function fetch200(sealed: Uint8Array, calls: string[]): FetchLike {
    return async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => ({
          sealedAccountKeyHex: bytesToHex(sealed),
          accountKeyId: "grant-abc",
          recipientPubKeyHex: bytesToHex(STK_PUB),
          expiresAt: Date.now() + 86_400_000,
        }),
      };
    };
  }

  it("opens a 200 grant sealed to THIS box's STK and returns the PEM", async () => {
    const pem = freshP256Pem();
    const sealed = sealForEd25519Recipient(new TextEncoder().encode(pem), STK_PUB);
    const calls: string[] = [];
    const out = await fetchGrantedAccountKeyPem({
      baseUrl: "https://flagshipserver.com",
      serverFqdn: FQDN,
      stkSeed: STK_SEED,
      fetch: fetch200(sealed, calls),
    });
    expect(out).toBe(pem);
    // Hits the documented control-plane endpoint with the FQDN encoded.
    expect(calls).toEqual([
      `GET https://flagshipserver.com/api/server/${encodeURIComponent(FQDN)}/acme-account-key`,
    ]);
  });

  it("strips a trailing slash from the base URL", async () => {
    const pem = freshP256Pem();
    const sealed = sealForEd25519Recipient(new TextEncoder().encode(pem), STK_PUB);
    const calls: string[] = [];
    await fetchGrantedAccountKeyPem({
      baseUrl: "https://flagshipserver.com/",
      serverFqdn: FQDN,
      stkSeed: STK_SEED,
      fetch: fetch200(sealed, calls),
    });
    expect(calls[0]).not.toContain(".com//api");
  });

  it("returns null on 404 (no active grant)", async () => {
    const fetch404: FetchLike = async () => ({
      ok: false,
      status: 404,
      text: async () => "not found",
      json: async () => ({}),
    });
    const out = await fetchGrantedAccountKeyPem({
      baseUrl: "https://flagshipserver.com",
      serverFqdn: FQDN,
      stkSeed: STK_SEED,
      fetch: fetch404,
    });
    expect(out).toBeNull();
  });

  it("returns null on any non-ok status (e.g. 503)", async () => {
    const fetch503: FetchLike = async () => ({
      ok: false,
      status: 503,
      text: async () => "down",
      json: async () => ({}),
    });
    const out = await fetchGrantedAccountKeyPem({
      baseUrl: "https://flagshipserver.com",
      serverFqdn: FQDN,
      stkSeed: STK_SEED,
      fetch: fetch503,
    });
    expect(out).toBeNull();
  });

  it("returns null (does NOT throw) when the grant was sealed to a DIFFERENT box", async () => {
    // The blob decrypts only under the other box's STK; opening under THIS
    // box's seed throws inside, which the fetcher swallows to null so a
    // mis-targeted grant never wedges boot.
    const pem = freshP256Pem();
    const otherPub = ed25519.getPublicKey(new Uint8Array(32).fill(9));
    const sealed = sealForEd25519Recipient(new TextEncoder().encode(pem), otherPub);
    const out = await fetchGrantedAccountKeyPem({
      baseUrl: "https://flagshipserver.com",
      serverFqdn: FQDN,
      stkSeed: STK_SEED,
      fetch: fetch200(sealed, []),
    });
    expect(out).toBeNull();
  });

  it("returns null on a network failure (fetch rejects)", async () => {
    const fetchThrows: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const out = await fetchGrantedAccountKeyPem({
      baseUrl: "https://flagshipserver.com",
      serverFqdn: FQDN,
      stkSeed: STK_SEED,
      fetch: fetchThrows,
    });
    expect(out).toBeNull();
  });

  it("returns null when the body lacks sealedAccountKeyHex", async () => {
    const fetchBad: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({ accountKeyId: "x" }),
    });
    const out = await fetchGrantedAccountKeyPem({
      baseUrl: "https://flagshipserver.com",
      serverFqdn: FQDN,
      stkSeed: STK_SEED,
      fetch: fetchBad,
    });
    expect(out).toBeNull();
  });

  it("returns null on malformed hex (not a valid sealed blob)", async () => {
    const fetchBadHex: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({ sealedAccountKeyHex: "zzzz" }),
    });
    const out = await fetchGrantedAccountKeyPem({
      baseUrl: "https://flagshipserver.com",
      serverFqdn: FQDN,
      stkSeed: STK_SEED,
      fetch: fetchBadHex,
    });
    expect(out).toBeNull();
  });
});
