/**
 * Box-side post-boot CGK delivery consumer (Phase 6).
 *
 * While the box has NO CGK it polls the `.com` cgk lane; when the owner's phone
 * has deposited an IRK-signed delivery sealing the CGK to THIS box's identity, the
 * daemon verifies under the config-pinned owner IRK, unseals with the box identity
 * key, persists cgk.hex, marks idempotency, and restarts so gossip wires next boot.
 * The EXACT twin of the SWK consumer test — only the payload + lane differ.
 */

import { describe, expect, it } from "vitest";
import {
  buildCgkDelivery,
  ed,
  cgkDeliveryToCarrierHex,
  type Keypair,
} from "@flagship/protocol";
import {
  claimCgkDeposit,
  decodeAndVerifyCgkCarrier,
  type CgkClaimMarkerStore,
} from "../src/cgkDepositConsumer.js";

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

function carrier(opts: { irk: Keypair; boxKey: Keypair; cgk: Uint8Array; domain?: string }): string {
  const { delivery, signature } = buildCgkDelivery({
    serverDomain: opts.domain ?? DOMAIN,
    cgk: opts.cgk,
    boxIdentityPub: opts.boxKey.publicKey,
    irk: opts.irk,
    issuedAt: 1_000,
  });
  return cgkDeliveryToCarrierHex(delivery, signature);
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

function inMemMarker(): CgkClaimMarkerStore & { marked: boolean } {
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

function harness(overrides?: { fetchImpl?: typeof fetch; markerStore?: CgkClaimMarkerStore }) {
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
      persistCgk: async (h: string) => {
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

const CGK = new Uint8Array(32).fill(0xcd);

describe("decodeAndVerifyCgkCarrier", () => {
  it("returns the CGK hex for a good carrier", () => {
    const irk = makeKey(1);
    const boxKey = makeKey(9);
    expect(
      decodeAndVerifyCgkCarrier({
        sealedHex: carrier({ irk, boxKey, cgk: CGK }),
        ownerIrkPub: irk.publicKey,
        boxIdentityPriv: boxKey.privateKey,
        serverDomain: DOMAIN,
      }),
    ).toBe(hex(CGK));
  });

  it("returns null on a wrong-owner signature / wrong box / junk", () => {
    const irk = makeKey(1);
    const wrong = makeKey(2);
    const boxKey = makeKey(9);
    const otherBox = makeKey(13);
    expect(
      decodeAndVerifyCgkCarrier({
        sealedHex: carrier({ irk, boxKey, cgk: CGK }),
        ownerIrkPub: wrong.publicKey,
        boxIdentityPriv: boxKey.privateKey,
        serverDomain: DOMAIN,
      }),
    ).toBeNull();
    expect(
      decodeAndVerifyCgkCarrier({
        sealedHex: carrier({ irk, boxKey, cgk: CGK }),
        ownerIrkPub: irk.publicKey,
        boxIdentityPriv: otherBox.privateKey,
        serverDomain: DOMAIN,
      }),
    ).toBeNull();
    for (const junk of ["", "zz", "abc", hex(new TextEncoder().encode("not json"))]) {
      expect(
        decodeAndVerifyCgkCarrier({
          sealedHex: junk,
          ownerIrkPub: irk.publicKey,
          boxIdentityPriv: boxKey.privateKey,
          serverDomain: DOMAIN,
        }),
      ).toBeNull();
    }
  });
});

describe("claimCgkDeposit", () => {
  it("happy path: verified delivery → persist + mark + restart, once", async () => {
    const irk = makeKey(1);
    const boxKey = makeKey(9);
    const h = harness({ fetchImpl: fetchReturning(carrier({ irk, boxKey, cgk: CGK })) });
    const out = await claimCgkDeposit(h.opts(irk, boxKey));
    expect(out).toEqual({ claimed: true, cgkHex: hex(CGK) });
    expect(h.persisted).toEqual([hex(CGK)]);
    expect(h.restarted).toBe(1);
    expect((h.markerStore as CgkClaimMarkerStore & { marked: boolean }).marked).toBe(true);
  });

  it("no deposit (404) → keep polling, no persist/restart", async () => {
    const irk = makeKey(1);
    const boxKey = makeKey(9);
    const h = harness({ fetchImpl: fetchReturning(null) });
    const out = await claimCgkDeposit(h.opts(irk, boxKey));
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
      fetchImpl: fetchReturning(carrier({ irk, boxKey, cgk: CGK })),
      markerStore: marker,
    });
    const out = await claimCgkDeposit(h.opts(irk, boxKey));
    expect(out).toEqual({ claimed: false, reason: "already-claimed" });
    expect(h.persisted).toEqual([]);
    expect(h.restarted).toBe(0);
  });

  it("forged signature → rejected WITHOUT persisting", async () => {
    const irk = makeKey(1);
    const wrong = makeKey(2);
    const boxKey = makeKey(9);
    const h = harness({ fetchImpl: fetchReturning(carrier({ irk: wrong, boxKey, cgk: CGK })) });
    const out = await claimCgkDeposit(h.opts(irk, boxKey));
    expect(out).toEqual({ claimed: false, reason: "rejected" });
    expect(h.persisted).toEqual([]);
    expect(h.restarted).toBe(0);
  });

  it("wrong-box delivery → rejected WITHOUT persisting", async () => {
    const irk = makeKey(1);
    const boxKey = makeKey(9);
    const otherBox = makeKey(13);
    const h = harness({ fetchImpl: fetchReturning(carrier({ irk, boxKey: otherBox, cgk: CGK })) });
    const out = await claimCgkDeposit(h.opts(irk, boxKey));
    expect(out).toEqual({ claimed: false, reason: "rejected" });
    expect(h.persisted).toEqual([]);
    expect(h.restarted).toBe(0);
  });

  it("a persist failure does NOT mark or restart (so a redeposit can recover)", async () => {
    const irk = makeKey(1);
    const boxKey = makeKey(9);
    const marker = inMemMarker();
    let restarted = 0;
    const out = await claimCgkDeposit({
      serverDomain: DOMAIN,
      ownerIrkPub: irk.publicKey,
      boxIdentityPriv: boxKey.privateKey,
      controlPlaneBaseUrl: "https://flagshipserver.com",
      persistCgk: async () => {
        throw new Error("disk full");
      },
      restart: () => {
        restarted += 1;
      },
      markerStore: marker,
      fetchImpl: fetchReturning(carrier({ irk, boxKey, cgk: CGK })),
      onLog: () => {},
    });
    expect(out).toEqual({ claimed: false, reason: "error" });
    expect(marker.marked).toBe(false);
    expect(restarted).toBe(0);
  });
});
