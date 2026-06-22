import { describe, expect, it } from "vitest";
import {
  ed,
  signDeviceEndpointClaim,
  signServerTransferOffer,
  signServerTransferClaim,
  type DeviceEndpointClaim,
  type Keypair,
  type ServerTransferOffer,
  type ServerTransferClaim,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handlePostTransferOffer,
  handlePostTransferClaim,
  handleGetTransferClaim,
  handleGetTransferRehome,
  type ServerTransferDeps,
} from "../src/serverTransfer.js";

// Transfer-a-box broker (docs/account-deletion-and-name-reclaim.md §4): the
// giver deposits an offer, the acquirer claims it, and `.com` re-homes the
// box's namespace from `<server>.<giver>` to `<server>.<acquirer>`.

const APEX = "flagship.services";
const HOST = "home.alice.flagship.services";

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
function rand(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

const NOW = 1_000_000;
const aliceIrk = makeKey();
const bobIrk = makeKey();
const boxIdentity = makeKey();

async function setup(): Promise<InMemoryStorage> {
  const s = new InMemoryStorage();
  await s.usernames.put({ username: "alice", irkPubHex: hex(aliceIrk.publicKey), claimedAt: 1 });
  await s.usernames.put({ username: "bob", irkPubHex: hex(bobIrk.publicKey), claimedAt: 1 });
  await s.servers.put({
    serverDomain: HOST,
    username: "alice",
    identityPubKeyHex: hex(boxIdentity.publicKey),
    registeredAt: 2,
  });
  // Pre-existing routing record for the box (RCK held by the giver's phone).
  await s.routing.register({
    subdomain: "home.alice",
    username: "alice",
    rckPubKeyHex: hex(rand(32)),
    currentTargetHex: hex(boxIdentity.publicKey),
    registeredAt: 2,
    lastTargetUpdate: 2,
    lastTargetNonce: "00".repeat(8),
  });
  return s;
}

function deps(s: InMemoryStorage, now = NOW): ServerTransferDeps {
  return {
    servers: s.servers,
    usernames: s.usernames,
    routing: s.routing,
    serverTransfers: s.serverTransfers,
    auditEvents: s.auditEvents,
    apex: APEX,
    now: () => now,
  };
}

function mailboxAuth(irk: Keypair, username: string, now = NOW) {
  const nonce = rand(32);
  const claim: DeviceEndpointClaim = {
    username,
    endpointLabel: "device",
    phoneIrkPub: irk.publicKey,
    issuedAt: now,
    expiresAt: now + 120_000,
    nonce,
  };
  const sig = signDeviceEndpointClaim(claim, irk);
  return {
    auth: {
      username,
      endpointLabel: "device",
      phoneIrkPub: hex(irk.publicKey),
      issuedAt: now,
      expiresAt: now + 120_000,
      nonce: hex(nonce),
    },
    authSignature: hex(sig),
  };
}

function offerBody(irk: Keypair, opts?: { nonce?: string; now?: number; expiresAt?: number; sign?: Keypair }) {
  const now = opts?.now ?? NOW;
  const nonce = opts?.nonce ?? hex(rand(32));
  const offer: ServerTransferOffer = {
    serverDomain: HOST,
    transferNonce: nonce,
    issuedAt: now,
    expiresAt: opts?.expiresAt ?? now + 15 * 60_000,
  };
  const sig = signServerTransferOffer(offer, opts?.sign ?? irk);
  return {
    ...mailboxAuth(irk, "alice", now),
    offer,
    offerSignature: hex(sig),
  };
}

function claimBody(
  irk: Keypair,
  username: string,
  nonce: string,
  opts?: { now?: number; acquirerIrkPub?: Uint8Array; sign?: Keypair },
) {
  const now = opts?.now ?? NOW;
  const claim: ServerTransferClaim = {
    serverDomain: HOST,
    transferNonce: nonce,
    acquirerUsername: username,
    acquirerIrkPub: opts?.acquirerIrkPub ?? irk.publicKey,
    issuedAt: now,
  };
  const sig = signServerTransferClaim(claim, opts?.sign ?? irk);
  return {
    claim: {
      serverDomain: HOST,
      transferNonce: nonce,
      acquirerUsername: username,
      acquirerIrkPub: hex(claim.acquirerIrkPub),
      issuedAt: now,
    },
    claimSignature: hex(sig),
  };
}

describe("transfer-a-box broker", () => {
  it("offer → claim moves ownership to the acquirer's namespace", async () => {
    const s = await setup();
    const nonce = hex(rand(32));
    const offerRes = await handlePostTransferOffer(deps(s), HOST, offerBody(aliceIrk, { nonce }));
    expect(offerRes.status).toBe(200);

    const claimRes = await handlePostTransferClaim(
      deps(s),
      HOST,
      claimBody(bobIrk, "bob", nonce),
    );
    expect(claimRes.status).toBe(200);
    const body = claimRes.body as { newServerDomain: string; acquirerUsername: string };
    expect(body.newServerDomain).toBe("home.bob.flagship.services");
    expect(body.acquirerUsername).toBe("bob");

    // The new servers record exists under bob, same identity key; the old is revoked.
    const moved = await s.servers.get("home.bob.flagship.services");
    expect(moved?.username).toBe("bob");
    expect(moved?.identityPubKeyHex).toBe(hex(boxIdentity.publicKey));
    const old = await s.servers.get(HOST);
    expect(old?.revokedAt).toBeTruthy();

    // Routing moved too: new subdomain registered, old released.
    expect(await s.routing.get("home.bob")).toBeDefined();
    expect(await s.routing.get("home.alice")).toBeUndefined();

    // Audit rows on both feeds.
    const aliceFeed = await s.auditEvents.list("alice", 0, 50);
    const bobFeed = await s.auditEvents.list("bob", 0, 50);
    expect(aliceFeed.some((e) => e.eventKind === "server-transfer-claimed")).toBe(true);
    expect(bobFeed.some((e) => e.eventKind === "server-transfer-claimed")).toBe(true);
  });

  it("rejects an offer signed by the wrong (non-owner) IRK", async () => {
    const s = await setup();
    const nonce = hex(rand(32));
    // Auth as alice (the owner) but sign the offer with bob's key.
    const res = await handlePostTransferOffer(
      deps(s),
      HOST,
      offerBody(aliceIrk, { nonce, sign: bobIrk }),
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/invalid offer signature/);
  });

  it("rejects offer-deposit by a non-owner account", async () => {
    const s = await setup();
    const nonce = hex(rand(32));
    // Bob (not the owner) authenticates + signs a (well-formed) offer for alice's box.
    const offer: ServerTransferOffer = {
      serverDomain: HOST,
      transferNonce: nonce,
      issuedAt: NOW,
      expiresAt: NOW + 15 * 60_000,
    };
    const body = {
      ...mailboxAuth(bobIrk, "bob"),
      offer,
      offerSignature: hex(signServerTransferOffer(offer, bobIrk)),
    };
    const res = await handlePostTransferOffer(deps(s), HOST, body);
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/different account/);
  });

  it("rejects a claim whose acquirerIrkPub is not the acquirer's registered IRK", async () => {
    const s = await setup();
    const nonce = hex(rand(32));
    await handlePostTransferOffer(deps(s), HOST, offerBody(aliceIrk, { nonce }));
    // Sign with a fresh key whose pub is NOT bob's registered IRK.
    const rogue = makeKey();
    const res = await handlePostTransferClaim(
      deps(s),
      HOST,
      claimBody(rogue, "bob", nonce, { acquirerIrkPub: rogue.publicKey }),
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/registered IRK/);
  });

  it("rejects a claim with a forged signature", async () => {
    const s = await setup();
    const nonce = hex(rand(32));
    await handlePostTransferOffer(deps(s), HOST, offerBody(aliceIrk, { nonce }));
    // Build a claim body that names bob's registered IRK but is signed by a
    // different key (sign != bobIrk).
    const wrongSigner = makeKey();
    const res = await handlePostTransferClaim(
      deps(s),
      HOST,
      claimBody(bobIrk, "bob", nonce, { sign: wrongSigner }),
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/invalid claim signature/);
  });

  it("rejects a claim against an absent offer", async () => {
    const s = await setup();
    const res = await handlePostTransferClaim(
      deps(s),
      HOST,
      claimBody(bobIrk, "bob", hex(rand(32))),
    );
    expect(res.status).toBe(404);
  });

  it("rejects a claim whose nonce doesn't match the stored offer", async () => {
    const s = await setup();
    await handlePostTransferOffer(deps(s), HOST, offerBody(aliceIrk, { nonce: hex(rand(32)) }));
    const res = await handlePostTransferClaim(
      deps(s),
      HOST,
      claimBody(bobIrk, "bob", hex(rand(32))),
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/nonce mismatch/i);
  });

  it("rejects a claim against an expired offer (GC'd → 404)", async () => {
    const s = await setup();
    const nonce = hex(rand(32));
    // Offer with a short TTL via the broker default; then claim well past it.
    await handlePostTransferOffer(deps(s, NOW), HOST, offerBody(aliceIrk, { nonce }));
    const late = NOW + 16 * 60_000; // past the 15-min offer TTL
    const res = await handlePostTransferClaim(
      deps(s, late),
      HOST,
      claimBody(bobIrk, "bob", nonce, { now: late }),
    );
    // getOffer GCs the expired unclaimed row, so the claim sees no live offer.
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toMatch(/no live transfer offer/);
  });

  it("is one-time — a second claim after success is rejected (410)", async () => {
    const s = await setup();
    const nonce = hex(rand(32));
    await handlePostTransferOffer(deps(s), HOST, offerBody(aliceIrk, { nonce }));
    const first = await handlePostTransferClaim(deps(s), HOST, claimBody(bobIrk, "bob", nonce));
    expect(first.status).toBe(200);
    // After the move the box is no longer owned by alice, so a replay 403s on
    // the ownership re-check OR 410s on the claimed offer — either way it does
    // NOT move again. Re-deposit is needed for a fresh transfer.
    const second = await handlePostTransferClaim(deps(s), HOST, claimBody(bobIrk, "bob", nonce));
    expect([403, 404, 410]).toContain(second.status);
  });

  it("giver discovers the claim (and the acquirer IRK) via the GET poll", async () => {
    const s = await setup();
    const nonce = hex(rand(32));
    await handlePostTransferOffer(deps(s), HOST, offerBody(aliceIrk, { nonce }));

    // Before a claim — giver poll returns 404 (not yet claimed).
    const pending = await handleGetTransferClaim(deps(s), HOST, mailboxAuth(aliceIrk, "alice"));
    expect(pending.status).toBe(404);

    await handlePostTransferClaim(deps(s), HOST, claimBody(bobIrk, "bob", nonce));

    // After the claim — the giver reads the acquirer IRK for the disk-key re-seal.
    const got = await handleGetTransferClaim(deps(s), HOST, mailboxAuth(aliceIrk, "alice"));
    expect(got.status).toBe(200);
    const body = got.body as { acquirerIrkPub: string; acquirerUsername: string; newServerDomain: string };
    expect(body.acquirerIrkPub).toBe(hex(bobIrk.publicKey));
    expect(body.acquirerUsername).toBe("bob");
    expect(body.newServerDomain).toBe("home.bob.flagship.services");

    // A different account (bob) cannot read the giver's claim poll.
    const wrong = await handleGetTransferClaim(deps(s), HOST, mailboxAuth(bobIrk, "bob"));
    expect(wrong.status).toBe(403);
  });

  it("a re-issued offer replaces the prior one (only the latest nonce is claimable)", async () => {
    const s = await setup();
    const nonce1 = hex(rand(32));
    const nonce2 = hex(rand(32));
    await handlePostTransferOffer(deps(s), HOST, offerBody(aliceIrk, { nonce: nonce1 }));
    await handlePostTransferOffer(deps(s), HOST, offerBody(aliceIrk, { nonce: nonce2 }));
    // The first nonce is gone — claim mismatches.
    const stale = await handlePostTransferClaim(deps(s), HOST, claimBody(bobIrk, "bob", nonce1));
    expect(stale.status).toBe(403);
    // The latest nonce works.
    const fresh = await handlePostTransferClaim(deps(s), HOST, claimBody(bobIrk, "bob", nonce2));
    expect(fresh.status).toBe(200);
  });

  it("cannot transfer a box to its current owner", async () => {
    const s = await setup();
    const nonce = hex(rand(32));
    await handlePostTransferOffer(deps(s), HOST, offerBody(aliceIrk, { nonce }));
    const res = await handlePostTransferClaim(deps(s), HOST, claimBody(aliceIrk, "alice", nonce));
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/current owner/);
  });

  // ── Layer A: box-side re-home read ───────────────────────────────────────
  it("rehome 404s for a box that was never transferred", async () => {
    const s = await setup();
    // Offer deposited but never claimed → no completed transfer.
    await handlePostTransferOffer(deps(s), HOST, offerBody(aliceIrk, { nonce: hex(rand(32)) }));
    const res = await handleGetTransferRehome(deps(s), HOST);
    expect(res.status).toBe(404);
  });

  it("rehome returns the new canonical + acquirer IRK after a completed transfer", async () => {
    const s = await setup();
    const nonce = hex(rand(32));
    await handlePostTransferOffer(deps(s), HOST, offerBody(aliceIrk, { nonce }));
    await handlePostTransferClaim(deps(s), HOST, claimBody(bobIrk, "bob", nonce));

    const res = await handleGetTransferRehome(deps(s), HOST);
    expect(res.status).toBe(200);
    const body = res.body as {
      rehomed: boolean;
      newServerDomain: string;
      acquirerUsername: string;
      acquirerIrkPub: string;
    };
    expect(body.rehomed).toBe(true);
    expect(body.newServerDomain).toBe("home.bob.flagship.services");
    expect(body.acquirerUsername).toBe("bob");
    expect(body.acquirerIrkPub).toBe(hex(bobIrk.publicKey));
  });
});
