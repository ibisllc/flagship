// Transfer-a-box — webapp client (docs/account-deletion-and-name-reclaim.md §4).
//
// Exercises the real shipping module lib/serverTransfer.js (dependency-injected,
// DOM-free) two ways:
//   1. its canonical bytes are byte-identical to @flagship/protocol's
//      verifyServerTransferOffer / verifyServerTransferClaim (the cross-platform
//      pin), so the broker accepts what the webapp signs;
//   2. a full giver-offer → acquirer-claim → giver-poll round-trip against the
//      REAL .com broker handlers (InMemoryStorage), proving the webapp's wire
//      shape moves ownership end-to-end.

import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ed,
  verifyServerTransferOffer,
  verifyServerTransferClaim,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import {
  handlePostTransferOffer,
  handlePostTransferClaim,
  handleGetTransferClaim,
  type ServerTransferDeps,
} from "@flagship/control-plane";

const APEX = "flagship.services";
const HOST = "home.alice.flagship.services";

async function loadLib() {
  const path = resolve(__dirname, "..", "public", "webapp", "lib", "serverTransfer.js");
  return import(pathToFileURL(path).href + `?t=${Math.random()}`);
}

function makeKey(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
/** A webapp `signWithIrk(umk, bytes)` backed by a fixed Ed25519 key (the test
 *  ignores the umk seed — the broker verifies against `key.publicKey`). */
function signerFor(key: Keypair) {
  return async (_umk: Uint8Array, bytes: Uint8Array) => ed.sign(bytes, key.privateKey);
}

const aliceIrk = makeKey(11);
const bobIrk = makeKey(22);
const boxIdentity = makeKey(33);

async function brokerStore(): Promise<InMemoryStorage> {
  const s = new InMemoryStorage();
  await s.usernames.put({ username: "alice", irkPubHex: hex(aliceIrk.publicKey), claimedAt: 1 });
  await s.usernames.put({ username: "bob", irkPubHex: hex(bobIrk.publicKey), claimedAt: 1 });
  await s.servers.put({
    serverDomain: HOST,
    username: "alice",
    identityPubKeyHex: hex(boxIdentity.publicKey),
    registeredAt: 2,
  });
  await s.routing.register({
    subdomain: "home.alice",
    username: "alice",
    rckPubKeyHex: hex(makeKey(44).publicKey),
    currentTargetHex: hex(boxIdentity.publicKey),
    registeredAt: 2,
    lastTargetUpdate: 2,
    lastTargetNonce: "00".repeat(8),
  });
  return s;
}

function deps(s: InMemoryStorage, now: number): ServerTransferDeps {
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

/** Route a webapp fetch(url, init) into the matching broker handler. */
function brokerFetch(s: InMemoryStorage, now: number) {
  return async (url: string, init: any) => {
    const u = new URL(url);
    const body = init?.body ? JSON.parse(init.body) : {};
    let res;
    if (u.pathname.endsWith("/transfer/offer")) {
      res = await handlePostTransferOffer(deps(s, now), HOST, body);
    } else if (u.pathname.endsWith("/transfer/claim-poll")) {
      res = await handleGetTransferClaim(deps(s, now), HOST, body);
    } else if (u.pathname.endsWith("/transfer/claim")) {
      res = await handlePostTransferClaim(deps(s, now), HOST, body);
    } else {
      res = { status: 404, body: { error: "not found" } };
    }
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      json: async () => res.body,
    };
  };
}

describe("transfer-a-box — webapp", () => {
  it("offer canonical bytes verify under @flagship/protocol", async () => {
    const lib = await loadLib();
    const offer = {
      serverDomain: HOST,
      transferNonce: "ab".repeat(32),
      issuedAt: 1700,
      expiresAt: 2700,
    };
    const bytes = lib.canonicalOfferBytes(offer);
    const sig = ed.sign(bytes, aliceIrk.privateKey);
    expect(verifyServerTransferOffer(offer, sig, aliceIrk.publicKey)).toBe(true);
  });

  it("claim canonical bytes verify under @flagship/protocol", async () => {
    const lib = await loadLib();
    const bytes = lib.canonicalClaimBytes({
      serverDomain: HOST,
      transferNonce: "cd".repeat(32),
      acquirerUsername: "bob",
      acquirerIrkPubHex: hex(bobIrk.publicKey),
      issuedAt: 1800,
    });
    const sig = ed.sign(bytes, bobIrk.privateKey);
    expect(
      verifyServerTransferClaim(
        {
          serverDomain: HOST,
          transferNonce: "cd".repeat(32),
          acquirerUsername: "bob",
          acquirerIrkPub: bobIrk.publicKey,
          issuedAt: 1800,
        },
        sig,
        bobIrk.publicKey,
      ),
    ).toBe(true);
  });

  it("parseTransferOfferQR round-trips the QR payload", async () => {
    const lib = await loadLib();
    const qr = {
      v: 1,
      kind: "flagship-transfer-offer",
      serverDomain: HOST,
      transferNonce: "ee".repeat(32),
      giverIrkPub: hex(aliceIrk.publicKey),
      issuedAt: 1,
      expiresAt: 2,
      offerSignature: "ff".repeat(64),
    };
    const parsed = lib.parseTransferOfferQR(JSON.stringify(qr));
    expect(parsed.serverDomain).toBe(HOST);
    expect(parsed.transferNonce).toBe("ee".repeat(32));
    expect(parsed.giverIrkPub).toBe(hex(aliceIrk.publicKey));
    expect(() => lib.parseTransferOfferQR("{}")).toThrow(/not a transfer QR/);
    expect(() => lib.parseTransferOfferQR("garbage")).toThrow();
  });

  it("full giver-offer → acquirer-claim → giver-poll moves ownership", async () => {
    const lib = await loadLib();
    const s = await brokerStore();
    const now = 1_000_000;
    const fetchImpl = brokerFetch(s, now);

    // GIVER creates the offer + QR (deposited to the broker).
    const created = await lib.createTransferOffer(
      {
        serverDomain: HOST,
        username: "alice",
        umk: new Uint8Array(32),
        irkPubHex: hex(aliceIrk.publicKey),
        signWithIrk: signerFor(aliceIrk),
      },
      { fetch: fetchImpl, origin: "https://x", now: () => now },
    );
    expect(created.ok).toBe(true);
    expect(created.qr.kind).toBe("flagship-transfer-offer");

    // ACQUIRER parses the QR + claims it.
    const parsed = lib.parseTransferOfferQR(created.qrText);
    const claimRes = await lib.submitTransferClaim(
      {
        offer: parsed,
        acquirerUsername: "bob",
        umk: new Uint8Array(32),
        acquirerIrkPubHex: hex(bobIrk.publicKey),
        signWithIrk: signerFor(bobIrk),
      },
      { fetch: fetchImpl, origin: "https://x", now: () => now },
    );
    expect(claimRes.ok).toBe(true);
    expect(claimRes.body.newServerDomain).toBe("home.bob.flagship.services");

    // Ownership actually moved in the broker store.
    const moved = await s.servers.get("home.bob.flagship.services");
    expect(moved?.username).toBe("bob");
    expect(moved?.identityPubKeyHex).toBe(hex(boxIdentity.publicKey));

    // GIVER polls + learns the acquirer IRK for the disk-key re-seal.
    const poll = await lib.pollTransferClaim(
      {
        serverDomain: HOST,
        username: "alice",
        umk: new Uint8Array(32),
        irkPubHex: hex(aliceIrk.publicKey),
        signWithIrk: signerFor(aliceIrk),
      },
      { fetch: fetchImpl, origin: "https://x", now: () => now },
    );
    expect(poll.claimed).toBe(true);
    expect(poll.acquirerIrkPub).toBe(hex(bobIrk.publicKey));
    expect(poll.newServerDomain).toBe("home.bob.flagship.services");
  });

  it("submitTransferClaim refuses an expired offer locally (no network)", async () => {
    const lib = await loadLib();
    let called = false;
    await expect(
      lib.submitTransferClaim(
        {
          offer: { serverDomain: HOST, transferNonce: "11".repeat(32), expiresAt: 5 },
          acquirerUsername: "bob",
          umk: new Uint8Array(32),
          acquirerIrkPubHex: hex(bobIrk.publicKey),
          signWithIrk: signerFor(bobIrk),
        },
        { fetch: async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; }, now: () => 1000 },
      ),
    ).rejects.toThrow(/expired/);
    expect(called).toBe(false);
  });
});
