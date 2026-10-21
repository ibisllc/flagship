import { describe, expect, it } from "vitest";
import {
  deriveIRK,
  nameDibsChallenge,
  signNameChange,
  signNameDibsInitiate,
  signNameDibsVerify,
  verifyNameChange,
  verifyNameDibsInitiate,
  verifyNameDibsVerify,
} from "../src/index.js";

const irk = deriveIRK({ seed: new Uint8Array(32).fill(5) });
const other = deriveIRK({ seed: new Uint8Array(32).fill(6) });
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

describe("name dibs envelopes", () => {
  const initiate = { username: "fresh-poppy", name: "acme", irkPubHex: hex(irk.publicKey), issuedAt: 1 };

  it("an initiate verifies under the signer and nothing else", () => {
    const sig = signNameDibsInitiate(initiate, irk);
    expect(verifyNameDibsInitiate(initiate, sig, irk.publicKey)).toBe(true);
    expect(verifyNameDibsInitiate(initiate, sig, other.publicKey)).toBe(false);
    expect(verifyNameDibsInitiate({ ...initiate, name: "acme2" }, sig, irk.publicKey)).toBe(false);
  });

  it("a verify request is bound to its nonce", () => {
    const v = { username: "fresh-poppy", name: "acme", nonce: "ab".repeat(32), issuedAt: 2 };
    const sig = signNameDibsVerify(v, irk);
    expect(verifyNameDibsVerify(v, sig, irk.publicKey)).toBe(true);
    expect(verifyNameDibsVerify({ ...v, nonce: "cd".repeat(32) }, sig, irk.publicKey)).toBe(false);
  });

  it("the challenge binds the claiming key and the nonce", () => {
    const a = nameDibsChallenge("acme", hex(irk.publicKey), "01".repeat(32));
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(nameDibsChallenge("acme", hex(other.publicKey), "01".repeat(32))).not.toBe(a);
    expect(nameDibsChallenge("acme", hex(irk.publicKey), "02".repeat(32))).not.toBe(a);
  });

  it("refuses a field carrying the canonical separator", () => {
    expect(() => signNameDibsInitiate({ ...initiate, name: "a|b" }, irk)).toThrow(/separator/);
    expect(() => nameDibsChallenge("a|b", "00", "00")).toThrow(/separator/);
  });

  it("a name change is bound to the account's AID", () => {
    const c = { aidPubHex: "aa".repeat(32), oldUsername: "fresh-poppy", newUsername: "acme", issuedAt: 3 };
    const sig = signNameChange(c, irk);
    expect(verifyNameChange(c, sig, irk.publicKey)).toBe(true);
    expect(verifyNameChange({ ...c, aidPubHex: "bb".repeat(32) }, sig, irk.publicKey)).toBe(false);
  });
});
