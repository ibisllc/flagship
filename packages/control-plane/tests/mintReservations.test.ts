/**
 * Unit tests for the mint-reservation lease handlers (per-user-cert design).
 *
 * Mirrors watchDelegates.test.ts: pure handlers over InMemory storage, no
 * network, real sign/verify. Covered:
 *   - acquire happy path (a real minter wins the lease → acquired:true)
 *   - back-off: a SECOND minter loses while a live lease is held by another
 *     (acquired:false, holder = the incumbent)
 *   - dead-lead-reclaim: once the lease lapses (now >= expiresAt), the next
 *     minter takes it over
 *   - a minter re-acquiring its OWN live lease extends it (acquired:true)
 *   - requireMinter gate: a key that is NOT a minter is rejected (403) even
 *     with a valid self-signature; the lease is untouched
 *   - bad self-signature → 403; unknown user → 403 (not a minter)
 *   - release frees the lease (a fresh acquire then succeeds); release by a
 *     non-holder is a no-op (can't free a successor's lease)
 */

import { describe, expect, it } from "vitest";
import {
  ed,
  signMintReservation,
  signAcmeAccountKeyGrant,
  type AcmeAccountKeyGrant,
  type Keypair,
  type MintReservationClaim,
} from "@flagship/protocol";
import {
  InMemoryAcmeAccountKeyGrantStorage,
  InMemoryMintReservationStorage,
  InMemoryUsernameStorage,
} from "@flagship/storage";
import {
  handleAcquireMintReservation,
  handleReleaseMintReservation,
  type MintReservationsDeps,
} from "../src/mintReservations.js";

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
  deps: MintReservationsDeps;
  usernames: InMemoryUsernameStorage;
  reservations: InMemoryMintReservationStorage;
  acmeGrants: InMemoryAcmeAccountKeyGrantStorage;
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
  const reservations = new InMemoryMintReservationStorage();
  const acmeGrants = new InMemoryAcmeAccountKeyGrantStorage();
  const clock = { now: 1_000_000 };
  const deps: MintReservationsDeps = {
    reservations,
    acmeGrants,
    usernames,
    now: () => clock.now,
  };
  return { deps, usernames, reservations, acmeGrants, userIrk, clock };
}

/** Seal an admin device as a minter by handing it an active ACME account-key
 *  grant (IRK-signed by the user). The holder then signs the lease with its
 *  OWN key; requireMinter confirms it holds this grant. */
async function makeMinter(
  h: Harness,
  args?: { grantId?: string; expiresAt?: number },
): Promise<Keypair> {
  const admin = makeKey();
  const grant: AcmeAccountKeyGrant = {
    grantId: args?.grantId ?? "aak-" + hex(admin.publicKey).slice(0, 8),
    username: USER,
    accountKeyId: "key-X",
    recipientPubKey: admin.publicKey,
    sealedAccountKey: new Uint8Array([1, 2, 3, 4]),
    issuedAt: 1_000_000,
    expiresAt: args?.expiresAt ?? 1_000_000 + 30 * 24 * 3_600_000,
  };
  const sig = signAcmeAccountKeyGrant(grant, h.userIrk);
  await h.acmeGrants.put({
    grantId: grant.grantId,
    username: USER,
    accountKeyId: grant.accountKeyId,
    recipientPubHex: hex(admin.publicKey),
    sealedAccountKeyHex: hex(grant.sealedAccountKey),
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    signatureHex: hex(sig),
    revokedAt: null,
  });
  return admin;
}

function acquireBody(
  holder: Keypair,
  expiresAt: number,
  username = USER,
): { claim: { username: string; holderPubKey: string; expiresAt: number }; signature: string } {
  const claim: MintReservationClaim = {
    username,
    holderPubKey: holder.publicKey,
    expiresAt,
  };
  return {
    claim: {
      username,
      holderPubKey: hex(holder.publicKey),
      expiresAt,
    },
    signature: hex(signMintReservation(claim, holder)),
  };
}

describe("handleAcquireMintReservation", () => {
  it("the account IRK can acquire the lease directly", async () => {
    const h = await mkHarness();
    const res = await handleAcquireMintReservation(
      h.deps,
      acquireBody(h.userIrk, h.clock.now + 300_000),
    );
    expect(res.status).toBe(200);
    const body = res.body as { acquired: boolean; holder: { holderPubKey: string } };
    expect(body.acquired).toBe(true);
    expect(body.holder.holderPubKey).toBe(hex(h.userIrk.publicKey));
  });

  it("a real minter (grant holder) wins the lease", async () => {
    const h = await mkHarness();
    const minter = await makeMinter(h);
    const res = await handleAcquireMintReservation(
      h.deps,
      acquireBody(minter, h.clock.now + 300_000),
    );
    expect(res.status).toBe(200);
    expect((res.body as { acquired: boolean }).acquired).toBe(true);
  });

  it("a second minter BACKS OFF while another holds a live lease", async () => {
    const h = await mkHarness();
    const first = await makeMinter(h, { grantId: "aak-first" });
    const second = await makeMinter(h, { grantId: "aak-second" });

    const r1 = await handleAcquireMintReservation(
      h.deps,
      acquireBody(first, h.clock.now + 300_000),
    );
    expect((r1.body as { acquired: boolean }).acquired).toBe(true);

    // Second minter tries while first's lease is still live → loses, and the
    // reply names the incumbent holder.
    const r2 = await handleAcquireMintReservation(
      h.deps,
      acquireBody(second, h.clock.now + 300_000),
    );
    expect(r2.status).toBe(200);
    const b2 = r2.body as { acquired: boolean; holder: { holderPubKey: string } };
    expect(b2.acquired).toBe(false);
    expect(b2.holder.holderPubKey).toBe(hex(first.publicKey));
  });

  it("RECLAIMS a dead lead's lapsed lease", async () => {
    const h = await mkHarness();
    const dead = await makeMinter(h, { grantId: "aak-dead" });
    const live = await makeMinter(h, { grantId: "aak-live" });

    // Dead lead grabs a short lease, then never mints.
    const r1 = await handleAcquireMintReservation(
      h.deps,
      acquireBody(dead, h.clock.now + 1_000),
    );
    expect((r1.body as { acquired: boolean }).acquired).toBe(true);

    // Time moves past the lease's expiry (δ ≪ remaining cert life).
    h.clock.now += 5_000;

    // The next minter takes it over.
    const r2 = await handleAcquireMintReservation(
      h.deps,
      acquireBody(live, h.clock.now + 300_000),
    );
    const b2 = r2.body as { acquired: boolean; holder: { holderPubKey: string } };
    expect(b2.acquired).toBe(true);
    expect(b2.holder.holderPubKey).toBe(hex(live.publicKey));
  });

  it("a minter re-acquiring its OWN live lease extends it", async () => {
    const h = await mkHarness();
    const minter = await makeMinter(h);
    await handleAcquireMintReservation(
      h.deps,
      acquireBody(minter, h.clock.now + 100_000),
    );
    const again = await handleAcquireMintReservation(
      h.deps,
      acquireBody(minter, h.clock.now + 500_000),
    );
    const b = again.body as { acquired: boolean; holder: { expiresAt: number } };
    expect(b.acquired).toBe(true);
    expect(b.holder.expiresAt).toBe(h.clock.now + 500_000);
  });

  it("REJECTS a non-minter key with 403 even with a valid self-signature; lease untouched", async () => {
    const h = await mkHarness();
    const stranger = makeKey(); // holds no grant, is not the IRK
    const res = await handleAcquireMintReservation(
      h.deps,
      acquireBody(stranger, h.clock.now + 300_000),
    );
    expect(res.status).toBe(403);
    // No reservation was created.
    expect(await h.reservations.get(USER)).toBeUndefined();
  });

  it("rejects a bad self-signature with 403", async () => {
    const h = await mkHarness();
    const minter = await makeMinter(h);
    const body = acquireBody(minter, h.clock.now + 300_000);
    body.signature = hex(new Uint8Array(64)); // all-zero sig
    const res = await handleAcquireMintReservation(h.deps, body);
    expect(res.status).toBe(403);
  });

  it("rejects an unknown user (not a minter) with 403", async () => {
    const h = await mkHarness();
    const minter = makeKey();
    const res = await handleAcquireMintReservation(
      h.deps,
      acquireBody(minter, h.clock.now + 300_000, "nobody"),
    );
    expect(res.status).toBe(403);
  });

  it("rejects a malformed body with 400", async () => {
    const h = await mkHarness();
    const res = await handleAcquireMintReservation(h.deps, {
      claim: { username: USER, holderPubKey: "short", expiresAt: 1 },
      signature: hex(new Uint8Array(64)),
    } as never);
    expect(res.status).toBe(400);
  });
});

describe("handleReleaseMintReservation", () => {
  it("releases the lease so a fresh acquire then succeeds", async () => {
    const h = await mkHarness();
    const first = await makeMinter(h, { grantId: "aak-first" });
    const second = await makeMinter(h, { grantId: "aak-second" });

    await handleAcquireMintReservation(
      h.deps,
      acquireBody(first, h.clock.now + 300_000),
    );

    // First releases early (forfeits leadership).
    const rel = await handleReleaseMintReservation(
      h.deps,
      acquireBody(first, h.clock.now + 300_000),
    );
    expect(rel.status).toBe(200);
    expect(await h.reservations.get(USER)).toBeUndefined();

    // Now the second minter can grab it even though the original lease window
    // had not yet elapsed.
    const r2 = await handleAcquireMintReservation(
      h.deps,
      acquireBody(second, h.clock.now + 300_000),
    );
    expect((r2.body as { acquired: boolean }).acquired).toBe(true);
  });

  it("release by a NON-holder is a no-op (can't free a successor's lease)", async () => {
    const h = await mkHarness();
    const holder = await makeMinter(h, { grantId: "aak-holder" });
    const other = await makeMinter(h, { grantId: "aak-other" });

    await handleAcquireMintReservation(
      h.deps,
      acquireBody(holder, h.clock.now + 300_000),
    );

    // A different minter tries to release — handler returns 200 but the lease
    // is NOT freed (storage only releases when the caller actually holds it).
    const rel = await handleReleaseMintReservation(
      h.deps,
      acquireBody(other, h.clock.now + 300_000),
    );
    expect(rel.status).toBe(200);
    const still = await h.reservations.get(USER);
    expect(still?.holderPubHex).toBe(hex(holder.publicKey));
  });

  it("rejects a release with a bad self-signature with 403", async () => {
    const h = await mkHarness();
    const minter = await makeMinter(h);
    const body = acquireBody(minter, h.clock.now + 300_000);
    body.signature = hex(new Uint8Array(64));
    const res = await handleReleaseMintReservation(h.deps, body);
    expect(res.status).toBe(403);
  });
});
