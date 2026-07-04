import { describe, expect, it } from "vitest";
import {
  ed,
  signAdminRootTransfer,
  signDeviceEndpointClaim,
  signRehomeAuthorization,
  verifyRehomeAuthorization,
  signServerTransferOffer,
  signServerTransferClaim,
  type AdminRootTransfer,
  type DeviceEndpointClaim,
  type Keypair,
  type RehomeAuthorization,
  type ServerTransferOffer,
  type ServerTransferClaim,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handlePostTransferOffer,
  handlePostTransferClaim,
  handleGetTransferClaim,
  handleGetTransferRehome,
  handlePostTransferAdminHandoff,
  handlePostTransferRehomeAuth,
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
  opts?: { now?: number; acquirerIrkPub?: Uint8Array; sign?: Keypair; adminRoot?: string },
) {
  const now = opts?.now ?? NOW;
  const adminRoot = opts?.adminRoot ?? "";
  const claim: ServerTransferClaim = {
    serverDomain: HOST,
    transferNonce: nonce,
    acquirerUsername: username,
    acquirerIrkPub: opts?.acquirerIrkPub ?? irk.publicKey,
    acquirerAdminRootPubHex: adminRoot,
    issuedAt: now,
  };
  const sig = signServerTransferClaim(claim, opts?.sign ?? irk);
  return {
    claim: {
      serverDomain: HOST,
      transferNonce: nonce,
      acquirerUsername: username,
      acquirerIrkPub: hex(claim.acquirerIrkPub),
      acquirerAdminRootPub: adminRoot,
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

// ── Slice D §9.8: claim v2 admin anchor + the admin-root handoff lane ───────
//
// Between two admin-rooted accounts: alice's OFFER + bob's CLAIM must be
// signed by their ADMIN roots (the sensitive gate is open), the claim (v2)
// commits to bob's admin root, and the box only re-pins on alice's
// admin-root-signed `flagship/admin-root-transfer/v1` proof relayed via the
// rehome read. `.com`'s verify on deposit is a garbage filter — the deposit
// carries NO other auth because the admin-root signature IS the authorization.

const aliceAdmin = makeKey();
const bobAdmin = makeKey();

async function setupAdminTier(): Promise<InMemoryStorage> {
  const s = await setup();
  await s.usernames.put({
    username: "alice",
    irkPubHex: hex(aliceIrk.publicKey),
    claimedAt: 1,
    adminRootPubHex: hex(aliceAdmin.publicKey),
  });
  await s.usernames.put({
    username: "bob",
    irkPubHex: hex(bobIrk.publicKey),
    claimedAt: 1,
    adminRootPubHex: hex(bobAdmin.publicKey),
  });
  return s;
}

/** Complete an admin-tier offer → claim; returns the nonce. */
async function claimAdminTier(s: InMemoryStorage): Promise<string> {
  const nonce = hex(rand(32));
  const offerRes = await handlePostTransferOffer(
    deps(s),
    HOST,
    offerBody(aliceIrk, { nonce, sign: aliceAdmin }),
  );
  expect(offerRes.status).toBe(200);
  const claimRes = await handlePostTransferClaim(
    deps(s),
    HOST,
    claimBody(bobIrk, "bob", nonce, { sign: bobAdmin, adminRoot: hex(bobAdmin.publicKey) }),
  );
  expect(claimRes.status).toBe(200);
  return nonce;
}

function handoffBody(
  signer: Keypair,
  nonce: string,
  overrides?: Partial<{
    serverDomain: string;
    giverUsername: string;
    acquirerUsername: string;
    oldAdminRootPub: string;
    newAdminRootPub: string;
    transferNonce: string;
    issuedAt: number;
  }>,
) {
  const handoff = {
    serverDomain: HOST,
    giverUsername: "alice",
    acquirerUsername: "bob",
    oldAdminRootPub: hex(aliceAdmin.publicKey),
    newAdminRootPub: hex(bobAdmin.publicKey),
    transferNonce: nonce,
    issuedAt: NOW,
    ...overrides,
  };
  const t: AdminRootTransfer = {
    serverDomain: handoff.serverDomain,
    giverUsername: handoff.giverUsername,
    acquirerUsername: handoff.acquirerUsername,
    oldAdminRootPubHex: handoff.oldAdminRootPub,
    newAdminRootPubHex: handoff.newAdminRootPub,
    transferNonce: handoff.transferNonce,
    issuedAt: handoff.issuedAt,
  };
  return { handoff, signatureHex: hex(signAdminRootTransfer(t, signer)) };
}

describe("transfer-a-box admin-root handoff (Slice D §9.8)", () => {
  it("claim v2 requires acquirerAdminRootPub (missing ⇒ 400; bad hex ⇒ 400)", async () => {
    const s = await setup();
    const nonce = hex(rand(32));
    await handlePostTransferOffer(deps(s), HOST, offerBody(aliceIrk, { nonce }));
    const good = claimBody(bobIrk, "bob", nonce);
    const missing = { ...good, claim: { ...good.claim } } as {
      claim: Record<string, unknown>;
      claimSignature: string;
    };
    delete missing.claim.acquirerAdminRootPub;
    expect((await handlePostTransferClaim(deps(s), HOST, missing)).status).toBe(400);
    const badHex = {
      ...good,
      claim: { ...good.claim, acquirerAdminRootPub: "zz".repeat(32) },
    };
    expect((await handlePostTransferClaim(deps(s), HOST, badHex)).status).toBe(400);
  });

  it("legacy accounts (no admin roots) claim with \"\" — giver poll + rehome carry it", async () => {
    const s = await setup();
    const nonce = hex(rand(32));
    await handlePostTransferOffer(deps(s), HOST, offerBody(aliceIrk, { nonce }));
    const res = await handlePostTransferClaim(deps(s), HOST, claimBody(bobIrk, "bob", nonce));
    expect(res.status).toBe(200);

    const poll = await handleGetTransferClaim(deps(s), HOST, mailboxAuth(aliceIrk, "alice"));
    expect((poll.body as { acquirerAdminRootPub: string }).acquirerAdminRootPub).toBe("");

    const rehome = await handleGetTransferRehome(deps(s), HOST);
    const rb = rehome.body as { acquirerAdminRootPub?: string; adminHandoff?: unknown };
    expect(rb.acquirerAdminRootPub).toBe("");
    expect(rb.adminHandoff).toBeUndefined();
  });

  it("happy path: admin-tier claim stores the anchor; deposit relays the proof on rehome", async () => {
    const s = await setupAdminTier();
    const nonce = await claimAdminTier(s);

    // Giver poll surfaces the acquirer's admin anchor for the proof.
    const poll = await handleGetTransferClaim(deps(s), HOST, mailboxAuth(aliceIrk, "alice"));
    expect((poll.body as { acquirerAdminRootPub: string }).acquirerAdminRootPub).toBe(
      hex(bobAdmin.publicKey),
    );

    // Before the deposit: rehome carries the anchor but NO handoff yet.
    const before = await handleGetTransferRehome(deps(s), HOST);
    expect((before.body as { adminHandoff?: unknown }).adminHandoff).toBeUndefined();

    const dep = await handlePostTransferAdminHandoff(deps(s), HOST, handoffBody(aliceAdmin, nonce));
    expect(dep.status).toBe(200);

    const after = await handleGetTransferRehome(deps(s), HOST);
    const body = after.body as {
      acquirerAdminRootPub: string;
      adminHandoff: {
        giverUsername: string;
        acquirerUsername: string;
        oldAdminRootPub: string;
        newAdminRootPub: string;
        transferNonce: string;
        issuedAt: number;
        signatureHex: string;
      };
    };
    expect(body.acquirerAdminRootPub).toBe(hex(bobAdmin.publicKey));
    expect(body.adminHandoff.giverUsername).toBe("alice");
    expect(body.adminHandoff.acquirerUsername).toBe("bob");
    expect(body.adminHandoff.oldAdminRootPub).toBe(hex(aliceAdmin.publicKey));
    expect(body.adminHandoff.newAdminRootPub).toBe(hex(bobAdmin.publicKey));
    expect(body.adminHandoff.transferNonce).toBe(nonce);
    expect(body.adminHandoff.signatureHex).toHaveLength(128);
  });

  it("rejects a handoff signed by the wrong key (403 — the sig IS the auth)", async () => {
    const s = await setupAdminTier();
    const nonce = await claimAdminTier(s);
    // Signed by bob's admin root (or any non-giver key) — `.com` refuses.
    const res = await handlePostTransferAdminHandoff(deps(s), HOST, handoffBody(bobAdmin, nonce));
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/invalid admin-handoff signature/);
  });

  it("rejects a mismatched nonce / acquirer / newRoot (409)", async () => {
    const s = await setupAdminTier();
    const nonce = await claimAdminTier(s);

    const wrongNonce = await handlePostTransferAdminHandoff(
      deps(s),
      HOST,
      handoffBody(aliceAdmin, hex(rand(32))),
    );
    expect(wrongNonce.status).toBe(409);
    expect((wrongNonce.body as { error: string }).error).toMatch(/transferNonce/);

    const wrongAcquirer = await handlePostTransferAdminHandoff(
      deps(s),
      HOST,
      handoffBody(aliceAdmin, nonce, { acquirerUsername: "carol" }),
    );
    expect(wrongAcquirer.status).toBe(409);
    expect((wrongAcquirer.body as { error: string }).error).toMatch(/acquirerUsername/);

    // A giver aiming the box at a THIRD root (not what bob's signed claim
    // committed to) is refused — the claim's anchor is the only valid target.
    const wrongNewRoot = await handlePostTransferAdminHandoff(
      deps(s),
      HOST,
      handoffBody(aliceAdmin, nonce, { newAdminRootPub: "3c".repeat(32) }),
    );
    expect(wrongNewRoot.status).toBe(409);
    expect((wrongNewRoot.body as { error: string }).error).toMatch(/admin anchor/);
  });

  it("rejects a handoff when the giver account has no admin root (409)", async () => {
    const s = await setup(); // legacy alice — no admin root registered
    const nonce = hex(rand(32));
    await handlePostTransferOffer(deps(s), HOST, offerBody(aliceIrk, { nonce }));
    await handlePostTransferClaim(deps(s), HOST, claimBody(bobIrk, "bob", nonce));
    const res = await handlePostTransferAdminHandoff(
      deps(s),
      HOST,
      handoffBody(aliceAdmin, nonce, { newAdminRootPub: "" }),
    );
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/no admin root/);
  });

  it("404s a handoff for an unclaimed / absent transfer", async () => {
    const s = await setupAdminTier();
    const nonce = hex(rand(32));
    // No offer at all.
    expect(
      (await handlePostTransferAdminHandoff(deps(s), HOST, handoffBody(aliceAdmin, nonce))).status,
    ).toBe(404);
    // Offer but no claim.
    await handlePostTransferOffer(deps(s), HOST, offerBody(aliceIrk, { nonce, sign: aliceAdmin }));
    expect(
      (await handlePostTransferAdminHandoff(deps(s), HOST, handoffBody(aliceAdmin, nonce))).status,
    ).toBe(404);
  });

  it("idempotent re-deposit replaces (giver phone may retry)", async () => {
    const s = await setupAdminTier();
    const nonce = await claimAdminTier(s);
    const first = handoffBody(aliceAdmin, nonce, { issuedAt: NOW });
    expect((await handlePostTransferAdminHandoff(deps(s), HOST, first)).status).toBe(200);
    const second = handoffBody(aliceAdmin, nonce, { issuedAt: NOW + 1000 });
    expect((await handlePostTransferAdminHandoff(deps(s), HOST, second)).status).toBe(200);
    const rehome = await handleGetTransferRehome(deps(s), HOST);
    expect((rehome.body as { adminHandoff: { issuedAt: number } }).adminHandoff.issuedAt).toBe(
      NOW + 1000,
    );
  });

  it("unpin handoff (\"\" new root) round-trips when the acquirer is a legacy account", async () => {
    const s = await setupAdminTier();
    // carol is a LEGACY acquirer — an IRK but no admin root (a benign re-put
    // preserves adminRootPubHex, so a fresh account is the honest fixture).
    const carolIrk = makeKey();
    await s.usernames.put({ username: "carol", irkPubHex: hex(carolIrk.publicKey), claimedAt: 1 });
    const nonce = hex(rand(32));
    await handlePostTransferOffer(deps(s), HOST, offerBody(aliceIrk, { nonce, sign: aliceAdmin }));
    const claimRes = await handlePostTransferClaim(
      deps(s),
      HOST,
      claimBody(carolIrk, "carol", nonce), // legacy carol: IRK-signed, adminRoot ""
    );
    expect(claimRes.status).toBe(200);

    const dep = await handlePostTransferAdminHandoff(
      deps(s),
      HOST,
      handoffBody(aliceAdmin, nonce, { acquirerUsername: "carol", newAdminRootPub: "" }),
    );
    expect(dep.status).toBe(200);
    const rehome = await handleGetTransferRehome(deps(s), HOST);
    const body = rehome.body as { adminHandoff: { newAdminRootPub: string } };
    expect(body.adminHandoff.newAdminRootPub).toBe("");
  });

  it("rejects a handoff whose serverDomain doesn't match the route host (403)", async () => {
    const s = await setupAdminTier();
    const nonce = await claimAdminTier(s);
    const res = await handlePostTransferAdminHandoff(
      deps(s),
      HOST,
      handoffBody(aliceAdmin, nonce, { serverDomain: "blog.alice.flagship.services" }),
    );
    expect(res.status).toBe(403);
  });
});

// ── v1-sec GAP 3: the LEGACY (no-admin-root) giver-owner-IRK re-home auth ────
//
// A box with NO pinned admin master root re-homes ONLY on a giver-owner-IRK
// `flagship/server-rehome-auth/v1` proof it verifies against its pinned owner
// IRK. The giver's phone deposits it post-claim; `.com` verifies against the
// giver account's registered IRK (garbage filter) + relays it on the rehome
// read. The deposit's SIGNATURE is the authorization — no mailbox-auth.

const NEW_HOST = "home.bob.flagship.services";

/** Build the giver-owner-IRK re-home-auth deposit body for the claimed transfer
 *  (HOST → NEW_HOST, re-bound to bob's IRK). `sign` overrides the signer to
 *  forge a non-owner signature; `acquirerIrkPub`/`newServerDomain` override the
 *  signed canonical to prove `.com`'s reconstruction is authoritative. */
function rehomeAuthBody(opts?: {
  sign?: Keypair;
  acquirerIrkPub?: Uint8Array;
  newServerDomain?: string;
  oldServerDomain?: string;
  issuedAt?: number;
}) {
  const issuedAt = opts?.issuedAt ?? NOW;
  const authorization: RehomeAuthorization = {
    oldServerDomain: opts?.oldServerDomain ?? HOST,
    newServerDomain: opts?.newServerDomain ?? NEW_HOST,
    acquirerIrkPub: opts?.acquirerIrkPub ?? bobIrk.publicKey,
    issuedAt,
  };
  const sig = signRehomeAuthorization(authorization, opts?.sign ?? aliceIrk);
  return { issuedAt, signatureHex: hex(sig) };
}

/** Complete a LEGACY offer → claim (both parties IRK-signed, no admin roots);
 *  returns the nonce. */
async function claimLegacy(s: InMemoryStorage): Promise<string> {
  const nonce = hex(rand(32));
  expect((await handlePostTransferOffer(deps(s), HOST, offerBody(aliceIrk, { nonce }))).status).toBe(
    200,
  );
  expect(
    (await handlePostTransferClaim(deps(s), HOST, claimBody(bobIrk, "bob", nonce))).status,
  ).toBe(200);
  return nonce;
}

describe("transfer-a-box legacy re-home authorization (v1-sec GAP 3)", () => {
  it("happy path: giver-IRK proof accepted; relayed verbatim on rehome; box verifies it", async () => {
    const s = await setup();
    await claimLegacy(s);

    // Before the deposit: rehome carries no rehomeAuth (a fail-closed box keeps
    // polling until it appears).
    const before = await handleGetTransferRehome(deps(s), HOST);
    expect((before.body as { rehomeAuth?: unknown }).rehomeAuth).toBeUndefined();

    const dep = await handlePostTransferRehomeAuth(deps(s), HOST, rehomeAuthBody());
    expect(dep.status).toBe(200);

    const after = await handleGetTransferRehome(deps(s), HOST);
    const body = after.body as {
      newServerDomain: string;
      acquirerIrkPub: string;
      rehomeAuth: { issuedAt: number; signatureHex: string };
    };
    expect(body.rehomeAuth.issuedAt).toBe(NOW);
    expect(body.rehomeAuth.signatureHex).toHaveLength(128);

    // The box's independent verify (reuse the protocol verify): reconstruct the
    // canonical from the relayed fields + our OLD canonical, and check it
    // against the giver's pinned owner IRK (== alice's).
    expect(body.newServerDomain).toBe(NEW_HOST);
    const authorization: RehomeAuthorization = {
      oldServerDomain: HOST,
      newServerDomain: body.newServerDomain,
      acquirerIrkPub: bobIrk.publicKey,
      issuedAt: body.rehomeAuth.issuedAt,
    };
    expect(
      verifyRehomeAuthorization(
        authorization,
        HexUtilDecode(body.rehomeAuth.signatureHex),
        aliceIrk.publicKey,
      ),
    ).toBe(true);
  });

  it("rejects a proof signed by a non-owner key (403 — the sig IS the auth)", async () => {
    const s = await setup();
    await claimLegacy(s);
    // Signed by bob (the acquirer), not the giver alice — `.com` refuses.
    const res = await handlePostTransferRehomeAuth(deps(s), HOST, rehomeAuthBody({ sign: bobIrk }));
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/invalid rehome-auth signature/);
  });

  it("rejects a proof whose signed newServerDomain / acquirerIrk doesn't match the row (403)", async () => {
    const s = await setup();
    await claimLegacy(s);
    // `.com` reconstructs the canonical from the CLAIMED row, so a proof signed
    // over a different new domain or acquirer key can't verify — the box would
    // reject it too. (The reconstruction is authoritative; the deposit body only
    // carries issuedAt + sig.)
    const wrongDomain = await handlePostTransferRehomeAuth(
      deps(s),
      HOST,
      rehomeAuthBody({ newServerDomain: "home.carol.flagship.services" }),
    );
    expect(wrongDomain.status).toBe(403);
    const wrongAcq = await handlePostTransferRehomeAuth(
      deps(s),
      HOST,
      rehomeAuthBody({ acquirerIrkPub: makeKey().publicKey }),
    );
    expect(wrongAcq.status).toBe(403);
  });

  it("404s a proof for an unclaimed / absent transfer", async () => {
    const s = await setup();
    // No offer at all.
    expect((await handlePostTransferRehomeAuth(deps(s), HOST, rehomeAuthBody())).status).toBe(404);
    // Offer but no claim.
    await handlePostTransferOffer(deps(s), HOST, offerBody(aliceIrk, { nonce: hex(rand(32)) }));
    expect((await handlePostTransferRehomeAuth(deps(s), HOST, rehomeAuthBody())).status).toBe(404);
  });

  it("malformed body ⇒ 400 (missing issuedAt / bad sig hex)", async () => {
    const s = await setup();
    await claimLegacy(s);
    expect(
      (await handlePostTransferRehomeAuth(deps(s), HOST, { signatureHex: "aa".repeat(64) })).status,
    ).toBe(400);
    expect(
      (await handlePostTransferRehomeAuth(deps(s), HOST, { issuedAt: NOW, signatureHex: "zz" }))
        .status,
    ).toBe(400);
  });

  it("idempotent re-deposit replaces (giver phone may retry)", async () => {
    const s = await setup();
    await claimLegacy(s);
    expect(
      (await handlePostTransferRehomeAuth(deps(s), HOST, rehomeAuthBody({ issuedAt: NOW })))
        .status,
    ).toBe(200);
    expect(
      (await handlePostTransferRehomeAuth(deps(s), HOST, rehomeAuthBody({ issuedAt: NOW + 1000 })))
        .status,
    ).toBe(200);
    const rehome = await handleGetTransferRehome(deps(s), HOST);
    expect((rehome.body as { rehomeAuth: { issuedAt: number } }).rehomeAuth.issuedAt).toBe(
      NOW + 1000,
    );
  });
});

function HexUtilDecode(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
