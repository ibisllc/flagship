import { describe, expect, it } from "vitest";
import {
  ed,
  signAccountSelfDelete,
  verifyAccountSelfDelete,
  signServersSelfDelete,
  verifyServersSelfDelete,
  signServerTransferOffer,
  verifyServerTransferOffer,
  signServerTransferClaim,
  verifyServerTransferClaim,
  type AccountSelfDelete,
  type Keypair,
  type ServersSelfDelete,
  type ServerTransferOffer,
  type ServerTransferClaim,
} from "../src/index.js";

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

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

describe("server-transfer-offer vector (transfer-a-box §4)", () => {
  const OFFER: ServerTransferOffer = {
    serverDomain: "home.alice.flagship.services",
    transferNonce: "ab".repeat(32),
    issuedAt: 1700,
    expiresAt: 1700 + 300_000,
  };

  it("canonical bytes match the pinned cross-platform string", () => {
    const irk = makeKey(7);
    const sig = signServerTransferOffer(OFFER, irk);
    const expected = new TextEncoder().encode(
      `flagship/server-transfer-offer/v1|home.alice.flagship.services|${"ab".repeat(32)}|1700|${1700 + 300_000}`,
    );
    expect(ed.verify(sig, expected, irk.publicKey)).toBe(true);
  });

  it("serverDomain + nonce are lowercased into the canonical bytes", () => {
    const irk = makeKey(8);
    const sig = signServerTransferOffer(
      { ...OFFER, serverDomain: "HOME.alice.flagship.services", transferNonce: "AB".repeat(32) },
      irk,
    );
    const expected = new TextEncoder().encode(
      `flagship/server-transfer-offer/v1|home.alice.flagship.services|${"ab".repeat(32)}|1700|${1700 + 300_000}`,
    );
    expect(ed.verify(sig, expected, irk.publicKey)).toBe(true);
  });

  it("sign/verify round-trips; a re-aimed domain fails", () => {
    const irk = makeKey(9);
    const sig = signServerTransferOffer(OFFER, irk);
    expect(verifyServerTransferOffer(OFFER, sig, irk.publicKey)).toBe(true);
    expect(
      verifyServerTransferOffer({ ...OFFER, serverDomain: "blog.alice.flagship.services" }, sig, irk.publicKey),
    ).toBe(false);
  });
});

describe("server-transfer-claim vector (transfer-a-box §4)", () => {
  it("canonical bytes match the pinned cross-platform string", () => {
    const irk = makeKey(7); // acquirer IRK
    const claim: ServerTransferClaim = {
      serverDomain: "home.alice.flagship.services",
      transferNonce: "ab".repeat(32),
      acquirerUsername: "bob",
      acquirerIrkPub: irk.publicKey,
      issuedAt: 1800,
    };
    const sig = signServerTransferClaim(claim, irk);
    const expected = new TextEncoder().encode(
      `flagship/server-transfer-claim/v1|home.alice.flagship.services|${"ab".repeat(32)}|bob|${hex(irk.publicKey)}|1800`,
    );
    expect(ed.verify(sig, expected, irk.publicKey)).toBe(true);
  });

  it("acquirerUsername is lowercased; binds to the acquirer IRK", () => {
    const irk = makeKey(10);
    const claim: ServerTransferClaim = {
      serverDomain: "home.alice.flagship.services",
      transferNonce: "cd".repeat(32),
      acquirerUsername: "BOB",
      acquirerIrkPub: irk.publicKey,
      issuedAt: 5,
    };
    const sig = signServerTransferClaim(claim, irk);
    const expected = new TextEncoder().encode(
      `flagship/server-transfer-claim/v1|home.alice.flagship.services|${"cd".repeat(32)}|bob|${hex(irk.publicKey)}|5`,
    );
    expect(ed.verify(sig, expected, irk.publicKey)).toBe(true);
  });

  it("does not verify under a different acquirer key", () => {
    const irk = makeKey(11);
    const other = makeKey(12);
    const claim: ServerTransferClaim = {
      serverDomain: "home.alice.flagship.services",
      transferNonce: "ef".repeat(32),
      acquirerUsername: "bob",
      acquirerIrkPub: irk.publicKey,
      issuedAt: 5,
    };
    const sig = signServerTransferClaim(claim, irk);
    expect(verifyServerTransferClaim(claim, sig, other.publicKey)).toBe(false);
  });
});
