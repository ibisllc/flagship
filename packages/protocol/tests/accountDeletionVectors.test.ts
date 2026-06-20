import { describe, expect, it } from "vitest";
import {
  ed,
  signAccountSelfDelete,
  verifyAccountSelfDelete,
  signServersSelfDelete,
  verifyServersSelfDelete,
  type AccountSelfDelete,
  type Keypair,
  type ServersSelfDelete,
} from "../src/index.js";

/**
 * Cross-platform pins for the account-deletion / name-reclaim envelopes. The
 * exact `|`-joined canonical strings here MUST match the Swift mirror
 * (`apps/mobile/shared/Tests/FlagshipSharedTests/AccountDeletionCanonicalTests.swift`)
 * and the Kotlin mirror
 * (`apps/mobile/android/app/src/test/java/com/flagshipserver/app/core/AccountDeletionVectorTest.kt`).
 */
function makeKey(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

describe("account-self-delete vector", () => {
  it("canonical bytes match the pinned cross-platform string", () => {
    const order: AccountSelfDelete = { username: "alice", issuedAt: 1700 };
    const irk = makeKey(7);
    const sig = signAccountSelfDelete(order, irk);
    const expected = new TextEncoder().encode(
      `flagship/account-self-delete/v1|alice|1700`,
    );
    expect(ed.verify(sig, expected, irk.publicKey)).toBe(true);
  });

  it("username is lowercased into the canonical bytes", () => {
    const irk = makeKey(8);
    const sig = signAccountSelfDelete({ username: "Alice", issuedAt: 42 }, irk);
    const expected = new TextEncoder().encode(
      `flagship/account-self-delete/v1|alice|42`,
    );
    expect(ed.verify(sig, expected, irk.publicKey)).toBe(true);
  });

  it("sign/verify round-trips", () => {
    const irk = makeKey(9);
    const order: AccountSelfDelete = { username: "bob", issuedAt: 5 };
    const sig = signAccountSelfDelete(order, irk);
    expect(verifyAccountSelfDelete(order, sig, irk.publicKey)).toBe(true);
  });

  it("a re-aimed username fails the signature", () => {
    const irk = makeKey(10);
    const order: AccountSelfDelete = { username: "alice", issuedAt: 5 };
    const sig = signAccountSelfDelete(order, irk);
    expect(
      verifyAccountSelfDelete({ ...order, username: "carol" }, sig, irk.publicKey),
    ).toBe(false);
  });

  it("does not verify under a different key", () => {
    const irk = makeKey(11);
    const other = makeKey(12);
    const order: AccountSelfDelete = { username: "alice", issuedAt: 5 };
    const sig = signAccountSelfDelete(order, irk);
    expect(verifyAccountSelfDelete(order, sig, other.publicKey)).toBe(false);
  });
});

describe("servers-self-delete vector", () => {
  it("canonical bytes match the pinned cross-platform string", () => {
    const order: ServersSelfDelete = { username: "alice", issuedAt: 1700 };
    const irk = makeKey(7);
    const sig = signServersSelfDelete(order, irk);
    const expected = new TextEncoder().encode(
      `flagship/servers-self-delete/v1|alice|1700`,
    );
    expect(ed.verify(sig, expected, irk.publicKey)).toBe(true);
  });

  it("sign/verify round-trips", () => {
    const irk = makeKey(13);
    const order: ServersSelfDelete = { username: "bob", issuedAt: 5 };
    const sig = signServersSelfDelete(order, irk);
    expect(verifyServersSelfDelete(order, sig, irk.publicKey)).toBe(true);
  });

  it("an account-self-delete signature does not verify as servers-self-delete", () => {
    const irk = makeKey(14);
    const acct: AccountSelfDelete = { username: "alice", issuedAt: 5 };
    const sig = signAccountSelfDelete(acct, irk);
    const servers: ServersSelfDelete = { username: "alice", issuedAt: 5 };
    expect(verifyServersSelfDelete(servers, sig, irk.publicKey)).toBe(false);
  });
});
