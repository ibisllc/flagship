/**
 * Box-side secret-free pairing consumer (no `pairingKeyPrivHex` in the recipe).
 *
 *   DEFAULT (online): the phone deposits the owner-IRK-signed `add-paired-session`
 *     order SEALED to the box IDENTITY into the `.com` pairing-deposit lane AFTER
 *     the box registers; the daemon POLLS that lane, unseals with its identity
 *     key, verifies the owner IRK, and adds the session.
 *   OFFLINE (embed): the recipe carries the owner-IRK-signed order in plaintext;
 *     the daemon verifies + adds it LOCALLY (no `.com`).
 *
 * Tests cover: happy path (claim + add + mark), idempotency (marker + already-
 * present token), 404, rejection-without-adding (forged sig / wrong-box seal /
 * wrong-box order / junk), and the offline-embed add + rejection.
 */
import { unsealerFor } from "./helpers/keyCustody.js";
import { describe, expect, it } from "vitest";
import {
  ed,
  pairingOrderToJson,
  sealForEd25519Recipient,
  signPhoneOrder,
  type Keypair,
  type PhoneOrder,
} from "@flagship/protocol";
import {
  addEmbeddedPairing,
  claimPairingDeposit,
  type PairingClaimMarkerStore,
  type PairingSessionSink,
} from "../src/pairingDepositConsumer.js";

const DOMAIN = "home.alice.flagship.services";

function makeKey(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const TOKEN = "f".repeat(64);

function buildOrder(opts: { irk: Keypair; domain?: string; token?: string }): {
  request: Extract<PhoneOrder, { type: "add-paired-session" }>;
  json: string;
} {
  const request: Extract<PhoneOrder, { type: "add-paired-session" }> = {
    type: "add-paired-session",
    serverId: opts.domain ?? DOMAIN,
    token: opts.token ?? TOKEN,
    issuedAt: 1_000,
  };
  const sig = signPhoneOrder(request, opts.irk);
  return { request, json: pairingOrderToJson(request, sig) };
}

/** The deposited carrier hex: the order JSON sealed to the box identity. */
function sealedCarrier(opts: { irk: Keypair; boxKey: Keypair; domain?: string; token?: string }): string {
  const { json } = buildOrder({ irk: opts.irk, domain: opts.domain, token: opts.token });
  const sealed = sealForEd25519Recipient(new TextEncoder().encode(json), opts.boxKey.publicKey);
  return hex(sealed);
}

function fetchReturning(sealedHex: string | null): typeof fetch {
  return (async () => {
    if (sealedHex === null) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ serverDomain: DOMAIN, sealed: sealedHex }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function inMemMarker(): PairingClaimMarkerStore & { marked: boolean } {
  const m = {
    marked: false,
    async has() {
      return m.marked;
    },
    async mark() {
      m.marked = true;
    },
  };
  return m;
}

function inMemSink(seedToken?: string): PairingSessionSink & { added: Array<{ token: string }> } {
  const added: Array<{ token: string }> = [];
  if (seedToken) added.push({ token: seedToken });
  return {
    added,
    has(token) {
      return added.some((a) => a.token === token);
    },
    async add(token) {
      added.push({ token });
    },
  };
}

function opts(irk: Keypair, boxKey: Keypair, over?: {
  fetchImpl?: typeof fetch;
  markerStore?: PairingClaimMarkerStore;
  pairedSessions?: PairingSessionSink;
}) {
  return {
    serverFqdn: DOMAIN,
    ownerIrkPub: irk.publicKey,
    unsealToBox: unsealerFor(boxKey.privateKey),
    controlPlaneBaseUrl: "https://flagshipserver.com",
    pairedSessions: over?.pairedSessions ?? inMemSink(),
    markerStore: over?.markerStore ?? inMemMarker(),
    fetchImpl: over?.fetchImpl,
    onLog: () => {},
  };
}

describe("claimPairingDeposit (online default — sealed to box identity)", () => {
  it("happy path: unseal + verify → add session + mark, once", async () => {
    const irk = makeKey(1);
    const boxKey = makeKey(9);
    const sink = inMemSink();
    const marker = inMemMarker();
    const out = await claimPairingDeposit(
      opts(irk, boxKey, {
        fetchImpl: fetchReturning(sealedCarrier({ irk, boxKey })),
        pairedSessions: sink,
        markerStore: marker,
      }),
    );
    expect(out).toEqual({ claimed: true, token: TOKEN });
    expect(sink.added).toEqual([{ token: TOKEN }]);
    expect(marker.marked).toBe(true);
  });

  it("no deposit (404) → keep polling, no add", async () => {
    const irk = makeKey(1);
    const boxKey = makeKey(9);
    const sink = inMemSink();
    const out = await claimPairingDeposit(opts(irk, boxKey, { fetchImpl: fetchReturning(null), pairedSessions: sink }));
    expect(out).toEqual({ claimed: false, reason: "no-deposit" });
    expect(sink.added).toEqual([]);
  });

  it("idempotent: marker present → never re-claims", async () => {
    const irk = makeKey(1);
    const boxKey = makeKey(9);
    const marker = inMemMarker();
    marker.marked = true;
    const sink = inMemSink();
    const out = await claimPairingDeposit(
      opts(irk, boxKey, { fetchImpl: fetchReturning(sealedCarrier({ irk, boxKey })), markerStore: marker, pairedSessions: sink }),
    );
    expect(out).toEqual({ claimed: false, reason: "already-claimed" });
    expect(sink.added).toEqual([]);
  });

  it("idempotent: token already present → claimed but no duplicate add", async () => {
    const irk = makeKey(1);
    const boxKey = makeKey(9);
    const sink = inMemSink(TOKEN);
    const out = await claimPairingDeposit(
      opts(irk, boxKey, { fetchImpl: fetchReturning(sealedCarrier({ irk, boxKey })), pairedSessions: sink }),
    );
    expect(out).toEqual({ claimed: true, token: TOKEN });
    expect(sink.added.filter((a) => a.token === TOKEN)).toHaveLength(1);
  });

  it("forged owner signature → rejected WITHOUT adding", async () => {
    const irk = makeKey(1);
    const wrong = makeKey(2);
    const boxKey = makeKey(9);
    const sink = inMemSink();
    // Order signed by `wrong`, box verifies under `irk`. Seal is to the box, so
    // it unseals — but the IRK verify fails.
    const out = await claimPairingDeposit(
      opts(irk, boxKey, { fetchImpl: fetchReturning(sealedCarrier({ irk: wrong, boxKey })), pairedSessions: sink }),
    );
    expect(out).toEqual({ claimed: false, reason: "rejected" });
    expect(sink.added).toEqual([]);
  });

  it("sealed for a different box → rejected WITHOUT adding (can't unseal)", async () => {
    const irk = makeKey(1);
    const boxKey = makeKey(9);
    const otherBox = makeKey(13);
    const sink = inMemSink();
    const out = await claimPairingDeposit(
      opts(irk, boxKey, { fetchImpl: fetchReturning(sealedCarrier({ irk, boxKey: otherBox })), pairedSessions: sink }),
    );
    expect(out).toEqual({ claimed: false, reason: "rejected" });
    expect(sink.added).toEqual([]);
  });

  it("order names a different box → rejected WITHOUT adding", async () => {
    const irk = makeKey(1);
    const boxKey = makeKey(9);
    const sink = inMemSink();
    const out = await claimPairingDeposit(
      opts(irk, boxKey, {
        fetchImpl: fetchReturning(sealedCarrier({ irk, boxKey, domain: "evil.bob.flagship.services" })),
        pairedSessions: sink,
      }),
    );
    expect(out).toEqual({ claimed: false, reason: "rejected" });
    expect(sink.added).toEqual([]);
  });

  it("junk carrier → rejected WITHOUT adding (never throws)", async () => {
    const irk = makeKey(1);
    const boxKey = makeKey(9);
    const sink = inMemSink();
    const out = await claimPairingDeposit(
      opts(irk, boxKey, { fetchImpl: fetchReturning(hex(new TextEncoder().encode("garbage"))), pairedSessions: sink }),
    );
    expect(out).toEqual({ claimed: false, reason: "rejected" });
    expect(sink.added).toEqual([]);
  });
});

describe("addEmbeddedPairing (offline embed — plaintext order)", () => {
  it("verified embedded order → adds the session locally", async () => {
    const irk = makeKey(1);
    const sink = inMemSink();
    const marker = inMemMarker();
    const { json } = buildOrder({ irk });
    const out = await addEmbeddedPairing({
      embeddedJson: json,
      serverFqdn: DOMAIN,
      ownerIrkPub: irk.publicKey,
      pairedSessions: sink,
      markerStore: marker,
    });
    expect(out).toEqual({ added: true, token: TOKEN });
    expect(sink.added).toEqual([{ token: TOKEN }]);
    expect(marker.marked).toBe(true);
  });

  it("forged/wrong-owner embedded order → rejected WITHOUT adding", async () => {
    const irk = makeKey(1);
    const wrong = makeKey(2);
    const sink = inMemSink();
    const { json } = buildOrder({ irk: wrong });
    const out = await addEmbeddedPairing({
      embeddedJson: json,
      serverFqdn: DOMAIN,
      ownerIrkPub: irk.publicKey,
      pairedSessions: sink,
      markerStore: inMemMarker(),
    });
    expect(out).toEqual({ added: false, reason: "rejected" });
    expect(sink.added).toEqual([]);
  });

  it("idempotent: marker present → does not re-add", async () => {
    const irk = makeKey(1);
    const sink = inMemSink();
    const marker = inMemMarker();
    marker.marked = true;
    const { json } = buildOrder({ irk });
    const out = await addEmbeddedPairing({
      embeddedJson: json,
      serverFqdn: DOMAIN,
      ownerIrkPub: irk.publicKey,
      pairedSessions: sink,
      markerStore: marker,
    });
    expect(out).toEqual({ added: false, reason: "already-claimed" });
    expect(sink.added).toEqual([]);
  });

  it("junk JSON → rejected WITHOUT adding (never throws)", async () => {
    const irk = makeKey(1);
    const sink = inMemSink();
    const out = await addEmbeddedPairing({
      embeddedJson: "not json at all",
      serverFqdn: DOMAIN,
      ownerIrkPub: irk.publicKey,
      pairedSessions: sink,
      markerStore: inMemMarker(),
    });
    expect(out).toEqual({ added: false, reason: "rejected" });
    expect(sink.added).toEqual([]);
  });
});
