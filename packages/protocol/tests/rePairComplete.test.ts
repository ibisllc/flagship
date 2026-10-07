import { describe, expect, it } from "vitest";
import {
  ed,
  signRePairComplete,
  signRePairObject,
  verifyRePairComplete,
  verifyRePairObject,
  type Keypair,
} from "../src/index.js";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

const USERNAME = "alice";
const T0 = 1_700_000_000_000;

describe("RePairComplete", () => {
  it("verifies under the new IRK that signed it", () => {
    const newIrk = makeKey();
    const r = { username: USERNAME, newIrkPub: newIrk.publicKey, issuedAt: T0 };
    expect(verifyRePairComplete(r, signRePairComplete(r, newIrk), newIrk.publicKey)).toBe(
      true,
    );
  });

  it("does not verify under any other key", () => {
    const newIrk = makeKey();
    const other = makeKey();
    const r = { username: USERNAME, newIrkPub: newIrk.publicKey, issuedAt: T0 };
    expect(verifyRePairComplete(r, signRePairComplete(r, newIrk), other.publicKey)).toBe(
      false,
    );
  });

  it("is tag-separated from RePairObject — a cancel can't replay as a completion", () => {
    // Identical fields, identical signer: the canonical TAG is the only
    // thing that distinguishes "stop this recovery" from "finish it".
    const newIrk = makeKey();
    const r = { username: USERNAME, newIrkPub: newIrk.publicKey, issuedAt: T0 };
    const cancel = signRePairObject(r, newIrk);
    const finish = signRePairComplete(r, newIrk);
    expect(verifyRePairComplete(r, cancel, newIrk.publicKey)).toBe(false);
    expect(verifyRePairObject(r, finish, newIrk.publicKey)).toBe(false);
  });

  it("binds every field — tampering with any of them breaks the signature", () => {
    const newIrk = makeKey();
    const other = makeKey();
    const r = { username: USERNAME, newIrkPub: newIrk.publicKey, issuedAt: T0 };
    const sig = signRePairComplete(r, newIrk);
    expect(verifyRePairComplete({ ...r, username: "bob" }, sig, newIrk.publicKey)).toBe(
      false,
    );
    expect(
      verifyRePairComplete({ ...r, newIrkPub: other.publicKey }, sig, newIrk.publicKey),
    ).toBe(false);
    expect(verifyRePairComplete({ ...r, issuedAt: T0 + 1 }, sig, newIrk.publicKey)).toBe(
      false,
    );
  });

  it("rejects a separator-bearing username instead of letting it reshape the bytes", () => {
    const newIrk = makeKey();
    expect(() =>
      signRePairComplete(
        { username: "a|b", newIrkPub: newIrk.publicKey, issuedAt: T0 },
        newIrk,
      ),
    ).toThrow();
  });

  it("returns false rather than throwing on a malformed signature", () => {
    const newIrk = makeKey();
    const r = { username: USERNAME, newIrkPub: newIrk.publicKey, issuedAt: T0 };
    expect(verifyRePairComplete(r, new Uint8Array(3), newIrk.publicKey)).toBe(false);
  });
});
