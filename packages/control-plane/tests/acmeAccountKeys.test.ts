/**
 * Unit tests for the ACME account-key grant handlers (per-user-cert design).
 *
 * Mirrors watchDelegates.test.ts: pure handlers over InMemory storage, no
 * network, real sign/verify. Covered:
 *   - mint round-trip → list shows it (METADATA ONLY — the sealed key is
 *     NEVER in the mint reply nor the list)
 *   - MULTIPLE active grants per user coexist (one sealed copy per admin
 *     device; no unique-active index)
 *   - bad signature → 403; unknown user → 404; expired → 400;
 *     duplicate grantId → 409
 *   - revoke-by-accountKeyId tombstones EVERY copy of a key + returns the
 *     count; list then excludes them; re-revoke is idempotent (count 0)
 *   - requireMinter: IRK fast-path + grant-holder happy path + every deny
 *     branch (unknown user, non-minter key, expired grant, IRK-rotation
 *     invalidates via stored-envelope re-verify)
 */

import { describe, expect, it } from "vitest";
import {
  ed,
  signAcmeAccountKeyGrant,
  signRevokeAcmeAccountKey,
  type AcmeAccountKeyGrant,
  type AccountKeyRevokeReason,
  type Keypair,
  type RevokeAcmeAccountKey,
} from "@flagship/protocol";
import {
  InMemoryAcmeAccountKeyDeliveryStorage,
  InMemoryAcmeAccountKeyGrantStorage,
  InMemoryUsernameStorage,
} from "@flagship/storage";
import {
  handleMintAcmeAccountKeyGrant,
  handleListAcmeAccountKeyGrants,
  handleRevokeAcmeAccountKeyGrant,
  requireMinter,
  type AcmeAccountKeysDeps,
} from "../src/acmeAccountKeys.js";

const USER = "dani";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

interface Harness {
  deps: AcmeAccountKeysDeps;
  usernames: InMemoryUsernameStorage;
  storage: InMemoryAcmeAccountKeyGrantStorage;
  userIrk: Keypair;
  clock: { now: number };
}

async function mkHarness(): Promise<Harness> {
  const userIrk = makeKey();
  const usernames = new InMemoryUsernameStorage();
  await usernames.put({
    username: USER,
    irkPubHex: hex(userIrk.publicKey),
    claimedAt: 1,
  });
  const storage = new InMemoryAcmeAccountKeyGrantStorage();
  const clock = { now: 1_000_000 };
  const deps: AcmeAccountKeysDeps = { storage, usernames, now: () => clock.now };
  return { deps, usernames, storage, userIrk, clock };
}

function mintGrant(args: {
  userIrk: Keypair;
  username?: string;
  recipientPub?: Uint8Array;
  sealedAccountKey?: Uint8Array;
  accountKeyId?: string;
  issuedAt?: number;
  expiresAt?: number;
  grantId?: string;
}): {
  body: {
    grant: {
      grantId: string;
      username: string;
      accountKeyId: string;
      recipientPubKey: string;
      sealedAccountKey: string;
      issuedAt: number;
      expiresAt: number;
    };
    signature: string;
  };
  grant: AcmeAccountKeyGrant;
  signature: Uint8Array;
} {
  const recipientPub = args.recipientPub ?? makeKey().publicKey;
  // A non-empty opaque ciphertext stand-in (the seal primitive is the
  // caller's; the protocol only carries the bytes).
  const sealedAccountKey =
    args.sealedAccountKey ?? new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const accountKeyId = args.accountKeyId ?? "acct-key-id-1";
  const issuedAt = args.issuedAt ?? 1_000_000;
  const expiresAt = args.expiresAt ?? issuedAt + 30 * 24 * 3_600_000;
  const grantId = args.grantId ?? "aak-uuid-1";
  const grant: AcmeAccountKeyGrant = {
    grantId,
    username: args.username ?? USER,
    accountKeyId,
    recipientPubKey: recipientPub,
    sealedAccountKey,
    issuedAt,
    expiresAt,
  };
  const signature = signAcmeAccountKeyGrant(grant, args.userIrk);
  return {
    body: {
      grant: {
        grantId,
        username: grant.username,
        accountKeyId,
        recipientPubKey: hex(recipientPub),
        sealedAccountKey: hex(sealedAccountKey),
        issuedAt,
        expiresAt,
      },
      signature: hex(signature),
    },
    grant,
    signature,
  };
}

describe("handleMintAcmeAccountKeyGrant", () => {
  it("mints a grant → list shows it as METADATA ONLY (no sealed key)", async () => {
    const h = await mkHarness();
    const sealed = new Uint8Array([9, 9, 9, 9]);
    const { body } = mintGrant({ userIrk: h.userIrk, sealedAccountKey: sealed });
    const res = await handleMintAcmeAccountKeyGrant(h.deps, body);
    expect(res.status).toBe(200);
    const mintBody = res.body as Record<string, unknown>;
    expect(mintBody.grantId).toBe("aak-uuid-1");
    expect(mintBody.accountKeyId).toBe("acct-key-id-1");
    // The sealed key must NEVER be echoed back.
    expect(mintBody.sealedAccountKey).toBeUndefined();
    expect(JSON.stringify(mintBody)).not.toContain(hex(sealed));

    const listed = await handleListAcmeAccountKeyGrants(h.deps, USER);
    const grants = (listed.body as { grants: Record<string, unknown>[] }).grants;
    expect(grants.length).toBe(1);
    expect(grants[0]?.accountKeyId).toBe("acct-key-id-1");
    // Listing is not a delivery channel — no sealed key in the metadata.
    expect(grants[0]?.sealedAccountKey).toBeUndefined();
    expect(grants[0]?.sealedAccountKeyHex).toBeUndefined();
    expect(JSON.stringify(grants[0])).not.toContain(hex(sealed));
  });

  it("allows MULTIPLE active grants per user (one per admin device)", async () => {
    const h = await mkHarness();
    const a = makeKey();
    const b = makeKey();
    await handleMintAcmeAccountKeyGrant(
      h.deps,
      mintGrant({ userIrk: h.userIrk, grantId: "aak-a", recipientPub: a.publicKey }).body,
    );
    const second = await handleMintAcmeAccountKeyGrant(
      h.deps,
      mintGrant({ userIrk: h.userIrk, grantId: "aak-b", recipientPub: b.publicKey }).body,
    );
    expect(second.status).toBe(200);

    const listed = await handleListAcmeAccountKeyGrants(h.deps, USER);
    const grants = (listed.body as { grants: { grantId: string }[] }).grants;
    expect(grants.length).toBe(2);
    expect(grants.map((g) => g.grantId).sort()).toEqual(["aak-a", "aak-b"]);
  });

  it("rejects a duplicate grantId with 409", async () => {
    const h = await mkHarness();
    await handleMintAcmeAccountKeyGrant(
      h.deps,
      mintGrant({ userIrk: h.userIrk, grantId: "dup" }).body,
    );
    const again = await handleMintAcmeAccountKeyGrant(
      h.deps,
      mintGrant({ userIrk: h.userIrk, grantId: "dup", recipientPub: makeKey().publicKey }).body,
    );
    expect(again.status).toBe(409);
  });

  it("rejects a bad signature with 403", async () => {
    const h = await mkHarness();
    const { body } = mintGrant({ userIrk: h.userIrk });
    body.signature = hex(new Uint8Array(64)); // all-zero sig
    const res = await handleMintAcmeAccountKeyGrant(h.deps, body);
    expect(res.status).toBe(403);
  });

  it("rejects an unknown user with 404", async () => {
    const h = await mkHarness();
    const { body } = mintGrant({ userIrk: h.userIrk, username: "nobody" });
    const res = await handleMintAcmeAccountKeyGrant(h.deps, body);
    expect(res.status).toBe(404);
  });

  it("rejects an already-expired grant with 400", async () => {
    const h = await mkHarness();
    const { body } = mintGrant({
      userIrk: h.userIrk,
      issuedAt: 1,
      expiresAt: 2,
    });
    const res = await handleMintAcmeAccountKeyGrant(h.deps, body);
    expect(res.status).toBe(400);
  });

  it("rejects a non-hex sealed key with 400", async () => {
    const h = await mkHarness();
    const { body } = mintGrant({ userIrk: h.userIrk });
    (body.grant.sealedAccountKey as string) = "not-hex!!";
    const res = await handleMintAcmeAccountKeyGrant(h.deps, body);
    expect(res.status).toBe(400);
  });
});

describe("handleRevokeAcmeAccountKeyGrant", () => {
  it("revokes EVERY copy of an accountKeyId + returns the count; list excludes them", async () => {
    const h = await mkHarness();
    // Two admin devices, same accountKeyId — both are sealed copies of one key.
    await handleMintAcmeAccountKeyGrant(
      h.deps,
      mintGrant({
        userIrk: h.userIrk,
        grantId: "aak-1",
        recipientPub: makeKey().publicKey,
        accountKeyId: "key-X",
      }).body,
    );
    await handleMintAcmeAccountKeyGrant(
      h.deps,
      mintGrant({
        userIrk: h.userIrk,
        grantId: "aak-2",
        recipientPub: makeKey().publicKey,
        accountKeyId: "key-X",
      }).body,
    );
    // A grant of a DIFFERENT key survives the revoke.
    await handleMintAcmeAccountKeyGrant(
      h.deps,
      mintGrant({
        userIrk: h.userIrk,
        grantId: "aak-3",
        recipientPub: makeKey().publicKey,
        accountKeyId: "key-Y",
      }).body,
    );

    const revoke: RevokeAcmeAccountKey = {
      accountKeyId: "key-X",
      username: USER,
      reason: "rotation",
      issuedAt: 1_000_500,
    };
    const sig = signRevokeAcmeAccountKey(revoke, h.userIrk);
    const res = await handleRevokeAcmeAccountKeyGrant(h.deps, {
      request: revoke,
      signature: hex(sig),
    });
    expect(res.status).toBe(200);
    expect((res.body as { revoked: number }).revoked).toBe(2);

    const listed = await handleListAcmeAccountKeyGrants(h.deps, USER);
    const grants = (listed.body as { grants: { grantId: string }[] }).grants;
    expect(grants.map((g) => g.grantId)).toEqual(["aak-3"]);

    // Idempotent: a second revoke of the same key tombstones nothing more.
    const again = await handleRevokeAcmeAccountKeyGrant(h.deps, {
      request: revoke,
      signature: hex(sig),
    });
    expect(again.status).toBe(200);
    expect((again.body as { revoked: number }).revoked).toBe(0);
  });

  it("#28: ALSO drops the seal-to-box delivery slot of the rotated key", async () => {
    const h = await mkHarness();
    const delivery = new InMemoryAcmeAccountKeyDeliveryStorage();
    const deps: AcmeAccountKeysDeps = { ...h.deps, delivery };

    // A box holds a released-key slot for key-X (its own server domain).
    await delivery.put({
      serverDomain: "nas.dani.flagship.services",
      accountKeyId: "key-X",
      sealedAccountKeyHex: "cc".repeat(8),
      recipientPubHex: "aa".repeat(32),
      issuedAt: 1_000_000,
      expiresAt: 9_999_999_999_999,
      revokedAt: null,
    });
    // A slot of a DIFFERENT key must survive.
    await delivery.put({
      serverDomain: "media.dani.flagship.services",
      accountKeyId: "key-Y",
      sealedAccountKeyHex: "dd".repeat(8),
      recipientPubHex: "bb".repeat(32),
      issuedAt: 1_000_000,
      expiresAt: 9_999_999_999_999,
      revokedAt: null,
    });

    const revoke: RevokeAcmeAccountKey = {
      accountKeyId: "key-X",
      username: USER,
      reason: "compromise",
      issuedAt: 1_000_500,
    };
    const res = await handleRevokeAcmeAccountKeyGrant(deps, {
      request: revoke,
      signature: hex(signRevokeAcmeAccountKey(revoke, h.userIrk)),
    });
    expect(res.status).toBe(200);
    expect((res.body as { deliveryDropped: number }).deliveryDropped).toBe(1);

    // The rotated key's box slot is gone; the other key's slot survives.
    expect(await delivery.getByDomain("nas.dani.flagship.services")).toBeUndefined();
    expect(
      (await delivery.getByDomain("media.dani.flagship.services"))?.accountKeyId,
    ).toBe("key-Y");
  });

  it("#28: delivery sweep is a no-op when no delivery store is wired", async () => {
    const h = await mkHarness(); // deps WITHOUT a delivery store
    const revoke: RevokeAcmeAccountKey = {
      accountKeyId: "key-X",
      username: USER,
      reason: "rotation",
      issuedAt: 1_000_500,
    };
    const res = await handleRevokeAcmeAccountKeyGrant(h.deps, {
      request: revoke,
      signature: hex(signRevokeAcmeAccountKey(revoke, h.userIrk)),
    });
    expect(res.status).toBe(200);
    expect((res.body as { deliveryDropped: number }).deliveryDropped).toBe(0);
  });

  it("rejects a bad revoke signature with 403", async () => {
    const h = await mkHarness();
    const revoke: RevokeAcmeAccountKey = {
      accountKeyId: "key-X",
      username: USER,
      reason: "compromise",
      issuedAt: 1_000_500,
    };
    const res = await handleRevokeAcmeAccountKeyGrant(h.deps, {
      request: revoke,
      signature: hex(new Uint8Array(64)),
    });
    expect(res.status).toBe(403);
  });

  it("rejects a revoke with an unknown reason with 400", async () => {
    const h = await mkHarness();
    const res = await handleRevokeAcmeAccountKeyGrant(h.deps, {
      request: {
        accountKeyId: "key-X",
        username: USER,
        reason: "bogus" as AccountKeyRevokeReason,
        issuedAt: 1_000_500,
      },
      signature: hex(new Uint8Array(64)),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a revoke for an unknown user with 404", async () => {
    const h = await mkHarness();
    const revoke: RevokeAcmeAccountKey = {
      accountKeyId: "key-X",
      username: "nobody",
      reason: "demotion",
      issuedAt: 1_000_500,
    };
    const sig = signRevokeAcmeAccountKey(revoke, h.userIrk);
    const res = await handleRevokeAcmeAccountKeyGrant(h.deps, {
      request: revoke,
      signature: hex(sig),
    });
    expect(res.status).toBe(404);
  });
});

describe("requireMinter", () => {
  it("allows the account IRK directly (fast path)", async () => {
    const h = await mkHarness();
    const check = await requireMinter(h.deps, {
      username: USER,
      signerPubHex: hex(h.userIrk.publicKey),
    });
    expect(check).toEqual({ ok: true });
  });

  it("allows a device holding an active, verifying ACME account-key grant", async () => {
    const h = await mkHarness();
    const admin = makeKey();
    await handleMintAcmeAccountKeyGrant(
      h.deps,
      mintGrant({ userIrk: h.userIrk, recipientPub: admin.publicKey }).body,
    );
    const check = await requireMinter(h.deps, {
      username: USER,
      signerPubHex: hex(admin.publicKey),
    });
    expect(check).toEqual({ ok: true });
  });

  it("denies an unknown user", async () => {
    const h = await mkHarness();
    const check = await requireMinter(h.deps, {
      username: "nobody",
      signerPubHex: hex(makeKey().publicKey),
    });
    expect(check).toEqual({ ok: false, reason: "username not registered" });
  });

  it("denies a key that holds no grant", async () => {
    const h = await mkHarness();
    const check = await requireMinter(h.deps, {
      username: USER,
      signerPubHex: hex(makeKey().publicKey),
    });
    expect(check).toEqual({ ok: false, reason: "not an account minter" });
  });

  it("denies a device whose grant has expired", async () => {
    const h = await mkHarness();
    const admin = makeKey();
    await handleMintAcmeAccountKeyGrant(
      h.deps,
      mintGrant({
        userIrk: h.userIrk,
        recipientPub: admin.publicKey,
        issuedAt: 1_000_000,
        expiresAt: 1_000_010,
      }).body,
    );
    h.clock.now = 2_000_000; // now well past expiry
    const check = await requireMinter(h.deps, {
      username: USER,
      signerPubHex: hex(admin.publicKey),
    });
    expect(check).toEqual({ ok: false, reason: "not an account minter" });
  });

  it("denies a grant that no longer verifies under the current IRK (post-rotation)", async () => {
    // Models Replace-device / Wipe: a grant signed under a now-superseded IRK
    // survives as an active row but no longer verifies under the user's CURRENT
    // IRK. We construct that by storing a grant signed with a ROGUE key.
    const h = await mkHarness();
    const admin = makeKey();
    const rogue = makeKey();
    const grant: AcmeAccountKeyGrant = {
      grantId: "aak-rogue",
      username: USER,
      accountKeyId: "key-X",
      recipientPubKey: admin.publicKey,
      sealedAccountKey: new Uint8Array([1, 2, 3, 4]),
      issuedAt: 1_000_000,
      expiresAt: 1_000_000 + 30 * 24 * 3_600_000,
    };
    const rogueSig = signAcmeAccountKeyGrant(grant, rogue); // NOT the user IRK
    await h.storage.put({
      grantId: grant.grantId,
      username: USER,
      accountKeyId: grant.accountKeyId,
      recipientPubHex: hex(admin.publicKey),
      sealedAccountKeyHex: hex(grant.sealedAccountKey),
      issuedAt: grant.issuedAt,
      expiresAt: grant.expiresAt,
      signatureHex: hex(rogueSig),
      revokedAt: null,
    });
    const check = await requireMinter(h.deps, {
      username: USER,
      signerPubHex: hex(admin.publicKey),
    });
    expect(check).toEqual({ ok: false, reason: "not an account minter" });
  });

  it("denies after the device's accountKeyId is revoked (rotation kills the copy)", async () => {
    const h = await mkHarness();
    const admin = makeKey();
    await handleMintAcmeAccountKeyGrant(
      h.deps,
      mintGrant({
        userIrk: h.userIrk,
        recipientPub: admin.publicKey,
        accountKeyId: "key-X",
      }).body,
    );
    // Sanity: holder is a minter before revoke.
    expect(
      await requireMinter(h.deps, {
        username: USER,
        signerPubHex: hex(admin.publicKey),
      }),
    ).toEqual({ ok: true });

    const revoke: RevokeAcmeAccountKey = {
      accountKeyId: "key-X",
      username: USER,
      reason: "demotion",
      issuedAt: 1_000_500,
    };
    await handleRevokeAcmeAccountKeyGrant(h.deps, {
      request: revoke,
      signature: hex(signRevokeAcmeAccountKey(revoke, h.userIrk)),
    });

    const after = await requireMinter(h.deps, {
      username: USER,
      signerPubHex: hex(admin.publicKey),
    });
    expect(after).toEqual({ ok: false, reason: "not an account minter" });
  });
});
