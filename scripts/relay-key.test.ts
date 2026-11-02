import { describe, expect, it } from "vitest";
import { ed } from "@flagship/protocol";
import { relayKeyFromSeed } from "./relay-key.mjs";

describe("relay-key", () => {
  it("prints the Ed25519 public key of a relay seed, as the relays derive it", () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const hex = Buffer.from(seed).toString("hex");
    expect(relayKeyFromSeed(hex)).toBe(Buffer.from(ed.getPublicKey(seed)).toString("hex"));
    expect(relayKeyFromSeed(`${hex.toUpperCase()}\n`)).toBe(relayKeyFromSeed(hex));
    expect(() => relayKeyFromSeed("abc")).toThrow(/64 hex/);
  });
});
