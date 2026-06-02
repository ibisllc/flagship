/**
 * Unit tests for the seal-to-box ACME account-key DELIVERY handlers (#28
 * Option B; per-user-cert design). Pure handlers over InMemory storage, no
 * network, real sign/verify. Mirrors secretMailbox.test.ts (the box-sealed
 * lease) since this is the same deposit-and-release shape.
 *
 * Covered:
 *   deposit:  happy path (records BOTH the grant for audit/requireMinter AND
 *             the delivery slot; reply NEVER echoes the sealed key);
 *             wrong-recipient (recipientPubKey ≠ directory STK) → 403;
 *             bad IRK signature → 403; unknown server → 404; expired → 400
 *   release:  present (sealed key only — no plaintext); absent → 404;
 *             expired → 404; revoked → 404
 *   revoke:   drops the slot (release then 404s); idempotent; bad sig → 403;
 *             foreign username → 403
 */

import { describe, expect, it } from "vitest";
import {
  ed,
  signAcmeAccountKeyGrant,
  signRevokeAcmeAccountKey,
  type AccountKeyRevokeReason,
  type AcmeAccountKeyGrant,
  type Keypair,
  type RevokeAcmeAccountKey,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handleDepositAcmeAccountKey,
  handleReleaseAcmeAccountKey,
  handleRevokeAcmeAccountKeyDelivery,
  type AcmeAccountKeyDeliveryDeps,
} from "../src/acmeAccountKeyDelivery.js";

const HOST = "nas.dani.flagship.services";
const USERNAME = "dani";

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
  deps: AcmeAccountKeyDeliveryDeps;
  storage: InMemoryStorage;
  userIrk: Keypair;
  /** The box STK — registered as the server's identity pubkey (the seal
   *  recipient the deposit pins against). */
  boxStk: Keypair;
  clock: { now: number };
}

async function mkHarness(): Promise<Harness> {
  const userIrk = makeKey();
  const boxStk = makeKey();
  const storage = new InMemoryStorage();
  await storage.usernames.put({
    username: USERNAME,
    irkPubHex: hex(userIrk.publicKey),
    claimedAt: 1,
  });
  await storage.servers.put({
    serverDomain: HOST,
    username: USERNAME,
    identityPubKeyHex: hex(boxStk.publicKey),
    registeredAt: 2,
  });
  const clock = { now: 1_000_000 };
  const deps: AcmeAccountKeyDeliveryDeps = {
    servers: storage.servers,
    usernames: storage.usernames,
    delivery: storage.acmeAccountKeyDelivery,
    acmeAccountKeyGrants: storage.acmeAccountKeyGrants,
    now: () => clock.now,
  };
  return { deps, storage, userIrk, boxStk, clock };
}

function depositBody(args: {
  userIrk: Keypair;
  recipientPub: Uint8Array; // the box STK pub the key is sealed to
  username?: string;
  accountKeyId?: string;
  sealedAccountKey?: Uint8Array;
  issuedAt?: number;
  expiresAt?: number;
  grantId?: string;
}) {
  const sealedAccountKey =
    args.sealedAccountKey ?? new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const accountKeyId = args.accountKeyId ?? "acct-key-id-1";
  const issuedAt = args.issuedAt ?? 1_000_000;
  const expiresAt = args.expiresAt ?? issuedAt + 30 * 24 * 3_600_000;
  const grantId = args.grantId ?? "aak-deliv-1";
  const grant: AcmeAccountKeyGrant = {
    grantId,
    username: args.username ?? USERNAME,
    accountKeyId,
    recipientPubKey: args.recipientPub,
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
        recipientPubKey: hex(args.recipientPub),
        sealedAccountKey: hex(sealedAccountKey),
        issuedAt,
        expiresAt,
      },
      signature: hex(signature),
    },
    sealedAccountKey,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Deposit.
// ──────────────────────────────────────────────────────────────────────

describe("handleDepositAcmeAccountKey", () => {
  it("happy path: records the grant + the slot; reply has NO sealed key", async () => {
    const h = await mkHarness();
    const { body, sealedAccountKey } = depositBody({
      userIrk: h.userIrk,
      recipientPub: h.boxStk.publicKey,
    });
    const res = await handleDepositAcmeAccountKey(h.deps, HOST, body);
    expect(res.status).toBe(200);
    const out = res.body as Record<string, unknown>;
    expect(out.ok).toBe(true);
    expect(out.accountKeyId).toBe("acct-key-id-1");
    // I1 — the sealed key is NEVER echoed back from the deposit.
    expect(out.sealedAccountKeyHex).toBeUndefined();
    expect(out.sealedAccountKey).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain(hex(sealedAccountKey));

    // The delivery slot now exists, sealed to the box STK.
    const slot = await h.storage.acmeAccountKeyDelivery.getByDomain(HOST);
    expect(slot?.recipientPubHex).toBe(hex(h.boxStk.publicKey));
    expect(slot?.sealedAccountKeyHex).toBe(hex(sealedAccountKey));

    // The grant was ALSO recorded for audit + requireMinter.
    const grant = await h.storage.acmeAccountKeyGrants.get("aak-deliv-1");
    expect(grant?.username).toBe(USERNAME);
    expect(grant?.recipientPubHex).toBe(hex(h.boxStk.publicKey));
  });

  it("a re-deposit (rotation re-seal) supersedes the prior slot", async () => {
    const h = await mkHarness();
    await handleDepositAcmeAccountKey(
      h.deps,
      HOST,
      depositBody({
        userIrk: h.userIrk,
        recipientPub: h.boxStk.publicKey,
        accountKeyId: "key-old",
        grantId: "aak-old",
        sealedAccountKey: new Uint8Array([1, 1, 1, 1]),
      }).body,
    );
    const again = await handleDepositAcmeAccountKey(
      h.deps,
      HOST,
      depositBody({
        userIrk: h.userIrk,
        recipientPub: h.boxStk.publicKey,
        accountKeyId: "key-new",
        grantId: "aak-new",
        sealedAccountKey: new Uint8Array([2, 2, 2, 2]),
      }).body,
    );
    expect(again.status).toBe(200);
    const slot = await h.storage.acmeAccountKeyDelivery.getByDomain(HOST);
    expect(slot?.accountKeyId).toBe("key-new");
    expect(slot?.sealedAccountKeyHex).toBe(hex(new Uint8Array([2, 2, 2, 2])));
  });

  it("rejects a grant sealed to the WRONG recipient (≠ directory STK) with 403", async () => {
    const h = await mkHarness();
    const someoneElse = makeKey();
    // The IRK signature is valid, but the seal recipient is NOT the box STK.
    const { body } = depositBody({
      userIrk: h.userIrk,
      recipientPub: someoneElse.publicKey,
    });
    const res = await handleDepositAcmeAccountKey(h.deps, HOST, body);
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/recipientPubKey/);
    // No slot was created.
    expect(await h.storage.acmeAccountKeyDelivery.getByDomain(HOST)).toBeUndefined();
  });

  it("rejects a bad IRK signature with 403", async () => {
    const h = await mkHarness();
    const { body } = depositBody({ userIrk: h.userIrk, recipientPub: h.boxStk.publicKey });
    body.signature = hex(new Uint8Array(64)); // all-zero sig
    const res = await handleDepositAcmeAccountKey(h.deps, HOST, body);
    expect(res.status).toBe(403);
    expect(await h.storage.acmeAccountKeyDelivery.getByDomain(HOST)).toBeUndefined();
  });

  it("rejects a deposit signed by a DIFFERENT key (not the account IRK) with 403", async () => {
    const h = await mkHarness();
    const attacker = makeKey();
    // Attacker signs a grant for the box STK with their own key — the stored
    // IRK won't verify it.
    const { body } = depositBody({ userIrk: attacker, recipientPub: h.boxStk.publicKey });
    const res = await handleDepositAcmeAccountKey(h.deps, HOST, body);
    expect(res.status).toBe(403);
  });

  it("rejects a deposit for an unknown server with 404", async () => {
    const h = await mkHarness();
    const { body } = depositBody({ userIrk: h.userIrk, recipientPub: h.boxStk.publicKey });
    const res = await handleDepositAcmeAccountKey(
      h.deps,
      "ghost.dani.flagship.services",
      body,
    );
    expect(res.status).toBe(404);
  });

  it("rejects a deposit for a revoked server with 403", async () => {
    const h = await mkHarness();
    await h.storage.servers.put({
      serverDomain: HOST,
      username: USERNAME,
      identityPubKeyHex: hex(h.boxStk.publicKey),
      registeredAt: 2,
      revokedAt: 50,
    });
    const { body } = depositBody({ userIrk: h.userIrk, recipientPub: h.boxStk.publicKey });
    const res = await handleDepositAcmeAccountKey(h.deps, HOST, body);
    expect(res.status).toBe(403);
  });

  it("rejects an already-expired grant with 400", async () => {
    const h = await mkHarness();
    const { body } = depositBody({
      userIrk: h.userIrk,
      recipientPub: h.boxStk.publicKey,
      issuedAt: 1,
      expiresAt: 500, // < clock.now (1_000_000)
    });
    const res = await handleDepositAcmeAccountKey(h.deps, HOST, body);
    expect(res.status).toBe(400);
  });

  it("rejects a malformed body with 400", async () => {
    const h = await mkHarness();
    expect((await handleDepositAcmeAccountKey(h.deps, HOST, {})).status).toBe(400);
    expect(
      (await handleDepositAcmeAccountKey(h.deps, HOST, { grant: {}, signature: "zz" }))
        .status,
    ).toBe(400);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Release (box boot — public read).
// ──────────────────────────────────────────────────────────────────────

describe("handleReleaseAcmeAccountKey", () => {
  it("returns the SEALED key + public refs when an active slot exists", async () => {
    const h = await mkHarness();
    const { body, sealedAccountKey } = depositBody({
      userIrk: h.userIrk,
      recipientPub: h.boxStk.publicKey,
    });
    await handleDepositAcmeAccountKey(h.deps, HOST, body);

    const res = await handleReleaseAcmeAccountKey(h.deps, HOST);
    expect(res.status).toBe(200);
    const out = res.body as Record<string, unknown>;
    expect(out.sealedAccountKeyHex).toBe(hex(sealedAccountKey));
    expect(out.accountKeyId).toBe("acct-key-id-1");
    expect(out.recipientPubKeyHex).toBe(hex(h.boxStk.publicKey));
    expect(typeof out.expiresAt).toBe("number");
  });

  it("404s when no slot exists", async () => {
    const h = await mkHarness();
    expect((await handleReleaseAcmeAccountKey(h.deps, HOST)).status).toBe(404);
  });

  it("404s when the slot has expired", async () => {
    const h = await mkHarness();
    await handleDepositAcmeAccountKey(
      h.deps,
      HOST,
      depositBody({
        userIrk: h.userIrk,
        recipientPub: h.boxStk.publicKey,
        issuedAt: 1,
        expiresAt: 1_000_001,
      }).body,
    );
    // Advance the clock past expiry.
    h.clock.now = 2_000_000;
    expect((await handleReleaseAcmeAccountKey(h.deps, HOST)).status).toBe(404);
  });

  it("404s when the slot is revoked (defensive — release reads revokedAt)", async () => {
    const h = await mkHarness();
    await handleDepositAcmeAccountKey(
      h.deps,
      HOST,
      depositBody({ userIrk: h.userIrk, recipientPub: h.boxStk.publicKey }).body,
    );
    // Soft-revoke the slot in place (the release gate must refuse it).
    const slot = await h.storage.acmeAccountKeyDelivery.getByDomain(HOST);
    await h.storage.acmeAccountKeyDelivery.put({ ...slot!, revokedAt: 1_000_100 });
    expect((await handleReleaseAcmeAccountKey(h.deps, HOST)).status).toBe(404);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Delivery-revoke.
// ──────────────────────────────────────────────────────────────────────

function revokeBody(args: {
  userIrk: Keypair;
  accountKeyId?: string;
  username?: string;
  reason?: AccountKeyRevokeReason;
  issuedAt?: number;
}) {
  const envelope: RevokeAcmeAccountKey = {
    accountKeyId: args.accountKeyId ?? "acct-key-id-1",
    username: args.username ?? USERNAME,
    reason: args.reason ?? "compromise",
    issuedAt: args.issuedAt ?? 1_000_500,
  };
  const sig = signRevokeAcmeAccountKey(envelope, args.userIrk);
  return { request: envelope, signature: hex(sig) };
}

describe("handleRevokeAcmeAccountKeyDelivery", () => {
  it("drops the slot so a subsequent release 404s; is idempotent", async () => {
    const h = await mkHarness();
    await handleDepositAcmeAccountKey(
      h.deps,
      HOST,
      depositBody({ userIrk: h.userIrk, recipientPub: h.boxStk.publicKey }).body,
    );
    // Slot is releasable before the revoke.
    expect((await handleReleaseAcmeAccountKey(h.deps, HOST)).status).toBe(200);

    const res = await handleRevokeAcmeAccountKeyDelivery(
      h.deps,
      HOST,
      revokeBody({ userIrk: h.userIrk }),
    );
    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);

    // The slot is gone — release now 404s.
    expect((await handleReleaseAcmeAccountKey(h.deps, HOST)).status).toBe(404);

    // Idempotent: a second revoke still 200s (nothing left to drop).
    const again = await handleRevokeAcmeAccountKeyDelivery(
      h.deps,
      HOST,
      revokeBody({ userIrk: h.userIrk }),
    );
    expect(again.status).toBe(200);
  });

  it("rejects a bad revoke signature with 403 (slot survives)", async () => {
    const h = await mkHarness();
    await handleDepositAcmeAccountKey(
      h.deps,
      HOST,
      depositBody({ userIrk: h.userIrk, recipientPub: h.boxStk.publicKey }).body,
    );
    const res = await handleRevokeAcmeAccountKeyDelivery(h.deps, HOST, {
      request: {
        accountKeyId: "acct-key-id-1",
        username: USERNAME,
        reason: "compromise",
        issuedAt: 1_000_500,
      },
      signature: hex(new Uint8Array(64)),
    });
    expect(res.status).toBe(403);
    // The slot is untouched.
    expect((await handleReleaseAcmeAccountKey(h.deps, HOST)).status).toBe(200);
  });

  it("rejects a revoke whose username does not own the server with 403", async () => {
    const h = await mkHarness();
    await handleDepositAcmeAccountKey(
      h.deps,
      HOST,
      depositBody({ userIrk: h.userIrk, recipientPub: h.boxStk.publicKey }).body,
    );
    // Register a second account + sign the revoke under ITS irk for ITS name.
    const otherIrk = makeKey();
    await h.storage.usernames.put({
      username: "mallory",
      irkPubHex: hex(otherIrk.publicKey),
      claimedAt: 1,
    });
    const res = await handleRevokeAcmeAccountKeyDelivery(
      h.deps,
      HOST,
      revokeBody({ userIrk: otherIrk, username: "mallory" }),
    );
    expect(res.status).toBe(403);
    expect((await handleReleaseAcmeAccountKey(h.deps, HOST)).status).toBe(200);
  });

  it("rejects a revoke for an unknown server with 404", async () => {
    const h = await mkHarness();
    const res = await handleRevokeAcmeAccountKeyDelivery(
      h.deps,
      "ghost.dani.flagship.services",
      revokeBody({ userIrk: h.userIrk }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects a malformed revoke body with 400", async () => {
    const h = await mkHarness();
    expect(
      (await handleRevokeAcmeAccountKeyDelivery(h.deps, HOST, {})).status,
    ).toBe(400);
    expect(
      (
        await handleRevokeAcmeAccountKeyDelivery(h.deps, HOST, {
          request: {
            accountKeyId: "k",
            username: USERNAME,
            reason: "bogus" as AccountKeyRevokeReason,
            issuedAt: 1,
          },
          signature: hex(new Uint8Array(64)),
        })
      ).status,
    ).toBe(400);
  });
});
