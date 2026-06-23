/**
 * Box-side secret-free-recipe SWK delivery consumer
 * (docs/recipe-delivery-and-remote-install.md).
 *
 * While the box has NO SWK it polls the `.com` swk lane; when the owner's phone
 * has deposited an IRK-signed delivery sealing the SWK to THIS box's identity,
 * the daemon verifies under the config-pinned owner IRK, unseals with the box
 * identity key, persists swk.hex, marks idempotency, and restarts. Tests:
 *   - happy path: verified delivery → persist runs once + marker written + restart fired;
 *   - idempotency: a re-poll after the marker is present never re-claims/restarts;
 *   - 404 (no deposit) → keep polling, no persist;
 *   - rejection WITHOUT persisting for a forged sig, a wrong-box delivery, and junk;
 *   - swkHex-present path: the consumer is gated off entirely (proven via the helper).
 */

import { describe, expect, it } from "vitest";
import {
  buildSwkDelivery,
  ed,
  swkDeliveryToCarrierHex,
  type Keypair,
} from "@flagship/protocol";
import {
  claimSwkDeposit,
  decodeAndVerifySwkCarrier,
  type SwkClaimMarkerStore,
} from "../src/swkDepositConsumer.js";

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

/** Build the deposited SWK-delivery carrier hex, sealed for `boxKey`. */
function carrier(opts: {
  irk: Keypair;
  boxKey: Keypair;
  swk: Uint8Array;
  domain?: string;
}): string {
  const { delivery, signature } = buildSwkDelivery({
    serverDomain: opts.domain ?? DOMAIN,
    swk: opts.swk,
    boxIdentityPub: opts.boxKey.publicKey,
    irk: opts.irk,
    issuedAt: 1_000,
  });
  return swkDeliveryToCarrierHex(delivery, signature);
}

/** A fetch returning a 200 swk-deposit reply with `sealedHex`, or 404. */
function fetchReturning(sealedHex: string | null): typeof fetch {
  return (async () => {
    if (sealedHex === null) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ serverDomain: DOMAIN, sealed: sealedHex }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function inMemMarker(): SwkClaimMarkerStore & { marked: boolean } {
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

function harness(overrides?: { fetchImpl?: typeof fetch; markerStore?: SwkClaimMarkerStore }) {
  const persisted: string[] = [];
  let restarted = 0;
  const markerStore = overrides?.markerStore ?? inMemMarker();
  return {
    persisted,
    get restarted() {
      return restarted;
    },
    markerStore,
    opts: (irk: Keypair, boxKey: Keypair) => ({
      serverDomain: DOMAIN,
      ownerIrkPub: irk.publicKey,
      boxIdentityPriv: boxKey.privateKey,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      persistSwk: async (h: string) => {
        persisted.push(h);
      },
      restart: () => {
        restarted += 1;
      },
      markerStore,
      fetchImpl: overrides?.fetchImpl,
      onLog: () => {},
    }),
  };
}

const SWK = new Uint8Array(32).fill(0xab);

describe("decodeAndVerifySwkCarrier", () => {
  it("returns the SWK hex for a good carrier", () => {
    const irk = makeKey(1);
    const boxKey = makeKey(9);
    const out = decodeAndVerifySwkCarrier({
      sealedHex: carrier({ irk, boxKey, swk: SWK }),
      ownerIrkPub: irk.publicKey,
      boxIdentityPriv: boxKey.privateKey,
      serverDomain: DOMAIN,
    });
    expect(out).toBe(hex(SWK));
  });

  it("returns null on a wrong-owner signature", () => {
    const irk = makeKey(1);
    const wrong = makeKey(2);
    const boxKey = makeKey(9);
    expect(
      decodeAndVerifySwkCarrier({
        sealedHex: carrier({ irk, boxKey, swk: SWK }),
        ownerIrkPub: wrong.publicKey,
        boxIdentityPriv: boxKey.privateKey,
        serverDomain: DOMAIN,
      }),
    ).toBeNull();
  });

  it("returns null when unsealed by the wrong box identity", () => {
    const irk = makeKey(1);
    const boxKey = makeKey(9);
    const otherBox = makeKey(13);
    expect(
      decodeAndVerifySwkCarrier({
        sealedHex: carrier({ irk, boxKey, swk: SWK }),
        ownerIrkPub: irk.publicKey,
        boxIdentityPriv: otherBox.privateKey,
        serverDomain: DOMAIN,
      }),
    ).toBeNull();
  });

  it("returns null on a delivery naming a different box", () => {
    const irk = makeKey(1);
    const boxKey = makeKey(9);
    expect(
      decodeAndVerifySwkCarrier({
        sealedHex: carrier({ irk, boxKey, swk: SWK, domain: "evil.bob.flagship.services" }),
        ownerIrkPub: irk.publicKey,
        boxIdentityPriv: boxKey.privateKey,
        serverDomain: DOMAIN,
      }),
    ).toBeNull();
  });

  it("returns null on a junk carrier (never throws)", () => {
    const irk = makeKey(1);
    const boxKey = makeKey(9);
    for (const junk of ["", "zz", "abc", hex(new TextEncoder().encode("not json"))]) {
      expect(
        decodeAndVerifySwkCarrier({
          sealedHex: junk,
          ownerIrkPub: irk.publicKey,
          boxIdentityPriv: boxKey.privateKey,
          serverDomain: DOMAIN,
        }),
      ).toBeNull();
    }
  });
});

describe("claimSwkDeposit", () => {
  it("happy path: verified delivery → persist + mark + restart, once", async () => {
    const irk = makeKey(1);
    const boxKey = makeKey(9);
    const h = harness({ fetchImpl: fetchReturning(carrier({ irk, boxKey, swk: SWK })) });
    const out = await claimSwkDeposit(h.opts(irk, boxKey));
    expect(out).toEqual({ claimed: true, swkHex: hex(SWK) });
    expect(h.persisted).toEqual([hex(SWK)]);
    expect(h.restarted).toBe(1);
    expect((h.markerStore as SwkClaimMarkerStore & { marked: boolean }).marked).toBe(true);
  });

  it("no deposit (404) → keep polling, no persist/restart", async () => {
    const irk = makeKey(1);
    const boxKey = makeKey(9);
    const h = harness({ fetchImpl: fetchReturning(null) });
    const out = await claimSwkDeposit(h.opts(irk, boxKey));
    expect(out).toEqual({ claimed: false, reason: "no-deposit" });
    expect(h.persisted).toEqual([]);
    expect(h.restarted).toBe(0);
  });

  it("idempotent: a re-poll after the marker is present never re-claims", async () => {
    const irk = makeKey(1);
    const boxKey = makeKey(9);
    const marker = inMemMarker();
    marker.marked = true;
    const h = harness({
      fetchImpl: fetchReturning(carrier({ irk, boxKey, swk: SWK })),
      markerStore: marker,
    });
    const out = await claimSwkDeposit(h.opts(irk, boxKey));
    expect(out).toEqual({ claimed: false, reason: "already-claimed" });
    expect(h.persisted).toEqual([]);
    expect(h.restarted).toBe(0);
  });

  it("forged signature → rejected WITHOUT persisting", async () => {
    const irk = makeKey(1);
    const wrong = makeKey(2);
    const boxKey = makeKey(9);
    // The delivery is signed by `wrong`, but we verify under `irk`.
    const h = harness({ fetchImpl: fetchReturning(carrier({ irk: wrong, boxKey, swk: SWK })) });
    const out = await claimSwkDeposit(h.opts(irk, boxKey));
    expect(out).toEqual({ claimed: false, reason: "rejected" });
    expect(h.persisted).toEqual([]);
    expect(h.restarted).toBe(0);
  });

  it("wrong-box delivery → rejected WITHOUT persisting", async () => {
    const irk = makeKey(1);
    const boxKey = makeKey(9);
    const otherBox = makeKey(13);
    // Sealed for `otherBox`, but we hold `boxKey` — the unseal fails.
    const h = harness({ fetchImpl: fetchReturning(carrier({ irk, boxKey: otherBox, swk: SWK })) });
    const out = await claimSwkDeposit(h.opts(irk, boxKey));
    expect(out).toEqual({ claimed: false, reason: "rejected" });
    expect(h.persisted).toEqual([]);
    expect(h.restarted).toBe(0);
  });

  it("junk carrier → rejected WITHOUT persisting", async () => {
    const irk = makeKey(1);
    const boxKey = makeKey(9);
    const h = harness({ fetchImpl: fetchReturning(hex(new TextEncoder().encode("garbage"))) });
    const out = await claimSwkDeposit(h.opts(irk, boxKey));
    expect(out).toEqual({ claimed: false, reason: "rejected" });
    expect(h.persisted).toEqual([]);
    expect(h.restarted).toBe(0);
  });

  it("a persist failure does NOT mark or restart (so a redeposit can recover)", async () => {
    const irk = makeKey(1);
    const boxKey = makeKey(9);
    const marker = inMemMarker();
    let restarted = 0;
    const out = await claimSwkDeposit({
      serverDomain: DOMAIN,
      ownerIrkPub: irk.publicKey,
      boxIdentityPriv: boxKey.privateKey,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      persistSwk: async () => {
        throw new Error("disk full");
      },
      restart: () => {
        restarted += 1;
      },
      markerStore: marker,
      fetchImpl: fetchReturning(carrier({ irk, boxKey, swk: SWK })),
      onLog: () => {},
    });
    expect(out).toEqual({ claimed: false, reason: "error" });
    expect(marker.marked).toBe(false);
    expect(restarted).toBe(0);
  });
});
