import { describe, expect, it } from "vitest";
import { ed } from "@flagship/protocol";
import { caKeypairFromEnv } from "../src/pubkeyCert.js";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

describe("caKeypairFromEnv", () => {
  it("derives the public half from the secret", () => {
    const ca = caKeypairFromEnv({ FLAGSHIP_CA_PRIV_HEX: "ab".repeat(32) });
    expect(hex(ca.keypair.publicKey)).toBe(hex(ed.getPublicKey(new Uint8Array(32).fill(0xab))));
    expect(ca.issuer).toBe("flagship-ca-v1");
  });

  it("gives the same keypair for the same secret and a different one for another", () => {
    const a = caKeypairFromEnv({ FLAGSHIP_CA_PRIV_HEX: "ab".repeat(32) });
    const b = caKeypairFromEnv({ FLAGSHIP_CA_PRIV_HEX: "AB".repeat(32) });
    const c = caKeypairFromEnv({ FLAGSHIP_CA_PRIV_HEX: "cd".repeat(32) });
    expect(hex(b.keypair.publicKey)).toBe(hex(a.keypair.publicKey));
    expect(hex(c.keypair.publicKey)).not.toBe(hex(a.keypair.publicKey));
  });

  it("keeps the issuer separate from the key", () => {
    const named = caKeypairFromEnv({ FLAGSHIP_CA_PRIV_HEX: "ab".repeat(32), FLAGSHIP_CA_ISSUER: "custom" });
    const plain = caKeypairFromEnv({ FLAGSHIP_CA_PRIV_HEX: "ab".repeat(32) });
    expect(named.issuer).toBe("custom");
    expect(plain.issuer).toBe("flagship-ca-v1");
  });

  it("falls back to the dev key for a missing or malformed secret", () => {
    const dev = caKeypairFromEnv({});
    expect(dev.issuer).toBe("flagship-ca-dev");
    expect(hex(dev.keypair.publicKey)).toBe(hex(ed.getPublicKey(new Uint8Array(32).fill(0xca))));
    const bad = caKeypairFromEnv({ FLAGSHIP_CA_PRIV_HEX: "not-hex" });
    expect(hex(bad.keypair.publicKey)).toBe(hex(dev.keypair.publicKey));
  });
});
